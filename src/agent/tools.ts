// The agent's tools. Each one is a function the model can call, with a zod schema for its
// input and a description written for a newcomer: what it does, what comes back, and how
// to read it. The description is part of the tool's design, since it is all the model
// knows about the tool.
import { tool } from "langchain";
import { z } from "zod";

import { MAX_ROWS, runReadQuery, type QueryResult } from "../graph/query.js";
import { searchDescriptions as rankDescriptions, type SearchResult } from "../search/search.js";

/** How many descriptions a search returns unless the model asks for another number; the best top-k on the blind dev set. */
export const SEARCH_DEFAULT_LIMIT = 10;

/** The graph query tool: the model writes Cypher and gets compact rows back. */
export const runCypher = tool(
  async ({ query }) => formatForModel(await runReadQuery(query)),
  {
    name: "run_cypher",
    description: [
      "Run one read-only Cypher query against the infrastructure graph and get the rows back.",
      "",
      "The reply starts with a line giving the row count, then `columns:` with the column names,",
      "then one row per line with values separated by ` | `. A node is shown as",
      "`(Label id=... name=...)`; ask for `n.description` explicitly when you need the text.",
      `At most ${MAX_ROWS} rows are returned; when a result is cut, the first line says how many`,
      "rows there were in total. Narrow or aggregate the query (count, collect) instead of",
      "trusting a cut result. 0 rows is reported as `0 rows`.",
      "",
      "A query that fails returns `Cypher error:` with the database's message, so you can fix",
      "the query and retry. A `warning:` line means the query named a label or relationship",
      "type that does not exist in the database; treat the result as a misspelling, not as an",
      "empty answer. Writes are refused by the database.",
    ].join("\n"),
    schema: z.object({
      query: z.string().describe("The Cypher query to run. Read-only: MATCH, RETURN, WHERE, WITH, CALL db.* for schema."),
    }),
  },
);

/** The search tool: finds resources by what their descriptions mean, for wording the model cannot guess. */
export const searchDescriptions = tool(
  async ({ query, limit }) => {
    try {
      return formatSearch(await rankDescriptions(query, limit ?? SEARCH_DEFAULT_LIMIT));
    } catch (error) {
      return `Search error: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: "search_descriptions",
    description: [
      "Find resources by what their descriptions mean, not by the exact words. Every resource in the",
      "graph has a short description of what it is for. This tool ranks those descriptions by how close",
      "their meaning is to your phrase, so it finds resources described in other words than yours",
      "(\"firewall rules\" when the description says \"security group\"). Search with a short phrase about a purpose",
      "or a role, not a whole question.",
      "",
      "The first line says how many descriptions are shown, out of how many. Then one line per description,",
      "best first: its score, the description, and the ids of every resource that carries it (many",
      "resources share one description). The score ranks descriptions within one search; it does not say",
      "whether a description is relevant. Read each description and decide, and confirm what matters with",
      "run_cypher. The last line gives the score of the best description left out.",
      "",
      `Start with the default limit (${SEARCH_DEFAULT_LIMIT}): the closest descriptions come first, and every`,
      "extra one is more to read. Search again with a larger limit only when the last ones shown are",
      "still relevant, since the next ones are then likely to be relevant too.",
      "",
      "A failure returns `Search error:` with the reason.",
    ].join("\n"),
    schema: z.object({
      query: z.string().describe("A short phrase about what the resources are for, such as \"payment data\"."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe(`How many descriptions to return, best first. Leave it out on a first search (default ${SEARCH_DEFAULT_LIMIT}).`),
    }),
  },
);

/** Lays a search out for the model: the count first, one line per description, then what was left out. */
export function formatSearch(result: SearchResult): string {
  const resources = result.hits.reduce((n, hit) => n + hit.ids.length, 0);
  const lines = [
    `${result.hits.length} of ${result.totalDescriptions} descriptions shown, best first, covering ${resources} resources.`,
  ];
  for (const hit of result.hits) lines.push(`${hit.score.toFixed(2)} | ${hit.description} | ${hit.ids.join(", ")}`);
  const left = result.totalDescriptions - result.hits.length;
  lines.push(
    result.nextScore === null
      ? "Every description is shown."
      : `${left} more not shown; the best of them scores ${result.nextScore.toFixed(2)}. Search again with a larger limit if the last ones shown are still relevant.`,
  );
  return lines.join("\n");
}

/**
 * Lays the result out as compact text for the model. The row count comes first because it
 * is the fact the model must not miss: an empty result and a cut result both say so.
 */
export function formatForModel(result: QueryResult): string {
  if (!result.ok) return `Cypher error: ${result.error}`;

  const lines: string[] = [];
  if (result.truncated) {
    lines.push(
      `${MAX_ROWS} of ${result.totalRows} rows shown. Narrow the query with WHERE or LIMIT, or aggregate.`,
    );
  } else if (result.rows.length === 0) {
    lines.push("0 rows. If you expected results, check that the names exist and the arrow direction.");
  } else {
    lines.push(`${result.rows.length} row${result.rows.length === 1 ? "" : "s"}`);
  }
  for (const warning of result.warnings) lines.push(`warning: ${warning}`);
  if (result.rows.length > 0) {
    lines.push(`columns: ${result.columns.join(" | ")}`);
    for (const row of result.rows) lines.push(row.map(cellText).join(" | "));
  }
  return lines.join("\n");
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}
