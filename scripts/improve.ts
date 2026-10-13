// npm run improve: reads the failing traces of an eval record against the key audit and proposes
// one change to the agent, for a person to decide on and the eval to measure.
//
//   npm run improve                                   (the latest record under runs/eval/)
//   npm run improve -- --question fulfillment-backing-up
//   npm run improve -- --eval <evalId> --traces 3
//
// It writes runs/improve/<id>.md (the proposal) and <id>.json (its record) and edits nothing
// else. Every check that can refuse the run happens before the first model call, and the
// estimated cost is printed before it. Each judgement is saved to <id>.json as it lands, so a
// failed call does not lose the ones paid for. The pipeline is in src/improve/; this file is the
// command line around it.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { loadQuestions } from "../eval/questions.js";
import { cents, EVAL_RUNS_DIR } from "../eval/record.js";
import { loadAnswerKey, loadKeyOverlay } from "../eval/score.js";
import { EFFORTS, MODEL_IDS, type Effort, type ModelId } from "../src/agent/agent.js";
import { RUNS_DIR, type RunRecord } from "../src/agent/record.js";
import { agentVersion } from "../src/agent/version.js";
import { answerHelp, argsError, field, reportFailure, usageError } from "../src/cli.js";
import { requireEnv } from "../src/env.js";
import {
  ESTIMATE_USD,
  IMPROVE_DIR,
  IMPROVER_EFFORT,
  IMPROVER_MODEL,
  JudgeFailure,
  improve,
  improveIdFor,
  isNoChange,
  judgedLine,
  loadExperiments,
  saveImprove,
  type JudgedTrace,
} from "../src/improve/improve.js";
import {
  agentInstructions,
  auditEntry,
  checkAgentVersion,
  judgeMessage,
  latestEvalId,
  loadEvalRecord,
  loadRunRecord,
  proposerMessage,
  recordSettings,
  selectTraces,
  traceSteps,
} from "../src/improve/inputs.js";
import { IMPROVER_PROMPT_VERSION, JUDGE_PROMPT, PROPOSER_PROMPT } from "../src/improve/prompt.js";

const COMMAND = "npm run improve";
const DEFAULT_TRACES = 1;

answerHelp(`
npm run improve: reads the failing traces of an eval record and proposes one change to the agent.
Each failing trace is read by a judge, one model call with the agent's own prompt and tools, the
question, the expected ids, the key audit's entry for it (eval/key-audit.md) and the trace, which
names the first error, the instruction involved and a yes or no on each of seven failure modes.
One more call reads every judgement with the experiment files (eval/experiments/) and proposes one
change (to the prompt, a convention, a tool's description, the model or the effort), or none when
the misses are the key's, noise, or too few to show a pattern, with the hypothesis, the check a
new trace must pass if it holds, and what the eval should show. It writes the proposal to
runs/improve/ and changes nothing else: a person decides, and the eval measures. The judge is not
validated against a person's labels, so it proposes and never gates. The estimated cost is printed
before the first call (about 11 cents a trace and 26 for the proposal at the default model).

A question is diagnosed when it failed at least one trial: the always-failing and the wobbly.

Options:
  --eval <evalId>      the eval record under runs/eval/ (default: the latest)
  --question <id>      diagnose only this question; repeat for several (default: every failing one)
  --traces <n>         failing traces judged per question, earliest trial first (default: ${DEFAULT_TRACES});
                       the others still reach the proposer as the ids they missed and added
  --model <id>         the improver's model: ${MODEL_IDS.join(", ")} (default: ${IMPROVER_MODEL})
  --effort <level>     the improver's effort: ${EFFORTS.join(", ")} (default: ${IMPROVER_EFFORT})
  --help               print this help

The traces must have run the agent this checkout holds (its fingerprint), since the judge reads the
prompt and tools from the code; otherwise run npm run eval on this checkout and improve that record.
An eval record from CI reads once its artifact's files are copied into runs/.

Example:
  npm run improve -- --question fulfillment-backing-up --traces 3
`);

const usage = (message: string): never => usageError(message, COMMAND);

const { values } = (() => {
  try {
    return parseArgs({
      options: {
        eval: { type: "string" },
        question: { type: "string", multiple: true },
        traces: { type: "string" },
        model: { type: "string" },
        effort: { type: "string" },
      },
    });
  } catch (error) {
    return usage(argsError(error));
  }
})();
const model = (values.model ?? IMPROVER_MODEL) as ModelId;
const effort = (values.effort ?? IMPROVER_EFFORT) as Effort;
const perQuestion = values.traces === undefined ? DEFAULT_TRACES : Number(values.traces);
if (!MODEL_IDS.includes(model)) usage(`Unknown model ${values.model}; one of ${MODEL_IDS.join(", ")}`);
if (!EFFORTS.includes(effort)) usage(`Unknown effort ${values.effort}; one of ${EFFORTS.join(", ")}`);
if (!Number.isInteger(perQuestion) || perQuestion < 1) usage("--traces is a whole number of traces per question, at least 1");

try {
  const evalId = values.eval ?? (await latestEvalId(EVAL_RUNS_DIR));
  if (!evalId) usage(`No eval record under ${EVAL_RUNS_DIR}/; run npm run eval first, or pass --eval <evalId>`);
  const record = await loadEvalRecord(EVAL_RUNS_DIR, evalId!);
  if (!record) usage(`No eval record ${evalId} under ${EVAL_RUNS_DIR}/`);
  const r = record!;

  const questions = await loadQuestions();
  const questionText = Object.fromEntries(questions.map((q) => [q.id, q.text]));
  const key = await loadAnswerKey();
  const selected = selectTraces(r, questionText, key, { only: values.question, perQuestion });
  if ("problem" in selected) usage(selected.problem);
  const { traces, failing } = selected as Exclude<typeof selected, { problem: string }>;
  if (traces.length === 0) {
    console.log(`Every question passed every trial of ${r.evalId}; nothing to diagnose.`);
    process.exit(0);
  }

  const runs = new Map<string, RunRecord>();
  for (const t of traces) {
    const run = await loadRunRecord(RUNS_DIR, t.runId);
    if (!run) usage(`Run record ${t.runId} is not under ${RUNS_DIR}/; an eval record from CI needs its artifact's files copied into ${RUNS_DIR}/`);
    runs.set(t.runId, run!);
  }
  const mismatch = checkAgentVersion([...runs.values()], r);
  if (mismatch) usage(mismatch);

  const audit = await readFile(path.join("eval", "key-audit.md"), "utf8");
  const overlay = await loadKeyOverlay();
  const entries = new Map(traces.map((t) => [t.questionId, auditEntry(audit, t.questionId)]));
  const noEntry = [...entries].filter(([, e]) => !e).map(([id]) => id);
  if (noEntry.length > 0) throw new Error(`eval/key-audit.md has no entry for ${noEntry.join(", ")}`);
  requireEnv("APP_ANTHROPIC_API_KEY");

  const settings = recordSettings(runs.values().next().value!);
  const instructions = agentInstructions(settings);
  const experiments = await loadExperiments();
  const version = agentVersion(settings);
  const estimate = traces.length * ESTIMATE_USD.perTrace + ESTIMATE_USD.proposal;

  console.log(
    [
      field("eval", `${r.evalId} (${r.model}, effort ${r.effort}, prompt ${r.promptVersion}, agent ${version}, code ${r.codeVersion})`),
      field("questions", `${new Set(failing.map((f) => f.questionId)).size} with a failing trial; failing trials ${failing.length}`),
      field("judging", `${traces.length} trace(s), at most ${perQuestion} per question`),
      field("improver", `${model}, effort ${effort}, prompt ${IMPROVER_PROMPT_VERSION}`),
      field("estimate", `about ${cents(estimate, 0)} (${traces.length} x ${cents(ESTIMATE_USD.perTrace, 0)} + ${cents(ESTIMATE_USD.proposal, 0)}, from the first full run at ${IMPROVER_MODEL} ${IMPROVER_EFFORT})`),
      "",
    ].join("\n"),
  );

  const now = new Date();
  const partialFile = path.join(IMPROVE_DIR, `${improveIdFor(r.evalId, now)}.json`);
  // Until the proposal lands, the record file holds the judgements paid for so far.
  const savePartial = async (judged: JudgedTrace[], failed: { runId: string; reason: string }[] = []) => {
    await mkdir(IMPROVE_DIR, { recursive: true });
    await writeFile(partialFile, JSON.stringify({ complete: false, createdAt: now.toISOString(), evalId: r.evalId, judged, failed }, null, 2));
  };
  let landed: JudgedTrace[] = [];

  const result = await improve(
    {
      record: r,
      agentVersion: version,
      traces: traces.map((trace) => {
        const amendment = overlay[trace.questionId];
        const run = runs.get(trace.runId)!;
        return {
          trace,
          audit: entries.get(trace.questionId)!,
          steps: traceSteps(run).length,
          judgeUser: judgeMessage({
            trace,
            run,
            evalId: r.evalId,
            audit: entries.get(trace.questionId)!,
            ...(amendment ? { amended: { ids: amendment.expected_resource_ids, reason: amendment.reason } } : {}),
          }),
        };
      }),
      failing,
      judgeSystem: `${JUDGE_PROMPT}\n\n${instructions}`,
      proposerSystem: `${PROPOSER_PROMPT}\n\n${instructions}`,
      proposerUser: (judged) => proposerMessage({ record: r, agentVersion: version, judged, failing, experiments }),
      settings: { model, effort },
      onJudged: async (judged) => {
        landed = judged;
        await savePartial(judged);
      },
    },
    undefined,
    now,
  ).catch(async (error: unknown) => {
    if (error instanceof JudgeFailure) {
      await savePartial(landed, error.failed);
      throw new Error(`${error.message}; the ${error.landed} judgements that landed are in ${partialFile}`);
    }
    throw error;
  });
  const file = await saveImprove(result);
  const p = result.proposal;

  console.log(
    [
      ...result.judged.map((j) => `judged    ${judgedLine(j)}`),
      "",
      field("proposal", isNoChange(p) ? p.change.target.replace(/_/g, " ") : `${p.change.target.replace(/_/g, " ")}: ${p.change.location}`),
      field("cost", cents(result.costUsd)),
      field("written", file),
      "",
      "Nothing was changed. Read the proposal and its diagnoses; a change taken from it is measured with npm run eval.",
    ].join("\n"),
  );
} catch (error) {
  reportFailure(error);
}
