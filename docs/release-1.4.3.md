# BreakTest Browser Recorder 1.4.3

- **Export a full waterfall as PNG.** Choose **Save as PNG** in a transaction’s waterfall on Chrome, Edge, or Firefox. The image includes rows and columns beyond the visible scroll area and respects the cached-request filter.
- **Export HTTP 304 responses without bodies.** HAR entries for `304 Not Modified` now report zero body bytes and omit cached response content.
- **Preserve Firefox’s original 304 status.** When Firefox reports the server’s `304` and then a cached `200` for the same request, the HAR keeps the `304` and its response headers.
- **Avoid stale debugger warnings in Chrome and Edge.** A page or frame can disappear before the recorder installs its WebSocket hook. Recording continues without showing the stale-context warning.
