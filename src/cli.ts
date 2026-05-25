#!/usr/bin/env node

import { runGatewayStdio } from "./gateway.js";
import { resolveStateDir } from "./state.js";

const [command] = process.argv.slice(2);

if (command === "gateway") {
  const stateDir = resolveStateDir();
  const exitCode = await runGatewayStdio({
    input: process.stdin,
    errorOutput: process.stderr,
    handleCommand(receivedCommand) {
      process.stderr.write(
        `Transport handling is not implemented yet: ${receivedCommand.type} (${stateDir})\n`,
      );
    },
  });

  process.exitCode = exitCode;
} else {
  process.stderr.write("Usage: umg gateway\n");
  process.exitCode = 1;
}
