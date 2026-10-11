// One chat turn: run the agent on the message, save the run record, and hand the page what
// it shows. The agent call is runAgent, the same entry point the eval scores, so a chat
// answer is produced exactly as an eval answer is; only the thread id differs.
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  GatewayTimeoutException,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationShutdown,
} from "@nestjs/common";

import { DEFAULT_MODEL, type ModelId } from "../agent/agent.js";
import { RUNS_DIR, saveRun, type RunRecord } from "../agent/record.js";
import { runAgent } from "../agent/run.js";
import { closeDriver } from "../graph/driver.js";

// How long one turn may take before the server gives up on it; answers usually take 10 to 60 s.
const TURN_DEADLINE_MS = 120_000;

/**
 * The models a chat may use: Haiku, which ships, and Sonnet, for comparing answers. Opus is left
 * out so that no request can pick the most expensive model. A new conversation without a
 * model gets DEFAULT_MODEL, the configuration the eval runs by default, so that what a user
 * gets without choosing is what is measured. The page lists these in this order, the
 * default first; a test holds the page, this list and DEFAULT_MODEL together.
 */
export const CHAT_MODELS = ["claude-haiku-5-5", "claude-sonnet-5-5"] as const satisfies readonly ModelId[];

/** One of CHAT_MODELS. */
export type ChatModel = (typeof CHAT_MODELS)[number];

/** What a turn may set besides the message: the conversation it continues, the model of a new one. */
export interface TurnOptions {
  threadId?: string;
  model?: ChatModel;
}

/** One tool call as the page shows it: the query, and the first line of what came back. */
export interface TraceStep {
  tool: string;
  /** The Cypher for the query tool; the JSON input for any other tool. */
  input: string;
  /** The tool result's first line: the row count, or the error. */
  result: string;
  isError: boolean;
}

/** What a chat turn returns: the answer as the eval scores it, plus the trace the page folds away. */
export interface ChatReply {
  threadId: string;
  answer: string;
  ids: string[];
  /**
   * When the model ended in prose without calling final_answer, that prose: shown so the user
   * is not left with nothing, while the record keeps the empty answer the eval scores as a miss.
   */
  unstructuredReply: string | null;
  trace: {
    runId: string;
    /** When the turn started, as an ISO timestamp. */
    startedAt: string;
    model: string;
    effort: string;
    modelCalls: number;
    durationMs: number;
    costUsd: number;
    steps: TraceStep[];
  };
}

/** Runs chat turns through the agent and records each one. */
@Injectable()
export class ChatService implements OnApplicationShutdown {
  private readonly logger = new Logger(ChatService.name);
  // LangGraph does not lock a thread: two turns at once on one conversation would both start
  // from the same state, and one of them would vanish from it. One turn per thread at a time.
  private readonly busyThreads = new Set<string>();
  // The conversations this server has answered, each with the model it started with. A
  // conversation keeps its model: a follow-up that sent none would otherwise fall back to the
  // default, and its earlier turns would be read by a model that did not write them. Held in
  // memory, like the agent's copy of the messages, so a restart forgets both together.
  private readonly threadModels = new Map<string, ModelId>();

  /** Answers one message, continuing the conversation when a thread id is given. */
  async reply(message: string, { threadId, model }: TurnOptions = {}): Promise<ChatReply> {
    let turnModel: ModelId = model ?? DEFAULT_MODEL;
    if (threadId !== undefined) {
      const threadModel = this.threadModels.get(threadId);
      if (threadModel === undefined) {
        throw new NotFoundException("This conversation is no longer on the server, which keeps them in memory. Start a new one.");
      }
      if (model !== undefined && model !== threadModel) {
        throw new BadRequestException(`This conversation uses ${threadModel}. Start a new conversation to change the model.`);
      }
      if (this.busyThreads.has(threadId)) {
        throw new ConflictException("This conversation is still answering the previous message.");
      }
      turnModel = threadModel;
      this.busyThreads.add(threadId);
    }

    const signal = AbortSignal.timeout(TURN_DEADLINE_MS);
    let record: RunRecord;
    try {
      record = await runAgent({ question: message, threadId }, { model: turnModel, signal });
    } catch (error) {
      if (signal.aborted) {
        throw new GatewayTimeoutException(`No answer within ${TURN_DEADLINE_MS / 1000} s. Try a narrower question.`);
      }
      this.logger.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
      const status = (error as { status?: unknown }).status;
      throw new BadGatewayException(
        `The agent could not finish this turn${typeof status === "number" ? ` (the model API answered ${status})` : ""}. Try again in a moment.`,
      );
    } finally {
      if (threadId !== undefined) this.busyThreads.delete(threadId);
    }

    this.threadModels.set(record.threadId, turnModel);
    const file = await saveRun(record);
    this.logger.log(
      `thread ${record.threadId}: ${record.toolCalls.length} tool calls, ` +
        `${(record.durationMs / 1000).toFixed(1)} s, $${record.costUsd.toFixed(4)}, saved ${file}`,
    );
    return toReply(record);
  }

  /** The full saved record of one turn, as JSON text, for the page's "Full run record" link. */
  async runRecord(runId: string): Promise<string> {
    try {
      return await readFile(path.join(RUNS_DIR, `${runId}.json`), "utf8");
    } catch {
      throw new NotFoundException(`No run record ${runId}.`);
    }
  }

  /** Closes the Neo4j connection pool when the server stops. */
  async onApplicationShutdown(): Promise<void> {
    await closeDriver();
  }
}

// The slice of the run record the page needs. The answer's two fields pass through
// unchanged: what the user reads is what the eval scores.
function toReply(record: RunRecord): ChatReply {
  return {
    threadId: record.threadId,
    answer: record.answer,
    ids: record.ids,
    unstructuredReply: record.answer ? null : closingText(record.messages),
    trace: {
      runId: record.runId,
      startedAt: record.startedAt,
      model: record.model,
      effort: String(record.modelSettings.effort),
      modelCalls: record.modelCalls,
      durationMs: record.durationMs,
      costUsd: record.costUsd,
      steps: record.toolCalls.map((call) => ({
        tool: call.name,
        input: queryText(call.input),
        result: call.output.split("\n", 1)[0] ?? "",
        isError: call.isError,
      })),
    },
  };
}

function queryText(input: unknown): string {
  if (typeof input === "object" && input !== null && "query" in input) return String(input.query);
  return JSON.stringify(input);
}

// The text of the turn's last AI message, from the serialised messages of the record
// (`{ type: "ai", data: { content } }`, where content is a string or a list of blocks).
function closingText(messages: unknown[]): string | null {
  for (const message of [...messages].reverse()) {
    const { type, data } = message as { type?: string; data?: { content?: unknown } };
    if (type !== "ai") continue;
    const content = data?.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.filter((b) => b?.type === "text").map((b) => String(b.text)).join("\n\n")
          : "";
    return text.trim() || null;
  }
  return null;
}
