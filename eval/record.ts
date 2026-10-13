// The record of one eval run: every question run n times (the trials), the totals of each
// trial, what the trials add up to, and the comparison with the baseline. One JSON file per
// eval run under `runs/eval/` (gitignored, like the agent records it points to by run id), so
// a score can always be traced back to the traces behind it. The n trials of one invocation
// share one record, so a CI run has one report, one summary page and one artifact.
//
// Every status and pass count here is against the key, and the gate reads only those. The pass
// against the key as amended by eval/key-overlay.json rides beside them in fields of its own,
// so the second score is reported without any path into the gate.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { RunRecord } from "../src/agent/record.js";
import type { Question } from "./questions.js";
import { checkAnswer, diagnostics, scoreAnswer, type AnswerChecks, type Diagnostics, type ResourceNames, type Score } from "./score.js";

/** A cost in US dollars printed in cents, the one unit every command prints; two digits where a gate compares two costs. */
export const cents = (usd: number, digits = 1): string => `${(usd * 100).toFixed(digits)}c`;

/** One question in one trial. `error` means the run never produced an answer to score (it threw or timed out). */
export interface QuestionResult {
  id: string;
  /** Against the key; the gate reads this. */
  status: "pass" | "fail" | "error";
  /** The agent record under runs/, null when the run threw. */
  runId: string | null;
  score: Score | null;
  /** The answer against the run's tool outputs and against its own prose; null when the run threw. */
  checks: AnswerChecks | null;
  diagnostics: Diagnostics | null;
  error: string | null;
  /** The pass against the amended key; absent when the overlay leaves the question alone or the run threw. */
  amendedPass?: boolean;
}

/** One question across the trials: how many passed, and each trial's result in trial order. */
export interface QuestionTrials {
  id: string;
  /** The trials that passed against the key, out of `results.length`. */
  passes: number;
  /** The trials that passed against the amended key; equal to `passes` when the overlay leaves the question alone. */
  amendedPasses: number;
  results: QuestionResult[];
}

/** Scores one agent run: its status against the key, the two answer checks, and its pass against the amended ids when the overlay amends the question. */
export function scoreRun(record: RunRecord, question: Question, expectedIds: string[], names: ResourceNames, amendedIds?: string[]): QuestionResult {
  const score = scoreAnswer(record, expectedIds, question.text);
  return {
    id: question.id,
    status: score.pass ? "pass" : "fail",
    runId: record.runId,
    score,
    checks: checkAnswer(record, names, question.text),
    diagnostics: diagnostics(record),
    error: null,
    ...(amendedIds ? { amendedPass: scoreAnswer(record, amendedIds, question.text).pass } : {}),
  };
}

/** Whether a result passes against the amended key: its own amended pass, or its status when the overlay leaves it alone. */
const passesAmended = (r: QuestionResult) => r.amendedPass ?? r.status === "pass";

/** Counts over all questions of one trial; sums over those that produced an answer; means over the non-empty answers. */
export interface EvalTotals {
  questions: number;
  passed: number;
  /** Passed against the amended key: reported beside `passed`, never gated. */
  passedAmended: number;
  failed: number;
  errors: number;
  /** Answers with no usable final_answer call; a prompt-compliance count, kept out of the means. */
  empty: number;
  toolCalls: number;
  /** Calls to `search_descriptions`, part of `toolCalls`. */
  searchCalls: number;
  cypherErrors: number;
  cutResults: number;
  costUsd: number;
  /** Null when no answer was non-empty: a mean of nothing is not a measurement. */
  meanRecall: number | null;
  meanPrecision: number | null;
  /** Runs that asserted at least one id found in none of their tool outputs, whether they passed or not. */
  ungroundedRuns: number;
  /** Asserted ids found in no tool output of their run, over all runs. */
  ungroundedIds: number;
  /** The share of asserted ids the prose names, as a mean over the non-empty answers. */
  meanProseNamed: number | null;
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
  /** Rule 2: a question that passed every trial of both accept rounds may fail at most one trial. */
  solid: { held: boolean; solidCount: number; broken: string[] };
  /** Rule 3: the mean cost per trial may not exceed the baseline's by more than the cost margin. */
  cost: ThresholdRule;
  /** Questions whose pass count moved against the baseline's, broken solid questions first. */
  flips: { id: string; baseline: number; run: number }[];
}

/** The second accept round: each question that passed every trial, run again alone up to `runsPerQuestion` times, stopped at its first failure. */
export interface SecondRound {
  runsPerQuestion: number;
  /** Per question, its runs in order and the passes before the first failure; a last result that did not pass is that failure. */
  questions: { id: string; passes: number; results: QuestionResult[] }[];
  /** Agent runs made, at most `runsPerQuestion` per question. */
  runs: number;
  costUsd: number;
  /** Runs that threw; any keeps the round out of a baseline. */
  errors: number;
}

/** Everything about one eval run. */
export interface EvalRecord {
  evalId: string;
  model: string;
  effort: string;
  promptVersion: string;
  /** The fingerprint of everything the model read (src/agent/version.ts); absent from records older than the field. */
  agentVersion?: string;
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
  /** Only on an accepting run: the second round that decides the solid set. */
  secondRound?: SecondRound;
}

/** An eval run before its comparison with the baseline and any second round. */
export type EvalRun = Omit<EvalRecord, "comparison" | "secondRound">;

export const EVAL_RUNS_DIR = path.join("runs", "eval");

/** Sums the question results of one trial. */
export function totals(questions: QuestionResult[]): EvalTotals {
  const answered = questions.filter((q) => q.score && q.checks && q.diagnostics);
  const nonEmpty = answered.filter((q) => !q.score!.empty);
  const mean = (values: number[]) => (values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length);
  const sum = (pick: (q: QuestionResult) => number) => answered.reduce((acc, q) => acc + pick(q), 0);
  return {
    questions: questions.length,
    passed: questions.filter((q) => q.status === "pass").length,
    passedAmended: questions.filter(passesAmended).length,
    failed: questions.filter((q) => q.status === "fail").length,
    errors: questions.filter((q) => q.status === "error").length,
    empty: answered.length - nonEmpty.length,
    toolCalls: sum((q) => q.diagnostics!.toolCalls),
    searchCalls: sum((q) => q.diagnostics!.searchCalls),
    cypherErrors: sum((q) => q.diagnostics!.cypherErrors),
    cutResults: sum((q) => q.diagnostics!.cutResults),
    costUsd: sum((q) => q.diagnostics!.costUsd),
    meanRecall: mean(nonEmpty.map((q) => q.score!.recall)),
    meanPrecision: mean(nonEmpty.map((q) => q.score!.precision)),
    ungroundedRuns: answered.filter((q) => q.checks!.ungrounded.length > 0).length,
    ungroundedIds: sum((q) => q.checks!.ungrounded.length),
    meanProseNamed: mean(nonEmpty.map((q) => q.checks!.proseNamed)),
  };
}

/** Groups per-trial results by question and adds up the trials; `trials[t]` holds trial t's results in question order. */
export function assemble(trials: QuestionResult[][]): Pick<EvalRun, "questions" | "trialTotals" | "summary"> {
  if (trials.length === 0) throw new Error("An eval run needs at least one trial.");
  const questions = trials[0]!.map((first, i) => {
    const results = trials.map((trial) => trial[i]!);
    if (results.some((r) => r.id !== first.id)) throw new Error(`Trials disagree on question ${i}: ${results.map((r) => r.id).join(", ")}`);
    return { id: first.id, passes: results.filter((r) => r.status === "pass").length, amendedPasses: results.filter(passesAmended).length, results };
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
