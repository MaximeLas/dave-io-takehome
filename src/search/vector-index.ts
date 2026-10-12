// Builds the vector index over node descriptions, laid out as Neo4j's own GraphRAG tooling
// does: each node carries the vector of its own description in a property, written with
// `db.create.setNodeVectorProperty` (stored more compactly than a plain SET), and a cosine
// vector index over that property serves the search. Vectors on the nodes, rather than on
// separate description nodes, keep the graph the agent counts and walks unchanged.
//
// Whether the index is ready is checked in src/graph/health.ts, which needs only the names
// in model.ts and not the model itself.
import neo4j from "neo4j-driver";

import { getDriver } from "../graph/driver.js";
import { embed } from "./embed.js";
import { EMBEDDING_DIMENSIONS, EMBEDDING_PROPERTY, INDEX_NAME } from "./model.js";

const INDEX_WAIT_SECONDS = 300;

/** What a build wrote: how many nodes got a vector, from how many distinct texts. */
export interface IndexBuild {
  nodes: number;
  distinctTexts: number;
}

/**
 * Embeds every node's description and (re)builds the index. Idempotent: every vector is
 * rewritten on each run, and a vector index left by another model or revision is dropped first.
 */
export async function buildIndex(): Promise<IndexBuild> {
  const driver = getDriver();
  const { records } = await driver.executeQuery(
    "MATCH (n:Entity) RETURN elementId(n) AS node, n.description AS text",
  );
  const nodes = records.map((r) => ({ node: r.get("node") as string, text: (r.get("text") as string | null) ?? "" }));

  // Many nodes share one description, so each distinct text is embedded once.
  const texts = [...new Set(nodes.map((n) => n.text))];
  const vectors = await embed(texts);
  const vectorOf = new Map(texts.map((text, i) => [text, vectors[i]]));

  const { records: stale } = await driver.executeQuery(
    "SHOW VECTOR INDEXES YIELD name, properties WHERE $property IN properties AND name <> $name RETURN name",
    { property: EMBEDDING_PROPERTY, name: INDEX_NAME },
  );
  for (const record of stale) await driver.executeQuery(`DROP INDEX \`${record.get("name") as string}\``);

  await driver.executeQuery(
    `UNWIND $rows AS row
     MATCH (n) WHERE elementId(n) = row.node
     CALL db.create.setNodeVectorProperty(n, $property, row.vector)`,
    { rows: nodes.map((n) => ({ node: n.node, vector: vectorOf.get(n.text) })), property: EMBEDDING_PROPERTY },
  );
  await driver.executeQuery(
    `CREATE VECTOR INDEX \`${INDEX_NAME}\` IF NOT EXISTS
     FOR (n:Entity) ON n.\`${EMBEDDING_PROPERTY}\`
     OPTIONS { indexConfig: { \`vector.dimensions\`: $dimensions, \`vector.similarity_function\`: 'cosine' } }`,
    // A JS number reaches Cypher as a float, and the index config takes an integer.
    { dimensions: neo4j.int(EMBEDDING_DIMENSIONS) },
  );
  await driver.executeQuery("CALL db.awaitIndex($name, $seconds)", { name: INDEX_NAME, seconds: INDEX_WAIT_SECONDS });

  return { nodes: nodes.length, distinctTexts: texts.length };
}
