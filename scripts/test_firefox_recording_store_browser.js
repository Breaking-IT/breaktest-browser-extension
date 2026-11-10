#!/usr/bin/env node
// Real IndexedDB with a mocked browser.storage.session surviving page restarts.
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
(async () => {
  const browser = await chromium.launch({channel: process.env.PLAYWRIGHT_CHANNEL || 'chromium', headless: true});
  try {
    const context = await browser.newContext();
    const session = {};
    const calls = [];
    await context.exposeFunction('sessionStorageCall', (method, arg) => {
      calls.push(method);
      if (method === 'get') return structuredClone({[arg]: session[arg]});
      if (method === 'set') {
        if (Buffer.byteLength(JSON.stringify({...session, ...arg})) > 10 * 1024 * 1024) {
          throw new Error('QuotaExceededError: storage.session quota');
        }
        Object.assign(session, structuredClone(arg));
      }
      if (method === 'remove') delete session[arg];
    });
    await context.route('https://recorder.test/**', route => route.fulfill({body: '<!doctype html><title>Storage test</title>', contentType: 'text/html'}));
    async function page() {
      const page = await context.newPage();
      await page.goto('https://recorder.test/');
      await page.evaluate(() => { window.browser = {storage: {session: {
        get: key => sessionStorageCall('get', key),
        set: value => sessionStorageCall('set', value),
        remove: key => sessionStorageCall('remove', key)
      }}}; });
      await page.addScriptTag({path: path.join(__dirname, '../firefox/recording-store.js')});
      return page;
    }
    let first = await page();
    await first.evaluate(() => RecordingStore.save({id: 'normal', incognito: false, entries: [{body: 'saved response'}]}));
    assert.deepEqual(session.firefoxRecordingCheckpoint, {id: 'normal'});
    await first.close();
    first = await page();
    assert.equal((await first.evaluate(() => RecordingStore.load())).entries[0].body, 'saved response');
    // A fresh browser session must not restore old data against a reused tab ID.
    delete session.firefoxRecordingCheckpoint;
    assert.equal(await first.evaluate(() => RecordingStore.load()), null);
    await first.evaluate(() => RecordingStore.save({id: 'private', incognito: true,
      entries: [{body: 'private response', large: 'x'.repeat(12 * 1024 * 1024)}]}));
    assert.equal(session.firefoxRecordingCheckpoint.private, true);
    assert.ok(JSON.stringify(session).length < 1024, 'session marker size is independent of recording size');
    assert.equal(session.firefoxRecordingCheckpoint.snapshot, undefined);
    const disk = await first.evaluate(() => new Promise((resolve, reject) => {
      const request = indexedDB.open('breaktest-active-recording', 1);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('checkpoint', 'readonly');
        const read = tx.objectStore('checkpoint').get('active');
        read.onsuccess = () => { resolve(read.result || null); db.close(); };
      };
      request.onerror = () => reject(request.error);
    }));
    assert.equal(disk.format, 'aes-gcm-v1');
    assert.equal(disk.entries, undefined, 'private recording contents must not be stored as plaintext');
    assert.equal(disk.key, undefined, 'encryption key must never be written to disk');
    const oldKey = session.firefoxRecordingCheckpoint.key;
    await first.evaluate(async () => {
      const snapshot = await RecordingStore.load();
      snapshot.entries[0].body = 'updated private response';
      await RecordingStore.save(snapshot);
    });
    assert.deepEqual(session.firefoxRecordingCheckpoint.key, oldKey);
    await first.close();
    first = await page();
    const recovered = await first.evaluate(() => RecordingStore.load());
    assert.equal(recovered.entries[0].body, 'updated private response');
    assert.equal(recovered.entries[0].large.length, 12 * 1024 * 1024);
    // A failed disk write must leave the last committed private checkpoint usable.
    await first.evaluate(() => {
      window.originalOpen = indexedDB.open.bind(indexedDB);
      indexedDB.open = () => { throw new DOMException('Disk full', 'QuotaExceededError'); };
    });
    await assert.rejects(first.evaluate(() => RecordingStore.save({id: 'private', incognito: true, entries: []})), /Disk full/);
    await first.evaluate(() => { indexedDB.open = window.originalOpen; });
    assert.equal((await first.evaluate(() => RecordingStore.load())).entries[0].body, 'updated private response');
    // A wrong key must fail closed instead of returning an incomplete recording.
    session.firefoxRecordingCheckpoint.key = Array(32).fill(0);
    await assert.rejects(first.evaluate(() => RecordingStore.load()));
    session.firefoxRecordingCheckpoint.key = oldKey;
    // Losing the browser session also loses the key; stale ciphertext is cleared.
    delete session.firefoxRecordingCheckpoint;
    assert.equal(await first.evaluate(() => RecordingStore.load()), null);
    // Migrate a checkpoint produced by the previous extension version.
    session.firefoxRecordingCheckpoint = {private: true, snapshot: {id: 'legacy', incognito: true, entries: []}};
    assert.equal((await first.evaluate(() => RecordingStore.load())).id, 'legacy');
    await first.evaluate(async () => RecordingStore.save(await RecordingStore.load()));
    assert.equal(session.firefoxRecordingCheckpoint.snapshot, undefined);
    assert.equal((await first.evaluate(() => RecordingStore.load())).id, 'legacy');
    await first.evaluate(() => RecordingStore.remove());
    assert.equal(await first.evaluate(() => RecordingStore.load()), null);
    await first.evaluate(() => { browser.storage.session.set = async () => { throw new Error('Quota exceeded'); }; });
    await assert.rejects(first.evaluate(() => RecordingStore.save({id: 'quota', incognito: true})), /Quota exceeded/);
    console.log('Recording storage: recovery above 10 MiB, encrypted private checkpoints, session isolation, migration, cleanup and storage errors passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
