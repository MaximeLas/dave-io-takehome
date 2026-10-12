// How often the gate turns red on unchanged code, simulated from the committed baseline.
//
//   npm run simulate-gate                          (the shipped model and effort, 100,000 pairs, seed 1)
//   npm run simulate-gate -- --seed 7 --pairs 20000
//   npm run simulate-gate -- --runs runs/eval      (pass rates pooled from local eval records instead)
//
// No model call, no database: the numbers come from eval/baselines/ (or local records) and a
// seeded generator, so anyone who runs the command gets the same figures. The simulation itself
// and its one weak assumption are in eval/simulate.ts.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { baselinePath, loadBaseline } from "../eval/baseline.js";
import { cents } from "../eval/record.js";
import { modelFromBaseline, poolRecords, simulateGate, type AgentModel } from "../eval/simulate.js";
import { DEFAULT_EFFORT, DEFAULT_MODEL, EFFORTS, MODEL_IDS, type Effort, type ModelId } from "../src/agent/agent.js";
import { answerHelp, argsError, field, reportFailure, usageError } from "../src/cli.js";

const DEFAULT_PAIRS = 100_000;
const DEFAULT_SEED = 1;

answerHelp(`
npm run simulate-gate: estimates how often the eval gate turns red on code that did not change.
It draws many pairs of runs of one unchanged agent (an accept run of three trials, then a later
run of three trials), each question passing each trial at its rate in the committed baseline and
each trial's cost drawn around the baseline's, and judges every later run with the gate's own
code. It prints how often each rule is red, how often any is, and how often a red run is red again
on one re-run. No model call, no database; the same seed prints the same figures.

Options:
  --model <id>       ${MODEL_IDS.join(", ")} (default: ${DEFAULT_MODEL}, what ships)
  --effort <level>   ${EFFORTS.join(", ")} (default: ${DEFAULT_EFFORT}, what ships)
  --pairs <n>        simulated accept-then-later pairs (default: ${DEFAULT_PAIRS.toLocaleString("en-US")})
  --seed <n>         the generator's seed, a whole number (default: ${DEFAULT_SEED})
  --runs <dir>       pool each question's pass rate from the local eval records in <dir> of the
                     baseline's model, effort and prompt, for rates finer than three draws
                     (default: the baseline's passes out of three)
  --help             print this help

Example:
  npm run simulate-gate -- --seed 2      the same estimate from other draws
`);

const usage = (message: string): never => usageError(message, "npm run simulate-gate");

const { values } = (() => {
  try {
    return parseArgs({ options: { model: { type: "string" }, effort: { type: "string" }, pairs: { type: "string" }, seed: { type: "string" }, runs: { type: "string" } } });
  } catch (error) {
    return usage(argsError(error));
  }
})();
const model = (values.model ?? DEFAULT_MODEL) as ModelId;
const effort = (values.effort ?? DEFAULT_EFFORT) as Effort;
const pairs = values.pairs === undefined ? DEFAULT_PAIRS : Number(values.pairs);
const seed = values.seed === undefined ? DEFAULT_SEED : Number(values.seed);
if (!MODEL_IDS.includes(model)) usage(`Unknown model ${values.model}; one of ${MODEL_IDS.join(", ")}.`);
if (!EFFORTS.includes(effort)) usage(`Unknown effort ${values.effort}; one of ${EFFORTS.join(", ")}.`);
if (!Number.isInteger(pairs) || pairs < 1) usage("--pairs is a whole number of simulated pairs, at least 1.");
if (!Number.isInteger(seed)) usage("--seed is a whole number.");

const pct = (share: number) => `${(share * 100).toFixed(1)}%`;
// The Monte Carlo error of a share: one standard error of a binomial proportion.
const se = (share: number) => `±${(Math.sqrt((share * (1 - share)) / pairs) * 100).toFixed(1)}`;
const oneIn = (share: number) => (share > 0 ? `, about one run in ${Math.round(1 / share)}` : "");

try {
  const baseline = await loadBaseline(model, effort);
  if (!baseline) usage(`No baseline for ${model} at effort ${effort} in eval/baselines/; nothing to simulate from.`);
  const b = baseline!;
  const agent: AgentModel = modelFromBaseline(b);
  let ratesLine = `each question's passes out of ${b.trials} in the baseline`;

  if (values.runs) {
    const files = (await readdir(values.runs).catch(() => usage(`--runs ${values.runs} is not a readable folder.`))).filter((f) => f.endsWith(".json"));
    const records = await Promise.all(files.map(async (f) => JSON.parse(await readFile(path.join(values.runs!, f), "utf8"))));
    const pooled = poolRecords(records, { model, effort, promptVersion: b.promptVersion });
    const missing = Object.keys(b.questions).filter((id) => !pooled.trials[id]);
    if (missing.length > 0) usage(`No record in ${values.runs} of prompt ${b.promptVersion} answers ${missing.join(", ")}; drop --runs to simulate from the baseline.`);
    for (const id of Object.keys(b.questions)) agent.passRates[id] = pooled.passes[id]! / pooled.trials[id]!;
    const fewest = Math.min(...Object.keys(b.questions).map((id) => pooled.trials[id]!));
    ratesLine = `pooled from ${pooled.used.length} record(s) in ${values.runs} of prompt ${b.promptVersion}, at least ${fewest} answered trials per question (code ${[...new Set(pooled.used.map((u) => u.codeVersion))].join(", ")})`;
  }

  const rates = Object.values(agent.passRates);
  const histogram = [...new Set(rates.map((r) => r.toFixed(2)))]
    .sort((x, y) => Number(y) - Number(x))
    .map((r) => `${rates.filter((x) => x.toFixed(2) === r).length} at ${Math.round(Number(r) * 100)}%`)
    .join(", ");

  const r = simulateGate(agent, { pairs, seed, trials: b.trials });
  const byQuestion = Object.entries(r.rule2ByQuestion).sort((x, y) => y[1] - x[1]);

  const out = [
    "",
    field("baseline", `${baselinePath(model, effort)} (${b.trials} trials on ${b.codeVersion}, prompt ${b.promptVersion})`),
    field("pass rates", ratesLine),
    field("", histogram),
    field("cost", `each trial's cost a normal draw with the baseline's mean ${cents(agent.costMeanUsd, 2)} and deviation ${cents(agent.costSdUsd, 2)}`),
    field("simulated", `${pairs.toLocaleString("en-US")} pairs (accept run, later run, ${b.trials} trials each, identical code), seed ${seed}`),
    "",
    "red on identical code, share of later runs (± one Monte Carlo standard error, in points)",
    `  rule 1    ${pct(r.rule1).padStart(6)} ${se(r.rule1)}  average below the floor`,
    `  rule 2    ${pct(r.rule2).padStart(6)} ${se(r.rule2)}  a solid question passed fewer than ${b.trials - 1} of ${b.trials}`,
    ...byQuestion.map(([id, share]) => `              ${pct(share).padStart(6)}  ${id}`),
    `  rule 3    ${pct(r.rule3).padStart(6)} ${se(r.rule3)}  cost above the ceiling`,
    `  any rule  ${pct(r.anyRule).padStart(6)} ${se(r.anyRule)}  red${oneIn(r.anyRule)}`,
    `  red twice ${pct(r.redTwice).padStart(6)} ${se(r.redTwice)}  red, then red again on one re-run against the same baseline${oneIn(r.redTwice)}`,
    "",
    "assumption: each question passes each trial independently at a fixed rate, and each trial's cost is",
    `independent of the passes. ${
      values.runs
        ? "The rates are pooled over every record of the prompt; records of one prompt can still differ in the tools the model reads, so check the code versions above."
        : `From the baseline, a rate is ${b.trials} draws: a question at ${b.trials} of ${b.trials} is modelled as never failing and one at ${b.trials - 1} of ${b.trials} at ${Math.round(((b.trials - 1) / b.trials) * 100)}%, whatever its true rate, so a solid question that in truth fails now and then is not counted and the rule 2 figure is a floor; --runs <dir> pools local eval records for finer rates.`
    } The cost deviation comes from the baseline's ${b.costUsd.length} costs, so the rule 3 figure moves with it.`,
  ];
  console.log(out.join("\n"));
} catch (error) {
  reportFailure(error);
}
