#!/usr/bin/env node
// Optional real-browser smoke test: requires Playwright and its Chromium install.
const {chromium} = require("playwright");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");

(async () => {
  const received = [];
  const server = http.createServer((request, response) => {
    if (request.method === "POST") {
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
  } finally {
    await context?.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
