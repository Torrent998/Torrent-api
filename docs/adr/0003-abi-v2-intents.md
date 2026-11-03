# ADR 0003 — Intents for torrent-escrow ABI v2

Status: accepted. Context: torrent-contracts ADR 0002 (pool close, leave, rotation, timelocked upgrades, timing rules).

## Decisions
1. **Only member-signed calls become intents.** v2 adds two: `cancel_transfer` (`TRANSFER_CANCEL`, proposer only, once
   the proposal is confirmed on-chain and still `Pending`) and `leave_pool` (`POOL_LEAVE`). Controller and admin calls
   (`close_pool`, `remove_member`, rotations, upgrades) stay with the organizer's or admin's own tooling
   (`stellar contract invoke`); the API holds no keys and does not orchestrate them.
2. **Pre-checks mirror the contract, the contract still decides.** Funding and proposals are refused for `Closed`
   pools (`POOL_CLOSED`); proposals for matured rights (`RIGHT_MATURED`) or with an expiry after maturity
   (`INVALID_EXPIRY`); approvals once the right matured or the pool is not `Active`; leaving while owning an unclaimed
   right (`MEMBER_HAS_RIGHTS`). All checks read indexer data, never the API database.
3. **Leaving is on-chain only.** A confirmed `member_left` ends pool eligibility; the circle's off-chain membership
   record (agreement history, audit) is kept.
4. **Governance is read-through.** `GET /v1/contract` returns the indexer's governance view so clients can warn about
   a pending upgrade during its 7-day timelock. The API adds no interpretation.
5. Confirmation still matches by transaction hash plus expected event name (`transfer_cancelled`, `member_left`).
