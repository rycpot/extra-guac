# Hard Refresh & Nuke

Minimal Chrome (MV3) extension.

- **Left-click the icon** — hard refresh (same as Cmd/Ctrl+Shift+R, bypasses cache).
- **Right-click the icon → Nuke** — wipes all data for the current site, then hard-reloads:
  cookies, cache, Cache Storage, localStorage, sessionStorage, IndexedDB, service workers,
  file systems and WebSQL — for the whole domain (e.g. on `app.example.com` it covers
  `example.com` and its subdomains). **Passwords, history, downloads and form data are kept.**

A ✓ / ✕ badge flashes briefly to show the result.

## Install

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and pick this folder.
3. Pin the icon to the toolbar.

## Notes

- Only works on `http(s)` pages (not `chrome://` pages or the Web Store).
- Subdomain storage is cleared for the current host, the root domain, `www.`, and every
  subdomain that has cookies. Chrome offers no way to list other subdomains that only hold storage.
