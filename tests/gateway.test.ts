import { Readable, Writable } from "node:stream";
import { expect, test } from "vitest";
import { runGatewayStdio } from "../src/index.js";

test("passes valid commands to the gateway handler", async () => {
  const input = Readable.from([
    '{"type":"send_typing","transport":"matrix","chatId":"room"}\n{"type":"send_reaction","transport":"matrix","chatId":"room","messageId":"$event","reaction":"+1"}\n',
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
