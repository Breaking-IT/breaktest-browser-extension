/* Copyright 2024-2026 Breaking IT. Licensed under the BreakTest Community Source License 1.0. */

// Native webRequest handshakes and isolated content-script message capture are
// correlated in creation order within each frame and URL. No page message bridge.
globalThis.WebSocketStore = (() => {
  const MAX_CHARS = 16 * 1024 * 1024;
  const MAX_MESSAGE_CHARS = 2 * 1024 * 1024;
  const MAX_MESSAGES = 10000;
  function capture(owner) {
    return owner.webSocketCapture ||= {
      token: crypto.randomUUID(), sockets: new Map(), handshakes: [], installationError: null
    };
  }
  function handshake(owner, state, details) {
    state.webSocketDone = new Promise(resolve => { state.webSocketResolve = resolve; });
    state.frameId = details.frameId;
    state.documentId = details.documentId;
    state.webSocketMessages = [];
    state.webSocket = {
      formatVersion: 1, source: "page-websocket-api", messagesAvailable: false,
      closed: false, closeInitiator: "unknown", captureEnd: "recording-stopped", messagesTruncated: false, droppedMessages: 0
    };
    const store = capture(owner);
    store.handshakes.push(state);
    match(store);
  }
  function match(store) {
    for (const socket of store.sockets.values()) {
      if (socket.state) continue;
      const state = store.handshakes.find(item => !item.webSocketBound && !item.discarded
        && item.frameId === socket.frameId && item.request.url === socket.url
        && (!item.documentId || !socket.documentId || item.documentId === socket.documentId)
        && Math.abs(item.startedAt - socket.startedAt) <= 1000);
      if (!state) continue;
      state.webSocketBound = true;
      socket.state = state;
      state.webSocketMessages.push(...socket.messages);
      Object.assign(state.webSocket, socket.metadata, {messagesAvailable: true});
      socket.messages = state.webSocketMessages;
      socket.metadata = state.webSocket;
    }
  }
  function handle(owner, message, sender) {
    if (!owner || sender.tab?.id !== owner.tabId) return {ok: false};
    const store = capture(owner);
    if (message.type === "websocket-begin") {
      if (owner.stopping || !Number.isFinite(message.time) || message.time < owner.startedAt
          || typeof message.id !== "string" || message.id.length > 128
          || typeof message.url !== "string" || !/^wss?:\/\//i.test(message.url)) return {ok: false};
      const key = `${sender.documentId || sender.frameId}:${message.id}`;
      if (store.sockets.has(key)) return {ok: false};
      store.sockets.set(key, {
        frameId: sender.frameId, documentId: sender.documentId, url: message.url, startedAt: message.time,
        messages: [], chars: 0, metadata: {
          closed: false, closeInitiator: "unknown", captureEnd: "recording-stopped", messagesTruncated: false, droppedMessages: 0
        }
      });
      match(store);
      return {ok: true, token: store.token, key};
    }
    if (message.token !== store.token) return {ok: false};
    const socket = store.sockets.get(message.key);
    if (!socket || socket.frameId !== sender.frameId || socket.documentId !== sender.documentId
        || socket.state?.discarded) return {ok: false};
    if (message.type === "websocket-message") {
      const item = message.message;
      if (!item || !["send", "receive"].includes(item.type) || ![1, 2].includes(item.opcode)
          || !Number.isFinite(item.time) || typeof item.data !== "string"
          || item.data.length > MAX_MESSAGE_CHARS) return {ok: false};
      if (socket.messages.length >= MAX_MESSAGES || socket.chars + item.data.length > MAX_CHARS) {
        socket.metadata.messagesTruncated = true;
        socket.metadata.droppedMessages++;
        return {ok: true};
      }
      if (item.opcode === 2 && (item.data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(item.data))) return {ok: false};
      const frame = {type: item.type, time: item.time, opcode: item.opcode, data: item.data};
      if (!globalThis.MessageCapture.tag(owner, frame)) return {ok: true};
      if (item.opcode === 2) frame._encoding = "base64";
      if (item._truncated === true) {
        frame._truncated = true;
        frame._originalLength = item._originalLength;
        socket.metadata.messagesTruncated = true;
      }
      socket.chars += item.data.length;
      socket.messages.push(frame);
    } else if (message.type === "websocket-close-requested") {
      if (socket.metadata.closed) return {ok: true};
      delete socket.metadata.closeInitiatorInferred;
      socket.metadata.closeInitiator = "client";
      socket.metadata.closeInitiatorSource = "page-close-call";
      if (Number.isFinite(message.time)) socket.metadata.closeInitiatedTime = message.time;
    } else if (message.type === "websocket-end") {
      socket.metadata.closed = message.closed === true;
      if (message.closed) {
        socket.metadata.wasClean = message.wasClean === true;
        if (socket.metadata.closeInitiator !== "client" && message.wasClean === true && !socket.metadata.error) {
          socket.metadata.closeInitiator = "server";
          socket.metadata.closeInitiatorSource = "clean-close-without-client-request";
          socket.metadata.closeInitiatorInferred = true;
        }
      }
      socket.metadata.captureEnd = message.closed ? "socket-closed" : "document-unloaded";
      if (Number.isFinite(message.time)) {
        if (message.closed) socket.metadata.closedTime = message.time;
        else socket.metadata.captureEndTime = message.time;
      }
      if (Number.isInteger(message.code)) socket.metadata.closeCode = message.code;
      if (typeof message.reason === "string") socket.metadata.closeReason = message.reason.slice(0, 4096);
    } else if (message.type === "websocket-error") {
      socket.metadata.error = "WebSocket error reported by the page API";
    } else if (message.type === "websocket-dropped") {
      socket.metadata.messagesTruncated = true;
      if (Number.isSafeInteger(message.count) && message.count > 0) socket.metadata.droppedMessages += message.count;
    } else if (message.type === "websocket-unavailable") {
      socket.metadata.captureIncomplete = true;
      socket.metadata.captureError = String(message.reason || "Payload unavailable").slice(0, 512);
    } else return {ok: false};
    return {ok: true};
  }
  async function install(api, owner) {
    const store = capture(owner);
    try {
      const results = await api.scripting.executeScript({target: {tabId: owner.tabId, allFrames: true}, files: ["websocket-capture.js"]});
      const failed = results.find(result => result.error);
      if (failed) throw new Error(failed.error.message || String(failed.error));
    } catch (error) {
      store.installationError = String(error.message || error);
    }
  }
  async function settle(api, owner) {
    const store = capture(owner);
    let timer;
    try {
      await Promise.race([
        (async () => {
          const results = await api.scripting.executeScript({
            target: {tabId: owner.tabId, allFrames: true},
            func: () => globalThis.breaktestWebSocketCapture?.flush()
          });
          const failed = results.find(result => result.error);
          if (failed) throw new Error(failed.error.message || String(failed.error));
          // Firefox delivers webRequest callbacks separately from page messages.
          // Drain handshakes already in flight rather than exporting status 0.
          await Promise.all(store.handshakes.filter(state => !state.finalized).map(state => state.webSocketDone));
        })(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("WebSocket flush timed out")), 5000); })
      ]);
    } catch (error) {
      store.flushError = String(error.message || error);
      for (const socket of store.sockets.values()) socket.metadata.captureIncomplete = true;
    } finally { clearTimeout(timer); }
  }
  function removeTransaction(owner, id, target) {
    for (const state of owner.webSocketCapture?.handshakes || []) {
      if (state.transaction.id === id) {
        if (target) state.transaction = target;
        else state.discarded = true;
      }
    }
  }
  function exportMetadata(owner) {
    const store = owner.webSocketCapture;
    return {
      formatVersion: 1, source: "page-websocket-api", scope: "documents-and-frames",
      workerMessagesAvailable: false, controlFramesAvailable: false,
      ...(store?.installationError ? {installationError: store.installationError} : {}),
      ...(store?.flushError ? {flushError: store.flushError} : {})
    };
  }
  return {handshake, handle, install, settle, removeTransaction, exportMetadata};
})();
