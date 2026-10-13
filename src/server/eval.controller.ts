// The eval page's endpoints: read the eval records and the agent's surface, run one question or a
// whole eval, and start the improver on a record's failures. Validation is zod, as for the chat;
// every id that becomes a file name is checked against the shape the code writes, so a route can
// only ever name a file inside runs/. No endpoint accepts a baseline.
import { BadRequestException, Body, Controller, Get, Header, HttpCode, Inject, Param, Post } from "@nestjs/common";
import { z } from "zod";

import type { ImproveRecord } from "../improve/improve.js";
import { EVAL_RUN_REQUEST, EvalService, type AgentView, type EvalJob, type EvalListing, type EvalView, type QuestionRun } from "./eval.service.js";
import { ImproveService, type ProposalListing } from "./improve.service.js";

// An eval record's or a proposal's id as the code writes it: an ISO timestamp with dashes, then the model and effort.
const FILE_ID = /^[\w-]+$/;
const QUESTION_ID = z.string({ error: "questionId is missing." }).regex(/^[a-z0-9-]+$/, "questionId must be an eval question's id.");

const QUESTION_RUN_REQUEST = z.object({ questionId: QUESTION_ID }, { error: "Send a JSON body: { questionId }." });

// The body of POST /api/improve: the eval record whose failures are read, and optionally which questions.
const IMPROVE_REQUEST = z.object(
  {
    evalId: z.string({ error: "evalId is missing." }).regex(FILE_ID, "evalId must be an eval record's id."),
    questionIds: z.array(QUESTION_ID).min(1, "questionIds, when given, names at least one question.").optional(),
  },
  { error: "Send a JSON body: { evalId, questionIds? }." },
);

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((issue) => issue.message).join(" "));
  return parsed.data;
}

function fileId(id: string): string {
  if (!FILE_ID.test(id)) throw new BadRequestException("Not a record id.");
  return id;
}

/** The eval page's JSON endpoints under /api. */
@Controller("api")
export class EvalController {
  // Explicit tokens, as in the chat controller, so the test under tsx builds it too (docs/facts.md).
  constructor(
    @Inject(EvalService) private readonly evals: EvalService,
    @Inject(ImproveService) private readonly improver: ImproveService,
  ) {}

  /** The eval records under runs/eval/, newest first. */
  @Get("evals")
  list(): Promise<EvalListing[]> {
    return this.evals.list();
  }

  /** One eval record, with the questions' text and the gate's verdict against the committed baseline. */
  @Get("evals/:evalId")
  view(@Param("evalId") evalId: string): Promise<EvalView> {
    return this.evals.view(fileId(evalId));
  }

  /** Everything the model of the shipped agent reads, and its fingerprint. */
  @Get("agent")
  agent(): AgentView {
    return this.evals.agent();
  }

  /** One eval question run once through the shipped agent, scored against the key. */
  @Post("question-runs")
  @HttpCode(200)
  runQuestion(@Body() body: unknown): Promise<QuestionRun> {
    return this.evals.runQuestion(parse(QUESTION_RUN_REQUEST, body).questionId);
  }

  /**
   * Starts a full eval of the shipped agent: `{ trials? }`, 3 (the gate's) or 1 (a quick read). The
   * body must be a JSON object even when empty: a form post from another site arrives unparsed, and
   * must start nothing.
   */
  @Post("eval-runs")
  @HttpCode(202)
  startEval(@Body() body: unknown): Promise<EvalJob> {
    return this.evals.startEval(parse(EVAL_RUN_REQUEST, body).trials);
  }

  /** The eval started from the page that is still running, if any, so a reloaded page can follow it. */
  @Get("eval-runs")
  running(): { job: EvalJob | null } {
    return { job: this.evals.running() };
  }

  /** A started eval's progress, then its outcome. */
  @Get("eval-runs/:jobId")
  job(@Param("jobId") jobId: string): EvalJob {
    return this.evals.job(jobId);
  }

  /** The improver's past proposals, newest first. */
  @Get("improve")
  proposals(): Promise<ProposalListing[]> {
    return this.improver.list();
  }

  /** One proposal's record. */
  @Get("improve/:improveId")
  @Header("content-type", "application/json; charset=utf-8")
  proposal(@Param("improveId") improveId: string): Promise<string> {
    return this.improver.read(fileId(improveId));
  }

  /** Judges an eval record's failing traces and proposes one change: `{ evalId, questionIds? }`. */
  @Post("improve")
  @HttpCode(200)
  propose(@Body() body: unknown): Promise<ImproveRecord> {
    const { evalId, questionIds } = parse(IMPROVE_REQUEST, body);
    return this.improver.propose({ evalId, only: questionIds });
  }
}
