// Color, element and font pickers: injected into the active tab from the popup.
// What they copy is kept, newest first, in colorHistory / selectorHistory / fontHistory
// ({ value, at }, plus format for selectors), up to PICK_LIMIT each.

const PICK_LIMIT = 20;
const PICK_KEYS = { color: "colorHistory", selector: "selectorHistory", font: "fontHistory" };

// Picking the same value again moves it to the top instead of repeating it.
async function rememberPick(key, entry) {
  const { [key]: list = [] } = await chrome.storage.local.get(key);
  const next = [{ ...entry, at: Date.now() }, ...list.filter((e) => e.value !== entry.value)].slice(0, PICK_LIMIT);
  await chrome.storage.local.set({ [key]: next });
}

// Before 2.10 only the last pick was kept (lastColor / lastSelector / lastFont). Its
// time is unknown, so it starts the history as already old (its row stays hidden).
chrome.runtime.onInstalled.addListener(() => migrateLastPicks());

async function migrateLastPicks() {
  const old = await chrome.storage.local.get(["lastColor", "lastSelector", "lastFont", ...Object.values(PICK_KEYS)]);
  const seed = {
    colorHistory: old.lastColor && { value: old.lastColor },
    selectorHistory: old.lastSelector?.value && old.lastSelector,
    fontHistory: old.lastFont && { value: old.lastFont },
  };
  const set = {};
  for (const [key, entry] of Object.entries(seed)) if (entry && !old[key]?.length) set[key] = [{ ...entry, at: 0 }];
  await chrome.storage.local.set(set);
  await chrome.storage.local.remove(["lastColor", "lastSelector", "lastFont"]);
}

const pickerHandlers = {
  pickColor: async ({ tabId }) => {
    const tab = await chrome.tabs.get(tabId);
    const dataUrl = await grab(tab.windowId); // frozen frame the color is read from
    await chrome.scripting.executeScript({ target: { tabId }, files: ["page-helpers.js", "picker-color.js"] });
    await chrome.scripting.executeScript({ target: { tabId }, func: (url) => window.__ttColorPicker(url), args: [dataUrl] });
  },
  pickElement: async ({ tabId }) => {
    const { picker } = await TT.getSettings();
    await chrome.scripting.executeScript({ target: { tabId }, files: ["vendor/css-selector-generator.js", "page-helpers.js", "picker-element.js"] });
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (format) => window.__ttElementPicker(format),
      args: [picker.selectorFormat],
    });
  },
  pickFont: async ({ tabId }) => {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["page-helpers.js", "picker-font.js"] });
    await chrome.scripting.executeScript({ target: { tabId }, func: () => window.__ttFontPicker() });
  },
  // From picker-font.js: find and read the font file behind a CSS family.
  fontInspect: async (request) => ({ info: (await toOffscreen({ ...request, type: "inspectFont" })).result }),
  pickedFont: ({ value }) => rememberPick(PICK_KEYS.font, { value }),
  // Popup "go" in the auto-redirect row: every enabled rule (auto and manual) on this tab.
  redirectNow: async ({ tabId }) => {
    const changed = await runManualRedirect(await chrome.tabs.get(tabId));
    if (!changed) throw new Error("No redirect rule matches this page");
  },
  // Sent by the pickers after copying, so the popup can show the last value.
  pickedColor: ({ value }) => rememberPick(PICK_KEYS.color, { value }),
  pickedSelector: ({ value, format }) => rememberPick(PICK_KEYS.selector, { value, format }),
  clearColorHistory: () => chrome.storage.local.set({ colorHistory: [] }),
  clearSelectorHistory: () => chrome.storage.local.set({ selectorHistory: [] }),
  clearFontHistory: () => chrome.storage.local.set({ fontHistory: [] }),
};
