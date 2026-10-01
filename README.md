# Tab Toolkit

**Tab Toolkit: Screenshots, Auto-Refresh, PII Blur, Nuke & More**: a Chrome (MV3) extension
that puts handy page tools in one popup, styled after the [Hop](https://hop.tools) Mac app.
Click the toolbar icon to open it; the gear opens settings, ⏻ stops everything that is running.

| Tool | What it does |
|---|---|
| **Screenshot** | **area** (drag a box, adjust it, ✓ at its bottom-right or Enter), **tab** (the visible part), **full** (scrolls to the end and stitches; very long pages are saved in parts). PNG or JPEG, saved to Downloads or a folder inside it. |
| **Privacy blur** | Hides personal data on every page while it's on (see below). |
| **Refresh** | **hard** reloads bypassing the cache (Cmd/Ctrl+Shift+R). **nuke** (click twice) clears everything the site stored, for the whole domain, and reloads. Passwords, history, downloads and form data are kept. |
| **Auto-refresh** | Per tab, every N seconds or a random time between two values. Optionally watches for a keyword: plays a sound, shows a notification and (optionally) brings the tab forward, then stops (or keeps going, per settings). The toolbar badge counts down. |
| **Shorten** | Shortens the tab's URL with cutt.ly, TinyURL or dub.co (your API keys, in settings) and copies it. Shows this month's count against the free limit (30 / 30 / 25) unless you mark a paid plan; ⤢ opens the full history. |
| **Volume** | Lowers this tab's volume (0–100%). |
| **Awake** | Keeps the screen on for 15 min, 30 min, 1 h, 2 h, ∞ or a custom time (scroll the unit to switch min/h). A green dot on the toolbar icon shows it's active. |

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

## Notes

- Page tools work on `http(s)` pages only (Chrome blocks extensions on `chrome://` pages and the Web Store).
- Nuke clears storage for the current host, the root domain, `www.`, and every subdomain that has
  cookies; Chrome offers no way to list other subdomains that only hold storage. Chrome can only
  delete saved passwords for all sites at once, so Nuke never touches them.
- Full-page screenshots follow the page's main scroll; pages that scroll inside an inner box
  (some web apps) capture only what's visible. Infinite-scroll pages stop after 80 screens.
- Screenshots can only be saved inside Downloads (a Chrome rule for extensions).
- While a tab's volume is below 100%, Chrome shows its "tab is being captured" indicator.

## Releasing

Bump `version` in `manifest.json` and push. The Release workflow zips the extension and
publishes it as a `v<version>` GitHub Release (skipped if that release already exists).
