// Ask the agent one question and print its trace: every tool call, the answer, the cost.
//
//   npm run ask -- dlq-for-prod-2                          (an eval question, by id)
//   npm run ask -- "Which queues have no DLQ?"             (any question)
//   npm run ask -- --model claude-haiku-5-5 --effort medium dlq-for-prod-2
//   npm run ask -- --list                                  (every eval question with its id)
//
// Model and effort default to what ships. The run is saved under runs/ as JSON, the same
// record the eval reads.
import { parseArgs } from "node:util";

import { findQuestion, loadQuestions } from "../eval/questions.js";
import { cents } from "../eval/record.js";
import { DEFAULT_EFFORT, DEFAULT_MODEL, EFFORTS, MODEL_IDS, type Effort, type ModelId } from "../src/agent/agent.js";
import { saveRun } from "../src/agent/record.js";
import { runAgent } from "../src/agent/run.js";
import { answerHelp, argsError, field, localTime, reportFailure, usageError } from "../src/cli.js";
import { closeDriver } from "../src/graph/driver.js";

const OUTPUT_PREVIEW_LINES = 12;
const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

answerHelp(`
npm run ask: asks the agent one question and prints its trace: every tool call, the answer, the cost.

Arguments and options:
  <id> | "<question>"   an eval question's id (see --list), or any question in quotes
  --list                print every eval question with its id, then exit; no model call
  --model <id>          ${MODEL_IDS.join(", ")} (default: ${DEFAULT_MODEL}, what ships)
  --effort <level>      ${EFFORTS.join(", ")} (default: ${DEFAULT_EFFORT}, what ships)
  --help                print this help

The run is saved under runs/ as JSON; an eval question costs about a cent.

Examples:
  npm run ask -- dlq-for-prod-2
  npm run ask -- "Which queues have no dead-letter queue?"
`);

// Every usage error is caught here, before the model is called, so a typo costs nothing.
const usage = (message: string): never => usageError(message, "npm run ask");
const { values, positionals } = (() => {
  try {
    return parseArgs({
      options: { model: { type: "string" }, effort: { type: "string" }, list: { type: "boolean", default: false } },
      allowPositionals: true,
    });
  } catch (error) {
    return usage(argsError(error));
  }
})();

if (values.list) {
  const questions = await loadQuestions();
  const width = Math.max(...questions.map((q) => q.id.length));
  for (const q of questions) console.log(`${q.id.padEnd(width)}  ${q.text}`);
  process.exit(0);
}
if (values.model !== undefined && !MODEL_IDS.includes(values.model as ModelId)) usage(`Unknown model ${values.model}; one of ${MODEL_IDS.join(", ")}.`);
if (values.effort !== undefined && !EFFORTS.includes(values.effort as Effort)) usage(`Unknown effort ${values.effort}; one of ${EFFORTS.join(", ")}.`);
const arg = positionals.join(" ").trim();
if (!arg) usage("Give an eval question's id or a question in quotes.");

const known = await findQuestion(arg);
// One word that is not an id is almost always a mistyped id, not a question worth a model call.
if (!known && !/\s/.test(arg)) {
  usageError(`No eval question has the id ${arg}; npm run ask -- --list prints them all (they are also in eval/QUESTIONS.md).`);
}
const input = known ? { question: known.text, questionId: known.id } : { question: arg };
const options = { model: values.model as ModelId | undefined, effort: values.effort as Effort | undefined };

console.log(`Q${known ? ` [${known.id}]` : ""}: ${input.question}\n`);

try {
  const record = await runAgent(input, options);

  record.toolCalls.forEach((call, i) => {
    const query = typeof call.input === "object" && call.input && "query" in call.input
      ? String((call.input as { query: unknown }).query)
      : JSON.stringify(call.input);
    console.log(`--- tool call ${i + 1}: ${call.name}${call.isError ? " (error)" : ""}`);
    console.log(query);
    const lines = call.output.split("\n");
    console.log(lines.slice(0, OUTPUT_PREVIEW_LINES).map((l) => `  > ${l}`).join("\n"));
    if (lines.length > OUTPUT_PREVIEW_LINES) console.log(`  > … ${lines.length - OUTPUT_PREVIEW_LINES} more lines`);
    console.log();
  });

  console.log("--- answer");
  console.log(record.answer);
  console.log(`--- ids (${record.ids.length})`);
  console.log(record.ids.join("\n"));
  const { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens } = record.usage;
  console.log(
    [
      "",
      field("cost", cents(record.costUsd)),
      field("time", `${(record.durationMs / 1000).toFixed(1)}s`),
      field("calls", `${plural(record.modelCalls, "model call")} (last stop: ${record.stopReasons.at(-1) ?? "unknown"}), ${plural(record.toolCalls.length, "tool call")}`),
      field("tokens", `${inputTokens} in, ${outputTokens} out, ${cacheReadTokens} cache read, ${cacheCreationTokens} cache write`),
      field("model", `${record.model}, effort ${String(record.modelSettings.effort)}`),
      field("version", `prompt ${record.promptVersion}, agent ${record.agentVersion}, code ${record.codeVersion}`),
      field("started", localTime(new Date(record.startedAt))),
      "",
      field("saved", await saveRun(record)),
    ].join("\n"),
  );
} catch (error) {
  reportFailure(error);
} finally {
  await closeDriver();
}
