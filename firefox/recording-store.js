/* Copyright 2024-2026 Breaking IT. Licensed under the BreakTest Community Source License 1.0. */

// Session storage identifies this browser session (tab IDs can be reused after
// browser restart). Only small markers and private encryption keys live there;
// recording payloads must never consume the fixed storage.session quota.
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
    // Accept checkpoints from older versions until the next successful save.
    if (marker.private && marker.snapshot) return marker.snapshot;
    const saved = await disk("get");
    if (!saved || saved.id !== marker.id) throw new Error("Recording checkpoint is unavailable");
    if (marker.private) {
      if (saved.format !== "aes-gcm-v1") throw new Error("Invalid private recording checkpoint");
      const key = await privateKey(marker.key);
      const plain = await crypto.subtle.decrypt({name: "AES-GCM", iv: saved.iv}, key, saved.ciphertext);
      return JSON.parse(new TextDecoder().decode(plain));
    }
    return saved;
  }
  function privateKey(bytes) {
    return crypto.subtle.importKey("raw", new Uint8Array(bytes), "AES-GCM", false, ["encrypt", "decrypt"]);
  }
  async function save(snapshot) {
    const marker = (await browser.storage.session.get(KEY))[KEY];
    if (snapshot.incognito) {
      const reuse = marker?.private && marker.id === snapshot.id && marker.key;
      const bytes = reuse ? marker.key : Array.from(crypto.getRandomValues(new Uint8Array(32)));
      const key = await privateKey(bytes);
      // Fresh IV for every checkpoint, even when the recording key is reused.
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt({name: "AES-GCM", iv}, key,
        new TextEncoder().encode(JSON.stringify(snapshot)));
      await disk("put", {id: snapshot.id, format: "aes-gcm-v1", iv, ciphertext});
      if (!reuse) await browser.storage.session.set({[KEY]: {id: snapshot.id, private: true, key: bytes}});
    } else {
      await disk("put", snapshot);
      if (marker?.id !== snapshot.id || marker.private) {
        await browser.storage.session.set({[KEY]: {id: snapshot.id}});
      }
    }
  }
  async function remove() {
    await browser.storage.session.remove(KEY);
    await disk("clear");
  }
  return {load, save, remove};
})();
