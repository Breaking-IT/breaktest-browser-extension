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
      if (method === 'set') Object.assign(session, structuredClone(arg));
      if (method === 'remove') delete session[arg];
    });
    await context.route('http://recorder.test/**', route => route.fulfill({body: '<!doctype html><title>Storage test</title>', contentType: 'text/html'}));
    async function page() {
      const page = await context.newPage();
      await page.goto('http://recorder.test/');
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
    await first.evaluate(() => RecordingStore.save({id: 'private', incognito: true, entries: [{body: 'private response'}]}));
    assert.equal(session.firefoxRecordingCheckpoint.private, true);
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
    assert.equal(disk, null, 'private recording contents must not be written to disk');
    await first.close();
    first = await page();
    assert.equal((await first.evaluate(() => RecordingStore.load())).entries[0].body, 'private response');
    await first.evaluate(() => RecordingStore.remove());
    assert.equal(await first.evaluate(() => RecordingStore.load()), null);
    await first.evaluate(() => { browser.storage.session.set = async () => { throw new Error('Quota exceeded'); }; });
    await assert.rejects(first.evaluate(() => RecordingStore.save({id: 'quota', incognito: true})), /Quota exceeded/);
    console.log('Recording storage: IndexedDB recovery, session isolation, private memory storage, cleanup and quota errors passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
