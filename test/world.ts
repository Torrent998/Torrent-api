import { AuditService } from "../src/modules/audit.service.js";
import { CircleService } from "../src/modules/circle.service.js";
import { FundingService } from "../src/modules/funding.service.js";
import { IntentService } from "../src/modules/intent.service.js";
import { LedgerSyncService } from "../src/modules/ledger-sync.service.js";
import { RightsService } from "../src/modules/rights.service.js";
import { FakeIndexer, TestChainSubmitter } from "./fakes.js";
import { TOKEN_ID, signedTxFor } from "./helpers.js";
import { actor, ctxOf, newDb, TestClock, testConfig, type Actor } from "./helpers-app.js";
import type { Intent } from "../src/domain/intent.js";
import type { AppConfig } from "../src/common/context.js";

export const rules = { tokenContractId: TOKEN_ID, maxMembers: 4, rounds: 3, roundLengthDays: 30, contributionAmount: "100", transferPolicy: "MEMBERS_ONLY" as const };

export function makeWorld(cfgOver: Partial<AppConfig> = {}) {
  const db = newDb(); const clock = new TestClock(); const idx = new FakeIndexer(); const sub = new TestChainSubmitter();
  const cfg = testConfig(cfgOver);
  const audit = new AuditService(db, clock);
  const circles = new CircleService(db, clock, audit, cfg);
  const ledger = new LedgerSyncService(db, idx, clock, cfg);
  const intents = new IntentService(db, clock, cfg, audit, ledger, sub);
  const funding = new FundingService(circles, intents, ledger, idx, cfg, clock);
  const rights = new RightsService(db, circles, intents, ledger, idx, cfg, clock, audit);
  return { db, clock, idx, sub, cfg, circles, ledger, intents, funding, rights, audit };
}
export type World = ReturnType<typeof makeWorld>;

/** Organizer alice + members bob, carol; pool "1" bound on the (fake) chain. */
export async function seed(w: World) {
  const alice = actor("alice"); const bob = actor("bob"); const carol = actor("carol"); const outsider = actor("eve");
  const c = w.circles.create(ctxOf(alice), { name: "Ajo", ruleSet: rules });
  for (const m of [bob, carol]) w.circles.accept(ctxOf(m), w.circles.invite(ctxOf(alice), c.id, { label: m.principal.userId }).token);
  w.idx.addPool({
    poolId: "1", controller: alice.principal.stellarAddress, token: TOKEN_ID, membershipPolicyHash: c.policyHash,
    members: [bob, carol].map((m) => m.principal.stellarAddress),
  });
  await w.ledger.sync();
  return { alice, bob, carol, outsider, circleId: c.id };
}

/** Sign an intent's descriptor as its actor, as a wallet would. */
export const sign = (i: Intent, a: Actor) => signedTxFor(i.descriptor, a.kp);
