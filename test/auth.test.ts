import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { Keypair } from "@stellar/stellar-sdk";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { createApp } from "../src/bootstrap.js";
import { MemoryPersistence } from "../src/persistence/state.js";
import { FakeIndexer, TestChainSubmitter } from "./fakes.js";
import { TestClock, testConfig } from "./helpers-app.js";
import { rules } from "./world.js";

let app: NestExpressApplication; let clock: TestClock; let auditor: Keypair;
const http = () => request(app.getHttpServer());
beforeEach(async () => {
  clock = new TestClock(); auditor = Keypair.random();
  app = await createApp({ config: testConfig({ auditorAddresses: [auditor.publicKey()] }), clock, persistence: new MemoryPersistence(), indexer: new FakeIndexer(), submitter: new TestChainSubmitter() }, ["error"]);
  await app.init();
});
afterEach(() => app.close());

async function login(kp: Keypair) {
  const ch = (await http().post("/v1/auth/challenge").send({ address: kp.publicKey() }).expect(201)).body;
  const sig = Buffer.from(kp.signMessage(ch.message)).toString("base64");
  return { ch, sig, res: await http().post("/v1/auth/login").send({ challengeId: ch.challengeId, signature: sig }) };
}

describe("wallet-signature login", () => {
  it("signing the challenge yields a session usable on protected routes; logout revokes it", async () => {
    const kp = Keypair.random();
    const { res } = await login(kp);
    expect(res.status).toBe(200);
    expect(res.body.address).toBe(kp.publicKey());
    expect(res.body.roles).toEqual(["user"]);
    const auth = { Authorization: `Bearer ${res.body.token}` };
    const made = await http().post("/v1/circles").set(auth).send({ name: "Ajo", ruleSet: rules }).expect(201);
    expect(made.body.organizerAddress).toBe(kp.publicKey());
    await http().post("/v1/auth/logout").set(auth).expect(200);
    await http().get("/v1/circles").set(auth).expect(401);
  });
  it("the challenge names the network and address and states it authorizes no payment", async () => {
    const kp = Keypair.random();
    const ch = (await http().post("/v1/auth/challenge").send({ address: kp.publicKey() }).expect(201)).body;
    expect(ch.message).toContain(`address: ${kp.publicKey()}`);
    expect(ch.message).toContain("network: testnet");
    expect(ch.message).toMatch(/does not authorize any payment/);
  });
  it("rejects a signature from a different key, and burns the challenge", async () => {
    const victim = Keypair.random(); const attacker = Keypair.random();
    const ch = (await http().post("/v1/auth/challenge").send({ address: victim.publicKey() }).expect(201)).body;
    const forged = Buffer.from(attacker.signMessage(ch.message)).toString("base64");
    await http().post("/v1/auth/login").send({ challengeId: ch.challengeId, signature: forged }).expect(401);
    const real = Buffer.from(victim.signMessage(ch.message)).toString("base64");
    await http().post("/v1/auth/login").send({ challengeId: ch.challengeId, signature: real }).expect(401); // already consumed
  });
  it("rejects signing a different message (e.g. a tampered challenge)", async () => {
    const kp = Keypair.random();
    const ch = (await http().post("/v1/auth/challenge").send({ address: kp.publicKey() }).expect(201)).body;
    const sig = Buffer.from(kp.signMessage(ch.message + "\nextra")).toString("base64");
    await http().post("/v1/auth/login").send({ challengeId: ch.challengeId, signature: sig }).expect(401);
  });
  it("challenges are single-use (replay) and expire", async () => {
    const kp = Keypair.random();
    const first = await login(kp);
    expect(first.res.status).toBe(200);
    await http().post("/v1/auth/login").send({ challengeId: first.ch.challengeId, signature: first.sig }).expect(401);
    const ch = (await http().post("/v1/auth/challenge").send({ address: kp.publicKey() }).expect(201)).body;
    clock.advance(6 * 60_000);
    await http().post("/v1/auth/login").send({ challengeId: ch.challengeId, signature: Buffer.from(kp.signMessage(ch.message)).toString("base64") }).expect(401);
  });
  it("sessions expire and bad input is rejected", async () => {
    const kp = Keypair.random();
    const { res } = await login(kp);
    clock.advance(13 * 3600_000);
    await http().get("/v1/circles").set({ Authorization: `Bearer ${res.body.token}` }).expect(401);
    await http().post("/v1/auth/challenge").send({ address: "S" + "A".repeat(55) }).expect(400);
    await http().post("/v1/auth/login").send({ challengeId: "chal_unknown_1", signature: "A".repeat(88) }).expect(401);
    await http().post("/v1/auth/login").send({ challengeId: "chal_unknown_1", signature: "short" }).expect(400);
  });
  it("tokens are stored only as hashes", async () => {
    const kp = Keypair.random();
    const { res } = await login(kp);
    const db = app.get((await import("../src/persistence/state.js")).Database).read();
    expect(JSON.stringify(db)).not.toContain(res.body.token);
  });
  it("auditor role is granted only to configured addresses and unlocks the audit view", async () => {
    const org = Keypair.random();
    const orgTok = (await login(org)).res.body.token as string;
    const circle = (await http().post("/v1/circles").set({ Authorization: `Bearer ${orgTok}` }).send({ name: "Ajo", ruleSet: rules }).expect(201)).body;
    const aud = (await login(auditor)).res;
    expect(aud.body.roles).toEqual(["user", "auditor"]);
    // auditor is not a member => still 404 (existence not disclosed), role does not bypass membership
    await http().get(`/v1/circles/${circle.id}/audit`).set({ Authorization: `Bearer ${aud.body.token}` }).expect(404);
  });
});

describe("audit view pagination", () => {
  it("pages through entries with a cursor and rejects unknown cursors", async () => {
    const org = Keypair.random();
    const auth = { Authorization: `Bearer ${(await login(org)).res.body.token}` };
    const c = (await http().post("/v1/circles").set(auth).send({ name: "Ajo", ruleSet: rules }).expect(201)).body;
    for (let i = 0; i < 3; i++) await http().post(`/v1/circles/${c.id}/invitations`).set(auth).set("Idempotency-Key", `inv-key-000${i}`).send({ label: `m${i}` }).expect(201);
    const p1 = (await http().get(`/v1/circles/${c.id}/audit?limit=2`).set(auth).expect(200)).body;
    expect(p1.events).toHaveLength(2);
    const p2 = (await http().get(`/v1/circles/${c.id}/audit?limit=2&cursor=${p1.nextCursor}`).set(auth).expect(200)).body;
    expect(p2.events).toHaveLength(2);
    expect([...p1.events, ...p2.events].map((e: { action: string }) => e.action)).toEqual(["circle.create", "invitation.create", "invitation.create", "invitation.create"]);
    const end = (await http().get(`/v1/circles/${c.id}/audit?cursor=${p2.nextCursor}`).set(auth).expect(200)).body;
    expect(end.events).toEqual([]);
    await http().get(`/v1/circles/${c.id}/audit?cursor=aud_nope`).set(auth).expect(400);
  });
});
