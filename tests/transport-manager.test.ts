import { expect, test } from "vitest";
import type { InboundMessage, TransportProvider } from "../src/index.js";
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

  expect(matrix.sentMessages).toEqual([{ chatId: "room", text: "hello" }]);
  expect(matrix.sentTyping).toEqual(["room"]);
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
  sentMessages: Array<{ chatId: string; text: string }> = [];
  sentTyping: string[] = [];
  readonly #messageHandlers = new Set<(message: InboundMessage) => void>();
  readonly #errorHandlers = new Set<(error: unknown) => void>();

  constructor(readonly type: TransportProvider["type"]) {}

  async connect(): Promise<void> {
    this.isConnected = true;
  }

  async disconnect(): Promise<void> {
    this.isConnected = false;
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    this.sentMessages.push({ chatId, text });
  }

  async sendTyping(chatId: string): Promise<void> {
    this.sentTyping.push(chatId);
  }

  onMessage(handler: (message: InboundMessage) => void): void {
    this.#messageHandlers.add(handler);
  }

  onError(handler: (error: unknown) => void): void {
    this.#errorHandlers.add(handler);
  }

  emitMessage(message: InboundMessage): void {
    for (const handler of this.#messageHandlers) {
      handler(message);
    }
  }

  emitError(error: unknown): void {
    for (const handler of this.#errorHandlers) {
      handler(error);
    }
  }
}
