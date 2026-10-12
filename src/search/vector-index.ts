// The vector index over node descriptions, laid out as Neo4j's own GraphRAG tooling does:
// each node carries the vector of its own description in an `embedding` property, written
// with `db.create.setNodeVectorProperty` (stored more compactly than a plain SET), and a
// cosine vector index over that property serves the search. Vectors on the nodes, rather
// than on separate description nodes, keep the graph the agent counts and walks unchanged.
//
// The index name carries the model id, so an index built by another model reads as
// missing instead of silently answering with vectors the search phrase cannot match.
import neo4j from "neo4j-driver";

import { getDriver } from "../graph/driver.js";
import { embed, EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from "./embed.js";

/** The node property that holds each node's description vector. */
export const EMBEDDING_PROPERTY = "embedding";
/** The vector index's name, derived from the model so a model change cannot go unnoticed. */
export const INDEX_NAME = `descriptions_${EMBEDDING_MODEL.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;

const INDEX_WAIT_SECONDS = 300;

/** What a build wrote: how many nodes got a vector, from how many distinct texts. */
export interface IndexBuild {
  nodes: number;
  distinctTexts: number;
}

/**
 * Embeds every node's description and (re)builds the index. Idempotent: every vector is
 * rewritten on each run, and a vector index left by another model is dropped first.
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

/** Throws, with the fix, unless the index exists for this model, is online, and covers every node. */
export async function assertIndexReady(): Promise<void> {
  const driver = getDriver();
  const { records } = await driver.executeQuery(
    "SHOW VECTOR INDEXES YIELD name, state WHERE name = $name RETURN state",
    { name: INDEX_NAME },
  );
  const fix = "Build it with `npm run index`.";
  if (records.length === 0) throw new Error(`The description index for ${EMBEDDING_MODEL} is missing. ${fix}`);
  const state = records[0]?.get("state") as string;
  if (state !== "ONLINE") throw new Error(`The description index is ${state}, not ONLINE. ${fix}`);

  const { records: coverage } = await driver.executeQuery(
    `MATCH (n:Entity)
     RETURN count(n) AS nodes, count { MATCH (m:Entity) WHERE size(m.\`${EMBEDDING_PROPERTY}\`) = $dimensions } AS covered`,
    { dimensions: EMBEDDING_DIMENSIONS },
  );
  const nodes = Number(coverage[0]?.get("nodes") ?? 0);
  const covered = Number(coverage[0]?.get("covered") ?? 0);
  if (covered !== nodes) throw new Error(`The description index covers ${covered} of ${nodes} nodes. ${fix}`);
}
