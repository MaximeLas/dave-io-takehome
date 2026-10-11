// The server's one module: the chat endpoint and the service behind it.
import { Module } from "@nestjs/common";

import { ChatController } from "./chat.controller.js";
import { ChatService } from "./chat.service.js";

/** The root module of the chat server. */
@Module({ controllers: [ChatController], providers: [ChatService] })
export class AppModule {}
