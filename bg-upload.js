// Image upload to ImgLink and/or x02 from the right-click menu on images, and screenshot
// uploads. Every upload is unlisted: it opens for anyone with the link but isn't listed
// in a gallery, profile or search.
// - ImgLink works without an account (anonymous) or with your API key (your account,
//   bigger limits); uploads are always sent as private (= unlisted), whatever the
//   account's default is.
// - x02 needs an API key and is only offered once that key has been verified.
// x02 is first asked to fetch the image itself; if it can't (private, hot-link protected,
// data:/blob: images), or for ImgLink, which has no fetch-by-address, the image is
// downloaded here, with your cookies, and uploaded as a file.

const uploadHandlers = {
  verifyX02: ({ key }) => verifyX02(key),
  verifyImglink: ({ key }) => verifyImglink(key),
  x02Usage: () => x02Usage(),
  clearUploadHistory: () => chrome.storage.local.set({ uploadHistory: [] }),
};

const UPLOAD_HISTORY_LIMIT = 100;

const UPLOADERS = {
  imglink: {
    label: "imglink",
    async fromFile(blob, name, s) {
      const key = s.imglinkVerified && s.imglinkKey.trim();
      const form = new FormData();
      form.append("visibility", "private");
      form.append("file", blob, name);
      const res = await fetch(key ? "https://imglink.cc/api/v1/upload" : "https://imglink.cc/api/upload", {
        method: "POST",
        headers: key ? { "x-api-key": key } : {},
        body: form,
      });
      return this.parse(res, !!key);
    },
    async parse(res, withKey) {
      const text = await res.text();
      let body = null;
      try { body = JSON.parse(text); } catch {}
      const url = body?.url || body?.images?.[0]?.url;
      if (res.ok && /^https:\/\//i.test(url || "")) return url;
      const why = body?.error || body?.message || text.trim().slice(0, 160) || `HTTP ${res.status}`;
      if (res.status === 401) throw new Error(`imglink refused the API key: ${why}`);
      if (res.status === 413) throw new Error(`imglink: image too large or storage full (${withKey ? "50 MB per file" : "25 MB per file without a key"})`);
      if (res.status === 429) throw new Error(`imglink: ${withKey ? "upload limit" : "limit for uploads without a key"} reached, try again later`);
      throw new Error(`imglink: ${why}`);
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

// Storage and daily uploads for settings → upload images, from the same account
// summary x02's own dashboard reads (not in their published API docs, so any field may be
// missing: settings then leaves that meter out). The daily limit follows the plan.
async function x02Usage() {
  const { upload: s } = await TT.getSettings();
  if (!s.x02Verified || !s.x02Key.trim()) throw new Error("No verified x02 key");
  const res = await fetch("https://up.x02.me/api/user/dashboard?page=1&limit=1", { headers: { "x-api-key": s.x02Key.trim() } });
  const body = await res.json().catch(() => null);
  if (!res.ok || body?.success === false) throw new Error(body?.error || `x02 answered HTTP ${res.status}`);
  const user = body?.data?.user || {};
  const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : null);
  return {
    storageUsed: num(user.usage?.monthlyStorageUsed),
    storageLimit: num(user.limits?.monthlyStorageLimit),
    today: num(user.usage?.todayCount),
    dailyLimit: num(user.limits?.dailyLimit),
    resetsAt: user.usage?.resetsAt || null,
    plan: typeof user.plan === "string" ? user.plan : typeof user.tier === "string" ? user.tier : "",
  };
}

// A key is checked by asking to change an image that doesn't exist: a good key gets
// "not found", a bad one "invalid API key". Nothing is uploaded.
async function verifyImglink(key) {
  key = (key || "").trim();
  let ok = false, error = "";
  if (key) {
    try {
      const res = await fetch("https://imglink.cc/api/v1/image/egKeyCheck0", {
        method: "PATCH",
        headers: { "x-api-key": key, "content-type": "application/json" },
        body: JSON.stringify({ nsfw: false }),
      });
      const body = await res.json().catch(() => null);
      ok = res.status === 404 || res.ok;
      if (!ok) error = res.status === 401 ? "imglink says the key is invalid" : body?.error || `imglink answered HTTP ${res.status}`;
    } catch (e) {
      error = `Couldn't reach imglink: ${e.message}`;
    }
  }
  // No key is fine: uploads then go up anonymously.
  await TT.updateSettings({ upload: { imglinkKey: key, imglinkVerified: ok } });
  return { verified: ok, error };
}

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

const uploadHostsOn = TT.uploadHosts; // switched on (and, for x02, a verified key)

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
  if (!uploadHostsOn(s).includes(host)) throw new Error(`${host === "x02" ? "x02 needs a verified API key" : `${host} is switched off`} (upload images)`);
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
    if (up.fromUrl && /^https?:/i.test(srcUrl)) {
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
