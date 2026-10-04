# WebSocket HAR extension, version 1

Chrome/Edge capture uses the browser's [DevTools Network events](https://chromedevtools.github.io/devtools-protocol/tot/Network/).
HAR stays at version 1.2; additional fields use underscore prefixes. This is
recording data for future BreakTest WebSocket support, not an executable test.
Firefox combines native `webRequest` handshake capture with an isolated content
script hooking the page's WebSocket API. Both implementations export the same
message fields. Firefox-specific coverage metadata is described below.

## Connection entry

A connection creates one entry with `_resourceType: "WebSocket"` (Chromium) or `"websocket"` (Firefox), a GET request
with the original `ws://` or `wss://` URL and handshake request headers, and the
handshake response status and headers in the standard `response.headers` array.
Chromium preserves headers supplied by the handshake event, raw header text, or
separate response metadata, including updates arriving after the entry is created
or while stopping. Repeated response headers are retained. `startedDateTime` uses the handshake's
wall clock. `time` and `timings` measure the handshake, not the socket lifetime.
Message bytes are not an HTTP response body. A handshake without a response at
recording stop is marked `_breaktest.incomplete`.

The connection entry belongs to its opening transaction. Each message separately
stores `_breaktest.transactionId`: the transaction whose start time is the latest
at or before the message's capture timestamp. Delayed processing (for example,
reading a Firefox Blob) does not move a message into a later transaction.
Renaming preserves IDs; reassignment updates affected message IDs. Deleting a
transaction's requests removes its messages even from connections opened earlier.
Deleting the opening request removes the whole connection, including later
messages. No playback semantics are implied.

## Messages

`entry._webSocketMessages` is an ordered array in browser event arrival order:

```json
[
  {"type": "send", "time": 1800000001.125, "opcode": 1, "data": "hello", "_breaktest": {"transactionId": "transaction-1"}},
  {"type": "receive", "time": 1800000001.25, "opcode": 2, "data": "AP+A", "_encoding": "base64", "_breaktest": {"transactionId": "transaction-2"}}
]
```

- `type`: `send` (outgoing) or `receive` (incoming).
- `time`: Unix epoch seconds, derived from the handshake wall clock and the
  browser's monotonic event timestamp. Fractional seconds are preserved.
- `_breaktest.transactionId`: transaction active at capture time.
- `opcode`: the opcode reported by DevTools. Opcode 1 carries text; other opcodes
  carry base64 data, following the DevTools payload representation.
- `data`: captured payload, including empty messages. No JSON parsing or decoding
  changes the payload.
- `_encoding`: `base64` for non-text payloads; omitted for text.
- `_truncated`: present and true when a payload was shortened.
- `_originalLength`: original payload string length before truncation (UTF-16
  code units for text, base64 characters otherwise).

Capture is limited to 2 Mi characters per message, 16 Mi characters per
connection, and 10,000 messages per connection. Base64 truncation preserves
four-character boundaries; text truncation preserves surrogate pairs.

## Lifecycle and completeness

`entry._breaktest.webSocket` contains:

- `formatVersion`: `1`.
- `closed`: whether the browser reported a socket close.
- `closedTime`: Unix epoch seconds of close, when observed.
- `closeInitiator`: `client`, `server`, or `unknown`. It stays `unknown` until
  attribution is available; consult `closed` to distinguish an open/closing
  connection from an observed disconnect.
- `closeInitiatedTime`: Unix epoch seconds of the first observed close request
  or close frame, when available.
- `closeInitiatorSource`: `first-close-frame`, `page-close-call`, or
  `clean-close-without-client-request`, when attribution is available.
- `closeInitiatorInferred`: true for a server attribution based on a clean close
  without an observed client `close()` call.
- `closeCode`, `closeReason`, `wasClean`: browser CloseEvent information, when
  the page lifecycle hook observes the close.
- `captureEnd`: `socket-closed`, `recording-stopped`, or `debugger-detached`.
- `messagesTruncated`: true if any payload was shortened or messages were dropped.
- `droppedMessages`: number of messages omitted after a capture limit was reached.
- `error`: browser-reported WebSocket error, when present.

An open socket at recording stop is not a failed handshake. Consumers must check
lifecycle and truncation metadata before attempting future playback. Sockets
opened before capture starts are ignored; reload the page during recording to
capture their handshake and messages. Capture covers debugger targets attached
by the recorder, and cannot recover traffic during debugger disconnections.
In Chromium, control frames are retained only when surfaced by the browser; the data is not
a raw wire trace. Binary payloads are not decoded and close codes are not inferred.

## Disconnect attribution

Both implementations track successful page `WebSocket.close()` calls made before
the socket enters CLOSING/CLOSED. Invalid calls and repeated calls while already
closing do not change the initiator. Chrome/Edge use a small CDP-installed
lifecycle hook; their message payloads still come exclusively from Network events.
Firefox uses its existing page API hook. These hooks preserve native close
argument validation and return behavior.

If Chromium exposes close frames, the first observed close frame takes precedence:
outgoing means client, incoming means server, and the acknowledgement does not
replace that direction. Chromium does not consistently expose those control
frames, so the lifecycle hook supplies attribution for ordinary page sockets.

A clean close with no observed client close request or preceding error is recorded
as an **inferred** server close. This is evidence from the captured page API,
not proof of the original backend process or a network-level trace. Proxies,
bypassed/overridden hooks, concurrent close attempts, and automatic browser
shutdown can limit attribution. Abrupt failures without a local close request
remain `unknown`, rather than being guessed to be a server disconnect.

The Chromium lifecycle hook is correlated with native connections by target,
URL and creation order within one second, so identical concurrent connections
can be ambiguous if their native events reorder. Hooks are removed when recording
stops or is discarded. `log._breaktest.webSocketLifecycleError` reports installation
failure. Worker/frame attribution is available only where the hook could be installed.

Ending the recording, losing the debugger, or unloading a document does not by
itself prove that a socket disconnected. Those conditions remain capture-end
metadata; `closed` is set only from an observed disconnect.

## Firefox coverage

`log._breaktest.webSocketCapture` reports `source: "page-websocket-api"`,
`scope: "documents-and-frames"`, `workerMessagesAvailable: false`, and
`controlFramesAvailable: false`. Installation or flush errors are reported here.
No additional permissions are required.

Each native WebSocket handshake has a message array, even when page capture is
unavailable. `entry._breaktest.webSocket.messagesAvailable` distinguishes a
captured connection with no messages from a connection whose messages could not
be observed. `source` identifies the page API capture path.

Handshakes and page sockets are matched in creation order by frame, URL,
document ID when available, and a one-second creation-time window. This is a
correlation rather than a browser-provided shared connection ID; concurrent
identical-URL connections whose handshake events reorder can be ambiguous.
Worker-created sockets, sockets opened before recording, pages that replace or
bypass the hooked API, and inaccessible frames cannot provide message coverage.

Firefox captures application messages (text, ArrayBuffer, typed-array views, and
Blob payloads), not raw protocol frames, fragmentation, ping, or pong. Binary
content is exported in base64, and mutable send buffers are snapshotted before
control returns to the page. Payload conversion and storage are serialized per
connection to preserve send/receive event order.

Additional lifecycle fields include `closeCode`, `closeReason`, and
`captureEnd: "document-unloaded"` with `captureEndTime` when page teardown is
observed. `captureIncomplete` and `captureError` identify failed payload reads or
flushes. Navigation may destroy a script before queued payloads reach the
background, so application-message capture is not a lossless wire trace.
Recording stop drains queued payloads and native handshake callbacks for up to
five seconds; unfinished capture is marked explicitly.

## Validation

`python3 scripts/validate_extensions.py` includes deterministic WebSocket event
tests. To exercise the real extension against a local WebSocket server, use an
extension-capable Chromium build and Node 22 or newer:

```sh
CHROMIUM_PATH=/path/to/chromium node scripts/test_websocket_browser.js
```

The browser test uses a temporary profile and verifies the staged HAR after
sending and receiving text and binary payloads.

For a real Firefox extension test, provide Firefox and an installed web-ext CLI:

```sh
FIREFOX_PATH=/path/to/firefox WEB_EXT_CLI=/path/to/web-ext/bin/web-ext.js node scripts/test_firefox_websocket_browser.js
```

This verifies native handshake metadata, messages in both directions, binary
Blob payloads, mutable buffer snapshots, subclasses, and single string coercion.
