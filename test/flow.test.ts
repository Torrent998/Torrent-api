import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { signedTxFor } from "./helpers.js";
import { ctxOf } from "./helpers-app.js";
import { makeWorld, seed, sign } from "./world.js";

const code = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as { code: string }).code; } return "OK"; };

describe("funding intent: DRAFT -> ... -> CONFIRMED", () => {
  it("walks the full path and confirms only when the indexer shows the event for that tx hash", async () => {
    const w = makeWorld(); const { alice, circleId } = await seed(w);
    const i = await w.funding.fundingIntent(ctxOf(alice), circleId, { amount: "1000" }, "fund-key-0001");
    expect(i.state).toBe("AWAITING_SIGNATURE");
    expect(i.descriptor).toMatchObject({ function: "deposit", args: [{ value: "1" }, { value: alice.principal.stellarAddress }, { value: "1000" }] });

    const sent = await w.intents.submit(ctxOf(alice), i.id, sign(i, alice));
    expect(sent.state).toBe("SUBMITTED");
    expect(w.sub.submitted).toHaveLength(1);

    // chain accepted but not yet indexed: must NOT be shown as settled
    expect((await w.intents.reconcile()).confirmed).toBe(0);
    expect(w.db.read().intents[i.id]!.state).toBe("SUBMITTED");

    w.idx.emit("funded", sent.txHash!, { poolId: "1" }, { amount: "1000" }, "SUBMITTED"); // seen but shallow
    await w.intents.reconcile();
    expect(w.db.read().intents[i.id]!.state).toBe("SUBMITTED");

    w.idx.log.at(-1)!.finality = "CONFIRMED"; // enough confirmations
    expect((await w.intents.reconcile()).confirmed).toBe(1);
    expect(w.db.read().intents[i.id]!.state).toBe("CONFIRMED");
    expect(w.db.read().intents[i.id]!.confirmedEventId).toBe(w.idx.log.at(-1)!.id);
  });

  it("is refused until a pool is bound, and for non-members", async () => {
    const w = makeWorld(); const { alice, outsider, circleId } = await seed(w);
    expect(await code(w.funding.fundingIntent(ctxOf(outsider), circleId, { amount: "5" }, "k-00000001"))).toBe("NOT_FOUND");
    const unbound = w.circles.create(ctxOf(alice), { name: "New", ruleSet: { ...(w.db.read().circles[circleId]!.ruleSet), rounds: 9 } });
    expect(await code(w.funding.fundingIntent(ctxOf(alice), unbound.id, { amount: "5" }, "k-00000002"))).toBe("POOL_NOT_BOUND");
  });

  it("is refused when the pool is paused or the indexer is halted/stale", async () => {
    const w = makeWorld(); const { alice, circleId } = await seed(w);
    w.idx.pools.get("1")!.status = "Paused";
    expect(await code(w.funding.fundingIntent(ctxOf(alice), circleId, { amount: "5" }, "k-00000003"))).toBe("POOL_PAUSED");
    w.idx.pools.get("1")!.status = "Active";
    w.idx.st = { ...w.idx.st, status: "RECONCILING" };
    expect(await code(w.funding.fundingIntent(ctxOf(alice), circleId, { amount: "5" }, "k-00000004"))).toBe("INDEXER_HALTED");
    w.idx.st = { ...w.idx.st, status: "SYNCING", lagLedgers: 99 };
    expect(await code(w.funding.fundingIntent(ctxOf(alice), circleId, { amount: "5" }, "k-00000005"))).toBe("INDEXER_STALE");
  });
});

describe("submit safety", () => {
  it("rejects a signed tx that differs from the approved intent and never sends it", async () => {
    const w = makeWorld(); const { alice, circleId } = await seed(w);
    const i = await w.funding.fundingIntent(ctxOf(alice), circleId, { amount: "1000" }, "fund-key-0002");
    const tampered = signedTxFor({ ...i.descriptor, args: i.descriptor.args.map((a) => (a.name === "amount" ? { ...a, value: "9999999" } : a)) }, alice.kp);
    expect(await code(w.intents.submit(ctxOf(alice), i.id, tampered))).toBe("TX_MISMATCH");
    expect(w.sub.submitted).toHaveLength(0);
    expect(w.db.read().intents[i.id]!.state).toBe("AWAITING_SIGNATURE");
  });
  it("rejects a tx signed by someone else, and submit by another user", async () => {
    const w = makeWorld(); const { alice, bob, circleId } = await seed(w);
    const i = await w.funding.fundingIntent(ctxOf(alice), circleId, { amount: "10" }, "fund-key-0003");
    expect(await code(w.intents.submit(ctxOf(alice), i.id, signedTxFor(i.descriptor, Keypair.random(), { source: alice.principal.stellarAddress })))).toBe("TX_MISMATCH");
    expect(await code(w.intents.submit(ctxOf(bob), i.id, sign(i, bob)))).toBe("FORBIDDEN");
  });
  it("re-submitting the same signed tx is idempotent; ", async () => {
    const w = makeWorld(); const { alice, circleId } = await seed(w);
    const i = await w.funding.fundingIntent(ctxOf(alice), circleId, { amount: "10" }, "fund-key-0004");
    const xdr = sign(i, alice);
    const a = await w.intents.submit(ctxOf(alice), i.id, xdr);
    const b = await w.intents.submit(ctxOf(alice), i.id, xdr);
    expect(b.txHash).toBe(a.txHash);
    expect(w.sub.submitted).toHaveLength(1); // exactly one network send
  });
  it("expired approval cannot be signed: intent fails and a new one is required", async () => {
    const w = makeWorld(); const { alice, circleId } = await seed(w);
    const i = await w.funding.fundingIntent(ctxOf(alice), circleId, { amount: "10" }, "fund-key-0005");
    w.clock.advance(901_000);
    expect(await code(w.intents.submit(ctxOf(alice), i.id, sign(i, alice)))).toBe("INTENT_EXPIRED");
    expect(w.db.read().intents[i.id]!).toMatchObject({ state: "FAILED", failureReason: "EXPIRED_BEFORE_SIGNATURE" });
    expect(await code(w.intents.submit(ctxOf(alice), i.id, sign(i, alice)))).toBe("INTENT_NOT_SUBMITTABLE");
  });
  it("definitive network rejection => FAILED", async () => {
    const w = makeWorld(); const { alice, circleId } = await seed(w);
    const i = await w.funding.fundingIntent(ctxOf(alice), circleId, { amount: "10" }, "fund-key-0006");
    w.sub.reject = true;
    const r = await w.intents.submit(ctxOf(alice), i.id, sign(i, alice));
    expect(r.state).toBe("FAILED");
    expect(r.failureReason).toMatch(/REJECTED/);
  });
});

describe("timeouts and reconciliation (never assume failure, never resend)", () => {
  it("timeout after send => stays SUBMITTED, then RECONCILING, then CONFIRMED when the event appears", async () => {
    const w = makeWorld(); const { alice, circleId } = await seed(w);
    const i = await w.funding.fundingIntent(ctxOf(alice), circleId, { amount: "10" }, "fund-key-0007");
    w.sub.networkError = true;
    const s = await w.intents.submit(ctxOf(alice), i.id, sign(i, alice));
    expect(s.state).toBe("SUBMITTED");
    expect(w.sub.submitted).toHaveLength(0);

    w.clock.advance(121_000);
    expect((await w.intents.reconcile()).reconciling).toBe(1);
    expect(w.db.read().intents[i.id]!.state).toBe("RECONCILING");
    expect(w.sub.submitted).toHaveLength(0); // no resend

    w.idx.emit("funded", s.txHash!, { poolId: "1" }, { amount: "10" });
    await w.intents.reconcile();
    expect(w.db.read().intents[i.id]!.state).toBe("CONFIRMED");
  });
  it("chain-reported execution failure => FAILED with reason", async () => {
    const w = makeWorld(); const { alice, circleId } = await seed(w);
    const i = await w.funding.fundingIntent(ctxOf(alice), circleId, { amount: "10" }, "fund-key-0008");
    const s = await w.intents.submit(ctxOf(alice), i.id, sign(i, alice));
    w.sub.statuses.set(s.txHash!, "FAILED");
    expect((await w.intents.reconcile()).failed).toBe(1);
    expect(w.db.read().intents[i.id]!.failureReason).toBe("CHAIN_EXECUTION_FAILED");
  });
  it("an unrelated event with a different tx hash never confirms the intent", async () => {
    const w = makeWorld(); const { alice, circleId } = await seed(w);
    const i = await w.funding.fundingIntent(ctxOf(alice), circleId, { amount: "10" }, "fund-key-0009");
    await w.intents.submit(ctxOf(alice), i.id, sign(i, alice));
    w.idx.emit("funded", "someone-elses-tx", { poolId: "1" });
    await w.intents.reconcile();
    expect(w.db.read().intents[i.id]!.state).toBe("SUBMITTED");
  });
  it("unsigned intents expire during reconcile", async () => {
    const w = makeWorld(); const { alice, circleId } = await seed(w);
    const i = await w.funding.fundingIntent(ctxOf(alice), circleId, { amount: "10" }, "fund-key-0010");
    w.clock.advance(901_000);
    expect((await w.intents.reconcile()).expired).toBe(1);
    expect(w.db.read().intents[i.id]!.state).toBe("FAILED");
  });
  it("reconcile is idempotent", async () => {
    const w = makeWorld(); const { alice, circleId } = await seed(w);
    const i = await w.funding.fundingIntent(ctxOf(alice), circleId, { amount: "10" }, "fund-key-0011");
    const s = await w.intents.submit(ctxOf(alice), i.id, sign(i, alice));
    w.idx.emit("funded", s.txHash!, { poolId: "1" });
    await w.intents.reconcile();
    const first = JSON.stringify(w.db.read().intents[i.id]);
    expect((await w.intents.reconcile()).confirmed).toBe(0);
    expect(JSON.stringify(w.db.read().intents[i.id])).toBe(first);
  });
});

describe("coverage is ledger-derived", () => {
  it("returns indexer totals and freshness, not API data", async () => {
    const w = makeWorld(); const { alice, circleId } = await seed(w);
    w.idx.pools.get("1")!.totals = { funded: "1000", reserved: "600", claimed: "0", withdrawn: "0" };
    w.idx.pools.get("1")!.coverage = { unreserved: "400", fullyBacked: true };
    const c = await w.funding.coverage(ctxOf(alice), circleId);
    expect(c).toMatchObject({ bound: true, unreserved: "400", fullyBacked: true, indexerStatus: "SYNCED", asOfLedger: 1000 });
  });
});
