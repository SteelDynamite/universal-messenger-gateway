import type {
  GatewayCommand,
  InboundMessage,
  InboundReaction,
  TransportName,
} from "../protocol.js";
import type { TransportProvider } from "./interface.js";

export type GatewayMessageHandler = (message: InboundMessage) => void;
export type GatewayReactionHandler = (reaction: InboundReaction) => void;
export type GatewayTransportErrorHandler = (
  transport: TransportName,
  error: unknown,
) => void;

export class UnknownTransportError extends Error {
  constructor(readonly transport: TransportName) {
    super(`Unknown transport: ${transport}`);
    this.name = "UnknownTransportError";
  }
}

export class DuplicateTransportError extends Error {
  constructor(readonly transport: TransportName) {
    super(`Duplicate transport: ${transport}`);
    this.name = "DuplicateTransportError";
  }
}

export class TransportManager {
  readonly transports = new Map<TransportName, TransportProvider>();
  readonly #messageHandlers = new Set<GatewayMessageHandler>();
  readonly #reactionHandlers = new Set<GatewayReactionHandler>();
  readonly #errorHandlers = new Set<GatewayTransportErrorHandler>();

  constructor(transports: Iterable<TransportProvider> = []) {
    for (const transport of transports) {
      this.addTransport(transport);
    }
  }

  addTransport(transport: TransportProvider): void {
    if (this.transports.has(transport.type)) {
      throw new DuplicateTransportError(transport.type);
    }

    this.transports.set(transport.type, transport);
    transport.onMessage((message) => this.emitMessage(message));
    transport.onReaction?.((reaction) => this.emitReaction(reaction));
    transport.onError((error) => this.emitError(transport.type, error));
  }

  onMessage(handler: GatewayMessageHandler): void {
    this.#messageHandlers.add(handler);
  }

  onReaction(handler: GatewayReactionHandler): void {
    this.#reactionHandlers.add(handler);
  }

  onError(handler: GatewayTransportErrorHandler): void {
    this.#errorHandlers.add(handler);
  }

  async connectAll(): Promise<void> {
    await Promise.all(
      [...this.transports.values()].map((transport) => transport.connect()),
    );
  }

  async disconnectAll(): Promise<void> {
    await Promise.all(
      [...this.transports.values()].map((transport) => transport.disconnect()),
    );
  }

  async handleCommand(command: GatewayCommand): Promise<void> {
    const transport = this.getTransport(command.transport);

    switch (command.type) {
      case "send_message":
        await transport.sendMessage(
          command.chatId,
          command.text,
          command.replyTo,
        );
        break;
      case "send_reaction":
        if (!transport.sendReaction) {
          throw new Error(
            `Transport does not support reactions: ${transport.type}`,
          );
        }
        await transport.sendReaction(
          command.chatId,
          command.messageId,
          command.reaction,
        );
        break;
      case "send_typing":
        await transport.sendTyping(command.chatId);
        break;
    }
  }

  getTransport(type: TransportName): TransportProvider {
    const transport = this.transports.get(type);

    if (!transport) {
      throw new UnknownTransportError(type);
    }

    return transport;
  }

  private emitMessage(message: InboundMessage): void {
    for (const handler of this.#messageHandlers) {
      handler(message);
    }
  }

  private emitReaction(reaction: InboundReaction): void {
    for (const handler of this.#reactionHandlers) {
      handler(reaction);
    }
  }

  private emitError(transport: TransportName, error: unknown): void {
    for (const handler of this.#errorHandlers) {
      handler(transport, error);
    }
  }
}
