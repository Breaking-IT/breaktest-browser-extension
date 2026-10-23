/* Copyright 2024-2026 Breaking IT. Licensed under the BreakTest Community Source License 1.0. */

// Session storage identifies this browser session (tab IDs can be reused after
// browser restart). Private recordings never put their contents on disk.
globalThis.RecordingStore = (() => {
  const KEY = "firefoxRecordingCheckpoint";
  async function database() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open("breaktest-active-recording", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("checkpoint");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("Recording recovery storage is blocked"));
    });
  }
  async function disk(operation, value) {
    const db = await database();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction("checkpoint", operation === "get" ? "readonly" : "readwrite");
        const store = tx.objectStore("checkpoint");
        const request = operation === "get" ? store.get("active")
          : operation === "put" ? store.put(value, "active") : store.clear();
        tx.oncomplete = () => resolve(request.result);
        tx.onabort = tx.onerror = () => reject(tx.error || new Error("Recording checkpoint failed"));
      });
    } finally { db.close(); }
  }
  async function load() {
    const marker = (await browser.storage.session.get(KEY))[KEY];
    if (!marker) { await disk("clear"); return null; }
    if (marker.private) return marker.snapshot;
    const saved = await disk("get");
    if (!saved || saved.id !== marker.id) throw new Error("Recording checkpoint is unavailable");
    return saved;
  }
  async function save(snapshot) {
    if (snapshot.incognito) {
      await browser.storage.session.set({[KEY]: {private: true, snapshot}});
    } else {
      await disk("put", snapshot);
      await browser.storage.session.set({[KEY]: {id: snapshot.id}});
    }
  }
  async function remove() {
    await browser.storage.session.remove(KEY);
    await disk("clear");
  }
  return {load, save, remove};
})();
