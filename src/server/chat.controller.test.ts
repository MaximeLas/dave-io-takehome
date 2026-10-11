// The chat endpoint's contract, pinned without a model or a database: the real module and
// HTTP setup (configureApp, as the server runs it) with the chat service replaced by a stub,
// so what is tested is parsing and validation; then the service's one rule that needs no
// agent run (an unknown conversation), and the page's model list against the server's. The
// service's other rules need a finished turn (a conversation keeps its model, one turn per
// conversation at a time) and were checked against the running server instead.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";

import { NotFoundException } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";

import { DEFAULT_MODEL } from "../agent/agent.js";
import { APP_OPTIONS, configureApp } from "./app.js";
import { AppModule } from "./app.module.js";
import { CHAT_MODELS, ChatService, type ChatReply, type TurnOptions } from "./chat.service.js";

const THREAD = "6db71b61-72ee-4528-baf6-08b1ef48696f";

const calls: Array<{ message: string; options: TurnOptions }> = [];
const stub = {
  async reply(message: string, options: TurnOptions): Promise<ChatReply> {
    calls.push({ message, options });
    return {
      threadId: THREAD,
      answer: "None.",
      ids: [],
      unstructuredReply: null,
      trace: { runId: "r", startedAt: "", model: "m", effort: "high", modelCalls: 1, durationMs: 1, costUsd: 0, steps: [] },
    };
  },
};

let app: NestExpressApplication;
let base: string;

before(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ChatService)
    .useValue(stub)
    .compile();
  app = configureApp(moduleRef.createNestApplication<NestExpressApplication>({ ...APP_OPTIONS, logger: false }));
  await app.listen(0, "127.0.0.1");
  base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
});
after(() => app.close());
beforeEach(() => {
  calls.length = 0;
});

function postJson(body: unknown) {
  return fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function rejection(response: Response): Promise<string> {
  assert.equal(response.status, 400);
  assert.equal(calls.length, 0, "a rejected request must not reach the agent");
  return ((await response.json()) as { message: string }).message;
}

test("a valid turn reaches the service with the trimmed message, the thread and the model", async () => {
  const response = await postJson({ message: "  Which queues?  ", threadId: THREAD, model: "claude-haiku-5-5" });
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as ChatReply).threadId, THREAD);
  assert.deepEqual(calls, [{ message: "Which queues?", options: { threadId: THREAD, model: "claude-haiku-5-5" } }]);
});

test("a new conversation may leave the model out, and the service picks the default", async () => {
  const response = await postJson({ message: "Which queues?" });
  assert.equal(response.status, 200);
  assert.deepEqual(calls[0]?.options, { threadId: undefined, model: undefined });
});

test("each invalid field is named in the error", async () => {
  assert.equal(await rejection(await postJson({})), "The message is missing.");
  assert.equal(await rejection(await postJson({ message: 42 })), "The message must be text.");
  assert.equal(await rejection(await postJson({ message: "   " })), "The message is empty.");
  assert.equal(await rejection(await postJson({ message: "x".repeat(2_001) })), "The message is over 2,000 characters.");
  assert.equal(await rejection(await postJson({ message: "hi", threadId: "abc" })), "threadId must be the id a previous reply returned.");
  assert.equal(
    await rejection(await postJson({ message: "hi", model: "claude-opus-5-5" })),
    "model must be one of claude-sonnet-5-5, claude-haiku-5-5.",
  );
});

test("a form post, which any website can send cross-site, is refused before the agent", async () => {
  const response = await fetch(`${base}/api/chat`, { method: "POST", body: new URLSearchParams({ message: "hi" }) });
  assert.equal(await rejection(response), "Send a JSON body: { message, threadId?, model? }.");
});

test("the record route accepts run ids only", async () => {
  const response = await fetch(`${base}/api/runs/${encodeURIComponent("../.env")}`);
  assert.equal(response.status, 400);
});

test("a conversation the server does not hold is a 404, before any agent run", async () => {
  await assert.rejects(new ChatService().reply("Which of those?", { threadId: THREAD }), NotFoundException);
});

test("the page offers exactly the chat models, the shipped default first", async () => {
  const page = await readFile("web/index.html", "utf8");
  const options = [...page.matchAll(/<option value="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(options, [...CHAT_MODELS]);
  assert.equal(CHAT_MODELS[0], DEFAULT_MODEL);
});
