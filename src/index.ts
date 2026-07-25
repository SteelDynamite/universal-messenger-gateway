export { runChatCli, type RunChatCliOptions } from "./chat.js";
export {
  createGateway,
  type CreateGatewayOptions,
  type Gateway,
} from "./sdk.js";
export { runAdminCli, type RunAdminCliOptions } from "./admin.js";
export {
  ManagerGatewayClient,
  type GatewayClient,
  type GatewayEventHandler,
} from "./gateway-client.js";
export {
  AGENT_OPERATION_DESCRIPTORS,
  executeAgentOperation,
  type AgentOperationDescriptor,
  type AgentOperationGroup,
  type AgentOperationHelp,
  type AgentOperationName,
  type AgentOperationRequest,
  type AgentOperationResult,
  type JsonSchema,
} from "./agent-operations.js";
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
  saveGatewayConfig,
} from "./config.js";
export type {
  AcceptInviteCommand,
  ChatHistoryDirection,
  ChatHistoryMessage,
  ChatHistoryQuery,
  ChatHistorySearchResult,
  GatewayCommand,
  GatewayEvent,
  InboundInvite,
  InboundMessage,
  InboundReaction,
  InboundTypingSnapshot,
  MessageReference,
  MessageRelation,
  MessageRelationsResult,
  PinnedMessageResolution,
  PinnedMessageStatus,
  SendMessageCommand,
  SendReactionCommand,
  SetTypingCommand,
  TransportName,
} from "./protocol.js";

export {
  isGatewayCommand,
  isTransportName,
  TRANSPORT_NAMES,
} from "./protocol.js";
export {
  runGatewayStdio,
  type GatewayCommandErrorHandler,
  type GatewayCommandHandler,
} from "./gateway.js";
export { resolveStateDir, STATE_DIR_ENV } from "./state.js";
export {
  DuplicateTransportError,
  TransportManager,
  UnknownTransportError,
  type GatewayInviteHandler,
  type GatewayMessageHandler,
  type GatewayReactionHandler,
  type GatewayTypingHandler,
  type GatewayTransportErrorHandler,
} from "./transports/manager.js";
export type {
  TransportChat,
  TransportErrorHandler,
  TransportHealth,
  TransportHealthStatus,
  TransportInvite,
  TransportInviteHandler,
  TransportMember,
  TransportMessageHandler,
  TransportProvider,
  TransportReactionHandler,
  TransportTypingHandler,
} from "./transports/interface.js";
export {
  createMatrixProvider,
  MatrixDecryptionError,
  MatrixConfigError,
  MatrixProvider,
  parseMatrixConfig,
} from "./transports/matrix.js";
export {
  createMautrixMatrixProvider,
  MautrixMatrixDecryptionError,
  MautrixMatrixProvider,
  parseMautrixMatrixConfig,
  type MautrixMatrixConfig,
} from "./transports/matrix-mautrix.js";
export {
  createConfiguredTransports,
  defaultTransportRegistry,
  UnavailableTransportError,
  type TransportFactory,
  type TransportFactoryContext,
  type TransportRegistry,
} from "./transports/registry.js";
