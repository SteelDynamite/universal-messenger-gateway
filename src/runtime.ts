import type { GatewayConfig } from "./config.js";
import type { TransportManager } from "./transports/manager.js";
import type { TransportRegistry } from "./transports/registry.js";

export function cliTransportRegistry(): TransportRegistry {
  return {
    matrix() {
      throw new Error("status-only transport registry");
    },
  };
}

export async function createConfiguredTransportList(
  config: GatewayConfig,
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

export async function replaceAndConnectTransports(
  manager: TransportManager,
  config: GatewayConfig,
  stateDir: string,
): Promise<void> {
  await manager.replaceTransports(
    await createConfiguredTransportList(config, stateDir),
  );
  await manager.connectAll();
}
