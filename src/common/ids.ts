import { randomBytes, createHash } from "node:crypto";

/** Opaque public ids: prefix + 128 random bits. They reveal nothing about ordering or counts. */
export const newId = (prefix: string): string => `${prefix}_${randomBytes(16).toString("base64url")}`;
export const sha256Hex = (s: string): string => createHash("sha256").update(s).digest("hex");
export const newSecretToken = (): string => randomBytes(32).toString("base64url");
