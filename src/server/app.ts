// How the chat server's HTTP layer is set up, in one function, so the endpoint test runs
// the exact setup the server runs, the JSON-only body included.
import path from "node:path";

import type { NestExpressApplication } from "@nestjs/platform-express";

/**
 * The options the app must be created with: Nest's default body parsers off, so that
 * `configureApp` decides which bodies are parsed.
 */
export const APP_OPTIONS = { bodyParser: false } as const;

/** Applies the HTTP setup to an app created with `APP_OPTIONS`: JSON bodies, the page, no fingerprint. */
export function configureApp(app: NestExpressApplication): NestExpressApplication {
  // JSON bodies only. Nest also parses form posts by default, and a browser sends a form post
  // to another site without asking it first, so any page could make this server spend the key.
  // A JSON post from another site needs the server's permission, which it never grants.
  app.useBodyParser("json");
  app.disable("x-powered-by");
  // Relative to the working directory, the repo root, as for the runs/ folder the records go to.
  app.useStaticAssets(path.resolve("web"));
  return app;
}
