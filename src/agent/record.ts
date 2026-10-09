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
  question: string;
  model: string;
  modelSettings: Record<string, unknown>;
  promptVersion: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  modelCalls: number;
  toolCalls: ToolCallRecord[];
  usage: TokenUsage;
  costUsd: number;
  answer: string;
  /** The whole conversation as the library serialises it, for reading a failed run. */
  messages: unknown[];
}

// USD per million tokens, from the published price list (checked 2026-10-08). The cache
// write price is the 5-minute cache, 1.25x input. A model missing here costs NaN on
// purpose: an unknown price must show, not read as free.
export const PRICES_USD_PER_MILLION_TOKENS: Record<
  string,
  { input: number; output: number; cacheRead: number; cacheWrite: number }
> = {
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
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
