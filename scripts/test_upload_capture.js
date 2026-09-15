#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {webcrypto: crypto} = require("node:crypto");

async function test(browser) {
  const context = vm.createContext({crypto, setTimeout, clearTimeout});
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", browser, "upload-store.js"), "utf8"), context);
  const store = context.UploadStore;
  let owner = {tabId: 7, currentTransaction: {id: "t1"}};
  const sender = {tab: {id: 7}, frameId: 3, documentId: "doc1", url: "https://example.test/form"};
  const send = message => store.handle(owner, message, sender);
  const token = send({type: "upload-status"}).token;
  const begin = (size, name = "recording.har") => send({type: "upload-begin", token,
    file: {name, size, mimeType: "application/json", fieldName: "attachment", source: "input"}});
  const body = Buffer.from('{"log":{"entries":[]},"unicode":"é😀"}');
  const upload = begin(body.length);
  assert.equal(upload.ok, true);
  assert.equal(store.handle(owner, {type: "upload-status"}, {...sender, tab: {id: 8}}).ok, false);
  assert.equal(store.handle(owner, {type: "upload-chunk", token, id: upload.id, data: body.toString("base64")},
    {...sender, documentId: "other"}).ok, false);
  assert.equal(send({type: "upload-chunk", token, id: upload.id, data: body.toString("base64")}).ok, true);
  send({type: "upload-end", token, id: upload.id});
  let file = store.exportFiles(owner).files[0];
  assert.deepEqual(Buffer.from(file.content, "base64"), body);
  assert.equal(file.fileName, "recording.har");
  assert.equal(file.transactionId, "t1");
  assert.equal(file.frameId, 3);
  const zero = begin(0, "empty.bin");
  send({type: "upload-end", token, id: zero.id});
  assert.equal(store.exportFiles(owner).files[1].content, "");
  begin(21 * 1024 * 1024);
  assert.equal(store.exportFiles(owner).files[2].reason, "file-size-limit");
  const bad = begin(3);
  assert.equal(send({type: "upload-chunk", token, id: bad.id, data: "%%%="}).ok, false);
  assert.equal(store.exportFiles(owner).files[3].reason, "invalid-chunk");
  begin(10);
  owner.stopping = true;
  assert.equal(begin(1).ok, false);
  await store.settle(owner, 1);
  assert.equal(store.exportFiles(owner).files[4].reason, "recording-stopped");
  assert.equal("content" in store.exportFiles(owner).files[4], false);
  owner = {tabId: 7};
  assert.equal(send({type: "upload-begin", token, file: {name: "stale", size: 0}}).ok, false);

  // Run the actual content script through the actual store for all event paths.
  const events = new Map();
  const messages = [];
  const binary = Buffer.alloc(400001);
  for (let i = 0; i < binary.length; i++) binary[i] = i % 256;
  const selected = new File([binary], "binary.dat", {type: "application/octet-stream"});
  const input = {type: "file", name: "attachment", files: [selected]};
  const document = {
    querySelectorAll: selector => selector.startsWith("input") ? [input] : [],
    addEventListener: (event, handler) => events.set(event, handler)
  };
  const runtime = {sendMessage: async message => {
    messages.push(message);
    return send(message);
  }};
  const page = vm.createContext({document, Blob, Uint8Array, btoa,
    [browser === "firefox" ? "browser" : "chrome"]: {runtime}});
  const source = fs.readFileSync(path.join(__dirname, "..", browser, "upload-capture.js"), "utf8");
  async function flush() {
    for (let i = 0; i < 100; i++) {
      await new Promise(resolve => setTimeout(resolve, 2));
      if (owner.uploadCapture?.files.length && !owner.uploadCapture.transfers.size) return;
    }
    throw new Error("Upload did not settle");
  }
  vm.runInContext(source, page);
  await flush();
  file = store.exportFiles(owner).files[0];
  assert.deepEqual(Buffer.from(file.content, "base64"), binary);
  assert.equal(messages.filter(message => message.type === "upload-chunk").length, 3);
  // Re-injection and change events do not duplicate the same File object in a session.
  vm.runInContext(source, page);
  events.get("change")({composedPath: () => [input]});
  await flush();
  assert.equal(store.exportFiles(owner).files.length, 1);
  events.get("drop")({dataTransfer: {files: [new File([body], "dropped.har")]}});
  await flush();
  events.get("formdata")({formData: new Map([["attachment", new File([body], "submitted.har")]])});
  await flush();
  assert.equal(store.exportFiles(owner).files[1].source, "drop");
  assert.equal(store.exportFiles(owner).files[2].source, "formdata");
  // Round-trip the JSON that will be embedded in HAR.
  const exported = JSON.parse(JSON.stringify(store.exportFiles(owner)));
  assert.deepEqual(Buffer.from(exported.files[2].content, "base64"), body);
  owner.stopping = true;
  events.get("drop")({dataTransfer: {files: [new File([body], "after-stop.har")]}});
  await flush();
  assert.equal(store.exportFiles(owner).files.length, 3);
  owner.stopping = false;
  const broken = new File([body], "unreadable.har");
  broken.slice = () => ({arrayBuffer: async () => { throw new Error("read failure"); }});
  events.get("drop")({dataTransfer: {files: [broken]}});
  await flush();
  assert.equal(store.exportFiles(owner).files[3].reason, "file-read-failed");
  const currentToken = send({type: "upload-status"}).token;
  const pending = send({type: "upload-begin", token: currentToken, file: {name: "last", size: 3}});
  owner.stopping = true;
  const settled = store.settle(owner, 1000);
  send({type: "upload-chunk", token: currentToken, id: pending.id, data: "AQID"});
  send({type: "upload-end", token: currentToken, id: pending.id});
  await settled;
  assert.equal(store.exportFiles(owner).files.at(-1).content, "AQID");
  owner = {tabId: 7, currentTransaction: {id: "old"}};
  const limitToken = send({type: "upload-status"}).token;
  for (let i = 0; i < 4; i++) {
    send({type: "upload-begin", token: limitToken, file: {name: "large", size: 20 * 1024 * 1024}});
  }
  assert.equal(store.exportFiles(owner).files.at(-1).reason, "recording-size-limit");
  store.removeTransaction(owner, "old", "new");
  assert.ok(store.exportFiles(owner).files.every(item => item.transactionId === "new"));
  store.removeTransaction(owner, "new");
  assert.equal(store.exportFiles(owner).files.length, 0);
  assert.equal(owner.uploadCapture.transfers.size, 0);
  owner = null;
  assert.equal(send({type: "upload-status"}).ok, false);
  console.log(`${browser}: upload capture, binary round-trip, event paths, limits and isolation passed`);
}
(async () => {
  await test("chrome");
  await test("firefox");
})().catch(error => { console.error(error); process.exitCode = 1; });
