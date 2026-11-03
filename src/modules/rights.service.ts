import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { CLOCK, type Clock, type Ctx } from "../common/context.js";
import { conflict, forbidden, notFound, unprocessable } from "../common/errors.js";
import { addressSchema } from "../domain/rules.js";
import { newId } from "../common/ids.js";
import type { IndexerClient } from "../integrations/indexer-client.js";
import { Database, type Circle, type TransferRecord } from "../persistence/state.js";
import { CircleService } from "./circle.service.js";
import { IntentService } from "./intent.service.js";
import { INDEXER, LedgerSyncService } from "./ledger-sync.service.js";
import { CONFIG, type AppConfig } from "../common/context.js";
import { AuditService } from "./audit.service.js";

export const transferIntentBody = z.object({ toAddress: addressSchema, expiresAt: z.iso.datetime() }).strict();
export const claimIntentBody = z.object({}).strict();
const MAX_TRANSFER_WINDOW_MS = 30 * 86400_000;

export const transferView = (t: TransferRecord) => ({
  id: t.id, circleId: t.circleId, rightId: t.rightId, from: t.fromAddress, to: t.toAddress, expiresAt: t.expiresAt,
  proposeIntentId: t.proposeIntentId, acceptIntentId: t.acceptIntentId, cancelIntentId: t.cancelIntentId ?? null,
  chainTransferId: t.chainTransferId, createdAt: t.createdAt,
});

@Injectable()
export class RightsService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(CircleService) private readonly circles: CircleService,
    @Inject(IntentService) private readonly intents: IntentService,
    @Inject(LedgerSyncService) private readonly ledger: LedgerSyncService,
    @Inject(INDEXER) private readonly indexer: IndexerClient,
    @Inject(CONFIG) private readonly cfg: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  private circleForPool(poolId: string): Circle | undefined {
    return Object.values(this.db.read().circles).find((c) => c.poolId === poolId);
  }

  async listRights(ctx: Ctx, circleId: string) {
    const c = this.circles.getForMember(ctx, circleId);
    if (!c.poolId) return { circleId, rights: [], bound: false as const };
    const rights = (await this.indexer.poolRights(c.poolId)) ?? [];
    const st = await this.indexer.status();
    return { circleId, bound: true as const, indexerStatus: st.status, asOfLedger: st.latestObservedLedger, rights: rights.map(({ indexerStatus: _a, latestObservedLedger: _b, ...r }) => r) };
  }

  /** Resolve a chain right to a circle the caller belongs to; non-members learn nothing (404). */
  private async rightForMember(ctx: Ctx, rightId: string) {
    const right = await this.indexer.right(rightId);
    const circle = right ? this.circleForPool(right.poolId) : undefined;
    if (!right || !circle || !circle.members.some((m) => m.userId === ctx.principal.userId)) throw notFound("right");
    return { right, circle };
  }

  async transferIntent(ctx: Ctx, rightId: string, body: z.infer<typeof transferIntentBody>, idempotencyKey: string) {
    const { latestLedger } = await this.ledger.assertHealthy();
    const { right, circle } = await this.rightForMember(ctx, rightId);
    // Authorization is evaluated server-side, against ledger-derived ownership, BEFORE any signature request.
    if (right.owner !== ctx.principal.stellarAddress) throw forbidden("only the current on-chain owner can transfer this right");
    if (right.state !== "Issued") throw unprocessable("RIGHT_NOT_ACTIVE", "right has already been claimed");
    const pool = await this.indexer.pool(right.poolId);
    if (!pool || pool.status === "Paused") throw conflict("POOL_PAUSED", "pool is paused; transfers are disabled");
    if (pool.status === "Closed") throw conflict("POOL_CLOSED", "pool is closed; rights can be claimed but not traded");
    if (body.toAddress === right.owner) throw unprocessable("SAME_OWNER", "recipient is already the owner");
    if (!circle.members.some((m) => m.address === body.toAddress) || !pool.members.includes(body.toAddress)) {
      throw unprocessable("RECIPIENT_NOT_ELIGIBLE", "recipient must be a member of the circle and of the on-chain pool");
    }
    const nowMs = this.clock.now().getTime();
    const expiry = Date.parse(body.expiresAt);
    // Contract timing rules (ABI v2): a matured right is for claiming only, and an offer may not outlive it.
    if (right.maturity * 1000 <= nowMs) throw unprocessable("RIGHT_MATURED", "this right has matured; claim it instead of transferring it");
    if (expiry <= nowMs || expiry > nowMs + MAX_TRANSFER_WINDOW_MS) throw unprocessable("INVALID_EXPIRY", "expiresAt must be in the future and within 30 days");
    if (Math.floor(expiry / 1000) > right.maturity) throw unprocessable("INVALID_EXPIRY", `expiresAt must not be after the right's maturity (${new Date(right.maturity * 1000).toISOString()})`);
    if (right.pendingTransfer) {
      const t = await this.indexer.transfer(right.pendingTransfer);
      if (t && t.status === "Pending" && t.expiry * 1000 > nowMs) throw conflict("TRANSFER_ALREADY_PENDING", "this right already has an open transfer proposal");
    }
    const expirySecs = String(Math.floor(expiry / 1000));
    const intent = this.intents.create(ctx, {
      kind: "TRANSFER_PROPOSE", circleId: circle.id, poolId: right.poolId, idempotencyKey, verifiedAtLedger: latestLedger,
      expectEvent: { name: "transfer_proposed", refs: { rightId } },
      descriptor: {
        contractId: this.cfg.contractId, function: "propose_transfer",
        args: [
          { name: "right_id", type: "u64", value: rightId },
          { name: "new_owner", type: "address", value: body.toAddress },
          { name: "expiry", type: "u64", value: expirySecs },
        ],
      },
    }, (s, i) => {
      const t: TransferRecord = {
        id: newId("trf"), circleId: circle.id, rightId, fromAddress: right.owner, toAddress: body.toAddress,
        expiresAt: new Date(Number(expirySecs) * 1000).toISOString(), proposeIntentId: i.id, acceptIntentId: null,
        cancelIntentId: null, chainTransferId: null, createdAt: this.clock.now().toISOString(),
      };
      s.transfers[t.id] = t;
    });
    const transfer = Object.values(this.db.read().transfers).find((t) => t.proposeIntentId === intent.id)!;
    return { transfer, intent };
  }

  /** Recipient approval: produces the accept_transfer signing request once the proposal is confirmed on-chain. */
  async approve(ctx: Ctx, transferId: string, idempotencyKey: string) {
    const rec = this.db.read().transfers[transferId];
    const circle = rec && this.db.read().circles[rec.circleId];
    if (!rec || !circle || !circle.members.some((m) => m.userId === ctx.principal.userId)) throw notFound("transfer");
    if (rec.toAddress !== ctx.principal.stellarAddress) throw forbidden("only the named recipient can approve");
    const { latestLedger } = await this.ledger.assertHealthy();
    const existing = rec.acceptIntentId ? this.db.read().intents[rec.acceptIntentId] : undefined;
    if (existing && existing.state !== "FAILED") return { transfer: rec, intent: existing };
    const proposal = this.db.read().intents[rec.proposeIntentId]!;
    if (proposal.state !== "CONFIRMED" || !rec.chainTransferId) throw conflict("PROPOSAL_NOT_CONFIRMED", `the proposal is ${proposal.state}; wait until it is confirmed on-chain`);
    const [chainT, right] = await Promise.all([this.indexer.transfer(rec.chainTransferId), this.indexer.right(rec.rightId)]);
    // Stale authorization => require a brand-new proposal rather than reusing old approval.
    if (!chainT || chainT.status !== "Pending") throw conflict("STALE_TRANSFER", `on-chain transfer is ${chainT?.status ?? "unknown"}`);
    if (chainT.expiry * 1000 <= this.clock.now().getTime()) throw conflict("STALE_TRANSFER", "on-chain proposal expired");
    if (!right || right.owner !== rec.fromAddress || right.state !== "Issued") throw conflict("STALE_TRANSFER", "right no longer belongs to the proposer");
    if (right.maturity * 1000 <= this.clock.now().getTime()) throw conflict("STALE_TRANSFER", "the right has matured; it can no longer change hands");
    const pool = await this.indexer.pool(right.poolId);
    if (!pool || pool.status !== "Active") throw conflict(pool?.status === "Closed" ? "POOL_CLOSED" : "POOL_PAUSED", `pool is ${pool?.status ?? "unknown"}; transfers are disabled`);
    const intent = this.intents.create(ctx, {
      kind: "TRANSFER_ACCEPT", circleId: circle.id, poolId: right.poolId, idempotencyKey, verifiedAtLedger: latestLedger,
      expectEvent: { name: "transfer_completed", refs: { transferId: rec.chainTransferId } },
      descriptor: {
        contractId: this.cfg.contractId, function: "accept_transfer",
        args: [{ name: "transfer_id", type: "u64", value: rec.chainTransferId }],
      },
    }, (s, i) => { s.transfers[rec.id]!.acceptIntentId = i.id; });
    return { transfer: this.db.read().transfers[rec.id]!, intent };
  }

  /** Proposer withdraws an on-chain proposal (cancel_transfer). Works even while the pool is paused or closed. */
  async cancel(ctx: Ctx, transferId: string, idempotencyKey: string) {
    const rec = this.db.read().transfers[transferId];
    const circle = rec && this.db.read().circles[rec.circleId];
    if (!rec || !circle || !circle.members.some((m) => m.userId === ctx.principal.userId)) throw notFound("transfer");
    if (rec.fromAddress !== ctx.principal.stellarAddress) throw forbidden("only the proposer can cancel");
    const { latestLedger } = await this.ledger.assertHealthy();
    const existing = rec.cancelIntentId ? this.db.read().intents[rec.cancelIntentId] : undefined;
    if (existing && existing.state !== "FAILED") return { transfer: rec, intent: existing };
    const proposal = this.db.read().intents[rec.proposeIntentId]!;
    if (proposal.state !== "CONFIRMED" || !rec.chainTransferId) throw conflict("PROPOSAL_NOT_CONFIRMED", `the proposal is ${proposal.state}; nothing is on-chain to cancel yet`);
    const chainT = await this.indexer.transfer(rec.chainTransferId);
    if (!chainT || chainT.status !== "Pending") throw conflict("STALE_TRANSFER", `on-chain transfer is ${chainT?.status ?? "unknown"}`);
    const intent = this.intents.create(ctx, {
      kind: "TRANSFER_CANCEL", circleId: circle.id, poolId: circle.poolId ?? "", idempotencyKey, verifiedAtLedger: latestLedger,
      expectEvent: { name: "transfer_cancelled", refs: { transferId: rec.chainTransferId } },
      descriptor: {
        contractId: this.cfg.contractId, function: "cancel_transfer",
        args: [{ name: "transfer_id", type: "u64", value: rec.chainTransferId }],
      },
    }, (s, i) => { s.transfers[rec.id]!.cancelIntentId = i.id; });
    return { transfer: this.db.read().transfers[rec.id]!, intent };
  }

  /** Workflow status derived from the intents (the chain remains the source of truth for ownership). */
  listTransfers(ctx: Ctx, circleId: string) {
    this.circles.getForMember(ctx, circleId);
    const st = this.db.read();
    return Object.values(st.transfers).filter((t) => t.circleId === circleId).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((t) => {
      const p = st.intents[t.proposeIntentId]!; const a = t.acceptIntentId ? st.intents[t.acceptIntentId] : undefined;
      const c = t.cancelIntentId ? st.intents[t.cancelIntentId] : undefined;
      const status = a?.state === "CONFIRMED" ? "COMPLETED"
        : c?.state === "CONFIRMED" ? "CANCELLED"
        : c && c.state !== "FAILED" ? "CANCELLING"
        : p.state === "FAILED" ? "FAILED"
        : a && a.state !== "FAILED" ? "ACCEPTING"
        : p.state === "CONFIRMED" ? "AWAITING_RECIPIENT" : "PROPOSING";
      return { ...transferView(t), status } as const;
    });
  }

  /** The intent the next signature belongs to: proposal first, then acceptance. */
  currentIntentId(ctx: Ctx, transferId: string): string {
    const rec = this.db.read().transfers[transferId];
    const circle = rec && this.db.read().circles[rec.circleId];
    if (!rec || !circle || !circle.members.some((m) => m.userId === ctx.principal.userId)) throw notFound("transfer");
    const acc = rec.acceptIntentId ? this.db.read().intents[rec.acceptIntentId] : undefined;
    if (acc && acc.state !== "FAILED" && ctx.principal.stellarAddress === rec.toAddress) return acc.id;
    const can = rec.cancelIntentId ? this.db.read().intents[rec.cancelIntentId] : undefined;
    if (can && can.state !== "FAILED" && ctx.principal.stellarAddress === rec.fromAddress) return can.id;
    return rec.proposeIntentId;
  }

  async claimIntent(ctx: Ctx, rightId: string, idempotencyKey: string) {
    const { latestLedger } = await this.ledger.assertHealthy();
    const { right, circle } = await this.rightForMember(ctx, rightId);
    if (right.owner !== ctx.principal.stellarAddress) throw forbidden("only the current on-chain owner can claim");
    if (right.state !== "Issued") throw unprocessable("ALREADY_CLAIMED", "right has already been claimed");
    // Advisory only: the contract enforces maturity against ledger time.
    if (right.maturity * 1000 > this.clock.now().getTime()) throw unprocessable("NOT_MATURED", `right matures at ${new Date(right.maturity * 1000).toISOString()}`);
    const intent = this.intents.create(ctx, {
      kind: "CLAIM", circleId: circle.id, poolId: right.poolId, idempotencyKey, verifiedAtLedger: latestLedger,
      expectEvent: { name: "right_claimed", refs: { rightId } },
      descriptor: {
        contractId: this.cfg.contractId, function: "claim",
        args: [
          { name: "right_id", type: "u64", value: rightId },
          { name: "recipient", type: "address", value: ctx.principal.stellarAddress },
        ],
      },
    });
    return { intent };
  }
}
