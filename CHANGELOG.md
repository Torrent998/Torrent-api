# Changelog
## Unreleased
- Organizer signing requests: `POST /v1/circles/{id}/pool-intent` (create_pool, bound back by the indexed pool_created), `/rights-intent` (issue_right, refused up front when unbacked, owner not a member, maturity in the past or caller not the controller) and `/close-intent` (close_pool). New intent kinds `POOL_CREATE`, `RIGHT_ISSUE`, `POOL_CLOSE`; OpenAPI regenerated; 6 tests. Live script `scripts/testnet-e2e.ts` drives login, circle, pool binding, a prepared Soroban deposit and its confirmation against Testnet.
- Targets torrent-escrow **ABI v2**: `TRANSFER_CANCEL` (`POST /v1/transfers/{id}/cancel`, proposer only, on-chain pending
  offers only) and `POOL_LEAVE` (`POST /v1/circles/{id}/leave-intent`, refused while owning an unclaimed right) intents;
  `GET /v1/contract` (ledger-derived governance); `Closed` pools refuse funding and transfers; the contract's timing rules
  (`RIGHT_MATURED`, offers may not outlive maturity) are checked before any signature request; transfer listing adds
  `CANCELLING` / `CANCELLED`. Indexer fixtures re-mirrored (ABI v2 stream). OpenAPI and examples regenerated. 98 tests.
- `npm start` loads `.env` when present; README overhaul, security policy, code of conduct, issue forms, Dependabot and repo-specific contributor tasks.
- M0: SRD v1 endpoints as a Zod route registry, generated OpenAPI 3.1 (`openapi/openapi.v1.json`), consumer fixtures from torrent-indexer, ADR 0001.
- M1: intent state machine, signed-XDR verification, idempotency, pool binding by policy hash, indexer-derived coverage/rights.
- M2 (partial): atomic file persistence, reconcile loop, RBAC, audit trail, rate limiting. No PostgreSQL/queues yet.
