import { ArgumentsHost, CanActivate, Catch, ExceptionFilter, ExecutionContext, HttpException, Inject, Injectable, Logger, NestMiddleware } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { AppError } from "../common/errors.js";

export const RATE_LIMIT = Symbol("RATE_LIMIT");
const SAFE_ID = /^[A-Za-z0-9_-]{8,64}$/;

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request & { requestId?: string }, res: Response, next: NextFunction): void {
    const inbound = req.headers["x-request-id"];
    req.requestId = typeof inbound === "string" && SAFE_ID.test(inbound) ? inbound : `req_${randomUUID()}`;
    res.setHeader("x-request-id", req.requestId);
    res.setHeader("cache-control", "no-store");
    next();
  }
}

/** All errors use {"error":{"code","message","requestId"}}; internals and input values are never echoed. */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly log = new Logger("errors");
  catch(e: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<Request & { requestId?: string }>();
    const res = http.getResponse<Response>();
    const requestId = req.requestId ?? "req_unknown";
    let status = 500; let code = "INTERNAL"; let message = "internal error";
    if (e instanceof AppError) { status = e.status; code = e.code; message = e.message; }
    else if (e instanceof ZodError) {
      status = 400; code = "VALIDATION_ERROR";
      message = e.issues.slice(0, 5).map((i) => `${i.path.join(".") || "request"}: ${i.message}`).join("; ");
    } else if (e instanceof HttpException) {
      status = e.getStatus();
      code = status === 404 ? "NOT_FOUND" : status === 413 ? "PAYLOAD_TOO_LARGE" : status === 400 ? "BAD_REQUEST" : "HTTP_ERROR";
      message = status === 404 ? "no such route" : status === 413 ? "request body too large" : status === 400 ? "malformed request" : "request failed";
    } else if ((e as { type?: string }).type === "entity.too.large") {
      status = 413; code = "PAYLOAD_TOO_LARGE"; message = "request body too large";
    } else if ((e as { type?: string }).type === "entity.parse.failed") {
      status = 400; code = "BAD_REQUEST"; message = "malformed JSON body";
    } else {
      const name = e instanceof Error ? e.name : "unknown";
      this.log.error(`unhandled ${name} (requestId=${requestId})`); // no message/stack: may contain user data
    }
    res.status(status).json({ error: { code, message, requestId } });
  }
}

/** Fixed-window per-caller limiter (in-memory, single process). */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly hits = new Map<string, { windowStart: number; n: number }>();
  constructor(@Inject(RATE_LIMIT) private readonly cfg: { limit: number; windowMs: number }) {}
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    const key = `${createHash("sha256").update(req.headers["authorization"] ?? "").digest("hex")}|${req.ip ?? ""}`;
    const t = Date.now();
    const h = this.hits.get(key);
    if (!h || t - h.windowStart >= this.cfg.windowMs) { this.hits.set(key, { windowStart: t, n: 1 }); return true; }
    if (++h.n > this.cfg.limit) throw new AppError(429, "RATE_LIMITED", "too many requests");
    return true;
  }
}
