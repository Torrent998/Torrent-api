import { rpc } from "@stellar/stellar-sdk";

export type ChainTxStatus = "PENDING" | "SUCCESS" | "FAILED" | "NOT_FOUND";

/** Sends already-signed transactions and reports their fate. It never signs or edits anything. */
export interface ChainSubmitter {
  /** Returns accepted=false only for definitive rejection; network errors must throw (=> RECONCILING path). */
  submit(signedXdr: string, txHash: string): Promise<{ accepted: boolean; detail?: string }>;
  status(txHash: string): Promise<ChainTxStatus>;
}

/**
 * Real Soroban RPC submitter. STATUS: compiled, NOT exercised against a live Testnet in this repo
 * (no deployed contract, no network access during authoring). Tests use TestChainSubmitter.
 */
export class SorobanRpcSubmitter implements ChainSubmitter {
  private readonly server: rpc.Server;
  constructor(url: string) { this.server = new rpc.Server(url); }

  async submit(signedXdr: string, txHash: string) {
    const { TransactionBuilder } = await import("@stellar/stellar-sdk");
    void txHash;
    const res = await this.server.sendTransaction(TransactionBuilder.fromXDR(signedXdr, (await this.server.getNetwork()).passphrase));
    if (res.status === "ERROR") return { accepted: false, detail: "rejected by network" };
    return { accepted: true, detail: res.status };
  }

  async status(txHash: string): Promise<ChainTxStatus> {
    const r = await this.server.getTransaction(txHash);
    return r.status === "SUCCESS" ? "SUCCESS" : r.status === "FAILED" ? "FAILED" : "NOT_FOUND";
  }
}
