// Controllable SSE server shared by real-browser recorder tests.
module.exports = function createSsePeer() {
  const clients = new Set();
  return {
    handle(req, res) {
      if (req.url.startsWith('/sse')) {
        res.writeHead(200, {'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-SSE-Test': 'captured'});
        clients.add(res);
        res.on('close', () => clients.delete(res));
        const bytes = Buffer.from(': heartbeat\r\nid: 42\r\nevent: update\r\ndata: hé🌍\r\ndata: line2\r\n\r\n');
        const split = bytes.indexOf(0xf0) + 1;
        res.write(bytes.subarray(0, split));
        setImmediate(() => { if (!res.destroyed) res.write(bytes.subarray(split)); });
        return true;
      }
      if (req.url === '/release-sse') {
        for (const client of clients) client.write('data: second\n\n');
        res.end('released');
        return true;
      }
      return false;
    },
    close() { for (const client of clients) client.end(); }
  };
};
