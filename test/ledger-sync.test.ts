import { describe, expect, it } from "vitest";
import { AuditService } from "../src/modules/audit.service.js";
import { CircleService } from "../src/modules/circle.service.js";
import { LedgerSyncService } from "../src/modules/ledger-sync.service.js";
import { FakeIndexer } from "./fakes.js";
import { TOKEN_ID } from "./helpers.js";
import { actor, ctxOf, newDb, TestClock, testConfig } from "./helpers-app.js";

const rules = { tokenContractId: TOKEN_ID, maxMembers: 3, rounds: 3, roundLengthDays: 30, contributionAmount: "100", transferPolicy: "MEMBERS_ONLY" as const };
function setup() {
  const db = newDb(); const clock = new TestClock(); const idx = new FakeIndexer(); const cfg = testConfig();
  const audit = new AuditService(db, clock);
  return { db, idx, circles: new CircleService(db, clock, audit, cfg), sync: new LedgerSyncService(db, idx, clock, cfg) };
}
const code = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as { code: string }).code; } return "OK"; };

describe("pool binding by policy hash", () => {
  it("binds a circle to the pool whose controller, token and policy hash match", async () => {
    const { circles, idx, sync, db } = setup(); const a = actor("alice");
    const c = circles.create(ctxOf(a), { name: "Ajo", ruleSet: rules });
    idx.addPool({ poolId: "7", controller: a.principal.stellarAddress, token: TOKEN_ID, membershipPolicyHash: c.policyHash });
    await sync.sync();
    expect(db.read().circles[c.id]!.poolId).toBe("7");
    expect(db.read().audit.some((e) => e.action === "pool.bind")).toBe(true);
  });
  it("never binds on a mismatching controller, token or hash", async () => {
    const { circles, idx, sync, db } = setup(); const a = actor("alice"); const mallory = actor("mallory");
    const c = circles.create(ctxOf(a), { name: "Ajo", ruleSet: rules });
    idx.addPool({ poolId: "1", controller: mallory.principal.stellarAddress, token: TOKEN_ID, membershipPolicyHash: c.policyHash });
    idx.addPool({ poolId: "2", controller: a.principal.stellarAddress, token: "C" + "B".repeat(55), membershipPolicyHash: c.policyHash });
    idx.addPool({ poolId: "3", controller: a.principal.stellarAddress, token: TOKEN_ID, membershipPolicyHash: "00".repeat(32) });
    await sync.sync();
    expect(db.read().circles[c.id]!.poolId).toBeNull();
  });
  it("refuses to guess when two pools match (ambiguous)", async () => {
    const { circles, idx, sync, db } = setup(); const a = actor("alice");
    const c = circles.create(ctxOf(a), { name: "Ajo", ruleSet: rules });
    for (const id of ["1", "2"]) idx.addPool({ poolId: id, controller: a.principal.stellarAddress, token: TOKEN_ID, membershipPolicyHash: c.policyHash });
    await sync.sync();
    expect(db.read().circles[c.id]!.poolId).toBeNull();
    expect(db.read().audit.some((e) => e.action === "pool.bind.ambiguous")).toBe(true);
  });
});

describe("event absorption", () => {
  it("only absorbs CONFIRMED events and resumes before the first unconfirmed one", async () => {
    const { idx, sync, db } = setup();
    idx.emit("funded", "tx1", { poolId: "1" });
    idx.emit("funded", "tx2", { poolId: "1" }, {}, "SUBMITTED");
    await sync.sync();
    expect(Object.keys(db.read().ledger.byTx)).toEqual(["tx1"]);
    idx.log[1]!.finality = "CONFIRMED"; // gained confirmations
    await sync.sync();
    expect(Object.keys(db.read().ledger.byTx).sort()).toEqual(["tx1", "tx2"]);
  });
  it("is idempotent when synced twice", async () => {
    const { idx, sync, db } = setup();
    idx.emit("funded", "tx1", { poolId: "1" });
    await sync.sync(); await sync.sync();
    expect(db.read().ledger.byTx["tx1"]).toHaveLength(1);
  });
  it("ignores events of other contracts", async () => {
    const { idx, sync, db } = setup();
    idx.emit("funded", "tx1", { poolId: "1" }).contractId = "C" + "Z".repeat(55);
    await sync.sync();
    expect(db.read().ledger.byTx).toEqual({});
  });
});

describe("health gate (fail closed)", () => {
  it("refuses while the indexer is halted, stale, or on another network", async () => {
    const { idx, sync } = setup();
    await expect(sync.assertHealthy()).resolves.toBeTruthy();
    idx.st = { ...idx.st, status: "RECONCILING" };
    expect(await code(sync.assertHealthy())).toBe("INDEXER_HALTED");
    idx.st = { ...idx.st, status: "SYNCING", lagLedgers: 50 };
    expect(await code(sync.assertHealthy())).toBe("INDEXER_STALE");
    idx.st = { ...idx.st, status: "SYNCED", lagLedgers: 0, network: "mainnet" };
    expect(await code(sync.assertHealthy())).toBe("NETWORK_MISMATCH");
  });
});
