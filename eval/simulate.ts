// How often the gate turns red on code that did not change. The model samples, so an agent that
// changed in nothing can still fail the gate: a question that usually passes can pass all three
// accept trials, enter the solid set, then fail two trials of the next run (rule 2), and the trial
// counts and costs wobble around the allowances (rules 1 and 3). This module estimates that
// false-red rate by Monte Carlo: it draws many pairs of runs of one unchanged agent (an accept run
// of three trials, then a later run of three trials) and judges each later run with the real
// `baselineFrom()` and `gate()`, so the simulation cannot drift from the rules CI applies.
//
// The model of the agent is deliberately plain: each question passes each trial independently
// with a fixed rate, and each trial's cost is an independent normal draw. The rates are whatever
// the caller passes: by default the committed baseline's passes out of three, which are three
// draws per question, so a question at 3 of 3 is modelled as never failing and one at 2 of 3 at
// 67% whatever its true rate. The figures are therefore a reading of the baseline file, not of
// the agent, and the script that prints them says so. A seeded generator makes every figure
// reproducible.
import { baselineFrom, gate, type Baseline } from "./baseline.js";
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

/** The agent model the committed baseline implies: each question's passes out of `trials`, and the mean and sample deviation of the trial costs. */
export function modelFromBaseline(baseline: Baseline): AgentModel {
  const passRates = Object.fromEntries(Object.entries(baseline.questions).map(([id, passes]) => [id, passes / baseline.trials]));
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
          diagnostics: { toolCalls: 0, cypherErrors: 0, cutResults: 0, durationMs: 0, costUsd: trialCost / ids.length, stopReason: "tool_use" },
          error: null,
        };
      }),
    );
  }
  return { evalId: "simulated", model: "m", effort: "e", promptVersion: "p", codeVersion: "c", startedAt: "", finishedAt: "", durationMs: 0, full: true, ...assemble(perTrial) };
}

/** Simulates `pairs` accept-then-later runs of one unchanged agent, three trials each, and counts how often the real gate turns red. */
export function simulateGate(model: AgentModel, { pairs, seed, trials = 3 }: { pairs: number; seed: number; trials?: number }): SimulationResult {
  const random = seededRandom(seed);
  const ids = Object.keys(model.passRates);
  let rule1 = 0, rule2 = 0, rule3 = 0, anyRule = 0, redTwice = 0;
  const broke: Record<string, number> = {};
  for (let i = 0; i < pairs; i++) {
    const baseline = baselineFrom(drawRun(model, ids, trials, random));
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
