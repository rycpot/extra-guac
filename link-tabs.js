// Open in new tab (bg-newtab.js), on the sites in the list only: a plain click on a link to
// another site opens it in a new tab. Links within the site, Ctrl/⌘/Shift/middle-clicks,
// links that already open elsewhere (target), downloads, and clicks the page handles itself
// (it canceled them) are left as they are. It follows the list as it changes, so switching
// a site off takes effect without a reload.
(() => {
  if (window.__egNewTab) return;
  window.__egNewTab = true;
  const host = location.hostname.toLowerCase().replace(/^www\./, "");
  const covers = (h, s) => h === s || h.endsWith(`.${s}`);
  let entry = ""; // the list entry covering this page, or "" when it's not in the list
  let also = [], split = []; // the user's own: domains counting as this site; one site per subdomain
  const load = (tt) => {
    const nt = tt?.newTab || {};
    entry = (nt.sites || []).find((s) => covers(host, s)) || "";
    also = (Array.isArray(nt.also) ? nt.also : []).find((a) => a?.site === entry)?.hosts || [];
    split = Array.isArray(nt.split) ? nt.split : [];
  };
  chrome.storage.local.get("tt").then(({ tt }) => load(tt), () => {});
  chrome.storage.onChanged.addListener((c, area) => area === "local" && c.tt && load(c.tt.newValue));

  // The site a host belongs to, roughly: its last two labels, or three for the likes of
  // example.co.uk. On hosting services that give everyone their own subdomain (the common
  // ones below, from the Public Suffix List's private section), the subdomain is the site:
  // alice.github.io and bob.github.io are two sites. Settings can add more (newTab.split).
  const SHARED = ["github.io", "gitlab.io", "blogspot.com", "wordpress.com", "tumblr.com", "substack.com", "medium.com",
    "vercel.app", "netlify.app", "pages.dev", "workers.dev", "herokuapp.com", "web.app", "firebaseapp.com", "appspot.com",
    "glitch.me", "onrender.com", "fly.dev", "azurewebsites.net", "cloudfront.net", "neocities.org", "itch.io", "carrd.co",
    "wixsite.com", "weebly.com", "notion.site", "replit.app", "repl.co", "surge.sh", "readthedocs.io", "gitbook.io",
    "bitbucket.io", "translate.goog", "s3.amazonaws.com", "codeberg.page", "deno.dev", "railway.app", "webflow.io",
    "framer.website", "super.site", "myshopify.com", "square.site", "mystrikingly.com", "jimdosite.com", "ghost.io"];
  const base = (h) => {
    const shared = [...split, ...SHARED].find((s) => h === s || h.endsWith(`.${s}`));
    const l = h.split(".");
    const n = shared ? shared.split(".").length + 1
      : l.length > 2 && l[l.length - 1].length === 2 && l[l.length - 2].length <= 3 ? 3 : 2;
    return l.slice(-n).join(".");
  };
  const sameSite = (h) => covers(h, entry) || also.some((s) => covers(h, s)) || base(h) === base(host);

  // Late (bubbling, on window), so the page has had its say first.
  window.addEventListener("click", (e) => {
    if (!entry || !e.isTrusted || e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    const a = e.composedPath().find((n) => (n.localName === "a" || n.localName === "area") && typeof n.href === "string" && n.href);
    if (!a || a.hasAttribute("download")) return;
    const target = (a.getAttribute("target") || "").toLowerCase();
    if (target && target !== "_self") return;
    let url;
    try { url = new URL(a.href); } catch { return; }
    if (!/^https?:$/.test(url.protocol) || sameSite(url.hostname.toLowerCase().replace(/^www\./, ""))) return;
    e.preventDefault();
    const noref = /(^|\s)noreferrer(\s|$)/i.test(a.rel || "");
    window.open(url.href, "_blank", noref ? "noopener,noreferrer" : "noopener");
    // So the popup can offer "treat … as same site" for it.
    const to = url.hostname.toLowerCase().replace(/^www\./, "");
    if (chrome.runtime?.id) chrome.runtime.sendMessage({ type: "newTabOpened", site: entry, host: to, base: base(to) }).catch(() => {}); // not once cut off by an extension update
  });
})();
