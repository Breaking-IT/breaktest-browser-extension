#!/usr/bin/env node
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {context, resetRecording} = require('./test_chrome_request_metadata');
const run = code => vm.runInContext(code, context);
const source = {tabId: 1};
async function request(id) {
  await context.requestWillBeSent(source, {requestId: id, timestamp: 1, wallTime: 1700000000,
    request: {method: 'GET', url: 'https://example.test/' + id}});
}
(async () => {
  resetRecording();
  await request('in-flight');
  const transaction = run('recording.currentTransaction.id');
  const paused = await context.handleMessage({type: 'pause-recording'});
  assert.equal(paused.active, true);
  assert.equal(paused.paused, true);
  await request('skipped');
  assert.equal(run('recording.activeRequests.size'), 1);
  assert.equal(run('MessageCapture.tag(recording, {time: 1700000001})'), false);
  assert.equal(run('UploadStore.handle(recording, {type: "upload-status"}, {tab: {id: 1}}).ok'), false);
  await context.loadingFinished(source, {requestId: 'in-flight', timestamp: 2});
  assert.equal(run('recording.entries.length'), 1, 'in-flight request finishes while paused');
  assert.equal((await context.handleMessage({type: 'resume-recording'})).paused, false);
  assert.equal(run('recording.currentTransaction.id'), transaction);
  assert.equal(run('MessageCapture.tag(recording, {time: 1700000002})'), true);
  await request('resumed');
  await context.loadingFinished(source, {requestId: 'resumed', timestamp: 2});
  assert.equal(run('recording.entries.length'), 2);
  assert.equal(run('recording.transactions[0].requestCount'), 2);
  await context.handleMessage({type: 'pause-recording'});
  const stopped = await context.handleMessage({type: 'stop-recording'});
  assert.equal(stopped.ok, true, 'can export while paused');
  assert.equal(run('recording'), null);
  await assert.rejects(context.handleMessage({type: 'resume-recording'}), /No active recording/);
  console.log('Pause/resume: request gating, in-flight completion, messages, uploads, transaction continuity and export passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
