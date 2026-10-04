#!/usr/bin/env node
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {context, resetRecording} = require('./test_chrome_request_metadata');
const run = code => vm.runInContext(code, context);
const event = (name, params = {}, sessionId) => context.handleDebuggerEvent(
  {tabId: 1, ...(sessionId ? {sessionId} : {})}, `Network.webSocket${name}`,
  {requestId: 'socket', ...params}
);
async function open(sessionId, status = 101) {
  await event('Created', {url: 'wss://example.test/chat?room=1'}, sessionId);
  await event('WillSendHandshakeRequest', {
    timestamp: 10, wallTime: 1800000000,
    request: {headers: {Upgrade: 'websocket', Cookie: 'session=secret'}}
  }, sessionId);
  await event('HandshakeResponseReceived', {
    timestamp: 10.25,
    response: {status, statusText: status === 101 ? 'Switching Protocols' : 'Forbidden',
      headers: {Upgrade: 'websocket', 'Sec-WebSocket-Protocol': 'chat'}}
  }, sessionId);
}
async function testResponseHeaderOrdering() {
  const source = {tabId: 1};
  for (const order of ['before', 'after', 'after-close', 'during-stop']) {
    resetRecording();
    const extra = () => context.responseExtraInfo(source, {
      requestId: 'socket', statusCode: 101,
      headers: {'X-Handshake-Token': 'token', 'Set-Cookie': 'first=1\nsecond=2'}
    });
    if (order === 'before') extra();
    await open();
    if (order === 'after-close') await event('Closed', {timestamp: 12});
    if (order === 'during-stop') {
      run('recording.stopping = true');
      await context.handleDebuggerEvent(source, 'Network.responseReceivedExtraInfo', {
        requestId: 'socket', statusCode: 101,
        headers: {'X-Handshake-Token': 'token', 'Set-Cookie': 'first=1\nsecond=2'}
      });
    } else if (order !== 'before') extra();
    const headers = run('buildHar(recording).log.entries[0].response.headers');
    assert.equal(headers.find(h => h.name === 'X-Handshake-Token')?.value, 'token', order);
    assert.deepEqual(Array.from(headers.filter(h => h.name === 'Set-Cookie'), h => h.value), ['first=1', 'second=2']);
    assert.equal(headers.find(h => h.name === 'Sec-WebSocket-Protocol')?.value, 'chat');
  }
  resetRecording();
  await event('Created', {url: 'wss://example.test/raw'});
  await event('WillSendHandshakeRequest', {timestamp: 10, wallTime: 1800000000, request: {headers: {}}});
  await event('HandshakeResponseReceived', {timestamp: 11, response: {
    status: 101, headers: {}, headersText: 'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nX-Handshake-Token: a:b\r\nSet-Cookie: first=1\r\nSet-Cookie: second=2\r\n\r\n'
  }});
  let entry = run('recording.entries[0]');
  assert.equal(entry.response.headers.find(h => h.name === 'X-Handshake-Token')?.value, 'a:b');
  assert.equal(entry.response.headers.filter(h => h.name === 'Set-Cookie').length, 2);
  const exportedResponse = entry.response;
  await event('HandshakeResponseReceived', {timestamp: 11.1, response: {status: 101, headers: {'X-Later': 'retained'}}});
  assert.equal(entry.response, exportedResponse, 'late response metadata updates the exported object');
  assert.equal(entry.response.headers.find(h => h.name === 'X-Later')?.value, 'retained');
  context.responseReceived(source, {requestId: 'socket', timestamp: 11.2, response: {status: 101, headers: {}}});
  assert.equal(entry.response.headers.find(h => h.name === 'Upgrade')?.value, 'websocket', 'empty later metadata cannot erase headers');
}

async function main() {
  await testResponseHeaderOrdering();
  resetRecording();
  await open();
  assert.equal(run('recording.entries.length'), 1, 'handshake appears before closing');
  await event('FrameSent', {timestamp: 11, response: {opcode: 1, payloadData: 'hello 🌍'}});
  await event('FrameReceived', {timestamp: 12, response: {opcode: 2, payloadData: 'AP+A'}});
  await event('FrameReceived', {timestamp: 13, response: {opcode: 1, payloadData: ''}});
  await event('Closed', {timestamp: 14});
  let entry = run('buildHar(recording).log.entries[0]');
  assert.equal(entry.request.url, 'wss://example.test/chat?room=1');
  assert.equal(entry.request.headers.find(h => h.name === 'Cookie').value, 'session=secret');
  assert.equal(entry.response.status, 101);
  assert.equal(entry.response.headers.find(h => h.name === 'Sec-WebSocket-Protocol').value, 'chat');
  assert.equal(entry.time, 250, 'timings measure handshake, not socket lifetime');
  assert.deepEqual(Array.from(entry._webSocketMessages, m => [m.type, m.time, m.opcode, m.data]), [
    ['send', 1800000001, 1, 'hello 🌍'], ['receive', 1800000002, 2, 'AP+A'],
    ['receive', 1800000003, 1, '']
  ]);
  assert.equal(entry._webSocketMessages[1]._encoding, 'base64');
  assert.equal(entry._breaktest.webSocket.closedTime, 1800000004);
  assert.equal(entry._breaktest.webSocket.closeInitiator, 'unknown');
  assert.equal(run('recording.activeRequests.size'), 0);
  assert.equal(run('recording.transactions[0].requestCount'), 1);

  for (const [first, initiator] of [['FrameSent', 'client'], ['FrameReceived', 'server']]) {
    resetRecording();
    await open();
    run('recording.activeRequests.values().next().value.webSocketChars = MAX_WEBSOCKET_CHARS');
    run("Object.assign(recording.entries[0]._breaktest.webSocket, {closeInitiator: 'server', closeInitiatorSource: 'clean-close-without-client-request', closeInitiatorInferred: true})");
    await event(first, {timestamp: 11, response: {opcode: 8, payloadData: 'A+g='}});
    await event(first === 'FrameSent' ? 'FrameReceived' : 'FrameSent', {timestamp: 12, response: {opcode: 8, payloadData: 'A+g='}});
    await event('Closed', {timestamp: 13});
    assert.equal(run('recording.entries[0]._breaktest.webSocket.closeInitiator'), initiator);
    assert.equal(run('recording.entries[0]._breaktest.webSocket.closeInitiatorSource'), 'first-close-frame');
    assert.equal(run('recording.entries[0]._breaktest.webSocket.closeInitiatorInferred'), undefined);
  }

  // Lifecycle observations arriving before or after native close remain paired.
  resetRecording();
  await open();
  const lifecycle = run('recording.webSocketLifecycle');
  const time = run('recording.webSocketLifecycle.states[0].webSocketWallTime');
  const lifecycleEvent = event => context.webSocketLifecycleEvent(run('recording'), {tabId: 1}, {
    name: lifecycle.binding, executionContextId: 1, payload: JSON.stringify({id: 1, time, ...event})
  });
  lifecycleEvent({event: 'created', url: 'wss://example.test/chat?room=1'});
  await event('Closed', {timestamp: 13});
  lifecycleEvent({event: 'closed', code: 1000, reason: 'done', wasClean: true});
  assert.equal(run('recording.entries[0]._breaktest.webSocket.closeInitiator'), 'server');
  assert.equal(run('recording.entries[0]._breaktest.webSocket.closeInitiatorInferred'), true);
  lifecycleEvent({event: 'close-requested'});
  assert.equal(run('recording.entries[0]._breaktest.webSocket.closeInitiator'), 'server', 'late close calls are not initiators');

  resetRecording();
  await open();
  await open('child');
  await event('FrameSent', {timestamp: 11, response: {opcode: 1, payloadData: 'child'}}, 'child');
  assert.equal(run('recording.entries[0]._webSocketMessages.length'), 0);
  assert.equal(run('recording.entries[1]._webSocketMessages[0].data'), 'child');
  let exported;
  context.HarExportStore.save = async har => { exported = har; return {id: 'export'}; };
  await context.stopRecording();
  assert.equal(exported.log.entries.length, 2);
  assert.equal(exported.log.entries[1]._breaktest.webSocket.captureEnd, 'recording-stopped');
  assert.equal(exported.log.entries[1]._breaktest.incomplete, false);
  await event('FrameSent', {timestamp: 12, response: {opcode: 1, payloadData: 'late'}});
  assert.equal(exported.log.entries[0]._webSocketMessages.length, 0);

  resetRecording();
  await open();
  await event('FrameReceived', {timestamp: 11, response: {opcode: 2, payloadData: 'AAAA'.repeat(600000)}});
  entry = run('recording.entries[0]');
  assert.equal(entry._webSocketMessages[0].data.length % 4, 0);
  assert.equal(entry._webSocketMessages[0]._truncated, true);
  assert.equal(entry._breaktest.webSocket.messagesTruncated, true);
  run('recording.activeRequests.values().next().value.webSocketMessages.length = MAX_WEBSOCKET_MESSAGES');
  await event('FrameSent', {timestamp: 12, response: {opcode: 1, payloadData: 'overflow'}});
  assert.equal(entry._breaktest.webSocket.droppedMessages, 1);

  resetRecording();
  await open();
  run('startTransactionInternal("Next")');
  context.renameTransaction('t1', 'Renamed');
  assert.equal(run('recording.entries[0]._breaktest.transactionName'), 'Renamed');
  context.deleteTransaction('t1', 'next');
  await event('FrameSent', {timestamp: 11, response: {opcode: 1, payloadData: 'still recording'}});
  assert.equal(run('recording.entries[0]._breaktest.transactionId'), 'transaction-2');
  assert.equal(run('recording.entries[0]._webSocketMessages.length'), 1);
  run('startTransactionInternal("Third")');
  context.deleteTransaction('transaction-2', 'delete');
  await event('FrameSent', {timestamp: 12, response: {opcode: 1, payloadData: 'discarded'}});
  await event('Closed', {timestamp: 13});
  assert.equal(run('recording.entries.length'), 0);

  resetRecording();
  await open();
  await event('FrameError', {timestamp: 11, errorMessage: 'Connection reset'});
  assert.equal(run('recording.entries[0]._breaktest.failed'), true);
  assert.equal(run('recording.entries[0]._breaktest.failureText'), 'Connection reset');

  resetRecording();
  await event('Created', {url: 'ws://example.test/pending'});
  await event('WillSendHandshakeRequest', {timestamp: 10, wallTime: 1800000000, request: {headers: {}}});
  await context.stopRecording();
  assert.equal(exported.log.entries[0]._breaktest.incomplete, true);
  assert.equal(exported.log.entries[0].response.status, 0);

  resetRecording();
  await open();
  run('recording.activeRequests.values().next().value.webSocketChars = MAX_WEBSOCKET_CHARS');
  await event('FrameSent', {timestamp: 11, response: {opcode: 1, payloadData: 'too much'}});
  assert.equal(run('recording.entries[0]._webSocketMessages.length'), 0);
  assert.equal(run('recording.entries[0]._breaktest.webSocket.droppedMessages'), 1);

  resetRecording();
  await open(undefined, 403);
  await event('FrameError', {timestamp: 11, errorMessage: 'Handshake failed'});
  await event('Closed', {timestamp: 12});
  entry = run('recording.entries[0]');
  assert.equal(entry._breaktest.failed, true);
  assert.equal(entry._breaktest.webSocket.error, 'Handshake failed');
  assert.equal(entry._webSocketMessages.length, 0);
  console.log('WebSocket capture tests passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
