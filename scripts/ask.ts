// Ask the agent one question and print its trace: every tool call, the answer, the cost.
//
//   npm run ask -- dlq-for-prod-2                          (an eval question, by id)
//   npm run ask -- "Which queues have no DLQ?"             (any question)
//   npm run ask -- --model claude-haiku-5-5 --effort medium dlq-for-prod-2
//
// Model and effort default to what ships. The run is saved under runs/ as JSON, the same
// record the eval reads.
import { parseArgs } from "node:util";

import { findQuestion } from "../eval/questions.js";
import type { Effort, ModelId } from "../src/agent/agent.js";
import { saveRun } from "../src/agent/record.js";
import { runAgent } from "../src/agent/run.js";
import { closeDriver } from "../src/graph/driver.js";

const OUTPUT_PREVIEW_LINES = 12;

const { values, positionals } = parseArgs({
  options: { model: { type: "string" }, effort: { type: "string" } },
  allowPositionals: true,
});
const arg = positionals.join(" ").trim();
if (!arg) {
  console.error("Usage: npm run ask -- [--model <id>] [--effort <level>] <question-id | question text>");
  process.exit(1);
}

const known = await findQuestion(arg);
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
  console.log();
  console.log(
    `model ${record.model}, effort ${String(record.modelSettings.effort)}, prompt ${record.promptVersion}, ` +
      `code ${record.codeVersion}, ${record.modelCalls} model calls, ${record.toolCalls.length} tool calls, ` +
      `${(record.durationMs / 1000).toFixed(1)} s`,
  );
  const { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens } = record.usage;
  console.log(
    `tokens: ${inputTokens} in, ${outputTokens} out, ${cacheReadTokens} cache read, ` +
      `${cacheCreationTokens} cache write; cost $${record.costUsd.toFixed(4)}`,
  );
  console.log(`saved ${await saveRun(record)}`);
} finally {
  await closeDriver();
}
