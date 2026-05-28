#!/usr/bin/env node

import { runChatCli } from "./chat.js";
import { loadGatewayConfig } from "./config.js";
import { ManagerGatewayClient } from "./gateway-client.js";
import { runGatewayStdio } from "./gateway.js";
import { writeJsonLine } from "./io/json-lines.js";
import { TRANSPORT_NAMES, type TransportName } from "./protocol.js";
import { createConfiguredTransportList } from "./runtime.js";
import { resolveStateDir } from "./state.js";
import {
  TransportManager,
  UnknownTransportError,
} from "./transports/manager.js";

const [command] = process.argv.slice(2);

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
    void writeJsonLine(process.stdout, event);
  });
  client.onError((transport, error) => {
    process.stderr.write(
      `Transport error from ${transport}: ${String(error)}\n`,
    );
  });

  await client.connect();

  const exitCode = await runGatewayStdio({
    input: process.stdin,
    errorOutput: process.stderr,
    async handleCommand(receivedCommand) {
      try {
        await client.send(receivedCommand);
      } catch (error) {
        if (error instanceof UnknownTransportError) {
          process.stderr.write(
            `Transport is not configured: ${error.transport} (${stateDir})\n`,
          );
          return;
        }

        throw error;
      }
    },
  });

  process.exitCode = exitCode;
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
    "Commands:",
    "  chat         Run an interactive agent session",
    "  gateway      Run the machine-readable JSON-lines gateway",
    "",
    "Transports:",
    ...TRANSPORT_NAMES.map(
      (transport) => `  ${transport.padEnd(10)} ${transportStatus(transport)}`,
    ),
    "",
    "State:",
    "  Uses ./state by default. Override with UNIVERSAL_MESSENGER_GATEWAY_STATE_DIR=/path.",
    "",
  ].join("\n");
}

function transportStatus(transport: TransportName): string {
  return transport === "matrix" ? "available" : "planned";
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
