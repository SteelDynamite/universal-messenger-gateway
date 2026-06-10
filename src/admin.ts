import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Writable } from "node:stream";
import {
  type GatewayConfig,
  type TransportConfig,
  loadGatewayConfig,
  saveGatewayConfig,
} from "./config.js";
import {
  TRANSPORT_NAMES,
  type TransportName,
  isTransportName,
} from "./protocol.js";
import { resolveStateDir } from "./state.js";
import type { TransportRegistry } from "./transports/registry.js";

export type RunAdminCliOptions = {
  args: string[];
  output: Writable;
  errorOutput: Writable;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  registry?: TransportRegistry;
};

type ParsedSetting = {
  key: string;
  value: unknown;
};

export async function runAdminCli({
  args,
  output,
  errorOutput,
  env = process.env,
  cwd = process.cwd(),
  registry,
}: RunAdminCliOptions): Promise<number> {
  const [command, ...commandArgs] = args;
  const stateDir = resolveStateDir(env, cwd);

  if (command === "status") {
    const config = await loadGatewayConfig(stateDir);
    const activeRegistry =
      registry ??
      (await import("./transports/registry.js")).defaultTransportRegistry;
    writeStatus(output, config, stateDir, activeRegistry);
    return 0;
  }

  if (command === "configure") {
    return configureTransport(commandArgs, stateDir, output, errorOutput);
  }

  if (command === "connect") {
    return setTransportEnabled(
      commandArgs,
      true,
      stateDir,
      output,
      errorOutput,
    );
  }

  if (command === "disconnect") {
    return setTransportEnabled(
      commandArgs,
      false,
      stateDir,
      output,
      errorOutput,
    );
  }

  errorOutput.write(adminUsage());
  return 1;
}

function writeStatus(
  output: Writable,
  config: GatewayConfig,
  stateDir: string,
  registry: TransportRegistry,
): void {
  output.write(`State: ${stateDir}\n`);

  for (const transport of TRANSPORT_NAMES) {
    const transportConfig = config.transports[transport];
    const enabled = transportConfig?.enabled === true;
    const available = registry[transport] ? "available" : "unavailable";
    const settingKeys = Object.keys(transportConfig?.settings ?? {}).sort();
    const settings = settingKeys.length > 0 ? settingKeys.join(", ") : "none";
    output.write(
      `${transport}: ${enabled ? "enabled" : "disabled"}, ${available}, settings: ${settings}\n`,
    );
  }
}

async function configureTransport(
  args: string[],
  stateDir: string,
  output: Writable,
  errorOutput: Writable,
): Promise<number> {
  const [transportArg, ...flags] = args;
  const transport = parseTransport(transportArg, errorOutput);

  if (!transport) {
    return 1;
  }

  const parsed = parseConfigureFlags(flags, errorOutput);

  if (!parsed) {
    return 1;
  }

  const config = await loadGatewayConfig(stateDir);
  const current = config.transports[transport] ?? {};
  const { accessToken: _legacyAccessToken, ...restSettings } =
    current.settings ?? {};
  void _legacyAccessToken;
  const settings = { ...restSettings };
  let matrixAccessToken: string | undefined;

  for (const setting of parsed.settings) {
    if (transport === "matrix" && setting.key === "accessToken") {
      matrixAccessToken = String(setting.value);
      continue;
    }
    settings[setting.key] = setting.value;
  }

  config.transports[transport] = compactTransportConfig({
    ...current,
    ...(parsed.enabled === undefined ? {} : { enabled: parsed.enabled }),
    ...(Object.keys(settings).length > 0 ? { settings } : {}),
  });

  await saveGatewayConfig(stateDir, config);
  if (matrixAccessToken !== undefined) {
    await writeSecret(
      join(stateDir, "matrix-access-token.txt"),
      matrixAccessToken,
    );
  }
  output.write(`Configured ${transport} in ${stateDir}\n`);
  return 0;
}

async function setTransportEnabled(
  args: string[],
  enabled: boolean,
  stateDir: string,
  output: Writable,
  errorOutput: Writable,
): Promise<number> {
  const transport = parseTransport(args[0], errorOutput);

  if (!transport) {
    return 1;
  }
  if (args.length > 1) {
    errorOutput.write(`Unexpected argument: ${args[1]}\n`);
    return 1;
  }

  const config = await loadGatewayConfig(stateDir);
  config.transports[transport] = compactTransportConfig({
    ...(config.transports[transport] ?? {}),
    enabled,
  });

  await saveGatewayConfig(stateDir, config);
  output.write(`${transport} ${enabled ? "enabled" : "disabled"}\n`);
  return 0;
}

function parseConfigureFlags(
  args: string[],
  errorOutput: Writable,
): { enabled?: boolean; settings: ParsedSetting[] } | undefined {
  const settings: ParsedSetting[] = [];
  let enabled: boolean | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--enable") {
      enabled = true;
      continue;
    }
    if (arg === "--disable") {
      enabled = false;
      continue;
    }
    if (arg === "--set") {
      const assignment = args[index + 1];
      if (!assignment) {
        errorOutput.write("Missing value after --set\n");
        return undefined;
      }
      const setting = parseSetting(assignment, errorOutput);
      if (!setting) {
        return undefined;
      }
      settings.push(setting);
      index += 1;
      continue;
    }
    if (arg?.startsWith("--set=")) {
      const setting = parseSetting(arg.slice("--set=".length), errorOutput);
      if (!setting) {
        return undefined;
      }
      settings.push(setting);
      continue;
    }

    errorOutput.write(`Unknown configure option: ${arg}\n`);
    return undefined;
  }

  return { ...(enabled === undefined ? {} : { enabled }), settings };
}

function parseSetting(
  assignment: string,
  errorOutput: Writable,
): ParsedSetting | undefined {
  const separator = assignment.indexOf("=");

  if (separator <= 0) {
    errorOutput.write("Settings must use key=value\n");
    return undefined;
  }

  return {
    key: assignment.slice(0, separator),
    value: parseSettingValue(assignment.slice(separator + 1)),
  };
}

function parseSettingValue(value: string): unknown {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return value;
}

function parseTransport(
  value: string | undefined,
  errorOutput: Writable,
): TransportName | undefined {
  if (!value) {
    errorOutput.write(
      `Missing transport. Available: ${TRANSPORT_NAMES.join(", ")}\n`,
    );
    return undefined;
  }

  if (!isTransportName(value)) {
    errorOutput.write(`Unknown transport: ${value}\n`);
    return undefined;
  }

  return value;
}

function compactTransportConfig(config: TransportConfig): TransportConfig {
  return {
    ...(config.enabled === undefined ? {} : { enabled: config.enabled }),
    ...(config.settings && Object.keys(config.settings).length > 0
      ? { settings: config.settings }
      : {}),
  };
}

async function writeSecret(path: string, value: string): Promise<void> {
  await writeFile(path, value, { mode: 0o600 });
  await chmod(path, 0o600);
}

function adminUsage(): string {
  return [
    "Admin commands:",
    "  status",
    "  configure <transport> [--enable|--disable] [--set key=value]...",
    "  connect <transport>",
    "  disconnect <transport>",
    "",
  ].join("\n");
}
