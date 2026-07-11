import { Writable } from "node:stream";
import { runAdminCli } from "./admin.js";
import { loadGatewayConfig } from "./config.js";
import type {
  ChatHistoryQuery,
  ChatHistorySearchResult,
  GatewayCommand,
  GatewayEvent,
  TransportName,
} from "./protocol.js";
import {
  cliTransportRegistry,
  createConfiguredTransportList,
} from "./runtime.js";
import type {
  TransportChat,
  TransportHealth,
  TransportInvite,
} from "./transports/interface.js";
import type {
  GatewayTransportErrorHandler,
  TransportManager,
} from "./transports/manager.js";

export type GatewayEventHandler = (event: GatewayEvent) => void;

export interface GatewayClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  shutdownForProcessExit?(): void;
  send(command: GatewayCommand): Promise<void>;
  onEvent(handler: GatewayEventHandler): () => void;
  onError(handler: GatewayTransportErrorHandler): () => void;
  configuredTransports(): ReadonlySet<TransportName>;
  listChats(transport: TransportName): Promise<TransportChat[]>;
  listInvites(transport: TransportName): Promise<TransportInvite[]>;
  health(transport: TransportName): Promise<TransportHealth[]>;
  searchHistory(query: ChatHistoryQuery): Promise<ChatHistorySearchResult>;
  leaveChat(
    transport: TransportName,
    chatId: string,
    reason?: string,
  ): Promise<void>;
  acceptInvite(transport: TransportName, inviteId: string): Promise<void>;
  rejectInvite(
    transport: TransportName,
    inviteId: string,
    reason?: string,
  ): Promise<void>;
}

export type ManagerGatewayClientOptions = {
  manager: TransportManager;
  stateDir?: string;
  reloadTransports?: () => Promise<void>;
  runAdminCommand?: (
    args: string[],
    output: Writable,
    errorOutput: Writable,
  ) => Promise<number>;
};

export class ManagerGatewayClient implements GatewayClient {
  readonly #eventHandlers = new Set<GatewayEventHandler>();
  readonly #errorHandlers = new Set<GatewayTransportErrorHandler>();

  constructor(readonly options: ManagerGatewayClientOptions) {
    options.manager.onMessage((message) =>
      this.#emit({ type: "message", message }),
    );
    options.manager.onReaction((reaction) =>
      this.#emit({ type: "reaction", reaction }),
    );
    options.manager.onTyping((typing) =>
      this.#emit({ type: "typing", typing }),
    );
    options.manager.onInvite((invite) =>
      this.#emit({ type: "invite", invite }),
    );
    options.manager.onError((transport, error) => {
      for (const handler of this.#errorHandlers) {
        handler(transport, error);
      }
    });
  }

  async connect(): Promise<void> {
    await this.options.manager.connectAll();
  }

  async disconnect(): Promise<void> {
    await this.options.manager.disconnectAll();
  }

  shutdownForProcessExit(): void {
    for (const transport of this.options.manager.transports.values()) {
      transport.shutdownForProcessExit?.();
    }
  }

  configuredTransports(): ReadonlySet<TransportName> {
    return new Set(this.options.manager.transports.keys());
  }

  async listChats(transportName: TransportName): Promise<TransportChat[]> {
    const transport = this.options.manager.getTransport(transportName);
    return transport.listChats?.() ?? [];
  }

  async listInvites(transportName: TransportName): Promise<TransportInvite[]> {
    const transport = this.options.manager.getTransport(transportName);
    return transport.listInvites?.() ?? [];
  }

  async health(transportName: TransportName): Promise<TransportHealth[]> {
    const transport = this.options.manager.getTransport(transportName);
    return transport.health?.() ?? [];
  }

  async searchHistory(
    query: ChatHistoryQuery,
  ): Promise<ChatHistorySearchResult> {
    const transport = this.options.manager.getTransport(query.transport);
    if (!transport.searchHistory) {
      throw new Error(`History search is not supported by ${query.transport}`);
    }
    return transport.searchHistory(query);
  }

  async leaveChat(
    transportName: TransportName,
    chatId: string,
    reason?: string,
  ): Promise<void> {
    const transport = this.options.manager.getTransport(transportName);
    if (!transport.leaveChat) {
      throw new Error(`Leave is not supported by ${transportName}`);
    }
    await transport.leaveChat(chatId, reason);
  }

  async acceptInvite(
    transportName: TransportName,
    inviteId: string,
  ): Promise<void> {
    const transport = this.options.manager.getTransport(transportName);
    if (!transport.acceptInvite) {
      throw new Error(`Accept invite is not supported by ${transportName}`);
    }
    await transport.acceptInvite(inviteId);
  }

  async rejectInvite(
    transportName: TransportName,
    inviteId: string,
    reason?: string,
  ): Promise<void> {
    const transport = this.options.manager.getTransport(transportName);
    if (!transport.rejectInvite) {
      throw new Error(`Reject invite is not supported by ${transportName}`);
    }
    await transport.rejectInvite(inviteId, reason);
  }

  async send(command: GatewayCommand): Promise<void> {
    if (isAdminGatewayCommand(command)) {
      await this.#handleAdminCommand(command);
      return;
    }

    await this.options.manager.handleCommand(command);
  }

  onEvent(handler: GatewayEventHandler): () => void {
    this.#eventHandlers.add(handler);
    return idempotentUnsubscribe(this.#eventHandlers, handler);
  }

  onError(handler: GatewayTransportErrorHandler): () => void {
    this.#errorHandlers.add(handler);
    return idempotentUnsubscribe(this.#errorHandlers, handler);
  }

  async #handleAdminCommand(command: GatewayCommand): Promise<void> {
    const output = stringWritable();
    const errorOutput = stringWritable();
    const exitCode = await this.#runAdminCommand(
      adminArgsForGatewayCommand(command),
      output,
      errorOutput,
      command,
    );

    if (exitCode === 0 && command.type !== "status") {
      try {
        if (this.options.reloadTransports) {
          await this.options.reloadTransports();
        } else if (this.options.stateDir) {
          const updatedConfig = await loadGatewayConfig(this.options.stateDir);
          await this.options.manager.replaceTransports(
            await createConfiguredTransportList(
              updatedConfig,
              this.options.stateDir,
            ),
          );
          await this.options.manager.connectAll();
        }
      } catch (error) {
        this.#emit({
          type: "admin_result",
          command: command.type,
          ok: false,
          output: `${output.text()}${errorOutput.text()}Transport configuration saved but could not be applied: ${String(error)}\n`,
        });
        return;
      }
    }

    this.#emit({
      type: "admin_result",
      command: command.type,
      ok: exitCode === 0,
      output: `${output.text()}${errorOutput.text()}`,
    });
  }

  async #runAdminCommand(
    args: string[],
    output: Writable,
    errorOutput: Writable,
    command: GatewayCommand,
  ): Promise<number> {
    if (this.options.runAdminCommand) {
      return this.options.runAdminCommand(args, output, errorOutput);
    }
    return runAdminCli({
      args,
      output,
      errorOutput,
      ...(command.type === "status"
        ? { registry: cliTransportRegistry() }
        : {}),
    });
  }

  #emit(event: GatewayEvent): void {
    for (const handler of this.#eventHandlers) {
      handler(event);
    }
  }
}

function idempotentUnsubscribe<T>(handlers: Set<T>, handler: T): () => void {
  let subscribed = true;
  return () => {
    if (!subscribed) {
      return;
    }
    subscribed = false;
    handlers.delete(handler);
  };
}

function isAdminGatewayCommand(command: GatewayCommand): boolean {
  return (
    command.type === "status" ||
    command.type === "configure_transport" ||
    command.type === "connect_transport" ||
    command.type === "disconnect_transport"
  );
}

function adminArgsForGatewayCommand(command: GatewayCommand): string[] {
  switch (command.type) {
    case "status":
      return ["status"];
    case "connect_transport":
      return ["connect", command.transport];
    case "disconnect_transport":
      return ["disconnect", command.transport];
    case "configure_transport": {
      const args = ["configure", command.transport];
      if (command.enabled === true) {
        args.push("--enable");
      } else if (command.enabled === false) {
        args.push("--disable");
      }
      for (const [key, value] of Object.entries(command.settings ?? {})) {
        args.push("--set", `${key}=${String(value)}`);
      }
      return args;
    }
    default:
      throw new Error(`Not an admin gateway command: ${command.type}`);
  }
}

function stringWritable(): Writable & { text(): string } {
  const chunks: string[] = [];
  const writable = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  }) as Writable & { text(): string };

  writable.text = () => chunks.join("");
  return writable;
}
