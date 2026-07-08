export const clients = new Set();
export const eventBacklog = [];
export let eventSeq = 0;

export function bumpEventSeq() {
  return ++eventSeq;
}

export function stampEvent(event = {}, record = false) {
  const stamped = {
    ...event,
    seq: Number(event.seq) || (++eventSeq)
  };
  if (record) {
    eventBacklog.push(stamped);
    if (eventBacklog.length > 500) eventBacklog.splice(0, eventBacklog.length - 500);
  }
  return stamped;
}

export function sendEvent(res, event) {
  if (res.destroyed || res.writableEnded) {
    clients.delete(res);
    return;
  }
  try {
    res.write(`data: ${JSON.stringify(stampEvent(event, false))}\n\n`);
  } catch (error) {
    clients.delete(res);
    console.error("sse write failed", error);
  }
}

export function broadcast(event) {
  const stamped = stampEvent(event, true);
  for (const client of clients) sendEvent(client, stamped);
}

export function changesSince(afterSeq = 0) {
  const seq = Number(afterSeq) || 0;
  const oldestSeq = eventBacklog[0]?.seq || eventSeq + 1;
  if (seq > 0 && seq < oldestSeq - 1) {
    return { reset: true, eventSeq, events: [] };
  }
  return {
    reset: false,
    eventSeq,
    events: eventBacklog.filter((event) => event.seq > seq)
  };
}
