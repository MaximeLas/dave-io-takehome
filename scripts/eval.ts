// Run the eval: the thirty questions through the agent, n times each, scored, compared with the baseline.
//
//   npm run eval                                   (what CI runs: three trials, gated by the three rules)
//   npm run eval -- --trials 1                     (a quick read of one trial: reported, not gated)
//   npm run eval -- --model claude-haiku-5-5 --effort high
//   npm run eval -- --only dlq-for-prod-2,path-compute-to-s3   (a subset: reported, not compared)
//   npm run eval -- --accept                       (declare this run the baseline for its model and effort)
//
// Exit code, read by CI: 0 when the run holds its baseline, 1 on a regression, 2 when the
// run cannot vouch for the agent (the eval stopped before scoring, a question threw, the
// baseline is missing, in the old format, or taken on another number of trials), 3 on a usage
// error. Only 0 ships.
import { parseArgs } from "node:util";

import { BASELINE_TRIALS, baselineFrom, EXIT, gate, loadBaseline, saveBaseline, type Baseline, type GateVerdict } from "../eval/baseline.js";
import { runEval } from "../eval/harness.js";
import { saveEvalRun, type Comparison, type EvalRecord, type EvalTotals, type QuestionTrials } from "../eval/record.js";
import type { Diagnostics } from "../eval/score.js";
import { DEFAULT_EFFORT, DEFAULT_MODEL, EFFORTS, MODEL_IDS, type Effort, type ModelId } from "../src/agent/agent.js";
import { codeVersion } from "../src/agent/run.js";
import { closeDriver } from "../src/graph/driver.js";

const { values } = parseArgs({
  options: {
    model: { type: "string" },
    effort: { type: "string" },
    only: { type: "string" },
    trials: { type: "string" },
    accept: { type: "boolean", default: false },
  },
});

const usage = (message: string): never => {
  console.error(`${message}\nUsage: npm run eval -- [--model <id>] [--effort <level>] [--only <ids>] [--trials <n>] [--accept]`);
  process.exit(EXIT.usage);
};
const model = (values.model ?? DEFAULT_MODEL) as ModelId;
const effort = (values.effort ?? DEFAULT_EFFORT) as Effort;
const trials = values.trials === undefined ? BASELINE_TRIALS : Number(values.trials);
if (!MODEL_IDS.includes(model)) usage(`Unknown model ${values.model}; one of ${MODEL_IDS.join(", ")}.`);
if (!EFFORTS.includes(effort)) usage(`Unknown effort ${values.effort}; one of ${EFFORTS.join(", ")}.`);
if (!Number.isInteger(trials) || trials < 1) usage("--trials is a whole number of runs per question, at least 1.");
if (values.accept && values.only) usage("--accept needs a run over every question; drop --only.");
if (values.accept && trials !== BASELINE_TRIALS) usage(`A baseline is taken on ${BASELINE_TRIALS} trials; drop --trials to accept.`);
// The baseline must point at a commit, so the change it measures is committed before any token is spent.
if (values.accept && codeVersion().endsWith("-dirty")) usage("Commit the change before accepting a baseline for it: the working tree is dirty.");

const cents = (usd: number) => `${(usd * 100).toFixed(1)}c`;
const dollars = (usd: number) => `$${usd.toFixed(3)}`;
const pct = (share: number | null) => (share === null ? "n/a" : `${Math.round(share * 100)}%`);
const seconds = (ms: number) => `${(ms / 1000).toFixed(0)}s`;
const mean = (xs: number[]) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);
const fmt = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(1));

// A full run is compared with its baseline, so the baseline is read first: a file in the old
// format stops the run before any model token is spent, unless this run is replacing it.
let baseline: Baseline | null = null;
if (!values.only) {
  try {
    baseline = await loadBaseline(model, effort);
  } catch (error) {
    if (!values.accept) {
      console.error(`INCOMPLETE: ${(error as Error).message}`);
      process.exit(EXIT.unmeasured);
    }
  }
}

// One question across the trials: its pass count, the means of what the answered trials measured, then a line per trial that did not pass.
function row(q: QuestionTrials, baselinePasses: number | undefined): string[] {
  const n = q.results.length;
  const answered = q.results.filter((r) => r.score && r.diagnostics);
  const avg = (pick: (d: Diagnostics) => number) => mean(answered.map((r) => pick(r.diagnostics!)));
  const marks = q.results.map((r) => ({ pass: "P", fail: "F", error: "E" })[r.status]).join("");
  const expected = answered[0]?.score?.expected;
  const nonEmpty = answered.filter((r) => !r.score!.empty);
  let line =
    `${q.id.padEnd(36)} ${q.passes}/${n}` +
    (baselinePasses === undefined ? "" : ` (baseline ${baselinePasses}/${n})`) +
    `  ${marks}`;
  if (answered.length > 0) {
    line +=
      `  exp ${String(expected).padStart(2)}  ` +
      `recall ${pct(mean(nonEmpty.map((r) => r.score!.recall))).padStart(4)}  prec ${pct(mean(nonEmpty.map((r) => r.score!.precision))).padStart(4)}  ` +
      `${fmt(avg((d) => d.toolCalls)!).padStart(4)} calls (${fmt(avg((d) => d.cypherErrors)!)} err, ${fmt(avg((d) => d.cutResults)!)} cut)  ` +
      `${seconds(avg((d) => d.durationMs)!).padStart(4)}  ${cents(avg((d) => d.costUsd)!).padStart(6)}`;
  }
  const details = q.results.flatMap((r, t) => {
    if (r.status === "pass") return [];
    if (!r.score || !r.diagnostics) return [`    trial ${t + 1}: ERROR ${r.error}`];
    if (r.score.empty) return [`    trial ${t + 1}: EMPTY ANSWER (stop: ${r.diagnostics.stopReason})`];
    const parts = [r.score.missing.length ? `missing ${r.score.missing.join(", ")}` : "", r.score.extra.length ? `extra ${r.score.extra.join(", ")}` : ""];
    return [`    trial ${t + 1}: ${parts.filter(Boolean).join("; ")}`];
  });
  return [line, ...details];
}

// The metrics that are reported and not gated, per trial, against the baseline's, so a drift is seen before it is gated.
function deltas(now: EvalTotals[], before: EvalTotals[]): string {
  const avg = (ts: EvalTotals[], pick: (t: EvalTotals) => number | null) => mean(ts.map(pick).filter((x): x is number => x !== null));
  const num = (label: string, pick: (t: EvalTotals) => number) => {
    const a = avg(now, pick)!;
    const b = avg(before, pick)!;
    return `${label} ${fmt(a)} (baseline ${fmt(b)}, ${a >= b ? "+" : ""}${fmt(a - b)})`;
  };
  return [
    num("tool calls per trial", (t) => t.toolCalls),
    num("Cypher errors", (t) => t.cypherErrors),
    num("empty answers", (t) => t.empty),
    `mean recall ${pct(avg(now, (t) => t.meanRecall))} (baseline ${pct(avg(before, (t) => t.meanRecall))})`,
  ].join("; ");
}

function rules(c: Comparison, b: Baseline): string[] {
  const verdict = (held: boolean) => (held ? "held" : "FAILED");
  const lines = [
    `baseline ${c.baselineFile}: ${b.trials} trials on ${b.codeVersion} (pass ${b.passed.join(", ")}; cost ${b.costUsd.map(dollars).join(", ")})`,
    `  rule 1, average:   mean ${fmt(c.average.value)} passes, floor ${fmt(c.average.limit)} (baseline ${fmt(c.average.baseline)} - tolerance ${c.average.allowance}): ${verdict(c.average.held)}`,
    `  rule 2, solid set: ${c.solid.solidCount} questions passed ${b.trials} of ${b.trials} at accept; each must pass at least ${b.trials - 1} of ${b.trials}: ${verdict(c.solid.held)}`,
  ];
  for (const id of c.solid.broken) lines.push(`                     broken: ${id} (${c.flips.find((f) => f.id === id)?.run ?? 0} of ${b.trials})`);
  lines.push(
    `  rule 3, cost:      mean ${dollars(c.cost.value)} per trial, ceiling ${dollars(c.cost.limit)} (baseline ${dollars(c.cost.baseline)} + margin ${dollars(c.cost.allowance)}): ${verdict(c.cost.held)}`,
  );
  return lines;
}

let record: EvalRecord;
let verdict: GateVerdict;
try {
  const started = Date.now();
  const run = await runEval({
    model,
    effort,
    trials,
    only: values.only?.split(",").map((id) => id.trim()),
    onQuestion: (r, t) => console.log(`  done ${r.id}${trials > 1 ? ` trial ${t}` : ""} (${r.status}, ${seconds(Date.now() - started)} in)`),
  });
  verdict = gate(run, baseline, values.accept);
  record = { ...run, comparison: verdict.comparison };
} catch (error) {
  // Nothing was scored (the graph is down or not seeded, a setting is missing): the run says
  // nothing about the agent, so it must not exit the way a regression does.
  console.error("INCOMPLETE: the eval stopped before scoring; the run cannot vouch for the agent.\n", error);
  process.exit(EXIT.unmeasured);
} finally {
  await closeDriver();
}

const s = record.summary;
const c = record.comparison;
console.log(`\nmodel ${record.model}, effort ${record.effort}, prompt ${record.promptVersion}, code ${record.codeVersion}, ${s.trials} trial(s)\n`);
// Broken solid questions first, then the other questions whose pass count moved, then the rest in question order.
const flipped = new Set(c?.flips.map((f) => f.id));
const ordered = [...(c?.flips.map((f) => record.questions.find((q) => q.id === f.id)!) ?? []), ...record.questions.filter((q) => !flipped.has(q.id))];
for (const q of ordered) for (const line of row(q, c ? baseline!.questions[q.id] : undefined)) console.log(line);

const per = (pick: (t: EvalTotals) => number, f: (n: number) => string = String) => record.trialTotals.map((t) => f(pick(t))).join(", ");
console.log(
  `\npass ${per((t) => t.passed)} of ${record.questions.length}` +
    (s.trials > 1 ? ` (mean ${fmt(s.meanPassed)}, min ${s.minPassed}, max ${s.maxPassed})` : "") +
    (s.errors ? `; ${s.errors} error(s)` : "") +
    `; empty answers ${per((t) => t.empty)}; tool calls ${per((t) => t.toolCalls)} (Cypher errors ${per((t) => t.cypherErrors)}, cut ${per((t) => t.cutResults)})` +
    `\ncost ${per((t) => t.costUsd, dollars)}` +
    (s.trials > 1 ? ` (mean ${dollars(s.meanCostUsd)} per trial, ${dollars(s.costUsd)} in all)` : "") +
    `; mean recall ${record.trialTotals.map((t) => pct(t.meanRecall)).join(", ")}, precision ${record.trialTotals.map((t) => pct(t.meanPrecision)).join(", ")}` +
    `; ${seconds(record.durationMs)} wall clock`,
);
console.log(`saved ${await saveEvalRun(record)}`);

if (c && baseline) {
  for (const line of rules(c, baseline)) console.log(line);
  console.log(`  reported: ${deltas(record.trialTotals, baseline.trialTotals)}`);
}
console.log(verdict.line);

if (values.accept && s.errors === 0) {
  const accepted = baselineFrom(record);
  const file = await saveBaseline(accepted);
  console.log(
    `accepted as the baseline: ${file}\n` +
      `  pass ${accepted.passed.join(", ")} (mean ${fmt(s.meanPassed)}), pass tolerance ${accepted.passTolerance} (spread ${s.maxPassed - s.minPassed})\n` +
      `  cost ${accepted.costUsd.map(dollars).join(", ")} (mean ${dollars(s.meanCostUsd)}), cost margin ${dollars(accepted.costMarginUsd)} (spread ${dollars(Math.max(...accepted.costUsd) - Math.min(...accepted.costUsd))})\n` +
      `  ${Object.values(accepted.questions).filter((k) => k === accepted.trials).length} questions in the solid set; commit the file on its own`,
  );
} else if (values.accept) {
  console.log("not accepted: a run with errors cannot become the baseline; re-run it");
}
process.exitCode = verdict.exit;
