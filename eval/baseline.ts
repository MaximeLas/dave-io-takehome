// The baseline: the agent declared "working" for one model and effort, measured over three
// trials, committed under eval/baselines/ and changed only on purpose, by `npm run eval --
// --accept` in its own commit. A run is compared with the baseline of its own model
// and effort, and only when it ran the same number of trials.
//
// The model samples, so the same agent scores differently from run to run; the gate therefore
// reads trials, not single runs, and holds three rules, each a one-sided check for a drop:
//   1. the average: the mean pass count may not fall by more than the pass tolerance;
//   2. the solid set: a question that passed every trial of both accept rounds may fail at most
//      one trial (two of three), while the other questions are reported, never gated;
//   3. cost: the mean cost per trial may not rise by more than the cost margin.
// Both allowances are measured at accept from the spread of the three trials; they live in the
// baseline file, so a threshold is versioned with the scores it protects.
//
// Rule 2 has no allowance, so what it costs in false reds depends on how a question enters the
// solid set. Three passes are cheap to draw by luck: a question that passes 75% of the time does it
// 42% of the time (0.75^3), then fails two of three in a later run and turns the gate red on code
// that did not change. So the accept runs a second round: each question that passed all three
// trials runs up to three more times alone, stopped at its first failure, and only a question that
// passes all six enters (0.75^6, 18%). A stable question costs three more runs, an unstable one
// stops early, and the round's cost is recorded, not gated. Six draws still let a question at 85%
// in about four times in ten (0.85^6), so the gate can still go red on unchanged code
// (`npm run simulate-gate`, eval/simulate.ts, estimates how often); a red run's first move is one
// re-run. The mean and the cost come from the three full trials only, which every later run
// repeats. A green run never becomes the baseline by itself: with any tolerance, a baseline that
// followed every green run could ratchet down one question at a time.
//
// Beside what the rules read, the baseline keeps each trial's totals: every reported metric, from
// recall and precision to the answer checks (ids asserted without appearing in any tool output, the
// prose naming its ids) and the search calls. A later run prints each beside the baseline's
// (`metricDeltas`), and none gates: a metric gates once it is steady across accepts and has an agreed
// budget. A new metric stored in the totals is a compile error in `metricDeltas` until it is compared.
// It does not move the format: a baseline taken before the metric existed prints "not in the baseline"
// for it, and stores it from the next accept made for one of its own reasons (AGENTS.md § Scoring).
// Retaking the baseline to store a metric would re-draw the solid set and both allowances from fresh
// samples of an agent that did not change, which is the neutral retake those reasons rule out.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { USAGE_EXIT } from "../src/cli.js";
import { cents, type Comparison, type EvalRun, type EvalTotals, type SecondRound } from "./record.js";

/** The baseline file's format; a file in an earlier format is refused before any token is spent. */
export const BASELINE_FORMAT = 2;

/** What the baseline keeps of the second accept round. */
export interface SecondRoundScores {
  /** The most runs a question gets in the round. */
  runsPerQuestion: number;
  /** Per question that passed every first-round trial: the runs it passed before its first failure, out of `runsPerQuestion`. */
  passes: Record<string, number>;
  /** Agent runs the round made. */
  runs: number;
  /** What the round cost; recorded, never gated (rule 3 reads the three full trials). */
  costUsd: number;
}

/** The committed scores for one model and effort, taken over `trials` runs of every question and a second round on the questions that passed them all. */
export interface Baseline {
  /** The file's format, `BASELINE_FORMAT`. */
  format: number;
  model: string;
  effort: string;
  promptVersion: string;
  codeVersion: string;
  /** The eval run the baseline was taken from. */
  evalId: string;
  acceptedAt: string;
  trials: number;
  /** Each trial's pass count, in trial order; rule 1 reads their mean. */
  passed: number[];
  /** How far the mean pass count may fall before the build fails (rule 1). */
  passTolerance: number;
  /** Each trial's cost, in trial order; rule 3 reads their mean. */
  costUsd: number[];
  /** How far the mean cost per trial may rise before the build fails (rule 3). */
  costMarginUsd: number;
  /** Per question, the trials it passed in the first round; those at `trials` ran the second round. */
  questions: Record<string, number>;
  /** The second accept round, on the questions at `trials` of `trials`. */
  secondRound: SecondRoundScores;
  /** The solid set (rule 2): the questions that passed every trial of both rounds, in question order. */
  solid: string[];
  /** Each trial's totals, for the metrics that are reported and not gated. */
  trialTotals: EvalTotals[];
}

/** The trials a baseline is taken on, and so the trials a gated run needs. */
export const BASELINE_TRIALS = 3;
/** The most runs a question gets in the second accept round; three more draws make six with the first round's. */
export const SECOND_ROUND_RUNS = 3;
// Both allowances follow one principle: the spread of the three accept trials (highest minus
// lowest). For draws with a standard deviation s, the expected spread of three is about 1.7 s, close
// to two standard errors of the gap between two means of three (1.6 s): the usual 95% band, measured
// on the agent being accepted, so a steadier prompt earns a tighter gate. Three draws can agree by
// chance, so each allowance has a floor: the smallest step that means anything for a count, and the
// band the measured cost noise gives for cost.
/** The pass tolerance's floor: one question, since a tolerance of 0 would fail on any single wobble. */
export const MIN_PASS_TOLERANCE = 1;
/**
 * The cost margin's floor, as a share of the baseline's mean cost. One trial's cost varies by about
 * 3% on the shipped prompt (ten runs on 12 Oct, three of them in CI, which cost the same as the local
 * ones); two standard errors of the gap between two means of three is about 4.4%, rounded up.
 */
export const MIN_COST_MARGIN_SHARE = 0.05;

export const BASELINES_DIR = path.join("eval", "baselines");

/** Where the baseline of a model and effort lives. */
export function baselinePath(model: string, effort: string): string {
  return path.join(BASELINES_DIR, `${model}.${effort}.json`);
}

/** The committed baseline for a model and effort, or null when none was accepted yet; throws on a file in an earlier format. */
export async function loadBaseline(model: string, effort: string): Promise<Baseline | null> {
  const file = baselinePath(model, effort);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const baseline = JSON.parse(raw) as Partial<Baseline>;
  if (typeof baseline.trials !== "number") {
    throw new Error(`${file} was taken from a single run, a format the gate no longer reads; take a new baseline with npm run eval -- --accept.`);
  }
  if (baseline.format !== BASELINE_FORMAT) {
    throw new Error(`${file} was taken with one accept round, a format the gate no longer reads; take a new baseline with npm run eval -- --accept.`);
  }
  return baseline as Baseline;
}

/** The questions that run the second accept round: those that passed every trial of the first, in question order. */
export function secondRoundEntrants(run: EvalRun): string[] {
  return run.questions.filter((q) => q.passes === run.summary.trials).map((q) => q.id);
}

/** What the baseline keeps of a second round; throws when a run in it threw, since an error says nothing about the question. */
export function secondRoundScores(round: SecondRound): SecondRoundScores {
  if (round.errors > 0) throw new Error("A second round with errors cannot become part of the baseline: re-run it.");
  return {
    runsPerQuestion: round.runsPerQuestion,
    passes: Object.fromEntries(round.questions.map((q) => [q.id, q.passes])),
    runs: round.runs,
    costUsd: round.costUsd,
  };
}

/** Compares a full eval run with a baseline taken on the same number of trials, under the three rules. */
export function compare(run: EvalRun, baseline: Baseline): Comparison {
  const n = baseline.trials;
  if (run.summary.trials !== n) throw new Error(`A run of ${run.summary.trials} trial(s) cannot be compared with a baseline of ${n}.`);

  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

  // Rule 1 on sums, which are whole numbers, so a mean in thirds is never misjudged by rounding.
  const runSum = run.trialTotals.reduce((acc, t) => acc + t.passed, 0);
  const baselineSum = baseline.passed.reduce((a, b) => a + b, 0);
  const average = {
    held: runSum >= baselineSum - baseline.passTolerance * n,
    value: run.summary.meanPassed,
    baseline: baselineSum / n,
    allowance: baseline.passTolerance,
    limit: baselineSum / n - baseline.passTolerance,
  };

  const passes = new Map(run.questions.map((q) => [q.id, q.passes]));
  const solidIds = baseline.solid;
  const broken = solidIds.filter((id) => (passes.get(id) ?? 0) < n - 1);
  const solid = { held: broken.length === 0, solidCount: solidIds.length, broken };

  const ceiling = mean(baseline.costUsd) + baseline.costMarginUsd;
  const cost = {
    held: run.summary.meanCostUsd <= ceiling,
    value: run.summary.meanCostUsd,
    baseline: mean(baseline.costUsd),
    allowance: baseline.costMarginUsd,
    limit: ceiling,
  };

  // Broken solid questions first, then the largest drops, then question order.
  const order = new Map(run.questions.map((q, i) => [q.id, i]));
  const brokenFirst = (f: { id: string }) => (broken.includes(f.id) ? 0 : 1);
  const change = (f: { baseline: number; run: number }) => f.run - f.baseline;
  const flips = run.questions
    .filter((q) => baseline.questions[q.id] !== undefined && baseline.questions[q.id] !== q.passes)
    .map((q) => ({ id: q.id, baseline: baseline.questions[q.id]!, run: q.passes }))
    .sort((a, b) => brokenFirst(a) - brokenFirst(b) || change(a) - change(b) || order.get(a.id)! - order.get(b.id)!);

  const verdict: Comparison["verdict"] =
    run.summary.errors > 0 ? "unmeasured" : average.held && solid.held && cost.held ? "ok" : "regression";
  return { baselineFile: baselinePath(baseline.model, baseline.effort), trials: n, verdict, average, solid, cost, flips };
}

/** The process exit codes, read by CI: the build ships only on 0. */
export const EXIT = { ok: 0, regression: 1, unmeasured: 2, usage: USAGE_EXIT } as const;

/** What the gate concludes about an eval run: the comparison when there is one, the exit code, and the line the report ends on. */
export interface GateVerdict {
  comparison: Comparison | null;
  exit: number;
  line: string;
}

/**
 * The gate's decision on a run, given the committed baseline of its model and effort (null when
 * none). Only a full, error-free run with the baseline's trial count is compared. A full run
 * with no baseline cannot vouch for the agent and exits `unmeasured`; a subset run, or a quick
 * read on another number of trials, is reported only, since the person running it asked for a
 * read rather than a verdict (CI runs the baseline's count). While accepting, the comparison is
 * with the baseline being replaced and never fails the run.
 */
export function gate(run: EvalRun, baseline: Baseline | null, accepting: boolean): GateVerdict {
  const unmeasured = (reason: string): GateVerdict => ({ comparison: null, exit: EXIT.unmeasured, line: `INCOMPLETE: ${reason}` });
  if (run.summary.errors > 0) return unmeasured(`${run.summary.errors} question run(s) threw (see the ERROR lines); the run cannot vouch for the agent`);
  if (!run.full) return { comparison: null, exit: EXIT.ok, line: "REPORTED only: a subset of the questions; the gate compares a full run with the baseline (npm run eval with no flags)" };
  const none = `no baseline for ${run.model} at effort ${run.effort}`;
  if (!baseline && accepting) return { comparison: null, exit: EXIT.ok, line: `ACCEPTING: ${none}; this run becomes the first` };
  if (!baseline) return unmeasured(`${none}; the build cannot pass without one (declare one with --accept)`);
  if (baseline.trials !== run.summary.trials) {
    const trials = `${run.summary.trials} trial${run.summary.trials === 1 ? "" : "s"}`;
    return { comparison: null, exit: EXIT.ok, line: `REPORTED only: ${trials}; the gate compares a ${baseline.trials}-trial run with the baseline (npm run eval with no flags)` };
  }

  const comparison = compare(run, baseline);
  const fmt = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(1));
  const failed = [
    comparison.average.held ? "" : `rule 1 (average: mean ${fmt(comparison.average.value)} below the floor of ${fmt(comparison.average.limit)})`,
    comparison.solid.held ? "" : `rule 2 (solid set: ${comparison.solid.broken.join(", ")} passed fewer than ${baseline.trials - 1} of ${baseline.trials})`,
    comparison.cost.held ? "" : `rule 3 (cost: ${cents(comparison.cost.value, 2)} per trial above the ceiling of ${cents(comparison.cost.limit, 2)})`,
  ].filter(Boolean);
  const verdict = failed.length === 0 ? "OK: all three rules held" : `REGRESSION: ${failed.join("; ")}`;
  if (accepting) return { comparison, exit: EXIT.ok, line: `ACCEPTING: against the baseline being replaced, ${verdict}` };
  return { comparison, exit: EXIT[comparison.verdict], line: verdict };
}

/**
 * Turns a full, error-free run of the baseline's trial count, and the second round run on its
 * questions at every trial, into the baseline: both allowances measured from the three trials'
 * spread, the solid set from the questions that passed every run of both rounds.
 */
export function baselineFrom(run: EvalRun, second: SecondRoundScores): Baseline {
  if (!run.full) throw new Error("Only a run over every question can become the baseline.");
  if (run.summary.errors > 0) throw new Error("A run with errors cannot become the baseline: re-run it first.");
  if (run.summary.trials !== BASELINE_TRIALS) throw new Error(`A baseline is taken on ${BASELINE_TRIALS} trials, not ${run.summary.trials}.`);
  const entrants = secondRoundEntrants(run);
  const ran = Object.keys(second.passes);
  if (ran.length !== entrants.length || entrants.some((id) => !(id in second.passes))) {
    throw new Error(`The second round must run exactly the questions that passed every trial (${entrants.join(", ")}), not ${ran.join(", ")}.`);
  }
  const costUsd = run.trialTotals.map((t) => t.costUsd);
  return {
    format: BASELINE_FORMAT,
    model: run.model,
    effort: run.effort,
    promptVersion: run.promptVersion,
    codeVersion: run.codeVersion,
    evalId: run.evalId,
    acceptedAt: new Date().toISOString(),
    trials: run.summary.trials,
    passed: run.trialTotals.map((t) => t.passed),
    passTolerance: Math.max(run.summary.maxPassed - run.summary.minPassed, MIN_PASS_TOLERANCE),
    costUsd,
    costMarginUsd: Math.max(Math.max(...costUsd) - Math.min(...costUsd), MIN_COST_MARGIN_SHARE * run.summary.meanCostUsd),
    questions: Object.fromEntries(run.questions.map((q) => [q.id, q.passes])),
    secondRound: second,
    solid: entrants.filter((id) => second.passes[id] === second.runsPerQuestion),
    trialTotals: run.trialTotals,
  };
}

// Every metric a trial's totals carry, beside the baseline's, except those the gate already reads
// (passed, by rules 1 and 2) or that follow from others (failed, questions) or stop the run (errors).
// The type makes a new field of EvalTotals a compile error here until it is compared.
type ComparedMetric = Exclude<keyof EvalTotals, "questions" | "passed" | "failed" | "errors">;
const pct = (share: number) => `${Math.round(share * 100)}%`;
const num = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(1));
const signed = (d: number, show: (x: number) => string) => `${d >= 0 ? "+" : "-"}${show(Math.abs(d))}`;
const METRICS: Record<ComparedMetric, { label: string; show: (x: number) => string; diff: (d: number) => string; note?: string }> = {
  meanRecall: { label: "mean recall", show: pct, diff: (d) => `${signed(Math.round(d * 100), String)} pts` },
  meanPrecision: { label: "mean precision", show: pct, diff: (d) => `${signed(Math.round(d * 100), String)} pts` },
  passedAmended: { label: "passed, amended key", show: num, diff: (d) => signed(d, num), note: "not gated" },
  empty: { label: "empty answers", show: num, diff: (d) => signed(d, num) },
  ungroundedRuns: { label: "ungrounded runs", show: num, diff: (d) => signed(d, num) },
  ungroundedIds: { label: "ungrounded ids", show: num, diff: (d) => signed(d, num) },
  meanProseNamed: { label: "prose names its ids", show: pct, diff: (d) => `${signed(Math.round(d * 100), String)} pts` },
  toolCalls: { label: "tool calls", show: num, diff: (d) => signed(d, num) },
  searchCalls: { label: "search calls", show: num, diff: (d) => signed(d, num) },
  cypherErrors: { label: "Cypher errors", show: num, diff: (d) => signed(d, num) },
  cutResults: { label: "cut results", show: num, diff: (d) => signed(d, num) },
  costUsd: { label: "cost", show: (x) => cents(x, 2), diff: (d) => signed(d, (x) => cents(x, 2)), note: "judged by rule 3" },
};

/** The metrics that are compared with the baseline, in the order the report prints them. */
export const COMPARED_METRICS = Object.keys(METRICS) as ComparedMetric[];

/** Every stored metric of a run's trials against the baseline's, as a mean per trial; a metric the baseline predates reads as such. */
export function metricDeltas(now: EvalTotals[], before: EvalTotals[]): string[] {
  const avg = (ts: EvalTotals[], key: ComparedMetric) => {
    const xs = ts.map((t) => t[key]).filter((x): x is number => typeof x === "number");
    return xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
  };
  return [
    "every stored metric, mean per trial, against the baseline (the three rules above are the verdict)",
    ...COMPARED_METRICS.map((key) => {
      const m = METRICS[key];
      const a = avg(now, key);
      const b = avg(before, key);
      const value = a === null ? "n/a" : m.show(a);
      const against = b === null ? "not in the baseline" : `baseline ${m.show(b)}${a === null ? "" : `, ${m.diff(a - b)}`}`;
      return `  ${m.label.padEnd(22)}${value} (${against})${m.note ? `; ${m.note}` : ""}`;
    }),
  ];
}

/** Writes the baseline file and returns its path. */
export async function saveBaseline(baseline: Baseline): Promise<string> {
  await mkdir(BASELINES_DIR, { recursive: true });
  const file = baselinePath(baseline.model, baseline.effort);
  await writeFile(file, JSON.stringify(baseline, null, 2) + "\n");
  return file;
}
