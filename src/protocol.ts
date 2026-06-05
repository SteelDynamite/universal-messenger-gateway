export type TransportName =
  | "matrix"
  | "slack"
  | "discord"
  | "telegram"
  | "whatsapp";

export const TRANSPORT_NAMES = [
  "matrix",
  "slack",
  "discord",
  "telegram",
  "whatsapp",
] as const satisfies readonly TransportName[];

export type MessageReference = {
  transport: TransportName;
  chatId: string;
  messageId: string;
};

export type InboundMessage = {
  chatId: string;
  transport: TransportName;
  content: string;
  username?: string;
  userId?: string;
  timestamp: number;
  messageId?: string;
  isGroupChat: boolean;
  wasMentioned: boolean;
  replyTo?: MessageReference;
  threadTo?: MessageReference;
};

export type InboundReaction = {
  chatId: string;
  transport: TransportName;
  messageId: string;
  reaction: string;
  timestamp: number;
  reactionId?: string;
  username?: string;
  userId?: string;
};

export type SendMessageCommand = {
  type: "send_message";
  transport: TransportName;
  chatId: string;
  text: string;
  replyTo?: MessageReference;
  threadTo?: MessageReference;
};

export type SendReactionCommand = {
  type: "send_reaction";
  transport: TransportName;
  chatId: string;
  messageId: string;
  reaction: string;
};

export type SendTypingCommand = {
  type: "send_typing";
  transport: TransportName;
  chatId: string;
};

export type StatusCommand = {
  type: "status";
};

export type ConfigureTransportCommand = {
  type: "configure_transport";
  transport: TransportName;
  enabled?: boolean;
  settings?: Record<string, unknown>;
};

export type ConnectTransportCommand = {
  type: "connect_transport";
  transport: TransportName;
};

export type DisconnectTransportCommand = {
  type: "disconnect_transport";
  transport: TransportName;
};

export type GatewayCommand =
  | SendMessageCommand
  | SendReactionCommand
  | SendTypingCommand
  | StatusCommand
  | ConfigureTransportCommand
  | ConnectTransportCommand
  | DisconnectTransportCommand;

export type GatewayEvent =
  | {
      type: "message";
      message: InboundMessage;
    }
  | {
      type: "reaction";
      reaction: InboundReaction;
    }
  | {
      type: "admin_result";
      command: GatewayCommand["type"];
      ok: boolean;
      output: string;
    };

export function isGatewayCommand(value: unknown): value is GatewayCommand {
  if (!isRecord(value)) {
    return false;
  }

  if (value.type === "send_message") {
    return (
      isTransportName(value.transport) &&
      typeof value.chatId === "string" &&
      typeof value.text === "string" &&
      isOptionalMessageReference(value.replyTo) &&
      isOptionalMessageReference(value.threadTo)
    );
  }

  if (value.type === "send_typing") {
    return isTransportName(value.transport) && typeof value.chatId === "string";
  }

  if (value.type === "send_reaction") {
    return (
      isTransportName(value.transport) &&
      typeof value.chatId === "string" &&
      typeof value.messageId === "string" &&
      typeof value.reaction === "string" &&
      value.reaction.length > 0
    );
  }

  if (value.type === "status") {
    return true;
  }

  if (value.type === "configure_transport") {
    return (
      isTransportName(value.transport) &&
      (value.enabled === undefined || typeof value.enabled === "boolean") &&
      (value.settings === undefined || isRecord(value.settings))
    );
  }

  if (
    value.type === "connect_transport" ||
    value.type === "disconnect_transport"
  ) {
    return isTransportName(value.transport);
  }

  return false;
}

export function isTransportName(value: unknown): value is TransportName {
  return TRANSPORT_NAMES.includes(value as TransportName);
}

function isOptionalMessageReference(
  value: unknown,
): value is MessageReference | undefined {
  if (value === undefined) {
    return true;
  }

  return (
    isRecord(value) &&
    isTransportName(value.transport) &&
    typeof value.chatId === "string" &&
    typeof value.messageId === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
