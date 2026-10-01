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
  if (document.activeElement !== $("rules")) $("rules").value = settings.rules;
  if (document.activeElement !== $("excludedSites")) $("excludedSites").value = settings.excludedSites;
  update();
}

function onInput(e) {
  const t = e.target;
  if (t.dataset.detector) settings.detectors[t.dataset.detector] = t.checked;
  else if (t.name === "style") settings.style = t.value;
  else if (t.id === "blurPx") settings.blurPx = +t.value;
  else if (t.type === "checkbox") settings[t.id] = t.checked;
  else if (t.id in settings) settings[t.id] = t.value;
  update();
  if (t.id === "sample") return;
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
  showErrors($("ruleErrors"), R.parseRules(settings.rules).errors);
  showErrors($("siteErrors"), R.parseSites(settings.excludedSites).errors);
  renderPreview();
}

function showErrors(list, errors) {
  list.replaceChildren(...errors.map(({ line, message }) => {
    const li = document.createElement("li");
    li.textContent = `Line ${line}: ${message}`;
    return li;
  }));
}

// Each line of the sample counts as one line of a page.
function renderPreview() {
  const compiled = R.compile(settings);
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
