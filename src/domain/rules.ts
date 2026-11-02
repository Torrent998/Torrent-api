import { z } from "zod";
import { amountSchema } from "../common/money.js";
import { sha256Hex } from "../common/ids.js";

export const addressSchema = z.string().regex(/^[GC][A-Z2-7]{55}$/, "invalid Stellar strkey");

export const ruleSetSchema = z.object({
  /** Synthetic Testnet asset contract. Real assets are out of scope for the MVP. */
  tokenContractId: addressSchema,
  maxMembers: z.number().int().min(2).max(50),
  rounds: z.number().int().min(1).max(50),
  roundLengthDays: z.number().int().min(1).max(366),
  contributionAmount: amountSchema,
  transferPolicy: z.literal("MEMBERS_ONLY"),
});
export type RuleSet = z.infer<typeof ruleSetSchema>;

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

/**
 * The 32-byte hash committed on-chain as `membership_policy_hash`. Canonical (sorted-key) JSON of
 * the rule set, so the off-chain agreement and the pool are bound without trusting either side.
 */
export const policyHashOf = (r: RuleSet): string => sha256Hex(canonical(r));
