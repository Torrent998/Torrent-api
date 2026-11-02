# ADR 0001 — API owns off-chain agreements and intents; the ledger owns money

Status: accepted (M1/M2 slice). Sources: `docs/SRD.md` (endpoints, error schema, state machine, idempotency), `docs/ARCHITECTURE.md` (ownership), `docs/TECHNICAL_BUILD.md`. The canonical doc set is maintained in this repo and mirrored to siblings.

## Decisions
1. **No custody, no keys.** The API returns an `InvocationDescriptor` (contract, function, typed args) inside a stateful intent. The user's wallet builds, prepares and signs the transaction. The API then *verifies* the signed XDR matches the descriptor exactly (contract, function, every argument, source account, valid signature, single operation) before forwarding. This is an interim split: there is no published contract SDK yet to own transaction building.
2. **Ledger truth comes only from torrent-indexer.** Ownership, maturity, coverage and pool state are read at request time; authorization (`owner == caller`, recipient is a pool member, pool not paused, no live proposal) is evaluated before any signature request. The API stores no balances.
3. **Policy binding.** A circle's `ruleSet` is canonicalised and hashed (sha256). The pool is bound to the circle only when an indexer `pool_created` event has the same `membership_policy_hash`, the organizer as controller and the configured token; ambiguity binds nothing.
4. **Intent state machine** `DRAFT -> VERIFIED -> AWAITING_SIGNATURE -> SUBMITTED -> CONFIRMED`, plus `FAILED` and `RECONCILING`. `SUBMITTED` is persisted *before* sending; timeouts go to `RECONCILING` and are resolved by tx hash, never by resending. `CONFIRMED` needs an indexer event with that tx hash and `CONFIRMED` finality.
5. **Idempotency**: `Idempotency-Key` required on intent-creating POSTs; same key and request returns the stored reply, same key with a different request is 409; concurrent duplicates share one execution.
6. **Fail closed**: indexer halted (`RECONCILING`), stale (lag), on another network, unreachable, or returning an unknown schema all yield 503 for sensitive actions.
7. **Privacy**: non-members get 404 for circle resources; invitation tokens and audit never contain secrets (tokens stored as sha256).
8. **Transfers are two on-chain steps** (owner `propose_transfer`, recipient `accept_transfer`) mirrored as two intents; `/approve` creates the second only while the on-chain proposal is still pending, unexpired and the owner unchanged (`STALE_TRANSFER` otherwise).
9. **Additive endpoints** beyond SRD v1: `POST /v1/invitations/accept`, `GET /v1/intents/:id`, `POST /v1/intents/:id/submit`, `GET /v1/openapi.json`, `/healthz`.

## Not done (honest list)
- **No PostgreSQL/Prisma/Redis/BullMQ.** State is an atomic single-file JSON store behind a `Database` unit-of-work, and the reconcile loop is an in-process timer. No Postgres server was available in the authoring sandbox, so a database schema would have been untested. Replace before real volume.
- **No real identity provider.** `StaticTokenVerifier` is a labeled dev/test adapter; `main.ts` refuses `APP_ENV=production`.
- No KYC/eligibility service, notifications, key rotation, or data export.
- `SorobanRpcSubmitter` and `HttpIndexerClient` have not run against a live Testnet (no deployment exists). The indexer client *is* contract-tested against the indexer's real recorded responses.
- Rate limiting is in-memory per process.
