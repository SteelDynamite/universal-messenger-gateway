import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, expect, test } from "vitest";
import { CONFIG_FILE_NAME, runAdminCli } from "../src/index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
  tempDirs.length = 0;
});

test("configures transport settings", async () => {
  const stateDir = await tempStateDir();

  const exitCode = await runAdminCli({
    args: [
      "configure",
      "matrix",
      "--enable",
      "--set",
      "homeserverUrl=https://matrix.example",
      "--set=accessToken=secret",
      "--set=encryption=false",
    ],
    output: collectOutput(),
    errorOutput: collectOutput(),
    env: { UNIVERSAL_MESSENGER_GATEWAY_STATE_DIR: stateDir },
    cwd: "/repo",
  });

  expect(exitCode).toBe(0);
  await expect(readConfig(stateDir)).resolves.toEqual({
    transports: {
      matrix: {
        enabled: true,
        settings: {
          homeserverUrl: "https://matrix.example",
          accessToken: "secret",
          encryption: false,
        },
      },
    },
  });
});

test("prints status without setting values", async () => {
  const stateDir = await tempStateDir();
  await runAdminCli({
    args: ["configure", "matrix", "--enable", "--set", "accessToken=secret"],
    output: collectOutput(),
    errorOutput: collectOutput(),
    env: { UNIVERSAL_MESSENGER_GATEWAY_STATE_DIR: stateDir },
    cwd: "/repo",
  });
  const output = collectOutput();

  const exitCode = await runAdminCli({
    args: ["status"],
    output,
    errorOutput: collectOutput(),
    env: { UNIVERSAL_MESSENGER_GATEWAY_STATE_DIR: stateDir },
    cwd: "/repo",
    registry: {},
  });

  expect(exitCode).toBe(0);
  expect(output.text()).toContain(
    "matrix: enabled, unavailable, settings: accessToken",
  );
  expect(output.text()).not.toContain("secret");
});

test("connect and disconnect toggle transport enabled state", async () => {
  const stateDir = await tempStateDir();

  await runAdminCli({
    args: ["connect", "matrix"],
    output: collectOutput(),
    errorOutput: collectOutput(),
    env: { UNIVERSAL_MESSENGER_GATEWAY_STATE_DIR: stateDir },
    cwd: "/repo",
  });
  await expect(readConfig(stateDir)).resolves.toEqual({
    transports: { matrix: { enabled: true } },
  });

  await runAdminCli({
    args: ["disconnect", "matrix"],
    output: collectOutput(),
    errorOutput: collectOutput(),
    env: { UNIVERSAL_MESSENGER_GATEWAY_STATE_DIR: stateDir },
    cwd: "/repo",
  });
  await expect(readConfig(stateDir)).resolves.toEqual({
    transports: { matrix: { enabled: false } },
  });
});

test("rejects unknown transports", async () => {
  const errorOutput = collectOutput();

  const exitCode = await runAdminCli({
    args: ["connect", "irc"],
    output: collectOutput(),
    errorOutput,
    env: {},
    cwd: "/repo",
  });

  expect(exitCode).toBe(1);
  expect(errorOutput.text()).toContain("Unknown transport: irc");
});

async function readConfig(stateDir: string): Promise<unknown> {
  return JSON.parse(await readFile(join(stateDir, CONFIG_FILE_NAME), "utf8"));
}

async function tempStateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "umg-admin-"));
  tempDirs.push(dir);
  return dir;
}

function collectOutput(): Writable & { text(): string } {
  let contents = "";

  return Object.assign(
    new Writable({
      write(chunk, _encoding, callback) {
        contents += String(chunk);
        callback();
      },
    }),
    {
      text: () => contents,
    },
  );
}
