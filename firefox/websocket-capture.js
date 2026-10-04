/* Copyright 2024-2026 Breaking IT. Licensed under the BreakTest Community Source License 1.0. */

// Firefox-only: exported Proxy traps keep socket behavior in the page realm,
// while payloads travel directly from the isolated script to the background.
(() => {
  if (globalThis.breaktestWebSocketCapture) return;
  const page = window.wrappedJSObject;
  const sockets = new WeakMap();
  const active = new Set();
  const NativeWebSocket = page.WebSocket;
  const nativeSend = NativeWebSocket.prototype.send;
  const nativeClose = NativeWebSocket.prototype.close;
  const nativeConstruct = page.Reflect.construct;
  const nativeApply = page.Reflect.apply;
  const nativeString = page.String;
  const MAX_CHARS = 16 * 1024 * 1024;
  const MAX_MESSAGE_CHARS = 2 * 1024 * 1024;
  const MAX_MESSAGES = 10000;
  const now = () => (performance.timeOrigin + performance.now()) / 1000;

  function enqueue(record, type, fields) {
    record.chain = record.chain.then(async () => {
      const auth = await record.auth;
      if (!auth?.ok) return;
      const result = await browser.runtime.sendMessage({type, token: auth.token, key: auth.key, ...fields});
      if (!result?.ok) record.ended = true;
    }).catch(() => { record.ended = true; });
  }
  function payload(record, type, value) {
    if (record.ended) return;
    if (record.count >= MAX_MESSAGES || record.chars >= MAX_CHARS) {
      record.dropped++;
      return;
    }
    const time = now();
    const binary = typeof value !== "string";
    if (binary) value = XPCNativeWrapper(value);
    const available = Math.min(MAX_MESSAGE_CHARS, MAX_CHARS - record.chars);
    let originalLength;
    let data;
    if (!binary) {
      originalLength = value.length;
      data = value.slice(0, available);
      if (data.length < value.length && /[\uD800-\uDBFF]$/.test(data)) data = data.slice(0, -1);
    } else {
      const blob = value instanceof window.Blob;
      const bytes = blob ? null : ArrayBuffer.isView(value)
        ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
        : new Uint8Array(value);
      const size = blob ? value.size : bytes.byteLength;
      originalLength = Math.ceil(size / 3) * 4;
      const byteLimit = Math.floor(available / 4) * 3;
      // Snapshot mutable buffers synchronously, before the caller can reuse them.
      if (blob) data = value.slice(0, byteLimit);
      else {
        data = new Uint8Array(Math.min(size, byteLimit));
        for (let index = 0; index < data.length; index++) data[index] = bytes[index];
      }
    }
    const capturedLength = binary ? Math.min(originalLength, Math.floor(available / 4) * 4) : data.length;
    record.chars += capturedLength;
    record.count++;
    record.chain = record.chain.then(async () => {
      const auth = await record.auth;
      if (!auth?.ok) return;
      let text = data;
      if (binary) {
        const bytes = data instanceof window.Blob ? new Uint8Array(await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(reader.error);
          reader.readAsArrayBuffer(data);
        })) : data;
        let raw = "";
        for (let index = 0; index < bytes.length; index += 8192) {
          const chunk = [];
          for (let offset = index; offset < Math.min(index + 8192, bytes.length); offset++) chunk.push(bytes[offset]);
          raw += String.fromCharCode(...chunk);
        }
        text = btoa(raw);
      }
      const result = await browser.runtime.sendMessage({
        type: "websocket-message", token: auth.token, key: auth.key,
        message: {type, time, opcode: binary ? 2 : 1, data: text,
          ...(capturedLength < originalLength ? {_truncated: true, _originalLength: originalLength} : {})}
      });
      if (!result?.ok) record.ended = true;
    }).catch(async error => {
      const auth = await record.auth;
      if (auth?.ok) await browser.runtime.sendMessage({type: "websocket-unavailable", token: auth.token, key: auth.key, reason: String(error)}).catch(() => {});
    });
  }
  function observe(socket) {
    socket = XPCNativeWrapper(socket);
    const record = {
      auth: browser.runtime.sendMessage({type: "websocket-begin", id: crypto.randomUUID(), url: socket.url, time: Date.now()}).catch(() => ({ok: false})),
      chain: Promise.resolve(), count: 0, chars: 0, dropped: 0, ended: false
    };
    sockets.set(socket, record);
    active.add(record);
    record.auth.then(auth => { if (!auth?.ok) { record.ended = true; active.delete(record); } });
    socket.addEventListener("message", event => { try { payload(record, "receive", event.data); } catch (error) { enqueue(record, "websocket-unavailable", {reason: String(error)}); } });
    socket.addEventListener("error", event => { if (event.isTrusted && !record.ended) enqueue(record, "websocket-error", {}); });
    socket.addEventListener("close", event => {
      if (!event.isTrusted || record.ended) return;
      record.ended = true;
      record.closed = true;
      enqueue(record, "websocket-end", {closed: true, time: now(), code: event.code, reason: event.reason, wasClean: event.wasClean});
      // Keep the chain available to flush until all queued payloads are stored.
      record.chain.finally(() => { if (!record.dropped) active.delete(record); });
    });
  }
  const sendHandler = cloneInto({apply(target, receiver, args) {
    // Convert string-like input exactly once, preserving native send exceptions.
    let value = args[0];
    if (args.length && typeof value !== "string" && !(value instanceof window.Blob)
        && !(value instanceof window.ArrayBuffer) && !ArrayBuffer.isView(value)
        && typeof value !== "symbol") value = nativeString(value);
    const sendArgs = new page.Array();
    if (args.length) sendArgs.push(value);
    const result = nativeApply(target, receiver, sendArgs);
    const record = sockets.get(XPCNativeWrapper(receiver));
    if (record && receiver.readyState === NativeWebSocket.OPEN) {
      try { payload(record, "send", value); } catch (error) { enqueue(record, "websocket-unavailable", {reason: String(error)}); }
    }
    return result;
  }}, window, {cloneFunctions: true});
  NativeWebSocket.prototype.send = new page.Proxy(nativeSend, sendHandler);
  NativeWebSocket.prototype.close = new page.Proxy(nativeClose, cloneInto({apply(target, receiver, args) {
    const socket = XPCNativeWrapper(receiver);
    const before = socket.readyState;
    const result = nativeApply(target, receiver, args);
    const record = sockets.get(socket);
    // Invalid arguments throw above. A close() call while already closing is
    // only a response/no-op, not evidence that the client initiated the close.
    if (record && !record.ended && !record.closeRequested && before < 2) {
      record.closeRequested = true;
      enqueue(record, "websocket-close-requested", {time: now()});
    }
    return result;
  }}, window, {cloneFunctions: true}));
  page.WebSocket = new page.Proxy(NativeWebSocket, cloneInto({construct(target, args, newTarget) {
    const socket = nativeConstruct(target, args, newTarget);
    try { observe(socket); } catch { /* Recording must never break the connection. */ }
    return socket;
  }}, window, {cloneFunctions: true}));

  async function flush(unloaded = false) {
    const records = [...active];
    for (const record of records) {
      record.ended = true;
      if (record.dropped) { enqueue(record, "websocket-dropped", {count: record.dropped}); record.dropped = 0; }
      if (unloaded && !record.closed) enqueue(record, "websocket-end", {closed: false, time: now()});
    }
    await Promise.all(records.map(record => record.chain));
    for (const record of records) active.delete(record);
  }
  globalThis.breaktestWebSocketCapture = {flush};
  window.addEventListener("pagehide", () => { void flush(true); });
})();
