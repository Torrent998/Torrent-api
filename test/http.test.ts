import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { StaticTokenVerifier } from "../src/auth/auth.js";
import { createApp } from "../src/bootstrap.js";
import { routes, nestPath } from "../src/http/routes.js";
import { buildOpenApi } from "../src/http/openapi.js";
import { errorSchema } from "../src/http/schemas.js";
import { MemoryPersistence } from "../src/persistence/state.js";
import { Controller } from "@nestjs/common";
import { ApiController, PublicController } from "../src/http/api.controller.js";
import { FakeIndexer, TestChainSubmitter } from "./fakes.js";
import { TOKEN_ID, signedTxFor } from "./helpers.js";
import { actor, TestClock, testConfig, type Actor } from "./helpers-app.js";
import { rules } from "./world.js";

let app: NestExpressApplication; let idx: FakeIndexer; let sub: TestChainSubmitter; let clock: TestClock;
let alice: Actor; let bob: Actor; let eve: Actor;
const http = () => request(app.getHttpServer());
const auth = (a: Actor) => ({ Authorization: `Bearer ${a.token}` });

async function boot(rateLimit?: { limit: number; windowMs: number }) {
  idx = new FakeIndexer(); sub = new TestChainSubmitter(); clock = new TestClock();
  alice = actor("alice"); bob = actor("bob"); eve = actor("eve");
  const verifier = new StaticTokenVerifier(Object.fromEntries([alice, bob, eve].map((a) => [a.token, a.principal])));
  app = await createApp({ config: testConfig(), clock, persistence: new MemoryPersistence(), indexer: idx, submitter: sub, verifier, ...(rateLimit ? { rateLimit } : {}) }, ["error"]);
  await app.init();
}
beforeEach(() => boot());
afterEach(() => app.close());

async function circleWithPool() {
  const c = await http().post("/v1/circles").set(auth(alice)).send({ name: "Ajo", ruleSet: rules }).expect(201);
  const inv = await http().post(`/v1/circles/${c.body.id}/invitations`).set(auth(alice)).set("Idempotency-Key", "inv-key-0001").send({ label: "bob" }).expect(201);
  await http().post("/v1/invitations/accept").set(auth(bob)).send({ token: inv.body.token }).expect(200);
  idx.addPool({ poolId: "1", controller: alice.principal.stellarAddress, token: TOKEN_ID, membershipPolicyHash: c.body.policyHash, members: [bob.principal.stellarAddress] });
  await sync();
  return c.body as { id: string; policyHash: string };
}
const sync = () => app.get(IntentService).reconcile();
import { IntentService } from "../src/modules/intent.service.js";

describe("authentication and error shape", () => {
  it("rejects missing/invalid tokens with the standard error body and a request id", async () => {
    const r = await http().get("/v1/circles").expect(401);
    expect(errorSchema.parse(r.body).error.code).toBe("UNAUTHENTICATED");
    expect(r.headers["x-request-id"]).toBe(r.body.error.requestId);
    await http().get("/v1/circles").set("Authorization", "Bearer not-a-known-token-0000000").expect(401);
    await http().get("/v1/circles").set("Authorization", "Basic abc").expect(401);
  });
  it("echoes a safe inbound request id only", async () => {
    const ok = await http().get("/healthz").set("x-request-id", "client-req-12345").expect(200);
    expect(ok.headers["x-request-id"]).toBe("client-req-12345");
    const bad = await http().get("/healthz").set("x-request-id", "<script>").expect(200);
    expect(bad.headers["x-request-id"]).toMatch(/^req_/);
  });
  it("validates input with Zod and never echoes values", async () => {
    const r = await http().post("/v1/circles").set(auth(alice)).send({ name: "", ruleSet: { contributionAmount: "1.5" }, evil: "SECRET-VALUE" }).expect(400);
    expect(r.body.error.code).toBe("VALIDATION_ERROR");
    expect(JSON.stringify(r.body)).not.toContain("SECRET-VALUE");
  });
  it("404 for unknown routes uses the same shape; oversize bodies are refused", async () => {
    errorSchema.parse((await http().get("/v1/nope").set(auth(alice)).expect(404)).body);
    const big = await http().post("/v1/circles").set(auth(alice)).send({ name: "x".repeat(100_000) });
    expect(big.status).toBe(413);
    errorSchema.parse(big.body);
  });
  it("rate limits per caller", async () => {
    await app.close(); await boot({ limit: 3, windowMs: 60_000 });
    for (let i = 0; i < 3; i++) await http().get("/v1/circles").set(auth(alice)).expect(200);
    const r = await http().get("/v1/circles").set(auth(alice)).expect(429);
    expect(r.body.error.code).toBe("RATE_LIMITED");
    await http().get("/v1/circles").set(auth(bob)).expect(200); // other callers unaffected
  });
});

describe("idempotency", () => {
  it("same key + same request => exactly one intent; same key + different body => 409; key required", async () => {
    const c = await circleWithPool();
    const send = (amount: string, key?: string) => {
      const r = http().post(`/v1/circles/${c.id}/funding-intents`).set(auth(alice));
      return (key ? r.set("Idempotency-Key", key) : r).send({ amount });
    };
    const a = await send("500", "fund-key-1111").expect(201);
    const b = await send("500", "fund-key-1111").expect(201);
    expect(b.body.id).toBe(a.body.id);
    const conflict = await send("501", "fund-key-1111").expect(409);
    expect(conflict.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect((await send("500").expect(400)).body.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    const fresh = await send("500", "fund-key-2222").expect(201);
    expect(fresh.body.id).not.toBe(a.body.id);
  });
  it("concurrent duplicates execute once", async () => {
    const c = await circleWithPool();
    const call = () => http().post(`/v1/circles/${c.id}/funding-intents`).set(auth(alice)).set("Idempotency-Key", "race-key-0001").send({ amount: "5" });
    const [x, y] = await Promise.all([call(), call()]);
    expect(x.body.id).toBe(y.body.id);
    const intents = Object.values(app.get(Database).read().intents);
    expect(intents).toHaveLength(1);
  });
});
import { Database } from "../src/persistence/state.js";

describe("end to end over HTTP (fake indexer / fake submitter)", () => {
  it("fund: intent -> signed -> submitted -> reconciled -> CONFIRMED, with ledger-derived coverage", async () => {
    const c = await circleWithPool();
    expect((await http().get(`/v1/circles/${c.id}`).set(auth(alice)).expect(200)).body.poolId).toBe("1");

    const i = (await http().post(`/v1/circles/${c.id}/funding-intents`).set(auth(alice)).set("Idempotency-Key", "e2e-fund-0001").send({ amount: "1000" }).expect(201)).body;
    expect(i.state).toBe("AWAITING_SIGNATURE");
    const sent = (await http().post(`/v1/intents/${i.id}/submit`).set(auth(alice)).send({ signedXdr: signedTxFor(i.descriptor, alice.kp) }).expect(200)).body.intent;
    expect(sent.state).toBe("SUBMITTED");
    idx.emit("funded", sent.txHash, { poolId: "1" }, { amount: "1000" });
    await sync();
    expect((await http().get(`/v1/intents/${i.id}`).set(auth(alice)).expect(200)).body.state).toBe("CONFIRMED");

    idx.pools.get("1")!.totals = { funded: "1000", reserved: "0", claimed: "0", withdrawn: "0" };
    idx.pools.get("1")!.coverage = { unreserved: "1000", fullyBacked: true };
    const cov = (await http().get(`/v1/circles/${c.id}/coverage`).set(auth(bob)).expect(200)).body;
    expect(cov).toMatchObject({ bound: true, unreserved: "1000", fullyBacked: true });
  });

  it("non-members get 404 on circle resources; non-organizers get 403 on invitations/audit", async () => {
    const c = await circleWithPool();
    for (const path of [`/v1/circles/${c.id}`, `/v1/circles/${c.id}/coverage`, `/v1/circles/${c.id}/rights`, `/v1/circles/${c.id}/audit`]) {
      await http().get(path).set(auth(eve)).expect(404);
    }
    await http().post(`/v1/circles/${c.id}/invitations`).set(auth(bob)).set("Idempotency-Key", "inv-key-0002").send({ label: "x" }).expect(403);
    await http().get(`/v1/circles/${c.id}/audit`).set(auth(bob)).expect(403);
    const audit = (await http().get(`/v1/circles/${c.id}/audit`).set(auth(alice)).expect(200)).body.events;
    expect(audit.map((e: { action: string }) => e.action)).toContain("circle.create");
    expect(JSON.stringify(audit)).not.toMatch(/token|secret/i);
  });

  it("transfer + claim endpoints enforce the on-chain owner", async () => {
    const c = await circleWithPool();
    idx.addRight({ rightId: "5", poolId: "1", owner: alice.principal.stellarAddress, maturity: Math.floor(clock.t / 1000) + 3600 });
    const body = { toAddress: bob.principal.stellarAddress, expiresAt: new Date(clock.t + 600_000).toISOString() };
    await http().post("/v1/rights/5/transfers/intent").set(auth(bob)).set("Idempotency-Key", "xfer-key-0001").send({ ...body, toAddress: alice.principal.stellarAddress }).expect(403);
    const t = (await http().post("/v1/rights/5/transfers/intent").set(auth(alice)).set("Idempotency-Key", "xfer-key-0002").send(body).expect(201)).body;
    expect(t.intent.descriptor.function).toBe("propose_transfer");
    const sent = await http().post(`/v1/transfers/${t.transfer.id}/submit`).set(auth(alice)).send({ signedXdr: signedTxFor(t.intent.descriptor, alice.kp) }).expect(200);
    expect(sent.body.intent.state).toBe("SUBMITTED");
    await http().post("/v1/rights/5/claim-intent").set(auth(alice)).set("Idempotency-Key", "claim-key-0001").send({}).expect(422);
    expect(c.id).toBeTruthy();
  });

  it("serves ledger events limited to the caller's pools", async () => {
    const c = await circleWithPool();
    idx.addRight({ rightId: "5", poolId: "1", owner: alice.principal.stellarAddress });
    idx.emit("funded", "t1", { poolId: "1" });
    idx.emit("funded", "t-other", { poolId: "999" });
    idx.emit("transfer_proposed", "t2", { rightId: "5", transferId: "1" });
    const mine = (await http().get("/v1/ledger/events?limit=100").set(auth(bob)).expect(200)).body;
    expect(mine.events.map((e: { txHash: string }) => e.txHash)).toEqual(["pool-tx-1", "t1", "t2"]);
    expect((await http().get("/v1/ledger/events?limit=100").set(auth(eve)).expect(200)).body.events).toEqual([]);
    await http().get("/v1/ledger/events?cursor=bad").set(auth(bob)).expect(400);
    expect(c.id).toBeTruthy();
  });

  it("fails closed with 503 while the indexer is halted or unreachable", async () => {
    const c = await circleWithPool();
    idx.st = { ...idx.st, status: "RECONCILING" };
    const r = await http().post(`/v1/circles/${c.id}/funding-intents`).set(auth(alice)).set("Idempotency-Key", "halt-key-0001").send({ amount: "5" }).expect(503);
    expect(r.body.error.code).toBe("INDEXER_HALTED");
  });
});

describe("OpenAPI is the real contract", () => {
  it("documents exactly the routes the controllers implement (method + path)", () => {
    const impl = new Set<string>();
    for (const C of [PublicController, ApiController]) {
      for (const name of Object.getOwnPropertyNames(C.prototype)) {
        const fn = (C.prototype as unknown as Record<string, unknown>)[name];
        if (typeof fn !== "function" || name === "constructor") continue;
        const path = Reflect.getMetadata("path", fn); const m = Reflect.getMetadata("method", fn);
        if (path === undefined) continue;
        impl.add(`${["get", "post"][m] ?? m} ${path}`);
      }
    }
    const documented = new Set(Object.values(routes).map((r) => `${r.method} ${nestPath(r.path)}`));
    documented.add("get /healthz"); documented.add("get /v1/openapi.json");
    expect([...impl].sort()).toEqual([...documented].sort());
    expect(Controller).toBeTruthy();
  });
  it("covers every SRD v1 endpoint", () => {
    const srd = ["post /v1/circles", "get /v1/circles", "get /v1/circles/{id}", "post /v1/circles/{id}/invitations", "post /v1/circles/{id}/funding-intents",
      "get /v1/circles/{id}/coverage", "get /v1/circles/{id}/rights", "post /v1/rights/{id}/transfers/intent", "post /v1/transfers/{id}/approve",
      "post /v1/transfers/{id}/submit", "post /v1/rights/{id}/claim-intent", "get /v1/ledger/events", "get /v1/circles/{id}/audit"];
    const doc = buildOpenApi().paths as Record<string, Record<string, unknown>>;
    for (const s of srd) { const [m, p] = s.split(" "); expect(doc[p!]?.[m!], s).toBeTruthy(); }
  });
  it("is served as OpenAPI 3.1 and idempotent routes declare the header", async () => {
    const d = (await http().get("/v1/openapi.json").expect(200)).body;
    expect(d.openapi).toBe("3.1.0");
    const params = d.paths["/v1/circles/{id}/funding-intents"].post.parameters.map((p: { name: string }) => p.name);
    expect(params).toContain("Idempotency-Key");
  });
});

describe("responses conform to their documented schemas", () => {
  it("circle, list, intent, transfer, coverage, rights, audit, events", async () => {
    const c = await circleWithPool();
    idx.addRight({ rightId: "5", poolId: "1", owner: alice.principal.stellarAddress });
    const get = async (p: string, a = alice) => (await http().get(p).set(auth(a)).expect(200)).body;
    routes.getCircle.success.schema.parse(await get(`/v1/circles/${c.id}`));
    routes.listCircles.success.schema.parse(await get("/v1/circles"));
    routes.getCoverage.success.schema.parse(await get(`/v1/circles/${c.id}/coverage`));
    routes.listRights.success.schema.parse(await get(`/v1/circles/${c.id}/rights`));
    routes.circleAudit.success.schema.parse(await get(`/v1/circles/${c.id}/audit`));
    routes.ledgerEvents.success.schema.parse(await get("/v1/ledger/events"));
    const fi = await http().post(`/v1/circles/${c.id}/funding-intents`).set(auth(alice)).set("Idempotency-Key", "schema-key-01").send({ amount: "7" }).expect(201);
    routes.createFundingIntent.success.schema.parse(fi.body);
    const t = await http().post("/v1/rights/5/transfers/intent").set(auth(alice)).set("Idempotency-Key", "schema-key-02")
      .send({ toAddress: bob.principal.stellarAddress, expiresAt: new Date(clock.t + 600_000).toISOString() }).expect(201);
    routes.createTransferIntent.success.schema.parse(t.body);
  });
});
