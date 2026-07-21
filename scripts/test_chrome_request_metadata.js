#!/usr/bin/env node

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const listener = () => ({addListener() {}});
const context = {
  console,
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

async function testMemoryCacheMarker() {
  resetRecording();
  await vm.runInContext(`requestWillBeSent({tabId: 1}, {
    requestId: "cached",
    timestamp: 1,
    wallTime: 1784557822,
    type: "Image",
    request: {
      method: "GET",
      url: "https://example.test/image.png",
      headers: {Referer: "https://example.test/"}
    }
  })`, context);
  vm.runInContext(`requestServedFromCache({tabId: 1}, {
    requestId: "cached"
  })`, context);
  vm.runInContext(`responseReceived({tabId: 1}, {
    requestId: "cached",
    timestamp: 2,
    type: "Image",
    hasExtraInfo: false,
    response: {
      status: 200,
      protocol: "h2",
      headers: {"content-type": "image/png"}
    }
  })`, context);
  vm.runInContext(`(() => {
    const state = recording.activeRequests.get("root:cached");
    finalizeRequest(state, 2);
    recording.activeRequests.delete("root:cached");
  })()`, context);

  const fromCache = vm.runInContext(`recording.entries[0]._fromCache`, context);
  assert.strictEqual(fromCache, "memory");
}

async function main() {
  await testExtraInfoBeforeRequest();
  await testRedirectOrdering(true);
  await testRedirectOrdering(false);
  await testMemoryCacheMarker();
  console.log("Chrome request metadata ordering tests passed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
