import { expect, test } from "vitest";
import type {
  GatewayEvent,
  InboundInvite,
  InboundMessage,
  InboundReaction,
  InboundTypingSnapshot,
  MessageReference,
  TransportProvider,
} from "../src/index.js";
import {
  DuplicateTransportError,
  ManagerGatewayClient,
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
    type: "set_typing",
    transport: "matrix",
    chatId: "room",
    typing: true,
    timeoutMs: 10_000,
  });
  await manager.handleCommand({
    type: "send_reaction",
    transport: "matrix",
    chatId: "room",
    messageId: "$event",
    reaction: "+1",
  });
  await manager.handleCommand({
    type: "accept_invite",
    transport: "matrix",
    inviteId: "invite-room",
  });

  expect(matrix.sentMessages).toEqual([{ chatId: "room", text: "hello" }]);
  expect(matrix.sentReactions).toEqual([
    { chatId: "room", messageId: "$event", reaction: "+1" },
  ]);
  expect(matrix.typingUpdates).toEqual([
    { chatId: "room", typing: true, timeoutMs: 10_000 },
  ]);
  expect(matrix.acceptedInvites).toEqual(["invite-room"]);
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
    transport: "slack",
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
    transport: "slack",
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

test("fans inbound typing snapshots to gateway handlers", () => {
  const matrix = new FakeTransport("matrix");
  const manager = new TransportManager([matrix]);
  const snapshots: InboundTypingSnapshot[] = [];

  manager.onTyping((typing) => snapshots.push(typing));
  matrix.emitTyping({
    transport: "slack",
    chatId: "room",
    userIds: ["@alice:example.org"],
    observedAt: 1,
  });

  expect(snapshots).toEqual([
    {
      transport: "matrix",
      chatId: "room",
      userIds: ["@alice:example.org"],
      observedAt: 1,
    },
  ]);
});

test("fans inbound transport invites to gateway handlers", () => {
  const matrix = new FakeTransport("matrix");
  const manager = new TransportManager([matrix]);
  const invites: InboundInvite[] = [];

  manager.onInvite((invite) => invites.push(invite));
  matrix.emitInvite({ inviteId: "invite-room", inviter: "@alice:example.org" });

  expect(invites).toEqual([
    {
      transport: "matrix",
      inviteId: "invite-room",
      inviter: "@alice:example.org",
    },
  ]);
});

test("emits inbound typing events from the gateway client", () => {
  const matrix = new FakeTransport("matrix");
  const manager = new TransportManager([matrix]);
  const client = new ManagerGatewayClient({ manager });
  const events: GatewayEvent[] = [];

  client.onEvent((event) => events.push(event));
  matrix.emitTyping({
    transport: "matrix",
    chatId: "room",
    userIds: ["@alice:example.org"],
    observedAt: 1,
  });

  expect(events).toEqual([
    {
      type: "typing",
      typing: {
        transport: "matrix",
        chatId: "room",
        userIds: ["@alice:example.org"],
        observedAt: 1,
      },
    },
  ]);
});

test("emits inbound invite events from the gateway client", () => {
  const matrix = new FakeTransport("matrix");
  const manager = new TransportManager([matrix]);
  const client = new ManagerGatewayClient({ manager });
  const events: GatewayEvent[] = [];

  client.onEvent((event) => events.push(event));
  matrix.emitInvite({ inviteId: "invite-room", inviter: "@alice:example.org" });

  expect(events).toEqual([
    {
      type: "invite",
      invite: {
        transport: "matrix",
        inviteId: "invite-room",
        inviter: "@alice:example.org",
      },
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
      type: "set_typing",
      transport: "matrix",
      chatId: "room",
      typing: true,
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
  typingUpdates: Array<{
    chatId: string;
    typing: boolean;
    timeoutMs?: number;
  }> = [];
  acceptedInvites: string[] = [];
  readonly #messageHandlers = new Set<(message: InboundMessage) => void>();
  readonly #reactionHandlers = new Set<(reaction: InboundReaction) => void>();
  readonly #typingHandlers = new Set<(typing: InboundTypingSnapshot) => void>();
  readonly #inviteHandlers = new Set<
    (invite: { inviteId: string; inviter?: string }) => void
  >();
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

  async setTyping(
    chatId: string,
    typing: boolean,
    timeoutMs?: number,
  ): Promise<void> {
    this.typingUpdates.push({
      chatId,
      typing,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
  }

  async acceptInvite(inviteId: string): Promise<void> {
    this.acceptedInvites.push(inviteId);
  }

  onMessage(handler: (message: InboundMessage) => void): void {
    this.#messageHandlers.add(handler);
  }

  onReaction(handler: (reaction: InboundReaction) => void): void {
    this.#reactionHandlers.add(handler);
  }

  onTyping(handler: (typing: InboundTypingSnapshot) => void): void {
    this.#typingHandlers.add(handler);
  }

  onInvite(
    handler: (invite: { inviteId: string; inviter?: string }) => void,
  ): void {
    this.#inviteHandlers.add(handler);
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

  emitTyping(typing: InboundTypingSnapshot): void {
    for (const handler of this.#typingHandlers) {
      handler(typing);
    }
  }

  emitInvite(invite: { inviteId: string; inviter?: string }): void {
    for (const handler of this.#inviteHandlers) {
      handler(invite);
    }
  }

  emitError(error: unknown): void {
    for (const handler of this.#errorHandlers) {
      handler(error);
    }
  }
}
