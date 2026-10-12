// The false-red simulation's own tests: a baseline with nothing wobbly never goes red, one wobbly
// question gives the rate a hand calculation gives under each entry rule, the figures repeat
// exactly for a seed, and local records of both formats pool into per-question rates.
import assert from "node:assert/strict";
import { test } from "node:test";

import { BASELINE_FORMAT, SECOND_ROUND_RUNS, type Baseline } from "./baseline.js";
import { modelFromBaseline, poolRecords, seededRandom, simulateGate } from "./simulate.js";

/**
 * A baseline from each question's passes out of three, the second-round passes of those at 3 of 3
 * (all three unless `second` says otherwise) and the three trial costs; the fields the simulation
 * does not read are placeholders.
 */
const baseline = (questions: Record<string, number>, costUsd = [0.09, 0.09, 0.09], second: Record<string, number> = {}): Baseline => {
  const passes = Object.fromEntries(Object.keys(questions).filter((id) => questions[id] === 3).map((id) => [id, second[id] ?? SECOND_ROUND_RUNS]));
  return {
    format: BASELINE_FORMAT,
    model: "m",
    effort: "high",
    promptVersion: "p",
    codeVersion: "c",
    evalId: "e",
    acceptedAt: "",
    trials: 3,
    passed: [0, 0, 0],
    passTolerance: 1,
    costUsd,
    costMarginUsd: 0,
    questions,
    secondRound: { runsPerQuestion: SECOND_ROUND_RUNS, passes, runs: 0, costUsd: 0 },
    solid: Object.keys(passes).filter((id) => passes[id] === SECOND_ROUND_RUNS),
    trialTotals: [],
  };
};

test("the agent model reads each question's passes out of its draws in both rounds, and the costs' mean and sample deviation", () => {
  // a: 6 of 6. d: 3 of 3, then a pass and a failure, 4 of 5. b and c ran no second round.
  const m = modelFromBaseline(baseline({ a: 3, b: 2, c: 0, d: 3 }, [0.08, 0.09, 0.1], { d: 1 }));
  assert.deepEqual(m.passRates, { a: 1, b: 2 / 3, c: 0, d: 4 / 5 });
  assert.ok(Math.abs(m.costMeanUsd - 0.09) < 1e-12);
  assert.ok(Math.abs(m.costSdUsd - 0.01) < 1e-12);
});

test("one question at 75%: it enters the solid set over three draws 42% of the time, over six 18%, and breaks it accordingly", () => {
  // Entry: 0.75^3 = 42.2% with one round, 0.75^6 = 17.8% with two. Once in, a later run passes
  // fewer than 2 of 3 with 0.25^3 + 3 (0.75) (0.25)^2 = 15.6%, so rule 2 is red 6.6% and 2.8%.
  const m = { passRates: { a: 1, w: 0.75 }, costMeanUsd: 0.09, costSdUsd: 0 };
  const one = simulateGate(m, { pairs: 40_000, seed: 5, rounds: 1 });
  const two = simulateGate(m, { pairs: 40_000, seed: 5, rounds: 2 });
  const fail = 0.25 ** 3 + 3 * 0.75 * 0.25 ** 2;
  assert.ok(Math.abs(one.meanSolid - (1 + 0.75 ** 3)) < 0.01, `one round: mean solid set ${one.meanSolid}`);
  assert.ok(Math.abs(two.meanSolid - (1 + 0.75 ** 6)) < 0.01, `two rounds: mean solid set ${two.meanSolid}`);
  assert.ok(Math.abs(one.rule2 - 0.75 ** 3 * fail) < 0.005, `one round: rule 2 at ${one.rule2}`);
  assert.ok(Math.abs(two.rule2 - 0.75 ** 6 * fail) < 0.004, `two rounds: rule 2 at ${two.rule2}`);
  assert.deepEqual([one.rounds, two.rounds], [1, 2]);
});

test("a baseline where every question is 3 of 3 or 0 of 3, at a fixed cost, is never red", () => {
  const r = simulateGate(modelFromBaseline(baseline({ a: 3, b: 3, c: 3, d: 0 })), { pairs: 2000, seed: 1 });
  assert.equal(r.rule2, 0);
  assert.equal(r.rule1, 0);
  assert.equal(r.rule3, 0);
  assert.equal(r.anyRule, 0);
  assert.deepEqual(r.rule2ByQuestion, {});
});

test("one question at 2 of 3 breaks the solid set at the rate a hand calculation gives, under the one-round rule", () => {
  // It enters the solid set with (2/3)^3 = 0.296, then passes fewer than 2 of 3 with
  // (1/3)^3 + 3 (2/3) (1/3)^2 = 0.259: about 7.7% of pairs. A re-run against the same baseline is
  // red again with 0.259, so red twice is about 2.0%: the re-run does not undo a lucky accept.
  const r = simulateGate(modelFromBaseline(baseline({ a: 3, b: 3, w: 2 })), { pairs: 40_000, seed: 3, rounds: 1 });
  const enter = (2 / 3) ** 3;
  const fail = (1 / 3) ** 3 + 3 * (2 / 3) * (1 / 3) ** 2;
  assert.ok(Math.abs(r.rule2 - enter * fail) < 0.006, `rule 2 at ${r.rule2}`);
  assert.ok(Math.abs(r.redTwice - enter * fail * fail) < 0.003, `red twice at ${r.redTwice}`);
  assert.equal(r.rule1, 0, "one wobbly question moves the sum by at most 3, the tolerance times three");
  assert.deepEqual(Object.keys(r.rule2ByQuestion), ["w"]);
});

test("the figures are exactly the same for the same seed, and differ for another", () => {
  const m = modelFromBaseline(baseline({ a: 3, b: 3, w: 2, x: 1 }, [0.088, 0.094, 0.086]));
  const one = simulateGate(m, { pairs: 3000, seed: 42 });
  assert.deepEqual(simulateGate(m, { pairs: 3000, seed: 42 }), one);
  assert.notDeepEqual(simulateGate(m, { pairs: 3000, seed: 43 }), one);
  const a = seededRandom(7);
  const b = seededRandom(7);
  for (let i = 0; i < 5; i++) assert.equal(a(), b());
});

test("local records pool per question across both formats, counting errored trials neither way", () => {
  const match = { model: "m", effort: "high", promptVersion: "p" };
  const records = [
    // A three-trial record: per-trial results.
    { model: "m", effort: "high", promptVersion: "p", codeVersion: "c1", full: true, questions: [{ id: "a", results: [{ status: "pass" }, { status: "fail" }, { status: "error" }] }] },
    // An earlier one-trial record: the status on the question.
    { model: "m", effort: "high", promptVersion: "p", codeVersion: "c0", full: true, questions: [{ id: "a", status: "pass" }] },
    // Another prompt, and a subset run: both left out.
    { model: "m", effort: "high", promptVersion: "q", full: true, questions: [{ id: "a", status: "fail" }] },
    { model: "m", effort: "high", promptVersion: "p", full: false, questions: [{ id: "a", status: "fail" }] },
  ];
  const pooled = poolRecords(records, match);
  assert.deepEqual(pooled.passes, { a: 2 });
  assert.deepEqual(pooled.trials, { a: 3 });
  assert.deepEqual(pooled.used, [{ codeVersion: "c1", trials: 3 }, { codeVersion: "c0", trials: 1 }]);
});
