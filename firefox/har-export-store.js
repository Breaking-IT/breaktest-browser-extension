/*
 * Copyright 2024-2026 Breaking IT
 *
 * Licensed under the BreakTest Community Source License 1.0.
 * You may not use this file except in compliance with that license.
 * See the LICENSE file at the root of this distribution.
 */

(() => {
  const DATABASE_NAME = "breaktest-browser-recorder";
  const DATABASE_VERSION = 1;
  const EXPORT_STORE = "har-exports";
  const CREATED_AT_INDEX = "created-at";
  const STALE_EXPORT_AGE_MS = 24 * 60 * 60 * 1000;

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(EXPORT_STORE)) {
          const store = database.createObjectStore(EXPORT_STORE, {keyPath: "id"});
          store.createIndex(CREATED_AT_INDEX, "createdAt");
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Unable to open HAR export storage"));
      request.onblocked = () => reject(new Error("HAR export storage is blocked by another extension page"));
    });
  }

  function transactionComplete(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(
        transaction.error || new Error("HAR export storage transaction was aborted")
      );
      transaction.onerror = () => reject(
        transaction.error || new Error("HAR export storage transaction failed")
      );
    });
  }

  function requestResult(request, fallbackMessage) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error(fallbackMessage));
    });
  }

  function descriptor(record) {
    if (!record) {
      return null;
    }
    return {
      id: record.id,
      filename: record.filename,
      byteSize: record.byteSize,
      entryCount: record.entryCount,
      createdAt: record.createdAt
    };
  }

  function exportFilename(createdAt) {
    const stamp = new Date(createdAt)
      .toISOString()
      .replaceAll(":", "-")
      .replace(/\.\d{3}Z$/, "Z");
    return `breaktest-recording-${stamp}.har`;
  }

  async function save(har) {
    const createdAt = Date.now();
    const json = JSON.stringify(har, null, 2);
    const blob = new Blob([json], {type: "application/octet-stream"});
    const record = {
      id: crypto.randomUUID(),
      filename: exportFilename(createdAt),
      byteSize: blob.size,
      entryCount: Array.isArray(har?.log?.entries) ? har.log.entries.length : 0,
      createdAt,
      blob
    };
    const database = await openDatabase();
    try {
      const transaction = database.transaction(EXPORT_STORE, "readwrite");
      transaction.objectStore(EXPORT_STORE).put(record);
      await transactionComplete(transaction);
      return descriptor(record);
    } catch (error) {
      if (error?.name === "QuotaExceededError") {
        throw new Error("Not enough local browser storage is available for this HAR export");
      }
      throw error;
    } finally {
      database.close();
    }
  }

  async function get(id) {
    if (!id) {
      return null;
    }
    const database = await openDatabase();
    try {
      const transaction = database.transaction(EXPORT_STORE, "readonly");
      const completed = transactionComplete(transaction);
      const request = transaction.objectStore(EXPORT_STORE).get(id);
      const [record] = await Promise.all([
        requestResult(request, "Unable to read the saved HAR export"),
        completed
      ]);
      return record || null;
    } finally {
      database.close();
    }
  }

  async function latest() {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(EXPORT_STORE, "readonly");
      const completed = transactionComplete(transaction);
      const request = transaction
        .objectStore(EXPORT_STORE)
        .index(CREATED_AT_INDEX)
        .openCursor(null, "prev");
      const [latestDescriptor] = await Promise.all([
        requestResult(request, "Unable to find a pending HAR export")
          .then(cursor => descriptor(cursor?.value)),
        completed
      ]);
      return latestDescriptor;
    } finally {
      database.close();
    }
  }

  async function remove(id) {
    if (!id) {
      return;
    }
    const database = await openDatabase();
    try {
      const transaction = database.transaction(EXPORT_STORE, "readwrite");
      transaction.objectStore(EXPORT_STORE).delete(id);
      await transactionComplete(transaction);
    } finally {
      database.close();
    }
  }

  async function cleanupStale(now = Date.now()) {
    const cutoff = now - STALE_EXPORT_AGE_MS;
    const database = await openDatabase();
    try {
      const transaction = database.transaction(EXPORT_STORE, "readwrite");
      const store = transaction.objectStore(EXPORT_STORE);
      const request = store
        .index(CREATED_AT_INDEX)
        .openKeyCursor(IDBKeyRange.upperBound(cutoff));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          return;
        }
        store.delete(cursor.primaryKey);
        cursor.continue();
      };
      await transactionComplete(transaction);
    } finally {
      database.close();
    }
  }

  globalThis.HarExportStore = Object.freeze({
    cleanupStale,
    get,
    latest,
    remove,
    save
  });
})();
