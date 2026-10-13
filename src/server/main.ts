// Starts the chat server: the JSON endpoints under /api and the pages from web/ at the root.
//
// It runs from compiled output (`npm run serve`), as it would in production, not from tsx:
// tsx drops the decorator metadata Nest's dependency injection reads, so any future
// constructor dependency without an explicit @Inject would be silently undefined there
// (docs/facts.md).
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";

import { codeVersion } from "../agent/run.js";
import { requireEnv } from "../env.js";
import { assertGraphReady } from "../graph/health.js";
import { APP_OPTIONS, configureApp } from "./app.js";
import { AppModule } from "./app.module.js";

// What every chat turn needs is checked before the server listens. The graph and its
// description index for the reason the eval checks them: the tools return a database outage
// to the model as text, which would read as wrong answers instead of an error. This holds at startup only; an outage
// later shows in the trace as failed queries.
requireEnv("APP_ANTHROPIC_API_KEY");
await assertGraphReady();
// The commit every record from this server carries, read once now: `npm run serve` compiled the
// server from this tree, so a branch checked out later is not the code these runs ran.
codeVersion();

// Localhost only: the chat and the eval page spend the API key and have no login.
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 3000);
const app = configureApp(await NestFactory.create<NestExpressApplication>(AppModule, APP_OPTIONS), host);
app.enableShutdownHooks();
await app.listen(port, host);
new Logger("Main").log(`Chat at http://localhost:${port}, the eval page at http://localhost:${port}/eval.html`);
