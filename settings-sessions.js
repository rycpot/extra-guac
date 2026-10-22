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

  $("ssImport").addEventListener("submit", async (e) => {
    e.preventDefault();
    say("Opening the backup…");
    try {
      const result = await call("file-open", { text: await $("ssFile").files[0].text(), passphrase: $("ssPass").value });
      e.target.reset();
      say(added(result));
    } catch (err) {
      say(err.message, true);
    }
  });
})();
