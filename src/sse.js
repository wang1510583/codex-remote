export const clients = new Set();
export const eventBacklog = [];
export let eventSeq = 0;

export function currentEventSeq() {
  return eventSeq;
}

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

function writeEvent(res, event) {
  if (res.destroyed || res.writableEnded) {
    clients.delete(res);
    return;
  }
  try {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  } catch (error) {
    clients.delete(res);
    console.error("sse write failed", error);
  }
}

export function sendEvent(res, event) {
  writeEvent(res, stampEvent(event, false));
}

// Connection status is a point-in-time snapshot, not a replayable event. It
// must not consume a sequence number or a client can skip a real event that
// was broadcast while the initial HTTP state request was still in flight.
export function sendSnapshot(res, event) {
  const { seq: _ignored, ...snapshot } = event || {};
  writeEvent(res, snapshot);
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
