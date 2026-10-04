// Minimal local WebSocket peer for recorder browser tests. No external services.
const {createHash} = require('node:crypto');
module.exports = function attachPeer(server, sockets) {
  server.on('upgrade', (req, socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nX-Recorder-Handshake: captured\r\nSet-Cookie: ws_first=one; Path=/\r\nSet-Cookie: ws_second=two; Path=/\r\n\r\n`);
    let closing = req.url === '/server-close';
    let buffered = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 2) {
        let size = buffered[1] & 127;
        let offset = 2;
        if (size === 126) {
          if (buffered.length < 4) return;
          size = buffered.readUInt16BE(2); offset = 4;
        } else if (size === 127) {
          if (buffered.length < 10) return;
          size = Number(buffered.readBigUInt64BE(2)); offset = 10;
        }
        const masked = Boolean(buffered[1] & 128);
        const frameSize = offset + (masked ? 4 : 0) + size;
        if (buffered.length < frameSize) return;
        if ((buffered[0] & 15) === 8) {
          if (!closing) socket.write(Buffer.from([0x88, 2, 0x03, 0xe8]));
          closing = true;
          socket.end();
        }
        buffered = buffered.subarray(frameSize);
      }
    });
    if (closing) socket.write(Buffer.from([0x88, 2, 0x03, 0xe8]));
    else if (req.url === '/abort') socket.destroy();
    else {
      socket.write(Buffer.concat([Buffer.from([0x81, 5]), Buffer.from('hello')]));
      socket.write(Buffer.from([0x82, 3, 0, 255, 128]));
    }
  });
};
