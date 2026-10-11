// Builds the agent: the model, the tools, the system prompt and the answer shape, in one place.
//
// The model id and the effort are parameters so the eval can compare them, with the defaults
// here being what ships. Changing a default is its own commit with an eval run, because the
// model id also selects a model-specific profile inside deepagents that alters the prompt
// (see docs/facts.md).
import { ChatAnthropic } from "@langchain/anthropic";
import { createDeepAgent, createFilesystemMiddleware } from "deepagents";
import { createMiddleware, toolStrategy } from "langchain";
import { z } from "zod";

import { requireEnv } from "../env.js";
import { IDS_RULE, SYSTEM_PROMPT } from "./prompt.js";
import { runCypher } from "./tools.js";

/** The models the agent can run on; a model is listed once its price row exists in record.ts. */
export const MODEL_IDS = ["claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5-5"] as const;
/** One of MODEL_IDS. */
export type ModelId = (typeof MODEL_IDS)[number];

/** Anthropic's effort levels. Defaults differ by model, so comparisons always set it. */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
/** One of EFFORTS. */
export type Effort = (typeof EFFORTS)[number];

/** The model and effort the agent ships with. Changing either is its own commit with an eval run. */
export const DEFAULT_MODEL: ModelId = "claude-sonnet-5-5";
export const DEFAULT_EFFORT: Effort = "high";

/** The settings of one agent instance. */
export interface AgentSettings {
  model: ModelId;
  effort: Effort;
  maxTokens: number;
}

export const MAX_TOKENS = 16_000;

/** The name of the tool the model calls to answer, as it appears in the trace. */
export const FINAL_ANSWER_TOOL = "final_answer";

/**
 * The shape of every answer. One shape serves the chat (the prose) and the eval (the ids),
 * so what is scored is what the user reads. The descriptions are instructions to the model.
 *
 * The model delivers it by calling a tool of this shape (the library's tool strategy), the
 * one way that keeps the loop free: the provider's native JSON format constrains every turn,
 * and a model constrained from its first turn answered empty without querying (see docs/facts.md).
 */
export const ANSWER_SCHEMA = z
  .object({
    answer: z
      .string()
      .describe(
        "The answer for the user, in prose: the finding, then what you did and how you verified it. Name resources by their id property.",
      ),
    ids: z.array(z.string()).describe(IDS_RULE),
  })
  .meta({
    title: FINAL_ANSWER_TOOL,
    description: "Deliver the final answer. Call it once, when the question is answered and verified.",
  });

/** The parsed final answer. */
export type Answer = z.infer<typeof ANSWER_SCHEMA>;

// The tool strategy forces a tool call on every turn (`tool_choice: any`), which the
// current models reject with a 400. This leaves the choice to the model: it queries while
// it needs to and calls final_answer when done.
const unforcedToolChoice = createMiddleware({
  name: "unforced-tool-choice",
  wrapModelCall: (request, handler) => handler({ ...request, toolChoice: "auto" }),
});

/** Builds the deepagents agent from the model, the tools, the prompt and the answer shape. */
export function createInfraAgent(settings: AgentSettings) {
  const model = new ChatAnthropic({
    model: settings.model,
    apiKey: requireEnv("APP_ANTHROPIC_API_KEY"),
    maxTokens: settings.maxTokens,
    outputConfig: { effort: settings.effort },
  });

  return createDeepAgent({
    model,
    tools: [runCypher],
    systemPrompt: SYSTEM_PROMPT,
    responseFormat: toolStrategy(ANSWER_SCHEMA),
    // deepagents adds its filesystem tools (ls, read_file, write_file, glob, grep...) to
    // every agent. They are noise here: the graph is the only source. A middleware with
    // the same name replaces the default one, and `read_file` is the one tool the library
    // requires in an explicit list.
    middleware: [createFilesystemMiddleware({ tools: ["read_file"] }), unforcedToolChoice],
  });
}
