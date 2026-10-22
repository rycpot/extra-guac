// Settings → session switch: linked sites, and encrypted
// backups of every profile (a key is derived from the passphrase with PBKDF2 and the data is sealed
// with AES-GCM; restoring hands the opened backup to the background, bg-sessions.js, to add).
(() => {
  const $ = (id) => document.getElementById(id);

  async function call(type, data = {}) {
    const reply = await chrome.runtime.sendMessage({ type: `ss:${type}`, ...data });
    if (reply?.error) throw new Error(reply.error);
    return reply;
  }

  // A message under the section it's about.
  function say(text, bad = false, where = "ssStatus") {
    $(where).classList.toggle("bad", bad);
    $(where).textContent = text;
  }
  const saySites = (text, bad = false) => say(text, bad, "ssSitesStatus");

  // ---- Sites and their linked sites ----

  async function sites() {
    let list;
    try {
      ({ sites: list } = await call("sites"));
    } catch (err) {
      return saySites(err.message, true);
    }
    const box = $("ssSites");
    if (!list.length) {
      box.innerHTML = `<p class="rm-empty">No profiles yet: start one in the popup's session switch section.</p>`;
      return;
    }
    const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
    box.replaceChildren(...list.map((site) => {
      const pills = el("div", { className: "rm-pills wrap" });
      for (const domain of site.domains.slice(1)) {
        const x = el("button", { type: "button", className: "chip-x", textContent: "×" });
        x.setAttribute("aria-label", `Unlink ${domain}`);
        x.onclick = () => call("unlink", { groupId: site.id, domain }).catch((err) => saySites(err.message, true));
        pills.append(el("span", { className: "chip" }, el("span", { className: "chip-text", textContent: domain }), x));
      }
      const input = el("input", { type: "text", className: "text", placeholder: "link a site, e.g. atlassian.com", spellcheck: false });
      const link = async () => {
        if (!input.value.trim()) return input.focus();
        try {
          const r = await call("link", { groupId: site.id, domain: input.value });
          saySites(`Linked ${r.site} to ${site.domains[0]}.`);
        } catch (err) {
          saySites(err.message, true);
        }
      };
      const add = el("button", { type: "button", className: "btn", textContent: "Link" });
      add.onclick = link;
      input.addEventListener("keydown", (e) => e.key === "Enter" && link());
      return el("div", { className: "ss-site" },
        el("h3", {}, site.domains[0], el("span", { className: "hint", textContent: ` ${site.profiles.length} profile${site.profiles.length === 1 ? "" : "s"}: ${site.profiles.join(", ")}` })),
        pills,
        el("div", { className: "add-row" }, input, add));
    }));
  }
  sites();
  // Sites and profiles coming and going change ssGroups (a profile's own record changes every time
  // its cookies are saved), and ssProxySites follows names. Not while a site is being typed in:
  // then once that box is left.
  let later = false;
  const typing = () => $("ssSites").contains(document.activeElement) && document.activeElement.value;
  chrome.storage.onChanged.addListener((c, area) => {
    if (area !== "local" || !(c.ssGroups || c.ssProxySites)) return;
    if (typing()) later = true;
    else sites();
  });
  $("ssSites").addEventListener("focusout", () => setTimeout(() => later && !typing() && ((later = false), sites())));

  const added = (r) => `Added ${r.added} profile${r.added === 1 ? "" : "s"}.${r.skipped ? ` ${r.skipped} were already here.` : ""}${r.noRoom ? ` ${r.noRoom} came without their proxy: all the plan's proxy sites are in use.` : ""}`;

  // ---- Backup file (sealed and opened by bg-sessions.js) ----

  $("ssExport").addEventListener("submit", async (e) => {
    e.preventDefault();
    if ($("ssPass1").value !== $("ssPass2").value) return say("The passphrases don't match.", true);
    say("Encrypting…");
    try {
      const { file, count } = await call("file-seal", { passphrase: $("ssPass1").value });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(new Blob([JSON.stringify(file)], { type: "application/json" }));
      link.download = `session-switch-backup-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 10000);
      e.target.reset();
      say(`Backup of ${count} profile${count === 1 ? "" : "s"} downloaded.`);
    } catch (err) {
      say(err.message, true);
    }
  });

  // The file can be dropped on its box as well as chosen; the box says which one it holds.
  const drop = $("ssDrop");
  const picked = () => {
    const file = $("ssFile").files[0];
    drop.classList.toggle("picked", !!file);
    if (file) $("ssDropText").textContent = file.name;
    else $("ssDropText").innerHTML = "Drop the backup file here, or <u>choose a file</u>";
  };
  $("ssFile").addEventListener("change", picked);
  drop.addEventListener("dragover", (e) => {
    if (![...e.dataTransfer.types].includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    drop.classList.add("over");
  });
  drop.addEventListener("dragleave", (e) => !drop.contains(e.relatedTarget) && drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("over");
    const file = e.dataTransfer.files[0];
    if (!file) return;
    const one = new DataTransfer();
    one.items.add(file);
    $("ssFile").files = one.files;
    picked();
  });

  $("ssImport").addEventListener("submit", async (e) => {
    e.preventDefault();
    say("Opening the backup…");
    try {
      const result = await call("file-open", { text: await $("ssFile").files[0].text(), passphrase: $("ssPass").value });
      e.target.reset();
      picked();
      say(added(result));
    } catch (err) {
      say(err.message, true);
    }
  });

  // ---- Profiles only, from a Drive or Dropbox snapshot (bg-backup.js) ----

  const sayDrive = (text, bad = false) => say(text, bad, "ssSnapStatus");
  async function snaps() {
    const sel = $("ssSnap");
    const { backupState: st = {}, dropboxState: db = {}, backupDevice } = await chrome.storage.local.get(["backupState", "dropboxState", "backupDevice"]);
    $("ssSnapRestore").disabled = true;
    const live = [st, db].filter((x) => x.connected && !x.needsSignIn).length;
    if (!live) return void (sel.innerHTML = `<option value="">connect Google Drive or Dropbox in backup first</option>`);
    try {
      const reply = await chrome.runtime.sendMessage({ type: "backupList" });
      if (!reply?.ok) throw new Error(reply?.error || "Something went wrong");
      // Only the snapshots that say they hold profiles (older ones don't say).
      const list = reply.snapshots.filter((snap) => snap.profiles);
      sel.replaceChildren(...list.map((snap) => {
        const o = document.createElement("option");
        o.value = snap.id;
        o.dataset.copies = JSON.stringify(snap.copies);
        const where = snap.kind === "pre-restore" ? "before a restore" : backupDevice && snap.device === backupDevice ? "this browser" : snap.device ? "another browser" : "";
        const cloud = live > 1 ? snap.clouds.map(TT.cloudShort).join(" · ") : "";
        o.textContent = [TT.when(snap.at), cloud, where, `${snap.profiles} profile${snap.profiles === 1 ? "" : "s"}`].filter(Boolean).join(" · ");
        return o;
      }));
      if (!list.length) sel.innerHTML = `<option value="">no snapshots with profiles yet</option>`;
      $("ssSnapRestore").disabled = !list.length;
    } catch (err) {
      sel.innerHTML = `<option value=""></option>`;
      sel.firstChild.textContent = `couldn't list snapshots: ${err.message}`;
    }
  }
  $("ssSnapRestore").addEventListener("click", async () => {
    const opt = $("ssSnap").selectedOptions[0];
    if (!opt?.value) return;
    $("ssSnapRestore").disabled = true;
    sayDrive("Adding the profiles…");
    try {
      const reply = await chrome.runtime.sendMessage({ type: "backupRestore", copies: JSON.parse(opt.dataset.copies), what: "profiles" });
      if (!reply?.ok) throw new Error(reply?.error || "Something went wrong");
      sayDrive(reply.locked
        ? `This snapshot's ${reply.locked} profile${reply.locked === 1 ? " was" : "s were"} locked with a passphrase by an older version, so nothing was added. Pick a newer snapshot.`
        : added(reply), !!reply.locked);
    } catch (err) {
      sayDrive(err.message, true);
    }
    $("ssSnapRestore").disabled = false;
  });
  // Listed when the section is first opened, and again when a cloud is connected or signed in.
  let listed = false;
  const listOnce = () => !listed && location.hash === "#sessions" && ((listed = true), snaps());
  listOnce();
  addEventListener("hashchange", listOnce);
  chrome.storage.onChanged.addListener((c, area) => {
    if (area !== "local") return;
    const flipped = TT.BACKUP_CLOUDS.some(({ key }) => {
      const was = c[key]?.oldValue || {}, now = c[key]?.newValue || {};
      return c[key] && (!!was.connected !== !!now.connected || !!was.needsSignIn !== !!now.needsSignIn || was.lastSnapshot !== now.lastSnapshot);
    });
    if (flipped) {
      listed = false;
      listOnce();
    }
  });
})();
