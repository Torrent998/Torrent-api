import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import type { z } from "zod";
import { AuthGuard, CurrentPrincipal, type Principal } from "../auth/auth.js";
import { AuthService } from "../auth/auth.service.js";
import type { Ctx } from "../common/context.js";
import { badRequest, forbidden } from "../common/errors.js";
import { INDEXER } from "../modules/ledger-sync.service.js";
import type { IndexerClient } from "../integrations/indexer-client.js";
import { AuditService } from "../modules/audit.service.js";
import { CircleService, circleView } from "../modules/circle.service.js";
import { FundingService } from "../modules/funding.service.js";
import { OrganizerService } from "../modules/organizer.service.js";
import { IdempotencyService, type Reply } from "../modules/idempotency.service.js";
import { IntentService, intentView } from "../modules/intent.service.js";
import { RightsService, transferView } from "../modules/rights.service.js";
import { Database } from "../persistence/state.js";
import { buildOpenApi } from "./openapi.js";
import { RateLimitGuard } from "./infra.js";
import { nestPath, routes, type RouteId } from "./routes.js";
import * as S from "./schemas.js";

type Req = Request & { requestId?: string; headers: Request["headers"] };
const parse = <T extends z.ZodType>(s: T, v: unknown): z.infer<T> => s.parse(v);
const P = (id: RouteId) => nestPath(routes[id].path);

@Controller()
export class PublicController {
  @Get("/healthz")
  health() { return { ok: true }; }

  @Get("/v1/openapi.json")
  openapi() { return buildOpenApi(); }
}

@Controller()
@UseGuards(RateLimitGuard)
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Post(P("authChallenge")) @HttpCode(201)
  challenge(@Body() body: unknown) { return this.auth.challenge(parse(routes.authChallenge.body, body).address); }

  @Post(P("authLogin")) @HttpCode(200)
  login(@Body() body: unknown) { const b = parse(routes.authLogin.body, body); return this.auth.login(b.challengeId, b.signature); }

  @Post(P("authLogout")) @HttpCode(200) @UseGuards(AuthGuard)
  logout(@Req() req: Req) {
    this.auth.logout(/^Bearer (.+)$/.exec(req.headers["authorization"] ?? "")?.[1] ?? "");
    return { ok: true as const };
  }
}

@Controller()
@UseGuards(RateLimitGuard, AuthGuard)
export class ApiController {
  constructor(
    @Inject(CircleService) private readonly circles: CircleService,
    @Inject(FundingService) private readonly funding: FundingService,
    @Inject(OrganizerService) private readonly organizer: OrganizerService,
    @Inject(RightsService) private readonly rights: RightsService,
    @Inject(IntentService) private readonly intents: IntentService,
    @Inject(IdempotencyService) private readonly idem: IdempotencyService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(Database) private readonly db: Database,
    @Inject(INDEXER) private readonly indexer: IndexerClient,
  ) {}

  private ctx(p: Principal, req: Req): Ctx { return { principal: p, requestId: req.requestId ?? "req_unknown" }; }
  private key(req: Req): string { return IdempotencyService.validKey(req.headers["idempotency-key"] as string | undefined); }
  private once(p: Principal, req: Req, shape: unknown, fn: () => Promise<Reply>) { return this.idem.run(p.userId, this.key(req), shape, fn); }

  @Post(P("createCircle")) @HttpCode(201)
  createCircle(@CurrentPrincipal() p: Principal, @Req() req: Req, @Body() body: unknown) {
    return circleView(this.circles.create(this.ctx(p, req), parse(routes.createCircle.body, body)));
  }

  @Get(P("listCircles"))
  listCircles(@CurrentPrincipal() p: Principal, @Req() req: Req) {
    return { circles: this.circles.listFor(this.ctx(p, req)).map(circleView) };
  }

  @Get(P("getCircle"))
  getCircle(@CurrentPrincipal() p: Principal, @Req() req: Req, @Param() prm: unknown) {
    return circleView(this.circles.getForMember(this.ctx(p, req), parse(S.idParam, prm).id));
  }

  @Post(P("createInvitation")) @HttpCode(201)
  async createInvitation(@CurrentPrincipal() p: Principal, @Req() req: Req, @Param() prm: unknown, @Body() body: unknown) {
    const { id } = parse(S.idParam, prm); const b = parse(routes.createInvitation.body, body);
    const r = await this.once(p, req, { id, b, op: "invite" }, async () => {
      const { invitation, token } = this.circles.invite(this.ctx(p, req), id, b);
      return { statusCode: 201, body: { invitation: { id: invitation.id, label: invitation.label, status: invitation.status, expiresAt: invitation.expiresAt }, token } };
    });
    return r.body;
  }

  @Post(P("acceptInvitation")) @HttpCode(200)
  acceptInvitation(@CurrentPrincipal() p: Principal, @Req() req: Req, @Body() body: unknown) {
    return circleView(this.circles.accept(this.ctx(p, req), parse(routes.acceptInvitation.body, body).token));
  }

  @Post(P("createFundingIntent")) @HttpCode(201)
  async createFundingIntent(@CurrentPrincipal() p: Principal, @Req() req: Req, @Param() prm: unknown, @Body() body: unknown) {
    const { id } = parse(S.idParam, prm); const b = parse(routes.createFundingIntent.body, body);
    const key = this.key(req);
    return (await this.idem.run(p.userId, key, { id, b, op: "fund" }, async () => ({
      statusCode: 201, body: intentView(await this.funding.fundingIntent(this.ctx(p, req), id, b, key)),
    }))).body;
  }

  @Get(P("getCoverage"))
  getCoverage(@CurrentPrincipal() p: Principal, @Req() req: Req, @Param() prm: unknown) {
    return this.funding.coverage(this.ctx(p, req), parse(S.idParam, prm).id);
  }

  @Get(P("listRights"))
  listRights(@CurrentPrincipal() p: Principal, @Req() req: Req, @Param() prm: unknown) {
    return this.rights.listRights(this.ctx(p, req), parse(S.idParam, prm).id);
  }

  @Post(P("createTransferIntent")) @HttpCode(201)
  async createTransferIntent(@CurrentPrincipal() p: Principal, @Req() req: Req, @Param() prm: unknown, @Body() body: unknown) {
    const { id } = parse(S.idParam, prm); const b = parse(routes.createTransferIntent.body, body);
    const key = this.key(req);
    return (await this.idem.run(p.userId, key, { id, b, op: "transfer" }, async () => {
      const r = await this.rights.transferIntent(this.ctx(p, req), id, b, key);
      return { statusCode: 201, body: { transfer: transferView(r.transfer), intent: intentView(r.intent) } };
    })).body;
  }

  @Post(P("approveTransfer")) @HttpCode(200)
  async approveTransfer(@CurrentPrincipal() p: Principal, @Req() req: Req, @Param() prm: unknown) {
    const { id } = parse(S.idParam, prm); const key = this.key(req);
    return (await this.idem.run(p.userId, key, { id, op: "approve" }, async () => {
      const r = await this.rights.approve(this.ctx(p, req), id, key);
      return { statusCode: 200, body: { transfer: transferView(r.transfer), intent: intentView(r.intent) } };
    })).body;
  }

  @Post(P("cancelTransfer")) @HttpCode(200)
  async cancelTransfer(@CurrentPrincipal() p: Principal, @Req() req: Req, @Param() prm: unknown) {
    const { id } = parse(S.idParam, prm); const key = this.key(req);
    return (await this.idem.run(p.userId, key, { id, op: "cancel" }, async () => {
      const r = await this.rights.cancel(this.ctx(p, req), id, key);
      return { statusCode: 200, body: { transfer: transferView(r.transfer), intent: intentView(r.intent) } };
    })).body;
  }

  @Post(P("createLeaveIntent")) @HttpCode(201)
  async createLeaveIntent(@CurrentPrincipal() p: Principal, @Req() req: Req, @Param() prm: unknown, @Body() body: unknown) {
    const { id } = parse(S.idParam, prm); parse(routes.createLeaveIntent.body, body ?? {});
    const key = this.key(req);
    return (await this.idem.run(p.userId, key, { id, op: "leave" }, async () => ({
      statusCode: 201, body: { intent: intentView(await this.funding.leaveIntent(this.ctx(p, req), id, key)) },
    }))).body;
  }

  @Post(P("createPoolIntent")) @HttpCode(201)
  async createPoolIntent(@CurrentPrincipal() p: Principal, @Req() req: Req, @Param() prm: unknown, @Body() body: unknown) {
    const { id } = parse(S.idParam, prm); parse(routes.createPoolIntent.body, body ?? {});
    const key = this.key(req);
    return (await this.idem.run(p.userId, key, { id, op: "pool-create" }, async () => ({
      statusCode: 201, body: { intent: intentView(await this.organizer.createPoolIntent(this.ctx(p, req), id, key)) },
    }))).body;
  }

  @Post(P("createIssueRightIntent")) @HttpCode(201)
  async createIssueRightIntent(@CurrentPrincipal() p: Principal, @Req() req: Req, @Param() prm: unknown, @Body() body: unknown) {
    const { id } = parse(S.idParam, prm); const b = parse(routes.createIssueRightIntent.body, body);
    const key = this.key(req);
    return (await this.idem.run(p.userId, key, { id, op: "right-issue", b }, async () => ({
      statusCode: 201, body: { intent: intentView(await this.organizer.issueRightIntent(this.ctx(p, req), id, b, key)) },
    }))).body;
  }

  @Post(P("createClosePoolIntent")) @HttpCode(201)
  async createClosePoolIntent(@CurrentPrincipal() p: Principal, @Req() req: Req, @Param() prm: unknown, @Body() body: unknown) {
    const { id } = parse(S.idParam, prm); parse(routes.createClosePoolIntent.body, body ?? {});
    const key = this.key(req);
    return (await this.idem.run(p.userId, key, { id, op: "pool-close" }, async () => ({
      statusCode: 201, body: { intent: intentView(await this.organizer.closePoolIntent(this.ctx(p, req), id, key)) },
    }))).body;
  }

  @Get(P("getContract"))
  getContract() { return this.indexer.contract(); }

  @Post(P("submitTransfer")) @HttpCode(200)
  async submitTransfer(@CurrentPrincipal() p: Principal, @Req() req: Req, @Param() prm: unknown, @Body() body: unknown) {
    const { id } = parse(S.idParam, prm); const b = parse(S.signBody, body);
    const ctx = this.ctx(p, req);
    return { intent: intentView(await this.intents.submit(ctx, this.rights.currentIntentId(ctx, id), b.signedXdr)) };
  }

  @Post(P("createClaimIntent")) @HttpCode(201)
  async createClaimIntent(@CurrentPrincipal() p: Principal, @Req() req: Req, @Param() prm: unknown, @Body() body: unknown) {
    const { id } = parse(S.idParam, prm); parse(routes.createClaimIntent.body, body);
    const key = this.key(req);
    return (await this.idem.run(p.userId, key, { id, op: "claim" }, async () => {
      const r = await this.rights.claimIntent(this.ctx(p, req), id, key);
      return { statusCode: 201, body: { intent: intentView(r.intent) } };
    })).body;
  }

  @Get(P("listTransfers"))
  listTransfers(@CurrentPrincipal() p: Principal, @Req() req: Req, @Param() prm: unknown) {
    return { transfers: this.rights.listTransfers(this.ctx(p, req), parse(S.idParam, prm).id) };
  }

  @Get(P("listIntents"))
  listIntents(@CurrentPrincipal() p: Principal, @Req() req: Req, @Param() prm: unknown) {
    const ctx = this.ctx(p, req); const { id } = parse(S.idParam, prm);
    this.circles.getForMember(ctx, id);
    return { intents: this.intents.listMine(ctx, id).map(intentView) };
  }

  @Get(P("getIntent"))
  getIntent(@CurrentPrincipal() p: Principal, @Req() req: Req, @Param() prm: unknown) {
    return intentView(this.intents.get(this.ctx(p, req), parse(S.idParam, prm).id));
  }

  @Post(P("submitIntent")) @HttpCode(200)
  async submitIntent(@CurrentPrincipal() p: Principal, @Req() req: Req, @Param() prm: unknown, @Body() body: unknown) {
    return { intent: intentView(await this.intents.submit(this.ctx(p, req), parse(S.idParam, prm).id, parse(S.signBody, body).signedXdr)) };
  }

  @Get(P("ledgerEvents"))
  async ledgerEvents(@CurrentPrincipal() p: Principal, @Query() q: unknown) {
    const { cursor, limit } = parse(S.ledgerQuery, q);
    const mine = new Set(Object.values(this.db.read().circles).filter((c) => c.poolId && c.members.some((m) => m.userId === p.userId)).map((c) => c.poolId!));
    const page = await this.indexer.events(cursor ?? null, limit);
    const poolOfRight = new Map<string, string | null>();
    const events = [];
    for (const e of page.events) {
      let pool = e.refs.poolId ?? null;
      if (!pool && e.refs.rightId) {
        if (!poolOfRight.has(e.refs.rightId)) poolOfRight.set(e.refs.rightId, (await this.indexer.right(e.refs.rightId))?.poolId ?? null);
        pool = poolOfRight.get(e.refs.rightId) ?? null;
      }
      if (pool && mine.has(pool)) events.push(e);
    }
    // nextCursor advances over filtered-out events too, so clients never re-read other pools' pages.
    return { ...page, events };
  }

  @Get(P("circleAudit"))
  circleAudit(@CurrentPrincipal() p: Principal, @Req() req: Req, @Param() prm: unknown, @Query() q: unknown) {
    const { id } = parse(S.idParam, prm); const { cursor, limit } = parse(S.auditQuery, q);
    const c = this.circles.getForMember(this.ctx(p, req), id);
    if (c.organizerUserId !== p.userId && !p.roles.includes("auditor")) throw forbidden("organizer or auditor role required");
    const all = this.audit.forCircle(c.id);
    const start = cursor ? all.findIndex((e) => e.id === cursor) + 1 : 0;
    if (cursor && start === 0) throw badRequest("INVALID_CURSOR", "unknown audit cursor");
    const events = all.slice(start, start + limit);
    return { events, nextCursor: events.at(-1)?.id ?? cursor ?? null };
  }
}
