import { Keypair } from "@stellar/stellar-sdk";
import type { Principal } from "../src/auth/auth.js";
import type { AppConfig, Clock, Ctx } from "../src/common/context.js";
import { Database, MemoryPersistence } from "../src/persistence/state.js";
import { CONTRACT_ID, PASSPHRASE } from "./helpers.js";

export class TestClock implements Clock {
  constructor(public t = Date.parse("2026-03-01T00:00:00.000Z")) {}
  now() { return new Date(this.t); }
  advance(ms: number) { this.t += ms; }
}
export const testConfig = (over: Partial<AppConfig> = {}): AppConfig => ({
  network: "testnet", networkPassphrase: PASSPHRASE, contractId: CONTRACT_ID,
  intentTtlSeconds: 900, reconcileAfterSeconds: 120, maxIndexerLagLedgers: 5, invitationTtlSeconds: 86400, ...over,
});
export interface Actor { kp: Keypair; principal: Principal; token: string }
export function actor(name: string, roles: Principal["roles"] = ["user"]): Actor {
  const kp = Keypair.random();
  return { kp, principal: { userId: `usr_${name}`, stellarAddress: kp.publicKey(), roles }, token: `tok-${name}-${"x".repeat(24)}` };
}
export const ctxOf = (a: Actor, requestId = "req_test"): Ctx => ({ principal: a.principal, requestId });
export const newDb = () => new Database(new MemoryPersistence());
