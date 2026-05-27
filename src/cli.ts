#!/usr/bin/env node

import { runAdminCli } from "./admin.js";
import { runChatCli } from "./chat.js";
import { loadGatewayConfig } from "./config.js";
import { runGatewayStdio } from "./gateway.js";
import { writeJsonLine } from "./io/json-lines.js";
import { resolveStateDir } from "./state.js";
import {
  TransportManager,
  UnknownTransportError,
} from "./transports/manager.js";
import {
  UnavailableTransportError,
  createConfiguredTransports,
} from "./transports/registry.js";

const [command] = process.argv.slice(2);

if (command === "gateway") {
  const stateDir = resolveStateDir();
  const config = await loadGatewayConfig(stateDir);
  const manager = createManager(config, stateDir);

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
  const manager = createManager(config, stateDir);

  const exitCode = await runChatCli({
    input: process.stdin,
    output: process.stdout,
    errorOutput: process.stderr,
    manager,
  });
  hardExit(exitCode);
} else if (
  command === "status" ||
  command === "configure" ||
  command === "connect" ||
  command === "disconnect"
) {
  process.exitCode = await runAdminCli({
    args: process.argv.slice(2),
    output: process.stdout,
    errorOutput: process.stderr,
  });
} else {
  process.stderr.write(
    "Usage: umg <gateway|chat|status|configure|connect|disconnect>\n",
  );
  process.exitCode = 1;
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

function createManager(
  config: Awaited<ReturnType<typeof loadGatewayConfig>>,
  stateDir: string,
): TransportManager {
  try {
    return new TransportManager(
      createConfiguredTransports(config, { stateDir }),
    );
  } catch (error) {
    if (error instanceof UnavailableTransportError) {
      process.stderr.write(`${error.message} (${stateDir})\n`);
      process.exit(1);
    }

    throw error;
  }
}
