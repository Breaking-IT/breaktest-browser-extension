#!/usr/bin/env node
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {context, resetRecording} = require('./test_chrome_request_metadata');
const run = code => vm.runInContext(code, context);
const source = {tabId: 1};
async function request(id) {
  await context.requestWillBeSent(source, {requestId: id, timestamp: 1, wallTime: 1700000000,
    request: {method: 'GET', url: 'https://example.test/' + id}});
  await context.responseReceived(source, {requestId: id, timestamp: 2,
    response: {status: 200, mimeType: 'text/plain'}});
}
async function chunk(id, text, withData = true) {
  await context.handleDebuggerEvent(source, 'Network.dataReceived', {requestId: id, timestamp: 3,
    dataLength: Buffer.byteLength(text), ...(withData ? {data: Buffer.from(text).toString('base64')} : {})});
}
(async () => {
  resetRecording();
  const calls = [];
  const full = 'x'.repeat(3 * 1024 * 1024) + 'tail';
  context.chrome.debugger.sendCommand = async (_source, method) => {
    calls.push(method);
    if (method === 'Network.streamResourceContent') return {bufferedData: ''};
    if (method === 'Network.getResponseBody') return {body: full, base64Encoded: false};
    return {};
  };
  await request('streamed');
  await chunk('streamed', full);
  await context.loadingFinished(source, {requestId: 'streamed', timestamp: 4});
  assert.equal(run('recording.entries[0].response.content.text'), full);
  assert.ok(!calls.includes('Network.getResponseBody'), 'complete stream bypasses CDP body cache');
  await request('missing-prefix');
  await chunk('missing-prefix', full.slice(0, -4), false);
  await chunk('missing-prefix', 'tail');
  await context.loadingFinished(source, {requestId: 'missing-prefix', timestamp: 4});
  assert.equal(run('recording.entries[1].response.content.text'), full, 'fallback recovers missing streamed bytes');
  assert.ok(calls.includes('Network.getResponseBody'));
  context.chrome.debugger.sendCommand = async (_source, method) => {
    if (method === 'Network.streamResourceContent') return {bufferedData: ''};
    throw new Error('CDP body unavailable');
  };
  await request('unavailable-prefix');
  await chunk('unavailable-prefix', 'missing', false);
  await chunk('unavailable-prefix', 'tail');
  await context.loadingFinished(source, {requestId: 'unavailable-prefix', timestamp: 4});
  assert.equal(run('recording.entries[2].response.content.text'), 'tail');
  assert.equal(run('recording.entries[2]._breaktest.bodyUnavailable'), true);
  assert.equal(run('recording.entries[2]._breaktest.bodyTruncated'), true);
  console.log('Chrome response streams: complete large bodies, cache fallback, and explicit incomplete capture passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
