#!/usr/bin/env node
// Real extension regression: a document moves from the root CDP session to an OOPIF.
// Set CHROMIUM_PATH to extension-capable Chromium and NODE_PATH to Playwright.
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
(async () => {
  assert.ok(process.env.CHROMIUM_PATH, 'Set CHROMIUM_PATH');
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(req.url === '/frame'
      ? '<title>Cross-site iframe</title><p>Frame response preserved</p>'
      : `<title>Parent</title><iframe src="http://localhost:${server.address().port}/frame"></iframe>`);
  });
  await new Promise(resolve => server.listen(0, resolve));
  const extension = path.resolve(__dirname, '../chrome');
  let context;
  try {
    context = await chromium.launchPersistentContext('', {executablePath: process.env.CHROMIUM_PATH, headless: true,
      args: ['--site-per-process', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`]});
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const url = `http://127.0.0.1:${server.address().port}/`;
    await worker.evaluate(async url => {
      globalThis.iframeProbe = [];
      chrome.debugger.onEvent.addListener((source, method, params) => {
        if (['Network.requestWillBeSent','Network.loadingFinished'].includes(method)) {
          iframeProbe.push({method, session: source.sessionId || 'root', id: params.requestId, url: params.request?.url});
        }
      });
      const tab = await chrome.tabs.create({url: 'about:blank'});
      await startRecording({tabId: tab.id, transactionName: 'Cross-site document', startUrl: url});
    }, url);
    let result;
    for (let attempt = 0; attempt < 100; attempt++) {
      result = await worker.evaluate(() => ({pending: recorderStatus().pendingCount,
        entries: recording.entries.map(entry => ({url: entry.request.url, body: entry.response.content.text})),
        events: iframeProbe}));
      if (result.entries.some(entry => entry.url.endsWith('/frame')) && result.pending === 0) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const started = result.events.find(event => event.url?.endsWith('/frame'));
    const finished = result.events.find(event => event.method === 'Network.loadingFinished' && event.id === started?.id);
    assert.ok(started && finished, JSON.stringify(result));
    assert.notEqual(started.session, finished.session, 'test must exercise the cross-session document handoff');
    assert.equal(result.pending, 0, JSON.stringify(result));
    assert.equal(result.entries.filter(entry => entry.url.endsWith('/frame')).length, 1);
    assert.match(result.entries.find(entry => entry.url.endsWith('/frame')).body, /Frame response preserved/);
    // Repeat with a warm cache: the child can finish before Network.enable
    // unless auto-attachment pauses it until capture is installed.
    const page = context.pages().find(page => page.url().startsWith(url));
    for (let navigation = 0; navigation < 3; navigation++) {
      await page.reload({waitUntil: 'load'});
      for (let attempt = 0; attempt < 100; attempt++) {
        result = await worker.evaluate(() => ({pending: recorderStatus().pendingCount,
          frames: recording.entries.filter(entry => entry.request.url.endsWith('/frame')).length}));
        if (result.pending === 0 && result.frames === navigation + 2) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.equal(result.pending, 0, JSON.stringify(result));
      assert.equal(result.frames, navigation + 2, 'each warm-cache navigation preserves its iframe request');
    }
    console.log('Chromium OOPIF: initial and three warm-cache navigations clear pending and preserve responses');
  } finally {
    await context?.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
