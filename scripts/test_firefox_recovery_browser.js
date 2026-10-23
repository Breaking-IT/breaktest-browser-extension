#!/usr/bin/env node
// Optional real Firefox test. Set FIREFOX_PATH and WEB_EXT_CLI.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const {spawn} = require('node:child_process');
const assert = require('node:assert/strict');
(async () => {
  assert.ok(process.env.FIREFOX_PATH && process.env.WEB_EXT_CLI, 'Set FIREFOX_PATH and WEB_EXT_CLI');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'breaktest-recovery-'));
  const extension = path.join(temp, 'extension');
  fs.cpSync(path.resolve(__dirname, '../firefox'), extension, {recursive: true});
  let finish;
  const result = new Promise(resolve => { finish = resolve; });
  const server = http.createServer((req, res) => {
    if (req.url === '/result') {
      let data = ''; req.on('data', chunk => { data += chunk; });
      req.on('end', () => { finish(JSON.parse(data)); res.end('ok'); });
    } else if (req.url.startsWith('/data')) {
      res.setHeader('content-type', 'text/plain'); res.end('preserved response ' + req.url);
    } else { res.setHeader('content-type', 'text/html'); res.end('<title>Recovery test</title>'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const manifestPath = path.join(extension, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath));
  manifest.background.scripts.push('recovery-test.js');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  fs.writeFileSync(path.join(extension, 'recovery-test.js'), `
    (async () => {
      try {
        await recordingReady;
        const stage = (await browser.storage.session.get('testStage')).testStage;
        if (!stage) {
          let tab;
          for (let i = 0; i < 100 && !tab; i++) {
            tab = (await browser.tabs.query({})).find(t => t.url === ${JSON.stringify(url)} && t.status === 'complete');
            if (!tab) await new Promise(resolve => setTimeout(resolve, 100));
          }
          if (!tab) throw new Error('Test tab unavailable');
          await startRecording({tabId: tab.id, transactionName: '01_Before'});
          await browser.scripting.executeScript({target: {tabId: tab.id}, func: () => fetch('/data-before').then(r => r.text())});
          for (let i = 0; i < 100 && !recording.entries.some(e => e.request.url.endsWith('/data-before')); i++) await new Promise(resolve => setTimeout(resolve, 50));
          if (!recording.entries.length) throw new Error('No captured request before restart');
          startTransaction('02_After');
          await checkpointRecording();
          await browser.storage.session.set({testStage: {tabId: tab.id}});
          location.reload();
          return;
        }
        if (!recording || !recording.recoveryNotice) throw new Error('Background did not recover');
        const before = recording.entries.find(e => e.request.url.endsWith('/data-before'));
        const content = before?.response.content;
        const body = content?.encoding === 'base64' ? atob(content.text) : content?.text;
        if (body !== 'preserved response /data-before') throw new Error('Response body lost');
        if (recording.currentTransaction.name !== '02_After') throw new Error('Transaction lost');
        await browser.scripting.executeScript({target: {tabId: stage.tabId}, func: () => fetch('/data-after').then(r => r.text())});
        for (let i = 0; i < 100 && !recording.entries.some(e => e.request.url.endsWith('/data-after')); i++) await new Promise(resolve => setTimeout(resolve, 50));
        const response = await stopRecording();
        const har = JSON.parse(await (await HarExportStore.get(response.export.id)).blob.text());
        await fetch(${JSON.stringify(url + 'result')}, {method: 'POST', body: JSON.stringify({har})});
      } catch (error) {
        await fetch(${JSON.stringify(url + 'result')}, {method: 'POST', body: JSON.stringify({error: String(error), stack: error.stack})});
      }
    })();
  `);
  const child = spawn(process.execPath, [process.env.WEB_EXT_CLI, 'run', '--source-dir', extension,
    '--firefox', process.env.FIREFOX_PATH, '--no-reload', '--start-url', url, '--args=-headless'], {stdio: ['ignore', 'pipe', 'pipe']});
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  let timer;
  try {
    const captured = await Promise.race([result, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Firefox recovery test timed out: ' + output)), 45000);
    })]);
    assert.ok(!captured.error, JSON.stringify(captured));
    for (const suffix of ['before', 'after']) {
      const entry = captured.har.log.entries.find(e => e.request.url.endsWith('/data-' + suffix));
      const content = entry?.response.content;
      const body = content?.encoding === 'base64' ? Buffer.from(content.text, 'base64').toString() : content?.text;
      assert.equal(body, 'preserved response /data-' + suffix);
    }
    assert.equal(captured.har.log._breaktest.transactions[1].name, '02_After');
    console.log('Real Firefox: background document restart preserves responses and transactions; capture resumes and HAR exports');
  } finally {
    clearTimeout(timer); child.kill();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temp, {recursive: true, force: true});
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
