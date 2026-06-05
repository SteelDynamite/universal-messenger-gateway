import type {
  InboundMessage,
  InboundReaction,
  MessageReference,
  TransportName,
} from "../protocol.js";

export type TransportMessageHandler = (message: InboundMessage) => void;
export type TransportReactionHandler = (reaction: InboundReaction) => void;
export type TransportErrorHandler = (error: unknown) => void;

export type TransportChat = {
  chatId: string;
  displayName?: string;
};

export type TransportInvite = {
  inviteId: string;
  displayName?: string;
  inviter?: string;
};

export type TransportHealthStatus = "ready" | "degraded" | "disabled";

export type TransportHealth = {
  category: string;
  status: TransportHealthStatus;
  summary: string;
  details?: string[];
};

export interface TransportProvider {
  readonly type: TransportName;
  readonly isConnected: boolean;

  connect(): Promise<void>;
  disconnect(): Promise<void>;
  shutdownForProcessExit?(): void;
  listChats?(): Promise<TransportChat[]>;
  listInvites?(): Promise<TransportInvite[]>;
  health?(): Promise<TransportHealth[]>;
  sendMessage(
    chatId: string,
    text: string,
    replyTo?: MessageReference,
    threadTo?: MessageReference,
  ): Promise<void>;
  sendReaction?(
    chatId: string,
    messageId: string,
    reaction: string,
  ): Promise<void>;
  sendTyping(chatId: string): Promise<void>;
  leaveChat?(chatId: string, reason?: string): Promise<void>;
  acceptInvite?(inviteId: string): Promise<void>;
  rejectInvite?(inviteId: string, reason?: string): Promise<void>;
  onMessage(handler: TransportMessageHandler): void;
  onReaction?(handler: TransportReactionHandler): void;
  onError(handler: TransportErrorHandler): void;
}
