// How often the gate turns red on code that did not change. The model samples, so an agent that
// changed in nothing can still fail the gate: a question that usually passes can pass every accept
// draw, enter the solid set, then fail two trials of the next run (rule 2), and the trial counts
// and costs wobble around the allowances (rules 1 and 3). This module estimates that false-red
// rate by Monte Carlo: it draws many pairs of runs of one unchanged agent (an accept, then a later
// run of three trials) and judges each later run with the real `baselineFrom()` and `gate()`, so
// the simulation cannot drift from the rules CI applies.
//
// The accept is simulated with either entry rule, so the two can be compared on the same agent:
// two rounds, as `npm run eval -- --accept` runs them (three trials, then up to three more runs of
// each question that passed them all, stopped at its first failure: solid after six passes), or
// one round (solid after three), the rule before the second round existed.
//
// The model of the agent is deliberately plain: each question passes each run independently
// with a fixed rate, and each trial's cost is an independent normal draw. The rates are whatever
// the caller passes: by default each question's passes out of its draws in the committed baseline,
// both rounds counted, so a question at 6 of 6 is modelled as never failing and one that passed
// three then failed at 75%, whatever its true rate. The figures are therefore a reading of the
// baseline file, not of the agent, and the script that prints them says so. A seeded generator
// makes every figure reproducible.
import { baselineFrom, gate, SECOND_ROUND_RUNS, secondRoundEntrants, type Baseline, type SecondRoundScores } from "./baseline.js";
import { assemble, type EvalRun, type QuestionResult } from "./record.js";

/** The unchanged agent the simulation draws runs from: a pass rate per question and a normal cost per trial. */
export interface AgentModel {
  /** Question id to the probability that one trial of it passes. */
  passRates: Record<string, number>;
  /** Mean cost of one trial (all questions once), in US dollars. */
  costMeanUsd: number;
  /** Standard deviation of one trial's cost, in US dollars; 0 makes rule 3 a function of the floor alone. */
  costSdUsd: number;
}

/** What the simulation counts, each as a share of the simulated pairs. */
export interface SimulationResult {
  pairs: number;
  seed: number;
  trials: number;
  /** The accept's entry rule: 2 for six draws (the gate's), 1 for three. */
  rounds: 1 | 2;
  /** The solid set's mean size across the simulated accepts. */
  meanSolid: number;
  /** Later runs red on each rule, and on any rule. */
  rule1: number;
  rule2: number;
  rule3: number;
  anyRule: number;
  /** Later runs red, then red again on a re-run against the same accepted baseline. */
  redTwice: number;
  /** Per question, the share of pairs in which it broke the solid set (rule 2). */
  rule2ByQuestion: Record<string, number>;
}

/** A seeded pseudo-random generator (mulberry32): the same seed gives the same draws on every machine. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A standard normal draw from two uniform draws (Box-Muller). */
function normal(random: () => number): number {
  const u = 1 - random(); // in (0, 1], so the log is finite
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

/**
 * The agent model the committed baseline implies: each question's passes out of its draws, the
 * trials and its second-round runs (passes, then the failure that stopped it, if any), and the mean
 * and sample deviation of the trial costs.
 */
export function modelFromBaseline(baseline: Baseline): AgentModel {
  const second = baseline.secondRound;
  const rate = (id: string, passes: number) => {
    const extra = second.passes[id];
    if (extra === undefined) return passes / baseline.trials;
    const draws = baseline.trials + extra + (extra < second.runsPerQuestion ? 1 : 0);
    return (passes + extra) / draws;
  };
  const passRates = Object.fromEntries(Object.entries(baseline.questions).map(([id, passes]) => [id, rate(id, passes)]));
  const costs = baseline.costUsd;
  const mean = costs.reduce((a, b) => a + b, 0) / costs.length;
  const variance = costs.length > 1 ? costs.reduce((a, c) => a + (c - mean) ** 2, 0) / (costs.length - 1) : 0;
  return { passRates, costMeanUsd: mean, costSdUsd: Math.sqrt(variance) };
}

/** One simulated eval run of the unchanged agent, shaped like the harness's, so the real gate can judge it. */
function drawRun(model: AgentModel, ids: string[], trials: number, random: () => number): EvalRun {
  const perTrial: QuestionResult[][] = [];
  for (let t = 0; t < trials; t++) {
    const trialCost = Math.max(0, model.costMeanUsd + model.costSdUsd * normal(random));
    perTrial.push(
      ids.map((id) => {
        const pass = random() < model.passRates[id]!;
        return {
          id,
          status: pass ? "pass" : "fail",
          runId: null,
          score: { pass, empty: false, expected: 1, asserted: 1, missing: [], extra: [], recall: 1, precision: 1 },
          checks: { ungrounded: [], proseNamed: 1 },
          diagnostics: { toolCalls: 0, searchCalls: 0, cypherErrors: 0, cutResults: 0, durationMs: 0, costUsd: trialCost / ids.length, stopReason: "tool_use" },
          error: null,
        };
      }),
    );
  }
  return { evalId: "simulated", model: "m", effort: "e", promptVersion: "p", codeVersion: "c", startedAt: "", finishedAt: "", durationMs: 0, full: true, ...assemble(perTrial) };
}

/**
 * The second round of a simulated accept. With two rounds, each question that passed every trial
 * draws up to three more runs, stopped at its first failure; with one, every such question passes
 * them all, which makes the solid set the questions at every trial, the one-round rule.
 */
function drawSecondRound(model: AgentModel, run: EvalRun, rounds: 1 | 2, random: () => number): SecondRoundScores {
  const passes: Record<string, number> = {};
  let runs = 0;
  for (const id of secondRoundEntrants(run)) {
    let k = 0;
    if (rounds === 1) k = SECOND_ROUND_RUNS;
    else {
      while (k < SECOND_ROUND_RUNS) {
        runs++;
        if (random() >= model.passRates[id]!) break;
        k++;
      }
    }
    passes[id] = k;
  }
  return { runsPerQuestion: SECOND_ROUND_RUNS, passes, runs, costUsd: 0 };
}

/** Simulates `pairs` accept-then-later runs of one unchanged agent, three trials each, the accept by one or two rounds, and counts how often the real gate turns red. */
export function simulateGate(
  model: AgentModel,
  { pairs, seed, trials = 3, rounds = 2 }: { pairs: number; seed: number; trials?: number; rounds?: 1 | 2 },
): SimulationResult {
  const random = seededRandom(seed);
  const ids = Object.keys(model.passRates);
  let rule1 = 0, rule2 = 0, rule3 = 0, anyRule = 0, redTwice = 0, solid = 0;
  const broke: Record<string, number> = {};
  for (let i = 0; i < pairs; i++) {
    const accept = drawRun(model, ids, trials, random);
    const baseline = baselineFrom(accept, drawSecondRound(model, accept, rounds, random));
    solid += baseline.solid.length;
    const first = gate(drawRun(model, ids, trials, random), baseline, false).comparison!;
    if (!first.average.held) rule1++;
    if (!first.solid.held) rule2++;
    if (!first.cost.held) rule3++;
    for (const id of first.solid.broken) broke[id] = (broke[id] ?? 0) + 1;
    if (first.verdict === "regression") {
      anyRule++;
      // The policy: a red run's first move is one re-run, judged against the same baseline.
      if (gate(drawRun(model, ids, trials, random), baseline, false).comparison!.verdict === "regression") redTwice++;
    }
  }
  const share = (n: number) => n / pairs;
  return {
    pairs,
    seed,
    trials,
    rounds,
    meanSolid: solid / pairs,
    rule1: share(rule1),
    rule2: share(rule2),
    rule3: share(rule3),
    anyRule: share(anyRule),
    redTwice: share(redTwice),
    rule2ByQuestion: Object.fromEntries(Object.entries(broke).map(([id, n]) => [id, share(n)])),
  };
}

/** One local eval record, in either format: three-trial records hold per-trial results, earlier one-trial records hold the status on the question. */
interface StoredRecord {
  model?: string;
  effort?: string;
  promptVersion?: string;
  codeVersion?: string;
  full?: boolean;
  questions?: { id: string; status?: string; results?: { status: string }[] }[];
}

/** Each question's passes and answered trials pooled over the records of one model, effort and prompt; errored trials count neither way. */
export function poolRecords(records: StoredRecord[], match: { model: string; effort: string; promptVersion: string }): {
  passes: Record<string, number>;
  trials: Record<string, number>;
  used: { codeVersion: string; trials: number }[];
} {
  const passes: Record<string, number> = {};
  const trials: Record<string, number> = {};
  const used: { codeVersion: string; trials: number }[] = [];
  for (const r of records) {
    if (!r.full || r.model !== match.model || r.effort !== match.effort || r.promptVersion !== match.promptVersion || !r.questions) continue;
    for (const q of r.questions) {
      for (const result of q.results ?? [{ status: q.status ?? "error" }]) {
        if (result.status === "error") continue;
        trials[q.id] = (trials[q.id] ?? 0) + 1;
        passes[q.id] = (passes[q.id] ?? 0) + (result.status === "pass" ? 1 : 0);
      }
    }
    used.push({ codeVersion: r.codeVersion ?? "?", trials: r.questions[0]?.results?.length ?? 1 });
  }
  return { passes, trials, used };
}
