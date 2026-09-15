#!/usr/bin/env node

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const listener = () => ({addListener() {}});
const context = {
  console,
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

async function main() {
  await testNavigationFailureKeepsRecording();
  await testExtraInfoBeforeRequest();
  await testRedirectOrdering(true);
  await testRedirectOrdering(false);
  console.log("Chrome request metadata ordering tests passed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
