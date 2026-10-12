// The agent version must move exactly when what the model reads moves: pinned here without a
// model or a database, on the shipped surface and on variations of it.
import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_EFFORT, DEFAULT_MODEL, MAX_TOKENS } from "./agent.js";
import { agentSurface, agentVersion, fingerprint } from "./version.js";

const shipped = { model: DEFAULT_MODEL, effort: DEFAULT_EFFORT, maxTokens: MAX_TOKENS };

test("the agent version is stable across calls", () => {
  assert.equal(agentVersion(shipped), agentVersion(shipped));
  assert.match(agentVersion(shipped), /^[0-9a-f]{8}$/);
});

test("a changed tool description changes it", () => {
  const surface = agentSurface(shipped);
  const edited = { ...surface, tools: surface.tools.map((t, i) => (i === 0 ? { ...t, description: `${t.description} ` } : t)) };
  assert.notEqual(fingerprint(edited), fingerprint(surface));
});

test("a changed effort changes it", () => {
  assert.notEqual(agentVersion({ ...shipped, effort: "low" }), agentVersion(shipped));
});

test("the order the tools are listed in does not change it", () => {
  const surface = agentSurface(shipped);
  assert.equal(fingerprint({ ...surface, tools: [...surface.tools].reverse() }), fingerprint(surface));
});
