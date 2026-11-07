<div align="center">

<img src="./brand/icon.svg" alt="Torrent logo" width="96" height="96" />

# Torrent-api

**The off-chain backend of Torrent: circles, invitations, wallet sign-in and signing requests. It holds no keys and no balances.**

[![CI](https://github.com/Torrent998/Torrent-api/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Torrent998/Torrent-api/actions/workflows/ci.yml)
[![Docs](https://github.com/Torrent998/Torrent-api/actions/workflows/docs.yml/badge.svg?branch=main)](https://github.com/Torrent998/Torrent-api/actions/workflows/docs.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-42DEB4.svg)](./LICENSE)
[![Network: Stellar Testnet](https://img.shields.io/badge/network-Stellar%20Testnet-00191C.svg)](#status)
[![Status: prototype, unaudited](https://img.shields.io/badge/status-prototype%2C%20unaudited-A5F9DE.svg)](#security)
[![OpenAPI 3.1](https://img.shields.io/badge/openapi-3.1-6ba539.svg)](./openapi/openapi.v1.json)

[Live app](https://torrent-web1.vercel.app) · [Docs](https://github.com/Torrent998/Torrent-web/tree/main/gitbook) · [Quick start](#quick-start) · [OpenAPI](./openapi/openapi.v1.json) · [Architecture](./docs/ARCHITECTURE.md) · [Contributing](./CONTRIBUTING.md)

</div>

---

## What this is

Torrent lets savings-circle members trade the timing of a payout, but only for payouts that are already fully funded. The money lives in a Soroban contract. This API is
everything around it that is not money: who is in which circle, which rules the circle agreed to, who is invited, who signed in, and which transaction each member is being asked
to sign. When a member needs to deposit, transfer or claim, the API builds a signing request, checks the signed transaction against what was approved, submits it, and then waits for
the ledger (through the indexer) to confirm it. It never shows something as settled before the ledger says so.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Torrent998/Torrent-web/main/docs/screenshots/landing-hero-1440-dark.png" />
  <img src="https://raw.githubusercontent.com/Torrent998/Torrent-web/main/docs/screenshots/landing-hero-1440-light.png" alt="The Torrent web app, which consumes this API" />
</picture>

## Status

Torrent is a **Testnet prototype with synthetic funds. It has not been audited.**

| Area | State |
|---|---|
| Circles, invitations (single-use codes stored hashed), wallet sign-in (SEP-53 challenge, 12 h revocable session), auditor role | implemented |
| Signing requests (intents) for deposit, transfer propose, approve, cancel and submit, claim, leave pool | implemented, failure paths tested (timeouts, expiry, stale authorization, tampered transactions, closed pools, matured rights) |
| Organizer intents: create pool, issue right, close pool (`/v1/circles/{id}/pool-intent`, `rights-intent`, `close-intent`) | implemented; a live Testnet run created a pool, deposited, issued a right and closed the pool, and an unbacked right was refused before signing |
| Ledger truth from the indexer (coverage, ownership, pool status, governance) | implemented; the intent turned `CONFIRMED` only after the indexer saw the event |
| Browser access | exact-origin CORS allowlist (`CORS_ALLOWED_ORIGINS`); verified against the hosted API: preflight from the web origin returns 204, another origin 403 |
| OpenAPI 3.1 generated from the same Zod registry that validates requests | implemented, snapshot and route-parity tests |
| Persistence | SQLite (`node:sqlite`, WAL, versioned migrations, append-only audit). No PostgreSQL or Redis yet |
| Tests | 113 passing and 1 skipped (a golden-regeneration test that runs only with `UPDATE_GOLDEN=1`) |
| Hosted | [torrent-api-ckiq.onrender.com](https://torrent-api-ckiq.onrender.com/healthz) on Render's free plan: it sleeps when idle and its SQLite data resets on redeploy |
| Not exercised live | transfer and claim intents, and joining a pool through the API (a join has no signing request; it was done with stellar-cli) |
| Real wallet run | **not done**: nobody has signed in through the hosted app with a real Freighter wallet |
| Security audit, Mainnet, production use | **no**, **no**, **no** |

## How it fits together

Torrent is four repositories, each owning one boundary. The contract is the only writer of financial truth; the API organizes people and signing requests around it.

```mermaid
flowchart LR
  U(["Member wallet"]) -.->|signs each call| W
  W["<b>Torrent-web</b><br/>Next.js app"] -->|HTTPS, OpenAPI v1| A["<b>Torrent-api</b><br/>circles, invitations, signing requests"]
  A -->|ledger read models| I["<b>Torrent-indexer</b><br/>ledger-derived state"]
  A -->|user-signed transactions| C["<b>Torrent-contracts</b><br/>Soroban escrow on Stellar"]
  C -->|contract events via RPC| I
  classDef here fill:#42DEB4,stroke:#00191C,color:#00191C
  class A here
```

| Repository | Stack | Owns |
|---|---|---|
| [Torrent-contracts](https://github.com/Torrent998/Torrent-contracts) | Rust, Soroban SDK 29 | Escrow pools, fully backed payout rights, member-only transfers, one-time claims |
| [Torrent-indexer](https://github.com/Torrent998/Torrent-indexer) | TypeScript, Node 22, Stellar RPC | Event ingestion and the ledger-derived read models |
| **[Torrent-api](https://github.com/Torrent998/Torrent-api)** (this repo) | TypeScript, NestJS, SQLite | Circles, invitations, wallet sign-in, the signing-request state machine |
| [Torrent-web](https://github.com/Torrent998/Torrent-web) | TypeScript, Next.js 16, Tailwind CSS 4 | Landing page and app, Freighter wallet adapter |

Signing requests move through `DRAFT`, `VERIFIED`, `AWAITING_SIGNATURE`, `SUBMITTED` and `CONFIRMED`, with `FAILED` and `RECONCILING` for the rest. Every write takes an idempotency
key. A signed transaction is verified against the approved intent before submission, and a timeout reconciles by transaction hash and is never retried with new parameters.
The API pre-checks the contract's rules (closed pools, matured rights, offers that would outlive maturity, leaving while owning a right) so nobody is asked to sign a doomed transaction.

## Tech stack

| Layer | Tools |
|---|---|
| Runtime | Node.js 22.12 or newer, TypeScript (strict), NestJS |
| Validation and API contract | Zod; OpenAPI 3.1 generated from the Zod registry |
| Chain access | `@stellar/stellar-sdk`, Soroban RPC (simulate, prepare, submit) |
| Storage | SQLite through `node:sqlite` (experimental in Node 22), WAL, versioned migrations |
| Tests | Vitest, real recorded indexer responses as fixtures |
| CI | GitHub Actions: lint, typecheck, tests, build, `npm audit --omit=dev --audit-level=high` |

## Quick start

Requires Node.js 22.12 or newer.

```bash
git clone https://github.com/Torrent998/Torrent-api && cd Torrent-api
npm ci
npm run check            # eslint, typecheck, vitest, build
cp .env.example .env     # set TORRENT_ESCROW_CONTRACT_ID, INDEXER_BASE_URL and CORS_ALLOWED_ORIGINS
npm start                # http://localhost:3001  (/healthz, /v1/openapi.json)
```

For the Testnet deployment use `TORRENT_ESCROW_CONTRACT_ID=CBWF73FUJDGXSXOYUVYHP3XAFSPZWX65YGFSXDSSF5VRFLEWFFTQUIJG` and an indexer that follows it (`INDEXER_BASE_URL=https://torrent-indexer.onrender.com`).
`npm start` loads `.env` when present, accepts Testnet only and refuses to start without the required settings. Stop with Ctrl-C or SIGTERM.

| Variable | Default | Meaning |
|---|---|---|
| `TORRENT_ESCROW_CONTRACT_ID` | none, required | Contract the intents target |
| `INDEXER_BASE_URL` | `http://localhost:3002` | Torrent-indexer to read ledger state from |
| `STELLAR_RPC_URL` | `https://soroban-testnet.stellar.org` | Soroban RPC for simulate and submit |
| `STELLAR_NETWORK`, `STELLAR_NETWORK_PASSPHRASE` | `testnet`, the Testnet passphrase | Network guard |
| `DATABASE_PATH` | `data/torrent-api.db` | SQLite file |
| `CORS_ALLOWED_ORIGINS` | empty (no CORS headers) | Exact browser origins, comma-separated. A wildcard or malformed list stops startup |
| `INTENT_TTL_SECONDS` | `900` | How long a signing request stays valid |
| `SUBMITTED_RECONCILE_AFTER_SECONDS` | `120` | When a submitted intent is reconciled by hash |
| `AUDITOR_ADDRESSES` | empty | Addresses with the read-only auditor role |
| `PORT` | `3001` | HTTP port |

The public boundary is [`openapi/openapi.v1.json`](./openapi/openapi.v1.json) with example responses in [`openapi/api-examples.v1.json`](./openapi/api-examples.v1.json).

## Project structure

```text
src/http/          routes, request schemas, OpenAPI generation, CORS, error mapping
src/modules/       circles, funding, organizer intents, rights, intents, idempotency, audit, ledger sync
src/domain/        the intent state machine and the contract's rules as pre-checks
src/integrations/  indexer client, chain submitter, signed-transaction verification
src/auth/          wallet-signature login and sessions
src/persistence/   SQLite store and migrations
openapi/           OpenAPI 3.1 document and example responses (versioned boundary)
test/              unit, integration and contract tests with labeled test adapters
docs/              architecture, contract specification, security model, deployment notes, ADRs
```

Design records are in [docs/adr/](./docs/adr/). Contract specification: [docs/STELLAR_PROTOCOL.md](./docs/STELLAR_PROTOCOL.md).

## Contributing

Contributions are welcome and Torrent takes part in the Stellar Wave program on Drips. Open, scoped tasks carry the
[`Stellar Wave`](https://github.com/Torrent998/Torrent-api/issues?q=is%3Aissue+is%3Aopen+label%3A%22Stellar+Wave%22) label and one complexity label
(`trivial`, `medium` or `high`). Read [CONTRIBUTING.md](./CONTRIBUTING.md) first. Changes to the OpenAPI document are versioned and described for Torrent-web.

## Security

Unaudited prototype, Testnet only, synthetic funds only. Report vulnerabilities privately through GitHub's
[private vulnerability reporting](https://github.com/Torrent998/Torrent-api/security/advisories/new) as described in [SECURITY.md](./SECURITY.md).
The threat model is in [docs/SECURITY.md](./docs/SECURITY.md).

## Community

Questions and design discussion: [GitHub Discussions](https://github.com/Torrent998/Torrent-api/discussions).

## Maintainers

| Maintainer | Role | Link |
|---|---|---|
| Cjay | Maintainer, all four Torrent repositories | [@Cjay-Cyber-2](https://github.com/Cjay-Cyber-2) |

Organization: [Torrent998](https://github.com/Torrent998).

## Contributors

<a href="https://github.com/Torrent998/Torrent-api/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=Torrent998/Torrent-api" alt="Contributors" />
</a>

## License

[MIT](./LICENSE)
