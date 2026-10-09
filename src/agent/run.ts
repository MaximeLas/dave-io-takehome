// The one entry point that runs the agent on a question. The eval harness and the server
// both call it, so what is scored is exactly what ships.
import { isAIMessage, isToolMessage, type BaseMessage } from "@langchain/core/messages";

import { createInfraAgent, MODEL_ID, MODEL_SETTINGS } from "./agent.js";
import { PROMPT_VERSION } from "./prompt.js";
import { costUsd, type RunRecord, type TokenUsage, type ToolCallRecord } from "./record.js";

/** A question for the agent, with its eval id when it is one of the fixed thirty. */
export interface RunInput {
  question: string;
  questionId?: string;
}

let agent: ReturnType<typeof createInfraAgent> | undefined;

/** Runs the agent on one question and returns its record. Saving the record is the caller's call. */
export async function runAgent(input: RunInput): Promise<RunRecord> {
  agent ??= createInfraAgent();

  const startedAt = new Date();
  const result = await agent.invoke({ messages: [{ role: "user", content: input.question }] });
  const finishedAt = new Date();

  const messages = result.messages as BaseMessage[];
  const { modelCalls, toolCalls, usage, answer } = readTrace(messages);

  return {
    runId: `${startedAt.toISOString().replace(/[:.]/g, "-")}-${input.questionId ?? "adhoc"}`,
    questionId: input.questionId ?? null,
    question: input.question,
    model: MODEL_ID,
    modelSettings: { ...MODEL_SETTINGS },
    promptVersion: PROMPT_VERSION,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    modelCalls,
    toolCalls,
    usage,
    costUsd: costUsd(MODEL_ID, usage),
    answer,
    messages: messages.map((m) => m.toDict()),
  };
}

// Walks the conversation the agent produced. Each AI message is one model call; its
// tool_calls are matched to the tool messages that answered them by id. The last AI
// message without tool calls is the answer.
function readTrace(messages: BaseMessage[]): {
  modelCalls: number;
  toolCalls: ToolCallRecord[];
  usage: TokenUsage;
  answer: string;
} {
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  const pending = new Map<string, ToolCallRecord>();
  const toolCalls: ToolCallRecord[] = [];
  let modelCalls = 0;
  let answer = "";

  for (const message of messages) {
    if (isAIMessage(message)) {
      modelCalls += 1;
      const u = message.usage_metadata;
      if (u) {
        usage.inputTokens += u.input_tokens;
        usage.outputTokens += u.output_tokens;
        usage.cacheReadTokens += u.input_token_details?.cache_read ?? 0;
        usage.cacheCreationTokens += u.input_token_details?.cache_creation ?? 0;
      }
      for (const call of message.tool_calls ?? []) {
        const record: ToolCallRecord = { name: call.name, input: call.args, output: "", isError: false };
        toolCalls.push(record);
        if (call.id) pending.set(call.id, record);
      }
      if (!message.tool_calls?.length && message.text) answer = message.text;
    } else if (isToolMessage(message)) {
      const record = pending.get(message.tool_call_id);
      if (record) {
        record.output = message.text;
        record.isError = message.status === "error" || message.text.startsWith("Cypher error:");
      }
    }
  }
  return { modelCalls, toolCalls, usage, answer };
}
