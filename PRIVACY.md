# Extra Guac privacy policy

_Last updated: 2 October 2026_

Extra Guac is a browser extension with tools for the page you're on: screenshots, privacy blur, dark mode, auto-refresh, word highlighting, clipboard history, image saving and similar tools. This policy covers what it handles and where that goes.

**In short:** everything stays in your browser. The developer runs no server, collects no analytics and can't see your data. Data leaves your browser only when you use a feature that sends it to a service you chose, and only to that service.

## What stays on your device

These are kept in Chrome's local extension storage, on your computer only:

- **Settings** for every tool, including API keys you enter for the URL shorteners and image hosts.
- **Clipboard history** (only while you have it switched on). This is text you copy or cut on web pages. Password, one-time-code and card fields are never recorded, and nothing is recorded on sites you exclude. Copies made in other apps are never seen.
- **Removed elements, highlight word lists and redirect rules** that you set up.
- **Recent results:** shortened links, uploaded image links, picked colours, element selectors and fonts.

The following are worked out in your browser and never sent anywhere:

- **Web page content.** It's read to blur sensitive data, highlight words, detect auto-refresh keywords, apply dark mode, remove elements, and find images, colours, fonts and elements you pick.
- **Screenshots and saved images.** They're written to your Downloads folder.
- **Site data deleted with "nuke".** The cookies, storage and cache for the current site are removed locally.
- **Tab audio**, used to lower or raise a tab's volume.

## What is sent, and only when you ask

| Feature | Sent to | What is sent |
|---|---|---|
| URL shorten | The shortener you pick: cutt.ly, tinyurl.com or dub.co | The page address you shorten, and your API key for that service |
| Upload images | The host you pick: catbox.moe or x02.me | The image you right-click, and your user hash or API key |
| Drive backup | Your own Google Drive, through an OAuth client you set up | Snapshots of the extension's settings and data, including API keys and clipboard history. Bookmarks are included if you choose. The `drive.file` permission only allows access to files the extension created. |
| Alert sound (if you set a sound file link) | The site hosting that sound file | A normal request to play the file. The built-in chime needs no request. |
| Save images on click | The site the image comes from | A normal request for the image, like your browser makes when showing it |

These services have their own privacy policies. Extra Guac sends nothing else to them, and nothing at all to anyone else.

## What Extra Guac does not do

- It doesn't sell, rent or share your data.
- It doesn't track your browsing, keep a browsing history or build a profile of you.
- It doesn't use your data for advertising or credit decisions, or for any purpose other than the tools described above.
- It doesn't load or run code from the internet.

## Your control

- Each tool that records anything (such as clipboard history) is off until you switch it on.
- You can clear clipboard history, removed elements and recent results from the tools themselves.
- The backup tab can export your settings and data to a file. Removing the extension deletes everything it stored in your browser.
- Drive backups live in an "Extra Guac backups" folder in your Google Drive. You can delete that folder at any time and revoke the extension's access in your Google account settings.

## Changes

If this policy changes, the new version will be published here with a new date.

## Contact

Questions about this policy: open an issue at https://github.com/rycpot/tab-toolkit/issues.
