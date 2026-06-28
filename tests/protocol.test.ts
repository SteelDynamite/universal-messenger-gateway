import { expect, test } from "vitest";
import type {
  ChatHistorySearchResult,
  GatewayCommand,
  GatewayEvent,
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
  } satisfies ChatHistorySearchResult;

  expect(result.messages[0]?.permalink).toContain("matrix.to");
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
      type: "send_reaction",
      transport: "matrix",
      chatId: "!room:example.org",
      messageId: "$event",
      reaction: "+1",
    },
    {
      type: "send_typing",
      transport: "matrix",
      chatId: "!room:example.org",
    },
    {
      type: "accept_invite",
      transport: "matrix",
      inviteId: "!room:example.org",
    },
  ] satisfies GatewayCommand[];

  expect(commands).toHaveLength(4);
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
