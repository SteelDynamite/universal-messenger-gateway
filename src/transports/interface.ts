import type { InboundMessage, TransportName } from "../protocol.js";

export type TransportMessageHandler = (message: InboundMessage) => void;
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

export interface TransportProvider {
  readonly type: TransportName;
  readonly isConnected: boolean;

  connect(): Promise<void>;
  disconnect(): Promise<void>;
  shutdownForProcessExit?(): void;
  listChats?(): Promise<TransportChat[]>;
  listInvites?(): Promise<TransportInvite[]>;
  sendMessage(chatId: string, text: string): Promise<void>;
  sendTyping(chatId: string): Promise<void>;
  leaveChat?(chatId: string, reason?: string): Promise<void>;
  acceptInvite?(inviteId: string): Promise<void>;
  rejectInvite?(inviteId: string, reason?: string): Promise<void>;
  onMessage(handler: TransportMessageHandler): void;
  onError(handler: TransportErrorHandler): void;
}
