// Preflight: is everything the agent needs reachable and in the expected state?
// Run before working on the agent or running the eval: `npm run check`. Costs no model tokens.
import neo4j from "neo4j-driver";

// The expected answers in eval/expected.generated.json were derived from exactly this graph.
const EXPECTED_NODES = 297;
const EXPECTED_RELATIONSHIPS = 579;

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}: copy .env.example to .env and fill it in.`);
  return value;
};

// Listing models validates the key without spending tokens.
const response = await fetch("https://api.anthropic.com/v1/models", {
  headers: { "x-api-key": env("APP_ANTHROPIC_API_KEY"), "anthropic-version": "2023-06-01" },
});
if (!response.ok) throw new Error(`APP_ANTHROPIC_API_KEY was rejected: HTTP ${response.status}`);
console.log("ok  APP_ANTHROPIC_API_KEY is valid");

await import("deepagents");
console.log("ok  deepagents loads");

const driver = neo4j.driver(
  env("NEO4J_URI"),
  neo4j.auth.basic(env("NEO4J_USER"), env("NEO4J_PASSWORD")),
);
try {
  const { records } = await driver.executeQuery(
    "CALL { MATCH (n) RETURN count(n) AS nodes } CALL { MATCH ()-[r]->() RETURN count(r) AS rels } RETURN nodes, rels",
  );
  const nodes = records[0]?.get("nodes").toNumber() ?? 0;
  const rels = records[0]?.get("rels").toNumber() ?? 0;
  if (nodes !== EXPECTED_NODES || rels !== EXPECTED_RELATIONSHIPS) {
    throw new Error(
      `Graph has ${nodes} nodes and ${rels} relationships, expected ${EXPECTED_NODES} and ${EXPECTED_RELATIONSHIPS}. ` +
        "Wait for the seed to finish, or re-run `docker compose up -d --build`.",
    );
  }
  console.log(`ok  Neo4j seeded: ${nodes} nodes, ${rels} relationships`);
} finally {
  await driver.close();
}
