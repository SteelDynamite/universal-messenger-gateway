import { once } from "node:events";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

export class JsonLineParseError extends Error {
  constructor(
    readonly lineNumber: number,
    readonly line: string,
    options?: ErrorOptions,
  ) {
    super(`Invalid JSON on line ${lineNumber}`, options);
    this.name = "JsonLineParseError";
  }
}

export async function* readJsonLines(input: Readable): AsyncGenerator<unknown> {
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  let lineNumber = 0;

  try {
    for await (const line of lines) {
      lineNumber += 1;

      if (line.trim() === "") {
        continue;
      }

      try {
        yield JSON.parse(line) as unknown;
      } catch (error) {
        throw new JsonLineParseError(lineNumber, line, { cause: error });
      }
    }
  } finally {
    lines.close();
  }
}

export async function writeJsonLine(
  output: Writable,
  value: unknown,
): Promise<void> {
  const canContinue = output.write(`${JSON.stringify(value)}\n`);

  if (!canContinue) {
    await once(output, "drain");
  }
}
