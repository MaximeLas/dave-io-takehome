// The record of one agent run: what was asked, what the agent did, what it cost.
//
// One JSON file per run, under `runs/` (gitignored). The eval reads these to score the
// trajectory (which tools, how many calls, what they cost) beside the answer, and the UI
// can show them. A database would replace the folder; the shape stays.
//
// LangSmith tracing is the richer alternative and needs no code: setting
// LANGSMITH_TRACING=true and LANGSMITH_API_KEY in the environment turns it on for the
// whole LangChain stack. This record is the portable subset that runs anywhere, CI included.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** One tool call the model made, with what the tool returned. */
export interface ToolCallRecord {
  name: string;
  input: unknown;
  output: string;
  isError: boolean;
}

/** The tokens of one run, summed over its model calls, in LangChain's provider-neutral shape. */
export interface TokenUsage {
  /** All input tokens, the cached ones included (LangChain's convention). */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/** Everything the eval, the UI and a developer need to know about one run. */
export interface RunRecord {
  runId: string;
  questionId: string | null;
  /** The conversation this run is one turn of; a chat's turns share it, an eval question has its own. */
  threadId: string;
  question: string;
  model: string;
  modelSettings: Record<string, unknown>;
  promptVersion: string;
  /** The model that embeds search phrases; the description index must have been built by the same one. */
  embeddingModel: string;
  /** The git commit the code ran from, "-dirty" when the tree had changes; "unknown" outside git. */
  codeVersion: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  modelCalls: number;
  /** Why each model call ended, in order (`tool_use`, `end_turn`, `max_tokens`…); the last says why the run stopped. */
  stopReasons: string[];
  toolCalls: ToolCallRecord[];
  usage: TokenUsage;
  costUsd: number;
  /** The answer as prose, for the user. */
  answer: string;
  /** The resource ids the answer asserts, for the eval; empty for "none". */
  ids: string[];
  /** This turn's messages, from the user's on, as the library serialises them; earlier turns are in the records that share its `threadId`. */
  messages: unknown[];
}

// USD per million tokens, from the published price list (checked 2026-10-09). The cache
// write price is the 5-minute cache, 1.25x input; cache reads are the published rate per
// model. Haiku's prices hold for prompts under 100k tokens, which every call here is.
// A model missing here costs NaN on purpose: an unknown price must show, not read as free.
export const PRICES_USD_PER_MILLION_TOKENS: Record<
  string,
  { input: number; output: number; cacheRead: number; cacheWrite: number }
> = {
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
};

/** The run's cost in USD from the price table; NaN for a model without a price. */
export function costUsd(model: string, usage: TokenUsage): number {
  const price = PRICES_USD_PER_MILLION_TOKENS[model];
  if (!price) return Number.NaN;
  // `inputTokens` is the total LangChain reports, cached tokens included; only the
  // remainder is billed at the full input price.
  const uncachedInputTokens = usage.inputTokens - usage.cacheReadTokens - usage.cacheCreationTokens;
  return (
    (uncachedInputTokens * price.input +
      usage.outputTokens * price.output +
      usage.cacheReadTokens * price.cacheRead +
      usage.cacheCreationTokens * price.cacheWrite) /
    1_000_000
  );
}

export const RUNS_DIR = "runs";

/** Writes the record under runs/ as one JSON file and returns its path. */
export async function saveRun(record: RunRecord): Promise<string> {
  await mkdir(RUNS_DIR, { recursive: true });
  const file = path.join(RUNS_DIR, `${record.runId}.json`);
  await writeFile(file, JSON.stringify(record, null, 2));
  return file;
}
