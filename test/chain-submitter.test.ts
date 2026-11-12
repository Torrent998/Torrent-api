import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { SorobanRpcSubmitter, type RpcServerLike } from "../src/integrations/chain-submitter.js";
import { AuditService } from "../src/modules/audit.service.js";
import { CircleService } from "../src/modules/circle.service.js";
import { FundingService } from "../src/modules/funding.service.js";
import { IntentService } from "../src/modules/intent.service.js";
import { LedgerSyncService } from "../src/modules/ledger-sync.service.js";
import { FakeIndexer } from "./fakes.js";
import { CONTRACT_ID, PASSPHRASE, TOKEN_ID, signedTxFor } from "./helpers.js";
import { actor, ctxOf, newDb, TestClock, testConfig } from "./helpers-app.js";
import { rules } from "./world.js";

function neverResolvingServer(opts: { resolveNetwork?: boolean } = {}): RpcServerLike {
  const never = <T>() => new Promise<T>(() => {});
  return {
    getNetwork: opts.resolveNetwork
      ? async () => ({ passphrase: PASSPHRASE, friendbotUrl: "" } as Awaited<ReturnType<RpcServerLike["getNetwork"]>>)
      : () => never(),
    sendTransaction: () => never(),
    getTransaction: () => never(),
  };
}

function sampleSignedXdr(kp = Keypair.random()): string {
  return signedTxFor(
    {
      contractId: CONTRACT_ID,
      function: "deposit",
      args: [
        { name: "pool_id", type: "u64", value: "1" },
        { name: "member", type: "address", value: kp.publicKey() },
        { name: "amount", type: "i128", value: "100" },
      ],
    },
    kp,
  );
}

describe("SorobanRpcSubmitter timeout bounds", () => {
  it("rejects non-positive or non-finite timeoutMs at construction", () => {
    const stub = neverResolvingServer();
    expect(() => new SorobanRpcSubmitter(stub, 0)).toThrow(/positive number/);
    expect(() => new SorobanRpcSubmitter(stub, -50)).toThrow(/positive number/);
    expect(() => new SorobanRpcSubmitter(stub, Number.NaN)).toThrow(/positive number/);
  });

  it("preserves fast submit() and status() classification within the timeout bound", async () => {
    const xdr = sampleSignedXdr();
    const mkServer = (sendStatus: string, txStatus: string): RpcServerLike => ({
      getNetwork: async () =>
        ({ passphrase: PASSPHRASE, friendbotUrl: "" }) as Awaited<ReturnType<RpcServerLike["getNetwork"]>>,
      sendTransaction: async () =>
        ({ status: sendStatus }) as Awaited<ReturnType<RpcServerLike["sendTransaction"]>>,
      getTransaction: async () =>
        ({ status: txStatus }) as Awaited<ReturnType<RpcServerLike["getTransaction"]>>,
    });

    const ok = new SorobanRpcSubmitter(mkServer("PENDING", "SUCCESS"), 250);
    await expect(ok.submit(xdr, "tx-1")).resolves.toEqual({ accepted: true, detail: "PENDING" });
    await expect(ok.status("tx-1")).resolves.toBe("SUCCESS");

    const rejected = new SorobanRpcSubmitter(mkServer("ERROR", "FAILED"), 250);
    await expect(rejected.submit(xdr, "tx-2")).resolves.toEqual({ accepted: false, detail: "rejected by network" });
    await expect(rejected.status("tx-2")).resolves.toBe("FAILED");

    const missing = new SorobanRpcSubmitter(mkServer("PENDING", "NOT_FOUND"), 250);
    await expect(missing.status("tx-3")).resolves.toBe("NOT_FOUND");
  });

  it("rejects submit() and status() within the configured timeout when RPC calls never resolve", async () => {
    const xdr = sampleSignedXdr();

    const hungSend = new SorobanRpcSubmitter(neverResolvingServer({ resolveNetwork: true }), 40);
    await expect(hungSend.submit(xdr, "tx-hash-1")).rejects.toThrow(/timed out after 40ms/);
    await expect(hungSend.status("tx-hash-1")).rejects.toThrow(/timed out after 40ms/);

    const hungNetwork = new SorobanRpcSubmitter(neverResolvingServer({ resolveNetwork: false }), 40);
    await expect(hungNetwork.submit(xdr, "tx-hash-2")).rejects.toThrow(/timed out after 40ms/);
  });

  it("leaves IntentService intents in SUBMITTED / RECONCILING (never FAILED) when SorobanRpcSubmitter times out", async () => {
    const db = newDb();
    const clock = new TestClock();
    const idx = new FakeIndexer();
    const cfg = testConfig();
    const audit = new AuditService(db, clock);
    const circles = new CircleService(db, clock, audit, cfg);
    const ledger = new LedgerSyncService(db, idx, clock, cfg);
    const submitter = new SorobanRpcSubmitter(neverResolvingServer({ resolveNetwork: true }), 30);
    const intents = new IntentService(db, clock, cfg, audit, ledger, submitter);
    const funding = new FundingService(circles, intents, ledger, idx, cfg, clock);

    const alice = actor("alice");
    const bob = actor("bob");
    const circle = circles.create(ctxOf(alice), { name: "Ajo", ruleSet: rules });
    circles.accept(ctxOf(bob), circles.invite(ctxOf(alice), circle.id, { label: "bob" }).token);
    idx.addPool({
      poolId: "1",
      controller: alice.principal.stellarAddress,
      token: TOKEN_ID,
      membershipPolicyHash: circle.policyHash,
      members: [bob.principal.stellarAddress],
    });
    await ledger.sync();

    const intent = await funding.fundingIntent(ctxOf(alice), circle.id, { amount: "100" }, "fund-timeout-0001");
    const signedXdr = signedTxFor(intent.descriptor, alice.kp);

    const submitted = await intents.submit(ctxOf(alice), intent.id, signedXdr);
    expect(submitted.state).toBe("SUBMITTED");
    expect(submitted.failureReason).toBeNull();

    // Before reconcileAfterSeconds: status() timeout keeps intent in SUBMITTED (not FAILED).
    clock.advance(30_000);
    const earlyRec = await intents.reconcile();
    expect(earlyRec.failed).toBe(0);
    expect(earlyRec.reconciling).toBe(0);
    expect(db.read().intents[intent.id]!.state).toBe("SUBMITTED");

    // Past reconcileAfterSeconds: status() timeout transitions SUBMITTED -> RECONCILING.
    clock.advance(91_000);
    const rec = await intents.reconcile();
    expect(rec.failed).toBe(0);
    expect(rec.reconciling).toBe(1);
    expect(db.read().intents[intent.id]!.state).toBe("RECONCILING");

    // Subsequent reconcile() ticks while RECONCILING stay bounded and keep RECONCILING.
    const repeatRec = await intents.reconcile();
    expect(repeatRec.failed).toBe(0);
    expect(db.read().intents[intent.id]!.state).toBe("RECONCILING");
  });
});
