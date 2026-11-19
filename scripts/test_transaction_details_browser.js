#!/usr/bin/env node
// Optional visual smoke test; requires Playwright and Chromium or Firefox.
const {chromium, firefox} = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
(async () => {
  const browser = process.env.PLAYWRIGHT_FIREFOX ? await firefox.launch({headless: true}) : await chromium.launch({
    channel: process.env.PLAYWRIGHT_CHANNEL || 'chromium', executablePath: process.env.CHROMIUM_PATH, headless: true
  });
  try {
    for (const kind of ['chrome', 'firefox']) {
      const page = await browser.newPage({locale: 'en-US', viewport: {width: 1120, height: 660}});
      await page.route('http://recorder.test/**', route => {
        const file = path.basename(new URL(route.request().url()).pathname);
        route.fulfill({path: path.join(__dirname, '..', kind, file), contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html'});
      });
      await page.addInitScript(kind => {
        const requests = [
          ['/', 0, 280, 18520, 60, 180, 40],
          ['/assets/application.js', 100, 360, 245810, 0, 130, 230],
          ['/api/scenarios', 160, 410, 34520, 25, 340, 45],
          ['/assets/styles.css', 175, 150, 12840, 0, 45, 105],
          ['/api/user', 300, 260, 2100, 20, 210, 30],
          ['/cached-icon.svg', 330, 5, 0, 0, 3, 2],
          ['/unavailable', 440, 170, -1, -1, -1, -1]
        ].map(([url, offset, time, size, connect, wait, receive], ordinal) => ({
          ordinal, transactionId: 't1', method: 'GET', status: ordinal === 6 ? 401 : 200,
          startedDateTime: new Date(1700000000000 + offset).toISOString(), time, size,
          url: 'https://application.example' + url,
          timings: ordinal === 6 ? null : {blocked: 0, dns: 0, connect, ssl: connect, send: 0, wait, receive}
        }));
        requests.push({ordinal: 10, transactionId: 't1', method: 'GET', status: 200, fromCache: 'memory', url: 'https://application.example/logo.svg', startedDateTime: new Date(1700000000200).toISOString(), time: 0, size: 0});
        window[kind === 'chrome' ? 'chrome' : 'browser'] = {runtime: {
          onMessage: {addListener(listener) { window.receiveUpdate = listener; }},
          sendMessage: async () => ({ok: true, transaction: {id: 't1', name: 'UC1_01_OpenHomepage', startedDateTime: new Date(1699999940000).toISOString(), requestCount: 8}, requests})
        }};
      }, kind);
      await page.goto('http://recorder.test/transaction-details.html?transaction=t1');
      await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 7);
      await page.evaluate(() => receiveUpdate({type: 'recorder-status-changed', status: {transactions: [{
        id: 't1', name: 'UC1_01_OpenHomepage', requestCount: 99, pendingCount: 0
      }]}}));
      assert.doesNotMatch(await page.locator('#transaction-details-summary').innerText(), /pending/);
      const first = page.locator('tbody tr').first();
      assert.equal(await first.locator('td').count(), 7);
      assert.ok((await first.boundingBox()).height <= 30);
      assert.equal(await page.locator('#timing-unknown-legend').isVisible(), true);
      assert.equal(await first.locator('.request-detail-size').innerText(), '18.5');
      assert.equal(await page.locator('tbody tr').nth(5).locator('.request-detail-size').innerText(), '0.0');
      assert.equal(await page.locator('tbody tr').last().locator('.request-detail-size').innerText(), '—');
      assert.equal(await first.locator('.waterfall-bar').count(), 3);
      // SSL must not be added to connect a second time.
      const ratio = await first.locator('.phase-connection').evaluate(el => parseFloat(el.style.width));
      assert.ok(Math.abs(ratio - 60 / 610 * 100) < 0.001);
      assert.equal(await page.locator('tbody tr').last().locator('.phase-unknown').count(), 1);
      assert.equal(await first.locator('.request-detail-start').innerText(), '0 ms');
      assert.equal(await first.locator('td').nth(5).innerText(), '280 ms');
      assert.equal(await first.locator('td').nth(6).innerText(), '18.5');
      assert.match(await page.locator('thead th').nth(5).innerText(), /Duration/i);
      assert.match(await page.locator('thead th').nth(6).innerText(), /Size/i);
      assert.deepEqual(await page.locator('.waterfall-tick').allTextContents(), ['0 ms', '200 ms', '400 ms', '600 ms']);
      assert.match(await page.locator('#transaction-details-summary').innerText(), /313.8 KB recorded \(partial\).*610 ms to last response/);
      assert.equal(await first.locator('.request-detail-url-text').innerText(), '/');
      await page.locator('#cache-toggle').click();
      assert.equal(await page.locator('tbody tr').count(), 8);
      assert.equal(await page.locator('.cache-badge').count(), 1);
      await page.locator('#cache-toggle').click();
      assert.equal(await page.locator('tbody tr').count(), 7);
      const bounds = await first.locator('.waterfall-cell').boundingBox();
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      assert.match(await page.locator('#waterfall-hover-time').innerText(), /30[4-6] ms since first request/);
      assert.equal(await page.locator('.waterfall-hovering').count(), 1);
      assert.equal(await page.locator('#request-timing-tooltip').isVisible(), true);
      assert.match(await page.locator('#request-timing-tooltip').innerText(), /End offset\s+280 ms/);
      await page.screenshot({path: `/tmp/breaktest-${kind}-waterfall.png`});
      await page.emulateMedia({colorScheme: 'dark'});
      await page.screenshot({path: `/tmp/breaktest-${kind}-waterfall-dark.png`});
      await page.evaluate(() => receiveUpdate({type: 'request-finished', summary: {
        ordinal: 7, transactionId: 't1', method: 'GET', status: 200, url: 'https://application.example/live',
        startedDateTime: new Date(1700000000700).toISOString(), time: 100, size: 1500,
        timings: {connect: 10, wait: 60, receive: 30}
      }}));
      assert.equal(await page.locator('tbody tr').last().locator('.request-detail-size').innerText(), '1.5');
      assert.equal(await page.locator('tbody tr').last().locator('.waterfall-bar').count(), 3);
      await page.evaluate(() => receiveUpdate({type: 'request-finished', summary: {
        ordinal: 6, transactionId: 't1', method: 'GET', status: 200, url: 'https://application.example/fallback',
        startedDateTime: new Date(1700000000440).toISOString(), time: 170, size: 1500,
        timingSource: 'response-events', timings: {connect: -1, wait: 100, receive: 70}
      }}));
      assert.equal(await page.locator('#timing-unknown-legend').isVisible(), false);
      const fallback = page.locator('tbody tr').nth(6);
      assert.equal(await fallback.locator('.waterfall-bar').count(), 2);
      assert.match(await fallback.locator('.request-detail-url-text').getAttribute('title'), /connection and waiting combined/);
      for (const fromCache of ['disk', 'memory', 'firefox-cache']) {
        await page.evaluate(fromCache => receiveUpdate({type: 'request-finished', summary: {
          ordinal: 8, transactionId: 't1', method: 'GET', status: 200, fromCache,
          url: 'https://application.example/cached', startedDateTime: new Date(1700000000800).toISOString(), time: 0, size: 0
        }}), fromCache);
        assert.equal(await page.locator('tbody tr').count(), 8);
        assert.match(await page.locator('#cache-toggle').innerText(), /2 cached hidden/);
        assert.doesNotMatch(await page.locator('#transaction-details-summary').innerText(), /pending/);
      }
      for (const [status, fromCache, failed] of [[304, 'disk', false], [200, 'service-worker', false], [0, 'memory', true], [204, undefined, false]]) {
        await page.evaluate(({status, fromCache, failed}) => receiveUpdate({type: 'request-finished', summary: {
          ordinal: 8, transactionId: 't1', method: 'GET', status, fromCache, failed,
          url: 'https://application.example/network', startedDateTime: new Date(1700000000800).toISOString(), time: 0, size: 0
        }}), {status, fromCache, failed});
        assert.equal(await page.locator('tbody tr').count(), 9);
      }
      await page.evaluate(() => receiveUpdate({type: 'request-finished', summary: {
        ordinal: 9, transactionId: 't1', method: 'GET', status: 200,
        url: 'https://application.example/slow', startedDateTime: new Date(1700000000900).toISOString(), time: 4000, size: 100
      }}));
      assert.deepEqual(await page.locator('.waterfall-tick').allTextContents(), ['0 ms', '1.00 s', '2.00 s', '3.00 s', '4.00 s']);
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#request-timing-tooltip').isVisible(), false);
      await first.locator('.waterfall-cell').focus();
      assert.equal(await page.locator('#request-timing-tooltip').isVisible(), true);
      await page.setViewportSize({width: 780, height: 420});
      const dimensions = await page.evaluate(() => {
        for (let ordinal = 11; ordinal <= 40; ordinal++) {
          receiveUpdate({type: 'request-finished', summary: {
            ordinal, transactionId: 't1', method: 'GET', status: ordinal === 40 ? 500 : 200,
            url: 'https://application.example/request-' + ordinal,
            startedDateTime: new Date(1700000001000 + ordinal).toISOString(), time: 120, size: 100
          }});
        }
        const scroller = document.querySelector('.request-detail-table-wrap');
        scroller.scrollTo(60, 100);
        return {width: scroller.scrollWidth, height: scroller.scrollHeight};
      });
      const [download] = await Promise.all([
        page.waitForEvent('download', {timeout: 10000}),
        page.getByRole('button', {name: 'Save as PNG'}).click()
      ]);
      assert.equal(download.suggestedFilename(), 'UC1_01_OpenHomepage-waterfall.png');
      const image = fs.readFileSync(await download.path());
      assert.equal(image.toString('hex', 0, 8), '89504e470d0a1a0a');
      assert.ok(image.readUInt32BE(16) > dimensions.width);
      assert.ok(image.readUInt32BE(20) > dimensions.height);
      const lastRowColor = await page.evaluate(async png => {
        const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(png), byte => byte.charCodeAt(0))]));
        const canvas = document.createElement('canvas');
        canvas.width = 1;
        canvas.height = 1;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 17, bitmap.height - 25, 1, 1, 0, 0, 1, 1);
        return Array.from(ctx.getImageData(0, 0, 1, 1).data);
      }, image.toString('base64'));
      assert.deepEqual(lastRowColor, [58, 32, 35, 255], 'the offscreen failed row is rendered in the dark theme');
      const scroll = await page.locator('.request-detail-table-wrap').evaluate(el => [el.scrollLeft, el.scrollTop]);
      assert.deepEqual(scroll, [60, 100]);
      console.log(`${kind}: timing, live updates and full waterfall PNG passed`);
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
