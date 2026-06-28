import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TransportConfig } from "../config.js";
import { readJsonLines, writeJsonLine } from "../io/json-lines.js";
import type {
  ChatHistoryQuery,
  ChatHistorySearchResult,
  InboundMessage,
  InboundReaction,
  MessageReference,
} from "../protocol.js";
import type {
  TransportChat,
  TransportHealth,
  TransportInvite,
  TransportProvider,
} from "./interface.js";
import { formatForMatrix } from "./matrix-utils.js";

export type MautrixMatrixConfig = {
  homeserverUrl: string;
  accessToken: string;
  encryption?: boolean;
  pythonPath?: string;
  recoveryKey?: string;
  sidecarPath?: string;
  startupTimeoutMs?: number;
  mediaDownloadMaxBytes?: number;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type SidecarEnvelope = {
  id?: unknown;
  ok?: unknown;
  result?: unknown;
  error?: unknown;
  type?: unknown;
  message?: unknown;
  reaction?: unknown;
  invite?: unknown;
  category?: unknown;
  roomId?: unknown;
  eventId?: unknown;
};

export class MautrixMatrixDecryptionError extends Error {
  constructor(
    readonly roomId: string | undefined,
    readonly eventId: string | undefined,
    options?: ErrorOptions,
  ) {
    super(
      `Matrix event could not be decrypted${roomId ? ` in ${roomId}` : ""}${eventId ? ` (${eventId})` : ""}`,
      options,
    );
    this.name = "MatrixDecryptionError";
  }
}

export class MautrixMatrixProvider implements TransportProvider {
  readonly type = "matrix";
  readonly #config: MautrixMatrixConfig;
  readonly #stateDir: string;
  #process: ChildProcessWithoutNullStreams | undefined;
  #isConnected = false;
  #nextId = 1;
  #pending = new Map<number, PendingRequest>();
  #messageHandler?: (message: InboundMessage) => void;
  #reactionHandler?: (reaction: InboundReaction) => void;
  #inviteHandler?: (invite: TransportInvite) => void;
  #errorHandler?: (error: unknown) => void;
  #readerDone: Promise<void> | undefined;

  constructor(config: MautrixMatrixConfig, stateDir: string) {
    this.#config = config;
    this.#stateDir = stateDir;
  }

  get isConnected(): boolean {
    return this.#isConnected;
  }

  async connect(): Promise<void> {
    if (this.#isConnected) {
      return;
    }

    const sidecarPath =
      this.#config.sidecarPath ?? (await defaultMautrixSidecarPath());
    const child = spawn(this.#config.pythonPath ?? "python3", [sidecarPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#process = child;
    child.stderr.on("data", (chunk) => {
      if (
        process.env.UMG_MAUTRIX_DEBUG === "1" ||
        process.env.UMG_MATRIX_DEBUG_ROOM_KEYS === "1"
      ) {
        process.stderr.write(chunk);
      }
    });
    child.on("error", (error) => {
      this.rejectPending(error);
      if (this.#isConnected) {
        this.#errorHandler?.(error);
      }
      this.#isConnected = false;
      if (this.#process === child) {
        this.#process = undefined;
      }
    });
    child.on("exit", (code, signal) => {
      const error = new Error(
        `mautrix sidecar exited${code === null ? "" : ` with code ${code}`}${signal ? ` via ${signal}` : ""}`,
      );
      this.rejectPending(error);
      if (this.#isConnected) {
        this.#errorHandler?.(error);
      }
      this.#isConnected = false;
      if (this.#process === child) {
        this.#process = undefined;
      }
    });
    this.#readerDone = this.readSidecar(child).catch((error: unknown) => {
      this.rejectPending(asError(error));
      this.#errorHandler?.(error);
    });

    try {
      await this.request(
        "connect",
        {
          homeserverUrl: this.#config.homeserverUrl,
          accessToken: this.#config.accessToken,
          stateDir: this.#stateDir,
          encryption: this.#config.encryption !== false,
          ...(this.#config.mediaDownloadMaxBytes === undefined
            ? {}
            : { mediaDownloadMaxBytes: this.#config.mediaDownloadMaxBytes }),
          ...(this.#config.recoveryKey
            ? { recoveryKey: this.#config.recoveryKey }
            : {}),
        },
        this.#config.startupTimeoutMs ?? 30_000,
      );
      this.#isConnected = true;
    } catch (error) {
      try {
        child.kill();
      } catch {
        // Startup cleanup is best effort.
      }
      if (this.#process === child) {
        this.#process = undefined;
      }
      this.#isConnected = false;
      this.rejectPending(asError(error));
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    const child = this.#process;
    if (!child) {
      this.#isConnected = false;
      return;
    }

    this.#isConnected = false;
    try {
      await this.request("disconnect", {});
    } catch {
      // Process shutdown is best effort.
    }
    child.stdin.end();
    child.kill();
    await this.#readerDone?.catch(() => {});
    this.reset();
  }

  shutdownForProcessExit(): void {
    this.#process?.kill();
    this.reset();
  }

  async listChats(): Promise<TransportChat[]> {
    return asArray(await this.request("list_chats", {})).filter(
      isTransportChat,
    );
  }

  async listInvites(): Promise<TransportInvite[]> {
    return asArray(await this.request("list_invites", {})).filter(
      isTransportInvite,
    );
  }

  async health(): Promise<TransportHealth[]> {
    const result = await this.request("health", {});
    return asArray(result).filter(isTransportHealth);
  }

  async searchHistory(
    query: ChatHistoryQuery,
  ): Promise<ChatHistorySearchResult> {
    return asChatHistorySearchResult(
      await this.request(
        "search_history",
        {
          query: query.query ?? "",
          ...(query.chatIds ? { chatIds: query.chatIds } : {}),
          ...(query.messageId === undefined
            ? {}
            : { messageId: query.messageId }),
          ...(query.fromTimestamp === undefined
            ? {}
            : { fromTimestamp: query.fromTimestamp }),
          ...(query.toTimestamp === undefined
            ? {}
            : { toTimestamp: query.toTimestamp }),
          ...(query.limit === undefined ? {} : { limit: query.limit }),
          ...(query.maxMessagesPerChat === undefined
            ? {}
            : { maxMessagesPerChat: query.maxMessagesPerChat }),
        },
        60_000,
      ),
    );
  }

  async sendMessage(
    chatId: string,
    text: string,
    replyTo?: MessageReference,
    threadTo?: MessageReference,
  ): Promise<void> {
    if (!text.trim()) {
      return;
    }
    const { body, formattedBody } = formatForMatrix(text);
    await this.request("send_message", {
      chatId,
      text: body,
      ...(formattedBody ? { formattedBody } : {}),
      ...(replyTo ? { replyTo } : {}),
      ...(threadTo ? { threadTo } : {}),
    });
  }

  async sendReaction(
    chatId: string,
    messageId: string,
    reaction: string,
  ): Promise<void> {
    await this.request("send_reaction", { chatId, messageId, reaction });
  }

  async sendTyping(chatId: string): Promise<void> {
    try {
      await this.request("send_typing", { chatId });
    } catch {
      // Typing indicators are best effort.
    }
  }

  async leaveChat(chatId: string, reason?: string): Promise<void> {
    await this.request("leave_chat", { chatId, ...(reason ? { reason } : {}) });
  }

  async acceptInvite(inviteId: string): Promise<void> {
    await this.request("accept_invite", { inviteId });
  }

  async rejectInvite(inviteId: string, reason?: string): Promise<void> {
    await this.request("reject_invite", {
      inviteId,
      ...(reason ? { reason } : {}),
    });
  }

  onMessage(handler: (message: InboundMessage) => void): void {
    this.#messageHandler = handler;
  }

  onReaction(handler: (reaction: InboundReaction) => void): void {
    this.#reactionHandler = handler;
  }

  onInvite(handler: (invite: TransportInvite) => void): void {
    this.#inviteHandler = handler;
  }

  onError(handler: (error: unknown) => void): void {
    this.#errorHandler = handler;
  }

  private async request(
    type: string,
    payload: Record<string, unknown>,
    timeoutMs = 10_000,
  ): Promise<unknown> {
    if (!this.#process) {
      throw new Error("mautrix sidecar is not running");
    }

    const id = this.#nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    const timer = setTimeout(() => {
      const pending = this.#pending.get(id);
      if (pending) {
        this.#pending.delete(id);
        pending.reject(new Error(`mautrix sidecar command timed out: ${type}`));
      }
    }, timeoutMs);

    try {
      await writeJsonLine(this.#process.stdin, { id, type, ...payload });
      return await promise;
    } finally {
      clearTimeout(timer);
    }
  }

  private async readSidecar(
    child: ChildProcessWithoutNullStreams,
  ): Promise<void> {
    for await (const value of readJsonLines(child.stdout)) {
      this.handleSidecarEnvelope(value);
    }
  }

  private handleSidecarEnvelope(value: unknown): void {
    if (!isRecord(value)) {
      this.#errorHandler?.(new Error("mautrix sidecar emitted a non-object"));
      return;
    }
    const envelope = value as SidecarEnvelope;
    if (typeof envelope.id === "number") {
      const pending = this.#pending.get(envelope.id);
      if (!pending) {
        return;
      }
      this.#pending.delete(envelope.id);
      if (envelope.ok === true) {
        pending.resolve(envelope.result);
      } else {
        pending.reject(new Error(String(envelope.error ?? "unknown error")));
      }
      return;
    }

    if (envelope.type === "message" && isInboundMessage(envelope.message)) {
      this.#messageHandler?.(envelope.message);
      return;
    }
    if (envelope.type === "reaction" && isInboundReaction(envelope.reaction)) {
      this.#reactionHandler?.(envelope.reaction);
      return;
    }
    if (envelope.type === "invite" && isTransportInvite(envelope.invite)) {
      this.#inviteHandler?.(envelope.invite);
      return;
    }
    if (envelope.type === "error") {
      if (envelope.category === "matrix-decryption") {
        this.#errorHandler?.(
          new MautrixMatrixDecryptionError(
            typeof envelope.roomId === "string" ? envelope.roomId : undefined,
            typeof envelope.eventId === "string" ? envelope.eventId : undefined,
            { cause: envelope.error },
          ),
        );
        return;
      }
      this.#errorHandler?.(
        new Error(String(envelope.error ?? "mautrix sidecar error")),
      );
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();
  }

  private reset(): void {
    this.#process = undefined;
    this.#isConnected = false;
    this.rejectPending(new Error("mautrix sidecar stopped"));
  }
}

export function createMautrixMatrixProvider(
  config: TransportConfig,
  context: { stateDir: string },
): MautrixMatrixProvider {
  return new MautrixMatrixProvider(
    parseMautrixMatrixConfig(config, context.stateDir),
    context.stateDir,
  );
}

export function parseMautrixMatrixConfig(
  config: TransportConfig,
  stateDir?: string,
): MautrixMatrixConfig {
  const settings = config.settings ?? {};
  const homeserverUrl = settings.homeserverUrl;
  if (typeof settings.accessToken === "string" && settings.accessToken) {
    throw new Error(
      "Matrix settings.accessToken is not supported; store the token in state/matrix-access-token.txt with chmod 600",
    );
  }
  const accessToken = readAccessToken(stateDir);

  if (typeof homeserverUrl !== "string" || !homeserverUrl) {
    throw new Error("Matrix settings.homeserverUrl is required");
  }
  if (!accessToken) {
    throw new Error(
      "Matrix access token is required: run setup/configure or create state/matrix-access-token.txt with chmod 600",
    );
  }

  return {
    homeserverUrl,
    accessToken,
    ...(typeof settings.encryption === "boolean"
      ? { encryption: settings.encryption }
      : {}),
    ...(typeof settings.pythonPath === "string"
      ? { pythonPath: settings.pythonPath }
      : {}),
    ...(typeof settings.sidecarPath === "string"
      ? { sidecarPath: settings.sidecarPath }
      : {}),
    ...(typeof settings.startupTimeoutMs === "number"
      ? { startupTimeoutMs: settings.startupTimeoutMs }
      : {}),
    ...(typeof settings.mediaDownloadMaxBytes === "number"
      ? { mediaDownloadMaxBytes: settings.mediaDownloadMaxBytes }
      : {}),
  };
}

function readAccessToken(stateDir?: string): string | undefined {
  if (!stateDir) return undefined;
  const filePath = join(stateDir, "matrix-access-token.txt");
  try {
    const stat = statSync(filePath);
    if ((stat.mode & 0o077) !== 0) {
      return undefined;
    }
    const value = readFileSync(filePath, "utf8").trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

async function defaultMautrixSidecarPath(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "matrix-mautrix-sidecar.py"),
    join(here, "../../src/transports/matrix-mautrix-sidecar.py"),
  ];

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next layout.
    }
  }

  return candidates[0] ?? "matrix-mautrix-sidecar.py";
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isInboundMessage(value: unknown): value is InboundMessage {
  return (
    isRecord(value) &&
    typeof value.chatId === "string" &&
    value.transport === "matrix" &&
    typeof value.content === "string" &&
    typeof value.timestamp === "number" &&
    typeof value.isGroupChat === "boolean" &&
    typeof value.wasMentioned === "boolean"
  );
}

function isInboundReaction(value: unknown): value is InboundReaction {
  return (
    isRecord(value) &&
    typeof value.chatId === "string" &&
    value.transport === "matrix" &&
    typeof value.messageId === "string" &&
    typeof value.reaction === "string" &&
    typeof value.timestamp === "number"
  );
}

function isTransportChat(value: unknown): value is TransportChat {
  return isRecord(value) && typeof value.chatId === "string";
}

function isTransportInvite(value: unknown): value is TransportInvite {
  return isRecord(value) && typeof value.inviteId === "string";
}

function asChatHistorySearchResult(value: unknown): ChatHistorySearchResult {
  if (!isRecord(value)) {
    return { messages: [], scannedChats: 0, scannedMessages: 0 };
  }
  return {
    messages: asArray(value.messages).filter(isChatHistoryMessage),
    scannedChats:
      typeof value.scannedChats === "number" ? value.scannedChats : 0,
    scannedMessages:
      typeof value.scannedMessages === "number" ? value.scannedMessages : 0,
    ...(typeof value.skippedDecryption === "number"
      ? { skippedDecryption: value.skippedDecryption }
      : {}),
    ...(typeof value.partial === "boolean" ? { partial: value.partial } : {}),
    ...(Array.isArray(value.errors) &&
    value.errors.every((error) => typeof error === "string")
      ? { errors: value.errors }
      : {}),
  };
}

function isChatHistoryMessage(
  value: unknown,
): value is ChatHistorySearchResult["messages"][number] {
  return (
    isRecord(value) &&
    value.transport === "matrix" &&
    typeof value.chatId === "string" &&
    typeof value.messageId === "string" &&
    typeof value.content === "string" &&
    typeof value.timestamp === "number"
  );
}

function isTransportHealth(value: unknown): value is TransportHealth {
  return (
    isRecord(value) &&
    typeof value.category === "string" &&
    (value.status === "ready" ||
      value.status === "degraded" ||
      value.status === "disabled") &&
    typeof value.summary === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
