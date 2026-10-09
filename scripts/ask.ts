// Ask the agent one question and print its trace: every tool call, the answer, the cost.
//
//   npm run ask -- dlq-for-prod-2                 (an eval question, by id)
//   npm run ask -- "Which queues have no DLQ?"    (any question)
//
// The run is saved under runs/ as JSON, the same record the eval reads.
import { findQuestion } from "../eval/questions.js";
import { saveRun } from "../src/agent/record.js";
import { runAgent } from "../src/agent/run.js";
import { closeDriver } from "../src/graph/driver.js";

const OUTPUT_PREVIEW_LINES = 12;

const arg = process.argv.slice(2).join(" ").trim();
if (!arg) {
  console.error("Usage: npm run ask -- <question-id | question text>");
  process.exit(1);
}

const known = await findQuestion(arg);
const input = known ? { question: known.text, questionId: known.id } : { question: arg };

console.log(`Q${known ? ` [${known.id}]` : ""}: ${input.question}\n`);

try {
  const record = await runAgent(input);

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
  console.log();
  console.log(
    `model ${record.model}, prompt ${record.promptVersion}, ${record.modelCalls} model calls, ` +
      `${record.toolCalls.length} tool calls, ${(record.durationMs / 1000).toFixed(1)} s`,
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
