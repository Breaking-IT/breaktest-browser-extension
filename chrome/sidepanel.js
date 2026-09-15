/*
 * Copyright 2024-2026 Breaking IT
 *
 * Licensed under the BreakTest Community Source License 1.0.
 * You may not use this file except in compliance with that license.
 * See the LICENSE file at the root of this distribution.
 */

import "./har-export-store.js";

const focusRecordingButton = document.querySelector("#focus-recording-tab");
focusRecordingButton.addEventListener("click", async () => {
  focusRecordingButton.disabled = true;
  try {
    const response = await send({type: "focus-recording-tab"});
    if (!response?.ok) throw new Error(response?.error || "Unable to find the recording tab");
  } catch (error) {
    showError(error.message);
  } finally {
    focusRecordingButton.disabled = false;
  }
});

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
const nextTransactionButton = document.querySelector("#next-transaction-button");
const nextTransactionDialog = document.querySelector("#next-transaction-dialog");
const nextTransactionInput = document.querySelector("#next-transaction-input");
const nextTransactionForm = document.querySelector("#next-transaction-form");
const nextTransactionError = document.querySelector("#next-transaction-error");
const confirmNextTransaction = document.querySelector("#confirm-next-transaction");
const cancelNextTransaction = document.querySelector("#cancel-next-transaction");
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
const removeTransactionDialog = document.querySelector("#remove-transaction-dialog");
const removeTransactionName = document.querySelector("#remove-transaction-name");
const removeTransactionSummary = document.querySelector("#remove-transaction-summary");
const removeTransactionRequests = document.querySelector("#remove-transaction-requests");
const moveRequestsPrevious = document.querySelector("#move-requests-previous");
const moveRequestsNext = document.querySelector("#move-requests-next");
const previousTransactionName = document.querySelector("#previous-transaction-name");
const nextTransactionName = document.querySelector("#next-transaction-name");
const cancelTransactionRemoval = document.querySelector("#cancel-transaction-removal");

let active = false;
let busy = false;
let errors = 0;
let pendingExport = null;
let currentTransactionId = null;
const INCOGNITO_LAUNCH_KEY = "pendingIncognitoLaunch";
const INCOGNITO_LAUNCH_TTL_MS = 60_000;
const RECORDING_CONSENT_KEY = "recordingDisclosureAcceptedVersion";
const RECORDING_DISCLOSURE_VERSION = 3;
const DEFAULT_TRANSACTION_NAME = "01_OpenHomepage";
let recordingConsentAccepted = false;
const inIncognitoContext = chrome.extension.inIncognitoContext;

startButton.addEventListener("click", () => startRecording(false));
nextTransactionButton.addEventListener("click", openNextTransaction);
nextTransactionForm.addEventListener("submit", startNextTransaction);
cancelNextTransaction.addEventListener("click", () => nextTransactionDialog.close());
nextTransactionDialog.addEventListener("cancel", event => { if (busy) event.preventDefault(); });
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
  if (event.key === "Enter" && !busy) {
    event.preventDefault();
    active ? openNextTransaction() : startRecording(false);
  }
});

chrome.runtime.onMessage.addListener(message => {
  switch (message.type) {
    case "request-finished":
      appendRequest(message.summary);
      applyStatus(message.status);
      break;
    case "transaction-started":
      message.status ? applyStatus(message.status) : renderTransactions();
      break;
    case "transactions-changed":
      applyTransactionChanges(message.status);
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
  await prefillStartUrl();
  await restorePendingExport();
}

async function prefillStartUrl() {
  if (active || startUrl.value.trim()) {
    return;
  }
  try {
    const [tab] = await chrome.tabs.query({active: true, lastFocusedWindow: true});
    const url = tab?.url;
    if (typeof url === "string" && /^https?:/i.test(url)) {
      startUrl.value = url;
    }
  } catch (_ignored) {
    // The field remains optional if the active tab URL is unavailable.
  }
}

async function restorePendingExport() {
  try {
    await globalThis.HarExportStore.cleanupStale();
    if (active) {
      return;
    }
    pendingExport = await globalThis.HarExportStore.latest();
    if (!pendingExport) {
      return;
    }
    applyStatus({
      active: false,
      requestCount: pendingExport.entryCount,
      pendingCount: 0
    });
    updateRecordingControls();
    setStatus("A completed HAR is waiting to be saved.");
  } catch (error) {
    showError(`Unable to restore a pending HAR export: ${error.message}`);
  }
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
  if (response.startWarning) setStatus(response.startWarning);
  if (!response.active) {
    requestList.replaceChildren();
    transactionList.replaceChildren();
    errors = 0;
    errorCount.textContent = "0";
  }
  if (response.summaries) {
    renderRequestSummaries(response.summaries);
  }
}

async function startRecording() {
  if (!requireRecordingConsent()) return false;
  setBusy(true);
  try {
    const [tab] = await chrome.tabs.query({active: true, lastFocusedWindow: true});
    const response = await send({
      type: "start-recording",
      tabId: tab?.id,
      transactionName: transactionName.value,
      startUrl: "",
      disableCache: disableCache.checked
    });
    if (!response.ok) throw new Error(response.error);
    requestList.replaceChildren();
    errors = 0;
    errorCount.textContent = "0";
    applyStatus(response);
    setStatus("Recording the current page. Reload it manually if you want to capture its initial requests.");
    return true;
  } catch (error) {
    showError(error.message);
    return false;
  } finally {
    setBusy(false);
  }
}

function nextTransactionPrefix(name) {
  // Increment the last underscore-delimited numeric token, preserving its width and prefix.
  const matches = [...name.trim().matchAll(/(?:^|_)(\d+)(?=_)/g)];
  const match = matches.at(-1);
  if (!match) return "01_";
  const digitsAt = match.index + (match[0].startsWith("_") ? 1 : 0);
  const number = (BigInt(match[1]) + 1n).toString().padStart(match[1].length, "0");
  return name.trim().slice(0, digitsAt) + number + "_";
}

function openNextTransaction() {
  if (!active || busy || nextTransactionDialog.open) return;
  nextTransactionInput.value = nextTransactionPrefix(transactionName.value);
  nextTransactionError.hidden = true;
  nextTransactionDialog.showModal();
  nextTransactionInput.focus();
  const end = nextTransactionInput.value.length;
  nextTransactionInput.setSelectionRange(end, end);
}

async function startNextTransaction(event) {
  event.preventDefault();
  if (!active || busy) return;
  const name = nextTransactionInput.value.trim();
  if (!name) {
    nextTransactionError.textContent = "Enter a transaction name";
    nextTransactionError.hidden = false;
    nextTransactionInput.focus();
    return;
  }
  setBusy(true);
  try {
    const response = await send({type: "new-transaction", name});
    if (!response.ok) throw new Error(response.error);
    applyStatus(response.status);
    nextTransactionDialog.close();
    setStatus(`Recording transaction: ${response.transaction.name}`);
  } catch (error) {
    nextTransactionError.textContent = error.message;
    nextTransactionError.hidden = false;
  } finally {
    setBusy(false);
  }
}

async function finishRecording() {
  setBusy(true);
  setStatus(pendingExport
    ? "Choose where to save the completed HAR…"
    : "Finishing pending requests and building HAR…");
  try {
    if (!pendingExport) {
      const response = await send({type: "stop-recording"});
      if (!response.ok) {
        throw new Error(response.error);
      }
      pendingExport = response.export;
      applyStatus({active: false, requestCount: pendingExport.entryCount, pendingCount: 0});
    }
    await downloadHar(pendingExport);
    await globalThis.HarExportStore.remove(pendingExport.id);
    pendingExport = null;
    updateRecordingControls();
    setStatus("HAR saved. Import it with File → Import HAR… in BreakTest.");
  } catch (error) {
    showError(pendingExport
      ? `HAR was not saved: ${error.message}. Choose Save HAR to retry or Discard and start over.`
      : error.message);
  } finally {
    setBusy(false);
    updateRecordingControls();
  }
}

async function discardAndStartOver() {
  const discardingHar = Boolean(pendingExport);
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
    if (pendingExport) {
      await globalThis.HarExportStore.remove(pendingExport.id);
    }
    pendingExport = null;
    resetRecordingView();
    setStatus("Recording discarded. Ready to start again.");
  } catch (error) {
    showError(`Unable to discard the recording: ${error.message}`);
  } finally {
    setBusy(false);
  }
}

function resetRecordingView() {
  requestList.replaceChildren();
  transactionList.replaceChildren();
  errors = 0;
  errorCount.textContent = "0";
  transactionName.value = DEFAULT_TRANSACTION_NAME;
  applyStatus({active: false, requestCount: 0, pendingCount: 0, transactions: []});
  updateRecordingControls();
}

async function downloadHar(exportDescriptor) {
  const storedExport = await globalThis.HarExportStore.get(exportDescriptor.id);
  if (!storedExport?.blob) {
    throw new Error("The completed HAR is no longer available in local storage");
  }
  const url = URL.createObjectURL(storedExport.blob);
  try {
    const downloadId = await chrome.downloads.download({
      url,
      filename: storedExport.filename,
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
  currentTransactionId = status.currentTransaction?.id || null;
  indicator.classList.toggle("active", Boolean(status.active && status.attached !== false));
  indicator.classList.toggle("reconnecting", Boolean(status.reconnecting));
  requestCount.textContent = String(status.requestCount ?? 0);
  pendingCount.textContent = String(status.pendingCount ?? 0);
  if (status.currentTransaction) {
    const currentName = status.currentTransaction.name;
    transactionName.value = currentName;
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
  transactionName.readOnly = isActive;
  if (!isActive && nextTransactionDialog.open) nextTransactionDialog.close();
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
  nextTransactionButton.disabled = !active || busy;
  confirmNextTransaction.disabled = busy;
  cancelNextTransaction.disabled = busy;
  nextTransactionInput.disabled = busy;
  const hasRecording = active;
  const hasUnsavedHar = Boolean(pendingExport);
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
  const disabled = busy || active || Boolean(pendingExport) || !recordingConsentAccepted;
  startButton.disabled = disabled;

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
    transactions.forEach((transaction, index) => {
      const item = document.createElement("li");
      const row = document.createElement("div");
      row.className = "transaction-row";

      const label = document.createElement("button");
      label.type = "button";
      label.className = "quiet transaction-name transaction-open";
      label.textContent = `${transaction.name} (${transaction.requestCount ?? 0})`;
      label.title = `View requests in ${transaction.name}`;
      label.addEventListener("click", () => openTransactionDetails(transaction));

      const actions = document.createElement("span");
      actions.className = "transaction-actions";
      const editButton = document.createElement("button");
      editButton.type = "button";
      editButton.className = "quiet transaction-action";
      editButton.textContent = "✎";
      editButton.title = `Rename ${transaction.name}`;
      editButton.setAttribute("aria-label", `Rename transaction ${transaction.name}`);
      editButton.disabled = !active;
      editButton.addEventListener("click", () => renameRecordedTransaction(transaction));

      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "quiet transaction-action transaction-delete";
      deleteButton.textContent = "×";
      deleteButton.setAttribute("aria-label", `Remove transaction ${transaction.name}`);
      const isCurrent = transaction.id === currentTransactionId;
      deleteButton.disabled = !active || isCurrent;
      deleteButton.title = isCurrent
        ? "Start a new transaction before removing the active transaction"
        : `Remove ${transaction.name} and its recorded requests`;
      deleteButton.addEventListener("click", () => deleteRecordedTransaction(
        transaction,
        transactions[index - 1] || null,
        transactions[index + 1] || null
      ));

      actions.append(editButton, deleteButton);
      row.append(label, actions);
      item.append(row);
      transactionList.append(item);
    });
  } else {
    send({type: "recorder-status"}).then(response => {
      if (response.ok) {
        renderTransactions(response.transactions || []);
      }
    });
  }
}

async function openTransactionDetails(transaction) {
  const url = new URL(chrome.runtime.getURL("transaction-details.html"));
  url.searchParams.set("transaction", transaction.id);
  try {
    await chrome.windows.create({
      url: url.href,
      type: "popup",
      width: 1000,
      height: 700,
      focused: true,
      incognito: inIncognitoContext
    });
  } catch (error) {
    showError(`Unable to open transaction requests: ${error.message}`);
  }
}

async function renameRecordedTransaction(transaction) {
  const name = window.prompt("Rename transaction", transaction.name);
  if (name == null || name.trim() === transaction.name) {
    return;
  }
  const response = await send({type: "rename-transaction", id: transaction.id, name});
  if (!response.ok) {
    showError(response.error);
    return;
  }
  applyTransactionChanges(response.status);
  setStatus(`Transaction renamed to ${response.transaction.name}.`);
}

async function deleteRecordedTransaction(transaction, previousTransaction, nextTransaction) {
  const requestDisposition = await chooseTransactionRemoval(
    transaction,
    previousTransaction,
    nextTransaction
  );
  if (!requestDisposition) {
    return;
  }
  const response = await send({
    type: "delete-transaction",
    id: transaction.id,
    requestDisposition
  });
  if (!response.ok) {
    showError(response.error);
    return;
  }
  applyTransactionChanges(response.status);
  setStatus(response.targetTransaction
    ? `Removed transaction ${transaction.name} and moved its requests to ${response.targetTransaction.name}.`
    : `Removed transaction ${transaction.name} and its recorded requests.`);
}

function chooseTransactionRemoval(transaction, previousTransaction, nextTransaction) {
  const requestCountValue = transaction.requestCount ?? 0;
  const requestLabel = requestCountValue === 1 ? "recorded request" : "recorded requests";
  removeTransactionName.textContent = `“${transaction.name}”`;
  removeTransactionSummary.textContent = `${requestCountValue} ${requestLabel}`;
  moveRequestsPrevious.disabled = !previousTransaction;
  previousTransactionName.textContent = previousTransaction
    ? `Move to “${previousTransaction.name}”.`
    : "No previous transaction is available.";
  moveRequestsNext.disabled = !nextTransaction;
  nextTransactionName.textContent = nextTransaction
    ? `Move to “${nextTransaction.name}”.`
    : "No next transaction is available.";

  return new Promise(resolve => {
    let settled = false;
    const finish = choice => {
      if (settled) {
        return;
      }
      settled = true;
      removeTransactionDialog.close();
      resolve(choice);
    };
    removeTransactionRequests.onclick = () => finish("delete");
    moveRequestsPrevious.onclick = () => finish("previous");
    moveRequestsNext.onclick = () => finish("next");
    cancelTransactionRemoval.onclick = () => finish(null);
    removeTransactionDialog.oncancel = event => {
      event.preventDefault();
      finish(null);
    };
    removeTransactionDialog.showModal();
    cancelTransactionRemoval.focus();
  });
}

function applyTransactionChanges(status) {
  if (!status) {
    return;
  }
  applyStatus(status);
  renderRequestSummaries(status.summaries || []);
}

function renderRequestSummaries(summaries) {
  requestList.replaceChildren();
  errors = 0;
  errorCount.textContent = "0";
  for (const summary of summaries) {
    appendRequest(summary);
  }
}

function appendRequest(summary, updateErrors = true) {
  const row = document.createElement("article");
  row.className = `request ${summary.failed || summary.status >= 400 ? "failed" : ""}`;
  row.dataset.transactionId = summary.transactionId;

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
