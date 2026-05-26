import { PassThrough, Writable } from "node:stream";
import { expect, test } from "vitest";
import type {
  InboundMessage,
  TransportChat,
  TransportProvider,
} from "../src/index.js";
import {
  MatrixDecryptionError,
  TransportManager,
  runChatCli,
} from "../src/index.js";

test("sends typed lines to the selected target", async () => {
  const matrix = new FakeTransport("matrix");
  const manager = new TransportManager([matrix]);
  const output = collectOutput();
  const input = scriptedInput("/target matrix room\nhello\n/quit\n");

  const exitCode = await runChatCli({
    input,
    output,
    errorOutput: collectOutput(),
    manager,
  });

  expect(exitCode).toBe(0);
  expect(matrix.sentMessages).toEqual([{ chatId: "room", text: "hello" }]);
  expect(output.text()).toContain("[matrix room] me: hello");
  expect(matrix.isConnected).toBe(false);
});

test("auto-selects the first inbound target", async () => {
  const matrix = new FakeTransport("matrix");
  const manager = new TransportManager([matrix]);

  matrix.onConnect = () => {
    matrix.emitMessage({
      chatId: "room",
      transport: "matrix",
      content: "incoming",
      username: "alice",
      timestamp: 1,
      isGroupChat: false,
      wasMentioned: false,
    });
  };
  const input = scriptedInput("reply\n/quit\n");

  await runChatCli({
    input,
    output: collectOutput(),
    errorOutput: collectOutput(),
    manager,
  });

  expect(matrix.sentMessages).toEqual([{ chatId: "room", text: "reply" }]);
});

test("auto-selects Matrix rooms with failed decryption", async () => {
  const matrix = new FakeTransport("matrix");
  const manager = new TransportManager([matrix]);

  matrix.onConnect = () => {
    matrix.emitError(new MatrixDecryptionError("room", "$event"));
  };

  await runChatCli({
    input: scriptedInput("bootstrap\n/quit\n"),
    output: collectOutput(),
    errorOutput: collectOutput(),
    manager,
  });

  expect(matrix.sentMessages).toEqual([{ chatId: "room", text: "bootstrap" }]);
});

test("leaves the current target", async () => {
  const matrix = new FakeTransport("matrix");
  const manager = new TransportManager([matrix]);

  await runChatCli({
    input: scriptedInput("/target matrix room\n/leave\n/quit\n"),
    output: collectOutput(),
    errorOutput: collectOutput(),
    manager,
  });

  expect(matrix.leftChats).toEqual(["room"]);
});

test("leaves the current target with a reason", async () => {
  const matrix = new FakeTransport("matrix");
  const manager = new TransportManager([matrix]);

  await runChatCli({
    input: scriptedInput('/target matrix room\n/leave "goodbye"\n/quit\n'),
    output: collectOutput(),
    errorOutput: collectOutput(),
    manager,
  });

  expect(matrix.leftChats).toEqual(["room"]);
  expect(matrix.leaveReasons).toEqual(["goodbye"]);
});

test("can target listed chats before receiving messages", async () => {
  const matrix = new FakeTransport("matrix");
  matrix.chats = [{ chatId: "listed-room", displayName: "Listed Room" }];
  const manager = new TransportManager([matrix]);

  await runChatCli({
    input: scriptedInput("/target matrix listed-room\nhello\n/quit\n"),
    output: collectOutput(),
    errorOutput: collectOutput(),
    manager,
  });

  expect(matrix.sentMessages).toEqual([
    { chatId: "listed-room", text: "hello" },
  ]);
});

function scriptedInput(source: string): PassThrough {
  const input = new PassThrough();

  setImmediate(() => {
    input.end(source);
  });

  return input;
}

function collectOutput(): Writable & { text(): string } {
  const chunks: string[] = [];

  const output = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  }) as Writable & { text(): string };

  output.text = () => chunks.join("");

  return output;
}

class FakeTransport implements TransportProvider {
  isConnected = false;
  onConnect?: () => void;
  chats: TransportChat[] = [];
  sentMessages: Array<{ chatId: string; text: string }> = [];
  leftChats: string[] = [];
  leaveReasons: Array<string | undefined> = [];
  readonly #messageHandlers = new Set<(message: InboundMessage) => void>();
  readonly #errorHandlers = new Set<(error: unknown) => void>();

  constructor(readonly type: TransportProvider["type"]) {}

  async connect(): Promise<void> {
    this.isConnected = true;
    this.onConnect?.();
  }

  async disconnect(): Promise<void> {
    this.isConnected = false;
  }

  async listChats(): Promise<TransportChat[]> {
    return this.chats;
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    this.sentMessages.push({ chatId, text });
  }

  async sendTyping(): Promise<void> {}

  async leaveChat(chatId: string, reason?: string): Promise<void> {
    this.leftChats.push(chatId);
    this.leaveReasons.push(reason);
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
