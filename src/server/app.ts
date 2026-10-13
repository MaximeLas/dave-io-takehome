// How the chat server's HTTP layer is set up, in one function, so the endpoint tests run
// the exact setup the server runs, the JSON-only body and the host check included.
import path from "node:path";

import type { NestExpressApplication } from "@nestjs/platform-express";

/**
 * The options the app must be created with: Nest's default body parsers off, so that
 * `configureApp` decides which bodies are parsed.
 */
export const APP_OPTIONS = { bodyParser: false } as const;

/** The names a request may address the server by: the loopback names, and the host it listens on. */
export const LOOPBACK_NAMES = ["localhost", "127.0.0.1", "[::1]"] as const;

/**
 * Applies the HTTP setup to an app created with `APP_OPTIONS`: requests addressed to this machine
 * only, JSON bodies, the pages, no fingerprint. `host` is the address the server listens on.
 */
export function configureApp(app: NestExpressApplication, host = "127.0.0.1"): NestExpressApplication {
  // Listening on localhost does not keep other websites out. A site can make its own domain
  // resolve to 127.0.0.1 (DNS rebinding); the browser then treats this server as that site,
  // same origin, and lets its scripts post JSON here. The one thing such a request cannot fake
  // is the name in its Host header, which is the attacker's domain, so any other name is refused.
  const names = new Set<string>([...LOOPBACK_NAMES, host.includes(":") ? `[${host}]` : host]);
  app.use((req: { headers: { host?: string }; socket: { localPort?: number } }, res: { status(code: number): { json(body: unknown): void } }, next: () => void) => {
    const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(req.headers.host ?? "");
    if (match && names.has(match[1]!.toLowerCase()) && (!match[2] || Number(match[2]) === req.socket.localPort)) return next();
    res.status(403).json({ statusCode: 403, message: "This server answers only requests addressed to localhost." });
  });
  // JSON bodies only. Nest also parses form posts by default, and a browser sends a form post
  // to another site without asking it first, so any page could make this server spend the key.
  // A JSON post from another site needs the server's permission, which it never grants.
  app.useBodyParser("json");
  app.disable("x-powered-by");
  // Relative to the working directory, the repo root, as for the runs/ folder the records go to.
  app.useStaticAssets(path.resolve("web"));
  return app;
}
