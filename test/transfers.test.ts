import { describe, expect, it } from "vitest";
import { ctxOf } from "./helpers-app.js";
import { makeWorld, seed, sign, type World } from "./world.js";

const code = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as { code: string }).code; } return "OK"; };
const iso = (w: World, ms: number) => new Date(w.clock.t + ms).toISOString();

async function withRight(w: World) {
  const s = await seed(w);
  w.idx.addRight({ rightId: "5", poolId: "1", owner: s.alice.principal.stellarAddress, maturity: Math.floor(w.clock.t / 1000) + 86400 });
  return s;
}

describe("transfer intent: authorization is ledger-derived and checked before any signature", () => {
  it("only the on-chain owner can propose; non-members cannot even see the right", async () => {
    const w = makeWorld(); const { alice, bob, outsider } = await withRight(w);
    const body = { toAddress: bob.principal.stellarAddress, expiresAt: iso(w, 3600_000) };
    expect(await code(w.rights.transferIntent(ctxOf(bob), "5", { ...body, toAddress: alice.principal.stellarAddress }, "tk-00000001"))).toBe("FORBIDDEN");
    expect(await code(w.rights.transferIntent(ctxOf(outsider), "5", body, "tk-00000002"))).toBe("NOT_FOUND");
    expect(await code(w.rights.transferIntent(ctxOf(alice), "404", body, "tk-00000003"))).toBe("NOT_FOUND");
    expect((await w.rights.transferIntent(ctxOf(alice), "5", body, "tk-00000004")).intent.state).toBe("AWAITING_SIGNATURE");
  });
  it("stale API data cannot grant ownership: after an on-chain move the old owner is refused", async () => {
    const w = makeWorld(); const { alice, bob } = await withRight(w);
    w.idx.rights.get("5")!.owner = bob.principal.stellarAddress; // chain truth changed
    expect(await code(w.rights.transferIntent(ctxOf(alice), "5", { toAddress: bob.principal.stellarAddress, expiresAt: iso(w, 3600_000) }, "tk-00000005"))).toBe("FORBIDDEN");
  });
  it("validates recipient, expiry, right state and pool state", async () => {
    const w = makeWorld(); const { alice, bob, outsider } = await withRight(w);
    const ok = { toAddress: bob.principal.stellarAddress, expiresAt: iso(w, 3600_000) };
    expect(await code(w.rights.transferIntent(ctxOf(alice), "5", { ...ok, toAddress: outsider.principal.stellarAddress }, "tk-00000006"))).toBe("RECIPIENT_NOT_ELIGIBLE");
    expect(await code(w.rights.transferIntent(ctxOf(alice), "5", { ...ok, toAddress: alice.principal.stellarAddress }, "tk-00000007"))).toBe("SAME_OWNER");
    expect(await code(w.rights.transferIntent(ctxOf(alice), "5", { ...ok, expiresAt: iso(w, -1000) }, "tk-00000008"))).toBe("INVALID_EXPIRY");
    expect(await code(w.rights.transferIntent(ctxOf(alice), "5", { ...ok, expiresAt: iso(w, 40 * 86400_000) }, "tk-00000009"))).toBe("INVALID_EXPIRY");
    w.idx.pools.get("1")!.status = "Paused";
    expect(await code(w.rights.transferIntent(ctxOf(alice), "5", ok, "tk-00000010"))).toBe("POOL_PAUSED");
    w.idx.pools.get("1")!.status = "Active";
    w.idx.rights.get("5")!.state = "Claimed";
    expect(await code(w.rights.transferIntent(ctxOf(alice), "5", ok, "tk-00000011"))).toBe("RIGHT_NOT_ACTIVE");
  });
  it("refuses a second proposal while a live one is open, allows it once expired", async () => {
    const w = makeWorld(); const { alice, bob } = await withRight(w);
    const ok = { toAddress: bob.principal.stellarAddress, expiresAt: iso(w, 3600_000) };
    w.idx.rights.get("5")!.pendingTransfer = "9";
    w.idx.transfers.set("9", { transferId: "9", rightId: "5", from: alice.principal.stellarAddress, to: bob.principal.stellarAddress, expiry: Math.floor(w.clock.t / 1000) + 600, status: "Pending", indexerStatus: "SYNCED", latestObservedLedger: 1 });
    expect(await code(w.rights.transferIntent(ctxOf(alice), "5", ok, "tk-00000012"))).toBe("TRANSFER_ALREADY_PENDING");
    w.idx.transfers.get("9")!.expiry = Math.floor(w.clock.t / 1000) - 1;
    expect(await code(w.rights.transferIntent(ctxOf(alice), "5", ok, "tk-00000013"))).toBe("OK");
  });
});

describe("two-step transfer: propose (owner) then approve/accept (recipient)", () => {
  async function proposed(w: World) {
    const s = await withRight(w);
    const { transfer, intent } = await w.rights.transferIntent(ctxOf(s.alice), "5", { toAddress: s.bob.principal.stellarAddress, expiresAt: iso(w, 3600_000) }, "tk-flow-0001");
    const sent = await w.intents.submit(ctxOf(s.alice), intent.id, sign(intent, s.alice));
    return { ...s, transfer, intent, sent };
  }

  it("full path: proposal confirmed on-chain -> recipient approval -> accept signed -> completed", async () => {
    const w = makeWorld(); const { alice, bob, transfer, intent, sent } = await proposed(w);
    expect(w.rights.currentIntentId(ctxOf(alice), transfer.id)).toBe(intent.id);
    // approval before the proposal is confirmed is refused
    expect(await code(w.rights.approve(ctxOf(bob), transfer.id, "tk-appr-0001"))).toBe("PROPOSAL_NOT_CONFIRMED");

    w.idx.emit("transfer_proposed", sent.txHash!, { rightId: "5", transferId: "77" });
    w.idx.rights.get("5")!.pendingTransfer = "77";
    w.idx.transfers.set("77", { transferId: "77", rightId: "5", from: alice.principal.stellarAddress, to: bob.principal.stellarAddress, expiry: Math.floor(w.clock.t / 1000) + 3600, status: "Pending", indexerStatus: "SYNCED", latestObservedLedger: 1 });
    await w.intents.reconcile();
    expect(w.db.read().transfers[transfer.id]!.chainTransferId).toBe("77");

    // only the named recipient may approve
    expect(await code(w.rights.approve(ctxOf(alice), transfer.id, "tk-appr-0002"))).toBe("FORBIDDEN");
    const { intent: accept } = await w.rights.approve(ctxOf(bob), transfer.id, "tk-appr-0003");
    expect(accept).toMatchObject({ kind: "TRANSFER_ACCEPT", state: "AWAITING_SIGNATURE" });
    expect(accept.descriptor.args).toEqual([{ name: "transfer_id", type: "u64", value: "77" }]);
    expect(w.rights.currentIntentId(ctxOf(bob), transfer.id)).toBe(accept.id);
    // approval is idempotent
    expect((await w.rights.approve(ctxOf(bob), transfer.id, "tk-appr-0004")).intent.id).toBe(accept.id);

    const done = await w.intents.submit(ctxOf(bob), accept.id, sign(accept, bob));
    w.idx.emit("transfer_completed", done.txHash!, { rightId: "5", transferId: "77" });
    await w.intents.reconcile();
    expect(w.db.read().intents[accept.id]!.state).toBe("CONFIRMED");
  });

  it("stale authorization: expired proposal, changed owner or cancelled transfer require a new proposal", async () => {
    for (const mutate of [
      (w: World) => { w.idx.transfers.get("77")!.expiry = Math.floor(w.clock.t / 1000) - 5; },
      (w: World) => { w.idx.rights.get("5")!.owner = "G" + "Z".repeat(55); },
      (w: World) => { w.idx.transfers.get("77")!.status = "Cancelled"; },
    ]) {
      const w = makeWorld(); const { alice, bob, transfer, sent } = await proposed(w);
      w.idx.emit("transfer_proposed", sent.txHash!, { rightId: "5", transferId: "77" });
      w.idx.transfers.set("77", { transferId: "77", rightId: "5", from: alice.principal.stellarAddress, to: bob.principal.stellarAddress, expiry: Math.floor(w.clock.t / 1000) + 3600, status: "Pending", indexerStatus: "SYNCED", latestObservedLedger: 1 });
      await w.intents.reconcile();
      mutate(w);
      expect(await code(w.rights.approve(ctxOf(bob), transfer.id, "tk-stale-0001"))).toBe("STALE_TRANSFER");
    }
  });
});

describe("transfer and intent listings", () => {
  it("derive workflow status from the intents and are member-scoped", async () => {
    const w = makeWorld(); const { alice, bob, outsider, circleId } = await withRight(w);
    const { transfer, intent } = await w.rights.transferIntent(ctxOf(alice), "5", { toAddress: bob.principal.stellarAddress, expiresAt: iso(w, 3600_000) }, "tk-list-0001");
    expect(w.rights.listTransfers(ctxOf(bob), circleId)[0]!.status).toBe("PROPOSING");
    const sent = await w.intents.submit(ctxOf(alice), intent.id, sign(intent, alice));
    w.idx.emit("transfer_proposed", sent.txHash!, { rightId: "5", transferId: "77" });
    w.idx.rights.get("5")!.pendingTransfer = "77";
    w.idx.transfers.set("77", { transferId: "77", rightId: "5", from: alice.principal.stellarAddress, to: bob.principal.stellarAddress, expiry: Math.floor(w.clock.t / 1000) + 3600, status: "Pending", indexerStatus: "SYNCED", latestObservedLedger: 1 });
    await w.intents.reconcile();
    expect(w.rights.listTransfers(ctxOf(bob), circleId)[0]!.status).toBe("AWAITING_RECIPIENT");
    const { intent: accept } = await w.rights.approve(ctxOf(bob), transfer.id, "tk-list-0002");
    expect(w.rights.listTransfers(ctxOf(bob), circleId)[0]!.status).toBe("ACCEPTING");
    const done = await w.intents.submit(ctxOf(bob), accept.id, sign(accept, bob));
    w.idx.emit("transfer_completed", done.txHash!, { rightId: "5", transferId: "77" });
    await w.intents.reconcile();
    expect(w.rights.listTransfers(ctxOf(alice), circleId)[0]!.status).toBe("COMPLETED");
    expect(() => w.rights.listTransfers(ctxOf(outsider), circleId)).toThrow(/not found/);
    // intents: only the caller's own, newest first
    expect(w.intents.listMine(ctxOf(alice), circleId).map((i) => i.id)).toEqual([intent.id]);
    expect(w.intents.listMine(ctxOf(bob), circleId).map((i) => i.id)).toEqual([accept.id]);
  });
  it("an expired accept intent returns the transfer to AWAITING_RECIPIENT", async () => {
    const w = makeWorld(); const { alice, bob, circleId } = await withRight(w);
    const { transfer, intent } = await w.rights.transferIntent(ctxOf(alice), "5", { toAddress: bob.principal.stellarAddress, expiresAt: iso(w, 20 * 3600_000) }, "tk-list-0003");
    const sent = await w.intents.submit(ctxOf(alice), intent.id, sign(intent, alice));
    w.idx.emit("transfer_proposed", sent.txHash!, { rightId: "5", transferId: "77" });
    w.idx.transfers.set("77", { transferId: "77", rightId: "5", from: alice.principal.stellarAddress, to: bob.principal.stellarAddress, expiry: Math.floor(w.clock.t / 1000) + 20 * 3600, status: "Pending", indexerStatus: "SYNCED", latestObservedLedger: 1 });
    await w.intents.reconcile();
    await w.rights.approve(ctxOf(bob), transfer.id, "tk-list-0004");
    w.clock.advance(901_000);
    await w.intents.reconcile(); // accept intent expires unsigned
    expect(w.rights.listTransfers(ctxOf(bob), circleId)[0]!.status).toBe("AWAITING_RECIPIENT");
    expect((await w.rights.approve(ctxOf(bob), transfer.id, "tk-list-0005")).intent.state).toBe("AWAITING_SIGNATURE");
  });
});

describe("claim intent", () => {
  it("owner only, only once matured (advisory), never twice", async () => {
    const w = makeWorld(); const { alice, bob } = await withRight(w);
    expect(await code(w.rights.claimIntent(ctxOf(alice), "5", "ck-00000001"))).toBe("NOT_MATURED");
    w.clock.advance(86400_000);
    expect(await code(w.rights.claimIntent(ctxOf(bob), "5", "ck-00000002"))).toBe("FORBIDDEN");
    const { intent } = await w.rights.claimIntent(ctxOf(alice), "5", "ck-00000003");
    expect(intent.descriptor).toMatchObject({ function: "claim", args: [{ value: "5" }, { value: alice.principal.stellarAddress }] });
    w.idx.rights.get("5")!.state = "Claimed";
    expect(await code(w.rights.claimIntent(ctxOf(alice), "5", "ck-00000004"))).toBe("ALREADY_CLAIMED");
  });
});

describe("rights listing", () => {
  it("members see pool rights with freshness; unbound circles are empty", async () => {
    const w = makeWorld(); const { alice, bob, outsider, circleId } = await withRight(w);
    const r = await w.rights.listRights(ctxOf(bob), circleId);
    expect(r).toMatchObject({ bound: true, indexerStatus: "SYNCED" });
    expect((r as { rights: unknown[] }).rights).toHaveLength(1);
    await expect(w.rights.listRights(ctxOf(outsider), circleId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    void alice;
  });
});
