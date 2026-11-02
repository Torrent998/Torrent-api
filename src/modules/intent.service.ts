import { Inject, Injectable } from "@nestjs/common";
import { CLOCK, CONFIG, type AppConfig, type Clock, type Ctx } from "../common/context.js";
import { conflict, forbidden, notFound, unprocessable } from "../common/errors.js";
import { newId } from "../common/ids.js";
import { assertTransition, isTerminal, type Intent, type IntentKind, type IntentState, type InvocationDescriptor } from "../domain/intent.js";
import { CHAIN_SUBMITTER, type ChainSubmitter } from "../integrations/chain-submitter.js";
import { verifySignedTx } from "../integrations/tx-verify.js";
import { Database, type AppState } from "../persistence/state.js";
import { AuditService } from "./audit.service.js";
import { LedgerSyncService } from "./ledger-sync.service.js";

export interface NewIntent {
  kind: IntentKind;
  circleId: string;
  poolId: string;
  descriptor: InvocationDescriptor;
  expectEvent: Intent["expectEvent"];
  idempotencyKey: string;
  verifiedAtLedger: number;
}

export const intentView = (i: Intent) => ({
  id: i.id, schemaVersion: i.schemaVersion, requestId: i.requestId, kind: i.kind, circleId: i.circleId, state: i.state,
  descriptor: i.descriptor, txHash: i.txHash, failureReason: i.failureReason, verifiedAtLedger: i.verifiedAtLedger,
  expiresAt: i.expiresAt, createdAt: i.createdAt, updatedAt: i.updatedAt,
});

@Injectable()
export class IntentService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CONFIG) private readonly cfg: AppConfig,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(LedgerSyncService) private readonly ledger: LedgerSyncService,
    @Inject(CHAIN_SUBMITTER) private readonly submitter: ChainSubmitter,
  ) {}

  private move(s: AppState, id: string, to: IntentState, patch: Partial<Intent> = {}): Intent {
    const i = s.intents[id]!;
    assertTransition(i.state, to);
    Object.assign(i, patch, { state: to, updatedAt: this.clock.now().toISOString() });
    return i;
  }

  /**
   * Preconditions were already verified by the caller against indexer truth. This records the
   * intent and walks DRAFT -> VERIFIED -> AWAITING_SIGNATURE; nothing is "succeeded" yet.
   */
  create(ctx: Ctx, n: NewIntent, extra?: (s: AppState, intent: Intent) => void): Intent {
    const now = this.clock.now();
    const intent: Intent = {
      id: newId("int"), schemaVersion: 1, requestId: ctx.requestId, kind: n.kind, circleId: n.circleId, poolId: n.poolId,
      actorUserId: ctx.principal.userId, actorAddress: ctx.principal.stellarAddress, state: "DRAFT", descriptor: n.descriptor,
      expectEvent: n.expectEvent, idempotencyKey: n.idempotencyKey, txHash: null, submittedAt: null, confirmedEventId: null,
      failureReason: null, verifiedAtLedger: n.verifiedAtLedger,
      expiresAt: new Date(now.getTime() + this.cfg.intentTtlSeconds * 1000).toISOString(),
      createdAt: now.toISOString(), updatedAt: now.toISOString(),
    };
    return this.db.mutate((s) => {
      s.intents[intent.id] = intent;
      this.move(s, intent.id, "VERIFIED");
      const out = this.move(s, intent.id, "AWAITING_SIGNATURE");
      this.audit.record(s, { ...ctx, actor: ctx.principal.userId }, `circle:${n.circleId}`, `intent.create.${n.kind}`, intent.id);
      extra?.(s, out);
      return out;
    });
  }

  get(ctx: Ctx, id: string): Intent {
    const i = this.db.read().intents[id];
    if (!i) throw notFound("intent");
    if (i.actorUserId !== ctx.principal.userId) {
      // Other circle members may see the status of intents in their circle (read-only).
      const c = this.db.read().circles[i.circleId];
      if (!c?.members.some((m) => m.userId === ctx.principal.userId)) throw notFound("intent");
    }
    return i;
  }

  /**
   * Forward a user-signed transaction. The tx hash is persisted BEFORE sending, so a crash or
   * timeout after send leaves a SUBMITTED intent that reconciliation resolves by hash; the
   * request is never silently re-sent with different parameters.
   */
  async submit(ctx: Ctx, id: string, signedXdr: string): Promise<Intent> {
    const i = this.get(ctx, id);
    if (i.actorUserId !== ctx.principal.userId) throw forbidden("only the intent actor can submit");
    if (i.state === "SUBMITTED" || i.state === "CONFIRMED" || i.state === "RECONCILING") {
      const v = verifySignedTx(signedXdr, this.cfg.networkPassphrase, i.descriptor, i.actorAddress);
      if (v.txHash === i.txHash) return i; // idempotent re-submit of the same signed tx
      throw conflict("INTENT_ALREADY_SUBMITTED", "a different transaction was already submitted for this intent");
    }
    if (i.state !== "AWAITING_SIGNATURE") throw conflict("INTENT_NOT_SUBMITTABLE", `intent is ${i.state}`);
    if (Date.parse(i.expiresAt) <= this.clock.now().getTime()) {
      this.db.mutate((s) => { this.move(s, id, "FAILED", { failureReason: "EXPIRED_BEFORE_SIGNATURE" }); });
      throw unprocessable("INTENT_EXPIRED", "approval expired; create a new intent");
    }
    await this.ledger.assertHealthy();
    const v = verifySignedTx(signedXdr, this.cfg.networkPassphrase, i.descriptor, i.actorAddress);
    this.db.mutate((s) => {
      this.move(s, id, "SUBMITTED", { txHash: v.txHash, submittedAt: this.clock.now().toISOString() });
      this.audit.record(s, { ...ctx, actor: ctx.principal.userId }, `circle:${i.circleId}`, "intent.submit", id);
    });
    try {
      const r = await this.submitter.submit(signedXdr, v.txHash);
      if (!r.accepted) {
        this.db.mutate((s) => { this.move(s, id, "FAILED", { failureReason: `REJECTED:${r.detail ?? "unknown"}` }); });
      }
    } catch {
      // Outcome unknown (timeout after send?): stay SUBMITTED; reconcile() decides by hash.
    }
    return this.db.read().intents[id]!;
  }

  /** Observe-and-resolve loop body. Idempotent; safe to run on a timer or on demand. */
  async reconcile(): Promise<{ confirmed: number; failed: number; reconciling: number; expired: number }> {
    const out = { confirmed: 0, failed: 0, reconciling: 0, expired: 0 };
    await this.ledger.sync();
    const now = this.clock.now().getTime();
    for (const i of Object.values(this.db.read().intents)) {
      if (isTerminal(i.state)) continue;
      if (i.state === "AWAITING_SIGNATURE") {
        if (Date.parse(i.expiresAt) <= now) {
          this.db.mutate((s) => { this.move(s, i.id, "FAILED", { failureReason: "EXPIRED_BEFORE_SIGNATURE" }); });
          out.expired++;
        }
        continue;
      }
      if (i.state !== "SUBMITTED" && i.state !== "RECONCILING") continue;
      const seen = this.db.read().ledger.byTx[i.txHash!]?.find((e) => e.name === i.expectEvent.name);
      if (seen) {
        this.db.mutate((s) => {
          this.move(s, i.id, "CONFIRMED", { confirmedEventId: seen.id });
          this.afterConfirmed(s, s.intents[i.id]!, seen.refs);
          this.audit.record(s, { requestId: "reconcile", actor: "system" }, `circle:${i.circleId}`, "intent.confirmed", i.id);
        });
        out.confirmed++;
        continue;
      }
      let st: Awaited<ReturnType<ChainSubmitter["status"]>>;
      try { st = await this.submitter.status(i.txHash!); } catch { st = "PENDING"; }
      if (st === "FAILED") {
        this.db.mutate((s) => { this.move(s, i.id, "FAILED", { failureReason: "CHAIN_EXECUTION_FAILED" }); });
        out.failed++;
      } else if (i.state === "SUBMITTED" && now - Date.parse(i.submittedAt!) >= this.cfg.reconcileAfterSeconds * 1000) {
        // Not observed in time and not provably failed: never assume failure or resubmit.
        this.db.mutate((s) => {
          this.move(s, i.id, "RECONCILING");
          this.audit.record(s, { requestId: "reconcile", actor: "system" }, `circle:${i.circleId}`, "intent.reconciling", i.id);
        });
        out.reconciling++;
      }
    }
    return out;
  }

  private afterConfirmed(s: AppState, i: Intent, refs: Record<string, string | undefined>): void {
    if (i.kind === "TRANSFER_PROPOSE" && refs["transferId"]) {
      for (const t of Object.values(s.transfers)) if (t.proposeIntentId === i.id) t.chainTransferId = refs["transferId"]!;
    }
  }
}
