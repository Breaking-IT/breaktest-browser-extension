#!/usr/bin/env node
// Optional UI smoke test: NODE_PATH pointing at a Playwright install, plus Chromium.
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
(async () => {
  const server = http.createServer((req, res) => {
    const relative = req.url.split('?')[0];
    if (!/^\/(chrome|firefox)\/[a-z.-]+$/.test(relative)) { res.writeHead(404).end(); return; }
    const file = path.join(__dirname, '..', relative);
    if (!fs.existsSync(file)) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({channel: 'chromium', headless: true});
    for (const [kind, panel] of [['chrome','sidepanel'], ['firefox','sidebar']]) {
      const page = await browser.newPage({viewport: {width: 380, height: 850}});
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(kind => {
        window.sent = [];
        let status = {ok: true, active: false, transactions: []};
        const api = {
          extension: {inIncognitoContext: false},
          windows: {getCurrent: async () => ({id: 1, incognito: false})},
          tabs: {query: async () => [{id: 1, windowId: 1, url: 'https://example.test/already-loaded'}]},
          storage: {local: {get: async () => ({recordingDisclosureAcceptedVersion: 3}), set: async () => {}, remove: async () => {}}},
          runtime: {
            connect: () => ({}), onMessage: {addListener() {}},
            sendMessage: async message => {
              window.sent.push(message);
              if (message.type === 'start-recording') {
                status = {ok: true, active: true, currentTransaction: {id: 't1', name: message.transactionName}, transactions: []};
              }
              if (message.type === 'new-transaction') {
                if (window.failNext) { window.failNext = false; return {ok: false, error: 'Try again'}; }
                status.currentTransaction = {id: 't2', name: message.name};
                return {ok: true, status, transaction: status.currentTransaction};
              }
              return status;
            }
          }
        };
        window[kind === 'chrome' ? 'chrome' : 'browser'] = api;
      }, kind);
      await page.goto(`http://127.0.0.1:${server.address().port}/${kind}/${panel}.html`);
      await page.waitForFunction(() => !document.querySelector('#start-button').disabled);
      assert.equal(await page.locator('#blank-start-button').count(), 0);
      assert.equal(await page.locator('#start-button').innerText(), 'Start recording here');
      assert.equal(await page.locator(kind === 'chrome' ? '#incognito-start-button' : '#private-start-button').innerText(), 'Start in incognito');
      await page.locator('#transaction-name').fill('UC1_01_Homepage');
      await page.locator('#start-button').click();
      await page.waitForFunction(() => !document.querySelector('#next-transaction-button').disabled);
      const start = await page.evaluate(() => sent.find(message => message.type === 'start-recording'));
      assert.equal(start.startUrl, '');
      assert.ok(!start.createBlankTab);
      await page.locator('#next-transaction-button').click();
      assert.equal(await page.locator('#next-transaction-input').inputValue(), 'UC1_02_');
      await page.locator('#next-transaction-input').fill('UC1_02_Login');
      await page.locator('#cancel-next-transaction').click();
      assert.equal(await page.locator('#transaction-name').inputValue(), 'UC1_01_Homepage');
      assert.equal(await page.evaluate(() => sent.filter(message => message.type === 'new-transaction').length), 0);
      await page.locator('#next-transaction-button').click();
      await page.locator('#next-transaction-input').fill('UC1_02_Login');
      await page.evaluate(() => { window.failNext = true; });
      await page.locator('#next-transaction-input').press('Enter');
      await page.waitForFunction(() => !document.querySelector('#next-transaction-error').hidden);
      assert.equal(await page.locator('#transaction-name').inputValue(), 'UC1_01_Homepage');
      await page.locator('#confirm-next-transaction').click();
      await page.waitForFunction(() => !document.querySelector('#next-transaction-dialog').open);
      assert.equal(await page.locator('#transaction-name').inputValue(), 'UC1_02_Login');
      await page.locator('#next-transaction-button').click();
      assert.equal(await page.locator('#next-transaction-input').inputValue(), 'UC1_03_');
      await page.screenshot({path: `/tmp/breaktest-${kind}-next-transaction.png`});
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#next-transaction-dialog').evaluate(dialog => dialog.open), false);
      assert.deepEqual(errors, []);
      console.log(`${kind}: start without navigation, popup, counter, cancel, retry and confirmation passed`);
      await page.close();
    }
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
