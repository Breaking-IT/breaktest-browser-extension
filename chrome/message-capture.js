/* Copyright 2024-2026 Breaking IT. Licensed under the BreakTest Community Source License 1.0. */
globalThis.MessageCapture = (() => {
  function startTransaction(owner, transaction) {
    const timeline = owner.messageTransactionTimeline ||= [];
    timeline.push({time: Date.parse(transaction.startedDateTime) / 1000, id: transaction.id});
  }
  function transactionAt(owner, time) {
    const timeline = owner.messageTransactionTimeline || owner.transactions?.map(transaction => ({
      time: Date.parse(transaction.startedDateTime) / 1000, id: transaction.id
    }));
    if (!timeline?.some(item => Number.isFinite(item.time))) return owner.currentTransaction?.id || null;
    for (let index = timeline.length - 1; index >= 0; index--) {
      if (time >= timeline[index].time) return timeline[index].id;
    }
    return null;
  }
  function tag(owner, message) {
    const id = transactionAt(owner, message.time);
    if (!id) return false;
    message._breaktest = {transactionId: id};
    return true;
  }
  function removeTransaction(owner, id, targetId) {
    owner.messageTransactionTimeline ||= (owner.transactions || []).map(transaction => ({
      time: Date.parse(transaction.startedDateTime) / 1000, id: transaction.id
    }));
    for (const item of owner.messageTransactionTimeline) if (item.id === id) item.id = targetId || null;
    const arrays = new Set();
    const collect = item => {
      for (const key of ['_webSocketMessages', 'webSocketMessages', '_serverSentEvents', 'serverSentEvents', 'messages']) {
        if (Array.isArray(item[key])) arrays.add(item[key]);
      }
    };
    for (const item of owner.entries || []) collect(item);
    for (const item of owner.activeRequests?.values() || []) collect(item);
    for (const item of owner.pendingStates || []) collect(item);
    for (const item of owner.webSocketCapture?.sockets.values() || []) collect(item);
    for (const messages of arrays) {
      for (let index = messages.length - 1; index >= 0; index--) {
        if (messages[index]._breaktest?.transactionId !== id) continue;
        if (targetId) messages[index]._breaktest.transactionId = targetId;
        else messages.splice(index, 1);
      }
    }
  }
  return {startTransaction, transactionAt, tag, removeTransaction};
})();
