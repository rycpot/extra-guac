// Text from image: drag a box over the page (area.js in its "ocr" mode, same handles and
// ✕ / ✓ as an area screenshot), the box is read by OCR.space (with your own free key, or
// Extra Guac's two shared ones while they last; see sharedOcrRead), and the
// text is copied and shown in a card on the page (ocr-card.js). The card keeps the image,
// so it can read it again with the other engine without a new selection.
// Engine 3 (default): slower, better on handwriting, tables and 200+ languages, with its own
// smaller monthly quota. Engine 2: fast, detects the language.

const OCR_FREE_URL = "https://api.ocr.space/parse/image";
const OCR_MAX_BYTES = { free: 1000 * 1000, pro: 5000 * 1000 }; // per image

// Where to send it: the free server, or the PRO servers (apipro1, then apipro2 if the first
// one fails), or the one typed in settings when the welcome email names another
// ("apipro3.ocr.space" or a full https:// address; /parse/image is added when there's no path).
const OCR_PRO_URLS = ["https://apipro1.ocr.space/parse/image", "https://apipro2.ocr.space/parse/image"];
function ocrUrls(ocr) {
  if (ocr.plan !== "pro") return [OCR_FREE_URL];
  let v = (ocr.endpoint || "").trim();
  if (!v) return OCR_PRO_URLS;
  if (!/^https?:\/\//i.test(v)) v = `https://${v}`;
  let u;
  try { u = new URL(v); } catch { throw new Error("The PRO server address in settings → text from image isn't valid"); }
  if (u.pathname === "/" || !u.pathname) u.pathname = "/parse/image";
  return [u.href, ...OCR_PRO_URLS.filter((x) => x !== u.href)];
}

// Extra Guac's shared free keys (kept scrambled, like the x.gd key in bg-shortener.js), used
// when no key of your own is set, on the free plan. When one hits its daily or monthly limit
// the other is used; when both have, you're asked to get a free key of your own. Which ones
// are used up, and until when, per engine (engine 3 has its own quota), is in storage.local
// "ocrShared": { "<key index>:<engine>": time it can be tried again }.
const OCR_SHARED = ["EWVhf3NMRVtQU2Rvd3RP", "EWVmdnBOQV9QVWRvd3RP"];
const OCR_OWN_KEY = "Extra Guac's shared OCR.space keys are used up for now. Get your own free key at ocr.space/ocrapi/freekey (a minute, no card) and add it in settings → text from image";
const usesShared = (ocr) => !(ocr.key || "").trim() && ocr.plan !== "pro";
async function sharedLeft(engine) {
  const { ocrShared = {} } = await chrome.storage.local.get("ocrShared");
  return OCR_SHARED.map((_, i) => i).filter((i) => !(ocrShared[`${i}:${engine}`] > Date.now()));
}

const ocrHandlers = {
  // Popup: start the selection on this tab.
  ocr: async ({ tabId }) => {
    const { ocr } = await TT.getSettings();
    if (!ocr.key.trim() && ocr.plan === "pro") throw new Error("Add your OCR.space PRO key in settings → text from image first");
    if (usesShared(ocr) && !(await sharedLeft(ocr.engine === "3" ? "3" : "2")).length) throw new Error(OCR_OWN_KEY);
    const target = { tabId };
    await chrome.scripting.executeScript({ target, func: () => { window.__ttAreaMode = "ocr"; } });
    await chrome.scripting.executeScript({ target, files: ["area.js"] });
  },
  // area.js: the box was confirmed. Captured here; the card on the page does the rest.
  ocrSelected: async ({ rect, viewportWidth }, sender) => {
    const tab = sender.tab;
    const { ocr } = await TT.getSettings();
    const msg = { type: "egOcrCard", engine: ocr.engine === "3" ? "3" : "2" };
    try { msg.image = await ocrImage(tab, rect, viewportWidth); } catch (err) { msg.error = err.message; }
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["ocr-card.js"] });
    await chrome.tabs.sendMessage(tab.id, msg, { frameId: 0 });
  },
  // Settings → check key: read a tiny test image with the key typed in, and find its plan.
  ocrTest: ({ key, image, endpoint }) => ocrKeyPlan(key, image, endpoint),
  // ocr-card.js: read this image with this engine; the text is copied too.
  ocrRead: async ({ image, engine }, sender) => {
    const text = await ocrRead(image, engine === "3" ? "3" : "2");
    const copied = text ? await copyToClipboard(text) : false;
    return { text, copied };
  },
};

// The selected part of the visible tab, at full screen resolution (sharper text reads
// better), as a PNG; as a JPEG, then smaller, if that's over the plan's limit (1 MB free, 5 MB PRO).
async function ocrImage(tab, rect, viewportWidth) {
  const { ocr } = await TT.getSettings();
  const max = OCR_MAX_BYTES[ocr.plan === "pro" ? "pro" : "free"];
  await sleep(80); // let the selection overlay disappear from the screen
  const bmp = await toBitmap(await grab(tab));
  const scale = bmp.width / viewportWidth;
  const sx = Math.round(rect.x * scale), sy = Math.round(rect.y * scale);
  const sw = Math.max(1, Math.round(rect.width * scale)), sh = Math.max(1, Math.round(rect.height * scale));
  for (const [shrink, type, quality] of [[1, "image/png"], [1, "image/jpeg", 0.92], [0.75, "image/jpeg", 0.9], [0.5, "image/jpeg", 0.88], [0.35, "image/jpeg", 0.85]]) {
    const w = Math.max(1, Math.round(sw * shrink)), h = Math.max(1, Math.round(sh * shrink));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff"; // JPEG has no transparency
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, w, h);
    const blob = await canvas.convertToBlob({ type, quality });
    if (blob.size <= max) return blobToDataUrl(blob);
  }
  throw new Error("That area is too big to read in one go; select a smaller part");
}

const blobToDataUrl = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(blob);
});

// test: { key, plan, endpoint } typed in settings, not saved yet. On PRO, a server that
// can't be reached, times out or fails to process (not a key, limit or unreadable-image
// answer) is tried once more on the next PRO server.
async function ocrRead(image, engine, test) {
  const ocr = test || (await TT.getSettings()).ocr;
  const key = (ocr.key || "").trim();
  if (!test && usesShared(ocr)) return sharedOcrRead(image, engine);
  if (!key) throw new Error(ocr.plan === "pro" ? "Add your OCR.space PRO key in settings → text from image" : "Add your free OCR.space key in settings → text from image");
  const urls = ocrUrls(ocr);
  let last;
  for (const url of urls) {
    try { return await ocrPost(url, key, image, engine, ocr.plan === "pro"); }
    catch (err) { if (!err.retry) throw err; last = err; }
  }
  throw last;
}

// Which plan a key is on. A key doesn't say, and OCR.space has no way to ask, but PRO keys are
// taken only by the PRO servers and free keys only by the free one: the test image is read on
// the PRO servers first, then on the free one. { text, plan }: plan is null when the free
// server took the key but the PRO ones couldn't be asked (unreachable, timed out).
async function ocrKeyPlan(key, image, endpoint) {
  let proErr;
  try { return { text: await ocrRead(image, "2", { key, plan: "pro", endpoint }), plan: "pro" }; } catch (err) { proErr = err; }
  const notPro = /refused the key/.test(proErr.message);
  try { return { text: await ocrRead(image, "2", { key, plan: "free" }), plan: notPro ? "free" : null }; } catch (err) {
    // Refused by the free server after the PRO ones failed some other way: it may be a PRO key.
    throw /refused the key/.test(err.message) && !notPro ? proErr : err;
  }
}

// With the shared keys: the first one not used up; one that hits a limit is set aside until
// it resets (the time OCR.space gives, else a day, or the 1st of next month for a monthly
// limit) and the next is tried.
async function sharedOcrRead(image, engine) {
  for (const i of await sharedLeft(engine)) {
    try { return await ocrPost(OCR_FREE_URL, unscrambleKey(OCR_SHARED[i]), image, engine, false, true); }
    catch (err) {
      if (!err.limit) throw err;
      await editLocal(["ocrShared"], ({ ocrShared = {} }) => ({ ocrShared: { ...ocrShared, [`${i}:${engine}`]: err.until } }));
    }
  }
  throw new Error(OCR_OWN_KEY);
}

// When a limit that was hit resets: the seconds OCR.space names ("… within 86400 seconds"),
// else a monthly limit at the start of next month, else in a day.
function limitResets(res, text) {
  const secs = +(/within\s+(\d+)\s*seconds/i.exec(text || "")?.[1] || res.headers.get("retry-after") || NaN);
  if (secs > 0) return Date.now() + secs * 1000;
  if (/month/i.test(text || "")) { const d = new Date(); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1); }
  return Date.now() + 86400000;
}

async function ocrPost(url, key, image, engine, pro, shared = false) {
  const fail = (text, retry = false) => Object.assign(new Error(text), { retry });
  const form = new URLSearchParams({ base64Image: image, OCREngine: engine, language: "auto", scale: "true", detectOrientation: "true" });
  let res;
  try {
    res = await fetch(url, { method: "POST", headers: { apikey: key }, body: form, signal: AbortSignal.timeout(pro ? 30000 : 60000) });
  } catch (err) {
    throw fail(err.name === "TimeoutError" ? "OCR.space took too long to answer; try again"
      : pro ? "Couldn't reach the PRO server; check its address in settings → text from image" : "Couldn't reach OCR.space", true);
  }
  const raw = await res.text();
  let body = null;
  try { body = JSON.parse(raw); } catch {}
  const msg = (v) => (Array.isArray(v) ? v.join(" ") : v || "").trim();
  // A daily or monthly limit (OCR.space says "… maximum N number of times within S seconds").
  const said = msg(body?.ErrorMessage) || msg(body?.error) || raw.slice(0, 300);
  if (res.status === 429 || /maximum\s+\d+\s+number of times|times within|limit (reached|exceeded)|quota/i.test(said)) {
    if (shared) throw Object.assign(new Error("limit"), { limit: true, until: limitResets(res, said) });
    const wait = retryWait(res, body);
    throw fail(`OCR.space limit reached${engine === "3" ? " for engine 3" : ""}, try again ${wait || "later"}`);
  }
  if (shared && (res.status === 403 || /E555|API key/i.test(body?.error || ""))) {
    // A shared key that's been switched off: set aside for a day, like a used-up one.
    throw Object.assign(new Error("refused"), { limit: true, until: Date.now() + 86400000 });
  }
  if (res.status === 403 || /E555|API key/i.test(body?.error || "")) {
    throw fail(`OCR.space refused the key: ${msg(body?.error) || `HTTP ${res.status}`}. Check it${pro ? " and the plan" : ""} in settings → text from image`);
  }
  if (!res.ok || !body) throw fail(`OCR.space: ${msg(body?.error) || raw.trim().slice(0, 160) || `HTTP ${res.status}`}`, res.status >= 500);
  // -10: the image itself couldn't be read (blurry, tiny); not the server's fault.
  if (body.ParsedResults?.[0]?.FileParseExitCode === -10) {
    throw fail(`Couldn't make out the text; try a bigger area${engine === "2" ? " or engine 3" : ""}`);
  }
  if (body.IsErroredOnProcessing || body.OCRExitCode > 2) {
    const why = msg(body.ErrorMessage) || msg(body.ParsedResults?.[0]?.ErrorMessage) || "couldn't read the image";
    throw fail(`OCR.space: ${why}`, true);
  }
  return (body.ParsedResults || []).map((r) => r.ParsedText || "").join("\n").replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").trim();
}

// Engine 3 became the default in 276 (it was engine 2): settings from before then move to it
// once. It can be changed back in settings.
chrome.runtime.onInstalled.addListener(async ({ reason, previousVersion }) => {
  if (reason !== "update" || !(Number(previousVersion) < 276 || !/^\d+$/.test(previousVersion || ""))) return;
  const { ocr } = await TT.getSettings();
  if (ocr.engine !== "3") await TT.updateSettings({ ocr: { engine: "3" } });
});
