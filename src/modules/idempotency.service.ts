import { Inject, Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import { badRequest, conflict } from "../common/errors.js";
import { CLOCK, type Clock } from "../common/context.js";
import { Database } from "../persistence/state.js";

export interface Reply { statusCode: number; body: unknown }

@Injectable()
export class IdempotencyService {
  private readonly inflight = new Map<string, { fingerprint: string; p: Promise<Reply> }>();
  constructor(@Inject(Database) private readonly db: Database, @Inject(CLOCK) private readonly clock: Clock) {}

  static validKey(key: string | undefined): string {
    if (!key || !/^[A-Za-z0-9_-]{8,128}$/.test(key)) throw badRequest("IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key header (8-128 chars of A-Za-z0-9_-) is required");
    return key;
  }

  /**
   * Same (user, key, request) => the stored reply, exactly one business effect.
   * Same key with a different request => 409, never a silent second intent.
   */
  async run(userId: string, key: string, requestShape: unknown, fn: () => Promise<Reply>): Promise<Reply> {
    const id = `${userId}:${key}`;
    const fingerprint = createHash("sha256").update(JSON.stringify(requestShape)).digest("hex");
    const hit = this.db.read().idempotency[id];
    if (hit) {
      if (hit.fingerprint !== fingerprint) throw conflict("IDEMPOTENCY_KEY_REUSED", "this Idempotency-Key was used with a different request");
      return { statusCode: hit.statusCode, body: hit.body };
    }
    const running = this.inflight.get(id);
    if (running) {
      // Concurrent duplicate: wait for the first request instead of executing a second time.
      if (running.fingerprint !== fingerprint) throw conflict("IDEMPOTENCY_KEY_REUSED", "this Idempotency-Key was used with a different request");
      return running.p;
    }
    const p = (async () => {
      const reply = await fn();
      this.db.mutate((s) => {
        s.idempotency[id] = { fingerprint, statusCode: reply.statusCode, body: reply.body, createdAt: this.clock.now().toISOString() };
      });
      return reply;
    })();
    this.inflight.set(id, { fingerprint, p });
    try {
      return await p;
    } finally {
      this.inflight.delete(id);
    }
  }
}
