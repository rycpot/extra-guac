// A screenshot opened from the screenshot card (shot-card.js → bg-capture.js "shotView"),
// shown without saving it, with edit tools (shot-edit.js): crop, rectangle, arrow, line,
// highlighter, text, numbered dots, blur and zoom. Parts of a very long page come one under
// another. Top right: undo, redo, ↓ save to Downloads, copy image, ☁ upload (to the host
// from settings → image upload; with both hosts on and "show both hosts", a small picker),
// all with the edits drawn in. Bottom bar: zoom, then what save and upload make (PNG or JPG,
// 1x-3x, an optional target file size) and the size of the file Save would make.
(async () => {
  const $ = (id) => document.getElementById(id);
  const ICON_CHECK = '<svg class="i" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  const send = async (type, payload = {}) => {
    const r = await chrome.runtime.sendMessage({ type, ...payload });
    if (!r?.ok) throw new Error(r?.error || "Something went wrong");
    return r;
  };
  const say = (text, bad = false) => { const st = $("status"); st.textContent = text; st.classList.toggle("bad", bad); st.title = text; };

  const id = location.hash.slice(1);
  let res = null;
  try { res = await chrome.runtime.sendMessage({ type: "shotViewGet", id }); } catch {}
  if (!res?.ok) {
    document.querySelector(".btns").hidden = true;
    say("");
    $("shots").innerHTML = `<p class="err"></p>`;
    $("shots").firstChild.textContent = res?.error || "This screenshot isn't available any more";
    return;
  }
  const items = res.items;
  const name = (items[0]?.name || "screenshot").split("/").pop();
  $("name").textContent = name;
  document.title = `${name} · Extra Guac`;

  // Blur draws into the pixels in the privacy blur style (blur, bars or mask).
  let style = PIIRules.withDefaults({});
  chrome.storage.local.get("pii").then(({ pii }) => { style = PIIRules.withDefaults(pii); });
  chrome.storage.onChanged.addListener((c, area) => { if (area === "local" && c.pii) style = PIIRules.withDefaults(c.pii.newValue); });
  const blur = {
    styleText: () => (style.style === "bars" ? "solid bars" : style.style === "mask" ? `mask (${style.maskChar})` : `blur ${style.blurPx}px`),
    openSettings: () => send("openSettings", { section: "blur" }).catch((err) => say(err.message, true)),
    draw: drawBlur,
  };
  let estimate = () => {}; // the size estimate below, once its controls are set up
  let keepClear = () => {}; // PNG once a background is removed (below)
  const editor = ShotEdit.start({
    items,
    host: $("shots"),
    say,
    blur,
    onChange: () => { say(editor.edited() ? "Edited · not saved yet" : "not saved yet"); keepClear(); estimate(); },
  });
  await editor.ready;
  const first = $("shots").querySelector("img");
  $("info").textContent = `${res.label} · ${first?.naturalWidth} × ${first?.naturalHeight}${items.length > 1 ? ` · ${items.length} parts` : ""}`;
  say("not saved yet");

  // ---- What Save and upload make: PNG | JPG, 1x / 2x / 3x, an optional target file size ----
  // A target means JPEG (its quality lowered to fit), so PNG is set aside while there is one.
  // The estimate is the file (all parts together) Save would make now; it's redone after
  // each change, a moment after the last one.
  const fmtBytes = (n) => n >= 1048576 ? `${(n / 1048576).toFixed(2)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`;
  const out = { fmt: items[0].dataUrl.startsWith("data:image/jpeg") ? "jpg" : "png", scale: 1, unit: "kb" };
  const targetBytes = () => {
    const n = parseFloat(($("target").value || "").replace(",", "."));
    return isFinite(n) && n > 0 ? Math.max(1, Math.round(n * (out.unit === "mb" ? 1048576 : 1024))) : 0;
  };
  const opts = () => ({ format: out.fmt, scale: out.scale, target: targetBytes() });
  function paintOut() {
    const target = targetBytes();
    for (const [grp, val] of [["fmt", target ? "jpg" : out.fmt], ["scale", String(out.scale)], ["unit", out.unit]]) {
      for (const b of $(grp).querySelectorAll("button")) b.setAttribute("aria-checked", String(b.dataset.v === val));
    }
    $("fmt").querySelector('[data-v="png"]').setAttribute("aria-disabled", String(!!target));
    $("fmt").querySelector('[data-v="png"]').title = target ? "A target size saves a JPG (clear it for PNG)" : "PNG: lossless";
  }
  let estTimer = 0, estRun = 0;
  // While it's worked out again, the last figure stays, dimmed (the bar doesn't jump).
  estimate = () => {
    clearTimeout(estTimer);
    if (!/\d/.test($("est").textContent)) $("est").textContent = "≈ …";
    $("est").classList.add("stale");
    estTimer = setTimeout(async () => {
      const run = ++estRun;
      try {
        const done = await editor.exportItems({ ...opts(), peek: true, stale: () => run !== estRun });
        if (run !== estRun) return;
        const bytes = done.reduce((t, x) => t + (x.bytes || 0), 0);
        const qs = done.map((x) => x.quality).filter((x) => x != null), q = qs.length ? Math.min(...qs) : null; // the lowest, with parts
        const target = targetBytes();
        $("est").textContent = `≈ ${fmtBytes(bytes)}` + (done.length > 1 ? ` in ${done.length} files` : "") + (target && q != null ? ` · JPG ${Math.round(q * 100)}%` : "")
          + (done[0]?.shrunk ? ` · ${done[0].width} × ${done[0].height}` : "")
          + (target && done.some((x) => x.bytes > target) ? " · over the target" : "");
        $("est").classList.remove("stale");
        const d = done[0];
        $("est").title = `What Save would make now: ${done.length > 1 ? `${done.length} files, ` : ""}${fmtBytes(bytes)}`
          + (d?.width ? ` · ${d.width} × ${d.height}px` : "") + (q != null && (target || out.fmt === "jpg") ? ` · JPG quality ${Math.round(q * 100)}%` : "")
          + (d?.shrunk ? " · made smaller to fit the target" : "");
      } catch { if (run === estRun) { $("est").textContent = "≈ ?"; $("est").classList.remove("stale"); } }
    }, 500);
  };
  for (const grp of ["fmt", "scale", "unit"]) {
    $(grp).addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b || b.getAttribute("aria-disabled") === "true") return;
      if (grp === "fmt") out.fmt = b.dataset.v;
      if (grp === "scale") out.scale = Number(b.dataset.v);
      if (grp === "unit") out.unit = b.dataset.v;
      paintOut(); estimate();
    });
  }
  $("target").addEventListener("input", () => { paintOut(); estimate(); });
  // With its background removed, a JPG would lose the see-through (it goes white): saving
  // turns to PNG, once; JPG can still be picked.
  let wasCut = false;
  keepClear = () => {
    const cut = editor.cutOut();
    if (cut && !wasCut && out.fmt === "jpg" && !targetBytes()) { out.fmt = "png"; paintOut(); }
    wasCut = cut;
  };
  $("out").hidden = false;
  paintOut();
  estimate();
  // The size, and for a JPEG its quality, of what was just saved or uploaded.
  const madeNote = (exported) => {
    const bytes = exported.reduce((t, x) => t + (x.bytes || 0), 0);
    const qs = exported.map((x) => x.quality).filter((x) => x != null), q = qs.length ? Math.min(...qs) : null;
    const jpg = /\.jpg$/i.test(exported[0]?.name || "");
    return ` · ${fmtBytes(bytes)}${jpg && q != null ? ` (JPG ${Math.round(q * 100)}%)` : ""}`;
  };
  // Leaving with edits that haven't gone anywhere asks first.
  addEventListener("beforeunload", (e) => { if (editor.edited()) e.preventDefault(); });

  // An edited shot that leaves the tab replaces its screenshot history entry, so what a blur
  // hid isn't kept there (or backed up). markSaved only after that.
  let historyId = res.historyId || "";
  async function leaving(exported) {
    if (!editor.edited() || !historyId) return editor.markSaved();
    try { historyId = (await send("shotHistoryReplace", { id: historyId, items: exported })).id; } catch {}
    editor.markSaved();
  }
  const flash = (btn) => { const was = btn.innerHTML; btn.innerHTML = ICON_CHECK; setTimeout(() => (btn.innerHTML = was), 1200); };

  // ↓ Save, with the screenshot folder from settings.
  $("save").onclick = async () => {
    try {
      const exported = await editor.exportItems(opts());
      const r = await send("shotSave", { items: exported });
      await leaving(exported);
      flash($("save"));
      say(`Saved ${r.files.length > 1 ? `${r.files.length} parts` : r.files[0].split("/").pop()} in Downloads${madeNote(exported)}`);
    } catch (err) { say(`Couldn't save: ${err.message}`, true); }
  };

  // Copy image (the first part of a very long page) as a PNG (the clipboard takes PNG only), at
  // the size picked below.
  $("copy").onclick = async () => {
    try {
      const exported = editor.exportItems({ format: "png", scale: out.scale });
      const png = (async () => {
        const blob = await (await fetch((await exported)[0].dataUrl)).blob();
        if (blob.type === "image/png") return blob;
        const bmp = await createImageBitmap(blob);
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        c.getContext("2d").drawImage(bmp, 0, 0);
        return c.convertToBlob({ type: "image/png" });
      })();
      await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
      await leaving(await exported);
      flash($("copy"));
      say(`Image copied${items.length > 1 ? ` (part 1 of ${items.length})` : ""}`);
    } catch (err) { say(`Couldn't copy the image: ${err.message}`, true); }
  };

  // ☁ Upload: the host picked in settings, or a picker when both are offered.
  const cloud = $("cloud");
  const { upload } = await TT.getSettings();
  const choices = TT.uploadChoices(upload);
  if (!choices.length) {
    cloud.setAttribute("aria-disabled", "true");
    cloud.title = "Turn on imglink or X02 in settings → image upload to upload";
  } else {
    cloud.title = choices.length === 1 ? `Upload to ${TT.hostName(choices[0])}` : "Upload to…";
  }
  let uploading = false;
  async function uploadTo(host) {
    document.querySelector(".pick")?.remove();
    if (uploading) return;
    uploading = true;
    const icon = cloud.innerHTML;
    cloud.innerHTML = '<i class="spin"></i>';
    say(`Uploading to ${host}…`);
    try {
      const exported = await editor.exportItems(opts());
      const r = await send("shotUpload", { items: exported, host, source: res.source });
      await leaving(exported);
      // The background copies the link too; copy here as well in case that couldn't.
      let copied = r.copied;
      try { await navigator.clipboard.writeText(r.links.join("\n")); copied = true; } catch {}
      const st = $("status");
      st.classList.remove("bad");
      st.textContent = `${copied ? "Link copied" : "Uploaded"} · ${host} · `;
      const a = Object.assign(document.createElement("a"), { href: r.links[0], target: "_blank", rel: "noopener noreferrer", textContent: r.links[0].replace(/^https?:\/\//, "") });
      st.append(a);
      if (r.links.length > 1) st.append(` +${r.links.length - 1} more`);
      st.title = r.links.join("\n");
    } catch (err) {
      say(`Upload failed: ${err.message}`, true);
    } finally {
      cloud.innerHTML = icon;
      uploading = false;
    }
  }
  cloud.onclick = () => {
    if (!choices.length || uploading) return;
    if (choices.length === 1) return uploadTo(choices[0]);
    if (document.querySelector(".pick")) return document.querySelector(".pick").remove();
    const pick = document.createElement("div");
    pick.className = "pick";
    for (const h of choices) {
      const b = document.createElement("button");
      b.textContent = TT.hostName(h);
      b.title = `Upload to ${TT.hostName(h)}`;
      b.onclick = () => uploadTo(h);
      pick.append(b);
    }
    document.querySelector(".btns").append(pick);
  };

  // ---- Blur: the image with one more box drawn in, in the privacy blur style ----
  // In the same format it came in (JPEG keeps its quality). k = image pixels per screen pixel.
  async function drawBlur(img, { x, y, w, h }, k) {
    const c = new OffscreenCanvas(img.naturalWidth, img.naturalHeight);
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const px = Math.max(1, k * devicePixelRatio); // the style's px are screen pixels
    if (style.style === "bars") {
      ctx.fillStyle = style.barColor;
      ctx.fillRect(x, y, w, h);
    } else if (style.style === "mask") {
      ctx.fillStyle = "#d9d9d9";
      ctx.fillRect(x, y, w, h);
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
      const size = Math.max(10, Math.min(h * 0.8, 16 * px));
      ctx.font = `${size}px system-ui, sans-serif`;
      ctx.fillStyle = "#6b6b6b";
      ctx.textBaseline = "middle";
      const step = ctx.measureText(style.maskChar || "×").width || size;
      for (let ty = y + size / 2; ty < y + h + size; ty += size * 1.15) {
        for (let tx = x; tx < x + w; tx += step) ctx.fillText(style.maskChar || "×", tx, ty);
      }
      ctx.restore();
    } else {
      // Only the box (plus a margin, so its edges blur from real pixels) is redrawn.
      const radius = Math.max(6, style.blurPx * px * 1.5); // stronger than on a page: nothing readable left
      const pad = Math.ceil(radius * 3);
      const sx = Math.max(0, x - pad), sy = Math.max(0, y - pad);
      const sw = Math.min(img.naturalWidth, x + w + pad) - sx, sh = Math.min(img.naturalHeight, y + h + pad) - sy;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
      ctx.filter = `blur(${radius}px)`;
      ctx.drawImage(img, sx, sy, sw, sh, sx, sy, sw, sh);
      ctx.restore();
    }
    // In the picture's own format now (a picture cut out of its background is a PNG, and stays one).
    const type = img.src.startsWith("data:image/jpeg") ? "image/jpeg" : "image/png";
    const { shot } = await TT.getSettings();
    const blob = await c.convertToBlob({ type, quality: (shot?.quality ?? 92) / 100 });
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(blob);
    });
  }
})();
