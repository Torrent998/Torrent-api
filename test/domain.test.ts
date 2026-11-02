import { describe, expect, it } from "vitest";
import { AppError } from "../src/common/errors.js";
import { amountSchema, parseAmount } from "../src/common/money.js";
import { INTENT_STATES, assertTransition, isTerminal } from "../src/domain/intent.js";
import { policyHashOf, ruleSetSchema } from "../src/domain/rules.js";

const rules = ruleSetSchema.parse({
  tokenContractId: "C" + "A".repeat(55), maxMembers: 5, rounds: 5, roundLengthDays: 30,
  contributionAmount: "100", transferPolicy: "MEMBERS_ONLY",
});

describe("intent state machine", () => {
  it("allows the SRD happy path", () => {
    const path = ["DRAFT", "VERIFIED", "AWAITING_SIGNATURE", "SUBMITTED", "CONFIRMED"] as const;
    for (let i = 0; i < path.length - 1; i++) expect(() => assertTransition(path[i]!, path[i + 1]!)).not.toThrow();
  });
  it("lets SUBMITTED go to RECONCILING and RECONCILING resolve, but never back to AWAITING_SIGNATURE", () => {
    expect(() => assertTransition("SUBMITTED", "RECONCILING")).not.toThrow();
    expect(() => assertTransition("RECONCILING", "CONFIRMED")).not.toThrow();
    expect(() => assertTransition("RECONCILING", "AWAITING_SIGNATURE")).toThrow(AppError);
    expect(() => assertTransition("SUBMITTED", "AWAITING_SIGNATURE")).toThrow(AppError);
  });
  it("terminal states accept nothing; every other illegal pair is rejected", () => {
    for (const from of INTENT_STATES) for (const to of INTENT_STATES) {
      if (isTerminal(from)) expect(() => assertTransition(from, to)).toThrow(/ILLEGAL|cannot move/);
    }
    expect(() => assertTransition("DRAFT", "SUBMITTED")).toThrow();
    expect(() => assertTransition("CONFIRMED", "FAILED")).toThrow();
  });
});

describe("amounts", () => {
  it("accepts integer strings only", () => {
    expect(parseAmount("1000")).toBe(1000n);
    for (const bad of ["0", "-1", "1.5", "1e3", " 1", "01", "", "170141183460469231731687303715884105728"]) {
      expect(amountSchema.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe("policy hash", () => {
  it("is 32 bytes hex, order-independent and sensitive to any rule", () => {
    const h = policyHashOf(rules);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(policyHashOf(ruleSetSchema.parse(JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(rules).reverse())))))).toBe(h);
    expect(policyHashOf({ ...rules, rounds: 6 })).not.toBe(h);
    expect(policyHashOf({ ...rules, contributionAmount: "101" })).not.toBe(h);
  });
  it("rejects malformed rule sets", () => {
    expect(ruleSetSchema.safeParse({ ...rules, maxMembers: 1 }).success).toBe(false);
    expect(ruleSetSchema.safeParse({ ...rules, transferPolicy: "ANYONE" }).success).toBe(false);
    expect(ruleSetSchema.safeParse({ ...rules, tokenContractId: "nope" }).success).toBe(false);
  });
});
