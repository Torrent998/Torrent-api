import "reflect-metadata";
import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { Keypair } from "@stellar/stellar-sdk";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { createApp } from "../src/bootstrap.js";
import { routes, type RouteId } from "../src/http/routes.js";
import { IntentService } from "../src/modules/intent.service.js";
import { MemoryPersistence } from "../src/persistence/state.js";
import { FakeIndexer, TestChainSubmitter } from "./fakes.js";
import { TOKEN_ID, signedTxFor } from "./helpers.js";
import { TestClock, testConfig } from "./helpers-app.js";
import { rules } from "./world.js";

/**
 * Records the API's real HTTP responses (wallet login, circle, invitation, funding, transfer,
 * approval, audit...) as a consumer fixture for torrent-web. Responses are produced by the real
 * controllers over the (labeled) fake indexer/submitter. Regenerate: UPDATE_GOLDEN=1.
 * Without UPDATE_GOLDEN the committed file must still parse against the CURRENT route schemas.
 */
const path = new URL("../openapi/api-examples.v1.json", import.meta.url);
let app: NestExpressApplication; let idx: FakeIndexer; let clock: TestClock;
beforeEach(async () => {
  idx = new FakeIndexer(); clock = new TestClock();
  app = await createApp({ config: testConfig(), clock, persistence: new MemoryPersistence(), indexer: idx, submitter: new TestChainSubmitter() }, ["error"]);
  await app.init();
});
afterEach(() => app.close());

describe("api-examples.v1.json", () => {
  it("every recorded example parses with the route's current success schema", () => {
    const doc = JSON.parse(readFileSync(path, "utf8")) as { examples: Record<string, unknown> };
    expect(Object.keys(doc.examples).length).toBeGreaterThanOrEqual(12);
    for (const [id, body] of Object.entries(doc.examples)) {
      const r = routes[id as RouteId];
      expect(r, id).toBeTruthy();
      expect(() => r.success.schema.parse(body), id).not.toThrow();
    }
  });

  it.runIf(!!process.env["UPDATE_GOLDEN"])("regenerates the examples from a real flow", async () => {
    const http = () => request(app.getHttpServer());
    const out: Record<string, unknown> = {};
    const login = async (kp: Keypair) => {
      const ch = (await http().post("/v1/auth/challenge").send({ address: kp.publicKey() }).expect(201)).body;
      out["authChallenge"] ??= ch;
      const res = (await http().post("/v1/auth/login").send({ challengeId: ch.challengeId, signature: Buffer.from(kp.signMessage(ch.message)).toString("base64") }).expect(200)).body;
      out["authLogin"] ??= res;
      return { Authorization: `Bearer ${res.token}` };
    };
    const alice = Keypair.random(); const bob = Keypair.random();
    const A = await login(alice); const B = await login(bob);
    const circle = (await http().post("/v1/circles").set(A).send({ name: "Ajo", ruleSet: rules }).expect(201)).body;
    out["createCircle"] = circle;
    const inv = (await http().post(`/v1/circles/${circle.id}/invitations`).set(A).set("Idempotency-Key", "ex-inv-0001").send({ label: "bob" }).expect(201)).body;
    out["createInvitation"] = inv;
    out["acceptInvitation"] = (await http().post("/v1/invitations/accept").set(B).send({ token: inv.token }).expect(200)).body;
    idx.addPool({ poolId: "1", controller: alice.publicKey(), token: TOKEN_ID, membershipPolicyHash: circle.policyHash, members: [bob.publicKey()] });
    const intents = app.get(IntentService);
    await intents.reconcile();
    out["getCircle"] = (await http().get(`/v1/circles/${circle.id}`).set(A).expect(200)).body;
    out["listCircles"] = (await http().get("/v1/circles").set(A).expect(200)).body;
    const fund = (await http().post(`/v1/circles/${circle.id}/funding-intents`).set(A).set("Idempotency-Key", "ex-fund-0001").send({ amount: "10000000000" }).expect(201)).body;
    out["createFundingIntent"] = fund; out["getIntent"] = (await http().get(`/v1/intents/${fund.id}`).set(A).expect(200)).body;
    const sentF = (await http().post(`/v1/intents/${fund.id}/submit`).set(A).send({ signedXdr: signedTxFor(fund.descriptor, alice) }).expect(200)).body;
    out["submitIntent"] = sentF;
    idx.emit("funded", sentF.intent.txHash, { poolId: "1" }, { amount: "10000000000" });
    idx.pools.get("1")!.totals = { funded: "10000000000", reserved: "6000000000", claimed: "0", withdrawn: "0" };
    idx.pools.get("1")!.coverage = { unreserved: "4000000000", fullyBacked: true };
    idx.addRight({ rightId: "5", poolId: "1", amount: "6000000000", owner: alice.publicKey(), maturity: Math.floor(clock.t / 1000) + 86400 });
    await intents.reconcile();
    out["getCoverage"] = (await http().get(`/v1/circles/${circle.id}/coverage`).set(B).expect(200)).body;
    out["listRights"] = (await http().get(`/v1/circles/${circle.id}/rights`).set(B).expect(200)).body;
    const tr = (await http().post("/v1/rights/5/transfers/intent").set(A).set("Idempotency-Key", "ex-xfer-0001").send({ toAddress: bob.publicKey(), expiresAt: new Date(clock.t + 3600_000).toISOString() }).expect(201)).body;
    out["createTransferIntent"] = tr;
    const sentT = (await http().post(`/v1/transfers/${tr.transfer.id}/submit`).set(A).send({ signedXdr: signedTxFor(tr.intent.descriptor, alice) }).expect(200)).body;
    out["submitTransfer"] = sentT;
    idx.emit("transfer_proposed", sentT.intent.txHash, { rightId: "5", transferId: "77" });
    idx.rights.get("5")!.pendingTransfer = "77";
    idx.transfers.set("77", { transferId: "77", rightId: "5", from: alice.publicKey(), to: bob.publicKey(), expiry: Math.floor(clock.t / 1000) + 3600, status: "Pending", indexerStatus: "SYNCED", latestObservedLedger: 1 });
    await intents.reconcile();
    out["approveTransfer"] = (await http().post(`/v1/transfers/${tr.transfer.id}/approve`).set(B).set("Idempotency-Key", "ex-appr-0001").expect(200)).body;
    out["listTransfers"] = (await http().get(`/v1/circles/${circle.id}/transfers`).set(B).expect(200)).body;
    out["listIntents"] = (await http().get(`/v1/circles/${circle.id}/intents`).set(A).expect(200)).body;
    // A second offer that the proposer withdraws (cancel_transfer).
    idx.addRight({ rightId: "6", poolId: "1", amount: "1000000000", owner: alice.publicKey(), maturity: Math.floor(clock.t / 1000) + 86400 });
    const tr2 = (await http().post("/v1/rights/6/transfers/intent").set(A).set("Idempotency-Key", "ex-xfer-0002").send({ toAddress: bob.publicKey(), expiresAt: new Date(clock.t + 3600_000).toISOString() }).expect(201)).body;
    const sentT2 = (await http().post(`/v1/transfers/${tr2.transfer.id}/submit`).set(A).send({ signedXdr: signedTxFor(tr2.intent.descriptor, alice) }).expect(200)).body;
    idx.emit("transfer_proposed", sentT2.intent.txHash, { rightId: "6", transferId: "78" });
    idx.rights.get("6")!.pendingTransfer = "78";
    idx.transfers.set("78", { transferId: "78", rightId: "6", from: alice.publicKey(), to: bob.publicKey(), expiry: Math.floor(clock.t / 1000) + 3600, status: "Pending", indexerStatus: "SYNCED", latestObservedLedger: 1 });
    await intents.reconcile();
    out["cancelTransfer"] = (await http().post(`/v1/transfers/${tr2.transfer.id}/cancel`).set(A).set("Idempotency-Key", "ex-cncl-0001").expect(200)).body;
    idx.gov.admin = alice.publicKey();
    idx.gov.pendingUpgrade = { wasmHash: "ab".repeat(32), executableAfter: Math.floor(clock.t / 1000) + 7 * 86400, proposedAtLedger: 950 };
    out["getContract"] = (await http().get("/v1/contract").set(A).expect(200)).body;
    out["createLeaveIntent"] = (await http().post(`/v1/circles/${circle.id}/leave-intent`).set(B).set("Idempotency-Key", "ex-leave-0001").send({}).expect(201)).body;
    clock.advance(2 * 86400_000);
    const A2 = await login(alice); const B2 = await login(bob); // sessions expire after 12 h
    out["createClaimIntent"] = (await http().post("/v1/rights/5/claim-intent").set(A2).set("Idempotency-Key", "ex-claim-0001").send({}).expect(201)).body;
    out["ledgerEvents"] = (await http().get("/v1/ledger/events").set(B2).expect(200)).body;
    out["circleAudit"] = (await http().get(`/v1/circles/${circle.id}/audit`).set(A2).expect(200)).body;
    out["authLogout"] = (await http().post("/v1/auth/logout").set(B2).expect(200)).body;
    writeFileSync(path, JSON.stringify({ $comment: "Real responses of torrent-api controllers over test adapters. Generated by test/examples.test.ts; mirrored into torrent-web/fixtures.", schemaVersion: 1, examples: out }, null, 2) + "\n");
    expect(Object.keys(out)).toContain("approveTransfer");
  });
});
