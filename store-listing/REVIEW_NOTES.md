# Reviewer notes

## Primary purpose

BreakTest Browser Recorder creates a HAR file from a browser tab after an
explicit user action. The user assigns transaction names during recording and
imports the resulting file into the separately installed BreakTest desktop
application. No BreakTest installation is required to exercise or review the
recording and export flow.

## Test steps

1. Install the submitted extension, visit `https://example.com/`, and open
   **BreakTest Browser Recorder** from its toolbar action.
2. Keep the initial transaction name or replace it.
3. Review the recording-data notice and select **I understand and want to
   record this traffic**. It can be reopened from **Privacy & settings**.
4. Choose **Start recording here**. The page is not reloaded automatically.
5. Reload the page manually and wait for requests under **Live requests**.
6. Click the arrow beside the transaction name. Complete the suggested `02_`
   prefix and confirm **Start transaction**, then navigate or reload.
7. Click a transaction to inspect response sizes and the timing waterfall.
8. Switch to another tab. Use **Go to recording tab** or Command+Shift+9
   (Ctrl+Shift+9 on Windows/Linux) to return to the recording.
9. Choose **Finish and export**, then choose a filename and folder.

Optional file-capture check: on a trusted test page containing a file input,
select a small non-sensitive file during recording. Its bytes are base64 in
`log._breaktest.uploadCapture.files` after export, even if not submitted. This
is a custom HAR extension, not a guaranteed request-to-file mapping. Files over
20 MiB or beyond the 64 MiB recording limit are marked unavailable. No upload
section is exported when no files were captured.

No account, remote service, license key, payment, or test credentials are
required.

## Data behavior

- Capture begins only after the user accepts the visible disclosure and chooses
  a Start action.
- The accepted disclosure version is remembered locally. The user can review
  or revoke consent through **Privacy & settings**, and changed data practices
  require a new disclosure version.
- The extension processes recorded traffic locally and does not send it to
  Breaking IT or a third party.
- The package contains no analytics, advertising, telemetry, remote scripts,
  dynamic code execution, or native messaging.
- Active recorded content is held in extension memory. When recording stops,
  the completed HAR is staged as a browser-local IndexedDB Blob so large files
  do not cross extension-message limits and an interrupted save can be retried.
  It is removed after a successful download, explicit discard, or cleanup once
  it is more than 24 hours old. The accepted disclosure version, short-lived
  private-window launch metadata, and Firefox cache-restoration state also use
  local extension storage.
- Export is initiated by the user and opens the browser's native Save As dialog
  through the `downloads` API. Cancelling keeps the completed HAR available in
  the recorder across panel reopenings so **Save HAR** can retry, or **Discard
  and start over** can explicitly delete it.

## Chromium-specific review notes

The `debugger` permission is required for the Chrome DevTools Protocol Network
domain. The extension attaches only to the selected recording tab after
consent, does not inspect other tabs, and detaches when recording finishes.
Opening Chrome or Edge DevTools on the same tab can detach the recorder because
the browser permits only one debugger client.

The Chrome/Edge side panel is configured per tab. The REC toolbar badge is
shown only on the recorded tab. The locator selects the tab and focuses its
window without changing the recording.

Incognito access is optional. If enabled by the reviewer, **Start in incognito** opens a launcher in a new private window and requires one browser-
mandated click before the side panel opens. That same launcher tab is changed
to `about:blank`, attached to the recorder, and then navigated to the Start URL
so the tab-specific panel remains visible.

## Firefox-specific review notes

The Firefox package is unminified, unbundled source with no third-party
libraries and no build step. The submitted ZIP itself is human-readable source;
no separate source-code archive is required.

- `webRequest`, `webRequestBlocking`, and `webRequestFilterResponse` capture the
  request metadata and unchanged response stream required for HAR export.
- `<all_urls>` is necessary because the user may record any HTTP or HTTPS
  system they are authorized to test.
- `browserSettings` is used only when the user explicitly enables **Disable
  browser cache while recording**; the previous setting is restored afterward.
- `downloads` opens the native Save As dialog only after **Finish and export**.
- `storage` holds the accepted disclosure version, short-lived private launch
  coordination, and cache restore state. Browser-local IndexedDB temporarily
  stages completed HAR exports for download and retry.
- Firefox sidebars are window-wide by browser design and therefore remain
  visible across tabs in the same window.

## New permissions in 1.2.0

`scripting` and Chrome host access support packaged isolated-world upload
capture. Content scripts may load on HTTP/HTTPS sites, but read file bytes only
when the background authorizes capture for the user-selected recording tab.
Selected files may never be submitted; the disclosure explicitly states this.
Captured bytes remain local. The recording notice version is incremented.
