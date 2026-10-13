// The improver: reads the failing traces of one eval record against the key audit, judges each
// with one model call, and proposes one change, or none, with a second call over all the
// judgements and the experiment files. It writes a proposal file and its JSON record under
// runs/improve/ and edits nothing else: a person reads the proposal and decides, and the eval
// measures the change. A proposal carries its check, written before any run: what the new traces
// must show if the hypothesis is right, since at three trials the pass count mostly moves within
// the noise.
//
// Two calls rather than one: a trace is long (tens of tool outputs), so each judge reads one
// trace with full attention, and the proposer reads the short judgements side by side, which is
// where a pattern across questions shows. The model call is a parameter so the tests can run the
// whole pipeline with a fake one.
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { ChatAnthropic } from "@langchain/anthropic";
import { HumanMessage, SystemMessage, type AIMessage } from "@langchain/core/messages";
import { z } from "zod";

import { cents, type EvalRecord } from "../../eval/record.js";
import type { Effort, ModelId } from "../agent/agent.js";
import { costUsd, type TokenUsage } from "../agent/record.js";
import { codeVersion } from "../agent/run.js";
import { requireEnv } from "../env.js";
import { auditVerdict, type FailingTrial, type JudgedForProposer, type TraceToJudge } from "./inputs.js";
import { FAILURE_MODES, IMPROVER_PROMPT_VERSION, type FailureMode } from "./prompt.js";

/** The improver's model: the strongest tier, since it reads long traces and proposes a design change. */
export const IMPROVER_MODEL: ModelId = "claude-opus-5-5";
/** The improver's effort. */
export const IMPROVER_EFFORT: Effort = "high";
/** Output tokens per call; under the SDK's limit for a call that is not streamed. */
export const IMPROVER_MAX_TOKENS = 16_000;
/** Judge calls in flight at once: enough to finish a typical record in a few rounds, few enough that a rate limit does not fail them together. */
export const JUDGE_CONCURRENCY = 3;

/**
 * The cost printed before any spend, at the default model and effort, from the first full run
 * (13 Oct, Claude Opus 5.5 at effort high, six traces): judge calls cost 6 to 15 cents, 10.5 on
 * average, and the proposer 26 cents. An estimate to decide on, not a cap.
 */
export const ESTIMATE_USD = { perTrace: 0.11, proposal: 0.26 } as const;

/** Where the proposals and their records are written. */
export const IMPROVE_DIR = path.join("runs", "improve");

const verdict = z.object({
  verdict: z.boolean().describe("True when this failure mode is present in the trace."),
  evidence: z.string().describe("When true, one sentence citing a step number or a quote from the trace; when false, an empty string."),
});

/** What the judge returns for one trace. */
export const JUDGEMENT_SCHEMA = z.object({
  firstError: z.object({
    step: z.number().int().describe("The number of the trace step where the run first went wrong; the final_answer step when the error is in the answer alone."),
    what: z.string().describe("What happened at that step, in one or two sentences."),
  }),
  instruction: z.object({
    source: z.enum(["system_prompt", "conventions", "run_cypher", "search_descriptions", "final_answer", "none"]).describe("Where the instruction that governs that step is, or none."),
    quote: z.string().describe("The instruction's words, quoted exactly; an empty string when none governs the step."),
    status: z.enum(["not_followed", "followed_and_led_here", "none_covers_it"]),
  }),
  failureModes: z.object(
    Object.fromEntries(Object.keys(FAILURE_MODES).map((mode) => [mode, verdict])) as Record<FailureMode, typeof verdict>,
  ),
  diagnosis: z.string().describe("At most 120 words: what went wrong, at which step, and what kind of change would have prevented it."),
});

/** One judgement of one failing trace. */
export type Judgement = z.infer<typeof JUDGEMENT_SCHEMA>;

/** The proposal's outcomes that change nothing, each naming why. */
export const NO_CHANGE = ["no_change_key_or_question_at_fault", "no_change_noise", "no_change_too_few_traces"] as const;

/** What the proposer returns: one change in the experiment files' shape, or none with its reason. */
export const PROPOSAL_SCHEMA = z.object({
  pattern: z.string().describe("The failure pattern across the diagnosed questions, naming each question it covers and what went wrong in it; or, when no change is proposed, why the diagnoses show none worth making."),
  outOfScope: z.string().describe("The diagnosed questions the change does not target, and why: the key at fault, an ambiguous question, or a fix that would only fit one question."),
  change: z.object({
    target: z
      .enum(["system_prompt", "convention", "tool_description", "model", "effort", ...NO_CHANGE])
      .describe("What the change edits; or one of the no_change outcomes, naming why nothing should change: the misses are the key's or the question's, what is left is noise, or the traces are too few to show a pattern."),
    location: z.string().describe("The file and the place in it (the line or bullet the change replaces or follows); for the model or the effort, the setting; an empty string when no change is proposed."),
    before: z.string().describe("The exact current text or setting; an empty string for a new line or when no change is proposed."),
    after: z.string().describe("The exact proposed text or setting; an empty string when no change is proposed."),
  }),
  hypothesis: z.string().describe("Why the change should fix the pattern, and why it holds as a statement about the domain rather than about these questions; when no change is proposed, what evidence would justify one."),
  check: z.string().describe("Written before the run: the one thing a trace must show in every trial if the hypothesis is right (an id that leaves or enters ids, a query the agent now runs). An empty string when no change is proposed."),
  measure: z.string().describe("What the eval should show over three trials if the hypothesis holds: which questions move from how many passes to how many, the total and the cost per trial, and what result would show it wrong."),
  mightRegress: z.string().describe("Which questions could get worse, and why."),
  alreadyTried: z.string().describe("The experiment files that tried something related, by name, and why this change would do differently; or that none did."),
  notChanged: z.string().describe("What you would not change, and why."),
});

/** One proposed change. */
export type Proposal = z.infer<typeof PROPOSAL_SCHEMA>;

/** One structured model call: a system prompt and a user message in, the parsed output and its cost out. */
export type ModelCall = <T>(
  schema: z.ZodType<T>,
  system: string,
  user: string,
  settings: { model: ModelId; effort: Effort },
) => Promise<{ output: T; costUsd: number }>;

/** The real model call: Anthropic's JSON-schema output (no forced tool call, which the current models refuse; docs/facts.md F1). */
export const callModel: ModelCall = async (schema, system, user, settings) => {
  const model = new ChatAnthropic({
    model: settings.model,
    apiKey: requireEnv("APP_ANTHROPIC_API_KEY"),
    maxTokens: IMPROVER_MAX_TOKENS,
    outputConfig: { effort: settings.effort },
  });
  const structured = model.withStructuredOutput(schema as z.ZodType<Record<string, unknown>>, { method: "jsonSchema", includeRaw: true });
  const { raw, parsed } = await structured.invoke([new SystemMessage(system), new HumanMessage(user)]);
  const u = (raw as AIMessage).usage_metadata;
  const usage: TokenUsage = {
    inputTokens: u?.input_tokens ?? 0,
    outputTokens: u?.output_tokens ?? 0,
    cacheReadTokens: u?.input_token_details?.cache_read ?? 0,
    cacheCreationTokens: u?.input_token_details?.cache_creation ?? 0,
  };
  return { output: schema.parse(parsed), costUsd: costUsd(settings.model, usage) };
};

/** One judged trace in the improve record. */
export interface JudgedTrace extends TraceToJudge {
  auditVerdict: string;
  judgement: Judgement;
  costUsd: number;
}

/** Everything about one improver run: what it read, what it judged, what it proposed, what it cost. */
export interface ImproveRecord {
  improveId: string;
  createdAt: string;
  /** The improver itself, so a change to its prompt or model is attributable. */
  improver: { model: ModelId; effort: Effort; promptVersion: string; codeVersion: string };
  /** The eval record whose failing traces were read, and the agent that produced them. */
  eval: { evalId: string; model: string; effort: string; promptVersion: string; agentVersion: string; codeVersion: string; passed: number[]; questions: number };
  judged: JudgedTrace[];
  failing: FailingTrial[];
  proposal: Proposal;
  proposalCostUsd: number;
  costUsd: number;
}

/** What the run needs once the inputs are gathered: the judge's and the proposer's messages are built by the caller's functions. */
export interface ImproveInputs {
  record: EvalRecord;
  agentVersion: string;
  /** Each trace to judge, with its audit entry, the judge's message, and how many steps the judge was shown. */
  traces: { trace: TraceToJudge; audit: string; judgeUser: string; steps: number }[];
  failing: FailingTrial[];
  judgeSystem: string;
  proposerSystem: string;
  proposerUser: (judged: JudgedForProposer[]) => string;
  settings: { model: ModelId; effort: Effort };
  /** Called with every judgement landed so far, after each one lands, so a later failure does not lose what was paid for. */
  onJudged?: (landed: JudgedTrace[]) => Promise<void>;
}

/** The id of an improver run: when it started, then the eval record it read. */
export const improveIdFor = (evalId: string, now: Date): string => `${now.toISOString().replace(/[:.]/g, "-")}-${evalId}`;

/** Thrown when a judge call failed or returned a step outside the trace; the judgements that landed were already handed to onJudged. */
export class JudgeFailure extends Error {
  constructor(
    readonly failed: { runId: string; reason: string }[],
    readonly landed: number,
  ) {
    super(`${failed.length} of ${failed.length + landed} judge calls failed, no proposal made (${failed[0]!.runId}: ${failed[0]!.reason})`);
  }
}

/**
 * Judges every trace, at most JUDGE_CONCURRENCY at once, then proposes one change (or none);
 * returns the improve record. A judgement naming a step outside the trace counts as a failed
 * call. When any judge call fails, no proposal is made, since a pattern read from part of the
 * traces would be read from the ones that happened to land. Writes nothing itself.
 */
export async function improve(inputs: ImproveInputs, call: ModelCall = callModel, now = new Date()): Promise<ImproveRecord> {
  type Landed = JudgedTrace & { audit: string };
  const landed: Landed[] = [];
  const failed: { runId: string; reason: string }[] = [];
  let saving = Promise.resolve();
  const queue = [...inputs.traces];
  const worker = async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      const { trace, audit, judgeUser, steps } = item;
      try {
        const { output, costUsd } = await call(JUDGEMENT_SCHEMA, inputs.judgeSystem, judgeUser, inputs.settings);
        const step = output.firstError.step;
        if (step < 1 || step > steps) throw new Error(`the judge named step ${step}, outside the trace's steps 1 to ${steps}`);
        landed.push({ ...trace, auditVerdict: auditVerdict(audit), judgement: output, costUsd, audit });
        const snapshot = landed.map(({ audit: _audit, ...rest }) => rest);
        if (inputs.onJudged) saving = saving.then(() => inputs.onJudged!(snapshot));
      } catch (error) {
        failed.push({ runId: trace.runId, reason: error instanceof Error ? error.message.split("\n")[0]! : String(error) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(JUDGE_CONCURRENCY, queue.length) }, worker));
  await saving;
  if (failed.length > 0) throw new JudgeFailure(failed, landed.length);
  // The traces' order, not the order the calls landed in.
  const order = new Map(inputs.traces.map(({ trace }, i) => [trace.runId, i]));
  const judged = landed.sort((a, b) => order.get(a.runId)! - order.get(b.runId)!);

  const proposed = await call(
    PROPOSAL_SCHEMA,
    inputs.proposerSystem,
    inputs.proposerUser(judged.map((j) => ({ trace: j, auditVerdict: j.auditVerdict, audit: j.audit, judgement: j.judgement }))),
    inputs.settings,
  );
  const { record } = inputs;
  const judgeCost = judged.reduce((sum, j) => sum + j.costUsd, 0);
  return {
    improveId: improveIdFor(record.evalId, now),
    createdAt: now.toISOString(),
    improver: { ...inputs.settings, promptVersion: IMPROVER_PROMPT_VERSION, codeVersion: codeVersion() },
    eval: {
      evalId: record.evalId,
      model: record.model,
      effort: record.effort,
      promptVersion: record.promptVersion,
      agentVersion: inputs.agentVersion,
      codeVersion: record.codeVersion,
      passed: record.trialTotals.map((t) => t.passed),
      questions: record.questions.length,
    },
    judged: judged.map(({ audit: _audit, ...rest }) => rest),
    failing: inputs.failing,
    proposal: proposed.output,
    proposalCostUsd: proposed.costUsd,
    costUsd: judgeCost + proposed.costUsd,
  };
}

/** The experiment files, README first, as the proposer reads them. */
export async function loadExperiments(dir = path.join("eval", "experiments")): Promise<{ name: string; text: string }[]> {
  const names = (await readdir(dir)).filter((f) => f.endsWith(".md")).sort((a, b) => (a === "README.md" ? -1 : b === "README.md" ? 1 : a.localeCompare(b)));
  return Promise.all(names.map(async (name) => ({ name, text: await readFile(path.join(dir, name), "utf8") })));
}

/** True when the proposal is to change nothing. */
export const isNoChange = (p: Proposal): boolean => (NO_CHANGE as readonly string[]).includes(p.change.target);
/** Why nothing should change, in words. */
const noChangeReason = (p: Proposal): string =>
  ({ no_change_key_or_question_at_fault: "the misses are the key's or the question's", no_change_noise: "what is left is noise", no_change_too_few_traces: "too few traces to show a pattern" })[
    p.change.target as (typeof NO_CHANGE)[number]
  ];

const usd = (n: number) => `$${n.toFixed(2)}`;
const ids = (list: string[]) => (list.length === 0 ? "none" : list.map((id) => `\`${id}\``).join(", "));
const fenced = (text: string) => "```text\n" + (text || "(empty)") + "\n```";
// A field the model wrote as a list goes under its label; prose stays on the label's line.
const labelled = (label: string, text: string) => (/^\s*- /.test(text) ? `**${label}**\n\n${text.trim()}` : `**${label}** ${text}`);

/** The proposal file: a header that frames it, the proposal in the experiment files' shape, then every diagnosis behind it. */
export function renderProposal(r: ImproveRecord): string {
  const p = r.proposal;
  const lines = [
    `# Improvement proposal (${r.createdAt.slice(0, 10)})`,
    "",
    "Written by the improver (`npm run improve`); nothing in it has been applied or measured. The judge behind it has not been validated against a person's labels, so read each diagnosis against its trace before acting on the proposal. A change taken from it is made by a person and measured by the eval like any other, with its own experiment file; and the more of this loop is automated, the more a held-out question set is needed to tell a gain from a fit to the thirty questions.",
    "",
    `- **Eval record:** \`runs/eval/${r.eval.evalId}.json\`: ${r.eval.model} at effort ${r.eval.effort}, prompt \`${r.eval.promptVersion}\`, agent \`${r.eval.agentVersion}\`, code \`${r.eval.codeVersion}\`; passed ${r.eval.passed.join(", ")} of ${r.eval.questions}.`,
    `- **Traces judged:** ${r.judged.length}; failing trials ${r.failing.length}, across questions ${new Set(r.failing.map((f) => f.questionId)).size}.`,
    `- **Improver:** ${r.improver.model} at effort ${r.improver.effort}, prompt \`${r.improver.promptVersion}\`, code \`${r.improver.codeVersion}\`.`,
    `- **Cost:** ${usd(r.costUsd)} (judging ${usd(r.costUsd - r.proposalCostUsd)}, proposing ${usd(r.proposalCostUsd)}).`,
    "",
    "## Proposal",
    "",
    labelled("Pattern.", p.pattern),
    "",
    labelled("Left out.", p.outOfScope),
    "",
    ...(isNoChange(p)
      ? [`**No change** (${noChangeReason(p)}).`, "", labelled("What would justify one.", p.hypothesis)]
      : [
          `**Change** (${p.change.target.replace(/_/g, " ")}): ${p.change.location}`,
          "",
          "Before:",
          "",
          fenced(p.change.before),
          "",
          "After:",
          "",
          fenced(p.change.after),
          "",
          labelled("Hypothesis.", p.hypothesis),
          "",
          labelled("Check, written before the run.", p.check),
        ]),
    "",
    labelled("What the eval should show.", p.measure),
    "",
    labelled("What might regress.", p.mightRegress),
    "",
    labelled("Already tried.", p.alreadyTried),
    "",
    labelled("Not changed.", p.notChanged),
    "",
    "## Diagnoses",
  ];
  for (const j of r.judged) {
    const g = j.judgement;
    lines.push(
      "",
      `### \`${j.questionId}\`: passed ${j.passes} of ${j.trials}`,
      "",
      `> ${j.question}`,
      "",
      `Trial ${j.trial}, run \`${j.runId}\` (\`runs/${j.runId}.json\`). Audit verdict: ${j.auditVerdict}. Missing: ${ids(j.missing)}. Added: ${ids(j.extra)}. Judged for ${usd(j.costUsd)}.`,
      "",
      `**First error, step ${g.firstError.step}.** ${g.firstError.what}`,
      "",
      `**Instruction** (${g.instruction.source.replace(/_/g, " ")}, ${g.instruction.status.replace(/_/g, " ")}).${g.instruction.quote ? ` "${g.instruction.quote}"` : ""}`,
      "",
      "| Failure mode | Present | Evidence |",
      "| --- | --- | --- |",
      ...(Object.keys(FAILURE_MODES) as FailureMode[]).map((m) => `| ${m} | ${g.failureModes[m].verdict ? "yes" : "no"} | ${g.failureModes[m].evidence.replace(/\|/g, "\\|").replace(/\n/g, " ")} |`),
      "",
      `**Diagnosis.** ${g.diagnosis}`,
    );
  }
  const notJudged = r.failing.filter((f) => !r.judged.some((j) => j.runId === f.runId));
  if (notJudged.length > 0) {
    lines.push("", "## Failing trials not judged", "", "Given to the proposer as the ids each missed and added:", "");
    for (const f of notJudged) lines.push(`- \`${f.questionId}\`, trial ${f.trial} (\`${f.runId}\`): missing ${ids(f.missing)}; added ${ids(f.extra)}.`);
  }
  return lines.join("\n") + "\n";
}

/** Writes the proposal (Markdown) and its record (JSON) under runs/improve/; returns the proposal's path. */
export async function saveImprove(r: ImproveRecord, dir = IMPROVE_DIR): Promise<string> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${r.improveId}.json`), JSON.stringify(r, null, 2));
  const file = path.join(dir, `${r.improveId}.md`);
  await writeFile(file, renderProposal(r));
  return file;
}

/** The cost line the command prints for one judged trace. */
export const judgedLine = (j: JudgedTrace): string => `${j.questionId}, trial ${j.trial}: first error at step ${j.judgement.firstError.step}, ${cents(j.costUsd)}`;
