import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { CLOCK, CONFIG, type AppConfig, type Clock, type Ctx } from "../common/context.js";
import { conflict, unprocessable } from "../common/errors.js";
import { amountSchema } from "../common/money.js";
import { INDEXER, LedgerSyncService } from "./ledger-sync.service.js";
import type { IndexerClient } from "../integrations/indexer-client.js";
import { CircleService } from "./circle.service.js";
import { IntentService } from "./intent.service.js";

export const fundingIntentBody = z.object({ amount: amountSchema }).strict();

@Injectable()
export class FundingService {
  constructor(
    @Inject(CircleService) private readonly circles: CircleService,
    @Inject(IntentService) private readonly intents: IntentService,
    @Inject(LedgerSyncService) private readonly ledger: LedgerSyncService,
    @Inject(INDEXER) private readonly indexer: IndexerClient,
    @Inject(CONFIG) private readonly cfg: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async fundingIntent(ctx: Ctx, circleId: string, body: z.infer<typeof fundingIntentBody>, idempotencyKey: string) {
    const c = this.circles.getForMember(ctx, circleId);
    if (!c.poolId) throw unprocessable("POOL_NOT_BOUND", "no on-chain pool is bound to this circle yet");
    const { latestLedger } = await this.ledger.assertHealthy();
    const pool = await this.indexer.pool(c.poolId);
    if (!pool) throw unprocessable("POOL_NOT_FOUND", "indexer does not know this pool");
    if (pool.status === "Paused") throw conflict("POOL_PAUSED", "pool is paused; funding is disabled");
    return this.intents.create(ctx, {
      kind: "FUNDING", circleId, poolId: pool.poolId, idempotencyKey, verifiedAtLedger: latestLedger,
      expectEvent: { name: "funded", refs: { poolId: pool.poolId } },
      descriptor: {
        contractId: this.cfg.contractId, function: "deposit",
        args: [
          { name: "pool_id", type: "u64", value: pool.poolId },
          { name: "from", type: "address", value: ctx.principal.stellarAddress },
          { name: "amount", type: "i128", value: body.amount },
        ],
      },
    });
  }

  /**
   * Coverage is NEVER computed from API data: it is the indexer's ledger-derived totals plus
   * honest freshness metadata so the UI can show unconfirmed/stale state.
   */
  async coverage(ctx: Ctx, circleId: string) {
    const c = this.circles.getForMember(ctx, circleId);
    if (!c.poolId) return { circleId, bound: false as const };
    const pool = await this.indexer.pool(c.poolId);
    if (!pool) return { circleId, bound: false as const };
    const st = await this.indexer.status();
    return {
      circleId, bound: true as const, poolId: pool.poolId, totals: pool.totals,
      unreserved: pool.coverage.unreserved, fullyBacked: pool.coverage.fullyBacked,
      poolStatus: pool.status, indexerStatus: st.status, asOfLedger: st.latestObservedLedger, lagLedgers: st.lagLedgers,
      observedAt: this.clock.now().toISOString(),
    };
  }
}
