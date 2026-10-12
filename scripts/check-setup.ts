// Preflight: is everything the agent needs reachable and in the expected state?
// Run before working on the agent or running the eval: `npm run check`. Costs no model tokens.
import { requireEnv } from "../src/env.js";
import { closeDriver } from "../src/graph/driver.js";
import { assertGraphSeeded } from "../src/graph/health.js";

// Listing models validates the key without spending tokens.
const response = await fetch("https://api.anthropic.com/v1/models", {
  headers: { "x-api-key": requireEnv("APP_ANTHROPIC_API_KEY"), "anthropic-version": "2023-06-01" },
});
if (!response.ok) throw new Error(`APP_ANTHROPIC_API_KEY was rejected: HTTP ${response.status}`);
console.log("ok  APP_ANTHROPIC_API_KEY is valid");

await import("deepagents");
console.log("ok  deepagents loads");

try {
  const { nodes, relationships } = await assertGraphSeeded();
  console.log(`ok  Neo4j seeded and indexed: ${nodes} nodes, ${relationships} relationships`);
} finally {
  await closeDriver();
}
