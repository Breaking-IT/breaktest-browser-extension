#!/usr/bin/env node
// Optional real-browser smoke test: requires Playwright and its Chromium install.
const {chromium} = require("playwright");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");

(async () => {
  const received = [];
  const server = http.createServer((request, response) => {
    if (request.url === "/auth") {
      if (request.headers.authorization === "Basic dGVzdDp0ZXN0") {
        response.end("Authenticated");
      } else {
        response.writeHead(401, {"WWW-Authenticate": 'Basic realm="Recorder test"'});
        response.end("Authentication required");
      }
    } else if (request.method === "POST") {
      const chunks = [];
      request.on("data", chunk => chunks.push(chunk));
      request.on("end", () => {
        received.push(Buffer.concat(chunks));
        response.end("uploaded");
      });
    } else {
      response.setHeader("Content-Type", "text/html");
      response.end('<form action="/upload" method="post" enctype="multipart/form-data"><input name="attachment" type="file"><button>Upload</button></form>');
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const extension = path.resolve(__dirname, "../chrome");
  let context;
  try {
    context = await chromium.launchPersistentContext("", {
      channel: "chromium", headless: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const page = await context.newPage();
    const url = `http://127.0.0.1:${server.address().port}/`;
    await page.goto(url);
    await page.evaluate(() => { window.recordingStartMarker = "preserve-current-page"; });
    await worker.evaluate(async url => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find(item => item.url === url);
      await startRecording({tabId: tab.id, transactionName: "File upload"});
    }, url);
    assert.equal(await page.evaluate(() => window.recordingStartMarker), "preserve-current-page");
    await worker.evaluate(async () => {
      const recordedId = recorderStatus().tabId;
      const otherWindow = await chrome.windows.create({url: "about:blank"});
      try {
        const result = await handleMessage({type: "focus-recording-tab"});
        if (result.tabId !== recordedId) throw new Error("Wrong recording tab selected");
        const tab = await chrome.tabs.get(recordedId);
        if (!tab.active || !(await chrome.windows.get(tab.windowId)).focused) throw new Error("Recording window not focused");
        if (await chrome.action.getBadgeText({tabId: recordedId}) !== "REC") throw new Error("Recording badge missing");
        if (await chrome.action.getBadgeText({tabId: otherWindow.tabs[0].id}) !== "") throw new Error("Badge leaked to another tab");
      } finally { await chrome.windows.remove(otherWindow.id); }
    });
    const body = Buffer.from('{"log":{"entries":[]},"test":"HAR upload é😀"}');
    await page.locator('input[type="file"]').setInputFiles({name: "source.har", mimeType: "application/json", buffer: body});
    await page.waitForTimeout(50);
    // Exercise a genuine multipart upload followed by navigation.
    await Promise.all([page.waitForURL("**/upload"), page.getByRole("button", {name: "Upload"}).click()]);
    const har = await worker.evaluate(async () => {
      const result = await stopRecording();
      const record = await HarExportStore.get(result.export.id);
      return JSON.parse(await record.blob.text());
    });
    assert.equal(received.length, 1);
    assert.ok(received[0].includes(body));
    const files = har.log._breaktest.uploadCapture.files;
    const file = files.find(item => item.fileName === "source.har" && item.status === "complete");
    assert.ok(file, JSON.stringify(files));
    assert.deepEqual(Buffer.from(file.content, "base64"), body);
    assert.ok(har.log.entries.some(entry => entry.request.method === "POST"));
    console.log("Chromium: real multipart upload and saved HAR file bytes passed");
    const authStatus = await worker.evaluate(async url => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find(item => item.url === url + "upload");
      return startRecording({tabId: tab.id, transactionName: "01_Auth", startUrl: url + "auth"});
    }, url);
    assert.equal(authStatus.active, true);
    assert.equal(authStatus.attached, true);
    // Supply credentials only to this local test server and retry the challenged page.
    await page.setExtraHTTPHeaders({Authorization: "Basic dGVzdDp0ZXN0"});
    await page.goto(url + "auth");
    assert.equal(await page.locator("body").innerText(), "Authenticated");
    const authHar = await worker.evaluate(async () => {
      const result = await stopRecording();
      const record = await HarExportStore.get(result.export.id);
      return JSON.parse(await record.blob.text());
    });
    assert.ok(authHar.log.entries.some(entry => entry.response.status === 401), "Initial 401 retained");
    assert.ok(authHar.log.entries.some(entry => entry.request.url.endsWith("/auth") && entry.response.status === 200), "Authenticated retry retained");
    console.log("Chromium: initial 401 and authenticated retry retained in the same HAR");
  } finally {
    await context?.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
