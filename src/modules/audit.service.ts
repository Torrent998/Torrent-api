import { Inject, Injectable } from "@nestjs/common";
import { newId } from "../common/ids.js";
import { CLOCK, type Clock, type Ctx } from "../common/context.js";
import { Database } from "../persistence/state.js";

@Injectable()
export class AuditService {
  constructor(@Inject(Database) private readonly db: Database, @Inject(CLOCK) private readonly clock: Clock) {}

  /** Records actor, scope, action, object, time and request id. Never pass secrets or tokens. */
  record(s: { audit: { push(e: unknown): void } }, ctx: Pick<Ctx, "requestId"> & { actor: string }, scope: string, action: string, object: string): void {
    s.audit.push({ id: newId("aud"), at: this.clock.now().toISOString(), actor: ctx.actor, scope, action, object, requestId: ctx.requestId });
  }

  forCircle(circleId: string) {
    return this.db.read().audit.filter((a) => a.scope === `circle:${circleId}`);
  }
}
