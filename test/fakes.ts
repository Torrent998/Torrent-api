import type { ChainSubmitter, ChainTxStatus } from "../src/integrations/chain-submitter.js";
import type { ContractView, EventsPage, IndexedEventView, IndexedPool, IndexedRight, IndexedTransfer, IndexerClient, IndexerStatusView } from "../src/integrations/indexer-client.js";
import { CONTRACT_ID } from "./helpers.js";

/**
 * TEST ADAPTER (not an integration): in-memory stand-in for torrent-indexer. Shapes are the same
 * zod-validated v1 shapes; the real client is contract-tested against the indexer's recorded output.
 */
export class FakeIndexer implements IndexerClient {
  st: IndexerStatusView = { schemaVersion: 1, network: "testnet", contractId: CONTRACT_ID, status: "SYNCED", cursor: null, latestObservedLedger: 1000, lagLedgers: 0 };
  pools = new Map<string, IndexedPool>();
  rights = new Map<string, IndexedRight>();
  transfers = new Map<string, IndexedTransfer>();
  log: IndexedEventView[] = [];
  gov: Omit<ContractView, "indexerStatus" | "latestObservedLedger"> = {
    contractId: CONTRACT_ID, abiVersion: 2, admin: null, pendingAdmin: null, pendingUpgrade: null, upgradesLocked: false, upgrades: [],
  };
  private seq = 0;
  down = false;

  private meta() { return { indexerStatus: this.st.status, latestObservedLedger: this.st.latestObservedLedger }; }
  async status() { if (this.down) throw new Error("down"); return this.st; }
  async pool(id: string) { return this.pools.get(id) ?? null; }
  async poolRights(id: string) { return this.pools.has(id) ? [...this.rights.values()].filter((r) => r.poolId === id) : null; }
  async right(id: string) { return this.rights.get(id) ?? null; }
  async transfer(id: string) { return this.transfers.get(id) ?? null; }
  async contract(): Promise<ContractView> { if (this.down) throw new Error("down"); return { ...this.gov, ...this.meta() }; }
  async events(cursor: string | null, limit: number): Promise<EventsPage> {
    const evs = this.log.filter((e) => cursor === null || e.id > cursor).slice(0, limit);
    return { schemaVersion: 1, network: this.st.network, events: evs, nextCursor: evs.at(-1)?.id ?? cursor, indexerStatus: this.st.status };
  }

  emit(name: string, txHash: string, refs: IndexedEventView["refs"], data: Record<string, string> = {}, finality: "SUBMITTED" | "CONFIRMED" = "CONFIRMED"): IndexedEventView {
    const e: IndexedEventView = {
      id: `${String(++this.seq).padStart(19, "0")}-0000000000`, ledger: 900 + this.seq, ledgerClosedAt: "2026-03-01T00:00:00.000Z",
      txHash, contractId: CONTRACT_ID, name, refs, data, finality,
    };
    this.log.push(e);
    return e;
  }
  addPool(p: Partial<IndexedPool> & { poolId: string; controller: string; token: string; membershipPolicyHash: string; members?: string[] }): IndexedPool {
    const full: IndexedPool = {
      startLedger: 1, status: "Active", members: [], departedMembers: [], pendingController: null, receipts: 0, createdAtLedger: 1,
      totals: { funded: "0", reserved: "0", claimed: "0", withdrawn: "0" }, coverage: { unreserved: "0", fullyBacked: true }, ...this.meta(), ...p,
    };
    this.pools.set(full.poolId, full);
    this.emit("pool_created", `pool-tx-${full.poolId}`, { poolId: full.poolId }, { controller: full.controller, token: full.token, membership_policy_hash: full.membershipPolicyHash, start_ledger: "1" });
    return full;
  }
  addRight(r: Partial<IndexedRight> & { rightId: string; poolId: string; owner: string }): IndexedRight {
    const full: IndexedRight = { amount: "100", maturity: 2_000_000_000, state: "Issued", pendingTransfer: null, issuedAtLedger: 2, claimedAtLedger: null, ...this.meta(), ...r };
    this.rights.set(full.rightId, full);
    return full;
  }
}

/** TEST ADAPTER: records submissions; statuses are set by the test, as the network would report them. */
export class TestChainSubmitter implements ChainSubmitter {
  submitted: string[] = [];
  statuses = new Map<string, ChainTxStatus>();
  reject = false;
  networkError = false;
  async submit(xdr: string, txHash: string) {
    if (this.networkError) throw new Error("timeout after send");
    this.submitted.push(xdr);
    if (this.reject) return { accepted: false, detail: "tx_bad_seq" };
    this.statuses.set(txHash, "PENDING");
    return { accepted: true };
  }
  async status(txHash: string): Promise<ChainTxStatus> { return this.statuses.get(txHash) ?? "NOT_FOUND"; }
}
