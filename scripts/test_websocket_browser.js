#!/usr/bin/env node
// Real extension smoke test. Set CHROMIUM_PATH to an extension-capable Chromium.
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

async function main() {
  assert.ok(process.env.CHROMIUM_PATH, 'Set CHROMIUM_PATH to Chromium executable');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'breaktest-ws-'));
  const sockets = new Set();
  const ssePeer = require('./sse_test_peer')();
  const server = http.createServer((req, res) => { if (!ssePeer.handle(req, res)) res.end('<!doctype html><title>WebSocket test</title>'); });
  require('./websocket_test_peer')(server, sockets);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const extension = path.resolve(__dirname, '../chrome');
  const child = spawn(process.env.CHROMIUM_PATH, [
    '--headless=new', '--no-first-run', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, `--disable-extensions-except=${extension}`,
    `--load-extension=${extension}`, 'about:blank'
  ], {stdio: ['ignore', 'ignore', 'pipe']});
  let ws;
  try {
    const endpoint = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('Chromium launch timed out')), 15000);
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.stderr.on('data', chunk => {
        output += chunk;
        const match = output.match(/DevTools listening on (ws:\/\/\S+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
    });
    ws = new WebSocket(endpoint);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    const pending = new Map();
    let id = 0;
    ws.onmessage = event => {
      const message = JSON.parse(event.data);
      if (!pending.has(message.id)) return;
      const {resolve, reject, timer} = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(timer);
      message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result);
    };
    const command = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const requestId = ++id;
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`Timed out: ${method}`)); }, 15000);
      pending.set(requestId, {resolve, reject, timer});
      ws.send(JSON.stringify({id: requestId, method, params, ...(sessionId ? {sessionId} : {})}));
    });
    const evaluate = async (sessionId, expression) => {
      const result = await command('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true}, sessionId);
      assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    let worker;
    for (let i = 0; i < 50 && !worker; i++) {
      worker = (await command('Target.getTargets')).targetInfos.find(t => t.type === 'service_worker' && t.url.endsWith('/service-worker.js'));
      if (!worker) await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(worker, 'Extension service worker loaded');
    const workerSession = (await command('Target.attachToTarget', {targetId: worker.targetId, flatten: true})).sessionId;
    const url = `http://127.0.0.1:${server.address().port}/`;
    const pageId = (await command('Target.createTarget', {url})).targetId;
    const pageSession = (await command('Target.attachToTarget', {targetId: pageId, flatten: true})).sessionId;
    await evaluate(pageSession, "window.originalWebSocket = WebSocket; window.originalWebSocketClose = WebSocket.prototype.close");
    await evaluate(workerSession, `(async () => {
      let tab;
      for (let i = 0; i < 50 && !tab; i++) {
        tab = (await chrome.tabs.query({})).find(t => t.url === ${JSON.stringify(url)} && t.status === 'complete');
        if (!tab) await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (!tab) throw new Error('Local test page did not finish loading');
      await startRecording({tabId: tab.id, transactionName: 'WebSocket test'});
    })()`);
    await evaluate(pageSession, `new Promise((resolve, reject) => {
      const socket = window.testSocket = new WebSocket(${JSON.stringify(url.replace('http:', 'ws:'))});
      let count = 0;
      socket.onerror = reject;
      socket.onopen = () => { socket.send('client hello'); socket.send(new Uint8Array([0, 255, 128])); };
      socket.onmessage = () => { if (++count === 2) resolve(true); };
    })`);
    await evaluate(pageSession, `(async () => {
      for (const kind of ['client-close', 'server-close', 'abort']) {
        await new Promise(resolve => {
          const socket = new WebSocket(${JSON.stringify(url.replace('http:', 'ws:'))} + kind);
          socket.onopen = () => { if (kind === 'client-close') socket.close(1000, 'done'); };
          socket.onclose = resolve;
        });
      }
    })()`);
    await evaluate(pageSession, `new Promise((resolve, reject) => {
      const source = window.testEventSource = new EventSource('/sse');
      source.onerror = reject;
      source.addEventListener('update', resolve, {once: true});
      window.secondSse = new Promise(done => source.onmessage = done);
    })`);
    await evaluate(pageSession, `(async () => {
      const response = await fetch('/sse?fetch');
      const reader = response.body.getReader();
      window.fetchSseReader = reader;
      let text = '';
      const decoder = new TextDecoder();
      while (!text.includes('line2')) text += decoder.decode((await reader.read()).value, {stream: true});
    })()`);
    await evaluate(workerSession, "startTransaction('Second transaction')");
    await evaluate(pageSession, `(async () => {
      testSocket.send('second transaction send');
      await fetch('/release-sse');
      await secondSse;
      await fetchSseReader.read();
    })()`);
    const har = await evaluate(workerSession, `(async () => {
      const result = await stopRecording();
      return JSON.parse(await (await HarExportStore.get(result.export.id)).blob.text());
    })()`);
    assert.equal(await evaluate(pageSession, 'WebSocket === window.originalWebSocket && WebSocket.prototype.close === window.originalWebSocketClose'), true, 'Stop restores page APIs');
    const entry = har.log.entries.find(e => e._resourceType === 'WebSocket');
    assert.ok(entry, 'WebSocket handshake exported');
    assert.equal(entry.response.status, 101);
    const responseHeaders = entry.response.headers;
    const header = name => responseHeaders.filter(item => item.name.toLowerCase() === name).map(item => item.value);
    assert.deepEqual(header('upgrade'), ['websocket']);
    assert.deepEqual(header('connection'), ['Upgrade']);
    assert.equal(header('sec-websocket-accept').length, 1);
    assert.deepEqual(header('x-recorder-handshake'), ['captured']);
    assert.deepEqual(header('set-cookie'), ['ws_first=one; Path=/', 'ws_second=two; Path=/']);
    assert.equal(entry._breaktest.webSocket.captureEnd, 'recording-stopped');
    const messages = entry._webSocketMessages;
    for (const [type, opcode, data] of [['send', 1, 'client hello'], ['receive', 1, 'hello'], ['send', 2, 'AP+A'], ['receive', 2, 'AP+A']]) {
      assert.ok(messages.some(m => m.type === type && m.opcode === opcode && m.data === data), JSON.stringify(messages));
    }
    assert.ok(messages.every(m => Math.abs(m.time * 1000 - Date.now()) < 30000));
    for (const [kind, initiator] of [['client-close', 'client'], ['server-close', 'server'], ['abort', 'unknown']]) {
      const closed = har.log.entries.find(e => e.request.url.endsWith('/' + kind));
      assert.equal(closed._breaktest.webSocket.closed, true);
      assert.equal(closed._breaktest.webSocket.closeInitiator, initiator, JSON.stringify(closed));
    }
    assert.equal(messages.find(m => m.data === 'client hello')._breaktest.transactionId, 'transaction-1');
    assert.equal(messages.find(m => m.data === 'second transaction send')._breaktest.transactionId, 'transaction-2');
    for (const suffix of ['/sse', '/sse?fetch']) {
      const stream = har.log.entries.find(e => e.request.url.endsWith(suffix));
      assert.ok(stream?._serverSentEvents, JSON.stringify(stream));
      assert.deepEqual(stream._serverSentEvents.map(e => [e.data, e.eventName, e.eventId, e._breaktest.transactionId]), [
        ['hé🌍\nline2', 'update', '42', 'transaction-1'], ['second', 'message', '42', 'transaction-2']
      ]);
      assert.ok(stream._serverSentEvents.every(e => Number.isFinite(e.time)));
      assert.equal(stream._breaktest.sse.captureIncomplete, undefined, JSON.stringify(stream._breaktest.sse));
    }
    console.log('Chromium extension: handshake, per-message transactions, EventSource/fetch SSE, disconnects, cleanup and HAR passed');
  } finally {
    ws?.close();
    child.kill();
    await new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve));
    ssePeer.close();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(profile, {recursive: true, force: true});
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
