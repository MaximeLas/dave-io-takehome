// One fingerprint of everything the model reads, so two run records can be compared at a
// glance and "the agent is unchanged" is a checkable claim. The prompt hash covers the
// system prompt alone; the model also reads every tool's name, description and input
// schema, and behaves differently per model id and settings, so all of it goes in.
//
// What the library adds on its own (deepagents' base prompt, its read_file tool) changes
// only with a dependency upgrade, which the commit and the lockfile already identify, so it
// stays out: the hash should move when our agent changes, not when a package is bumped.
import { createHash } from "node:crypto";

import { z } from "zod";

import { ANSWER_SCHEMA, FINAL_ANSWER_TOOL, type AgentSettings } from "./agent.js";
import { SYSTEM_PROMPT } from "./prompt.js";
import { runCypher, searchDescriptions } from "./tools.js";

/** A tool as the model sees it: its name, its description and its input schema. */
export interface ToolSurface {
  name: string;
  description: string;
  schema: z.ZodType;
}

/** Everything the model reads, the input of the fingerprint. */
export interface AgentSurface {
  systemPrompt: string;
  tools: ToolSurface[];
  settings: AgentSettings;
}

/** The first 8 hex characters of the SHA-256 of a surface; tool order does not count. */
export function fingerprint(surface: AgentSurface): string {
  const tools = [...surface.tools]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((t) => ({ name: t.name, description: t.description, schema: z.toJSONSchema(t.schema) }));
  const canonical = JSON.stringify(sortKeys({ systemPrompt: surface.systemPrompt, tools, settings: surface.settings }));
  return createHash("sha256").update(canonical).digest("hex").slice(0, 8);
}

/** The surface of the agent as it ships, for the given model settings. */
export function agentSurface(settings: AgentSettings): AgentSurface {
  return {
    systemPrompt: SYSTEM_PROMPT,
    tools: [
      { name: runCypher.name, description: runCypher.description, schema: runCypher.schema },
      { name: searchDescriptions.name, description: searchDescriptions.description, schema: searchDescriptions.schema },
      // The answer reaches the model as a tool too; its description lives in the schema's metadata.
      { name: FINAL_ANSWER_TOOL, description: "", schema: ANSWER_SCHEMA },
    ],
    settings: { model: settings.model, effort: settings.effort, maxTokens: settings.maxTokens },
  };
}

/** Identifies the agent in run records: prompt, tools, model and settings in one hash. */
export function agentVersion(settings: AgentSettings): string {
  return fingerprint(agentSurface(settings));
}

// JSON key order follows insertion order; sorting makes the serialisation depend on content only.
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}
