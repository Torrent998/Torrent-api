import { Address, Keypair, Transaction, TransactionBuilder, scValToNative } from "@stellar/stellar-sdk";
import { unprocessable } from "../common/errors.js";
import type { InvocationDescriptor } from "../domain/intent.js";

export interface VerifiedTx {
  txHash: string;
  xdr: string;
}

const same = (a: unknown, b: string): boolean => {
  if (typeof a === "bigint") return a.toString() === b;
  if (a instanceof Uint8Array) return Buffer.from(a).toString("hex") === b;
  return String(a) === b;
};

/**
 * Refuses to forward anything the user did not agree to: the signed transaction must be a single
 * Soroban invocation of exactly the intent's contract, function and arguments, sourced from the
 * intent's actor, on the configured network, with a valid signature from that actor.
 */
export function verifySignedTx(
  signedXdr: string,
  networkPassphrase: string,
  d: InvocationDescriptor,
  expectedSource: string,
): VerifiedTx {
  const bad = (m: string) => unprocessable("TX_MISMATCH", m);
  let tx: Transaction;
  try {
    const parsed = TransactionBuilder.fromXDR(signedXdr, networkPassphrase);
    if (!("operations" in parsed) || "innerTransaction" in parsed) throw bad("fee-bump transactions are not accepted");
    tx = parsed as Transaction;
  } catch (e) {
    if (e instanceof Error && "code" in e) throw e;
    throw unprocessable("TX_INVALID", "signedXdr is not a valid transaction for the configured network");
  }
  if (tx.source !== expectedSource) throw bad("transaction source is not the intent actor");
  if (tx.operations.length !== 1) throw bad("exactly one operation is required");
  const op = tx.operations[0]!;
  if (op.type !== "invokeHostFunction" || op.func.type !== "hostFunctionTypeInvokeContract") throw bad("operation is not a contract invocation");
  const ic = op.func.invokeContract;
  if (Address.fromScAddress(ic.contractAddress).toString() !== d.contractId) throw bad("wrong contract");
  if (ic.functionName.toString() !== d.function) throw bad("wrong function");
  if (ic.args.length !== d.args.length) throw bad("wrong argument count");
  d.args.forEach((a, i) => {
    if (!same(scValToNative(ic.args[i]!), a.value)) throw bad(`argument ${a.name} differs from the approved intent`);
  });
  const kp = Keypair.fromPublicKey(expectedSource);
  const hash = tx.hash();
  if (!tx.signatures.some((s) => kp.verify(hash, s.signature))) throw bad("missing valid signature from the intent actor");
  return { txHash: Buffer.from(hash).toString("hex"), xdr: signedXdr };
}
