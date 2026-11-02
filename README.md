<img src="./brand/icon.svg" alt="Torrent logo" width="144" />

# torrent-api

> Torrent — Ownership of when money becomes available.

**Status: M0 + M1 implemented, M2 partially (file persistence, in-process reconciliation). Tested with labeled test adapters; NOT run against a live Testnet; NOT production.** This repo is one of **exactly four meaningful independent codebases** in the Torrent Stellar-native project. It is not a placeholder created merely to increase Drips Wave submissions.

## Honest status
| Item | State |
|---|---|
| All SRD v1 endpoints + 5 additive ones, Zod validation, standard error schema, request ids | implemented, 68 tests |
| OpenAPI 3.1 generated from the same Zod registry; snapshot + route-parity tests | implemented (`openapi/openapi.v1.json`) |
| Intent state machine, idempotency keys, signed-XDR verification against the approved intent | implemented, failure paths tested (timeouts, expiry, stale authorization, tampered tx) |
| Ledger-derived coverage/ownership via `torrent-indexer` HTTP client | implemented; client contract-tested against the indexer's real recorded responses |
| Persistence | atomic **single-file JSON** store. **No PostgreSQL/Prisma/Redis/BullMQ** yet |
| Authentication | **dev/test adapter only** (static bearer tokens from env); no real identity provider, no KYC |
| `SorobanRpcSubmitter` | compiled, **never run against live Testnet** |
| Tests use `test/fakes.ts` (`FakeIndexer`, `TestChainSubmitter`) | clearly labeled **TEST ADAPTERS** |

The API holds no keys and no balances. See `docs/adr/0001-api-design.md`.

## Local startup
```bash
npm ci
npm run check          # typecheck + eslint + vitest (68 tests)
cp .env.example .env   # set TORRENT_ESCROW_CONTRACT_ID (no deployment exists yet) and DEV_TOKENS
npm run build && npm start   # http://localhost:3001, /v1/openapi.json, /healthz
```
Stop with Ctrl-C/SIGTERM. State: `STATE_FILE` (default `data/api-state.json`, git-ignored). Needs a running `torrent-indexer` at `INDEXER_BASE_URL`. Refuses non-Testnet networks and `APP_ENV=production`.

## Public boundary (versioned)
`openapi/openapi.v1.json`; consumes `torrent-indexer` v1 (`fixtures/`, mirrored from indexer@dbac919); intent descriptors target `torrent-contracts` ABI v1 (`deposit`, `propose_transfer`, `accept_transfer`, `claim`).

## Owns
Authenticated groups, enrollment, policy state, off-chain agreements, transaction intent orchestration, RBAC, compliance and notifications

## Why it is separate
It has a distinct runtime/toolchain, external interface, tests, release cadence and maintainership boundary. Its siblings depend on its delivered interface, but implementation responsibilities must not be duplicated.

## Sibling repositories
- `torrent-web` — Savings-circle dashboard, governance and identity UX, fully-funded payout inventory, swap/transfer requests, signing and reporting
- `torrent-contracts` — Escrow of backed assets, immutable fully-funded payout rights, transfer restrictions, schedule enforcement, claims, authorized amendments
- `torrent-indexer` — Soroban event ingestion, canonical ledger-derived read models, reconciliation, replay/backfill, settlement status and event API

## Architecture and development context
Start with:
- `AGENTS.md` — coding agent rules;
- `docs/PRD.md` — product purpose and MVP;
- `docs/SRD.md` — user/system requirements, APIs and state;
- `docs/ARCHITECTURE.md` — four-repository responsibilities, data and execution paths;
- `docs/TECHNICAL_BUILD.md` — recommended bootstrap, testing, phases;
- `docs/SECURITY.md` — security/trust boundaries;
- `docs/BRAND.md` — approved flat logo and flexible UI direction;
- `docs/ROADMAP.md` — milestone acceptance gates.

## Technical target
NestJS backend. The actual product implementation starts at milestone M0; no real-money transactions or claims exist in this scaffold.

## Minimal integration contract
Always test the dependency path stated in ARCHITECTURE.md. Every new public endpoint/ABI/package message must be versioned and covered by consumer fixtures. See `docs/SRD.md` and `docs/TECHNICAL_BUILD.md`.

## Drips Wave
Stellar is essential: Soroban escrow contract takes custody of already-funded supported Stellar assets. Approval/eligibility for Wave depends on substantive open-source implementation and organizer review, not repo count.


## Official project identity

The project uses the **approved flat SVG logo** in [`brand/icon.svg`](./brand/icon.svg), with an editable transparent vector mark in [`brand/mark.svg`](./brand/mark.svg). The [512 px GitHub organization avatar](./brand/org-avatar.png) is in the same directory. This logo is shared by all four project repositories. UI design remains intentionally flexible.
