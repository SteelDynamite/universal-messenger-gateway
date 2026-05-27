import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  CONFIG_FILE_NAME,
  ConfigError,
  configPathForStateDir,
  loadGatewayConfig,
  parseGatewayConfig,
  saveGatewayConfig,
} from "../src/index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
  tempDirs.length = 0;
});

test("loads empty config when no config file exists", async () => {
  const stateDir = await tempStateDir();

  await expect(loadGatewayConfig(stateDir)).resolves.toEqual({
    transports: {},
  });
});

test("loads transport config from state/config.json", async () => {
  const stateDir = await tempStateDir();
  await writeFile(
    join(stateDir, CONFIG_FILE_NAME),
    JSON.stringify({
      transports: {
        matrix: {
          enabled: true,
          settings: { homeserverUrl: "https://matrix.example" },
        },
      },
    }),
  );

  await expect(loadGatewayConfig(stateDir)).resolves.toEqual({
    transports: {
      matrix: {
        enabled: true,
        settings: { homeserverUrl: "https://matrix.example" },
      },
    },
  });
});

test("rejects invalid config shapes", () => {
  expect(() => parseGatewayConfig("[]")).toThrow(ConfigError);
  expect(() => parseGatewayConfig('{"transports":[]}')).toThrow(ConfigError);
  expect(() => parseGatewayConfig('{"transports":{"irc":{}}}')).toThrow(
    ConfigError,
  );
  expect(() =>
    parseGatewayConfig('{"transports":{"matrix":{"enabled":"yes"}}}'),
  ).toThrow(ConfigError);
});

test("builds config paths under the state directory", () => {
  expect(configPathForStateDir("/repo/state")).toBe("/repo/state/config.json");
});

test("saves config under the state directory", async () => {
  const stateDir = await tempStateDir();

  await saveGatewayConfig(stateDir, {
    transports: { matrix: { enabled: true } },
  });

  await expect(
    readFile(join(stateDir, CONFIG_FILE_NAME), "utf8"),
  ).resolves.toBe(
    '{\n  "transports": {\n    "matrix": {\n      "enabled": true\n    }\n  }\n}\n',
  );
});

async function tempStateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "umg-state-"));
  tempDirs.push(dir);
  return dir;
}
