// Scores one agent run against the answer key. Pure functions: an answer and the key in,
// numbers out, with no model call and no database, so the grader can be tested on its own
// (score.test.ts feeds it the key itself, which must pass, and an empty answer, which must fail).
//
// A question passes when the set of ids the answer asserts equals the expected set, after
// removing from both sides the ids the question itself names: the key includes them in one
// question of the ten that name a resource (path-compute-to-s3 keeps its starting instance,
// dlq-for-prod-2 leaves out queue-commerce-prod-2), so they count neither way. Recall and precision are reported beside
// the pass so progress on a large set shows as a number while the question still fails.
//
// The key is the reviewers' reference and is never edited. Where eval/key-audit.md finds it wrong,
// eval/key-overlay.json holds the amended set; applyOverlay gives the amended key, and the eval
// reports a second pass count against it. The gate reads the key alone.
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { RunRecord } from "../src/agent/record.js";

/** The expected resource ids per question id, as expected.generated.json lists them. */
export type AnswerKey = Record<string, string[]>;

// Both files are read relative to the working directory, the repo root, so the compiled server
// under dist/ reads the same files as the commands run with tsx.
const KEY_FILE = path.join("eval", "expected.generated.json");

/** Loads the answer key: question id to expected ids. */
export async function loadAnswerKey(): Promise<AnswerKey> {
  const parsed = JSON.parse(await readFile(KEY_FILE, "utf8")) as {
    evals: Record<string, { expected_resource_ids: string[] }>;
  };
  return Object.fromEntries(Object.entries(parsed.evals).map(([id, entry]) => [id, entry.expected_resource_ids]));
}

/** Amendments to the key, per question id: the amended expected ids, why, and the audit entry that argues it. */
export type KeyOverlay = Record<string, { expected_resource_ids: string[]; reason: string; audit: string }>;

const OVERLAY_FILE = path.join("eval", "key-overlay.json");

/** Loads the key's overlay; an absent file is an empty overlay, so the eval runs the same without one. */
export async function loadKeyOverlay(file: URL | string = OVERLAY_FILE): Promise<KeyOverlay> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as KeyOverlay;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

/** The key with each question the overlay names replaced by its amended ids; every other question is the key's own. */
export function applyOverlay(key: AnswerKey, overlay: KeyOverlay): AnswerKey {
  const unknown = Object.keys(overlay).filter((id) => !(id in key));
  if (unknown.length > 0) throw new Error(`The key overlay amends question(s) the key does not have: ${unknown.join(", ")}`);
  return { ...key, ...Object.fromEntries(Object.entries(overlay).map(([id, entry]) => [id, entry.expected_resource_ids])) };
}

/** What the grader says about one answer. */
export interface Score {
  /** The asserted ids equal the expected ids (question-named ids neutral) and the answer is not empty. */
  pass: boolean;
  /** No usable final_answer (the call never came, or its prose was blank). Never passes, even against an empty expected set. */
  empty: boolean;
  /** Expected ids after removing the question-named ones. */
  expected: number;
  /** Asserted ids after removing the question-named ones. */
  asserted: number;
  missing: string[];
  extra: string[];
  /** The share of expected ids that were asserted; 1 when nothing was expected. */
  recall: number;
  /** The share of asserted ids that were expected; 1 when nothing was asserted. */
  precision: number;
}

/** Scores an answer against the expected ids of its question. */
export function scoreAnswer(answer: Pick<RunRecord, "answer" | "ids">, expectedIds: string[], questionText: string): Score {
  const expectedSet = new Set(expectedIds);
  const assertedSet = new Set(answer.ids);
  const expected = [...expectedSet].filter((id) => !namedInQuestion(id, questionText));
  const asserted = [...assertedSet].filter((id) => !namedInQuestion(id, questionText));
  const missing = expected.filter((id) => !assertedSet.has(id));
  const extra = asserted.filter((id) => !expectedSet.has(id));
  const empty = answer.answer === "";
  return {
    pass: !empty && missing.length === 0 && extra.length === 0,
    empty,
    expected: expected.length,
    asserted: asserted.length,
    missing,
    extra,
    recall: expected.length === 0 ? 1 : (expected.length - missing.length) / expected.length,
    precision: asserted.length === 0 ? 1 : (asserted.length - extra.length) / asserted.length,
  };
}

// An id is named in the question when its resource name (the last segment of the id) appears
// in the text as a whole word, so `queue-commerce-prod-1` does not match `queue-commerce-prod-14`.
function namedInQuestion(id: string, questionText: string): boolean {
  const name = id.slice(id.lastIndexOf(":") + 1);
  const escaped = name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_/-])${escaped}(?![A-Za-z0-9_/-])`).test(questionText);
}

// The answer against the evidence, and against itself. Everything above compares the answer with
// the key; these two checks compare it with what the run read and with its own prose. Both are
// code, because the claims are ids and the evidence is text the record stores verbatim: groundedness
// (the RAG triad, RAGAS's faithfulness) usually needs a model to split an answer into claims and
// judge each against the context, and here neither step needs one. Reported, not gated.

/** Each resource's name, by its id, as the graph holds it; the prose check knows a resource by either. */
export type ResourceNames = ReadonlyMap<string, string>;

/** What the two answer-level checks say about one run. */
export interface AnswerChecks {
  /** Asserted ids that appear in no tool output of the run: built from a pattern or a name, never read. Independent of the pass. */
  ungrounded: string[];
  /** The share of asserted ids the prose names, by full id, by name, or in a family's short form; 1 when nothing was asserted. */
  proseNamed: number;
}

// The tools whose successful output is evidence: the two that read the graph.
const EVIDENCE_TOOLS = new Set(["run_cypher", "search_descriptions"]);
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
// Whole tokens: `queue-commerce-prod-1` must not match inside `queue-commerce-prod-13`, a bucket's name
// inside its policy's (`bucket-commerce-prod-1-policy`), or a repository's inside a workflow's
// (`repo-commerce-prod-1/deploy-prod.yml`). An id may follow a colon, since a query can print
// `label:id`; a name may not, so a bucket is not named by its policy's id (`aws:s3-policy:bucket-…`).
// A trailing `.` or `:` is allowed, for punctuation.
const idToken = (id: string) => new RegExp(`(?<![A-Za-z0-9_/.-])${escape(id)}(?![A-Za-z0-9_/-])`);
const nameToken = (name: string) => new RegExp(`(?<![A-Za-z0-9_:/.-])${escape(name)}(?![A-Za-z0-9_/-])`);

/**
 * Whether the prose names a resource: its full id, its name from the graph, or a short form of either.
 * The prose often names one member of a family in full and abbreviates the rest
 * ("queue-commerce-prod-5, -6 and -7", "i-ecomm-prod-02, 06, 10 and 14", "prod-13 to prod-16",
 * "datadog:monitor:commerce-3, -4"), so a resource whose id or name ends in a number also counts as
 * named when a sibling (the same id or name up to the number) is named in full somewhere in the prose,
 * and its number appears in a run of short forms that starts at the family: a member in full, by id or
 * by name, or the family's last word (`prod-13`), followed by numbers joined by commas, "and", or a
 * range ("to", "through", a dash), each bare, `-6`, `prod-6` or in full. A run is tied to its family,
 * so "prod queues 1 to 16" credits nothing, and "queue-commerce-prod-13 and rds-commerce-prod-14" does
 * not name queue 14. Errors remain both ways. Two families sharing a last word (`queue-commerce-prod-`,
 * `i-ecomm-prod-`) can credit each other through a run that starts at the word alone. A prose that
 * names no member in full ("dev queues 1 to 4"), or calls a resource by a partial id
 * ("s3-policy:bucket-commerce-prod-1") or a short form of its own ("repo-commerce-prod-1" for
 * `acme-commerce/repo-commerce-prod-1`), leaves a resource it names flagged.
 */
function namedInProse(id: string, name: string | undefined, prose: string): boolean {
  if (idToken(id).test(prose) || (name !== undefined && nameToken(name).test(prose))) return true;
  return namedAsSibling(id, name, prose);
}

// The short forms of `namedInProse`, for a resource whose id, or name, ends in a number.
function namedAsSibling(id: string, name: string | undefined, prose: string): boolean {
  const families = [id, name].flatMap((full) => {
    const family = full?.match(/^(.*[^0-9])(\d+)$/);
    return family ? [{ full: full!, stem: family[1]!, n: Number(family[2]) }] : [];
  });
  const n = families[0]?.n;
  if (n === undefined) return false;
  const own = families.filter((f) => f.n === n);
  // A member in full, with the boundaries of a full id or name: an id may follow a colon, a name may not.
  const inFull = own.map((f) => `${f.full.includes(":") ? "(?<![A-Za-z0-9_/.-])" : "(?<![A-Za-z0-9_:/.-])"}${escape(f.stem)}`).join("|");
  // The sibling named in full ("aws:sqs:queue-commerce-prod-5, prod-6 and prod-7").
  if (!new RegExp(`(?:${inFull})\\d+(?!\\d)`).test(prose)) return false;
  const words = [...new Set(own.map((f) => f.stem.replace(/-$/, "").split(/[-/:]/).at(-1) ?? ""))].filter((w) => w !== "");
  // Where a run starts: a member in full, or the family's word (`prod-13 to prod-16`). A later member
  // is written the same way, as `-6`, or as a bare number.
  const start = `(?:${[inFull, ...words.map((w) => `(?<![A-Za-z0-9_:/.-])${escape(w)}-`)].join("|")})`;
  const member = `(?:${start}|-)?`;
  // Members may carry a parenthesis between them ("i-ecomm-dev-01 and -05 (web entry), -02 and -06"),
  // and Markdown's code or bold marks around them ("`i-ecomm-dev-01`, `-03`").
  const join = "[`*]*(?:\\s*\\([^()]*\\))?\\s*(?:,\\s*and|,|and|to|through|–|—)\\s*[`*]*";
  for (const run of prose.matchAll(new RegExp(`${start}(\\d+)(?![A-Za-z0-9_-])((?:${join}${member}\\d+(?![\\d-]))*)`, "g"))) {
    let previous = Number(run[1]);
    if (previous === n) return true;
    for (const step of run[2]!.matchAll(new RegExp(`(${join})${member}(\\d+)`, "g"))) {
      const next = Number(step[2]);
      const range = /\b(?:to|through)\b|–|—/.test(step[1]!.replace(/\([^()]*\)/, ""));
      if (next === n || (range && previous <= n && n <= next)) return true;
      previous = next;
    }
  }
  return false;
}

/**
 * Checks one run's answer against the outputs of its tool calls and against its own prose. The
 * asserted ids are the grader's: the ids the question names count neither way.
 *
 * Grounded: an asserted id must appear, as a whole token, in the output of at least one successful call
 * of the two tools that read the graph (`run_cypher` prints every value a query returns, ids included
 * when it returns them; `search_descriptions` lists the ids carrying each description). Matching the id
 * string suffices because both tools print ids verbatim (`src/agent/tools.ts`). An id the run only built
 * from a name or a naming pattern is flagged even when it is right, which is the point: a right id that
 * was never read is a lucky guess. A row beyond the 100-row cap was never printed, so an id seen only
 * there is flagged. A query's own text is not evidence: `WHERE n.id IN [...]` returns rows for some ids
 * of the list. Nor is an error's output, which can quote the failing query, ids and all, nor the output
 * of any other tool, which can echo what the model wrote.
 *
 * Prose: the share of asserted ids the prose names (`namedInProse`). It sees that an id is named, not
 * that the prose asserts it: a prose that names what it ruled out names ids it did not assert.
 */
export function checkAnswer(record: Pick<RunRecord, "answer" | "ids" | "toolCalls">, names: ResourceNames, questionText: string): AnswerChecks {
  const asserted = [...new Set(record.ids)].filter((id) => !namedInQuestion(id, questionText));
  const outputs = record.toolCalls.filter((call) => !call.isError && EVIDENCE_TOOLS.has(call.name)).map((call) => call.output);
  const ungrounded = asserted.filter((id) => !outputs.some((output) => idToken(id).test(output)));
  const named = asserted.filter((id) => namedInProse(id, names.get(id), record.answer));
  return { ungrounded, proseNamed: asserted.length === 0 ? 1 : named.length / asserted.length };
}

/** What a run cost and how it went, read off the record. Reported, not gated. */
export interface Diagnostics {
  toolCalls: number;
  /** Calls to `search_descriptions`: whether the agent searches when a question names a purpose, and leaves the search alone when the graph's structure answers. */
  searchCalls: number;
  /** Queries the database refused (`Cypher error:`); the model repairing its own query. */
  cypherErrors: number;
  /** Results the tool cut at its row cap; the model asking for too much. */
  cutResults: number;
  durationMs: number;
  costUsd: number;
  /** Why the last model call ended: `end_turn` on an empty answer is the model stopping in prose, `max_tokens` a cut-off. */
  stopReason: string;
}

const CUT_RESULT = /^\d+ of \d+ rows shown/;

/** Reads the diagnostics of one run from its record. */
export function diagnostics(record: RunRecord): Diagnostics {
  return {
    toolCalls: record.toolCalls.length,
    searchCalls: record.toolCalls.filter((call) => call.name === "search_descriptions").length,
    cypherErrors: record.toolCalls.filter((call) => call.isError).length,
    cutResults: record.toolCalls.filter((call) => CUT_RESULT.test(call.output)).length,
    durationMs: record.durationMs,
    costUsd: record.costUsd,
    stopReason: record.stopReasons.at(-1) ?? "unknown",
  };
}
