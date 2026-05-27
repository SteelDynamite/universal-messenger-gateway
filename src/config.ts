import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type TransportName, isTransportName } from "./protocol.js";

export const CONFIG_FILE_NAME = "config.json";

export type TransportConfig = {
  enabled?: boolean;
  settings?: Record<string, unknown>;
};

export type GatewayConfig = {
  transports: Partial<Record<TransportName, TransportConfig>>;
};

export class ConfigError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConfigError";
  }
}

export function configPathForStateDir(stateDir: string): string {
  return join(stateDir, CONFIG_FILE_NAME);
}

export async function loadGatewayConfig(
  stateDir: string,
): Promise<GatewayConfig> {
  const configPath = configPathForStateDir(stateDir);

  try {
    return parseGatewayConfig(await readFile(configPath, "utf8"));
  } catch (error) {
    if (isNotFoundError(error)) {
      return emptyGatewayConfig();
    }

    throw error;
  }
}

export async function saveGatewayConfig(
  stateDir: string,
  config: GatewayConfig,
): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  await writeFile(
    configPathForStateDir(stateDir),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );
}

export function parseGatewayConfig(source: string): GatewayConfig {
  let value: unknown;

  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new ConfigError("Config file is not valid JSON", { cause: error });
  }

  return validateGatewayConfig(value);
}

export function emptyGatewayConfig(): GatewayConfig {
  return { transports: {} };
}

function validateGatewayConfig(value: unknown): GatewayConfig {
  if (!isRecord(value)) {
    throw new ConfigError("Config must be an object");
  }

  if (value.transports === undefined) {
    return emptyGatewayConfig();
  }

  if (!isRecord(value.transports)) {
    throw new ConfigError("Config transports must be an object");
  }

  const transports: GatewayConfig["transports"] = {};

  for (const [transport, config] of Object.entries(value.transports)) {
    if (!isTransportName(transport)) {
      throw new ConfigError(`Unknown transport in config: ${transport}`);
    }

    transports[transport] = validateTransportConfig(transport, config);
  }

  return { transports };
}

function validateTransportConfig(
  transport: TransportName,
  value: unknown,
): TransportConfig {
  if (!isRecord(value)) {
    throw new ConfigError(`Config for ${transport} must be an object`);
  }

  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    throw new ConfigError(`Config for ${transport}.enabled must be a boolean`);
  }

  if (value.settings !== undefined && !isRecord(value.settings)) {
    throw new ConfigError(`Config for ${transport}.settings must be an object`);
  }

  return {
    ...(value.enabled !== undefined ? { enabled: value.enabled } : {}),
    ...(value.settings !== undefined ? { settings: value.settings } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFoundError(error: unknown): boolean {
  return (
    isRecord(error) &&
    "code" in error &&
    (error as { code: unknown }).code === "ENOENT"
  );
}
