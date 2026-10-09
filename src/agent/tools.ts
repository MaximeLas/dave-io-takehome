// The agent's tools. Each one is a function the model can call, with a zod schema for its
// input and a description written for a newcomer: what it does, what comes back, and how
// to read it. The description is part of the tool's design, since it is all the model
// knows about the tool.
import { tool } from "langchain";
import { z } from "zod";

import { MAX_ROWS, runReadQuery, type QueryResult } from "../graph/query.js";

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
