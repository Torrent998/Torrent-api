import { z } from "zod";
import { INTENT_KINDS, INTENT_STATES } from "../domain/intent.js";
import { addressSchema, ruleSetSchema } from "../domain/rules.js";
import { eventsPageSchema } from "../integrations/indexer-client.js";

export const errorSchema = z.object({ error: z.object({ code: z.string(), message: z.string(), requestId: z.string() }) });

export const circleSchema = z.object({
  id: z.string(), name: z.string(), ruleSet: ruleSetSchema, policyHash: z.string(), poolId: z.string().nullable(),
  organizerAddress: addressSchema,
  members: z.array(z.object({ address: addressSchema, role: z.enum(["ORGANIZER", "MEMBER"]), joinedAt: z.string() })),
  createdAt: z.string(), updatedAt: z.string(),
});

export const descriptorSchema = z.object({
  contractId: z.string(), function: z.string(),
  args: z.array(z.object({ name: z.string(), type: z.enum(["u64", "i128", "address", "bytes32"]), value: z.string() })),
});
export const intentSchema = z.object({
  id: z.string(), schemaVersion: z.literal(1), requestId: z.string(),
  kind: z.enum(INTENT_KINDS), circleId: z.string(),
  state: z.enum(INTENT_STATES), descriptor: descriptorSchema, txHash: z.string().nullable(), failureReason: z.string().nullable(),
  verifiedAtLedger: z.number().int(), expiresAt: z.string(), createdAt: z.string(), updatedAt: z.string(),
});
export const transferSchema = z.object({
  id: z.string(), circleId: z.string(), rightId: z.string(), from: z.string(), to: z.string(), expiresAt: z.string(),
  proposeIntentId: z.string(), acceptIntentId: z.string().nullable(), cancelIntentId: z.string().nullable(), chainTransferId: z.string().nullable(), createdAt: z.string(),
});
export const transferWithIntentSchema = z.object({ transfer: transferSchema, intent: intentSchema });
export const coverageSchema = z.union([
  z.object({ circleId: z.string(), bound: z.literal(false) }),
  z.object({
    circleId: z.string(), bound: z.literal(true), poolId: z.string(),
    totals: z.object({ funded: z.string(), reserved: z.string(), claimed: z.string(), withdrawn: z.string() }),
    unreserved: z.string(), fullyBacked: z.boolean(), poolStatus: z.enum(["Active", "Paused", "Closed"]),
    indexerStatus: z.enum(["SYNCING", "SYNCED", "RECONCILING"]), asOfLedger: z.number().int(), lagLedgers: z.number().int(), observedAt: z.string(),
  }),
]);
export const rightsSchema = z.object({
  circleId: z.string(), bound: z.boolean(), indexerStatus: z.string().optional(), asOfLedger: z.number().int().optional(),
  rights: z.array(z.object({
    rightId: z.string(), poolId: z.string(), amount: z.string(), owner: z.string(), maturity: z.number().int(),
    state: z.enum(["Issued", "Claimed"]), pendingTransfer: z.string().nullable(), issuedAtLedger: z.number().int(), claimedAtLedger: z.number().int().nullable(),
  })),
});
export const auditSchema = z.object({
  nextCursor: z.string().nullable(),
  events: z.array(z.object({ id: z.string(), at: z.string(), actor: z.string(), scope: z.string(), action: z.string(), object: z.string(), requestId: z.string() })),
});
export const invitationCreatedSchema = z.object({
  invitation: z.object({ id: z.string(), label: z.string(), status: z.string(), expiresAt: z.string() }),
  token: z.string().describe("Shown once; only its hash is stored."),
});
export const signBody = z.object({ signedXdr: z.string().min(100).max(20000) }).strict();
export const idParam = z.object({ id: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/) });
export const ledgerQuery = z.object({
  cursor: z.string().regex(/^\d{19}-\d{10}$/).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export { eventsPageSchema };

export const auditQuery = z.object({ cursor: z.string().regex(/^aud_[A-Za-z0-9_-]+$/).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) });
export const challengeResponse = z.object({ challengeId: z.string(), message: z.string(), expiresAt: z.string() });
export const loginResponse = z.object({ token: z.string(), expiresAt: z.string(), userId: z.string(), address: z.string(), roles: z.array(z.enum(["user", "auditor"])) });
export const okSchema = z.object({ ok: z.literal(true) });

export const transferListSchema = z.object({ transfers: z.array(transferSchema.extend({ status: z.enum(["PROPOSING", "AWAITING_RECIPIENT", "ACCEPTING", "COMPLETED", "CANCELLING", "CANCELLED", "FAILED"]) })) });
export const intentOnlySchema = z.object({ intent: intentSchema });
export { contractSchema } from "../integrations/indexer-client.js";
export const intentListSchema = z.object({ intents: z.array(intentSchema) });
