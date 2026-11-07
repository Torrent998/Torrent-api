# Torrent â€” Environment, Deployment and Recovery

## Environment boundaries
- Local: deterministic Docker Compose services, Stellar local network/Testnet, synthetic users/fixtures.
- Staging: separate database, bucket, API credentials, signing identities, Testnet assets/contracts, observability.
- Production: requires security audit, real issuer/provider agreements and relevant jurisdictional legal/compliance review. Not included in this Testnet prototype.

## Suggested variables (non-secret examples only)
```dotenv
APP_ENV=development
STELLAR_NETWORK=testnet
STELLAR_RPC_URL=https://soroban-testnet.stellar.org
HORIZON_URL=https://horizon-testnet.stellar.org
DATABASE_URL=postgresql://localhost:5432/torrent
REDIS_URL=redis://localhost:6379
API_BASE_URL=http://localhost:3001
CHAIN_START_LEDGER=0
LOG_LEVEL=info
```
- Credentials to sign on-chain go into a secure secret manager or hardware-backed user wallet, never into a public mobile/web bundle.
- Signed store badge links are configured after actual publication; no fabricated App Store or Google Play app URLs.

## CORS for the browser app

The web app calls this API from the browser, so the API must name the web app's origin. Set on the host (Render, Railway, Fly):

```
CORS_ALLOWED_ORIGINS=https://torrent-web1.vercel.app
```

Exact origins only (scheme + host + port), comma-separated; a wildcard or a malformed entry stops the process at startup. Unset means no CORS headers at all, so a
browser on another origin cannot read any response. Preflight (`OPTIONS`) is answered with `204` before authentication. The session token travels in the
`Authorization` header, never in a cookie, so credentials are never allowed. Checked by `test/cors.test.ts` (9 tests).

## CI & GitHub setup
- GitHub Actions per repo: formatting/lint, schema checks, unit tests, dependency scanning; chain/devices smoke tests where supported.
- Branch protection and PR review recommended.
- Release tag points to tested sibling versions in an integration lockfile.
- All paths use offline/synthetic test fixtures, not real user financial records.

## Failure recovery
- Rebuild indexers from ledger cursor; compare DB projection vs chain truth.
- Restore DB backups after verifying transaction-intent reconciliation.
- Never republish user transactions solely because a client request timed out.
- Test signing-key rotation, dependency outages, stale quotes, malicious user input, insufficient balances and duplicate delivery.
- External reference infrastructure may change; check upstream project versions and licenses at build time.

## Live run against Testnet (2026-11-04)

Services ran locally: `Torrent-indexer` (port 4002, `CHAIN_START_LEDGER=5553711`) and `Torrent-api` (port 4001,
`INDEXER_BASE_URL=http://localhost:4002`), both with `TORRENT_ESCROW_CONTRACT_ID=CBWF73FUJDGXSXOYUVYHP3XAFSPZWX65YGFSXDSSF5VRFLEWFFTQUIJG`. The scripts are
`scripts/testnet-e2e.ts` (deposit flow) and `scripts/testnet-e2e.ts organizer` (organizer flow). Secret seeds are read in
memory from the local stellar-cli keystore and never printed. Evidence (public data only) is in
`Torrent-contracts/deployments/testnet-api-e2e.json` and `testnet-api-organizer-e2e.json`; every hash was checked as
`successful` on Horizon.

What a real wallet does was reproduced in the script: build the contract invocation from the intent's descriptor, let the
network fill footprint, fee and auth (`prepareTransaction`), sign as the intent's actor, submit through
`POST /v1/intents/{id}/submit`. The API's signed-XDR verification accepted these real prepared transactions without changes.

### Deposit flow
| Step | Result | Tx |
|---|---|---|
| organizer logs in by signing the wallet challenge (SEP-53) | ok |  |
| circle created (off-chain agreement + policy hash) | ok |  |
| organizer creates the on-chain pool with the circle policy hash (stellar-cli) | ok |  |
| API binds the circle to the pool from indexed pool_created (by policy hash) | ok |  |
| deposit intent signed with a real prepared Soroban tx and submitted through the API | ok | [a2fcbb564b…](https://stellar.expert/explorer/testnet/tx/a2fcbb564bdb776389c0290e56e1e703ba719cc93c5794a4e99f1d57b75144e8) |
| intent CONFIRMED after the indexer ingested the funded event for that tx hash | ok | [a2fcbb564b…](https://stellar.expert/explorer/testnet/tx/a2fcbb564bdb776389c0290e56e1e703ba719cc93c5794a4e99f1d57b75144e8) |
| coverage endpoint shows funded 2500000 (ledger-derived) | ok |  |

### Organizer flow (new endpoints: create pool, issue right, close pool)
| Step | Result | Tx |
|---|---|---|
| create_pool: API signing request -> real prepared tx -> CONFIRMED by the indexed event | ok | [68ae86c526…](https://stellar.expert/explorer/testnet/tx/68ae86c526ee6927b215e28640c4e533accd9a5a3e784d452842520e7529ae30) |
| circle bound to the pool created through the API | ok |  |
| member allowed and joined on-chain (stellar-cli; the API has no join request) | ok |  |
| deposit: API signing request -> real prepared tx -> CONFIRMED by the indexed event | ok | [b1e5dd5f79…](https://stellar.expert/explorer/testnet/tx/b1e5dd5f7972e6e50de47cc1a6fb6e0277da4e7df4aac49eeb10cebf244978f8) |
| unbacked issue_right is refused by the API before signing (INSUFFICIENT_BACKING) | ok |  |
| issue_right: API signing request -> real prepared tx -> CONFIRMED by the indexed event | ok | [14db7add74…](https://stellar.expert/explorer/testnet/tx/14db7add74079b76531caa3588ae93a1b60cfc1bf2922b5896d342b1fcae4fb9) |
| close_pool: API signing request -> real prepared tx -> CONFIRMED by the indexed event | ok | [44df9338f0…](https://stellar.expert/explorer/testnet/tx/44df9338f0dd965130f66f1549faf0b5f58ea3661ba4eb23b2a0184a50cd4a90) |
| coverage after the organizer flow | ok |  |

Honest limits:
- Wallet signing here is a Testnet key through the Stellar SDK, **not Freighter**. See `Torrent-web/docs/FREIGHTER_WALKTHROUGH.md`.
- Joining a pool on-chain (`allow_member`, `join_pool`) has no API signing request; the run used stellar-cli for it.
- Transfers (propose/approve/accept) and claim intents were not run live; they are covered by the in-process tests only.
- Failed attempts during development (a polling bug in the script) left extra circles/pools on Testnet; only the runs above are recorded.
