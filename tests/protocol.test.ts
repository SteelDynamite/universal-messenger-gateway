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
      type: "send_typing",
      transport: "matrix",
      chatId: "!room:example.org",
    },
  ] satisfies GatewayCommand[];

  expect(commands).toHaveLength(2);
});
