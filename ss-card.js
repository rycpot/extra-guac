// Session Switch card: at the bottom-right of a site's page, injected by bg-sessions.js when the
// site's login was changed outside Session Switch. It asks what the popup asks (save the login in
// the browser as a new profile, update the profile with it, or put the profile's back), once per
// change, and stays until one is picked or it's closed (the question then waits in the popup).
// Picking one anywhere else closes it too ("ss:card-close"). In a closed shadow root, so the page
// can't read it or press its buttons.
(() => {
  if (window.__egSessionCard) return;
  window.__egSessionCard = true;

  let host = null, root = null, closeTimer = 0;
  let picking = false; // a choice made here: its outcome shows before the card goes

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (!chrome.runtime?.id) return;
    if (msg?.type === "ss:card") {
      reply(true);
      show(msg);
    } else if (msg?.type === "ss:card-close") {
      reply(true);
      if (!picking) close();
    }
  });

  function show({ site, name }) {
    if (!host) {
      host = document.createElement("div");
      host.dataset.egSessionCard = "";
      host.style.cssText = "all:initial;position:fixed;z-index:2147483647;right:16px;bottom:16px;";
      root = host.attachShadow({ mode: "closed" });
      root.innerHTML = `
        <style>
          .card { display: grid; gap: 8px; width: min(360px, calc(100vw - 32px)); padding: 10px 10px 8px 12px; box-sizing: border-box;
            border-radius: 12px; background: rgb(22,22,22); color: #fff; font: 500 11.5px/1.35 system-ui, sans-serif;
            box-shadow: 0 8px 28px rgba(0,0,0,.45);
            outline: 1px solid rgba(255,255,255,.28); outline-offset: -1px; } /* the edge keeps it visible on dark pages */
          .top { display: flex; align-items: flex-start; gap: 8px; }
          .text { flex: 1; min-width: 0; display: grid; gap: 2px; }
          .sub { color: rgba(255,255,255,.6); font-weight: 400; font-size: 10.5px; }
          .btns { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 2px; }
          button { all: unset; height: 26px; min-width: 26px; display: grid; place-items: center; border-radius: 8px; cursor: pointer; }
          button.t { padding: 0 8px; font-size: 11px; }
          button.t.main { background: rgba(255,255,255,.12); }
          button:hover { background: rgba(255,255,255,.12); }
          button.t.main:hover { background: rgba(255,255,255,.2); }
          button[disabled] { opacity: .4; cursor: default; background: none; }
          svg { width: 11px; height: 11px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; }
          .spin { width: 13px; height: 13px; margin: 0 6px; border-radius: 50%; border: 2px solid rgba(255,255,255,.25);
            border-top-color: #fff; animation: spin .8s linear infinite; }
          @keyframes spin { to { transform: rotate(360deg); } }
        </style>
        <div class="card" role="dialog" aria-label="Session Switch">
          <div class="top">
            <div class="text"><div class="main"></div><div class="sub"></div></div>
            <button class="x" title="Close (the question stays in the popup)"><svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7 7 17"/></svg></button>
          </div>
          <div class="btns"></div>
        </div>`;
      root.querySelector(".x").onclick = (e) => e.isTrusted && close();
    }
    clearTimeout(closeTimer);
    root.querySelector(".main").textContent = `The login on ${site} was changed outside Session Switch`;
    root.querySelector(".sub").textContent = `${name} kept its own login. What should happen to the one now in the browser?`;
    const btns = root.querySelector(".btns");
    btns.replaceChildren();
    const button = (label, title, choice, main = false) => {
      const b = document.createElement("button");
      b.className = main ? "t main" : "t";
      b.textContent = label;
      b.title = title;
      b.onclick = (e) => e.isTrusted && pick(choice, name);
      btns.append(b);
    };
    button("save as new profile", "Keep this login as a profile of its own", "save", true);
    button(`update ${name}`, `Replace ${name}'s saved login with this one`, "update");
    button(`put ${name} back`, `Discard this login and put ${name}'s back`, "back");
    document.documentElement.append(host);
  }

  async function pick(choice, name) {
    picking = true;
    const btns = root.querySelector(".btns");
    for (const b of btns.querySelectorAll("button")) b.disabled = true;
    btns.insertAdjacentHTML("beforeend", '<i class="spin"></i>');
    let reply;
    try {
      reply = await chrome.runtime.sendMessage({ type: "ss:card-choice", choice });
    } catch {
      return; // the page went away (putting the profile back reloads it)
    }
    btns.querySelector(".spin")?.remove();
    const main = root.querySelector(".main"), sub = root.querySelector(".sub");
    if (reply?.error) {
      main.textContent = reply.error;
      sub.textContent = "Open the popup to see where things stand.";
      btns.replaceChildren();
      picking = false;
      return;
    }
    main.textContent = choice === "save" ? `Saved as ${reply.name}` : choice === "update" ? `${name} has this login now` : `${name} is back`;
    sub.textContent = choice === "back" ? "" : "It stays up to date as you use the site.";
    btns.replaceChildren();
    picking = false;
    closeTimer = setTimeout(close, 2500);
  }

  function close() {
    clearTimeout(closeTimer);
    host?.remove();
  }
})();
