// Is the graph the one the answer key was derived from? The seed loads a fixed number of
// nodes and relationships; anything else means the container is down, still seeding, or
// holds another dataset, and every answer measured against it would be wrong for reasons
// that have nothing to do with the agent. Checked before any model token is spent.
import { getDriver } from "./driver.js";

/** The counts the fixture's seed produces; eval/expected.generated.json assumes exactly this graph. */
export const EXPECTED_NODES = 297;
export const EXPECTED_RELATIONSHIPS = 579;

/** Throws, with the fix, unless the graph is reachable and fully seeded. Returns the counts otherwise. */
export async function assertGraphSeeded(): Promise<{ nodes: number; relationships: number }> {
  let nodes = 0;
  let relationships = 0;
  try {
    const { records } = await getDriver().executeQuery(
      "CALL { MATCH (n) RETURN count(n) AS nodes } CALL { MATCH ()-[r]->() RETURN count(r) AS rels } RETURN nodes, rels",
    );
    nodes = Number(records[0]?.get("nodes") ?? 0);
    relationships = Number(records[0]?.get("rels") ?? 0);
  } catch (error) {
    throw new Error(
      `Neo4j is not reachable (${error instanceof Error ? error.message : String(error)}). Start it with \`docker compose up -d --build\`.`,
    );
  }
  if (nodes !== EXPECTED_NODES || relationships !== EXPECTED_RELATIONSHIPS) {
    throw new Error(
      `Graph has ${nodes} nodes and ${relationships} relationships, expected ${EXPECTED_NODES} and ${EXPECTED_RELATIONSHIPS}. ` +
        "Wait for the seed to finish, or re-run `docker compose up -d --build`.",
    );
  }
  return { nodes, relationships };
}
