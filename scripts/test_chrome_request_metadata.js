#!/usr/bin/env node

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const listener = () => ({addListener() {}});
const context = {
  console,
  atob,
  crypto: require("node:crypto").webcrypto,
  URL,
  URLSearchParams,
  Blob,
  TextEncoder,
  TextDecoder,
  setTimeout,
  clearTimeout,
  importScripts() {}
};
context.globalThis = context;
context.HarExportStore = {
  cleanupStale: async () => {},
  save: async () => ({id: "export"})
};
context.chrome = {
  commands: {onCommand: listener()},
  runtime: {
    onInstalled: listener(),
    onStartup: listener(),
    onMessage: listener(),
    sendMessage: async () => {},
    getManifest: () => ({version: "1.1.0"})
  },
  tabs: {
    onCreated: listener(),
    onReplaced: listener(),
    query: async () => [],
    get: async id => ({id, url: "https://example.test/", title: "test"}),
    create: async () => ({id: 2}),
    update: async () => ({})
  },
  windows: {
    create: async () => ({}),
    get: async () => ({tabs: []})
  },
  sidePanel: {
    setPanelBehavior: async () => {},
    setOptions: async () => {},
    open: async () => {}
  },
  debugger: {
    onEvent: listener(),
    onDetach: listener(),
    attach: async () => {},
    detach: async () => {},
    sendCommand: async (_source, method) => method === "Network.getResponseBody"
      ? {body: "", base64Encoded: false}
      : {}
  },
  action: {
    setBadgeText: async () => {},
    setBadgeBackgroundColor: async () => {}
  },
  storage: {
    local: {
      get: async () => ({}),
      set: async () => {},
      remove: async () => {}
    }
  },
  extension: {inIncognitoContext: false}
};

vm.createContext(context);
vm.runInContext(fs.readFileSync(path.resolve(__dirname, "../chrome/upload-store.js"), "utf8"), context);
vm.runInContext(fs.readFileSync(path.resolve(__dirname, "../chrome/websocket-lifecycle.js"), "utf8"), context);
for (const name of ["message-capture.js", "sse-capture.js"]) vm.runInContext(fs.readFileSync(path.resolve(__dirname, "../chrome", name), "utf8"), context);
const workerPath = path.resolve(__dirname, "../chrome/service-worker.js");
vm.runInContext(fs.readFileSync(workerPath, "utf8"), context);

function resetRecording() {
  vm.runInContext(`recording = {
    tabId: 1,
    tabTitle: "",
    incognito: false,
    disableCache: false,
    startedAt: Date.now(),
    attached: true,
    stopping: false,
    transactions: [{id: "t1", name: "Transaction", order: 1, requestCount: 0}],
    currentTransaction: {id: "t1", name: "Transaction", order: 1, requestCount: 0},
    activeRequests: new Map(),
    requestSequences: new Map(),
    requestChains: new Map(),
    entries: [],
    summaries: [],
    pendingTasks: new Set(),
    capturedBodyChars: 0,
    nextTransactionOrdinal: 2,
    nextEntryOrdinal: 0
  }`, context);
}

async function testExtraInfoBeforeRequest() {
  resetRecording();
  vm.runInContext(`requestExtraInfo({tabId: 1}, {
    requestId: "normal",
    headers: {
      ":authority": "www.fedex.com",
      ":method": "GET",
      ":path": "/menu-sprite.png",
      ":scheme": "https",
      "accept": "image/avif,image/webp,*/*",
      "accept-encoding": "gzip, deflate, br, zstd",
      "cookie": "siteDC=atl",
      "sec-fetch-dest": "image"
    },
    associatedCookies: [{
      cookie: {
        name: "siteDC",
        value: "atl",
        domain: ".fedex.com",
        path: "/",
        expires: 1784644222,
        httpOnly: true,
        secure: true
      },
      blockedReasons: []
    }]
  })`, context);
  await vm.runInContext(`requestWillBeSent({tabId: 1}, {
    requestId: "normal",
    timestamp: 1,
    wallTime: 1784557822,
    type: "Image",
    request: {
      method: "GET",
      url: "https://www.fedex.com/menu-sprite.png",
      headers: {Referer: "https://www.fedex.com/style.css"}
    }
  })`, context);
  vm.runInContext(`responseReceived({tabId: 1}, {
    requestId: "normal",
    timestamp: 2,
    type: "Image",
    hasExtraInfo: true,
    response: {
      status: 200,
      protocol: "h2",
      headers: {"content-type": "image/png"}
    }
  })`, context);

  const result = vm.runInContext(`(() => {
    const state = recording.activeRequests.get("root:normal");
    return {
      headers: state.request.headers,
      cookies: state.request.cookies,
      requestVersion: state.request.httpVersion,
      responseVersion: state.response.httpVersion
    };
  })()`, context);
  assert(result.headers.some(header => header.name === "accept-encoding"));
  assert(result.headers.some(header => header.name === "cookie"));
  assert(result.headers.some(header => header.name === "sec-fetch-dest"));
  assert.strictEqual(result.cookies[0].name, "siteDC");
  assert.strictEqual(result.requestVersion, "http/2.0");
  assert.strictEqual(result.responseVersion, "http/2.0");
}

async function testRedirectOrdering(firstHasExtraInfo) {
  resetRecording();
  await vm.runInContext(`requestWillBeSent({tabId: 1}, {
    requestId: "redirect",
    timestamp: 1,
    wallTime: 1784557822,
    type: "Document",
    request: {
      method: "GET",
      url: "https://example.test/one",
      headers: {initial: "one"}
    }
  })`, context);
  if (firstHasExtraInfo) {
    vm.runInContext(`requestExtraInfo({tabId: 1}, {
      requestId: "redirect",
      headers: {attempt: "one"}
    })`, context);
    vm.runInContext(`responseExtraInfo({tabId: 1}, {
      requestId: "redirect",
      statusCode: 302,
      headers: {location: "/two"}
    })`, context);
  }

  // Chrome may deliver the next attempt's extra info before requestWillBeSent.
  vm.runInContext(`requestExtraInfo({tabId: 1}, {
    requestId: "redirect",
    headers: {attempt: "two"}
  })`, context);
  await vm.runInContext(`requestWillBeSent({tabId: 1}, {
    requestId: "redirect",
    timestamp: 2,
    wallTime: 1784557823,
    redirectHasExtraInfo: ${firstHasExtraInfo},
    redirectResponse: {
      status: 302,
      protocol: "h2",
      headers: {location: "/two"}
    },
    type: "Document",
    request: {
      method: "GET",
      url: "https://example.test/two",
      headers: {initial: "two"}
    }
  })`, context);
  vm.runInContext(`responseReceived({tabId: 1}, {
    requestId: "redirect",
    timestamp: 3,
    type: "Document",
    hasExtraInfo: true,
    response: {
      status: 200,
      protocol: "h2",
      headers: {"content-type": "text/html"}
    }
  })`, context);

  const attempts = vm.runInContext(`recording.requestChains.get("root:redirect").attempts
    .map(state => ({
      attempt: state.request.headers.find(header => header.name === "attempt")?.value || null,
      status: state.response.status
    }))`, context);
  assert.strictEqual(attempts[0].attempt, firstHasExtraInfo ? "one" : null);
  assert.strictEqual(attempts[1].attempt, "two");
  assert.strictEqual(attempts[0].status, 302);
  assert.strictEqual(attempts[1].status, 200);
}

async function testNavigationFailureKeepsRecording() {
  const originalCommand = context.chrome.debugger.sendCommand;
  const originalAttach = context.chrome.debugger.attach;
  const originalDetach = context.chrome.debugger.detach;
  const originalNotify = context.chrome.runtime.sendMessage;
  let detached = 0;
  const notifications = [];
  context.chrome.debugger.detach = async () => { detached++; };
  context.chrome.runtime.sendMessage = async message => { notifications.push(message); };
  try {
    for (const failure of ["net::ERR_INVALID_AUTH_CREDENTIALS", "net::ERR_NAME_NOT_RESOLVED", "command-rejected"]) {
      vm.runInContext("recording = null", context);
      notifications.length = 0;
      detached = 0;
      context.chrome.debugger.sendCommand = async (source, method) => {
        if (method !== "Page.navigate") return {};
        assert.ok(notifications.some(message => message.type === "recording-started" && message.active));
        await vm.runInContext(`requestWillBeSent({tabId: 1}, {
          requestId: "auth", timestamp: 1, wallTime: 1784557822, type: "Document",
          request: {method: "GET", url: "https://example.test/auth", headers: {}}
        })`, context);
        vm.runInContext(`responseReceived({tabId: 1}, {
          requestId: "auth", timestamp: 2, hasExtraInfo: false,
          response: {status: 401, headers: {"www-authenticate": 'Basic realm="test"'}, protocol: "http/1.1"}
        }); loadingFailed({tabId: 1}, {requestId: "auth", timestamp: 3, errorText: "authentication required"});`, context);
        if (failure === "command-rejected") throw new Error("navigation command failed");
        return {errorText: failure};
      };
      const result = await vm.runInContext('startRecording({tabId: 1, transactionName: "01_Auth", startUrl: "https://example.test/auth"})', context);
      assert.strictEqual(result.active, true);
      assert.strictEqual(result.attached, true);
      assert.strictEqual(detached, 0);
      assert.match(result.startWarning, /Recording is active/);
      assert.strictEqual(vm.runInContext('recording.entries[0].response.status', context), 401);
      const detail = vm.runInContext('transactionDetails(recording.currentTransaction.id).requests[0]', context);
      assert.strictEqual(detail.timingSource, "response-events");
      assert.strictEqual(detail.timings.wait, 1000);
      assert.strictEqual(detail.timings.receive, 1000);
      assert.strictEqual(detail.timings.connect, -1);
      assert.strictEqual(vm.runInContext('recording.summaries[0].timings.receive', context), 1000);
      await vm.runInContext(`requestWillBeSent({tabId: 1}, {
        requestId: "retry", timestamp: 4, wallTime: 1784557825, type: "Document",
        request: {method: "GET", url: "https://example.test/auth", headers: {}}
      })`, context);
      assert.strictEqual(vm.runInContext('recording.activeRequests.has("root:retry")', context), true);
    }
    // Genuine attachment/setup errors must still fail and clean up.
    vm.runInContext("recording = null", context);
    context.chrome.debugger.attach = async () => { throw new Error("attach denied"); };
    await assert.rejects(vm.runInContext('startRecording({tabId: 1, transactionName: "01_Auth"})', context), /attach denied/);
    assert.strictEqual(vm.runInContext('recording', context), null);
    context.chrome.debugger.attach = originalAttach;
    context.chrome.debugger.sendCommand = async () => { throw new Error("network enable failed"); };
    await assert.rejects(vm.runInContext('startRecording({tabId: 1, transactionName: "01_Auth"})', context), /network enable failed/);
    assert.strictEqual(vm.runInContext('recording', context), null);
    assert.strictEqual(detached, 1);
  } finally {
    context.chrome.debugger.sendCommand = originalCommand;
    context.chrome.debugger.attach = originalAttach;
    context.chrome.debugger.detach = originalDetach;
    context.chrome.runtime.sendMessage = originalNotify;
  }
}

async function testRecordingLocator() {
  await vm.runInContext('locatorWrites', context);
  const originals = {get: context.chrome.storage.local.get, set: context.chrome.storage.local.set,
    remove: context.chrome.storage.local.remove, tabGet: context.chrome.tabs.get,
    tabUpdate: context.chrome.tabs.update, windowUpdate: context.chrome.windows.update,
    targets: context.chrome.debugger.getTargets, badge: context.chrome.action.setBadgeText};
  const store = {};
  const selected = [];
  const focused = [];
  const badges = [];
  context.chrome.storage.local.get = async () => store;
  context.chrome.storage.local.set = async values => Object.assign(store, values);
  context.chrome.storage.local.remove = async key => { delete store[key]; };
  context.chrome.tabs.get = async id => {
    if (id === 99) throw new Error('closed');
    return {id, windowId: id + 100};
  };
  context.chrome.tabs.update = async (id, options) => { selected.push([id, options.active]); };
  context.chrome.windows.update = async (id, options) => { focused.push([id, options.focused]); };
  context.chrome.debugger.getTargets = async () => [{tabId: 2, attached: true}, {tabId: 99, attached: true}];
  context.chrome.action.setBadgeText = async options => { badges.push(options); };
  try {
    vm.runInContext('recording = {tabId: 1, startedAt: 1}; setRecordingBadge(true)', context);
    await vm.runInContext('locatorWrites', context);
    assert.strictEqual(store.recordingLocatorNormal.tabId, 1);
    await vm.runInContext('focusRecordingTab()', context);
    assert.deepStrictEqual(selected.pop(), [1, true]);
    assert.deepStrictEqual(focused.pop(), [101, true]);
    assert.ok(badges.some(item => item.tabId === 1 && item.text === 'REC'));
    assert.ok(!badges.some(item => item.tabId === undefined && item.text === 'REC'));
    vm.runInContext('setRecordingBadge(false); recording = null', context);
    await vm.runInContext('locatorWrites', context);
    assert.strictEqual(store.recordingLocatorNormal, undefined);
    store.recordingLocatorPrivate = {tabId: 2, startedAt: 2};
    await vm.runInContext('focusRecordingTab()', context);
    assert.deepStrictEqual(selected.pop(), [2, true]);
    assert.deepStrictEqual(focused.pop(), [102, true]);
    store.recordingLocatorPrivate = {tabId: 99, startedAt: 2};
    await assert.rejects(vm.runInContext('focusRecordingTab()', context), /No active recording tab/);
    delete store.recordingLocatorPrivate;
    await assert.rejects(vm.runInContext('focusRecordingTab()', context), /No active recording tab/);
  } finally {
    context.chrome.storage.local.get = originals.get;
    context.chrome.storage.local.set = originals.set;
    context.chrome.storage.local.remove = originals.remove;
    context.chrome.tabs.get = originals.tabGet;
    context.chrome.tabs.update = originals.tabUpdate;
    context.chrome.windows.update = originals.windowUpdate;
    context.chrome.debugger.getTargets = originals.targets;
    context.chrome.action.setBadgeText = originals.badge;
  }
}

// Exercise the debugger dispatcher, with no earlier URL history in the recording.
async function testCacheMetadata() {
  const originalCommand = context.chrome.debugger.sendCommand;
  let bodyResult = {body: "é🐈", base64Encoded: false};
  context.chrome.debugger.sendCommand = async () => bodyResult;
  const event = (method, params, sessionId) => vm.runInContext(
    `handleDebuggerEvent(${JSON.stringify({tabId: 1, ...(sessionId ? {sessionId} : {})})},
      ${JSON.stringify(`Network.${method}`)}, ${JSON.stringify(params)})`, context);
  const start = (requestId, sessionId, extra = {}) => event("requestWillBeSent", {
    requestId, timestamp: 1, wallTime: 1784557822, type: "Image",
    request: {method: "GET", url: "https://example.test/pre-cached.png", headers: {Referer: "https://example.test/"}},
    ...extra
  }, sessionId);
  const response = (requestId, sessionId, extra = {}) => event("responseReceived", {
    requestId, timestamp: 1.00002, hasExtraInfo: false,
    response: {status: 200, protocol: "h2", headers: {}, encodedDataLength: 1182,
      remoteIPAddress: "127.0.0.1", connectionId: 7,
      timing: {dnsStart: -1, dnsEnd: -1, connectStart: -1, connectEnd: -1,
        sslStart: -1, sslEnd: -1, sendStart: 0, sendEnd: 0, receiveHeadersEnd: 30.125},
      ...extra}
  }, sessionId);
  const finish = (requestId, sessionId, encodedDataLength = 0) => event("loadingFinished", {
    requestId, timestamp: 1.000045, encodedDataLength
  }, sessionId);
  const entries = () => JSON.parse(vm.runInContext("JSON.stringify(buildHar(recording).log.entries)", context));
  const assertLocal = (entry, marker) => {
    assert.strictEqual(entry._fromCache, marker);
    assert.strictEqual(entry.response._transferSize, 0);
    assert.strictEqual(entry.response.bodySize, 0);
    assert.strictEqual(entry.response.content.size, 6);
    assert.strictEqual(entry._breaktest.timingSource, "cache");
    assert.strictEqual(entry.timings.wait, 0);
    assert.strictEqual(entry.timings.receive, 0);
    assert.strictEqual(entry.timings.send, 0);
    assert.strictEqual(entry.timings.dns, -1);
    assert.strictEqual(entry.timings.connect, -1);
    assert.strictEqual(entry.timings.ssl, -1);
    assert.strictEqual(entry.timings.blocked, entry.time);
    assert.strictEqual(entry.serverIPAddress, "");
    assert.strictEqual(entry.connection, "");
  };
  try {
    for (const cacheAfterResponse of [false, true]) {
      resetRecording();
      await start("cached");
      if (!cacheAfterResponse) await event("requestServedFromCache", {requestId: "cached"});
      await response("cached");
      if (cacheAfterResponse) await event("requestServedFromCache", {requestId: "cached"});
      await finish("cached");
      assertLocal(entries()[0], "memory");
      assert.strictEqual(entries().length, 1);
    }
    for (const alsoCacheEvent of [false, true]) {
      resetRecording();
      await start("disk");
      if (alsoCacheEvent) await event("requestServedFromCache", {requestId: "disk"});
      await response("disk", undefined, {fromDiskCache: true});
      await finish("disk");
      assertLocal(entries()[0], "disk");
    }
    resetRecording();
    await start("cache-missing-size");
    await event("requestServedFromCache", {requestId: "cache-missing-size"});
    await response("cache-missing-size");
    await event("loadingFinished", {requestId: "cache-missing-size", timestamp: 1.000045});
    assert.strictEqual(entries()[0]._fromCache, "memory");
    assert.strictEqual(entries()[0].response._transferSize, -1);
    resetRecording();
    await start("worker");
    await response("worker", undefined, {fromServiceWorker: true});
    await finish("worker", undefined, 42);
    assert.strictEqual(entries()[0]._fromCache, "service-worker");
    assert.strictEqual(entries()[0].response._transferSize, 42);
    assert.strictEqual(entries()[0]._breaktest.timingSource, "network");

    // Short duration, zero transfer/body, or a previously cached URL proves nothing.
    for (const finalSize of [0, 1500, null]) {
      resetRecording();
      await start("network");
      await response("network", undefined, {timing: undefined});
      await finish("network", undefined, finalSize);
      const entry = entries()[0];
      assert.ok(!("_fromCache" in entry));
      assert.strictEqual(entry.response._transferSize, finalSize ?? -1);
      assert.strictEqual(entry.response.bodySize, finalSize ?? -1);
      assert.strictEqual(entry.response.content.size, 6);
      assert.strictEqual(entry._breaktest.timingSource, "response-events");
    }
    resetRecording();
    await start("ordinary");
    await response("ordinary");
    await event("loadingFinished", {requestId: "ordinary", timestamp: 1.05, encodedDataLength: 1500});
    assert.strictEqual(entries()[0].timings.wait, 30.125);
    assert.strictEqual(entries()[0]._breaktest.timingSource, "network");

    // Full decoded size, including base64 padding and text truncated for export.
    for (const body of ["", "YQ==", "YWI=", "YWJj"]) {
      resetRecording();
      bodyResult = {body, base64Encoded: true};
      await start("binary");
      await response("binary");
      await finish("binary");
      assert.strictEqual(entries()[0].response.content.size, Buffer.from(body, "base64").length);
    }
    resetRecording();
    bodyResult = {body: "é".repeat(vm.runInContext("MAX_BODY_CHARS + 1", context)), base64Encoded: false};
    await start("truncated");
    await response("truncated");
    await finish("truncated");
    assert.strictEqual(entries()[0].response.content.size, Buffer.byteLength(bodyResult.body));
    assert.strictEqual(entries()[0]._breaktest.bodyTruncated, true);
    resetRecording();
    bodyResult = {};
    await start("unknown");
    await response("unknown", undefined, {encodedDataLength: undefined});
    await event("loadingFinished", {requestId: "unknown", timestamp: 1.000045});
    assert.strictEqual(entries()[0].response.content.size, -1);
    assert.strictEqual(entries()[0].response._transferSize, -1);

    bodyResult = {body: "é🐈", base64Encoded: false};
    resetRecording();
    await start("shared");
    await start("shared", "child");
    await start("other");
    await event("requestServedFromCache", {requestId: "shared"}, "child");
    await event("requestServedFromCache", {requestId: "unseen"});
    for (const [id, session] of [["shared", undefined], ["shared", "child"], ["other", undefined], ["unseen", undefined]]) {
      if (id === "unseen") await start(id);
      await response(id, session);
      await finish(id, session);
    }
    assert.deepStrictEqual(entries().map(entry => entry._fromCache), [undefined, "memory", undefined, undefined]);

    // Cache events belong only to the current redirect attempt, in either direction.
    for (const cachedAttempt of [0, 1]) {
      resetRecording();
      await start("redirect-cache");
      if (cachedAttempt === 0) await event("requestServedFromCache", {requestId: "redirect-cache"});
      await start("redirect-cache", undefined, {timestamp: 1.00001,
        redirectHasExtraInfo: false,
        redirectResponse: {status: 302, headers: {location: "/final"}, encodedDataLength: 1182}});
      if (cachedAttempt === 1) await event("requestServedFromCache", {requestId: "redirect-cache"});
      await response("redirect-cache");
      await finish("redirect-cache");
      await vm.runInContext("Promise.all([...recording.pendingTasks])", context);
      const result = entries();
      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[cachedAttempt]._fromCache, "memory");
      assert.ok(!("_fromCache" in result[1 - cachedAttempt]));
    }
    // A new recording does not inherit cache information from a previous session.
    resetRecording();
    await start("redirect-cache");
    await response("redirect-cache");
    await finish("redirect-cache");
    assert.ok(!("_fromCache" in entries()[0]));
  } finally {
    context.chrome.debugger.sendCommand = originalCommand;
  }
}

async function main() {
  await testCacheMetadata();
  await testRecordingLocator();
  await testNavigationFailureKeepsRecording();
  await testExtraInfoBeforeRequest();
  await testRedirectOrdering(true);
  await testRedirectOrdering(false);
  console.log("Chrome request metadata ordering tests passed");
}

module.exports = {context, resetRecording};

if (require.main === module) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
