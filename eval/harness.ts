// Runs the eval: every question (or a subset) through `runAgent`, the one entry point the
// server also calls, n times (the trials), scored against the key (and, for the questions
// eval/key-overlay.json amends, against the amended key as well), into one eval record. No
// printing here; the script in scripts/eval.ts does that, so the harness can run from CI or a test.
//
// The trials share one pool of workers, five per trial. Each run waits on the model, not on this
// process, so fifteen runs in flight take about as long as five: three evals of five workers side by
// side each took about 90 s, as one alone does. Ninety runs instead of thirty also triple the chance
// that an API error makes the run incomplete, which the model client's own retries keep rare.
//
// An accepting run adds a second round (`runSecondRound`): each question that passed every trial
// runs again alone, in sequence, stopped at its first failure, so the solid set is earned over six
// draws (eval/baseline.ts gives the reasoning). Different questions run side by side.
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
import { assertGraphReady } from "../src/graph/health.js";
import { SECOND_ROUND_RUNS, secondRoundEntrants } from "./baseline.js";
import { loadQuestions, type Question } from "./questions.js";
import { assemble, scoreRun, type EvalRun, type QuestionResult, type SecondRound } from "./record.js";
import { applyOverlay, loadAnswerKey, loadKeyOverlay } from "./score.js";

/** What one eval run varies; anything left out takes the shipped default. */
export interface EvalOptions {
  model?: ModelId;
  effort?: Effort;
  /** Question ids to run; every question when absent. */
  only?: string[];
  /** How many times each question runs; 1 when absent. */
  trials?: number;
  /** Called as each question run finishes, in completion order, for progress output; `trial` counts from 1. */
  onQuestion?: (result: QuestionResult, trial: number) => void;
}

const WORKERS_PER_TRIAL = 5;
/** The slowest observed run was under two minutes (Haiku, 109 s); past this a run is looping, not thinking. */
export const QUESTION_TIMEOUT_MS = 5 * 60_000;

/** Runs the questions and returns the eval run, before its baseline comparison. */
export async function runEval(options: EvalOptions = {}): Promise<EvalRun> {
  const model = options.model ?? DEFAULT_MODEL;
  const effort = options.effort ?? DEFAULT_EFFORT;
  const trials = options.trials ?? 1;
  if (!Number.isInteger(trials) || trials < 1) throw new Error(`The number of trials must be a whole number of at least 1, not ${trials}.`);
  const scorer = await loadScorer();
  const all = await loadQuestions();
  const questions = options.only ? all.filter((q) => options.only!.includes(q.id)) : all;
  const unknown = (options.only ?? []).filter((id) => !all.some((q) => q.id === id));
  if (unknown.length > 0) throw new Error(`Unknown question id(s): ${unknown.join(", ")}`);
  await assertGraphReady();

  const startedAt = new Date();
  const results: QuestionResult[][] = Array.from({ length: trials }, () => []);
  const queue = Array.from({ length: trials }, (_, t) => questions.map((q, i) => ({ t, i, q }))).flat();
  const worker = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const result = await scorer(job.q, model, effort);
      results[job.t]![job.i] = result;
      options.onQuestion?.(result, job.t + 1);
    }
  };
  await Promise.all(Array.from({ length: Math.min(WORKERS_PER_TRIAL * trials, queue.length) }, worker));
  const finishedAt = new Date();

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
    ...assemble(results),
  };
}

/** Runs one question through the agent and scores it; the key and overlay are loaded once, and checked against each other before any token is spent. */
async function loadScorer(): Promise<(question: Question, model: ModelId, effort: Effort) => Promise<QuestionResult>> {
  const key = await loadAnswerKey();
  const overlay = await loadKeyOverlay();
  // Only the questions the overlay names get an amended score.
  const amended = applyOverlay(key, overlay);
  return (q, model, effort) => runOne(q, key[q.id] ?? [], q.id in overlay ? amended[q.id] : undefined, model, effort);
}

/**
 * The second accept round on a full run: each question that passed every trial runs again, up to
 * `runsPerQuestion` times in sequence, stopped at its first run that does not pass (a failure, or
 * an error, which the round counts so the accept can refuse it). Questions below every trial never
 * run. `runQuestion` is the agent in production and a stub in the tests.
 */
export async function playSecondRound(
  run: EvalRun,
  runQuestion: (id: string) => Promise<QuestionResult>,
  { runsPerQuestion = SECOND_ROUND_RUNS, workers = WORKERS_PER_TRIAL * 3, onRun }: { runsPerQuestion?: number; workers?: number; onRun?: (result: QuestionResult, attempt: number) => void } = {},
): Promise<SecondRound> {
  const ids = secondRoundEntrants(run);
  const rounds = new Map<string, QuestionResult[]>();
  const queue = [...ids];
  const worker = async () => {
    for (let id = queue.shift(); id; id = queue.shift()) {
      const results: QuestionResult[] = [];
      while (results.length < runsPerQuestion && results.every((r) => r.status === "pass")) {
        const result = await runQuestion(id);
        results.push(result);
        onRun?.(result, results.length);
      }
      rounds.set(id, results);
    }
  };
  await Promise.all(Array.from({ length: Math.min(workers, ids.length) }, worker));
  const questions = ids.map((id) => {
    const results = rounds.get(id)!;
    return { id, passes: results.filter((r) => r.status === "pass").length, results };
  });
  const all = questions.flatMap((q) => q.results);
  return {
    runsPerQuestion,
    questions,
    runs: all.length,
    costUsd: all.reduce((acc, r) => acc + (r.diagnostics?.costUsd ?? 0), 0),
    errors: all.filter((r) => r.status === "error").length,
  };
}

/** Runs the second accept round through the agent, on the model and effort of the run it follows. */
export async function runSecondRound(run: EvalRun, options: { onRun?: (result: QuestionResult, attempt: number) => void } = {}): Promise<SecondRound> {
  const scorer = await loadScorer();
  const questions = new Map((await loadQuestions()).map((q) => [q.id, q]));
  await assertGraphReady();
  return playSecondRound(run, (id) => scorer(questions.get(id)!, run.model as ModelId, run.effort as Effort), options);
}

async function runOne(question: Question, expectedIds: string[], amendedIds: string[] | undefined, model: ModelId, effort: Effort): Promise<QuestionResult> {
  try {
    const record = await runAgent(
      { question: question.text, questionId: question.id },
      { model, effort, signal: AbortSignal.timeout(QUESTION_TIMEOUT_MS) },
    );
    await saveRun(record);
    return scoreRun(record, question, expectedIds, amendedIds);
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
