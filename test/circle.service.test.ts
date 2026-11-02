import { describe, expect, it } from "vitest";
import { AuditService } from "../src/modules/audit.service.js";
import { CircleService } from "../src/modules/circle.service.js";
import { TOKEN_ID } from "./helpers.js";
import { actor, ctxOf, newDb, TestClock, testConfig } from "./helpers-app.js";

const rules = { tokenContractId: TOKEN_ID, maxMembers: 3, rounds: 3, roundLengthDays: 30, contributionAmount: "100", transferPolicy: "MEMBERS_ONLY" as const };
function setup() {
  const db = newDb(); const clock = new TestClock(); const audit = new AuditService(db, clock);
  return { db, clock, audit, svc: new CircleService(db, clock, audit, testConfig()) };
}
const code = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as { code: string }).code; } return "OK"; };

describe("CircleService", () => {
  it("creates a circle bound to a policy hash, organizer is the first member, audit recorded", () => {
    const { svc, audit } = setup(); const a = actor("alice");
    const c = svc.create(ctxOf(a), { name: "Ajo", ruleSet: rules });
    expect(c.policyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(c.poolId).toBeNull();
    expect(c.members[0]).toMatchObject({ role: "ORGANIZER", address: a.principal.stellarAddress });
    expect(audit.forCircle(c.id).map((e) => e.action)).toEqual(["circle.create"]);
  });
  it("hides circles from non-members (404) and restricts invitations to the organizer (403)", () => {
    const { svc } = setup(); const a = actor("alice"); const b = actor("bob");
    const c = svc.create(ctxOf(a), { name: "Ajo", ruleSet: rules });
    expect(code(() => svc.getForMember(ctxOf(b), c.id))).toBe("NOT_FOUND");
    const { token } = svc.invite(ctxOf(a), c.id, { label: "bob" });
    svc.accept(ctxOf(b), token);
    expect(code(() => svc.invite(ctxOf(b), c.id, { label: "x" }))).toBe("FORBIDDEN");
    expect(svc.listFor(ctxOf(b)).map((x) => x.id)).toEqual([c.id]);
  });
  it("invitation tokens are single-use, expire, and are stored only as hashes", () => {
    const { svc, db, clock } = setup(); const a = actor("alice"); const b = actor("bob"); const c2 = actor("carol");
    const c = svc.create(ctxOf(a), { name: "Ajo", ruleSet: rules });
    const { token, invitation } = svc.invite(ctxOf(a), c.id, { label: "bob" });
    expect(JSON.stringify(db.read())).not.toContain(token);
    expect(invitation.tokenHash).not.toBe(token);
    svc.accept(ctxOf(b), token);
    expect(code(() => svc.accept(ctxOf(c2), token))).toBe("INVITATION_NOT_PENDING");
    const t2 = svc.invite(ctxOf(a), c.id, { label: "carol" }).token;
    clock.advance(2 * 86400_000);
    expect(code(() => svc.accept(ctxOf(c2), t2))).toBe("INVITATION_EXPIRED");
    expect(code(() => svc.accept(ctxOf(c2), "unknown-token"))).toBe("NOT_FOUND");
  });
  it("enforces maxMembers and rejects duplicate members", () => {
    const { svc } = setup(); const a = actor("alice"); const b = actor("bob"); const c3 = actor("carol"); const d = actor("dave");
    const c = svc.create(ctxOf(a), { name: "Ajo", ruleSet: rules });
    const t1 = svc.invite(ctxOf(a), c.id, { label: "b" }).token;
    const t2 = svc.invite(ctxOf(a), c.id, { label: "c" }).token;
    const t3 = svc.invite(ctxOf(a), c.id, { label: "d" }).token;
    svc.accept(ctxOf(b), t1);
    expect(code(() => svc.accept(ctxOf(b), t2))).toBe("ALREADY_MEMBER");
    svc.accept(ctxOf(c3), t2);
    expect(code(() => svc.accept(ctxOf(d), t3))).toBe("CIRCLE_FULL");
    expect(code(() => svc.invite(ctxOf(a), c.id, { label: "e" }))).toBe("CIRCLE_FULL");
  });
});
