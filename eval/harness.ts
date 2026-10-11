// Runs the eval: every question (or a subset) through `runAgent`, the one entry point the
// server also calls, scored against the key, into one eval record. No printing here; the
// script in scripts/eval.ts does that, so the harness can run from CI or a test.
//
// Infrastructure failures are kept apart from the agent's failures. The graph is checked
// before any model token is spent, because the query tool returns a database outage to the
// model as text (by design, so it can repair its own queries), which would otherwise turn a
// stopped container into thirty wrong answers. A question whose run throws or exceeds its
// deadline is recorded as an error, never as a failed answer; transient API errors are
// already retried inside the model client, so the harness adds no retry of its own.
import { DEFAULT_EFFORT, DEFAULT_MODEL, type Effort, type ModelId } from "../src/agent/agent.js";
import { PROMPT_VERSION } from "../src/agent/prompt.js";
import { saveRun } from "../src/agent/record.js";
import { codeVersion, runAgent } from "../src/agent/run.js";
import { assertGraphSeeded } from "../src/graph/health.js";
import { loadQuestions, type Question } from "./questions.js";
import { totals, type EvalRun, type QuestionResult } from "./record.js";
import { diagnostics, loadAnswerKey, scoreAnswer } from "./score.js";

/** What one eval run varies; anything left out takes the shipped default. */
export interface EvalOptions {
  model?: ModelId;
  effort?: Effort;
  /** Question ids to run; every question when absent. */
  only?: string[];
  /** Called as each question finishes, in completion order, for progress output. */
  onQuestion?: (result: QuestionResult) => void;
}

const CONCURRENCY = 5;
/** The slowest observed run was under two minutes (Haiku, 109 s); past this a run is looping, not thinking. */
export const QUESTION_TIMEOUT_MS = 5 * 60_000;

/** Runs the questions and returns the eval run, before its baseline comparison. */
export async function runEval(options: EvalOptions = {}): Promise<EvalRun> {
  const model = options.model ?? DEFAULT_MODEL;
  const effort = options.effort ?? DEFAULT_EFFORT;
  const key = await loadAnswerKey();
  const all = await loadQuestions();
  const questions = options.only ? all.filter((q) => options.only!.includes(q.id)) : all;
  const unknown = (options.only ?? []).filter((id) => !all.some((q) => q.id === id));
  if (unknown.length > 0) throw new Error(`Unknown question id(s): ${unknown.join(", ")}`);
  await assertGraphSeeded();

  const startedAt = new Date();
  const results = new Map<string, QuestionResult>();
  const queue = [...questions];
  const worker = async () => {
    for (let q = queue.shift(); q; q = queue.shift()) {
      const result = await runOne(q, key[q.id] ?? [], model, effort);
      results.set(q.id, result);
      options.onQuestion?.(result);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, questions.length) }, worker));
  const finishedAt = new Date();

  const ordered = questions.map((q) => results.get(q.id)!);
  return {
    evalId: `${startedAt.toISOString().replace(/[:.]/g, "-")}-${model}-${effort}`,
    model,
    effort,
    promptVersion: PROMPT_VERSION,
    codeVersion: codeVersion(),
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    full: questions.length === all.length,
    questions: ordered,
    totals: totals(ordered),
  };
}

async function runOne(question: Question, expectedIds: string[], model: ModelId, effort: Effort): Promise<QuestionResult> {
  try {
    const record = await runAgent(
      { question: question.text, questionId: question.id },
      { model, effort, signal: AbortSignal.timeout(QUESTION_TIMEOUT_MS) },
    );
    await saveRun(record);
    const score = scoreAnswer(record, expectedIds, question.text);
    return {
      id: question.id,
      status: score.pass ? "pass" : "fail",
      runId: record.runId,
      score,
      diagnostics: diagnostics(record),
      error: null,
    };
  } catch (error) {
    return { id: question.id, status: "error", runId: null, score: null, diagnostics: null, error: describe(error) };
  }
}

// The error's class and message, so a timeout, an API status and a bug in our code read differently in the row.
function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  if (error.name === "TimeoutError") return `timed out after ${QUESTION_TIMEOUT_MS / 1000} s`;
  const status = (error as { status?: number }).status;
  return `${error.name}${status ? ` ${status}` : ""}: ${error.message.slice(0, 300)}`;
}
