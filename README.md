# Tab Toolkit

**Tab Toolkit: Hard Refresh, Site Data Nuke, PII Blur & More**: a lightweight Chrome (MV3)
extension that bundles handy page tools into one toolbar icon.

- **Left-click the icon** — hard refresh (same as Cmd/Ctrl+Shift+R, bypasses cache).
- **Right-click the icon → Nuke** — wipes all data for the current site, then hard-reloads:
  cookies, cache, Cache Storage, localStorage, sessionStorage, IndexedDB, service workers,
  file systems and WebSQL — for the whole domain (e.g. on `app.example.com` it covers
  `example.com` and its subdomains). **Passwords, history, downloads and form data are kept.**

A ✓ / ✕ badge flashes briefly to show the result.

- **Right-click → Blur sensitive data** (checkbox) — hides personal data on every page until you
  untick it. **Right-click → Blur settings…** opens a tall settings window docked beside the page;
  every change applies to open tabs instantly.

## Blur sensitive data

**Styles:** blur (adjustable strength), solid bars (pick a colour), or mask characters
(`×××@××××.×××`, drawn in the page's own font). Hover to reveal. Form fields are covered too.
"Hide page until it has been scanned" keeps pages blank for the moment it takes to scan them,
so nothing leaks during screen sharing.

**Built-in detectors** (each can be switched off): email, card numbers (Luhn-checked), IBANs
(checksum), MAC addresses, API keys/tokens (AWS, GitHub, Stripe, Slack, OpenAI/Anthropic, Google,
JWTs), passwords in URLs, IPv4, IPv6, US SSNs (dashed).

**Custom rules** are shown as chips: type a rule and press Enter (or paste several lines at once),
click a chip to edit it, ● to switch it off, × to remove it:

| Rule | Effect |
|---|---|
| `John Appleseed` | Plain text: blurs that text, any case |
| `Phone number: {number}` | Label stays visible; only the `{…}` part is hidden |
| `{number}` | Digits with spaces and `+ ( ) - .`, at least 4 digits |
| `{word}` / `{line}` | The next word / the rest of the line |
| `{[\d()\- ]}` | Your own set of allowed characters |
| `/order #(?<blur>\d+)/i` | JavaScript regex: hides the whole match, or only the `blur` group |

Labels and values split across elements (`<b>Phone number:</b> <span>99…</span>`) still match.
The settings window has a test box that previews your rules (including the one you're typing),
and a list of sites to never blur on.

Limits: text inside images, canvas and shadow DOM isn't covered; in mask mode, copying text
copies the masks.

## Install

Download the zip from [Releases](../../releases) and unzip it (or clone this repo), then:

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and pick this folder.
3. Pin the icon to the toolbar.

## Notes (Nuke)

- Only works on `http(s)` pages (not `chrome://` pages or the Web Store).
- Subdomain storage is cleared for the current host, the root domain, `www.`, and every
  subdomain that has cookies. Chrome offers no way to list other subdomains that only hold storage.

## Releasing

Bump `version` in `manifest.json` and push. The Release workflow zips the extension and
publishes it as a `v<version>` GitHub Release (skipped if that release already exists).
