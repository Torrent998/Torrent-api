import type { Principal } from "../auth/auth.js";

export interface Clock { now(): Date }
export const CLOCK = Symbol("CLOCK");
export const CONFIG = Symbol("CONFIG");

export interface AppConfig {
  network: string;
  networkPassphrase: string;
  /** Deployed torrent-escrow contract id. */
  contractId: string;
  intentTtlSeconds: number;
  /** SUBMITTED intents with no observed event after this long move to RECONCILING. */
  reconcileAfterSeconds: number;
  /** Intent creation is refused when the indexer lags by more than this many ledgers. */
  maxIndexerLagLedgers: number;
  invitationTtlSeconds: number;
  /** Addresses granted the read-only `auditor` role on login. */
  auditorAddresses?: string[];
}

/** Per-request context passed explicitly into services. */
export interface Ctx {
  principal: Principal;
  requestId: string;
}
