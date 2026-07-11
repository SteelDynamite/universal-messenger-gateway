import { Readable } from "node:stream";
import { expect, test } from "vitest";
import {
  type JsonLineParseError,
  readJsonLines,
} from "../src/io/json-lines.js";

test("reads newline-delimited JSON values", async () => {
  const input = Readable.from([
    '{"type":"set_typing","transport":"matrix","chatId":"room","typing":true}\n\n',
  ]);

  await expect(collect(input)).resolves.toEqual([
    { type: "set_typing", transport: "matrix", chatId: "room", typing: true },
  ]);
});

test("reports invalid JSON line numbers", async () => {
  const input = Readable.from(['{"ok":true}\nnot-json\n']);

  await expect(collect(input)).rejects.toMatchObject<JsonLineParseError>({
    lineNumber: 2,
    line: "not-json",
  });
});

async function collect(input: Readable): Promise<unknown[]> {
  const values = [];

  for await (const value of readJsonLines(input)) {
    values.push(value);
  }

  return values;
}
