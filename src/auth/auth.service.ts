import { Inject, Injectable } from "@nestjs/common";
import { Keypair } from "@stellar/stellar-sdk";
import { createHash } from "node:crypto";
import { z } from "zod";
import { CLOCK, CONFIG, type AppConfig, type Clock } from "../common/context.js";
import { badRequest, unauthorized } from "../common/errors.js";
import { newId, newSecretToken, sha256Hex } from "../common/ids.js";
import { Database } from "../persistence/state.js";
import type { Principal, TokenVerifier } from "./auth.js";

export const challengeBody = z.object({ address: z.string().regex(/^G[A-Z2-7]{55}$/, "must be a public account address (G...)") }).strict();
export const loginBody = z.object({ challengeId: z.string().min(8).max(64), signature: z.string().min(80).max(100) }).strict();

const CHALLENGE_TTL_MS = 5 * 60_000;
const SESSION_TTL_MS = 12 * 3600_000;

/**
 * Wallet-signature login. The server issues a one-time challenge message; the wallet signs it
 * (SEP-53 `signMessage`, ed25519 over the account key) and returns the signature. The server never
 * sees a secret key; a session token proves control of the address, nothing more.
 */
@Injectable()
export class AuthService implements TokenVerifier {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CONFIG) private readonly cfg: AppConfig,
  ) {}

  challenge(address: string) {
    const now = this.clock.now();
    const id = newId("chal");
    const nonce = newSecretToken();
    const expiresAt = new Date(now.getTime() + CHALLENGE_TTL_MS).toISOString();
    const message = [
      "Torrent sign-in (Stellar Testnet prototype)",
      `network: ${this.cfg.network}`,
      `address: ${address}`,
      `nonce: ${nonce}`,
      `issued: ${now.toISOString()}`,
      `expires: ${expiresAt}`,
      "Signing proves you control this address. It does not authorize any payment.",
    ].join("\n");
    this.db.mutate((s) => {
      s.authChallenges[id] = { id, address, nonce, message, expiresAt, used: false };
      // opportunistic cleanup of old challenges
      for (const [k, c] of Object.entries(s.authChallenges)) if (Date.parse(c.expiresAt) < now.getTime() - 3600_000) delete s.authChallenges[k];
    });
    return { challengeId: id, message, expiresAt };
  }

  login(challengeId: string, signatureB64: string) {
    const now = this.clock.now();
    const ch = this.db.read().authChallenges[challengeId];
    // Same error for unknown / used / expired / bad signature: no oracle for which one failed.
    const fail = () => unauthorized("invalid or expired challenge, or signature does not verify");
    if (!ch || ch.used || Date.parse(ch.expiresAt) <= now.getTime()) throw fail();
    let sig: Buffer;
    try { sig = Buffer.from(signatureB64, "base64"); } catch { throw badRequest("BAD_SIGNATURE", "signature must be base64"); }
    if (sig.length !== 64) throw badRequest("BAD_SIGNATURE", "signature must be a 64-byte ed25519 signature (base64)");
    let ok: boolean;
    try { ok = Keypair.fromPublicKey(ch.address).verifyMessage(ch.message, sig); } catch { ok = false; }
    // The challenge is consumed on any attempt with a well-formed signature, so it cannot be brute-forced.
    this.db.mutate((s) => { s.authChallenges[ch.id]!.used = true; });
    if (!ok) throw fail();
    const token = newSecretToken();
    const userId = `usr_${createHash("sha256").update(ch.address).digest("hex").slice(0, 24)}`;
    const roles: Principal["roles"] = this.cfg.auditorAddresses?.includes(ch.address) ? ["user", "auditor"] : ["user"];
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
    const sid = newId("ses");
    this.db.mutate((s) => {
      s.sessions[sid] = { id: sid, tokenHash: sha256Hex(token), userId, address: ch.address, roles, createdAt: now.toISOString(), expiresAt, revoked: false };
      s.audit.push({ id: newId("aud"), at: now.toISOString(), actor: userId, scope: "auth", action: "auth.login", object: sid, requestId: "login" });
    });
    return { token, expiresAt, userId, address: ch.address, roles };
  }

  logout(token: string): void {
    const h = sha256Hex(token);
    this.db.mutate((s) => {
      for (const x of Object.values(s.sessions)) if (x.tokenHash === h) x.revoked = true;
    });
  }

  /** TokenVerifier: resolves a bearer token to a principal while the session is live. */
  verify(bearer: string): Principal | null {
    const h = sha256Hex(bearer);
    const now = this.clock.now().getTime();
    const sess = Object.values(this.db.read().sessions).find((x) => x.tokenHash === h);
    if (!sess || sess.revoked || Date.parse(sess.expiresAt) <= now) return null;
    return { userId: sess.userId, stellarAddress: sess.address, roles: sess.roles };
  }
}
