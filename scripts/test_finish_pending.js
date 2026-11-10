#!/usr/bin/env node
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {context, resetRecording} = require('./test_chrome_request_metadata');
const run = code => vm.runInContext(code, context);
(async () => {
  resetRecording();
  const source = {tabId: 1};
  let saved;
  const replies = [];
  context.HarExportStore.save = async har => { saved = structuredClone(har); return {id: 'saved', entryCount: har.log.entries.length}; };
  context.chrome.debugger.sendCommand = () => new Promise(resolve => replies.push(resolve));
  context.chrome.debugger.detach = () => new Promise(() => {});
  // Both streaming setup and the redirect's body retrieval never return.
  await context.requestWillBeSent(source, {requestId: 'redirect', timestamp: 1, wallTime: 1700000000,
    request: {url: 'https://example.test/old', method: 'GET'}});
  await context.requestWillBeSent(source, {requestId: 'redirect', timestamp: 2, wallTime: 1700000001,
    redirectResponse: {status: 302, headers: {location: '/new'}},
    request: {url: 'https://example.test/new', method: 'GET'}});
  // Lifecycle cleanup also never returns.
  run('recording.webSocketLifecycle = {binding: "test", targets: new Map([["root", {target: {tabId: 1}, contexts: new Set()}]])}');
  const began = Date.now();
  let watchdog;
  const result = await Promise.race([
    context.handleMessage({type: 'stop-recording'}),
    new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error('Export stayed blocked')), 5000); })
  ]).finally(() => clearTimeout(watchdog));
  assert.equal(result.ok, true);
  assert.ok(Date.now() - began < 4500);
  assert.equal(saved.log.entries.length, 2, 'includes the redirect waiting outside activeRequests');
  assert.ok(saved.log.entries.every(entry => entry._breaktest.incomplete));
  assert.ok(saved.log.entries.every(entry => entry._breaktest.bodyUnavailable));
  assert.equal(run('recording'), null);
  // Late browser replies cannot add entries to a new recording or alter the saved HAR.
  resetRecording();
  for (const resolve of replies) resolve({bufferedData: '', body: 'late response'});
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(run('recording.entries.length'), 0);
  assert.equal(saved.log.entries[0].response.content.text, undefined);
  console.log('Finish exports stalled capture, redirect and lifecycle tasks despite a stalled detach; late replies stay isolated');
})().catch(error => { console.error(error); process.exitCode = 1; });
