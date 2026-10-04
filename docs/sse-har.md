# SSE HAR extension, version 1

An HTTP response with MIME type `text/event-stream` retains its normal HAR request,
response headers, and timings. Incoming complete SSE events are stored in the
custom `entry._serverSentEvents` array. This records data for future BreakTest
support; it does not implement playback.

```json
{
  "_serverSentEvents": [
    {
      "type": "receive",
      "time": 1800000001.125,
      "eventName": "update",
      "eventId": "42",
      "data": "hello\nworld",
      "_breaktest": {"transactionId": "transaction-2"}
    }
  ]
}
```

`time` is Unix epoch seconds with a fractional part. `eventName` defaults to
`message`. `eventId` is the last SSE ID, including persistence across events and
an explicit empty-ID reset; it is independent of the BreakTest transaction ID.
`data` preserves decoded UTF-8 text and joins multiple data lines with newlines.
Comments and retry instructions are not messages. Empty data events are retained.
An event is emitted only after its terminating blank line. A partial final event
is not exported as a complete message.

Each message's transaction ID is selected using its timestamp and the transaction
start times. The HTTP entry itself belongs to the transaction that started the
request. Reassigning a transaction updates its message IDs; deleting its requests
removes its messages. Deleting the stream's opening request removes the entire
entry, including messages from later transactions. Delayed events respect these
edits. Transaction start times have millisecond resolution; ties use the most
recently started transaction.

## Sources and timestamps

Chrome and Edge use native debugger `Network.eventSourceMessageReceived` events
for `EventSource`, preserving the browser event timestamp. For fetch streams they
use `Network.streamResourceContent` and parse the incoming chunks. Firefox parses
bytes from `webRequest.filterResponseData` for both paths. Each parsed event is
timestamped when its final chunk arrives, so events completed in the same chunk
share a timestamp. Firefox timestamps receipt in the extension.

Chromium can return initial bytes buffered before streaming was enabled. Events
completed in that initial buffer use its retrieval time, and the entry marks
`bufferedTimestampEstimated: true`. Their transaction attribution therefore uses
that estimated time. If the browser does not support the streaming command or
refuses it, the HTTP entry remains and capture is explicitly marked incomplete.
A stream must be requested during recording to be captured. Reconnect requests
produce separate HTTP entries; parsing starts with the request's `Last-Event-ID`
header when present.

## Limits and completeness

`entry._breaktest.sse` contains `formatVersion: 1`, `source`, `captureEnd`,
`messagesTruncated`, and `droppedMessages`. Source is one of
`chrome.debugger.EventSource`, `chrome.debugger.response-stream`, or
`firefox.webRequest.response-stream`. Capture ends as `stream-ended`,
`request-failed`, or `recording-stopped`. Stopping recording does not disconnect
the application's stream.

Capture is bounded to 10,000 events and 16 Mi UTF-16 data characters per response,
with a 2 Mi character per-event limit. Native Chromium events can be truncated
with `_truncated` and `_originalLength`. The streaming parser drops oversized
events and resumes at the next event boundary. Event name and ID are capped at
4,096 characters, with `_metadataTruncated` when shortened. These conditions set
`messagesTruncated`; dropped events increment `droppedMessages`.

`captureIncomplete` flags unavailable capture or lost input, with `captureError`
when a browser command failed. `partialEventAtEnd` identifies unfinished input at
EOF or recording stop. SSE capture limits are independent of normal HTTP body
capture limits. A saved HTTP body may therefore be truncated even when the event
array contains all events. Message contents can contain application secrets, as
can other HAR bodies.
