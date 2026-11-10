/* Copyright 2024-2026 Breaking IT. Licensed under the BreakTest Community Source License 1.0. */
globalThis.SseCapture = (() => {
  function init(state, source) {
    if (state.sse) return;
    state.serverSentEvents = [];
    state.sseChars = 0;
    state.sse = {formatVersion: 1, source, captureEnd: 'recording-stopped', messagesTruncated: false, droppedMessages: 0};
  }
  function append(owner, state, message) {
    if (state.discarded || !MessageCapture.tag(owner, message)) return;
    state.sseChars += message.data.length;
    state.serverSentEvents.push(message);
  }
  // Streaming UTF-8 SSE parser. A timestamp denotes receipt of the chunk that
  // completes the event, not the start of an unfinished data line.
  function parser(owner, state, lastEventId = '') {
    const decoder = new TextDecoder('utf-8');
    let line = '', skipLF = false, eventName = '', data = '', hasData = false;
    function consume(time) {
      if (!line) {
        if (hasData) append(owner, state, {type: 'receive', time, eventName: eventName || 'message', eventId: lastEventId, data: data.slice(0, -1)});
        eventName = ''; data = ''; hasData = false;
        return;
      }
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'data') {
        hasData = true;
        data += value + '\n';
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
        } else line += character;
      }
    }
    function finish() {
      // SSE does not dispatch an unterminated event at EOF/recording stop.
      if (line || hasData) state.sse.partialEventAtEnd = true;
    }
    return {feed, finish};
  }
  return {init, append, parser};
})();
