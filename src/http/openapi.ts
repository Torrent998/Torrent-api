import { z } from "zod";
import { errorSchema } from "./schemas.js";
import { nestPath, routes, type RouteDef } from "./routes.js";

const js = (s: z.ZodType) => z.toJSONSchema(s, { target: "draft-2020-12", io: "output", unrepresentable: "any" });
const jsIn = (s: z.ZodType) => z.toJSONSchema(s, { target: "draft-2020-12", io: "input", unrepresentable: "any" });
const REASON: Record<number, string> = {
  400: "Validation error", 401: "Missing or invalid bearer token", 403: "Not allowed", 404: "Not found (also used to avoid disclosing existence)",
  409: "Conflict / illegal state", 422: "Business rule violated", 429: "Rate limited", 503: "Indexer halted/stale/unreachable (fail closed)",
};

function params(r: RouteDef): unknown[] {
  const out: unknown[] = [];
  const shape = (r.params as z.ZodObject | undefined)?.shape ?? {};
  for (const [name, sch] of Object.entries(shape)) out.push({ name, in: "path", required: true, schema: jsIn(sch as z.ZodType) });
  const q = (r.query as z.ZodObject | undefined)?.shape ?? {};
  for (const [name, sch] of Object.entries(q)) out.push({ name, in: "query", required: !(sch as z.ZodType).safeParse(undefined).success, schema: jsIn(sch as z.ZodType) });
  if (r.idempotent) out.push({ name: "Idempotency-Key", in: "header", required: true, schema: { type: "string", pattern: "^[A-Za-z0-9_-]{8,128}$" } });
  return out;
}

export function buildOpenApi(): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [id, r] of Object.entries(routes) as [string, RouteDef][]) {
    (paths[r.path] ??= {})[r.method] = {
      operationId: id, summary: r.summary, tags: [r.tag],
      ...(r.additive ? { "x-additive-to-srd-v1": true } : {}),
      ...(r.auth ? { security: [{ bearer: [] }] } : {}),
      parameters: params(r),
      ...(r.body ? { requestBody: { required: true, content: { "application/json": { schema: jsIn(r.body) } } } } : {}),
      responses: {
        [r.success.status]: { description: "OK", content: { "application/json": { schema: js(r.success.schema) } } },
        ...Object.fromEntries([...new Set(r.errors)].map((c) => [c, { description: REASON[c] ?? "Error", content: { "application/json": { schema: js(errorSchema) } } }])),
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: { title: "torrent-api", version: "1.0.0", description: "Testnet/synthetic only. Writes that need an on-chain action return a stateful intent, never an immediate success. Ledger truth comes from torrent-indexer." },
    servers: [{ url: "http://localhost:3001" }],
    components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
    paths,
  };
}

export { nestPath };
