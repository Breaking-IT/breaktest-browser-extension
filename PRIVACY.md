# BreakTest Browser Recorder Privacy Policy

Effective date: July 20, 2026

This policy describes how the BreakTest Browser Recorder extensions for
Chrome, Microsoft Edge, and Firefox process information.

## Summary

The recorder processes browser traffic only after you review the in-extension
notice, give consent, and start a recording. Recording data stays on your
device. Breaking IT does not receive it, upload it, sell it, use it for
advertising, or share it with third parties.

## Information processed during a recording

To create a HAR file, the recorder may process the following information from
the browser tab you selected:

- requested URLs, HTTP methods, status codes, timings, and resource types;
- request and response headers, which may include cookies, authorization
  headers, session tokens, and other authentication information;
- request and response bodies, including form submissions and website content;
- the selected tab's title and basic recording state; and
- transaction names, the optional Start URL, and the cache preference you
  enter in the recorder.

Websites can place sensitive information in headers or bodies. Depending on
the system you record, a HAR can therefore contain names, email addresses,
account identifiers, personal communications, location information, financial
or payment information, health information, or other personal data. The
recorder does not seek these categories independently; it records the HTTP
traffic required for the user-requested HAR capture.

## Purpose and use

The information is used only to show recording progress and create the HAR
file you explicitly request. BreakTest can import that HAR to create a load
testing script with named transactions.

The extension contains no advertising, analytics, tracking pixels, or remote
code. It does not create user profiles or use recorded information for any
secondary purpose.

## Storage and retention

Active recording data is kept in extension memory until you finish or discard
the recording, close the recorded tab, reload or remove the extension, or the
browser terminates the extension process. The recorder retains at most 2 MiB
of body text for each response and marks larger bodies as truncated.

When you finish a recording, the extension serializes the completed HAR into a
Blob in browser-local IndexedDB before opening the Save As dialog. This avoids
browser extension-message size limits and lets the recorder offer the same
completed HAR again if the dialog or download fails or the recorder panel is
closed. The locally stored Blob is deleted after a successful download or when
you explicitly discard it. An abandoned Blob is deleted the next time cleanup
runs after it becomes 24 hours old. Removing the extension also removes its
IndexedDB data.

For private or incognito launch coordination, the extension temporarily stores
the Start URL, transaction name, cache preference, consent version, and window
identifiers in browser-local extension storage. Unclaimed launch instructions
expire after 60 seconds. Firefox also temporarily stores whether the recorder
changed its browser-wide cache setting so that setting can be restored.

The extension also stores the version of the recording-data notice you
accepted. This prevents the same notice from occupying the recorder before
every recording. You can review the notice or clear your consent through
**Privacy & settings** in the recorder. A material change to the recording or
data practices increments the notice version and requires consent again.

When you export a recording, the browser opens its native Save As dialog and
writes the HAR to the filename and folder you choose. The extension deletes
its temporary IndexedDB copy after the download succeeds, but it does not
manage or delete the exported file.

## Transmission and sharing

The extension does not transmit recording data to Breaking IT or any third
party. Normal requests between your browser and the website being recorded
continue as part of your browsing session. Opening an external documentation,
support, or privacy-policy link is an explicit navigation to that site.

## Private browsing

The recorder can run in a private or incognito window when you enable that
browser permission. Recorded data is still processed locally. Closing all
private windows asks the browser to discard that private session's cookies and
site storage; exported HAR files remain in the location you selected.

## Your choices and control

Recording begins only after you have affirmed the recording-data notice and
chosen a start action. Your consent is remembered in browser-local extension
storage. You can review or revoke it through **Privacy & settings** in the
recorder. You can finish and export at any time, close the recorded tab, or
remove the extension. You should review and redact HAR files before sharing
them because they may contain credentials and personal data.

## Chrome Web Store Limited Use

BreakTest Browser Recorder's collection and use of user data adhere to the
Chrome Web Store User Data Policy, including its Limited Use requirements.
Recorded data is used only to provide the single, user-facing purpose
described in this policy: creating the HAR file you explicitly request. It is
not sold, is not used for advertising or creditworthiness, and is not
transferred to third parties.

## Security

Security issues should be reported privately as described in
[SECURITY.md](SECURITY.md). Do not attach a HAR containing credentials or
personal data to a public issue.

## Changes to this policy

Material changes to recording or data practices will be reflected here and in
the extension disclosure before an updated version is published.

## Contact

For non-sensitive privacy questions, use the
[BreakTest Browser Recorder issue tracker](https://github.com/Breaking-IT/breaktest-browser-extension/issues).
For sensitive security or privacy reports, follow the private reporting process
in [SECURITY.md](SECURITY.md).
