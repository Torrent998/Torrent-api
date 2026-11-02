# ADR 0002 — SQLite persistence and wallet-signature login

Status: accepted.

## Persistence
`Database` (unit of work) sits on a `StatePersistence` interface. `SqlitePersistence` (node:sqlite, WAL, `synchronous=FULL`) keeps one table per collection plus an append-only `audit` table and a `kv` row for the ledger cache; migrations are an ordered list applied once (`schema_migrations`). `save` diffs against the last persisted bodies and writes only changed rows in one `BEGIN IMMEDIATE` transaction; any failure rolls back and the in-memory state is left unchanged. `node:sqlite` is experimental in Node 22; this is a deliberate trade-off over adding a native dependency. Not done: Postgres/Prisma, multi-process access, backups/restore tooling.

## Authentication
`POST /v1/auth/challenge` issues a one-time message (network, address, nonce, expiry, "authorizes no payment"). The wallet signs it with SEP-53 `signMessage`; `POST /v1/auth/login` verifies the ed25519 signature against the address, consumes the challenge on any well-formed attempt, and returns a random bearer token stored only as sha256. Failures share one error to avoid an oracle. Sessions expire (12 h) and can be revoked. The `auditor` role is granted by the `AUDITOR_ADDRESSES` list; it does not bypass circle membership. Not done: KYC/eligibility, refresh tokens, per-device session listing.
