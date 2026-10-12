// The one entry point that runs the agent on a question. The eval harness and the server
// both call it, so what is scored is exactly what ships.
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { HumanMessage, isAIMessage, isToolMessage, type BaseMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";

import {
  ANSWER_SCHEMA,
  createInfraAgent,
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  FINAL_ANSWER_TOOL,
  MAX_TOKENS,
  type AgentSettings,
  type Answer,
  type Effort,
  type ModelId,
} from "./agent.js";
import { EMBEDDING_MODEL_ID } from "../search/model.js";
import { PROMPT_VERSION } from "./prompt.js";
import { agentVersion } from "./version.js";
import { costUsd, type RunRecord, type TokenUsage, type ToolCallRecord } from "./record.js";

/** A question for the agent, with its eval id when it is one of the fixed thirty. */
export interface RunInput {
  question: string;
  questionId?: string;
  /** The conversation the question continues; without one, the run starts a new conversation. */
  threadId?: string;
}

/** What a caller may vary per run; anything left out takes the shipped default. */
export interface RunOptions {
  model?: ModelId;
  effort?: Effort;
  /** Aborts the run (the invoke throws) when it fires; the eval uses it as a per-question deadline. */
  signal?: AbortSignal;
}

const agents = new Map<string, ReturnType<typeof createInfraAgent>>();

// Every conversation's messages, by thread id, held in this process's memory: it keeps
// every step of every conversation until the process ends, and a restart forgets them all,
// which a demo chat can afford. A persistent checkpointer (Postgres, SQLite) is a drop-in
// replacement. An eval question gets a fresh thread, so it runs through the same agent the
// chat uses and still starts from an empty conversation.
const conversations = new MemorySaver();

/**
 * The messages of the latest turn: from the last user message to the end. The agent returns
 * the whole conversation, and earlier turns have their own records, so a turn's record must
 * not count them again.
 */
export function turnMessages(conversation: BaseMessage[]): BaseMessage[] {
  const start = conversation.findLastIndex((m) => HumanMessage.isInstance(m));
  if (start === -1) throw new Error("The conversation has no user message.");
  return conversation.slice(start);
}

/**
 * Runs the agent on one question, continuing `input.threadId` when given, and returns the
 * record of this turn alone. Saving the record is the caller's call.
 */
export async function runAgent(input: RunInput, options: RunOptions = {}): Promise<RunRecord> {
  const settings: AgentSettings = {
    model: options.model ?? DEFAULT_MODEL,
    effort: options.effort ?? DEFAULT_EFFORT,
    maxTokens: MAX_TOKENS,
  };
  const key = `${settings.model}/${settings.effort}`;
  let agent = agents.get(key);
  if (!agent) {
    agent = createInfraAgent(settings, conversations);
    agents.set(key, agent);
  }

  const threadId = input.threadId ?? randomUUID();
  const startedAt = new Date();
  const result = await agent.invoke(
    { messages: [{ role: "user", content: input.question }] },
    { configurable: { thread_id: threadId }, ...(options.signal ? { signal: options.signal } : {}) },
  );
  const finishedAt = new Date();

  const messages = turnMessages(result.messages as BaseMessage[]);
  const { modelCalls, stopReasons, toolCalls, usage } = readTrace(messages);
  const answer = readAnswer(result.structuredResponse);

  return {
    runId: `${startedAt.toISOString().replace(/[:.]/g, "-")}-${input.questionId ?? "adhoc"}`,
    questionId: input.questionId ?? null,
    threadId,
    question: input.question,
    model: settings.model,
    modelSettings: { effort: settings.effort, maxTokens: settings.maxTokens },
    promptVersion: PROMPT_VERSION,
    agentVersion: agentVersion(settings),
    embeddingModel: EMBEDDING_MODEL_ID,
    codeVersion: codeVersion(),
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    modelCalls,
    stopReasons,
    toolCalls,
    usage,
    costUsd: costUsd(settings.model, usage),
    answer: answer.answer,
    ids: answer.ids,
    messages: messages.map((m) => m.toDict()),
  };
}

// The structured response is what the library parsed from the final_answer call. It is
// re-validated here so a record never carries a shape the eval cannot read. A run that
// ends in prose without the call is recorded with an empty answer, which the eval must
// score as a failure whatever the ids say (an empty list is also the right answer to
// "none"); how often that happens is the prompt's problem to fix, measured, not a retry's.
function readAnswer(structuredResponse: unknown): Answer {
  const parsed = ANSWER_SCHEMA.safeParse(structuredResponse);
  return parsed.success ? parsed.data : { answer: "", ids: [] };
}

// Walks the conversation the agent produced. Each AI message is one model call; its
// tool_calls are matched to the tool messages that answered them by id. The final_answer
// call is the answer itself, not a lookup, so it is left out of the tool calls. The stop
// reason is kept per call so a run cut at the token limit reads as that, not as a wrong
// answer. An AI message without one is not a model call: the library appends one after
// final_answer to carry the parsed answer.
function readTrace(messages: BaseMessage[]): {
  modelCalls: number;
  stopReasons: string[];
  toolCalls: ToolCallRecord[];
  usage: TokenUsage;
} {
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  const pending = new Map<string, ToolCallRecord>();
  const toolCalls: ToolCallRecord[] = [];
  const stopReasons: string[] = [];
  let modelCalls = 0;

  for (const message of messages) {
    if (isAIMessage(message)) {
      const stopReason = message.response_metadata?.stop_reason;
      if (stopReason === undefined) continue;
      modelCalls += 1;
      stopReasons.push(String(stopReason));
      const u = message.usage_metadata;
      if (u) {
        usage.inputTokens += u.input_tokens;
        usage.outputTokens += u.output_tokens;
        usage.cacheReadTokens += u.input_token_details?.cache_read ?? 0;
        usage.cacheCreationTokens += u.input_token_details?.cache_creation ?? 0;
      }
      for (const call of message.tool_calls ?? []) {
        if (call.name === FINAL_ANSWER_TOOL) continue;
        const record: ToolCallRecord = { name: call.name, input: call.args, output: "", isError: false };
        toolCalls.push(record);
        if (call.id) pending.set(call.id, record);
      }
    } else if (isToolMessage(message)) {
      const record = pending.get(message.tool_call_id);
      if (record) {
        record.output = message.text;
        record.isError = message.status === "error" || message.text.startsWith("Cypher error:");
      }
    }
  }
  return { modelCalls, stopReasons, toolCalls, usage };
}

// The commit the code ran from, with "-dirty" when the working tree had changes, so a
// score move can be attributed to a code change (the tool's text is read by the model
// too, and the prompt hash alone does not cover it). Unknown outside a git checkout.
let cachedCodeVersion: string | undefined;
/** The git commit the code runs from, "-dirty" when the tree has changes; also stamped on eval records. */
export function codeVersion(): string {
  if (cachedCodeVersion === undefined) {
    try {
      const commit = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
      const dirty = execSync("git status --porcelain", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() !== "";
      cachedCodeVersion = dirty ? `${commit}-dirty` : commit;
    } catch {
      cachedCodeVersion = "unknown";
    }
  }
  return cachedCodeVersion;
}
