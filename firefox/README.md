<!--
  Copyright 2024-2026 Breaking IT

  Licensed under the BreakTest Community Source License 1.0.
  You may not use this file except in compliance with that license.
  See the LICENSE file at the root of this distribution.
-->

# BreakTest Browser Recorder for Firefox

This local developer extension records a Firefox tab as HAR and assigns each
request to a named BreakTest transaction. It is the Firefox counterpart of the
Chrome and Edge extension, using Firefox's native web-request response stream
instead of the Chromium DevTools protocol.

## Requirements

- Firefox 142 or newer.
- A local checkout of this repository containing the `firefox` directory.

## Install temporarily

1. Open `about:debugging#/runtime/this-firefox` in Firefox.
2. Choose **Load Temporary Add-on...**.
3. Select `firefox/manifest.json` from the extension checkout.
4. Open `about:addons`, select **BreakTest Browser Recorder**, and set **Run in
   Private Windows** to **Allow**.
5. Pin **BreakTest Browser Recorder** from Firefox's Extensions menu if desired.

Firefox removes temporary add-ons when the browser exits. Repeat these steps
after restarting Firefox. Changes to the extension source also require using
**Reload** beside the extension on the `about:debugging` page.

## Start recording

Open the page and recorder sidebar, choose the initial transaction name, and
click **Start recording here**. The current page is not reloaded or navigated.
Reload it manually after starting if you want to capture its initial load.
For a fresh private window, enter the **Incognito start URL** and click
**Start in incognito**. The URL field applies only to the private-window action.

The cache option is off by default. Firefox exposes cache control as a global
browser setting, so selecting it temporarily disables the cache for all
Firefox windows and restores the previous browser-controlled state when the
recording finishes. Private windows do not by themselves guarantee a cold
HTTP cache, so use this option when that distinction matters.

## Name and export transactions

The transaction field shows the current transaction. Click **→** on its right
to open **Next transaction**. `01_Openhomepage` suggests `02_`, and
`UC1_01_Homepage` suggests `UC1_02_`; leading zeros and the prefix are preserved.
Names without a numeric counter start at `01_`. Enter a description and press
Enter or **Start transaction**. Cancel or Escape leaves the current transaction
unchanged. Requests stay in the current transaction until confirmation, and
requests already in progress retain their original transaction.

Use the edit icon in the Transactions list to rename a transaction and update
all requests already assigned to it. Use the × button to remove an earlier
transaction, then choose whether to remove its captured and pending requests or
add them to the previous or next transaction. Choices without an available
neighboring transaction are disabled. The active transaction cannot be removed;
start the next transaction first, then remove the earlier one.

Choose **Finish and export** to download the HAR. In BreakTest, use
**File > Import HAR...** and select that file. BreakTest turns the recorded
names into Transaction Controllers.

Firefox opens its native Save As dialog so you can change the suggested HAR
filename and select a folder. Firefox sidebars are window-wide, so the recorder
remains visible when you switch tabs in the same window. This differs from the
tab-specific recorder panel in Chrome and Edge.

The completed HAR is staged as a browser-local IndexedDB Blob before the Save
As dialog opens. If saving is cancelled or interrupted, choose **Save HAR** to
retry. The pending export survives closing and reopening the sidebar. It is
removed after a successful download, explicit discard, or the next cleanup
after it becomes 24 hours old.

## Private-window recording

Private access is enabled as part of the installation steps above. Open the
recorder in a normal window, enter the start settings, and choose **Start in
private window**. On the launcher page in the new private window, choose **Open
recorder**. Capture starts before the Start URL loads.

Close all existing private windows before starting if you need a fresh private
session. Cookies created during the recording remain available for login flows
until the last private window closes.

## Capture behavior

- Captures HTTP/HTTPS request and response metadata, request bodies, and
  response bodies for the selected tab and its frames.
- Streams each response through Firefox unchanged while retaining up to 2 MiB
  per response for the HAR. Larger individual bodies are marked as truncated;
  there is no recording-wide body limit.
- Captures redirect response streams when Firefox provides them, including
  response bodies on 3xx requests.
- Keeps requests whose bodies Firefox cannot expose and marks them as
  unavailable in `_breaktest` metadata and the live list.
- Stages completed HARs in browser-local IndexedDB, allowing exports larger
  than extension-message transport limits. Available browser storage and
  memory bound the practical recording size.
- Exports locally and does not upload recordings to a BreakTest service.
- Does not convert individual WebSocket frames into JMeter samplers.

## Troubleshooting

If an internal Firefox page cannot be recorded, enter an HTTP or HTTPS Start
URL and use **Start in incognito**. If the private launcher cannot start, verify
**Run in Private Windows** is allowed, close the private window, reload the
temporary add-on, and try again.

HAR files may contain credentials, cookies, tokens, personal data, and response
content. Record only authorized systems and review files before sharing them.

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
