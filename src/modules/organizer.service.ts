import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { CLOCK, CONFIG, type AppConfig, type Clock, type Ctx } from "../common/context.js";
import { conflict, forbidden, unprocessable } from "../common/errors.js";
import { amountSchema, parseAmount } from "../common/money.js";
import { addressSchema } from "../domain/rules.js";
import { CircleService } from "./circle.service.js";
import { IntentService } from "./intent.service.js";
import { INDEXER, LedgerSyncService } from "./ledger-sync.service.js";
import type { IndexerClient } from "../integrations/indexer-client.js";

export const createPoolBody = z.object({}).strict();
export const closePoolBody = z.object({}).strict();
export const issueRightBody = z.object({
  owner: addressSchema,
  amount: amountSchema,
  /** Unix seconds. Must be in the future when the right is issued. */
  maturity: z.number().int().positive(),
}).strict();

/**
 * Organizer signing requests: create the on-chain pool, issue a payout right, close the pool. Same contract as every
 * other intent: the API verifies preconditions against indexer truth, returns an unsigned descriptor, the organizer's
 * wallet signs, and nothing counts as done until the indexer shows the event for that transaction hash.
 */
@Injectable()
export class OrganizerService {
  constructor(
    @Inject(CircleService) private readonly circles: CircleService,
    @Inject(IntentService) private readonly intents: IntentService,
    @Inject(LedgerSyncService) private readonly ledger: LedgerSyncService,
    @Inject(INDEXER) private readonly indexer: IndexerClient,
    @Inject(CONFIG) private readonly cfg: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private organizerCircle(ctx: Ctx, circleId: string) {
    const c = this.circles.getForMember(ctx, circleId);
    if (c.organizerUserId !== ctx.principal.userId) throw forbidden("only the circle organizer can do this");
    return c;
  }

  /** create_pool: the pool is bound back to the circle by the indexed pool_created event (policy hash match). */
  async createPoolIntent(ctx: Ctx, circleId: string, idempotencyKey: string) {
    const c = this.organizerCircle(ctx, circleId);
    if (c.poolId) throw conflict("POOL_ALREADY_BOUND", "this circle already has an on-chain pool");
    const { latestLedger } = await this.ledger.assertHealthy();
    return this.intents.create(ctx, {
      kind: "POOL_CREATE", circleId, poolId: "0", idempotencyKey, verifiedAtLedger: latestLedger,
      expectEvent: { name: "pool_created", refs: {} },
      descriptor: {
        contractId: this.cfg.contractId, function: "create_pool",
        args: [
          { name: "controller", type: "address", value: ctx.principal.stellarAddress },
          { name: "token", type: "address", value: c.ruleSet.tokenContractId },
          { name: "membership_policy_hash", type: "bytes32", value: c.policyHash },
        ],
      },
    });
  }

  /** issue_right: refused up front when it would exceed the ledger-derived backing, so nobody signs a doomed transaction. */
  async issueRightIntent(ctx: Ctx, circleId: string, body: z.infer<typeof issueRightBody>, idempotencyKey: string) {
    const c = this.organizerCircle(ctx, circleId);
    if (!c.poolId) throw unprocessable("POOL_NOT_BOUND", "no on-chain pool is bound to this circle yet");
    const { latestLedger } = await this.ledger.assertHealthy();
    const pool = await this.indexer.pool(c.poolId);
    if (!pool) throw unprocessable("POOL_NOT_FOUND", "indexer does not know this pool");
    if (pool.controller !== ctx.principal.stellarAddress) throw forbidden("you are not the on-chain controller of this pool");
    if (pool.status === "Paused") throw conflict("POOL_PAUSED", "pool is paused; no new rights can be issued");
    if (pool.status === "Closed") throw conflict("POOL_CLOSED", "pool is closed; no new rights can be issued");
    if (!pool.members.includes(body.owner)) throw unprocessable("NOT_POOL_MEMBER", "the owner has not joined the on-chain pool");
    if (body.maturity * 1000 <= this.clock.now().getTime()) throw unprocessable("MATURITY_IN_PAST", "maturity must be in the future");
    const amount = parseAmount(body.amount);
    const t = pool.totals;
    const free = BigInt(t.funded) - BigInt(t.reserved) - BigInt(t.claimed) - BigInt(t.withdrawn); // totals may legitimately be 0
    if (amount > free) throw unprocessable("INSUFFICIENT_BACKING", `only ${free} is unreserved; issuing ${amount} would leave rights unbacked`);
    return this.intents.create(ctx, {
      kind: "RIGHT_ISSUE", circleId, poolId: pool.poolId, idempotencyKey, verifiedAtLedger: latestLedger,
      expectEvent: { name: "right_issued", refs: { poolId: pool.poolId } },
      descriptor: {
        contractId: this.cfg.contractId, function: "issue_right",
        args: [
          { name: "pool_id", type: "u64", value: pool.poolId },
          { name: "owner", type: "address", value: body.owner },
          { name: "amount", type: "i128", value: body.amount },
          { name: "maturity", type: "u64", value: String(body.maturity) },
          { name: "policy_hash", type: "bytes32", value: c.policyHash },
        ],
      },
    });
  }

  async closePoolIntent(ctx: Ctx, circleId: string, idempotencyKey: string) {
    const c = this.organizerCircle(ctx, circleId);
    if (!c.poolId) throw unprocessable("POOL_NOT_BOUND", "no on-chain pool is bound to this circle yet");
    const { latestLedger } = await this.ledger.assertHealthy();
    const pool = await this.indexer.pool(c.poolId);
    if (!pool) throw unprocessable("POOL_NOT_FOUND", "indexer does not know this pool");
    if (pool.controller !== ctx.principal.stellarAddress) throw forbidden("you are not the on-chain controller of this pool");
    if (pool.status === "Closed") throw conflict("POOL_CLOSED", "pool is already closed");
    return this.intents.create(ctx, {
      kind: "POOL_CLOSE", circleId, poolId: pool.poolId, idempotencyKey, verifiedAtLedger: latestLedger,
      expectEvent: { name: "pool_closed", refs: { poolId: pool.poolId } },
      descriptor: {
        contractId: this.cfg.contractId, function: "close_pool",
        args: [{ name: "pool_id", type: "u64", value: pool.poolId }],
      },
    });
  }
}
