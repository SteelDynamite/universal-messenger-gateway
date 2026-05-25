import type { InboundMessage, TransportName } from "../protocol.js";

export type TransportMessageHandler = (message: InboundMessage) => void;
export type TransportErrorHandler = (error: unknown) => void;

export interface TransportProvider {
  readonly type: TransportName;
  readonly isConnected: boolean;

  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendMessage(chatId: string, text: string): Promise<void>;
  sendTyping(chatId: string): Promise<void>;
  onMessage(handler: TransportMessageHandler): void;
  onError(handler: TransportErrorHandler): void;
}
