import { describe, expect, it } from "vitest";
import { ctxOf } from "./helpers-app.js";
import { makeWorld, rules, seed, sign } from "./world.js";
import { actor } from "./helpers-app.js";

const code = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as { code: string }).code; } return "OK"; };
const future = () => Math.floor(Date.now() / 1000) + 86_400 * 30;

describe("organizer intent: create_pool", () => {
  it("returns the create_pool signing request with the circle's policy hash, and confirms only on the indexed pool_created", async () => {
    const w = makeWorld(); const alice = actor("alice");
    const c = w.circles.create(ctxOf(alice), { name: "New circle", ruleSet: { ...rules, rounds: 7 } });
    const i = await w.organizer.createPoolIntent(ctxOf(alice), c.id, "pool-key-0001");
    expect(i).toMatchObject({ kind: "POOL_CREATE", state: "AWAITING_SIGNATURE", descriptor: { function: "create_pool" } });
    expect(i.descriptor.args).toEqual([
      { name: "controller", type: "address", value: alice.principal.stellarAddress },
      { name: "token", type: "address", value: rules.tokenContractId },
      { name: "membership_policy_hash", type: "bytes32", value: c.policyHash },
    ]);
    const sent = await w.intents.submit(ctxOf(alice), i.id, sign(i, alice));
    expect(sent.state).toBe("SUBMITTED");
    await w.intents.reconcile();
    expect(w.db.read().intents[i.id]!.state).toBe("SUBMITTED"); // not indexed yet: never shown as done
    w.idx.addPool({ poolId: "5", controller: alice.principal.stellarAddress, token: rules.tokenContractId, membershipPolicyHash: c.policyHash });
    w.idx.log.at(-1)!.txHash = sent.txHash!;
    await w.intents.reconcile();
    expect(w.db.read().intents[i.id]!.state).toBe("CONFIRMED");
    expect(w.db.read().circles[c.id]!.poolId).toBe("5"); // bound by the indexed event
  });

  it("is organizer-only and refused once a pool is bound", async () => {
    const w = makeWorld(); const { alice, bob, circleId } = await seed(w);
    expect(await code(w.organizer.createPoolIntent(ctxOf(bob), circleId, "pool-key-0002"))).toBe("FORBIDDEN");
    expect(await code(w.organizer.createPoolIntent(ctxOf(alice), circleId, "pool-key-0003"))).toBe("POOL_ALREADY_BOUND");
  });
});

describe("organizer intent: issue_right", () => {
  const funded = async () => {
    const w = makeWorld(); const s = await seed(w);
    const p = w.idx.pools.get("1")!;
    p.totals = { funded: "1000", reserved: "0", claimed: "0", withdrawn: "0" };
    return { w, ...s };
  };

  it("builds the issue_right descriptor for a pool member within the free backing", async () => {
    const { w, alice, bob, circleId } = await funded();
    const m = future();
    const i = await w.organizer.issueRightIntent(ctxOf(alice), circleId, { owner: bob.principal.stellarAddress, amount: "600", maturity: m }, "right-key-0001");
    expect(i).toMatchObject({ kind: "RIGHT_ISSUE", state: "AWAITING_SIGNATURE", descriptor: { function: "issue_right" }, expectEvent: { name: "right_issued" } });
    expect(i.descriptor.args.map((a) => a.name)).toEqual(["pool_id", "owner", "amount", "maturity", "policy_hash"]);
    expect(i.descriptor.args[3]!.value).toBe(String(m));
  });

  it("refuses doomed requests before anyone signs: unbacked, non-member, past maturity, non-controller, closed pool", async () => {
    const { w, alice, bob, outsider, circleId } = await funded();
    const m = future();
    expect(await code(w.organizer.issueRightIntent(ctxOf(alice), circleId, { owner: bob.principal.stellarAddress, amount: "1001", maturity: m }, "right-key-0002"))).toBe("INSUFFICIENT_BACKING");
    expect(await code(w.organizer.issueRightIntent(ctxOf(alice), circleId, { owner: outsider.principal.stellarAddress, amount: "10", maturity: m }, "right-key-0003"))).toBe("NOT_POOL_MEMBER");
    expect(await code(w.organizer.issueRightIntent(ctxOf(alice), circleId, { owner: bob.principal.stellarAddress, amount: "10", maturity: 1000 }, "right-key-0004"))).toBe("MATURITY_IN_PAST");
    expect(await code(w.organizer.issueRightIntent(ctxOf(bob), circleId, { owner: bob.principal.stellarAddress, amount: "10", maturity: m }, "right-key-0005"))).toBe("FORBIDDEN");
    w.idx.pools.get("1")!.status = "Closed";
    expect(await code(w.organizer.issueRightIntent(ctxOf(alice), circleId, { owner: bob.principal.stellarAddress, amount: "10", maturity: m }, "right-key-0006"))).toBe("POOL_CLOSED");
  });

  it("counts already reserved, claimed and withdrawn value against the backing", async () => {
    const { w, alice, bob, circleId } = await funded();
    w.idx.pools.get("1")!.totals = { funded: "1000", reserved: "500", claimed: "100", withdrawn: "100" };
    expect(await code(w.organizer.issueRightIntent(ctxOf(alice), circleId, { owner: bob.principal.stellarAddress, amount: "301", maturity: future() }, "right-key-0007"))).toBe("INSUFFICIENT_BACKING");
    expect(await code(w.organizer.issueRightIntent(ctxOf(alice), circleId, { owner: bob.principal.stellarAddress, amount: "300", maturity: future() }, "right-key-0008"))).toBe("OK");
  });
});

describe("organizer intent: close_pool", () => {
  it("builds close_pool for the controller and refuses a second close or a non-controller", async () => {
    const w = makeWorld(); const { alice, bob, circleId } = await seed(w);
    expect(await code(w.organizer.closePoolIntent(ctxOf(bob), circleId, "close-key-0001"))).toBe("FORBIDDEN");
    const i = await w.organizer.closePoolIntent(ctxOf(alice), circleId, "close-key-0002");
    expect(i).toMatchObject({ kind: "POOL_CLOSE", descriptor: { function: "close_pool", args: [{ name: "pool_id", type: "u64", value: "1" }] }, expectEvent: { name: "pool_closed" } });
    w.idx.pools.get("1")!.status = "Closed";
    expect(await code(w.organizer.closePoolIntent(ctxOf(alice), circleId, "close-key-0003"))).toBe("POOL_CLOSED");
  });
});
