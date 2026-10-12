// Run the eval: the thirty questions through the agent, n times each, scored, compared with the baseline.
//
//   npm run eval                                   (what CI runs: three trials, gated by the three rules)
//   npm run eval -- --trials 1                     (a quick read of one trial: reported, not gated)
//   npm run eval -- --model claude-haiku-5-5 --effort high
//   npm run eval -- --only dlq-for-prod-2,path-compute-to-s3   (a subset: reported, not compared)
//   npm run eval -- --accept                       (declare this run the baseline for its model and effort)
//
// Exit code, read by CI: 0 when the run holds its baseline (or is a subset or a quick read on
// another number of trials, reported and not compared), 1 on a regression, 2 when the run
// cannot vouch for the agent (the eval stopped before scoring, a question threw, the baseline
// is missing or in the old format), 3 on a usage error. Only 0 ships.
import { parseArgs } from "node:util";

import {
  BASELINE_TRIALS,
  baselineFrom,
  EXIT,
  gate,
  loadBaseline,
  metricDeltas,
  saveBaseline,
  SECOND_ROUND_RUNS,
  secondRoundScores,
  type Baseline,
  type GateVerdict,
} from "../eval/baseline.js";
import { runEval, runSecondRound } from "../eval/harness.js";
import { cents, saveEvalRun, type Comparison, type EvalRecord, type EvalTotals, type QuestionTrials } from "../eval/record.js";
import { loadQuestions } from "../eval/questions.js";
import type { Diagnostics } from "../eval/score.js";
import { DEFAULT_EFFORT, DEFAULT_MODEL, EFFORTS, MODEL_IDS, type Effort, type ModelId } from "../src/agent/agent.js";
import { codeVersion } from "../src/agent/run.js";
import { answerHelp, argsError, field, localTime, reportFailure, usageError } from "../src/cli.js";
import { closeDriver } from "../src/graph/driver.js";

answerHelp(`
npm run eval: runs the thirty eval questions through the agent, scores each against the key,
and judges the run. By default every question runs ${BASELINE_TRIALS} times (${BASELINE_TRIALS} trials, about 27 cents) and
the run ends with the gate's verdict against the committed baseline in eval/baselines/: the
same check CI runs. A run on another number of trials, or with --only, is reported, not compared.
Where eval/key-overlay.json amends the key (the audit in eval/key-audit.md), the report also
prints the passes against the amended key; the gate reads the key alone.

Options:
  --trials <n>       runs per question (default: ${BASELINE_TRIALS}, what the gate compares)
  --only <ids>       comma-separated question ids, see npm run ask -- --list (default: all thirty)
  --model <id>       ${MODEL_IDS.join(", ")} (default: ${DEFAULT_MODEL}, what ships)
  --effort <level>   ${EFFORTS.join(", ")} (default: ${DEFAULT_EFFORT}, what ships)
  --accept           declare this run the new baseline for its model and effort
                     (all questions, ${BASELINE_TRIALS} trials, committed code; then commit the file);
                     each question that passed every trial then runs up to ${SECOND_ROUND_RUNS} more
                     times alone, stopped at its first failure, and only those that pass all
                     ${BASELINE_TRIALS + SECOND_ROUND_RUNS} make up the solid set the gate holds
  --help             print this help

Exit code: 0 the baseline held (or the run was only reported), 1 a regression,
2 the run cannot vouch for the agent, 3 a usage error. Only 0 ships.

Example:
  npm run eval -- --trials 1        a quick read of every question, about 9 cents
`);

const usage = (message: string): never => usageError(message, "npm run eval");

const { values } = (() => {
  try {
    return parseArgs({
      options: {
        model: { type: "string" },
        effort: { type: "string" },
        only: { type: "string" },
        trials: { type: "string" },
        accept: { type: "boolean", default: false },
      },
    });
  } catch (error) {
    return usage(argsError(error));
  }
})();
const model = (values.model ?? DEFAULT_MODEL) as ModelId;
const effort = (values.effort ?? DEFAULT_EFFORT) as Effort;
const trials = values.trials === undefined ? BASELINE_TRIALS : Number(values.trials);
if (!MODEL_IDS.includes(model)) usage(`Unknown model ${values.model}; one of ${MODEL_IDS.join(", ")}.`);
if (!EFFORTS.includes(effort)) usage(`Unknown effort ${values.effort}; one of ${EFFORTS.join(", ")}.`);
if (!Number.isInteger(trials) || trials < 1) usage("--trials is a whole number of runs per question, at least 1.");
const only = values.only?.split(",").map((id) => id.trim());
const questions = await loadQuestions();
const unknownIds = only?.filter((id) => !questions.some((q) => q.id === id)) ?? [];
if (unknownIds.length > 0) {
  usageError(`No eval question has the id${unknownIds.length > 1 ? "s" : ""} ${unknownIds.join(", ")}; npm run ask -- --list prints them all.`);
}
if (values.accept && values.only) usage("--accept needs a run over every question; drop --only.");
if (values.accept && trials !== BASELINE_TRIALS) usage(`A baseline is taken on ${BASELINE_TRIALS} trials; drop --trials to accept.`);
// The baseline must point at a commit, so the change it measures is committed before any token is spent.
if (values.accept && codeVersion().endsWith("-dirty")) usage("Commit the change before accepting a baseline for it: the working tree is dirty.");

// Costs the gate compares (rule 3, the baseline, the margin) get two digits, so a failing
// ceiling never prints equal to the cost that broke it.
const gateCents = (usd: number) => cents(usd, 2);
const pct = (share: number | null) => (share === null ? "n/a" : `${Math.round(share * 100)}%`);
const seconds = (ms: number) => `${(ms / 1000).toFixed(0)}s`;
const mean = (xs: number[]) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);
const fmt = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(1));

// A full run is compared with its baseline, so the baseline is read first: a file in the old
// format stops the run before any model token is spent, unless this run is replacing it.
let baseline: Baseline | null = null;
let replacedFormat = false;
if (!values.only) {
  try {
    baseline = await loadBaseline(model, effort);
  } catch (error) {
    if (!values.accept) {
      console.error(`INCOMPLETE: ${(error as Error).message}`);
      process.exit(EXIT.unmeasured);
    }
    replacedFormat = true;
  }
}

// What the table's columns mean, one definition per line, printed once above it.
const legend = (compared: boolean, amended: boolean) => [
  field("passed", `passes out of trials; a trial is one run of every question, and the gate runs ${BASELINE_TRIALS}`),
  ...(compared ? [field(`(n/${BASELINE_TRIALS})`, "beside passed: the same question's passes in the baseline")] : []),
  ...(amended ? [field("[n/t]", "beside passed: passes against the key as eval/key-overlay.json amends it (eval/key-audit.md); not gated")] : []),
  field("exp", "ids the answer key expects"),
  field("the rest", "means per answered run: recall, precision, time, cost, tool calls"),
  field("err, cut", "beside the tool calls, only when nonzero: Cypher errors, results cut short"),
];
const ID_WIDTH = Math.max(...questions.map((q) => q.id.length));
// A question the overlay amends carries an amended pass in every trial that produced an answer.
const isAmended = (q: QuestionTrials) => q.results.some((r) => r.amendedPass !== undefined);
const passedText = (q: QuestionTrials, baselinePasses: number | undefined) =>
  `${q.passes}/${q.results.length}` +
  (baselinePasses === undefined ? "" : ` (${baselinePasses}/${q.results.length})`) +
  (isAmended(q) ? ` [${q.amendedPasses}/${q.results.length}]` : "");

// The table's header row, its columns aligned with row()'s.
function header(passedWidth: number): string {
  return `${"question".padEnd(ID_WIDTH)}  ${"passed".padEnd(passedWidth)}  exp  recall  prec  time  cost  tool calls`;
}

// One question across the trials: its pass count, the means of what the answered trials measured, then a line per trial that did not pass.
// The tool-call count, whose length varies, comes last, so the columns before it stay aligned.
function row(q: QuestionTrials, baselinePasses: number | undefined, passedWidth: number): string[] {
  const answered = q.results.filter((r) => r.score && r.diagnostics);
  const avg = (pick: (d: Diagnostics) => number) => mean(answered.map((r) => pick(r.diagnostics!)));
  const expected = answered[0]?.score?.expected;
  const nonEmpty = answered.filter((r) => !r.score!.empty);
  let line = `${q.id.padEnd(ID_WIDTH)}  ${passedText(q, baselinePasses).padEnd(passedWidth)}`;
  if (answered.length > 0) {
    const errors = avg((d) => d.cypherErrors)!;
    const cut = avg((d) => d.cutResults)!;
    line +=
      `  ${String(expected).padStart(3)}` +
      `  ${pct(mean(nonEmpty.map((r) => r.score!.recall))).padStart(6)}  ${pct(mean(nonEmpty.map((r) => r.score!.precision))).padStart(4)}` +
      `  ${seconds(avg((d) => d.durationMs)!).padStart(4)}  ${cents(avg((d) => d.costUsd)!).padStart(4)}` +
      `  ${fmt(avg((d) => d.toolCalls)!)}` +
      (errors > 0 ? `, ${fmt(errors)} err` : "") +
      (cut > 0 ? `, ${fmt(cut)} cut` : "");
  }
  // Each line names its trial and what went wrong; a blank line closes the group, so the
  // details read as belonging to the row above them.
  const details = q.results.flatMap((r, t) => {
    if (r.status === "pass") return [];
    if (!r.score || !r.diagnostics) return [`  trial ${t + 1} threw: ${r.error}`];
    if (r.score.empty) return [`  trial ${t + 1} failed: EMPTY ANSWER (stop: ${r.diagnostics.stopReason})`];
    const parts = [r.score.missing.length ? `missing ${r.score.missing.join(", ")}` : "", r.score.extra.length ? `extra ${r.score.extra.join(", ")}` : ""];
    return [`  trial ${t + 1} failed: ${parts.filter(Boolean).join("; ")}`];
  });
  return details.length > 0 ? [line, ...details, ""] : [line];
}

// The three rules, each opening with whether it held, so the line can be read from its first word.
function rules(c: Comparison, b: Baseline): string[] {
  const verdict = (held: boolean) => (held ? "held  " : "FAILED");
  const draws = b.trials + b.secondRound.runsPerQuestion;
  const leftInSecond = Object.keys(b.secondRound.passes).filter((id) => !b.solid.includes(id));
  const lines = [
    `gate against ${c.baselineFile}`,
    `  baseline  ${b.trials} trials on ${b.codeVersion}; passed ${b.passed.join(", ")}; cost ${b.costUsd.map(gateCents).join(", ")}`,
    `  rule 1    ${verdict(c.average.held)}  average: mean ${fmt(c.average.value)} passes, floor ${fmt(c.average.limit)} (baseline ${fmt(c.average.baseline)} - tolerance ${c.average.allowance})`,
    `  rule 2    ${verdict(c.solid.held)}  solid set: the ${c.solid.solidCount} questions that passed all ${draws} accept draws must pass at least ${b.trials - 1} of ${b.trials}`,
  ];
  for (const id of c.solid.broken) lines.push(`                    broken: ${id} (${c.flips.find((f) => f.id === id)?.run ?? 0} of ${b.trials})`);
  if (leftInSecond.length > 0) {
    lines.push(`                    not gated: ${leftInSecond.join(", ")} (${b.trials} of ${b.trials} in the baseline's trials, then a failure in its second round)`);
  }
  lines.push(
    `  rule 3    ${verdict(c.cost.held)}  cost: mean ${gateCents(c.cost.value)} per trial, ceiling ${gateCents(c.cost.limit)} (baseline ${gateCents(c.cost.baseline)} + margin ${gateCents(c.cost.allowance)})`,
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
    only,
    onQuestion: (r, t) => console.log(`  done ${r.id}${trials > 1 ? ` trial ${t}` : ""} (${r.status}, ${seconds(Date.now() - started)} in)`),
  });
  verdict = gate(run, baseline, values.accept);
  if (replacedFormat && verdict.line.startsWith("ACCEPTING: no baseline")) {
    verdict = { ...verdict, line: `ACCEPTING: the committed baseline is in an earlier format the gate no longer reads, so this run replaces it uncompared` };
  }
  record = { ...run, comparison: verdict.comparison };
  // Accepting a clean run: the second round decides which of the questions at every trial are solid.
  if (values.accept && run.full && run.summary.errors === 0) {
    record.secondRound = await runSecondRound(run, {
      onRun: (r, attempt) => console.log(`  done ${r.id} second round ${attempt} (${r.status}, ${seconds(Date.now() - started)} in)`),
    });
  }
} catch (error) {
  // Nothing was scored (the graph is down or not seeded, a setting is missing): the run says
  // nothing about the agent, so it must not exit the way a regression does.
  reportFailure(error, "INCOMPLETE: the eval stopped before scoring, so the run cannot vouch for the agent: ");
  process.exit(EXIT.unmeasured);
} finally {
  await closeDriver();
}

// The report, in blocks separated by a blank line, read top to bottom like a test runner's:
// what ran, each question, the totals, where the record is, the gate, and the verdict last.
const s = record.summary;
const c = record.comparison;
const out: string[] = [];
const block = (...lines: string[]) => out.push("", ...lines);

const args = process.argv.slice(2);
block(
  field("command", `npm run eval${args.length > 0 ? ` -- ${args.join(" ")}` : ""}`),
  field("model", `${record.model}, effort ${record.effort}`),
  field("version", `prompt ${record.promptVersion}, code ${record.codeVersion}`),
  field("trials", String(s.trials)),
  field("started", localTime(new Date(record.startedAt))),
);

// Broken solid questions first, then the other questions whose pass count moved, then the rest in question order.
const flipped = new Set(c?.flips.map((f) => f.id));
const ordered = [...(c?.flips.map((f) => record.questions.find((q) => q.id === f.id)!) ?? []), ...record.questions.filter((q) => !flipped.has(q.id))];
const baselinePasses = (q: QuestionTrials) => (c ? baseline!.questions[q.id] : undefined);
const passedWidth = Math.max("passed".length, ...ordered.map((q) => passedText(q, baselinePasses(q)).length));
const amendedCount = record.questions.filter(isAmended).length;
block(...legend(c !== null, amendedCount > 0), "", header(passedWidth), ...ordered.flatMap((q) => row(q, baselinePasses(q), passedWidth)));

const per = (pick: (t: EvalTotals) => number, f: (n: number) => string = String) => record.trialTotals.map((t) => f(pick(t))).join(", ");
const several = s.trials > 1;
block(
  field("passed", `${per((t) => t.passed)} of ${record.questions.length}` + (several ? ` (mean ${fmt(s.meanPassed)}, min ${s.minPassed}, max ${s.maxPassed})` : "")),
  ...(amendedCount > 0
    ? [field("amended", `${per((t) => t.passedAmended)} of ${record.questions.length} against the key with ${amendedCount} question${amendedCount === 1 ? "" : "s"} amended by eval/key-overlay.json; the gate reads the key`)]
    : []),
  ...(s.errors ? [field("errors", `${s.errors} question run(s) threw; see the ERROR lines`)] : []),
  field("cost", per((t) => t.costUsd, cents) + (several ? ` (mean ${cents(s.meanCostUsd)} per trial, ${cents(s.costUsd)} in all)` : "")),
  field("recall", record.trialTotals.map((t) => pct(t.meanRecall)).join(", ")),
  field("precision", record.trialTotals.map((t) => pct(t.meanPrecision)).join(", ")),
  field("tool calls", `${per((t) => t.toolCalls)} (Cypher errors ${per((t) => t.cypherErrors)}; cut results ${per((t) => t.cutResults)})`),
  field("empty", `${per((t) => t.empty)} answers without a final_answer call`),
  field("wall clock", seconds(record.durationMs)),
);

// The score says that a question failed; its trace says why.
const firstFailure = record.questions.flatMap((q) => q.results).find((r) => r.status !== "pass" && r.runId);
block(
  field("saved", await saveEvalRun(record)),
  ...(firstFailure ? [field("traces", `npm run serve, then http://localhost:3000/run.html?id=${firstFailure.runId}`)] : []),
);

if (c && baseline) block(...rules(c, baseline), "", ...metricDeltas(record.trialTotals, baseline.trialTotals));

const second = record.secondRound;
if (values.accept && second && second.errors === 0) {
  const accepted = baselineFrom(record, secondRoundScores(second));
  const file = await saveBaseline(accepted);
  const left = second.questions.filter((q) => q.passes < second.runsPerQuestion);
  block(
    `accepted as the baseline: ${file}${replacedFormat ? " (replacing a file in an earlier format)" : ""}`,
    `  passed ${accepted.passed.join(", ")} (mean ${fmt(s.meanPassed)}), pass tolerance ${accepted.passTolerance} (spread ${s.maxPassed - s.minPassed})`,
    `  cost ${accepted.costUsd.map(gateCents).join(", ")} (mean ${gateCents(s.meanCostUsd)}), cost margin ${gateCents(accepted.costMarginUsd)} (spread ${gateCents(Math.max(...accepted.costUsd) - Math.min(...accepted.costUsd))})`,
    `  second round: the ${second.questions.length} questions at ${s.trials} of ${s.trials}, up to ${second.runsPerQuestion} more runs each, stopped at the first failure: ${second.runs} runs, ${gateCents(second.costUsd)} (not in rule 3)`,
    ...left.map((q) => `    left the solid set: ${q.id} (passed ${q.passes} of ${second.runsPerQuestion} before failing)`),
    `  ${accepted.solid.length} questions in the solid set (${second.questions.length} at ${s.trials} of ${s.trials} in the trials); commit the file on its own`,
  );
} else if (values.accept && second) {
  block(`not accepted: ${second.errors} run(s) of the second round threw, so the solid set is undecided; re-run the accept`);
  verdict = { ...verdict, exit: EXIT.unmeasured, line: "INCOMPLETE: the second round had errors; nothing was accepted" };
} else if (values.accept) {
  block("not accepted: a run with errors cannot become the baseline; re-run it");
}

block("-".repeat(72), verdict.line);
console.log(out.join("\n"));
process.exitCode = verdict.exit;
