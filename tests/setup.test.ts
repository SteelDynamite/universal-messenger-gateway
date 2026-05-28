import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, expect, test } from "vitest";
import { runSetupCli } from "../src/setup.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
  tempDirs.length = 0;
});

test("sets up Matrix config and secret files", async () => {
  const stateDir = await tempStateDir();
  const output = new StringSink();

  const exitCode = await runSetupCli({
    input: Readable.from([
      "https://matrix.example\n",
      "y\n",
      "access-token\n",
      "recovery-key\n",
    ]),
    output,
    errorOutput: new StringSink(),
    stateDir,
    transport: "matrix",
  });

  expect(exitCode).toBe(0);
  expect(
    JSON.parse(await readFile(join(stateDir, "config.json"), "utf8")),
  ).toEqual({
    transports: {
      matrix: {
        enabled: true,
        settings: {
          homeserverUrl: "https://matrix.example",
          encryption: true,
        },
      },
    },
  });
  expect(
    await readFile(join(stateDir, "matrix-access-token.txt"), "utf8"),
  ).toBe("access-token");
  expect(
    await readFile(join(stateDir, "matrix-recovery-key.txt"), "utf8"),
  ).toBe("recovery-key");
  expect(
    (await stat(join(stateDir, "matrix-access-token.txt"))).mode & 0o777,
  ).toBe(0o600);
  expect(output.text()).toContain("Matrix configured");
});

test("keeps existing Matrix secrets when blank", async () => {
  const stateDir = await tempStateDir();
  await runSetupCli({
    input: Readable.from([
      "https://matrix.example\ny\naccess-token\nrecovery-key\n",
    ]),
    output: new StringSink(),
    errorOutput: new StringSink(),
    stateDir,
    transport: "matrix",
  });
  await chmod(join(stateDir, "matrix-access-token.txt"), 0o600);

  await runSetupCli({
    input: Readable.from(["https://matrix.example.org\nn\n\n"]),
    output: new StringSink(),
    errorOutput: new StringSink(),
    stateDir,
    transport: "matrix",
  });

  expect(
    await readFile(join(stateDir, "matrix-access-token.txt"), "utf8"),
  ).toBe("access-token");
  expect(
    JSON.parse(await readFile(join(stateDir, "config.json"), "utf8")).transports
      .matrix.settings,
  ).toEqual({
    homeserverUrl: "https://matrix.example.org",
    encryption: false,
  });
});

test("rejects unsupported setup transport", async () => {
  const stateDir = await tempStateDir();
  const errorOutput = new StringSink();

  const exitCode = await runSetupCli({
    input: Readable.from([]),
    output: new StringSink(),
    errorOutput,
    stateDir,
    transport: "slack",
  });

  expect(exitCode).toBe(1);
  expect(errorOutput.text()).toContain("not available yet");
});

class StringSink extends Writable {
  #chunks: string[] = [];

  _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.#chunks.push(chunk.toString());
    callback();
  }

  text(): string {
    return this.#chunks.join("");
  }
}

async function tempStateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "umg-setup-"));
  tempDirs.push(dir);
  return dir;
}
