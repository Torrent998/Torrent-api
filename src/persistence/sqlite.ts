import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { emptyState, type AppState, type StatePersistence } from "./state.js";

/** Ordered, append-only migrations. Never edit an applied one; add a new entry. */
export const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE circles (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE invitations (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE intents (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE transfers (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE idempotency (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, body TEXT NOT NULL);
      CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE auth_challenges (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, body TEXT NOT NULL);
    `,
  },
];

const MAP_TABLES = ["circles", "invitations", "intents", "transfers", "idempotency", "auth_challenges", "sessions"] as const;
type MapTable = (typeof MAP_TABLES)[number];

/**
 * Durable SQLite persistence (node:sqlite, WAL). `save` writes only rows that changed since the
 * last load/save, inside one transaction: a failure leaves the database at the previous state.
 * node:sqlite is marked experimental by Node; pin the Node version and watch release notes.
 */
export class SqlitePersistence implements StatePersistence {
  private readonly db: DatabaseSync;
  private last = new Map<string, string>(); // "table:id" -> serialized body
  private lastAuditIds = new Set<string>();

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    const done = new Set((this.db.prepare("SELECT version FROM schema_migrations").all() as { version: number }[]).map((r) => r.version));
    for (const m of MIGRATIONS) {
      if (done.has(m.version)) continue;
      this.db.exec("BEGIN");
      try {
        this.db.exec(m.sql);
        this.db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(m.version, new Date().toISOString());
        this.db.exec("COMMIT");
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
    }
  }

  get schemaVersion(): number {
    return (this.db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number }).v;
  }

  close(): void { this.db.close(); }

  load(): AppState | null {
    const s = emptyState() as AppState & Record<string, unknown>;
    this.last.clear();
    let any = false;
    const mapOf = (t: MapTable): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      for (const r of this.db.prepare(`SELECT id, body FROM ${t}`).all() as { id: string; body: string }[]) {
        out[r.id] = JSON.parse(r.body); this.last.set(`${t}:${r.id}`, r.body); any = true;
      }
      return out;
    };
    s.circles = mapOf("circles") as AppState["circles"];
    s.invitations = mapOf("invitations") as AppState["invitations"];
    s.intents = mapOf("intents") as AppState["intents"];
    s.transfers = mapOf("transfers") as AppState["transfers"];
    s.idempotency = mapOf("idempotency") as AppState["idempotency"];
    s.authChallenges = mapOf("auth_challenges") as AppState["authChallenges"];
    s.sessions = mapOf("sessions") as AppState["sessions"];
    s.audit = (this.db.prepare("SELECT id, body FROM audit ORDER BY seq").all() as { id: string; body: string }[]).map((r) => {
      this.lastAuditIds.add(r.id); any = true; return JSON.parse(r.body);
    });
    const kv = this.db.prepare("SELECT v FROM kv WHERE k = 'ledger'").get() as { v: string } | undefined;
    if (kv) { s.ledger = JSON.parse(kv.v); this.last.set("kv:ledger", kv.v); any = true; }
    return any ? s : null;
  }

  save(s: AppState): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const seen = new Set<string>();
      const maps: Record<MapTable, Record<string, unknown>> = {
        circles: s.circles, invitations: s.invitations, intents: s.intents, transfers: s.transfers,
        idempotency: s.idempotency, auth_challenges: s.authChallenges, sessions: s.sessions,
      };
      const pending: [string, string][] = [];
      for (const t of MAP_TABLES) {
        const up = this.db.prepare(`INSERT INTO ${t} (id, body) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body`);
        for (const [id, v] of Object.entries(maps[t])) {
          const key = `${t}:${id}`; const body = JSON.stringify(v); seen.add(key);
          if (this.last.get(key) !== body) { up.run(id, body); pending.push([key, body]); }
        }
        const del = this.db.prepare(`DELETE FROM ${t} WHERE id = ?`);
        for (const key of [...this.last.keys()]) if (key.startsWith(`${t}:`) && !seen.has(key)) { del.run(key.slice(t.length + 1)); pending.push([key, ""]); }
      }
      // audit is append-only: never updated or deleted.
      const ins = this.db.prepare("INSERT INTO audit (id, body) VALUES (?, ?)");
      const newAudit: string[] = [];
      for (const a of s.audit) if (!this.lastAuditIds.has(a.id)) { ins.run(a.id, JSON.stringify(a)); newAudit.push(a.id); }
      const ledger = JSON.stringify(s.ledger);
      if (this.last.get("kv:ledger") !== ledger) {
        this.db.prepare("INSERT INTO kv (k, v) VALUES ('ledger', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(ledger);
        pending.push(["kv:ledger", ledger]);
      }
      this.db.exec("COMMIT");
      for (const [k, b] of pending) { if (b === "") this.last.delete(k); else this.last.set(k, b); }
      for (const id of newAudit) this.lastAuditIds.add(id);
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
}
