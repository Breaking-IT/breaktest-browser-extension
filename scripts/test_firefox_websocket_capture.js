#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const context = vm.createContext({crypto: require('node:crypto').webcrypto, setTimeout, clearTimeout});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../firefox/websocket-store.js'), 'utf8'), context);
vm.runInContext(fs.readFileSync(path.join(__dirname, "../firefox/message-capture.js"), "utf8"), context);
const store = context.WebSocketStore;
const owner = {tabId: 1, startedAt: 1000, currentTransaction: {id: "t1"}};
const sender = {tab: {id: 1}, frameId: 0, documentId: 'document'};
const url = 'wss://example.test/chat';
const begin = (id, source = sender, time = 1010) => store.handle(owner, {type: 'websocket-begin', id, url, time}, source);
const send = (auth, message, source = sender) => store.handle(owner, {...auth, ...message}, source);
const state = (frameId = 0, documentId = 'document', startedAt = 1010) => {
  const item = {request: {url}, transaction: {id: 't1'}, startedAt};
  store.handshake(owner, item, {frameId, documentId});
  return item;
};
const frame = {type: 'websocket-message', message: {type: 'send', time: 1.02, opcode: 1, data: 'hello'}};
async function main() {
  assert.equal(begin('wrong-tab', {...sender, tab: {id: 2}}).ok, false);
  assert.equal(begin('old', sender, 999).ok, false);
  const auth = begin('one');
  assert.equal(auth.ok, true);
  assert.equal(send({...auth, token: 'wrong'}, frame).ok, false);
  assert.equal(send(auth, frame, {...sender, documentId: 'new-document'}).ok, false);
  assert.equal(send(auth, frame).ok, true, 'messages may arrive before webRequest');
  const first = state();
  assert.equal(first.webSocket.messagesAvailable, true);
  assert.equal(first.webSocketMessages[0].data, 'hello');
  send(auth, {...frame, message: {...frame.message, type: 'receive', opcode: 2, data: 'AP+A'}});
  assert.equal(first.webSocketMessages[1]._encoding, 'base64');
  assert.equal(send(auth, {...frame, message: {...frame.message, opcode: 2, data: 'bad'}}).ok, false);

  const second = state();
  const auth2 = begin('two');
  send(auth2, {...frame, message: {...frame.message, data: 'second'}});
  assert.equal(second.webSocketMessages[0].data, 'second');
  assert.equal(first.webSocketMessages.length, 2, 'same-URL connections remain distinct');
  const worker = state(-1);
  assert.equal(worker.webSocket.messagesAvailable, false, 'worker coverage is explicit');
  const oldDocument = state(0, 'old-document');
  const third = state();
  const auth3 = begin('three');
  send(auth3, frame);
  assert.equal(oldDocument.webSocketMessages.length, 0);
  assert.equal(third.webSocketMessages.length, 1);

  owner.stopping = true;
  assert.equal(begin('late').ok, false);
  assert.equal(send(auth, frame).ok, true, 'authorized queued messages drain during stop');
  owner.stopping = false;
  send(auth, {type: 'websocket-dropped', count: 2});
  assert.equal(first.webSocket.messagesTruncated, true);
  assert.equal(first.webSocket.droppedMessages, 2);
  send(auth, {type: 'websocket-close-requested', time: 1.9});
  send(auth, {type: 'websocket-end', closed: true, time: 2, code: 1000, reason: 'done', wasClean: true});
  assert.equal(first.webSocket.closed, true);
  assert.equal(first.webSocket.closedTime, 2);
  assert.equal(first.webSocket.closeCode, 1000);
  assert.equal(first.webSocket.closeInitiator, 'client');
  assert.equal(first.webSocket.closeInitiatedTime, 1.9);
  send(auth2, {type: 'websocket-end', closed: true, time: 2, code: 1000, wasClean: true});
  assert.equal(second.webSocket.closeInitiator, 'server');
  assert.equal(second.webSocket.closeInitiatorInferred, true);
  send(auth2, {type: 'websocket-close-requested', time: 2.1});
  assert.equal(second.webSocket.closeInitiator, 'server', 'a late client call cannot overwrite server attribution');
  send(auth3, {type: 'websocket-end', closed: true, time: 2, code: 1006, wasClean: false});
  assert.equal(third.webSocket.closeInitiator, 'unknown');
  send(auth2, {type: 'websocket-unavailable', reason: 'read failed'});
  assert.equal(second.webSocket.captureIncomplete, true);
  assert.equal(second.webSocket.captureError, 'read failed');

  store.removeTransaction(owner, 't1', {id: 't2'});
  assert.equal(first.transaction.id, 't2');
  store.removeTransaction(owner, 't2');
  assert.equal(send(auth, frame).ok, false, 'deleted transactions cannot keep collecting');

  const limitOwner = {tabId: 1, startedAt: 1000, currentTransaction: {id: "t1"}};
  const limited = {request: {url}, transaction: {id: 't1'}, startedAt: 1010};
  store.handshake(limitOwner, limited, sender);
  const limitAuth = store.handle(limitOwner, {type: 'websocket-begin', id: 'limit', url, time: 1010}, sender);
  const big = {type: 'websocket-message', message: {...frame.message, data: 'a'.repeat(2 * 1024 * 1024)}};
  for (let i = 0; i < 8; i++) store.handle(limitOwner, {...limitAuth, ...big}, sender);
  store.handle(limitOwner, {...limitAuth, ...frame}, sender);
  assert.equal(limited.webSocketMessages.length, 8);
  assert.equal(limited.webSocket.droppedMessages, 1);

  let drained = false;
  const settling = store.settle({scripting: {executeScript: async () => []}}, limitOwner).then(() => { drained = true; });
  await Promise.resolve();
  assert.equal(drained, false, 'flush waits for native handshake events');
  limited.webSocketResolve();
  await settling;
  assert.equal(drained, true);
  console.log('Firefox WebSocket correlation, authorization, lifecycle, limits and stop draining passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
