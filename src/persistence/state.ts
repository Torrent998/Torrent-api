import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, openSync, fsyncSync, closeSync } from "node:fs";
import { dirname } from "node:path";
import type { Intent } from "../domain/intent.js";
import type { RuleSet } from "../domain/rules.js";

export interface CircleMember {
  userId: string;
  address: string;
  role: "ORGANIZER" | "MEMBER";
  joinedAt: string;
}
export interface Circle {
  id: string;
  name: string;
  organizerUserId: string;
  organizerAddress: string;
  ruleSet: RuleSet;
  policyHash: string;
  /** Bound from the indexer once a pool with this policy hash and controller exists on-chain. */
  poolId: string | null;
  members: CircleMember[];
  createdAt: string;
  updatedAt: string;
}
export interface Invitation {
  id: string;
  circleId: string;
  /** sha256 of the secret token; the token itself is shown once and never stored. */
  tokenHash: string;
  label: string;
  status: "PENDING" | "ACCEPTED" | "REVOKED";
  expiresAt: string;
  createdBy: string;
  createdAt: string;
}
/** Off-chain agreement history for one right transfer. On-chain state lives in the contract. */
export interface TransferRecord {
  id: string;
  circleId: string;
  rightId: string;
  fromAddress: string;
  toAddress: string;
  expiresAt: string;
  proposeIntentId: string;
  acceptIntentId: string | null;
  /** Proposer's cancel_transfer intent (optional for records written before it existed). */
  cancelIntentId?: string | null;
  chainTransferId: string | null;
  createdAt: string;
}
export interface IdempotencyRecord {
  fingerprint: string;
  statusCode: number;
  body: unknown;
  createdAt: string;
}
export interface AuditEvent {
  id: string;
  at: string;
  actor: string;
  scope: string;
  action: string;
  object: string;
  requestId: string;
}
/** Minimal projection of an indexer event, enough to confirm intents by tx hash. */
export interface ObservedEvent {
  id: string;
  name: string;
  txHash: string;
  ledger: number;
  refs: Record<string, string | undefined>;
}

export interface AuthChallenge {
  id: string; address: string; nonce: string; message: string; expiresAt: string; used: boolean;
}
export interface SessionRecord {
  id: string; tokenHash: string; userId: string; address: string; roles: ("user" | "auditor")[]; createdAt: string; expiresAt: string; revoked: boolean;
}

export interface AppState {
  schemaVersion: 1;
  circles: Record<string, Circle>;
  invitations: Record<string, Invitation>;
  intents: Record<string, Intent>;
  transfers: Record<string, TransferRecord>;
  idempotency: Record<string, IdempotencyRecord>;
  audit: AuditEvent[];
  /** Wallet-signature login: one-time challenges and issued sessions (token stored as sha256). */
  authChallenges: Record<string, AuthChallenge>;
  sessions: Record<string, SessionRecord>;
  ledger: { cursor: string | null; byTx: Record<string, ObservedEvent[]>; pools: Record<string, { controller: string; policyHash: string; token: string }> };
}

export const emptyState = (): AppState => ({
  schemaVersion: 1, circles: {}, invitations: {}, intents: {}, transfers: {}, idempotency: {}, audit: [], authChallenges: {}, sessions: {},
  ledger: { cursor: null, byTx: {}, pools: {} },
});

export interface StatePersistence {
  load(): AppState | null;
  save(s: AppState): void;
}

export class MemoryPersistence implements StatePersistence {
  private s: AppState | null = null;
  load() { return this.s ? structuredClone(this.s) : null; }
  save(s: AppState) { this.s = structuredClone(s); }
}

/** Atomic single-file persistence (temp + fsync + rename). Whole-file rewrite; swap for PostgreSQL later. */
export class FilePersistence implements StatePersistence {
  constructor(private readonly path: string) {}
  load(): AppState | null {
    if (!existsSync(this.path)) return null;
    const s = JSON.parse(readFileSync(this.path, "utf8")) as AppState;
    if (s.schemaVersion !== 1) throw new Error(`unsupported state schemaVersion ${String(s.schemaVersion)}`);
    return { ...emptyState(), ...s };
  }
  save(s: AppState): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(s));
    const fd = openSync(tmp, "r+");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, this.path);
  }
}

/** Single-process unit of work: the mutation runs on a copy and is committed only if it does not throw. */
export class Database {
  private state: AppState;
  constructor(private readonly p: StatePersistence) {
    this.state = p.load() ?? emptyState();
  }
  read(): Readonly<AppState> { return this.state; }
  mutate<T>(fn: (s: AppState) => T): T {
    const draft = structuredClone(this.state);
    const out = fn(draft);
    this.p.save(draft); // persist first: if it throws, in-memory state is unchanged
    this.state = draft;
    return out;
  }
}
