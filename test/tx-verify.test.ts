import { Account, Asset, Keypair, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import type { InvocationDescriptor } from "../src/domain/intent.js";
import { verifySignedTx } from "../src/integrations/tx-verify.js";
import { CONTRACT_ID, PASSPHRASE, signedTxFor } from "./helpers.js";

const kp = Keypair.random();
const other = Keypair.random();
const d: InvocationDescriptor = {
  contractId: CONTRACT_ID, function: "deposit",
  args: [
    { name: "pool_id", type: "u64", value: "1" },
    { name: "from", type: "address", value: kp.publicKey() },
    { name: "amount", type: "i128", value: "1000" },
  ],
};
const code = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as { code: string }).code; } return "OK"; };

describe("verifySignedTx", () => {
  it("accepts exactly the approved invocation and returns the tx hash", () => {
    const v = verifySignedTx(signedTxFor(d, kp), PASSPHRASE, d, kp.publicKey());
    expect(v.txHash).toMatch(/^[0-9a-f]{64}$/);
  });
  it("rejects a different amount, contract, function or argument count", () => {
    const amt = { ...d, args: d.args.map((a) => (a.name === "amount" ? { ...a, value: "999999" } : a)) };
    expect(code(() => verifySignedTx(signedTxFor(amt, kp), PASSPHRASE, d, kp.publicKey()))).toBe("TX_MISMATCH");
    expect(code(() => verifySignedTx(signedTxFor({ ...d, function: "withdraw_unreserved" }, kp), PASSPHRASE, d, kp.publicKey()))).toBe("TX_MISMATCH");
    expect(code(() => verifySignedTx(signedTxFor({ ...d, args: d.args.slice(0, 2) }, kp), PASSPHRASE, d, kp.publicKey()))).toBe("TX_MISMATCH");
    const otherContract = { ...d, contractId: "CBWLJK3P6ECN2KZZPKGUIIJ6BCJPXNQTMHMJJGJPZ2ITUJFHPXHUQGBS" };
    expect(code(() => verifySignedTx(signedTxFor(otherContract, kp), PASSPHRASE, d, kp.publicKey()))).toBe("TX_MISMATCH");
  });
  it("rejects wrong source, missing/foreign signature, wrong network, garbage", () => {
    expect(code(() => verifySignedTx(signedTxFor(d, other), PASSPHRASE, d, kp.publicKey()))).toBe("TX_MISMATCH");
    expect(code(() => verifySignedTx(signedTxFor(d, kp, { signer: other }), PASSPHRASE, d, kp.publicKey()))).toBe("TX_MISMATCH");
    expect(code(() => verifySignedTx(signedTxFor(d, kp), "Public Global Stellar Network ; September 2015", d, kp.publicKey()))).toBe("TX_MISMATCH") /* signature is over the testnet hash, so it fails on another network */;
    expect(code(() => verifySignedTx("not xdr", PASSPHRASE, d, kp.publicKey()))).toBe("TX_INVALID");
  });
  it("rejects non-contract operations", () => {
    const pay = new TransactionBuilder(new Account(kp.publicKey(), "1"), { fee: "100", networkPassphrase: PASSPHRASE })
      .addOperation(Operation.payment({ destination: other.publicKey(), asset: Asset.native(), amount: "1" }))
      .setTimeout(30).build();
    pay.sign(kp);
    expect(code(() => verifySignedTx(pay.toXDR(), PASSPHRASE, d, kp.publicKey()))).toBe("TX_MISMATCH");
  });
});
