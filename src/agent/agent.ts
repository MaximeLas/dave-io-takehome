// Builds the agent: the model, the tools and the system prompt, in one place.
//
// The model id lives only here. Changing it is its own commit with an eval run, because
// the id also selects a model-specific profile inside deepagents that alters the prompt
// (see docs/facts.md).
import { ChatAnthropic } from "@langchain/anthropic";
import { createDeepAgent, createFilesystemMiddleware } from "deepagents";

import { requireEnv } from "../env.js";
import { SYSTEM_PROMPT } from "./prompt.js";
import { runCypher } from "./tools.js";

/** The model the agent runs on. Changing it is its own commit with an eval run. */
export const MODEL_ID = "claude-sonnet-5-5";

/**
 * What we send besides the model id. Thinking and effort are left at the API's defaults
 * for this model (adaptive thinking, effort "high"); they become explicit settings here
 * the day the eval compares them.
 */
export const MODEL_SETTINGS = { maxTokens: 16_000 } as const;

/** Builds the deepagents agent from the model, the tools and the prompt. */
export function createInfraAgent() {
  const model = new ChatAnthropic({
    model: MODEL_ID,
    apiKey: requireEnv("APP_ANTHROPIC_API_KEY"),
    maxTokens: MODEL_SETTINGS.maxTokens,
  });

  return createDeepAgent({
    model,
    tools: [runCypher],
    systemPrompt: SYSTEM_PROMPT,
    // deepagents adds its filesystem tools (ls, read_file, write_file, glob, grep...) to
    // every agent. They are noise here: the graph is the only source. A middleware with
    // the same name replaces the default one, and `read_file` is the one tool the library
    // requires in an explicit list.
    middleware: [createFilesystemMiddleware({ tools: ["read_file"] })],
  });
}
