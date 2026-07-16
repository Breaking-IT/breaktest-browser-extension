/*
 * Copyright 2024-2026 Breaking IT
 *
 * Licensed under the BreakTest Community Source License 1.0.
 * You may not use this file except in compliance with that license.
 * See the LICENSE file at the root of this distribution.
 */

const transactionName = document.querySelector("#transaction-name");
const startUrl = document.querySelector("#start-url");
const disableCache = document.querySelector("#disable-cache");
const recordingConsent = document.querySelector("#recording-consent");
const recordingDisclosure = document.querySelector("#recording-disclosure");
const privacySummary = document.querySelector("#privacy-summary");
const privacySettingsButton = document.querySelector("#privacy-settings-button");
const privacyDoneButton = document.querySelector("#privacy-done-button");
const startSetup = document.querySelector("#start-setup");
const startActions = document.querySelector("#start-actions");
const startButton = document.querySelector("#start-button");
const blankStartButton = document.querySelector("#blank-start-button");
const incognitoStartButton = document.querySelector("#incognito-start-button");
const stopButton = document.querySelector("#stop-button");
const discardButton = document.querySelector("#discard-button");
const transactionHint = document.querySelector("#transaction-hint");
const clearViewButton = document.querySelector("#clear-view-button");
const statusText = document.querySelector("#status-text");
const indicator = document.querySelector("#recording-indicator");
const requestCount = document.querySelector("#request-count");
const pendingCount = document.querySelector("#pending-count");
const errorCount = document.querySelector("#error-count");
const transactionList = document.querySelector("#transaction-list");
const requestList = document.querySelector("#request-list");

let active = false;
let busy = false;
let errors = 0;
let pendingHar = null;
let lastCommittedTransactionName = transactionName.value.trim();
let transactionNameDirty = false;
let lastTransactionInputAt = 0;
let transactionCommitTimer = null;
let transactionCommitPromise = Promise.resolve();
const TRANSACTION_TYPING_SETTLE_MS = 250;
const INCOGNITO_LAUNCH_KEY = "pendingIncognitoLaunch";
const INCOGNITO_LAUNCH_TTL_MS = 60_000;
const RECORDING_CONSENT_KEY = "recordingDisclosureAcceptedVersion";
const RECORDING_DISCLOSURE_VERSION = 1;
const DEFAULT_TRANSACTION_NAME = "01_OpenHomepage";
let recordingConsentAccepted = false;
const inIncognitoContext = chrome.extension.inIncognitoContext;

startButton.addEventListener("click", () => startRecording(false));
blankStartButton.addEventListener("click", () => startRecording(true));
incognitoStartButton.addEventListener("click", startIncognitoRecording);
recordingConsent.addEventListener("change", persistRecordingConsent);
privacySettingsButton.addEventListener("click", showPrivacySettings);
privacyDoneButton.addEventListener("click", collapsePrivacySettings);
stopButton.addEventListener("click", finishRecording);
discardButton.addEventListener("click", discardAndStartOver);
clearViewButton.addEventListener("click", () => {
  requestList.replaceChildren();
  errors = 0;
  errorCount.textContent = "0";
});
transactionName.addEventListener("keydown", event => {
  if (event.key === "Enter") {
    event.preventDefault();
    active ? commitPendingTransaction() : startRecording(true);
  }
});
transactionName.addEventListener("input", () => {
  transactionNameDirty = transactionName.value.trim() !== lastCommittedTransactionName;
  lastTransactionInputAt = Date.now();
  clearTimeout(transactionCommitTimer);
});
transactionName.addEventListener("blur", () => scheduleTransactionCommit(true));
document.addEventListener("pointermove", () => scheduleTransactionCommit(false));

chrome.runtime.onMessage.addListener(message => {
  switch (message.type) {
    case "request-finished":
      appendRequest(message.summary);
      applyStatus(message.status);
      break;
    case "transaction-started":
      renderTransactions();
      break;
    case "recording-started":
      applyStatus(message);
      setStatus(`${message.incognito ? "Incognito recording" : "Recording"} started.`);
      break;
    case "recorder-start-failed":
      showError(message.message || "Unable to start the recording");
      break;
    case "recorder-detached":
      applyStatus(message.status || {active: true, attached: false});
      showError(message.message
        ? `Recorder interrupted: ${message.message}`
        : `Recorder interrupted: ${message.reason}. Captured requests can still be exported.`);
      break;
    case "recorder-reconnecting":
      applyStatus(message.status);
      setStatus("Recorder connection interrupted. Reconnecting…");
      break;
    case "recorder-reattached":
      applyStatus(message.status);
      setStatus("Recorder reconnected. Requests are being captured again.");
      break;
    case "recorder-warning":
      setStatus(message.message);
      break;
    default:
      break;
  }
});

initialize();

async function initialize() {
  incognitoStartButton.hidden = inIncognitoContext;
  await restoreRecordingConsent();
  await removeExpiredIncognitoLaunch();
  await restoreStatus();
}

async function removeExpiredIncognitoLaunch() {
  try {
    const stored = await chrome.storage.local.get(INCOGNITO_LAUNCH_KEY);
    if (!isValidIncognitoLaunch(stored[INCOGNITO_LAUNCH_KEY])) {
      await chrome.storage.local.remove(INCOGNITO_LAUNCH_KEY);
    }
  } catch (_ignored) {
    // A stale launch instruction is harmless and will be replaced on the next attempt.
  }
}

function isValidIncognitoLaunch(launch) {
  return launch
    && Number.isInteger(launch.windowId)
    && typeof launch.transactionName === "string"
    && typeof launch.startUrl === "string"
    && launch.consentVersion === RECORDING_DISCLOSURE_VERSION
    && Number.isFinite(launch.createdAt)
    && Date.now() - launch.createdAt <= INCOGNITO_LAUNCH_TTL_MS;
}

async function startIncognitoRecording() {
  if (!requireRecordingConsent()) {
    return;
  }
  setBusy(true);
  let launch;
  try {
    if (inIncognitoContext) {
      throw new Error("This recorder is already running in an incognito window");
    }
    if (!transactionName.value.trim()) {
      throw new Error("Enter a transaction name");
    }
    const allowed = await chrome.extension.isAllowedIncognitoAccess();
    if (!allowed) {
      throw new Error("Enable Allow in incognito in the extension Details page, then try again");
    }
    launch = {
      nonce: crypto.randomUUID(),
      transactionName: transactionName.value.trim(),
      startUrl: startUrl.value.trim(),
      disableCache: disableCache.checked,
      consentVersion: RECORDING_DISCLOSURE_VERSION,
      createdAt: Date.now()
    };
    await chrome.storage.local.set({[INCOGNITO_LAUNCH_KEY]: launch});
    const launcherUrl = new URL(chrome.runtime.getURL("incognito-launch.html"));
    launcherUrl.searchParams.set("launch", launch.nonce);
    const incognitoWindow = await chrome.windows.create({
      incognito: true,
      focused: true,
      url: launcherUrl.href
    });
    if (Number.isInteger(incognitoWindow?.id)) {
      const stored = await chrome.storage.local.get(INCOGNITO_LAUNCH_KEY);
      const launcherReadyLaunch = stored[INCOGNITO_LAUNCH_KEY]?.nonce === launch.nonce
        ? stored[INCOGNITO_LAUNCH_KEY]
        : launch;
      launch = {
        ...launcherReadyLaunch,
        windowId: incognitoWindow.id,
        launcherTabId: incognitoWindow.tabs?.[0]?.id ?? launcherReadyLaunch.launcherTabId
      };
      await chrome.storage.local.set({[INCOGNITO_LAUNCH_KEY]: launch});
      setStatus("Incognito window opened. Choose Open recorder on the BreakTest page there.");
    } else {
      setStatus("Incognito window opened. Choose Open recorder on the BreakTest page there.");
    }
    setTimeout(() => removeLaunchIfUnclaimed(launch.nonce), INCOGNITO_LAUNCH_TTL_MS);
  } catch (error) {
    if (launch?.nonce) {
      await removeLaunchIfUnclaimed(launch.nonce);
    }
    showError(error.message);
  } finally {
    setBusy(false);
  }
}

async function removeLaunchIfUnclaimed(nonce) {
  try {
    const stored = await chrome.storage.local.get(INCOGNITO_LAUNCH_KEY);
    if (stored[INCOGNITO_LAUNCH_KEY]?.nonce === nonce) {
      await chrome.storage.local.remove(INCOGNITO_LAUNCH_KEY);
    }
  } catch (_ignored) {
    // Cleanup is best effort; a timestamp also prevents stale instructions from being used.
  }
}

async function restoreStatus() {
  const response = await send({type: "recorder-status"});
  if (!response.ok) {
    showError(response.error);
    return;
  }
  applyStatus(response);
  if (!response.active) {
    requestList.replaceChildren();
    transactionList.replaceChildren();
    errors = 0;
    errorCount.textContent = "0";
  }
  if (response.summaries) {
    for (const summary of response.summaries) {
      appendRequest(summary, false);
    }
  }
}

async function startRecording(createBlankTab) {
  if (!requireRecordingConsent()) {
    return false;
  }
  setBusy(true);
  let sourceTab;
  let createdTab;
  try {
    [sourceTab] = await chrome.tabs.query({active: true, lastFocusedWindow: true});
    let tab = sourceTab;
    if (createBlankTab) {
      createdTab = await chrome.tabs.create({
        windowId: sourceTab?.windowId,
        url: "about:blank",
        active: false
      });
      tab = createdTab;
      await chrome.sidePanel.setOptions({
        tabId: tab.id,
        path: "sidepanel.html",
        enabled: true
      });
      await chrome.tabs.update(tab.id, {active: true});
      await chrome.sidePanel.open({tabId: tab.id});
    }
    const response = await send({
      type: "start-recording",
      tabId: tab?.id,
      windowId: tab?.windowId,
      transactionName: transactionName.value,
      startUrl: startUrl.value,
      createBlankTab: false,
      preparedNewTab: Boolean(createdTab),
      disableCache: disableCache.checked
    });
    if (!response.ok) {
      throw new Error(response.error);
    }
    if (createdTab) {
      if (typeof chrome.sidePanel.close === "function" && Number.isInteger(sourceTab?.id)) {
        await chrome.sidePanel.close({tabId: sourceTab.id}).catch(() => {});
      }
    }
    requestList.replaceChildren();
    errors = 0;
    errorCount.textContent = "0";
    applyStatus(response);
    setStatus(startUrl.value.trim()
      ? `${response.incognito ? "Incognito recording" : "Recording"} started and the start URL was opened.`
      : (createBlankTab
        ? `${response.incognito ? "Incognito recording" : "Recording"} started in a new tab.`
        : `${response.incognito ? "Incognito recording" : "Recording"} the selected tab.`));
    return true;
  } catch (error) {
    if (createdTab && Number.isInteger(sourceTab?.id)) {
      await chrome.tabs.update(sourceTab.id, {active: true}).catch(() => {});
      await chrome.tabs.remove(createdTab.id).catch(() => {});
    }
    showError(error.message);
    return false;
  } finally {
    setBusy(false);
  }
}

function scheduleTransactionCommit(force) {
  if (!active || !transactionNameDirty) {
    return;
  }
  clearTimeout(transactionCommitTimer);
  const elapsed = Date.now() - lastTransactionInputAt;
  const delay = force ? 0 : Math.max(0, TRANSACTION_TYPING_SETTLE_MS - elapsed);
  transactionCommitTimer = setTimeout(() => commitPendingTransaction(), delay);
}

function commitPendingTransaction() {
  clearTimeout(transactionCommitTimer);
  transactionCommitPromise = transactionCommitPromise.then(async () => {
    if (!active || !transactionNameDirty) {
      return;
    }
    const name = transactionName.value.trim();
    if (!name) {
      showError("Enter a transaction name");
      return;
    }
    if (name === lastCommittedTransactionName) {
      transactionNameDirty = false;
      return;
    }
    const response = await send({type: "new-transaction", name});
    if (!response.ok) {
      showError(response.error);
      return;
    }
    lastCommittedTransactionName = response.transaction.name;
    transactionNameDirty = transactionName.value.trim() !== lastCommittedTransactionName;
    applyStatus(response.status);
    setStatus(`Recording transaction: ${lastCommittedTransactionName}`);
  });
  return transactionCommitPromise;
}

async function finishRecording() {
  setBusy(true);
  setStatus(pendingHar
    ? "Choose where to save the completed HAR…"
    : "Finishing pending requests and building HAR…");
  try {
    if (!pendingHar) {
      await commitPendingTransaction();
      const response = await send({type: "stop-recording"});
      if (!response.ok) {
        throw new Error(response.error);
      }
      pendingHar = response.har;
      applyStatus({active: false, requestCount: pendingHar.log.entries.length, pendingCount: 0});
    }
    await downloadHar(pendingHar);
    pendingHar = null;
    updateRecordingControls();
    setStatus("HAR saved. Import it with File → Import HAR… in BreakTest.");
  } catch (error) {
    showError(pendingHar
      ? `HAR was not saved: ${error.message}. Choose Save HAR to retry or Discard and start over.`
      : error.message);
  } finally {
    setBusy(false);
    updateRecordingControls();
  }
}

async function discardAndStartOver() {
  const discardingHar = Boolean(pendingHar);
  const confirmed = window.confirm(discardingHar
    ? "Discard the unsaved HAR and start over? This recording cannot be recovered."
    : "Cancel this recording and discard all captured requests?");
  if (!confirmed) {
    return;
  }
  setBusy(true);
  try {
    if (active) {
      const response = await send({type: "cancel-recording"});
      if (!response.ok) {
        throw new Error(response.error);
      }
    }
    pendingHar = null;
    resetRecordingView();
    setStatus("Recording discarded. Ready to start again.");
  } catch (error) {
    showError(`Unable to discard the recording: ${error.message}`);
  } finally {
    setBusy(false);
  }
}

function resetRecordingView() {
  clearTimeout(transactionCommitTimer);
  requestList.replaceChildren();
  transactionList.replaceChildren();
  errors = 0;
  errorCount.textContent = "0";
  transactionName.value = DEFAULT_TRANSACTION_NAME;
  lastCommittedTransactionName = DEFAULT_TRANSACTION_NAME;
  transactionNameDirty = false;
  applyStatus({active: false, requestCount: 0, pendingCount: 0, transactions: []});
  updateRecordingControls();
}

async function downloadHar(har) {
  const json = JSON.stringify(har, null, 2);
  // Keep the explicit .har filename authoritative in the browser's Save As
  // dialog. application/json can cause some platforms to replace or append
  // the extension with .json even though HAR content is JSON.
  const blob = new Blob([json], {type: "application/octet-stream"});
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
  try {
    const downloadId = await chrome.downloads.download({
      url,
      filename: `breaktest-recording-${stamp}.har`,
      saveAs: true
    });
    await waitForDownload(downloadId);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function waitForDownload(downloadId) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = error => {
      if (settled) {
        return;
      }
      settled = true;
      chrome.downloads.onChanged.removeListener(onChanged);
      error ? reject(error) : resolve();
    };
    const inspect = item => {
      if (item?.state === "complete") {
        finish();
      } else if (item?.state === "interrupted") {
        finish(new Error(item.error || "The download was interrupted"));
      }
    };
    const onChanged = delta => {
      if (delta.id === downloadId && delta.state) {
        inspect({state: delta.state.current, error: delta.error?.current});
      }
    };
    chrome.downloads.onChanged.addListener(onChanged);
    chrome.downloads.search({id: downloadId})
      .then(items => inspect(items[0]))
      .catch(finish);
  });
}

function applyStatus(status) {
  setActive(Boolean(status.active));
  indicator.classList.toggle("active", Boolean(status.active && status.attached !== false));
  indicator.classList.toggle("reconnecting", Boolean(status.reconnecting));
  requestCount.textContent = String(status.requestCount ?? 0);
  pendingCount.textContent = String(status.pendingCount ?? 0);
  if (status.currentTransaction) {
    const currentName = status.currentTransaction.name;
    if (!transactionNameDirty) {
      transactionName.value = currentName;
    }
    lastCommittedTransactionName = currentName;
    transactionNameDirty = transactionName.value.trim() !== lastCommittedTransactionName;
  }
  if (status.transactions) {
    renderTransactions(status.transactions);
  }
}

function setActive(isActive) {
  active = isActive;
  startSetup.hidden = isActive;
  startActions.hidden = isActive;
  updateStartControls();
  updateRecordingControls();
  transactionHint.hidden = !isActive;
  transactionName.disabled = false;
  if (!isActive) {
    clearTimeout(transactionCommitTimer);
    transactionNameDirty = false;
  }
  if (!isActive && !statusText.textContent.includes("saved")) {
    setStatus("");
  }
}

function setBusy(isBusy) {
  busy = isBusy;
  updateStartControls();
  updateRecordingControls();
}

function updateRecordingControls() {
  const hasRecording = active;
  const hasUnsavedHar = Boolean(pendingHar);
  stopButton.textContent = hasUnsavedHar ? "Save HAR" : "Finish and export";
  stopButton.hidden = !hasRecording && !hasUnsavedHar;
  stopButton.disabled = busy || (!hasRecording && !hasUnsavedHar);
  discardButton.textContent = hasUnsavedHar ? "Discard and start over" : "Cancel recording";
  discardButton.hidden = !hasRecording && !hasUnsavedHar;
  discardButton.disabled = busy || (!hasRecording && !hasUnsavedHar);
}

function requireRecordingConsent() {
  if (recordingConsentAccepted) {
    return true;
  }
  showError("Review and accept the recording data notice before starting.");
  showPrivacySettings();
  recordingConsent.focus();
  return false;
}

function updateStartControls() {
  const disabled = busy || active || Boolean(pendingHar) || !recordingConsentAccepted;
  startButton.disabled = disabled;
  blankStartButton.disabled = disabled;
  incognitoStartButton.disabled = disabled;
}

async function restoreRecordingConsent() {
  try {
    const stored = await chrome.storage.local.get(RECORDING_CONSENT_KEY);
    setRecordingConsentAccepted(
      stored[RECORDING_CONSENT_KEY] === RECORDING_DISCLOSURE_VERSION,
      true
    );
  } catch (_ignored) {
    setRecordingConsentAccepted(false, false);
  }
}

async function persistRecordingConsent() {
  const accepted = recordingConsent.checked;
  try {
    if (accepted) {
      await chrome.storage.local.set({[RECORDING_CONSENT_KEY]: RECORDING_DISCLOSURE_VERSION});
    } else {
      await chrome.storage.local.remove(RECORDING_CONSENT_KEY);
    }
    setRecordingConsentAccepted(accepted, accepted);
  } catch (error) {
    setRecordingConsentAccepted(false, false);
    showError(`Unable to save recording consent: ${error.message}`);
  }
}

function setRecordingConsentAccepted(accepted, collapse) {
  recordingConsentAccepted = accepted;
  recordingConsent.checked = accepted;
  recordingDisclosure.hidden = accepted && collapse;
  privacySummary.hidden = !(accepted && collapse);
  privacyDoneButton.hidden = !accepted;
  updateStartControls();
}

function showPrivacySettings() {
  recordingDisclosure.hidden = false;
  privacySummary.hidden = true;
  privacyDoneButton.hidden = !recordingConsentAccepted;
}

function collapsePrivacySettings() {
  if (recordingConsentAccepted) {
    recordingDisclosure.hidden = true;
    privacySummary.hidden = false;
  }
}

function renderTransactions(transactions) {
  if (transactions) {
    transactionList.replaceChildren();
    for (const transaction of transactions) {
      const item = document.createElement("li");
      item.textContent = `${transaction.name} (${transaction.requestCount ?? 0})`;
      transactionList.append(item);
    }
  } else {
    send({type: "recorder-status"}).then(response => {
      if (response.ok) {
        renderTransactions(response.transactions || []);
      }
    });
  }
}

function appendRequest(summary, updateErrors = true) {
  const row = document.createElement("article");
  row.className = `request ${summary.failed || summary.status >= 400 ? "failed" : ""}`;

  const status = document.createElement("span");
  status.className = "request-status";
  status.textContent = summary.status || (summary.failed ? "ERR" : "—");
  const method = document.createElement("strong");
  method.textContent = summary.method;

  const path = document.createElement("span");
  path.className = "request-path";
  path.textContent = requestPath(summary.url);
  path.title = `${summary.url}\n${summary.transactionName} · ${summary.resourceType}`;

  row.append(status, method, path);
  if (summary.bodyTruncated || summary.bodyUnavailable) {
    const bodyWarning = document.createElement("span");
    bodyWarning.className = "request-body-warning";
    bodyWarning.textContent = "⚠";
    bodyWarning.title = summary.bodyTruncated ? "Response body truncated" : "Response body unavailable";
    row.append(bodyWarning);
  }

  requestList.prepend(row);
  while (requestList.childElementCount > 300) {
    requestList.lastElementChild.remove();
  }
  if (updateErrors && (summary.failed || summary.status >= 400)) {
    errors++;
    errorCount.textContent = String(errors);
  }
}

function requestPath(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname || "/"}${parsed.search}`;
  } catch (_ignored) {
    return url;
  }
}

function showError(message) {
  setStatus(message || "Unexpected recorder error");
  statusText.classList.add("error");
  setTimeout(() => statusText.classList.remove("error"), 4000);
}

function setStatus(message) {
  statusText.textContent = message;
  statusText.hidden = !message;
}

async function send(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (error) {
    return {ok: false, error: error.message};
  }
}
