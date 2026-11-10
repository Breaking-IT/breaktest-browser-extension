/*
 * Copyright 2024-2026 Breaking IT
 *
 * Licensed under the BreakTest Community Source License 1.0.
 * You may not use this file except in compliance with that license.
 * See the LICENSE file at the root of this distribution.
 */

/* File bytes live in the recording, never in extension storage or page messages. */
globalThis.UploadStore = (() => {
  const CHUNK_BYTES = 192 * 1024; // Divisible by three, so base64 chunks can be joined.

  function state(owner) {
    return owner.uploadCapture ||= {
      token: crypto.randomUUID(), files: [], transfers: new Map(), reservedBytes: 0,
      fileLimitReached: false, installationError: null
    };
  }

  function handle(owner, message, sender) {
    if (!owner || sender.tab?.id !== owner.tabId) return {ok: false};
    const capture = state(owner);
    if (message.type === "upload-status") {
      return {ok: !owner.stopping && !owner.paused, token: capture.token};
    }
    if (message.token !== capture.token) return {ok: false};
    if (message.type === "upload-begin") {
      if (owner.stopping || owner.paused) return {ok: false};
      const meta = message.file;
      if (!meta || typeof meta.name !== "string" || !Number.isSafeInteger(meta.size) || meta.size < 0) {
        return {ok: false};
      }
      const file = {
        id: crypto.randomUUID(), fileName: meta.name, size: meta.size,
        mimeType: String(meta.mimeType || "application/octet-stream"),
        fieldName: String(meta.fieldName || ""),
        source: ["input", "drop", "formdata"].includes(meta.source) ? meta.source : "input",
        pageUrl: sender.url || "", frameId: sender.frameId,
        capturedDateTime: new Date().toISOString(),
        transactionId: owner.currentTransaction?.id,
        status: "pending", encoding: "base64"
      };
      capture.files.push(file);
      capture.reservedBytes += file.size;
      let resolve;
      const done = new Promise(callback => { resolve = callback; });
      capture.transfers.set(file.id, {
        file, chunks: [], bytes: 0, frameId: sender.frameId, documentId: sender.documentId,
        done, resolve, lastProgress: Date.now()
      });
      return {ok: true, id: file.id, chunkBytes: CHUNK_BYTES};
    }
    const transfer = capture.transfers.get(message.id);
    if (!transfer || transfer.frameId !== sender.frameId || transfer.documentId !== sender.documentId) {
      return {ok: false};
    }
    if (message.type === "upload-chunk") {
      const data = message.data;
      if (typeof data !== "string" || data.length > CHUNK_BYTES / 3 * 4 ||
          data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
        finish(capture, transfer, "invalid-chunk");
        return {ok: false};
      }
      const bytes = data.length / 4 * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
      const remaining = transfer.file.size - transfer.bytes;
      if (bytes !== Math.min(CHUNK_BYTES, remaining) || bytes === 0) {
        finish(capture, transfer, "invalid-chunk-size");
        return {ok: false};
      }
      transfer.chunks.push(data);
      transfer.bytes += bytes;
      transfer.lastProgress = Date.now();
      return {ok: true};
    }
    if (message.type === "upload-end") {
      finish(capture, transfer, message.failed ? "file-read-failed" :
        transfer.bytes !== transfer.file.size ? "incomplete-transfer" : null);
      return {ok: true};
    }
    return {ok: false};
  }

  function finish(capture, transfer, reason) {
    transfer.file.status = reason ? "unavailable" : "complete";
    if (reason) transfer.file.reason = reason;
    else transfer.file.content = transfer.chunks.join("");
    capture.transfers.delete(transfer.file.id);
    transfer.resolve();
  }

  async function settle(owner, timeoutMs = 5000, maxWaitMs = Infinity) {
    if (!owner.uploadCapture) return;
    const capture = owner.uploadCapture;
    // Allow progressing transfers to drain, subject to an optional total
    // deadline when finishing a recording. Also abandon stalled transfers.
    const settlingAt = Date.now();
    while (capture.transfers.size) {
      let timer;
      const remaining = Math.min(Math.max(1, maxWaitMs - (Date.now() - settlingAt)), [...capture.transfers.values()].reduce((wait, item) =>
        Math.min(wait, Math.max(1, timeoutMs - (Date.now() - Math.max(item.lastProgress, settlingAt)))), timeoutMs));
      await Promise.race([
        Promise.all([...capture.transfers.values()].map(item => item.done)),
        new Promise(resolve => { timer = setTimeout(resolve, remaining); })
      ]);
      clearTimeout(timer);
      for (const transfer of capture.transfers.values()) {
        if (Date.now() - settlingAt >= maxWaitMs || Date.now() - Math.max(transfer.lastProgress, settlingAt) >= timeoutMs) {
          finish(capture, transfer, "recording-stopped");
        }
      }
    }
  }

  async function install(api, owner) {
    state(owner);
    try {
      await api.scripting.executeScript({target: {tabId: owner.tabId, allFrames: true}, files: ["upload-capture.js"]});
    } catch (error) {
      // Internal/new tabs cannot be injected; the manifest script handles subsequent navigation.
      state(owner).installationError = String(error.message || error);
    }
  }

  function removeTransaction(owner, id, targetId) {
    const capture = owner.uploadCapture;
    if (!capture) return;
    for (const file of capture.files.filter(item => item.transactionId === id)) {
      if (targetId) {
        file.transactionId = targetId;
      } else {
        const transfer = capture.transfers.get(file.id);
        if (transfer) finish(capture, transfer, "transaction-deleted");
        capture.files = capture.files.filter(item => item !== file);
      }
    }
  }

  function exportFiles(owner) {
    const capture = owner.uploadCapture;
    if (!capture?.files.length) return undefined;
    return {
      version: 1, files: capture?.files || [],
      fileLimitReached: Boolean(capture?.fileLimitReached),
      installationError: capture?.installationError || null,
      scope: "Files selected, dropped, or observed in formdata; not proof of upload or a request association."
    };
  }
  return {handle, install, settle, exportFiles, removeTransaction};
})();
