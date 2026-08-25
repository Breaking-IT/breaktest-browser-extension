/*
 * Copyright 2024-2026 Breaking IT
 *
 * Licensed under the BreakTest Community Source License 1.0.
 * You may not use this file except in compliance with that license.
 * See the LICENSE file at the root of this distribution.
 */

const title = document.querySelector("#transaction-details-title");
const summary = document.querySelector("#transaction-details-summary");
const requestRows = document.querySelector("#transaction-details-requests");
const emptyState = document.querySelector("#transaction-details-empty");
const transactionId = new URLSearchParams(location.search).get("transaction");

let transaction = null;
let requests = [];
let loadSequence = 0;

chrome.runtime.onMessage.addListener(message => {
  switch (message.type) {
    case "request-finished":
      if (message.summary?.transactionId !== transactionId) {
        return;
      }
      updateTransaction(message.status);
      upsertRequest(message.summary);
      render();
      break;
    case "transaction-started":
      updateTransaction(message.status);
      render();
      break;
    case "transactions-changed":
      loadTransactionDetails();
      break;
    case "recording-stopped":
      updateTransaction(message);
      render();
      break;
    case "recording-cancelled":
      showUnavailable("This recording was discarded.");
      break;
    default:
      break;
  }
});

initialize();

async function initialize() {
  if (!transactionId) {
    showUnavailable("No transaction was selected.");
    return;
  }
  await loadTransactionDetails();
}

async function loadTransactionDetails() {
  const sequence = ++loadSequence;
  summary.textContent = "Loading requests…";
  try {
    const response = await chrome.runtime.sendMessage({
      type: "transaction-details",
      id: transactionId
    });
    if (sequence !== loadSequence) {
      return;
    }
    if (!response?.ok) {
      showUnavailable(response?.error || "Unable to load transaction requests.");
      return;
    }
    transaction = response.transaction;
    requests = response.requests || [];
    render();
  } catch (error) {
    if (sequence === loadSequence) {
      showUnavailable(error.message || "Unable to load transaction requests.");
    }
  }
}

function updateTransaction(status) {
  const updated = status?.transactions?.find(item => item.id === transactionId);
  if (updated) {
    transaction = updated;
  }
}

function upsertRequest(request) {
  const existingIndex = requests.findIndex(item => item.ordinal === request.ordinal);
  if (existingIndex >= 0) {
    requests[existingIndex] = request;
  } else {
    requests.push(request);
  }
}

function render() {
  if (!transaction) {
    showUnavailable("The selected transaction is no longer available.");
    return;
  }
  title.textContent = transaction.name;
  document.title = `${transaction.name} · BreakTest`;

  const sortedRequests = [...requests].sort((left, right) => (
    Date.parse(left.startedDateTime) - Date.parse(right.startedDateTime)
      || (left.ordinal ?? 0) - (right.ordinal ?? 0)
  ));
  requestRows.replaceChildren();
  const completedCount = sortedRequests.length;
  const includedCount = transaction.requestCount ?? completedCount;
  const pendingCount = Math.max(includedCount - completedCount, 0);
  summary.textContent = pendingCount
    ? `${completedCount} completed · ${pendingCount} pending`
    : `${completedCount} ${completedCount === 1 ? "request" : "requests"}`;
  emptyState.textContent = "No completed requests in this transaction yet.";
  emptyState.hidden = completedCount > 0;
  if (!completedCount) {
    return;
  }

  const firstStart = sortedRequests.reduce(
    (earliest, request) => Math.min(earliest, requestStart(request)),
    Number.POSITIVE_INFINITY
  );
  const lastEnd = sortedRequests.reduce(
    (latest, request) => Math.max(latest, requestStart(request) + requestDuration(request)),
    0
  );
  const span = Math.max(lastEnd - firstStart, 1);
  const rows = document.createDocumentFragment();

  for (const request of sortedRequests) {
    const row = document.createElement("tr");
    if (request.failed || request.status >= 400) {
      row.className = "failed";
    }

    const status = document.createElement("td");
    status.className = "request-detail-status";
    status.textContent = request.status || (request.failed ? "ERR" : "—");

    const method = document.createElement("td");
    method.className = "request-detail-method";
    method.textContent = request.method || "—";

    const url = document.createElement("td");
    url.className = "request-detail-url";
    const urlText = document.createElement("div");
    urlText.className = "request-detail-url-text";
    urlText.textContent = request.url || "—";
    urlText.title = request.url || "";

    const responseTime = document.createElement("td");
    responseTime.className = "request-detail-time";
    responseTime.textContent = formatResponseTime(requestDuration(request));

    const track = document.createElement("div");
    track.className = "waterfall-track";
    track.title = `${formatResponseTime(requestStart(request) - firstStart)} start · ${formatResponseTime(requestDuration(request))} response`;
    const bar = document.createElement("span");
    bar.className = "waterfall-bar";
    const left = ((requestStart(request) - firstStart) / span) * 100;
    const width = Math.max((requestDuration(request) / span) * 100, 0.8);
    const barWidth = Math.min(width, 100);
    bar.style.left = `${Math.min(left, 100 - barWidth)}%`;
    bar.style.width = `${barWidth}%`;
    track.append(bar);
    url.append(urlText, track);

    row.append(status, method, url, responseTime);
    rows.append(row);
  }
  requestRows.append(rows);
}

function showUnavailable(message) {
  transaction = null;
  requests = [];
  title.textContent = "Transaction unavailable";
  summary.textContent = "";
  requestRows.replaceChildren();
  emptyState.textContent = message;
  emptyState.hidden = false;
}

function requestStart(request) {
  const value = Date.parse(request.startedDateTime);
  return Number.isFinite(value) ? value : 0;
}

function requestDuration(request) {
  const value = Number(request.time);
  return Number.isFinite(value) ? Math.max(value, 0) : 0;
}

function formatResponseTime(milliseconds) {
  if (milliseconds < 1000) {
    return `${Math.round(milliseconds)} ms`;
  }
  return `${(milliseconds / 1000).toFixed(milliseconds < 10_000 ? 2 : 1)} s`;
}
