#!/usr/bin/env node
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {context, resetRecording} = require('./test_chrome_request_metadata');
const run = code => vm.runInContext(code, context);
const source = {tabId: 1};
const wallTime = 1700000000;

async function request(id, timestamp, method = 'GET') {
  await context.requestWillBeSent(source, {
    requestId: id, timestamp, wallTime: wallTime + timestamp - 10,
    request: {method, url: 'https://example.test/api'}
  });
}

async function finish(id, start, end, extra = {}) {
  await context.responseReceived(source, {
    requestId: id, timestamp: end - 0.01,
    response: {status: 200, timing: {
      requestTime: start, dnsStart: -1, dnsEnd: -1,
      connectStart: -1, connectEnd: -1, sslStart: -1, sslEnd: -1,
      sendStart: 0, sendEnd: 1, receiveHeadersEnd: 10
    }, ...extra}
  });
  await context.loadingFinished(source, {requestId: id, timestamp: end});
}

(async () => {
  resetRecording();
  // Main request is announced first, but cannot reach the network until OPTIONS completes.
  await request('main', 10, 'POST');
  await request('preflight', 10.1, 'OPTIONS');
  await finish('preflight', 10.1, 10.2);
  await finish('main', 10.3, 10.5);
  const entries = run('buildHar(recording).log.entries');
  assert.deepEqual(Array.from(entries, e => e.request.method), ['OPTIONS', 'POST']);
  assert.equal(Date.parse(entries[1].startedDateTime), wallTime * 1000 + 300);
  assert.ok(Math.abs(entries[1].time - 200) < 0.001);
  assert.equal(run('recording.summaries[1].startedDateTime'), entries[1].startedDateTime);
  assert.equal(run('recording.summaries[1].time'), entries[1].time);
  assert.equal(Date.parse(entries[1].startedDateTime) + Math.round(entries[1].time), wallTime * 1000 + 500);
  // The network duration must no longer include the preflight wait.
  assert.ok(entries[1].timings.receive < 200);

  for (const [label, start, extra] of [
    ['missing', undefined, {}], ['negative', -1, {}], ['invalid', NaN, {}],
    ['future', 20, {}], ['disk cache', 10.3, {fromDiskCache: true}],
    ['service worker', 10.3, {fromServiceWorker: true}],
    ['no timing', undefined, {timing: undefined}]
  ]) {
    resetRecording();
    await request('fallback', 10);
    await finish('fallback', start, 10.5, extra);
    const entry = run('recording.entries[0]');
    assert.equal(Date.parse(entry.startedDateTime), wallTime * 1000, label);
    assert.equal(entry.time, 500, label);
  }
  console.log('Preflight ordering, network duration, summary consistency, and timing fallbacks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
