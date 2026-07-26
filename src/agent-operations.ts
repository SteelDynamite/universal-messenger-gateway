import { basename, extname } from "node:path";
import type { GatewayClient } from "./gateway-client.js";
import type {
  ChatHistoryMessage,
  ChatHistoryQuery,
  MediaAttachment,
  MessageReference,
  PinnedMessageResolution,
  TransportName,
} from "./protocol.js";

export type AgentOperationGroup =
  | "chats"
  | "members"
  | "messages"
  | "media"
  | "writes"
  | "diagnostics";

export type JsonSchema = {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  enum?: readonly unknown[];
  items?: JsonSchema;
  minimum?: number;
  maximum?: number;
};

export type AgentOperationHelp = {
  summary: string;
  examples: readonly Record<string, unknown>[];
};

export type AgentOperationDescriptor<Name extends string = string> = {
  name: Name;
  group: AgentOperationGroup;
  inputSchema: JsonSchema;
  defaults: Readonly<Record<string, unknown>>;
  help: AgentOperationHelp;
  resultSchema: JsonSchema;
  execute(
    client: GatewayClient,
    args: Record<string, unknown>,
  ): Promise<unknown>;
};

const transportSchema: JsonSchema = {
  type: "string",
  enum: ["matrix", "slack", "discord", "telegram", "whatsapp"],
};
const limitSchema: JsonSchema = { type: "integer", minimum: 1, maximum: 100 };
const cursorSchema: JsonSchema = {
  type: "string",
  description: "Opaque cursor from a previous result",
};
const chatIdSchema: JsonSchema = {
  type: "string",
  description: "Transport chat id",
};
const messageIdSchema: JsonSchema = {
  type: "string",
  description: "Stable transport message id",
};
const referenceSchema: JsonSchema = {
  type: "object",
  required: ["transport", "chatId", "messageId"],
  additionalProperties: false,
  properties: {
    transport: transportSchema,
    chatId: chatIdSchema,
    messageId: messageIdSchema,
  },
};
const MAX_AGENT_TEXT_LENGTH = 4_000;
const pagedResultSchema: JsonSchema = {
  type: "object",
  required: ["items", "nextCursor", "hasMore"],
  properties: {
    items: { type: "array" },
    nextCursor: { type: ["string", "null"] },
    hasMore: { type: "boolean" },
  },
};
const pinnedResultSchema: JsonSchema = {
  type: "object",
  required: ["items", "nextCursor", "hasMore"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        required: ["messageId", "status"],
        properties: {
          messageId: messageIdSchema,
          status: {
            type: "string",
            enum: [
              "available",
              "missing",
              "redacted",
              "undecryptable",
              "unsupported",
            ],
          },
          message: { type: "object" },
        },
      },
    },
    nextCursor: { type: ["string", "null"] },
    hasMore: { type: "boolean" },
  },
};

/** The sole operation definition source for execution and generated help. */
export const AGENT_OPERATION_DESCRIPTORS = [
  helpDescriptor(),
  {
    name: "listChats",
    group: "chats",
    inputSchema: objectSchema({
      transport: transportSchema,
      limit: limitSchema,
      cursor: cursorSchema,
    }),
    defaults: { limit: 25 },
    help: {
      summary:
        "List chats joined by one transport or every configured transport.",
      examples: [{ transport: "matrix" }],
    },
    resultSchema: pagedResultSchema,
    async execute(client, args) {
      const limit = boundedLimit(args.limit);
      const transport = optionalTransport(args.transport);
      const chats = transport
        ? (await client.listChats(transport)).map((chat) => ({
            transport,
            ...chat,
          }))
        : (
            await Promise.all(
              [...client.configuredTransports()].map(async (name) =>
                (
                  await client.listChats(name)
                ).map((chat) => ({
                  transport: name,
                  ...chat,
                })),
              ),
            )
          ).flat();
      chats.sort((left, right) =>
        `${left.transport}:${left.chatId}`.localeCompare(
          `${right.transport}:${right.chatId}`,
        ),
      );
      return page(chats, limit, optionalString(args.cursor));
    },
  },
  {
    name: "getChat",
    group: "chats",
    inputSchema: objectSchema(
      { transport: transportSchema, chatId: chatIdSchema },
      ["transport", "chatId"],
    ),
    defaults: {},
    help: {
      summary: "Get one joined chat's normalized metadata.",
      examples: [{ transport: "matrix", chatId: "!room:example.org" }],
    },
    resultSchema: {
      type: "object",
      properties: { chat: { type: "object" } },
    },
    async execute(client, args) {
      const transport = requiredTransport(args.transport, "transport");
      const chatId = requiredString(args.chatId, "chatId");
      const chat = (await client.listChats(transport)).find(
        (candidate) => candidate.chatId === chatId,
      );
      if (!chat) {
        throw new Error(`Chat not found on ${transport}: ${chatId}`);
      }
      return { chat: { transport, ...chat } };
    },
  },
  {
    name: "listMembers",
    group: "members",
    inputSchema: objectSchema(
      {
        transport: transportSchema,
        chatId: chatIdSchema,
        limit: limitSchema,
        cursor: cursorSchema,
      },
      ["transport", "chatId"],
    ),
    defaults: { limit: 25 },
    help: {
      summary: "List joined members when the transport supports member lookup.",
      examples: [
        { transport: "matrix", chatId: "!room:example.org", limit: 25 },
      ],
    },
    resultSchema: pagedResultSchema,
    async execute(client, args) {
      const transport = requiredTransport(args.transport, "transport");
      const limit = boundedLimit(args.limit);
      const members = await client.listMembers(
        transport,
        requiredString(args.chatId, "chatId"),
        limit + 1,
        optionalString(args.cursor),
      );
      return collectedPage(
        members.map((member) => ({ transport, ...member })),
        limit,
        optionalString(args.cursor),
      );
    },
  },
  {
    name: "searchMessages",
    group: "messages",
    inputSchema: objectSchema(
      {
        transport: transportSchema,
        query: { type: "string" },
        chatId: chatIdSchema,
        allChats: { type: "boolean" },
        limit: limitSchema,
        cursor: cursorSchema,
        direction: { type: "string", enum: ["backward", "forward"] },
        fromTimestamp: { type: "integer" },
        toTimestamp: { type: "integer" },
      },
      ["transport", "query"],
    ),
    defaults: { limit: 10 },
    help: {
      summary:
        "Search source-of-truth history in one chat, or set allChats true intentionally.",
      examples: [
        { transport: "matrix", chatId: "!room:example.org", query: "deploy" },
        { transport: "matrix", allChats: true, query: "deploy" },
      ],
    },
    resultSchema: historyResultSchema(),
    async execute(client, args) {
      const chatId = optionalString(args.chatId);
      if (!chatId && args.allChats !== true) {
        throw new Error("searchMessages requires chatId or allChats: true");
      }
      if (chatId && args.allChats === true) {
        throw new Error(
          "searchMessages accepts chatId or allChats: true, not both",
        );
      }
      return history(client, {
        transport: requiredTransport(args.transport, "transport"),
        query: requiredString(args.query, "query"),
        ...(chatId ? { chatIds: [chatId] } : {}),
        ...cursorDirection(args),
        ...timestamps(args),
        limit: boundedLimit(args.limit, 10, 100),
      });
    },
  },
  {
    name: "getMessage",
    group: "messages",
    inputSchema: objectSchema(
      {
        transport: transportSchema,
        chatId: chatIdSchema,
        messageId: messageIdSchema,
      },
      ["transport", "chatId", "messageId"],
    ),
    defaults: {},
    help: {
      summary:
        "Look up one exact source-of-truth message, including bounded attachment downloads.",
      examples: [
        {
          transport: "matrix",
          chatId: "!room:example.org",
          messageId: "$event",
        },
      ],
    },
    resultSchema: {
      type: "object",
      properties: { message: { type: "object" } },
    },
    async execute(client, args) {
      const result = await history(client, exactMessageQuery(args));
      return { ...(result.items[0] ? { message: result.items[0] } : {}) };
    },
  },
  {
    name: "getMessageRelations",
    group: "messages",
    inputSchema: objectSchema(
      {
        transport: transportSchema,
        chatId: chatIdSchema,
        messageId: messageIdSchema,
        limit: limitSchema,
        cursor: cursorSchema,
      },
      ["transport", "chatId", "messageId"],
    ),
    defaults: { limit: 25 },
    help: {
      summary:
        "Get an exact message's reply/thread fields and bounded source-of-truth relations.",
      examples: [
        {
          transport: "matrix",
          chatId: "!room:example.org",
          messageId: "$event",
        },
      ],
    },
    resultSchema: {
      type: "object",
      required: ["items", "nextCursor", "hasMore"],
      properties: {
        message: { type: "object" },
        ...pagedResultSchema.properties,
      },
    },
    async execute(client, args) {
      const transport = requiredTransport(args.transport, "transport");
      const result = await client.getRelations(
        transport,
        requiredString(args.chatId, "chatId"),
        requiredString(args.messageId, "messageId"),
        boundedLimit(args.limit, 25),
        optionalString(args.cursor),
      );
      return {
        ...(result.message ? { message: conciseMessage(result.message) } : {}),
        items: result.items.map((item) => ({ transport, ...item })),
        nextCursor: result.nextCursor,
        hasMore: result.hasMore,
      };
    },
  },
  {
    name: "getMessages",
    group: "messages",
    inputSchema: objectSchema(
      {
        transport: transportSchema,
        chatId: chatIdSchema,
        limit: limitSchema,
        cursor: cursorSchema,
        direction: { type: "string", enum: ["backward", "forward"] },
        fromTimestamp: { type: "integer" },
        toTimestamp: { type: "integer" },
      },
      ["transport", "chatId"],
    ),
    defaults: { limit: 25 },
    help: {
      summary: "Get recent bounded source-of-truth messages from one chat.",
      examples: [
        { transport: "matrix", chatId: "!room:example.org", limit: 25 },
      ],
    },
    resultSchema: historyResultSchema(),
    async execute(client, args) {
      return history(client, {
        transport: requiredTransport(args.transport, "transport"),
        chatIds: [requiredString(args.chatId, "chatId")],
        ...cursorDirection(args),
        ...timestamps(args),
        limit: boundedLimit(args.limit, 25, 100),
      });
    },
  },
  {
    name: "getMedia",
    group: "media",
    inputSchema: objectSchema(
      {
        transport: transportSchema,
        chatId: chatIdSchema,
        messageId: messageIdSchema,
        attachmentIndex: { type: "integer", minimum: 0, maximum: 9 },
      },
      ["transport", "chatId", "messageId"],
    ),
    defaults: { attachmentIndex: 0 },
    help: {
      summary:
        "Get one message attachment's bounded media metadata and download status.",
      examples: [
        {
          transport: "matrix",
          chatId: "!room:example.org",
          messageId: "$event",
        },
      ],
    },
    resultSchema: {
      type: "object",
      properties: { media: { type: "object" } },
    },
    async execute(client, args) {
      const result = await history(client, exactMessageQuery(args));
      const attachmentIndex = boundedInteger(args.attachmentIndex, 0, 0, 9);
      const media = result.items[0]?.attachments?.[attachmentIndex];
      return { ...(media ? { media: conciseAttachment(media) } : {}) };
    },
  },
  {
    name: "getPinnedMessages",
    group: "messages",
    inputSchema: objectSchema(
      {
        transport: transportSchema,
        chatId: chatIdSchema,
        limit: limitSchema,
        cursor: cursorSchema,
      },
      ["transport", "chatId"],
    ),
    defaults: { limit: 25 },
    help: {
      summary:
        "Get pinned source-of-truth messages when the transport supports pins.",
      examples: [{ transport: "matrix", chatId: "!room:example.org" }],
    },
    resultSchema: pinnedResultSchema,
    async execute(client, args) {
      const limit = boundedLimit(args.limit, 25);
      const messages = await client.getPinnedMessages(
        requiredTransport(args.transport, "transport"),
        requiredString(args.chatId, "chatId"),
        limit + 1,
        optionalString(args.cursor),
      );
      return collectedPage(
        messages.map(concisePinnedMessage),
        limit,
        optionalString(args.cursor),
      );
    },
  },
  {
    name: "listInvites",
    group: "chats",
    inputSchema: objectSchema({
      transport: transportSchema,
      limit: limitSchema,
      cursor: cursorSchema,
    }),
    defaults: { limit: 25 },
    help: {
      summary:
        "List pending invitations for one transport or every configured transport.",
      examples: [{ transport: "matrix" }],
    },
    resultSchema: pagedResultSchema,
    async execute(client, args) {
      const limit = boundedLimit(args.limit);
      const transport = optionalTransport(args.transport);
      const invites = transport
        ? (await client.listInvites(transport)).map((invite) => ({
            transport,
            ...invite,
          }))
        : (
            await Promise.all(
              [...client.configuredTransports()].map(async (name) =>
                (
                  await client.listInvites(name)
                ).map((invite) => ({
                  transport: name,
                  ...invite,
                })),
              ),
            )
          ).flat();
      invites.sort((left, right) =>
        `${left.transport}:${left.inviteId}`.localeCompare(
          `${right.transport}:${right.inviteId}`,
        ),
      );
      return page(invites, limit, optionalString(args.cursor));
    },
  },
  action("acceptInvite", "Accept a pending invitation.", {
    inviteId: "!room:example.org",
  }),
  action(
    "rejectInvite",
    "Reject a pending invitation.",
    { inviteId: "!room:example.org" },
    true,
  ),
  sendMessageToChatDescriptor(),
  sendFileToChatDescriptor(),
  sendReactionDescriptor(),
  setTypingDescriptor(),
  action(
    "leaveChat",
    "Leave a joined chat.",
    { chatId: "!room:example.org" },
    true,
  ),
  {
    name: "health",
    group: "diagnostics",
    inputSchema: objectSchema({ transport: transportSchema }),
    defaults: {},
    help: {
      summary:
        "Get concise transport health checks for one or every configured transport.",
      examples: [{ transport: "matrix" }],
    },
    resultSchema: pagedResultSchema,
    async execute(client, args) {
      const transport = optionalTransport(args.transport);
      const checks = transport
        ? (await client.health(transport)).map((check) => ({
            transport,
            ...check,
          }))
        : (
            await Promise.all(
              [...client.configuredTransports()].map(async (name) =>
                (
                  await client.health(name)
                ).map((check) => ({
                  transport: name,
                  ...check,
                })),
              ),
            )
          ).flat();
      return page(checks, 100);
    },
  },
] as const satisfies readonly AgentOperationDescriptor[];

export type AgentOperationName =
  (typeof AGENT_OPERATION_DESCRIPTORS)[number]["name"];

export type AgentOperationRequest = {
  operation: AgentOperationName;
  args?: Record<string, unknown>;
};

export type AgentOperationResult = {
  operation: AgentOperationName;
  summary: string;
  data: unknown;
};

function helpDescriptor(): AgentOperationDescriptor<"help"> {
  return {
    name: "help",
    group: "diagnostics",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { operation: { type: "string" } },
    },
    defaults: {},
    help: {
      summary: "List operations or show one operation's schema and examples.",
      examples: [{}, { operation: "getMessages" }],
    },
    resultSchema: {
      type: "object",
      properties: { operations: { type: "array" } },
    },
    async execute(_client, args) {
      const requested = optionalString(args.operation);
      const descriptors = requested
        ? AGENT_OPERATION_DESCRIPTORS.filter(({ name }) => name === requested)
        : AGENT_OPERATION_DESCRIPTORS;
      if (requested && descriptors.length === 0) {
        throw new Error(`Unknown agent operation: ${requested}`);
      }
      return { operations: descriptors.map(publicDescriptor) };
    },
  };
}

export async function executeAgentOperation(
  client: GatewayClient,
  request: AgentOperationRequest,
): Promise<AgentOperationResult> {
  const descriptor = AGENT_OPERATION_DESCRIPTORS.find(
    ({ name }) => name === request.operation,
  );
  if (!descriptor) {
    throw new Error(`Unknown agent operation: ${String(request.operation)}`);
  }
  const args = request.args === undefined ? {} : request.args;
  validateSchema(descriptor.inputSchema, args, "args");
  const data = await descriptor.execute(client, args);
  return { operation: descriptor.name, summary: descriptor.help.summary, data };
}

function action<Name extends "acceptInvite" | "rejectInvite" | "leaveChat">(
  name: Name,
  summary: string,
  example: Record<string, unknown>,
  reason = false,
): AgentOperationDescriptor<Name> {
  const invite = name !== "leaveChat";
  return {
    name,
    group: "writes",
    inputSchema: objectSchema(
      {
        transport: transportSchema,
        ...(invite ? { inviteId: chatIdSchema } : { chatId: chatIdSchema }),
        ...(reason ? { reason: { type: "string" } } : {}),
      },
      ["transport", invite ? "inviteId" : "chatId"],
    ),
    defaults: {},
    help: { summary, examples: [{ transport: "matrix", ...example }] },
    resultSchema: { type: "object", properties: { ok: { type: "boolean" } } },
    async execute(client, args) {
      const transport = requiredTransport(args.transport, "transport");
      const reasonValue = optionalString(args.reason);
      if (name === "acceptInvite") {
        await client.acceptInvite(
          transport,
          requiredString(args.inviteId, "inviteId"),
        );
      } else if (name === "rejectInvite") {
        await client.rejectInvite(
          transport,
          requiredString(args.inviteId, "inviteId"),
          reasonValue,
        );
      } else {
        await client.leaveChat(
          transport,
          requiredString(args.chatId, "chatId"),
          reasonValue,
        );
      }
      return { ok: true };
    },
  };
}

function sendMessageToChatDescriptor(): AgentOperationDescriptor<"sendMessageToChat"> {
  return {
    name: "sendMessageToChat",
    group: "writes",
    inputSchema: objectSchema(
      {
        transport: transportSchema,
        chatId: chatIdSchema,
        text: { type: "string" },
        replyTo: referenceSchema,
        threadTo: referenceSchema,
      },
      ["transport", "chatId", "text"],
    ),
    defaults: {},
    help: {
      summary:
        "Send a text message to an explicit chat and optional reply/thread target.",
      examples: [
        { transport: "matrix", chatId: "!room:example.org", text: "Hello" },
      ],
    },
    resultSchema: { type: "object", properties: { ok: { type: "boolean" } } },
    async execute(client, args) {
      await client.send({
        type: "send_message",
        transport: requiredTransport(args.transport, "transport"),
        chatId: requiredString(args.chatId, "chatId"),
        text: requiredString(args.text, "text"),
        ...references(args),
      });
      return { ok: true };
    },
  };
}

function sendFileToChatDescriptor(): AgentOperationDescriptor<"sendFileToChat"> {
  return {
    name: "sendFileToChat",
    group: "writes",
    inputSchema: objectSchema(
      {
        transport: transportSchema,
        chatId: chatIdSchema,
        path: { type: "string" },
        fileName: { type: "string" },
        mimeType: { type: "string" },
        kind: { type: "string", enum: ["image", "file", "audio", "video"] },
        caption: { type: "string", maximum: 4_000 },
        replyTo: referenceSchema,
        threadTo: referenceSchema,
      },
      ["transport", "chatId", "path"],
    ),
    defaults: {
      fileName: "local basename",
      mimeType: "inferred from filename",
      kind: "inferred from MIME type",
    },
    help: {
      summary:
        "Send a local file to an explicit chat with an optional same-event caption.",
      examples: [
        {
          transport: "matrix",
          chatId: "!room:example.org",
          path: "/tmp/report.txt",
        },
      ],
    },
    resultSchema: { type: "object", properties: { ok: { type: "boolean" } } },
    async execute(client, args) {
      const transport = requiredTransport(args.transport, "transport");
      const chatId = requiredString(args.chatId, "chatId");
      const path = requiredString(args.path, "path");
      const fileName =
        (optionalString(args.fileName) ?? basename(path)) || "file";
      const mimeType = optionalString(args.mimeType) ?? inferMimeType(fileName);
      const kind = (optionalString(args.kind) ?? attachmentKind(mimeType)) as
        | "image"
        | "file"
        | "audio"
        | "video";
      const caption = optionalString(args.caption);
      await client.send({
        type: "send_file",
        transport,
        chatId,
        path,
        fileName,
        mimeType,
        kind,
        ...(caption ? { caption } : {}),
        ...references(args),
      });
      return { ok: true };
    },
  };
}

function sendReactionDescriptor(): AgentOperationDescriptor<"sendReaction"> {
  return {
    name: "sendReaction",
    group: "writes",
    inputSchema: objectSchema(
      {
        transport: transportSchema,
        chatId: chatIdSchema,
        messageId: messageIdSchema,
        reaction: { type: "string" },
      },
      ["transport", "chatId", "messageId", "reaction"],
    ),
    defaults: {},
    help: {
      summary: "React to a message.",
      examples: [
        {
          transport: "matrix",
          chatId: "!room:example.org",
          messageId: "$event",
          reaction: "👍",
        },
      ],
    },
    resultSchema: { type: "object", properties: { ok: { type: "boolean" } } },
    async execute(client, args) {
      await client.send({
        type: "send_reaction",
        transport: requiredTransport(args.transport, "transport"),
        chatId: requiredString(args.chatId, "chatId"),
        messageId: requiredString(args.messageId, "messageId"),
        reaction: requiredString(args.reaction, "reaction"),
      });
      return { ok: true };
    },
  };
}

function setTypingDescriptor(): AgentOperationDescriptor<"setTyping"> {
  return {
    name: "setTyping",
    group: "writes",
    inputSchema: objectSchema(
      {
        transport: transportSchema,
        chatId: chatIdSchema,
        typing: { type: "boolean" },
        timeoutMs: { type: "integer", minimum: 1, maximum: 30_000 },
      },
      ["transport", "chatId", "typing"],
    ),
    defaults: { timeoutMs: 10_000 },
    help: {
      summary: "Set a short-lived typing indicator.",
      examples: [
        { transport: "matrix", chatId: "!room:example.org", typing: true },
      ],
    },
    resultSchema: { type: "object", properties: { ok: { type: "boolean" } } },
    async execute(client, args) {
      await client.setTyping(
        requiredTransport(args.transport, "transport"),
        requiredString(args.chatId, "chatId"),
        requiredBoolean(args.typing, "typing"),
        boundedInteger(args.timeoutMs, 10_000, 1, 30_000),
      );
      return { ok: true };
    },
  };
}

function objectSchema(
  properties: Record<string, JsonSchema>,
  required: string[] = [],
): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

function historyResultSchema(): JsonSchema {
  return {
    type: "object",
    required: [
      "items",
      "nextCursor",
      "hasMore",
      "scannedChats",
      "scannedMessages",
    ],
    properties: {
      ...pagedResultSchema.properties,
      scannedChats: { type: "integer" },
      scannedMessages: { type: "integer" },
      partial: { type: "boolean" },
    },
  };
}

async function history(
  client: GatewayClient,
  query: ChatHistoryQuery,
): Promise<{
  items: ChatHistoryMessage[];
  nextCursor: string | null;
  hasMore: boolean;
  scannedChats: number;
  scannedMessages: number;
  partial?: boolean;
  errors?: string[];
}> {
  const result = await client.searchHistory(query);
  return {
    items: result.messages.slice(0, query.limit ?? 25).map(conciseMessage),
    nextCursor: result.nextCursor,
    hasMore: result.hasMore,
    scannedChats: result.scannedChats,
    scannedMessages: result.scannedMessages,
    ...(result.partial === undefined ? {} : { partial: result.partial }),
    ...(result.errors?.length ? { errors: result.errors.slice(0, 10) } : {}),
  };
}

function conciseMessage(message: ChatHistoryMessage): ChatHistoryMessage {
  return {
    ...message,
    content: conciseText(message.content),
    ...(message.username ? { username: conciseText(message.username) } : {}),
    ...(message.attachments
      ? { attachments: message.attachments.slice(0, 10).map(conciseAttachment) }
      : {}),
  };
}

function concisePinnedMessage(
  resolution: PinnedMessageResolution,
): PinnedMessageResolution {
  return {
    messageId: resolution.messageId,
    status: resolution.status,
    ...(resolution.message
      ? { message: conciseMessage(resolution.message) }
      : {}),
  };
}

function conciseAttachment(attachment: MediaAttachment): MediaAttachment {
  return {
    ...attachment,
    ...(attachment.fileName
      ? { fileName: conciseText(attachment.fileName) }
      : {}),
    ...(attachment.description
      ? { description: conciseText(attachment.description) }
      : {}),
    ...(attachment.download?.error
      ? {
          download: {
            ...attachment.download,
            error: conciseText(attachment.download.error),
          },
        }
      : {}),
  };
}

function conciseText(value: string): string {
  return value.length <= MAX_AGENT_TEXT_LENGTH
    ? value
    : `${value.slice(0, MAX_AGENT_TEXT_LENGTH - 1)}…`;
}

function exactMessageQuery(args: Record<string, unknown>): ChatHistoryQuery {
  return {
    transport: requiredTransport(args.transport, "transport"),
    chatIds: [requiredString(args.chatId, "chatId")],
    messageId: requiredString(args.messageId, "messageId"),
    limit: 1,
  };
}

function cursorDirection(
  args: Record<string, unknown>,
): Pick<ChatHistoryQuery, "cursor" | "direction"> {
  const cursor = optionalString(args.cursor);
  if (cursor && !/^(?:0|[1-9]\d*)$/.test(cursor)) {
    throw new Error("cursor must be a non-negative timestamp");
  }
  const direction = args.direction === "forward" ? "forward" : "backward";
  return { ...(cursor ? { cursor } : {}), direction };
}

function timestamps(
  args: Record<string, unknown>,
): Pick<ChatHistoryQuery, "fromTimestamp" | "toTimestamp"> {
  const fromTimestamp = optionalInteger(args.fromTimestamp);
  const toTimestamp = optionalInteger(args.toTimestamp);
  return {
    ...(fromTimestamp === undefined ? {} : { fromTimestamp }),
    ...(toTimestamp === undefined ? {} : { toTimestamp }),
  };
}

function references(
  args: Record<string, unknown>,
): Pick<
  { replyTo?: MessageReference; threadTo?: MessageReference },
  "replyTo" | "threadTo"
> {
  const replyTo = reference(args.replyTo, "replyTo");
  const threadTo = reference(args.threadTo, "threadTo");
  return {
    ...(replyTo ? { replyTo } : {}),
    ...(threadTo ? { threadTo } : {}),
  };
}

function reference(value: unknown, name: string): MessageReference | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`${name} must be a message reference`);
  return {
    transport: requiredTransport(value.transport, `${name}.transport`),
    chatId: requiredString(value.chatId, `${name}.chatId`),
    messageId: requiredString(value.messageId, `${name}.messageId`),
  };
}

function publicDescriptor(
  descriptor: AgentOperationDescriptor,
): Omit<AgentOperationDescriptor, "execute"> {
  const { execute: _execute, ...publicValue } = descriptor;
  return publicValue;
}

function page<T>(
  items: T[],
  limit: number,
  cursor?: string,
): { items: T[]; nextCursor: string | null; hasMore: boolean } {
  const offset = cursorOffset(cursor);
  const pageItems = items.slice(offset, offset + limit);
  const hasMore = items.length > offset + pageItems.length;
  return {
    items: pageItems,
    nextCursor: hasMore ? String(offset + pageItems.length) : null,
    hasMore,
  };
}

function collectedPage<T>(
  items: T[],
  limit: number,
  cursor?: string,
): { items: T[]; nextCursor: string | null; hasMore: boolean } {
  const pageItems = items.slice(0, limit);
  const hasMore = items.length > pageItems.length;
  return {
    items: pageItems,
    nextCursor: hasMore
      ? String(cursorOffset(cursor) + pageItems.length)
      : null,
    hasMore,
  };
}

function cursorOffset(cursor: string | undefined): number {
  if (!cursor) return 0;
  if (!/^(?:0|[1-9]\d*)$/.test(cursor)) {
    throw new Error("cursor must be a non-negative decimal offset");
  }
  const offset = Number(cursor);
  if (!Number.isSafeInteger(offset)) {
    throw new Error("cursor offset is too large");
  }
  return offset;
}

function requiredTransport(value: unknown, name: string): TransportName {
  const transport = optionalTransport(value);
  if (!transport) throw new Error(`${name} must be a supported transport`);
  return transport;
}

function optionalTransport(value: unknown): TransportName | undefined {
  return ["matrix", "slack", "discord", "telegram", "whatsapp"].includes(
    String(value),
  )
    ? (value as TransportName)
    : undefined;
}

function requiredString(value: unknown, name: string): string {
  const result = optionalString(value);
  if (!result) throw new Error(`${name} must be a non-empty string`);
  return result;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function requiredBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${name} must be a boolean`);
  }
  return value;
}

function boundedLimit(value: unknown, fallback = 25, maximum = 100): number {
  return boundedInteger(value, fallback, 1, maximum);
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return typeof value === "number" && Number.isInteger(value)
    ? Math.max(minimum, Math.min(maximum, value))
    : fallback;
}

function optionalInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : undefined;
}

function validateSchema(
  schema: JsonSchema,
  value: unknown,
  path: string,
): void {
  const types = schema.type
    ? Array.isArray(schema.type)
      ? schema.type
      : [schema.type]
    : [];
  if (types.length && !types.some((type) => matchesType(type, value))) {
    throw new Error(`Invalid ${path}: expected ${types.join(" or ")}`);
  }
  if (schema.enum && !schema.enum.includes(value)) {
    throw new Error(
      `Invalid ${path}: expected one of ${schema.enum.join(", ")}`,
    );
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      throw new Error(`Invalid ${path}: must be at least ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      throw new Error(`Invalid ${path}: must be at most ${schema.maximum}`);
    }
  }
  if (
    typeof value === "string" &&
    schema.maximum !== undefined &&
    value.length > schema.maximum
  ) {
    throw new Error(
      `Invalid ${path}: must be at most ${schema.maximum} characters`,
    );
  }
  const itemsSchema = schema.items;
  if (Array.isArray(value) && itemsSchema) {
    value.forEach((item, index) =>
      validateSchema(itemsSchema, item, `${path}[${index}]`),
    );
  }
  if (!isRecord(value) || !schema.properties) return;
  const allowed = new Set(Object.keys(schema.properties));
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) {
        throw new Error(`Invalid ${path}: unknown field ${key}`);
      }
    }
  }
  for (const name of schema.required ?? []) {
    if (!(name in value)) {
      throw new Error(`Invalid ${path}: missing required field ${name}`);
    }
  }
  for (const [name, propertySchema] of Object.entries(schema.properties)) {
    if (name in value)
      validateSchema(propertySchema, value[name], `${path}.${name}`);
  }
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return isRecord(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    default:
      return false;
  }
}

function attachmentKind(
  mimeType: string,
): "image" | "file" | "audio" | "video" {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  return "file";
}

function inferMimeType(fileName: string): string {
  switch (extname(fileName).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".svg":
      return "image/svg+xml";
    case ".pdf":
      return "application/pdf";
    case ".json":
      return "application/json";
    case ".csv":
      return "text/csv";
    case ".md":
      return "text/markdown";
    case ".txt":
    case ".log":
      return "text/plain";
    case ".mp3":
      return "audio/mpeg";
    case ".wav":
      return "audio/wav";
    case ".mp4":
      return "video/mp4";
    case ".webm":
      return "video/webm";
    default:
      return "application/octet-stream";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
