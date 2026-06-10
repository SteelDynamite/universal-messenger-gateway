#!/usr/bin/env node

import { runChatCli } from "./chat.js";
import { loadGatewayConfig } from "./config.js";
import { ManagerGatewayClient } from "./gateway-client.js";
import { runGatewayStdio } from "./gateway.js";
import { writeJsonLine } from "./io/json-lines.js";
import { TRANSPORT_NAMES, type TransportName } from "./protocol.js";
import { createConfiguredTransportList } from "./runtime.js";
import { runSetupCli } from "./setup.js";
import { resolveStateDir } from "./state.js";
import { TransportManager } from "./transports/manager.js";

const [command, subcommand] = process.argv.slice(2);

if (
  !command ||
  command === "help" ||
  command === "--help" ||
  command === "-h"
) {
  process.stdout.write(usage());
  process.exitCode = 0;
} else if (command === "gateway") {
  const stateDir = resolveStateDir();
  const config = await loadGatewayConfig(stateDir);
  const manager = await createManager(config, stateDir);

  const client = new ManagerGatewayClient({ manager, stateDir });
  client.onEvent((event) => {
    void writeGatewayEvent(event);
  });
  client.onError((transport, error) => {
    process.stderr.write(
      `Transport error from ${transport}: ${String(error)}\n`,
    );
  });

  await client.connect();

  let exitCode = 0;
  try {
    exitCode = await runGatewayStdio({
      input: process.stdin,
      errorOutput: process.stderr,
      handleCommand: (receivedCommand) => client.send(receivedCommand),
      handleCommandError: (_receivedCommand, event) => writeGatewayEvent(event),
    });
  } finally {
    try {
      await client.disconnect();
    } catch (error) {
      process.stderr.write(`Gateway disconnect failed: ${String(error)}\n`);
      process.exitCode = 1;
    }
  }
  process.exitCode ??= exitCode;
} else if (command === "chat") {
  const stateDir = resolveStateDir();
  const config = await loadGatewayConfig(stateDir);
  const manager = await createManager(config, stateDir);

  const exitCode = await runChatCli({
    input: process.stdin,
    output: process.stdout,
    errorOutput: process.stderr,
    client: new ManagerGatewayClient({
      manager,
      async reloadTransports() {
        const updatedConfig = await loadGatewayConfig(stateDir);
        await manager.replaceTransports(
          await createConfiguredTransportList(updatedConfig, stateDir),
        );
        await manager.connectAll();
      },
    }),
  });
  hardExit(exitCode);
} else if (command === "setup") {
  const stateDir = resolveStateDir();
  process.exitCode = await runSetupCli({
    input: process.stdin,
    output: process.stdout,
    errorOutput: process.stderr,
    stateDir,
    transport: subcommand,
  });
} else {
  process.stderr.write(usage());
  process.exitCode = 1;
}

function usage(): string {
  return [
    "Usage: umg <command>",
    "",
    "UMG lets an agent communicate through configured message transports.",
    "",
    "Start here:",
    "  umg chat",
    "      Run an interactive agent session. Use /status, /configure, /connect, and /disconnect inside chat.",
    "",
    "  umg gateway",
    "      Run a JSON-lines agent session. Send status/configure/connect/disconnect commands over stdin.",
    "",
    "  umg setup [transport]",
    "      Interactively configure a transport and local secret files.",
    "",
    "Commands:",
    "  chat         Run an interactive agent session",
    "  gateway      Run the machine-readable JSON-lines gateway",
    "  setup        Interactively configure a transport",
    "",
    "Transports:",
    ...TRANSPORT_NAMES.map(
      (transport) => `  ${transport.padEnd(10)} ${transportStatus(transport)}`,
    ),
    "",
    "State:",
    "  Uses ./state by default. Override with UNIVERSAL_MESSENGER_GATEWAY_STATE_DIR=/path.",
    "  Matrix secrets may live in state/matrix-access-token.txt and state/matrix-recovery-key.txt (chmod 600).",
    "",
  ].join("\n");
}

function transportStatus(transport: TransportName): string {
  return transport === "matrix" ? "available" : "planned";
}

async function writeGatewayEvent(event: unknown): Promise<void> {
  try {
    await writeJsonLine(process.stdout, event);
  } catch (error) {
    if (isBrokenPipe(error)) {
      process.exitCode = 1;
      return;
    }
    process.stderr.write(`Could not write gateway event: ${String(error)}\n`);
    process.exitCode = 1;
  }
}

function isBrokenPipe(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EPIPE"
  );
}

function hardExit(exitCode: number): never {
  const processWithHardExit = process as typeof process & {
    reallyExit?: (code?: number) => never;
  };

  if (processWithHardExit.reallyExit) {
    processWithHardExit.reallyExit(exitCode);
  }

  process.exit(exitCode);
}

async function createManager(
  config: Awaited<ReturnType<typeof loadGatewayConfig>>,
  stateDir: string,
): Promise<TransportManager> {
  try {
    return new TransportManager(
      await createConfiguredTransportList(config, stateDir),
    );
  } catch (error) {
    handleTransportCreationError(error, stateDir);
  }
}

function handleTransportCreationError(error: unknown, stateDir: string): never {
  const unavailable = error as { name?: string; message?: string };
  if (unavailable.name === "UnavailableTransportError") {
    process.stderr.write(`${unavailable.message} (${stateDir})\n`);
    process.exit(1);
  }

  throw error;
}
