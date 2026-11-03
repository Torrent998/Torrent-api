# Contributor tasks for Torrent-api

Scoped tasks for contributors, including Drips Wave participants. Each one is real remaining work in this repository, with acceptance tests. They are opened as GitHub issues when a maintainer is ready to review them; nothing here is claimed as done or as funded.

Sizes: small (a day or two), medium (up to a week), large (more, usually with an ADR).

## 1. Notifications for pending transfer approvals

- **Motivation:** Recipients do not learn that a proposal is waiting for them.
- **Touches:** new `src/modules/notifications`, intent/transfer services
- **Acceptance:** A notifier interface with a labelled test adapter is called once per transfer that reaches `AWAITING_RECIPIENT`; idempotent on retries; no personal data on-chain.
- **Size:** medium
- **Non-goals:** Real email or SMS providers.

## 2. Eligibility provider interface

- **Motivation:** `EligibilityDecision` exists in the domain model but has no provider boundary.
- **Touches:** `src/domain`, `src/modules`
- **Acceptance:** Joining and transfer approval consult an eligibility provider; a labelled test adapter covers allow, deny and provider-down (fail closed).
- **Size:** medium
- **Non-goals:** Integrating a real KYC vendor.

## 3. PostgreSQL storage adapter

- **Motivation:** SQLite (`node:sqlite`) is experimental and single-node.
- **Touches:** `src/persistence`
- **Acceptance:** The existing persistence tests pass against PostgreSQL in CI (service container) with migrations and the append-only audit table.
- **Size:** large
- **Non-goals:** Dropping SQLite.

## 4. First live Testnet submission

- **Motivation:** `SorobanRpcSubmitter` has never run against Testnet.
- **Touches:** `src/integrations/chain-submitter.ts`
- **Acceptance:** After a Torrent-contracts Testnet deployment, a documented script submits one funding intent and records the transaction hash; reconciliation reaches `CONFIRMED`.
- **Size:** medium
- **Non-goals:** Mainnet.

## 5. Generated TypeScript client package

- **Motivation:** Torrent-web hand-writes its client against the OpenAPI document.
- **Touches:** `openapi/`, new package script
- **Acceptance:** A typed client is generated from `openapi.v1.json` in CI and its drift is checked.
- **Size:** small
- **Non-goals:** Changing the API surface.

## Already done

Earlier items on this list (cross-repo schemas and golden fixtures, per-repo CI, the intent state machine and reconciliation, coverage-invariant and double-claim property tests, transfer authorization, and indexer replay/backfill) are implemented; see each repository's README status table.
