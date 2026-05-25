export type {
  GatewayConfig,
  TransportConfig,
} from "./config.js";
export {
  CONFIG_FILE_NAME,
  ConfigError,
  configPathForStateDir,
  emptyGatewayConfig,
  loadGatewayConfig,
  parseGatewayConfig,
} from "./config.js";
export type {
  GatewayCommand,
  GatewayEvent,
  InboundMessage,
  MessageReference,
  SendMessageCommand,
  SendTypingCommand,
  TransportName,
} from "./protocol.js";

export { isGatewayCommand, isTransportName } from "./protocol.js";
export { runGatewayStdio, type GatewayCommandHandler } from "./gateway.js";
export { resolveStateDir, STATE_DIR_ENV } from "./state.js";
export {
  DuplicateTransportError,
  TransportManager,
  UnknownTransportError,
  type GatewayMessageHandler,
  type GatewayTransportErrorHandler,
} from "./transports/manager.js";
export type {
  TransportErrorHandler,
  TransportMessageHandler,
  TransportProvider,
} from "./transports/interface.js";
export {
  createConfiguredTransports,
  defaultTransportRegistry,
  UnavailableTransportError,
  type TransportFactory,
  type TransportRegistry,
} from "./transports/registry.js";
