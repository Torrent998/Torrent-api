import { z } from "zod";
import { acceptInvitationBody, createCircleBody, createInvitationBody } from "../modules/circle.service.js";
import { fundingIntentBody } from "../modules/funding.service.js";
import { claimIntentBody, transferIntentBody } from "../modules/rights.service.js";
import { challengeBody, loginBody } from "../auth/auth.service.js";
import * as S from "./schemas.js";

export interface RouteDef {
  method: "get" | "post";
  path: string; // OpenAPI style
  summary: string;
  tag: string;
  auth: boolean;
  /** Mutating endpoints that create intents require an Idempotency-Key header. */
  idempotent?: boolean;
  params?: z.ZodType;
  query?: z.ZodType;
  body?: z.ZodType;
  success: { status: 200 | 201; schema: z.ZodType };
  errors: number[];
  /** Additive to the SRD v1 list. */
  additive?: boolean;
}

export const nestPath = (p: string) => p.replace(/\{(\w+)\}/g, ":$1");
const E_AUTH = [400, 401, 429];
const E_MEMBER = [...E_AUTH, 404];

export const routes = {
  authChallenge: { method: "post", path: "/v1/auth/challenge", summary: "Start wallet-signature login: get a one-time message to sign", tag: "auth", auth: false, body: challengeBody, success: { status: 201, schema: S.challengeResponse }, errors: [400, 429], additive: true },
  authLogin: { method: "post", path: "/v1/auth/login", summary: "Finish login with the wallet's signature; returns a session bearer token", tag: "auth", auth: false, body: loginBody, success: { status: 200, schema: S.loginResponse }, errors: [400, 401, 429], additive: true },
  authLogout: { method: "post", path: "/v1/auth/logout", summary: "Revoke the current session", tag: "auth", auth: true, success: { status: 200, schema: S.okSchema }, errors: [401, 429], additive: true },
  createCircle: { method: "post", path: "/v1/circles", summary: "Create a circle (off-chain agreement + policy hash)", tag: "circles", auth: true, body: createCircleBody, success: { status: 201, schema: S.circleSchema }, errors: E_AUTH },
  listCircles: { method: "get", path: "/v1/circles", summary: "List circles the caller belongs to", tag: "circles", auth: true, success: { status: 200, schema: z.object({ circles: z.array(S.circleSchema) }) }, errors: E_AUTH },
  getCircle: { method: "get", path: "/v1/circles/{id}", summary: "Get one circle", tag: "circles", auth: true, params: S.idParam, success: { status: 200, schema: S.circleSchema }, errors: E_MEMBER },
  createInvitation: { method: "post", path: "/v1/circles/{id}/invitations", summary: "Invite a member (organizer only)", tag: "circles", auth: true, idempotent: true, params: S.idParam, body: createInvitationBody, success: { status: 201, schema: S.invitationCreatedSchema }, errors: [...E_MEMBER, 403, 409, 422] },
  acceptInvitation: { method: "post", path: "/v1/invitations/accept", summary: "Accept an invitation with its secret token", tag: "circles", auth: true, body: acceptInvitationBody, success: { status: 200, schema: S.circleSchema }, errors: [...E_MEMBER, 409, 422], additive: true },
  createFundingIntent: { method: "post", path: "/v1/circles/{id}/funding-intents", summary: "Create a deposit signing request (stateful intent)", tag: "funding", auth: true, idempotent: true, params: S.idParam, body: fundingIntentBody, success: { status: 201, schema: S.intentSchema }, errors: [...E_MEMBER, 409, 422, 503] },
  getCoverage: { method: "get", path: "/v1/circles/{id}/coverage", summary: "Ledger-derived escrow coverage with freshness", tag: "funding", auth: true, params: S.idParam, success: { status: 200, schema: S.coverageSchema }, errors: E_MEMBER },
  listRights: { method: "get", path: "/v1/circles/{id}/rights", summary: "Payout rights of the circle's pool (ledger-derived)", tag: "rights", auth: true, params: S.idParam, success: { status: 200, schema: S.rightsSchema }, errors: E_MEMBER },
  createTransferIntent: { method: "post", path: "/v1/rights/{id}/transfers/intent", summary: "Propose handing a right to another member (owner)", tag: "transfers", auth: true, idempotent: true, params: S.idParam, body: transferIntentBody, success: { status: 201, schema: S.transferWithIntentSchema }, errors: [...E_MEMBER, 403, 409, 422, 503] },
  approveTransfer: { method: "post", path: "/v1/transfers/{id}/approve", summary: "Recipient approval: creates the accept signing request", tag: "transfers", auth: true, idempotent: true, params: S.idParam, success: { status: 200, schema: S.transferWithIntentSchema }, errors: [...E_MEMBER, 403, 409, 503] },
  submitTransfer: { method: "post", path: "/v1/transfers/{id}/submit", summary: "Submit the signed transaction for the transfer's current step", tag: "transfers", auth: true, params: S.idParam, body: S.signBody, success: { status: 200, schema: z.object({ intent: S.intentSchema }) }, errors: [...E_MEMBER, 403, 409, 422, 503] },
  createClaimIntent: { method: "post", path: "/v1/rights/{id}/claim-intent", summary: "Create a claim signing request (owner, matured)", tag: "rights", auth: true, idempotent: true, params: S.idParam, body: claimIntentBody, success: { status: 201, schema: z.object({ intent: S.intentSchema }) }, errors: [...E_MEMBER, 403, 422, 503] },
  listTransfers: { method: "get", path: "/v1/circles/{id}/transfers", summary: "Transfer proposals in the circle with their workflow status", tag: "transfers", auth: true, params: S.idParam, success: { status: 200, schema: S.transferListSchema }, errors: E_MEMBER, additive: true },
  listIntents: { method: "get", path: "/v1/circles/{id}/intents", summary: "The caller's own intents in the circle (funding, transfers, claims)", tag: "intents", auth: true, params: S.idParam, success: { status: 200, schema: S.intentListSchema }, errors: E_MEMBER, additive: true },
  getIntent: { method: "get", path: "/v1/intents/{id}", summary: "Read an intent's state", tag: "intents", auth: true, params: S.idParam, success: { status: 200, schema: S.intentSchema }, errors: E_MEMBER, additive: true },
  submitIntent: { method: "post", path: "/v1/intents/{id}/submit", summary: "Submit a signed transaction for an intent", tag: "intents", auth: true, params: S.idParam, body: S.signBody, success: { status: 200, schema: z.object({ intent: S.intentSchema }) }, errors: [...E_MEMBER, 403, 409, 422, 503], additive: true },
  ledgerEvents: { method: "get", path: "/v1/ledger/events", summary: "Indexer events limited to the caller's circles", tag: "ledger", auth: true, query: S.ledgerQuery, success: { status: 200, schema: S.eventsPageSchema }, errors: [...E_AUTH, 503] },
  circleAudit: { method: "get", path: "/v1/circles/{id}/audit", summary: "Audit trail, paginated (organizer or auditor)", tag: "circles", auth: true, params: S.idParam, query: S.auditQuery, success: { status: 200, schema: S.auditSchema }, errors: [...E_MEMBER, 403] },
} satisfies Record<string, RouteDef>;

export type RouteId = keyof typeof routes;
