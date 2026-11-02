import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildOpenApi } from "../src/http/openapi.js";

/** The checked-in contract. Regenerate deliberately: `UPDATE_GOLDEN=1 npm test -- openapi-snapshot`. */
describe("openapi/openapi.v1.json", () => {
  it("matches the generated document (API changes need a version decision)", () => {
    const path = new URL("../openapi/openapi.v1.json", import.meta.url);
    const doc = JSON.stringify(buildOpenApi(), null, 2) + "\n";
    if (process.env["UPDATE_GOLDEN"]) writeFileSync(path, doc);
    expect(readFileSync(path, "utf8")).toBe(doc);
  });
});
