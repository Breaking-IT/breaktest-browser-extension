/*
 * Copyright 2024-2026 Breaking IT
 *
 * Licensed under the BreakTest Community Source License 1.0.
 * You may not use this file except in compliance with that license.
 * See the LICENSE file at the root of this distribution.
 */

importScripts("har-export-store.js");
importScripts("upload-store.js");

const PROTOCOL_VERSION = "1.3";
const MAX_BODY_CHARS = 2 * 1024 * 1024;
const NETWORK_TOTAL_BUFFER_BYTES = 48 * 1024 * 1024;
const NETWORK_RESOURCE_BUFFER_BYTES = 24 * 1024 * 1024;
const MAX_VISIBLE_REQUESTS = 1000;
const SIDE_PANEL_PATH = "sidepanel.html";
const INCOGNITO_LAUNCH_KEY = "pendingIncognitoLaunch";
const RECORDING_DISCLOSURE_VERSION = 3;

let recording = null;


chrome.runtime.onInstalled.addListener(() => {
  configureExistingTabPanels().catch(error => console.error(error));
});

chrome.runtime.onStartup.addListener(() => {
  configureExistingTabPanels().catch(error => console.error(error));
  globalThis.HarExportStore.cleanupStale().catch(error => console.error(error));
});

chrome.tabs.onCreated.addListener(tab => {
  configureTabPanel(tab.id).catch(error => console.error(error));
});

chrome.tabs.onReplaced.addListener(addedTabId => {
  configureTabPanel(addedTabId).catch(error => console.error(error));
});

chrome.sidePanel
  .setPanelBehavior({openPanelOnActionClick: true})
  .catch(error => console.error(error));

configureExistingTabPanels().catch(error => console.error(error));
globalThis.HarExportStore.cleanupStale().catch(error => console.error(error));

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message, _sender)
    .then(sendResponse)
    .catch(error => sendResponse({ok: false, error: errorMessage(error)}));
  return true;
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!recording || source.tabId !== recording.tabId) {
    return;
  }
  const task = handleDebuggerEvent(source, method, params).catch(error => {
    notify("recorder-warning", {message: errorMessage(error)});
  });
  trackTask(task);
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (!recording || source.tabId !== recording.tabId || recording.stopping) {
    return;
  }
  const interruptedRecording = recording;
  recording.attached = false;
  recording.detachReason = reason;
  setRecordingBadge(false);
  if (reason === "target_closed") {
    notify("recorder-detached", {reason, status: recorderStatus()});
    return;
  }
  recording.reconnecting = true;
  notify("recorder-reconnecting", {reason, status: recorderStatus()});
  const task = reconnectDebugger(interruptedRecording, reason);
  trackTask(task);
});

async function handleMessage(message, sender = {}) {
  if (message?.type?.startsWith("upload-")) {
    return globalThis.UploadStore.handle(recording, message, sender);
  }
  switch (message?.type) {
    case "start-recording":
      return startRecording(message);
    case "start-incognito-recording":
      return startIncognitoRecording(message);
    case "new-transaction":
      return startTransaction(message.name);
    case "rename-transaction":
      return renameTransaction(message.id, message.name);
    case "delete-transaction":
      return deleteTransaction(message.id, message.requestDisposition);
    case "transaction-details":
      return transactionDetails(message.id);
    case "stop-recording":
      return stopRecording();
    case "cancel-recording":
      return cancelRecording();
    case "recorder-status":
      return recorderStatus();
    default:
      return {ok: false, error: "Unknown recorder command"};
  }
}

async function startIncognitoRecording(message) {
  try {
    const stored = await chrome.storage.local.get(INCOGNITO_LAUNCH_KEY);
    const launch = stored[INCOGNITO_LAUNCH_KEY];
    if (!launch
        || launch.nonce !== message.nonce
        || launch.consentVersion !== RECORDING_DISCLOSURE_VERSION
        || !Number.isInteger(launch.windowId)
        || !Number.isInteger(launch.launcherTabId)) {
      throw new Error("The incognito recorder launch instruction is invalid or expired");
    }
    const launcherTab = await chrome.tabs.get(launch.launcherTabId);
    if (!launcherTab.incognito || launcherTab.windowId !== launch.windowId) {
      throw new Error("The incognito launcher tab no longer belongs to this recording window");
    }
    const result = await startRecording({
      tabId: launch.launcherTabId,
      windowId: launch.windowId,
      transactionName: launch.transactionName,
      startUrl: launch.startUrl,
      createBlankTab: false,
      prepareCurrentTabAsBlank: true,
      disableCache: launch.disableCache === true
    });
    await chrome.storage.local.remove(INCOGNITO_LAUNCH_KEY);
    return result;
  } catch (error) {
    notify("recorder-start-failed", {message: errorMessage(error)});
    throw error;
  }
}

async function startRecording(message) {
  let {tabId} = message;
  const transactionName = String(message.transactionName || "").trim();
  if (!transactionName) {
    throw new Error("Enter a transaction name");
  }
  const startUrl = normalizeStartUrl(message.startUrl);
  const createBlankTab = message.createBlankTab === true;
  const preparedNewTab = message.preparedNewTab === true;
  const prepareCurrentTabAsBlank = message.prepareCurrentTabAsBlank === true;
  if ([createBlankTab, preparedNewTab, prepareCurrentTabAsBlank].filter(Boolean).length > 1) {
    throw new Error("Choose only one new-tab recording mode");
  }
  let tab;
  if (createBlankTab) {
    tab = await chrome.tabs.create({
      windowId: Number.isInteger(message.windowId) ? message.windowId : undefined,
      url: "about:blank",
      active: false
    });
    tabId = tab.id;
  } else {
    if (!Number.isInteger(tabId)) {
      throw new Error("No active browser tab was selected");
    }
    tab = await chrome.tabs.get(tabId);
  }
  if (prepareCurrentTabAsBlank) {
    const launcherUrl = chrome.runtime.getURL("incognito-launch.html");
    if (!tab.incognito || !tab.url?.startsWith(launcherUrl)) {
      throw new Error("Only the active incognito launcher tab can be prepared for recording");
    }
    tab = await chrome.tabs.update(tabId, {url: "about:blank"});
  } else if (isBrowserNewTab(tab.url)) {
    await chrome.tabs.update(tabId, {url: "about:blank"});
    tab = await chrome.tabs.get(tabId);
  }
  if (!createBlankTab
      && !preparedNewTab
      && !prepareCurrentTabAsBlank
      && !isRecordableUrl(tab.pendingUrl || tab.url)) {
    throw new Error(
      "This Chrome internal page cannot be recorded. Enter a Start URL or open an HTTP/HTTPS page."
    );
  }
  if (recording) {
    await discardCurrentRecording();
  }

  recording = {
    tabId,
    tabTitle: tab.title || "",
    incognito: Boolean(tab.incognito),
    disableCache: message.disableCache === true,
    startedAt: Date.now(),
    attached: false,
    stopping: false,
    transactions: [],
    currentTransaction: null,
    activeRequests: new Map(),
    requestSequences: new Map(),
    requestChains: new Map(),
    entries: [],
    summaries: [],
    pendingTasks: new Set(),
    reconnecting: false,
    detachReason: null,
    capturedBodyChars: 0,
    nextTransactionOrdinal: 1,
    nextEntryOrdinal: 0
  };
  startTransactionInternal(transactionName);
  await globalThis.UploadStore.install(chrome, recording);

  try {
    await chrome.debugger.attach({tabId}, PROTOCOL_VERSION);
    recording.attached = true;
    await configureRootTarget(tabId);
    if (createBlankTab) {
      await moveRecorderToTab(tabId);
    }
  } catch (error) {
    await discardCurrentRecording();
    throw error;
  }

  // Capture is ready before navigation, which may pause for HTTP authentication.
  const owner = recording;
  setRecordingBadge(true);
  notify("recording-started", recorderStatus());
  if (startUrl) {
    try {
      const navigation = await chrome.debugger.sendCommand({tabId}, "Page.navigate", {url: startUrl});
      if (navigation?.errorText) throw new Error(navigation.errorText);
    } catch (error) {
      // A failed page load is recording evidence, not a failed debugger setup.
      // Keep the initial request and continue capturing authentication retries.
      if (recording === owner && !owner.stopping) {
        owner.startWarning = `Recording is active. The start page could not load (${errorMessage(error)}). Complete authentication or retry the page; requests will continue to be captured.`;
        notify("recorder-warning", {message: owner.startWarning});
      }
    }
  }
  return recorderStatus();
}

async function configureExistingTabPanels() {
  await chrome.sidePanel.setPanelBehavior({openPanelOnActionClick: true});
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs
    .filter(tab => Number.isInteger(tab.id))
    .map(tab => configureTabPanel(tab.id)));
}

async function configureTabPanel(tabId) {
  await chrome.sidePanel.setOptions({
    tabId,
    path: SIDE_PANEL_PATH,
    enabled: true
  });
}

async function moveRecorderToTab(targetTabId) {
  await configureTabPanel(targetTabId);
  await chrome.tabs.update(targetTabId, {active: true});
  await chrome.sidePanel.open({tabId: targetTabId}).catch(() => {});
}

async function configureRootTarget(tabId) {
  await enableTarget({tabId});
  await safeCommand({tabId}, "Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
    filter: [
      {type: "iframe", exclude: false},
      {type: "worker", exclude: false},
      {type: "shared_worker", exclude: false},
      {type: "service_worker", exclude: false}
    ]
  });
}

async function reconnectDebugger(interruptedRecording, reason) {
  let lastError = null;
  for (let attempt = 0; attempt < 12; attempt++) {
    if (recording !== interruptedRecording || recording.stopping) {
      return;
    }
    await delay(attempt === 0 ? 100 : 500);
    try {
      await chrome.debugger.attach({tabId: interruptedRecording.tabId}, PROTOCOL_VERSION);
      interruptedRecording.attached = true;
      await configureRootTarget(interruptedRecording.tabId);
      interruptedRecording.reconnecting = false;
      interruptedRecording.detachReason = null;
      setRecordingBadge(true);
      notify("recorder-reattached", {reason, status: recorderStatus()});
      return;
    } catch (error) {
      lastError = error;
      interruptedRecording.attached = false;
    }
  }
  if (recording === interruptedRecording && !recording.stopping) {
    recording.reconnecting = false;
    notify("recorder-detached", {
      reason,
      message: errorMessage(lastError),
      status: recorderStatus()
    });
  }
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function enableTarget(target) {
  await chrome.debugger.sendCommand(target, "Network.enable", {
    maxTotalBufferSize: NETWORK_TOTAL_BUFFER_BYTES,
    maxResourceBufferSize: NETWORK_RESOURCE_BUFFER_BYTES,
    maxPostDataSize: MAX_BODY_CHARS
  });
  await safeCommand(target, "Network.configureDurableMessages", {
    maxTotalBufferSize: NETWORK_TOTAL_BUFFER_BYTES,
    maxResourceBufferSize: NETWORK_RESOURCE_BUFFER_BYTES
  });
  if (recording?.disableCache) {
    await chrome.debugger.sendCommand(target, "Network.setCacheDisabled", {cacheDisabled: true});
  }
}

async function startTransaction(name) {
  if (!recording || recording.stopping) {
    throw new Error("No recording is active");
  }
  const normalizedName = String(name || "").trim();
  if (!normalizedName) {
    throw new Error("Enter a transaction name");
  }
  if (recording.currentTransaction?.name === normalizedName) {
    return {ok: true, transaction: recording.currentTransaction, status: recorderStatus()};
  }
  const transaction = startTransactionInternal(normalizedName);
  const status = recorderStatus();
  notify("transaction-started", {transaction, status});
  return {ok: true, transaction, status};
}

function startTransactionInternal(name) {
  const normalizedName = String(name || "").trim();
  if (!normalizedName) {
    throw new Error("Enter a transaction name");
  }
  const transactionOrdinal = recording.nextTransactionOrdinal++;
  const transaction = {
    id: `transaction-${transactionOrdinal}`,
    name: normalizedName,
    startedDateTime: new Date().toISOString(),
    order: transactionOrdinal,
    requestCount: 0
  };
  recording.transactions.push(transaction);
  recording.currentTransaction = transaction;
  return transaction;
}

function renameTransaction(id, name) {
  const transaction = editableTransaction(id);
  const normalizedName = String(name || "").trim();
  if (!normalizedName) {
    throw new Error("Enter a transaction name");
  }
  if (normalizedName.length > 120) {
    throw new Error("Transaction names can contain at most 120 characters");
  }
  transaction.name = normalizedName;
  for (const state of recording.activeRequests.values()) {
    if (state.transaction.id === id) {
      state.transaction.name = normalizedName;
    }
  }
  for (const entry of recording.entries) {
    if (entry._breaktest.transactionId === id) {
      entry._breaktest.transactionName = normalizedName;
    }
  }
  for (const summary of recording.summaries) {
    if (summary.transactionId === id) {
      summary.transactionName = normalizedName;
    }
  }
  const status = recorderStatus();
  notify("transactions-changed", {status});
  return {ok: true, transaction, status};
}

function deleteTransaction(id, requestDisposition = "delete") {
  const transaction = editableTransaction(id);
  if (recording.currentTransaction.id === id) {
    throw new Error("Start a new transaction before removing the active transaction");
  }
  if (!["delete", "previous", "next"].includes(requestDisposition)) {
    throw new Error("Choose what to do with the recorded requests");
  }

  const transactionIndex = recording.transactions.findIndex(item => item.id === id);
  const targetTransaction = requestDisposition === "previous"
    ? recording.transactions[transactionIndex - 1]
    : requestDisposition === "next"
      ? recording.transactions[transactionIndex + 1]
      : null;
  if (requestDisposition !== "delete" && !targetTransaction) {
    throw new Error(`There is no ${requestDisposition} transaction`);
  }

  globalThis.UploadStore.removeTransaction(recording, id, targetTransaction?.id);
  recording.transactions = recording.transactions.filter(item => item.id !== id);
  if (targetTransaction) {
    targetTransaction.requestCount += transaction.requestCount;
    for (const state of recording.activeRequests.values()) {
      if (state.transaction.id === id) {
        state.transaction = targetTransaction;
      }
    }
    for (const entry of recording.entries) {
      if (entry._breaktest.transactionId === id) {
        entry._breaktest.transactionId = targetTransaction.id;
        entry._breaktest.transactionName = targetTransaction.name;
        entry._breaktest.transactionOrder = targetTransaction.order;
      }
    }
    for (const summary of recording.summaries) {
      if (summary.transactionId === id) {
        summary.transactionId = targetTransaction.id;
        summary.transactionName = targetTransaction.name;
      }
    }
  } else {
    recording.entries = recording.entries.filter(entry => entry._breaktest.transactionId !== id);
    recording.summaries = recording.summaries.filter(summary => summary.transactionId !== id);
    for (const [key, state] of recording.activeRequests) {
      if (state.transaction.id === id) {
        state.discarded = true;
        state.finalized = true;
        recording.activeRequests.delete(key);
      }
    }
  }
  recording.capturedBodyChars = recording.entries.reduce(
    (total, entry) => total + (entry.response.content.text?.length || 0),
    0
  );

  const status = recorderStatus();
  notify("transactions-changed", {status});
  return {ok: true, transaction, targetTransaction, requestDisposition, status};
}

function editableTransaction(id) {
  if (!recording || recording.stopping) {
    throw new Error("No recording is active");
  }
  const transaction = recording.transactions.find(item => item.id === id);
  if (!transaction) {
    throw new Error("The selected transaction no longer exists");
  }
  return transaction;
}

function transactionDetails(id) {
  if (!recording) {
    throw new Error("No recording is active");
  }
  const transaction = recording.transactions.find(item => item.id === id);
  if (!transaction) {
    throw new Error("The selected transaction no longer exists");
  }
  const requests = recording.entries
    .filter(entry => entry._breaktest.transactionId === id)
    .sort((left, right) => {
      const timeDifference = Date.parse(left.startedDateTime) - Date.parse(right.startedDateTime);
      return timeDifference || left._breaktest.entryOrdinal - right._breaktest.entryOrdinal;
    })
    .map(entry => ({
      id: String(entry._breaktest.entryOrdinal),
      ordinal: entry._breaktest.entryOrdinal,
      transactionId: id,
      method: entry.request.method,
      url: entry.request.url,
      status: entry.response.status,
      failed: entry._breaktest.failed,
      startedDateTime: entry.startedDateTime,
      time: entry.time
    }));
  return {ok: true, transaction, requests};
}

async function stopRecording() {
  if (!recording) {
    throw new Error("No recording is active");
  }
  recording.stopping = true;
  await globalThis.UploadStore.settle(recording);
  await settlePendingTasks();

  for (const state of recording.activeRequests.values()) {
    state.incomplete = true;
    resolveUnknownExtraInfo(state);
    finalizeRequest(state, state.lastTimestamp || state.requestTimestamp);
  }
  recording.activeRequests.clear();

  if (recording.attached) {
    try {
      await chrome.debugger.detach({tabId: recording.tabId});
    } catch (_ignored) {
      // The tab or debugger session may already have gone away.
    }
  }
  recording.attached = false;
  setRecordingBadge(false);

  const har = buildHar(recording);
  const exportDescriptor = await globalThis.HarExportStore.save(har);
  const status = recorderStatus();
  recording = null;
  notify("recording-stopped", status);
  return {ok: true, export: exportDescriptor, status};
}

async function cancelRecording() {
  await discardCurrentRecording();
  const status = recorderStatus();
  notify("recording-cancelled", status);
  return status;
}

async function discardCurrentRecording() {
  if (!recording) {
    return;
  }
  recording.stopping = true;
  if (recording.attached) {
    try {
      await chrome.debugger.detach({tabId: recording.tabId});
    } catch (_ignored) {
      // Ignore cleanup failure when replacing a stale session.
    }
  }
  setRecordingBadge(false);
  recording = null;
}

async function settlePendingTasks() {
  for (let pass = 0; pass < 4; pass++) {
    const tasks = [...recording.pendingTasks];
    if (tasks.length === 0) {
      return;
    }
    await Promise.allSettled(tasks);
  }
}

function trackTask(task) {
  if (!recording) {
    return;
  }
  const owner = recording;
  owner.pendingTasks.add(task);
  task.finally(() => owner.pendingTasks.delete(task));
}

async function handleDebuggerEvent(source, method, params) {
  switch (method) {
    case "Target.attachedToTarget": {
      const child = {tabId: source.tabId, sessionId: params.sessionId};
      await enableTarget(child);
      await safeCommand(child, "Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true
      });
      break;
    }
    case "Network.requestWillBeSent":
      await requestWillBeSent(source, params);
      break;
    case "Network.requestWillBeSentExtraInfo":
      requestExtraInfo(source, params);
      break;
    case "Network.responseReceived":
      responseReceived(source, params);
      break;
    case "Network.responseReceivedExtraInfo":
      responseExtraInfo(source, params);
      break;
    case "Network.loadingFinished":
      await loadingFinished(source, params);
      break;
    case "Network.loadingFailed":
      loadingFailed(source, params);
      break;
    default:
      break;
  }
}

async function requestWillBeSent(source, params) {
  const key = requestKey(source, params.requestId);
  const previous = recording.activeRequests.get(key);
  if (params.redirectResponse && previous) {
    applyResponse(previous, params.redirectResponse, params.timestamp);
    if (typeof params.redirectHasExtraInfo === "boolean") {
      previous.hasExtraInfo = params.redirectHasExtraInfo;
      reconcileExtraInfo(previous.chain);
    }
    previous.redirect = true;
    recording.activeRequests.delete(key);
    const owner = recording;
    const redirectTask = captureRedirectBody(owner, previous, source)
      .finally(() => {
        if (recording === owner) {
          finalizeRequest(previous, params.timestamp);
        }
      });
    trackTask(redirectTask);
  }

  const request = params.request || {};
  if (!isCapturableRequestUrl(request.url)) {
    return;
  }
  const sequence = (recording.requestSequences.get(key) || 0) + 1;
  recording.requestSequences.set(key, sequence);
  const transaction = recording.currentTransaction;
  const wallTimeMs = Number.isFinite(params.wallTime) ? params.wallTime * 1000 : Date.now();
  const state = {
    key,
    entryId: `${key}:${sequence}`,
    ordinal: recording.nextEntryOrdinal++,
    source: {...source},
    requestId: params.requestId,
    requestTimestamp: params.timestamp,
    lastTimestamp: params.timestamp,
    startedDateTime: new Date(wallTimeMs).toISOString(),
    resourceType: params.type || "Other",
    initiator: params.initiator || {},
    transaction: {...transaction},
    request: {
      method: request.method || "GET",
      url: request.url || "",
      httpVersion: "",
      headers: headersToHar(request.headers),
      queryString: queryToHar(request.url),
      cookies: [],
      headersSize: -1,
      bodySize: request.postData ? request.postData.length : 0
    },
    response: emptyResponse(),
    responseTimestamp: null,
    encodedDataLength: 0,
    bodyTruncated: false,
    failed: false,
    incomplete: false
  };
  const chain = requestChain(key);
  state.chain = chain;
  chain.attempts.push(state);
  reconcileExtraInfo(chain);
  const activeTransaction = recording.transactions.find(item => item.id === transaction.id);
  if (activeTransaction) {
    activeTransaction.requestCount++;
  }
  const postData = makePostData(request.postData, state.request.headers);
  if (postData) {
    state.request.postData = postData;
  }
  recording.activeRequests.set(key, state);

  if (request.hasPostData && typeof request.postData !== "string") {
    state.postDataTask = chrome.debugger.sendCommand(source, "Network.getRequestPostData", {
      requestId: params.requestId
    }).then(result => {
      const current = recording?.activeRequests.get(key);
      if (current === state && typeof result?.postData === "string") {
        current.request.postData = makePostData(result.postData, current.request.headers);
        current.request.bodySize = result.postData.length;
      }
    }).catch(() => {
      state.requestBodyUnavailable = true;
    });
    await state.postDataTask;
  }
}

async function captureRedirectBody(owner, state, source) {
  try {
    const result = await chrome.debugger.sendCommand(source, "Network.getResponseBody", {
      requestId: state.requestId
    });
    if (recording === owner) {
      captureBody(state, result);
    }
  } catch (error) {
    if (responseMayHaveBody(state)) {
      state.bodyUnavailable = true;
      state.bodyUnavailableReason = `Redirect body unavailable: ${errorMessage(error)}`;
    }
  }
}

function responseMayHaveBody(state) {
  if (state.request.method === "HEAD" || state.response.status === 204 || state.response.status === 304) {
    return false;
  }
  const contentLength = Number.parseInt(headerValue(state.response.headers, "content-length"), 10);
  return contentLength > 0 || Boolean(headerValue(state.response.headers, "transfer-encoding"));
}

function requestChain(key) {
  let chain = recording.requestChains.get(key);
  if (!chain) {
    chain = {
      attempts: [],
      requestInfos: [],
      responseInfos: [],
      requestCursor: 0,
      responseCursor: 0
    };
    recording.requestChains.set(key, chain);
  }
  return chain;
}

function reconcileExtraInfo(chain) {
  for (const state of chain.attempts) {
    if (state.hasExtraInfo !== true) {
      continue;
    }
    if (!state.requestExtraInfoApplied && chain.requestCursor < chain.requestInfos.length) {
      const extraInfo = chain.requestInfos[chain.requestCursor];
      chain.requestInfos[chain.requestCursor++] = null;
      applyRequestExtraInfo(state, extraInfo);
      state.requestExtraInfoApplied = true;
    }
    if (!state.responseExtraInfoApplied && chain.responseCursor < chain.responseInfos.length) {
      const extraInfo = chain.responseInfos[chain.responseCursor];
      chain.responseInfos[chain.responseCursor++] = null;
      applyResponseExtraInfo(state, extraInfo);
      state.responseExtraInfoApplied = true;
    }
  }
}

function resolveUnknownExtraInfo(state) {
  if (typeof state.hasExtraInfo !== "boolean") {
    state.hasExtraInfo = state.chain.requestCursor < state.chain.requestInfos.length
      || state.chain.responseCursor < state.chain.responseInfos.length;
  }
  reconcileExtraInfo(state.chain);
}

function applyRequestExtraInfo(state, extraInfo) {
  if (extraInfo.headers) {
    state.request.headers = headersToHar(extraInfo.headers);
    if (state.request.postData) {
      state.request.postData = makePostData(state.request.postData.text, state.request.headers);
    }
  }
  if (Array.isArray(extraInfo.associatedCookies)) {
    state.request.cookies = associatedCookiesToHar(extraInfo.associatedCookies);
  }
}

function applyResponseExtraInfo(state, extraInfo) {
  if (extraInfo.headers) {
    state.response.headers = headersToHar(extraInfo.headers);
    state.response.content.mimeType = headerValue(state.response.headers, "content-type")
      || state.response.content.mimeType;
    state.response.redirectURL = headerValue(state.response.headers, "location")
      || state.response.redirectURL;
  }
  if (Number.isInteger(extraInfo.statusCode)) {
    state.response.status = extraInfo.statusCode;
  }
}

function requestExtraInfo(source, params) {
  const chain = requestChain(requestKey(source, params.requestId));
  chain.requestInfos.push(params);
  reconcileExtraInfo(chain);
}

function responseReceived(source, params) {
  const state = recording.activeRequests.get(requestKey(source, params.requestId));
  if (!state) {
    return;
  }
  applyResponse(state, params.response || {}, params.timestamp);
  if (typeof params.hasExtraInfo === "boolean") {
    state.hasExtraInfo = params.hasExtraInfo;
    reconcileExtraInfo(state.chain);
  }
  state.resourceType = params.type || state.resourceType;
}

function responseExtraInfo(source, params) {
  const chain = requestChain(requestKey(source, params.requestId));
  chain.responseInfos.push(params);
  reconcileExtraInfo(chain);
}

async function loadingFinished(source, params) {
  const key = requestKey(source, params.requestId);
  const state = recording.activeRequests.get(key);
  if (!state) {
    return;
  }
  state.lastTimestamp = params.timestamp;
  state.encodedDataLength = params.encodedDataLength || 0;
  state.response.bodySize = state.encodedDataLength;
  if (state.postDataTask) {
    await state.postDataTask;
  }

  if (!state.redirect) {
    try {
      const result = await getResponseBodyWithRetry(source, params.requestId);
      captureBody(state, result);
    } catch (error) {
      state.bodyUnavailable = true;
      state.bodyUnavailableReason = errorMessage(error);
    }
  }
  finalizeRequest(state, params.timestamp);
  recording.activeRequests.delete(key);
}

async function getResponseBodyWithRetry(source, requestId) {
  let lastError = null;
  for (const waitMs of [0, 50, 150]) {
    if (waitMs > 0) {
      await delay(waitMs);
    }
    try {
      return await chrome.debugger.sendCommand(source, "Network.getResponseBody", {requestId});
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Chrome did not make the response body available");
}

function loadingFailed(source, params) {
  const key = requestKey(source, params.requestId);
  const state = recording.activeRequests.get(key);
  if (!state) {
    return;
  }
  state.failed = true;
  state.failureText = params.errorText || "Request failed";
  state.canceled = Boolean(params.canceled);
  state.lastTimestamp = params.timestamp;
  resolveUnknownExtraInfo(state);
  finalizeRequest(state, params.timestamp);
  recording.activeRequests.delete(key);
}

function applyResponse(state, response, timestamp) {
  state.responseTimestamp = timestamp;
  state.lastTimestamp = timestamp;
  state.response = {
    status: response.status || 0,
    statusText: response.statusText || "",
    httpVersion: normalizeHttpVersion(response.protocol),
    headers: headersToHar(response.headers),
    cookies: [],
    content: {
      size: Number.isFinite(response.encodedDataLength) ? response.encodedDataLength : 0,
      mimeType: response.mimeType || headerValue(headersToHar(response.headers), "content-type") || ""
    },
    redirectURL: headerValue(headersToHar(response.headers), "location") || "",
    headersSize: -1,
    bodySize: Number.isFinite(response.encodedDataLength) ? response.encodedDataLength : -1,
    _transferSize: Number.isFinite(response.encodedDataLength) ? response.encodedDataLength : 0
  };
  state.request.httpVersion = normalizeHttpVersion(response.protocol) || state.request.httpVersion;
  state.serverIPAddress = response.remoteIPAddress || "";
  state.connection = response.connectionId == null ? "" : String(response.connectionId);
  state.fromDiskCache = Boolean(response.fromDiskCache);
  state.fromServiceWorker = Boolean(response.fromServiceWorker);
  state.timing = response.timing || null;
}

function captureBody(state, result) {
  if (state.discarded || state.finalized) {
    return;
  }
  if (!result || typeof result.body !== "string") {
    state.bodyUnavailable = true;
    state.bodyUnavailableReason = "Chrome returned no response body";
    return;
  }
  const available = MAX_BODY_CHARS;
  const safeAvailable = result.base64Encoded ? available - (available % 4) : available;
  if (safeAvailable <= 0) {
    state.bodyTruncated = true;
    return;
  }
  const body = result.body.slice(0, safeAvailable);
  state.bodyTruncated = result.body.length > body.length;
  state.response.content.text = body;
  if (result.base64Encoded) {
    state.response.content.encoding = "base64";
  }
  recording.capturedBodyChars += body.length;
}

function finalizeRequest(state, finishedTimestamp) {
  if (state.finalized || state.discarded) {
    return;
  }
  state.finalized = true;
  const end = Number.isFinite(finishedTimestamp) ? finishedTimestamp : state.requestTimestamp;
  const totalMs = Math.max((end - state.requestTimestamp) * 1000, 0);
  const entry = {
    startedDateTime: state.startedDateTime,
    time: totalMs,
    request: state.request,
    response: state.response,
    cache: {},
    timings: buildTimings(state, totalMs),
    serverIPAddress: state.serverIPAddress || "",
    connection: state.connection || "",
    _resourceType: state.resourceType,
    _fromCache: state.fromDiskCache ? "disk" : (state.fromServiceWorker ? "service-worker" : undefined),
    _breaktest: {
      transactionId: state.transaction.id,
      transactionName: state.transaction.name,
      transactionOrder: state.transaction.order,
      entryOrdinal: state.ordinal,
      bodyTruncated: state.bodyTruncated,
      bodyUnavailable: Boolean(state.bodyUnavailable),
      bodyUnavailableReason: state.bodyUnavailableReason || "",
      requestBodyUnavailable: Boolean(state.requestBodyUnavailable),
      failed: state.failed,
      incomplete: state.incomplete,
      failureText: state.failureText || ""
    }
  };
  if (!entry._fromCache) {
    delete entry._fromCache;
  }
  recording.entries.push(entry);

  const summary = {
    id: state.entryId,
    ordinal: state.ordinal,
    transactionId: state.transaction.id,
    transactionName: state.transaction.name,
    method: state.request.method,
    url: state.request.url,
    status: state.response.status,
    resourceType: state.resourceType,
    size: state.response.bodySize,
    startedDateTime: state.startedDateTime,
    time: totalMs,
    failed: state.failed,
    bodyTruncated: state.bodyTruncated,
    bodyUnavailable: Boolean(state.bodyUnavailable)
  };
  recording.summaries.push(summary);
  if (recording.summaries.length > MAX_VISIBLE_REQUESTS) {
    recording.summaries.shift();
  }
  notify("request-finished", {summary, status: recorderStatus()});
}

function buildHar(session) {
  const entries = [...session.entries].sort((left, right) => {
    const timeDifference = Date.parse(left.startedDateTime) - Date.parse(right.startedDateTime);
    return timeDifference || left._breaktest.entryOrdinal - right._breaktest.entryOrdinal;
  });
  return {
    log: {
      version: "1.2",
      creator: {
        name: "BreakTest Browser Recorder",
        version: chrome.runtime.getManifest().version
      },
      pages: [],
      entries,
      _breaktest: {
        formatVersion: 1,
        recordedWith: "chrome.debugger",
        startedDateTime: new Date(session.startedAt).toISOString(),
        tabTitle: session.tabTitle,
        uploadCapture: globalThis.UploadStore.exportFiles(session),
        transactions: session.transactions
      }
    }
  };
}

function buildTimings(state, totalMs) {
  const timing = state.timing;
  if (!timing) {
    return {blocked: 0, dns: -1, connect: -1, ssl: -1, send: 0, wait: totalMs, receive: 0};
  }
  const dns = duration(timing.dnsStart, timing.dnsEnd);
  const connect = duration(timing.connectStart, timing.connectEnd);
  const ssl = duration(timing.sslStart, timing.sslEnd);
  const send = duration(timing.sendStart, timing.sendEnd, 0);
  const wait = duration(timing.sendEnd, timing.receiveHeadersEnd, 0);
  const known = [dns, connect, send, wait].filter(value => value > 0).reduce((sum, value) => sum + value, 0);
  const receive = Math.max(totalMs - known, 0);
  return {blocked: 0, dns, connect, ssl, send, wait, receive};
}

function duration(start, end, unavailable = -1) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < 0) {
    return unavailable;
  }
  return Math.max(end - start, 0);
}

function emptyResponse() {
  return {
    status: 0,
    statusText: "",
    httpVersion: "",
    headers: [],
    cookies: [],
    content: {size: 0, mimeType: ""},
    redirectURL: "",
    headersSize: -1,
    bodySize: -1
  };
}

function headersToHar(headers) {
  if (!headers || typeof headers !== "object") {
    return [];
  }
  const result = [];
  for (const [name, rawValue] of Object.entries(headers)) {
    const values = String(rawValue).split("\n");
    for (const value of values) {
      result.push({name, value});
    }
  }
  return result;
}

function associatedCookiesToHar(associatedCookies) {
  return associatedCookies
    .filter(item => item?.cookie && (!Array.isArray(item.blockedReasons) || item.blockedReasons.length === 0))
    .map(item => {
      const cookie = item.cookie;
      const result = {
        name: String(cookie.name || ""),
        value: String(cookie.value || "")
      };
      if (cookie.path) {
        result.path = cookie.path;
      }
      if (cookie.domain) {
        result.domain = cookie.domain;
      }
      if (Number.isFinite(cookie.expires) && cookie.expires >= 0) {
        result.expires = new Date(cookie.expires * 1000).toISOString();
      }
      if (typeof cookie.httpOnly === "boolean") {
        result.httpOnly = cookie.httpOnly;
      }
      if (typeof cookie.secure === "boolean") {
        result.secure = cookie.secure;
      }
      return result;
    });
}

function normalizeHttpVersion(protocol) {
  const normalized = String(protocol || "").toLowerCase();
  if (normalized === "h2" || normalized === "http/2" || normalized === "http/2.0") {
    return "http/2.0";
  }
  if (normalized === "h3" || normalized === "http/3" || normalized === "http/3.0") {
    return "http/3.0";
  }
  return normalized;
}

function headerValue(headers, wantedName) {
  const header = headers.find(item => item.name.toLowerCase() === wantedName.toLowerCase());
  return header ? header.value : "";
}

function queryToHar(url) {
  try {
    return [...new URL(url).searchParams.entries()].map(([name, value]) => ({name, value}));
  } catch (_ignored) {
    return [];
  }
}

function makePostData(text, headers) {
  if (typeof text !== "string") {
    return null;
  }
  const mimeType = headerValue(headers, "content-type");
  const postData = {mimeType, text, params: []};
  if (mimeType.toLowerCase().startsWith("application/x-www-form-urlencoded")) {
    postData.params = [...new URLSearchParams(text).entries()].map(([name, value]) => ({name, value}));
  }
  return postData;
}

function requestKey(source, requestId) {
  return `${source.sessionId || "root"}:${requestId}`;
}

function recorderStatus() {
  if (!recording) {
    return {ok: true, active: false, summaries: []};
  }
  return {
    ok: true,
    active: !recording.stopping,
    attached: recording.attached,
    reconnecting: recording.reconnecting,
    detachReason: recording.detachReason,
    startWarning: recording.startWarning || null,
    tabId: recording.tabId,
    currentTransaction: recording.currentTransaction,
    transactions: recording.transactions,
    requestCount: recording.entries.length,
    pendingCount: recording.activeRequests.size,
    capturedBodyChars: recording.capturedBodyChars,
    incognito: recording.incognito,
    cacheDisabled: recording.disableCache,
    summaries: recording.summaries
  };
}

function isRecordableUrl(url) {
  return typeof url === "string" && (/^(https?|file):/i.test(url) || url === "about:blank");
}

function isCapturableRequestUrl(url) {
  return typeof url === "string" && /^https?:/i.test(url);
}

function normalizeStartUrl(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }
  let candidate = text;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(candidate)) {
    candidate = /^(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(candidate)
      ? `http://${candidate}`
      : `https://${candidate}`;
  }
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch (_ignored) {
    throw new Error("Enter a valid HTTP or HTTPS start URL");
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    throw new Error("The start URL must use HTTP or HTTPS");
  }
  return parsed.href;
}

function isBrowserNewTab(url) {
  if (typeof url !== "string") {
    return false;
  }
  return url === "about:blank"
    || /^(chrome|edge):\/\/(newtab|new-tab-page)\/?/i.test(url)
    || url.startsWith("chrome-search://");
}

async function safeCommand(target, method, params) {
  try {
    return await chrome.debugger.sendCommand(target, method, params);
  } catch (_ignored) {
    return null;
  }
}

function setRecordingBadge(active) {
  chrome.action.setBadgeText({text: active ? "REC" : ""});
  if (active) {
    chrome.action.setBadgeBackgroundColor({color: "#c62828"});
  }
}

function notify(type, payload) {
  chrome.runtime.sendMessage({type, ...payload}).catch(() => {
    // The side panel can be closed while recording continues.
  });
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
