// Preflight: is everything the agent needs reachable and in the expected state?
// Run before working on the agent or running the eval: `npm run check`. Costs no model tokens.
// Each check prints one line; the first failure prints what is wrong and how to fix it, and
// stops, since every later check depends on the earlier ones.
import { noArguments, reportFailure } from "../src/cli.js";
import { requireEnv } from "../src/env.js";
import { closeDriver } from "../src/graph/driver.js";
import { assertGraphReady } from "../src/graph/health.js";

noArguments(
  `
npm run check: checks the setup without spending a model token: the API key is accepted, the
agent library loads, and Neo4j (NEO4J_URI in .env) holds the full graph with its description index.

Options:
  --help   print this help

Example:
  npm run check
`,
  "npm run check",
);

try {
  // Listing models validates the key without spending tokens.
  const response = await fetch("https://api.anthropic.com/v1/models", {
    headers: { "x-api-key": requireEnv("APP_ANTHROPIC_API_KEY"), "anthropic-version": "2023-06-01" },
  });
  if (!response.ok) throw new Error(`APP_ANTHROPIC_API_KEY was rejected: HTTP ${response.status}. Check the key in .env.`);
  console.log("ok    APP_ANTHROPIC_API_KEY is valid");

  await import("deepagents");
  console.log("ok    deepagents loads");

  const neo4j = `Neo4j at ${requireEnv("NEO4J_URI")}`;
  const { nodes, relationships } = await assertGraphReady().catch((error: Error) => {
    throw new Error(`${neo4j}: ${error.message}`);
  });
  console.log(`ok    ${neo4j} is seeded and indexed: ${nodes} nodes, ${relationships} relationships`);
} catch (error) {
  reportFailure(error);
} finally {
  await closeDriver();
}
