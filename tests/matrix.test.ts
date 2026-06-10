import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  MatrixConfigError,
  MatrixProvider,
  createConfiguredTransports,
  parseMatrixConfig,
} from "../src/index.js";
import {
  createMatrixLogger,
  createSyncFilterLogger,
  matrixRelatesTo,
  messageReferences,
} from "../src/transports/matrix.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
  tempDirs.length = 0;
});

test("parses Matrix transport settings", () => {
  expect(
    parseMatrixConfig({
      enabled: true,
      settings: {
        homeserverUrl: "https://matrix.example",
        accessToken: "token",
        encryption: true,
        selfCrossSign: "reset",
      },
    }),
  ).toEqual({
    homeserverUrl: "https://matrix.example",
    accessToken: "token",
    encryption: true,
    selfCrossSign: "reset",
  });
});

test("rejects Matrix config without homeserver or token", () => {
  expect(() => parseMatrixConfig({ enabled: true, settings: {} })).toThrow(
    MatrixConfigError,
  );
  expect(() =>
    parseMatrixConfig({
      enabled: true,
      settings: { homeserverUrl: "https://matrix.example" },
    }),
  ).toThrow(MatrixConfigError);
});

test("parses Matrix access token from state file", async () => {
  const stateDir = await tempStateDir();
  await writeFile(join(stateDir, "matrix-access-token.txt"), "token\n");
  await chmod(join(stateDir, "matrix-access-token.txt"), 0o600);

  expect(
    parseMatrixConfig(
      {
        enabled: true,
        settings: { homeserverUrl: "https://matrix.example" },
      },
      stateDir,
    ),
  ).toEqual({
    homeserverUrl: "https://matrix.example",
    accessToken: "token",
  });
});

test("default registry creates Matrix transport", () => {
  const transports = createConfiguredTransports(
    {
      transports: {
        matrix: {
          enabled: true,
          settings: {
            homeserverUrl: "https://matrix.example",
            accessToken: "token",
          },
        },
      },
    },
    { stateDir: "/state" },
  );

  expect(transports).toHaveLength(1);
  expect(transports[0]).toBeInstanceOf(MatrixProvider);
});

test("parses Matrix direct reply references", () => {
  expect(
    messageReferences(
      "!room",
      {
        "m.relates_to": { "m.in_reply_to": { event_id: "$previous" } },
      },
      "matrix",
    ),
  ).toEqual({
    replyTo: { transport: "matrix", chatId: "!room", messageId: "$previous" },
  });
});

test("parses Matrix thread fallback separately from direct replies", () => {
  expect(
    messageReferences(
      "!room",
      {
        "m.relates_to": {
          rel_type: "m.thread",
          event_id: "$root",
          "m.in_reply_to": { event_id: "$root" },
          is_falling_back: true,
        },
      },
      "matrix",
    ),
  ).toEqual({
    threadTo: { transport: "matrix", chatId: "!room", messageId: "$root" },
  });
});

test("parses Matrix replies inside threads", () => {
  expect(
    messageReferences(
      "!room",
      {
        "m.relates_to": {
          rel_type: "m.thread",
          event_id: "$root",
          "m.in_reply_to": { event_id: "$previous" },
        },
      },
      "matrix",
    ),
  ).toEqual({
    replyTo: { transport: "matrix", chatId: "!room", messageId: "$previous" },
    threadTo: { transport: "matrix", chatId: "!room", messageId: "$root" },
  });
});

test("formats Matrix threaded outbound relations", () => {
  expect(
    matrixRelatesTo("!room", "matrix", undefined, {
      transport: "matrix",
      chatId: "!room",
      messageId: "$root",
    }),
  ).toEqual({
    rel_type: "m.thread",
    event_id: "$root",
    "m.in_reply_to": { event_id: "$root" },
    is_falling_back: true,
  });
});

test("Matrix logger writes to the provided non-stdout stream", () => {
  const chunks: string[] = [];
  const logger = createMatrixLogger({
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
  });

  logger.info("MatrixClientLite", "connected");
  logger.error("MatrixHttpClient", new Error("failed"));

  expect(chunks.join("")).toContain("[INFO] [MatrixClientLite] connected");
  expect(chunks.join("")).toContain("[ERROR] [MatrixHttpClient] Error: failed");
});

test("Matrix logger filters noisy sync errors", () => {
  const chunks: string[] = [];
  const logger = createSyncFilterLogger(
    createMatrixLogger({
      write(chunk: string) {
        chunks.push(chunk);
        return true;
      },
    }),
  );

  logger.error("MatrixClientLite", "Decryption error from backlog");
  logger.error("MatrixHttpClient", "M_NOT_FOUND missing relation");
  logger.error("MatrixHttpClient", "M_FORBIDDEN send failed");

  const output = chunks.join("");
  expect(output).not.toContain("Decryption error");
  expect(output).not.toContain("M_NOT_FOUND");
  expect(output).toContain("M_FORBIDDEN send failed");
});

test("formats Matrix replies inside threads", () => {
  expect(
    matrixRelatesTo(
      "!room",
      "matrix",
      { transport: "matrix", chatId: "!room", messageId: "$previous" },
      { transport: "matrix", chatId: "!room", messageId: "$root" },
    ),
  ).toEqual({
    rel_type: "m.thread",
    event_id: "$root",
    "m.in_reply_to": { event_id: "$previous" },
  });
});

async function tempStateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "umg-matrix-config-"));
  tempDirs.push(dir);
  return dir;
}
