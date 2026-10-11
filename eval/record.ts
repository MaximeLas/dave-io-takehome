// The record of one eval run: every question's result, the totals, and the comparison with
// the baseline. One JSON file per eval run under `runs/eval/` (gitignored, like the agent
// records it points to by run id), so a score can always be traced back to the trace behind it.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Diagnostics, Score } from "./score.js";

/** One question's row. `error` means the run never produced an answer to score (it threw or timed out). */
export interface QuestionResult {
  id: string;
  status: "pass" | "fail" | "error";
  /** The agent record under runs/, null when the run threw. */
  runId: string | null;
  score: Score | null;
  diagnostics: Diagnostics | null;
  error: string | null;
}

/** Counts over all questions; sums over those that produced an answer; means over the non-empty answers. */
export interface EvalTotals {
  questions: number;
  passed: number;
  failed: number;
  errors: number;
  /** Answers with no usable final_answer call; a prompt-compliance count, kept out of the means. */
  empty: number;
  toolCalls: number;
  cypherErrors: number;
  cutResults: number;
  costUsd: number;
  /** Null when no answer was non-empty: a mean of nothing is not a measurement. */
  meanRecall: number | null;
  meanPrecision: number | null;
}

/** The verdict of one eval run against its baseline. */
export interface Comparison {
  baselineFile: string;
  baselinePassed: number;
  tolerance: number;
  /** The fewest passes that still pass the build: the baseline's passes minus the tolerance. */
  minPasses: number;
  passed: number;
  /** `unmeasured` when a question errored: the run is incomplete, and the build must not ship on it. */
  verdict: "ok" | "regression" | "unmeasured";
  newlyFailing: string[];
  newlyPassing: string[];
}

/** Everything about one eval run. */
export interface EvalRecord {
  evalId: string;
  model: string;
  effort: string;
  promptVersion: string;
  codeVersion: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /** True when the run covered every question; only a full run is compared or accepted. */
  full: boolean;
  questions: QuestionResult[];
  totals: EvalTotals;
  comparison: Comparison | null;
}

/** An eval run before its comparison with the baseline. */
export type EvalRun = Omit<EvalRecord, "comparison">;

export const EVAL_RUNS_DIR = path.join("runs", "eval");

/** Sums the question results. */
export function totals(questions: QuestionResult[]): EvalTotals {
  const answered = questions.filter((q) => q.score && q.diagnostics);
  const nonEmpty = answered.filter((q) => !q.score!.empty);
  const mean = (values: number[]) => (values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length);
  const sum = (pick: (q: QuestionResult) => number) => answered.reduce((acc, q) => acc + pick(q), 0);
  return {
    questions: questions.length,
    passed: questions.filter((q) => q.status === "pass").length,
    failed: questions.filter((q) => q.status === "fail").length,
    errors: questions.filter((q) => q.status === "error").length,
    empty: answered.length - nonEmpty.length,
    toolCalls: sum((q) => q.diagnostics!.toolCalls),
    cypherErrors: sum((q) => q.diagnostics!.cypherErrors),
    cutResults: sum((q) => q.diagnostics!.cutResults),
    costUsd: sum((q) => q.diagnostics!.costUsd),
    meanRecall: mean(nonEmpty.map((q) => q.score!.recall)),
    meanPrecision: mean(nonEmpty.map((q) => q.score!.precision)),
  };
}

/** Writes the eval record under runs/eval/ and returns its path. */
export async function saveEvalRun(record: EvalRecord): Promise<string> {
  await mkdir(EVAL_RUNS_DIR, { recursive: true });
  const file = path.join(EVAL_RUNS_DIR, `${record.evalId}.json`);
  await writeFile(file, JSON.stringify(record, null, 2));
  return file;
}
