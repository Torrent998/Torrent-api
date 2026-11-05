import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule, type AppDeps } from "./app.module.js";
import { corsMiddleware, type CorsPolicy } from "./http/cors.js";

export interface AppOptions {
  /** exact browser origins allowed to call the API; unset or empty = no CORS headers at all */
  cors?: CorsPolicy;
}

export async function createApp(deps: AppDeps, logger: false | ("log" | "error" | "warn")[] = false, options: AppOptions = {}): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(deps), { logger, bodyParser: true });
  if (options.cors && options.cors.allowedOrigins.length > 0) app.use(corsMiddleware(options.cors));
  app.useBodyParser("json", { limit: "64kb" });
  app.disable("x-powered-by");
  return app;
}
