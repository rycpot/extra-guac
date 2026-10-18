// Settings → session switch: WebRTC on sites that go through a profile's proxy, and encrypted
// backups of every profile (a key is derived from the passphrase with PBKDF2 and the data is sealed
// with AES-GCM; restoring hands the opened backup to the background, bg-sessions.js, to add).
(() => {
  const $ = (id) => document.getElementById(id);
  const encoder = new TextEncoder();
  const ITERATIONS = 600000;

  async function call(type, data = {}) {
    const reply = await chrome.runtime.sendMessage({ type: `ss:${type}`, ...data });
    if (reply?.error) throw new Error(reply.error);
    return reply;
  }

  function say(text, bad = false) {
    $("ssStatus").classList.toggle("bad", bad);
    $("ssStatus").textContent = text;
  }

  // ---- WebRTC ----

  call("proxy-info").then((info) => ($("ssWebrtc").checked = info.webrtc), (err) => say(err.message, true));
  $("ssWebrtc").addEventListener("change", (e) => {
    call("webrtc", { on: e.target.checked }).catch((err) => say(err.message, true));
  });

  // ---- Backups ----

  const toBase64 = (bytes) => {
    let text = "";
    for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(text);
  };
  const fromBase64 = (text) => Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0));

  async function keyFor(passphrase, salt, iterations) {
    const base = await crypto.subtle.importKey("raw", encoder.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }

  async function seal(passphrase) {
    const { ssGroups = {} } = await chrome.storage.local.get("ssGroups");
    const ids = Object.values(ssGroups).flatMap((g) => g.order || []);
    const saved = await chrome.storage.local.get(ids.flatMap((id) => [`ssProfile:${id}`, `ssData:${id}`]));
    const payload = { groups: ssGroups, profiles: {}, data: {} };
    for (const id of ids) {
      if (saved[`ssProfile:${id}`]) payload.profiles[id] = saved[`ssProfile:${id}`];
      if (saved[`ssData:${id}`]) payload.data[id] = saved[`ssData:${id}`];
    }
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await keyFor(passphrase, salt, ITERATIONS);
    const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(JSON.stringify(payload))));
    return {
      file: {
        format: "session-switch-backup", version: 1, created: new Date().toISOString(),
        kdf: { name: "PBKDF2", hash: "SHA-256", iterations: ITERATIONS, salt: toBase64(salt) },
        cipher: { name: "AES-GCM", iv: toBase64(iv) },
        data: toBase64(sealed),
      },
      count: Object.keys(payload.profiles).length,
    };
  }

  async function open(file, passphrase) {
    let box;
    try {
      box = JSON.parse(await file.text());
    } catch {
      box = null;
    }
    if (box?.format !== "session-switch-backup" || box.version !== 1) throw new Error("This file isn't a Session Switch backup.");
    const iterations = Number(box.kdf?.iterations);
    if (!(iterations >= 100000 && iterations <= 5000000)) throw new Error("This backup uses settings that are not supported.");
    const key = await keyFor(passphrase, fromBase64(box.kdf.salt), iterations);
    try {
      const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(box.cipher.iv) }, key, fromBase64(box.data));
      return JSON.parse(new TextDecoder().decode(plain));
    } catch {
      throw new Error("The passphrase is wrong, or the file is damaged.");
    }
  }

  $("ssExport").addEventListener("submit", async (e) => {
    e.preventDefault();
    if ($("ssPass1").value !== $("ssPass2").value) return say("The passphrases don't match.", true);
    say("Encrypting…");
    try {
      const { file, count } = await seal($("ssPass1").value);
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
      const payload = await open($("ssFile").files[0], $("ssPass").value);
      const result = await call("import", { payload });
      e.target.reset();
      say(`Added ${result.added} profile${result.added === 1 ? "" : "s"}.${result.skipped ? ` ${result.skipped} were already here.` : ""}`);
    } catch (err) {
      say(err.message, true);
    }
  });
})();
