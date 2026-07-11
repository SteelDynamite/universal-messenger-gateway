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

export type ChatHistoryQuery = {
  transport: TransportName;
  query?: string;
  chatIds?: string[];
  messageId?: string;
  fromTimestamp?: number;
  toTimestamp?: number;
  limit?: number;
  maxMessagesPerChat?: number;
};

export type ChatHistoryMessage = {
  transport: TransportName;
  chatId: string;
  messageId: string;
  content: string;
  timestamp: number;
  username?: string;
  userId?: string;
  permalink?: string;
  attachments?: MediaAttachment[];
  replyTo?: MessageReference;
  threadTo?: MessageReference;
};

export type ChatHistorySearchResult = {
  messages: ChatHistoryMessage[];
  scannedChats: number;
  scannedMessages: number;
  skippedDecryption?: number;
  partial?: boolean;
  errors?: string[];
};

export type MediaAttachmentKind = "image" | "file" | "audio" | "video";

export type MediaAttachmentDownload = {
  status: "downloaded" | "skipped" | "failed";
  localPath?: string;
  sizeBytes?: number;
  sha256?: string;
  error?: string;
};

export type MediaAttachment = {
  mediaId: string;
  kind: MediaAttachmentKind;
  fileName?: string;
  mimeType?: string;
  sizeBytes?: number;
  description?: string;
  download?: MediaAttachmentDownload;
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
  attachments?: MediaAttachment[];
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

export type InboundInvite = {
  transport: TransportName;
  inviteId: string;
  displayName?: string;
  inviter?: string;
};

export type InboundTypingSnapshot = {
  transport: TransportName;
  chatId: string;
  userIds: string[];
  observedAt: number;
};

export type SendMessageCommand = {
  type: "send_message";
  transport: TransportName;
  chatId: string;
  text: string;
  replyTo?: MessageReference;
  threadTo?: MessageReference;
};

export type SendFileCommand = {
  type: "send_file";
  transport: TransportName;
  chatId: string;
  path: string;
  fileName?: string;
  mimeType?: string;
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

export type SetTypingCommand = {
  type: "set_typing";
  transport: TransportName;
  chatId: string;
  typing: boolean;
  timeoutMs?: number;
};

export type AcceptInviteCommand = {
  type: "accept_invite";
  transport: TransportName;
  inviteId: string;
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
  | SendFileCommand
  | SendReactionCommand
  | SetTypingCommand
  | AcceptInviteCommand
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
      type: "invite";
      invite: InboundInvite;
    }
  | {
      type: "typing";
      typing: InboundTypingSnapshot;
    }
  | {
      type: "admin_result";
      command: GatewayCommand["type"];
      ok: boolean;
      output: string;
    }
  | {
      type: "command_error";
      command: GatewayCommand["type"];
      error: string;
      transport?: TransportName;
      chatId?: string;
      messageId?: string;
      inviteId?: string;
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

  if (value.type === "send_file") {
    return (
      isTransportName(value.transport) &&
      typeof value.chatId === "string" &&
      typeof value.path === "string" &&
      value.path.length > 0 &&
      (value.fileName === undefined || typeof value.fileName === "string") &&
      (value.mimeType === undefined || typeof value.mimeType === "string") &&
      isOptionalMessageReference(value.replyTo) &&
      isOptionalMessageReference(value.threadTo)
    );
  }

  if (value.type === "set_typing") {
    return (
      isTransportName(value.transport) &&
      typeof value.chatId === "string" &&
      typeof value.typing === "boolean" &&
      (value.timeoutMs === undefined ||
        (typeof value.timeoutMs === "number" &&
          Number.isSafeInteger(value.timeoutMs) &&
          value.timeoutMs > 0))
    );
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

  if (value.type === "accept_invite") {
    return (
      isTransportName(value.transport) &&
      typeof value.inviteId === "string" &&
      value.inviteId.length > 0
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
