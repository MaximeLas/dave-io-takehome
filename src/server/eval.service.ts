// What the eval page reads and runs. Every number it shows comes from the eval's own code: the
// records `npm run eval` saves under runs/eval/, the verdict each record stored when it was judged
// (or gate() against today's committed baseline when it stores none, labelled so), the metric
// lines from metricDeltas(), one question scored by the harness's own scorer, and a full run
// through runEval(), judged and saved as the command judges and saves it. The page never accepts
// a baseline: the baseline moves only on purpose, by a person, in its own commit (AGENTS.md
// § Scoring), so `--accept` stays a command on a committed tree.
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { z } from "zod";

import { BASELINE_TRIALS, baselinePath, EXIT, gate, loadBaseline, metricDeltas, verdictLine, type Baseline, type GateVerdict } from "../../eval/baseline.js";
import { loadScorer, runEval } from "../../eval/harness.js";
import { loadQuestions, type Question } from "../../eval/questions.js";
import { EVAL_RUNS_DIR, saveEvalRun, type EvalRecord, type EvalRun, type QuestionResult } from "../../eval/record.js";
import { loadKeyOverlay } from "../../eval/score.js";
import { DEFAULT_EFFORT, DEFAULT_MODEL, MAX_TOKENS } from "../agent/agent.js";
import { agentSurface, agentVersion } from "../agent/version.js";
import { ESTIMATE_USD, IMPROVER_EFFORT, IMPROVER_MODEL } from "../improve/improve.js";
import { assertGraphReady } from "../graph/health.js";
import { loadResourceNames } from "../graph/names.js";
import { apiFailure } from "./api-failure.js";

/** One eval record in the page's picker, newest first. */
export interface EvalListing {
  evalId: string;
  startedAt: string;
  model: string;
  effort: string;
  trials: number;
  full: boolean;
  /** Question runs that threw; a record with any is incomplete. */
  errors: number;
  meanPassed: number;
  questions: number;
  meanCostUsd: number;
}

/** A record's verdict as the page shows it, with where it comes from. */
export interface RecordVerdict extends GateVerdict {
  /** "stored": the comparison the run saved when it was judged. "now": the record stores none, so the gate ran against today's committed baseline. */
  judged: "stored" | "now";
  /** A stored comparison made against a baseline whose figures (mean passes, solid count, mean cost) are not today's. */
  earlierBaseline: boolean;
  /** The record is the run today's baseline was accepted from: judged against it, every rule holds by construction. */
  baselineRun: boolean;
}

/** The baseline a record is shown beside, per question; `solid` is null where the record does not say. */
export interface BaselineColumn {
  /** Which baseline: the one the record was judged against when it ran, or today's committed one. */
  source: "judged against" | "today";
  trials: number;
  questions: Record<string, { passes: number; solid: boolean | null }>;
}

/** One eval record with everything the page shows beside it. */
export interface EvalView {
  record: EvalRecord;
  /** Every question's text by id, since a reader has not read eval/QUESTIONS.md. */
  questionText: Record<string, string>;
  /** Why the key overlay amends a question, for the questions it amends. */
  amendments: Record<string, string>;
  /** Today's committed baseline for the record's model and effort, null when there is none or it cannot be read. */
  baseline: (Pick<Baseline, "codeVersion" | "evalId" | "acceptedAt" | "trials" | "solid" | "passed" | "costUsd"> & { file: string }) | null;
  verdict: RecordVerdict;
  column: BaselineColumn | null;
  /** Every stored metric against today's committed baseline, the lines the command prints; empty when the run is not compared. */
  metrics: string[];
  /** The improver's cost estimate, per judged trace and for the proposal, as the command prints it. */
  improveEstimateUsd: { perTrace: number; proposal: number };
  /** The improver's model and effort, so the page names what a click runs without a copy of either. */
  improver: { model: string; effort: string };
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * The verdict the page shows for a record: the comparison it stored when it was judged, since a
 * baseline retaken since then would otherwise turn a red run green on the page, or the reverse.
 * Only a record that stores none is judged now, against today's committed baseline, and says so.
 */
export function recordVerdict(record: EvalRecord, baseline: Baseline | null): RecordVerdict {
  const baselineRun = baseline?.evalId === record.evalId;
  const c = record.comparison;
  if (c) {
    const same = !!baseline && c.average.baseline === mean(baseline.passed) && c.cost.baseline === mean(baseline.costUsd) && c.solid.solidCount === baseline.solid.length;
    const line = record.secondRound ? `ACCEPTING: against the baseline being replaced, ${verdictLine(c)}` : verdictLine(c);
    return { comparison: c, exit: record.secondRound ? EXIT.ok : EXIT[c.verdict], line, judged: "stored", earlierBaseline: !same, baselineRun };
  }
  // The command's line points at its ERROR lines, which exist only in the terminal.
  const v = gate(record, baseline, false);
  return { ...v, line: v.line.replace("(see the ERROR lines)", "(marked in the Traces column)"), judged: "now", earlierBaseline: false, baselineRun };
}

/**
 * The baseline column beside a record. A stored comparison lists every question whose count
 * differed from the baseline it was judged against, so that baseline's counts are recovered
 * exactly; its solid set is not stored, so membership is shown only when that baseline is today's.
 */
export function baselineColumn(record: EvalRecord, verdict: RecordVerdict, baseline: Baseline | null): BaselineColumn | null {
  const c = verdict.comparison;
  if (c && verdict.judged === "stored") {
    const flips = new Map(c.flips.map((f) => [f.id, f.baseline]));
    const solid = verdict.earlierBaseline ? null : new Set(baseline!.solid);
    return {
      source: "judged against",
      trials: c.trials,
      questions: Object.fromEntries(record.questions.map((q) => [q.id, { passes: flips.get(q.id) ?? q.passes, solid: solid ? solid.has(q.id) : null }])),
    };
  }
  if (!baseline) return null;
  return {
    source: "today",
    trials: baseline.trials,
    questions: Object.fromEntries(Object.entries(baseline.questions).map(([id, passes]) => [id, { passes, solid: baseline.solid.includes(id) }])),
  };
}

/** One tool as the model reads it. */
export interface ToolView {
  name: string;
  description: string;
  /** The input schema as JSON Schema, which is what reaches the model. */
  schema: unknown;
}

/** Everything that determines a run of the shipped agent: the fingerprint's input, and the fingerprint. */
export interface AgentView {
  agentVersion: string;
  settings: { model: string; effort: string; maxTokens: number };
  systemPrompt: string;
  tools: ToolView[];
}

/** One question run once from the page, scored against the key. */
export interface QuestionRun {
  question: Question;
  result: QuestionResult;
}

/** An eval started from the page, as the page polls it. */
export interface EvalJob {
  jobId: string;
  trials: number;
  /** Question runs the eval will make: trials times questions. */
  total: number;
  startedAt: string;
  state: "running" | "done" | "failed";
  /** Each finished question run, in completion order; a run that threw carries why, in one line. */
  done: { id: string; trial: number; status: QuestionResult["status"]; error: string | null }[];
  /** Set once the record is saved under runs/eval/. */
  evalId: string | null;
  /** The gate's last line on the finished run, as the command ends on it. */
  verdict: string | null;
  /** Why the run stopped before scoring. */
  error: string | null;
}

/** The trial counts the page offers: the gate's three, or one for a quick read, as `--trials 1` is. */
export const PAGE_TRIALS = [BASELINE_TRIALS, 1] as const;

/** The body of POST /api/eval-runs. */
export const EVAL_RUN_REQUEST = z.object(
  { trials: z.union(PAGE_TRIALS.map((n) => z.literal(n)), { error: `trials must be ${PAGE_TRIALS.join(" or ")}.` }).default(BASELINE_TRIALS) },
  { error: "Send a JSON body: { trials? }." },
);

/** What a full eval needs from the outside world; a test swaps it for a fake, so no model or database is touched. */
export interface EvalRunner {
  run: typeof runEval;
  baseline: typeof loadBaseline;
  save: typeof saveEvalRun;
}

/** A JSON file's content, or null when it does not parse: one half-written file must not hide the others. */
async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** The eval records under `dir`, newest first; a file that is not an eval record of the current shape is left out. */
export async function listEvalRecords(dir = EVAL_RUNS_DIR): Promise<EvalListing[]> {
  const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith(".json"));
  const listings: EvalListing[] = [];
  for (const file of files) {
    const r = await readJson<Partial<EvalRecord>>(path.join(dir, file));
    if (!r?.evalId || !r.summary || !r.questions?.[0]?.results) continue;
    listings.push({
      evalId: r.evalId,
      startedAt: r.startedAt!,
      model: r.model!,
      effort: r.effort!,
      trials: r.summary.trials,
      full: r.full!,
      errors: r.summary.errors,
      meanPassed: r.summary.meanPassed,
      questions: r.questions.length,
      meanCostUsd: r.summary.meanCostUsd,
    });
  }
  return listings.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** Reads, runs and judges evals for the page. */
@Injectable()
export class EvalService {
  private readonly logger = new Logger(EvalService.name);
  private readonly jobs = new Map<string, EvalJob>();
  /** Replaced in the tests; the eval's own functions otherwise. */
  runner: EvalRunner = { run: runEval, baseline: loadBaseline, save: saveEvalRun };

  /** The eval records, newest first. */
  list(): Promise<EvalListing[]> {
    return listEvalRecords();
  }

  /** One eval record, with the verdict it stored when it was judged, beside today's committed baseline. */
  async view(evalId: string): Promise<EvalView> {
    const record = await readJson<EvalRecord>(path.join(EVAL_RUNS_DIR, `${evalId}.json`));
    if (!record?.questions?.[0]?.results) throw new NotFoundException(`No eval record ${evalId} under ${EVAL_RUNS_DIR}/ in the current format.`);
    // A run that threw is stored with the error as the harness wrote it; the page shows it in one line.
    for (const q of record.questions) for (const r of q.results) if (r.error) r.error = apiFailure(r.error);
    const questionText = Object.fromEntries((await loadQuestions()).map((q) => [q.id, q.text]));
    const amendments = Object.fromEntries(Object.entries(await loadKeyOverlay()).map(([id, a]) => [id, a.reason]));

    let baseline: Baseline | null = null;
    let verdict: RecordVerdict;
    try {
      baseline = await this.runner.baseline(record.model, record.effort);
      verdict = recordVerdict(record, baseline);
    } catch (error) {
      verdict = record.comparison
        ? recordVerdict(record, null)
        : { comparison: null, exit: EXIT.unmeasured, line: `Not judged: the committed baseline cannot be read (${(error as Error).message})`, judged: "now", earlierBaseline: false, baselineRun: false };
    }
    return {
      record,
      questionText,
      amendments,
      baseline: baseline && {
        file: baselinePath(baseline.model, baseline.effort),
        codeVersion: baseline.codeVersion,
        evalId: baseline.evalId,
        acceptedAt: baseline.acceptedAt,
        trials: baseline.trials,
        solid: baseline.solid,
        passed: baseline.passed,
        costUsd: baseline.costUsd,
      },
      verdict,
      column: baselineColumn(record, verdict, baseline),
      metrics: verdict.comparison && baseline ? metricDeltas(record.trialTotals, baseline.trialTotals) : [],
      improveEstimateUsd: ESTIMATE_USD,
      improver: { model: IMPROVER_MODEL, effort: IMPROVER_EFFORT },
    };
  }

  /** What the model of the shipped agent reads, with its fingerprint. */
  agent(): AgentView {
    const settings = { model: DEFAULT_MODEL, effort: DEFAULT_EFFORT, maxTokens: MAX_TOKENS };
    const surface = agentSurface(settings);
    return {
      agentVersion: agentVersion(settings),
      settings,
      systemPrompt: surface.systemPrompt,
      tools: surface.tools.map((t) => {
        const schema = z.toJSONSchema(t.schema) as { description?: string };
        // The answer tool's description lives in its schema's metadata (src/agent/agent.ts).
        return { name: t.name, description: t.description || schema.description || "", schema };
      }),
    };
  }

  /** Runs one eval question once through the shipped agent and scores it against the key; the trace is saved under runs/. */
  async runQuestion(questionId: string): Promise<QuestionRun> {
    const question = (await loadQuestions()).find((q) => q.id === questionId);
    if (!question) throw new BadRequestException(`No eval question has the id ${questionId}.`);
    const withNames = await loadScorer();
    // As in the eval: a database outage reaches the model as text, so the graph is checked before any token is spent.
    await assertGraphReady();
    const score = withNames(await loadResourceNames());
    // A run that threw is a result with status "error", as in the eval; its reason is shortened to one line.
    const result = await score(question, DEFAULT_MODEL, DEFAULT_EFFORT);
    return { question, result: result.error ? { ...result, error: apiFailure(result.error) } : result };
  }

  /**
   * Starts a full eval of the shipped agent in the background and returns its job. One at a time:
   * each costs real tokens. The baseline is read first, so a file the gate cannot read refuses the
   * run before any token is spent, as the command does.
   */
  async startEval(trials: number): Promise<EvalJob> {
    const running = this.running();
    if (running) throw new ConflictException(`An eval started from this page is still running (${running.done.length} of ${running.total} runs done); wait for it.`);
    let baseline: Baseline | null;
    try {
      baseline = await this.runner.baseline(DEFAULT_MODEL, DEFAULT_EFFORT);
    } catch (error) {
      throw new ConflictException(`INCOMPLETE: ${(error as Error).message}`);
    }
    const questions = (await loadQuestions()).length;
    const job: EvalJob = {
      jobId: randomUUID(),
      trials,
      total: trials * questions,
      startedAt: new Date().toISOString(),
      state: "running",
      done: [],
      evalId: null,
      verdict: null,
      error: null,
    };
    this.jobs.set(job.jobId, job);
    void this.execute(job, baseline);
    return job;
  }

  /** The eval started from the page that is still running, so a reloaded page can follow it again; null when none is. */
  running(): EvalJob | null {
    return [...this.jobs.values()].find((j) => j.state === "running") ?? null;
  }

  /** The job's progress, or its outcome once finished. */
  job(jobId: string): EvalJob {
    const job = this.jobs.get(jobId);
    if (!job) throw new NotFoundException("No such eval on this server; it keeps them in memory, so a restart forgets them.");
    return job;
  }

  // The command's steps without its printing: run, judge against the baseline, save the record.
  private async execute(job: EvalJob, baseline: Baseline | null): Promise<void> {
    try {
      const run: EvalRun = await this.runner.run({
        trials: job.trials,
        onQuestion: (result, trial) => job.done.push({ id: result.id, trial, status: result.status, error: result.error && apiFailure(result.error) }),
      });
      const verdict = gate(run, baseline, false);
      const file = await this.runner.save({ ...run, comparison: verdict.comparison });
      Object.assign(job, { state: "done", evalId: run.evalId, verdict: verdict.line });
      this.logger.log(`eval ${run.evalId}: ${verdict.line}; saved ${file}`);
    } catch (error) {
      // Nothing was scored: the run says nothing about the agent, as the command's INCOMPLETE says.
      Object.assign(job, { state: "failed", error: `INCOMPLETE: the eval stopped before scoring: ${(error as Error).message}` });
      this.logger.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    }
  }
}
