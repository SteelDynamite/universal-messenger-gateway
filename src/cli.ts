#!/usr/bin/env node

import { Writable } from "node:stream";
import { runAdminCli } from "./admin.js";
import { runChatCli } from "./chat.js";
import { loadGatewayConfig } from "./config.js";
import { runGatewayStdio } from "./gateway.js";
import { writeJsonLine } from "./io/json-lines.js";
import {
  type GatewayCommand,
  TRANSPORT_NAMES,
  type TransportName,
} from "./protocol.js";
import { resolveStateDir } from "./state.js";
import {
  TransportManager,
  UnknownTransportError,
} from "./transports/manager.js";
import type { TransportRegistry } from "./transports/registry.js";

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

  manager.onMessage((message) => {
    void writeJsonLine(process.stdout, { type: "message", message });
  });
  manager.onReaction((reaction) => {
    void writeJsonLine(process.stdout, { type: "reaction", reaction });
  });
  manager.onError((transport, error) => {
    process.stderr.write(
      `Transport error from ${transport}: ${String(error)}\n`,
    );
  });

  await manager.connectAll();

  const exitCode = await runGatewayStdio({
    input: process.stdin,
    errorOutput: process.stderr,
    async handleCommand(receivedCommand) {
      if (isAdminGatewayCommand(receivedCommand)) {
        await handleAdminGatewayCommand(receivedCommand, manager, stateDir);
        return;
      }

      try {
        await manager.handleCommand(receivedCommand);
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
    manager,
    async runAdminCommand(args, output, errorOutput) {
      return runAdminCli({ args, output, errorOutput });
    },
    async reloadTransports() {
      const updatedConfig = await loadGatewayConfig(stateDir);
      await manager.replaceTransports(
        await createConfiguredTransportList(updatedConfig, stateDir),
      );
      await manager.connectAll();
    },
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

function isAdminGatewayCommand(command: GatewayCommand): boolean {
  return (
    command.type === "status" ||
    command.type === "configure_transport" ||
    command.type === "connect_transport" ||
    command.type === "disconnect_transport"
  );
}

async function handleAdminGatewayCommand(
  command: GatewayCommand,
  manager: TransportManager,
  stateDir: string,
): Promise<void> {
  const args = adminArgsForGatewayCommand(command);
  const output = stringWritable();
  const errorOutput = stringWritable();
  const exitCode = await runAdminCli({
    args,
    output,
    errorOutput,
    ...(command.type === "status" ? { registry: cliTransportRegistry() } : {}),
  });

  if (exitCode === 0 && command.type !== "status") {
    try {
      const updatedConfig = await loadGatewayConfig(stateDir);
      await manager.replaceTransports(
        await createConfiguredTransportList(updatedConfig, stateDir),
      );
      await manager.connectAll();
    } catch (error) {
      await writeJsonLine(process.stdout, {
        type: "admin_result",
        command: command.type,
        ok: false,
        output: `${output.text()}${errorOutput.text()}Transport configuration saved but could not be applied: ${String(error)}\n`,
      });
      return;
    }
  }

  await writeJsonLine(process.stdout, {
    type: "admin_result",
    command: command.type,
    ok: exitCode === 0,
    output: `${output.text()}${errorOutput.text()}`,
  });
}

function adminArgsForGatewayCommand(command: GatewayCommand): string[] {
  switch (command.type) {
    case "status":
      return ["status"];
    case "connect_transport":
      return ["connect", command.transport];
    case "disconnect_transport":
      return ["disconnect", command.transport];
    case "configure_transport": {
      const args = ["configure", command.transport];
      if (command.enabled === true) {
        args.push("--enable");
      } else if (command.enabled === false) {
        args.push("--disable");
      }
      for (const [key, value] of Object.entries(command.settings ?? {})) {
        args.push("--set", `${key}=${String(value)}`);
      }
      return args;
    }
    default:
      throw new Error(`Not an admin gateway command: ${command.type}`);
  }
}

function cliTransportRegistry(): TransportRegistry {
  return {
    matrix() {
      throw new Error("status-only transport registry");
    },
  };
}

function stringWritable(): Writable & { text(): string } {
  const chunks: string[] = [];

  const writable = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  }) as Writable & { text(): string };

  writable.text = () => chunks.join("");
  return writable;
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

async function createConfiguredTransportList(
  config: Awaited<ReturnType<typeof loadGatewayConfig>>,
  stateDir: string,
) {
  if (
    !Object.values(config.transports).some((transport) => transport.enabled)
  ) {
    return [];
  }

  const { createConfiguredTransports } = await import(
    "./transports/registry.js"
  );
  return createConfiguredTransports(config, { stateDir });
}

function handleTransportCreationError(error: unknown, stateDir: string): never {
  const unavailable = error as { name?: string; message?: string };
  if (unavailable.name === "UnavailableTransportError") {
    process.stderr.write(`${unavailable.message} (${stateDir})\n`);
    process.exit(1);
  }

  throw error;
}
