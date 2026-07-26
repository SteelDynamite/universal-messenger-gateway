import type {
  ChatHistoryQuery,
  ChatHistorySearchResult,
  InboundMessage,
  InboundReaction,
  InboundTypingSnapshot,
  MediaAttachmentKind,
  MessageReference,
  MessageRelationsResult,
  PinnedMessageResolution,
  TransportName,
} from "../protocol.js";

export type TransportMessageHandler = (message: InboundMessage) => void;
export type TransportReactionHandler = (reaction: InboundReaction) => void;
export type TransportTypingHandler = (typing: InboundTypingSnapshot) => void;
export type TransportInviteHandler = (invite: TransportInvite) => void;
export type TransportErrorHandler = (error: unknown) => void;

export type TransportChat = {
  chatId: string;
  displayName?: string;
  topic?: string;
  avatarUrl?: string;
  type?: string;
};

export type TransportInvite = {
  inviteId: string;
  displayName?: string;
  inviter?: string;
};

export type TransportMember = {
  userId: string;
  displayName?: string;
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
  listMembers?(
    chatId: string,
    limit?: number,
    cursor?: string,
  ): Promise<TransportMember[]>;
  getPinnedMessages?(
    chatId: string,
    limit?: number,
    cursor?: string,
  ): Promise<PinnedMessageResolution[]>;
  getRelations?(
    chatId: string,
    messageId: string,
    limit?: number,
    cursor?: string,
  ): Promise<MessageRelationsResult>;
  health?(): Promise<TransportHealth[]>;
  searchHistory?(query: ChatHistoryQuery): Promise<ChatHistorySearchResult>;
  sendMessage(
    chatId: string,
    text: string,
    replyTo?: MessageReference,
    threadTo?: MessageReference,
  ): Promise<void>;
  sendFile?(
    chatId: string,
    path: string,
    fileName?: string,
    mimeType?: string,
    replyTo?: MessageReference,
    threadTo?: MessageReference,
    kind?: MediaAttachmentKind,
    caption?: string,
  ): Promise<void>;
  sendReaction?(
    chatId: string,
    messageId: string,
    reaction: string,
  ): Promise<void>;
  setTyping(chatId: string, typing: boolean, timeoutMs?: number): Promise<void>;
  leaveChat?(chatId: string, reason?: string): Promise<void>;
  acceptInvite?(inviteId: string): Promise<void>;
  rejectInvite?(inviteId: string, reason?: string): Promise<void>;
  onMessage(handler: TransportMessageHandler): void;
  onReaction?(handler: TransportReactionHandler): void;
  onTyping?(handler: TransportTypingHandler): void;
  onInvite?(handler: TransportInviteHandler): void;
  onError(handler: TransportErrorHandler): void;
}
