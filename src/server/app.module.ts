// The server's one module: the chat, and the eval page with the improver behind it.
import { Module } from "@nestjs/common";

import { ChatController } from "./chat.controller.js";
import { ChatService } from "./chat.service.js";
import { EvalController } from "./eval.controller.js";
import { EvalService } from "./eval.service.js";
import { ImproveService } from "./improve.service.js";

/** The root module of the server. */
@Module({ controllers: [ChatController, EvalController], providers: [ChatService, EvalService, ImproveService] })
export class AppModule {}
