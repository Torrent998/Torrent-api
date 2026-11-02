import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS, SqlitePersistence } from "../src/persistence/sqlite.js";
import { Database, emptyState, type Circle } from "../src/persistence/state.js";
import { rules } from "./world.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const path = () => { const d = mkdtempSync(join(tmpdir(), "torrent-sqlite-")); dirs.push(d); return join(d, "api.db"); };
const circle = (id: string): Circle => ({ id, name: id, organizerUserId: "u", organizerAddress: "G" + "A".repeat(55), ruleSet: rules, policyHash: "h", poolId: null, members: [], createdAt: "t", updatedAt: "t" });

describe("SqlitePersistence", () => {
  it("applies migrations once and reports the schema version", () => {
    const p = path();
    const a = new SqlitePersistence(p); expect(a.schemaVersion).toBe(MIGRATIONS.at(-1)!.version); a.close();
    const b = new SqlitePersistence(p); expect(b.schemaVersion).toBe(MIGRATIONS.at(-1)!.version); b.close();
  });
  it("round-trips state across a reopen (durable)", () => {
    const p = path();
    const a = new SqlitePersistence(p);
    const db = new Database(a);
    db.mutate((s) => {
      s.circles["c1"] = circle("c1"); s.ledger.cursor = "cur";
      s.audit.push({ id: "a1", at: "t", actor: "x", scope: "s", action: "act", object: "o", requestId: "r" });
    });
    a.close();
    const b = new SqlitePersistence(p);
    const back = new Database(b).read();
    expect(back.circles["c1"]!.name).toBe("c1");
    expect(back.ledger.cursor).toBe("cur");
    expect(back.audit.map((x) => x.id)).toEqual(["a1"]);
    b.close();
  });
  it("persists updates and deletions, writing only changed rows", () => {
    const p = new SqlitePersistence(":memory:");
    const s = emptyState();
    s.circles["c1"] = circle("c1"); s.circles["c2"] = circle("c2");
    p.save(s);
    s.circles["c1"]!.name = "renamed"; delete s.circles["c2"];
    p.save(s);
    const back = p.load()!;
    expect(Object.keys(back.circles)).toEqual(["c1"]);
    expect(back.circles["c1"]!.name).toBe("renamed");
  });
  it("audit is append-only: removing entries from state does not delete history", () => {
    const p = new SqlitePersistence(":memory:");
    const s = emptyState();
    s.audit.push({ id: "a1", at: "t", actor: "x", scope: "s", action: "x", object: "o", requestId: "r" });
    p.save(s);
    s.audit = [];
    p.save(s);
    expect(p.load()!.audit).toHaveLength(1);
  });
  it("a failing save rolls back completely", () => {
    const p = new SqlitePersistence(":memory:");
    const s = emptyState();
    s.circles["c1"] = circle("c1");
    s.audit.push({ id: "dup", at: "t", actor: "x", scope: "s", action: "x", object: "o", requestId: "r" });
    p.save(s);
    const bad = emptyState();
    bad.circles["c1"] = circle("c1"); bad.circles["c9"] = circle("c9");
    // force a unique-constraint failure on the audit table
    (p as unknown as { lastAuditIds: Set<string> }).lastAuditIds.clear();
    bad.audit.push({ id: "dup", at: "t", actor: "x", scope: "s", action: "x", object: "o", requestId: "r" });
    expect(() => p.save(bad)).toThrow();
    expect(Object.keys(p.load()!.circles)).toEqual(["c1"]);
  });
  it("Database unit of work keeps memory unchanged when the SQLite write fails", () => {
    const p = new SqlitePersistence(":memory:");
    const db = new Database(p);
    db.mutate((s) => { s.circles["c1"] = circle("c1"); });
    p.close();
    expect(() => db.mutate((s) => { s.circles["c2"] = circle("c2"); })).toThrow();
    expect(Object.keys(db.read().circles)).toEqual(["c1"]);
  });
  it("empty database loads as null (fresh install)", () => {
    expect(new SqlitePersistence(":memory:").load()).toBeNull();
  });
});
