// What the improver reads, gathered and laid out without a model call: the failing traces of an
// eval record, the key audit's entry for each question, the agent's own instructions as it read
// them, and the experiment files. Everything here is a pure function of files on disk, so the
// tests can check exactly what the judge and the proposer are shown.
//
// The agent's instructions come from this checkout, not from the record, which stores only their
// fingerprint. `checkAgentVersion` therefore refuses a record whose traces ran a different agent:
// a judge that reads one prompt against a trace produced by another would blame the wrong text.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import type { EvalRecord } from "../../eval/record.js";
import type { Effort, ModelId } from "../agent/agent.js";
import { MAX_TOKENS } from "../agent/agent.js";
import type { RunRecord } from "../agent/record.js";
import { agentSurface, agentVersion } from "../agent/version.js";

/** One failing trace chosen for the judge, with what the eval scored about it. */
export interface TraceToJudge {
  questionId: string;
  question: string;
  /** Passes of this question out of the record's trials. */
  passes: number;
  trials: number;
  /** Which trial this trace is, from 1. */
  trial: number;
  runId: string;
  expected: string[];
  missing: string[];
  extra: string[];
}

/** Every failing trial of a selected question, judged or not: what it missed and added. */
export interface FailingTrial {
  questionId: string;
  trial: number;
  runId: string;
  missing: string[];
  extra: string[];
}

/** The newest eval record's id under `dir`, by its timestamped name; undefined when there is none. */
export async function latestEvalId(dir: string): Promise<string | undefined> {
  const files = await readdir(dir).catch(() => [] as string[]);
  return files.filter((f) => f.endsWith(".json")).sort().at(-1)?.replace(/\.json$/, "");
}

/** Reads one eval record by id from `dir`; undefined when the file does not exist. */
export async function loadEvalRecord(dir: string, evalId: string): Promise<EvalRecord | undefined> {
  try {
    return JSON.parse(await readFile(path.join(dir, `${evalId}.json`), "utf8")) as EvalRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Reads one agent run record by id from `dir`; undefined when the file does not exist. */
export async function loadRunRecord(dir: string, runId: string): Promise<RunRecord | undefined> {
  try {
    return JSON.parse(await readFile(path.join(dir, `${runId}.json`), "utf8")) as RunRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * The questions to diagnose and the traces to judge. A question is diagnosed when it failed at
 * least one trial (the always-failing and the wobbly alike); `only` narrows the set. Up to
 * `perQuestion` failing traces are judged per question, the earliest trials first; every failing
 * trial's missing and extra ids go to the proposer whether judged or not. A run that threw has no
 * trace and is skipped. Returns a problem to print instead when a named question cannot be diagnosed.
 */
export function selectTraces(
  record: EvalRecord,
  questionText: Record<string, string>,
  key: Record<string, string[]>,
  options: { only?: string[]; perQuestion: number },
): { traces: TraceToJudge[]; failing: FailingTrial[] } | { problem: string } {
  const byId = new Map(record.questions.map((q) => [q.id, q]));
  for (const id of options.only ?? []) {
    const q = byId.get(id);
    if (!q) return { problem: `Question ${id} is not in eval record ${record.evalId}` };
    if (!q.results.some((r) => r.status === "fail")) return { problem: `Question ${id} failed no trial of eval record ${record.evalId}; nothing to diagnose` };
  }
  const chosen = record.questions.filter((q) => (options.only ? options.only.includes(q.id) : true));
  const traces: TraceToJudge[] = [];
  const failing: FailingTrial[] = [];
  for (const q of chosen) {
    const failed = q.results
      .map((r, i) => ({ r, trial: i + 1 }))
      .filter(({ r }) => r.status === "fail" && r.runId && r.score);
    for (const { r, trial } of failed) failing.push({ questionId: q.id, trial, runId: r.runId!, missing: r.score!.missing, extra: r.score!.extra });
    for (const { r, trial } of failed.slice(0, options.perQuestion)) {
      traces.push({
        questionId: q.id,
        question: questionText[q.id] ?? q.id,
        passes: q.passes,
        trials: q.results.length,
        trial,
        runId: r.runId!,
        expected: key[q.id] ?? [],
        missing: r.score!.missing,
        extra: r.score!.extra,
      });
    }
  }
  return { traces, failing };
}

/** The key audit's entry for one question: from its `### \`id\`` heading to the next heading; undefined when absent. */
export function auditEntry(auditMarkdown: string, questionId: string): string | undefined {
  const lines = auditMarkdown.split("\n");
  const start = lines.findIndex((line) => line.trim() === `### \`${questionId}\``);
  if (start === -1) return undefined;
  const end = lines.findIndex((line, i) => i > start && /^#{1,3} /.test(line));
  return lines
    .slice(start, end === -1 ? undefined : end)
    .join("\n")
    .trim();
}

/** The audit's verdict word for one entry (`agrees`, `disagrees`, `ambiguous`), or `unknown`. */
export function auditVerdict(entry: string): string {
  return /\*\*Verdict: ([a-z]+)/.exec(entry)?.[1] ?? "unknown";
}

/** The model settings the record's runs used, as the fingerprint reads them. */
export function recordSettings(run: Pick<RunRecord, "model" | "modelSettings">): { model: ModelId; effort: Effort; maxTokens: number } {
  return {
    model: run.model as ModelId,
    effort: run.modelSettings.effort as Effort,
    maxTokens: (run.modelSettings.maxTokens as number | undefined) ?? MAX_TOKENS,
  };
}

/** A problem to print when the traces ran a different agent from this checkout's; undefined when they match. */
export function checkAgentVersion(runs: RunRecord[], record: Pick<EvalRecord, "evalId" | "codeVersion">): string | undefined {
  const seen = [...new Set(runs.map((r) => r.agentVersion ?? "none"))];
  const here = runs[0] ? agentVersion(recordSettings(runs[0])) : undefined;
  if (seen.length === 1 && seen[0] === here) return undefined;
  return (
    `The traces in ${record.evalId} ran agent ${seen.join(", ")}, and this checkout's agent is ${here}: ` +
    `run npm run eval on this checkout (about 27 cents) and improve that record, so the judge reads what the agent read`
  );
}

/** The agent's instructions as the model read them: the system prompt, then each tool with its description and input schema. */
export function agentInstructions(settings: { model: ModelId; effort: Effort; maxTokens: number }): string {
  const surface = agentSurface(settings);
  const tools = surface.tools.map((t) => {
    const schema = z.toJSONSchema(t.schema) as { description?: string };
    // The answer tool's description lives in its schema's metadata (agent.ts), not in a field of its own.
    const description = t.description || schema.description || "";
    return `<tool name="${t.name}">\n${description}\n\nInput schema: ${JSON.stringify(schema)}\n</tool>`;
  });
  return [
    `<agent_model>${settings.model}, effort ${settings.effort}, at most ${settings.maxTokens} output tokens per model call</agent_model>`,
    `<agent_system_prompt>\n${surface.systemPrompt}\n</agent_system_prompt>`,
    `<agent_tools>\n${tools.join("\n")}\n</agent_tools>`,
  ].join("\n\n");
}

/** One serialised LangChain message as the run record stores it. */
interface StoredMessage {
  type: string;
  data: { content: unknown; tool_call_id?: string; name?: string };
}

interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

/** The trace as the judge reads it: its numbered steps, one blank line apart. */
export function renderTrace(run: Pick<RunRecord, "messages" | "toolCalls">): string {
  return traceSteps(run).join("\n\n");
}

/**
 * The trace's numbered steps: what the agent wrote, each tool call with its input and output, and
 * the final_answer call. Thinking is not recorded (its blocks are empty), so it is left out, as is
 * the library's closing echo of the structured answer. Their count bounds the step a judge may name.
 */
export function traceSteps(run: Pick<RunRecord, "messages" | "toolCalls">): string[] {
  const messages = run.messages as StoredMessage[];
  const outputs = new Map<string, string>();
  for (const m of messages) {
    if (m.type === "tool" && m.data.tool_call_id) outputs.set(m.data.tool_call_id, contentText(m.data.content));
  }
  const steps: string[] = [];
  const step = (body: string) => steps.push(`[${steps.length + 1}] ${body}`);
  for (const m of messages) {
    if (m.type !== "ai") continue;
    const blocks: ContentBlock[] = typeof m.data.content === "string" ? [{ type: "text", text: m.data.content }] : (m.data.content as ContentBlock[]);
    for (const b of blocks) {
      if (b.type === "text" && b.text?.trim() && !b.text.startsWith("Returning structured response:")) step(`agent wrote:\n${b.text.trim()}`);
      if (b.type === "tool_use") {
        const input = typeof b.input === "object" && b.input && "query" in b.input && Object.keys(b.input).length === 1 ? String((b.input as { query: unknown }).query) : JSON.stringify(b.input);
        if (b.name === "final_answer") step("final_answer called; its prose and ids are under <final_answer> below.");
        else step(`${b.name} called with:\n${input}\noutput:\n${outputs.get(b.id ?? "") ?? "(no output recorded)"}`);
      }
    }
  }
  // A record written before messages were stored still has its tool calls.
  if (steps.length === 0) for (const c of run.toolCalls) step(`${c.name} called with:\n${JSON.stringify(c.input)}\noutput:\n${c.output}`);
  return steps;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b) => (typeof b === "string" ? b : ((b as ContentBlock).text ?? JSON.stringify(b)))).join("\n");
  return JSON.stringify(content);
}

const list = (ids: string[]) => (ids.length === 0 ? "none" : ids.join(", "));

/** The judge's user message for one trace: the question, what was expected and scored, the audit entry, the trace and the answer. */
export function judgeMessage(input: {
  trace: TraceToJudge;
  run: RunRecord;
  evalId: string;
  audit: string;
  amended?: { ids: string[]; reason: string };
}): string {
  const { trace, run } = input;
  return [
    `<question id="${trace.questionId}">${trace.question}</question>`,
    `<eval_score>\nThis question passed ${trace.passes} of ${trace.trials} trials in eval run ${input.evalId}; this is trial ${trace.trial}, which failed.\nExpected ids (the answer key): ${list(trace.expected)}\nMissing from the answer: ${list(trace.missing)}\nAdded by the answer: ${list(trace.extra)}\n</eval_score>`,
    `<audit_entry>\n${input.audit}\n</audit_entry>`,
    ...(input.amended
      ? [`<key_amendment>\nThe audit's amended set, which the eval reports beside the key and never gates on: ${list(input.amended.ids)}\nReason: ${input.amended.reason}\n</key_amendment>`]
      : []),
    `<trace run_id="${run.runId}">\n${renderTrace(run)}\n</trace>`,
    `<final_answer>\nProse:\n${run.answer || "(empty: the run ended without a final_answer call)"}\n\nids: ${list(run.ids)}\n</final_answer>`,
  ].join("\n\n");
}

/** One judgement as the proposer reads it: which trace, the audit's verdict, and the judge's output. */
export interface JudgedForProposer {
  trace: TraceToJudge;
  auditVerdict: string;
  audit: string;
  judgement: unknown;
}

/** The proposer's user message: the eval run, every judgement, every failing trial, and the experiment files. */
export function proposerMessage(input: {
  record: EvalRecord;
  agentVersion: string;
  judged: JudgedForProposer[];
  failing: FailingTrial[];
  experiments: { name: string; text: string }[];
}): string {
  const { record } = input;
  const passes = record.questions.map((q) => `${q.id}: ${q.passes} of ${q.results.length}`).join("\n");
  const judged = input.judged.map(
    (j) =>
      `<diagnosis question_id="${j.trace.questionId}" trial="${j.trace.trial}" run_id="${j.trace.runId}" audit_verdict="${j.auditVerdict}">\n` +
      `Question: ${j.trace.question}\nPassed ${j.trace.passes} of ${j.trace.trials}. Missing: ${list(j.trace.missing)}. Added: ${list(j.trace.extra)}.\n\n` +
      `<audit_entry>\n${j.audit}\n</audit_entry>\n\n<judgement>\n${JSON.stringify(j.judgement, null, 2)}\n</judgement>\n</diagnosis>`,
  );
  const failing = input.failing.map((f) => `${f.questionId}, trial ${f.trial} (${f.runId}): missing ${list(f.missing)}; added ${list(f.extra)}`).join("\n");
  const experiments = input.experiments.map((e) => `<experiment_file name="${e.name}">\n${e.text}\n</experiment_file>`).join("\n\n");
  return [
    `<eval_run id="${record.evalId}" model="${record.model}" effort="${record.effort}" prompt_version="${record.promptVersion}" agent_version="${input.agentVersion}" code_version="${record.codeVersion}">\nPassed per trial: ${record.trialTotals.map((t) => t.passed).join(", ")} of ${record.questions.length}.\nPasses per question:\n${passes}\n</eval_run>`,
    `<diagnoses>\n${judged.join("\n\n")}\n</diagnoses>`,
    `<failing_trials>\n${failing}\n</failing_trials>`,
    `<experiments>\n${experiments}\n</experiments>`,
  ].join("\n\n");
}
