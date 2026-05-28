import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { MatrixClient } from "matrix-bot-sdk";
import { afterEach, expect, test } from "vitest";
import type {
  GatewayEvent,
  InboundMessage,
  InboundReaction,
  TransportInvite,
  TransportProvider,
} from "../src/index.js";
import {
  MatrixProvider,
  TransportManager,
  createConfiguredTransports,
  loadGatewayConfig,
  runAdminCli,
  runGatewayStdio,
} from "../src/index.js";

const SMOKE_TIMEOUT_MS = 90_000;
const WAIT_TIMEOUT_MS = 45_000;

type SmokeConfig = {
  homeserverUrl: string;
  accountA: SmokeAccount;
  accountB: SmokeAccount;
  accountC: SmokeAccount;
  stateDir: string;
};

type SmokeAccount = {
  accessToken: string;
  accountPassword?: string;
  recoveryKey?: string;
};

type SmokeParticipant = {
  provider: MatrixProvider;
  messages: InboundMessage[];
  reactions: InboundReaction[];
  errors: unknown[];
};

const config = matrixSmokeConfig();
const runMatrixSmoke = config ? test : test.skip;
const connectedParticipants: SmokeParticipant[] = [];
const roomsToLeave: string[] = [];

afterEach(async () => {
  await Promise.all(
    connectedParticipants.flatMap(({ provider }) =>
      cleanupJoinedRooms(provider).catch(() => {}),
    ),
  );
  await Promise.all(
    connectedParticipants.map(({ provider }) =>
      provider.disconnect().catch(() => {}),
    ),
  );
  connectedParticipants.length = 0;
  roomsToLeave.length = 0;
});

async function cleanupJoinedRooms(provider: MatrixProvider): Promise<void> {
  const joinedRoomIds = new Set(
    (await provider.listChats()).map((chat) => chat.chatId),
  );
  await Promise.all(
    roomsToLeave
      .filter((roomId) => joinedRoomIds.has(roomId))
      .map((roomId) =>
        provider.leaveChat(roomId, "matrix smoke cleanup").catch(() => {}),
      ),
  );
}

runMatrixSmoke(
  "round-trips encrypted Matrix messages between live accounts",
  { timeout: SMOKE_TIMEOUT_MS },
  async () => {
    if (!config) {
      return;
    }

    const controlClient = new MatrixClient(
      config.homeserverUrl,
      config.accountA.accessToken,
    );
    const accountBUserId = await new MatrixClient(
      config.homeserverUrl,
      config.accountB.accessToken,
    ).getUserId();
    const accountCUserId = await new MatrixClient(
      config.homeserverUrl,
      config.accountC.accessToken,
    ).getUserId();
    const accountAUserId = await controlClient.getUserId();
    const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    const accountA = await connectAdminConfiguredParticipant(
      config.accountA,
      config,
      stateName("a", accountAUserId),
    );
    const accountB = await connectParticipant(
      config.accountB,
      config,
      stateName("b", accountBUserId),
    );
    const accountC = await connectParticipant(
      config.accountC,
      config,
      stateName("c", accountCUserId),
    );

    const roomId = await controlClient.createRoom({
      preset: "private_chat",
      visibility: "private",
      is_direct: true,
      invite: [accountBUserId],
      name: `umg smoke ${runId}`,
      initial_state: [
        {
          type: "m.room.encryption",
          state_key: "",
          content: { algorithm: "m.megolm.v1.aes-sha2" },
        },
      ],
    });
    roomsToLeave.push(roomId);

    await waitForChat(accountA.provider, roomId);
    const inviteForB = await waitForInvite(accountB.provider, roomId);
    expect(inviteForB).toMatchObject({
      inviteId: roomId,
      inviter: accountAUserId,
    });
    if (inviteForB.displayName) {
      expect(inviteForB.displayName).toBe(`umg smoke ${runId}`);
    }
    expect(await hasChat(accountB.provider, roomId)).toBe(false);

    await accountB.provider.acceptInvite(roomId);
    await waitForChat(accountB.provider, roomId);

    const messageFromA = `umg smoke a->b ${runId}`;
    const receivedByB = waitForMessage(
      accountB,
      (message) =>
        message.chatId === roomId && message.content === messageFromA,
    );
    await accountA.provider.sendMessage(roomId, messageFromA);
    const messageAAtB = await receivedByB;
    expect(messageAAtB).toMatchObject({
      transport: "matrix",
      chatId: roomId,
      content: messageFromA,
      isGroupChat: false,
      wasMentioned: false,
    });
    expect(messageAAtB.messageId).toEqual(expect.any(String));

    const messageFromB = `umg smoke b->a ${runId}`;
    const receivedByA = waitForMessage(
      accountA,
      (message) =>
        message.chatId === roomId && message.content === messageFromB,
    );
    await accountB.provider.sendMessage(roomId, messageFromB, {
      transport: "matrix",
      chatId: roomId,
      messageId: requiredMessageId(messageAAtB),
    });
    const messageBAtA = await receivedByA;
    expect(messageBAtA).toMatchObject({
      transport: "matrix",
      chatId: roomId,
      content: messageFromB,
      isGroupChat: false,
      wasMentioned: false,
      replyTo: {
        transport: "matrix",
        chatId: roomId,
        messageId: requiredMessageId(messageAAtB),
      },
    });
    expect(messageBAtA.messageId).toEqual(expect.any(String));

    const reaction = "👍";
    const receivedReactionByB = waitForReaction(
      accountB,
      (event) =>
        event.chatId === roomId &&
        event.messageId === requiredMessageId(messageBAtA) &&
        event.reaction === reaction,
    );
    await accountA.provider.sendReaction(
      roomId,
      requiredMessageId(messageBAtA),
      reaction,
    );
    expect(await receivedReactionByB).toMatchObject({
      transport: "matrix",
      chatId: roomId,
      messageId: requiredMessageId(messageBAtA),
      reaction,
    });

    const gatewayOutput = collectOutput();
    const gatewayManager = new TransportManager([accountA.provider]);
    gatewayManager.onMessage((message) => {
      accountA.messages.push(message);
      writeGatewayEvent(gatewayOutput, { type: "message", message });
    });
    gatewayManager.onReaction((reaction) => {
      accountA.reactions.push(reaction);
      writeGatewayEvent(gatewayOutput, { type: "reaction", reaction });
    });
    gatewayManager.onError((_transport, error) => accountA.errors.push(error));

    const gatewayMessage = `umg smoke gateway ${runId}`;
    const receivedGatewayMessageByB = waitForMessage(
      accountB,
      (message) =>
        message.chatId === roomId && message.content === gatewayMessage,
    );
    expect(
      await runGatewayStdio({
        input: Readable.from([
          `${JSON.stringify({ type: "send_typing", transport: "matrix", chatId: roomId })}\n`,
          `${JSON.stringify({ type: "send_message", transport: "matrix", chatId: roomId, text: gatewayMessage })}\n`,
        ]),
        errorOutput: collectOutput(),
        handleCommand: (command) => gatewayManager.handleCommand(command),
      }),
    ).toBe(0);
    expect(await receivedGatewayMessageByB).toMatchObject({
      transport: "matrix",
      chatId: roomId,
      content: gatewayMessage,
    });

    const gatewayInbound = `umg smoke gateway inbound ${runId}`;
    const receivedGatewayInboundByA = waitForMessage(
      accountA,
      (message) =>
        message.chatId === roomId && message.content === gatewayInbound,
    );
    await accountB.provider.sendMessage(roomId, gatewayInbound);
    const gatewayInboundAtA = await receivedGatewayInboundByA;
    expect(readGatewayEvents(gatewayOutput)).toContainEqual({
      type: "message",
      message: expect.objectContaining({
        chatId: roomId,
        content: gatewayInbound,
        messageId: requiredMessageId(gatewayInboundAtA),
      }),
    });

    const formattedRoomId = await controlClient.createRoom({
      preset: "private_chat",
      visibility: "private",
      is_direct: true,
      invite: [accountBUserId],
      name: `umg smoke formatted ${runId}`,
    });
    roomsToLeave.push(formattedRoomId);
    await waitForChat(accountA.provider, formattedRoomId);
    await waitForInvite(accountB.provider, formattedRoomId);
    await accountB.provider.acceptInvite(formattedRoomId);
    await waitForChat(accountB.provider, formattedRoomId);

    const formattedMessage = `umg smoke **bold** \`code\` ${runId}`;
    const receivedFormattedByB = waitForMessage(
      accountB,
      (message) =>
        message.chatId === formattedRoomId &&
        message.content === formattedMessage,
    );
    await accountA.provider.sendMessage(formattedRoomId, formattedMessage);
    const formattedAtB = await receivedFormattedByB;
    const rawFormattedEvent = await controlClient.getEvent(
      formattedRoomId,
      requiredMessageId(formattedAtB),
    );
    expect(rawFormattedEvent.content).toMatchObject({
      body: formattedMessage,
      format: "org.matrix.custom.html",
    });
    expect(rawFormattedEvent.content.formatted_body).toContain(
      "<strong>bold</strong>",
    );
    expect(rawFormattedEvent.content.formatted_body).toContain(
      "<code>code</code>",
    );

    const groupRoomId = await controlClient.createRoom({
      preset: "private_chat",
      visibility: "private",
      invite: [accountBUserId, accountCUserId],
      name: `umg smoke group ${runId}`,
      initial_state: [
        {
          type: "m.room.encryption",
          state_key: "",
          content: { algorithm: "m.megolm.v1.aes-sha2" },
        },
      ],
    });
    roomsToLeave.push(groupRoomId);
    await waitForChat(accountA.provider, groupRoomId);
    await waitForInvite(accountB.provider, groupRoomId);
    await waitForInvite(accountC.provider, groupRoomId);
    await accountB.provider.acceptInvite(groupRoomId);
    await accountC.provider.acceptInvite(groupRoomId);
    await waitForChat(accountB.provider, groupRoomId);
    await waitForChat(accountC.provider, groupRoomId);

    const groupMessage = `${accountAUserId} umg smoke group mention ${runId}`;
    const groupMessageContent = `umg smoke group mention ${runId}`;
    const receivedGroupMessageByA = waitForMessage(
      accountA,
      (message) =>
        message.chatId === groupRoomId &&
        message.content === groupMessageContent,
    );
    await accountB.provider.sendMessage(groupRoomId, groupMessage);
    expect(await receivedGroupMessageByA).toMatchObject({
      transport: "matrix",
      chatId: groupRoomId,
      content: groupMessageContent,
      isGroupChat: true,
      wasMentioned: true,
    });

    expect(accountA.messages).toContainEqual(
      expect.objectContaining({ chatId: roomId, content: messageFromB }),
    );
    expect(accountB.messages).toContainEqual(
      expect.objectContaining({ chatId: roomId, content: messageFromA }),
    );

    await accountB.provider.leaveChat(roomId, "matrix smoke leave");
    await waitFor(
      async () => !(await hasChat(accountB.provider, roomId)),
      `Matrix room ${roomId} still appears in joined chats after leave`,
    );

    const rejectedRoomId = await controlClient.createRoom({
      preset: "private_chat",
      visibility: "private",
      is_direct: true,
      invite: [accountBUserId],
      name: `umg smoke reject ${runId}`,
      initial_state: [
        {
          type: "m.room.encryption",
          state_key: "",
          content: { algorithm: "m.megolm.v1.aes-sha2" },
        },
      ],
    });
    roomsToLeave.push(rejectedRoomId);

    await waitForInvite(accountB.provider, rejectedRoomId);
    await accountB.provider.rejectInvite(rejectedRoomId, "matrix smoke reject");
    await waitFor(
      async () => !(await hasInvite(accountB.provider, rejectedRoomId)),
    );
    expect(await hasChat(accountB.provider, rejectedRoomId)).toBe(false);

    accountB.provider.shutdownForProcessExit();
    expect(accountB.provider.isConnected).toBe(false);
    expectNoUnexpectedErrors(accountA);
    expectNoUnexpectedErrors(accountB);
    expectNoUnexpectedErrors(accountC);
  },
);

async function connectParticipant(
  account: SmokeAccount,
  config: SmokeConfig,
  name: string,
): Promise<SmokeParticipant> {
  const participant: SmokeParticipant = {
    provider: new MatrixProvider(
      {
        homeserverUrl: config.homeserverUrl,
        accessToken: account.accessToken,
        ...(account.accountPassword
          ? { accountPassword: account.accountPassword }
          : {}),
        ...(account.recoveryKey ? { recoveryKey: account.recoveryKey } : {}),
      },
      join(config.stateDir, name),
    ),
    messages: [],
    reactions: [],
    errors: [],
  };
  participant.provider.onMessage((message) =>
    participant.messages.push(message),
  );
  participant.provider.onReaction((reaction) =>
    participant.reactions.push(reaction),
  );
  participant.provider.onError((error) => participant.errors.push(error));

  await participant.provider.connect();
  connectedParticipants.push(participant);
  return participant;
}

async function connectAdminConfiguredParticipant(
  account: SmokeAccount,
  config: SmokeConfig,
  name: string,
): Promise<SmokeParticipant> {
  const stateDir = join(config.stateDir, name);
  const output = collectOutput();
  const errorOutput = collectOutput();
  const env = { UNIVERSAL_MESSENGER_GATEWAY_STATE_DIR: stateDir };
  const configureArgs = [
    "configure",
    "matrix",
    "--set",
    `homeserverUrl=${config.homeserverUrl}`,
    "--set",
    `accessToken=${account.accessToken}`,
  ];

  if (account.accountPassword) {
    configureArgs.push("--set", `accountPassword=${account.accountPassword}`);
  }
  if (account.recoveryKey) {
    configureArgs.push("--set", `recoveryKey=${account.recoveryKey}`);
  }

  expect(
    await runAdminCli({
      args: configureArgs,
      output,
      errorOutput,
      env,
      cwd: process.cwd(),
    }),
  ).toBe(0);
  expect(
    await runAdminCli({
      args: ["disconnect", "matrix"],
      output,
      errorOutput,
      env,
      cwd: process.cwd(),
    }),
  ).toBe(0);
  expect(
    await runAdminCli({
      args: ["connect", "matrix"],
      output,
      errorOutput,
      env,
      cwd: process.cwd(),
    }),
  ).toBe(0);

  const statusOutput = collectOutput();
  expect(
    await runAdminCli({
      args: ["status"],
      output: statusOutput,
      errorOutput,
      env,
      cwd: process.cwd(),
    }),
  ).toBe(0);
  expect(statusOutput.text()).toContain("matrix: enabled");
  expect(statusOutput.text()).toContain("accessToken");
  expect(statusOutput.text()).not.toContain(account.accessToken);
  if (account.accountPassword) {
    expect(statusOutput.text()).not.toContain(account.accountPassword);
  }
  if (account.recoveryKey) {
    expect(statusOutput.text()).not.toContain(account.recoveryKey);
  }

  const transports = createConfiguredTransports(
    await loadGatewayConfig(stateDir),
    { stateDir },
  );
  expect(transports).toHaveLength(1);
  const provider = requireMatrixProvider(transports[0]);
  const participant = registerParticipant(provider);

  await participant.provider.connect();
  connectedParticipants.push(participant);
  return participant;
}

function stateName(label: string, userId: string): string {
  return `${label}-${userId.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
}

function registerParticipant(provider: MatrixProvider): SmokeParticipant {
  const participant: SmokeParticipant = {
    provider,
    messages: [],
    reactions: [],
    errors: [],
  };
  participant.provider.onMessage((message) =>
    participant.messages.push(message),
  );
  participant.provider.onReaction((reaction) =>
    participant.reactions.push(reaction),
  );
  participant.provider.onError((error) => participant.errors.push(error));
  return participant;
}

function requireMatrixProvider(
  provider: TransportProvider | undefined,
): MatrixProvider {
  if (!(provider instanceof MatrixProvider)) {
    throw new Error("Expected admin config to create a MatrixProvider");
  }

  return provider;
}

async function waitForChat(
  provider: MatrixProvider,
  roomId: string,
): Promise<void> {
  await waitFor(async () => {
    const chats = await provider.listChats();
    return chats.some((chat) => chat.chatId === roomId);
  }, `Matrix room ${roomId} did not appear in joined chats`);
}

async function waitForInvite(
  provider: MatrixProvider,
  inviteId: string,
): Promise<TransportInvite> {
  return await waitFor(async () => {
    const invites = await provider.listInvites();
    return invites.find((invite) => invite.inviteId === inviteId);
  });
}

async function hasChat(
  provider: MatrixProvider,
  roomId: string,
): Promise<boolean> {
  const chats = await provider.listChats();
  return chats.some((chat) => chat.chatId === roomId);
}

async function hasInvite(
  provider: MatrixProvider,
  inviteId: string,
): Promise<boolean> {
  const invites = await provider.listInvites();
  return invites.some((invite) => invite.inviteId === inviteId);
}

async function waitForMessage(
  participant: SmokeParticipant,
  predicate: (message: InboundMessage) => boolean,
): Promise<InboundMessage> {
  return await waitFor(() => {
    const unexpectedError = participant.errors.find(isUnexpectedSmokeError);
    if (unexpectedError) {
      throw unexpectedError;
    }
    return participant.messages.find(predicate);
  });
}

async function waitForReaction(
  participant: SmokeParticipant,
  predicate: (reaction: InboundReaction) => boolean,
): Promise<InboundReaction> {
  return await waitFor(() => participant.reactions.find(predicate));
}

function requiredMessageId(message: InboundMessage): string {
  if (!message.messageId) {
    throw new Error("Expected Matrix smoke message to include messageId");
  }

  return message.messageId;
}

function expectNoUnexpectedErrors(participant: SmokeParticipant): void {
  expect(participant.errors.filter(isUnexpectedSmokeError)).toEqual([]);
}

function isUnexpectedSmokeError(error: unknown): boolean {
  return !(
    error instanceof Error &&
    error.message.startsWith("Matrix cross-sign skipped:")
  );
}

async function waitFor<T>(
  read: () => T | undefined | false | Promise<T | undefined | false>,
  message = "Timed out waiting for Matrix smoke condition",
): Promise<T> {
  const startedAt = Date.now();
  let lastError: unknown;

  while (Date.now() - startedAt < WAIT_TIMEOUT_MS) {
    try {
      const result = await read();
      if (result) {
        return result;
      }
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(message, lastError ? { cause: lastError } : undefined);
}

function matrixSmokeConfig(): SmokeConfig | undefined {
  if (process.env.UMG_MATRIX_SMOKE !== "1") {
    return undefined;
  }

  const homeserverUrl = process.env.UMG_MATRIX_HOMESERVER_URL;
  const accountAAccessToken = process.env.UMG_MATRIX_A_ACCESS_TOKEN;
  const accountBAccessToken = process.env.UMG_MATRIX_B_ACCESS_TOKEN;
  const accountCAccessToken = process.env.UMG_MATRIX_C_ACCESS_TOKEN;

  if (
    !homeserverUrl ||
    !accountAAccessToken ||
    !accountBAccessToken ||
    !accountCAccessToken
  ) {
    throw new Error(
      "Matrix smoke test requires UMG_MATRIX_HOMESERVER_URL, UMG_MATRIX_A_ACCESS_TOKEN, UMG_MATRIX_B_ACCESS_TOKEN, and UMG_MATRIX_C_ACCESS_TOKEN",
    );
  }

  return {
    homeserverUrl,
    accountA: {
      accessToken: accountAAccessToken,
      ...(process.env.UMG_MATRIX_A_ACCOUNT_PASSWORD
        ? { accountPassword: process.env.UMG_MATRIX_A_ACCOUNT_PASSWORD }
        : {}),
      ...(process.env.UMG_MATRIX_A_RECOVERY_KEY
        ? { recoveryKey: process.env.UMG_MATRIX_A_RECOVERY_KEY }
        : {}),
    },
    accountB: {
      accessToken: accountBAccessToken,
      ...(process.env.UMG_MATRIX_B_ACCOUNT_PASSWORD
        ? { accountPassword: process.env.UMG_MATRIX_B_ACCOUNT_PASSWORD }
        : {}),
      ...(process.env.UMG_MATRIX_B_RECOVERY_KEY
        ? { recoveryKey: process.env.UMG_MATRIX_B_RECOVERY_KEY }
        : {}),
    },
    accountC: {
      accessToken: accountCAccessToken,
      ...(process.env.UMG_MATRIX_C_ACCOUNT_PASSWORD
        ? { accountPassword: process.env.UMG_MATRIX_C_ACCOUNT_PASSWORD }
        : {}),
      ...(process.env.UMG_MATRIX_C_RECOVERY_KEY
        ? { recoveryKey: process.env.UMG_MATRIX_C_RECOVERY_KEY }
        : {}),
    },
    stateDir: process.env.UMG_MATRIX_SMOKE_STATE_DIR ?? "state/matrix-smoke",
  };
}

function writeGatewayEvent(output: Writable, event: GatewayEvent): void {
  output.write(`${JSON.stringify(event)}\n`);
}

function readGatewayEvents(output: { text(): string }): GatewayEvent[] {
  return output
    .text()
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as GatewayEvent);
}

function collectOutput(): Writable & { text(): string } {
  let contents = "";

  return Object.assign(
    new Writable({
      write(chunk, _encoding, callback) {
        contents += String(chunk);
        callback();
      },
    }),
    {
      text: () => contents,
    },
  );
}
