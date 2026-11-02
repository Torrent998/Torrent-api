import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { HttpIndexerClient } from "../src/integrations/indexer-client.js";

const ex = JSON.parse(readFileSync(new URL("../fixtures/indexer-api-examples.v1.json", import.meta.url), "utf8")).responses as Record<string, unknown>;
let server: Server;
afterEach(() => new Promise((r) => (server ? server.close(() => r(undefined)) : r(undefined))));

async function serve(handler: (path: string) => [number, unknown]): Promise<HttpIndexerClient> {
  server = createServer((req, res) => {
    const [code, body] = handler(req.url ?? "");
    res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
  await new Promise((r) => server.listen(0, () => r(undefined)));
  return new HttpIndexerClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 500);
}
const fromFixtures = (path: string): [number, unknown] => (path in ex ? [200, ex[path]] : [404, { error: {} }]);

describe("HttpIndexerClient against the indexer's REAL recorded responses (contract test)", () => {
  it("parses every v1 response shape", async () => {
    const c = await serve(fromFixtures);
    expect((await c.status()).status).toBe("SYNCED");
    expect((await c.pool("1"))?.totals.claimed).toBe("600");
    expect((await c.poolRights("1"))?.length).toBe(2);
    expect((await c.right("2"))?.state).toBe("Issued");
    expect((await c.transfer("2"))?.status).toBe("Cancelled");
    const page = await c.events(null, 200);
    expect(page.events).toHaveLength(14);
  });
  it("maps 404 to null", async () => {
    const c = await serve(fromFixtures);
    expect(await c.pool("99")).toBeNull();
    expect(await c.right("99")).toBeNull();
  });
  it("fails closed on schema drift, server errors and unreachable indexer", async () => {
    const drift = await serve(() => [200, { poolId: 1 }]);
    await expect(drift.pool("1")).rejects.toMatchObject({ code: "INDEXER_SCHEMA_MISMATCH", status: 503 });
    await new Promise((r) => server.close(() => r(undefined)));
    const err = await serve(() => [500, {}]);
    await expect(err.status()).rejects.toMatchObject({ code: "INDEXER_ERROR" });
    await new Promise((r) => server.close(() => r(undefined)));
    const dead = new HttpIndexerClient("http://127.0.0.1:1", 300);
    await expect(dead.status()).rejects.toMatchObject({ code: "INDEXER_UNREACHABLE" });
  });
});
