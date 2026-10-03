// Image upload to Catbox and/or x02 from the right-click menu on images.
// Catbox works anonymously or with your userhash; x02 needs an API key and is only
// offered once that key has been verified. The host is first asked to fetch the
// image itself; if it can't (private, hot-link protected, data:/blob: images), the
// image is downloaded here, with your cookies, and uploaded as a file.

const uploadHandlers = {
  verifyX02: ({ key }) => verifyX02(key),
  clearUploadHistory: () => chrome.storage.local.set({ uploadHistory: [] }),
};

const UPLOAD_HISTORY_LIMIT = 100;

const UPLOADERS = {
  catbox: {
    label: "catbox",
    async fromUrl(url, s) {
      const form = new FormData();
      form.append("reqtype", "urlupload");
      if (s.catboxUserhash.trim()) form.append("userhash", s.catboxUserhash.trim());
      form.append("url", url);
      return this.parse(await fetch("https://catbox.moe/user/api.php", { method: "POST", body: form }));
    },
    async fromFile(blob, name, s) {
      const form = new FormData();
      form.append("reqtype", "fileupload");
      if (s.catboxUserhash.trim()) form.append("userhash", s.catboxUserhash.trim());
      form.append("fileToUpload", blob, name);
      return this.parse(await fetch("https://catbox.moe/user/api.php", { method: "POST", body: form }));
    },
    async parse(res) {
      const text = (await res.text()).trim();
      if (res.ok && /^https?:\/\//i.test(text)) return text;
      throw new Error(`catbox: ${text.slice(0, 160) || `HTTP ${res.status}`}`);
    },
  },
  x02: {
    label: "x02",
    async fromUrl(url, s) {
      const res = await fetch("https://up.x02.me/api/upload/url", {
        method: "POST",
        headers: { "x-api-key": s.x02Key.trim(), "content-type": "application/json" },
        body: JSON.stringify({ imageUrl: url }),
      });
      return this.parse(res);
    },
    async fromFile(blob, name, s) {
      const form = new FormData();
      form.append("file", blob, name);
      const res = await fetch("https://up.x02.me/api/upload?format=json", {
        method: "POST",
        headers: { "x-api-key": s.x02Key.trim() },
        body: form,
      });
      return this.parse(res);
    },
    async parse(res) {
      const text = await res.text();
      let body = null;
      try { body = JSON.parse(text); } catch {}
      if (res.ok && body?.success && body.data?.url) return body.data.url;
      const why = body?.error || text.trim().slice(0, 160) || `HTTP ${res.status}`;
      if (res.status === 401 || res.status === 403) throw new Error(`x02 refused the API key: ${why}`);
      if (res.status === 413) throw new Error("x02: image is larger than your plan allows");
      if (res.status === 429) throw new Error("x02: rate limit reached, try again shortly");
      throw new Error(`x02: ${why}`);
    },
  },
};

async function verifyX02(key) {
  key = (key || "").trim();
  let ok = false, error = "";
  if (key) {
    try {
      const res = await fetch("https://up.x02.me/api/user/dashboard?page=1&limit=1", { headers: { "x-api-key": key } });
      const body = await res.json().catch(() => null);
      ok = res.ok && body?.success !== false;
      if (!ok) error = body?.error || `x02 answered HTTP ${res.status}`;
    } catch (e) {
      error = `Couldn't reach x02: ${e.message}`;
    }
  } else {
    error = "Enter an API key";
  }
  await TT.updateSettings({ upload: { x02Key: key, x02Verified: ok, ...(ok ? {} : { x02: false }) } });
  return { verified: ok, error };
}

// Hosts that can take an upload right now: switched on (and, for x02, a verified key).
const uploadHostsOn = (s) => [s.catbox && "catbox", s.x02 && s.x02Verified && s.x02Key.trim() && "x02"].filter(Boolean);

async function recordUploads(entries) {
  const { uploadHistory = [] } = await chrome.storage.local.get("uploadHistory");
  uploadHistory.unshift(...entries);
  await chrome.storage.local.set({ uploadHistory: uploadHistory.slice(0, UPLOAD_HISTORY_LIMIT) });
}

// Screenshot upload (bg-capture.js / shot-card.js): every part goes up as a file; the
// links are copied (one per line) and kept in the upload history. first = the first
// screenshot ever uploaded, so the card can say the links are public.
async function uploadShot(items, host, tab) {
  const { upload: s } = await TT.getSettings();
  if (!uploadHostsOn(s).includes(host)) throw new Error(`${host === "x02" ? "x02 needs a verified API key" : "catbox is switched off"} (upload images)`);
  const up = UPLOADERS[host];
  const links = [];
  for (const it of items) {
    const blob = await (await fetch(it.dataUrl)).blob();
    links.push(await up.fromFile(blob, it.name.split("/").pop(), s));
  }
  let site = "page";
  try { site = new URL(tab.url).hostname.replace(/^www\./, "") || site; } catch {}
  const at = Date.now();
  await recordUploads(links.map((link) => ({ host: up.label, link, source: `screenshot of ${site}`, at })));
  const copied = await copyToClipboard(links.join("\n"), tab);
  const { notes = {} } = await chrome.storage.local.get("notes");
  if (!notes.shotUpload) await chrome.storage.local.set({ notes: { ...notes, shotUpload: at } });
  return { links, copied, first: !notes.shotUpload };
}

async function uploadImage(host, srcUrl, tab) {
  const { upload: s } = await TT.getSettings();
  const up = UPLOADERS[host];
  setBadge(tab.id, "↑", "#0a84ff");
  try {
    let link;
    let firstError = null;
    if (/^https?:/i.test(srcUrl)) {
      try { link = await up.fromUrl(srcUrl, s); } catch (e) { firstError = e; }
    }
    if (!link) {
      if (firstError && /API key|rate limit|larger/.test(firstError.message)) throw firstError;
      const { blob, name } = await fetchImage(srcUrl, tab);
      link = await up.fromFile(blob, name, s);
    }
    await recordUploads([{ host: up.label, link, source: srcUrl.startsWith("data:") ? "(embedded image)" : srcUrl, at: Date.now() }]);
    const copied = await copyToClipboard(link, tab);
    setBadge(tab.id, "✓");
    chrome.notifications.create(`upload|${link}`, {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: `Uploaded to ${up.label}${copied ? " · link copied" : " · copy failed, click to open"}`,
      message: link,
      contextMessage: "Click to open",
    });
  } catch (err) {
    setBadge(tab.id, "✕", "#ff453a");
    chrome.notifications.create(`upload-error-${Date.now()}`, {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: `Upload to ${up.label} failed`,
      message: err.message,
    });
  } finally {
    setTimeout(() => setBadge(tab.id, ""), 2500);
  }
}

// Copies text: first in the page that was right-clicked (it has focus), then through
// the offscreen document. The clipboardWrite permission lets both work without a click.
async function copyToClipboard(text, tab) {
  const inPage = await chrome.scripting
    .executeScript({
      target: { tabId: tab.id },
      func: (t) => {
        const ta = document.createElement("textarea");
        ta.value = t;
        ta.style.cssText = "position:fixed;top:-100px;opacity:0;";
        document.documentElement.append(ta);
        ta.select();
        let ok = false;
        try { ok = document.execCommand("copy"); } catch {}
        ta.remove();
        return ok;
      },
      args: [text],
    })
    .then((r) => !!r[0]?.result)
    .catch(() => false);
  if (inPage) return true;
  return toOffscreen({ type: "copy", text }).then(() => true, () => false);
}

// Downloads the image bytes: data: URLs directly, blob: URLs from inside the page,
// everything else with the page's cookies so logged-in images work.
async function fetchImage(srcUrl, tab) {
  let blob;
  if (srcUrl.startsWith("blob:")) {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async (u) => {
        const b = await (await fetch(u)).blob();
        return new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(b); });
      },
      args: [srcUrl],
    });
    blob = await (await fetch(result)).blob();
  } else {
    const res = await fetch(srcUrl, { credentials: "include" });
    if (!res.ok) throw new Error(`Couldn't download the image (HTTP ${res.status})`);
    blob = await res.blob();
  }
  if (!blob.type.startsWith("image/")) {
    // Some servers label images as generic data: recognise them by their first bytes. A web
    // page (an error, login or "no hotlinking" page) is refused.
    const type = await sniffImageType(blob);
    if (!type) throw new Error("the address gave back a web page, not an image");
    blob = new Blob([blob], { type });
  }
  const ext = (blob.type.split("/")[1] || "png").replace("jpeg", "jpg").replace(/\+.*/, "");
  let base = "image";
  if (/^https?:/i.test(srcUrl)) {
    try { base = decodeURIComponent(new URL(srcUrl).pathname.split("/").pop()).replace(/\.[^.]+$/, "") || base; } catch {}
  }
  return { blob, name: `${base.replace(/[^\w.-]/g, "_").slice(0, 60)}.${ext}` };
}

async function sniffImageType(blob) {
  const b = new Uint8Array(await blob.slice(0, 32).arrayBuffer());
  const ascii = (from, to) => String.fromCharCode(...b.slice(from, to));
  if (b[0] === 0x89 && ascii(1, 4) === "PNG") return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (ascii(0, 4) === "GIF8") return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (ascii(4, 8) === "ftyp" && /^avi[fs]$/.test(ascii(8, 12))) return "image/avif";
  if (ascii(0, 2) === "BM") return "image/bmp";
  const head = (await blob.slice(0, 512).text()).trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(head)) return "image/svg+xml";
  return "";
}

chrome.notifications.onClicked.addListener((id) => {
  if (!id.startsWith("upload|")) return;
  chrome.tabs.create({ url: id.slice("upload|".length) });
  chrome.notifications.clear(id);
});
