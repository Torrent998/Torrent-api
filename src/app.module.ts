import { type DynamicModule, MiddlewareConsumer, Module, type NestModule } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { AuthGuard, TOKEN_VERIFIER, type TokenVerifier } from "./auth/auth.js";
import { AuthService } from "./auth/auth.service.js";
import { CLOCK, CONFIG, type AppConfig, type Clock } from "./common/context.js";
import { ApiController, AuthController, PublicController } from "./http/api.controller.js";
import { ErrorFilter, RATE_LIMIT, RateLimitGuard, RequestIdMiddleware } from "./http/infra.js";
import { CHAIN_SUBMITTER, type ChainSubmitter } from "./integrations/chain-submitter.js";
import type { IndexerClient } from "./integrations/indexer-client.js";
import { AuditService } from "./modules/audit.service.js";
import { CircleService } from "./modules/circle.service.js";
import { FundingService } from "./modules/funding.service.js";
import { OrganizerService } from "./modules/organizer.service.js";
import { IdempotencyService } from "./modules/idempotency.service.js";
import { IntentService } from "./modules/intent.service.js";
import { INDEXER, LedgerSyncService } from "./modules/ledger-sync.service.js";
import { RightsService } from "./modules/rights.service.js";
import { Database, type StatePersistence } from "./persistence/state.js";

export interface AppDeps {
  config: AppConfig;
  clock: Clock;
  persistence: StatePersistence;
  indexer: IndexerClient;
  submitter: ChainSubmitter;
  /** Test-only override. Production wiring uses wallet-signature sessions (AuthService). */
  verifier?: TokenVerifier;
  rateLimit?: { limit: number; windowMs: number };
}

@Module({})
export class AppModule implements NestModule {
  configure(c: MiddlewareConsumer): void { c.apply(RequestIdMiddleware).forRoutes("*path"); }

  static register(d: AppDeps): DynamicModule {
    return {
      module: AppModule,
      controllers: [PublicController, AuthController, ApiController],
      providers: [
        { provide: CONFIG, useValue: d.config },
        { provide: CLOCK, useValue: d.clock },
        { provide: INDEXER, useValue: d.indexer },
        { provide: CHAIN_SUBMITTER, useValue: d.submitter },
        d.verifier ? { provide: TOKEN_VERIFIER, useValue: d.verifier } : { provide: TOKEN_VERIFIER, useExisting: AuthService },
        { provide: Database, useValue: new Database(d.persistence) },
        { provide: RATE_LIMIT, useValue: d.rateLimit ?? { limit: 120, windowMs: 60_000 } },
        RateLimitGuard,
        { provide: APP_FILTER, useClass: ErrorFilter },
        AuthGuard, AuthService, AuditService, CircleService, FundingService, OrganizerService, IdempotencyService, IntentService, LedgerSyncService, RightsService,
      ],
      exports: [IntentService, LedgerSyncService, Database],
    };
  }
}
