import { z } from "zod";
import { unavailable } from "../common/errors.js";

const meta = { indexerStatus: z.enum(["SYNCING", "SYNCED", "RECONCILING"]), latestObservedLedger: z.number().int() };
const amt = z.string().regex(/^\d+$/);

export const poolSchema = z.object({
  poolId: z.string(), controller: z.string(), token: z.string(), membershipPolicyHash: z.string(),
  startLedger: z.number().int(), status: z.enum(["Active", "Paused", "Closed"]), members: z.array(z.string()),
  departedMembers: z.array(z.string()), pendingController: z.string().nullable(),
  receipts: z.number().int(),
  totals: z.object({ funded: amt, reserved: amt, claimed: amt, withdrawn: amt }),
  createdAtLedger: z.number().int(),
  coverage: z.object({ unreserved: z.string().regex(/^-?\d+$/), fullyBacked: z.boolean() }),
  ...meta,
});
export const rightSchema = z.object({
  rightId: z.string(), poolId: z.string(), amount: amt, owner: z.string(), maturity: z.number().int(),
  state: z.enum(["Issued", "Claimed"]), pendingTransfer: z.string().nullable(),
  issuedAtLedger: z.number().int(), claimedAtLedger: z.number().int().nullable(), ...meta,
});
export const transferSchema = z.object({
  transferId: z.string(), rightId: z.string(), from: z.string(), to: z.string(), expiry: z.number().int(),
  status: z.enum(["Pending", "Completed", "Cancelled"]), ...meta,
});
/** Contract governance as derived by the indexer (torrent-escrow ABI v2). */
export const contractSchema = z.object({
  contractId: z.string(), abiVersion: z.literal(2), admin: z.string().nullable(), pendingAdmin: z.string().nullable(),
  pendingUpgrade: z.object({ wasmHash: z.string().regex(/^[0-9a-f]{64}$/), executableAfter: z.number().int(), proposedAtLedger: z.number().int() }).nullable(),
  upgradesLocked: z.boolean(), upgrades: z.array(z.object({ wasmHash: z.string(), ledger: z.number().int() })),
  ...meta,
});
export const poolRightsSchema = z.object({ rights: z.array(rightSchema.omit({ indexerStatus: true, latestObservedLedger: true })), ...meta });
export const eventSchema = z.object({
  id: z.string(), ledger: z.number().int(), ledgerClosedAt: z.string(), txHash: z.string(), contractId: z.string(),
  name: z.string(),
  refs: z.object({ poolId: z.string().optional(), rightId: z.string().optional(), transferId: z.string().optional() }),
  data: z.record(z.string(), z.string()),
  finality: z.enum(["SUBMITTED", "CONFIRMED"]),
});
export const eventsPageSchema = z.object({
  schemaVersion: z.literal(1), network: z.string(), events: z.array(eventSchema),
  nextCursor: z.string().nullable(), indexerStatus: z.enum(["SYNCING", "SYNCED", "RECONCILING"]),
});
export const indexerStatusSchema = z.object({
  schemaVersion: z.literal(1), network: z.string(), contractId: z.string(),
  status: z.enum(["SYNCING", "SYNCED", "RECONCILING"]), cursor: z.string().nullable(),
  latestObservedLedger: z.number().int(), lagLedgers: z.number().int(),
});

export type IndexedPool = z.infer<typeof poolSchema>;
export type IndexedRight = z.infer<typeof rightSchema>;
export type IndexedTransfer = z.infer<typeof transferSchema>;
export type IndexedEventView = z.infer<typeof eventSchema>;
export type EventsPage = z.infer<typeof eventsPageSchema>;
export type IndexerStatusView = z.infer<typeof indexerStatusSchema>;
export type ContractView = z.infer<typeof contractSchema>;

/** Read-only view of ledger-derived truth. The API never overrides what this returns. */
export interface IndexerClient {
  status(): Promise<IndexerStatusView>;
  pool(poolId: string): Promise<IndexedPool | null>;
  poolRights(poolId: string): Promise<IndexedRight[] | null>;
  right(rightId: string): Promise<IndexedRight | null>;
  transfer(transferId: string): Promise<IndexedTransfer | null>;
  events(cursor: string | null, limit: number): Promise<EventsPage>;
  contract(): Promise<ContractView>;
}

export class HttpIndexerClient implements IndexerClient {
  constructor(private readonly baseUrl: string, private readonly timeoutMs = 5000) {}

  private async get<T>(path: string, schema: z.ZodType<T>, allow404 = false): Promise<T | null> {
    let res: Response;
    try {
      res = await fetch(this.baseUrl + path, { signal: AbortSignal.timeout(this.timeoutMs) });
    } catch {
      throw unavailable("INDEXER_UNREACHABLE", "indexer is not reachable");
    }
    if (res.status === 404 && allow404) return null;
    if (!res.ok) throw unavailable("INDEXER_ERROR", `indexer returned ${res.status}`);
    const parsed = schema.safeParse(await res.json());
    // Unknown shape => fail closed rather than guess.
    if (!parsed.success) throw unavailable("INDEXER_SCHEMA_MISMATCH", "indexer response did not match schema v1");
    return parsed.data;
  }

  status() { return this.get("/v1/status", indexerStatusSchema) as Promise<IndexerStatusView>; }
  pool(id: string) { return this.get(`/v1/pools/${enc(id)}`, poolSchema, true); }
  async poolRights(id: string) {
    const r = await this.get(`/v1/pools/${enc(id)}/rights`, poolRightsSchema, true);
    return r ? r.rights.map((x) => ({ ...x, indexerStatus: "SYNCED" as const, latestObservedLedger: 0 })) : null;
  }
  right(id: string) { return this.get(`/v1/rights/${enc(id)}`, rightSchema, true); }
  transfer(id: string) { return this.get(`/v1/transfers/${enc(id)}`, transferSchema, true); }
  contract() { return this.get("/v1/contract", contractSchema) as Promise<ContractView>; }
  events(cursor: string | null, limit: number) {
    const q = new URLSearchParams({ limit: String(limit), ...(cursor ? { cursor } : {}) });
    return this.get(`/v1/ledger/events?${q}`, eventsPageSchema) as Promise<EventsPage>;
  }
}
const enc = (s: string) => encodeURIComponent(s);
