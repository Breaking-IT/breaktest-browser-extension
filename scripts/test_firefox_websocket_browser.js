#!/usr/bin/env node
// FIREFOX_PATH and WEB_EXT_CLI select Firefox and the installed web-ext CLI.
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
async function main() {
  assert.ok(process.env.FIREFOX_PATH && process.env.WEB_EXT_CLI, 'Set FIREFOX_PATH and WEB_EXT_CLI');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'breaktest-firefox-ws-'));
  const extension = path.join(temporary, 'extension');
  fs.cpSync(path.resolve(__dirname, '../firefox'), extension, {recursive: true});
  const sockets = new Set();
  let finish;
  const result = new Promise(resolve => { finish = resolve; });
  const ssePeer = require('./sse_test_peer')();
  const server = http.createServer((req, res) => {
    if (ssePeer.handle(req, res)) return;
    if (req.url === '/result') {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => { finish(JSON.parse(Buffer.concat(chunks))); res.end('ok'); });
    } else { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>WebSocket test</title>'); }
  });
  require('./websocket_test_peer')(server, sockets);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const manifestPath = path.join(extension, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath));
  manifest.background.scripts.push('websocket-browser-test.js');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  fs.writeFileSync(path.join(extension, 'websocket-browser-test.js'), `
    (async () => {
      try {
        let tab;
        for (let i = 0; i < 100 && !tab; i++) {
          tab = (await browser.tabs.query({})).find(t => t.url === ${JSON.stringify(url)} && t.status === 'complete');
          if (!tab) await new Promise(resolve => setTimeout(resolve, 100));
        }
        if (!tab) throw new Error('Test page not loaded');
        await startRecording({tabId: tab.id, transactionName: 'WebSocket test'});
        const pageResult = await browser.scripting.executeScript({target: {tabId: tab.id}, world: 'MAIN', args: [${JSON.stringify(url.replace('http:', 'ws:'))}], func: url => new Promise((resolve, reject) => {
          class TestSocket extends WebSocket {}
          const socket = window.testSocket = new TestSocket(url);
          if (!(socket instanceof TestSocket)) throw new Error("Subclass semantics changed");
          if (!(socket instanceof WebSocket) || WebSocket.OPEN !== 1) throw new Error('Constructor semantics changed');
          let count = 0;
          socket.onerror = () => reject(new Error('WebSocket failed'));
          socket.onopen = () => {
            try {
            socket.send('client hello');
            let conversions = 0;
            socket.send({toString() { conversions++; return 'custom text'; }});
            if (conversions !== 1) throw new Error('Send coerced the payload more than once');
            const buffer = new Uint8Array([0, 255, 128]);
            socket.send(buffer); buffer.fill(1);
            socket.send(new Blob([new Uint8Array([0, 255, 128])]));
            } catch (error) { reject(error); }
          };
          socket.onmessage = () => { if (++count === 2) resolve(true); };
        })});
        if (pageResult[0].error) throw new Error(pageResult[0].error.message);
        await browser.scripting.executeScript({target: {tabId: tab.id}, world: 'MAIN', args: [${JSON.stringify(url.replace('http:', 'ws:'))}], func: async url => {
          for (const kind of ['client-close', 'server-close', 'abort']) {
            await new Promise(resolve => {
              const socket = new WebSocket(url + kind);
              socket.onopen = () => { if (kind === 'client-close') socket.close(1000, 'done'); };
              socket.onclose = resolve;
            });
          }
        }});
        const initSse = await browser.scripting.executeScript({target: {tabId: tab.id}, world: 'MAIN', func: async () => {
          await new Promise((resolve, reject) => {
            const source = window.testEventSource = new EventSource('/sse');
            source.onerror = reject;
            source.addEventListener('update', resolve, {once: true});
            window.secondSse = new Promise(done => source.onmessage = done);
          });
          const reader = (await fetch('/sse?fetch')).body.getReader();
          window.fetchSseReader = reader;
          let text = '';
          const decoder = new TextDecoder();
          while (!text.includes('line2')) text += decoder.decode((await reader.read()).value, {stream: true});
        }});
        if (initSse[0].error) throw new Error(initSse[0].error.message);
        startTransaction('Second transaction');
        const nextSse = await browser.scripting.executeScript({target: {tabId: tab.id}, world: 'MAIN', func: async () => {
          testSocket.send('second transaction send');
          await fetch('/release-sse');
          await secondSse;
          await fetchSseReader.read();
        }});
        if (nextSse[0].error) throw new Error(nextSse[0].error.message);
        const stopped = await stopRecording();
        const har = JSON.parse(await (await HarExportStore.get(stopped.export.id)).blob.text());
        await fetch(${JSON.stringify(url + 'result')}, {method: 'POST', body: JSON.stringify({har})});
      } catch (error) {
        await fetch(${JSON.stringify(url + 'result')}, {method: 'POST', body: JSON.stringify({error: String(error), stack: error.stack})});
      }
    })();
  `);
  const child = spawn(process.execPath, [process.env.WEB_EXT_CLI, 'run', '--source-dir', extension,
    '--firefox', process.env.FIREFOX_PATH, '--no-reload', '--start-url', url, '--args=-headless'],
    {stdio: ['ignore', 'pipe', 'pipe']});
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  let timer;
  try {
    const completed = await Promise.race([result, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Firefox test timed out\n${output}`)), 30000);
      child.on('error', reject);
    })]);
    assert.ok(!completed.error, JSON.stringify(completed));
    const entries = completed.har.log.entries.filter(e => e._webSocketMessages);
    assert.equal(entries.length, 4, JSON.stringify(completed.har));
    const entry = entries.find(e => e.request.url.endsWith('/'));
    assert.equal(entry.response.status, 101, JSON.stringify(entry));
    const responseHeaders = entry.response.headers;
    const header = name => responseHeaders.filter(item => item.name.toLowerCase() === name).flatMap(item => item.value.split("\n"));
    assert.deepEqual(header('upgrade'), ['websocket']);
    assert.deepEqual(header('connection'), ['Upgrade']);
    assert.equal(header('sec-websocket-accept').length, 1);
    assert.deepEqual(header('x-recorder-handshake'), ['captured']);
    assert.deepEqual(header('set-cookie'), ['ws_first=one; Path=/', 'ws_second=two; Path=/']);
    assert.equal(entry._breaktest.webSocket.messagesAvailable, true, JSON.stringify(entry));
    assert.equal(entry._breaktest.webSocket.captureIncomplete, undefined, JSON.stringify(entry));
    for (const [type, opcode, data] of [['send', 1, 'client hello'], ['receive', 1, 'hello'], ['send', 1, 'custom text'], ['send', 2, 'AP+A'], ['receive', 2, 'AP+A']]) {
      assert.ok(entry._webSocketMessages.some(m => m.type === type && m.opcode === opcode && m.data === data), JSON.stringify(entry));
    }
    assert.equal(entry._webSocketMessages.filter(m => m.type === 'send' && m.opcode === 2).length, 2, 'Typed array snapshot and Blob both captured');
    for (const [kind, initiator] of [['client-close', 'client'], ['server-close', 'server'], ['abort', 'unknown']]) {
      const closed = entries.find(e => e.request.url.endsWith('/' + kind));
      assert.equal(closed._breaktest.webSocket.closed, true, JSON.stringify(closed));
      assert.equal(closed._breaktest.webSocket.closeInitiator, initiator, JSON.stringify(closed));
    }
    assert.equal(entry._webSocketMessages.find(m => m.data === 'client hello')._breaktest.transactionId, 'transaction-1');
    assert.equal(entry._webSocketMessages.find(m => m.data === 'second transaction send')._breaktest.transactionId, 'transaction-2');
    for (const suffix of ['/sse', '/sse?fetch']) {
      const stream = completed.har.log.entries.find(e => e.request.url.endsWith(suffix));
      assert.ok(stream?._serverSentEvents, JSON.stringify(stream));
      assert.deepEqual(stream._serverSentEvents.map(e => [e.data, e.eventName, e.eventId, e._breaktest.transactionId]), [
        ['hé🌍\nline2', 'update', '42', 'transaction-1'], ['second', 'message', '42', 'transaction-2']
      ]);
      assert.ok(stream._serverSentEvents.every(e => Number.isFinite(e.time)));
    }
    console.log('Firefox extension: handshake, per-message transactions, EventSource/fetch SSE, Blob snapshots and disconnects passed');
  } finally {
    clearTimeout(timer);
    child.kill('SIGINT');
    await new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve));
    ssePeer.close();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temporary, {recursive: true, force: true});
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
