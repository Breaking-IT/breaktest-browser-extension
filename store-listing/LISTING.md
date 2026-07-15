# Store listing copy

Use this material for the Chrome Web Store, Microsoft Edge Add-ons, and
addons.mozilla.org listings. Keep the disclosures aligned with `PRIVACY.md`
and the behavior of the submitted package.

## Identity and links

- Name: `BreakTest Browser Recorder`
- Publisher: `Breaking IT`
- Category: Developer Tools / Web Development
- Homepage: `https://github.com/Breaking-IT/breaktest-browser-extension`
- Support: `https://github.com/Breaking-IT/breaktest-browser-extension/issues`
- Privacy policy: `https://github.com/Breaking-IT/breaktest-browser-extension/blob/main/PRIVACY.md`

## Short description

Record browser traffic as a local HAR file with named BreakTest transactions.

## Detailed description

BreakTest Browser Recorder captures HTTP and HTTPS traffic directly through
the browser's debugging and web-request APIs. It does not require a proxy.

Start recording in the current tab, a prepared blank tab, or a private browser
window. Enter transaction names while you work so BreakTest can turn them into
Transaction Controllers when the HAR is imported.

Features:

- captures the first homepage request by attaching before the Start URL loads;
- records request and response headers, bodies, timings, and status details;
- assigns requests to named transactions as you perform a scenario;
- optionally disables the browser cache for a cold-cache recording;
- supports incognito or private-window recording when browser access is
  enabled; and
- exports locally for **File > Import HAR...** in BreakTest.

Recording begins only after you review and accept the recording-data notice.
That consent is remembered in the browser and can be reviewed or revoked from
**Privacy & settings**. A changed data-practice version requires consent again.
The extension does not upload recordings, run analytics, display advertising,
or share recorded information. HAR files can contain credentials and personal
data, so review them before sharing.

Chrome and Microsoft Edge use the same Chromium extension. Firefox uses a
native implementation of Firefox's response-stream APIs.

## Chrome privacy-practices entry

### Single purpose

Record user-initiated HTTP traffic from a selected browser tab into a local HAR
file with named BreakTest transactions.

### Permission justifications

- `debugger`: Attaches to the user-selected tab only after explicit consent and
  a Start action. It enables the DevTools Network domain to capture request and
  response data required for the HAR. It is detached when recording ends.
- `downloads`: Opens the browser's Save As dialog after the user chooses
  **Finish and export**, allowing the HAR filename and folder to be selected.
- `sidePanel`: Provides the visible recorder controls, transaction list, and
  live request status. In Chrome and Edge it is enabled only for the tab where
  the recorder was opened or the new tab created for recording.
- `storage`: Remembers the accepted disclosure version and temporarily
  coordinates an explicitly requested incognito launch. Launch instructions
  expire after 60 seconds; recorded HAR content is not stored there.
- `tabs`: Creates or selects the recording tab, reads the selected tab's URL
  and title, navigates to the user-supplied Start URL, and replaces the
  temporary private-window launcher page with the recorded site.

### Data disclosures

The recorder handles information locally, which Chrome treats as collection
even though nothing is uploaded. Select the dashboard categories corresponding
to:

- web history or browsing activity: URLs, methods, resource types, and timing;
- website content: request and response headers and bodies;
- authentication information: cookies, authorization headers, and tokens; and
- personal or sensitive categories that can occur inside arbitrary recorded
  website content, including identifying information, communications,
  location, financial or payment information, and health information.

Certify that the data is used only for the disclosed single purpose, is not
sold, is not used for advertising or creditworthiness, and is not transferred
to third parties. Use the public privacy-policy URL above.

## Firefox data disclosure

The extension does not transmit data outside the extension or local browser,
so the manifest declares:

```json
"data_collection_permissions": {
  "required": ["none"]
}
```

The add-on still processes website traffic locally and explains that processing
in its listing, in-product disclosure, and privacy policy.

Firefox's `downloads` permission is used only to open the native Save As dialog
for a user-requested HAR export. Firefox sidebars are window-wide by browser
design, so the recorder remains visible across tabs in the same window.

## Graphic assets

- Store-facing files belong under `store-listing/assets/`; they are kept out of
  the browser extension packages.
- Store icon: `chrome/icons/icon128.png` or `firefox/icons/icon128.png`
- Screenshots: `store-listing/assets/screenshots/`, using 1280x800 PNG or JPEG
- Chrome/Edge small promotional tile:
  `store-listing/assets/promotional/small-440x280.png`
- Chrome marquee promotional tile:
  `store-listing/assets/promotional/marquee-1400x560.png`, optional
- Additional screenshots: up to five, showing consent, live requests,
  transaction naming, and local HAR export

Do not place credentials, customer domains, or real HAR content in screenshots.
