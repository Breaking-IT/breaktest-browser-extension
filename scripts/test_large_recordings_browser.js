#!/usr/bin/env node
// Real Chromium extension: bodies exceed the old per-response and CDP buffer caps.
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
(async () => {
  assert.ok(process.env.CHROMIUM_PATH, 'Set CHROMIUM_PATH');
  const size = 32 * 1024 * 1024;
  const server = http.createServer((req, res) => {
    if (req.url === '/large-text' || req.url === '/large-binary') {
      res.setHeader('content-type', req.url.endsWith('text') ? 'text/plain; charset=utf-8' : 'application/octet-stream');
      const body = Buffer.alloc(size, req.url.endsWith('text') ? 120 : 255);
      body.write('END', size - 3);
      res.end(body);
    } else {
      res.setHeader('content-type', 'text/html');
      res.end('<title>Large recording test</title><input type="file">');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let context;
  try {
    const extension = path.resolve(__dirname, '../chrome');
    context = await chromium.launchPersistentContext('', {executablePath: process.env.CHROMIUM_PATH,
      headless: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]});
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const url = `http://127.0.0.1:${server.address().port}/`;
    const page = await context.newPage();
    await page.goto(url);
    await worker.evaluate(async url => {
      const tab = (await chrome.tabs.query({})).find(tab => tab.url === url);
      await startRecording({tabId: tab.id, transactionName: 'Large bodies and files'});
    }, url);
    await page.evaluate(async () => {
      await (await fetch('/large-text')).arrayBuffer();
      await (await fetch('/large-binary')).arrayBuffer();
    });
    await page.locator('input').setInputFiles({name: 'large.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(21 * 1024 * 1024, 123)});
    let ready = false;
    for (let i = 0; i < 300; i++) {
      ready = await worker.evaluate(() => recording.entries.length >= 2 &&
        recording.uploadCapture?.files[0]?.status === 'complete');
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, 'Large responses and file capture completed');
    const result = await worker.evaluate(async () => {
      const stopped = await stopRecording();
      const har = JSON.parse(await (await HarExportStore.get(stopped.export.id)).blob.text());
      return {
        bodies: har.log.entries.filter(entry => entry.request.url.includes('/large-')).map(entry => {
          const content = entry.response.content;
          const text = content.encoding === 'base64' ? atob(content.text) : content.text;
          return {url: entry.request.url, length: text.length, first: text.charCodeAt(0), tail: text.slice(-3),
            unavailable: entry._breaktest.bodyUnavailable, truncated: entry._breaktest.bodyTruncated};
        }),
        file: {size: har.log._breaktest.uploadCapture.files[0].size,
          bytes: atob(har.log._breaktest.uploadCapture.files[0].content).length}
      };
    });
    assert.equal(result.bodies.length, 2);
    for (const body of result.bodies) {
      assert.equal(body.length, size);
      assert.equal(body.tail, 'END');
      assert.equal(body.first, body.url.endsWith('text') ? 120 : 255);
      assert.ok(!body.unavailable && !body.truncated);
    }
    assert.equal(result.file.size, 21 * 1024 * 1024);
    assert.equal(result.file.bytes, result.file.size);
    console.log('Chromium: full 32 MiB text and binary responses plus a 21 MiB file survive HAR staging/export');
  } finally {
    await context?.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
