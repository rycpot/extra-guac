# Extra Guac 🥑
![Image](https://imglink.cc/cdn/KMLRslW1FC.png)
![Image](https://imglink.cc/cdn/iPptfB4shl.png)
![Image](https://imglink.cc/cdn/y41cuZzfDH.png)
![Image](https://imglink.cc/cdn/DyVAe-FlMh.png)
![Image](https://imglink.cc/cdn/8DWl5KVcB7.png)
![Image](https://imglink.cc/cdn/3bkb8dNuRR.png)
![Image](https://imglink.cc/cdn/W3RP5dlwcf.png)
![Image](https://imglink.cc/cdn/KXLy30_4T5.png)
![Image](https://imglink.cc/cdn/N9g45oLPjN.png)
![Image](https://imglink.cc/cdn/K_ptEAbLZr.png)

25+ tools for the page you're on, in one side panel. We may have gotten carried away.

A Chrome extension. Click its icon to open the side panel (or a popup, in settings → general). The gear opens settings; ⏻ stops everything running on the tab.

## Tools

**Tab 1**

| Tool | What it does |
|---|---|
| **Screenshot** | Capture an area, the visible tab or the full page. Mark it up, blur parts or remove the background in the editor, then save, copy or upload it. **image**, beside the scratch pads, opens the same editor for any image you drop in or paste. The last 10 shots stay in a history. |
| **Text from image** | Drag a box over any text on screen; it's read and copied. Shown in a card where you can fix it and read it again with another engine. |
| **Privacy blur** | Hides emails, phone numbers, card numbers, keys and your own rules on every page. Blur, bars or masked characters; hover to peek. |
| **Scratch pads** | Six pads that save as you type, in rich or plain text. Drop in a text or code file to read it with colors, with find and replace in plain text; Markdown and HTML have a preview. |
| **Refresh** | **hard** reloads without the cache. **nuke** clears the site's cookies, storage and cache, then reloads. |
| **Auto-refresh** | Reloads a tab on a fixed or random timer. Optionally watches for your keywords and alerts you when they appear. |
| **URL shorten** | Shortens the tab's address with x.gd, spoo.me or dub.sh, copied right away. x.gd and spoo.me work without a key. |
| **QR code** | A code for the page, a link, text, a phone number or an email, in Extra Guac's avocado look. Static, or dynamic so you can change where it points later. Add your own icon in the middle. |
| **Tab volume** | Turns one noisy tab down, from 0 to 100%, with four quick levels (double-click one to change it), 100% and mute. In the side panel, a switch adds "Activate volume controls" to that tab's right-click menu when Chrome needs it. |
| **Proxy** | Opens the sites you pick through your own Webshare proxies, in the country you choose. A site can also be given by its name alone, for every real domain ending (google covers google.com, google.co.uk and google.es), for sites that change their ending or have one per country. Free plan: 20 sites and 1 GB a month; paid plans can send every site but a skip list. WebRTC is turned off on proxied sites, so they can't see your own address, and they see the proxy's place: a location in its country, its time zone and its language (each can be switched off). |
| **Awake** | Keeps the screen on for a set time, or until you stop it. |
| **Highlight words** | Neon marks for your words, on every site or per site. Several sites can share one list. |
| **Clipboard history** | Once on, keeps text you copy on web pages to search, pin and paste again. Password and card fields are never saved. |

**Tab 2**

| Tool | What it does |
|---|---|
| **What color?** | A magnifier over the page; click to copy a pixel's color as hex. |
| **What element?** | Hover and click any element to copy its CSS selector or XPath. |
| **What font?** | Click any text to see the font's real name, weight and size; the name is copied. |
| **Zoom & rotate images** | Hold a key and scroll over an image to zoom it. Right-click it for rotate and zoom controls. |
| **Save images on click** | Hold a key and click an image to save it as is, or as PNG, JPG or WebP. |
| **Upload images** | Right-click an image, or drop, paste or pick images in the upload images section, to upload them to ImgLink or X02; the link is copied and kept in a history, with the newest four shown as thumbnails. With no host on, dropped images go to ImgLink without an account; with both on, you drop them on the host you want. |
| **Dark mode** | Dark pages on every site or only the ones you pick. Sites with a dark theme of their own get that one. |
| **Remove elements** | Click away clutter on a page; it stays gone on that site until you bring it back. |
| **Open other site URLs in new tab** | On the sites you pick, links that leave the site open in a new tab. |
| **URL auto redirect** | Rewrites addresses with your own find-and-replace rules, per domain. |
| **Refresh on focus** | Reloads a page when you come back to it, if it's on your list. Normal or hard, until a date you choose. |
| **Enable copy & right-click** | Unlocks selecting, copying and right-clicking on sites that block them, one site at a time. |

**Tab 3**

| Tool | What it does |
|---|---|
| **Session switch** | Several logins for the same site, and one click to switch between them. Each profile keeps the site's cookies, page storage and app data and stays up to date while you use it, with its login's expiry date shown. A profile can open its site through one of your Webshare proxies, in a country you pick. A login already saved in a profile is recognized by itself. A login changed from outside never overwrites a profile: a card on the page asks once what to do with it. Profiles go into cloud backups, and into an encrypted backup file when you ask. |
| **Userscripts** | Runs your own userscripts (.user.js) on the sites they name. Off until you turn it on. Everything is on one page with tabs: your scripts (newest first, each with edit, check for update, download and delete), settings, and an editor tab for each open script (with undo, redo, go to row, find and replace and kept indentation). Open a .user.js link to install a script, or write one in the editor. Scripts get the GM\_\* and GM.\* functions (saved values, requests to other sites, styles, menu commands, notifications, downloads and more) and update themselves on the schedule you pick, asking first when an update wants more access. A script that uses the page's own JavaScript (unsafeWindow) runs in the page with its GM functions, and one set to run from the right-click menu gets an item there. Import a .zip, a userscript backup text file or .user.js files; export all as a .zip. Part of cloud backups, and can be restored from one on their own. Needs Chrome 131 or later, and Chrome's "Allow User Scripts" switch for Extra Guac (the userscripts page shows how). |
| **Word search** | Find the hidden words, in 42 languages, with hints and best times (Expert shows only each word's length until it's found). New game asks for a level and starts one puzzle with its own clock; Stop ends it. The puzzle waits behind a Start button each time it opens, and the timer pauses when you look away or leave the puzzle alone for a minute. Easy plays right in the panel; Medium, Hard and Expert open in a tab of their own. Each language's word list (made from [wordfreq](https://github.com/rspeer/wordfreq), CC BY-SA 4.0) downloads the first time you pick it. **Play with others** (its people button opens it in the tab): make a room and up to 5 others join with its code or invite link, from Extra Guac or [rycpot.github.io/wordsearch](https://rycpot.github.io/wordsearch) in any browser. The host picks the level and language and starts; after a 10-second countdown everyone races on the same puzzle, sees the others' progress and finishing times, and can chat. It connects the same way Beam does. |

**Backup tab**

| Tool | What it does |
|---|---|
| **Cloud backup** | Snapshots of your settings, data and bookmarks to your own Google Drive, Dropbox or both, by hand or every 1 to 24 hours. Restore any snapshot from the list. |
| **Beam** | Send files between your devices with a 6-digit code or a QR code, encrypted end to end. The other device uses Extra Guac too, or just [rycpot.github.io/beam](https://rycpot.github.io/beam) in any browser. Once connected, the devices can also chat. |
| **Settings file** | Export everything as a .json file, or import one to replace it. Tick the box to include session switch profiles, encrypted with a passphrase; importing such a file lets you bring back the settings with the profiles, or the settings only. |

**Layout:** drag tools between tabs, or reorder them, in settings → general. Tab 3 holds session switch, userscripts and word search at first, and anything you drag there.

## Install

Download the zip from [Releases](../../releases) and unzip it, then:

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick the folder.
3. Pin the icon to the toolbar.

<a href="https://chromewebstore.google.com/detail/extra-guac/kgaeicakljpjmpeacalbmfbcmlpploni"><img src="https://fonts.gstatic.com/s/i/productlogos/chrome_store/v7/192px.svg" width="24" align="absmiddle" alt="Chrome Web Store"></a>&nbsp;<a href="https://chromewebstore.google.com/detail/extra-guac/kgaeicakljpjmpeacalbmfbcmlpploni"><b>Install from the Chrome Web Store</b></a>

## Notes

- Privacy: everything stays in your browser unless a tool you use needs an outside service, and then it goes only there. See [PRIVACY.md](PRIVACY.md).
- The interface font is [Inter](https://github.com/rsms/inter) (SIL Open Font License), trimmed to the characters Extra Guac shows (`tools/inter-trim.py`).
- License: [0BSD](LICENSE), use it for anything. The bundled libraries keep their own licenses, next to them in `vendor/` and `beam/lib/`.
