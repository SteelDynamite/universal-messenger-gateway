import type { Readable, Writable } from "node:stream";
import { JsonLineParseError, readJsonLines } from "./io/json-lines.js";
import { type GatewayCommand, isGatewayCommand } from "./protocol.js";

export type GatewayCommandHandler = (
  command: GatewayCommand,
) => Promise<void> | void;

export type RunGatewayStdioOptions = {
  input: Readable;
  errorOutput: Writable;
  handleCommand: GatewayCommandHandler;
};

export async function runGatewayStdio({
  input,
  errorOutput,
  handleCommand,
}: RunGatewayStdioOptions): Promise<number> {
  try {
    for await (const value of readJsonLines(input)) {
      if (!isGatewayCommand(value)) {
        errorOutput.write("Invalid gateway command\n");
        continue;
      }

      await handleCommand(value);
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
