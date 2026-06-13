import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import {
  type GatewayConfig,
  loadGatewayConfig,
  saveGatewayConfig,
} from "./config.js";
import { isTransportName } from "./protocol.js";

export type RunSetupCliOptions = {
  input: Readable;
  output: Writable;
  errorOutput: Writable;
  stateDir: string;
  transport?: string | undefined;
};

export async function runSetupCli({
  input,
  output,
  errorOutput,
  stateDir,
  transport,
}: RunSetupCliOptions): Promise<number> {
  const questioner = createQuestioner(input, output);
  try {
    const selected =
      transport ?? (await questioner.question("Transport [matrix]: "));
    const normalizedSelected = selected.trim() || "matrix";
    if (!isTransportName(normalizedSelected)) {
      errorOutput.write(`Unknown transport: ${normalizedSelected}\n`);
      return 1;
    }

    if (normalizedSelected !== "matrix") {
      errorOutput.write(
        `Setup for ${normalizedSelected} is not available yet.\n`,
      );
      return 1;
    }

    await setupMatrix({
      output,
      stateDir,
      question: questioner.question,
    });
    return 0;
  } finally {
    questioner.close();
  }
}

async function setupMatrix({
  output,
  stateDir,
  question,
}: {
  output: Writable;
  stateDir: string;
  question: (query: string) => Promise<string>;
}): Promise<void> {
  await mkdir(stateDir, { mode: 0o700, recursive: true });
  await chmod(stateDir, 0o700);
  const config = await loadGatewayConfig(stateDir);
  const existing = config.transports.matrix?.settings ?? {};
  const existingHomeserver = stringSetting(existing.homeserverUrl);
  const existingEncryption = booleanSetting(existing.encryption) ?? true;

  output.write("Matrix setup\n");
  const homeserverUrl = await prompt(output, question, {
    label: "Homeserver URL",
    ...(existingHomeserver ? { defaultValue: existingHomeserver } : {}),
    required: true,
  });
  const encryption = await promptYesNo(
    output,
    question,
    "Enable encryption?",
    existingEncryption,
  );
  const accessTokenFile = join(stateDir, "matrix-access-token.txt");
  const accessToken = await promptSecret(output, question, {
    label: "Access token",
    existingFile: accessTokenFile,
  });

  const {
    accessToken: _accessToken,
    recoveryKey: _recoveryKey,
    ...settings
  } = existing;
  void _accessToken;
  void _recoveryKey;
  config.transports.matrix = {
    enabled: true,
    settings: {
      ...settings,
      homeserverUrl,
      encryption,
    },
  };

  await saveGatewayConfig(stateDir, config);
  if (accessToken !== undefined) {
    await writeSecret(accessTokenFile, accessToken);
  }
  if (encryption) {
    output.write("Matrix E2EE will use the mautrix SQLite crypto store.\n");
  }
  output.write(`Matrix configured in ${stateDir}. Run: umg chat\n`);
}

async function prompt(
  output: Writable,
  question: (query: string) => Promise<string>,
  opts: { label: string; defaultValue?: string; required?: boolean },
): Promise<string> {
  const suffix = opts.defaultValue ? ` [${opts.defaultValue}]` : "";
  while (true) {
    const answer = (await question(`${opts.label}${suffix}: `)).trim();
    const value = answer || opts.defaultValue || "";
    if (value || !opts.required) {
      return value;
    }
    output.write(`${opts.label} is required.\n`);
  }
}

async function promptYesNo(
  output: Writable,
  question: (query: string) => Promise<string>,
  label: string,
  defaultValue: boolean,
): Promise<boolean> {
  const suffix = defaultValue ? " [Y/n]" : " [y/N]";
  while (true) {
    const answer = (await question(`${label}${suffix}: `)).trim().toLowerCase();
    if (!answer) {
      return defaultValue;
    }
    if (["y", "yes"].includes(answer)) {
      return true;
    }
    if (["n", "no"].includes(answer)) {
      return false;
    }
    output.write("Answer yes or no.\n");
  }
}

async function promptSecret(
  output: Writable,
  question: (query: string) => Promise<string>,
  opts: { label: string; existingFile: string; optional?: boolean },
): Promise<string | undefined> {
  const existing = await fileExists(opts.existingFile);
  const suffix = existing
    ? " [leave blank to keep existing]"
    : opts.optional
      ? " [optional]"
      : "";
  while (true) {
    const answer = await question(`${opts.label}${suffix}: `);
    const value = answer.trim();
    if (value) {
      return value;
    }
    if (existing || opts.optional) {
      return undefined;
    }
    output.write(`${opts.label} is required.\n`);
  }
}

/* Non-TTY setup uses visible prompts so tests and piped setup work. Interactive secret masking can be added around this prompt boundary later. */

function createQuestioner(
  input: Readable,
  output: Writable,
): { question: (query: string) => Promise<string>; close: () => void } {
  const iterator = input[Symbol.asyncIterator]();
  let buffer = "";
  let closed = false;

  return {
    async question(query) {
      output.write(query);
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, "");
          buffer = buffer.slice(newline + 1);
          return line;
        }

        const next = await iterator.next();
        if (next.done) {
          const line = buffer;
          buffer = "";
          return line;
        }
        buffer += Buffer.isBuffer(next.value)
          ? next.value.toString("utf8")
          : String(next.value);
      }
    },
    close() {
      if (!closed && iterator.return) {
        closed = true;
        void iterator.return();
      }
    },
  };
}

async function writeSecret(path: string, value: string): Promise<void> {
  await writeFile(path, value, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path, "utf8");
    return true;
  } catch (error) {
    return !isNotFoundError(error);
  }
}

function stringSetting(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function booleanSetting(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "ENOENT"
  );
}
