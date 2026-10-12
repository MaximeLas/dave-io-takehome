// Search by meaning: embeds a phrase and ranks the node descriptions by cosine similarity
// through the vector index (Neo4j's SEARCH clause).
//
// The result is grouped by description, because many nodes share one text: a description
// is listed once with every node that carries it, so a cut never splits a group. The cut
// is a number of descriptions, not a score: scores are not comparable from one phrase to
// the next (a fixed threshold lost to a top-k cut on the blind dev set, eval/search-dev-set.json),
// so the caller sees every score and the score of the first description left out, and asks
// for more when the tail is still relevant.
import neo4j from "neo4j-driver";

import { getDriver } from "../graph/driver.js";
import { embed } from "./embed.js";
import { EMBEDDING_PROPERTY, INDEX_NAME } from "./vector-index.js";

/** One description and the nodes that carry it, with its score: Neo4j's cosine score, (1 + cos) / 2. */
export interface DescriptionHit {
  score: number;
  description: string;
  ids: string[];
}

/** The best `limit` descriptions for a phrase, and what was left out. */
export interface SearchResult {
  hits: DescriptionHit[];
  totalDescriptions: number;
  /** The score of the best description left out; null when nothing was left out. */
  nextScore: number | null;
}

/** Ranks every node by how close its description's meaning is to `phrase`, grouped by description. */
export async function searchDescriptions(phrase: string, limit: number): Promise<SearchResult> {
  const [vector] = await embed([phrase]);
  const { records } = await getDriver().executeQuery(
    // Every node is asked for, so the grouping sees whole groups; at this graph's size the
    // approximate index returns them all.
    `MATCH (n:Entity)
     SEARCH n IN (VECTOR INDEX \`${INDEX_NAME}\` FOR $vector LIMIT $all) SCORE AS score
     WITH n.description AS description, score, n.id AS id ORDER BY id
     RETURN description, max(score) AS score, collect(id) AS ids
     ORDER BY score DESC`,
    { vector, all: neo4j.int(await nodeCount()) },
    { routing: neo4j.routing.READ },
  );
  const ranked = records.map((r) => ({
    score: r.get("score") as number,
    description: r.get("description") as string,
    ids: r.get("ids") as string[],
  }));
  return {
    hits: ranked.slice(0, limit),
    totalDescriptions: ranked.length,
    nextScore: ranked[limit]?.score ?? null,
  };
}

let nodes: number | undefined;

async function nodeCount(): Promise<number> {
  if (nodes === undefined) {
    const { records } = await getDriver().executeQuery(`MATCH (n:Entity) WHERE n.\`${EMBEDDING_PROPERTY}\` IS NOT NULL RETURN count(n) AS n`, {}, {
      routing: neo4j.routing.READ,
    });
    nodes = Number(records[0]?.get("n") ?? 0);
  }
  return nodes;
}
