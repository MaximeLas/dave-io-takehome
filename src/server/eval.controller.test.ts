// The eval page's endpoints, pinned without a model or a database: the real module and HTTP setup
// with the eval service replaced by a stub, so what is tested is parsing, validation and the host
// check; the real improver service, which must refuse a missing eval record in one line before any
// model call; the verdict a record shows; the eval job's progress shape, driven by a fake runner in
// place of the eval; the listings' order; and a model refusal shortened to one line.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

import { ConflictException } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";

import type { Baseline } from "../../eval/baseline.js";
import type { Comparison, EvalRecord, EvalRun, QuestionResult } from "../../eval/record.js";
import { apiFailure } from "./api-failure.js";
import { APP_OPTIONS, configureApp } from "./app.js";
import { AppModule } from "./app.module.js";
import { baselineColumn, EvalService, listEvalRecords, recordVerdict, type EvalJob } from "./eval.service.js";
import { listProposals } from "./improve.service.js";

const calls: Array<{ method: string; arg: unknown }> = [];
const stub = {
  async startEval(trials: number) {
    calls.push({ method: "startEval", arg: trials });
    return { jobId: "j" };
  },
  async runQuestion(questionId: string) {
    calls.push({ method: "runQuestion", arg: questionId });
    return {};
  },
};

let app: NestExpressApplication;
let base: string;

before(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(EvalService)
    .useValue(stub)
    .compile();
  app = configureApp(moduleRef.createNestApplication<NestExpressApplication>({ ...APP_OPTIONS, logger: false }));
  await app.listen(0, "127.0.0.1");
  base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
});
after(() => app.close());
beforeEach(() => {
  calls.length = 0;
});

function post(route: string, body: unknown) {
  return fetch(`${base}/api/${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

async function rejection(response: Response): Promise<string> {
  assert.equal(response.status, 400);
  assert.equal(calls.length, 0, "a rejected request must not reach the service");
  return ((await response.json()) as { message: string }).message;
}

test("an eval run takes three trials by default, or one, and nothing else", async () => {
  assert.equal((await post("eval-runs", {})).status, 202);
  assert.equal((await post("eval-runs", { trials: 1 })).status, 202);
  assert.deepEqual(calls, [{ method: "startEval", arg: 3 }, { method: "startEval", arg: 1 }]);
  calls.length = 0;
  assert.equal(await rejection(await post("eval-runs", { trials: 2 })), "trials must be 3 or 1.");
  assert.equal(await rejection(await post("eval-runs", { trials: "3" })), "trials must be 3 or 1.");
});

test("a form post, which any website can send cross-site, starts nothing", async () => {
  const response = await fetch(`${base}/api/eval-runs`, { method: "POST", body: new URLSearchParams({ trials: "3" }) });
  assert.equal(await rejection(response), "Send a JSON body: { trials? }.");
});

test("a request addressed to another host is refused, so a rebinding domain cannot reach the endpoints that spend", async () => {
  // fetch() will not send a Host header of the caller's choosing; a page on a domain that resolves to 127.0.0.1 does.
  const { port } = app.getHttpServer().address() as AddressInfo;
  const send = (host: string) =>
    new Promise<number>((resolve, reject) => {
      const body = JSON.stringify({ trials: 1 });
      const req = request({ host: "127.0.0.1", port, method: "POST", path: "/api/eval-runs", headers: { host, "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (res) => {
        res.resume();
        resolve(res.statusCode!);
      });
      req.on("error", reject);
      req.end(body);
    });
  assert.equal(await send(`attacker.example:${port}`), 403);
  assert.equal(await send(`localhost:${port + 1}`), 403);
  assert.equal(calls.length, 0, "a refused host must not reach the service");
  assert.equal(await send(`localhost:${port}`), 202);
  assert.equal(await send(`[::1]:${port}`), 202);
});

test("a question run needs an eval question's id", async () => {
  assert.equal((await post("question-runs", { questionId: "dev-compute-stack" })).status, 200);
  assert.deepEqual(calls, [{ method: "runQuestion", arg: "dev-compute-stack" }]);
  calls.length = 0;
  assert.equal(await rejection(await post("question-runs", {})), "questionId is missing.");
  assert.equal(await rejection(await post("question-runs", { questionId: "../x" })), "questionId must be an eval question's id.");
});

test("record routes accept record ids only, so none names a file outside runs/", async () => {
  for (const route of ["evals", "improve"]) {
    assert.equal((await fetch(`${base}/api/${route}/${encodeURIComponent("../.env")}`)).status, 400);
  }
  assert.equal(await rejection(await post("improve", { evalId: "../x" })), "evalId must be an eval record's id.");
  assert.equal(await rejection(await post("improve", { evalId: "e", questionIds: [] })), "questionIds, when given, names at least one question.");
});

test("the improver refuses a missing eval record in one line, before any model call", async () => {
  const response = await post("improve", { evalId: "2000-01-01T00-00-00-000Z-none" });
  assert.equal(response.status, 400);
  assert.equal(((await response.json()) as { message: string }).message, "No eval record 2000-01-01T00-00-00-000Z-none under runs/eval/.");
});

test("the eval records and the proposals are listed newest first, other files left out", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "eval-page-"));
  const record = (evalId: string, startedAt: string) =>
    JSON.stringify({ evalId, startedAt, model: "m", effort: "e", full: true, questions: [{ id: "q", results: [] }], summary: { trials: 3, meanPassed: 25, meanCostUsd: 0.09 } });
  await mkdir(path.join(dir, "eval"));
  await writeFile(path.join(dir, "eval", "a.json"), record("older", "2026-10-11T10:00:00.000Z"));
  await writeFile(path.join(dir, "eval", "b.json"), record("newer", "2026-10-12T10:00:00.000Z"));
  await writeFile(path.join(dir, "eval", "c.json"), JSON.stringify({ evalId: "single-run-format", questions: [{ id: "q" }] }));
  await writeFile(path.join(dir, "eval", "d.json"), '{"evalId": "half-written');
  assert.deepEqual((await listEvalRecords(path.join(dir, "eval"))).map((r) => r.evalId), ["newer", "older"]);

  const proposal = (improveId: string, createdAt: string) =>
    JSON.stringify({ improveId, createdAt, eval: { evalId: "e" }, judged: [{ questionId: "q" }], proposal: { change: { target: "system_prompt", location: "l" } }, costUsd: 0.9 });
  await mkdir(path.join(dir, "improve"));
  await writeFile(path.join(dir, "improve", "x.json"), proposal("first", "2026-10-13T01:00:00.000Z"));
  await writeFile(path.join(dir, "improve", "y.json"), proposal("second", "2026-10-13T02:00:00.000Z"));
  await writeFile(path.join(dir, "improve", "y.md"), "# the rendered proposal");
  await writeFile(path.join(dir, "improve", "z.json"), JSON.stringify({ complete: false, createdAt: "2026-10-13T03:00:00.000Z", evalId: "e", judged: [] }));
  assert.deepEqual((await listProposals(path.join(dir, "improve"))).map((p) => p.improveId), ["second", "first"]);
});

test("a record shows the verdict it stored when it ran, not one recomputed against a baseline retaken since", () => {
  // Today's baseline, retaken with a wider tolerance: against it the record below would hold every rule.
  const today = { evalId: "accept", model: "m", effort: "e", trials: 3, passed: [24, 26, 26], passTolerance: 2, costUsd: [0.09, 0.08, 0.08], costMarginUsd: 0.01, solid: ["a"], questions: { a: 3, b: 2 } } as unknown as Baseline;
  const stored: Comparison = {
    baselineFile: "eval/baselines/m.e.json",
    trials: 3,
    verdict: "regression",
    average: { held: false, value: 24, baseline: 26, allowance: 1, limit: 25 },
    solid: { held: true, solidCount: 25, broken: [] },
    cost: { held: true, value: 0.08, baseline: 0.09, allowance: 0.005, limit: 0.095 },
    flips: [{ id: "b", baseline: 3, run: 1 }],
  };
  const record = {
    evalId: "older",
    model: "m",
    effort: "e",
    full: true,
    summary: { trials: 3, errors: 0, meanPassed: 24, meanCostUsd: 0.08 },
    trialTotals: [{ passed: 24 }, { passed: 24 }, { passed: 24 }],
    questions: [{ id: "a", passes: 3, results: [] }, { id: "b", passes: 1, results: [] }],
    comparison: stored,
  } as unknown as EvalRecord;

  const v = recordVerdict(record, today);
  assert.deepEqual([v.judged, v.earlierBaseline, v.baselineRun], ["stored", true, false]);
  assert.equal(v.line, "REGRESSION: rule 1 (average: mean 24 below the floor of 25)");
  // The baseline it was judged against, recovered from the comparison; its solid set is not stored.
  assert.deepEqual(baselineColumn(record, v, today), { source: "judged against", trials: 3, questions: { a: { passes: 3, solid: null }, b: { passes: 3, solid: null } } });

  const now = recordVerdict({ ...record, comparison: null }, today);
  assert.deepEqual([now.judged, now.line], ["now", "OK: all three rules held"]);
  assert.equal(baselineColumn({ ...record, comparison: null }, now, today)!.source, "today");
  assert.equal(recordVerdict({ ...record, evalId: "accept", comparison: null }, today).baselineRun, true);
});

test("an eval job reports each finished run, then the saved record and the gate's line; one runs at a time", async () => {
  const service = new EvalService();
  let finish!: () => void;
  const released = new Promise<void>((resolve) => (finish = resolve));
  const saved: string[] = [];
  const thrown: QuestionResult = {
    id: "dev-compute-stack",
    status: "error",
    runId: null,
    score: null,
    checks: null,
    diagnostics: null,
    error: 'Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"You have reached your specified API usage limits."}}',
  };
  service.runner = {
    async run(options = {}) {
      options.onQuestion?.(thrown, 1);
      await released;
      return { evalId: "e1", full: false, summary: { errors: 0 } } as EvalRun;
    },
    baseline: async () => null,
    save: async (record) => {
      saved.push(record.evalId);
      return "runs/eval/e1.json";
    },
  };

  const job = await service.startEval(1);
  assert.equal(job.state, "running");
  assert.equal(job.total, 30);
  assert.deepEqual(service.job(job.jobId).done, [
    { id: "dev-compute-stack", trial: 1, status: "error", error: "the model API answered 400: You have reached your specified API usage limits." },
  ]);
  await assert.rejects(service.startEval(1), ConflictException);

  finish();
  let done: EvalJob = service.job(job.jobId);
  while (done.state === "running") {
    await new Promise((resolve) => setTimeout(resolve, 5));
    done = service.job(job.jobId);
  }
  assert.equal(done.state, "done");
  assert.equal(done.evalId, "e1");
  assert.match(done.verdict!, /^REPORTED only/);
  assert.deepEqual(saved, ["e1"]);
});

test("a model refusal reads as one line with the API's status and message", () => {
  const body = '400 {"type":"error","error":{"type":"invalid_request_error","message":"You have reached your specified API usage limits."},"request_id":"r"}';
  const expected = "the model API answered 400: You have reached your specified API usage limits.";
  assert.equal(apiFailure(new Error(body)), expected);
  assert.equal(apiFailure(`Error: ${body}`), expected);
  assert.equal(apiFailure("timed out after 300 s"), "timed out after 300 s");
});
