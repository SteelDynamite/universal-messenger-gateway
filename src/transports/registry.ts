import type { GatewayConfig, TransportConfig } from "../config.js";
import type { TransportName } from "../protocol.js";
import type { TransportProvider } from "./interface.js";

export type TransportFactory = (config: TransportConfig) => TransportProvider;
export type TransportRegistry = Partial<
  Record<TransportName, TransportFactory>
>;

export class UnavailableTransportError extends Error {
  constructor(readonly transport: TransportName) {
    super(`Transport is not available in this build: ${transport}`);
    this.name = "UnavailableTransportError";
  }
}

export const defaultTransportRegistry: TransportRegistry = {};

export function createConfiguredTransports(
  config: GatewayConfig,
  registry: TransportRegistry = defaultTransportRegistry,
): TransportProvider[] {
  const transports: TransportProvider[] = [];

  for (const [transport, transportConfig] of Object.entries(
    config.transports,
  )) {
    if (!transportConfig.enabled) {
      continue;
    }

    const factory = registry[transport as TransportName];

    if (!factory) {
      throw new UnavailableTransportError(transport as TransportName);
    }

    transports.push(factory(transportConfig));
  }

  return transports;
}
