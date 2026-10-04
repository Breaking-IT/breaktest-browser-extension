/* Copyright 2024-2026 Breaking IT. Licensed under the BreakTest Community Source License 1.0. */

// Serialized into the target's main world through CDP. Only lifecycle metadata
// uses this hook; handshakes and message payloads still come from Network events.
function installWebSocketLifecycle(bindingName, stop = false) {
  const marker = '__breaktestWebSocketLifecycle';
  const previous = globalThis[marker];
  if (stop) {
    if (previous?.bindingName === bindingName) previous.stop();
    return;
  }
  if (previous?.bindingName === bindingName || typeof WebSocket !== 'function') return;
  previous?.stop?.();
  const Original = WebSocket;
  const originalClose = Original.prototype.close;
  const addListener = EventTarget.prototype.addEventListener;
  const binding = globalThis[bindingName];
  if (typeof binding !== 'function') return;
  const sockets = new WeakMap();
  let active = true;
  let sequence = 0;
  const emit = (record, event, extra = {}) => {
    if (!active) return;
    try {
      binding(JSON.stringify({id: record.id, event, time: (performance.timeOrigin + performance.now()) / 1000, ...extra}));
    } catch { /* Debugger disconnects must not affect the application's socket. */ }
  };
  const close = new Proxy(originalClose, {apply(target, receiver, args) {
    const before = receiver.readyState;
    const result = Reflect.apply(target, receiver, args);
    const record = sockets.get(receiver);
    if (record && before < 2 && !record.requested) {
      record.requested = true;
      emit(record, 'close-requested');
    }
    return result;
  }});
  const Wrapped = new Proxy(Original, {construct(target, args, newTarget) {
    const socket = Reflect.construct(target, args, newTarget);
    const record = {id: ++sequence};
    sockets.set(socket, record);
    emit(record, 'created', {url: socket.url});
    Reflect.apply(addListener, socket, ['error', event => { if (event.isTrusted) emit(record, 'error'); }]);
    Reflect.apply(addListener, socket, ['close', event => {
      if (!event.isTrusted) return;
      emit(record, 'closed', {code: event.code, reason: event.reason, wasClean: event.wasClean});
    }]);
    return socket;
  }});
  Original.prototype.close = close;
  globalThis.WebSocket = Wrapped;
  globalThis[marker] = {bindingName, stop() {
    active = false;
    if (Original.prototype.close === close) Original.prototype.close = originalClose;
    if (globalThis.WebSocket === Wrapped) globalThis.WebSocket = Original;
    if (globalThis[marker]?.bindingName === bindingName) delete globalThis[marker];
  }};
}

function webSocketLifecycleState(owner) {
  return owner.webSocketLifecycle ||= {
    binding: `__breaktest_ws_${crypto.randomUUID().replaceAll('-', '')}`,
    targets: new Map(), sockets: new Map(), states: []
  };
}

async function enableWebSocketLifecycle(owner, target) {
  const capture = webSocketLifecycleState(owner);
  const key = target.sessionId || 'root';
  const info = {target, contexts: new Set()};
  capture.targets.set(key, info);
  await chrome.debugger.sendCommand(target, 'Runtime.addBinding', {name: capture.binding});
  const expression = `(${installWebSocketLifecycle.toString()})(${JSON.stringify(capture.binding)})`;
  try {
    const result = await chrome.debugger.sendCommand(target, 'Page.addScriptToEvaluateOnNewDocument', {source: expression});
    info.scriptId = result.identifier;
  } catch { /* Worker targets have no Page domain; Runtime handles their context. */ }
  await chrome.debugger.sendCommand(target, 'Runtime.enable');
  await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {expression});
}

async function webSocketExecutionContext(owner, source, context) {
  if (context.auxData?.isDefault === false) return;
  const capture = webSocketLifecycleState(owner);
  const info = capture.targets.get(source.sessionId || 'root');
  if (!info) return;
  info.contexts.add(context.id);
  await chrome.debugger.sendCommand(source, 'Runtime.evaluate', {
    contextId: context.id,
    expression: `(${installWebSocketLifecycle.toString()})(${JSON.stringify(capture.binding)})`
  });
}

function registerWebSocketLifecycle(owner, state) {
  const capture = webSocketLifecycleState(owner);
  state.webSocketCreatedTime = Date.now() / 1000;
  capture.states.push(state);
  matchWebSocketLifecycle(capture);
}

function matchWebSocketLifecycle(capture) {
  for (const socket of capture.sockets.values()) {
    if (socket.state) continue;
    const state = capture.states.find(candidate => !candidate.discarded && !candidate.webSocketLifecycleBound
      && (candidate.source.sessionId || 'root') === socket.session
      && candidate.request.url === socket.url
      && Math.abs((candidate.webSocketWallTime || candidate.webSocketCreatedTime) - socket.time) <= 1);
    if (!state) continue;
    socket.state = state;
    state.webSocketLifecycleBound = true;
    applyWebSocketLifecycle(socket);
  }
}

function applyWebSocketLifecycle(socket) {
  const state = socket.state;
  if (!state || state.discarded) return;
  const metadata = state.webSocket;
  // Native close-frame evidence takes precedence over page API observations.
  if (metadata.closeInitiatorSource !== 'first-close-frame') {
    if (socket.requestedTime !== undefined) {
      delete metadata.closeInitiatorInferred;
      metadata.closeInitiator = 'client';
      metadata.closeInitiatorSource = 'page-close-call';
      metadata.closeInitiatedTime = socket.requestedTime;
    } else if (socket.closed?.wasClean && !socket.error && !metadata.error) {
      metadata.closeInitiator = 'server';
      metadata.closeInitiatorSource = 'clean-close-without-client-request';
      metadata.closeInitiatorInferred = true;
    }
  }
  if (socket.closed) {
    metadata.closeCode = socket.closed.code;
    metadata.closeReason = socket.closed.reason;
    metadata.wasClean = socket.closed.wasClean;
  }
}

function webSocketLifecycleEvent(owner, source, params) {
  const capture = owner.webSocketLifecycle;
  if (!capture || params.name !== capture.binding || typeof params.payload !== 'string' || params.payload.length > 65536) return;
  let event;
  try { event = JSON.parse(params.payload); } catch { return; }
  if (!event || !Number.isSafeInteger(event.id) || !Number.isFinite(event.time)) return;
  const session = source.sessionId || 'root';
  const key = `${session}:${params.executionContextId}:${event.id}`;
  if (event.event === 'created') {
    if (owner.stopping || typeof event.url !== 'string' || !/^wss?:\/\//i.test(event.url) || capture.sockets.has(key)) return;
    capture.sockets.set(key, {session, url: event.url, time: event.time});
    matchWebSocketLifecycle(capture);
    return;
  }
  const socket = capture.sockets.get(key);
  if (!socket || socket.state?.discarded) return;
  if (event.event === 'close-requested' && !socket.closed) socket.requestedTime ??= event.time;
  else if (event.event === 'error') socket.error = true;
  else if (event.event === 'closed') socket.closed = {
    code: Number.isInteger(event.code) ? event.code : 1006,
    reason: typeof event.reason === 'string' ? event.reason.slice(0, 4096) : '',
    wasClean: event.wasClean === true
  };
  applyWebSocketLifecycle(socket);
}

async function disableWebSocketLifecycle(owner) {
  const capture = owner.webSocketLifecycle;
  if (!capture) return;
  await Promise.all([...capture.targets.values()].map(async info => {
    const expression = `(${installWebSocketLifecycle.toString()})(${JSON.stringify(capture.binding)}, true)`;
    for (const contextId of info.contexts) {
      await chrome.debugger.sendCommand(info.target, 'Runtime.evaluate', {expression, contextId}).catch(() => {});
    }
    await chrome.debugger.sendCommand(info.target, 'Runtime.evaluate', {expression}).catch(() => {});
    if (info.scriptId) await chrome.debugger.sendCommand(info.target, 'Page.removeScriptToEvaluateOnNewDocument', {identifier: info.scriptId}).catch(() => {});
    await chrome.debugger.sendCommand(info.target, 'Runtime.removeBinding', {name: capture.binding}).catch(() => {});
  }));
}
