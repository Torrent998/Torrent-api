import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule, type AppDeps } from "./app.module.js";

export async function createApp(deps: AppDeps, logger: false | ("log" | "error" | "warn")[] = false): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(deps), { logger, bodyParser: true });
  app.useBodyParser("json", { limit: "64kb" });
  app.disable("x-powered-by");
  return app;
}
