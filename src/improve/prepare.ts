// Gathers everything one improver run needs from files on disk, before any model call: the eval
// record, the failing traces chosen for the judge, their run records, the key audit's entries, the
// agent's own instructions and the experiment files. `npm run improve` and the eval page both call
// it, so the command and the button run one pipeline and refuse the same requests with the same
// line: each refusal throws `ImproveRefused`, which the command prints as a usage error and the
// page as a 400; nothing was spent when it is thrown.
import { readFile } from "node:fs/promises";
import path from "node:path";

import { loadQuestions } from "../../eval/questions.js";
import { EVAL_RUNS_DIR, type EvalRecord } from "../../eval/record.js";
import { loadAnswerKey, loadKeyOverlay } from "../../eval/score.js";
import type { Effort, ModelId } from "../agent/agent.js";
import { RUNS_DIR, type RunRecord } from "../agent/record.js";
import { agentVersion } from "../agent/version.js";
import { IMPROVER_EFFORT, IMPROVER_MODEL, loadExperiments, type ImproveInputs } from "./improve.js";
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
} from "./inputs.js";
import { JUDGE_PROMPT, PROPOSER_PROMPT } from "./prompt.js";

/** A reason the improver cannot run on what was asked, said in one line; nothing was spent. */
export class ImproveRefused extends Error {
  override name = "ImproveRefused";
}

/** The record has no failing trace to read: not an error, so the command exits 0 on it. */
export class NothingToDiagnose extends ImproveRefused {
  override name = "NothingToDiagnose";
}

/** What an improver run reads: which eval record, which questions, how many traces each, and the improver's model. */
export interface ImproveRequest {
  /** The eval record under runs/eval/; the latest when absent. */
  evalId?: string;
  /** Questions to diagnose; every question that failed a trial when absent. */
  only?: string[];
  /** Failing traces judged per question, earliest trial first. */
  perQuestion?: number;
  model?: ModelId;
  effort?: Effort;
}

/** The improver's inputs for one request, ready for `improve()`; throws `ImproveRefused` when the request cannot run. */
export async function prepareImprove(request: ImproveRequest = {}): Promise<ImproveInputs> {
  const evalId = request.evalId ?? (await latestEvalId(EVAL_RUNS_DIR));
  if (!evalId) throw new ImproveRefused(`No eval record under ${EVAL_RUNS_DIR}/; run the eval first.`);
  const record: EvalRecord | undefined = await loadEvalRecord(EVAL_RUNS_DIR, evalId);
  if (!record) throw new ImproveRefused(`No eval record ${evalId} under ${EVAL_RUNS_DIR}/.`);

  const questionText = Object.fromEntries((await loadQuestions()).map((q) => [q.id, q.text]));
  const selected = selectTraces(record, questionText, await loadAnswerKey(), { only: request.only, perQuestion: request.perQuestion ?? 1 });
  if ("problem" in selected) throw new ImproveRefused(`${selected.problem}.`);
  const { traces, failing } = selected;
  if (traces.length === 0) {
    const errors = record.summary.errors;
    throw new NothingToDiagnose(
      errors > 0
        ? `No question failed a trial of ${record.evalId}, and ${errors} run(s) threw, which leave no trace to read; nothing to diagnose.`
        : `Every question passed every trial of ${record.evalId}; nothing to diagnose.`,
    );
  }

  const runs = new Map<string, RunRecord>();
  for (const t of traces) {
    const run = await loadRunRecord(RUNS_DIR, t.runId);
    if (!run) throw new ImproveRefused(`Run record ${t.runId} is not under ${RUNS_DIR}/; an eval record from CI needs its artifact's files copied there.`);
    runs.set(t.runId, run);
  }
  const mismatch = checkAgentVersion([...runs.values()], record);
  if (mismatch) throw new ImproveRefused(`${mismatch}.`);

  const audit = await readFile(path.join("eval", "key-audit.md"), "utf8");
  const overlay = await loadKeyOverlay();
  const entries = new Map(traces.map((t) => [t.questionId, auditEntry(audit, t.questionId)]));
  const noEntry = [...entries].filter(([, e]) => !e).map(([id]) => id);
  if (noEntry.length > 0) throw new ImproveRefused(`eval/key-audit.md has no entry for ${noEntry.join(", ")}, so the judge has no reference for it.`);

  const settings = recordSettings(runs.values().next().value!);
  const instructions = agentInstructions(settings);
  const experiments = await loadExperiments();
  const version = agentVersion(settings);
  return {
    record,
    agentVersion: version,
    traces: traces.map((trace) => {
      const amendment = overlay[trace.questionId];
      const entry = entries.get(trace.questionId)!;
      const run = runs.get(trace.runId)!;
      return {
        trace,
        audit: entry,
        steps: traceSteps(run).length,
        judgeUser: judgeMessage({
          trace,
          run,
          evalId: record.evalId,
          audit: entry,
          ...(amendment ? { amended: { ids: amendment.expected_resource_ids, reason: amendment.reason } } : {}),
        }),
      };
    }),
    failing,
    judgeSystem: `${JUDGE_PROMPT}\n\n${instructions}`,
    proposerSystem: `${PROPOSER_PROMPT}\n\n${instructions}`,
    proposerUser: (judged) => proposerMessage({ record, agentVersion: version, judged, failing, experiments }),
    settings: { model: request.model ?? IMPROVER_MODEL, effort: request.effort ?? IMPROVER_EFFORT },
  };
}
