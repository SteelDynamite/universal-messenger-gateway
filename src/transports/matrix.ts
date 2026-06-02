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
import type {
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
import {
  type CrossSignResult,
  ensureSelfCrossSigned,
  isDeviceCrossSigned,
  readAccessToken,
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

type MatrixMachine = {
  crossSigningStatus(): Promise<{
    hasMaster: boolean;
    hasSelfSigning: boolean;
    hasUserSigning: boolean;
  }>;
  isBackupEnabled?(): Promise<boolean>;
};

type MatrixEvent = MatrixRoomEvent & {
  event_id?: string;
  type?: string;
  content?: MatrixEventContent;
};

type MatrixEventContent = {
  body?: unknown;
  format?: unknown;
  formatted_body?: unknown;
  "m.relates_to"?: {
    "m.in_reply_to"?: {
      event_id?: unknown;
    };
    event_id?: unknown;
    key?: unknown;
    rel_type?: unknown;
  };
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
  #reactionHandler?: (reaction: InboundReaction) => void;
  #errorHandler?: (error: unknown) => void;
  #botUserId: string | undefined;
  #joinedRooms = new Set<string>();
  #pendingInvites = new Map<string, TransportInvite>();
  #roomMemberCount = new Map<string, number>();
  #connectedAt = 0;
  #e2eeHealth: TransportHealth = {
    category: "matrix-e2ee",
    status: "disabled",
    summary: "encryption not checked yet",
  };

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
    this.installRoomKeyDiagnostics();

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
    this.#client.on("room.event", (roomId: string, event: MatrixEvent) => {
      if (event.type === "m.room.member") {
        this.refreshRoomMemberCount(roomId);
        return;
      }

      if (event.type !== "m.reaction") {
        return;
      }

      this.handleReaction(roomId, event);
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

      let crossSignResult: CrossSignResult | undefined;
      if (cryptoProvider && this.#config.selfCrossSign !== false) {
        crossSignResult = await this.selfCrossSign();
      }
      this.#e2eeHealth = await this.evaluateE2eeHealth(
        cryptoProvider,
        crossSignResult,
      );
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
      this.#client?.stop();
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

  health(): Promise<TransportHealth[]> {
    return Promise.resolve([this.#e2eeHealth]);
  }

  async sendMessage(
    chatId: string,
    text: string,
    replyTo?: MessageReference,
  ): Promise<void> {
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
      ...(replyTo?.transport === this.type && replyTo.chatId === chatId
        ? {
            "m.relates_to": {
              "m.in_reply_to": { event_id: replyTo.messageId },
            },
          }
        : {}),
      ...(formattedBody
        ? { format: "org.matrix.custom.html", formatted_body: formattedBody }
        : {}),
    });
  }

  async sendReaction(
    chatId: string,
    messageId: string,
    reaction: string,
  ): Promise<void> {
    if (!this.#client) {
      throw new Error("Matrix client not connected");
    }

    await this.#client.unstableApis.addReactionToEvent(
      chatId,
      messageId,
      reaction,
    );
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

  onReaction(handler: (reaction: InboundReaction) => void): void {
    this.#reactionHandler = handler;
  }

  onError(handler: (error: unknown) => void): void {
    this.#errorHandler = handler;
  }

  private installRoomKeyDiagnostics(): void {
    if (process.env.UMG_MATRIX_DEBUG_ROOM_KEYS !== "1" || !this.#client) {
      return;
    }

    const client = this.#client as MatrixClient & {
      sendToDevices(
        type: string,
        messages: Record<string, Record<string, unknown>>,
      ): Promise<void>;
    };
    const requestClient = client as MatrixClient & {
      doRequest(
        method: string,
        path: string,
        ...args: unknown[]
      ): Promise<unknown>;
    };
    const originalDoRequest = requestClient.doRequest.bind(requestClient);
    requestClient.doRequest = async (method, path, ...args) => {
      const response = await originalDoRequest(method, path, ...args);
      if (method === "GET" && path.includes("/sync")) {
        process.stderr.write(
          `[Matrix room-key debug] ${this.#botUserId ?? "unknown"} sync ${summarizeSyncToDevice(response)}\n`,
        );
      }
      return response;
    };

    const originalSendToDevices = client.sendToDevices.bind(client);
    client.sendToDevices = async (type, messages) => {
      process.stderr.write(
        `[Matrix room-key debug] ${this.#botUserId ?? "unknown"} sending to-device ${type} to ${summarizeToDeviceRecipients(messages)}\n`,
      );
      const result = await originalSendToDevices(type, messages);
      process.stderr.write(
        `[Matrix room-key debug] ${this.#botUserId ?? "unknown"} sent to-device ${type}\n`,
      );
      return result;
    };

    client.on("to_device.decrypted", (event: unknown) => {
      process.stderr.write(
        `[Matrix room-key debug] ${this.#botUserId ?? "unknown"} received decrypted to-device ${summarizeToDeviceEvent(event)}\n`,
      );
    });
  }

  private async selfCrossSign(): Promise<CrossSignResult | undefined> {
    if (!this.#client) {
      return undefined;
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
      return result;
    } catch (error) {
      this.#errorHandler?.(error);
      return {
        status: "skipped",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async evaluateE2eeHealth(
    cryptoProvider: RustSdkCryptoStorageProvider | undefined,
    crossSignResult: CrossSignResult | undefined,
  ): Promise<TransportHealth> {
    if (this.#config.encryption === false) {
      return {
        category: "matrix-e2ee",
        status: "disabled",
        summary: "encryption disabled",
      };
    }

    const details: string[] = [];
    const warnings: string[] = [];
    const problems: string[] = [];
    if (!cryptoProvider) {
      problems.push("crypto store was not created");
    }

    const machine = this.matrixMachine();
    if (!machine) {
      problems.push("Olm machine unavailable");
    }

    const recoveryKey =
      this.#config.recoveryKey ?? readRecoveryKey(this.#stateDir);
    if (recoveryKey) {
      details.push("recovery key: present");
    } else {
      problems.push(
        "recovery key missing; cannot import SSSS cross-signing secrets",
      );
    }

    if (crossSignResult) {
      details.push(
        `cross-sign import: ${crossSignResult.status}${crossSignResult.reason ? ` (${crossSignResult.reason})` : ""}`,
      );
      if (crossSignResult.status === "skipped") {
        problems.push(
          `cross-signing skipped: ${crossSignResult.reason ?? "unknown reason"}`,
        );
      }
    } else if (this.#config.selfCrossSign === false) {
      problems.push("self cross-signing disabled by config");
    }

    if (machine) {
      try {
        const status = await machine.crossSigningStatus();
        const hasIdentity =
          status.hasMaster && status.hasSelfSigning && status.hasUserSigning;
        details.push(
          `cross-signing identity: ${hasIdentity ? "present" : "incomplete"}`,
        );
        if (!hasIdentity) {
          problems.push("cross-signing identity incomplete");
        }
      } catch (error) {
        problems.push(`cross-signing status unavailable: ${String(error)}`);
      }

      try {
        const userId = this.#botUserId ?? (await this.#client?.getUserId());
        const signed = userId
          ? await isDeviceCrossSigned(this.#client as MatrixClient, userId)
          : false;
        details.push(`device signature: ${signed ? "signed" : "not signed"}`);
        if (!signed) {
          problems.push("device is not cross-signed");
        }
      } catch (error) {
        problems.push(`device signature check failed: ${String(error)}`);
      }

      if (machine.isBackupEnabled) {
        try {
          const backupEnabled = await machine.isBackupEnabled();
          details.push(
            `key backup: ${backupEnabled ? "active" : "not active"}`,
          );
          if (!backupEnabled) {
            warnings.push(
              "key backup is not active in the local crypto machine",
            );
          }
        } catch (error) {
          warnings.push(`key backup status unavailable: ${String(error)}`);
        }
      } else {
        warnings.push("key backup status API unavailable");
      }
    }

    return {
      category: "matrix-e2ee",
      status: problems.length === 0 ? "ready" : "degraded",
      summary:
        problems.length === 0
          ? warnings.length === 0
            ? "ready"
            : `ready; warning: ${warnings[0]}`
          : `degraded: ${problems[0]}`,
      details: [
        ...details,
        ...warnings.map((warning) => `warning: ${warning}`),
        ...problems.map((problem) => `problem: ${problem}`),
      ],
    };
  }

  private matrixMachine(): MatrixMachine | undefined {
    return (
      this.#client as unknown as {
        crypto?: { engine?: { machine?: MatrixMachine } };
      }
    )?.crypto?.engine?.machine;
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
      ...messageReplyTo(roomId, event.content, this.type),
    });
  }

  private handleReaction(roomId: string, event: MatrixEvent): void {
    if (!this.#botUserId || event.sender === this.#botUserId) {
      return;
    }

    const relatesTo = event.content?.["m.relates_to"];
    if (
      relatesTo?.rel_type !== "m.annotation" ||
      typeof relatesTo.event_id !== "string" ||
      typeof relatesTo.key !== "string"
    ) {
      return;
    }

    const userId = event.sender;
    this.#reactionHandler?.({
      chatId: roomId,
      transport: this.type,
      messageId: relatesTo.event_id,
      reaction: relatesTo.key,
      timestamp: event.origin_server_ts ?? Date.now(),
      ...(event.event_id ? { reactionId: event.event_id } : {}),
      ...(userId ? { userId, username: extractUsername(userId) } : {}),
    });
  }

  private refreshRoomMemberCount(roomId: string): void {
    this.#client
      ?.getJoinedRoomMembers(roomId)
      .then((members) => this.#roomMemberCount.set(roomId, members.length))
      .catch(() => {});
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

function messageReplyTo(
  roomId: string,
  content: MatrixEventContent | undefined,
  transport: "matrix",
): { replyTo?: MessageReference } {
  const eventId = content?.["m.relates_to"]?.["m.in_reply_to"]?.event_id;
  return typeof eventId === "string"
    ? { replyTo: { transport, chatId: roomId, messageId: eventId } }
    : {};
}

export function createMatrixProvider(
  config: TransportConfig,
  context: { stateDir: string },
): MatrixProvider {
  return new MatrixProvider(
    parseMatrixConfig(config, context.stateDir),
    context.stateDir,
  );
}

export function parseMatrixConfig(
  config: TransportConfig,
  stateDir?: string,
): MatrixTransportConfig {
  const settings = config.settings ?? {};
  const homeserverUrl = settings.homeserverUrl;
  const accessToken =
    typeof settings.accessToken === "string" && settings.accessToken
      ? settings.accessToken
      : readAccessToken(stateDir);

  if (typeof homeserverUrl !== "string" || !homeserverUrl) {
    throw new MatrixConfigError("Matrix settings.homeserverUrl is required");
  }
  if (!accessToken) {
    throw new MatrixConfigError(
      "Matrix access token is required: set settings.accessToken or create state/matrix-access-token.txt with chmod 600",
    );
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

function summarizeSyncToDevice(response: unknown): string {
  if (!isRecord(response)) {
    return "to-device:none";
  }
  const toDevice = recordField(response, "to_device");
  const events = toDevice?.events;
  if (!Array.isArray(events)) {
    return "to-device:none";
  }
  return summarizeRawToDeviceEvents(events);
}

function summarizeRawToDeviceEvents(events: unknown[]): string {
  if (events.length === 0) {
    return "to-device:0";
  }
  return `to-device:${events.length} ${events
    .map((event) => {
      if (!isRecord(event)) {
        return typeof event;
      }
      return `${stringField(event, "type") ?? "unknown"} from:${stringField(event, "sender") ?? "unknown"}`;
    })
    .join(", ")}`;
}

function summarizeToDeviceRecipients(
  messages: Record<string, Record<string, unknown>>,
): string {
  return Object.entries(messages)
    .map(([userId, devices]) => `${userId}:${Object.keys(devices).join("|")}`)
    .join(", ");
}

function summarizeToDeviceEvent(event: unknown): string {
  if (Array.isArray(event)) {
    return `array length:${event.length} items:${event.map((item) => (isRecord(item) ? summarizeToDeviceRecord(item) : summarizeUnknownShape(item))).join(",")}`;
  }
  if (!isRecord(event)) {
    return summarizeUnknownShape(event);
  }

  return summarizeToDeviceRecord(event);
}

function summarizeToDeviceRecord(event: Record<string, unknown>): string {
  const type =
    stringField(event, "type") ?? stringField(event, "event_type") ?? "unknown";
  const content =
    recordField(event, "content") ?? recordField(event, "decrypted") ?? event;
  const roomId = stringField(content, "room_id") ?? "";
  const algorithm = stringField(content, "algorithm") ?? "";
  const sessionId = stringField(content, "session_id")
    ? "session_id:present"
    : "";
  const code = stringField(content, "code")
    ? `code:${stringField(content, "code")}`
    : "";
  const reason = stringField(content, "reason")
    ? `reason:${stringField(content, "reason")}`
    : "";
  const keys = Object.keys(event).join("|");
  const contentKeys = isRecord(content) ? Object.keys(content).join("|") : "";
  return [
    type,
    roomId,
    algorithm,
    sessionId,
    code,
    reason,
    `keys:${keys}`,
    `content:${contentKeys}`,
  ]
    .filter(Boolean)
    .join(" ");
}

function stringField(
  value: Record<string, unknown>,
  field: string,
): string | undefined {
  return typeof value[field] === "string" ? value[field] : undefined;
}

function recordField(
  value: Record<string, unknown>,
  field: string,
): Record<string, unknown> | undefined {
  return isRecord(value[field]) ? value[field] : undefined;
}

function summarizeUnknownShape(value: unknown): string {
  if (Array.isArray(value)) {
    return `array:${value.length}`;
  }
  if (isRecord(value)) {
    return `object:${Object.keys(value).join("|")}`;
  }
  return typeof value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
