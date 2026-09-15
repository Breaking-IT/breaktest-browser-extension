<!--
  Copyright 2024-2026 Breaking IT

  Licensed under the BreakTest Community Source License 1.0.
  You may not use this file except in compliance with that license.
  See the LICENSE file at the root of this distribution.
-->

# BreakTest Browser Recorder

The BreakTest Browser Recorder records a Chrome or Microsoft Edge session as a
HAR file. During the recording you can assign meaningful transaction names.
When the HAR is imported, BreakTest converts those names into Transaction
Controllers.

This is currently a local developer extension. It is not yet available from the
Chrome Web Store or Microsoft Edge Add-ons.

## Requirements

- Google Chrome or Chromium-based Microsoft Edge version 118 or newer.
- A local checkout of this repository containing the `chrome` directory.
- Developer mode enabled in the browser.

Firefox uses a separate native implementation in `firefox`.
See that directory's README for installation and browser-specific behavior.

## Install the local extension

### Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select `<extension checkout>/chrome`. Select the `chrome` directory itself,
   not its parent.
5. Open **Details** for BreakTest Browser Recorder and enable **Allow in
   incognito**.
6. Open Chrome's Extensions menu and pin **BreakTest Browser Recorder**.

### Microsoft Edge

1. Open `edge://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select the same `<extension checkout>/chrome` directory.
5. Open **Details** for BreakTest Browser Recorder and enable **Allow in
   InPrivate**.
6. Pin **BreakTest Browser Recorder** to the toolbar.

Chrome and Edge use the same extension files. No separate Edge build is needed.

## Start recording

1. Open the page you want to record and open the recorder panel.
2. Keep `01_OpenHomepage` as the initial transaction name, or replace it.
3. Optionally select **Disable browser cache while recording**.
4. Choose **Start recording here** to attach to the current page without reloading.

Only subsequent requests are recorded. Reload the page manually after starting
if you want to capture its initial load. To start a fresh incognito session,
enter the **Incognito start URL** and choose **Start in incognito**; capture
starts before navigation. The URL field does not affect **Start recording here**.
Browser internal and extension pages cannot be recorded; open an HTTP/HTTPS
page first or use the incognito action.

The recorder panel belongs to the tab where it was opened. Chrome and Edge
hide it when you switch tabs and show it again when you return.

## Name transactions while recording

The transaction field shows the current transaction. Click the **→** button
on its right to open **Next transaction**. The popup increments the last numeric
counter: `01_Openhomepage` suggests `02_`, and `UC1_01_Homepage` suggests
`UC1_02_`. Leading zeros and the prefix are preserved; names without a counter
start at `01_`. Type the description and press Enter or **Start transaction**.
Cancel or Escape keeps the current transaction. New requests stay with the
current transaction until you confirm; requests already in progress retain
the transaction in which they started.

The Transactions list displays the number of requests assigned to each name.
Use the edit icon beside a transaction to rename it and update all requests
already assigned to it. Use the × button to remove an earlier transaction, then
choose whether to remove its captured and pending requests or add them to the
previous or next transaction. Choices without an available neighboring
transaction are disabled. The active transaction cannot be removed; start the
next transaction first, then remove the earlier one.
The Live requests list shows each completed request as status, method, and
path. A warning marker means Chrome could not return the complete response
body.

## Finish and import into BreakTest

1. Choose **Finish and export**.
2. In the browser's Save As dialog, choose the HAR filename and folder. The
   suggested name is `breaktest-recording-<timestamp>.har`.
3. Open BreakTest.
4. Choose **File > Import HAR...**.
5. Select the downloaded HAR and complete the import wizard.

BreakTest uses the recorded names instead of guessing transaction boundaries
from timing gaps.

The completed HAR is staged as a browser-local IndexedDB Blob instead of being
sent through extension messaging, so the 64 MiB extension-message limit does
not limit the exported HAR size. If saving is cancelled or interrupted, choose
**Save HAR** to retry. The pending export survives closing and reopening the
recorder panel. It is removed after a successful download, explicit discard,
or the next cleanup after it becomes 24 hours old.

## Record in a private browser session

Private mode provides a temporary cookie, history, and storage context. It is
useful for repeatable login flows without changing the normal browser profile.

Private access is enabled as part of the installation steps above. The recorder
button may still say **Start in incognito window** in Edge; it opens an
InPrivate window there.

### Start a private recording

1. Close all existing incognito or InPrivate windows. This ensures the next
   window starts with a fresh temporary session.
2. Open the recorder in a normal browser window.
3. Enter the Start URL and initial transaction name.
4. Optionally select **Disable browser cache while recording**.
5. Choose **Start in incognito window**.
6. If the side panel does not open automatically, choose **Open recorder** on
   the BreakTest launcher page in the private window.
7. The launcher tab becomes the recording tab, keeping the recorder panel open
   while capture starts before the Start URL loads.
8. Record and export the scenario normally.
9. Close the private window to discard its temporary cookies and storage.

Cookies created during the recording remain available until that private
session is closed. This is intentional because multi-step authentication flows
need session cookies. For a guaranteed cold-cache run, explicitly select the
cache option before starting.

## Update the local extension

After pulling new recorder changes:

1. Finish any active recording first. Reloading discards an active recording.
2. Open `chrome://extensions` or `edge://extensions`.
3. Find BreakTest Browser Recorder.
4. Choose **Reload**.

The browser does not automatically update an unpacked extension.

## Troubleshooting

### The start page requires HTTP authentication or fails to load

Recording becomes active before the incognito start URL is opened. A 401
challenge or navigation error leaves the recorder attached and preserves the
requests already captured. Complete the browser's authentication prompt or
retry the page while recording remains active, then finish and export normally.
Failure to attach the debugger or enable network capture still stops startup.


### “Chrome internal and extension pages cannot be recorded”

The selected tab is a New Tab, settings page, extension page, or another
protected browser page. Enter the application URL in **Start URL** and choose
**Start in incognito**.

### The recorder is missing in a private window

Enable **Allow in incognito** or **Allow in InPrivate** in the extension's
Details page. Close existing private windows and try again.

### The private launcher says the instruction expired

Close the private window, reload the extension, and start again from the normal
recorder panel. Do not reload the extension while a recording is active.

### Recording stops after opening DevTools or another extension intervenes

Only one debugger client can control a tab at a time. Opening browser DevTools,
password managers, or other debugging extensions can detach the recorder. The
recorder attempts to reconnect, but for the most reliable capture:

- Keep browser DevTools closed on the recorded tab.
- Use a clean browser profile or private window.
- Disable unnecessary extensions in the recording profile.

### A response body is unavailable

Chrome does not expose every response body through DevTools. Redirects, cached
responses, streaming responses, and requests completed before attachment are
common examples. The recorder retries normal bodies and attempts redirect
bodies before Chrome reuses their request identifier. If Chrome still refuses
the body, the request is retained and marked as unavailable rather than being
silently presented as an empty response.

### Extension changes are not visible

Use **Reload** on the browser's Extensions page. Refreshing the recorded webpage
does not reload extension source files.

## Capture behavior and limits

- Captures HTTP/HTTPS requests, response metadata, request bodies, and bounded
  response bodies from the selected tab and attached frame/worker targets.
- Ignores browser- and extension-internal requests such as injected password
  manager assets.
- Captures at most 2 MiB of body text per response. There is no recording-wide
  body limit. Oversized individual bodies are marked as truncated in
  `_breaktest` metadata.
- Requests use Chrome's durable response-body buffer when supported, with a
  compatibility fallback and short retries around `Network.getResponseBody`.
  Redirect bodies are requested immediately before Chrome reuses their request
  identifier for the next hop.
  Bodies Chrome still cannot expose are marked as unavailable in `_breaktest`
  metadata and in the live request list rather than silently appearing empty.
- Stages completed HARs in browser-local IndexedDB before export, avoiding
  extension-message size limits. Available browser storage and memory, rather
  than Chrome's 64 MiB message limit, bound the practical recording size.
- Exports a HAR locally; it does not yet stream to a running BreakTest process.
- WebSocket handshakes may appear as HTTP requests, but individual WebSocket
  frames are not converted into JMeter samplers.
- Opening normal Chrome DevTools can briefly detach the extension debugger
  session. The recorder retries the connection for several seconds and keeps
  already captured requests available for export if it cannot reconnect.
- Popups that become independent tabs may need to be recorded separately.

## Security and privacy

HAR files can contain credentials, cookies, bearer tokens, personal data and
response content. Record only systems you are authorized to test. Review and
redact HAR files before sharing them or committing them to source control.

The recorder processes and exports data locally. It does not upload recordings
to a BreakTest service.

## Uploaded file content

While recording, the extension reads files selected in file inputs, dropped into
the recorded tab, or observed in a DOM `formdata` event. Existing file selections
are also captured when recording starts. This includes files selected but never
submitted. File bytes stay local and are included in the exported HAR at
`log._breaktest.uploadCapture.files`.

Each record contains `fileName`, `mimeType`, `size` (original byte count),
`fieldName`, `source`, `pageUrl`, `frameId`, `transactionId` (when available),
`capturedDateTime`, and `status`. A complete record has `encoding: "base64"` and
`content`: decode that string as base64 to recover the exact original file,
including binary files and empty files. An unavailable record has a `reason`
and no `content`. The original network request body is not rewritten.

Capture is limited to 20 MiB per file, 64 MiB total original file bytes per
recording, and 1,000 file records. The HAR reports size-limit failures,
interrupted reads/transfers, and the file-count limit explicitly. Export waits
up to five seconds for transfers already accepted by the recorder. Navigation
can interrupt a transfer. Same-file observations may appear more than once if
the browser supplies different File objects; filenames are not unique IDs.

This is a file inventory, not a claim that a file was sent or a mapping to an
HTTP request. Importers must explicitly support this custom field; existing
HAR consumers can ignore it. It does not capture arbitrary programmatically
created fetch/XHR Blob bodies, worker-generated files, inaccessible closed
shadow roots, or files on pages where the browser blocks content scripts.
A `formdata` event on a detached form is also outside the document listener.
Select/drop the original file again during a new recording to recover content
that was absent from an older HAR.

The `scripting` and host permissions let the isolated content script read files
in the recorded tab and its accessible frames. It asks the background recorder
whether that tab is recording before reading any bytes, and does not send file
contents to the page or any external service.
