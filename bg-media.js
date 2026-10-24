// Tab volume (captures the tab's audio into a gain node in the offscreen document)
// and keep awake (chrome.power, shown as a green dot on the toolbar icon).
// Loaded by background.js; mediaHandlers join its message handlers.

const mediaHandlers = {
  setVolume: ({ tabId, volume }) => setVolume(tabId, volume),
  awakeStart: ({ minutes }) => startAwake(minutes),
  awakeStop: () => stopAwake(),
};

// ---- Tab volume -------------------------------------------------------------
// storage.session "volume": { [tabId]: 0..100 }. At 100% the capture is dropped,
// so Chrome's "tab is being captured" indicator only shows while volume is lowered.
// Chrome only lets a tab's sound be captured once Extra Guac has been used on that tab
// (its icon, a right-click item); the side panel stays open across tabs, so on a tab it
// hasn't been used on, the page's own videos and audio are turned down instead
// (storage.session "volumePage": { [tabId]: true }), and again after each reload.

// One change at a time: the slider sends a new value every few dozen milliseconds while it's
// dragged, and starting a capture takes longer than that. Run side by side, a second change
// would see no capture yet and ask Chrome for another one, which it refuses while the first is
// starting: the tab then got its media turned down on top of the capture, which was left
// running at the first value, even at 100%.
let volumeQueue = Promise.resolve();
function volumeTask(fn) {
  const run = volumeQueue.then(fn);
  volumeQueue = run.catch(() => {});
  return run;
}
const setVolume = (tabId, volume) => volumeTask(() => setVolumeNow(tabId, volume));

async function setVolumeNow(tabId, volume) {
  volume = Math.max(0, Math.min(100, Math.round(+volume)));
  const { volume: vols = {} } = await chrome.storage.session.get("volume");
  const { volumePage: pages = {} } = await chrome.storage.session.get("volumePage");
  const captured = tabId in vols && !pages[tabId];
  if (pages[tabId]) {
    await pageVolume(tabId, volume / 100);
    if (volume >= 100) { delete vols[tabId]; delete pages[tabId]; } else vols[tabId] = volume;
    await chrome.storage.session.set({ volumePage: pages });
  } else if (volume >= 100) {
    if (captured) await toOffscreen({ type: "volumeStop", tabId }).catch(() => {});
    delete vols[tabId];
  } else if (captured) {
    await toOffscreen({ type: "volumeGain", tabId, gain: volume / 100 });
    vols[tabId] = volume;
  } else {
    let streamId = null;
    try { streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }); } catch {}
    if (streamId) await toOffscreen({ type: "volumeStart", tabId, streamId, gain: volume / 100 });
    else {
      await pageVolume(tabId, volume / 100);
      pages[tabId] = true;
      await chrome.storage.session.set({ volumePage: pages });
    }
    vols[tabId] = volume;
  }
  await chrome.storage.session.set({ volume: vols });
}

// The page's videos and audio, in every frame, at gain × the volume the page gave them
// (the page's own volume control keeps working); 1 puts them back.
async function pageVolume(tabId, gain) {
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    world: "MAIN",
    args: [gain],
    func: (gain) => {
      const st = (window.__egVolume ||= { gain: 1, els: new Set() });
      st.gain = gain;
      const set = (el) => { el.__egSet = Math.min(1, el.__egBase * st.gain); el.volume = el.__egSet; };
      const apply = (el) => {
        if (!(el instanceof HTMLMediaElement)) return;
        if (el.__egBase === undefined) {
          el.__egBase = el.volume;
          st.els.add(el);
          el.addEventListener("volumechange", () => { // the page changed it: that's its volume now
            if (Math.abs(el.volume - el.__egSet) < 1e-4) return; // the change was ours
            el.__egBase = el.volume;
            set(el);
          });
        }
        set(el);
      };
      document.querySelectorAll("video, audio").forEach(apply);
      st.els.forEach(apply);
      if (!st.watch) { // media added later starts playing: caught as it plays
        st.watch = (e) => apply(e.target);
        document.addEventListener("play", st.watch, true);
        document.addEventListener("loadedmetadata", st.watch, true);
      }
    },
  }).catch(() => {});
}
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status !== "complete") return;
  const { volumePage: pages = {}, volume: vols = {} } = await chrome.storage.session.get(["volumePage", "volume"]);
  if (pages[tabId] && tabId in vols) pageVolume(tabId, vols[tabId] / 100);
});

const stopAllVolume = () => volumeTask(async () => {
  const { volume: vols = {}, volumePage: pages = {} } = await chrome.storage.session.get(["volume", "volumePage"]);
  if (!Object.keys(vols).length) return;
  for (const id of Object.keys(pages)) pageVolume(+id, 1);
  await toOffscreen({ type: "volumeStopAll" }).catch(() => {});
  await chrome.storage.session.set({ volume: {}, volumePage: {} });
});

chrome.tabs.onRemoved.addListener((tabId) => volumeTask(async () => {
  const { volume: vols = {} } = await chrome.storage.session.get("volume");
  if (!(tabId in vols)) return;
  delete vols[tabId];
  const { volumePage: pages = {} } = await chrome.storage.session.get("volumePage");
  delete pages[tabId];
  await chrome.storage.session.set({ volume: vols, volumePage: pages });
  toOffscreen({ type: "volumeStop", tabId }).catch(() => {});
}).catch(() => {}));

// ---- Keep awake ---------------------------------------------------------------
// storage.session "awake": { until, minutes } (until = null / minutes = 0 means no time limit).

async function startAwake(minutes) {
  const until = minutes > 0 ? Date.now() + minutes * 60000 : null;
  chrome.power.requestKeepAwake("display");
  await chrome.storage.session.set({ awake: { until, minutes: minutes > 0 ? minutes : 0, startedAt: Date.now() } });
  await chrome.alarms.clear("awake-end");
  if (until) chrome.alarms.create("awake-end", { when: until });
  if (minutes > 0) {
    const amount = minutes % 60 === 0 && minutes >= 60 ? minutes / 60 : minutes;
    await TT.updateSettings({ awake: { lastAmount: amount, lastUnit: amount === minutes ? "min" : "h" } });
  }
  await setAwakeIcon(true);
}

async function stopAwake() {
  chrome.power.releaseKeepAwake();
  await chrome.alarms.clear("awake-end");
  await chrome.storage.session.remove("awake");
  await setAwakeIcon(false);
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "awake-end") stopAwake();
});

const ICON_SIZES = [16, 32];

async function setAwakeIcon(on) {
  if (on) await chrome.action.setIcon({ imageData: await actionIcon({ awake: true }) });
  else await chrome.action.setIcon({ path: Object.fromEntries(ICON_SIZES.map((s) => [s, `icons/icon${s}.png`])) });
  await proxyTabIcons(); // tabs with an icon of their own get the dot too
}

// The toolbar icon: the avocado, with a green dot while the screen is kept awake and the
// purple proxy pill (a globe) at the bottom-right while the tab's site goes through a proxy
// (the dot moves to the top-left then). Drawn once per combination.
const actionIcons = new Map();
async function actionIcon({ awake = false, proxy = false }) {
  const id = `${+awake}${+proxy}`;
  if (actionIcons.has(id)) return actionIcons.get(id);
  const imageData = {};
  for (const size of ICON_SIZES) {
    const blob = await (await fetch(chrome.runtime.getURL(`icons/icon${size}.png`))).blob();
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(await createImageBitmap(blob), 0, 0, size, size);
    if (proxy) {
      const w = Math.round(size * 0.62), h = Math.round((w * 40) / 64);
      drawProxyPill(ctx, size - w, size - h, w, h);
    }
    if (awake) {
      const r = size * 0.24;
      ctx.beginPath();
      ctx.arc(proxy ? r : size - r, proxy ? r : size - r, r, 0, Math.PI * 2);
      ctx.fillStyle = "#30d158";
      ctx.fill();
      ctx.lineWidth = Math.max(1, size / 16);
      ctx.strokeStyle = "#ffffff";
      ctx.stroke();
    }
    imageData[size] = ctx.getImageData(0, 0, size, size);
  }
  actionIcons.set(id, imageData);
  return imageData;
}

// The proxy pill (icons/proxy.svg, drawn on a 64×40 grid) at x, y, w × h.
function drawProxyPill(ctx, x, y, w, h) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(w / 64, h / 40);
  const g = ctx.createLinearGradient(0, 0, 64, 35);
  g.addColorStop(0, "#a683ff");
  g.addColorStop(0.55, "#7a3cfe");
  g.addColorStop(1, "#6f2efe");
  ctx.fillStyle = g;
  ctx.fill(new Path2D("M14 1.5C20 .6 44 .6 50 1.5C58.5 2.6 62.6 9 62.6 20C62.6 31 58.5 37.4 50 38.5C44 39.4 20 39.4 14 38.5C5.5 37.4 1.4 31 1.4 20C1.4 9 5.5 2.6 14 1.5Z"));
  ctx.strokeStyle = "#fbfaff";
  ctx.lineWidth = 3.4;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.arc(32, 20, 12, 0, Math.PI * 2);
  ctx.moveTo(37.2, 20);
  ctx.ellipse(32, 20, 5.2, 12, 0, 0, Math.PI * 2);
  ctx.moveTo(20.5, 20);
  ctx.lineTo(43.5, 20);
  ctx.stroke();
  ctx.restore();
}
