import { expect, test } from "vitest";
import type {
  InboundMessage,
  InboundReaction,
  MessageReference,
  TransportProvider,
} from "../src/index.js";
import {
  DuplicateTransportError,
  TransportManager,
  UnknownTransportError,
} from "../src/index.js";

test("fans outbound commands to the selected transport", async () => {
  const matrix = new FakeTransport("matrix");
  const manager = new TransportManager([matrix]);

  await manager.handleCommand({
    type: "send_message",
    transport: "matrix",
    chatId: "room",
    text: "hello",
  });
  await manager.handleCommand({
    type: "send_typing",
    transport: "matrix",
    chatId: "room",
  });
  await manager.handleCommand({
    type: "send_reaction",
    transport: "matrix",
    chatId: "room",
    messageId: "$event",
    reaction: "+1",
  });

  expect(matrix.sentMessages).toEqual([{ chatId: "room", text: "hello" }]);
  expect(matrix.sentReactions).toEqual([
    { chatId: "room", messageId: "$event", reaction: "+1" },
  ]);
  expect(matrix.sentTyping).toEqual(["room"]);
});

test("passes outbound reply and thread references to the selected transport", async () => {
  const matrix = new FakeTransport("matrix");
  const manager = new TransportManager([matrix]);

  await manager.handleCommand({
    type: "send_message",
    transport: "matrix",
    chatId: "room",
    text: "hello",
    replyTo: {
      transport: "matrix",
      chatId: "room",
      messageId: "$previous",
    },
    threadTo: {
      transport: "matrix",
      chatId: "room",
      messageId: "$root",
    },
  });

  expect(matrix.sentMessages).toEqual([
    {
      chatId: "room",
      text: "hello",
      replyTo: { transport: "matrix", chatId: "room", messageId: "$previous" },
      threadTo: { transport: "matrix", chatId: "room", messageId: "$root" },
    },
  ]);
});

test("fans inbound transport messages to gateway handlers", () => {
  const matrix = new FakeTransport("matrix");
  const manager = new TransportManager([matrix]);
  const messages: InboundMessage[] = [];

  manager.onMessage((message) => messages.push(message));
  matrix.emitMessage({
    chatId: "room",
    transport: "matrix",
    content: "hello",
    timestamp: 1,
    isGroupChat: false,
    wasMentioned: false,
  });

  expect(messages).toEqual([
    {
      chatId: "room",
      transport: "matrix",
      content: "hello",
      timestamp: 1,
      isGroupChat: false,
      wasMentioned: false,
    },
  ]);
});

test("fans inbound transport reactions to gateway handlers", () => {
  const matrix = new FakeTransport("matrix");
  const manager = new TransportManager([matrix]);
  const reactions: InboundReaction[] = [];

  manager.onReaction((reaction) => reactions.push(reaction));
  matrix.emitReaction({
    chatId: "room",
    transport: "matrix",
    messageId: "$event",
    reaction: "+1",
    timestamp: 1,
  });

  expect(reactions).toEqual([
    {
      chatId: "room",
      transport: "matrix",
      messageId: "$event",
      reaction: "+1",
      timestamp: 1,
    },
  ]);
});

test("fans transport errors to gateway handlers with transport context", () => {
  const matrix = new FakeTransport("matrix");
  const manager = new TransportManager([matrix]);
  const errors: unknown[] = [];

  manager.onError((transport, error) => errors.push({ transport, error }));
  matrix.emitError(new Error("boom"));

  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatchObject({ transport: "matrix" });
});

test("rejects duplicate transports", () => {
  const matrix = new FakeTransport("matrix");

  expect(() => new TransportManager([matrix, matrix])).toThrow(
    DuplicateTransportError,
  );
});

test("rejects commands for unavailable transports", async () => {
  const manager = new TransportManager();

  await expect(
    manager.handleCommand({
      type: "send_typing",
      transport: "matrix",
      chatId: "room",
    }),
  ).rejects.toThrow(UnknownTransportError);
});

class FakeTransport implements TransportProvider {
  isConnected = false;
  sentMessages: Array<{
    chatId: string;
    text: string;
    replyTo?: MessageReference;
    threadTo?: MessageReference;
  }> = [];
  sentReactions: Array<{
    chatId: string;
    messageId: string;
    reaction: string;
  }> = [];
  sentTyping: string[] = [];
  readonly #messageHandlers = new Set<(message: InboundMessage) => void>();
  readonly #reactionHandlers = new Set<(reaction: InboundReaction) => void>();
  readonly #errorHandlers = new Set<(error: unknown) => void>();

  constructor(readonly type: TransportProvider["type"]) {}

  async connect(): Promise<void> {
    this.isConnected = true;
  }

  async disconnect(): Promise<void> {
    this.isConnected = false;
  }

  async sendMessage(
    chatId: string,
    text: string,
    replyTo?: MessageReference,
    threadTo?: MessageReference,
  ): Promise<void> {
    this.sentMessages.push({
      chatId,
      text,
      ...(replyTo ? { replyTo } : {}),
      ...(threadTo ? { threadTo } : {}),
    });
  }

  async sendReaction(
    chatId: string,
    messageId: string,
    reaction: string,
  ): Promise<void> {
    this.sentReactions.push({ chatId, messageId, reaction });
  }

  async sendTyping(chatId: string): Promise<void> {
    this.sentTyping.push(chatId);
  }

  onMessage(handler: (message: InboundMessage) => void): void {
    this.#messageHandlers.add(handler);
  }

  onReaction(handler: (reaction: InboundReaction) => void): void {
    this.#reactionHandlers.add(handler);
  }

  onError(handler: (error: unknown) => void): void {
    this.#errorHandlers.add(handler);
  }

  emitMessage(message: InboundMessage): void {
    for (const handler of this.#messageHandlers) {
      handler(message);
    }
  }

  emitReaction(reaction: InboundReaction): void {
    for (const handler of this.#reactionHandlers) {
      handler(reaction);
    }
  }

  emitError(error: unknown): void {
    for (const handler of this.#errorHandlers) {
      handler(error);
    }
  }
}
