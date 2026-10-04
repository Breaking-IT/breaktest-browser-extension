# BreakTest Browser Recorder 1.3.0

- Record WebSocket request and response handshake headers, incoming/outgoing text and binary messages, and disconnect metadata.
- Store a transaction ID on each streaming message using its capture timestamp, supporting connections spanning multiple transactions.
- Capture incoming SSE events from EventSource and fetch streams, with timestamps, event names, event IDs, and multiline data.
- Preserve transaction reassignment and deletion behavior for streaming messages.
- Document capture limits and incomplete data explicitly in the HAR.

Available for Chrome, Edge, and Firefox. BreakTest import and playback support is developed separately.
