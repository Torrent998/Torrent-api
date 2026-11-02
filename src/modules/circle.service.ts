import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { CLOCK, type Clock, type Ctx } from "../common/context.js";
import { forbidden, notFound, conflict, unprocessable } from "../common/errors.js";
import { newId, newSecretToken, sha256Hex } from "../common/ids.js";
import { policyHashOf, ruleSetSchema } from "../domain/rules.js";
import { Database, type Circle, type Invitation } from "../persistence/state.js";
import { AuditService } from "./audit.service.js";
import { CONFIG, type AppConfig } from "../common/context.js";

export const createCircleBody = z.object({ name: z.string().trim().min(1).max(80), ruleSet: ruleSetSchema }).strict();
export const createInvitationBody = z.object({ label: z.string().trim().min(1).max(80) }).strict();
export const acceptInvitationBody = z.object({}).strict();

/** Public view: no internal fields; poolId only appears once bound to an on-chain pool. */
export const circleView = (c: Circle) => ({
  id: c.id, name: c.name, ruleSet: c.ruleSet, policyHash: c.policyHash, poolId: c.poolId,
  organizerAddress: c.organizerAddress,
  members: c.members.map((m) => ({ address: m.address, role: m.role, joinedAt: m.joinedAt })),
  createdAt: c.createdAt, updatedAt: c.updatedAt,
});

@Injectable()
export class CircleService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CONFIG) private readonly cfg: AppConfig,
  ) {}

  create(ctx: Ctx, body: z.infer<typeof createCircleBody>): Circle {
    const now = this.clock.now().toISOString();
    const p = ctx.principal;
    const circle: Circle = {
      id: newId("cir"), name: body.name, organizerUserId: p.userId, organizerAddress: p.stellarAddress,
      ruleSet: body.ruleSet, policyHash: policyHashOf(body.ruleSet), poolId: null,
      members: [{ userId: p.userId, address: p.stellarAddress, role: "ORGANIZER", joinedAt: now }],
      createdAt: now, updatedAt: now,
    };
    this.db.mutate((s) => {
      s.circles[circle.id] = circle;
      this.audit.record(s, { ...ctx, actor: p.userId }, `circle:${circle.id}`, "circle.create", circle.id);
    });
    return circle;
  }

  listFor(ctx: Ctx): Circle[] {
    return Object.values(this.db.read().circles).filter((c) => c.members.some((m) => m.userId === ctx.principal.userId));
  }

  /** Non-members get 404, not 403: circle existence is not disclosed. */
  getForMember(ctx: Ctx, id: string): Circle {
    const c = this.db.read().circles[id];
    if (!c || !c.members.some((m) => m.userId === ctx.principal.userId)) throw notFound("circle");
    return c;
  }

  getForOrganizer(ctx: Ctx, id: string): Circle {
    const c = this.getForMember(ctx, id);
    if (c.organizerUserId !== ctx.principal.userId) throw forbidden("organizer role required");
    return c;
  }

  invite(ctx: Ctx, circleId: string, body: z.infer<typeof createInvitationBody>): { invitation: Invitation; token: string } {
    const c = this.getForOrganizer(ctx, circleId);
    if (c.members.length >= c.ruleSet.maxMembers) throw unprocessable("CIRCLE_FULL", "circle already has the maximum number of members");
    const now = this.clock.now();
    const token = newSecretToken();
    const invitation: Invitation = {
      id: newId("inv"), circleId, tokenHash: sha256Hex(token), label: body.label, status: "PENDING",
      expiresAt: new Date(now.getTime() + this.cfg.invitationTtlSeconds * 1000).toISOString(),
      createdBy: ctx.principal.userId, createdAt: now.toISOString(),
    };
    this.db.mutate((s) => {
      s.invitations[invitation.id] = invitation;
      this.audit.record(s, { ...ctx, actor: ctx.principal.userId }, `circle:${circleId}`, "invitation.create", invitation.id);
    });
    return { invitation, token }; // token is returned once and never stored
  }

  accept(ctx: Ctx, token: string): Circle {
    const hash = sha256Hex(token);
    const inv = Object.values(this.db.read().invitations).find((i) => i.tokenHash === hash);
    if (!inv) throw notFound("invitation");
    const now = this.clock.now();
    if (inv.status !== "PENDING") throw conflict("INVITATION_NOT_PENDING", `invitation is ${inv.status}`);
    if (Date.parse(inv.expiresAt) <= now.getTime()) throw unprocessable("INVITATION_EXPIRED", "invitation has expired");
    return this.db.mutate((s) => {
      const c = s.circles[inv.circleId]!;
      if (c.members.some((m) => m.userId === ctx.principal.userId || m.address === ctx.principal.stellarAddress)) {
        throw conflict("ALREADY_MEMBER", "principal is already a member");
      }
      if (c.members.length >= c.ruleSet.maxMembers) throw unprocessable("CIRCLE_FULL", "circle already has the maximum number of members");
      c.members.push({ userId: ctx.principal.userId, address: ctx.principal.stellarAddress, role: "MEMBER", joinedAt: now.toISOString() });
      c.updatedAt = now.toISOString();
      s.invitations[inv.id]!.status = "ACCEPTED";
      this.audit.record(s, { ...ctx, actor: ctx.principal.userId }, `circle:${c.id}`, "invitation.accept", inv.id);
      return c;
    });
  }
}
