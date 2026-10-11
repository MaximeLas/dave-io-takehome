// The baseline: the scores declared "working" for one model and effort, committed under
// eval/baselines/ and changed only on purpose, by `npm run eval -- --accept` in its own
// commit. An eval run is compared with the baseline of its own model and effort, never
// with another's, since a model change is a change to the agent and gets its own baseline.
//
// The gate is one-sided and has a tolerance: the run may lose up to `tolerance` passes
// before the build fails, because the pass count moves from run to run with nothing
// changed (the model samples). The tolerance is agreed from the measured spread and lives
// in the baseline file, so the threshold is versioned with the scores it protects. The
// baseline also keeps the run's totals, so the report can show how cost, recall and tool
// calls moved; those are reported, not gated, until one of them earns a budget.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Comparison, EvalRun, EvalTotals } from "./record.js";

/** The committed scores for one model and effort. */
export interface Baseline {
  model: string;
  effort: string;
  promptVersion: string;
  codeVersion: string;
  /** The eval run the baseline was taken from. */
  evalId: string;
  acceptedAt: string;
  /** How many passes a run may lose before it fails the build. */
  tolerance: number;
  passed: number;
  questions: Record<string, "pass" | "fail">;
  totals: EvalTotals;
}

export const BASELINES_DIR = path.join("eval", "baselines");

/** Where the baseline of a model and effort lives. */
export function baselinePath(model: string, effort: string): string {
  return path.join(BASELINES_DIR, `${model}.${effort}.json`);
}

/** The committed baseline for a model and effort, or null when none was accepted yet. */
export async function loadBaseline(model: string, effort: string): Promise<Baseline | null> {
  try {
    return JSON.parse(await readFile(baselinePath(model, effort), "utf8")) as Baseline;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Compares a full eval run with its baseline. */
export function compare(run: EvalRun, baseline: Baseline): Comparison {
  const minPasses = baseline.passed - baseline.tolerance;
  const status = new Map(run.questions.map((q) => [q.id, q.status]));
  const verdict: Comparison["verdict"] =
    run.totals.errors > 0 ? "unmeasured" : run.totals.passed < minPasses ? "regression" : "ok";
  return {
    baselineFile: baselinePath(baseline.model, baseline.effort),
    baselinePassed: baseline.passed,
    tolerance: baseline.tolerance,
    minPasses,
    passed: run.totals.passed,
    verdict,
    newlyFailing: Object.keys(baseline.questions).filter((id) => baseline.questions[id] === "pass" && status.get(id) === "fail"),
    newlyPassing: Object.keys(baseline.questions).filter((id) => baseline.questions[id] === "fail" && status.get(id) === "pass"),
  };
}

/** The process exit codes, read by CI: the build ships only on 0. */
export const EXIT = { ok: 0, regression: 1, unmeasured: 2, usage: 3 } as const;

/**
 * The exit code of an eval run. A full run with errors, or with no baseline for its model
 * and effort, cannot vouch for the agent and exits `unmeasured`, unless this run is being
 * accepted as the baseline. A subset run is reported only and exits `ok` when nothing threw.
 */
export function exitCode(run: EvalRun, comparison: Comparison | null, accepting: boolean): number {
  if (run.totals.errors > 0) return EXIT.unmeasured;
  if (accepting) return EXIT.ok;
  if (!run.full) return EXIT.ok;
  if (!comparison) return EXIT.unmeasured;
  return EXIT[comparison.verdict];
}

/** Turns a full, error-free eval run into the baseline for its model and effort. */
export function baselineFrom(run: EvalRun, tolerance: number): Baseline {
  if (!run.full) throw new Error("Only a run over every question can become the baseline.");
  if (run.totals.errors > 0) throw new Error("A run with errors cannot become the baseline: re-run it first.");
  if (!Number.isInteger(tolerance) || tolerance < 0 || tolerance > run.totals.passed) {
    throw new Error(`The tolerance must be a whole number between 0 and the passes of the run (${run.totals.passed}).`);
  }
  return {
    model: run.model,
    effort: run.effort,
    promptVersion: run.promptVersion,
    codeVersion: run.codeVersion,
    evalId: run.evalId,
    acceptedAt: new Date().toISOString(),
    tolerance,
    passed: run.totals.passed,
    questions: Object.fromEntries(run.questions.map((q) => [q.id, q.status === "pass" ? "pass" : "fail"])),
    totals: run.totals,
  };
}

/** Writes the baseline file and returns its path. */
export async function saveBaseline(baseline: Baseline): Promise<string> {
  await mkdir(BASELINES_DIR, { recursive: true });
  const file = baselinePath(baseline.model, baseline.effort);
  await writeFile(file, JSON.stringify(baseline, null, 2) + "\n");
  return file;
}
