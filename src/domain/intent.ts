import { AppError } from "../common/errors.js";

/** SRD state machine: DRAFT -> VERIFIED -> AWAITING_SIGNATURE -> SUBMITTED -> CONFIRMED; failures FAILED / RECONCILING. */
export const INTENT_STATES = [
  "DRAFT", "VERIFIED", "AWAITING_SIGNATURE", "SUBMITTED", "CONFIRMED", "FAILED", "RECONCILING",
] as const;
export type IntentState = (typeof INTENT_STATES)[number];

export type IntentKind = "FUNDING" | "TRANSFER_PROPOSE" | "TRANSFER_ACCEPT" | "CLAIM";

const NEXT: Record<IntentState, readonly IntentState[]> = {
  DRAFT: ["VERIFIED", "FAILED"],
  VERIFIED: ["AWAITING_SIGNATURE", "FAILED"],
  // expiry before signature => FAILED (a fresh intent with fresh approval is required)
  AWAITING_SIGNATURE: ["SUBMITTED", "FAILED"],
  // A submitted tx is never "retried with changed parameters": it resolves or goes RECONCILING.
  SUBMITTED: ["CONFIRMED", "FAILED", "RECONCILING"],
  RECONCILING: ["CONFIRMED", "FAILED"],
  CONFIRMED: [],
  FAILED: [],
};

export const isTerminal = (s: IntentState) => NEXT[s].length === 0;

export function assertTransition(from: IntentState, to: IntentState): void {
  if (!NEXT[from].includes(to)) {
    throw new AppError(409, "ILLEGAL_STATE_TRANSITION", `intent cannot move ${from} -> ${to}`);
  }
}

/** What the wallet must sign: a contract invocation descriptor, not a transaction. */
export interface InvocationDescriptor {
  contractId: string;
  function: string;
  /** Ordered, typed arguments; values are strings (u64/i128 decimal, addresses as strkeys, bytes hex). */
  args: { name: string; type: "u64" | "i128" | "address" | "bytes32"; value: string }[];
}

export interface Intent {
  id: string;
  schemaVersion: 1;
  requestId: string;
  kind: IntentKind;
  circleId: string;
  poolId: string;
  actorUserId: string;
  actorAddress: string;
  state: IntentState;
  descriptor: InvocationDescriptor;
  /** Entity the intent acts on (chain ids), for matching indexer events. */
  expectEvent: { name: string; refs: Record<string, string> };
  idempotencyKey: string;
  txHash: string | null;
  submittedAt: string | null;
  confirmedEventId: string | null;
  failureReason: string | null;
  /** Ledger the preconditions were verified against (informational; chain decides). */
  verifiedAtLedger: number;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}
