import { createHash, timingSafeEqual } from "node:crypto";
import { CanActivate, ExecutionContext, Inject, Injectable, createParamDecorator } from "@nestjs/common";
import { unauthorized } from "../common/errors.js";

export type Role = "user" | "auditor";
export interface Principal {
  userId: string;
  /** Stellar account the user signs with. Server never holds this key. */
  stellarAddress: string;
  roles: Role[];
}

export interface TokenVerifier {
  verify(bearer: string): Principal | null;
}

/**
 * DEV/TEST ADAPTER, not an identity provider. Maps pre-shared random bearer tokens (kept as
 * sha256 hashes in memory, supplied via env/test code, never committed) to synthetic principals.
 * Must not be enabled in production: main.ts refuses it when APP_ENV=production.
 */
export class StaticTokenVerifier implements TokenVerifier {
  private readonly byHash = new Map<string, Principal>();
  constructor(tokens: Record<string, Principal>) {
    for (const [t, p] of Object.entries(tokens)) this.byHash.set(h(t), p);
  }
  verify(bearer: string): Principal | null {
    const want = Buffer.from(h(bearer));
    for (const [k, p] of this.byHash) {
      const have = Buffer.from(k);
      if (have.length === want.length && timingSafeEqual(have, want)) return p;
    }
    return null;
  }
}
const h = (s: string) => createHash("sha256").update(s).digest("hex");

export const TOKEN_VERIFIER = Symbol("TOKEN_VERIFIER");

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(TOKEN_VERIFIER) private readonly verifier: TokenVerifier) {}
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{ headers: Record<string, string | undefined>; principal?: Principal }>();
    const m = /^Bearer ([A-Za-z0-9._~-]{16,200})$/.exec(req.headers["authorization"] ?? "");
    if (!m) throw unauthorized();
    const p = this.verifier.verify(m[1]!);
    if (!p) throw unauthorized("invalid token");
    req.principal = p;
    return true;
  }
}

export const CurrentPrincipal = createParamDecorator((_d: unknown, ctx: ExecutionContext): Principal => {
  return ctx.switchToHttp().getRequest<{ principal: Principal }>().principal;
});
