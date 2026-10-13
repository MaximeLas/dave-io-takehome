// The improver's tests, with no model call and no database: what the judge is shown for a fixed
// record (the audit entry, the trace in steps, the score), which traces are chosen, the refusal
// of traces from another agent, the proposal file's shape from a fake model (a change, and no
// change), a failed or out-of-range judgement keeping the ones that landed, and the command's
// usage errors before any token is spent.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { loadQuestions } from "../../eval/questions.js";
import type { EvalRecord, QuestionResult } from "../../eval/record.js";
import { DEFAULT_EFFORT, DEFAULT_MODEL, MAX_TOKENS } from "../agent/agent.js";
import { SYSTEM_PROMPT } from "../agent/prompt.js";
import type { RunRecord } from "../agent/record.js";
import { agentVersion } from "../agent/version.js";
import {
  JUDGEMENT_SCHEMA,
  JudgeFailure,
  PROPOSAL_SCHEMA,
  improve,
  renderProposal,
  saveImprove,
  type ImproveInputs,
  type JudgedTrace,
  type Judgement,
  type ModelCall,
  type Proposal,
} from "./improve.js";
import { agentInstructions, auditEntry, auditVerdict, checkAgentVersion, judgeMessage, latestEvalId, proposerMessage, renderTrace, selectTraces, traceSteps } from "./inputs.js";
import { FAILURE_MODES, IMPROVER_PROMPT_VERSION } from "./prompt.js";

const settings = { model: DEFAULT_MODEL, effort: DEFAULT_EFFORT, maxTokens: MAX_TOKENS };
const audit = await readFile(new URL("../../eval/key-audit.md", import.meta.url), "utf8");

/** A failing run record with the message shapes the library stores: thinking, text, tool calls, results, the closing echo. */
const run = (runId: string, overrides: Partial<RunRecord> = {}): RunRecord => ({
  runId,
  questionId: "q-fail",
  threadId: runId,
  question: "Which repository's code ends up on i-ecomm-dev-02?",
  model: DEFAULT_MODEL,
  modelSettings: { effort: DEFAULT_EFFORT, maxTokens: MAX_TOKENS },
  promptVersion: "p",
  agentVersion: agentVersion(settings),
  embeddingModel: "e",
  codeVersion: "c",
  startedAt: "",
  finishedAt: "",
  durationMs: 0,
  modelCalls: 2,
  stopReasons: ["tool_use", "tool_use"],
  toolCalls: [{ name: "run_cypher", input: { query: "MATCH (w)-[:DEPLOYS_TO]->(i) RETURN w.id" }, output: "1 row\ncolumns: w.id\ngithub:workflow:deploy-dev", isError: false }],
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
  costUsd: 0,
  answer: "The code comes from github:repo:acme/repo-dev-2.",
  ids: ["github:repo:acme/repo-dev-2", "github:workflow:deploy-dev"],
  messages: [
    { type: "human", data: { content: "Which repository's code ends up on i-ecomm-dev-02?" } },
    {
      type: "ai",
      data: {
        content: [
          { type: "thinking", thinking: "", signature: "x" },
          { type: "text", text: "Plan: find the workflow that deploys there." },
          { type: "tool_use", id: "t1", name: "run_cypher", input: { query: "MATCH (w)-[:DEPLOYS_TO]->(i) RETURN w.id" } },
        ],
      },
    },
    { type: "tool", data: { tool_call_id: "t1", name: "run_cypher", content: "1 row\ncolumns: w.id\ngithub:workflow:deploy-dev" } },
    { type: "ai", data: { content: [{ type: "tool_use", id: "t2", name: "final_answer", input: { answer: "x", ids: [] } }] } },
    { type: "tool", data: { tool_call_id: "t2", content: "{}" } },
    { type: "ai", data: { content: 'Returning structured response: {"answer":"x"}' } },
  ],
  ...overrides,
});

const result = (status: QuestionResult["status"], runId: string | null, missing: string[] = [], extra: string[] = []): QuestionResult => ({
  id: "",
  status,
  runId,
  score: status === "error" ? null : { pass: status === "pass", empty: false, expected: 1, asserted: 1, missing, extra, recall: 1, precision: 1 },
  checks: null,
  diagnostics: null,
  error: null,
});

/** An eval record of four questions over three trials: one always failing, one wobbly, one passing, one failing once with an error beside it. */
const record: EvalRecord = {
  evalId: "e1",
  model: DEFAULT_MODEL,
  effort: DEFAULT_EFFORT,
  promptVersion: "p",
  codeVersion: "abc1234",
  startedAt: "",
  finishedAt: "",
  durationMs: 0,
  full: true,
  questions: [
    { id: "q-fail", passes: 0, amendedPasses: 0, results: [result("fail", "f1", ["m1"], []), result("fail", "f2", ["m1"]), result("fail", "f3", [], ["x1"])] },
    { id: "q-wobbly", passes: 2, amendedPasses: 2, results: [result("pass", "w1"), result("fail", "w2", [], ["x2"]), result("pass", "w3")] },
    { id: "q-pass", passes: 3, amendedPasses: 3, results: [result("pass", "p1"), result("pass", "p2"), result("pass", "p3")] },
    { id: "q-error", passes: 1, amendedPasses: 1, results: [result("error", null), result("fail", "e2", ["m3"]), result("pass", "e3")] },
  ],
  trialTotals: [{ passed: 1 }, { passed: 1 }, { passed: 3 }] as EvalRecord["trialTotals"],
  summary: { trials: 3, meanPassed: 5 / 3, minPassed: 1, maxPassed: 3, errors: 1, meanCostUsd: 0, costUsd: 0 },
  comparison: null,
};
const text = { "q-fail": "Which repository?", "q-wobbly": "Which queue?", "q-pass": "Which bucket?", "q-error": "Which monitor?" };
const key = { "q-fail": ["github:repo:acme/repo-dev-2"], "q-wobbly": ["q"], "q-pass": ["b"], "q-error": ["m"] };

test("every question has an entry in the key audit, read up to the next entry, with its verdict", async () => {
  for (const q of await loadQuestions()) {
    const entry = auditEntry(audit, q.id);
    assert.ok(entry, `no audit entry for ${q.id}`);
    assert.ok(entry.startsWith(`### \`${q.id}\``));
    assert.equal(entry.match(/^### /gm)!.length, 1, `${q.id}'s entry runs into the next one`);
    assert.notEqual(auditVerdict(entry), "unknown", `${q.id}'s entry has no verdict`);
  }
  assert.equal(auditVerdict(auditEntry(audit, "fulfillment-backing-up")!), "agrees");
  assert.equal(auditVerdict(auditEntry(audit, "storefront-resources")!), "ambiguous");
  assert.equal(auditVerdict(auditEntry(audit, "order-flow-instances-actual-access")!), "disagrees");
  assert.equal(auditEntry(audit, "no-such-question"), undefined);
});

test("the failing and the wobbly questions are chosen, the earliest failing trials first, and a run that threw is skipped", () => {
  const one = selectTraces(record, text, key, { perQuestion: 1 });
  assert.ok(!("problem" in one));
  assert.deepEqual(one.traces.map((t) => [t.questionId, t.trial, t.runId]), [["q-fail", 1, "f1"], ["q-wobbly", 2, "w2"], ["q-error", 2, "e2"]]);
  assert.deepEqual(one.failing.map((f) => f.runId), ["f1", "f2", "f3", "w2", "e2"]);
  assert.deepEqual(one.traces[0]!.expected, key["q-fail"]);
  assert.deepEqual(one.traces[0]!.missing, ["m1"]);

  const all = selectTraces(record, text, key, { perQuestion: 3, only: ["q-fail"] });
  assert.ok(!("problem" in all));
  assert.deepEqual(all.traces.map((t) => t.runId), ["f1", "f2", "f3"]);
  assert.deepEqual(all.failing.map((f) => f.runId), ["f1", "f2", "f3"]);

  assert.deepEqual(selectTraces(record, text, key, { perQuestion: 1, only: ["q-pass"] }), { problem: "Question q-pass failed no trial of eval record e1; nothing to diagnose" });
  assert.deepEqual(selectTraces(record, text, key, { perQuestion: 1, only: ["nope"] }), { problem: "Question nope is not in eval record e1" });
});

test("the judge reads the question, the score, the audit entry, the trace in numbered steps and the final answer", () => {
  const trace = { questionId: "repo-behind-dev-02", question: "Which repository's code ends up on i-ecomm-dev-02?", passes: 2, trials: 3, trial: 1, runId: "f1", expected: ["github:repo:acme/repo-dev-2"], missing: [], extra: ["github:workflow:deploy-dev"] };
  const entry = auditEntry(audit, "repo-behind-dev-02")!;
  const message = judgeMessage({ trace, run: run("f1"), evalId: "e1", audit: entry });
  assert.match(message, /<question id="repo-behind-dev-02">Which repository's code ends up on i-ecomm-dev-02\?<\/question>/);
  assert.match(message, /passed 2 of 3 trials in eval run e1; this is trial 1/);
  assert.match(message, /Expected ids \(the answer key\): github:repo:acme\/repo-dev-2/);
  assert.match(message, /Missing from the answer: none\nAdded by the answer: github:workflow:deploy-dev/);
  assert.ok(message.includes(`<audit_entry>\n${entry}\n</audit_entry>`));
  assert.match(message, /\[1\] agent wrote:\nPlan: find the workflow that deploys there\./);
  assert.match(message, /\[2\] run_cypher called with:\nMATCH \(w\)-\[:DEPLOYS_TO\]->\(i\) RETURN w\.id\noutput:\n1 row/);
  assert.match(message, /\[3\] final_answer called; its prose and ids are under <final_answer> below\./);
  assert.doesNotMatch(message, /\[4\]|Returning structured response|signature/);
  assert.match(message, /<final_answer>\nProse:\nThe code comes from github:repo:acme\/repo-dev-2\.\n\nids: github:repo:acme\/repo-dev-2, github:workflow:deploy-dev\n<\/final_answer>/);
  assert.doesNotMatch(message, /<key_amendment>/);
  assert.match(judgeMessage({ trace, run: run("f1"), evalId: "e1", audit: entry, amended: { ids: ["a"], reason: "r" } }), /<key_amendment>[\s\S]*: a\nReason: r/);
});

test("a record without stored messages is rendered from its tool calls", () => {
  assert.match(renderTrace(run("f1", { messages: [] })), /^\[1\] run_cypher called with:\n\{"query":"MATCH/);
  assert.equal(traceSteps(run("f1")).length, 3);
});

test("the latest eval record is the newest JSON file, whatever else the folder holds", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "evals-"));
  assert.equal(await latestEvalId(dir), undefined);
  for (const name of ["2026-10-12T01-a.json", "2026-10-13T01-b.json", "2026-10-14T01-log.txt"]) await writeFile(path.join(dir, name), "{}");
  assert.equal(await latestEvalId(dir), "2026-10-13T01-b");
});

test("the agent's instructions are the system prompt and every tool the model reads, the answer tool's description included", () => {
  const instructions = agentInstructions(settings);
  assert.ok(instructions.includes(SYSTEM_PROMPT));
  for (const name of ["run_cypher", "search_descriptions", "final_answer"]) assert.match(instructions, new RegExp(`<tool name="${name}">`));
  assert.match(instructions, /<tool name="final_answer">\nDeliver the final answer\./);
});

test("traces from another agent are refused, pointing at an eval run on this checkout", () => {
  assert.equal(checkAgentVersion([run("a"), run("b")], record), undefined);
  const problem = checkAgentVersion([run("a"), run("b", { agentVersion: "0000beef" })], record);
  assert.match(problem!, /ran agent .*0000beef.*run npm run eval on this checkout/);
});

const judgement: Judgement = {
  firstError: { step: 3, what: "The workflow went into ids." },
  instruction: { source: "final_answer", quote: "not the ones you passed through", status: "not_followed" },
  failureModes: Object.fromEntries(Object.keys(FAILURE_MODES).map((m) => [m, { verdict: m === "ids_disagree_with_prose", evidence: m === "ids_disagree_with_prose" ? "Step 3 lists it." : "" }])) as Judgement["failureModes"],
  diagnosis: "The path clause was over-applied.",
};
const proposal: Proposal = {
  pattern: "Padding.",
  outOfScope: "- q-error: one trial.",
  change: { target: "system_prompt", location: "src/agent/prompt.ts, IDS_RULE", before: "old line", after: "new line" },
  hypothesis: "H.",
  check: "C.",
  measure: "M.",
  mightRegress: "R.",
  alreadyTried: "T.",
  notChanged: "N.",
};
const selected = selectTraces(record, text, key, { perQuestion: 1 });
assert.ok(!("problem" in selected));

/** The improver's inputs for the fixed record, every trace three steps long. */
const inputs = (overrides: Partial<ImproveInputs> = {}): ImproveInputs => ({
  record,
  agentVersion: "a6d81ecf",
  traces: selected.traces.map((trace) => ({ trace, audit: "**Verdict: agrees.**", judgeUser: `judge ${trace.runId}`, steps: 3 })),
  failing: selected.failing,
  judgeSystem: "J",
  proposerSystem: "P",
  proposerUser: (judged) => proposerMessage({ record, agentVersion: "a6d81ecf", judged, failing: selected.failing, experiments: [{ name: "x.md", text: "tried" }] }),
  settings: { model: "claude-opus-5-5", effort: "high" },
  ...overrides,
});

/** A fake model returning the given judgement (or the one per run id) and proposal, recording every prompt. */
const fakeModel = (prompts: string[], judge: (user: string) => Judgement = () => judgement, propose: Proposal = proposal): ModelCall =>
  async (schema, system, user) => {
    prompts.push(`${system}\n${user}`);
    return { output: (schema === (JUDGEMENT_SCHEMA as unknown) ? judge(user) : propose) as never, costUsd: 0.1 };
  };

test("the proposal file frames the proposal, lays it out in the experiment files' shape and carries every diagnosis with its trace", async () => {
  const prompts: string[] = [];
  const r = await improve(inputs(), fakeModel(prompts), new Date("2026-10-13T01:00:00.000Z"));
  assert.equal(prompts.length, 4, "three judgements, one proposal");
  assert.match(prompts[3]!, /<diagnosis question_id="q-fail" trial="1" run_id="f1" audit_verdict="agrees">/);
  assert.match(prompts[3]!, /<experiment_file name="x.md">\ntried/);
  assert.match(prompts[3]!, /q-wobbly, trial 2 \(w2\): missing none; added x2/);

  assert.equal(r.improveId, "2026-10-13T01-00-00-000Z-e1");
  assert.deepEqual(r.eval, { evalId: "e1", model: DEFAULT_MODEL, effort: DEFAULT_EFFORT, promptVersion: "p", agentVersion: "a6d81ecf", codeVersion: "abc1234", passed: [1, 1, 3], questions: 4 });
  assert.equal(r.improver.promptVersion, IMPROVER_PROMPT_VERSION);
  assert.deepEqual(r.judged.map((j) => j.runId), ["f1", "w2", "e2"]);
  assert.ok(Math.abs(r.costUsd - 0.4) < 1e-9);
  assert.ok(!("audit" in r.judged[0]!), "the audit text stays out of the record; the question id finds it");

  const md = renderProposal(r);
  assert.match(md, /nothing in it has been applied or measured\. The judge behind it has not been validated against a person's labels/);
  assert.match(md, /- \*\*Eval record:\*\* `runs\/eval\/e1\.json`: .*prompt `p`, agent `a6d81ecf`, code `abc1234`; passed 1, 1, 3 of 4\./);
  assert.match(md, new RegExp(`- \\*\\*Improver:\\*\\* claude-opus-5-5 at effort high, prompt \`${IMPROVER_PROMPT_VERSION}\``));
  const headings = md.match(/^#+ .*$/gm)!;
  assert.deepEqual(headings.slice(0, 3), ["# Improvement proposal (2026-10-13)", "## Proposal", "## Diagnoses"]);
  assert.ok(headings.includes("## Failing trials not judged"));
  for (const label of ["Pattern.", "Hypothesis.", "Check, written before the run.", "What the eval should show.", "What might regress.", "Already tried.", "Not changed."]) assert.ok(md.includes(`**${label}** `), label);
  assert.match(md, /\*\*Left out\.\*\*\n\n- q-error: one trial\./);
  assert.match(md, /Before:\n\n```text\nold line\n```\n\nAfter:\n\n```text\nnew line\n```/);
  assert.match(md, /### `q-fail`: passed 0 of 3\n\n> Which repository\?\n\nTrial 1, run `f1` \(`runs\/f1\.json`\)\. Audit verdict: agrees\./);
  for (const mode of Object.keys(FAILURE_MODES)) assert.match(md, new RegExp(`^\\| ${mode} \\| (yes|no) \\|`, "m"));
  assert.match(md, /- `q-fail`, trial 2 \(`f2`\): missing `m1`; added none\./);

  const dir = await mkdtemp(path.join(tmpdir(), "improve-"));
  const file = await saveImprove(r, dir);
  assert.equal(file, path.join(dir, `${r.improveId}.md`));
  assert.deepEqual((await readdir(dir)).sort(), [`${r.improveId}.json`, `${r.improveId}.md`]);
  assert.deepEqual(JSON.parse(await readFile(path.join(dir, `${r.improveId}.json`), "utf8")), JSON.parse(JSON.stringify(r)));
});

test("a proposal of no change says why and carries no before, after or check", async () => {
  const none: Proposal = { ...proposal, change: { target: "no_change_noise", location: "", before: "", after: "" }, hypothesis: "Judge all three trials.", check: "" };
  const md = renderProposal(await improve(inputs(), fakeModel([], undefined, none)));
  assert.match(md, /\*\*No change\*\* \(what is left is noise\)\.\n\n\*\*What would justify one\.\*\* Judge all three trials\./);
  assert.doesNotMatch(md, /Before:|After:|\*\*Check, written before the run\.\*\*/);
  assert.match(md, /\*\*What the eval should show\.\*\* M\./);
});

test("a failed judge call or a step outside the trace makes no proposal and keeps the judgements that landed", async () => {
  const saved: JudgedTrace[][] = [];
  const prompts: string[] = [];
  const judge = (user: string) => {
    if (user === "judge w2") throw new Error("HTTP 529 overloaded");
    return user === "judge e2" ? { ...judgement, firstError: { step: 0, what: "x" } } : judgement;
  };
  await assert.rejects(
    improve(inputs({ onJudged: async (landed) => void saved.push(landed) }), fakeModel(prompts, judge)),
    (error: unknown) => {
      assert.ok(error instanceof JudgeFailure);
      assert.equal(error.landed, 1);
      assert.deepEqual(error.failed.map((f) => f.runId).sort(), ["e2", "w2"]);
      assert.match(error.failed.find((f) => f.runId === "e2")!.reason, /step 0, outside the trace's steps 1 to 3/);
      return true;
    },
  );
  assert.equal(prompts.length, 3, "three judge calls and no proposal");
  assert.deepEqual(saved.at(-1)!.map((j) => j.runId), ["f1"]);
});

test("at most three judge calls are in flight at once", async () => {
  const many = Array.from({ length: 7 }, (_, i) => ({ ...selected.traces[0]!, runId: `r${i}` }));
  let inFlight = 0;
  let most = 0;
  const call: ModelCall = async (schema) => {
    most = Math.max(most, ++inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight--;
    return { output: (schema === (JUDGEMENT_SCHEMA as unknown) ? judgement : proposal) as never, costUsd: 0 };
  };
  const r = await improve(inputs({ traces: many.map((trace) => ({ trace, audit: "", judgeUser: trace.runId, steps: 3 })) }), call);
  assert.equal(most, 3);
  assert.deepEqual(r.judged.map((j) => j.runId), many.map((t) => t.runId), "in the traces' order");
});

test("both output schemas are plain objects of strings, booleans, integers and enums, which the API's JSON-schema output accepts", () => {
  for (const schema of [JUDGEMENT_SCHEMA, PROPOSAL_SCHEMA]) {
    const types = new Set(JSON.stringify(schema.toJSONSchema()).match(/"type":"[a-z]+"/g));
    assert.deepEqual([...types].filter((t) => !['"type":"object"', '"type":"string"', '"type":"boolean"', '"type":"integer"'].includes(t)), []);
  }
});

test("usage errors are one line and exit 3 before any token is spent", () => {
  const cli = (...args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", "scripts/improve.ts", ...args], { encoding: "utf8", env: { ...process.env, APP_ANTHROPIC_API_KEY: "" } });
  for (const [args, message] of [
    [["--bogus"], "Unknown option '--bogus'. See npm run improve -- --help."],
    [["--traces", "0"], "--traces is a whole number of traces per question, at least 1. See npm run improve -- --help."],
    [["--model", "gpt"], "Unknown model gpt; one of claude-sonnet-5-5, claude-haiku-5-5, claude-opus-5-5. See npm run improve -- --help."],
    [["--eval", "no-such-record"], "No eval record no-such-record under runs/eval/. See npm run improve -- --help."],
  ] as const) {
    const r = cli(...args);
    assert.equal(r.status, 3, `${args.join(" ")}: ${r.stderr}`);
    assert.equal(r.stderr.trim(), message);
  }
  const help = cli("--help");
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^npm run improve: reads the failing traces/);
});
