import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ILogger } from "matrix-bot-sdk";
import {
  LogService,
  MatrixClient,
  RichConsoleLogger,
  RustSdkCryptoStorageProvider,
  SimpleFsStorageProvider,
} from "matrix-bot-sdk";
import type { TransportConfig } from "../config.js";
import type { InboundMessage } from "../protocol.js";
import type {
  TransportChat,
  TransportInvite,
  TransportProvider,
} from "./interface.js";
import {
  ensureSelfCrossSigned,
  readAccountPassword,
  readRecoveryKey,
} from "./matrix-crosssign.js";
import {
  type MatrixRoomEvent,
  extractUsername,
  formatForMatrix,
  shouldSkipEvent,
  stripBotMention,
  wasBotMentioned,
} from "./matrix-utils.js";

type MatrixTransportConfig = {
  homeserverUrl: string;
  accessToken: string;
  encryption?: boolean;
  selfCrossSign?: boolean | "reset";
  accountPassword?: string;
  recoveryKey?: string;
};

type MatrixEvent = MatrixRoomEvent & {
  event_id?: string;
};

type MatrixInviteEvent = {
  sender?: string;
  unsigned?: {
    invite_room_state?: Array<{
      type?: string;
      state_key?: string;
      content?: Record<string, unknown>;
    }>;
  };
};

export class MatrixConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MatrixConfigError";
  }
}

export class MatrixDecryptionError extends Error {
  constructor(
    readonly roomId: string,
    readonly eventId: string | undefined,
    options?: ErrorOptions,
  ) {
    super(
      `Matrix event could not be decrypted in ${roomId}${eventId ? ` (${eventId})` : ""}`,
      options,
    );
    this.name = "MatrixDecryptionError";
  }
}

export class MatrixProvider implements TransportProvider {
  readonly type = "matrix";
  readonly #config: MatrixTransportConfig;
  readonly #stateDir: string;
  #client: MatrixClient | undefined;
  #isConnected = false;
  #messageHandler?: (message: InboundMessage) => void;
  #errorHandler?: (error: unknown) => void;
  #botUserId: string | undefined;
  #joinedRooms = new Set<string>();
  #pendingInvites = new Map<string, TransportInvite>();
  #roomMemberCount = new Map<string, number>();
  #connectedAt = 0;

  constructor(config: MatrixTransportConfig, stateDir: string) {
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

    await mkdir(this.#stateDir, { recursive: true });

    const storage = new SimpleFsStorageProvider(
      join(this.#stateDir, "matrix-store.json"),
    );
    let cryptoProvider: RustSdkCryptoStorageProvider | undefined;

    if (this.#config.encryption !== false) {
      try {
        cryptoProvider = new RustSdkCryptoStorageProvider(
          join(this.#stateDir, "matrix-crypto"),
          0,
        );
      } catch (error) {
        this.#errorHandler?.(error);
      }
    }

    this.#client = new MatrixClient(
      this.#config.homeserverUrl,
      this.#config.accessToken,
      storage,
      cryptoProvider,
    );

    this.#botUserId = await this.#client.getUserId();
    this.#connectedAt = Date.now();

    this.#client.on("room.join", (roomId: string) => {
      this.#joinedRooms.add(roomId);
      this.#pendingInvites.delete(roomId);
      this.#client
        ?.getJoinedRoomMembers(roomId)
        .then((members) => this.#roomMemberCount.set(roomId, members.length))
        .catch(() => {});
    });
    this.#client.on("room.leave", (roomId: string) => {
      this.#joinedRooms.delete(roomId);
      this.#pendingInvites.delete(roomId);
      this.#roomMemberCount.delete(roomId);
    });
    this.#client.on(
      "room.invite",
      (roomId: string, event: MatrixInviteEvent) => {
        this.#pendingInvites.set(roomId, {
          inviteId: roomId,
          ...inviteDetails(event),
        });
      },
    );
    this.#client.on("room.message", (roomId: string, event: MatrixEvent) => {
      void this.handleMessage(roomId, event).catch((error: unknown) => {
        this.#errorHandler?.(error);
      });
    });
    this.#client.on(
      "room.failed_decryption",
      (roomId: string, event: MatrixEvent, error: unknown) => {
        this.#errorHandler?.(
          new MatrixDecryptionError(roomId, event.event_id, { cause: error }),
        );
      },
    );

    try {
      const defaultLogger = new RichConsoleLogger();
      LogService.setLogger(createSyncFilterLogger(defaultLogger));
      await this.#client.start();

      if (cryptoProvider && this.#config.selfCrossSign !== false) {
        await this.selfCrossSign();
      }
    } catch (error) {
      this.resetClientState();
      throw error;
    }

    const rooms = await this.#client.getJoinedRooms();
    this.#joinedRooms = new Set(rooms);
    await Promise.all(
      rooms.map(async (roomId) => {
        try {
          const members = await this.#client?.getJoinedRoomMembers(roomId);
          if (members) {
            this.#roomMemberCount.set(roomId, members.length);
          }
        } catch {
          // Cache miss can be filled on first message.
        }
      }),
    );
    this.#isConnected = true;
  }

  disconnect(): Promise<void> {
    if (this.#client) {
      this.#client.stop();
    }
    this.resetClientState();
    return Promise.resolve();
  }

  shutdownForProcessExit(): void {
    try {
      (
        this.#client as unknown as {
          crypto?: { engine?: { machine?: { close?(): void } } };
        }
      )?.crypto?.engine?.machine?.close?.();
    } catch {
      // Process exit is already in progress.
    }
    this.resetClientState();
  }

  async listChats(): Promise<TransportChat[]> {
    if (!this.#client) {
      return [...this.#joinedRooms].map((chatId) => ({ chatId }));
    }

    const rooms = await this.#client.getJoinedRooms();
    this.#joinedRooms = new Set(rooms);
    return Promise.all(
      rooms.map(async (roomId) => ({
        chatId: roomId,
        ...(await this.roomDisplayName(roomId)),
      })),
    );
  }

  listInvites(): Promise<TransportInvite[]> {
    return Promise.resolve([...this.#pendingInvites.values()]);
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    if (!this.#client) {
      throw new Error("Matrix client not connected");
    }
    if (!text.trim()) {
      return;
    }

    const { body, formattedBody } = formatForMatrix(text);
    await this.#client.sendMessage(chatId, {
      msgtype: "m.text",
      body,
      ...(formattedBody
        ? { format: "org.matrix.custom.html", formatted_body: formattedBody }
        : {}),
    });
  }

  async sendTyping(chatId: string): Promise<void> {
    try {
      await this.#client?.setTyping(chatId, true, 10000);
    } catch {
      // Typing indicators are best effort.
    }
  }

  async leaveChat(chatId: string, reason?: string): Promise<void> {
    if (!this.#client) {
      throw new Error("Matrix client not connected");
    }

    await this.#client.leaveRoom(chatId, reason);
    this.#joinedRooms.delete(chatId);
    this.#roomMemberCount.delete(chatId);
  }

  async acceptInvite(inviteId: string): Promise<void> {
    if (!this.#client) {
      throw new Error("Matrix client not connected");
    }

    const roomId = await this.#client.joinRoom(inviteId);
    this.#pendingInvites.delete(inviteId);
    this.#joinedRooms.add(roomId);
  }

  async rejectInvite(inviteId: string, reason?: string): Promise<void> {
    if (!this.#client) {
      throw new Error("Matrix client not connected");
    }

    await this.#client.leaveRoom(inviteId, reason);
    this.#pendingInvites.delete(inviteId);
  }

  onMessage(handler: (message: InboundMessage) => void): void {
    this.#messageHandler = handler;
  }

  onError(handler: (error: unknown) => void): void {
    this.#errorHandler = handler;
  }

  private async selfCrossSign(): Promise<void> {
    if (!this.#client) {
      return;
    }

    try {
      const password =
        this.#config.accountPassword ?? readAccountPassword(this.#stateDir);
      const recoveryKey =
        this.#config.recoveryKey ?? readRecoveryKey(this.#stateDir);
      const result = await ensureSelfCrossSigned(this.#client, {
        reset: this.#config.selfCrossSign === "reset",
        ...(password ? { password } : {}),
        ...(recoveryKey ? { recoveryKey } : {}),
      });
      if (result.status === "skipped" && result.reason) {
        this.#errorHandler?.(
          new Error(`Matrix cross-sign skipped: ${result.reason}`),
        );
      }
    } catch (error) {
      this.#errorHandler?.(error);
    }
  }

  private async roomDisplayName(
    roomId: string,
  ): Promise<{ displayName?: string }> {
    const displayName =
      (await this.roomName(roomId)) ??
      (await this.roomAlias(roomId)) ??
      (await this.memberRoomName(roomId));

    return displayName ? { displayName } : {};
  }

  private async roomName(roomId: string): Promise<string | undefined> {
    try {
      const event = await this.#client?.getRoomStateEvent(
        roomId,
        "m.room.name",
        "",
      );
      return typeof event?.name === "string" && event.name.trim()
        ? event.name.trim()
        : undefined;
    } catch {
      return undefined;
    }
  }

  private async roomAlias(roomId: string): Promise<string | undefined> {
    try {
      return (await this.#client?.getPublishedAlias(roomId)) ?? undefined;
    } catch {
      return undefined;
    }
  }

  private async memberRoomName(roomId: string): Promise<string | undefined> {
    if (!this.#client || !this.#botUserId) {
      return undefined;
    }

    try {
      const members =
        await this.#client.getJoinedRoomMembersWithProfiles(roomId);
      const otherMembers = Object.entries(members).filter(
        ([userId]) => userId !== this.#botUserId,
      );

      if (otherMembers.length === 0) {
        return undefined;
      }

      if (otherMembers.length === 1) {
        const [userId, profile] = otherMembers[0] ?? [];
        return displayNameFromProfile(profile) ?? userId;
      }

      const names = otherMembers
        .slice(0, 3)
        .map(([userId, profile]) => displayNameFromProfile(profile) ?? userId);
      const suffix = otherMembers.length > names.length ? "..." : "";
      return `${names.join(", ")}${suffix}`;
    } catch {
      return undefined;
    }
  }

  private async handleMessage(
    roomId: string,
    event: MatrixEvent,
  ): Promise<void> {
    if (!this.#client || !this.#botUserId) {
      return;
    }

    const skipReason = shouldSkipEvent(
      event,
      this.#botUserId,
      this.#connectedAt,
      this.#joinedRooms,
      roomId,
    );
    if (skipReason) {
      return;
    }

    const messageText = event.content?.body;
    const userId = event.sender;
    if (!messageText || !userId) {
      return;
    }

    let memberCount = this.#roomMemberCount.get(roomId);
    if (memberCount === undefined) {
      try {
        const members = await this.#client.getJoinedRoomMembers(roomId);
        memberCount = members.length;
        this.#roomMemberCount.set(roomId, memberCount);
      } catch {
        memberCount = 2;
      }
    }

    const isGroupChat = memberCount > 2;
    const wasMentioned = isGroupChat
      ? wasBotMentioned(messageText, this.#botUserId)
      : false;
    const content = wasMentioned
      ? stripBotMention(messageText, this.#botUserId)
      : messageText;

    if (!content) {
      return;
    }

    this.#messageHandler?.({
      chatId: roomId,
      transport: this.type,
      content,
      username: extractUsername(userId),
      userId,
      timestamp: event.origin_server_ts ?? Date.now(),
      isGroupChat,
      wasMentioned,
      ...(event.event_id ? { messageId: event.event_id } : {}),
    });
  }

  private resetClientState(): void {
    this.#client = undefined;
    this.#isConnected = false;
    this.#botUserId = undefined;
    this.#joinedRooms.clear();
    this.#pendingInvites.clear();
    this.#roomMemberCount.clear();
    this.#connectedAt = 0;
  }
}

function inviteDetails(event: MatrixInviteEvent): {
  displayName?: string;
  inviter?: string;
} {
  const inviteRoomState = event.unsigned?.invite_room_state ?? [];
  const roomName = inviteRoomState.find(
    (state) => state.type === "m.room.name" && state.state_key === "",
  )?.content?.name;
  const canonicalAlias = inviteRoomState.find(
    (state) =>
      state.type === "m.room.canonical_alias" && state.state_key === "",
  )?.content?.alias;

  return {
    ...(typeof roomName === "string" && roomName.trim()
      ? { displayName: roomName.trim() }
      : typeof canonicalAlias === "string" && canonicalAlias.trim()
        ? { displayName: canonicalAlias.trim() }
        : {}),
    ...(event.sender ? { inviter: event.sender } : {}),
  };
}

export function createMatrixProvider(
  config: TransportConfig,
  context: { stateDir: string },
): MatrixProvider {
  return new MatrixProvider(parseMatrixConfig(config), context.stateDir);
}

export function parseMatrixConfig(
  config: TransportConfig,
): MatrixTransportConfig {
  const settings = config.settings ?? {};
  const homeserverUrl = settings.homeserverUrl;
  const accessToken = settings.accessToken;

  if (typeof homeserverUrl !== "string" || !homeserverUrl) {
    throw new MatrixConfigError("Matrix settings.homeserverUrl is required");
  }
  if (typeof accessToken !== "string" || !accessToken) {
    throw new MatrixConfigError("Matrix settings.accessToken is required");
  }

  return {
    homeserverUrl,
    accessToken,
    ...(typeof settings.encryption === "boolean"
      ? { encryption: settings.encryption }
      : {}),
    ...(settings.selfCrossSign === "reset" ||
    typeof settings.selfCrossSign === "boolean"
      ? { selfCrossSign: settings.selfCrossSign }
      : {}),
    ...(typeof settings.accountPassword === "string"
      ? { accountPassword: settings.accountPassword }
      : {}),
    ...(typeof settings.recoveryKey === "string"
      ? { recoveryKey: settings.recoveryKey }
      : {}),
  };
}

function createSyncFilterLogger(defaultLogger: ILogger): ILogger {
  return {
    info: (module, ...args) => defaultLogger.info(module, ...args),
    warn: (module, ...args) => defaultLogger.warn(module, ...args),
    debug: (module, ...args) => defaultLogger.debug(module, ...args),
    trace: (module, ...args) => defaultLogger.trace(module, ...args),
    error: (module, ...args) => {
      const message = args
        .map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
        .join(" ");
      if (
        module === "MatrixClientLite" &&
        message.includes("Decryption error")
      ) {
        return;
      }
      if (module === "MatrixHttpClient" && message.includes("M_NOT_FOUND")) {
        return;
      }
      defaultLogger.error(module, ...args);
    },
  };
}

function displayNameFromProfile(profile: unknown): string | undefined {
  if (typeof profile !== "object" || profile === null) {
    return undefined;
  }

  const displayName =
    (profile as { display_name?: unknown; displayname?: unknown })
      .display_name ?? (profile as { displayname?: unknown }).displayname;

  return typeof displayName === "string" && displayName.trim()
    ? displayName.trim()
    : undefined;
}
