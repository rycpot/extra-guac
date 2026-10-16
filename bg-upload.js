// Image upload to ImgLink and/or x02 from the right-click menu on images, and screenshot
// uploads. Every upload is unlisted: it opens for anyone with the link but isn't listed
// in a gallery, profile or search.
// - ImgLink works without an account (anonymous: 25 MB per file, 10 uploads per rolling
//   10 minutes per IP) or with your API key (your account, bigger limits); uploads are always sent as private (= unlisted), whatever the
//   account's default is.
// - x02 needs an API key and is only offered once that key has been verified.
// x02 is first asked to fetch the image itself; if it can't (private, hot-link protected,
// data:/blob: images), or for ImgLink, which has no fetch-by-address, the image is
// downloaded here, with your cookies, and uploaded as a file.

const uploadHandlers = {
  verifyX02: ({ key }) => verifyX02(key),
  verifyImglink: ({ key }) => verifyImglink(key),
  x02Usage: () => x02Usage(),
  imglinkUsage: () => imglinkUsage(),
  clearUploadHistory: () => editLocal("uploadHistory", () => ({ uploadHistory: [] })),
  deleteUploads: ({ links }) => deleteUploads(links),
  uploadThumbs: ({ links }) => fillUploadThumbs(links),
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
      const id = body?.id || body?.images?.[0]?.id;
      // Only uploads to your account can be deleted (anonymous ones can't, by anyone).
      if (res.ok && /^https:\/\//i.test(url || "")) return { url, del: withKey && id ? { host: "imglink", id } : null };
      const why = body?.error || body?.message || text.trim().slice(0, 160) || `HTTP ${res.status}`;
      if (res.status === 401) throw new Error(`imglink refused the API key: ${why}`);
      if (res.status === 413) throw new Error(`imglink: image too large or storage full (${withKey ? "50 MB per file" : "25 MB per file without a key"})`);
      if (res.status === 429) {
        const wait = retryWait(res, body);
        throw new Error(`imglink: ${withKey ? "upload limit reached" : "10 uploads per 10 minutes without a key"}, try again ${wait || (withKey ? "later" : "in a few minutes")}`);
      }
      throw new Error(`imglink: ${why}`);
    },
  },
  x02: {
    label: "X02",
    async fromUrl(url, s) {
      let res;
      try {
        res = await fetch("https://up.x02.me/api/upload/url", {
          method: "POST",
          headers: { "x-api-key": s.x02Key.trim(), "content-type": "application/json" },
          body: JSON.stringify({ imageUrl: url }),
        });
      } catch {
        throw new Error("Couldn't reach X02, check your connection and try again");
      }
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
      // Deleting needs the file name the upload answered with (or the link's last part).
      if (res.ok && body?.success && /^https?:\/\//i.test(body.data?.url || "")) {
        let id = body.data.filename || body.data.fileName || "";
        if (!id) try { id = decodeURIComponent(new URL(body.data.url).pathname.split("/").pop() || ""); } catch {}
        return { url: body.data.url, del: id ? { host: "x02", id } : null };
      }
      if (res.ok && body?.success) throw new Error("X02 took the image but sent no link back; check your uploads on x02.me");
      const why = body?.error || text.trim().slice(0, 160) || `HTTP ${res.status}`;
      if (res.status === 401 || res.status === 403) throw new Error(`X02 refused the API key: ${why}`);
      if (res.status === 413) throw new Error("X02: image is larger than your plan allows");
      if (res.status === 429) throw new Error(`X02: rate limit reached, try again ${retryWait(res, body) || "shortly"}`);
      const err = new Error(`X02: ${why}`);
      // X02 said plainly that it failed (it couldn't fetch the image, say), so the image can
      // be sent as a file instead. Any other odd reply may mean it was stored after all, and
      // sending it again would make a duplicate.
      err.retryAsFile = body?.success === false || (res.status >= 400 && res.status < 500);
      throw err;
    },
  },
};

// How long the host says to wait after refusing an upload for its rate limit ("in 4 min"),
// or "" when it doesn't say. Read from the refusal itself, so it counts every upload the
// host saw from you (other devices and apps on your IP included). Sources, in order: the
// standard Retry-After header (seconds or a date), a wait in the body, and the
// x-ratelimit-reset header when its x-ratelimit-remaining is 0 (that limit is the one hit).
function retryWait(res, body) {
  const h = (n) => res.headers.get(n)?.trim();
  let secs = NaN;
  const ra = h("retry-after");
  if (ra) secs = /^\d+(\.\d+)?$/.test(ra) ? +ra : (Date.parse(ra) - Date.now()) / 1000;
  if (!(secs > 0)) secs = +(body?.retryAfter ?? body?.retry_after ?? body?.resetSeconds ?? NaN);
  if (!(secs > 0) && h("x-ratelimit-remaining") === "0") secs = +h("x-ratelimit-reset");
  if (!(secs > 0) || secs > 86400) return "";
  if (secs < 60) return `in ${Math.ceil(secs)} s`;
  const min = Math.ceil(secs / 60);
  return min < 60 ? `in ${min} min` : `in ${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ""}`;
}

// Storage and daily uploads for settings → upload images, from the same account
// summary x02's own dashboard reads (not in their published API docs, so any field may be
// missing: settings then leaves that meter out). The daily limit follows the plan.
async function x02Usage() {
  const { upload: s } = await TT.getSettings();
  if (!s.x02Verified || !s.x02Key.trim()) throw new Error("No verified x02 key");
  const res = await fetch("https://up.x02.me/api/user/dashboard?page=1&limit=1", { headers: { "x-api-key": s.x02Key.trim() } });
  const body = await res.json().catch(() => null);
  if (!res.ok || body?.success === false) throw new Error(body?.error || `X02 answered HTTP ${res.status}`);
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

// Storage and the hourly upload window for settings → upload images (GET /api/v1/me).
// Sizes in bytes; a null limit means unlimited.
async function imglinkUsage() {
  const { upload: s } = await TT.getSettings();
  if (!s.imglinkVerified || !s.imglinkKey.trim()) throw new Error("No verified imglink key");
  const res = await fetch("https://imglink.cc/api/v1/me", { headers: { "x-api-key": s.imglinkKey.trim() } });
  const body = await res.json().catch(() => null);
  if (!res.ok || body?.success === false) throw new Error(body?.error || `imglink answered HTTP ${res.status}`);
  const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
  const role = String(body?.role || "user");
  return {
    storageUsed: num(body?.storage?.used),
    storageLimit: num(body?.storage?.limit), // null: unlimited
    used: num(body?.rateLimit?.used),
    limit: num(body?.rateLimit?.limit),
    resetSeconds: num(body?.rateLimit?.resetSeconds),
    tier: role !== "user" ? role : body?.emailVerified ? "verified" : "unverified",
  };
}

// A key is checked against the account summary (GET /api/v1/me); nothing is uploaded.
async function verifyImglink(key) {
  key = (key || "").trim();
  let ok = false, error = "";
  if (key) {
    try {
      const res = await fetch("https://imglink.cc/api/v1/me", { headers: { "x-api-key": key } });
      const body = await res.json().catch(() => null);
      ok = res.ok && body?.success !== false;
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
      if (!ok) error = body?.error || `X02 answered HTTP ${res.status}`;
    } catch (e) {
      error = `Couldn't reach X02: ${e.message}`;
    }
  } else {
    error = "Enter an API key";
  }
  await TT.updateSettings({ upload: { x02Key: key, x02Verified: ok, ...(ok ? {} : { x02: false }) } });
  return { verified: ok, error };
}

const uploadHostsOn = TT.uploadHosts; // switched on (and, for x02, a verified key)

// Deletes uploads from their host (x02, or ImgLink uploads made with your key) and drops
// them from the history. Each link that can't be deleted keeps its entry and says why.
const DELETERS = {
  async x02(id, s, link) {
    const res = await fetch(`https://up.x02.me/api/user/images/${encodeURIComponent(id)}/delete`, { method: "POST", headers: { "x-api-key": s.x02Key.trim() } });
    // Not found: already deleted (on x02.me, say) if the link itself is gone too.
    if (res.status === 404 && (await linkGone(link))) return;
    const body = await res.json().catch(() => null);
    if (!res.ok || body?.success === false) throw new Error(`X02: ${body?.error || body?.message || `HTTP ${res.status}`}`);
  },
  async imglink(id, s) {
    if (!s.imglinkKey.trim()) throw new Error("imglink: needs the API key it was uploaded with");
    const res = await fetch(`https://imglink.cc/api/v1/image/${encodeURIComponent(id)}`, { method: "DELETE", headers: { "x-api-key": s.imglinkKey.trim() } });
    const body = await res.json().catch(() => null);
    if (!res.ok && res.status !== 404) throw new Error(`imglink: ${body?.error || `HTTP ${res.status}`}`); // 404: already gone
  },
};

async function linkGone(link) {
  try {
    const res = await fetch(link, { method: "HEAD", credentials: "omit", cache: "no-store" });
    return res.status === 404 || res.status === 410;
  } catch {
    return false;
  }
}

async function deleteUploads(links) {
  const { upload: s } = await TT.getSettings();
  const { uploadHistory = [] } = await chrome.storage.local.get("uploadHistory");
  const gone = new Set(), errors = [];
  for (const link of links) {
    const entry = uploadHistory.find((e) => e.link === link);
    try {
      if (!entry?.del || !DELETERS[entry.del.host]) throw new Error("this upload can't be deleted from here");
      await DELETERS[entry.del.host](entry.del.id, s, entry.link);
      gone.add(link);
    } catch (e) { errors.push(e.message); }
  }
  await editLocal("uploadHistory", ({ uploadHistory: now = [] }) => ({ uploadHistory: now.filter((e) => !gone.has(e.link)) }));
  if (errors.length) throw new Error(errors[0]);
  return { deleted: gone.size };
}

// blobs[i]: the image entries[i] was made from, for its thumbnail (upload-thumbs.js).
async function recordUploads(entries, blobs = []) {
  await editLocal("uploadHistory", ({ uploadHistory = [] }) => ({ uploadHistory: [...entries, ...uploadHistory].slice(0, UPLOAD_HISTORY_LIMIT) }));
  await Promise.all(entries.map((e, i) => blobs[i] && UPTHUMBS.save(e.link, blobs[i]).catch(() => {})));
  const fetchLater = entries.filter((e, i) => !blobs[i]).map((e) => e.link); // sent by address: no image here
  if (fetchLater.length) fillUploadThumbs(fetchLater).catch(() => {});
}

// ---- Upload thumbnails: fetched once from the link when there's no image to make one from.
// A link that answers with a page instead of an image gets its preview image (og:image).
// One that fails is tried again a day later at most.
async function fetchImageBlob(url, depth = 0) {
  const res = await fetch(url, { credentials: "omit" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = res.headers.get("content-type") || "";
  if (type.startsWith("image/")) return res.blob();
  if (depth || !type.includes("html")) throw new Error("not an image");
  const html = (await res.text()).slice(0, 200000);
  const m = /<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]*content=["']([^"']+)/i.exec(html)
    || /<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:image|twitter:image)["']/i.exec(html);
  if (!m) throw new Error("no image on the page");
  return fetchImageBlob(new URL(m[1].replace(/&amp;/g, "&"), url).href, 1);
}
const thumbJobs = new Map(); // link -> running fetch
async function fillUploadThumbs(links) {
  let made = 0;
  const one = async (link) => {
    const rec = await UPTHUMBS.get(link).catch(() => null);
    if (rec?.thumb || (rec?.failed && Date.now() - rec.at < DAY_MS)) return;
    if (!/^https?:\/\//i.test(link)) return;
    try {
      await UPTHUMBS.save(link, await fetchImageBlob(link));
      made++;
    } catch {
      await UPTHUMBS.put({ link, thumb: null, failed: true, at: Date.now() }).catch(() => {});
    }
  };
  const queue = [...new Set(links)];
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
    for (let link; (link = queue.shift()); ) {
      if (!thumbJobs.has(link)) thumbJobs.set(link, one(link).finally(() => thumbJobs.delete(link)));
      await thumbJobs.get(link);
    }
  }));
  return { made };
}
const DAY_MS = 86400000;
// Thumbnails go with their uploads (dropped off the list, deleted, cleared, a restore).
async function tidyUploadThumbs() {
  const { uploadHistory = [] } = await chrome.storage.local.get("uploadHistory");
  const keep = new Set(uploadHistory.map((e) => e.link));
  for (const link of await UPTHUMBS.keys().catch(() => [])) if (!keep.has(link)) await UPTHUMBS.remove(link).catch(() => {});
}
chrome.storage.onChanged.addListener((c, area) => { if (area === "local" && c.uploadHistory) tidyUploadThumbs().catch(() => {}); });
chrome.runtime.onStartup.addListener(() => tidyUploadThumbs().catch(() => {}));

// Screenshot upload (bg-capture.js / shot-card.js): every part goes up as a file; the
// links are copied (one per line) and kept in the upload history. first = the first
// screenshot ever uploaded, so the card can say the links are public.
async function uploadShot(items, host, tab, what = "") {
  const { upload: s } = await TT.getSettings();
  if (!uploadHostsOn(s).includes(host)) throw new Error(`${host === "x02" ? "X02 needs a verified API key" : `${host} is switched off`} (upload images)`);
  const up = UPLOADERS[host];
  const done = [], blobs = [];
  for (const it of items) {
    const blob = await (await fetch(it.dataUrl)).blob();
    done.push(await up.fromFile(blob, it.name.split("/").pop(), s));
    blobs.push(blob);
  }
  const links = done.map((d) => d.url);
  let site = "page";
  try { site = new URL(tab.url).hostname.replace(/^www\./, "") || site; } catch {}
  const at = Date.now();
  const source = what === "QR code" ? "QR code" : `screenshot of ${site}`;
  await recordUploads(done.map((d) => ({ host: up.label, link: d.url, source, at, ...(d.del ? { del: d.del } : {}) })), blobs);
  const copied = await copyToClipboard(links.join("\n"));
  const { notes = {} } = await chrome.storage.local.get("notes");
  if (!notes.shotUpload) await chrome.storage.local.set({ notes: { ...notes, shotUpload: at } });
  return { links, copied, first: !notes.shotUpload, deletable: done.every((d) => d.del) };
}

// The toolbar badge for a tab: ↑ while any upload from it runs, then ✓ or ✕ for a moment
// once the last one ends.
const uploadsRunning = new Map(), badgeTimers = new Map();
function uploadBadgeStart(tabId) {
  uploadsRunning.set(tabId, (uploadsRunning.get(tabId) || 0) + 1);
  clearTimeout(badgeTimers.get(tabId));
  setBadge(tabId, "↑", "#0a84ff");
}
function uploadBadgeEnd(tabId, ok) {
  const left = (uploadsRunning.get(tabId) || 1) - 1;
  if (left) return void uploadsRunning.set(tabId, left);
  uploadsRunning.delete(tabId);
  setBadge(tabId, ok ? "✓" : "✕", ok ? "#30d158" : "#ff453a");
  badgeTimers.set(tabId, setTimeout(() => { badgeTimers.delete(tabId); setBadge(tabId, ""); }, 2500));
}

async function uploadImage(host, srcUrl, tab, frameId = 0) {
  const { upload: s } = await TT.getSettings();
  const up = UPLOADERS[host];
  let ok = false;
  uploadBadgeStart(tab.id);
  try {
    let done = null, blob = null;
    if (up.fromUrl && /^https?:/i.test(srcUrl)) {
      try { done = await up.fromUrl(srcUrl, s); } catch (e) { if (!e.retryAsFile) throw e; }
    }
    if (!done) {
      const got = await fetchImage(srcUrl, tab, frameId);
      blob = got.blob;
      done = await up.fromFile(blob, got.name, s);
    }
    const link = done.url;
    await recordUploads([{ host: up.label, link, source: srcUrl.startsWith("data:") ? "(embedded image)" : srcUrl, at: Date.now(), ...(done.del ? { del: done.del } : {}) }], [blob]);
    const copied = await copyToClipboard(link);
    ok = true;
    chrome.notifications.create(`upload|${link}`, {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: `Uploaded to ${up.label}${copied ? " · link copied" : " · copy failed, click to open"}`,
      message: link,
      contextMessage: "Click to open",
    });
  } catch (err) {
    chrome.notifications.create(`upload-error-${Date.now()}`, {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: `Upload to ${up.label} failed`,
      message: err.message,
    });
  } finally {
    uploadBadgeEnd(tab.id, ok);
  }
}

// Copies text in Extra Guac's own hidden (offscreen) page, never in the page that was
// right-clicked: that page could see the text in its copy event or swap it, and selecting
// text there would take the cursor out of whatever was being typed in. The clipboardWrite
// permission lets it work without a click. Tried twice, in case Chrome closed the page
// just then.
async function copyToClipboard(text) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await toOffscreen({ type: "copy", text });
      return true;
    } catch {}
  }
  return false;
}

// Downloads the image bytes: data: URLs directly, blob: URLs from inside the frame that
// made them (a blob: address only works there, and it may be an embedded frame),
// everything else with the page's cookies so logged-in images work.
async function fetchImage(srcUrl, tab, frameId = 0) {
  let blob;
  if (srcUrl.startsWith("blob:")) {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [frameId || 0] },
      func: async (u) => {
        const b = await (await fetch(u)).blob();
        return new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(b); });
      },
      args: [srcUrl],
    }).catch(() => []);
    if (typeof injection?.result !== "string") throw new Error("Couldn't read this image from the page");
    blob = await (await fetch(injection.result)).blob();
  } else {
    const res = await fetch(srcUrl, { credentials: "include" });
    if (!res.ok) throw new Error(`Couldn't download the image (HTTP ${res.status})`);
    blob = await res.blob();
  }
  if (!blob.type.startsWith("image/")) {
    // Some servers label images as generic data: recognize them by their first bytes. A web
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
