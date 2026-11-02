import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StaticTokenVerifier } from "../src/auth/auth.js";
import { Database, FilePersistence, MemoryPersistence } from "../src/persistence/state.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const path = () => { const d = mkdtempSync(join(tmpdir(), "torrent-api-")); dirs.push(d); return join(d, "s.json"); };

describe("Database unit of work", () => {
  it("commits on success and rolls back when the mutation throws", () => {
    const db = new Database(new MemoryPersistence());
    db.mutate((s) => { s.ledger.cursor = "a"; });
    expect(() => db.mutate((s) => { s.ledger.cursor = "b"; throw new Error("boom"); })).toThrow("boom");
    expect(db.read().ledger.cursor).toBe("a");
  });
  it("keeps memory unchanged when persistence fails", () => {
    let fail = false;
    const mem = new MemoryPersistence();
    const db = new Database({ load: () => mem.load(), save: (s) => { if (fail) throw new Error("disk full"); mem.save(s); } });
    db.mutate((s) => { s.ledger.cursor = "a"; });
    fail = true;
    expect(() => db.mutate((s) => { s.ledger.cursor = "b"; })).toThrow("disk full");
    expect(db.read().ledger.cursor).toBe("a");
  });
  it("survives restart through the file and ignores a torn temp file", () => {
    const p = path();
    new Database(new FilePersistence(p)).mutate((s) => { s.ledger.cursor = "x"; });
    writeFileSync(`${p}.tmp`, "{ torn");
    expect(new Database(new FilePersistence(p)).read().ledger.cursor).toBe("x");
  });
  it("refuses an unknown state schema version", () => {
    const p = path();
    writeFileSync(p, JSON.stringify({ schemaVersion: 2 }));
    expect(() => new Database(new FilePersistence(p))).toThrow(/schemaVersion/);
    expect(readFileSync(p, "utf8")).toContain("2");
  });
});

describe("StaticTokenVerifier (dev adapter)", () => {
  const v = new StaticTokenVerifier({ "tok-alice-0123456789abcdef": { userId: "u1", stellarAddress: "G" + "A".repeat(55), roles: ["user"] } });
  it("accepts the exact token only", () => {
    expect(v.verify("tok-alice-0123456789abcdef")?.userId).toBe("u1");
    expect(v.verify("tok-alice-0123456789abcdeg")).toBeNull();
    expect(v.verify("")).toBeNull();
  });
});
