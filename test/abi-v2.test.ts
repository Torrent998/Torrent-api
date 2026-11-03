import { describe, expect, it } from "vitest";
import { ctxOf } from "./helpers-app.js";
import { makeWorld, seed, sign, type World } from "./world.js";

/** torrent-escrow ABI v2: closed pools, timing rules, cancel_transfer and leave_pool intents. */
const code = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as { code: string }).code; } return "OK"; };
const iso = (w: World, ms: number) => new Date(w.clock.t + ms).toISOString();
const nowS = (w: World) => Math.floor(w.clock.t / 1000);

async function withRight(w: World, maturityIn = 86400) {
  const s = await seed(w);
  w.idx.addRight({ rightId: "5", poolId: "1", owner: s.bob.principal.stellarAddress, maturity: nowS(w) + maturityIn });
  return s;
}

/** bob proposes right 5 to carol and the proposal is confirmed on-chain as transfer 77. */
async function confirmedProposal(w: World) {
  const s = await withRight(w);
  const { transfer, intent } = await w.rights.transferIntent(ctxOf(s.bob), "5", { toAddress: s.carol.principal.stellarAddress, expiresAt: iso(w, 3600_000) }, "tk-v2-prop-01");
  const sent = await w.intents.submit(ctxOf(s.bob), intent.id, sign(intent, s.bob));
  w.idx.emit("transfer_proposed", sent.txHash!, { rightId: "5", transferId: "77" });
  w.idx.rights.get("5")!.pendingTransfer = "77";
  w.idx.transfers.set("77", { transferId: "77", rightId: "5", from: s.bob.principal.stellarAddress, to: s.carol.principal.stellarAddress, expiry: nowS(w) + 3600, status: "Pending", indexerStatus: "SYNCED", latestObservedLedger: 1 });
  await w.intents.reconcile();
  return { ...s, transfer };
}

describe("closed pools", () => {
  it("refuse funding and transfer proposals, but claims stay possible", async () => {
    const w = makeWorld(); const { bob, carol, circleId } = await withRight(w, 60);
    w.idx.pools.get("1")!.status = "Closed";
    expect(await code(w.funding.fundingIntent(ctxOf(bob), circleId, { amount: "100" }, "tk-v2-fund-01"))).toBe("POOL_CLOSED");
    expect(await code(w.rights.transferIntent(ctxOf(bob), "5", { toAddress: carol.principal.stellarAddress, expiresAt: iso(w, 30_000) }, "tk-v2-xfer-01"))).toBe("POOL_CLOSED");
    w.clock.advance(61_000);
    expect((await w.rights.claimIntent(ctxOf(bob), "5", "tk-v2-claim-01")).intent.descriptor.function).toBe("claim");
  });
  it("coverage reports the Closed status from the indexer", async () => {
    const w = makeWorld(); const { bob, circleId } = await seed(w);
    w.idx.pools.get("1")!.status = "Closed";
    expect(await w.funding.coverage(ctxOf(bob), circleId)).toMatchObject({ bound: true, poolStatus: "Closed" });
  });
});

describe("transfer timing rules mirror the contract", () => {
  it("a matured right cannot be offered and an offer may not outlive maturity", async () => {
    const w = makeWorld(); const { bob, carol } = await withRight(w, 3600);
    const to = carol.principal.stellarAddress;
    expect(await code(w.rights.transferIntent(ctxOf(bob), "5", { toAddress: to, expiresAt: iso(w, 3601_000) }, "tk-v2-time-01"))).toBe("INVALID_EXPIRY");
    expect(await code(w.rights.transferIntent(ctxOf(bob), "5", { toAddress: to, expiresAt: iso(w, 3600_000) }, "tk-v2-time-02"))).toBe("OK");
    w.clock.advance(3600_000);
    w.idx.rights.get("5")!.pendingTransfer = null;
    expect(await code(w.rights.transferIntent(ctxOf(bob), "5", { toAddress: to, expiresAt: iso(w, 60_000) }, "tk-v2-time-03"))).toBe("RIGHT_MATURED");
  });
  it("approval is refused once the right matured or the pool stopped being active", async () => {
    for (const mutate of [
      (w: World) => { w.idx.rights.get("5")!.maturity = nowS(w); },
      (w: World) => { w.idx.pools.get("1")!.status = "Closed"; },
      (w: World) => { w.idx.pools.get("1")!.status = "Paused"; },
    ]) {
      const w = makeWorld(); const { carol, transfer } = await confirmedProposal(w);
      mutate(w);
      expect(["STALE_TRANSFER", "POOL_CLOSED", "POOL_PAUSED"]).toContain(await code(w.rights.approve(ctxOf(carol), transfer.id, "tk-v2-appr-01")));
    }
  });
});

describe("cancel_transfer intent", () => {
  it("only the proposer, only once the proposal is on-chain and still pending", async () => {
    const w = makeWorld(); const s = await withRight(w);
    const { transfer } = await w.rights.transferIntent(ctxOf(s.bob), "5", { toAddress: s.carol.principal.stellarAddress, expiresAt: iso(w, 3600_000) }, "tk-v2-c-00");
    expect(await code(w.rights.cancel(ctxOf(s.bob), transfer.id, "tk-v2-c-01"))).toBe("PROPOSAL_NOT_CONFIRMED");
    expect(await code(w.rights.cancel(ctxOf(s.outsider), transfer.id, "tk-v2-c-02"))).toBe("NOT_FOUND");
    expect(await code(w.rights.cancel(ctxOf(s.carol), transfer.id, "tk-v2-c-03"))).toBe("FORBIDDEN");
  });

  it("creates cancel_transfer(transfer_id), is idempotent, and confirms on transfer_cancelled", async () => {
    const w = makeWorld(); const { bob, carol, circleId, transfer } = await confirmedProposal(w);
    const { intent } = await w.rights.cancel(ctxOf(bob), transfer.id, "tk-v2-c-10");
    expect(intent).toMatchObject({ kind: "TRANSFER_CANCEL", state: "AWAITING_SIGNATURE" });
    expect(intent.descriptor).toMatchObject({ function: "cancel_transfer", args: [{ name: "transfer_id", type: "u64", value: "77" }] });
    expect((await w.rights.cancel(ctxOf(bob), transfer.id, "tk-v2-c-11")).intent.id).toBe(intent.id);
    expect(w.rights.listTransfers(ctxOf(carol), circleId)[0]!.status).toBe("CANCELLING");
    expect(w.rights.currentIntentId(ctxOf(bob), transfer.id)).toBe(intent.id);
    const sent = await w.intents.submit(ctxOf(bob), intent.id, sign(intent, bob));
    w.idx.emit("transfer_cancelled", sent.txHash!, { rightId: "5", transferId: "77" });
    await w.intents.reconcile();
    expect(w.db.read().intents[intent.id]!.state).toBe("CONFIRMED");
    expect(w.rights.listTransfers(ctxOf(carol), circleId)[0]!).toMatchObject({ status: "CANCELLED", cancelIntentId: intent.id });
  });

  it("refuses when the chain says the offer is no longer pending", async () => {
    const w = makeWorld(); const { bob, transfer } = await confirmedProposal(w);
    w.idx.transfers.get("77")!.status = "Completed";
    expect(await code(w.rights.cancel(ctxOf(bob), transfer.id, "tk-v2-c-20"))).toBe("STALE_TRANSFER");
  });
});

describe("leave_pool intent", () => {
  it("is refused while the member owns an unclaimed right, or for non-members", async () => {
    const w = makeWorld(); const { alice, bob, circleId } = await withRight(w);
    expect(await code(w.funding.leaveIntent(ctxOf(bob), circleId, "tk-v2-l-01"))).toBe("MEMBER_HAS_RIGHTS");
    // alice organizes the circle but is the pool controller, not a pool member
    expect(await code(w.funding.leaveIntent(ctxOf(alice), circleId, "tk-v2-l-02"))).toBe("NOT_POOL_MEMBER");
  });

  it("builds leave_pool(pool_id, member) and confirms on member_left", async () => {
    const w = makeWorld(); const { bob, carol, circleId } = await withRight(w);
    const i = await w.funding.leaveIntent(ctxOf(carol), circleId, "tk-v2-l-10");
    expect(i).toMatchObject({ kind: "POOL_LEAVE", state: "AWAITING_SIGNATURE" });
    expect(i.descriptor.args).toEqual([
      { name: "pool_id", type: "u64", value: "1" },
      { name: "member", type: "address", value: carol.principal.stellarAddress },
    ]);
    const sent = await w.intents.submit(ctxOf(carol), i.id, sign(i, carol));
    w.idx.emit("member_left", sent.txHash!, { poolId: "1" }, { member: carol.principal.stellarAddress });
    await w.intents.reconcile();
    expect(w.db.read().intents[i.id]!.state).toBe("CONFIRMED");
    // a claimed right no longer blocks leaving
    w.idx.rights.get("5")!.state = "Claimed";
    expect((await w.funding.leaveIntent(ctxOf(bob), circleId, "tk-v2-l-11")).kind).toBe("POOL_LEAVE");
  });

  it("requires a bound pool", async () => {
    const w = makeWorld(); const { bob } = await seed(w);
    const c = w.circles.create(ctxOf(bob), { name: "Unbound", ruleSet: (await import("./world.js")).rules });
    expect(await code(w.funding.leaveIntent(ctxOf(bob), c.id, "tk-v2-l-20"))).toBe("POOL_NOT_BOUND");
  });
});
