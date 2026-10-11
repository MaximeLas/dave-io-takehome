// The gate's own tests: the comparison with a baseline and the exit code, on hand-made
// records, so the verdicts and the tolerance are checked without a model call.
import assert from "node:assert/strict";
import { test } from "node:test";

import { baselineFrom, compare, EXIT, exitCode, type Baseline } from "./baseline.js";
import { totals, type EvalRun, type QuestionResult } from "./record.js";

const result = (id: string, status: QuestionResult["status"], empty = false): QuestionResult => ({
  id,
  status,
  runId: status === "error" ? null : `run-${id}`,
  score:
    status === "error"
      ? null
      : { pass: status === "pass", empty, expected: 1, asserted: empty ? 0 : 1, missing: [], extra: [], recall: empty ? 0 : 1, precision: 1 },
  diagnostics: status === "error" ? null : { toolCalls: 1, cypherErrors: 0, cutResults: 0, durationMs: 1000, costUsd: 0.01, stopReason: "tool_use" },
  error: status === "error" ? "boom" : null,
});

const run = (statuses: Record<string, QuestionResult["status"]>, full = true): EvalRun => {
  const questions = Object.entries(statuses).map(([id, status]) => result(id, status));
  return {
    evalId: "e1",
    model: "m",
    effort: "high",
    promptVersion: "p",
    codeVersion: "c",
    startedAt: "",
    finishedAt: "",
    durationMs: 0,
    full,
    questions,
    totals: totals(questions),
  };
};

// Three of four passed, and one pass may be lost.
const baseline: Baseline = baselineFrom(run({ a: "pass", b: "pass", c: "pass", d: "fail" }), 1);

test("a run within the tolerance holds the baseline, and the flips are named", () => {
  const c = compare(run({ a: "pass", b: "fail", c: "pass", d: "pass" }), baseline);
  assert.equal(c.verdict, "ok");
  assert.equal(c.minPasses, 2);
  assert.deepEqual(c.newlyFailing, ["b"]);
  assert.deepEqual(c.newlyPassing, ["d"]);
});

test("exactly the minimum still holds; one fewer is a regression", () => {
  const atMin = run({ a: "pass", b: "pass", c: "fail", d: "fail" });
  assert.equal(compare(atMin, baseline).verdict, "ok");
  assert.equal(exitCode(atMin, compare(atMin, baseline), false), EXIT.ok);
  const below = run({ a: "pass", b: "fail", c: "fail", d: "fail" });
  assert.equal(compare(below, baseline).verdict, "regression");
  assert.equal(exitCode(below, compare(below, baseline), false), EXIT.regression);
});

test("an errored question makes the run unmeasured, whatever the pass count", () => {
  const r = run({ a: "pass", b: "pass", c: "pass", d: "error" });
  assert.equal(compare(r, baseline).verdict, "unmeasured");
  assert.equal(exitCode(r, compare(r, baseline), false), EXIT.unmeasured);
  // Even a subset run, and even while accepting.
  assert.equal(exitCode(run({ a: "error" }, false), null, false), EXIT.unmeasured);
  assert.equal(exitCode(r, null, true), EXIT.unmeasured);
});

test("a full run with no baseline cannot pass the build, unless it is being accepted", () => {
  const r = run({ a: "pass", b: "pass" });
  assert.equal(exitCode(r, null, false), EXIT.unmeasured);
  assert.equal(exitCode(r, null, true), EXIT.ok);
});

test("a subset run without errors is reported and exits ok", () => {
  assert.equal(exitCode(run({ a: "fail" }, false), null, false), EXIT.ok);
});

test("only a full, error-free run with a sane tolerance can become the baseline", () => {
  assert.throws(() => baselineFrom(run({ a: "pass" }, false), 0), /every question/);
  assert.throws(() => baselineFrom(run({ a: "pass", b: "error" }), 0), /errors/);
  assert.throws(() => baselineFrom(run({ a: "pass", b: "fail" }), 2), /between 0 and/);
  const b = baselineFrom(run({ a: "pass", b: "fail" }), 1);
  assert.equal(b.passed, 1);
  assert.equal(b.tolerance, 1);
  assert.deepEqual(b.questions, { a: "pass", b: "fail" });
  assert.equal(b.totals.toolCalls, 2);
});

test("totals: errors stay out of the sums, empty answers stay out of the means", () => {
  const t = totals([result("a", "pass"), result("b", "fail", true), result("c", "error")]);
  assert.equal(t.errors, 1);
  assert.equal(t.empty, 1);
  assert.equal(t.toolCalls, 2);
  assert.equal(t.meanRecall, 1);
  assert.equal(t.meanPrecision, 1);
  assert.equal(totals([result("c", "error")]).meanRecall, null);
});
