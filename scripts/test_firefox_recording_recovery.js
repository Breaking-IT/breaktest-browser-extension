#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const event = () => ({listeners: [], addListener(fn) { this.listeners.push(fn); }});
function background(storage) {
  const filters = new Map();
  const notices = [];
  const api = {
    commands: {onCommand: event()},
    action: {onClicked: event(), setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}},
    sidebarAction: {open: async () => {}},
    runtime: {onConnect: event(), onMessage: event(), getManifest: () => ({version: 'test'}), sendMessage: async message => notices.push(message)},
    tabs: {onRemoved: event(), get: async id => {
      if (storage.closed) throw new Error('Tab closed');
      return {id, url: 'https://example.test/', incognito: !!storage.private};
    }, update: async () => {}},
    windows: {update: async () => {}},
    storage: {local: {get: async () => ({}), set: async () => {}, remove: async () => {}}},
    browserSettings: {cacheEnabled: {set: async () => true, clear: async () => {}}},
    scripting: {executeScript: async () => []},
    webRequest: Object.fromEntries(['onBeforeRequest','onBeforeSendHeaders','onHeadersReceived','onResponseStarted','onBeforeRedirect','onCompleted','onErrorOccurred'].map(key => [key, event()]))
  };
  api.webRequest.filterResponseData = id => {
    const filter = {write() {}, close() {}, disconnect() {}};
    filters.set(id, filter); return filter;
  };
  const context = vm.createContext({browser: api, console, structuredClone, URL, URLSearchParams,
    TextEncoder, TextDecoder, Uint8Array, atob, btoa, crypto: require('node:crypto').webcrypto,
    setTimeout, clearTimeout,
    RecordingStore: {
      load: async () => { if (storage.gate) await storage.gate; return structuredClone(storage.saved || null); },
      save: async value => { if (storage.fail) throw new Error('Storage full'); storage.saved = structuredClone(value); },
      remove: async () => { storage.saved = null; }
    },
    HarExportStore: {cleanupStale: async () => {}, save: async har => {
      if (storage.exportFail) throw new Error('Export failed');
      storage.har = structuredClone(har); return {id: 'export', entryCount: har.log.entries.length};
    }}
  });
  for (const file of ['upload-store.js','message-capture.js','sse-capture.js','websocket-store.js','background.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../firefox', file), 'utf8'), context, {filename: file});
  }
  return {context, api, filters, notices, run: code => vm.runInContext(code, context),
    send: message => api.runtime.onMessage.listeners[0](message, {})};
}
async function request(bg, id, finish = true) {
  const details = {tabId: 1, requestId: id, url: 'https://example.test/' + id, method: 'GET', type: 'xmlhttprequest', timeStamp: 1000};
  await bg.api.webRequest.onBeforeRequest.listeners[0](details);
  await bg.api.webRequest.onResponseStarted.listeners[0]({...details, timeStamp: 1010, statusCode: 200, responseHeaders: [{name: 'content-type', value: 'text/plain'}]});
  bg.filters.get(id).ondata({data: new TextEncoder().encode('response ' + id).buffer});
  if (finish) {
    bg.filters.get(id).onstop();
    await bg.api.webRequest.onCompleted.listeners[0]({...details, timeStamp: 1020, statusCode: 200});
  }
  await bg.run('checkpointRecording()');
}
(async () => {
  for (const privateMode of [false, true]) {
    const storage = {private: privateMode};
    let bg = background(storage);
    await bg.send({type: 'start-recording', tabId: 1, transactionName: '01_First'});
    await request(bg, 'complete');
    await request(bg, 'in-flight', false);
    await bg.send({type: 'new-transaction', name: '02_Next'});
    assert.equal(storage.saved.entries[0].response.content.text, 'response complete');
    assert.equal(storage.saved.incognito, privateMode);
    // A new VM has no globals, response filters, or ports from the old background.
    let release;
    storage.gate = new Promise(resolve => { release = resolve; });
    bg = background(storage);
    let answered = false;
    const statusPromise = bg.send({type: 'recorder-status'}).then(result => { answered = true; return result; });
    await Promise.resolve();
    assert.equal(answered, false, 'commands wait for recovery');
    release();
    const status = await statusPromise;
    delete storage.gate;
    assert.equal(status.active, true);
    assert.equal(status.currentTransaction.name, '02_Next');
    assert.equal(status.requestCount, 2);
    assert.equal(status.pendingCount, 0);
    assert.match(status.recoveryNotice, /recovered/);
    assert.equal(storage.saved.entries[1]._breaktest.incomplete, true);
    assert.equal(storage.saved.entries[1].response.content.text, 'response in-flight');
    await request(bg, 'after-restart');
    assert.equal(storage.saved.entries.length, 3);
    await assert.rejects(bg.send({type: 'start-recording', tabId: 1, transactionName: 'overwrite'}), /already exists/);
    storage.exportFail = true;
    await assert.rejects(bg.send({type: 'stop-recording'}), /Export failed/);
    assert.ok(storage.saved, 'failed export retains recoverable data');
    storage.exportFail = false;
    bg = background(storage);
    const result = await bg.send({type: 'stop-recording'});
    assert.equal(result.export.entryCount, 3);
    assert.equal(storage.har.log.entries[0].response.content.text, 'response complete');
    assert.equal(storage.saved, null);
    bg = background(storage);
    assert.equal((await bg.send({type: 'recorder-status'})).active, false);
    await bg.send({type: 'start-recording', tabId: 1, transactionName: 'discard'});
    await request(bg, 'discard');
    await bg.send({type: 'cancel-recording'});
    bg = background(storage);
    assert.equal((await bg.send({type: 'recorder-status'})).active, false);
    await bg.send({type: 'start-recording', tabId: 1, transactionName: 'closed tab'});
    await request(bg, 'saved');
    storage.closed = true;
    bg = background(storage);
    assert.equal((await bg.send({type: 'recorder-status'})).attached, false);
    assert.equal((await bg.send({type: 'stop-recording'})).export.entryCount, 1);
  }
  const pending = background({});
  await pending.send({type: 'start-recording', tabId: 1, transactionName: 'Pending lifecycle'});
  await request(pending, 'body-draining', false);
  assert.equal((await pending.send({type: 'recorder-status'})).pendingCount, 1);
  await pending.api.webRequest.onCompleted.listeners[0]({tabId: 1, requestId: 'body-draining', timeStamp: 1020, statusCode: 200});
  let status = await pending.send({type: 'recorder-status'});
  assert.equal(status.pendingCount, 0, 'completed network request is not pending while its filter drains');
  assert.equal(pending.run('recording.pendingStates.size'), 1, 'body processing is retained');
  assert.equal(status.transactions[0].pendingCount, 0);
  assert.equal((await pending.send({type: 'transaction-details', id: status.currentTransaction.id})).transaction.pendingCount, 0);
  assert.equal(pending.notices.filter(message => message.type === 'recorder-status-changed').at(-1).status.pendingCount, 0);
  pending.filters.get('body-draining').onstop();
  await pending.run('checkpointRecording()');
  assert.equal(pending.run('recording.entries[0].response.content.text'), 'response body-draining');
  await request(pending, 'redirect', false);
  await pending.api.webRequest.onBeforeRedirect.listeners[0]({tabId: 1, requestId: 'redirect', timeStamp: 1020, statusCode: 302, redirectUrl: 'https://example.test/destination'});
  assert.equal((await pending.send({type: 'recorder-status'})).pendingCount, 0);
  pending.filters.get('redirect').onstop();
  await request(pending, 'failed', false);
  await pending.api.webRequest.onErrorOccurred.listeners[0]({tabId: 1, requestId: 'failed', timeStamp: 1020, error: 'cancelled'});
  assert.equal((await pending.send({type: 'recorder-status'})).pendingCount, 0);
  await pending.api.webRequest.onBeforeRequest.listeners[0]({tabId: 1, requestId: 'socket', url: 'wss://example.test/socket', method: 'GET', type: 'websocket', timeStamp: 1030});
  assert.equal((await pending.send({type: 'recorder-status'})).pendingCount, 1);
  await pending.api.webRequest.onResponseStarted.listeners[0]({tabId: 1, requestId: 'socket', timeStamp: 1040, statusCode: 101});
  assert.equal((await pending.send({type: 'recorder-status'})).pendingCount, 0, 'established WebSocket is not an unfinished handshake');
  await pending.send({type: 'cancel-recording'});
  const failureStorage = {};
  let failing = background(failureStorage);
  await failing.send({type: 'start-recording', tabId: 1, transactionName: '01_Save'});
  await request(failing, 'retained');
  failureStorage.fail = true;
  await assert.rejects(failing.send({type: 'new-transaction', name: '02_NotSaved'}), /Storage full/);
  assert.match((await failing.send({type: 'recorder-status'})).persistenceError, /Storage full/);
  assert.equal(failureStorage.saved.entries.length, 1, 'last good checkpoint remains intact');
  failureStorage.fail = false;
  await failing.send({type: 'new-transaction', name: '03_Retry'});
  assert.equal((await failing.send({type: 'recorder-status'})).persistenceError, null);
  const concurrent = background({});
  const starts = await Promise.allSettled([
    concurrent.send({type: 'start-recording', tabId: 1, transactionName: 'one'}),
    concurrent.send({type: 'start-recording', tabId: 1, transactionName: 'two'})
  ]);
  assert.equal(starts.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((await concurrent.send({type: 'recorder-status'})).currentTransaction.name, 'one');
  console.log('Firefox recovery: restart, bodies, in-flight requests, gating, private mode, export failure, discard and closed tab passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
