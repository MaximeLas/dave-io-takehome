// The gate's own tests: the three rules, the baseline taken from three trials and a second round,
// the comparison of every stored metric, and the exit code, on hand-made records, so every verdict
// is checked without a model call or a database.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  BASELINES_DIR,
  baselineFrom,
  COMPARED_METRICS,
  compare,
  EXIT,
  gate,
  loadBaseline,
  metricDeltas,
  MIN_PASS_TOLERANCE,
  SECOND_ROUND_RUNS,
  secondRoundEntrants,
  secondRoundScores,
  type Baseline,
  type SecondRoundScores,
} from "./baseline.js";
import { playSecondRound } from "./harness.js";
import type { RunRecord } from "../src/agent/record.js";
import { loadQuestions } from "./questions.js";
import { assemble, scoreRun, totals, type EvalRun, type EvalTotals, type QuestionResult } from "./record.js";
import { applyOverlay, loadAnswerKey, loadKeyOverlay, type KeyOverlay } from "./score.js";

const result = (id: string, status: QuestionResult["status"], costUsd = 0.01, empty = false): QuestionResult => ({
  id,
  status,
  runId: status === "error" ? null : `run-${id}`,
  score:
    status === "error"
      ? null
      : { pass: status === "pass", empty, expected: 1, asserted: empty ? 0 : 1, missing: [], extra: [], recall: empty ? 0 : 1, precision: 1 },
  diagnostics: status === "error" ? null : { toolCalls: 1, cypherErrors: 0, cutResults: 0, durationMs: 1000, costUsd, stopReason: "tool_use" },
  error: status === "error" ? "boom" : null,
});

const STATUS = { P: "pass", F: "fail", E: "error" } as const;

/** A run from one string per question, a letter per trial ("PPF": passed trials 1 and 2, failed 3); every question run costs `cost`. */
const run = (statuses: Record<string, string>, { full = true, cost = 0.01 } = {}): EvalRun => {
  const ids = Object.keys(statuses);
  const n = statuses[ids[0]!]!.length;
  const trials = Array.from({ length: n }, (_, t) => ids.map((id) => result(id, STATUS[statuses[id]![t] as keyof typeof STATUS], cost)));
  return { evalId: "e1", model: "m", effort: "high", promptVersion: "p", codeVersion: "c", startedAt: "", finishedAt: "", durationMs: 0, full, ...assemble(trials) };
};

/** A second round on a run's questions at every trial: each passes all its runs unless `passes` says how many it passed before failing. */
const secondRound = (r: EvalRun, passes: Record<string, number> = {}): SecondRoundScores => {
  const entrants = secondRoundEntrants(r);
  const got = Object.fromEntries(entrants.map((id) => [id, passes[id] ?? SECOND_ROUND_RUNS]));
  const runs = Object.values(got).reduce((acc, k) => acc + Math.min(k + 1, SECOND_ROUND_RUNS), 0);
  return { runsPerQuestion: SECOND_ROUND_RUNS, passes: got, runs, costUsd: runs * 0.01 };
};

// Ten questions: a to g at 3 of 3, h and i passed once, j never. Trial counts 8, 8, 7 (sum 23);
// their spread of 1 is the tolerance, so a run's sum over three trials may fall to 20. In the
// second round a to f pass all three runs and g fails its second, so the solid set is a to f.
const accepted = run({ a: "PPP", b: "PPP", c: "PPP", d: "PPP", e: "PPP", f: "PPP", g: "PPP", h: "PFF", i: "FPF", j: "FFF" });
const baseline: Baseline = baselineFrom(accepted, secondRound(accepted, { g: 1 }));
const sum = (r: EvalRun) => r.trialTotals.reduce((s, t) => s + t.passed, 0);

test("a baseline from three trials keeps each question's pass count and measures both allowances", () => {
  assert.equal(baseline.trials, 3);
  assert.deepEqual(baseline.passed, [8, 8, 7]);
  assert.deepEqual(baseline.questions, { a: 3, b: 3, c: 3, d: 3, e: 3, f: 3, g: 3, h: 1, i: 1, j: 0 });
  assert.equal(baseline.passTolerance, 1, "the spread of the three counts");
  // Identical costs (10c a trial) have no spread, so the cost margin is its floor, 5% of the mean.
  assert.ok(Math.abs(baseline.costMarginUsd - 0.005) < 1e-12);
  // Three equal counts are raised to the floor; a wide spread is kept as measured.
  const twoQuestions = run({ a: "PPP", b: "FFF" });
  assert.equal(baselineFrom(twoQuestions, secondRound(twoQuestions)).passTolerance, MIN_PASS_TOLERANCE);
  const wide = run({ a: "PPF", b: "PPF", c: "PFF", d: "PFF" });
  assert.equal(baselineFrom(wide, secondRound(wide)).passTolerance, 4);
});

test("the solid set is earned over both rounds: a question that fails in the second round is not solid, and is recorded", () => {
  assert.deepEqual(Object.keys(baseline.secondRound.passes), ["a", "b", "c", "d", "e", "f", "g"], "only the questions at 3 of 3 ran the second round");
  assert.equal(baseline.secondRound.passes.g, 1);
  assert.deepEqual(baseline.solid, ["a", "b", "c", "d", "e", "f"]);
  // Six passes for a to f, two for g's runs: 3 each, then g's pass and its failure.
  assert.equal(baseline.secondRound.runs, 20);
  // The second round's cost is recorded, and the cost rule reads the three trials alone.
  assert.ok(Math.abs(baseline.secondRound.costUsd - 0.2) < 1e-12);
  assert.ok(baseline.costUsd.every((c) => Math.abs(c - 0.1) < 1e-12), "ten questions at 1c a trial");
  // The mean and the tolerance are those of the three trials, whatever the second round did.
  const allSolid = baselineFrom(accepted, secondRound(accepted));
  assert.deepEqual([allSolid.passed, allSolid.passTolerance, allSolid.solid.length], [baseline.passed, baseline.passTolerance, 7]);
});

test("only a full, error-free run of three trials, with a second round on exactly its questions at 3 of 3, can become the baseline", () => {
  const one = run({ a: "PPP" }, { full: false });
  assert.throws(() => baselineFrom(one, secondRound(one)), /every question/);
  const errored = run({ a: "PPP", b: "PEP" });
  assert.throws(() => baselineFrom(errored, secondRound(errored)), /errors/);
  const single = run({ a: "P" });
  assert.throws(() => baselineFrom(single, secondRound(single)), /3 trials, not 1/);
  // A second round that skipped a question at 3 of 3, or ran one below it, is refused.
  const { g: _g, ...withoutG } = secondRound(accepted).passes;
  assert.throws(() => baselineFrom(accepted, { ...secondRound(accepted), passes: withoutG }), /exactly the questions that passed every trial/);
  assert.throws(() => baselineFrom(accepted, { ...secondRound(accepted), passes: { ...secondRound(accepted).passes, h: 3 } }), /exactly the questions/);
});

test("the second round runs only the questions at 3 of 3, each in sequence, stopped at its first failure or error", async () => {
  // a passes every run, b fails its second, c throws on its first; d (2 of 3) and e (0 of 3) never run.
  const r = run({ a: "PPP", b: "PPP", c: "PPP", d: "PPF", e: "FFF" });
  const script: Record<string, QuestionResult["status"][]> = { a: ["pass", "pass", "pass", "pass"], b: ["pass", "fail", "pass"], c: ["error", "pass"] };
  const calls: string[] = [];
  const round = await playSecondRound(r, async (id) => {
    calls.push(id);
    const status = script[id]!.shift()!;
    return result(id, status, 0.004);
  });
  assert.deepEqual([...calls].sort(), ["a", "a", "a", "b", "b", "c"]);
  assert.deepEqual(round.questions.map((q) => [q.id, q.passes, q.results.length]), [["a", 3, 3], ["b", 1, 2], ["c", 0, 1]]);
  assert.equal(round.runs, 6);
  assert.equal(round.errors, 1);
  assert.ok(Math.abs(round.costUsd - 0.02) < 1e-12, "the five runs that answered, at 0.4c each");
  // An error says nothing about the question, so the round cannot decide the solid set.
  assert.throws(() => secondRoundScores(round), /second round with errors/);
  const clean = { ...round, errors: 0 };
  assert.deepEqual(secondRoundScores(clean), { runsPerQuestion: 3, passes: { a: 3, b: 1, c: 0 }, runs: 6, costUsd: round.costUsd });
});

test("a run identical to the accepted one holds all three rules", () => {
  const g = gate(accepted, baseline, false);
  assert.equal(g.exit, EXIT.ok);
  assert.equal(g.line, "OK: all three rules held");
  assert.equal(g.comparison!.solid.solidCount, 6);
  assert.deepEqual(g.comparison!.flips, []);
});

test("rule 1: the mean may fall by the tolerance and no further", () => {
  // Every solid question keeps at least 2 of 3 in both runs, so only rule 1 can fail.
  const atFloor = run({ a: "PPP", b: "PPP", c: "PPP", d: "PPP", e: "PPP", f: "PPP", g: "PFP", h: "FFF", i: "FFF", j: "FFF" });
  assert.equal(sum(atFloor), 20);
  assert.equal(compare(atFloor, baseline).verdict, "ok");
  const below = run({ a: "PPP", b: "PPP", c: "PPP", d: "PPP", e: "PPP", f: "PPF", g: "FPP", h: "FFF", i: "FFF", j: "FFF" });
  assert.equal(sum(below), 19);
  const c = compare(below, baseline);
  assert.equal(c.verdict, "regression");
  assert.ok(!c.average.held);
  assert.ok(c.solid.held);
  assert.equal(c.average.limit, 23 / 3 - 1);
  const g = gate(below, baseline, false);
  assert.equal(g.exit, EXIT.regression);
  assert.match(g.line, /^REGRESSION: rule 1 \(average: mean 6\.3 below the floor of 6\.7\)$/);
});

test("rule 2: a solid question may fail one trial of three, not two; the others are reported, never gated", () => {
  // f falls to 1 of 3; h, i and j rise, so the mean holds and only rule 2 can fail.
  const broken = run({ a: "PPP", b: "PPP", c: "PPP", d: "PPP", e: "PPP", f: "FPF", g: "PFP", h: "PPP", i: "PPP", j: "PPP" });
  const c = compare(broken, baseline);
  assert.ok(c.average.held);
  assert.ok(!c.solid.held);
  assert.deepEqual(c.solid.broken, ["f"]);
  assert.equal(c.verdict, "regression");
  // Broken solid questions lead the flips, then the largest drops, then the rises.
  assert.deepEqual(c.flips.map((f) => f.id), ["f", "g", "h", "i", "j"]);
  assert.deepEqual(c.flips[0], { id: "f", baseline: 3, run: 1 });
  assert.match(gate(broken, baseline, false).line, /^REGRESSION: rule 2 \(solid set: f passed fewer than 2 of 3\)$/);
  // A question below 3 of 3 at accept may fail every trial: h, i and j at 0 of 3 hold the rule.
  const wobblyLost = run({ a: "PPP", b: "PPP", c: "PPP", d: "PPP", e: "PPP", f: "PPP", g: "PPP", h: "FFF", i: "FFF", j: "FFF" });
  assert.ok(compare(wobblyLost, baseline).solid.held);
  // So may g, at 3 of 3 in the trials but failed in the second round: reported beside its 3 of 3, never gated.
  const gLost = run({ a: "PPP", b: "PPP", c: "PPP", d: "PPP", e: "PPP", f: "PPP", g: "FFF", h: "PPP", i: "FPF", j: "FFF" });
  const lost = compare(gLost, baseline);
  assert.ok(lost.solid.held && lost.average.held);
  assert.deepEqual(lost.flips[0], { id: "g", baseline: 3, run: 0 });
  // Under the one-round rule the same run would have failed rule 2 on g.
  assert.deepEqual(compare(gLost, baselineFrom(accepted, secondRound(accepted))).solid.broken, ["g"]);
});

test("rule 3: the mean cost per trial may rise by the margin and no further", () => {
  const all = { a: "PPP", b: "PPP", c: "PPP", d: "PPP", e: "PPP", f: "PPP", g: "PPP", h: "PFF", i: "FPF", j: "FFF" };
  // The baseline's questions cost 1c each, so 10c per trial with a 0.5c margin: 1.04c a question holds, 1.06c does not.
  assert.equal(compare(run(all, { cost: 0.0104 }), baseline).verdict, "ok");
  const dear = compare(run(all, { cost: 0.0106 }), baseline);
  assert.equal(dear.verdict, "regression");
  assert.ok(!dear.cost.held);
  assert.ok(dear.average.held && dear.solid.held);
  assert.match(gate(run(all, { cost: 0.0106 }), baseline, false).line, /^REGRESSION: rule 3 \(cost: 10\.60c per trial above the ceiling of 10\.50c\)$/);
});

test("a question erroring in one trial of three makes the run incomplete, whatever the rules say", () => {
  const r = run({ a: "PPP", b: "PEP", c: "PPP", d: "PPP", e: "PPP", f: "PPP", g: "PPP", h: "PFF", i: "FPF", j: "FFF" });
  assert.equal(r.summary.errors, 1);
  const g = gate(r, baseline, false);
  assert.equal(g.exit, EXIT.unmeasured);
  assert.match(g.line, /^INCOMPLETE: 1 question run\(s\) threw/);
  // Even a subset run, and even while accepting.
  assert.equal(gate(run({ a: "E" }, { full: false }), baseline, false).exit, EXIT.unmeasured);
  assert.equal(gate(r, baseline, true).exit, EXIT.unmeasured);
});

test("the gate compares only a full run with a baseline of its own trial count", () => {
  // One trial against a three-trial baseline: a quick read, reported and not compared, like a subset.
  const one = run({ a: "P", b: "P", c: "P", d: "P", e: "P", f: "P", g: "P", h: "F", i: "F", j: "F" });
  assert.throws(() => compare(one, baseline), /1 trial\(s\) cannot be compared with a baseline of 3/);
  const mismatch = gate(one, baseline, false);
  assert.deepEqual([mismatch.exit, mismatch.comparison], [EXIT.ok, null]);
  assert.equal(mismatch.line, "REPORTED only: 1 trial; the gate compares a 3-trial run with the baseline (npm run eval with no flags)");
  // A quick read with an error is still incomplete: the error says something is broken.
  assert.equal(gate(run({ a: "E" }), baseline, false).exit, EXIT.unmeasured);
  // No baseline: incomplete, unless this run is being accepted as the first.
  assert.equal(gate(accepted, null, false).exit, EXIT.unmeasured);
  assert.match(gate(accepted, null, false).line, /^INCOMPLETE: no baseline for m at effort high/);
  assert.equal(gate(accepted, null, true).exit, EXIT.ok);
  // A subset run without errors is reported and exits ok, baseline or not.
  assert.equal(gate(run({ a: "FFF" }, { full: false }), baseline, false).exit, EXIT.ok);
});

test("while accepting, the run is compared with the baseline it replaces and never fails on it", () => {
  const worse = run({ a: "PPP", b: "PPP", c: "PPP", d: "PPP", e: "PPP", f: "PPF", g: "FPP", h: "FFF", i: "FFF", j: "FFF" });
  const g = gate(worse, baseline, true);
  assert.equal(g.exit, EXIT.ok);
  assert.match(g.line, /^ACCEPTING: against the baseline being replaced, REGRESSION: rule 1/);
});

test("a baseline in an earlier format (one run, or one accept round) is refused, and a missing one reads as none", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "eval-baseline-"));
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    assert.equal(await loadBaseline("m", "high"), null);
    await mkdir(BASELINES_DIR, { recursive: true });
    await writeFile(path.join(BASELINES_DIR, "m.high.json"), JSON.stringify({ model: "m", effort: "high", tolerance: 3, passed: 27, questions: {} }));
    await assert.rejects(loadBaseline("m", "high"), /single run.*npm run eval -- --accept/);
    // Three trials, but its solid set came from the trials alone.
    const { format: _f, secondRound: _s, solid: _o, ...oneRound } = baseline;
    await writeFile(path.join(BASELINES_DIR, "m.high.json"), JSON.stringify(oneRound));
    await assert.rejects(loadBaseline("m", "high"), /one accept round, a format the gate no longer reads; take a new baseline with npm run eval -- --accept\.$/);
    await writeFile(path.join(BASELINES_DIR, "m.high.json"), JSON.stringify(baseline));
    assert.deepEqual(await loadBaseline("m", "high"), baseline);
  } finally {
    process.chdir(cwd);
  }
});

test("the trials add up: each question's pass count, and the mean, min and max of the trials", () => {
  const r = run({ a: "PPF", b: "FFF", c: "PPP" }, { cost: 0.02 });
  assert.deepEqual(r.questions.map((q) => [q.id, q.passes]), [["a", 2], ["b", 0], ["c", 3]]);
  assert.deepEqual(r.questions[0]!.results.map((x) => x.status), ["pass", "pass", "fail"]);
  assert.deepEqual(r.summary, { trials: 3, meanPassed: 5 / 3, minPassed: 1, maxPassed: 2, errors: 0, meanCostUsd: 0.06, costUsd: 0.18 });
  assert.throws(() => assemble([[result("a", "pass")], [result("b", "pass")]]), /disagree/);
});

test("the gate's verdict is the same with and without the key overlay file", async () => {
  const key = await loadAnswerKey();
  const questions = await loadQuestions();
  const withFile = await loadKeyOverlay();
  const withoutFile = await loadKeyOverlay(new URL("./no-such-overlay.json", import.meta.url));
  assert.ok(Object.keys(withFile).length > 0, "the committed overlay amends at least one question");
  const amendedKey = applyOverlay(key, withFile);
  // Every question answered with the amended set in trials 1 and 2 and the key's set in trial 3,
  // so each amended question fails the key twice and the amended key once.
  const record = (ids: string[], q: string) =>
    ({ runId: `run-${q}`, questionId: q, answer: "x", ids, durationMs: 1000, costUsd: 0.003, stopReasons: ["tool_use"], toolCalls: [] }) as unknown as RunRecord;
  const runWith = (overlay: KeyOverlay): EvalRun => {
    const amended = applyOverlay(key, overlay);
    const trials = [0, 1, 2].map((t) =>
      questions.map((q) => scoreRun(record(t < 2 ? amendedKey[q.id]! : key[q.id]!, q.id), q, key[q.id]!, q.id in overlay ? amended[q.id] : undefined)),
    );
    return { evalId: "e", model: "m", effort: "high", promptVersion: "p", codeVersion: "c", startedAt: "", finishedAt: "", durationMs: 0, full: true, ...assemble(trials) };
  };
  const present = runWith(withFile);
  const absent = runWith(withoutFile);
  const reference = baselineFrom(absent, secondRound(absent));

  // The overlay moves the amended score, so the comparison below is not vacuous...
  const amendedId = Object.keys(withFile)[0]!;
  const passesOf = (r: EvalRun) => r.questions.find((q) => q.id === amendedId)!;
  assert.deepEqual([passesOf(present).passes, passesOf(present).amendedPasses], [1, 2]);
  assert.deepEqual([passesOf(absent).passes, passesOf(absent).amendedPasses], [1, 1]);
  // ...and nothing the gate reads: the verdict against a baseline, and a baseline taken from the run.
  assert.deepEqual(gate(present, reference, false), gate(absent, reference, false));
  assert.deepEqual(gate(present, reference, true), gate(absent, reference, true));
  const { acceptedAt: _a, trialTotals: _ta, ...fromPresent } = baselineFrom(present, secondRound(present));
  const { acceptedAt: _b, trialTotals: _tb, ...fromAbsent } = baselineFrom(absent, secondRound(absent));
  assert.deepEqual(fromPresent, fromAbsent);
});

test("the report compares every metric a trial's totals store with the baseline's, cost included", () => {
  // Every field of EvalTotals is compared, except the pass count the rules read and the counts that follow from it.
  const fields = Object.keys(totals([result("a", "pass")])) as (keyof EvalTotals)[];
  const notCompared = ["questions", "passed", "failed", "errors"];
  assert.deepEqual([...COMPARED_METRICS].sort(), fields.filter((f) => !notCompared.includes(f)).sort());

  const now = run({ a: "PPP", b: "PFP" }, { cost: 0.012 }).trialTotals;
  const lines = metricDeltas(now, accepted.trialTotals);
  assert.equal(lines.length, 1 + COMPARED_METRICS.length);
  assert.match(lines[0]!, /^every stored metric/);
  for (const label of ["mean recall", "mean precision", "passed, amended key", "empty answers", "tool calls", "Cypher errors", "cut results", "cost"]) {
    assert.ok(lines.some((l) => l.startsWith(`  ${label} `)), `a line for ${label}`);
  }
  // Two questions at 1.2c against ten at 1c: 2.4c a trial against 10c.
  assert.equal(lines.find((l) => l.startsWith("  cost "))!.trim(), "cost                  2.40c (baseline 10.00c, -7.60c); judged by rule 3");
  assert.equal(lines.find((l) => l.startsWith("  tool calls "))!.trim(), "tool calls            2 (baseline 10, -8)");
  // A baseline taken before a metric existed says so instead of printing a difference.
  const older = accepted.trialTotals.map(({ passedAmended: _p, ...rest }) => rest as EvalTotals);
  assert.match(lines.find((l) => l.startsWith("  passed, amended key"))!, /1\.7 \(baseline 7\.7, -6\); not gated$/);
  assert.match(metricDeltas(now, older).find((l) => l.startsWith("  passed, amended key"))!, /\(not in the baseline\); not gated$/);
});

test("totals: errors stay out of the sums, empty answers stay out of the means", () => {
  const t = totals([result("a", "pass"), result("b", "fail", 0.01, true), result("c", "error")]);
  assert.equal(t.errors, 1);
  assert.equal(t.empty, 1);
  assert.equal(t.toolCalls, 2);
  assert.equal(t.meanRecall, 1);
  assert.equal(t.meanPrecision, 1);
  assert.equal(totals([result("c", "error")]).meanRecall, null);
});
