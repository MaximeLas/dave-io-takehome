// The chat endpoints: validate the request and hand it to the chat service.
// Validation uses zod, the schema library the agent already depends on, rather than
// Nest's class-validator pipeline, which would add two packages for one small body.
import { BadRequestException, Body, Controller, Get, Header, HttpCode, Inject, Param, Post } from "@nestjs/common";
import { z } from "zod";

import { CHAT_MODELS, ChatService, type ChatReply } from "./chat.service.js";

// The body of POST /api/chat: the user's message, the conversation it continues, if any,
// and the model, for a new conversation only.
const CHAT_REQUEST = z.object({
  message: z
    .string({ error: (issue) => (issue.input === undefined ? "The message is missing." : "The message must be text.") })
    .trim()
    .min(1, "The message is empty.")
    .max(2_000, "The message is over 2,000 characters."),
  threadId: z.uuid("threadId must be the id a previous reply returned.").optional(),
  model: z.enum(CHAT_MODELS, `model must be one of ${CHAT_MODELS.join(", ")}.`).optional(),
}, { error: "Send a JSON body: { message, threadId?, model? }." });

// A run id as runAgent writes it (an ISO timestamp with dashes, then the question id), so
// the record route can only ever name a file inside runs/.
const RUN_ID = /^[\w-]+$/;

/** Exposes the agent as JSON endpoints under /api. */
@Controller("api")
export class ChatController {
  // Injected by an explicit token, not by the constructor's type, so the controller also builds
  // under tsx, which drops the type metadata Nest would read (docs/facts.md); the endpoint test runs there.
  constructor(@Inject(ChatService) private readonly chat: ChatService) {}

  /** One chat turn: `{ message, threadId?, model? }` in, the answer and its trace out. */
  @Post("chat")
  @HttpCode(200)
  async post(@Body() body: unknown): Promise<ChatReply> {
    const parsed = CHAT_REQUEST.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((issue) => issue.message).join(" "));
    }
    const { message, threadId, model } = parsed.data;
    return this.chat.reply(message, { threadId, model });
  }

  /** The full run record of one turn: every message, tool input and output, and the tokens. */
  @Get("runs/:runId")
  @Header("content-type", "application/json; charset=utf-8")
  async run(@Param("runId") runId: string): Promise<string> {
    if (!RUN_ID.test(runId)) throw new BadRequestException("Not a run id.");
    return this.chat.runRecord(runId);
  }
}
