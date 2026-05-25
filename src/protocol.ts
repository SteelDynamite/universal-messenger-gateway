export type TransportName =
  | "matrix"
  | "slack"
  | "discord"
  | "telegram"
  | "whatsapp";

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
};

export type SendMessageCommand = {
  type: "send_message";
  transport: TransportName;
  chatId: string;
  text: string;
  replyTo?: MessageReference;
};

export type SendTypingCommand = {
  type: "send_typing";
  transport: TransportName;
  chatId: string;
};

export type GatewayCommand = SendMessageCommand | SendTypingCommand;

export type GatewayEvent = {
  type: "message";
  message: InboundMessage;
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
      isOptionalMessageReference(value.replyTo)
    );
  }

  if (value.type === "send_typing") {
    return isTransportName(value.transport) && typeof value.chatId === "string";
  }

  return false;
}

export function isTransportName(value: unknown): value is TransportName {
  return (
    value === "matrix" ||
    value === "slack" ||
    value === "discord" ||
    value === "telegram" ||
    value === "whatsapp"
  );
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
