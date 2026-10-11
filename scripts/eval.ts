// Run the eval: the thirty questions through the agent, scored, compared with the baseline.
//
//   npm run eval                                   (what ships: the default model and effort)
//   npm run eval -- --model claude-haiku-5-5 --effort high
//   npm run eval -- --only dlq-for-prod-2,path-compute-to-s3   (a subset: reported, not compared)
//   npm run eval -- --accept --tolerance 1         (declare this run the baseline for its model and effort)
//
// Exit code, read by CI: 0 when the run holds its baseline, 1 on a regression, 2 when the
// run cannot vouch for the agent (a question threw, or the model and effort have no baseline
// yet), 3 on a usage error. Only 0 ships.
import { parseArgs } from "node:util";

import { baselineFrom, compare, EXIT, exitCode, loadBaseline, saveBaseline } from "../eval/baseline.js";
import { runEval } from "../eval/harness.js";
import { saveEvalRun, type EvalRecord, type EvalTotals, type QuestionResult } from "../eval/record.js";
import { DEFAULT_EFFORT, DEFAULT_MODEL, EFFORTS, MODEL_IDS, type Effort, type ModelId } from "../src/agent/agent.js";
import { closeDriver } from "../src/graph/driver.js";

const { values } = parseArgs({
  options: {
    model: { type: "string" },
    effort: { type: "string" },
    only: { type: "string" },
    accept: { type: "boolean", default: false },
    tolerance: { type: "string" },
  },
});

const usage = (message: string): never => {
  console.error(`${message}\nUsage: npm run eval -- [--model <id>] [--effort <level>] [--only <ids>] [--accept [--tolerance <n>]]`);
  process.exit(EXIT.usage);
};
const model = (values.model ?? DEFAULT_MODEL) as ModelId;
const effort = (values.effort ?? DEFAULT_EFFORT) as Effort;
if (!MODEL_IDS.includes(model)) usage(`Unknown model ${values.model}; one of ${MODEL_IDS.join(", ")}.`);
if (!EFFORTS.includes(effort)) usage(`Unknown effort ${values.effort}; one of ${EFFORTS.join(", ")}.`);
if (values.accept && values.only) usage("--accept needs a run over every question; drop --only.");
if (values.tolerance !== undefined && !values.accept) usage("--tolerance only means something with --accept.");
const tolerance = values.tolerance === undefined ? undefined : Number(values.tolerance);
if (tolerance !== undefined && (!Number.isInteger(tolerance) || tolerance < 0)) {
  usage("--tolerance is a whole number of passes the run may lose.");
}

const cents = (usd: number) => `${(usd * 100).toFixed(1)}c`;
const pct = (share: number | null) => (share === null ? "n/a" : `${Math.round(share * 100)}%`);
const seconds = (ms: number) => `${(ms / 1000).toFixed(0)}s`;

function row(r: QuestionResult): string {
  if (!r.score || !r.diagnostics) return `${r.id.padEnd(36)} ERROR  ${r.error}`;
  const s = r.score;
  const d = r.diagnostics;
  return (
    `${r.id.padEnd(36)} ${r.status.toUpperCase().padEnd(5)} ` +
    `exp ${String(s.expected).padStart(2)}  miss ${String(s.missing.length).padStart(2)}  extra ${String(s.extra.length).padStart(2)}  ` +
    `recall ${pct(s.recall).padStart(4)}  prec ${pct(s.precision).padStart(4)}  ` +
    `${String(d.toolCalls).padStart(2)} calls (${d.cypherErrors} err, ${d.cutResults} cut)  ${seconds(d.durationMs).padStart(4)}  ${cents(d.costUsd).padStart(6)}` +
    (s.empty ? `  EMPTY ANSWER (stop: ${d.stopReason})` : "")
  );
}

// How the run's totals moved against the baseline's: reported, so a metric's drift is seen before it is gated.
function deltas(now: EvalTotals, before: EvalTotals): string {
  const num = (label: string, a: number, b: number, fmt: (n: number) => string) =>
    `${label} ${fmt(a)} (baseline ${fmt(b)}, ${a >= b ? "+" : ""}${fmt(a - b)})`;
  return [
    num("cost", now.costUsd, before.costUsd, (n) => `$${n.toFixed(3)}`),
    num("tool calls", now.toolCalls, before.toolCalls, String),
    num("empty answers", now.empty, before.empty, String),
    `mean recall ${pct(now.meanRecall)} (baseline ${pct(before.meanRecall)})`,
  ].join("; ");
}

let record: EvalRecord;
let baselineTolerance: number | undefined;
try {
  const started = Date.now();
  const run = await runEval({
    model,
    effort,
    only: values.only?.split(",").map((id) => id.trim()),
    onQuestion: (r) => console.log(`  done ${r.id} (${r.status}, ${seconds(Date.now() - started)} in)`),
  });
  const baseline = run.full ? await loadBaseline(run.model, run.effort) : null;
  baselineTolerance = baseline?.tolerance;
  record = { ...run, comparison: baseline ? compare(run, baseline) : null };
} finally {
  await closeDriver();
}

console.log(`\nmodel ${record.model}, effort ${record.effort}, prompt ${record.promptVersion}, code ${record.codeVersion}\n`);
for (const r of record.questions) {
  console.log(row(r));
  if (r.score?.missing.length) console.log(`    missing: ${r.score.missing.join(", ")}`);
  if (r.score?.extra.length) console.log(`    extra:   ${r.score.extra.join(", ")}`);
}

const t = record.totals;
console.log(
  `\npass ${t.passed} of ${t.questions}` +
    (t.errors ? `, ${t.errors} error(s)` : "") +
    (t.empty ? `, ${t.empty} empty answer(s)` : "") +
    `; mean recall ${pct(t.meanRecall)}, mean precision ${pct(t.meanPrecision)}; ` +
    `${t.toolCalls} tool calls (${t.cypherErrors} errors, ${t.cutResults} cut); ` +
    `$${t.costUsd.toFixed(3)}; ${seconds(record.durationMs)} wall clock`,
);
console.log(`saved ${await saveEvalRun(record)}`);

const c = record.comparison;
if (t.errors > 0) {
  console.log(`INCOMPLETE: ${t.errors} question(s) threw (see the ERROR rows); the run cannot vouch for the agent`);
} else if (!record.full) {
  console.log("subset run: reported, not compared with the baseline");
} else if (!c) {
  console.log(
    `no baseline for ${record.model} at effort ${record.effort}` +
      (values.accept ? "" : ": the build cannot pass without one; re-run with --accept --tolerance <n> to declare this run the baseline"),
  );
} else {
  console.log(`baseline ${c.baselineFile}: ${c.baselinePassed} passed, tolerance ${c.tolerance}, so the build fails below ${c.minPasses}`);
  if (c.newlyFailing.length) console.log(`  newly failing: ${c.newlyFailing.join(", ")}`);
  if (c.newlyPassing.length) console.log(`  newly passing: ${c.newlyPassing.join(", ")}`);
  const baseline = (await loadBaseline(record.model, record.effort))!;
  console.log(`  ${deltas(t, baseline.totals)}`);
  if (c.verdict === "ok") console.log(`OK: ${c.passed} passed, baseline held`);
  else console.log(`REGRESSION: ${c.passed} passed, below ${c.minPasses}`);
}

if (values.accept) {
  // The baseline must point at a commit, so the change it measures is committed first.
  if (record.codeVersion.endsWith("-dirty")) usage("Commit the change before accepting a baseline for it: the working tree is dirty.");
  if (tolerance === undefined && baselineTolerance === undefined) usage("A first baseline needs --tolerance <n>, agreed from the measured run-to-run spread.");
  const file = await saveBaseline(baselineFrom(record, tolerance ?? baselineTolerance!));
  console.log(`accepted as the baseline: ${file} (${t.passed} passed, tolerance ${tolerance ?? baselineTolerance}); commit it on its own`);
}
process.exitCode = exitCode(record, c, values.accept);
