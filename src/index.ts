export { runChatCli, type RunChatCliOptions } from "./chat.js";
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
  InboundReaction,
  MessageReference,
  SendMessageCommand,
  SendReactionCommand,
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
  type GatewayReactionHandler,
  type GatewayTransportErrorHandler,
} from "./transports/manager.js";
export type {
  TransportChat,
  TransportErrorHandler,
  TransportInvite,
  TransportMessageHandler,
  TransportProvider,
  TransportReactionHandler,
} from "./transports/interface.js";
export {
  createMatrixProvider,
  MatrixDecryptionError,
  MatrixConfigError,
  MatrixProvider,
  parseMatrixConfig,
} from "./transports/matrix.js";
export {
  createConfiguredTransports,
  defaultTransportRegistry,
  UnavailableTransportError,
  type TransportFactory,
  type TransportFactoryContext,
  type TransportRegistry,
} from "./transports/registry.js";
