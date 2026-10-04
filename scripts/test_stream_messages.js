#!/usr/bin/env node
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {context, resetRecording} = require('./test_chrome_request_metadata');
const run = code => vm.runInContext(code, context);
const {MessageCapture, SseCapture} = context;
function session() {
  const owner = {transactions: [], entries: []};
  for (const [id, time] of [['one', 1000], ['two', 2000], ['three', 3000]]) {
    const transaction = {id, startedDateTime: new Date(time).toISOString()};
    owner.transactions.push(transaction);
    owner.currentTransaction = transaction;
    MessageCapture.startTransaction(owner, transaction);
  }
  return owner;
}
async function main() {
  const owner = session();
  for (const [time, expected] of [[1.1, 'one'], [2, 'two'], [2.9, 'two'], [3.1, 'three']]) {
    const message = {time};
    assert.equal(MessageCapture.tag(owner, message), true);
    assert.equal(message._breaktest.transactionId, expected, 'capture time, not processing time');
  }
  const state = {};
  SseCapture.init(state, 'test');
  const parser = SseCapture.parser(owner, state);
  const wire = Buffer.from('\uFEFF: heartbeat\r\nid: 42\r\nevent: update\r\ndata: hé🌍\r\ndata: line2\r\n\r\n');
  // Splitting every byte covers UTF-8, BOM, CRLF and event boundaries.
  for (const byte of wire) parser.feed(Uint8Array.of(byte), 1.5);
  parser.feed(Buffer.from('data: next\n\nid:\n\ndata:\n\n'), 2.5);
  parser.feed(Buffer.from('id: bad\0id\ndata: last\n\n'), 3.5);
  assert.deepEqual(Array.from(state.serverSentEvents, event => [event.data, event.eventName, event.eventId, event.time, event._breaktest.transactionId]), [
    ['hé🌍\nline2', 'update', '42', 1.5, 'one'], ['next', 'message', '42', 2.5, 'two'],
    ['', 'message', '', 2.5, 'two'], ['last', 'message', '', 3.5, 'three']
  ]);
  parser.feed(Buffer.from('data: unfinished'), 3.9);
  parser.finish();
  assert.equal(state.serverSentEvents.length, 4);
  assert.equal(state.sse.partialEventAtEnd, true);
  owner.entries.push({_serverSentEvents: state.serverSentEvents});
  MessageCapture.removeTransaction(owner, 'two', 'one');
  assert.equal(state.serverSentEvents[1]._breaktest.transactionId, 'one');
  assert.equal(MessageCapture.transactionAt(owner, 2.7), 'one', 'delayed messages follow reassignment');
  MessageCapture.removeTransaction(owner, 'one');
  assert.equal(state.serverSentEvents.length, 1);
  assert.equal(MessageCapture.tag(owner, {time: 1.9}), false, 'delayed deleted messages stay deleted');

  const reconnected = {};
  SseCapture.init(reconnected, 'test');
  const resumed = SseCapture.parser(session(), reconnected, 'previous-id');
  resumed.feed(Buffer.from(': keepalive\r\rdata: resumed\r\r'), 2.2);
  assert.equal(reconnected.serverSentEvents[0].eventId, 'previous-id');
  assert.equal(reconnected.serverSentEvents[0]._breaktest.transactionId, 'two');
  const bounded = {};
  SseCapture.init(bounded, 'test');
  const boundedParser = SseCapture.parser(session(), bounded);
  boundedParser.feed(Buffer.from('data: ' + 'x'.repeat(2 * 1024 * 1024 + 1) + '\n\ndata: valid\n\n'), 1.5);
  assert.equal(bounded.sse.droppedMessages, 1);
  assert.equal(bounded.serverSentEvents[0].data, 'valid');

  resetRecording();
  run(`recording.transactions[0].startedDateTime = new Date(1800000000000).toISOString();
    MessageCapture.startTransaction(recording, recording.transactions[0]);`);
  await context.requestWillBeSent({tabId: 1}, {requestId: 'sse', timestamp: 10, wallTime: 1800000000,
    type: 'EventSource', request: {url: 'https://example.test/events'}});
  await context.responseReceived({tabId: 1}, {requestId: 'sse', timestamp: 10.1, type: 'EventSource', response: {status: 200, mimeType: 'text/event-stream', headers: {'Content-Type': 'text/event-stream'}}});
  await context.handleDebuggerEvent({tabId: 1}, 'Network.eventSourceMessageReceived', {requestId: 'sse', timestamp: 11, eventName: 'update', eventId: '42', data: 'hello'});
  let exported;
  context.HarExportStore.save = async har => { exported = har; return {id: 'export'}; };
  await context.stopRecording();
  const event = exported.log.entries[0]._serverSentEvents[0];
  assert.equal(event.time, 1800000001);
  assert.equal(event._breaktest.transactionId, 't1');
  assert.equal(event.eventId, '42');
  assert.equal(exported.log.entries[0]._breaktest.sse.captureEnd, 'recording-stopped');

  resetRecording();
  const sendCommand = context.chrome.debugger.sendCommand;
  context.chrome.debugger.sendCommand = async (_source, method) => method === 'Network.streamResourceContent'
    ? {bufferedData: Buffer.from('data: buffered\n\n').toString('base64')} : {};
  await context.requestWillBeSent({tabId: 1}, {requestId: 'fetch', timestamp: 10, wallTime: 1800000000,
    type: 'Fetch', request: {url: 'https://example.test/events'}});
  await context.responseReceived({tabId: 1}, {requestId: 'fetch', timestamp: 10.1, type: 'Fetch', response: {status: 200, mimeType: 'text/event-stream'}});
  await context.handleDebuggerEvent({tabId: 1}, 'Network.dataReceived', {requestId: 'fetch', timestamp: 11, data: Buffer.from('data: streamed\n\n').toString('base64')});
  assert.deepEqual(Array.from(run("recording.activeRequests.get('root:fetch').serverSentEvents"), item => item.data), ['buffered', 'streamed']);
  // A stream can finish while CDP is still returning its initial buffered data.
  resetRecording();
  let release;
  context.chrome.debugger.sendCommand = async (_source, method) => method === 'Network.streamResourceContent'
    ? new Promise(resolve => { release = resolve; }) : {body: '', base64Encoded: false};
  await context.requestWillBeSent({tabId: 1}, {requestId: 'fast', timestamp: 10, wallTime: 1800000000,
    type: 'Fetch', request: {url: 'https://example.test/events'}});
  const response = context.responseReceived({tabId: 1}, {requestId: 'fast', timestamp: 10.1,
    type: 'Fetch', response: {status: 200, mimeType: 'text/event-stream'}});
  const finish = context.loadingFinished({tabId: 1}, {requestId: 'fast', timestamp: 11});
  release({bufferedData: Buffer.from('data: final\n\n').toString('base64')});
  await Promise.all([response, finish]);
  assert.equal(run('recording.entries[0]._serverSentEvents[0].data'), 'final');
  assert.equal(run('recording.entries[0]._breaktest.sse.captureEnd'), 'stream-ended');
  context.chrome.debugger.sendCommand = async () => { throw new Error('Streaming unsupported'); };
  await context.requestWillBeSent({tabId: 1}, {requestId: 'unsupported', timestamp: 12, wallTime: 1800000002,
    type: 'Fetch', request: {url: 'https://example.test/events'}});
  await context.responseReceived({tabId: 1}, {requestId: 'unsupported', timestamp: 12.1,
    type: 'Fetch', response: {status: 200, mimeType: 'text/event-stream'}});
  assert.equal(run("recording.activeRequests.get('root:unsupported').sse.captureIncomplete"), true);
  context.chrome.debugger.sendCommand = sendCommand;
  console.log('Message transaction timing/editing and native/streaming SSE tests passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
