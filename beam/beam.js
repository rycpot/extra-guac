// Beam: send files between devices. Files go straight between them over WebRTC (PeerJS)
// when possible, or through a public relay (Piping Server) when not, encrypted end to end.
//
// One copy serves every place Beam shows: the extension's own tab (beam/index.html), the side
// panel's backup tab, a preview in the popup (popup.html) and the web page at
// rycpot.github.io/beam (the release workflow copies this folder there). Beam.mount() builds
// the markup inside the element it's given.
//
// Pairing: one device (the hub) shows a 6-digit code; others enter it (or scan the QR code), and
// the hub accepts each one. With Broadcast off the hub takes one device and turns away any other;
// with Broadcast on up to MAX_DEVICES can join, the hub sends to all of them or the ones picked,
// and each sends back to the hub. Every device makes a fresh key pair for each code and swaps the
// public half with the hub; files sent through the relay are sealed with the key that exchange
// gives (AES-GCM), one per device, so knowing the code isn't enough to read them. Only the
// handshake itself (names, public keys) is sealed with a key made from the code.
(() => {
'use strict'
// ===== Settings =====
// The hosted page. QR codes made inside the extension point here, so a device without the
// extension can join from its browser.
const WEB_APP_URL = 'https://rycpot.github.io/beam/'
// Disconnect after this long with no transfers and no taps on either device (a warning shows 1 minute before).
const IDLE_LIMIT_MIN = 30
// With Broadcast on, at most this many devices can join the hub.
const MAX_DEVICES = 5
// =====================

const IS_EXTENSION = location.protocol === 'chrome-extension:'
// Which Extra Guac release this Beam is: the extension's own version, or, on the web page, the
// one the release wrote here when it published the page (empty in a copy run from the repository).
const RELEASE = ''
// The usage mark: two green arrows, one each way; this month's figures show on hover or a tap.
const ICON_GAUGE = '<svg class="beam-gauge" viewBox="16 16 480 480" aria-hidden="true"><path d="M40 106H318V32L468 139 318 248V172H40ZM472 340H194V264L44 373 194 482V406H472Z" fill="#4caf50" stroke="#4caf50" stroke-width="32" stroke-linejoin="round"/></svg>'
// The version mark's icon: a green dome with two eyes and two antennae.
const ICON_DROID = '<svg class="beam-droid" viewBox="0 0 24 15" aria-hidden="true"><path d="M7.2 5.2 5 2M16.8 5.2 19 2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M2.2 13.6a9.8 9.8 0 0 1 19.6 0Z" fill="#4caf50" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="8.3" cy="9.6" r="1.25" fill="#16210f"/><circle cx="15.7" cy="9.6" r="1.25" fill="#16210f"/></svg>'
const VERSION = IS_EXTENSION ? chrome.runtime.getManifest().version : RELEASE
const BEAM_APP = 'egbeam4'             // also the protocol version: devices on different versions don't pair
const PIPE_SERVERS = ['https://piping.onrender.com', 'https://ppng.io']
// How devices find a direct path: two STUN servers (each tells a device its public address; the
// browser asks both at once, so either answering is enough) and two TURN fallbacks for networks
// that block a direct path, in order of preference (the browser ranks them as listed): ExpressTURN's
// free relay (UDP and TCP; the one with an account behind it) and the free public relay at
// turn.evan-brass.net (UDP, TCP, and TLS on port 443 for networks that only allow web traffic; its
// login is published for everyone). A direct path always wins over both. (PeerJS's own TURN
// servers no longer exist.) A link through a TURN relay is slow, so files then go through the
// Piping relay when they can (see sendTo).
// ExpressTURN's login is one shared account for Beam. A browser has to be given a TURN login to
// use it, so it can't be kept secret; it's only scrambled here so it isn't plain text in the code.
const unscramble = s => Array.from(atob(s), (c, i) => String.fromCharCode(c.charCodeAt(0) ^ 0x5a ^ (i * 7 & 0x3f))).join('')
const STUN = [{urls: 'stun:stun.l.google.com:19302'}, {urls: 'stun:stun.cloudflare.com:3478'}]
const TURN = {
  express: {urls: ['turn:free.expressturn.com:3478', 'turn:free.expressturn.com:3478?transport=tcp'],
    username: unscramble('am1kf3ZJQFtQVGxgf3ZPS1hZ'), credential: unscramble('DGw5CycvHwUzIGkSPy8hFEEhCy55GHc8ND8HWg==')},
  evan: {urls: ['turn:turn.evan-brass.net', 'turn:turn.evan-brass.net?transport=tcp', 'turns:turn.evan-brass.net:443?transport=tcp'], username: 'user', credential: 'password'},
}
const ICE_SERVERS = [...STUN, TURN.express, TURN.evan]
// Which relay carried a direct link, from the TURN address it went through.
const relayName = url => /expressturn/.test(url) ? 'ExpressTURN' : /evan-brass/.test(url) ? 'turn.evan-brass.net' : ''
const relayKind = s => /expressturn/i.test(s) ? 'express' : /evan-brass/i.test(s) ? 'evan' : ''
const MAX_LANES = 4
const HDR = 12                         // chunk header: 4-byte transfer number + 8-byte offset
const BLOCK = 4 * 1024 * 1024          // bytes read from disk at a time
const HIGH_WATER = 8 * 1024 * 1024     // per-connection queue limit (Chrome rejects sends past ~16 MB queued)
const LOW_WATER = 2 * 1024 * 1024
const ACK_TIMEOUT = 30000
// The relay seals a whole file at once (the browser's AES-GCM has no streaming), so a relay
// transfer holds it in memory two or three times over: kept to sizes a phone or computer copes with.
const MOBILE = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1)
const RELAY_MAX = (MOBILE ? 500 : 1024) * 1024 * 1024
// A phone or tablet can join by scanning the other device's QR code with its camera, on the web
// page (the extension runs on computers). jsQR reads it where the browser has no QR reader of its own.
const CAN_SCAN = !IS_EXTENSION && MOBILE && window.isSecureContext && !!navigator.mediaDevices?.getUserMedia
const JSQR_URL = new URL('lib/jsQR.min.js', document.currentScript?.src || location.href).href
// Received files from this size up go to disk as they arrive (disk.js), not into memory.
const DISK_URL = new URL('disk.js', document.currentScript?.src || location.href).href
const DISK_MIN = 16 * 1024 * 1024
const BEAM_ICON = new URL('icons/icon-128.png', document.currentScript?.src || location.href).href
const $ = id => document.getElementById('beam-' + id)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const enc = s => new TextEncoder().encode(s)
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)))
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0))

const ICON_QR = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><path d="M14 14h2v2h-2zM18 14h2M14 18h2M18 18h2v2M18 16v2"/></svg>'
const VORTEX = '<svg viewBox="0 0 220 220" aria-hidden="true"><g class="vortex">' +
  [[98, 40, 1, '120 40 2 6 2 40'], [84, 26, 1.5, '90 30 0.1 6 0.1 6 0.1 30'], [70, 17, 1, '70 26 3 5 3 26'], [56, 11, 1.5, '52 20 0.1 5 0.1 20'],
    [43, 7, 1, '38 16 2 4'], [31, 4.5, 1.5, '24 12 0.1 5'], [20, 2.8, 1, '14 8']]
    .map(([r, d, w, dash]) => `<circle class="ring" style="--d:${d}s" cx="110" cy="110" r="${r}" stroke-width="${w}" stroke-dasharray="${dash}" stroke-linecap="round"/>`).join('') +
  '<circle class="core" cx="110" cy="110" r="7"/></g></svg>'
const ICON_SCAN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2M7 12h10"/></svg>'
const ICON_X = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17"/></svg>'
// The Broadcast switch: under the code while waiting, and under the devices once connected.
const BCAST = '<div class="beam-bcast" data-bcast hidden><span class="beam-bcast-text">Broadcast<small></small></span>' +
  '<button type="button" class="beam-switch" role="switch" aria-checked="false" aria-label="Broadcast: let up to ' + MAX_DEVICES + ' devices join"></button></div>'
const ICON_PEN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 19h3.5L18.5 9 15 5.5 5 15.5z"/></svg>'
const WEB_LABEL = WEB_APP_URL.replace(/^https?:\/\//, '').replace(/\/$/, '')

function markup(preview) {
  return `
  <p class="beam-notice" id="beam-blockedNotice" hidden>This browser is blocking direct connections, usually because of a VPN or a privacy setting that blocks WebRTC. Files will go through the slower relay; allow WebRTC for full speed.</p>

  <div class="beam-ask" id="beam-ask" role="alert" hidden>
    <p><b id="beam-askName">A device</b> wants to connect.</p>
    <p class="beam-check" id="beam-askCheck" hidden>Check code <b></b><small>Accept only if that device shows the same code.</small></p>
    <div class="beam-row beam-center-row">
      <button type="button" class="beam-btn" id="beam-decline">Decline</button>
      <button type="button" class="beam-btn primary" id="beam-accept">Accept</button>
    </div>
    <p class="beam-hint" id="beam-askNote">Only accept a device you're pairing with right now.</p>
  </div>

  <section class="beam-card beam-center" id="beam-pair">
    <p class="beam-eyebrow" id="beam-codeLabel">Your code</p>
    <div class="beam-code" id="beam-roomCode">${preview ? '••••••' : '------'}</div>
    <p class="beam-status"><span class="beam-dot" aria-hidden="true"></span><span id="beam-pairStatus">Waiting for the other device…</span></p>
    <p class="beam-check" id="beam-joinCheck" hidden>Check code <b></b><small>It should match the code on the other device.</small></p>
    <button type="button" class="beam-btn small" id="beam-joinCancel" hidden>Cancel</button>
    ${BCAST}
    <ol class="beam-steps" id="beam-steps">
      <li><span>On the other device, open <a id="beam-webAddr" href="${WEB_APP_URL}" target="_blank" rel="noopener">${WEB_LABEL}</a> or Extra Guac</span></li>
      <li><span>Enter the 6-digit code above</span></li>
      <li><span>Accept it here, then send files either way</span></li>
    </ol>
    <button type="button" class="beam-btn beam-qr-toggle" id="beam-qrToggle" aria-expanded="false" aria-controls="beam-qrBox">${ICON_QR}<span>Show QR code</span></button>
    <div id="beam-qrBox" class="beam-qr-box" hidden>
      <div id="beam-qr" aria-label="QR code that opens Beam with your code"></div>
      <p class="beam-hint">Scan it with the other device's camera to skip steps 1 and 2.</p>
    </div>
    <hr class="beam-divider">
    <form id="beam-joinForm" class="beam-join">
      <label for="beam-joinInput" class="beam-eyebrow">Have a code from the other device?</label>
      <div class="beam-row beam-center-row" id="beam-joinRow">
        <input type="text" id="beam-joinInput" placeholder="000000" inputmode="numeric" autocomplete="off" maxlength="10">
        <button type="submit" class="beam-btn primary">Connect</button>
      </div>
      ${CAN_SCAN ? `<button type="button" class="beam-btn beam-qr-toggle" id="beam-scanBtn">${ICON_SCAN}<span>Scan QR code</span></button>
      <div class="beam-scan" id="beam-scan" hidden>
        <div class="beam-scan-view"><video id="beam-scanVideo" playsinline muted></video><span class="beam-scan-frame" aria-hidden="true"></span></div>
        <div class="beam-row beam-between"><p class="beam-hint" id="beam-scanHint" aria-live="polite"></p><button type="button" class="beam-btn small" id="beam-scanCancel">Cancel</button></div>
      </div>` : ''}
    </form>
  </section>

  <section class="beam-card" id="beam-connected" hidden>
    <div class="beam-notice beam-idle-warn" id="beam-idleWarn" role="alert" hidden>
      <span>Nothing's happened for a while. Disconnecting in <b id="beam-idleSecs">60</b> s.</span>
      <button type="button" class="beam-btn small" id="beam-stayBtn">Stay connected</button>
    </div>
    <div class="beam-conn">
      <p class="beam-eyebrow" id="beam-connLabel">Connected to</p>
      <ul class="beam-devices" id="beam-devices"></ul>
      ${BCAST}
      <div class="beam-more" id="beam-more" hidden>
        <button type="button" class="beam-btn beam-qr-toggle" id="beam-qrToggle2" aria-expanded="false" aria-controls="beam-qrBox2">${ICON_QR}<span>Show QR code</span></button>
        <div id="beam-qrBox2" class="beam-qr-box" hidden>
          <div id="beam-qr2" aria-label="QR code that opens Beam with this room's code"></div>
          <p class="beam-hint">Scan it with another device's camera to join.</p>
        </div>
      </div>
    </div>
    <label class="beam-drop" id="beam-drop" for="beam-fileInput">${VORTEX}
      <span class="beam-drop-text">Choose files to send<small id="beam-dropSub">or drop them into the vortex</small></span>
    </label>
    <input type="file" id="beam-fileInput" multiple hidden>
    <p class="beam-hint" id="beam-routeHint">Files go straight to the other device and are never stored on a server. Keep both screens on while sending.</p>
    <div class="beam-activity">
      <p class="beam-eyebrow">Activity</p>
      <pre id="beam-log" aria-live="polite"></pre>
    </div>
    <div class="beam-row beam-between">
      <span class="beam-hint">Room <span id="beam-roomSmall"></span></span>
      <button type="button" class="beam-btn small end" id="beam-disconnect">Disconnect</button>
    </div>
  </section>

  <section class="beam-card beam-chat off" id="beam-chat" aria-label="Chat">
    <div class="beam-row beam-between beam-chat-head"><div class="beam-chat-who"><p class="beam-eyebrow">Chat as</p><button type="button" class="beam-me" id="beam-me" title="Change the name others see"><span id="beam-meName"></span>${ICON_PEN}</button></div><span class="beam-hint" id="beam-chatNote">Connect to chat</span><button type="button" class="beam-chat-toggle" id="beam-chatToggle" aria-expanded="false" aria-controls="beam-msgs" hidden><span class="beam-unread" id="beam-unread" hidden></span><span id="beam-chatToggleText">Open</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9.5l6 6 6-6"/></svg></button></div>
    <div class="beam-msgs" id="beam-msgs" aria-live="polite"></div>
    <form class="beam-compose" id="beam-compose">
      <input type="text" id="beam-chatInput" placeholder="Message" maxlength="500" autocomplete="off" aria-label="Message" disabled>
      <button type="submit" class="beam-send" aria-label="Send"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 18.5v-13M6.5 11 12 5.5l5.5 5.5"/></svg></button>
    </form>
  </section>

  <section id="beam-xferSec" class="beam-xfer-sec" hidden aria-label="Transfers">
    <div class="beam-row beam-between"><p class="beam-eyebrow">Transfers</p><button type="button" class="beam-btn small" id="beam-clearDone">Clear finished</button></div>
    <div class="beam-transfers" id="beam-transfers"></div>
  </section>

  <details class="beam-details" id="beam-details" hidden>
    <summary>Details</summary>
    <div class="beam-dgrid">
      <dl class="beam-kv">
        <dt>This browser</dt><dd id="beam-selfState"><span class="beam-pill muted">Checking</span></dd>
        <dt>Direct link</dt><dd id="beam-peerState"><span class="beam-pill muted">Starting</span></dd>
        <dt>Parallel links</dt><dd id="beam-laneState"><span class="beam-pill muted">0 open</span></dd>
        <dt>Relay</dt><dd id="beam-pipeState"><span class="beam-pill muted">Starting</span></dd>
        <dt>Relay speeds</dt><dd id="beam-relaySpeeds" class="beam-hint">Measured before the first file goes through a relay</dd>
        <dt>Check code</dt><dd id="beam-checkCodes" class="beam-hint">Shown once a device connects</dd>
      </dl>
      <div class="beam-row"><label for="beam-lanes" class="beam-hint">Parallel connections</label>
        <select id="beam-lanes"><option value="1">1</option><option value="2">2</option><option value="3">3</option><option value="4" selected>4</option></select></div>
      <div class="beam-row"><label for="beam-route" class="beam-hint">Send using</label>
        <select id="beam-route"><option value="auto">Automatic (direct, then relay)</option><option value="peer">Direct only</option><option value="pipe">Relay only</option></select></div>
      <div class="beam-row"><label for="beam-turnVia" class="beam-hint">Direct link through</label>
        <select id="beam-turnVia"><option value="">Automatic (straight, then a TURN relay)</option><option value="express">ExpressTURN only</option><option value="evan">turn.evan-brass.net only</option></select></div>
      <p class="beam-hint">For testing a TURN relay: the direct link is forced through it. It applies from the next direct link (Disconnect and pair again), and only this device needs it.</p>
      <div class="beam-row"><label for="beam-pipeServer" class="beam-hint">Relay server</label><select id="beam-pipeServer"></select></div>
      <p class="beam-hint">The relay server carries this device's pairing and messages, and it's inside the QR code, so devices that scan it use it too. The device that shows the code listens on every relay, so a device that types the code reaches it whatever is picked here. Files that go through a relay use whichever relay is fastest from the sending device. Relay transfers keep whole files in memory, so they're limited to 500 MB on phones and 1 GB on computers.</p>
    </div>
  </details>

  <div class="beam-credits"><p class="beam-powered"><svg class="beam-gh" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>Powered by <a href="https://github.com/peers/peerjs" target="_blank" rel="noopener">PeerJS</a> · <a href="https://github.com/nwtgck/piping-server" target="_blank" rel="noopener">Piping Server</a><span class="beam-usage" id="beam-usage" tabindex="0" role="button" aria-label="Data used this month" aria-expanded="false">${ICON_GAUGE}<span class="beam-usepop" id="beam-usePop" role="tooltip"></span></span></p><div class="beam-meta">${VERSION ? '<p class="beam-version" title="Extra Guac version ' + VERSION + '">' + ICON_DROID + 'v' + VERSION + '</p>' : ''}</div></div>
  ${preview ? `<div class="beam-preview-cover"><p>Beam needs to stay open while files are sent, and this popup closes when you click elsewhere.</p><button type="button" class="beam-btn primary" id="beam-openTab">Open Beam in a tab</button></div>` : ''}`
}

function deviceName() {
  const ua = navigator.userAgent
  // An iPad asks for desktop sites as a Mac with a touch screen.
  const ipad = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1
  const os = /Android/i.test(ua) ? 'Android' : /iPhone|iPad/i.test(ua) || ipad ? 'iPhone/iPad' : /Mac/i.test(ua) ? 'Mac' : /Windows/i.test(ua) ? 'Windows' : /Linux/i.test(ua) ? 'Linux' : 'Device'
  // Browsers on iPhones and iPads all say "Safari"; their own names are in the CriOS-style tags.
  const br = /Edg\/|EdgiOS\//.test(ua) ? 'Edge' : /Firefox\/|FxiOS\//.test(ua) ? 'Firefox' : /OPR\/|OPiOS\//.test(ua) ? 'Opera' : /CriOS\//.test(ua) ? 'Chrome' : /DuckDuckGo\//.test(ua) ? 'DuckDuckGo' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser'
  return os + ' · ' + br
}
let mounted = false
// opts.game: a room for a game (the word search) instead of Beam's own page. The markup is there
// but hidden, everyone who enters the code is let in (up to MAX_DEVICES), and the game gets its
// own messages, the room's devices and a word when the room ends; mount() returns the room. It
// isn't held to one at a time like Beam itself, and can be mounted again after dispose().
function mount(root, opts = {}) {
  if (opts.game) {
    root.hidden = true
    root.innerHTML = markup(false)
    return start(root, opts)
  }
  if (mounted) return
  mounted = true
  root.classList.add('beam')
  if (opts.preview) {
    root.innerHTML = markup(true)
    root.classList.add('beam-preview')
    root.querySelectorAll('button, input, select, a').forEach(el => { if (el.id !== 'beam-openTab') el.tabIndex = -1 })
    $('openTab').addEventListener('click', () => opts.onOpenTab && opts.onOpenTab())
    return
  }
  if (IS_EXTENSION && typeof BroadcastChannel === 'function') return single(root)
  root.innerHTML = markup(false)
  start(root)
}

// Inside Extra Guac only one Beam runs at a time (its own tab or the side panel): the one opened
// last takes over, and the other lets go of its code. One that's paired or sending is asked
// first rather than cut off. The running one holds a lock (navigator.locks), so with no other
// Beam open, one starts at once; otherwise it asks the running one to let go (the "claim"),
// and starts as soon as that has.
function single(root) {
  const LOCK = 'extra-guac-beam'
  const chan = new BroadcastChannel('extra-guac-beam')
  const me = Math.random().toString(36).slice(2)
  let running = null, release = null
  // A claim waiting for the lock: two Beams waiting at the same moment settle it between them,
  // the one that claimed last taking over (ties go by id).
  let waiting = null
  const newer = (a, b) => a.at > b.at || (a.at === b.at && a.from > b.from)
  const card = (text, btn, fn) => {
    root.innerHTML = `<section class="beam-card beam-center beam-elsewhere"><p>${text}</p><button type="button" class="beam-btn primary" id="beam-here">${btn}</button></section>`
    $('here').addEventListener('click', fn)
  }
  const elsewhere = () => card('Beam is open in another Extra Guac tab or the side panel. It runs in one place at a time.', 'Use Beam here', () => take(false))
  chan.onmessage = ({data: m}) => {
    if (!m || m.from === me) return
    if (m.t === 'claim' && running) {
      if (running.busy() && !m.force) return chan.postMessage({t: 'busy', to: m.from, from: me})
      running.dispose()
      running = null
      release?.(); release = null
      elsewhere()
    } else if (m.t === 'claim' && waiting && newer(m, waiting.claim)) {
      waiting.stop()
      elsewhere()
    }
    if (m.t === 'busy' && m.to === me && waiting) {
      waiting.stop()
      card('Beam is paired with a device in another Extra Guac tab or the side panel. Using it here ends that connection.', 'Use Beam here anyway', () => take(true))
    }
  }
  // The lock: right now if it's free (true/false), or, given a signal, once it's let go.
  // It's held until release() (dispose, above) or this page closes.
  const lock = signal => new Promise((resolve, reject) => {
    navigator.locks.request(LOCK, signal ? {signal} : {ifAvailable: true}, l => {
      resolve(!!l)
      return l && new Promise(r => (release = r))
    }).catch(reject)
  })
  function run() {
    root.innerHTML = markup(false)
    running = start(root)
  }
  async function take(force) {
    waiting?.stop()
    if (await lock().catch(() => false)) return run()
    // Asked again every half second: the running Beam may itself have been only starting the
    // first time, and missed it.
    const claim = {t: 'claim', from: me, force, at: performance.timeOrigin + performance.now()}
    const ac = new AbortController()
    const again = setInterval(() => chan.postMessage(claim), 500)
    const w = waiting = {claim, stop: () => { ac.abort(); clearInterval(again); if (waiting === w) waiting = null }}
    chan.postMessage(claim)
    try { await lock(ac.signal) } catch (e) { return } // stopped: another took over, or the running one is busy
    w.stop()
    run()
  }
  take(false)
}

function start(root, opts = {}) {
const GAME = opts.game || null
// A game's rooms are apart from Beam's: their own codes and relay inboxes.
const APP = GAME ? GAME.app : BEAM_APP
const life = new AbortController() // dispose() ends it: the root's listeners and the idle timer go
// Once disposed, late callbacks (a connection closing, a relay answer) write into a detached
// element instead of the page, which may now show another Beam or the "open elsewhere" card.
const $ = id => (!life.signal.aborted && document.getElementById('beam-' + id)) || document.createElement('div')
// ---------- helpers ----------
const DEV = (() => { try { return new URLSearchParams(location.search).has('dev') } catch (e) { return false } })()
function dbg(msg, isErr) { if (DEV) log('· ' + msg, isErr) } // technical detail, only with ?dev
function log(msg, isErr) {
  const t = new Date().toLocaleTimeString([], DEV ? {hour: '2-digit', minute: '2-digit', second: '2-digit'} : {hour: '2-digit', minute: '2-digit'})
  const line = document.createElement('div')
  line.textContent = t + '  ' + msg
  if (isErr) line.className = 'err'
  $('log').prepend(line)
}
function pill(el, text, tone) { el.className = 'beam-pill ' + tone; el.textContent = text }
function pillIn(el, text, tone) { el.innerHTML = ''; const s = document.createElement('span'); pill(s, text, tone); el.append(s) }
function fmtBytes(n) {
  if (n < 1024) return n + ' B'
  const u = ['KB', 'MB', 'GB']; let i = -1
  do { n /= 1024; i++ } while (n >= 1024 && i < u.length - 1)
  return n.toFixed(n < 10 ? 2 : 1) + ' ' + u[i]
}
const fmtRate = (b, ms) => ms > 0 ? (b / 1048576 / (ms / 1000)).toFixed(2) + ' MB/s' : '—'
const fmtTime = ms => {
  if (ms < 59950) return (ms / 1000).toFixed(1) + ' s' // what rounds to 60.0 s reads as 1 min
  const s = Math.round(ms / 1000) // rounded once, so 119.6 s is "2 min 0 s", never "1 min 60 s"
  return Math.floor(s / 60) + ' min ' + (s % 60) + ' s'
}
const myName = deviceName()
// The name this device goes by in Beam and the word search: the one picked there, or the device's.
const NAME_KEY = 'eg-name'
const shownName = () => { try { const n = (localStorage.getItem(NAME_KEY) || '').trim(); if (n) return n.slice(0, 24) } catch (e) {} return myName }
const TS = GAME ? GAME.app + '-' : 'beam-' // this tab's room, apart from Beam's own
const randomCode = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 900000 + 100000)
const cleanCode = s => (s || '').replace(/\D/g, '').slice(0, 10)
const validCode = c => /^\d{6,10}$/.test(c)
const hexOf = buf => Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('')
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(16).slice(2))
const tabStore = {
  get(k) { try { return sessionStorage.getItem(k) || '' } catch (e) { return '' } },
  set(k, v) { try { sessionStorage.setItem(k, v) } catch (e) {} },
}
function waiter(map, id) { let res; const p = new Promise(r => { res = r }); map.set(id, v => res(v)); return p }
const within = (p, ms) => Promise.race([p, sleep(ms).then(() => false)])

// ---------- screens ----------
let mode = 'waiting' // 'waiting' | 'connected'
function setMode(m) {
  mode = m
  notify()
  paintJoining()
  showUse()
  $('pair').hidden = m !== 'waiting'
  $('connected').hidden = m === 'waiting'
  if (m === 'connected') { $('pairStatus').textContent = waitingText(); renderLinks() }
  showBroadcast()
  showChat()
}
const waitingText = () => isHub() && broadcast ? 'Waiting for devices…' : 'Waiting for the other device…'
const DIRECT_HINT = 'Files go straight between the devices and are never stored on a server. Keep the screens on while sending.'
const RELAY_HINT = 'A direct connection isn\'t possible on this network, so files pass through a relay, encrypted with a key only the paired devices have. Nothing is stored on it.'
const SOME_RELAY_HINT = 'Devices marked Relay can\'t connect directly on this network, so their files pass through a relay, encrypted with a key only that device and this one have. Nothing is stored on it.'

// ---------- devices ----------
// Each device on the other end is a "link": its name, its public key, the key the two share, its
// direct connections ("lanes") and its transfers. The hub (the device that made the code) has a
// link for every device that joined or is asking to; a device that joined has one, to the hub.
const links = new Map() // hub: public key -> link; a device that joined: 'hub' -> link
let asks = []           // hub: devices waiting for Accept, first come first served
const declined = new Set()
let broadcast = !!GAME // starts off on every visit, reload included (always on in a game)
const isHub = () => intent === 'create'
const hubLink = () => links.get('hub')
const present = L => [...links.values()].includes(L)
const newLink = (pub, key, name) => ({pub, key, name, baseName: name, id: '', accepted: false, known: false, selected: true, lanes: [], inX: new Map(), path: '', helloBack: false, lostTimer: 0})
// known: accepted at some point and still in the room; accepted: reachable right now.
const roomLinks = () => [...links.values()].filter(L => L.known)
const direct = L => !!(L && L.lanes[0] && L.lanes[0].open)
const nameOf = L => (L && L.name) || 'the other device'
function recipients() {
  if (!isHub()) { const L = hubLink(); return L && L.accepted ? [L] : [] }
  const live = roomLinks().filter(L => L.accepted)
  return roomLinks().length > 1 ? live.filter(L => L.selected) : live
}
// Where files to a device go: through the relay when there's no direct link, when Details → Send
// using is "Relay only", or (Automatic) when the direct link goes through a TURN relay, since files
// then take the faster Piping relay (sendTo). The direct link's own route is in Details.
const viaRelay = L => !direct(L) || $('route').value === 'pipe' || ($('route').value === 'auto' && L.path === 'relay')
function routeOf(L) {
  if (!L.accepted) return ['Reconnecting…', 'muted']
  if (viaRelay(L)) return ['Relay', 'warn']
  return L.path === 'relay' ? ['Direct via ' + (L.relayName || 'TURN relay'), 'warn'] : L.path === 'lan' ? ['Direct · same Wi-Fi', 'good'] : L.path === 'internet' ? ['Direct · via internet', 'good'] : ['Direct', 'good']
}
// The connected card: who's here, how each is reached, and (with several) who gets the next files.
function renderLinks() {
  notify()
  if (mode !== 'connected') return
  const list = roomLinks()
  const many = isHub() && list.length > 1
  $('connLabel').textContent = many ? 'Connected to ' + list.length + ' devices' : 'Connected to'
  const ul = $('devices')
  ul.innerHTML = ''
  ul.classList.toggle('many', many)
  for (const L of list) {
    const li = document.createElement('li')
    li.className = 'beam-device'
    if (many) {
      const cb = document.createElement('input')
      cb.type = 'checkbox'; cb.className = 'beam-pick'; cb.checked = L.selected
      cb.setAttribute('aria-label', 'Send to ' + L.name)
      cb.addEventListener('change', () => { L.selected = cb.checked; renderLinks() })
      li.classList.toggle('skip', !L.selected)
      li.append(cb)
    }
    const n = document.createElement('span')
    n.className = 'name'; n.textContent = L.name || 'Other device'
    if (L.check) n.title = 'Check code ' + L.check
    const p = document.createElement('span')
    pill(p, ...routeOf(L))
    li.append(n, p)
    if (many) {
      const b = document.createElement('button')
      b.type = 'button'; b.className = 'beam-btn small beam-remove'; b.innerHTML = ICON_X
      b.title = 'Disconnect ' + L.name; b.setAttribute('aria-label', 'Disconnect ' + L.name)
      b.addEventListener('click', () => kick(L))
      li.append(b)
    }
    ul.append(li)
  }
  const relayed = list.filter(L => L.accepted && viaRelay(L)).length
  $('routeHint').textContent = !relayed ? DIRECT_HINT : many && relayed < list.length ? SOME_RELAY_HINT : RELAY_HINT
  const to = recipients().length
  $('dropSub').textContent = !many ? 'or drop them into the vortex'
    : to === list.length ? (to === 2 ? 'to both devices' : 'to all ' + to + ' devices') + ' · or drop them into the vortex'
    : to ? 'to ' + to + ' of ' + list.length + ' devices · or drop them into the vortex' : 'tick a device above first'
  $('disconnect').textContent = many ? 'Disconnect all' : 'Disconnect'
  showChecks()
  showBroadcast()
}
// The Broadcast switch is the hub's: off, one device can connect; on, up to MAX_DEVICES.
function showBroadcast() {
  if (life.signal.aborted) return
  const n = roomLinks().length
  root.querySelectorAll('[data-bcast]').forEach(el => {
    el.hidden = !isHub()
    el.querySelector('.beam-switch').setAttribute('aria-checked', String(broadcast))
    el.querySelector('small').textContent = el.closest('#beam-connected')
      ? (broadcast ? n + ' of ' + MAX_DEVICES + ' devices · others can join with code ' + code : 'Turn on to let more devices join')
      : (broadcast ? 'Up to ' + MAX_DEVICES + ' devices can join' : 'Turn on to send to up to ' + MAX_DEVICES + ' devices')
  })
  $('more').hidden = !(isHub() && broadcast && n < MAX_DEVICES) // room for more: the QR code for them
}
function setBroadcast(on) {
  broadcast = on
  log(on ? 'Broadcast on: up to ' + MAX_DEVICES + ' devices can join' : roomLinks().length ? 'Broadcast off: no more devices can join' : 'Broadcast off')
  if (/^Waiting for (the other device|devices)…$/.test($('pairStatus').textContent)) $('pairStatus').textContent = waitingText()
  showBroadcast()
}
function showAsk() {
  const L = asks[0]
  $('ask').hidden = !L
  if (!L) return
  $('askName').textContent = L.name
  showCheck($('askCheck'), L.check)
  const n = roomLinks().length
  $('askNote').textContent = (n ? n + ' of ' + MAX_DEVICES + ' devices connected. ' : '') + 'Only accept a device you\'re pairing with right now.' +
    (asks.length > 1 ? ' ' + (asks.length - 1) + ' more waiting.' : '')
}

// ---------- chat ----------
// Text between the room's devices, through the hub like everything else: a device that joined
// writes to the hub, the hub shows it and passes it on to the others with the writer's name.
// Kept only on these screens, and gone when the pairing ends.
const CHAT_MAX = 500, CHAT_KEEP = 200
const chatLines = []
const chatText = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
const toLink = (L, msg) => direct(L) ? sendCtl(L, msg) : postControl(L, msg, 3)
function sayChat(text) {
  text = chatText(text, CHAT_MAX)
  if (!text || mode !== 'connected') return
  const to = isHub() ? roomLinks().filter(L => L.accepted) : [hubLink()].filter(L => L && L.accepted)
  if (!to.length) return
  addChat({text})
  for (const L of to) toLink(L, isHub() ? {t: 'chat', text, name: shownName()} : {t: 'chat', text})
  markActive()
}
function onChat(L, m) {
  const text = chatText(m.text, CHAT_MAX)
  if (!text) return
  markActive(true)
  if (!isHub()) return addChat({name: chatText(m.name, 40) || nameOf(L), text})
  addChat({name: nameOf(L), text})
  for (const o of roomLinks()) if (o !== L && o.accepted) toLink(o, {t: 'chat', text, name: nameOf(L)})
}
// The name the other devices see (the same one the word search uses): changed from the chat's
// header, sent to every connected device at once, and to new ones in the hello.
function showMe() { $('meName').textContent = shownName() }
function editMe() {
  if (life.signal.aborted || $('me').hidden) return
  const btn = $('me'), input = document.createElement('input')
  Object.assign(input, {type: 'text', value: shownName(), maxLength: 24, placeholder: myName, autocomplete: 'off', spellcheck: false, className: 'beam-me-edit'})
  input.setAttribute('aria-label', 'Your name')
  btn.hidden = true
  btn.after(input)
  input.focus(); input.select()
  let done = false
  const finish = (save, refocus) => {
    if (done) return
    done = true
    input.remove(); btn.hidden = false
    if (save) setMe(input.value)
    if (refocus) btn.focus({preventScroll: true}) // not after a click elsewhere: that keeps its focus
  }
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); finish(true, true) } if (e.key === 'Escape') { e.stopPropagation(); finish(false, true) } })
  input.addEventListener('blur', () => finish(true))
}
function setMe(v) {
  const name = chatText(v, 24), before = shownName()
  try { if (name && name !== myName) localStorage.setItem(NAME_KEY, name); else localStorage.removeItem(NAME_KEY) } catch (e) {}
  if (shownName() !== before) announceMe()
}
let lastSent = ''
function announceMe() {
  showMe()
  const name = shownName()
  if (name === lastSent) return
  lastSent = name
  for (const L of links.values()) if (L.accepted) toLink(L, {t: 'name', name})
}
// Another device renamed itself (for a device that joined: the hub did).
function onName(L, m) {
  const name = chatText(m.name, 24)
  if (!name) return
  if (isHub()) renameLink(L, name)
  else { L.name = name; renderLinks() }
}
function renameLink(L, name) {
  const taken = new Set([...links.values()].filter(o => o !== L).map(o => o.name))
  let shown = name
  for (let k = 2; taken.has(shown); k++) shown = name + ' (' + k + ')'
  L.baseName = name; L.name = shown
  renderLinks()
}
function addChat(line) {
  chatLines.push(line)
  if (chatLines.length > CHAT_KEEP) chatLines.splice(0, chatLines.length - CHAT_KEEP)
  const box = $('msgs')
  const atEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 40
  box.append(chatRow(line))
  while (box.childElementCount > CHAT_KEEP) box.firstElementChild.remove()
  if (atEnd || !line.name) box.scrollTop = box.scrollHeight
  if (!chatOpen && line.name) { unread++; showChatToggle() } // folded: the bar counts what came in
}
function chatRow(line) {
  const row = document.createElement('div')
  row.className = 'beam-m' + (line.name ? '' : ' mine')
  if (line.name) { const n = document.createElement('small'); n.textContent = line.name; row.append(n) }
  row.append(document.createTextNode(line.text))
  return row
}
// A gray bar until a device is connected. Once connected it stays folded to its bar, which
// counts messages that come in, until it's opened (the bar's Open, or a tap on the bar); open,
// it's as tall as the window has room for below the Beam box (the panel, Beam's tab, the web
// page), and never shorter than 260 px. Close folds it again; each new connection starts folded.
let chatOpen = false, unread = 0
function showChat() {
  if (life.signal.aborted) return
  const on = mode === 'connected'
  const c = $('chat')
  if (!on && chatLines.length) { chatLines.length = 0; $('msgs').replaceChildren() }
  if (!on) { chatOpen = false; unread = 0 }
  c.classList.toggle('off', !on)
  c.classList.toggle('shut', on && !chatOpen)
  $('chatNote').hidden = on
  $('chatInput').disabled = !on
  showChatToggle()
  sizeChat()
}
function showChatToggle() {
  const t = $('chatToggle')
  t.hidden = mode !== 'connected'
  t.setAttribute('aria-expanded', String(chatOpen))
  t.setAttribute('aria-label', chatOpen ? 'Close chat' : unread ? 'Open chat, ' + unread + ' new' : 'Open chat')
  $('chatToggleText').textContent = chatOpen ? 'Close' : 'Open'
  $('unread').hidden = chatOpen || !unread
  $('unread').textContent = unread > 99 ? '99+' : String(unread)
}
function setChatOpen(open) {
  if (mode !== 'connected' || open === chatOpen) return
  chatOpen = open
  if (open) unread = 0
  showChat()
  if (open) { const box = $('msgs'); box.scrollTop = box.scrollHeight; $('chatInput').focus({preventScroll: true}) }
}
function scrollerOf(el) {
  for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY
    if (o === 'auto' || o === 'scroll') return p
  }
  return null
}
function sizeChat() {
  const c = $('chat')
  if (GAME || c.classList.contains('off') || c.classList.contains('shut') || !c.offsetParent) { c.style.height = ''; return }
  const s = scrollerOf(c), r = c.getBoundingClientRect()
  const top = s ? r.top - s.getBoundingClientRect().top + s.scrollTop : r.top + scrollY
  const room = (s ? s.clientHeight : innerHeight) - top - 16
  const h = Math.max(260, Math.floor(room)) + 'px'
  if (c.style.height !== h) c.style.height = h
}

// ---------- transfers UI ----------
const activeX = new Set() // transfers still running, so Disconnect can stop them
const rows = new Set()    // every transfer in the list; a received file's blob lives until it's discarded or cleared
// The way a file goes, on its row: straight between the devices, or through a relay (a Piping
// relay, or the TURN relay a direct link runs through). Either way only the two devices can read it.
const VIA = {
  direct: ['Direct', 'good', 'Sent straight between the devices, never stored on a server'],
  turn: ['Via TURN relay', 'warn', 'The direct link runs through a TURN relay on this network. Encrypted end to end, nothing is stored'],
  relay: ['Via relay', 'warn', 'Passed through a relay, encrypted with a key only the two devices have. Nothing is stored'],
}
function getXfer(id, name, size, dir, via, L) {
  $('xferSec').hidden = false
  const el = document.createElement('div'); el.className = 'beam-xfer'
  el.innerHTML = '<div class="top"><span class="name"></span><span class="dir"><span class="beam-pill"></span><span class="info"></span></span></div><div class="beam-bar"><i></i></div>' +
    '<div class="stats"><span class="pct"></span><span class="beam-row"><span class="rate"></span><button type="button" class="beam-btn small cancel">Cancel</button></span></div>'
  $('transfers').prepend(el)
  const x = {id, el, size, dir, link: L, start: performance.now(), ms: 0, base: 0, lastUI: 0, finished: false, cancel: null, abort: null, free: null}
  // With several devices in the room, each row says which one it's to or from.
  const who = isHub() && roomLinks().length > 1 ? (dir === 'in' ? ' · from ' : ' · to ') + nameOf(L) : ''
  el.querySelector('.name').textContent = name
  const [label, tone, tip] = VIA[via === 'Relay' ? 'relay' : L && L.path === 'relay' ? 'turn' : 'direct']
  const p = el.querySelector('.dir .beam-pill')
  pill(p, label, tone); p.title = tip
  el.querySelector('.dir .info').textContent = (dir === 'in' ? '↓' : '↑') + who + (size ? ' · ' + fmtBytes(size) : '')
  el.querySelector('.cancel').addEventListener('click', () => { if (x.cancel && !x.finished) x.cancel() })
  activeX.add(x)
  rows.add(x)
  return x
}
// A row leaves the list; a received file it held is let go of (its memory or disk space is freed).
function dropRow(x) {
  if (x.url) URL.revokeObjectURL(x.url)
  x.url = ''
  if (x.free) { x.free(); x.free = null }
  x.el.remove()
  rows.delete(x)
  if (!rows.size) $('xferSec').hidden = true
}
function setStatus(x, text) { if (!x.finished) x.el.querySelector('.pct').textContent = text }
function updateXfer(x, bytes, total, force) {
  if (x.finished) return
  const now = performance.now()
  x.ms = now - x.start
  const t = total || x.size || 0
  const done = t ? Math.min(1, bytes / t) : 0
  if (!force && done < 1 && now - x.lastUI < 120) return
  x.lastUI = now
  x.el.querySelector('.beam-bar > i').style.width = (done * 100).toFixed(1) + '%'
  x.el.querySelector('.pct').textContent = (done * 100).toFixed(0) + '% · ' + fmtBytes(bytes)
  x.el.querySelector('.rate').innerHTML = '<b>' + fmtRate(bytes - x.base, x.ms) + '</b>' // base: what was already there when it carried on
}
function finishXfer(x, state, text) {
  if (x.finished) return
  x.finished = true
  activeX.delete(x)
  x.el.classList.add(state)
  if (state === 'done' && x.size) addTotal(x.dir === 'in' ? 0 : x.size, x.dir === 'in' ? x.size : 0)
  if (state === 'done' || state === 'warn') {
    x.el.querySelector('.beam-bar > i').style.width = '100%'
    if (x.size) x.el.querySelector('.rate').innerHTML = '<b>' + fmtRate(x.size - x.base, x.ms) + '</b>'
  }
  x.el.querySelector('.pct').textContent = text
  const c = x.el.querySelector('.cancel'); if (c) c.remove()
}
// A transfer whose device left: marked stopped, and whatever it was waiting on let go.
function stopXfer(x, text) { finishXfer(x, 'failed', text); if (x.abort) x.abort() }
// A received file: Save file downloads it (as often as wanted); Discard drops it from the list
// and from memory.
function offerSave(x, blob, name) {
  x.url = URL.createObjectURL(blob)
  x.saved = false
  const row = document.createElement('div')
  row.className = 'beam-row actions'
  const a = document.createElement('a')
  a.href = x.url; a.download = name || 'file'
  a.className = 'beam-btn primary small'; a.textContent = 'Save file'
  // Once saved (or discarded, which drops the row), the choice is made: the buttons go.
  a.addEventListener('click', () => {
    x.saved = true
    setTimeout(() => { row.remove(); x.el.querySelector('.pct').textContent += ' · Saved' }, 150) // after the download has started
  })
  const d = document.createElement('button')
  d.type = 'button'; d.className = 'beam-btn small'; d.textContent = 'Discard'
  d.addEventListener('click', () => { log('Discarded ' + (name || 'a file')); dropRow(x) })
  row.append(a, d)
  x.el.append(row)
}
// Clear finished: every row that's done (sent, received, failed or canceled). Received files
// not saved yet go too, so then it asks first.
let clearTimer = 0
function clearFinished() {
  const btn = $('clearDone')
  const done = [...rows].filter(x => x.finished)
  if (!done.length) return
  const unsaved = done.filter(x => x.url && !x.saved).length
  if (unsaved && !btn.classList.contains('armed')) {
    btn.classList.add('armed')
    btn.textContent = unsaved === 1 ? 'Clear, with 1 unsaved file?' : 'Clear, with ' + unsaved + ' unsaved files?'
    clearTimeout(clearTimer)
    clearTimer = setTimeout(() => { btn.classList.remove('armed'); btn.textContent = 'Clear finished' }, 4000)
    return
  }
  clearTimeout(clearTimer)
  btn.classList.remove('armed'); btn.textContent = 'Clear finished'
  done.forEach(dropRow)
}

// ---------- where received files are kept ----------
// A store takes a file's blocks as they're done (put) and gives the whole file back as a Blob
// (finish). Large files go to disk: the browser's private storage for this page (the origin private
// file system), written by disk.js in a worker, so they never have to fit in memory; the Blob it
// gives back reads from disk. Smaller files, and any where that storage isn't there (some private
// windows) or hasn't room, are kept in memory as before.
// Each Beam has its own folder there, held with a lock while it's open; folders whose lock nobody
// holds any more (a closed tab) are cleared the first time a file goes to disk.
const disk = (() => {
  const dir = Date.now() + '-' + uid()
  let worker = null, ready = null, n = 0, release = null
  const waits = new Map()
  const LOCK = 'beam-disk-'
  function call(m, transfer) {
    return new Promise((resolve, reject) => {
      const k = ++n
      waits.set(k, {resolve, reject})
      worker.postMessage({...m, n: k, dir}, transfer || [])
    })
  }
  async function sweep(root) {
    for await (const [name] of root.entries()) {
      if (name === dir) continue
      const remove = () => root.removeEntry(name, {recursive: true}).catch(() => {})
      // Without locks, a folder is taken as left over once it's a day old.
      if (!navigator.locks) { if (Date.now() - parseInt(name, 10) > 86400000) await remove(); continue }
      await navigator.locks.request(LOCK + name, {ifAvailable: true}, l => l ? remove() : null)
    }
  }
  function start() {
    return ready || (ready = (async () => {
      if (!navigator.storage || !navigator.storage.getDirectory || typeof Worker !== 'function') throw new Error('no private storage in this browser')
      const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('beam', {create: true})
      if (navigator.locks) await new Promise(held => navigator.locks.request(LOCK + dir, () => { held(); return new Promise(r => (release = r)) }).catch(() => held()))
      await sweep(root).catch(() => {}) // before the space check below, so left-over files don't count
      worker = new Worker(DISK_URL)
      worker.onmessage = ({data: m}) => {
        const w = waits.get(m.n); if (!w) return
        waits.delete(m.n)
        if (m.ok) w.resolve()
        else w.reject(Object.assign(new Error(m.quota ? 'not enough storage space' : m.error), {quota: m.quota}))
      }
      worker.onerror = e => { e.preventDefault(); for (const w of waits.values()) w.reject(new Error('the disk writer stopped')); waits.clear() }
    })().catch(e => { ready = null; throw e }))
  }
  async function store(size, type) {
    await start()
    if (navigator.storage.estimate) {
      const {quota, usage} = await navigator.storage.estimate()
      if (quota && quota - (usage || 0) < size + 64 * 1024 * 1024) throw new Error('not enough room in this browser\'s storage')
    }
    const key = 'f' + (++n)
    await call({op: 'open', key})
    let gone = false
    return {
      onDisk: true,
      put: (at, bytes) => call({op: 'write', key, at, data: bytes.buffer}, [bytes.buffer]),
      async finish() {
        await call({op: 'close', key})
        const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('beam')
        const file = await (await (await root.getDirectoryHandle(dir)).getFileHandle(key)).getFile()
        return file.slice(0, file.size, type || 'application/octet-stream')
      },
      discard() { if (!gone && worker) { gone = true; call({op: 'remove', key}).catch(() => {}) } },
    }
  }
  // Beam closes here (another took over, or the page is going): its folder goes with it.
  function close() {
    if (!worker) return
    const w = worker
    worker = null
    navigator.storage.getDirectory().then(r => r.getDirectoryHandle('beam')).then(r => {
      w.terminate() // its files are closed with it, so the folder can go
      return r.removeEntry(dir, {recursive: true})
    }).catch(() => {}).finally(() => { if (release) release() })
  }
  // Shortly after Beam opens: files left by Beams that have closed go, without waiting for the
  // next large file. Nothing is created if Beam never put anything there.
  function tidy() {
    if (ready || !navigator.storage || !navigator.storage.getDirectory) return
    navigator.storage.getDirectory().then(r => r.getDirectoryHandle('beam')).then(sweep).catch(() => {})
  }
  return {store, close, tidy}
})()
if (!GAME) setTimeout(() => { if (!life.signal.aborted) disk.tidy() }, 5000)
function memStore(size, type) {
  let buf = new Uint8Array(size) // throws when there isn't that much memory
  return {
    onDisk: false,
    put: async (at, bytes) => { buf.set(bytes, at) },
    // The Blob is a copy: the buffer is let go of, so the file isn't held twice.
    finish: async () => { const b = new Blob([buf], {type: type || 'application/octet-stream'}); buf = null; return b },
    discard() { buf = null },
  }
}
async function storeFor(size, type) {
  if (size >= DISK_MIN) {
    try { return await disk.store(size, type) }
    catch (e) { dbg('Keeping it in memory: ' + (e.message || e)) }
  }
  return memStore(size, type)
}

// ---------- room ----------
// The room number lives in this tab only. The QR link carries it to the other device, which then cleans its address bar.
let code = ''
let serverIndex = 0
let generation = 0

function parseHash() {
  if (IS_EXTENSION) return {code: '', s: null} // QR links open the web page, not the extension
  return parseLink(location.hash)
}
function parseLink(hash) {
  const [codePart, ...rest] = hash.slice(1).split('&')
  const p = new URLSearchParams(rest.join('&'))
  const s = parseInt(p.get('s'), 10)
  return {code: cleanCode(codePart), s: Number.isInteger(s) && s >= 0 && s < PIPE_SERVERS.length ? s : null}
}
const cleanUrl = () => location.href.split('#')[0]
// Inside the extension the page lives at chrome-extension://…, which other devices can't open, so links use the hosted page.
const pageUrl = () => IS_EXTENSION ? WEB_APP_URL : cleanUrl().split('?')[0]
const roomLink = () => pageUrl() + '#' + code + '&s=' + serverIndex
function cleanAddressBar() { if (!IS_EXTENSION && location.hash) history.replaceState(null, '', cleanUrl()) }

// intent: 'create' = this device made the code: it's the hub, which accepts whoever joins;
//         'join'   = the code came from the other device (QR or typed).
let intent = 'create', reclaims = 0
function setRoom(newCode, how, reclaim) {
  if (life.signal.aborted) return // disposed: a late timer (a device that didn't come back, a decline) mustn't start a new code
  stopScan()
  reclaims = reclaim ? 5 : 0
  const c = cleanCode(newCode)
  intent = validCode(c) ? (how || 'join') : 'create'
  code = validCode(c) ? c : randomCode()
  tabStore.set(TS + 'room', code)
  tabStore.set(TS + 'intent', intent)
  generation++
  closeAllLanes()
  for (const L of links.values()) clearTimeout(L.lostTimer)
  links.clear(); asks = []; declined.clear()
  if (intent === 'join') links.set('hub', newLink('', null, ''))
  $('roomCode').textContent = code
  $('roomSmall').textContent = code
  $('pairStatus').textContent = intent === 'join' ? 'Connecting…' : waitingText()
  $('joinCheck').hidden = true
  showChecks()
  showAsk()
  drawQR()
  dbg('Room ' + code + ' · this device: ' + myName)
  resetHandshake()
  setMode('waiting')
  resetPipeState()
  startPeer(generation)
  startPipe(generation)
  // Joining a code nobody is holding: given up after 2 minutes (Cancel ends it sooner).
  if (intent === 'join') {
    const gen = generation, tried = code
    setTimeout(() => {
      const L = hubLink()
      if (gen !== generation || mode !== 'waiting' || (L && L.pub)) return
      leaveJoin()
      if (startOver('gone')) return
      setRoom('', 'create')
      $('pairStatus').textContent = 'Nobody answered on ' + tried + '. Check the code on the other device and try again, or share this code of yours.'
    }, JOIN_GIVE_UP)
  }
}
const JOIN_GIVE_UP = 120000
// A game's room that can't go on (nobody answered, full, the host left, idle) ends there and
// tells the game why, rather than moving to a new code as Beam does.
function startOver(why) {
  if (!GAME || life.signal.aborted) return !!GAME
  GAME.onEnd(why)
  return true
}
const notify = () => { if (GAME && !life.signal.aborted) GAME.onChange() }
// While joining, the code shown is the one being joined, and Cancel goes back to one of this device's own.
function paintJoining() {
  const joining = intent === 'join' && mode === 'waiting'
  $('codeLabel').textContent = joining ? 'Joining' : 'Your code'
  $('joinCancel').hidden = !joining
  // The steps and the QR code are for sharing this device's own code: not while joining another.
  $('steps').hidden = joining
  $('qrToggle').hidden = joining
  if (joining) {
    $('qrBox').hidden = true
    $('qrToggle').setAttribute('aria-expanded', 'false')
    $('qrToggle').querySelector('span').textContent = 'Show QR code'
  }
}
// The QR code while waiting, and once connected with Broadcast on, for more devices to join.
// In Extra Guac's look (lib/qr-render.js: avocado-half corners, leaf squares) with Beam's
// icon in the middle, read back before it's shown; a plain one if that can't be drawn.
let qrRun = 0
async function drawQR() {
  if (GAME) return // a game shows its own, for its own page
  const run = ++qrRun, text = roomLink()
  let svg = null
  try {
    if (window.EGQR && window.jsQR) {
      const made = await EGQR.make(text, {icon: await EGQR.dataUrlOf(BEAM_ICON)})
      if (made.ok) svg = made.svg
    }
  } catch (e) {}
  if (run !== qrRun) return
  for (const qr of [$('qr'), $('qr2')]) {
    qr.innerHTML = ''
    qr.classList.toggle('plain', !svg)
    if (svg) { qr.innerHTML = svg; continue }
    try { new QRCode(qr, {text, width: 296, height: 296, correctLevel: QRCode.CorrectLevel.M}) }
    catch (e) { qr.textContent = 'QR unavailable' }
  }
}

// ---------- scanning the other device's QR code (CAN_SCAN) ----------
// The camera's picture is read a few times a second by the browser's own QR reader, or by jsQR
// (loaded the first time it's needed). Beam's link (or a bare code) joins that room, on the relay
// server the link names, as opening the link would.
let scanning = null
async function qrReader() {
  try {
    if ('BarcodeDetector' in window && (await BarcodeDetector.getSupportedFormats()).includes('qr_code')) {
      const detector = new BarcodeDetector({formats: ['qr_code']})
      const read = async video => (await detector.detect(video))[0]?.rawValue || null
      read.native = true
      return read
    }
  } catch (e) {}
  window.__beamJsQR ??= window.jsQR ? Promise.resolve() : new Promise((ok, fail) => {
    const s = document.createElement('script')
    s.src = JSQR_URL; s.onload = ok; s.onerror = () => { window.__beamJsQR = null; fail(new Error('reader')) }
    document.head.append(s)
  })
  await window.__beamJsQR
  // Mostly just the scan box (the middle of the picture, a little past the frame drawn on it),
  // read at the right size: jsQR finds a camera's soft picture of a styled code only when its
  // squares come out about 3-6 px each, and how big the code is in the picture isn't known.
  // So each frame is read at 240 px (a code filling the box), then at one other size in turn
  // (a smaller or bigger code). Every fourth frame reads the whole picture instead, for a code
  // held off to one side.
  const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d', {willReadFrequently: true})
  const OTHER = [400, 600, 180, 320]
  let n = 0
  const at = (video, sx, sy, sw, sh, size) => {
    const k = size / Math.max(sw, sh)
    canvas.width = Math.round(sw * k); canvas.height = Math.round(sh * k)
    ctx.imageSmoothingQuality = 'high' // (resizing the canvas resets it)
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height)
    return window.jsQR(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, {inversionAttempts: 'dontInvert'})?.data || null
  }
  return async video => {
    const vw = video.videoWidth, vh = video.videoHeight
    if (++n % 4 === 0) return at(video, 0, 0, vw, vh, 600)
    const side = Math.round(Math.min(vw, vh) * 0.8), sx = (vw - side) >> 1, sy = (vh - side) >> 1
    return at(video, sx, sy, side, side, 240) || at(video, sx, sy, side, side, OTHER[n % 4])
  }
}
// Where the page reads the code itself (iPhones): the camera zoomed in a little, so the code
// fills more of the picture and the camera sets its exposure for the screen rather than the
// room around it, and a touch darker, so a bright screen isn't washed out. Only what the camera
// says it can do; the rest is left as it is.
async function tuneCamera(track) {
  const caps = track?.getCapabilities?.() || {}, want = {}
  if (caps.zoom && caps.zoom.max >= 1.5) want.zoom = Math.min(2, caps.zoom.max)
  if (caps.exposureCompensation && caps.exposureCompensation.min < 0) want.exposureCompensation = Math.max(caps.exposureCompensation.min, -1)
  if (caps.focusMode?.includes('continuous')) want.focusMode = 'continuous'
  dbg('Camera can: ' + (Object.keys(caps).join(', ') || 'nothing it says') + ' · set: ' + (JSON.stringify(want)))
  if (!Object.keys(want).length) return
  try { await track.applyConstraints({advanced: [want]}) } catch (e) { dbg('Camera settings not taken: ' + e.message) }
}
// Beam's own link (this page or the web page, with a code) or just the 6 digits.
function codeFromQR(text) {
  const bare = cleanCode(text)
  if (/^\s*[\d\s-]+\s*$/.test(text) && validCode(bare)) return {code: bare, s: null}
  try {
    const u = new URL(text.trim())
    if (u.host !== location.host && !u.href.startsWith(WEB_APP_URL)) return null
    const r = parseLink(u.hash)
    return validCode(r.code) ? r : null
  } catch (e) { return null }
}
function showScan(on) {
  $('scan').hidden = !on
  $('scanBtn').hidden = on
  $('joinRow').hidden = on
}
async function startScan() {
  if (scanning) return
  const s = scanning = {stream: null}
  const hint = $('scanHint'), video = $('scanVideo')
  showScan(true)
  $('scan').scrollIntoView({block: 'center', behavior: 'smooth'})
  hint.textContent = 'Starting the camera…'
  try {
    // A sharp picture: by default some phones (iPhones) give a small one, too coarse for a code across the room.
    s.stream = await navigator.mediaDevices.getUserMedia({video: {facingMode: {ideal: 'environment'}, width: {ideal: 1920}, height: {ideal: 1080}}, audio: false})
    if (s !== scanning) return s.stream.getTracks().forEach(t => t.stop())
    video.srcObject = s.stream
    await video.play()
    const read = await qrReader()
    if (s !== scanning) return
    if (!read.native) await tuneCamera(s.stream.getVideoTracks()[0])
    if (s !== scanning) return
    hint.textContent = 'Point it at the QR code on the other device'
    // A screen in a dim room comes out blown to white until the camera sets itself for it, and
    // a code that small can't be read: filling the box with it does both.
    const slow = setTimeout(() => { if (s === scanning) hint.textContent = 'Can\'t read it yet? Move closer so the code fills the box' }, 3000)
    s.stop = () => clearTimeout(slow)
    while (s === scanning) {
      const text = video.readyState >= 2 ? await read(video).catch(() => null) : null
      if (s !== scanning) return
      const found = text && codeFromQR(text)
      if (found) return joinScanned(found)
      if (text) hint.textContent = 'That QR code isn\'t from Beam. Show Beam\'s QR code on the other device.'
      // Every new camera frame (where the browser says when there is one), else a few times a second.
      await (video.requestVideoFrameCallback ? new Promise(ok => { video.requestVideoFrameCallback(() => ok()); setTimeout(ok, 200) }) : sleep(60))
    }
  } catch (e) {
    if (s !== scanning) return
    stopScan()
    $('pairStatus').textContent = e.name === 'NotAllowedError' ? 'Camera access is off for this page. Allow it in the browser\'s settings, or type the code.'
      : e.name === 'NotFoundError' || e.name === 'OverconstrainedError' ? 'No camera found. Type the code instead.'
      : 'The camera couldn\'t start. Type the code instead.'
  }
}
function stopScan() {
  const s = scanning
  scanning = null
  s?.stop?.()
  if (s?.stream) s.stream.getTracks().forEach(t => t.stop())
  if (!CAN_SCAN) return
  $('scanVideo').srcObject = null
  showScan(false)
}
function joinScanned(r) {
  stopScan()
  if (r.code === code) { $('pairStatus').textContent = 'That is this device\'s own code. Scan the code on the other device.'; return }
  if (r.s !== null && r.s !== serverIndex) { serverIndex = r.s; $('pipeServer').value = String(serverIndex); tabStore.set(TS + 'server', String(serverIndex)) }
  setRoom(r.code, 'join')
}

// ---------- pairing: who joined, and the key only the hub and that device know ----------
// Each code gets a fresh ECDH key pair. "hello" carries a device's public key (directly, or
// through the relay sealed with the code's key); the hub and that device then derive the same
// AES key, which seals everything else sent between them through the relay. The hub accepts or
// declines; a device that joined waits for "welcome".
let keys = null, myPub = ''
function resetHandshake() {
  myNonce = randomHex()
  myCommit = sha256hex(myNonce)
  keys = crypto.subtle.generateKey({name: 'ECDH', namedCurve: 'P-256'}, false, ['deriveBits']).then(async k => {
    myPub = b64(await crypto.subtle.exportKey('raw', k.publicKey))
    return k
  })
}
async function sessionFor(pub) {
  const k = await keys
  const theirs = await crypto.subtle.importKey('raw', unb64(pub), {name: 'ECDH', namedCurve: 'P-256'}, false, [])
  const bits = await crypto.subtle.deriveBits({name: 'ECDH', public: theirs}, k.privateKey, 256)
  const hk = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey({name: 'HKDF', hash: 'SHA-256', salt: enc(APP + ':' + code), info: enc('beam relay')},
    hk, {name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt'])
}
// The check code: six digits, the same on both devices, made from both public keys, the room code
// and a fresh random value from each side. Someone else who got hold of the room code (or sat
// between the two) ends up with other keys, so a different code: the hub compares it before
// Accept, and it stays in Details.
// So that a go-between can't try key after key until the two codes happen to match, neither side
// can know the code before the other's value is fixed: the joining device first sends only a hash
// of its value ("commit", in its hello), the hub then sends its own value for that device
// ("check" with nh), and only then does the device show its value ("check" with nj), which the hub
// checks against the hash.
let myNonce = '', myCommit = null
const randomHex = () => hexOf(crypto.getRandomValues(new Uint8Array(16)))
const isHex = (v, len) => typeof v === 'string' && v.length === len && /^[0-9a-f]+$/.test(v)
async function updateCheck(L) {
  const nj = isHub() ? L.nj : myNonce
  if (!L.pub || !L.nh || !nj) return
  await keys
  const pub = L.pub
  const h = await crypto.subtle.digest('SHA-256', enc([APP, 'check', code, ...[myPub, pub].sort(), L.nh, nj].join(':')))
  if (L.pub !== pub) return
  const n = new DataView(h).getUint32(0) % 1000000
  L.check = String(n).padStart(6, '0').replace(/^(\d{3})/, '$1 ')
  if (isHub()) { if (asks[0] === L) showAsk() }
  else if (!L.accepted) showCheck($('joinCheck'), L.check)
  renderLinks()
}
// The hub: a device's hello came with its commit, so it gets the hub's value (the same one each time).
function sendNonce(L, via) {
  if (!L.commit || L.check) return
  if (!L.nh) L.nh = randomHex()
  if (via === 'direct') sendCtl(L, {t: 'check', nh: L.nh})
  else postHandshake(L, {t: 'check', nh: L.nh, to: L.pub})
}
// Both sides: the other's value. A device that joined answers with its own.
async function onCheck(L, m, via) {
  if (!L) return
  if (isHub()) {
    if (!isHex(m.nj, 32) || L.nj || !L.commit || (await sha256hex(m.nj)) !== L.commit) return
    L.nj = m.nj
  } else {
    if (!forMe(m) || !isHex(m.nh, 32)) return
    if (L.nh !== m.nh) { L.nh = m.nh; L.check = '' }
    if (via === 'direct') sendCtl(L, {t: 'check', nj: myNonce})
    else postHandshake(L, {t: 'check', nj: myNonce, pub: myPub})
  }
  updateCheck(L)
}
function showCheck(el, check) {
  el.hidden = !check
  el.querySelector('b').textContent = check || ''
}
function showChecks() {
  const list = [...links.values()].filter(L => L.known && L.check)
  const dd = $('checkCodes')
  if (!list.length) { dd.textContent = 'Shown once a device connects'; return }
  dd.textContent = list.map(L => (list.length > 1 ? nameOf(L) + ': ' : '') + L.check).join(' · ')
}
// "relay": the relay this device listens on (it may have come from a QR code, or be the default
// when the code was typed), so the hub answers it there.
async function helloMsg(t) {
  await keys
  const m = {t, v: APP, name: shownName(), pub: myPub, intent, relay: serverIndex}
  if (intent === 'join') m.commit = await myCommit
  return m
}

async function onHello(m, via, gen, conn, base) {
  if (gen !== generation) return
  if (m.v !== APP) { $('pairStatus').textContent = 'The other device has a different version of Beam. Update both, then try again.'; return }
  if (typeof m.pub !== 'string' || !m.pub || m.pub === myPub) return
  const name = String(m.name || 'Device').slice(0, 40)
  return isHub() ? hubHello(m, name, via, gen, conn, base) : joinerHello(m, name, via, gen)
}
// The hub: a device that entered the code says hello. It's asked about (Accept / Decline), let
// straight back in if it was here before, or turned away: with Broadcast off once a device is
// here (or being asked about), and with it on once the room has MAX_DEVICES.
async function hubHello(m, name, via, gen, conn, base) {
  if (m.intent !== 'join') return
  // The relay to answer this device on: the one its hello came through, or the one it names.
  const relay = base || (Number.isInteger(m.relay) && PIPE_SERVERS[m.relay]) || ''
  let L = links.get(m.pub)
  if (!L) {
    let key, id
    try { key = await sessionFor(m.pub); id = (await sha256hex(m.pub)).slice(0, 16) } catch (e) { dbg('Bad public key from a device', true); return }
    if (gen !== generation) return
    L = links.get(m.pub) // the same hello can arrive both ways at once
    if (!L) {
      // Two devices of the same kind ("iPhone/iPad · Safari") are told apart by a number.
      const taken = new Set([...links.values()].map(l => l.name))
      let shown = name
      for (let k = 2; taken.has(shown); k++) shown = name + ' (' + k + ')'
      L = newLink(m.pub, key, shown)
      L.id = id; L.baseName = name; L.relay = relay
      if (isHex(m.commit, 64)) L.commit = m.commit
      if (conn) { conn._link = L; L.lanes[0] = conn }
      // A game's full room: a player that dropped and hasn't come back gives up its place (most
      // often this same player, reloaded with a new key; the game knows it again by its id).
      if (GAME && links.size >= MAX_DEVICES) { const gone = [...links.values()].find(l => l.known && !l.accepted); if (gone) { removeLink(gone, 'Connection lost'); notify() } }
      // With Broadcast off, a device that dropped and is only waiting to come back doesn't keep
      // others out: a device that reloads comes back with a new key, so it looks like a new one.
      const holding = [...links.values()].filter(l => l.accepted || asks.includes(l)).length
      const why = declined.has(m.pub) ? 'declined' : links.size >= MAX_DEVICES ? 'full' : !broadcast && holding ? 'closed' : ''
      if (why) return turnAway(L, why)
      links.set(m.pub, L)
      if (GAME) L.letIn = true // a game lets in whoever has the code
      else {
        asks.push(L)
        showAsk()
        if (mode === 'waiting') $('pairStatus').textContent = 'Someone entered your code'
        log(name + ' wants to connect')
      }
    }
  }
  if (relay) L.relay = relay
  else if (name && L.known && name !== L.baseName) renameLink(L, name) // renamed while its link was down
  if (conn && L.lanes[0] !== conn) {
    // A device's direct link is its own: another connection can't take it over while it's open.
    if (direct(L) && L.lanes[0].peer !== conn.peer) { try { conn.close() } catch (e) {} return }
    const old = L.lanes[0]
    conn._link = L; L.lanes[0] = conn
    if (old) { try { old.close() } catch (e) {} }
  }
  // Through the relay the device hasn't heard from the hub yet: say hello back, so it can show
  // who it's waiting for.
  if (via === 'relay' && !L.helloBack) { L.helloBack = true; postHandshake(L, await helloMsg('hello')) }
  if (present(L)) sendNonce(L, via)
  if (L.known || L.letIn) { L.letIn = false; welcome(L) } // back after a dropped link, or let straight in
}
function turnAway(L, why) {
  declined.add(L.pub) // it asks again only with a new key, which means entering the code again
  sendCtl(L, {t: 'reject', why})
  postHandshake(L, {t: 'reject', why, to: L.pub})
  const c = L.lanes[0]
  if (c) setTimeout(() => { try { c.close() } catch (e) {} }, 1500)
  if (why === 'full') log('Turned away ' + L.name + ': the room already has ' + MAX_DEVICES + ' devices')
  if (why === 'closed') log('Turned away ' + L.name + ': Broadcast is off')
}
// A device that joined: the hub says hello (directly, or through the relay in answer to this
// device's hello there).
async function joinerHello(m, name, via, gen) {
  const L = hubLink()
  if (m.intent !== 'create' || !L) return
  // Once paired, only the hub this device joined counts while the link is up. While reconnecting,
  // a new key means the hub started over (it reloaded): it asks again, and this device follows.
  if (L.known && L.accepted && m.pub !== L.pub) return
  if (m.pub !== L.pub) {
    let key
    try { key = await sessionFor(m.pub) } catch (e) { dbg('Bad public key from the other device', true); return }
    if (gen !== generation) return
    L.key = key; L.pub = m.pub; L.check = ''
    updateCheck(L) // the hub's value may have come first
  }
  L.name = name
  if (!L.accepted) { $('pairStatus').textContent = 'Waiting for ' + name + ' to accept…'; showCheck($('joinCheck'), L.check) }
  if (via === 'relay' && !helloSentByRelay) sendHelloByRelay(gen)
}
function acceptAsk() {
  const L = asks.shift()
  if (L && present(L)) welcome(L)
  showAsk()
}
function welcome(L) {
  const fresh = !L.accepted
  L.accepted = true; L.known = true
  clearTimeout(L.lostTimer)
  // With Broadcast off this is the one device: any that dropped and hasn't come back is let go
  // (most often this same device, from before a reload), and it gets its plain name back.
  if (!broadcast) {
    for (const o of [...links.values()]) if (o !== L && o.known && !o.accepted) { removeLink(o, 'Connection lost'); log('Let go of the earlier connection to ' + nameOf(o)) }
    if (L.name !== L.baseName && ![...links.values()].some(o => o !== L && o.name === L.baseName)) L.name = L.baseName
  }
  sendCtl(L, {t: 'welcome'})
  helloMsg('welcome').then(m => postHandshake(L, {...m, to: L.pub}))
  if (fresh) enterConnected(L)
}
// Relay handshake messages name the device they're for ("to").
const forMe = m => !m || !m.to || m.to === myPub
function onWelcome(m, gen) {
  const L = hubLink()
  if (gen !== generation || !L || !forMe(m)) return
  if (L.accepted) return dialExtraLanes(L, gen)
  const go = () => {
    if (gen !== generation || L.accepted) return
    L.accepted = true; L.known = true
    enterConnected(L)
    dialExtraLanes(L, gen)
  }
  // Through the relay the welcome carries the hub's key, in case its hello never arrived.
  if (m && m.pub && m.pub !== L.pub) {
    L.name = String(m.name || L.name || 'Device').slice(0, 40)
    sessionFor(m.pub).then(k => { if (gen !== generation) return; L.key = k; L.pub = m.pub; L.check = ''; updateCheck(L); go() }, () => {})
  } else if (L.pub) go()
}
function onReject(m, gen) {
  const L = hubLink()
  if (gen !== generation || !L || L.known || !forMe(m)) return
  const why = m && m.why
  log(why === 'full' ? 'That room is full' : why === 'closed' ? 'The other device is already connected to another device' : 'The other device declined', true)
  if (startOver(why === 'full' ? 'full' : 'declined')) return
  setRoom('', 'create')
  $('pairStatus').textContent = why === 'full' ? 'That room already has ' + MAX_DEVICES + ' devices. Here\'s a code of your own to share instead.'
    : why === 'closed' ? 'That device is already connected to another one. Ask them to turn on Broadcast, or share this new code.'
    : 'The other device declined. Share this new code to try again.'
}
function decline() {
  const L = asks.shift()
  showAsk()
  if (!L) return
  links.delete(L.pub)
  log('Declined ' + L.name)
  turnAway(L, 'declined')
  if (links.size) return renderLinks() // others are here or asking: the code stays
  setTimeout(() => {
    setRoom('', 'create')
    $('pairStatus').textContent = 'Declined. Here\'s a new code, so that device can\'t try again.'
  }, 300)
}
function enterConnected(L) {
  if (mode !== 'connected') setMode('connected')
  log('Connected to ' + nameOf(L) + (direct(L) ? '' : ' through the encrypted relay'))
  if (direct(L)) checkPath(L, L.lanes[0], generation, 0)
  renderLinks()
}
// The hub: a device left, or stopped asking. Its transfers stop and its connections close.
function removeLink(L, note) {
  clearTimeout(L.lostTimer)
  for (const x of [...activeX]) if (x.link === L) stopXfer(x, note)
  for (const r of [...L.inX.values()]) endIn(L, r)
  links.delete(L.pub)
  asks = asks.filter(a => a !== L)
  showAsk()
  const lanes = L.lanes
  L.lanes = []
  setTimeout(() => lanes.forEach(c => { try { c && c.close() } catch (e) {} }), 300) // let a goodbye leave first
  showLaneCount()
  renderLinks()
}
// The hub, once the last device has left: with Broadcast on (or someone still asking) it keeps
// its code; otherwise it moves to a fresh code, so nobody reconnects by accident.
function afterLeave(what) {
  if (roomLinks().length) return
  if (broadcast || asks.length) { setMode('waiting'); $('pairStatus').textContent = what + '. Others can still join with this code.'; return }
  setRoom('', 'create')
  $('pairStatus').textContent = what + '. Share this new code to connect again.'
}
function onLinkBye(L) {
  if (!present(L)) return
  const known = L.known, asking = asks.includes(L)
  removeLink(L, 'Stopped: ' + nameOf(L) + ' disconnected')
  if (!known) {
    // It canceled before being accepted: its request is gone, and this device waits again.
    if (asking) log(nameOf(L) + ' canceled')
    if (mode === 'waiting' && !asks.length) $('pairStatus').textContent = waitingText()
    return
  }
  log(nameOf(L) + ' ended the connection')
  afterLeave(L.name + ' disconnected')
}
// The hub's ✕ beside a device: just that one is disconnected.
function kick(L) {
  sayBye(L)
  log('Disconnected ' + nameOf(L))
  removeLink(L, 'Stopped')
  afterLeave(L.name + ' was disconnected')
}
// The hub lost a device's direct link: it's let back in without asking when it says hello again
// (directly or through the relay), and given up after 2 minutes.
function linkLost(L) {
  holdAllIn(L) // files coming in wait for it, to carry on
  L.lanes.forEach(c => { try { c && c.close() } catch (e) {} })
  L.lanes = []
  showLaneCount()
  if (!L.accepted) return
  L.accepted = false
  log('Lost the connection to ' + nameOf(L) + '. Waiting for it to come back…', true)
  renderLinks()
  clearTimeout(L.lostTimer)
  L.lostTimer = setTimeout(() => {
    if (!present(L) || L.accepted) return
    log(nameOf(L) + ' didn\'t come back')
    removeLink(L, 'Connection lost')
    afterLeave(L.name + ' disconnected')
  }, 120000)
}

// ---------- browser check ----------
// The browser offers no routes for a direct link at all. iPhones' engine sometimes takes a while
// to start them, so a check that ends with none found but hadn't finished isn't a verdict: it's
// tried again (twice, 20 s apart) before the browser is said to block them; a direct link that
// opens clears it.
let webrtcBlocked = false
async function probeWebRTC(tries = 0) {
  const found = {host: 0, srflx: 0, any: 0}, errors = [], t0 = Date.now()
  let pc
  try {
    pc = new RTCPeerConnection({iceServers: STUN})
    pc.createDataChannel('probe')
    pc.onicecandidate = ev => {
      const c = ev.candidate; if (!c || !c.candidate) return
      found.any++
      const t = (c.candidate.match(/ typ (\w+)/) || [])[1]
      if (t in found) found[t]++
      dbg('Browser check: route ' + (t || '?') + ' (' + (c.protocol || '') + (c.address ? ', ' + (c.address.endsWith('.local') ? 'hidden local address' : 'address shown') : '') + ')')
    }
    // Why the connection servers didn't answer, where the browser says (shown with ?dev).
    pc.onicecandidateerror = ev => errors.push((ev.url || '') + ' ' + (ev.errorCode || '') + ' ' + (ev.errorText || ''))
    await pc.setLocalDescription(await pc.createOffer())
    await new Promise(r => {
      const t = setTimeout(r, 6000)
      pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); r() } }
    })
  } catch (e) { dbg('Browser check failed: ' + (e.message || e), true) }
  dbg('Browser check: ' + found.any + ' routes (' + found.host + ' local, ' + found.srflx + ' through the internet) in ' + (Date.now() - t0) + ' ms, gathering ' + (pc ? pc.iceGatheringState : 'not started') + (errors.length ? ' · server errors: ' + errors.slice(0, 4).join(' | ') : ' · no server errors'))
  const finished = pc?.iceGatheringState === 'complete'
  try { pc && pc.close() } catch (e) {}
  if (!found.any && !finished && tries < 2) {
    dbg('Browser check: nothing yet, checking again in 20 s')
    setTimeout(() => { if (!directSeen) probeWebRTC(tries + 1) }, 20000)
    return
  }
  if (directSeen) return // a direct link opened meanwhile: they aren't blocked
  webrtcBlocked = found.any === 0
  if (webrtcBlocked) {
    pillIn($('selfState'), 'Direct connections blocked', 'bad')
    // On an iPhone or iPad, the system's direct-connection engine sometimes gets stuck, in every
    // browser at once, until the device is restarted; Safari's own privacy settings come next.
    const ua = navigator.userAgent
    if (MOBILE && /iPhone|iPad|iPod|Macintosh/.test(ua)) {
      const dev = /iPad/.test(ua) || /Macintosh/.test(ua) ? 'iPad' : 'iPhone'
      const safari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|GSA\/|DuckDuckGo/.test(ua)
      $('blockedNotice').textContent = (safari ? 'Safari' : 'This browser') + ' isn\'t making direct connections. Restarting the ' + dev + ' usually fixes this'
        + (safari ? '; otherwise it\'s often iCloud Private Relay, Advanced Tracking and Fingerprinting Protection set to All Browsing, or a content blocker.' : '; otherwise it\'s often a VPN or a content filter.')
        + ' Meanwhile files go through the slower relay, and Beam switches to direct once it can.'
    }
    $('blockedNotice').hidden = false
    log('This browser blocks direct connections, so files will use the slower relay', true)
  } else if (!found.srflx) pillIn($('selfState'), 'Direct OK on this Wi-Fi only', 'warn')
  else pillIn($('selfState'), 'Direct connections allowed', 'good')
}

// With ?dev: a longer look (30 s) at which routes come and when, including through the TURN
// relay over UDP and TCP, and why connection servers don't answer.
async function deepProbe() {
  const t0 = Date.now(), seen = {}, errors = []
  let pc
  try {
    pc = new RTCPeerConnection({iceServers: [...STUN, TURN.express]})
    pc.createDataChannel('probe')
    pc.onicecandidate = ev => {
      const c = ev.candidate; if (!c || !c.candidate) return
      const t = (c.candidate.match(/ typ (\w+)/) || [])[1] || '?', p = (c.candidate.match(/ (udp|tcp) /i) || [])[1] || ''
      const k = t + '/' + p.toLowerCase()
      if (!seen[k]) { seen[k] = Date.now() - t0; dbg('Long check: first ' + k + ' route after ' + seen[k] + ' ms') }
    }
    pc.onicecandidateerror = ev => { if (errors.length < 6) errors.push((ev.url || '?') + ' → ' + (ev.errorCode || '') + ' ' + (ev.errorText || '')) }
    await pc.setLocalDescription(await pc.createOffer())
    await new Promise(r => {
      const t = setTimeout(r, 30000)
      pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); r() } }
    })
  } catch (e) { dbg('Long check failed: ' + (e.message || e), true) }
  dbg('Long check done in ' + (Date.now() - t0) + ' ms, gathering ' + (pc ? pc.iceGatheringState : '-') + ': ' + (Object.keys(seen).join(', ') || 'no routes at all') + (errors.length ? ' · server errors: ' + errors.join(' | ') : ' · no server errors'))
  try { pc && pc.close() } catch (e) {}
}

let directSeen = false
function directWorks() {
  if (directSeen) return
  directSeen = true
  if (!webrtcBlocked) return
  webrtcBlocked = false
  $('blockedNotice').hidden = true
  pillIn($('selfState'), 'Direct connections allowed', 'good')
}

// ---------- direct (PeerJS) ----------
// The hub claims the room's ID; each device that joins connects to it and opens up to 4 parallel
// connections ("lanes"). Lane 0 carries control messages. File pieces are spread over the lanes,
// each tagged with its transfer number and offset.
let peer = null, peerUp = false
let lastUnavailable = 0
const hostId = () => APP + '-' + code

function showLaneCount() {
  notify()
  const n = [...links.values()].reduce((s, L) => s + L.lanes.filter(c => c && c.open).length, 0)
  pillIn($('laneState'), n + ' open', n ? 'good' : 'muted')
}
function closeAllLanes() {
  for (const L of links.values()) { L.lanes.forEach(c => { try { c && c.close() } catch (e) {} }); L.lanes = [] }
  showLaneCount()
}

function startPeer(gen) {
  if (peer) { try { peer.destroy() } catch (e) {} peer = null }
  peerUp = false
  pillIn($('peerState'), 'Connecting to server', 'muted')
  // Pairing doesn't wait for the connection service: if it can't be reached (some networks
  // block it), the devices pair and send through the relay alone.
  setTimeout(() => relayOnly(gen), 10000)
  if (typeof Peer === 'undefined') { pillIn($('peerState'), 'PeerJS did not load', 'bad'); relayOnly(gen); return }
  if (isHub()) claimHost(gen)
  else joinAsGuest(gen)
}
function relayOnly(gen) {
  if (gen !== generation || peerUp || isHub()) return
  dbg('No connection service: pairing through the relay')
  sendHelloByRelay(gen)
}

// Back to the connection service after it dropped, after a pause (straight away it may still
// hold the old connection, and say the ID is taken).
function reconnectSoon(p, gen, ms) {
  if (p._egReconnect) return
  p._egReconnect = setTimeout(() => {
    p._egReconnect = 0
    if (gen === generation && p === peer && p.disconnected && !p.destroyed) { try { p.reconnect() } catch (e) {} }
  }, ms)
}

function claimHost(gen) {
  const p = new Peer(hostId(), {debug: 1, config: iceConfig()})
  peer = p
  let held = false // this Peer had the code: a later "taken" is its own old connection
  p.on('open', () => {
    if (gen !== generation) return
    held = true
    peerUp = true
    pillIn($('peerState'), 'Waiting for devices', 'muted')
    dbg('Holding this room')
  })
  // Lane 0 from anyone (who it is shows in its hello); more lanes only from an accepted device.
  p.on('connection', c => {
    if (gen !== generation) return
    const lane = (c.metadata && c.metadata.lane) | 0
    if (!lane) return setupLane(null, c, 0, gen)
    const L = [...links.values()].find(l => l.accepted && l.lanes[0] && l.lanes[0].peer === c.peer)
    if (!L || lane >= MAX_LANES) { try { c.close() } catch (e) {} return }
    setupLane(L, c, lane, gen)
  })
  p.on('error', err => {
    if (gen !== generation) return
    if (err.type === 'unavailable-id') {
      // Reconnecting mid-session: the service still holds this device's old connection for a
      // while. PeerJS keeps the device links open meanwhile, so just try again later; the code
      // stays and nobody is cut off.
      if (held) { reconnectSoon(p, gen, 5000); return }
      p.destroy()
      // Back after a reload: the old session can hold the code for a few seconds, so try again.
      if (reclaims > 0) { reclaims--; setTimeout(() => { if (gen === generation) claimHost(gen) }, 3000); return }
      // A code this device just made is already in use by someone else: pick another.
      dbg('Code ' + code + ' was already in use, picking another')
      setRoom(randomCode(), 'create')
      return
    }
    handlePeerError(err)
  })
  p.on('disconnected', () => { if (gen === generation && !p.destroyed) reconnectSoon(p, gen, 1000) })
}

function joinAsGuest(gen) {
  const p = new Peer({debug: 1, config: iceConfig()})
  peer = p
  let misses = 0
  p.on('open', () => {
    if (gen !== generation) return
    peerUp = true
    dbg('Joining the device that made this code')
    dialLane(0, gen)
  })
  p.on('error', err => {
    if (gen !== generation) return
    if (err.type === 'peer-unavailable') {
      misses++; lastUnavailable = Date.now()
      const L = hubLink()
      if (L && !L.pub) $('pairStatus').textContent = 'The other device isn\'t online yet…'
      if (misses === 3) sendHelloByRelay(gen) // it may be reachable through the relay only
      setTimeout(() => { if (gen === generation && !direct(hubLink())) dialLane(0, gen) }, misses < 10 ? 3000 : 10000)
    } else handlePeerError(err)
  })
  p.on('disconnected', () => { if (gen === generation && !p.destroyed) reconnectSoon(p, gen, 1000) })
}

function dialLane(i, gen) {
  if (!peer || peer.destroyed || gen !== generation || !hubLink()) return
  // Without the connection service a new link can't be made (PeerJS gives nothing back): get it
  // back, try lane 0 again shortly, and meanwhile say hello through the relay.
  const c = peer.disconnected ? null : peer.connect(hostId(), {serialization: 'raw', reliable: true, metadata: {lane: i}})
  if (!c) {
    if (i !== 0) return
    reconnectSoon(peer, gen, 0)
    sendHelloByRelay(gen)
    setTimeout(() => { if (gen === generation && !direct(hubLink())) dialLane(0, gen) }, 3000)
    return
  }
  setupLane(hubLink(), c, i, gen)
}
// On the relay because the direct link didn't open (a slow start, a network that changed): it's
// tried again in the background, a minute apart, up to 10 times, and the connection moves over
// when it opens. Not while files are moving, so none is cut off halfway.
const DIRECT_RETRIES = 10
function directLater(L, gen) {
  L.directTries = (L.directTries || 0) + 1
  if (L.directTries > DIRECT_RETRIES) return
  clearTimeout(L.directTimer)
  L.directTimer = setTimeout(function again() {
    if (gen !== generation || hubLink() !== L || direct(L) || !peer || peer.destroyed) return
    if (activeX.size) { L.directTimer = setTimeout(again, 15000); return }
    dbg('Trying a direct link again')
    const c = peer.disconnected ? null : peer.connect(hostId(), {serialization: 'raw', reliable: true, metadata: {lane: 0}})
    if (!c) return directLater(L, gen)
    c._retry = true
    setupLane(L, c, 0, gen)
  }, 60000)
}
function dialExtraLanes(L, gen) {
  if (isHub() || !direct(L)) return
  for (let k = 1; k < MAX_LANES; k++) if (!L.lanes[k]) dialLane(k, gen)
}

let lastServerWarn = 0
function handlePeerError(err) {
  dbg('Direct link: ' + (err.type || '') + ' ' + (err.message || err), true)
  if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error') {
    pillIn($('peerState'), 'Server unreachable', 'bad')
    if (!peerUp) relayOnly(generation)
    // Safari drops this connection while the page is in the background and it comes back by
    // itself, so the user is told only when it's still down 10 seconds later (and once a minute
    // at most: PeerJS reports it several times in a row).
    const gen = generation, p = peer
    setTimeout(() => {
      if (gen !== generation || p !== peer || (p && p.open && !p.disconnected)) return
      if (Date.now() - lastServerWarn > 60000) { lastServerWarn = Date.now(); log('Can\'t reach the connection service. Check your internet connection.', true) }
    }, 10000)
  }
}

// L is the device the connection belongs to; on the hub a new lane 0 has none until its hello.
function setupLane(L, c, i, gen) {
  if (L) {
    if (L.lanes[i] && L.lanes[i] !== c) { try { L.lanes[i].close() } catch (e) {} }
    L.lanes[i] = c
    c._link = L
  }
  let timer = null
  if (i === 0) {
    if (L) { L.path = ''; L.relayName = ''; L.theirRelay = '' } // a new link: its route is looked at afresh
    if (!isHub()) pillIn($('peerState'), 'Connecting…', 'muted')
    timer = setTimeout(() => {
      if (gen !== generation || c.open) return
      if (isHub()) { try { c.close() } catch (e) {} return } // the device falls back to the relay by itself
      if (hubLink() !== L || L.lanes[0] !== c) return
      if (c._retry) { dbg('Direct link still not possible, staying on the relay'); return directLater(L, gen) }
      pillIn($('peerState'), 'Failed · relay will be used', 'bad')
      if (Date.now() - lastUnavailable > 20000) {
        log('Couldn\'t connect directly, so the encrypted relay will be used')
        dbg(webrtcBlocked ? 'WebRTC is blocked in this browser' : 'Direct link failed, including PeerJS\'s relay', true)
      }
      sendHelloByRelay(gen) // pair through the relay instead
      directLater(L, gen)
    }, 20000)
  }
  c.on('open', () => {
    if (gen !== generation) return
    c._opened = true
    showLaneCount()
    if (i !== 0) return
    clearTimeout(timer)
    helloMsg('hello').then(m => { if (gen === generation) { try { c.send(JSON.stringify(m)) } catch (e) {} } })
    if (!isHub()) pillIn($('peerState'), 'Connected', 'good')
    directWorks()
    if (c._retry) log('Switched to a direct connection')
    dbg('Direct link connected')
    const own = c._link
    if (own && own.accepted) { renderLinks(); checkPath(own, c, gen, 0) }
  })
  c.on('data', d => onPeerData(d, gen, c))
  c.on('close', () => {
    const own = c._link
    // While disconnecting on purpose, the other side hanging up isn't a lost connection.
    if (gen !== generation || ending || !own || own.lanes[i] !== c) return
    own.lanes[i] = null
    showLaneCount()
    if (i !== 0) return
    if (!c._opened) return // a try at a direct link that never opened: nothing was lost
    if (isHub()) return linkLost(own)
    log('Connection lost. Trying to reconnect…', true)
    pillIn($('peerState'), 'Disconnected', 'warn')
    holdAllIn(own) // files coming in wait for it, to carry on
    own.lanes.forEach(l => { try { l && l.close() } catch (e) {} })
    own.lanes = []
    showLaneCount()
    own.accepted = false // the hub lets this device back in without asking
    helloSentByRelay = false // if the direct link doesn't come back, it says hello through the relay again
    setMode('waiting')
    $('pairStatus').textContent = 'Reconnecting…'
    setTimeout(() => { if (gen === generation && !direct(own)) dialLane(0, gen) }, 3000)
  })
  c.on('error', e => dbg('Direct link ' + i + ': ' + (e.message || e), true))
}

// The servers a direct link may use: all of them, or (Details, for testing) one TURN relay only.
function iceConfig() {
  const via = $('turnVia').value
  return TURN[via] ? {iceServers: [...STUN, TURN[via]], iceTransportPolicy: 'relay'} : {iceServers: ICE_SERVERS}
}
function showPath(L, v, via) {
  if (L.path === 'lan' && v === 'internet') return // if either device saw a same-Wi-Fi link, that is the true path
  // A relay on the other side is named by that device (its "path" message, kept in L.theirRelay,
  // which can arrive before this side has looked at its own connection).
  if (v === 'relay') L.relayName = via || L.relayName || L.theirRelay || ''
  else L.relayName = ''
  L.path = v
  renderLinks()
  if (!isHub()) {
    const [text, tone] = routeOf(L)
    pillIn($('peerState'), 'Connected · ' + text.replace('Direct · ', '').replace('Direct via ', 'via '), tone)
  }
}

// Whether two addresses are on one local network: the same IPv6 /64 (a home network's own
// prefix) or the same IPv4 /24. A name or an unknown address never is.
function sameNetwork(a, b) {
  const v6 = s => {
    if (!s.includes(':')) return null
    const [head, tail = ''] = s.toLowerCase().split('%')[0].split('::')
    const h = head ? head.split(':') : [], t = tail ? tail.split(':') : []
    if (!s.includes('::') && h.length !== 8) return null
    return [...h, ...Array(8 - h.length - t.length).fill('0'), ...t].slice(0, 4).map(x => parseInt(x, 16)).join(':')
  }
  const v4 = s => /^\d+\.\d+\.\d+\.\d+$/.test(s) ? s.split('.').slice(0, 3).join('.') : null
  const pa = v6(a) || v4(a), pb = v6(b) || v4(b)
  return !!pa && pa === pb
}

async function checkPath(L, c, gen, tries) {
  const pc = c && c.peerConnection
  if (!pc || gen !== generation || L.lanes[0] !== c) return
  try {
    const stats = await pc.getStats()
    let pairId = null, pair = null
    stats.forEach(r => { if (r.type === 'transport' && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId })
    if (pairId) pair = stats.get(pairId)
    if (!pair) stats.forEach(r => { if (!pair && r.type === 'candidate-pair' && r.state === 'succeeded' && (r.nominated || r.selected)) pair = r })
    const l = pair && stats.get(pair.localCandidateId), r = pair && stats.get(pair.remoteCandidateId)
    if (l) {
      const relay = l.candidateType === 'relay' || (r && r.candidateType === 'relay')
      // Only the device whose side is relayed knows which relay; it tells the other (below).
      const via = l.candidateType === 'relay' ? relayName(l.url || '') : ''
      const addr = (r && (r.address || r.ip)) || ''
      const privateAddr = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|fe80:|fc|fd)/i.test(addr) || /\.local$/i.test(addr)
      // A device's own (host) address isn't proof of a shared Wi-Fi: on IPv6, a phone on mobile
      // data and a computer on Wi-Fi often both have public addresses and reach each other over
      // the internet. Two public addresses count as the same network only when they share it.
      const lan = privateAddr || sameNetwork((l.address || l.ip) || '', addr)
      showPath(L, relay ? 'relay' : lan ? 'lan' : 'internet', via)
      sendCtl(L, {t: 'path', v: L.path, via: L.relayName || undefined})
      return
    }
  } catch (e) {}
  if (tries < 10) setTimeout(() => checkPath(L, c, gen, tries + 1), 1000)
}

function sendCtl(L, obj) { const c = L && L.lanes[0]; try { if (c && c.open) c.send(JSON.stringify(obj)) } catch (e) {} }

// ----- receiving direct -----
// Each link keeps its own incoming transfers (L.inX: transfer number -> record), and the ids of
// files it has had in full (L.gotIds, id -> checked), in case the sender asks again.
// A file comes in BLOCK by BLOCK: a block's pieces are gathered in memory, and once it's whole it
// goes to the file's store (storeFor) and, when the sender gave one, is checked against that
// block's SHA-256. The file is done when every block is in and checked.
// A transfer cut off by a lost connection is held for HOLD_MS: the sender, once it's back, carries
// on from the first block that hadn't come in (resumeIn) rather than starting over.
const readyWaiters = new Map(), peerAcks = new Map(), peerCanceled = new Map()
const storedOut = new Map() // a file this device is sending: id -> {n: blocks the other device has stored}
const HOLD_MS = 120000
const OPEN_BLOCKS = 24 // blocks being gathered at once; the sender keeps far fewer in flight

function onPeerData(d, gen, c) {
  const L = c._link
  if (typeof d === 'string') {
    let m; try { m = JSON.parse(d) } catch (e) { return }
    if (m.t === 'hello') return onHello(m, 'direct', gen, c)
    if (!L) return
    switch (m.t) {
      case 'welcome': if (!isHub()) onWelcome(m, gen); return
      case 'reject': if (!isHub()) onReject(m, gen); return
      case 'bye': if (isHub()) onLinkBye(L); else onBye(); return
      case 'check': onCheck(L, m, 'direct'); return
    }
    if (!L.accepted) return // nothing else until this device is accepted
    switch (m.t) {
      case 'active': markActive(true); return
      case 'path':
        if (m.v === 'lan' && L.path !== 'relay') showPath(L, 'lan')
        if (m.v === 'relay' && typeof m.via === 'string') {
          L.theirRelay = relayName(m.via.toLowerCase().replace(/ /g, '')) || ''
          if (L.path === 'relay' && !L.relayName) showPath(L, 'relay', L.theirRelay)
        }
        break
      case 'meta': if (!GAME) onMeta(L, m); break // a game room takes no files
      case 'bh': onBlockHash(L, m); break
      case 'hold': { const r = findIn(L, m.id); if (r) holdIn(L, r); break }
      case 'g': if (GAME) { markActive(true); GAME.onData(isHub() ? L.pub : 'hub', m.d) } break
      case 'chat': if (!GAME) onChat(L, m); break
      case 'name': if (!GAME) onName(L, m); break
      case 'ready': { const f = readyWaiters.get(m.id); if (f) f(m); break }
      case 'got': { const o = storedOut.get(m.id); if (o && Number.isInteger(m.n) && m.n > o.n) o.n = m.n; break }
      case 'ack': { const f = peerAcks.get(m.id); if (f) f(m); break }
      case 'prog': { const o = outgoingPipe.get(m.id); if (o) o.progress(m.n); break } // a relay file's progress, told over the direct link
      case 'cancel': cancelIn(L, m); break
    }
    return
  }
  if (L && L.accepted) onChunk(L, d)
}
// The other device stopped a file: one coming in here (gone through the relay instead, or
// canceled), or one going out from here.
function cancelIn(L, m) {
  const r = findIn(L, m.id)
  if (r && m.why === 'relay') { endIn(L, r); finishXfer(r.x, 'failed', ''); dropRow(r.x) } // it comes again as a relay row
  else if (r) { endIn(L, r); finishXfer(r.x, 'failed', 'Canceled by sender'); log(nameOf(L) + ' canceled ' + r.meta.name) }
  if (peerAcks.has(m.id)) peerCanceled.set(m.id, m.why || '') // only for a file this device is sending; dropped when it ends
  const a = readyWaiters.get(m.id); if (a) a(false)
  const k = peerAcks.get(m.id); if (k) k(false)
}

// A file's description is checked before any memory or disk is set aside for it.
const validId = id => typeof id === 'string' && id.length > 0 && id.length <= 64
const validSize = n => Number.isSafeInteger(n) && n >= 0
const findIn = (L, id) => [...L.inX.values()].find(r => r.id === id)
async function onMeta(L, m) {
  if (!validId(m.id) || !validSize(m.size) || !Number.isInteger(m.num) || m.num < 0 || m.num > 0xffffffff || L.inX.has(m.num)) {
    dbg('Ignored a file description that didn\'t make sense', true)
    if (validId(m.id)) sendCtl(L, {t: 'cancel', id: m.id})
    return
  }
  // Asked again for a file already here (its confirmation got lost): it's confirmed again.
  if (L.gotIds && L.gotIds.has(m.id)) { sendCtl(L, {t: 'ready', id: m.id, num: m.num, from: m.size}); sendCtl(L, {t: 'ack', id: m.id, checked: L.gotIds.get(m.id)}); return }
  // One canceled here (perhaps while the connection was down, so the sender never heard): no again.
  if (L.droppedIds && L.droppedIds.has(m.id)) { sendCtl(L, {t: 'cancel', id: m.id}); return }
  const had = findIn(L, m.id)
  if (had) return resumeIn(L, had, m)
  // Its store is still being set up: the sender asked again (under a new number), which is the one answered.
  if (!L.opening) L.opening = new Map()
  if (L.opening.has(m.id)) { L.opening.set(m.id, m); return }
  m.name = String(m.name || 'file').slice(0, 255)
  m.type = typeof m.type === 'string' ? m.type.slice(0, 100) : ''
  const gen = generation
  let store
  L.opening.set(m.id, m)
  try { store = await storeFor(m.size, m.type) }
  catch (e) { L.opening.delete(m.id); sendCtl(L, {t: 'cancel', id: m.id, why: 'space'}); log('This device doesn\'t have enough memory for ' + m.name, true); return }
  const last = L.opening.get(m.id)
  L.opening.delete(m.id)
  if (gen !== generation || !present(L) || !L.accepted || L.inX.has(last.num)) { store.discard(); return }
  m.num = last.num
  const x = getXfer(m.id, m.name, m.size, 'in', 'Direct', L)
  setStatus(x, 'Starting…')
  const blocks = Math.ceil(m.size / BLOCK)
  // stored: per block, 0 not yet, 1 whole and on its way into the store, 2 in the store.
  // want: the sender's SHA-256 per block, got: this side's, ok: blocks whose two match.
  const r = {id: m.id, num: m.num, meta: m, store, x, began: false, blocks, open: new Map(), partial: 0,
    stored: new Uint8Array(blocks), nStored: 0, storedBytes: 0, check: m.check === 'sha256', want: new Map(), got: new Map(), ok: new Set(),
    holdTimer: 0, over: false}
  L.inX.set(m.num, r)
  x.cancel = () => {
    tellDropped(L, r.id); endIn(L, r)
    finishXfer(x, 'failed', 'Canceled'); log('Canceled ' + m.name)
  }
  x.abort = () => endIn(L, r)
  // got: this side says how many blocks it has stored, so the sender doesn't run too far ahead.
  sendCtl(L, {t: 'ready', id: m.id, num: m.num, got: true})
  doneIn(L, r) // an empty file is already whole
}
// The transfer is over here (done, failed or canceled): it takes no more pieces, and unless it
// was done, its store is let go of.
function endIn(L, r) {
  if (r.over) return
  r.over = true
  clearTimeout(r.holdTimer)
  if (L.inX.get(r.num) === r) L.inX.delete(r.num)
  r.open.clear()
  if (!r.done) r.store.discard()
}
// Told directly or through the relay, and remembered, in case the sender comes back with it later.
function tellDropped(L, id, why) {
  if (!L.droppedIds) L.droppedIds = new Set()
  L.droppedIds.add(id)
  toLink(L, {t: 'cancel', id, why})
}
function failIn(L, r, text, why = 'failed') {
  if (r.over) return
  tellDropped(L, r.id, why)
  endIn(L, r)
  finishXfer(r.x, 'failed', text)
  log('Couldn\'t receive ' + r.meta.name + ': ' + text.replace(/^Failed: /, ''), true)
}

function onChunk(L, d) {
  let view
  if (d instanceof ArrayBuffer) view = new DataView(d)
  else if (d && ArrayBuffer.isView(d)) view = new DataView(d.buffer, d.byteOffset, d.byteLength)
  else return
  if (view.byteLength < HDR) return
  const r = L.inX.get(view.getUint32(0))
  if (!r || r.over) return // a canceled or unknown transfer
  const off = view.getFloat64(4)
  const data = new Uint8Array(view.buffer, view.byteOffset + HDR, view.byteLength - HDR)
  if (!Number.isInteger(off) || off < 0 || off + data.length > r.meta.size) return
  const i = Math.floor(off / BLOCK), from = i * BLOCK, len = Math.min(BLOCK, r.meta.size - from)
  if (off + data.length > from + len || r.stored[i]) return // across a block (never sent so), or a block already here
  let b = r.open.get(i)
  if (!b) {
    if (r.open.size >= OPEN_BLOCKS) return failIn(L, r, 'Failed: pieces came in too far out of order')
    b = {buf: new Uint8Array(len), got: 0}
    r.open.set(i, b)
  }
  if (!r.began) { r.began = true; r.x.start = performance.now(); r.x.base = r.storedBytes }
  b.buf.set(data, off - from)
  b.got += data.length
  r.partial += data.length
  updateXfer(r.x, r.storedBytes + r.partial)
  if (b.got >= len) { r.open.delete(i); r.partial -= b.got; blockIn(L, r, i, b.buf) }
}
// A whole block: checked (when the sender gives SHA-256s) and put in the store.
async function blockIn(L, r, i, buf) {
  r.stored[i] = 1
  r.storedBytes += buf.length
  try {
    if (r.check) r.got.set(i, hexOf(await crypto.subtle.digest('SHA-256', buf)))
    await r.store.put(i * BLOCK, buf) // a block going to disk is handed over, not copied
  } catch (e) {
    return failIn(L, r, e.quota ? 'Failed: not enough storage space on this device' : 'Failed: couldn\'t save it (' + (e.message || e) + ')', 'space')
  }
  if (r.over) return
  r.stored[i] = 2
  r.nStored++
  sendCtl(L, {t: 'got', id: r.id, n: r.nStored})
  checkBlock(L, r, i)
}
// The sender's SHA-256 for one block, sent along with it.
function onBlockHash(L, m) {
  const r = findIn(L, m.id)
  if (!r || r.over || !Number.isInteger(m.i) || m.i < 0 || m.i >= r.blocks || !/^[0-9a-f]{64}$/.test(m.h)) return
  r.want.set(m.i, m.h)
  checkBlock(L, r, m.i)
}
function checkBlock(L, r, i) {
  if (r.check) {
    const want = r.want.get(i), got = r.got.get(i)
    if (!want || !got || r.stored[i] !== 2) return
    if (want !== got) return failIn(L, r, 'Failed: it didn\'t arrive intact. Send it again.', 'check')
    r.ok.add(i)
  }
  doneIn(L, r)
}
async function doneIn(L, r) {
  if (r.over || r.nStored < r.blocks || (r.check && r.ok.size < r.blocks)) return
  r.done = true
  endIn(L, r)
  let blob
  try { blob = await r.store.finish() }
  catch (e) { r.store.discard(); sendCtl(L, {t: 'cancel', id: r.id, why: 'space'}); finishXfer(r.x, 'failed', 'Failed: couldn\'t save it (' + (e.message || e) + ')'); return }
  if (!L.gotIds) L.gotIds = new Map()
  L.gotIds.set(r.id, r.check)
  updateXfer(r.x, r.meta.size, r.meta.size, true)
  finishXfer(r.x, 'done', 'Received in ' + fmtTime(r.x.ms) + (r.check ? ' · Checked' : ''))
  r.x.free = () => r.store.discard()
  offerSave(r.x, blob, r.meta.name)
  sendCtl(L, {t: 'ack', id: r.id, checked: r.check})
  log('Received ' + r.meta.name + (r.check ? ', checked: every part matches what was sent' : ''))
  dbg('Direct at ' + fmtRate(r.meta.size - r.x.base, r.x.ms) + (r.store.onDisk ? ', written to disk' : ', kept in memory'))
}

// The connection to the sender dropped (or the sender says it will carry on later): what came in
// whole is kept, pieces of blocks still open are let go, and it waits for the sender to come back.
function holdIn(L, r) {
  if (r.over) return
  r.open.clear()
  r.partial = 0
  updateXfer(r.x, r.storedBytes, 0, true)
  setStatus(r.x, 'Connection lost · waiting to carry on…')
  clearTimeout(r.holdTimer)
  r.holdTimer = setTimeout(() => {
    if (r.over) return
    tellDropped(L, r.id)
    endIn(L, r)
    finishXfer(r.x, 'failed', 'Connection lost')
    log('Couldn\'t receive ' + r.meta.name + ': the connection didn\'t come back', true)
  }, HOLD_MS)
}
const holdAllIn = L => { for (const r of [...L.inX.values()]) holdIn(L, r) }
// The sender is back with a file this device has part of: it goes on from the first block not
// here yet (or whose SHA-256 never came), under its new transfer number.
function resumeIn(L, r, m) {
  if (r.over || m.size !== r.meta.size || L.inX.has(m.num)) { sendCtl(L, {t: 'cancel', id: m.id}); return }
  clearTimeout(r.holdTimer)
  L.inX.delete(r.num)
  r.num = m.num
  L.inX.set(r.num, r)
  r.open.clear()
  r.partial = 0
  r.began = false
  let i = 0
  while (i < r.blocks && r.stored[i] && (!r.check || r.want.has(i))) i++
  const from = Math.min(i * BLOCK, r.meta.size)
  setStatus(r.x, from ? 'Carrying on from ' + Math.floor(from / r.meta.size * 100) + '%…' : 'Starting again…')
  log('Carrying on with ' + r.meta.name + (from ? ' from ' + fmtBytes(from) : ''))
  sendCtl(L, {t: 'ready', id: r.id, num: r.num, from, got: true})
  doneIn(L, r)
}

// ----- sending direct -----
let sendNum = 0

function waitForDrain(dc, force) {
  if (!force && dc.bufferedAmount < HIGH_WATER) return Promise.resolve()
  if (force && dc.bufferedAmount <= LOW_WATER) return sleep(50)
  return new Promise(res => {
    dc.bufferedAmountLowThreshold = LOW_WATER
    const done = () => { dc.removeEventListener('bufferedamountlow', done); dc.removeEventListener('close', done); res() }
    dc.addEventListener('bufferedamountlow', done)
    dc.addEventListener('close', done)
  })
}
async function safeSend(dc, data) {
  for (let attempt = 0; ; attempt++) {
    try { dc.send(data); return }
    catch (e) {
      if (dc.readyState !== 'open' || attempt >= 20) throw e
      await waitForDrain(dc, true); await sleep(20)
    }
  }
}
// The connection with the least queued data takes the next piece.
async function pickLane(dcs) {
  for (;;) {
    let best = null
    for (const dc of dcs) {
      if (dc.readyState !== 'open') throw new Error('a connection closed during the transfer')
      if (!best || dc.bufferedAmount < best.bufferedAmount) best = dc
    }
    if (best.bufferedAmount < HIGH_WATER) return best
    await waitForDrain(best)
  }
}
const queued = dcs => dcs.reduce((s, dc) => s + dc.bufferedAmount, 0)

// again: the id of a file this device was sending to L when the connection dropped; the other
// device keeps what it has of it, so it carries on from there.
async function sendViaPeer(file, L, again) {
  const id = again || uid(), num = (++sendNum) >>> 0
  const x = getXfer(id, file.name, file.size, 'out', 'Direct', L)
  let canceled = false
  const stopWaits = () => {
    const a = readyWaiters.get(id); if (a) a(false)
    const k = peerAcks.get(id); if (k) k(false)
  }
  x.cancel = () => { canceled = true; stopWaits() }
  x.abort = () => { canceled = true; stopWaits() } // the row is already marked; nothing more to say
  try {
    await sendDirect(file, id, num, x, () => canceled, L)
  } catch (e) {
    // The other device holds on to what it has, for a send that carries on (sendTo); one that
    // doesn't tells it to let go (dropSend).
    sendCtl(L, {t: 'hold', id})
    finishXfer(x, 'failed', 'Failed: ' + (e.message || e))
    e.xfer = x // the automatic retry replaces this row
    e.sendId = id
    throw e
  } finally { readyWaiters.delete(id); peerAcks.delete(id); peerCanceled.delete(id); storedOut.delete(id) }
}

async function sendDirect(file, id, num, x, isCanceled, L) {
  const stopped = () => isCanceled() || peerCanceled.has(id)
  const stop = () => {
    if (x.finished) return
    const why = peerCanceled.get(id)
    if (isCanceled()) { sendCtl(L, {t: 'cancel', id}); finishXfer(x, 'failed', 'Canceled'); log('Canceled ' + file.name) }
    else if (why === 'check') { finishXfer(x, 'failed', 'Failed: it didn\'t arrive intact. Send it again.'); log(file.name + ' didn\'t arrive intact on ' + nameOf(L), true) }
    else if (why === 'space') { finishXfer(x, 'failed', 'Failed: no room for it on ' + nameOf(L)); log(nameOf(L) + ' has no room for ' + file.name, true) }
    else if (why) { finishXfer(x, 'failed', 'Failed on ' + nameOf(L)); log(nameOf(L) + ' couldn\'t take ' + file.name, true) }
    else { finishXfer(x, 'failed', 'Canceled by receiver'); log(nameOf(L) + ' canceled ' + file.name) }
  }
  // An answer for an earlier try at this file (another transfer number) isn't this one's.
  let readyFor = null
  const ready = new Promise(res => { readyFor = res })
  readyWaiters.set(id, m => { if (!m || m.num === undefined || m.num === num) readyFor(m) })
  const acked = waiter(peerAcks, id)
  let gotAck = false
  acked.then(v => { if (v) gotAck = true })
  if (!direct(L)) throw new Error('not connected')
  // check: each block's SHA-256 goes along with it ("bh"), and the other device checks what came in.
  L.lanes[0].send(JSON.stringify({t: 'meta', id, num, name: file.name, size: file.size, type: file.type, check: 'sha256'}))
  setStatus(x, 'Waiting for the other device…')
  const ok = await within(ready, 10000)
  if (stopped()) return stop()
  if (!ok) throw new Error('the other device did not answer')
  // Carrying on: the other device already has everything before "from" (always a whole number of blocks).
  const from = Number.isSafeInteger(ok.from) && ok.from > 0 && ok.from <= file.size && (ok.from % BLOCK === 0 || ok.from === file.size) ? ok.from : 0
  // A receiver that says how many blocks it has stored (got) is kept at most AHEAD blocks behind,
  // so blocks waiting to be checked and written there never pile up in its memory.
  const paced = ok.got === true, AHEAD = 16
  const out = {n: Math.floor(from / BLOCK)}
  if (paced) storedOut.set(id, out)

  // Over a TURN relay, parallel connections only fight each other for a slow, far-off path (and
  // lost pieces sent again count against the relay's allowance), so one does.
  const want = L.path === 'relay' ? 1 : parseInt($('lanes').value, 10) || 1
  const active = L.lanes.slice(0, want).filter(c => c && c.open)
  if (!active.length) throw new Error('not connected')
  const dcs = active.map(c => c.dataChannel)
  // Use the largest message every connection allows (Chrome allows 256 KB).
  const maxMsg = Math.min(...active.map(c => (c.peerConnection && c.peerConnection.sctp && c.peerConnection.sctp.maxMessageSize) || 65536))
  const chunk = Math.max(16 * 1024, Math.min(256 * 1024, maxMsg) - HDR)
  if (from) log('Carrying on with ' + file.name + ' from ' + fmtBytes(from))
  else log('Sending ' + file.name + (isHub() && roomLinks().length > 1 ? ' to ' + nameOf(L) : ''))
  dbg('Using ' + dcs.length + ' parallel connection' + (dcs.length > 1 ? 's' : ''))

  x.start = performance.now()
  x.base = from
  let offset = from
  outer:
  while (offset < file.size) {
    if (stopped()) break
    while (paced && offset / BLOCK - out.n >= AHEAD) {
      if (stopped()) break outer
      if (dcs.some(dc => dc.readyState !== 'open')) throw new Error('a connection closed during the transfer')
      await sleep(30)
    }
    const block = await file.slice(offset, offset + BLOCK).arrayBuffer()
    sendCtl(L, {t: 'bh', id, i: offset / BLOCK, h: hexOf(await crypto.subtle.digest('SHA-256', block))})
    for (let o = 0; o < block.byteLength; o += chunk) {
      if (stopped()) break outer
      const dc = await pickLane(dcs)
      const len = Math.min(chunk, block.byteLength - o)
      const msg = new Uint8Array(HDR + len)
      const dv = new DataView(msg.buffer)
      dv.setUint32(0, num); dv.setFloat64(4, offset + o)
      msg.set(new Uint8Array(block, o, len), HDR)
      await safeSend(dc, msg)
      updateXfer(x, Math.max(0, offset + o + len - queued(dcs)))
    }
    offset += block.byteLength
  }
  if (stopped()) return stop()
  // The receiver's confirmation ends the wait too: some browsers (Safari) keep reporting data as
  // queued after it has arrived.
  while (queued(dcs) > 0 && !gotAck && dcs.every(dc => dc.readyState === 'open') && !stopped()) {
    updateXfer(x, file.size - queued(dcs))
    await sleep(50)
  }
  updateXfer(x, file.size, file.size, true)
  setStatus(x, 'Waiting for confirmation…')
  const confirmed = await within(acked, ACK_TIMEOUT)
  if (stopped()) return stop()
  x.ms = performance.now() - x.start // includes the receiver finishing, so the speed is end to end
  if (confirmed) {
    finishXfer(x, 'done', 'Delivered in ' + fmtTime(x.ms) + (confirmed.checked ? ' · Checked' : ''))
    log('Delivered ' + file.name + (confirmed.checked ? ', checked on ' + nameOf(L) : ''))
    dbg('Direct at ' + fmtRate(file.size - from, x.ms) + ' over ' + dcs.length + ' connection(s)')
  }
  else { finishXfer(x, 'warn', 'Sent, but not confirmed'); log(file.name + ' was sent, but ' + nameOf(L) + ' didn\'t confirm it', true) }
}

// ---------- relay (Piping Server, end-to-end encrypted, confirmed) ----------
// codeKey (from the code) seals only the handshake: hello, welcome, reject, bye.
// Each link's key (from the key exchange) seals everything else between the hub and that device,
// files included. Every device has its own inbox on the relay: the hub's is "-to-hub", a joined
// device's is named after its public key, so the hub can reach each one.
let codeKey = null, pipeBase = '', pipePath = '', myInbox = ''
let inboxReqs = [], listening = 0, helloSentByRelay = false // listening: which round of listening is current
const acceptWaiters = new Map(), ackWaiters = new Map(), outgoingPipe = new Map(), incomingPipe = new Map(), seenOffers = new Set()
const HANDSHAKE = new Set(['hello', 'welcome', 'reject', 'bye', 'check'])
// The hub listens on every relay, so a device reaches it whichever relay it uses (the default when
// it typed the code, or the one in the QR code), and answers each device on that device's relay.
const inboxTo = L => pipeBase && pipePath && L ? (isHub() ? (L.relay || pipeBase) + '/' + pipePath + '-to-' + L.id : pipeBase + '/' + pipePath + '-to-hub') : ''

function stopListening() { listening++; inboxReqs.forEach(r => r.abort()); inboxReqs = [] }
function resetPipeState() {
  stopListening()
  myInbox = ''; codeKey = null; helloSentByRelay = false
  for (const L of links.values()) L.helloBack = false
  seenOffers.clear()
}
async function sha256hex(s) {
  return hexOf(await crypto.subtle.digest('SHA-256', enc(s)))
}
async function deriveCodeKey(c) {
  const base = await crypto.subtle.importKey('raw', enc(c), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey({name: 'PBKDF2', salt: enc(APP + '-salt'), iterations: 150000, hash: 'SHA-256'},
    base, {name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt'])
}
async function seal(bytes, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  return new Blob([iv, await crypto.subtle.encrypt({name: 'AES-GCM', iv}, key, bytes)])
}
async function unseal(buf, key) {
  return new Uint8Array(await crypto.subtle.decrypt({name: 'AES-GCM', iv: new Uint8Array(buf, 0, 12)}, key, new Uint8Array(buf, 12)))
}
async function packFile(file, key) {
  const header = enc(JSON.stringify({name: file.name, size: file.size, type: file.type}))
  const body = new Uint8Array(4 + header.length + file.size)
  new DataView(body.buffer).setUint32(0, header.length)
  body.set(header, 4)
  // Read in slices straight into place, rather than a whole extra copy of the file first.
  for (let o = 0; o < file.size; o += BLOCK) body.set(new Uint8Array(await file.slice(o, o + BLOCK).arrayBuffer()), 4 + header.length + o)
  return seal(body, key)
}
async function unpack(buf, key) {
  const pt = await unseal(buf, key)
  const hlen = new DataView(pt.buffer).getUint32(0)
  return {meta: JSON.parse(new TextDecoder().decode(pt.subarray(4, 4 + hlen))), data: pt.subarray(4 + hlen)}
}
function request(method, url, body, opts) {
  opts = opts || {}
  const xhr = new XMLHttpRequest()
  const promise = new Promise((resolve, reject) => {
    xhr.open(method, url)
    if (method === 'GET') xhr.responseType = 'arraybuffer'
    else xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    if (opts.timeout) xhr.timeout = opts.timeout
    if (opts.onUp) xhr.upload.onprogress = opts.onUp
    if (opts.onDown) xhr.onprogress = opts.onDown
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300) ? resolve(xhr) : reject(Object.assign(new Error('server returned ' + xhr.status), {status: xhr.status}))
    xhr.onerror = () => reject(new Error('network error'))
    xhr.ontimeout = () => reject(Object.assign(new Error('timed out'), {timedOut: true}))
    xhr.onabort = () => reject(Object.assign(new Error('canceled'), {aborted: true}))
    xhr.send(body || null)
  })
  return {promise, abort: () => { try { xhr.abort() } catch (e) {} }}
}
async function startPipe(gen) {
  pillIn($('pipeState'), 'Waiting for room setup', 'muted')
  pipeBase = PIPE_SERVERS[serverIndex]
  const path = (await sha256hex(APP + ':' + code)).slice(0, 40)
  const key = await deriveCodeKey(APP + ':' + code)
  await keys
  const me = isHub() ? 'hub' : (await sha256hex(myPub)).slice(0, 16)
  if (gen !== generation) return
  pipePath = path
  codeKey = key
  myInbox = pipeBase + '/' + pipePath + '-to-' + me
  stopListening()
  for (const base of isHub() ? PIPE_SERVERS : [pipeBase]) listenInbox(gen, listening, base + '/' + pipePath + '-to-' + me, base)
}
// One inbox: wait for a message, handle it, wait for the next. The Relay pill shows the room's own.
function listenInbox(gen, round, inbox, base) {
  const stale = () => gen !== generation || round !== listening
  if (stale()) return
  const own = base === pipeBase
  const r = request('GET', inbox)
  inboxReqs.push(r)
  const done = () => { inboxReqs = inboxReqs.filter(x => x !== r) }
  if (own) pillIn($('pipeState'), 'Ready', 'good')
  r.promise.then(async xhr => {
    done()
    if (stale()) return
    // Whichever key opens it says who it's from: a device's own key, or the code's (handshake).
    let msg = null, from = null
    for (const L of [...links.values()].filter(l => l.key)) {
      try { msg = JSON.parse(new TextDecoder().decode(await unseal(xhr.response, L.key))); msg.sealedBy = 'session'; from = L; break } catch (e) {}
    }
    if (!msg && codeKey) {
      try { msg = JSON.parse(new TextDecoder().decode(await unseal(xhr.response, codeKey))); msg.sealedBy = 'code' } catch (e) {}
    }
    if (msg) handleControl(msg, gen, from, base)
    else dbg('Relay: ignored a message that could not be decrypted', true)
    listenInbox(gen, round, inbox, base)
  }).catch(e => {
    done()
    if (e.aborted || stale()) return
    if (own) pillIn($('pipeState'), e.status ? 'Busy · retrying' : 'Unreachable · retrying', 'warn')
    setTimeout(() => listenInbox(gen, round, inbox, base), e.status ? 2000 : 4000)
  })
}
async function postControl(L, msg, tries) {
  tries = tries || 5
  const gen = generation
  // The handshake goes with the code's key, except a goodbye once paired: that takes the pair's key.
  const key = msg.t === 'bye' && L.known && L.key ? L.key : HANDSHAKE.has(msg.t) ? codeKey : L.key
  if (!key) return false
  const body = await seal(enc(JSON.stringify(msg)), key)
  const target = inboxTo(L)
  for (let i = 0; i < tries; i++) {
    if (!target || gen !== generation || target !== inboxTo(L)) return false
    try { await request('POST', target, body, {timeout: 25000}).promise; return true }
    // An inbox takes one message at a time, so devices writing to the hub at once take turns.
    catch (e) { await sleep(500 + Math.random() * 700 * (i + 1)) }
  }
  return false
}
const postHandshake = (L, msg) => postControl(L, msg, 4)
// A device that joined says hello to the hub through the relay (once, unless it didn't get there).
async function sendHelloByRelay(gen) {
  if (gen !== generation || helloSentByRelay || isHub()) return
  helloSentByRelay = true
  // The relay keys and inboxes may still be on their way (startPipe).
  for (let i = 0; i < 40 && gen === generation && !(codeKey && myInbox); i++) await sleep(250)
  const L = hubLink()
  if (gen !== generation || !L) return
  if (!(await postHandshake(L, await helloMsg('hello'))) && gen === generation) {
    helloSentByRelay = false
    // Until the hub lets this device in, first pairing or coming back after a dropped link.
    setTimeout(() => { if (gen === generation && hubLink() === L && !L.accepted) sendHelloByRelay(gen) }, L.known ? 8000 : 3000)
  }
}
// A goodbye, directly and through the relay. The relay copy retries like other messages (the
// device's inbox may be taking another one), and keeps going after this device moves on to a
// new code.
async function sayBye(L) {
  sendCtl(L, {t: 'bye'})
  const key = L.known && L.key ? L.key : codeKey
  const target = inboxTo(L)
  if (!target || !key) return
  const body = await seal(enc(JSON.stringify({t: 'bye', pub: myPub})), key)
  for (let i = 0; i < 4; i++) {
    try { await request('POST', target, body, {timeout: 8000}).promise; return }
    catch (e) { if (e.timedOut) return; await sleep(400 + Math.random() * 600 * (i + 1)) }
  }
}
function handleControl(msg, gen, from, base) {
  if (!msg || !msg.t) return
  if (isHub() && from && base) from.relay = base // the hub answers a device on the relay it last wrote through
  // Once paired, only a goodbye sealed with the pair's own key counts.
  if (msg.t === 'bye') {
    if (!isHub()) { const L = hubLink(); return L && (!L.known || msg.sealedBy === 'session') && onBye() }
    const L = from || links.get(msg.pub)
    return L && (!L.known || msg.sealedBy === 'session') && onLinkBye(L)
  }
  if (msg.sealedBy === 'code') {
    if (msg.t === 'hello') return onHello(msg, 'relay', gen, null, base)
    if (msg.t === 'check') return gen === generation && onCheck(isHub() ? links.get(msg.pub) : hubLink(), msg, 'relay')
    if (isHub()) return
    if (msg.t === 'welcome') return onWelcome(msg, gen)
    if (msg.t === 'reject') return onReject(msg, gen)
    return
  }
  // Everything else must come sealed with the key only that device and this one have, after accepting.
  const L = from
  if (!L || !L.accepted) return
  if (msg.t === 'offer') return GAME ? undefined : onOffer(L, msg)
  if (msg.t === 'g') { if (GAME) { markActive(true); GAME.onData(isHub() ? L.pub : 'hub', msg.d) } return }
  if (msg.t === 'active') return markActive(true)
  if (msg.t === 'chat') return GAME ? undefined : onChat(L, msg)
  if (msg.t === 'name') return GAME ? undefined : onName(L, msg)
  if (msg.t === 'accept') { const f = acceptWaiters.get(msg.id); if (f) f(true) }
  if (msg.t === 'ack') { const f = ackWaiters.get(msg.id); if (f) f(true) }
  if (msg.t === 'prog') { const o = outgoingPipe.get(msg.id); if (o) o.progress(msg.n) }
  if (msg.t === 'cancel') {
    if (validId(msg.id) && findIn(L, msg.id)) cancelIn(L, msg) // a direct file this device was holding
    const o = outgoingPipe.get(msg.id); if (o) o.remoteCancel(msg.why)
    const i = incomingPipe.get(msg.id); if (i) i.remoteCancel()
  }
}
function tellProgress(L, id, n) {
  if (direct(L)) sendCtl(L, {t: 'prog', id, n})
  else postControl(L, {t: 'prog', id, n}, 1)
}
// Relay file addresses must be on one of Beam's relays (files go through the fastest one, which
// needn't be the room's).
const onRelay = path => typeof path === 'string' && PIPE_SERVERS.some(b => path.startsWith(b + '/'))

// ---------- data usage: this device, this month ----------
// Every file this device sent and received (direct or through a relay), and, apart, what went
// through a relay: bytes on direct links that a TURN relay carried (read from the connections
// every few seconds) and file data through the Piping relays (their speed tests aren't counted).
// Kept in this browser only and started again each month. Shown from the arrows in the footer
// (on hover, or a tap): the totals, the relay part and each relay's share.
const USE_KEY = 'beam-relay-use2'
const USE_NAMES = {express: 'ExpressTURN', evan: 'evan-brass', piping: 'Piping'}
const monthNow = () => { const d = new Date(); return d.getFullYear() + '-' + (d.getMonth() + 1) }
function readUse() {
  try { const u = JSON.parse(localStorage.getItem(USE_KEY)); if (u && u.month === monthNow() && u.bytes) return {total: {sent: 0, recv: 0}, ...u} } catch (e) {}
  return {month: monthNow(), bytes: {}, total: {sent: 0, recv: 0}} // bytes: relay -> {sent, recv}; total: every file
}
function saveUse(u) { try { localStorage.setItem(USE_KEY, JSON.stringify(u)) } catch (e) {} showUse(u) }
function addUse(kind, sent, recv) {
  if (!USE_NAMES[kind] || !(sent > 0 || recv > 0)) return
  const u = readUse() // read fresh: another Beam tab may have added to it
  const b = u.bytes[kind] = u.bytes[kind] || {sent: 0, recv: 0}
  b.sent += sent > 0 ? sent : 0
  b.recv += recv > 0 ? recv : 0
  saveUse(u)
}
// A file delivered or received, whichever way it went.
function addTotal(sent, recv) {
  const u = readUse()
  u.total.sent += sent; u.total.recv += recv
  saveUse(u)
}
function showUse(u = readUse()) {
  const used = Object.keys(USE_NAMES).filter(k => u.bytes[k] && (u.bytes[k].sent || u.bytes[k].recv))
  const relay = used.reduce((t, k) => t + u.bytes[k].sent + u.bytes[k].recv, 0)
  const pop = $('usePop')
  if (!pop) return
  pop.innerHTML = ''
  const line = (label, value, cls) => { const p = document.createElement('span'); p.className = 'beam-urow' + (cls ? ' ' + cls : ''); const a = document.createElement('span'); a.textContent = label; const b = document.createElement('b'); b.textContent = value; p.append(a, b); pop.append(p) }
  const head = document.createElement('span'); head.className = 'beam-uhead'; head.textContent = 'This month, this browser'; pop.append(head)
  line('Sent', fmtBytes(u.total.sent))
  line('Received', fmtBytes(u.total.recv))
  line('Through relays', relay ? fmtBytes(relay) : 'none, all direct')
  for (const k of used) line(USE_NAMES[k], '↑ ' + fmtBytes(u.bytes[k].sent) + '  ↓ ' + fmtBytes(u.bytes[k].recv), 'sub')
}
// A relayed link's connections: what moved since the last look, put down to the relay carrying
// it (this side's, or the one the other device named).
async function meterLanes() {
  for (const L of [...links.values()]) {
    if (L.path !== 'relay') continue
    for (const c of L.lanes) {
      const pc = c && c.open && c.peerConnection
      if (!pc) continue
      try {
        const stats = await pc.getStats()
        let t = null
        stats.forEach(r => { if (r.type === 'transport' && r.selectedCandidatePairId) t = r })
        const pair = t && stats.get(t.selectedCandidatePairId), l = pair && stats.get(pair.localCandidateId)
        const kind = l && l.candidateType === 'relay' ? relayKind(l.url || '') : relayKind(L.relayName || '')
        if (!t || !kind) continue
        const sent = t.bytesSent || 0, recv = t.bytesReceived || 0
        addUse(kind, sent - (c._sent || 0), recv - (c._recv || 0))
        c._sent = sent; c._recv = recv
      } catch (e) {}
    }
  }
}
const meterTimer = setInterval(meterLanes, 3000)

// ---------- choosing the fastest relay for files ----------
// Before a file goes through a relay, each relay without a recent test gets one: 1 MB of empty
// data sent through it from this device to itself (up and down at once), timed. Every file of
// 1 MB or more that goes through a relay also notes that relay's real speed, end to end.
// A short test always reads slower than a real file, so like is compared with like: real speeds
// when every relay has a recent one, otherwise test speeds; and a relay whose last real file was
// slower than another relay's test (clearly struggling) gives way to it. Measurements older than
// 30 minutes are redone, since free servers' speeds change (and one may be asleep). They're kept
// in this browser, so a reload doesn't test again.
const PROBE_BYTES = 1024 * 1024, PROBE_TIMEOUT = 8000, SPEED_FRESH = 30 * 60000, SPEEDS_KEY = 'beam-relay-speeds'
let relaySpeeds = (() => { try { return JSON.parse(localStorage.getItem(SPEEDS_KEY)) || {} } catch (e) { return {} } })() // base -> {test, file}: {rate (bytes/ms), at}
const hostOf = base => base.replace(/^https?:\/\//, '')
const freshM = m => !!m && Date.now() - m.at < SPEED_FRESH
function noteSpeed(base, bytesPerMs, kind) {
  relaySpeeds[base] = {...relaySpeeds[base], [kind]: {rate: bytesPerMs, at: Date.now()}}
  try { localStorage.setItem(SPEEDS_KEY, JSON.stringify(relaySpeeds)) } catch (e) {}
  showSpeeds()
}
function showSpeeds() {
  const ago = m => { const a = Math.round((Date.now() - m.at) / 60000); return a < 1 ? 'just now' : a < 120 ? a + ' min ago' : Math.round(a / 60) + ' h ago' }
  const rate = m => m.rate ? fmtRate(m.rate * 1000, 1000) : 'no answer'
  $('relaySpeeds').textContent = PIPE_SERVERS.map(b => {
    const {test, file} = relaySpeeds[b] || {}
    const bits = [test && 'test ' + rate(test) + ', ' + ago(test), file && 'last file ' + rate(file) + ', ' + ago(file)].filter(Boolean)
    return hostOf(b) + ': ' + (bits.join('; ') || 'not measured')
  }).join(' · ')
}
async function testRelay(base) {
  const path = base + '/' + (await sha256hex(APP + ':test:' + uid())).slice(0, 40)
  const t0 = performance.now()
  const up = request('POST', path, new Blob([new Uint8Array(PROBE_BYTES)]), {timeout: PROBE_TIMEOUT})
  const down = request('GET', path, null, {timeout: PROBE_TIMEOUT})
  try {
    await Promise.all([up.promise, down.promise])
    return PROBE_BYTES / (performance.now() - t0)
  } catch (e) { up.abort(); down.abort(); return 0 } // too slow, asleep or unreachable
}
let testing = null
async function fastestRelay() {
  const m = b => relaySpeeds[b] || {}
  const allFiles = PIPE_SERVERS.every(b => freshM(m(b).file))
  if (!allFiles) {
    const stale = PIPE_SERVERS.filter(b => !freshM(m(b).test))
    if (stale.length) {
      // One test at a time, so they don't share this device's connection.
      testing = testing || (async () => {
        for (const b of stale) {
          const r = await testRelay(b)
          noteSpeed(b, r, 'test')
          dbg('Relay test: ' + hostOf(b) + (r ? ' at ' + fmtRate(r * 1000, 1000) : ' didn\'t answer in time'))
        }
      })().finally(() => { testing = null })
      await testing
    }
  }
  const kind = allFiles ? 'file' : 'test'
  const by = b => (m(b)[kind] || {}).rate || 0
  let best = PIPE_SERVERS.reduce((a, b) => by(b) > by(a) ? b : a)
  if (!allFiles) {
    const file = m(best).file
    const rival = PIPE_SERVERS.filter(b => b !== best).reduce((a, b) => !a || by(b) > by(a) ? b : a, null)
    if (freshM(file) && rival && file.rate < by(rival)) best = rival // its last real file was slower than the other's test
  }
  return by(best) > 0 ? best : pipeBase // nothing answered: the room's own relay
}
async function onOffer(L, msg) {
  if (!onRelay(msg.path) || !validId(msg.id) || !validSize(msg.size)) return
  // The same offer again: while it's coming in or once it's here, just say yes again (the first
  // yes may have been lost). One that failed was forgotten, so it starts over.
  if (seenOffers.has(msg.id)) { postControl(L, {t: 'accept', id: msg.id}, 2); return }
  const name = String(msg.name || 'file').slice(0, 255)
  if (msg.size > RELAY_MAX) {
    postControl(L, {t: 'cancel', id: msg.id, why: 'too-big'}, 3)
    log(nameOf(L) + ' tried to send ' + name + ' (' + fmtBytes(msg.size) + ') through the relay, which is limited to ' + fmtBytes(RELAY_MAX) + ' on this device', true)
    return
  }
  seenOffers.add(msg.id)
  const x = getXfer(msg.id, name, msg.size, 'in', 'Relay', L)
  setStatus(x, 'Starting…')
  postControl(L, {t: 'accept', id: msg.id})
  let canceled = false, began = false, r = null, lastProg = 0
  incomingPipe.set(msg.id, {remoteCancel: () => { canceled = true; r && r.abort(); finishXfer(x, 'failed', 'Canceled by sender'); log(nameOf(L) + ' canceled ' + name) }})
  x.cancel = () => { canceled = true; r && r.abort(); finishXfer(x, 'failed', 'Canceled'); postControl(L, {t: 'cancel', id: msg.id}, 3); log('Canceled ' + name) }
  x.abort = () => { canceled = true; r && r.abort() }
  try {
    // A download that fails before anything arrives is tried again: the sender is still waiting
    // on the relay for it. Once data has flowed, the relay has let go of the sender, so it isn't.
    let xhr = null
    for (let tries = 1; ; tries++) {
      r = request('GET', msg.path, null, {onDown: e => {
        if (!began) { began = true; x.start = performance.now() }
        updateXfer(x, e.loaded, e.lengthComputable ? e.total : 0)
        // The sender's own upload runs ahead of this (the relay buffers), so it's told what has
        // actually arrived, about once a second, to show true progress and speed.
        const now = performance.now()
        if (now - lastProg > 1000) { lastProg = now; tellProgress(L, msg.id, e.loaded) }
      }})
      try { xhr = await r.promise; break }
      catch (e) {
        if (canceled || began || e.aborted || tries >= 3) throw e
        dbg('Relay download failed (' + (e.message || e) + '), trying again', true)
        await sleep(1500 * tries)
        if (canceled) throw e
      }
    }
    addUse('piping', 0, xhr.response.byteLength)
    const {meta, data} = await unpack(xhr.response, L.key)
    xhr = null
    updateXfer(x, meta.size, meta.size, true)
    // Sealed with AES-GCM, it opens only if every byte is what was sent: it's checked.
    finishXfer(x, 'done', 'Received in ' + fmtTime(x.ms) + ' · Checked')
    offerSave(x, new Blob([data], {type: meta.type || 'application/octet-stream'}), meta.name)
    log('Received ' + meta.name)
    dbg('Relay at ' + fmtRate(meta.size, x.ms))
    postControl(L, {t: 'ack', id: msg.id})
  } catch (e) {
    seenOffers.delete(msg.id) // a new offer for it starts over
    if (!canceled) {
      finishXfer(x, 'failed', 'Failed: ' + (e.message || 'could not decrypt')); log('Couldn\'t receive ' + name, true); dbg(e.message || String(e), true)
      postControl(L, {t: 'cancel', id: msg.id, why: 'failed'}, 3) // so the sender stops waiting for it
    }
  } finally { incomingPipe.delete(msg.id) }
}
async function sendViaPipe(file, L) {
  if (!inboxTo(L) || !L.key || !L.accepted) throw new Error('the relay is not ready yet')
  const id = uid()
  const x = getXfer(id, file.name, file.size, 'out', 'Relay', L)
  if (file.size > RELAY_MAX) {
    finishXfer(x, 'failed', 'Too large for the relay (' + fmtBytes(RELAY_MAX) + ' at most here)')
    log(file.name + ' is too large to send through the relay from this device. It can go directly when the devices can connect directly.', true)
    return
  }
  let canceled = false, upload = null, started = false
  const stopAll = () => {
    canceled = true
    if (upload) upload.abort()
    const a = acceptWaiters.get(id); if (a) a(false)
    const k = ackWaiters.get(id); if (k) k(false)
  }
  x.cancel = () => { stopAll(); finishXfer(x, 'failed', 'Canceled'); postControl(L, {t: 'cancel', id}, 3); log('Canceled ' + file.name) }
  x.abort = stopAll
  // What the receiver says has arrived (heard), once it says so, rather than this side's upload.
  let heard = false, packetSize = 0
  const progress = n => {
    if (!started || x.finished || !(n > 0) || !packetSize) return
    heard = true
    const b = Math.min(file.size, Math.round(file.size * n / packetSize))
    updateXfer(x, b, file.size, b >= file.size)
    if (b >= file.size) setStatus(x, 'Finishing on ' + nameOf(L) + '…')
  }
  outgoingPipe.set(id, {progress, remoteCancel: why => {
    stopAll()
    if (why === 'too-big') { finishXfer(x, 'failed', 'Too large for the relay on ' + nameOf(L)); log(file.name + ' is too large for the relay on ' + nameOf(L), true) }
    else if (why === 'failed') { finishXfer(x, 'failed', nameOf(L) + ' couldn\'t download it'); log(nameOf(L) + ' couldn\'t download ' + file.name + '. Try again.', true) }
    else { finishXfer(x, 'failed', 'Canceled by receiver'); log(nameOf(L) + ' canceled ' + file.name) }
  }})
  const accepted_ = waiter(acceptWaiters, id)
  const acked = waiter(ackWaiters, id)
  try {
    setStatus(x, 'Finding the fastest relay…')
    const base = await fastestRelay()
    if (canceled) return
    setStatus(x, 'Encrypting…')
    const packet = await packFile(file, L.key)
    packetSize = packet.size
    if (canceled) return
    const path = base + '/' + (await sha256hex(APP + ':' + code + ':' + id)).slice(0, 48)
    const t0 = performance.now() // for this relay's speed: from the upload's start to the receiver's confirmation
    upload = request('POST', path, packet, {onUp: e => {
      if (started && !heard && e.lengthComputable && e.total) updateXfer(x, Math.round(file.size * e.loaded / e.total), file.size)
    }})
    upload.promise.catch(() => {})
    log('Sending ' + file.name + (isHub() && roomLinks().length > 1 ? ' to ' + nameOf(L) : '') + ' through ' + hostOf(base))
    setStatus(x, 'Waiting for the other device…')
    let ok = false
    for (let attempt = 0; attempt < 4 && !ok && !canceled; attempt++) {
      postControl(L, {t: 'offer', id, path, name: file.name, size: file.size, type: file.type}, 2)
      ok = await within(accepted_, 15000)
    }
    if (canceled) return
    if (!ok) { upload.abort(); finishXfer(x, 'failed', 'The other device did not respond'); log(nameOf(L) + ' didn\'t respond, so ' + file.name + ' wasn\'t sent', true); throw Object.assign(new Error('the other device did not respond'), {xfer: x}) }
    started = true; x.start = performance.now()
    await upload.promise
    addUse('piping', packet.size, 0)
    if (canceled) return
    if (!heard) { updateXfer(x, file.size, file.size, true); setStatus(x, 'Waiting for confirmation…') }
    const confirmed = await within(acked, ACK_TIMEOUT)
    if (canceled) return
    x.ms = performance.now() - x.start
    if (confirmed) {
      finishXfer(x, 'done', 'Delivered in ' + fmtTime(x.ms) + ' · Checked'); log('Delivered ' + file.name); dbg('Relay at ' + fmtRate(file.size, x.ms)) // it confirms only once it opened the sealed file
      // A real transfer is the best measure of a relay; tiny files are mostly waiting, so they don't count.
      if (file.size >= PROBE_BYTES) noteSpeed(base, file.size / (performance.now() - t0), 'file')
    }
    else { finishXfer(x, 'warn', 'Sent, but not confirmed'); log(file.name + ' was sent, but ' + nameOf(L) + ' didn\'t confirm it', true) }
  } catch (e) {
    if (!canceled) { finishXfer(x, 'failed', 'Failed: ' + (e.message || e)); e.xfer = e.xfer || x; throw e }
  } finally {
    outgoingPipe.delete(id); acceptWaiters.delete(id); ackWaiters.delete(id)
  }
}
// A relay transfer holds the whole file, encrypted for its device, in memory, so with several
// devices they go one at a time.
let relayChain = Promise.resolve()
function queueRelay(file, L) {
  const run = relayChain.then(() => sendViaPipe(file, L))
  relayChain = run.catch(() => {})
  return run
}

// ---------- sending ----------
// The screen stays on while anything is sending: one lock for all batches, let go when the last
// one ends, and taken again when the page comes back to the front (the browser drops it when hidden).
let wakeLock = null
async function keepAwake(on) {
  try {
    if (on && !wakeLock && 'wakeLock' in navigator && document.visibilityState === 'visible') {
      const w = await navigator.wakeLock.request('screen')
      if (!sendingCount || life.signal.aborted) { w.release(); return }
      wakeLock = w
      w.addEventListener('release', () => { if (wakeLock === w) wakeLock = null })
    }
    if (!on && wakeLock) { const w = wakeLock; wakeLock = null; await w.release() }
  } catch (e) {}
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && sendingCount) keepAwake(true) }, {signal: life.signal})
let sendingCount = 0
async function sendFiles(files) {
  if (!files.length) return
  const to = recipients()
  if (!to.length) { log(roomLinks().length > 1 ? 'Tick at least one device to send to' : 'Not connected right now', true); return }
  if (++sendingCount === 1) keepAwake(true)
  $('drop').classList.add('busy') // the vortex turns faster while sending
  try { await sendFilesInner(files, to) } finally {
    if (--sendingCount === 0) { $('drop').classList.remove('busy'); keepAwake(false) }
  }
}
// Each file goes to every device picked: straight to each at once, or one at a time through the relay.
async function sendFilesInner(files, to) {
  const gen = generation // a disconnect starts a new room; stop sending this batch when that happens
  for (const file of files) {
    if (gen !== generation) break
    await Promise.all(to.filter(L => present(L)).map(L => sendTo(file, L, gen)))
  }
}
// A device whose link dropped mid-batch: wait (up to ms) for it to be let back in.
async function backAgain(L, gen, ms) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) {
    if (gen !== generation || !present(L)) return false
    if (L.accepted) return true
  }
  return false
}
// A direct send that won't carry on: the other device lets go of what it kept. why 'relay': the
// file goes through the relay instead, so its row there just goes.
function dropSend(L, id, why) { if (id && present(L)) toLink(L, {t: 'cancel', id, why}) }
async function sendTo(file, L, gen) {
  if (!L.accepted) {
    log('Waiting for ' + nameOf(L) + ' to reconnect before sending ' + file.name + '…')
    if (!(await backAgain(L, gen, 60000))) { if (gen === generation) log('Couldn\'t send ' + file.name + ': ' + nameOf(L) + ' didn\'t reconnect', true); return }
  }
  const route = $('route').value
  const directReady = direct(L)
  // A direct link that goes through a TURN relay is slow (a far-off relay, often a limited free
  // one); the Piping relay is usually several times faster. So in Automatic, files that fit go
  // through Piping then, and over the TURN-relayed link only if that doesn't work.
  const relayFirst = route === 'auto' && directReady && L.path === 'relay' && file.size <= RELAY_MAX
  try {
    if (route === 'pipe' || (route === 'auto' && !directReady) || relayFirst) {
      if (relayFirst) dbg('The direct link goes through a TURN relay, so ' + file.name + ' goes through the faster Piping relay')
      else if (route === 'auto') dbg('No direct link, using the relay for ' + file.name)
      await queueRelay(file, L)
    } else {
      if (!directReady) { dbg('There is no direct link. Set "Send using" to Automatic or Relay.', true); return }
      await sendViaPeer(file, L)
    }
  } catch (e) {
    dbg('Sending ' + file.name + ' failed: ' + (e.message || e), true)
    if (gen !== generation || !present(L)) return
    // Direct only: once the device is back on a direct link, the file carries on where it stopped.
    if (route === 'peer' && e.sendId) {
      if (e.xfer) dropRow(e.xfer)
      if (!L.accepted) log('Lost the link to ' + nameOf(L) + ' while sending ' + file.name + '. Waiting for it to come back…')
      if (!(await backAgain(L, gen, 60000)) || !direct(L)) { dropSend(L, e.sendId); if (gen === generation) log('Couldn\'t send ' + file.name + ': ' + nameOf(L) + ' didn\'t reconnect directly', true); return }
      try { await sendViaPeer(file, L, e.sendId) } catch (e2) { dropSend(L, e2.sendId); log('Couldn\'t send ' + file.name + '. Try again.', true); dbg(e2.message || String(e2), true) }
      return
    }
    if (relayFirst) {
      if (e.xfer) dropRow(e.xfer)
      if (!direct(L)) { log('Couldn\'t send ' + file.name + '. Try again.', true); return }
      log('The relay didn\'t work for ' + file.name + ', so it goes over the direct link')
      try { await sendViaPeer(file, L) } catch (e2) { dropSend(L, e2.sendId); log('Couldn\'t send ' + file.name + '. Try again.', true); dbg(e2.message || String(e2), true) }
      return
    }
    if (route === 'auto' && directReady) {
      if (e.xfer) dropRow(e.xfer)
      // When the link itself dropped, the device is let back in shortly (directly or through the
      // relay): wait for that first, then send again the way that works now.
      if (!L.accepted) {
        log('Lost the link to ' + nameOf(L) + ' while sending ' + file.name + '. Waiting for it to come back…')
        if (!(await backAgain(L, gen, 60000))) { dropSend(L, e.sendId); if (gen === generation) log('Couldn\'t send ' + file.name + ': ' + nameOf(L) + ' didn\'t reconnect', true); return }
      }
      // Back on a direct link, it carries on where it stopped; otherwise it goes through the relay.
      try {
        if (direct(L)) await sendViaPeer(file, L, e.sendId)
        else { dropSend(L, e.sendId, 'relay'); log('Switching to the relay for ' + file.name); await queueRelay(file, L) }
      } catch (e2) {
        if (e2.xfer) dropRow(e2.xfer)
        if (gen !== generation || !present(L)) return
        dropSend(L, e2.sendId, 'relay')
        try { log('Switching to the relay for ' + file.name); await queueRelay(file, L) }
        catch (e3) { log('Couldn\'t send ' + file.name + '. Try again.', true); dbg(e3.message || String(e3), true) }
      }
    }
  }
}

// ---------- ending the session ----------
// Disconnect stops running transfers, tells every device (directly and through the relay), then
// this device moves to a fresh code so nobody reconnects by accident.
let ending = false
async function endSession(reason) {
  if (ending) return
  if (typeof reason !== 'string') reason = '' // called from the button with a click event
  ending = true
  try {
    for (const x of [...activeX]) { if (x.cancel) x.cancel(); else finishXfer(x, 'failed', 'Stopped') }
    for (const L of links.values()) sayBye(L)
    await sleep(300) // let the goodbye leave before the connection closes
    log(reason || 'Disconnected')
    if (startOver('idle')) return
    setRoom('', 'create')
    $('pairStatus').textContent = (reason || 'Disconnected') + '. Share this new code to connect again.'
  } finally { ending = false }
}
// A device that joined: the hub ended it (or disconnected this device).
function onBye() {
  for (const x of [...activeX]) stopXfer(x, 'Stopped: the other device disconnected')
  log('The other device ended the connection')
  if (startOver('bye')) return
  setRoom('', 'create')
  $('pairStatus').textContent = 'The other device disconnected. Share this new code to connect again.'
}

// ---------- auto-disconnect when idle ----------
// The timer runs only while connected. Only Beam counts as activity: taps, key presses and file drags
// inside Beam's own area, plus any running transfer. Each device tells the others (at most once a
// minute) so the timers stay in step; the hub passes on what it hears, so every device in the room
// keeps up with the busiest one.
const IDLE_LIMIT = IDLE_LIMIT_MIN * 60000, IDLE_WARN = 60000
let lastActivity = Date.now(), lastActiveSent = 0
function markActive(fromOther) {
  lastActivity = Date.now()
  $('idleWarn').hidden = true
  if ((!fromOther || isHub()) && mode !== 'waiting' && Date.now() - lastActiveSent > 60000) {
    lastActiveSent = Date.now()
    for (const L of links.values()) {
      if (!L.accepted) continue
      if (direct(L)) sendCtl(L, {t: 'active'})
      else postControl(L, {t: 'active'}, 1)
    }
  }
}
// A game room's markup stays hidden, so the game page's own input counts.
;['pointerdown', 'keydown', 'dragenter'].forEach(ev => (GAME ? document : root).addEventListener(ev, () => markActive(), {passive: true, signal: life.signal}))
$('stayBtn').addEventListener('click', () => markActive())
const idleTimer = setInterval(() => {
  if (mode === 'waiting') { lastActivity = Date.now(); $('idleWarn').hidden = true; return }
  if (activeX.size) { lastActivity = Date.now(); return } // never disconnect during a transfer
  const left = IDLE_LIMIT - (Date.now() - lastActivity)
  if (left <= 0) {
    $('idleWarn').hidden = true
    endSession('Disconnected after ' + IDLE_LIMIT_MIN + ' minutes without activity')
  } else if (left <= IDLE_WARN) {
    $('idleSecs').textContent = String(Math.ceil(left / 1000))
    $('idleWarn').hidden = false
  } else $('idleWarn').hidden = true
}, 1000)

// ---------- wiring ----------
PIPE_SERVERS.forEach((url, i) => { const o = document.createElement('option'); o.value = String(i); o.textContent = url.replace('https://', ''); $('pipeServer').append(o) })
const drop = $('drop')
// The vortex briefly swallows the files when they are chosen or dropped.
function swallow() {
  drop.classList.remove('swallow'); void drop.offsetWidth // restart the animation
  drop.classList.add('swallow')
}
drop.addEventListener('animationend', e => { if (e.animationName === 'beam-swallow') drop.classList.remove('swallow') })
function sendPicked(files) { if (!files.length) return; swallow(); sendFiles(files) }
$('fileInput').addEventListener('change', e => { sendPicked(Array.from(e.target.files)); e.target.value = '' })
let dragDepth = 0 // dragenter/leave also fire for the rings inside, so count them
drop.addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; drop.classList.add('over') })
drop.addEventListener('dragover', e => e.preventDefault())
drop.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) drop.classList.remove('over') })
drop.addEventListener('drop', e => { e.preventDefault(); e.stopPropagation(); dragDepth = 0; drop.classList.remove('over'); sendPicked(Array.from(e.dataTransfer.files)) })
$('joinForm').addEventListener('submit', e => {
  e.preventDefault()
  const c = cleanCode($('joinInput').value)
  if (!validCode(c)) { $('pairStatus').textContent = 'Enter the 6-digit code shown on the other device.'; return }
  if (c === code) { $('pairStatus').textContent = 'That is this device\'s own code. Enter the code from the other device.'; return }
  $('joinInput').value = ''; setRoom(c, 'join')
})
// Leaving a code being joined tells the device that made it, so a request waiting there for
// Accept goes away instead of letting it "connect" to a device that's gone.
const leaveJoin = () => { const L = hubLink(); if (L) sayBye(L) }
$('joinCancel').addEventListener('click', () => { leaveJoin(); setRoom('', 'create'); $('pairStatus').textContent = 'Canceled. Here\'s a code of your own to share.' })
$('scanBtn').addEventListener('click', startScan)
$('scanCancel').addEventListener('click', stopScan)
// The camera is let go when the page is hidden (another app, the screen off); scanning starts again from the button.
document.addEventListener('visibilitychange', () => { if (document.hidden) stopScan() }, {signal: life.signal})
$('accept').addEventListener('click', acceptAsk)
root.querySelectorAll('[data-bcast] .beam-switch').forEach(b => b.addEventListener('click', () => setBroadcast(!broadcast)))
$('clearDone').addEventListener('click', clearFinished)
$('decline').addEventListener('click', decline)
$('disconnect').addEventListener('click', endSession)
$('route').addEventListener('change', () => renderLinks())
showMe()
$('me').addEventListener('click', editMe)
$('chatToggle').addEventListener('click', e => { e.stopPropagation(); setChatOpen(!chatOpen) })
// A tap anywhere on the folded bar opens it too (not on the name, which edits it).
$('chat').querySelector('.beam-chat-head').addEventListener('click', e => { if (!chatOpen && !e.target.closest('.beam-me, .beam-me-edit')) setChatOpen(true) })
// The word search (or another Beam) changed the name: shown here too.
addEventListener('storage', e => { if (e.key === NAME_KEY && !GAME) announceMe() }, {signal: life.signal})
$('compose').addEventListener('submit', e => { e.preventDefault(); sayChat($('chatInput').value); $('chatInput').value = '' })
if (!GAME) {
  // The chat's height follows what's above it and the window (the panel's tab shown, a device added).
  // On the next frame, not inside the observer: the chat's new height can change what it observes.
  let chatFrame = 0
  const ro = new ResizeObserver(() => { cancelAnimationFrame(chatFrame); chatFrame = requestAnimationFrame(sizeChat) })
  ro.observe(root)
  addEventListener('resize', sizeChat, {signal: life.signal})
  life.signal.addEventListener('abort', () => ro.disconnect())
}
// The usage mark: its figures show on hover, or stay open after a tap / Enter (a tap elsewhere closes them).
// The figures open below the arrows, moved left as needed to stay inside a narrow window
// (the side panel), where the arrows sit near the right edge.
const fitUse = () => requestAnimationFrame(() => {
  const pop = $('usePop')
  if (!pop) return
  pop.style.left = ''
  const r = pop.getBoundingClientRect()
  if (!r.width) return
  const over = r.right - (document.documentElement.clientWidth - 8)
  if (over > 0) pop.style.left = `${Math.round(-6 - Math.min(over, r.left - 8))}px`
})
const toggleUse = () => { const u = $('usage'); u.classList.toggle('open'); u.setAttribute('aria-expanded', String(u.classList.contains('open'))); fitUse() }
$('usage').addEventListener('pointerenter', fitUse)
$('usage').addEventListener('focus', fitUse)
$('usage').addEventListener('click', toggleUse)
$('usage').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleUse() } })
document.addEventListener('click', e => { if (!e.target.closest('#beam-usage')) $('usage').classList.remove('open') }, {signal: life.signal})
$('turnVia').addEventListener('change', () => {
  if (peer) peer.options.config = iceConfig() // PeerJS reads it for each new connection
  dbg('Direct links from now on: ' + $('turnVia').selectedOptions[0].textContent)
})
$('pipeServer').addEventListener('change', () => {
  serverIndex = parseInt($('pipeServer').value, 10) || 0
  tabStore.set(TS + 'server', String(serverIndex))
  drawQR(); resetPipeState(); startPipe(generation)
  // A device that joined tells the hub, through the new relay, to answer it there from now on.
  const H = hubLink()
  if (H && H.known) sendHelloByRelay(generation)
  dbg('Relay server changed to ' + PIPE_SERVERS[serverIndex].replace('https://', '') + (isHub() ? '. Devices that scan the QR code from now on use it.' : '.'))
})
if (!IS_EXTENSION && !GAME) window.addEventListener('hashchange', () => {
  // A QR link opened in an existing tab: take its room and server, then clean the address bar.
  const h = parseHash()
  cleanAddressBar()
  if (h.s !== null && h.s !== serverIndex) { serverIndex = h.s; $('pipeServer').value = String(serverIndex); tabStore.set(TS + 'server', String(serverIndex)) }
  if (validCode(h.code) && h.code !== code) setRoom(h.code, 'join')
  else { drawQR(); resetPipeState(); startPipe(generation) }
})

// Start: a QR link wins, then this tab's saved room, then a new code.
if (DEV) $('details').hidden = false
// The QR code stays hidden until asked for.
for (const [toggle, box] of [['qrToggle', 'qrBox'], ['qrToggle2', 'qrBox2']]) $(toggle).addEventListener('click', () => {
  const show = $(box).hidden
  $(box).hidden = !show
  $(toggle).setAttribute('aria-expanded', String(show))
  $(toggle).querySelector('span').textContent = show ? 'Hide QR code' : 'Show QR code'
})
// A game's page keeps its own address: its room comes from the game (a code to join, or this tab's
// room again after a reload).
const h = GAME ? {code: '', s: Number.isInteger(GAME.server) && GAME.server >= 0 && GAME.server < PIPE_SERVERS.length ? GAME.server : null} : parseHash()
const savedServer = parseInt(tabStore.get(TS + 'server'), 10)
serverIndex = h.s !== null ? h.s : (Number.isInteger(savedServer) && savedServer >= 0 && savedServer < PIPE_SERVERS.length ? savedServer : 0)
tabStore.set(TS + 'server', String(serverIndex))
$('pipeServer').value = String(serverIndex)
if (!GAME) cleanAddressBar()
probeWebRTC()
if (DEV) setTimeout(deepProbe, 7000)
showUse()
if (Object.keys(relaySpeeds).length) showSpeeds()
const savedRoom = tabStore.get(TS + 'room'), savedIntent = tabStore.get(TS + 'intent')
if (GAME) {
  if (validCode(GAME.join)) setRoom(GAME.join, 'join')
  else if (GAME.resume && validCode(savedRoom)) setRoom(savedRoom, savedIntent === 'create' ? 'create' : 'join', true)
  else setRoom('', 'create')
} else if (validCode(h.code)) setRoom(h.code, 'join')                            // opened from a QR code
else if (validCode(savedRoom)) setRoom(savedRoom, savedIntent === 'create' ? 'create' : 'join', true) // reload: back to this tab's room
else setRoom('', 'create')                                                       // fresh visit

// Busy: paired, asking whether to accept someone, or sending. dispose() lets go of everything:
// tells every device goodbye, stops transfers, gives up the code and stops listening.
return {
  busy: () => mode !== 'waiting' || activeX.size > 0 || asks.length > 0,
  // For a game: the room as it is now, and a message to one device ('hub' from a device that joined).
  info: () => ({
    code, host: isHub(), server: serverIndex, connected: mode === 'connected',
    peers: roomLinks().map(L => ({id: isHub() ? L.pub : 'hub', name: L.name, state: !L.accepted ? 'away' : viaRelay(L) ? 'relay' : 'direct'})),
  }),
  send(id, d) {
    const L = id === 'hub' ? hubLink() : links.get(id)
    if (!L || !L.accepted || life.signal.aborted) return
    markActive()
    if (direct(L)) sendCtl(L, {t: 'g', d})
    else postControl(L, {t: 'g', d}, 3)
  },
  dispose() {
    for (const x of [...activeX]) { if (x.cancel) x.cancel(); else finishXfer(x, 'failed', 'Stopped') }
    for (const L of links.values()) sayBye(L)
    generation++ // every callback still on its way sees it's stale
    life.abort()
    clearInterval(idleTimer)
    clearInterval(meterTimer)
    for (const L of links.values()) clearTimeout(L.lostTimer)
    clearTimeout(clearTimer)
    setTimeout(() => {
      closeAllLanes()
      if (peer) { try { peer.destroy() } catch (e) {} peer = null }
      stopListening()
    }, 300) // let the goodbye leave first
    keepAwake(false)
    stopScan()
    for (const x of rows) if (x.url) URL.revokeObjectURL(x.url)
    disk.close()
    tabStore.set(TS + 'room', '')
  },
}
}

window.Beam = { mount, deviceName: () => deviceName(), maxDevices: MAX_DEVICES }
// The page versions (beam/index.html, the website) mount themselves.
const auto = document.querySelector('[data-beam-auto]')
if (auto) mount(auto)
})()
