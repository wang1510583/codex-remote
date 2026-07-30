import { createHash, randomBytes } from "node:crypto";

export class LiveVoiceTicketStore {
  constructor({
    ttlMs = 60_000,
    maxTickets = 1_024,
    maxTicketsPerSession = 8,
    now = () => Date.now(),
    random = (size) => randomBytes(size)
  } = {}) {
    this.ttlMs = ttlMs;
    this.maxTickets = maxTickets;
    this.maxTicketsPerSession = maxTicketsPerSession;
    this.now = now;
    this.random = random;
    this.records = new Map();
  }

  digest(ticket) {
    return createHash("sha256").update(ticket).digest("hex");
  }

  prune() {
    const now = this.now();
    for (const [digest, record] of this.records) {
      if (record.expiresAt <= now) this.records.delete(digest);
    }
  }

  issue(sessionId) {
    this.prune();
    if (this.records.size >= this.maxTickets) {
      throw Object.assign(
        new Error("Live Voice 临时票据已达到容量上限，请稍后重试。"),
        { statusCode: 429 }
      );
    }
    let sessionCount = 0;
    for (const record of this.records.values()) {
      if (record.sessionId === sessionId) sessionCount += 1;
    }
    if (sessionCount >= this.maxTicketsPerSession) {
      throw Object.assign(
        new Error("当前会话申请了过多 Live Voice 临时票据，请稍后重试。"),
        { statusCode: 429 }
      );
    }
    const ticket = this.random(32).toString("base64url");
    this.records.set(this.digest(ticket), {
      sessionId,
      expiresAt: this.now() + this.ttlMs
    });
    return ticket;
  }

  consume(sessionId, ticket) {
    this.prune();
    const digest = this.digest(String(ticket || ""));
    const record = this.records.get(digest);
    this.records.delete(digest);
    return Boolean(
      record
      && record.sessionId === sessionId
      && record.expiresAt > this.now()
    );
  }

  clear() {
    this.records.clear();
  }
}
