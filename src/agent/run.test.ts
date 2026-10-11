// The turn slice decides what a chat turn's record counts and costs, so it is pinned here
// without a model: a first turn keeps everything, a follow-up keeps only its own messages.
import assert from "node:assert/strict";
import { test } from "node:test";

import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";

import { turnMessages } from "./run.js";

const firstTurn = [
  new HumanMessage("Which production queues have a dead-letter queue?"),
  new AIMessage({ content: "", tool_calls: [{ id: "q1", name: "run_cypher", args: { query: "MATCH (q) RETURN q" } }] }),
  new ToolMessage({ content: "4 rows", tool_call_id: "q1" }),
  new AIMessage("Four of them."),
];

test("a first turn keeps every message", () => {
  assert.deepEqual(turnMessages(firstTurn), firstTurn);
});

test("a follow-up keeps only its own messages, tool calls included", () => {
  const followUp = [
    new HumanMessage("Which of those have a monitor?"),
    new AIMessage({ content: "", tool_calls: [{ id: "q2", name: "run_cypher", args: { query: "MATCH (m) RETURN m" } }] }),
    new ToolMessage({ content: "0 rows", tool_call_id: "q2" }),
    new AIMessage("None."),
  ];
  assert.deepEqual(turnMessages([...firstTurn, ...followUp]), followUp);
});

test("a conversation without a user message is an error, not a silent slice", () => {
  assert.throws(() => turnMessages([new AIMessage("hello")]), /no user message/);
});
