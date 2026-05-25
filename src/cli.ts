#!/usr/bin/env node

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
  let manager: TransportManager;

  try {
    manager = new TransportManager(
      createConfiguredTransports(config, { stateDir }),
    );
  } catch (error) {
    if (error instanceof UnavailableTransportError) {
      process.stderr.write(`${error.message} (${stateDir})\n`);
      process.exit(1);
    } else {
      throw error;
    }
  }

  manager.onMessage((message) => {
    void writeJsonLine(process.stdout, { type: "message", message });
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
} else {
  process.stderr.write("Usage: umg gateway\n");
  process.exitCode = 1;
}
