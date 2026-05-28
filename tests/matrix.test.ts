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

async function tempStateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "umg-matrix-config-"));
  tempDirs.push(dir);
  return dir;
}
