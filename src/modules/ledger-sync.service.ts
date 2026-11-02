import { Inject, Injectable } from "@nestjs/common";
import { unavailable } from "../common/errors.js";
import { CONFIG, type AppConfig, type Clock, CLOCK } from "../common/context.js";
import { newId } from "../common/ids.js";
import type { IndexerClient, IndexedEventView } from "../integrations/indexer-client.js";
import { Database, type AppState } from "../persistence/state.js";

export const INDEXER = Symbol("INDEXER");

/**
 * Pulls confirmed-chain events from torrent-indexer into a small local cache: a tx-hash index
 * (to confirm intents) and pool_created facts (to bind circles to pools by policy hash). The
 * cache never decides balances or ownership; those are always read from the indexer.
 */
@Injectable()
export class LedgerSyncService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(INDEXER) private readonly indexer: IndexerClient,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CONFIG) private readonly cfg: AppConfig,
  ) {}

  /** Fail closed: sensitive actions are refused while the indexer is halted or far behind. */
  async assertHealthy(): Promise<{ latestLedger: number }> {
    const st = await this.indexer.status();
    if (st.network !== this.cfg.network) throw unavailable("NETWORK_MISMATCH", "indexer serves a different network");
    if (st.status === "RECONCILING") throw unavailable("INDEXER_HALTED", "ledger state is under reconciliation; sensitive actions are paused");
    if (st.lagLedgers > this.cfg.maxIndexerLagLedgers) throw unavailable("INDEXER_STALE", "ledger state is stale; try again shortly");
    return { latestLedger: st.latestObservedLedger };
  }

  /**
   * Absorbs only CONFIRMED events (deep enough per the indexer). The first unconfirmed event
   * stops the scan and the cursor stays before it, so it is picked up on a later sync.
   */
  async sync(): Promise<{ events: number }> {
    let total = 0;
    for (let guard = 0; guard < 1000; guard++) {
      const cursor = this.db.read().ledger.cursor;
      const page = await this.indexer.events(cursor, 200);
      if (page.network !== this.cfg.network) throw unavailable("NETWORK_MISMATCH", "indexer serves a different network");
      const firstOpen = page.events.findIndex((e) => e.finality !== "CONFIRMED");
      const ready = firstOpen === -1 ? page.events : page.events.slice(0, firstOpen);
      if (ready.length > 0) {
        this.db.mutate((s) => {
          for (const e of ready) this.absorb(s, e);
          s.ledger.cursor = ready[ready.length - 1]!.id;
        });
        total += ready.length;
      }
      if (firstOpen !== -1 || page.events.length === 0) break;
    }
    this.bindPools();
    return { events: total };
  }

  private absorb(s: AppState, e: IndexedEventView): void {
    if (e.contractId !== this.cfg.contractId) return; // other deployments are not ours
    (s.ledger.byTx[e.txHash] ??= []).push({ id: e.id, name: e.name, txHash: e.txHash, ledger: e.ledger, refs: e.refs });
    if (e.name === "pool_created" && e.refs.poolId) {
      s.ledger.pools[e.refs.poolId] = {
        controller: e.data["controller"] ?? "", policyHash: e.data["membership_policy_hash"] ?? "", token: e.data["token"] ?? "",
      };
    }
  }

  private bindPools(): void {
    const s0 = this.db.read();
    const taken = new Set(Object.values(s0.circles).map((c) => c.poolId).filter(Boolean));
    for (const c of Object.values(s0.circles)) {
      if (c.poolId) continue;
      const matches = Object.entries(s0.ledger.pools).filter(
        ([id, p]) => !taken.has(id) && p.policyHash === c.policyHash && p.controller === c.organizerAddress && p.token === c.ruleSet.tokenContractId,
      );
      if (matches.length === 0) continue;
      this.db.mutate((s) => {
        if (matches.length > 1) {
          s.audit.push({ id: newId("aud"), at: this.clock.now().toISOString(), actor: "system", scope: `circle:${c.id}`, action: "pool.bind.ambiguous", object: matches.map(([i]) => i).join(","), requestId: "sync" });
          return;
        }
        const [poolId] = matches[0]!;
        s.circles[c.id]!.poolId = poolId;
        taken.add(poolId);
        s.audit.push({ id: newId("aud"), at: this.clock.now().toISOString(), actor: "system", scope: `circle:${c.id}`, action: "pool.bind", object: poolId, requestId: "sync" });
      });
    }
  }
}
