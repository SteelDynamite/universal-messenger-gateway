import type {
  GatewayCommand,
  InboundInvite,
  InboundMessage,
  InboundReaction,
  InboundTypingSnapshot,
  TransportName,
} from "../protocol.js";
import type { TransportInvite, TransportProvider } from "./interface.js";

export type GatewayMessageHandler = (message: InboundMessage) => void;
export type GatewayReactionHandler = (reaction: InboundReaction) => void;
export type GatewayTypingHandler = (typing: InboundTypingSnapshot) => void;
export type GatewayInviteHandler = (invite: InboundInvite) => void;
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
  readonly #typingHandlers = new Set<GatewayTypingHandler>();
  readonly #inviteHandlers = new Set<GatewayInviteHandler>();
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
    transport.onMessage((message) => this.emitMessage(transport.type, message));
    transport.onReaction?.((reaction) =>
      this.emitReaction(transport.type, reaction),
    );
    transport.onTyping?.((typing) => this.emitTyping(transport.type, typing));
    transport.onInvite?.((invite) => this.emitInvite(transport.type, invite));
    transport.onError((error) => this.emitError(transport.type, error));
  }

  onMessage(handler: GatewayMessageHandler): void {
    this.#messageHandlers.add(handler);
  }

  onReaction(handler: GatewayReactionHandler): void {
    this.#reactionHandlers.add(handler);
  }

  onTyping(handler: GatewayTypingHandler): void {
    this.#typingHandlers.add(handler);
  }

  onInvite(handler: GatewayInviteHandler): void {
    this.#inviteHandlers.add(handler);
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

  async replaceTransports(
    transports: Iterable<TransportProvider>,
  ): Promise<void> {
    const nextTransports = [...transports];
    await this.disconnectAll();
    this.transports.clear();

    for (const transport of nextTransports) {
      this.addTransport(transport);
    }
  }

  async handleCommand(command: GatewayCommand): Promise<void> {
    switch (command.type) {
      case "send_message": {
        const transport = this.getTransport(command.transport);
        await transport.sendMessage(
          command.chatId,
          command.text,
          command.replyTo,
          command.threadTo,
        );
        break;
      }
      case "send_file": {
        const transport = this.getTransport(command.transport);
        if (!transport.sendFile) {
          throw new Error(
            `Transport does not support file sends: ${transport.type}`,
          );
        }
        await transport.sendFile(
          command.chatId,
          command.path,
          command.fileName,
          command.mimeType,
          command.replyTo,
          command.threadTo,
        );
        break;
      }
      case "send_reaction": {
        const transport = this.getTransport(command.transport);
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
      }
      case "set_typing": {
        const transport = this.getTransport(command.transport);
        await transport.setTyping(
          command.chatId,
          command.typing,
          command.timeoutMs,
        );
        break;
      }
      case "accept_invite": {
        const transport = this.getTransport(command.transport);
        if (!transport.acceptInvite) {
          throw new Error(
            `Transport does not support accepting invites: ${transport.type}`,
          );
        }
        await transport.acceptInvite(command.inviteId);
        break;
      }
    }
  }

  getTransport(type: TransportName): TransportProvider {
    const transport = this.transports.get(type);

    if (!transport) {
      throw new UnknownTransportError(type);
    }

    return transport;
  }

  private emitMessage(transport: TransportName, message: InboundMessage): void {
    for (const handler of this.#messageHandlers) {
      handler({ ...message, transport });
    }
  }

  private emitReaction(
    transport: TransportName,
    reaction: InboundReaction,
  ): void {
    for (const handler of this.#reactionHandlers) {
      handler({ ...reaction, transport });
    }
  }

  private emitTyping(
    transport: TransportName,
    typing: InboundTypingSnapshot,
  ): void {
    for (const handler of this.#typingHandlers) {
      handler({ ...typing, transport });
    }
  }

  private emitInvite(transport: TransportName, invite: TransportInvite): void {
    for (const handler of this.#inviteHandlers) {
      handler({
        inviteId: invite.inviteId,
        ...(invite.displayName ? { displayName: invite.displayName } : {}),
        ...(invite.inviter ? { inviter: invite.inviter } : {}),
        transport,
      });
    }
  }

  private emitError(transport: TransportName, error: unknown): void {
    for (const handler of this.#errorHandlers) {
      handler(transport, error);
    }
  }
}
