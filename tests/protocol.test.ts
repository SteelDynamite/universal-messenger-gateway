import { expect, test } from "vitest";
import type { GatewayCommand, GatewayEvent } from "../src/index.js";

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
      replyTo: {
        transport: "matrix",
        chatId: "!room:example.org",
        messageId: "$previous",
      },
    },
  } satisfies GatewayEvent;

  expect(event.message.content).toBe("hello");
});

test("models outbound gateway commands", () => {
  const commands = [
    {
      type: "send_message",
      transport: "matrix",
      chatId: "!room:example.org",
      text: "hello back",
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
