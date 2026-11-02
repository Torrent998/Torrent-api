import { z } from "zod";

const I128_MAX = (1n << 127n) - 1n;

/** Amounts are integer base units carried as decimal strings; never floats. */
export const amountSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,38}$/, "amount must be a positive integer string in base units")
  .refine((s) => /^[0-9]+$/.test(s) && BigInt(s) <= I128_MAX, "amount exceeds i128");

export const parseAmount = (s: string): bigint => BigInt(amountSchema.parse(s));
