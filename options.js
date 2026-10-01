const R = PIIRules;
const $ = (id) => document.getElementById(id);
let settings;
let saveTimer = 0;

init();

async function init() {
  const { pii } = await chrome.storage.local.get("pii");
  settings = R.withDefaults(pii);

  const grid = $("detectors");
  for (const [key, d] of Object.entries(R.DETECTORS)) {
    const label = document.createElement("label");
    label.innerHTML = `<input type="checkbox" data-detector="${key}"> ${d.label}<small></small>`;
    label.querySelector("small").textContent = d.example;
    grid.append(label);
  }

  render();
  document.body.addEventListener("input", onInput);
  for (const input of document.querySelectorAll("[data-chips]")) {
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") addChips(input.dataset.chips); });
    input.addEventListener("paste", (e) => {
      const text = e.clipboardData.getData("text");
      if (!text.includes("\n")) return;
      e.preventDefault();
      addChips(input.dataset.chips, text);
    });
  }
  document.querySelectorAll("[data-add]").forEach((b) => b.addEventListener("click", () => addChips(b.dataset.add)));
  chrome.storage.onChanged.addListener((changes, area) => {
    // Reflect changes made elsewhere (e.g. the right-click checkbox).
    if (area === "local" && changes.pii && !saveTimer) {
      settings = R.withDefaults(changes.pii.newValue);
      render();
    }
  });
}

function render() {
  $("enabled").checked = settings.enabled;
  document.querySelector(`input[name=style][value=${settings.style}]`).checked = true;
  $("blurPx").value = settings.blurPx;
  $("barColor").value = settings.barColor;
  $("maskChar").value = settings.maskChar;
  $("hideUntilScanned").checked = settings.hideUntilScanned;
  document.querySelectorAll("[data-detector]").forEach((el) => (el.checked = settings.detectors[el.dataset.detector]));
  for (const key of Object.keys(CHIPS)) renderChips(key);
  update();
}

function onInput(e) {
  const t = e.target;
  if (t.dataset.chips) return checkPending(t.dataset.chips);
  if (t.dataset.detector) settings.detectors[t.dataset.detector] = t.checked;
  else if (t.name === "style") settings.style = t.value;
  else if (t.id === "blurPx") settings.blurPx = +t.value;
  else if (t.type === "checkbox") settings[t.id] = t.checked;
  else if (t.id in settings) settings[t.id] = t.value;
  update();
  if (t.id !== "sample") save();
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await chrome.storage.local.set({ pii: settings });
    saveTimer = 0;
    $("saved").textContent = settings.enabled
      ? "Saved — open tabs updated."
      : "Saved. Blurring is off — turn it on to see it on pages.";
  }, 200);
}

function update() {
  $("blurPxOut").textContent = `${settings.blurPx}px`;
  renderPreview();
}

// ---- Chips (custom rules and excluded sites) --------------------------------
// Stored as one entry per line; a rule starting with "#" is switched off.

const CHIPS = {
  rules: { list: "ruleChips", input: "ruleInput", errors: "ruleErrors", toggle: true,
    error: (line) => R.parseRules(line).errors[0]?.message },
  excludedSites: { list: "siteChips", input: "siteInput", errors: "siteErrors", toggle: false,
    error: (line) => R.parseSites(line).errors[0]?.message },
};

const linesOf = (key) => settings[key].split("\n").map((l) => l.trim()).filter(Boolean);
const isOff = (line) => line.startsWith("#");
const bare = (line) => line.replace(/^#\s*/, "");

function setLines(key, lines) {
  settings[key] = lines.join("\n");
  renderChips(key);
  update();
  save();
}

function renderChips(key) {
  const cfg = CHIPS[key];
  $(cfg.list).replaceChildren(...linesOf(key).map((line, i) => {
    const chip = document.createElement("span");
    const off = cfg.toggle && isOff(line);
    const err = off ? null : cfg.error(line);
    chip.className = "chip" + (off ? " off" : "") + (err ? " bad" : "");
    chip.title = err ? `${bare(line)}\n${err}` : bare(line);
    if (cfg.toggle) {
      const t = button("chip-toggle", off ? "○" : "●", off ? "Turn on" : "Turn off");
      t.onclick = () => setLines(key, linesOf(key).map((l, j) => (j !== i ? l : off ? bare(l) : `# ${l}`)));
      chip.append(t);
    }
    const text = button("chip-text", bare(line), "Edit");
    text.onclick = () => {
      $(cfg.input).value = bare(line);
      $(cfg.input).focus();
      setLines(key, linesOf(key).filter((_, j) => j !== i));
      checkPending(key);
    };
    const x = button("chip-x", "×", "Remove");
    x.onclick = () => setLines(key, linesOf(key).filter((_, j) => j !== i));
    chip.append(text, x);
    return chip;
  }));
}

function button(cls, text, label) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.textContent = text;
  b.setAttribute("aria-label", label);
  return b;
}

// Adds the input's text (or pasted lines); anything invalid stays in the input.
function addChips(key, text) {
  const cfg = CHIPS[key];
  const input = $(cfg.input);
  const entries = (text ?? input.value).split("\n").map((l) => l.trim()).filter(Boolean);
  const lines = linesOf(key), rejected = [];
  for (const entry of entries) {
    if (cfg.error(bare(entry))) rejected.push(entry);
    else if (!lines.includes(entry)) lines.push(entry);
  }
  input.value = rejected.join(" ");
  setLines(key, lines);
  checkPending(key);
}

function checkPending(key) {
  const cfg = CHIPS[key];
  const value = $(cfg.input).value.trim();
  const err = value && cfg.error(bare(value));
  showErrors($(cfg.errors), err ? [{ message: err }] : []);
  if (key === "rules") renderPreview();
}

function showErrors(list, errors) {
  list.replaceChildren(...errors.map(({ line, message }) => {
    const li = document.createElement("li");
    li.textContent = line ? `Line ${line}: ${message}` : message;
    return li;
  }));
}

// Each line of the sample counts as one line of a page.
function renderPreview() {
  // Include the rule being typed so it can be tried before adding it.
  const pending = $("ruleInput").value.trim();
  const rules = pending && !CHIPS.rules.error(pending) ? `${settings.rules}\n${pending}` : settings.rules;
  const compiled = R.compile({ ...settings, rules });
  const mask = settings.style === "mask";
  const style = mask ? "" : settings.style === "bars"
    ? `color:${settings.barColor};background:${settings.barColor}`
    : `color:transparent;text-shadow:0 0 ${settings.blurPx}px rgba(128,128,128,.95)`;
  const out = $("preview");
  out.replaceChildren();
  $("sample").value.split("\n").forEach((line, i) => {
    if (i) out.append("\n");
    let pos = 0;
    for (const [s, e] of R.findMatches(line, compiled)) {
      out.append(line.slice(pos, s));
      const span = document.createElement("span");
      span.style.cssText = style;
      span.textContent = mask ? line.slice(s, e).replace(/\S/g, settings.maskChar) : line.slice(s, e);
      span.title = line.slice(s, e);
      out.append(span);
      pos = e;
    }
    out.append(line.slice(pos));
  });
}
