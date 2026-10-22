# Extra Guac privacy policy

_Last updated: October 22, 2026_

Extra Guac is a browser extension with tools for the page you're on: screenshots, privacy blur, dark mode, auto-refresh, word highlighting, clipboard history, image saving, sending files between your devices (Beam) and similar tools. This policy covers what it handles and where that goes.

**In short:** everything stays in your browser. The developer runs no server, collects no analytics and can't see your data. Data leaves your browser only when you use a feature that needs an outside service, and only to the services listed for that feature below.

## What stays on your device

These are kept in Chrome's local extension storage, on your computer only:

- **Settings** for every tool, including API keys you enter for the URL shorteners and image hosts.
- **Clipboard history** (only while you have it switched on). This is text you copy or cut on web pages. Password, one-time-code and card fields are never recorded, and nothing is recorded on sites you exclude. Copies made in other apps are never seen.
- **Scratch pads:** what you write or drop into them, including images you add.
- **Fonts you add** for text on screenshots, kept so they're there next time.
- **Screenshot history:** your last 10 screenshots (unless you switch it off in settings, which deletes them).
- **Removed elements, highlight word lists and redirect rules** that you set up.
- **Recent results:** shortened links, uploaded image links, picked colors, element selectors and fonts.
- **Proxy:** your Webshare API key, your lists of sites and countries, the addresses you've opened of sites you listed by name on any ending (so the WebRTC and place settings reach them; forgotten when you take the site off), and what Webshare reports for your account (your plan, this month's data use, and your proxies' addresses, countries, cities and login). The proxy logins aren't included in Drive backups.
- **Session switch profiles:** for each site you save profiles for, each profile's copy of the site's cookies (its login), the site's page storage (localStorage, sessionStorage and IndexedDB, up to 25 MB), its name, color and proxy country. They stay on your computer, like Chrome's own cookies, and aren't part of the settings file. An encrypted backup file is made only when you ask, with a passphrase you choose that isn't stored. They also go into Drive backups (without IndexedDB copies), so restoring a snapshot on another browser brings them back. They aren't encrypted there: anyone who gets into your Drive could use those logins.
- **Userscripts:** the scripts you install or write (their code, the files they load, where each came from and when it was updated) and the values each script saves for itself. They're part of Drive backups and the userscripts .zip export.
- **QR code history:** the newest 50 static and 50 dynamic codes you made (what each one holds, and a dynamic code's short link and destination), and the icon you chose for the middle of your codes.

The following are worked out in your browser and never sent anywhere:

- **Web page content.** It's read to blur sensitive data, highlight words, detect auto-refresh keywords, apply dark mode, remove elements, and find images, colors, fonts and elements you pick.
- **Screenshots and saved images.** They're written to your Downloads folder, unless you upload a screenshot (below).
- **Site data deleted with "nuke".** The cookies, storage and cache for the current site are removed locally.
- **Tab audio**, used to lower or raise a tab's volume.

## What is sent, and only when you ask

| Feature | Sent to | What is sent |
|---|---|---|
| URL shorten | The shortener you pick: x.gd (xgd.io), spoo.me or dub.sh (api.dub.co) | The page address you shorten, and your API key for that service if you added one (x.gd is sent Extra Guac's own key otherwise; spoo.me works without one). Short link analytics: x.gd's are off, unless you add your own key and turn them on (x.gd then shows them to anyone who adds + to the link); spoo.me's can be seen only by you with your key, and without one are accessible to anyone with the link. With a dub.sh key, Extra Guac also asks dub.sh how much of your plan is used (your workspace's link count); only your key is sent for that. When you add a spoo.me or dub.sh key, and when settings open, Extra Guac asks that service whether it accepts the key, so a key it doesn't take is shown in red; only the key is sent. |
| Dynamic QR codes (only when you make one, or change where it goes) | spoo.me or dub.sh (api.dub.co), with your API key for it | The web address the code points to, to make its short link (spoo.me's, which only you can see analytics for), and later the new address when you change it; with spoo.me, the new link's short name, to find it among your links. Static QR codes are made in your browser and nothing is sent. |
| Upload images | The host you pick: imglink.cc or x02.me | The image you right-click, and your API key for that host if you set one (ImgLink also works without one). Uploads are unlisted: not shown in a gallery, but anyone with the link can open them. |
| Screenshot upload | Your default image host: imglink.cc or x02.me | The screenshot you choose to upload, and your API key for that host if you set one |
| Text from image | OCR.space (api.ocr.space, or its PRO servers apipro1/apipro2.ocr.space on a PRO plan) | Only the box you select on the page, as an image, and the OCR.space API key: yours, or Extra Guac's shared one. Read again only when you switch engine on the card. |
| Proxy (only with your own Webshare API key) | Webshare (proxy.webshare.io), and your own Webshare proxies | To Webshare's API: your API key, to read your plan, your proxies and this month's data use (when you connect, about once an hour while a key is set, when you open the panel or settings, and when a proxy fails). Through your proxies: the sites you list (or, on a paid plan with every site on, all but the ones you skip) load through them, so Webshare carries that traffic and the sites see the proxy's address instead of yours. For secure (https) sites the proxy sees which site and how much data, not the pages; for plain http sites it can see the pages too. Your proxy login is given only to your proxies, when they ask. The place proxied sites are shown (a location in the proxy's country, its time zone and its language) is worked out inside Extra Guac from the country and city Webshare reports: nothing else is asked for it. |
| Drive backup | Your own Google Drive, through Google sign-in | Snapshots of the extension's settings and data, including API keys, clipboard history, scratch pads, your userscripts and the values they saved, and the screenshot history (their images as separate files, each uploaded once). Bookmarks are included if you choose. Session switch profiles (each one's cookies and page storage, not encrypted). The `drive.file` permission only allows access to files the extension created. |
| Alert sound (if you set a sound file link) | The site hosting that sound file | A normal request to play the file. The built-in chime needs no request. |
| Save images on click | The site the image comes from | A normal request for the image, like your browser makes when showing it |
| Upload history thumbnails (uploads without a saved thumbnail, such as ones made before thumbnails or restored from a backup) | The image host the link points to | One normal request for that uploaded image, like opening the link, to make its thumbnail. Thumbnails stay on this computer and aren't backed up. |
| Beam: sending files between your devices (only while you use it, in its own tab or the side panel) | PeerJS's public connection server (0.peerjs.com) and Google's and Cloudflare's STUN servers (stun.l.google.com, stun.cloudflare.com), to put the devices in touch; public TURN servers (ExpressTURN's at free.expressturn.com, and turn.evan-brass.net) when a network blocks a direct path, to pass the direct link along; when a direct link isn't possible, public Piping Server relays (piping.onrender.com or ppng.io); the files themselves go to the devices you pair with | The connection server gets a room name made from the 6-digit code and your network address, as any connection does; the STUN servers tell the device its public address (either one is enough; both are asked). Each device shows the other its type and browser (such as "Mac · Chrome"), or the name picked in the word search, and the device that shows the code must accept each one that joins: one device, or with Broadcast on up to 5. Files go straight between the devices over an encrypted WebRTC link (passed along by a TURN server when a network blocks a direct path; it sees only encrypted data). Through a relay they're encrypted end to end with a key only the sending and receiving device have (made fresh for each pairing), so the relay sees only encrypted data and its size, and keeps nothing. To pick the faster relay, a device about to send a file through one first sends 1 MB of empty test data through each relay to itself; the measured speeds (just the two relays' speeds and when they were measured) are kept in the browser, as is this month's data usage (how many bytes of files this device sent and received, and how many went through each relay), which Beam shows from the arrows at the bottom of the page. Chat messages go to the devices you're connected to over the same encrypted links (the device that shows the code passes them on to the others) and stay on the page until the connection ends. Beam stores nothing else: a received file is saved only when you click Save file. |
| Word search (the first time you pick a language, then about once a month) | Extra Guac's website, rycpot.github.io, on GitHub Pages | A normal request for that language's word list, a plain text file. The list is kept in the browser so puzzles work offline; your games, times and language never leave it. |
| Word search with others (only while you're in a room) | The same services as Beam: PeerJS's connection server, the STUN and TURN servers, and the Piping Server relays when a direct link isn't possible | The connection server gets a room name made from the 6-digit code and your network address. Everyone in the room sees your name (the one you pick, or your device's type and browser), your connection (direct or relay), how many words you've found and your finishing time; the host's device sends everyone the puzzle. Chat messages go to everyone in the room. All of it goes over the devices' encrypted links (through a relay, encrypted end to end), only to the devices in the room, and stays on the page until you leave it. Only the name you pick is kept in the browser. |
| Userscripts (only the scripts you install) | The address you install a script from, when you install it and when it's checked for updates (on the schedule you pick, or never); and the sites a script itself sends requests to, which it must list (by @connect) unless it lists none | Normal requests for the script and the files it names. A script's own requests go with your cookies for that site, like the site's own pages would. What a script does in a page is up to its code: install scripts only from authors you trust. |
| HTML preview in a scratch pad (only after "Load them for this pad") | The sites the HTML file's images, styles and fonts come from | Normal requests for those files, like your browser makes when showing the page. Until you allow it for that pad, nothing is requested. |

These services have their own privacy policies. Extra Guac sends nothing else to them, and nothing at all to anyone else.

## What Extra Guac does not do

- It doesn't sell, rent or share your data.
- It doesn't track your browsing, keep a browsing history or build a profile of you.
- It doesn't use your data for advertising or credit decisions, or for any purpose other than the tools described above.
- It doesn't load or run code from the internet, apart from userscripts you choose to install, which run only through Chrome's user script feature after you allow it.

## Your control

- Each tool that records anything (such as clipboard history) is off until you switch it on.
- You can clear clipboard history, removed elements and recent results from the tools themselves.
- The backup tab can export your settings and data to a file. Removing the extension deletes everything it stored in your browser.
- Drive backups live in an "Extra Guac backups" folder in your Google Drive. You can delete that folder at any time and revoke the extension's access in your Google account settings.

## Changes

If this policy changes, the new version will be published here with a new date.

## Contact

Questions about this policy: open an issue at https://github.com/rycpot/extra-guac/issues.
