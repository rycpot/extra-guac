// Color and element pickers: injected into the active tab from the popup.

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
  pickedFont: ({ value }) => chrome.storage.local.set({ lastFont: value }),
  // Popup "go" in the auto-redirect row: every enabled rule (auto and manual) on this tab.
  redirectNow: async ({ tabId }) => {
    const changed = await runManualRedirect(await chrome.tabs.get(tabId));
    if (!changed) throw new Error("No redirect rule matches this page");
  },
  // Sent by the pickers after copying, so the popup can show the last value.
  pickedColor: ({ value }) => chrome.storage.local.set({ lastColor: value }),
  pickedSelector: ({ value, format }) => chrome.storage.local.set({ lastSelector: { value, format } }),
};
