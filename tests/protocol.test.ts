import { expect, test } from "vitest";
import type { GatewayCommand, GatewayEvent } from "../src/index.js";
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
  ] satisfies GatewayCommand[];

  expect(commands).toHaveLength(3);
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
