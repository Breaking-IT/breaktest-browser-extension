/*
 * Copyright 2024-2026 Breaking IT
 *
 * Licensed under the BreakTest Community Source License 1.0.
 * You may not use this file except in compliance with that license.
 * See the LICENSE file at the root of this distribution.
 */

/* File bytes live in the recording, never in extension storage or page messages. */
globalThis.UploadStore = (() => {
  const MAX_FILE_BYTES = 20 * 1024 * 1024;
  const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
  const CHUNK_BYTES = 192 * 1024; // Divisible by three, so base64 chunks can be joined.
  const MAX_FILES = 1000;

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
      return {ok: !owner.stopping, token: capture.token};
    }
    if (message.token !== capture.token) return {ok: false};
    if (message.type === "upload-begin") {
      if (owner.stopping) return {ok: false};
      if (capture.files.length >= MAX_FILES) {
        capture.fileLimitReached = true;
        return {ok: false};
      }
      const meta = message.file;
      if (!meta || typeof meta.name !== "string" || !Number.isSafeInteger(meta.size) || meta.size < 0) {
        return {ok: false};
      }
      const file = {
        id: crypto.randomUUID(), fileName: meta.name.slice(0, 4096), size: meta.size,
        mimeType: String(meta.mimeType || "application/octet-stream").slice(0, 256),
        fieldName: String(meta.fieldName || "").slice(0, 4096),
        source: ["input", "drop", "formdata"].includes(meta.source) ? meta.source : "input",
        pageUrl: sender.url || "", frameId: sender.frameId,
        capturedDateTime: new Date().toISOString(),
        transactionId: owner.currentTransaction?.id,
        status: "pending", encoding: "base64"
      };
      capture.files.push(file);
      if (file.size > MAX_FILE_BYTES || capture.reservedBytes + file.size > MAX_TOTAL_BYTES) {
        file.status = "unavailable";
        file.reason = file.size > MAX_FILE_BYTES ? "file-size-limit" : "recording-size-limit";
        return {ok: false};
      }
      capture.reservedBytes += file.size;
      let resolve;
      const done = new Promise(callback => { resolve = callback; });
      capture.transfers.set(file.id, {
        file, chunks: [], bytes: 0, frameId: sender.frameId, documentId: sender.documentId,
        done, resolve
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

  async function settle(owner, timeoutMs = 5000) {
    if (!owner.uploadCapture) return;
    const capture = owner.uploadCapture;
    let timer;
    await Promise.race([
      Promise.all([...capture.transfers.values()].map(item => item.done)),
      new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); })
    ]);
    clearTimeout(timer);
    for (const transfer of capture.transfers.values()) finish(capture, transfer, "recording-stopped");
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
      maxFileBytes: MAX_FILE_BYTES, maxTotalBytes: MAX_TOTAL_BYTES,
      fileLimitReached: Boolean(capture?.fileLimitReached),
      installationError: capture?.installationError || null,
      scope: "Files selected, dropped, or observed in formdata; not proof of upload or a request association."
    };
  }
  return {handle, install, settle, exportFiles, removeTransaction};
})();
