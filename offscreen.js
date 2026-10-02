// Hidden page owned by the background worker. It
// - sends a "tick" every second while an auto-refresh is running (a service worker's
//   own timers stop when Chrome suspends it; a message from here wakes it up),
// - plays the keyword alert sound,
// - copies text to the clipboard (uploaded image links),
// - reads font files for "what font?" (font-names.js, loaded on first use),
// - holds one audio graph per tab whose volume was lowered: tab audio -> gain -> speakers.

// Created with the BLOBS reason (which, unlike AUDIO_PLAYBACK alone, doesn't make
// Chrome close this page after ~30s of silence); this is that use.
URL.createObjectURL(new Blob(["tab-toolkit"]));

let ticker = 0;
const graphs = new Map(); // tabId -> { ctx, stream, gain }

const actions = {
  ticker({ on }) {
    if (on && !ticker) ticker = setInterval(() => chrome.runtime.sendMessage({ type: "tick" }).catch(() => {}), 1000);
    if (!on && ticker) { clearInterval(ticker); ticker = 0; }
  },

  copy({ text }) {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    if (!ok) throw new Error("copy failed");
  },

  async play({ url }) {
    if (url === "chime") return playChime();
    const audio = new Audio(url);
    await audio.play();
  },

  async volumeStart({ tabId, streamId, gain }) {
    if (graphs.has(tabId)) return actions.volumeGain({ tabId, gain });
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
    });
    const ctx = new AudioContext();
    const node = ctx.createGain();
    node.gain.value = gain;
    ctx.createMediaStreamSource(stream).connect(node);
    node.connect(ctx.destination);
    graphs.set(tabId, { ctx, stream, gain: node });
  },

  volumeGain({ tabId, gain }) {
    const g = graphs.get(tabId);
    if (g) g.gain.gain.value = gain;
  },

  volumeStop({ tabId }) {
    const g = graphs.get(tabId);
    if (!g) return;
    g.stream.getTracks().forEach((t) => t.stop());
    g.ctx.close();
    graphs.delete(tabId);
  },

  volumeStopAll() {
    for (const tabId of [...graphs.keys()]) actions.volumeStop({ tabId });
  },

  async inspectFont(request) {
    const { inspect } = await import("./font-names.js");
    return inspect(request);
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.target !== "offscreen" || !actions[msg.type]) return;
  Promise.resolve()
    .then(() => actions[msg.type](msg))
    .then((result) => reply({ ok: true, result }), (err) => reply({ ok: false, error: err?.message || String(err) }));
  return true;
});
