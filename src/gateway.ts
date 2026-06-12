import type { Readable, Writable } from "node:stream";
import { JsonLineParseError, readJsonLines } from "./io/json-lines.js";
import {
  type GatewayCommand,
  type GatewayEvent,
  isGatewayCommand,
} from "./protocol.js";

export type GatewayCommandHandler = (
  command: GatewayCommand,
) => Promise<void> | void;

export type GatewayCommandErrorHandler = (
  command: GatewayCommand,
  event: GatewayEvent,
) => Promise<void> | void;

export type RunGatewayStdioOptions = {
  input: Readable;
  errorOutput: Writable;
  handleCommand: GatewayCommandHandler;
  handleCommandError?: GatewayCommandErrorHandler;
};

export async function runGatewayStdio({
  input,
  errorOutput,
  handleCommand,
  handleCommandError,
}: RunGatewayStdioOptions): Promise<number> {
  try {
    for await (const value of readJsonLines(input)) {
      if (!isGatewayCommand(value)) {
        errorOutput.write("Invalid gateway command\n");
        continue;
      }

      try {
        await handleCommand(value);
      } catch (error) {
        if (!handleCommandError) {
          throw error;
        }
        await handleCommandError(value, commandErrorEvent(value, error));
      }
    }
  } catch (error) {
    if (error instanceof JsonLineParseError) {
      errorOutput.write(`${error.message}\n`);
      return 1;
    }

    throw error;
  }

  return 0;
}

function commandErrorEvent(
  command: GatewayCommand,
  error: unknown,
): GatewayEvent {
  return {
    type: "command_error",
    command: command.type,
    error: error instanceof Error ? error.message : String(error),
    ...("transport" in command ? { transport: command.transport } : {}),
    ...("chatId" in command ? { chatId: command.chatId } : {}),
    ...("messageId" in command ? { messageId: command.messageId } : {}),
    ...("inviteId" in command ? { inviteId: command.inviteId } : {}),
  };
}
