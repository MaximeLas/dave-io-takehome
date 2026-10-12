// Is the graph the one the answer key was derived from, and is it ready for the agent? The
// seed loads a fixed number of nodes and relationships; anything else means the container
// is down, still seeding, or holds another dataset, and every answer measured against it
// would be wrong for reasons that have nothing to do with the agent. The description index
// the search tool reads is checked for the same reason: without it, every search would come
// back to the model as a tool error. Checked before any model token is spent.
import neo4j from "neo4j-driver";

import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL_ID, EMBEDDING_PROPERTY, INDEX_NAME } from "../search/model.js";
import { getDriver } from "./driver.js";

/** The counts the fixture's seed produces; eval/expected.generated.json assumes exactly this graph. */
export const EXPECTED_NODES = 297;
export const EXPECTED_RELATIONSHIPS = 579;

/** Throws, with the fix, unless the graph is reachable, fully seeded and indexed. Returns the counts otherwise. */
export async function assertGraphReady(): Promise<{ nodes: number; relationships: number }> {
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
  await assertIndexReady();
  return { nodes, relationships };
}

/** Throws, with the fix, unless the index exists for this model and revision, is online, and covers every node. */
async function assertIndexReady(): Promise<void> {
  const driver = getDriver();
  const fix = "Build it with `npm run index`.";
  const { records } = await driver.executeQuery(
    "SHOW VECTOR INDEXES YIELD name, state WHERE name = $name RETURN state",
    { name: INDEX_NAME },
  );
  if (records.length === 0) throw new Error(`The description index for ${EMBEDDING_MODEL_ID} is missing. ${fix}`);
  const state = records[0]?.get("state") as string;
  if (state !== "ONLINE") throw new Error(`The description index is ${state}, not ONLINE. ${fix}`);

  const { records: coverage } = await driver.executeQuery(
    `MATCH (n:Entity)
     RETURN count(n) AS nodes, count(CASE WHEN size(n.\`${EMBEDDING_PROPERTY}\`) = $dimensions THEN 1 END) AS covered`,
    { dimensions: neo4j.int(EMBEDDING_DIMENSIONS) },
  );
  const total = Number(coverage[0]?.get("nodes") ?? 0);
  const covered = Number(coverage[0]?.get("covered") ?? 0);
  if (covered !== total) throw new Error(`The description index covers ${covered} of ${total} nodes. ${fix}`);
}
