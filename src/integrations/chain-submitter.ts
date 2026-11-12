import { rpc } from "@stellar/stellar-sdk";

export const CHAIN_SUBMITTER = Symbol("CHAIN_SUBMITTER");

export type ChainTxStatus = "PENDING" | "SUCCESS" | "FAILED" | "NOT_FOUND";

/** Sends already-signed transactions and reports their fate. It never signs or edits anything. */
export interface ChainSubmitter {
  /** Returns accepted=false only for definitive rejection; network errors must throw (=> RECONCILING path). */
  submit(signedXdr: string, txHash: string): Promise<{ accepted: boolean; detail?: string }>;
  status(txHash: string): Promise<ChainTxStatus>;
}

export type RpcServerLike = Pick<rpc.Server, "getNetwork" | "sendTransaction" | "getTransaction">;

/** Default bound for Soroban Testnet RPC calls (generous enough for slow Testnet ledgers). */
export const DEFAULT_RPC_TIMEOUT_MS = 15_000;

function withTimeout<T>(op: () => Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new Error(`Soroban RPC ${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    op().then(
      (val) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(val);
      },
      (err: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/**
 * Real Soroban RPC submitter. STATUS: compiled, NOT exercised against a live Testnet in this repo
 * (no deployed contract, no network access during authoring). Tests use TestChainSubmitter.
 */
export class SorobanRpcSubmitter implements ChainSubmitter {
  private readonly server: RpcServerLike;

  constructor(
    urlOrServer: string | RpcServerLike,
    private readonly timeoutMs = DEFAULT_RPC_TIMEOUT_MS,
  ) {
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error("SorobanRpcSubmitter timeoutMs must be a positive number");
    }
    this.server = typeof urlOrServer === "string" ? new rpc.Server(urlOrServer) : urlOrServer;
  }

  async submit(signedXdr: string, txHash: string) {
    const { TransactionBuilder } = await import("@stellar/stellar-sdk");
    void txHash;
    const res = await withTimeout(
      async () => {
        const { passphrase } = await this.server.getNetwork();
        return this.server.sendTransaction(TransactionBuilder.fromXDR(signedXdr, passphrase));
      },
      this.timeoutMs,
      "submit",
    );
    if (res.status === "ERROR") return { accepted: false, detail: "rejected by network" };
    return { accepted: true, detail: res.status };
  }

  async status(txHash: string): Promise<ChainTxStatus> {
    const r = await withTimeout(() => this.server.getTransaction(txHash), this.timeoutMs, "status");
    return r.status === "SUCCESS" ? "SUCCESS" : r.status === "FAILED" ? "FAILED" : "NOT_FOUND";
  }
}
