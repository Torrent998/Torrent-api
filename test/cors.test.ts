import "reflect-metadata";
import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { createApp, type AppOptions } from "../src/bootstrap.js";
import { allowOrigin, parseAllowedOrigins } from "../src/http/cors.js";
import { MemoryPersistence } from "../src/persistence/state.js";
import { FakeIndexer, TestChainSubmitter } from "./fakes.js";
import { TestClock, testConfig } from "./helpers-app.js";

const WEB = "https://torrent-web1.vercel.app";
let app: NestExpressApplication | undefined;

async function boot(options?: AppOptions) {
  app = await createApp({ config: testConfig(), clock: new TestClock(), persistence: new MemoryPersistence(), indexer: new FakeIndexer(), submitter: new TestChainSubmitter() }, ["error"], options);
  await app.init();
  return request(app.getHttpServer());
}
afterEach(async () => { await app?.close(); app = undefined; });

describe("CORS configuration parsing", () => {
  it("parses a comma-separated list of bare origins", () => {
    expect(parseAllowedOrigins(undefined)).toEqual([]);
    expect(parseAllowedOrigins("  ")).toEqual([]);
    expect(parseAllowedOrigins(`${WEB}, http://localhost:3000/, ${WEB}`)).toEqual([WEB, "http://localhost:3000"]);
    expect(parseAllowedOrigins("HTTPS://X.Example")).toEqual(["https://x.example"]);
  });
  it("fails at startup on anything that is not a bare origin, and refuses a wildcard", () => {
    for (const bad of ["torrent-web1.vercel.app", `${WEB}/app`, "ftp://x.example", "https://u:p@x.example", "https://x.example?a=1", "*", `${WEB}, *`]) {
      expect(() => parseAllowedOrigins(bad), bad).toThrow(/CORS_ALLOWED_ORIGINS/);
    }
  });
  it("matches origins exactly (scheme, host and port)", () => {
    const p = { allowedOrigins: [WEB] };
    expect(allowOrigin(p, WEB)).toBe(WEB);
    expect(allowOrigin(p, `${WEB}.evil.test`)).toBeUndefined();
    expect(allowOrigin(p, "http://torrent-web1.vercel.app")).toBeUndefined();
    expect(allowOrigin(p, `${WEB}:8443`)).toBeUndefined();
    expect(allowOrigin(p, "null")).toBeUndefined();
    expect(allowOrigin(p, "not a url")).toBeUndefined();
    expect(allowOrigin(undefined, WEB)).toBeUndefined();
  });
});

describe("CORS on the HTTP API", () => {
  it("answers an allowed preflight with 204 and no authentication, never allowing credentials", async () => {
    const http = await boot({ cors: { allowedOrigins: [WEB] } });
    const r = await http.options("/v1/auth/challenge").set("Origin", WEB).set("Access-Control-Request-Method", "POST").set("Access-Control-Request-Headers", "content-type, authorization, idempotency-key");
    expect(r.status).toBe(204);
    expect(r.headers["access-control-allow-origin"]).toBe(WEB);
    expect(r.headers["access-control-allow-methods"]).toContain("POST");
    expect(r.headers["access-control-allow-headers"]).toContain("authorization");
    expect(r.headers["access-control-allow-headers"]).toContain("idempotency-key");
    expect(r.headers["access-control-allow-headers"]).toContain("content-type");
    expect(r.headers["access-control-max-age"]).toBe("600");
    expect(r.headers["access-control-allow-credentials"]).toBeUndefined();
    expect(r.headers["vary"]).toContain("Origin");
  });

  it("preflight also works for an authenticated route (it must never reach the auth guard)", async () => {
    const http = await boot({ cors: { allowedOrigins: [WEB] } });
    const r = await http.options("/v1/circles").set("Origin", WEB).set("Access-Control-Request-Method", "GET").set("Access-Control-Request-Headers", "authorization");
    expect(r.status).toBe(204);
  });

  it("refuses a preflight from another origin and sends no allow-origin header", async () => {
    const http = await boot({ cors: { allowedOrigins: [WEB] } });
    const r = await http.options("/v1/auth/challenge").set("Origin", "https://evil.test").set("Access-Control-Request-Method", "POST");
    expect(r.status).toBe(403);
    expect(r.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("adds allow-origin and exposes x-request-id on real responses, including errors", async () => {
    const http = await boot({ cors: { allowedOrigins: [WEB] } });
    const ok = await http.get("/healthz").set("Origin", WEB);
    expect(ok.status).toBe(200);
    expect(ok.headers["access-control-allow-origin"]).toBe(WEB);
    expect(ok.headers["access-control-expose-headers"]).toBe("x-request-id");
    const unauth = await http.get("/v1/circles").set("Origin", WEB);
    expect(unauth.status).toBe(401);
    expect(unauth.headers["access-control-allow-origin"]).toBe(WEB);
  });

  it("sends no allow-origin on real responses to a disallowed origin", async () => {
    const http = await boot({ cors: { allowedOrigins: [WEB] } });
    const r = await http.get("/healthz").set("Origin", "https://evil.test");
    expect(r.status).toBe(200); // the server answers; the browser withholds the body from the page
    expect(r.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("is off by default: no CORS headers, and a preflight is not answered specially", async () => {
    for (const options of [undefined, { cors: { allowedOrigins: [] } }]) {
      const http = await boot(options);
      const get = await http.get("/healthz").set("Origin", WEB);
      expect(get.headers["access-control-allow-origin"]).toBeUndefined();
      const pre = await http.options("/v1/auth/challenge").set("Origin", WEB).set("Access-Control-Request-Method", "POST");
      expect(pre.status).not.toBe(204);
      expect(pre.headers["access-control-allow-origin"]).toBeUndefined();
      await app!.close(); app = undefined;
    }
  });
});
