// The gate's own tests: the three rules, the baseline taken from three trials, and the exit
// code, on hand-made records, so every verdict is checked without a model call or a database.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { BASELINES_DIR, baselineFrom, compare, EXIT, gate, loadBaseline, MIN_PASS_TOLERANCE, type Baseline } from "./baseline.js";
import { assemble, totals, type EvalRun, type QuestionResult } from "./record.js";

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

// Ten questions: a to g solid (3 of 3), h and i passed once, j never. Trial counts 8, 8, 7 (sum 23);
// their spread of 1 is the tolerance, so a run's sum over three trials may fall to 20.
const accepted = run({ a: "PPP", b: "PPP", c: "PPP", d: "PPP", e: "PPP", f: "PPP", g: "PPP", h: "PFF", i: "FPF", j: "FFF" });
const baseline: Baseline = baselineFrom(accepted);
const sum = (r: EvalRun) => r.trialTotals.reduce((s, t) => s + t.passed, 0);

test("a baseline from three trials keeps each question's pass count and measures both allowances", () => {
  assert.equal(baseline.trials, 3);
  assert.deepEqual(baseline.passed, [8, 8, 7]);
  assert.deepEqual(baseline.questions, { a: 3, b: 3, c: 3, d: 3, e: 3, f: 3, g: 3, h: 1, i: 1, j: 0 });
  assert.equal(baseline.passTolerance, 1, "the spread of the three counts");
  // Identical costs (10c a trial) have no spread, so the cost margin is its floor, 5% of the mean.
  assert.ok(Math.abs(baseline.costMarginUsd - 0.005) < 1e-12);
  // Three equal counts are raised to the floor; a wide spread is kept as measured.
  assert.equal(baselineFrom(run({ a: "PPP", b: "FFF" })).passTolerance, MIN_PASS_TOLERANCE);
  assert.equal(baselineFrom(run({ a: "PPF", b: "PPF", c: "PFF", d: "PFF" })).passTolerance, 4);
});

test("only a full, error-free run of three trials can become the baseline", () => {
  assert.throws(() => baselineFrom(run({ a: "PPP" }, { full: false })), /every question/);
  assert.throws(() => baselineFrom(run({ a: "PPP", b: "PEP" })), /errors/);
  assert.throws(() => baselineFrom(run({ a: "P" })), /3 trials, not 1/);
});

test("a run identical to the accepted one holds all three rules", () => {
  const g = gate(accepted, baseline, false);
  assert.equal(g.exit, EXIT.ok);
  assert.equal(g.line, "OK: all three rules held");
  assert.equal(g.comparison!.solid.solidCount, 7);
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
  // g falls to 1 of 3; h, i and j rise, so the mean holds and only rule 2 can fail.
  const broken = run({ a: "PPP", b: "PPP", c: "PPP", d: "PPP", e: "PPP", f: "PFP", g: "FPF", h: "PPP", i: "PPP", j: "PPP" });
  const c = compare(broken, baseline);
  assert.ok(c.average.held);
  assert.ok(!c.solid.held);
  assert.deepEqual(c.solid.broken, ["g"]);
  assert.equal(c.verdict, "regression");
  // Broken solid questions lead the flips, then the largest drops, then the rises.
  assert.deepEqual(c.flips.map((f) => f.id), ["g", "f", "h", "i", "j"]);
  assert.deepEqual(c.flips[0], { id: "g", baseline: 3, run: 1 });
  assert.match(gate(broken, baseline, false).line, /^REGRESSION: rule 2 \(solid set: g passed fewer than 2 of 3\)$/);
  // A question below 3 of 3 at accept may fail every trial: h, i and j at 0 of 3 hold the rule.
  const wobblyLost = run({ a: "PPP", b: "PPP", c: "PPP", d: "PPP", e: "PPP", f: "PPP", g: "PPP", h: "FFF", i: "FFF", j: "FFF" });
  assert.ok(compare(wobblyLost, baseline).solid.held);
});

test("rule 3: the mean cost per trial may rise by the margin and no further", () => {
  const all = { a: "PPP", b: "PPP", c: "PPP", d: "PPP", e: "PPP", f: "PPP", g: "PPP", h: "PFF", i: "FPF", j: "FFF" };
  // The baseline's questions cost 1c each, so 10c per trial with a 0.5c margin: 1.04c a question holds, 1.06c does not.
  assert.equal(compare(run(all, { cost: 0.0104 }), baseline).verdict, "ok");
  const dear = compare(run(all, { cost: 0.0106 }), baseline);
  assert.equal(dear.verdict, "regression");
  assert.ok(!dear.cost.held);
  assert.ok(dear.average.held && dear.solid.held);
  assert.match(gate(run(all, { cost: 0.0106 }), baseline, false).line, /^REGRESSION: rule 3 \(cost: \$0\.106 per trial above the ceiling of \$0\.105\)$/);
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
  // One trial against a three-trial baseline: not compared, and the build cannot pass on it.
  const one = run({ a: "P", b: "P", c: "P", d: "P", e: "P", f: "P", g: "P", h: "F", i: "F", j: "F" });
  assert.throws(() => compare(one, baseline), /1 trial\(s\) cannot be compared with a baseline of 3/);
  const mismatch = gate(one, baseline, false);
  assert.deepEqual([mismatch.exit, mismatch.comparison], [EXIT.unmeasured, null]);
  assert.match(mismatch.line, /^INCOMPLETE: not compared: the baseline was taken on 3 trials and this run has 1/);
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
  assert.match(g.line, /^against the baseline being replaced: REGRESSION: rule 1/);
});

test("a baseline in the old one-run format is refused, and a missing one reads as none", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "eval-baseline-"));
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    assert.equal(await loadBaseline("m", "high"), null);
    await mkdir(BASELINES_DIR, { recursive: true });
    await writeFile(path.join(BASELINES_DIR, "m.high.json"), JSON.stringify({ model: "m", effort: "high", tolerance: 3, passed: 27, questions: {} }));
    await assert.rejects(loadBaseline("m", "high"), /single run.*npm run eval -- --accept/);
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

test("totals: errors stay out of the sums, empty answers stay out of the means", () => {
  const t = totals([result("a", "pass"), result("b", "fail", 0.01, true), result("c", "error")]);
  assert.equal(t.errors, 1);
  assert.equal(t.empty, 1);
  assert.equal(t.toolCalls, 2);
  assert.equal(t.meanRecall, 1);
  assert.equal(t.meanPrecision, 1);
  assert.equal(totals([result("c", "error")]).meanRecall, null);
});
