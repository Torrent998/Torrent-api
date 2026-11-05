import type { NextFunction, Request, Response } from "express";

/**
 * CORS for the browser app (torrent-web). Off by default: with no allowed origins configured no CORS
 * header is ever sent and browsers keep the same-origin policy. Origins are matched exactly (scheme +
 * host + port). The session token travels in the Authorization header, never in a cookie, so
 * `Access-Control-Allow-Credentials` is never sent and a wildcard is not accepted.
 */
export interface CorsPolicy {
  /** exact origins such as https://torrent-web1.vercel.app */
  readonly allowedOrigins: readonly string[];
}

export const CORS_ALLOWED_METHODS = "GET, POST, OPTIONS";
export const CORS_ALLOWED_HEADERS = "authorization, content-type, idempotency-key, x-request-id";
export const CORS_MAX_AGE_SECS = 600;

/** Parses CORS_ALLOWED_ORIGINS ("https://a.example, http://localhost:3000"). Throws on anything that is not a bare origin. */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  if (!raw || !raw.trim()) return [];
  const out: string[] = [];
  for (const part of raw.split(",").map((p) => p.trim()).filter(Boolean)) {
    if (part === "*") throw new Error('CORS_ALLOWED_ORIGINS: "*" is not accepted; list the exact origins');
    let u: URL;
    try { u = new URL(part); } catch { throw new Error(`CORS_ALLOWED_ORIGINS: "${part}" is not a URL`); }
    if ((u.protocol !== "https:" && u.protocol !== "http:") || u.origin !== part.replace(/\/$/, "").toLowerCase() || u.pathname !== "/" || u.search || u.hash || u.username) {
      throw new Error(`CORS_ALLOWED_ORIGINS: "${part}" must be a bare origin like https://torrent-web1.vercel.app`);
    }
    out.push(u.origin);
  }
  return [...new Set(out)];
}

/** Returns the value for Access-Control-Allow-Origin, or undefined when the origin is not allowed. */
export function allowOrigin(policy: CorsPolicy | undefined, origin: string | undefined): string | undefined {
  if (!policy || !origin || origin === "null") return undefined;
  let normalized: string;
  try { normalized = new URL(origin).origin; } catch { return undefined; }
  return normalized === origin.toLowerCase() && policy.allowedOrigins.includes(normalized) ? origin : undefined;
}

/**
 * Express middleware, registered before authentication, rate limiting and routing so that a browser
 * preflight (which carries no Authorization header) is answered here and never reaches a guard.
 */
export function corsMiddleware(policy: CorsPolicy) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
    const allowed = allowOrigin(policy, origin);
    const preflight = req.method === "OPTIONS" && typeof req.headers["access-control-request-method"] === "string";
    if (origin) res.vary("Origin");
    if (preflight) {
      if (!allowed) { res.status(403).json({ error: { code: "CORS_ORIGIN_NOT_ALLOWED", message: "origin not allowed" } }); return; }
      res.setHeader("access-control-allow-origin", allowed);
      res.setHeader("access-control-allow-methods", CORS_ALLOWED_METHODS);
      res.setHeader("access-control-allow-headers", CORS_ALLOWED_HEADERS);
      res.setHeader("access-control-max-age", String(CORS_MAX_AGE_SECS));
      res.status(204).end();
      return;
    }
    if (allowed) {
      res.setHeader("access-control-allow-origin", allowed);
      res.setHeader("access-control-expose-headers", "x-request-id");
    }
    next();
  };
}
