/* Copyright 2024-2026 Breaking IT. Licensed under the BreakTest Community Source License 1.0. */
globalThis.SseCapture = (() => {
  const MAX_MESSAGE_CHARS = 2 * 1024 * 1024;
  const MAX_TOTAL_CHARS = 16 * 1024 * 1024;
  const MAX_MESSAGES = 10000;
  function init(state, source) {
    if (state.sse) return;
    state.serverSentEvents = [];
    state.sseChars = 0;
    state.sse = {formatVersion: 1, source, captureEnd: 'recording-stopped', messagesTruncated: false, droppedMessages: 0};
  }
  function append(owner, state, message) {
    if (state.discarded || !MessageCapture.tag(owner, message)) return;
    if (state.serverSentEvents.length >= MAX_MESSAGES || state.sseChars >= MAX_TOTAL_CHARS) {
      state.sse.messagesTruncated = true;
      state.sse.droppedMessages++;
      return;
    }
    for (const field of ['eventName', 'eventId']) {
      if (message[field].length > 4096) {
        message[field] = message[field].slice(0, 4096);
        message._metadataTruncated = true;
        state.sse.messagesTruncated = true;
      }
    }
    const originalLength = message.data.length;
    const available = Math.min(MAX_MESSAGE_CHARS, MAX_TOTAL_CHARS - state.sseChars);
    message.data = message.data.slice(0, available);
    if (message.data.length < originalLength && /[\uD800-\uDBFF]$/.test(message.data)) message.data = message.data.slice(0, -1);
    if (message.data.length < originalLength) {
      message._truncated = true;
      message._originalLength = originalLength;
      state.sse.messagesTruncated = true;
    }
    state.sseChars += message.data.length;
    state.serverSentEvents.push(message);
  }
  // Streaming UTF-8 SSE parser. A timestamp denotes receipt of the chunk that
  // completes the event, not the start of an unfinished data line.
  function parser(owner, state, lastEventId = '') {
    const decoder = new TextDecoder('utf-8');
    let line = '', skipLF = false, eventName = '', data = '', hasData = false;
    let oversized = false, lineOversized = false;
    function consume(time) {
      if (lineOversized) { oversized = true; lineOversized = false; line = ''; return; }
      if (!line) {
        if (oversized) { state.sse.messagesTruncated = true; state.sse.droppedMessages++; }
        else if (hasData) append(owner, state, {type: 'receive', time, eventName: eventName || 'message', eventId: lastEventId, data: data.slice(0, -1)});
        eventName = ''; data = ''; hasData = false; oversized = false;
        return;
      }
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'data') {
        hasData = true;
        if (data.length + value.length + 1 > MAX_MESSAGE_CHARS) oversized = true;
        else if (!oversized) data += value + '\n';
      } else if (field === 'event') eventName = value;
      else if (field === 'id' && !value.includes('\0')) lastEventId = value;
      line = '';
    }
    function feed(bytes, time) {
      const text = decoder.decode(bytes, {stream: true});
      for (const character of text) {
        if (skipLF) { skipLF = false; if (character === '\n') continue; }
        if (character === '\r' || character === '\n') {
          consume(time);
          skipLF = character === '\r';
        } else if (line.length < MAX_MESSAGE_CHARS) line += character;
        else { lineOversized = true; state.sse.captureIncomplete = true; }
      }
    }
    function finish() {
      // SSE does not dispatch an unterminated event at EOF/recording stop.
      if (line || hasData || oversized || lineOversized) state.sse.partialEventAtEnd = true;
    }
    return {feed, finish};
  }
  return {init, append, parser};
})();
