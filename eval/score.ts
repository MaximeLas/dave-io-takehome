// Scores one agent run against the answer key. Pure functions: an answer and the key in,
// numbers out, with no model call and no database, so the grader can be tested on its own
// (score.test.ts feeds it the key itself, which must pass, and an empty answer, which must fail).
//
// A question passes when the set of ids the answer asserts equals the expected set, after
// removing from both sides the ids the question itself names: the key is inconsistent about
// those (dlq-for-prod-2 leaves out queue-commerce-prod-2, path-compute-to-s3 includes the
// starting instance), so they count neither way. Recall and precision are reported beside
// the pass so progress on a large set shows as a number while the question still fails.
import { readFile } from "node:fs/promises";

import type { RunRecord } from "../src/agent/record.js";

/** The expected resource ids per question id, as expected.generated.json lists them. */
export type AnswerKey = Record<string, string[]>;

const KEY_FILE = new URL("./expected.generated.json", import.meta.url);

/** Loads the answer key: question id to expected ids. */
export async function loadAnswerKey(): Promise<AnswerKey> {
  const parsed = JSON.parse(await readFile(KEY_FILE, "utf8")) as {
    evals: Record<string, { expected_resource_ids: string[] }>;
  };
  return Object.fromEntries(Object.entries(parsed.evals).map(([id, entry]) => [id, entry.expected_resource_ids]));
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

/** What a run cost and how it went, read off the record. Reported, not gated. */
export interface Diagnostics {
  toolCalls: number;
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
    cypherErrors: record.toolCalls.filter((call) => call.isError).length,
    cutResults: record.toolCalls.filter((call) => CUT_RESULT.test(call.output)).length,
    durationMs: record.durationMs,
    costUsd: record.costUsd,
    stopReason: record.stopReasons.at(-1) ?? "unknown",
  };
}
