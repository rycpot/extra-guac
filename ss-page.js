// Session Switch, on pages of sites that have profiles. It keeps the active profile's copy of the
// page's localStorage current by sending it when the page is hidden or closed, and reloads a page brought
// back from the back/forward cache if the site switched profiles since the page was loaded.
(() => {
  if (self.__sessionSwitchPage) return;
  self.__sessionSwitchPage = true;

  // Nothing to say once an extension reload or update has cut this copy of the script off (the page
  // gets the new one when it loads again).
  const ask = async (message) => (chrome.runtime?.id ? chrome.runtime.sendMessage(message).catch(() => null) : null);
  const ancestors = [...(location.ancestorOrigins || [])];
  let epoch = null;
  let held = false;
  let last = null;

  async function hello(restored) {
    const reply = await ask({ type: "ss:page-hello", ancestors, top: self === top });
    if (!reply?.track) return;
    if (restored && epoch !== null && reply.epoch !== epoch) {
      location.reload();
      return;
    }
    epoch = reply.epoch;
    held = reply.held;
  }

  function report() {
    if (epoch === null || held) return;
    let local;
    try {
      local = {};
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        local[key] = localStorage.getItem(key);
      }
    } catch {
      return;
    }
    const json = JSON.stringify(local);
    if (json === last) return;
    last = json;
    ask({ type: "ss:page-storage", epoch, ancestors, local });
  }

  hello(false);
  addEventListener("pagehide", report);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") report();
  });
  addEventListener("pageshow", (event) => {
    if (event.persisted) hello(true);
  });
})();
