// Runs one read-only Cypher query and returns plain rows.
//
// Safety is enforced by the database, not by inspecting the query text:
// - the query runs in a READ transaction, and the Neo4j server refuses any write inside
//   one (`Neo.ClientError.Statement.AccessMode`), so no keyword filter is needed;
// - a timeout ends runaway queries (an unbounded path search can run for minutes);
// - results are capped, and the caller is told when the cap was hit;
// - a failed query returns its error as a value, so the caller (the agent) can repair it;
// - the server's warnings are returned too: naming a label or relationship type that does
//   not exist is not an error in Cypher, it just matches nothing, and the warning is the
//   only sign of the misspelling.
import neo4j, { type Node, type Path, type Relationship } from "neo4j-driver";

import { getDriver } from "./driver.js";

export const MAX_ROWS = 100;
export const QUERY_TIMEOUT_MS = 30_000;

/** The rows of a query (at most MAX_ROWS of the totalRows found), or the database's error text. */
export type QueryResult =
  | {
      ok: true;
      columns: string[];
      rows: unknown[][];
      totalRows: number;
      truncated: boolean;
      warnings: string[];
    }
  | { ok: false; error: string };

/** Runs one read-only Cypher query. Never throws: a failure comes back as `{ ok: false }`. */
export async function runReadQuery(cypher: string): Promise<QueryResult> {
  try {
    // The whole result is fetched before the cap is applied, which is how the total is
    // known. With 297 nodes that is fine, and the timeout bounds the pathological cases.
    const { keys, records, summary } = await getDriver().executeQuery(cypher, {}, {
      routing: neo4j.routing.READ,
      transactionConfig: { timeout: QUERY_TIMEOUT_MS },
    });
    const truncated = records.length > MAX_ROWS;
    const rows = records.slice(0, MAX_ROWS).map((record) => record.toObject()).map(
      (row) => keys.map((key) => plain(row[key])),
    );
    const warnings = summary.notifications
      .filter((n) => n.severityLevel === "WARNING")
      .map((n) => n.description);
    return { ok: true, columns: keys, rows, totalRows: records.length, truncated, warnings };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// Converts a driver value into something compact and JSON-friendly. Graph objects are
// summarised: a node by its type label, id and name (descriptions are long, so the caller
// asks for `n.description` when it wants the text), a relationship by its type, a path by
// its chain of nodes and arrows, with the arrow direction kept.
function plain(value: unknown): unknown {
  if (neo4j.isNode(value)) return nodeText(value);
  if (neo4j.isRelationship(value)) return `[${value.type}]`;
  if (neo4j.isPath(value)) return pathText(value);
  if (Array.isArray(value)) return value.map(plain);
  if (value instanceof Date) return value.toISOString();
  if (value !== null && typeof value === "object") {
    if (typeof (value as { toString?: unknown }).toString === "function" && !isPlainObject(value)) {
      return String(value); // temporal and spatial types render themselves
    }
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
  }
  return value;
}

function nodeText(node: Node): string {
  const label = node.labels.filter((l) => l !== "Entity").join(":") || "Entity";
  const { id, name } = node.properties as { id?: unknown; name?: unknown };
  return `(${label} id=${String(id)} name=${String(name)})`;
}

function pathText(path: Path): string {
  let text = nodeText(path.start);
  for (const segment of path.segments) {
    const rel: Relationship = segment.relationship;
    const forward = rel.startNodeElementId === segment.start.elementId;
    text += forward ? `-[${rel.type}]->` : `<-[${rel.type}]-`;
    text += nodeText(segment.end);
  }
  return text;
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
