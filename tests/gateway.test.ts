import { Readable, Writable } from "node:stream";
import { expect, test } from "vitest";
import { runGatewayStdio } from "../src/index.js";

test("passes valid commands to the gateway handler", async () => {
  const input = Readable.from([
    '{"type":"send_typing","transport":"matrix","chatId":"room"}\n{"type":"send_reaction","transport":"matrix","chatId":"room","messageId":"$event","reaction":"+1"}\n{"type":"status"}\n',
  ]);
  const errorOutput = sink();
  const commands = [];

  const exitCode = await runGatewayStdio({
    input,
    errorOutput,
    handleCommand(command) {
      commands.push(command);
    },
  });

  expect(exitCode).toBe(0);
  expect(commands).toEqual([
    { type: "send_typing", transport: "matrix", chatId: "room" },
    {
      type: "send_reaction",
      transport: "matrix",
      chatId: "room",
      messageId: "$event",
      reaction: "+1",
    },
    { type: "status" },
  ]);
});

test("emits command errors without stopping the stream", async () => {
  const input = Readable.from([
    '{"type":"send_message","transport":"matrix","chatId":"room","text":"hello"}\n{"type":"send_typing","transport":"matrix","chatId":"room"}\n',
  ]);
  const errorOutput = sink();
  const events = [];
  const commands = [];

  const exitCode = await runGatewayStdio({
    input,
    errorOutput,
    handleCommand(command) {
      commands.push(command.type);
      if (command.type === "send_message") {
        throw new Error("send failed");
      }
    },
    handleCommandError(_command, event) {
      events.push(event);
    },
  });

  expect(exitCode).toBe(0);
  expect(commands).toEqual(["send_message", "send_typing"]);
  expect(events).toEqual([
    {
      type: "command_error",
      command: "send_message",
      transport: "matrix",
      chatId: "room",
      error: "send failed",
    },
  ]);
});

test("rejects invalid commands without stopping the stream", async () => {
  const input = Readable.from([
    '{"type":"unknown"}\n{"type":"send_typing","transport":"matrix","chatId":"room"}\n',
  ]);
  const errorOutput = sink();
  const commands = [];

  const exitCode = await runGatewayStdio({
    input,
    errorOutput,
    handleCommand(command) {
      commands.push(command);
    },
  });

  expect(exitCode).toBe(0);
  expect(commands).toHaveLength(1);
});

function sink(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}
