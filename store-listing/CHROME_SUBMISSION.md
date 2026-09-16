# Chrome Web Store submission checklist

Use this checklist for the `1.2.0` submission. Keep the answers aligned
with [LISTING.md](LISTING.md), [REVIEW_NOTES.md](REVIEW_NOTES.md), and the
public [privacy policy](../PRIVACY.md).

## 1. Publisher account

- Complete the one-time Chrome Web Store developer registration.
- Set the publisher name to `Breaking IT`.
- Verify the developer contact email.
- Enable 2-Step Verification on the publishing Google account.
- Confirm that the account can receive Chrome Web Store review messages.

## 2. Package

From the repository root, run:

```bash
python3 scripts/validate_extensions.py
python3 scripts/package_extensions.py
```

Upload `dist/breaktest-browser-recorder-chrome-edge-1.2.0.zip`. The generated
ZIP and checksums are release artifacts and are intentionally not committed.

## 3. Store listing

- Name: `BreakTest Browser Recorder`
- Primary language: English
- Category: Developer Tools
- Short and detailed descriptions: copy from [LISTING.md](LISTING.md)
- Homepage: `https://github.com/Breaking-IT/breaktest-browser-extension`
- Support: `https://github.com/Breaking-IT/breaktest-browser-extension/issues`
- Privacy policy:
  `https://github.com/Breaking-IT/breaktest-browser-extension/blob/main/PRIVACY.md`

Upload these graphic assets:

- Icon: `chrome/icons/icon128.png`
- `store-listing/assets/screenshots/01-idle-setup.png`
- `store-listing/assets/screenshots/02-live-recording.png`
- `store-listing/assets/screenshots/03-completed-checkout.png`
- `store-listing/assets/screenshots/04-imported-test-plan.png`
- `store-listing/assets/promotional/small-440x280.png`

The 1400x560 marquee image and a promotional video are optional.

## 4. Privacy practices

### Single purpose

> Record user-initiated HTTP traffic from a selected browser tab into a local
> HAR file with named BreakTest transactions.

### Permission justifications

- `debugger`: Attaches to the tab selected by the user, after consent and a
  Start action, to use the DevTools Network domain for HAR request, response,
  body, and timing capture. It detaches when recording ends.
- `downloads`: Opens the browser Save As dialog after the user chooses Finish
  and export so the HAR filename and folder can be selected.
- `sidePanel`: Displays the recorder controls, transaction list, and live
  request status for the selected recording tab.
- `storage`: Remembers the accepted disclosure version and temporarily
  coordinates an explicitly requested incognito launch. Separately, a
  completed HAR is staged in browser-local IndexedDB until its download
  succeeds, the user discards it, or cleanup runs after it becomes 24 hours
  old.
- `tabs`: Creates or selects the recording tab, reads its URL and title,
  navigates to a user-supplied Start URL, and prepares the private-window
  launcher tab for recording.

- `scripting`: Installs the packaged isolated-world file-capture script in the
  selected recording tab and its frames. It reads selected/dropped file bytes
  only after the background confirms an active, user-consented recording.
- Host access (`<all_urls>`): Users may record arbitrary HTTP/HTTPS sites.
  Packaged content scripts observe file selections and formdata; the background
  authorizes byte capture only for the recorded tab. No file bytes are read
  outside an active recording, and no captured data is sent to the publisher.

### Remote code

Select **No**. The extension does not execute remotely hosted code.

### Data-use disclosure

Chrome treats locally processed data as collection. Select every dashboard
category that can occur in arbitrary recorded traffic, including:

- web history or browsing activity;
- website content and resources;
- authentication information;
- personally identifiable information;
- personal communications;
- location information;
- financial and payment information; and
- health information.

If the dashboard presents equivalent categories under different wording,
choose the corresponding categories. Certify that the information is used
only for the extension's disclosed single purpose, is not sold, is not used
for advertising or creditworthiness, is not transferred to third parties,
and is not read by the publisher. Users remain in control of the HAR files
they explicitly export.

Enter the public privacy-policy URL above. Verify it is accessible without a
GitHub login before submitting.

## 5. Distribution

- Visibility: Public
- Regions: all supported regions, unless there is a business reason to limit
  availability
- In-app purchases: No
- Trusted testers: optional; not required for the public submission

Private, unlisted, and public items all receive policy review.

## 6. Reviewer instructions and submission

Use the test steps and Chromium-specific explanation from
[REVIEW_NOTES.md](REVIEW_NOTES.md) wherever the dashboard offers reviewer test
instructions or notes. No account, credentials, payment, license key, remote
service, or BreakTest desktop installation is required to review recording and
HAR export.

Before choosing **Submit for review**:

- confirm the privacy-policy URL is live;
- install the exact uploaded ZIP in a clean Chrome profile and complete one
  current-tab recording and export;
- confirm the listing, privacy disclosures, and package behavior agree; and
- retain `dist/SHA256SUMS` with the release artifacts.
