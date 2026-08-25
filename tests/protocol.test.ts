import { expect, test } from "vitest";
import type {
  ChatHistoryQuery,
  ChatHistorySearchResult,
  GatewayCommand,
  GatewayEvent,
  ThreadContext,
  ThreadContextQuery,
} from "../src/index.js";
import { isGatewayCommand } from "../src/index.js";

test("models inbound message events", () => {
  const event = {
    type: "message",
    message: {
      chatId: "!room:example.org",
      transport: "matrix",
      content: "hello",
      username: "alice",
      userId: "@alice:example.org",
      timestamp: 1_716_000_000_000,
      messageId: "$event",
      isGroupChat: true,
      wasMentioned: false,
      attachments: [
        {
          mediaId: "mxc://example/photo",
          kind: "image",
          fileName: "photo.png",
          mimeType: "image/png",
          sizeBytes: 1234,
          download: {
            status: "downloaded",
            localPath: "/state/media/photo.png",
            sizeBytes: 1234,
            sha256: "abc",
          },
        },
      ],
      replyTo: {
        transport: "matrix",
        chatId: "!room:example.org",
        messageId: "$previous",
      },
      threadTo: {
        transport: "matrix",
        chatId: "!room:example.org",
        messageId: "$root",
      },
    },
  } satisfies GatewayEvent;

  expect(event.message.content).toBe("hello");
  expect(event.message.attachments?.[0]?.kind).toBe("image");
  expect(event.message.attachments?.[0]?.download?.status).toBe("downloaded");
});

test("models chat history search results", () => {
  const result = {
    messages: [
      {
        transport: "matrix",
        chatId: "!room:example.org",
        messageId: "$event",
        content: "deployment notes",
        timestamp: 1_716_000_000_000,
        userId: "@alice:example.org",
        permalink: "https://matrix.to/#/!room%3Aexample.org/%24event",
      },
    ],
    scannedChats: 1,
    scannedMessages: 42,
    skippedDecryption: 3,
    partial: true,
    errors: ["search returned partial results at deadline"],
  } satisfies ChatHistorySearchResult;
  const query = {
    transport: "matrix",
    query: "deployment",
    messageId: "$event",
    fromTimestamp: 1_716_000_000_000,
    toTimestamp: 1_716_086_400_000,
  } satisfies ChatHistoryQuery;

  expect(query.messageId).toBe("$event");
  expect(query.fromTimestamp).toBeLessThan(query.toTimestamp);
  expect(result.messages[0]?.permalink).toContain("matrix.to");
});

test("models thread context resolution", () => {
  const query = {
    transport: "matrix",
    chatId: "!room:example.org",
    threadRootId: "$root",
    invocationId: "$reply",
    limit: 25,
    maxContentChars: 8_000,
    deadlineMs: 10_000,
  } satisfies ThreadContextQuery;
  const context = {
    root: {
      status: "available",
      wasMentioned: true,
      message: {
        transport: "matrix",
        chatId: query.chatId,
        messageId: query.threadRootId,
        content: "@bot deployment",
        timestamp: 1,
      },
    },
    history: {
      messages: [],
      statuses: ["undecryptable", "partial", "truncated"],
    },
  } satisfies ThreadContext;

  expect(context.root.wasMentioned).toBe(true);
  expect(context.history.statuses).toContain("truncated");
});

test("models inbound invite events", () => {
  const event = {
    type: "invite",
    invite: {
      transport: "matrix",
      inviteId: "!room:example.org",
      displayName: "Project Room",
      inviter: "@alice:example.org",
    },
  } satisfies GatewayEvent;

  expect(event.invite.inviter).toBe("@alice:example.org");
});

test("models outbound gateway commands", () => {
  const commands = [
    {
      type: "send_message",
      transport: "matrix",
      chatId: "!room:example.org",
      text: "hello back",
      threadTo: {
        transport: "matrix",
        chatId: "!room:example.org",
        messageId: "$root",
      },
    },
    {
      type: "send_file",
      transport: "matrix",
      chatId: "!room:example.org",
      path: "/tmp/session.html",
      fileName: "session.html",
      mimeType: "text/html",
      kind: "file",
      caption: "Session export",
      replyTo: {
        transport: "matrix",
        chatId: "!room:example.org",
        messageId: "$event",
      },
    },
    {
      type: "send_reaction",
      transport: "matrix",
      chatId: "!room:example.org",
      messageId: "$event",
      reaction: "+1",
    },
    {
      type: "set_typing",
      transport: "matrix",
      chatId: "!room:example.org",
      typing: true,
      timeoutMs: 10_000,
    },
    {
      type: "accept_invite",
      transport: "matrix",
      inviteId: "!room:example.org",
    },
  ] satisfies GatewayCommand[];

  expect(commands).toHaveLength(5);
  expect(commands.every(isGatewayCommand)).toBe(true);
});

test("rejects invalid file captions", () => {
  expect(
    isGatewayCommand({
      type: "send_file",
      transport: "matrix",
      chatId: "!room:example.org",
      path: "/tmp/file",
      caption: 42,
    }),
  ).toBe(false);
});

test("rejects legacy and invalid typing commands", () => {
  expect(
    isGatewayCommand({
      type: "send_typing",
      transport: "matrix",
      chatId: "!room:example.org",
    }),
  ).toBe(false);
  expect(
    isGatewayCommand({
      type: "set_typing",
      transport: "matrix",
      chatId: "!room:example.org",
      typing: true,
      timeoutMs: 0,
    }),
  ).toBe(false);
});

test("models inbound typing snapshots", () => {
  const event = {
    type: "typing",
    typing: {
      transport: "matrix",
      chatId: "!room:example.org",
      userIds: ["@alice:example.org"],
      observedAt: 1_716_000_000_000,
    },
  } satisfies GatewayEvent;

  expect(event.typing.userIds).toEqual(["@alice:example.org"]);
});

test("models gateway admin commands", () => {
  const commands = [
    { type: "status" },
    {
      type: "configure_transport",
      transport: "matrix",
      enabled: true,
      settings: { homeserverUrl: "https://matrix.example" },
    },
    { type: "connect_transport", transport: "matrix" },
    { type: "disconnect_transport", transport: "matrix" },
  ] satisfies GatewayCommand[];

  expect(commands.every(isGatewayCommand)).toBe(true);
});

test("models gateway admin result events", () => {
  const event = {
    type: "admin_result",
    command: "configure_transport",
    ok: true,
    output: "Configured matrix\n",
  } satisfies GatewayEvent;

  expect(event.ok).toBe(true);
});

test("models gateway command error events", () => {
  const event = {
    type: "command_error",
    command: "send_message",
    transport: "matrix",
    chatId: "!room:example.org",
    error: "M_FORBIDDEN",
  } satisfies GatewayEvent;

  expect(event.error).toBe("M_FORBIDDEN");
});

test("models inbound reaction events", () => {
  const event = {
    type: "reaction",
    reaction: {
      chatId: "!room:example.org",
      transport: "matrix",
      messageId: "$event",
      reaction: "+1",
      reactionId: "$reaction",
      username: "alice",
      userId: "@alice:example.org",
      timestamp: 1_716_000_000_000,
    },
  } satisfies GatewayEvent;

  expect(event.reaction.messageId).toBe("$event");
});
