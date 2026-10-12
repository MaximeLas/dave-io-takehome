// The record of one eval run: every question run n times (the trials), the totals of each
// trial, what the trials add up to, and the comparison with the baseline. One JSON file per
// eval run under `runs/eval/` (gitignored, like the agent records it points to by run id), so
// a score can always be traced back to the traces behind it. The n trials of one invocation
// share one record, so a CI run has one report, one summary page and one artifact.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Diagnostics, Score } from "./score.js";

/** One question in one trial. `error` means the run never produced an answer to score (it threw or timed out). */
export interface QuestionResult {
  id: string;
  status: "pass" | "fail" | "error";
  /** The agent record under runs/, null when the run threw. */
  runId: string | null;
  score: Score | null;
  diagnostics: Diagnostics | null;
  error: string | null;
}

/** One question across the trials: how many passed, and each trial's result in trial order. */
export interface QuestionTrials {
  id: string;
  /** The trials that passed, out of `results.length`. */
  passes: number;
  results: QuestionResult[];
}

/** Counts over all questions of one trial; sums over those that produced an answer; means over the non-empty answers. */
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

/** What the trials add up to: the pass count and the cost the gate reads, with their spread. */
export interface EvalSummary {
  trials: number;
  meanPassed: number;
  minPassed: number;
  maxPassed: number;
  /** Errored question runs across all trials; any makes the run incomplete. */
  errors: number;
  meanCostUsd: number;
  /** All trials together: what the run cost. */
  costUsd: number;
}

/** A gate rule that holds one number of the run against a limit drawn from the baseline (rules 1 and 3). */
export interface ThresholdRule {
  held: boolean;
  /** The run's value: mean passes per trial, or mean cost per trial. */
  value: number;
  /** The baseline's value the limit is drawn from. */
  baseline: number;
  /** The measured allowance taken from the baseline: the pass tolerance or the cost margin. */
  allowance: number;
  /** The limit the run must stay on the right side of: the pass floor or the cost ceiling. */
  limit: number;
}

/** The verdict of a full eval run against a baseline taken with the same number of trials. */
export interface Comparison {
  baselineFile: string;
  trials: number;
  /** `unmeasured` when a question errored in any trial: the run is incomplete, and the build must not ship on it. */
  verdict: "ok" | "regression" | "unmeasured";
  /** Rule 1: the mean pass count may not drop by more than the pass tolerance. */
  average: ThresholdRule;
  /** Rule 2: a question that passed every baseline trial may fail at most one trial. */
  solid: { held: boolean; solidCount: number; broken: string[] };
  /** Rule 3: the mean cost per trial may not exceed the baseline's by more than the cost margin. */
  cost: ThresholdRule;
  /** Questions whose pass count moved against the baseline's, broken solid questions first. */
  flips: { id: string; baseline: number; run: number }[];
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
  questions: QuestionTrials[];
  /** The totals of each trial, in trial order. */
  trialTotals: EvalTotals[];
  summary: EvalSummary;
  comparison: Comparison | null;
}

/** An eval run before its comparison with the baseline. */
export type EvalRun = Omit<EvalRecord, "comparison">;

export const EVAL_RUNS_DIR = path.join("runs", "eval");

/** Sums the question results of one trial. */
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

/** Groups per-trial results by question and adds up the trials; `trials[t]` holds trial t's results in question order. */
export function assemble(trials: QuestionResult[][]): Pick<EvalRun, "questions" | "trialTotals" | "summary"> {
  if (trials.length === 0) throw new Error("An eval run needs at least one trial.");
  const questions = trials[0]!.map((first, i) => {
    const results = trials.map((trial) => trial[i]!);
    if (results.some((r) => r.id !== first.id)) throw new Error(`Trials disagree on question ${i}: ${results.map((r) => r.id).join(", ")}`);
    return { id: first.id, passes: results.filter((r) => r.status === "pass").length, results };
  });
  const trialTotals = trials.map(totals);
  const passed = trialTotals.map((t) => t.passed);
  const costUsd = trialTotals.reduce((acc, t) => acc + t.costUsd, 0);
  return {
    questions,
    trialTotals,
    summary: {
      trials: trials.length,
      meanPassed: passed.reduce((a, b) => a + b, 0) / trials.length,
      minPassed: Math.min(...passed),
      maxPassed: Math.max(...passed),
      errors: trialTotals.reduce((acc, t) => acc + t.errors, 0),
      meanCostUsd: costUsd / trials.length,
      costUsd,
    },
  };
}

/** Writes the eval record under runs/eval/ and returns its path. */
export async function saveEvalRun(record: EvalRecord): Promise<string> {
  await mkdir(EVAL_RUNS_DIR, { recursive: true });
  const file = path.join(EVAL_RUNS_DIR, `${record.evalId}.json`);
  await writeFile(file, JSON.stringify(record, null, 2));
  return file;
}
