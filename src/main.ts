/**
 * Process entrypoint (Testnet only). No secrets are read: the API never holds signing keys.
 * STATUS: the real Soroban RPC submitter and HTTP indexer client are wired here but have not been
 * run against a live Testnet in this repository (no deployed contract exists yet).
 */
import { createApp } from "./bootstrap.js";
import { SorobanRpcSubmitter } from "./integrations/chain-submitter.js";
import { HttpIndexerClient } from "./integrations/indexer-client.js";
import { IntentService } from "./modules/intent.service.js";
import { SqlitePersistence } from "./persistence/sqlite.js";

const env = (k: string, d?: string): string => {
  const v = process.env[k] ?? d;
  if (v === undefined || v === "") throw new Error(`missing required env ${k}`);
  return v;
};

const appEnv = env("APP_ENV", "development");
const network = env("STELLAR_NETWORK", "testnet");
if (network !== "testnet") throw new Error("MVP is Testnet-only; mainnet requires the go-live review in docs/PROJECT_MASTER.md");
void appEnv; // wallet-signature login (AuthService) is the only authentication path

const app = await createApp(
  {
    config: {
      network,
      networkPassphrase: env("STELLAR_NETWORK_PASSPHRASE", "Test SDF Network ; September 2015"),
      contractId: env("TORRENT_ESCROW_CONTRACT_ID"),
      intentTtlSeconds: Number(env("INTENT_TTL_SECONDS", "900")),
      reconcileAfterSeconds: Number(env("SUBMITTED_RECONCILE_AFTER_SECONDS", "120")),
      maxIndexerLagLedgers: Number(env("MAX_INDEXER_LAG_LEDGERS", "10")),
      invitationTtlSeconds: 7 * 86400,
      auditorAddresses: (process.env["AUDITOR_ADDRESSES"] ?? "").split(",").map((x) => x.trim()).filter(Boolean),
    },
    clock: { now: () => new Date() },
    persistence: new SqlitePersistence(env("DATABASE_PATH", "data/torrent-api.db")),
    indexer: new HttpIndexerClient(env("INDEXER_BASE_URL", "http://localhost:3002")),
    submitter: new SorobanRpcSubmitter(env("STELLAR_RPC_URL", "https://soroban-testnet.stellar.org")),
  },
  ["log", "warn", "error"],
);
await app.listen(Number(env("PORT", "3001")));

// Bounded, observable reconciliation loop (a BullMQ worker is the planned replacement).
const intents = app.get(IntentService);
const timer = setInterval(() => {
  intents.reconcile().catch((e: unknown) => console.warn("reconcile failed:", e instanceof Error ? e.name : "unknown"));
}, Number(env("RECONCILE_INTERVAL_MS", "5000")));
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => { clearInterval(timer); void app.close().then(() => process.exit(0)); });
}
