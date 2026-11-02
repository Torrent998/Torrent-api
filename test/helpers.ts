import { Account, Address, Contract, Keypair, Networks, StrKey, TransactionBuilder, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import type { InvocationDescriptor } from "../src/domain/intent.js";

export const PASSPHRASE = Networks.TESTNET;
export const CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 7));
export const TOKEN_ID = StrKey.encodeContract(Buffer.alloc(32, 9));

export function argToScVal(a: InvocationDescriptor["args"][number]): xdr.ScVal {
  switch (a.type) {
    case "u64": return nativeToScVal(BigInt(a.value), { type: "u64" });
    case "i128": return nativeToScVal(BigInt(a.value), { type: "i128" });
    case "address": return new Address(a.value).toScVal();
    case "bytes32": return nativeToScVal(Buffer.from(a.value, "hex"), { type: "bytes" });
  }
}

/** Builds and signs a real Stellar transaction for a descriptor, offline, with a synthetic key. */
export function signedTxFor(d: InvocationDescriptor, kp: Keypair, opts: { source?: string; signer?: Keypair } = {}): string {
  const tx = new TransactionBuilder(new Account(opts.source ?? kp.publicKey(), "1"), { fee: "100", networkPassphrase: PASSPHRASE })
    .addOperation(new Contract(d.contractId).call(d.function, ...d.args.map(argToScVal)))
    .setTimeout(300)
    .build();
  tx.sign(opts.signer ?? kp);
  return tx.toXDR();
}
