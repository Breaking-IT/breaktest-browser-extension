#!/usr/bin/env node
// Real private-window extension page, actual sidebar code and download bytes.
// FIREFOX_PATH and WEB_EXT_CLI select Firefox and web-ext. No user profile is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {spawn} = require('node:child_process');
(async () => {
  assert.ok(process.env.FIREFOX_PATH && process.env.WEB_EXT_CLI, 'Set FIREFOX_PATH and WEB_EXT_CLI');
  const incognito = process.env.TEST_PRIVATE_EXPORT !== '0';
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'breaktest-private-export-'));
  const extension = path.join(temp, 'extension');
  const downloadDir = path.join(temp, 'downloads');
  const profile = path.join(temp, 'profile');
  fs.mkdirSync(downloadDir);
  fs.mkdirSync(profile);
  // Firefox imports this permission record into its current permission store.
  // Seed only the disposable test profile, never the user's installed browser.
  fs.writeFileSync(path.join(profile, 'extension-preferences.json'), JSON.stringify({
    'browser-recorder@breaktest.io': {permissions: ['internal:privateBrowsingAllowed'], origins: [], data_collection: []}
  }));
  fs.cpSync(path.resolve(__dirname, '../firefox'), extension, {recursive: true});
  let finish;
  const result = new Promise(resolve => { finish = resolve; });
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => { finish(JSON.parse(body)); res.end('ok'); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const resultUrl = `http://127.0.0.1:${server.address().port}/result`;
  const manifestPath = path.join(extension, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath));
  manifest.background.scripts.push('private-export-test.js');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  fs.writeFileSync(path.join(extension, 'private-export-test.js'), `
    let testDownloadId, testAttempts = 0;
    const nativeDownload = browser.downloads.download.bind(browser.downloads);
    browser.downloads.download = async options => {
      if (!options.saveAs || options.incognito !== ${incognito}) throw new Error('Save As/private flags lost');
      if (++testAttempts === 1) throw new Error('Test: user cancelled Save As');
      // Only the native file picker is bypassed in this automated test.
      return testDownloadId = await nativeDownload({...options, saveAs: false});
    };
    browser.runtime.onMessage.addListener((message, sender) => {
      if (message.type === 'private-export-test-reopen') {
        return browser.tabs.create({windowId: sender.tab.windowId,
          url: browser.runtime.getURL('sidebar.html?private-export-test=retry')})
          .then(() => browser.tabs.remove(sender.tab.id));
      }
      if (message.type === 'private-export-test-result') {
        return (async () => {
          const item = testDownloadId && (await browser.downloads.search({id: testDownloadId}))[0];
          await fetch(${JSON.stringify(resultUrl)}, {method: 'POST', body: JSON.stringify({
            ...message, attempts: testAttempts, download: item
          })});
        })();
      }
    });
    (async () => {
      try {
        await recordingReady;
        if (!await browser.extension.isAllowedIncognitoAccess()) throw new Error('Test extension lacks private browsing access');
        await HarExportStore.save({log: {version: '1.2', entries: [{response: {content: {text: 'discard this HAR'}}}]}});
        await new Promise(resolve => setTimeout(resolve, 10));
        await HarExportStore.save({log: {version: '1.2', entries: [{response: {content: {text: 'private HAR data'}}}]}});
        await browser.windows.create({incognito: ${incognito}, url: browser.runtime.getURL('sidebar.html?private-export-test=first')});
      } catch (error) {
        await fetch(${JSON.stringify(resultUrl)}, {method: 'POST', body: JSON.stringify({error: String(error), stack: error.stack})});
      }
    })();
  `);
  fs.appendFileSync(path.join(extension, 'sidebar.js'), `
    (async () => {
      try {
        if (!location.search.includes('private-export-test')) return;
        for (let i = 0; i < 100 && !pendingExport; i++) await new Promise(resolve => setTimeout(resolve, 50));
        if (inPrivateContext !== ${incognito} || !pendingExport) throw new Error('Sidebar did not restore the staged HAR: ' + statusText.textContent);
        const savedId = pendingExport.id;
        let privateDatabaseError;
        try {
          await new Promise((resolve, reject) => {
            const request = indexedDB.open('private-context-regression-probe');
            request.onsuccess = () => { request.result.close(); resolve(); };
            request.onerror = () => reject(request.error);
          });
        } catch (error) { privateDatabaseError = error.name + ': ' + error.message; }
        await finishRecording();
        if (location.search.endsWith('first')) {
          if (!pendingExport || !statusText.textContent.includes('Test: user cancelled')) throw new Error('Failed download was not retryable');
          await browser.runtime.sendMessage({type: 'private-export-test-reopen'});
          return;
        }
        if (pendingExport || !statusText.textContent.startsWith('HAR saved.')) throw new Error('Retry failed: ' + statusText.textContent);
        await restorePendingExport();
        if (!pendingExport || pendingExport.id === savedId) throw new Error('Saved HAR was not cleaned up');
        // Confirm discard only in this disposable test page.
        window.confirm = () => true;
        await discardAndStartOver();
        const latest = await send({type: 'har-export-latest'});
        if (!latest.ok || latest.export || pendingExport) throw new Error('Discard did not remove the remaining HAR');
        await browser.runtime.sendMessage({type: 'private-export-test-result', privateDatabaseError, saved: true});
      } catch (error) {
        await browser.runtime.sendMessage({type: 'private-export-test-result', error: String(error), stack: error.stack});
      }
    })();
  `);
  const child = spawn(process.execPath, [process.env.WEB_EXT_CLI, 'run', '--source-dir', extension,
    '--firefox', process.env.FIREFOX_PATH, '--firefox-profile', profile, '--no-reload', '--args=-headless',
    '--pref=browser.download.folderList=2',
    '--pref=browser.download.useDownloadDir=true', `--pref=browser.download.dir=${downloadDir}`],
    {stdio: ['ignore', 'pipe', 'pipe']});
  let output = '', timer;
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  try {
    const captured = await Promise.race([result, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Private HAR export timed out: ' + output)), 45000);
    })]);
    assert.ok(!captured.error, JSON.stringify(captured));
    assert.equal(captured.saved, true);
    assert.equal(captured.attempts, 2);
    assert.equal(captured.download.state, 'complete');
    assert.equal(captured.download.incognito, incognito);
    const har = JSON.parse(fs.readFileSync(captured.download.filename, 'utf8'));
    assert.equal(har.log.entries[0].response.content.text, 'private HAR data');
    console.log('Firefox ' + (incognito ? 'private' : 'normal') + ' sidebar: cancelled download retained; reopened sidebar retries, saves exact HAR bytes, cleans up and discards');
    console.log('Direct sidebar IndexedDB probe:', captured.privateDatabaseError || 'available in this Firefox build');
  } finally {
    clearTimeout(timer);
    child.kill();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temp, {recursive: true, force: true});
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
