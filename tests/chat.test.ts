import { PassThrough, Writable } from "node:stream";
import { expect, test } from "vitest";
import type {
  InboundMessage,
  TransportChat,
  TransportHealth,
  TransportInvite,
  TransportProvider,
} from "../src/index.js";
import {
  MatrixDecryptionError,
  TransportManager,
  runChatCli,
} from "../src/index.js";

test("starts in configuration mode with no transports", async () => {
  const manager = new TransportManager();
  const output = collectOutput();

  const exitCode = await runChatCli({
    input: scriptedInput("/quit\n"),
    output,
    errorOutput: collectOutput(),
    manager,
  });

  expect(exitCode).toBe(0);
  expect(output.text()).toContain("No transports are enabled");
});

test("runs admin slash commands and reloads transports", async () => {
  const manager = new TransportManager();
  const output = collectOutput();
  const matrix = new FakeTransport("matrix");

  await runChatCli({
    input: scriptedInput(
      "/connect matrix\n/target matrix room\nhello\n/quit\n",
    ),
    output,
    errorOutput: collectOutput(),
    manager,
    async runAdminCommand(args, commandOutput) {
      commandOutput.write(`${args.join(" ")}\n`);
      return 0;
    },
    async reloadTransports() {
      await manager.replaceTransports([matrix]);
      await manager.connectAll();
    },
  });

  expect(output.text()).toContain("Transport configuration applied");
  expect(matrix.sentMessages).toEqual([{ chatId: "room", text: "hello" }]);
});

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

test("reports send failures without exiting", async () => {
  const matrix = new FakeTransport("matrix");
  matrix.sendMessageError = new Error("M_FORBIDDEN");
  const manager = new TransportManager([matrix]);
  const output = collectOutput();

  const exitCode = await runChatCli({
    input: scriptedInput("/target matrix room\nhello\n/quit\n"),
    output,
    errorOutput: collectOutput(),
    manager,
  });

  expect(exitCode).toBe(0);
  expect(matrix.sentMessages).toEqual([]);
  expect(output.text()).toContain("M_FORBIDDEN");
});

test("interactive input edits at the cursor", async () => {
  const matrix = new FakeTransport("matrix");
  const manager = new TransportManager([matrix]);

  await runChatCli({
    input: interactiveInput([
      "/target matrix room",
      "\r",
      "helo",
      "\u001b[D",
      "l",
      "\r",
      "/quit",
      "\r",
    ]),
    output: interactiveOutput(),
    errorOutput: collectOutput(),
    manager,
  });

  expect(matrix.sentMessages).toEqual([{ chatId: "room", text: "hello" }]);
});

test("interactive input accepts pasted text", async () => {
  const matrix = new FakeTransport("matrix");
  const manager = new TransportManager([matrix]);

  await runChatCli({
    input: interactiveInput([
      "/target matrix room",
      "\r",
      "pasted message",
      "\r",
      "/quit",
      "\r",
    ]),
    output: interactiveOutput(),
    errorOutput: collectOutput(),
    manager,
  });

  expect(matrix.sentMessages).toEqual([
    { chatId: "room", text: "pasted message" },
  ]);
});

test("interactive input normalizes bracketed paste newlines", async () => {
  const matrix = new FakeTransport("matrix");
  const manager = new TransportManager([matrix]);

  await runChatCli({
    input: interactiveInput([
      "/target matrix room",
      "\r",
      "\u001b[200~hello\nworld\u001b[201~",
      "\r",
      "/quit",
      "\r",
    ]),
    output: interactiveOutput(),
    errorOutput: collectOutput(),
    manager,
  });

  expect(matrix.sentMessages).toEqual([
    { chatId: "room", text: "hello world" },
  ]);
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

test("shows pending invite counts in status", async () => {
  const matrix = new FakeTransport("matrix");
  matrix.invites = [{ inviteId: "invite-room", displayName: "Invite Room" }];
  const manager = new TransportManager([matrix]);
  const output = collectOutput();

  await runChatCli({
    input: scriptedInput("/status\n/quit\n"),
    output,
    errorOutput: collectOutput(),
    manager,
  });

  expect(output.text()).toContain("Pending invites: 1");
});

test("shows transport health in status", async () => {
  const matrix = new FakeTransport("matrix");
  matrix.healthChecks = [
    {
      category: "matrix-e2ee",
      status: "degraded",
      summary: "degraded: recovery key missing",
      details: ["problem: recovery key missing"],
    },
  ];
  const manager = new TransportManager([matrix]);
  const output = collectOutput();

  await runChatCli({
    input: scriptedInput("/status\n/quit\n"),
    output,
    errorOutput: collectOutput(),
    manager,
  });

  expect(output.text()).toContain(
    "matrix matrix-e2ee: degraded, degraded: recovery key missing",
  );
  expect(output.text()).toContain("problem: recovery key missing");
});

test("accepts pending invites", async () => {
  const matrix = new FakeTransport("matrix");
  const manager = new TransportManager([matrix]);

  await runChatCli({
    input: scriptedInput("/accept matrix invite-room\n/quit\n"),
    output: collectOutput(),
    errorOutput: collectOutput(),
    manager,
  });

  expect(matrix.acceptedInvites).toEqual(["invite-room"]);
});

test("rejects pending invites with a reason", async () => {
  const matrix = new FakeTransport("matrix");
  const manager = new TransportManager([matrix]);

  await runChatCli({
    input: scriptedInput('/reject matrix invite-room "not now"\n/quit\n'),
    output: collectOutput(),
    errorOutput: collectOutput(),
    manager,
  });

  expect(matrix.rejectedInvites).toEqual(["invite-room"]);
  expect(matrix.rejectReasons).toEqual(["not now"]);
});

function scriptedInput(source: string): PassThrough {
  const input = new PassThrough();

  setImmediate(() => {
    input.end(source);
  });

  return input;
}

function interactiveInput(chunks: string[]): PassThrough & {
  isTTY: true;
  setRawMode(mode: boolean): void;
} {
  const input = new PassThrough() as PassThrough & {
    isTTY: true;
    setRawMode(mode: boolean): void;
  };
  input.isTTY = true;
  input.setRawMode = () => {};

  const writeChunk = (index: number) => {
    if (index >= chunks.length) {
      input.end();
      return;
    }
    input.write(chunks[index]);
    setImmediate(() => writeChunk(index + 1));
  };
  setImmediate(() => writeChunk(0));

  return input;
}

function interactiveOutput(): Writable & { isTTY: true; text(): string } {
  const output = collectOutput() as Writable & { isTTY: true; text(): string };
  output.isTTY = true;
  return output;
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
  invites: TransportInvite[] = [];
  healthChecks: TransportHealth[] = [];
  sentMessages: Array<{ chatId: string; text: string }> = [];
  sendMessageError: Error | undefined;
  leftChats: string[] = [];
  leaveReasons: Array<string | undefined> = [];
  acceptedInvites: string[] = [];
  rejectedInvites: string[] = [];
  rejectReasons: Array<string | undefined> = [];
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

  async listInvites(): Promise<TransportInvite[]> {
    return this.invites;
  }

  async health(): Promise<TransportHealth[]> {
    return this.healthChecks;
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    if (this.sendMessageError) {
      throw this.sendMessageError;
    }
    this.sentMessages.push({ chatId, text });
  }

  async setTyping(): Promise<void> {}

  async leaveChat(chatId: string, reason?: string): Promise<void> {
    this.leftChats.push(chatId);
    this.leaveReasons.push(reason);
  }

  async acceptInvite(inviteId: string): Promise<void> {
    this.acceptedInvites.push(inviteId);
  }

  async rejectInvite(inviteId: string, reason?: string): Promise<void> {
    this.rejectedInvites.push(inviteId);
    this.rejectReasons.push(reason);
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
