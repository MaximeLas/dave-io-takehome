// The readiness check's advice must match the cause: a missing setting names the setting and
// .env.example, and never sends the reader to restart a database that may be running fine.
// Runs without a database: the check fails before it connects.
import assert from "node:assert/strict";
import { test } from "node:test";

import { assertGraphReady } from "./health.js";

test("a missing setting is named with its fix, not reported as an unreachable database", async () => {
  delete process.env.NEO4J_URI;
  await assert.rejects(assertGraphReady(), { message: /^Missing NEO4J_URI: copy \.env\.example to \.env/ });
});
