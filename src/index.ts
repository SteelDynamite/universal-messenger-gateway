export type {
  GatewayCommand,
  GatewayEvent,
  InboundMessage,
  MessageReference,
  SendMessageCommand,
  SendTypingCommand,
  TransportName,
} from "./protocol.js";

export { isGatewayCommand } from "./protocol.js";
export { runGatewayStdio, type GatewayCommandHandler } from "./gateway.js";
export { resolveStateDir, STATE_DIR_ENV } from "./state.js";
