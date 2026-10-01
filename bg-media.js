// Tab volume (captures the tab's audio into a gain node in the offscreen document)
// and keep awake (chrome.power, shown as a green dot on the toolbar icon).

const mediaHandlers = {
  setVolume: ({ tabId, volume }) => setVolume(tabId, volume),
  awakeStart: ({ minutes }) => startAwake(minutes),
  awakeStop: () => stopAwake(),
};

// ---- Tab volume -------------------------------------------------------------
// storage.session "volume": { [tabId]: 0..100 }. At 100% the capture is dropped,
// so Chrome's "tab is being captured" indicator only shows while volume is lowered.

async function setVolume(tabId, volume) {
  volume = Math.max(0, Math.min(100, Math.round(+volume)));
  const { volume: vols = {} } = await chrome.storage.session.get("volume");
  const captured = tabId in vols;
  if (volume >= 100) {
    if (captured) await toOffscreen({ type: "volumeStop", tabId }).catch(() => {});
    delete vols[tabId];
  } else if (captured) {
    await toOffscreen({ type: "volumeGain", tabId, gain: volume / 100 });
    vols[tabId] = volume;
  } else {
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    await toOffscreen({ type: "volumeStart", tabId, streamId, gain: volume / 100 });
    vols[tabId] = volume;
  }
  await chrome.storage.session.set({ volume: vols });
}

async function stopAllVolume() {
  const { volume: vols = {} } = await chrome.storage.session.get("volume");
  if (!Object.keys(vols).length) return;
  await toOffscreen({ type: "volumeStopAll" }).catch(() => {});
  await chrome.storage.session.set({ volume: {} });
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { volume: vols = {} } = await chrome.storage.session.get("volume");
  if (!(tabId in vols)) return;
  delete vols[tabId];
  await chrome.storage.session.set({ volume: vols });
  toOffscreen({ type: "volumeStop", tabId }).catch(() => {});
});

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
  if (!on) {
    return chrome.action.setIcon({ path: Object.fromEntries(ICON_SIZES.map((s) => [s, `icons/icon${s}.png`])) });
  }
  const imageData = {};
  for (const size of ICON_SIZES) {
    const blob = await (await fetch(chrome.runtime.getURL(`icons/icon${size}.png`))).blob();
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(await createImageBitmap(blob), 0, 0, size, size);
    const r = size * 0.24;
    ctx.beginPath();
    ctx.arc(size - r, size - r, r, 0, Math.PI * 2);
    ctx.fillStyle = "#30d158";
    ctx.fill();
    ctx.lineWidth = Math.max(1, size / 16);
    ctx.strokeStyle = "#ffffff";
    ctx.stroke();
    imageData[size] = ctx.getImageData(0, 0, size, size);
  }
  await chrome.action.setIcon({ imageData });
}
