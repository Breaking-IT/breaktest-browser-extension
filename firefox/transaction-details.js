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
let timelineSpan = 1;
let showCached = false;
const cacheToggle = document.querySelector("#cache-toggle");
const tooltip = document.querySelector("#request-timing-tooltip");
cacheToggle.addEventListener("click", () => { showCached = !showCached; render(); });
document.querySelector(".request-detail-table-wrap").addEventListener("scroll", clearHover);
document.addEventListener("keydown", event => { if (event.key === "Escape") clearHover(); });
window.addEventListener("resize", clearHover);

function showTimingDetails(cell) {
  tooltip.replaceChildren();
  const heading = document.createElement("strong");
  heading.textContent = cell.dataset.path;
  const details = document.createElement("dl");
  for (const [label, value] of JSON.parse(cell.dataset.details)) {
    const term = document.createElement("dt");
    term.textContent = label;
    const description = document.createElement("dd");
    description.textContent = value;
    details.append(term, description);
  }
  tooltip.append(heading, details);
  tooltip.hidden = false;
  const bounds = cell.getBoundingClientRect();
  tooltip.style.left = `${Math.max(8, Math.min(bounds.left, innerWidth - tooltip.offsetWidth - 8))}px`;
  tooltip.style.top = `${Math.max(8, bounds.bottom + tooltip.offsetHeight + 12 < innerHeight ? bounds.bottom + 8 : bounds.top - tooltip.offsetHeight - 8)}px`;
}
function shortUrl(value) {
  try { const url = new URL(value); return `${url.pathname}${url.search}`; }
  catch { return value || "—"; }
}
const timeline = document.querySelector("#waterfall-axis");
const table = document.querySelector(".request-detail-table");
const hoverLabel = document.querySelector("#waterfall-hover-time");

table.addEventListener("pointermove", event => {
  const cell = event.target.closest(".waterfall-cell, #waterfall-axis");
  if (!cell) { clearHover(); return; }
  if (cell.dataset.details) showTimingDetails(cell);
  else tooltip.hidden = true;
  const bounds = cell.getBoundingClientRect();
  const fraction = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
  table.style.setProperty("--hover-position", `${fraction * 100}%`);
  table.classList.add("waterfall-hovering");
  hoverLabel.textContent = `${formatResponseTime(fraction * timelineSpan)} since first request`;
});
table.addEventListener("pointerleave", clearHover);
function clearHover() {
  tooltip.hidden = true;
  table.classList.remove("waterfall-hovering");
  hoverLabel.textContent = "Hover over the waterfall to inspect elapsed time";
}

function isCacheOnly(request) {
  // Revalidation and failures still belong in the network view. Service workers
  // may fetch from the network, so their responses are not assumed cache-only.
  return ["disk", "memory", "firefox-cache"].includes(request.fromCache)
    && !request.failed && request.status !== 304 && request.status < 400;
}

function renderAxis(span) {
  timeline.replaceChildren();
  const target = span / 5;
  const magnitude = 10 ** Math.floor(Math.log10(target));
  const step = [1, 2, 5, 10].map(value => value * magnitude).find(value => value >= target);
  table.style.setProperty("--grid-step", `${step / span * 100}%`);
  for (let time = 0; time <= span; time += step) {
    const tick = document.createElement("span");
    tick.className = "waterfall-tick";
    tick.style.left = `${time / span * 100}%`;
    if (time / span > 0.9) tick.style.transform = "translateX(-100%)";
    tick.textContent = formatResponseTime(time);
    timeline.append(tick);
  }
}

browser.runtime.onMessage.addListener(message => {
  switch (message.type) {
    case "request-finished":
      if (message.summary?.transactionId !== transactionId) {
        return;
      }
      updateTransaction(message.status);
      upsertRequest(message.summary);
      render();
      break;
    case "recorder-status-changed":
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
    const response = await browser.runtime.sendMessage({
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

  const sortedRequests = requests.filter(request => showCached || !isCacheOnly(request)).sort((left, right) => (
    Date.parse(left.startedDateTime) - Date.parse(right.startedDateTime)
      || (left.ordinal ?? 0) - (right.ordinal ?? 0)
  ));
  clearHover();
  timeline.replaceChildren();
  requestRows.replaceChildren();
  document.querySelector("#timing-unknown-legend").hidden = !sortedRequests.some(request =>
    requestPhases(request).some(phase => phase.name === "unknown" && phase.time > 0));
  const completedCount = sortedRequests.length;
  const includedCount = transaction.requestCount ?? completedCount;
  const pendingCount = transaction.pendingCount ?? Math.max(includedCount - requests.length, 0);
  const cachedCount = requests.filter(isCacheOnly).length;
  const hiddenCount = requests.length - completedCount;
  cacheToggle.hidden = cachedCount === 0;
  cacheToggle.textContent = showCached ? `Hide ${cachedCount} cached` : `${cachedCount} cached hidden · Show`;
  cacheToggle.setAttribute("aria-pressed", String(showCached));
  summary.textContent = pendingCount
    ? `${completedCount} completed · ${pendingCount} pending`
    : `${completedCount} ${completedCount === 1 ? "request" : "requests"}`;
  const networkRequests = requests.filter(request => !isCacheOnly(request));
  const knownSizes = networkRequests.filter(request => Number.isFinite(request.size) && request.size >= 0);
  const bytes = knownSizes.reduce((total, request) => total + request.size, 0);
  summary.textContent += ` · ${formatSize(bytes)} KB recorded${knownSizes.length < networkRequests.length ? " (partial)" : ""}`;
  summary.title = "Recorded network response bytes; cached responses excluded. Some browsers do not report full transfer sizes.";
  emptyState.textContent = hiddenCount ? "No completed network requests; cached responses are hidden." : "No completed requests in this transaction yet.";
  emptyState.hidden = completedCount > 0;
  if (!completedCount) {
    return;
  }

  // Keep the origin stable when cached rows are shown or hidden.
  const firstStart = requests.reduce(
    (earliest, request) => Math.min(earliest, requestStart(request)),
    Number.POSITIVE_INFINITY
  );
  const lastEnd = requests.reduce(
    (latest, request) => Math.max(latest, requestStart(request) + requestDuration(request)),
    0
  );
  const span = Math.max(lastEnd - firstStart, 1);
  summary.textContent += ` · ${formatResponseTime(Math.max(lastEnd - firstStart, 0))} to last response`;
  timelineSpan = span;
  renderAxis(span);
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
    urlText.textContent = shortUrl(request.url);
    urlText.title = request.url || "";

    const relativeStart = document.createElement("td");
    relativeStart.className = "request-detail-start";
    relativeStart.textContent = formatResponseTime(Math.max(requestStart(request) - firstStart, 0));

    const responseTime = document.createElement("td");
    responseTime.className = "request-detail-time";
    responseTime.textContent = formatResponseTime(requestDuration(request));

    const track = document.createElement("div");
    track.className = "waterfall-track";
    track.title = `${formatResponseTime(requestStart(request) - firstStart)} start · ${formatResponseTime(requestDuration(request))} response`;
    const phases = requestPhases(request);
    let offset = requestStart(request) - firstStart;
    for (const phase of phases) {
      if (phase.time <= 0) continue;
      const bar = document.createElement("span");
      bar.className = `waterfall-bar phase-${phase.name}`;
      bar.style.left = `${Math.min(offset / span * 100, 100)}%`;
      bar.style.width = `${Math.min(phase.time / span * 100, 100)}%`;
      track.append(bar);
      offset += phase.time;
    }
    const timingDescription = phases.map(phase => `${phase.label}: ${formatResponseTime(phase.time)}`).join(" · ");
    url.title = `${request.url || ""}\n${track.title}\n${timingDescription}`;
    urlText.title = url.title;
    track.setAttribute("aria-hidden", "true");
    const waterfall = document.createElement("div");
    waterfall.className = "waterfall-cell";
    waterfall.append(track);
    waterfall.tabIndex = 0;
    waterfall.setAttribute("aria-describedby", "request-timing-tooltip");
    waterfall.setAttribute("aria-label", `${request.method} ${shortUrl(request.url)}; ${track.title}`);
    waterfall.dataset.path = shortUrl(request.url);
    waterfall.dataset.details = JSON.stringify([
      ["Start offset", formatResponseTime(requestStart(request) - firstStart)],
      ["End offset", formatResponseTime(requestStart(request) - firstStart + requestDuration(request))],
      ["Duration", formatResponseTime(requestDuration(request))],
      ...phases.map(phase => [phase.label, formatResponseTime(phase.time)])
    ]);
    waterfall.addEventListener("focus", () => showTimingDetails(waterfall));
    waterfall.addEventListener("blur", clearHover);
    track.removeAttribute("title");
    const waterfallColumn = document.createElement("td");
    waterfallColumn.className = "request-detail-waterfall";
    waterfallColumn.append(waterfall);
    url.append(urlText);
    if (isCacheOnly(request)) {
      const badge = document.createElement("span");
      badge.className = "cache-badge";
      badge.textContent = "cached";
      urlText.append(" ", badge);
    }
    const size = document.createElement("td");
    size.className = "request-detail-size";
    size.textContent = formatSize(request.size);
    size.title = Number.isFinite(request.size) && request.size >= 0
      ? `${request.size.toLocaleString()} recorded response bytes (1 KB = 1,000 bytes)`
      : "Response size unavailable";
    row.append(status, method, url, waterfallColumn, relativeStart, responseTime, size);
    rows.append(row);
  }
  requestRows.append(rows);
}

function showUnavailable(message) {
  transaction = null;
  requests = [];
  title.textContent = "Transaction unavailable";
  summary.textContent = "";
  cacheToggle.hidden = true;
  clearHover();
  timeline.replaceChildren();
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

function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  return (bytes / 1000).toLocaleString(undefined, {minimumFractionDigits: 1, maximumFractionDigits: 1});
}

function requestPhases(request) {
  const total = requestDuration(request);
  const timings = request.timings;
  const known = value => Number.isFinite(value) && value >= 0 ? value : 0;
  if (!timings) return [{name: "unknown", label: "Total duration only; the browser did not provide a timing breakdown", time: total}];
  // HAR connect already includes TLS. Do not add ssl a second time.
  const phases = [
    {name: "connection", label: "Connection / sending", time: [timings.blocked, timings.dns, timings.connect, timings.send].reduce((sum, value) => sum + known(value), 0)},
    {name: "wait", label: request.timingSource === "response-events" ? "Before response (connection and waiting combined)" : "Waiting", time: known(timings.wait)},
    {name: "receive", label: "Receiving", time: known(timings.receive)}
  ];
  const sum = phases.reduce((value, phase) => value + phase.time, 0);
  // Roundoff or browser estimates must not draw past the request's end.
  if (sum > total && sum > 0) phases.forEach(phase => { phase.time *= total / sum; });
  if (sum < total) phases.push({name: "unknown", label: "Time not attributed to a phase by the browser", time: total - sum});
  return phases;
}
