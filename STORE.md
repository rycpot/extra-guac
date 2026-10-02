# Chrome Web Store submission notes

Ready-to-paste answers for the Developer Dashboard. This file isn't part of the extension zip.

## Store listing

**Summary** (manifest `description`, max 132 characters):

> Page tools in a side panel: screenshots, privacy blur, dark mode, auto-refresh, highlights, clipboard history, image saving & more.

**Category:** Tools (or Productivity).

**Name:** still to be decided. Keep it short and avoid lists of keywords. The Web Store's spam policy rejects names stuffed with feature words, such as the current one, "Tab Toolkit: Screenshots, Auto-Refresh, PII Blur, Nuke & More".

## Privacy practices tab

### Single purpose

> Tab Toolkit gives you tools for the web page you're on, gathered in one popup or side panel: capture it (screenshots, saved images), hide or change how it looks (privacy blur, dark mode, highlighted words, removed elements, zoom), control it (refresh, auto-refresh, volume, redirects, keep awake), inspect it (colour, font and element pickers) and keep what you copy from it (clipboard history, short links, image uploads).

### Permission justifications

| Permission | Justification |
|---|---|
| `<all_urls>` (host) | The tools work on whatever page the user is on: blur, dark mode, highlighting, element removal, image zoom and image saving run in the page. The pickers and screenshots read it, and auto-refresh watches it for keywords. Images are fetched with the page's cookies so saving and uploading work on sites that need you to be signed in. |
| `tabs` | Reads the current tab's address and title so each tool knows which site it's on (per-site settings, "not on this page" states) and can tell Chrome pages apart from normal ones. |
| `scripting` | Injects the page tools (blur, dark mode, highlighting, pickers, element removal, image zoom/save, clipboard capture, auto-refresh keyword watch) into the tabs where the user switches them on. |
| `storage` | Saves settings, word lists, removed elements, redirect rules, clipboard history and recent results locally. |
| `contextMenus` | Right-click items: upload an image, image controls, redirect with rules, paste a pinned clipboard entry. |
| `downloads` | Saves screenshots, clicked images and exported settings to the user's Downloads folder. |
| `cookies` | "Nuke" removes the current site's cookies, and only that site's, when the user asks. |
| `browsingData` | "Nuke" and "hard refresh" clear the current site's cache and storage when the user asks. |
| `alarms` | Runs scheduled Drive backups and ends a "keep awake" timer. |
| `notifications` | Tells the user when an auto-refresh keyword is found, when an upload link is copied or when a redirect loop is stopped. |
| `offscreen` | A hidden page plays the alert sound, keeps auto-refresh timers running, copies links to the clipboard, reads font files for the font picker and applies tab volume. |
| `tabCapture` | Captures a tab's audio so the volume tool can lower or boost it. Audio is processed locally and never recorded or sent. |
| `power` | "Awake" keeps the screen on for the time the user picks. |
| `sidePanel` | Lets the tools open in Chrome's side panel (the default) instead of a popup. |
| `webNavigation` | Applies auto-redirect rules as a page starts loading, and hides removed elements on the right frame from the first paint. |
| `identity` | Signs in to the user's own Google Drive for backups, using an OAuth client the user sets up and only the `drive.file` scope. |
| `bookmarks` | Includes bookmarks in Drive backups and restores them, only if the user turns that on. |
| `clipboardWrite` | Copies short links, upload links, colours, selectors and clipboard history entries. |

**Remote code:** No, I am not using remote code. All scripts are in the package. Two MIT-licensed libraries are bundled in `vendor/`, with their licences. The font is Inter (SIL Open Font License, `fonts/Inter.LICENSE`).

### Data usage

Tick the boxes below. Each one applies only while the user uses that tool, and the data is kept in their own browser:

- **Website content:** read in the page for blur, highlighting, keyword watch, pickers and screenshots, and never sent.
- **Web history:** the current tab's address, used for per-site settings and redirect rules. No history is collected or kept.
- **User activity:** text the user copies on web pages, kept only while clipboard history is on.
- **Authentication information:** API keys the user enters for the shortener and upload services, sent only to those services.

Leave these unticked: personally identifiable information, health, financial and payment information, personal communications and location.

Then tick all three statements:

- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

**Privacy policy URL:** https://github.com/rycpot/tab-toolkit/blob/claude/stoic-meitner-y26kmg/PRIVACY.md. The repository must be public for reviewers to open it; otherwise host `PRIVACY.md` somewhere public, such as GitHub Pages or a gist.

## Before submitting

- Upload the release zip (`tab-toolkit-vX.Y.Z.zip`). It holds only the extension files.
- Screenshots: at least one at 1280×800 or 640×400. A 440×280 promo tile is optional.
- Drive backup needs each user's own OAuth client ID, so say so in the listing description, or ship a built-in client later.
- Reviewers may take longer because of the `<all_urls>` host access. That is expected.
