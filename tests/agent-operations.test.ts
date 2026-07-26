import { expect, test } from "vitest";
import {
  AGENT_OPERATION_DESCRIPTORS,
  ManagerGatewayClient,
  TransportManager,
} from "../src/index.js";
import type {
  ChatHistoryQuery,
  ChatHistorySearchResult,
  MediaAttachmentKind,
  MessageReference,
  TransportProvider,
} from "../src/index.js";

class AgentTransport implements TransportProvider {
  readonly type = "matrix" as const;
  isConnected = true;
  readonly commands: unknown[] = [];
  readonly historyQueries: ChatHistoryQuery[] = [];
  readonly typings: Array<{
    chatId: string;
    typing: boolean;
    timeoutMs?: number;
  }> = [];
  readonly memberRequests: Array<{ limit?: number; cursor?: string }> = [];
  readonly pinnedRequests: Array<{ limit?: number; cursor?: string }> = [];

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async sendMessage(
    chatId: string,
    text: string,
    replyTo?: MessageReference,
    threadTo?: MessageReference,
  ): Promise<void> {
    this.commands.push({
      type: "sendMessage",
      chatId,
      text,
      replyTo,
      threadTo,
    });
  }
  async sendFile(
    chatId: string,
    path: string,
    fileName?: string,
    _mimeType?: string,
    _replyTo?: MessageReference,
    _threadTo?: MessageReference,
    _kind?: MediaAttachmentKind,
    caption?: string,
  ): Promise<void> {
    this.commands.push({ type: "sendFile", chatId, path, fileName, caption });
  }
  async sendReaction(
    chatId: string,
    messageId: string,
    reaction: string,
  ): Promise<void> {
    this.commands.push({ type: "sendReaction", chatId, messageId, reaction });
  }
  async setTyping(
    chatId: string,
    typing: boolean,
    timeoutMs?: number,
  ): Promise<void> {
    this.typings.push({ chatId, typing, timeoutMs });
  }
  async acceptInvite(inviteId: string): Promise<void> {
    this.commands.push({ type: "acceptInvite", inviteId });
  }
  async rejectInvite(inviteId: string, reason?: string): Promise<void> {
    this.commands.push({ type: "rejectInvite", inviteId, reason });
  }
  async leaveChat(chatId: string, reason?: string): Promise<void> {
    this.commands.push({ type: "leaveChat", chatId, reason });
  }
  async listChats() {
    return [{ chatId: "!room", displayName: "Room" }];
  }
  async listInvites() {
    return [{ inviteId: "!invite", displayName: "Invite" }];
  }
  async listMembers(_chatId: string, limit?: number, cursor?: string) {
    this.memberRequests.push({ limit, cursor });
    return [{ userId: "@alice:example", displayName: "Alice" }];
  }
  async getPinnedMessages(_chatId: string, limit?: number, cursor?: string) {
    this.pinnedRequests.push({ limit, cursor });
    return [
      {
        messageId: "$event",
        status: "available" as const,
        message: historyMessage,
      },
      { messageId: "$missing", status: "missing" as const },
      { messageId: "$redacted", status: "redacted" as const },
      { messageId: "$encrypted", status: "undecryptable" as const },
    ];
  }
  async getRelations() {
    return {
      message: historyMessage,
      items: [
        {
          messageId: "$reaction",
          relationType: "m.annotation",
          eventType: "m.reaction",
          timestamp: 2,
          userId: "@alice:example",
          key: "👍",
        },
      ],
      nextCursor: "next-relations",
      hasMore: true,
    };
  }
  async health() {
    return [{ category: "matrix", status: "ready" as const, summary: "ready" }];
  }
  async searchHistory(
    query: ChatHistoryQuery,
  ): Promise<ChatHistorySearchResult> {
    this.historyQueries.push(query);
    return {
      messages: [historyMessage],
      nextCursor: "0",
      hasMore: true,
      scannedChats: 1,
      scannedMessages: 1,
    };
  }
  onMessage(): void {}
  onError(): void {}
}

const historyMessage = {
  transport: "matrix" as const,
  chatId: "!room",
  messageId: "$event",
  content: "hello",
  timestamp: 1,
  attachments: [
    {
      mediaId: "mxc://example/file",
      kind: "file" as const,
      fileName: "file.txt",
      download: { status: "downloaded" as const, localPath: "/tmp/file.txt" },
    },
  ],
};

function createTestClient(): {
  client: ManagerGatewayClient;
  transport: AgentTransport;
} {
  const transport = new AgentTransport();
  return {
    transport,
    client: new ManagerGatewayClient({
      manager: new TransportManager([transport]),
    }),
  };
}

test("generated help exposes only registered camelCase operations", async () => {
  const { client } = createTestClient();
  const result = await client.executeAgentOperation({ operation: "help" });
  const operations = (result.data as { operations: Array<{ name: string }> })
    .operations;

  expect(result.summary).toBe(AGENT_OPERATION_DESCRIPTORS[0]?.help.summary);
  expect(operations.map(({ name }) => name)).toEqual(
    AGENT_OPERATION_DESCRIPTORS.map(({ name }) => name),
  );
  expect(operations.map(({ name }) => name)).not.toEqual(
    expect.arrayContaining([
      "configure",
      "connect",
      "disconnect",
      "status",
      "getRelations",
      "sendMessage",
      "sendFile",
    ]),
  );
  expect(operations.every(({ name }) => /^[a-z][A-Za-z]*$/.test(name))).toBe(
    true,
  );
});

test("agent history and metadata operations use bounded normalized transport data", async () => {
  const { client, transport } = createTestClient();

  await expect(
    client.executeAgentOperation({
      operation: "listChats",
      args: { transport: "matrix" },
    }),
  ).resolves.toMatchObject({
    data: {
      items: [{ transport: "matrix", chatId: "!room" }],
      nextCursor: null,
      hasMore: false,
    },
  });
  await expect(
    client.executeAgentOperation({
      operation: "listInvites",
      args: { transport: "matrix" },
    }),
  ).resolves.toMatchObject({
    data: { items: [{ transport: "matrix", inviteId: "!invite" }] },
  });
  await expect(
    client.executeAgentOperation({
      operation: "health",
      args: { transport: "matrix" },
    }),
  ).resolves.toMatchObject({
    data: { items: [{ transport: "matrix", status: "ready" }] },
  });
  await expect(
    client.executeAgentOperation({
      operation: "searchMessages",
      args: { transport: "matrix", chatId: "!room", query: "hello" },
    }),
  ).resolves.toMatchObject({
    data: { items: [{ messageId: "$event" }], nextCursor: "0", hasMore: true },
  });
  await expect(
    client.executeAgentOperation({
      operation: "getChat",
      args: { transport: "matrix", chatId: "!room" },
    }),
  ).resolves.toMatchObject({ data: { chat: { displayName: "Room" } } });
  await expect(
    client.executeAgentOperation({
      operation: "listMembers",
      args: { transport: "matrix", chatId: "!room" },
    }),
  ).resolves.toMatchObject({
    data: {
      items: [{ userId: "@alice:example" }],
      nextCursor: null,
      hasMore: false,
    },
  });
  await expect(
    client.executeAgentOperation({
      operation: "getPinnedMessages",
      args: { transport: "matrix", chatId: "!room" },
    }),
  ).resolves.toMatchObject({
    data: {
      items: [
        {
          messageId: "$event",
          status: "available",
          message: { messageId: "$event" },
        },
        { messageId: "$missing", status: "missing" },
        { messageId: "$redacted", status: "redacted" },
        { messageId: "$encrypted", status: "undecryptable" },
      ],
    },
  });
  await expect(
    client.executeAgentOperation({
      operation: "getMessage",
      args: { transport: "matrix", chatId: "!room", messageId: "$event" },
    }),
  ).resolves.toMatchObject({ data: { message: { messageId: "$event" } } });
  await expect(
    client.executeAgentOperation({
      operation: "getMedia",
      args: { transport: "matrix", chatId: "!room", messageId: "$event" },
    }),
  ).resolves.toMatchObject({
    data: { media: { mediaId: "mxc://example/file" } },
  });
  await client.executeAgentOperation({
    operation: "getMessages",
    args: {
      transport: "matrix",
      chatId: "!room",
      limit: 100,
      cursor: "2",
      direction: "backward",
    },
  });
  await expect(
    client.executeAgentOperation({
      operation: "getMessageRelations",
      args: { transport: "matrix", chatId: "!room", messageId: "$event" },
    }),
  ).resolves.toMatchObject({
    data: {
      message: { messageId: "$event" },
      items: [{ messageId: "$reaction", relationType: "m.annotation" }],
      nextCursor: "next-relations",
      hasMore: true,
    },
  });
  await expect(
    client.executeAgentOperation({
      operation: "searchMessages",
      args: { transport: "matrix", query: "all", allChats: true },
    }),
  ).resolves.toMatchObject({ data: { items: [{ messageId: "$event" }] } });

  expect(transport.historyQueries).toEqual([
    {
      transport: "matrix",
      query: "hello",
      chatIds: ["!room"],
      direction: "backward",
      limit: 10,
    },
    { transport: "matrix", chatIds: ["!room"], messageId: "$event", limit: 1 },
    { transport: "matrix", chatIds: ["!room"], messageId: "$event", limit: 1 },
    {
      transport: "matrix",
      chatIds: ["!room"],
      cursor: "2",
      direction: "backward",
      limit: 100,
    },
    { transport: "matrix", query: "all", direction: "backward", limit: 10 },
  ]);
  expect(transport.memberRequests).toEqual([{ limit: 26, cursor: undefined }]);
  expect(transport.pinnedRequests).toEqual([{ limit: 26, cursor: undefined }]);
});

test("agent operation schemas reject unknown and invalid input", async () => {
  const { client } = createTestClient();

  await expect(
    client.executeAgentOperation({
      operation: "getMessages",
      args: { transport: "matrix", chatId: "!room", unexpected: true },
    }),
  ).rejects.toThrow("Invalid args: unknown field unexpected");
  await expect(
    client.executeAgentOperation({
      operation: "searchMessages",
      args: { transport: "matrix", query: "deploy" },
    }),
  ).rejects.toThrow("searchMessages requires chatId or allChats: true");
  await expect(
    client.executeAgentOperation({
      operation: "getChat",
      args: { transport: "matrix", chatId: "!missing" },
    }),
  ).rejects.toThrow("Chat not found on matrix: !missing");
  await expect(
    client.executeAgentOperation({
      operation: "getMessages",
      args: { transport: "matrix", chatId: "!room", cursor: "opaque" },
    }),
  ).rejects.toThrow("cursor must be a non-negative timestamp");
});

test("agent setTyping is a bounded write with generated metadata", async () => {
  const { client, transport } = createTestClient();
  const descriptor = AGENT_OPERATION_DESCRIPTORS.find(
    ({ name }) => name === "setTyping",
  );

  expect(descriptor).toMatchObject({
    group: "writes",
    defaults: { timeoutMs: 10_000 },
    inputSchema: {
      required: ["transport", "chatId", "typing"],
      properties: { timeoutMs: { minimum: 1, maximum: 30_000 } },
    },
  });
  await expect(
    client.executeAgentOperation({
      operation: "setTyping",
      args: {
        transport: "matrix",
        chatId: "!room",
        typing: true,
        timeoutMs: 60_000,
      },
    }),
  ).rejects.toThrow("Invalid args.timeoutMs: must be at most 30000");
  await client.executeAgentOperation({
    operation: "setTyping",
    args: {
      transport: "matrix",
      chatId: "!room",
      typing: true,
      timeoutMs: 30_000,
    },
  });
  await client.executeAgentOperation({
    operation: "setTyping",
    args: { transport: "matrix", chatId: "!room", typing: false },
  });

  expect(transport.typings).toEqual([
    { chatId: "!room", typing: true, timeoutMs: 30_000 },
    { chatId: "!room", typing: false, timeoutMs: 10_000 },
  ]);
});

test("agent write operations use existing gateway commands", async () => {
  const { client, transport } = createTestClient();

  await client.executeAgentOperation({
    operation: "acceptInvite",
    args: { transport: "matrix", inviteId: "!invite" },
  });
  await client.executeAgentOperation({
    operation: "rejectInvite",
    args: { transport: "matrix", inviteId: "!invite", reason: "no" },
  });
  await client.executeAgentOperation({
    operation: "sendMessageToChat",
    args: { transport: "matrix", chatId: "!room", text: "hello" },
  });
  await client.executeAgentOperation({
    operation: "sendFileToChat",
    args: {
      transport: "matrix",
      chatId: "!room",
      path: "/tmp/file",
      caption: "Attached report",
    },
  });
  await client.executeAgentOperation({
    operation: "sendReaction",
    args: {
      transport: "matrix",
      chatId: "!room",
      messageId: "$event",
      reaction: "👍",
    },
  });
  await client.executeAgentOperation({
    operation: "leaveChat",
    args: { transport: "matrix", chatId: "!room" },
  });

  expect(transport.commands).toMatchObject([
    { type: "acceptInvite", inviteId: "!invite" },
    { type: "rejectInvite", inviteId: "!invite", reason: "no" },
    { type: "sendMessage", chatId: "!room", text: "hello" },
    {
      type: "sendFile",
      chatId: "!room",
      path: "/tmp/file",
      fileName: "file",
      caption: "Attached report",
    },
    { type: "sendReaction", messageId: "$event", reaction: "👍" },
    { type: "leaveChat", chatId: "!room" },
  ]);
});
