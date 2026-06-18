import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, expect, test } from "vitest";
import type {
  GatewayEvent,
  InboundMessage,
  InboundReaction,
  TransportInvite,
} from "../src/index.js";
import {
  MautrixMatrixProvider,
  TransportManager,
  runGatewayStdio,
} from "../src/index.js";
import { MatrixControlClient, passwordLogin } from "./matrix-control-client.js";

const SMOKE_TIMEOUT_MS = 120_000;
const WAIT_TIMEOUT_MS = 45_000;

type SmokeConfig = {
  homeserverUrl: string;
  accountA: SmokeAccount;
  accountB: SmokeAccount;
  accountC: SmokeAccount;
  stateDir: string;
  pythonPath?: string;
};

type SmokeAccount = {
  accessToken: string;
  accountPassword?: string;
  recoveryKey?: string;
};

type LoggedInSmokeAccount = {
  account: SmokeAccount;
  stateName: string;
  userId: string;
};

type SmokeParticipant = {
  provider: MautrixMatrixProvider;
  messages: InboundMessage[];
  reactions: InboundReaction[];
  invites: TransportInvite[];
  errors: unknown[];
};

const config = matrixMautrixSmokeConfig();
const runMatrixMautrixSmoke = config ? test : test.skip;
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
  if (config) {
    await cleanupSmokeAccounts(config).catch(() => {});
  }
  connectedParticipants.length = 0;
  roomsToLeave.length = 0;
});

runMatrixMautrixSmoke(
  "matches Matrix transport parity through mautrix sidecar",
  { timeout: SMOKE_TIMEOUT_MS },
  async () => {
    if (!config) return;

    const accountAUserId = await matrixUserId(
      config.homeserverUrl,
      config.accountA.accessToken,
    );
    const accountBUserId = await matrixUserId(
      config.homeserverUrl,
      config.accountB.accessToken,
    );
    const accountCUserId = await matrixUserId(
      config.homeserverUrl,
      config.accountC.accessToken,
    );
    await cleanupSmokeAccounts(config);
    const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const loggedInA = await loginSmokeAccount(
      config.accountA,
      config,
      "a",
      accountAUserId,
      runId,
    );
    const loggedInB = await loginSmokeAccount(
      config.accountB,
      config,
      "b",
      accountBUserId,
      runId,
    );
    const loggedInC = await loginSmokeAccount(
      config.accountC,
      config,
      "c",
      accountCUserId,
      runId,
    );
    const controlClient = new MatrixControlClient(
      config.homeserverUrl,
      loggedInA.account.accessToken,
    );

    const accountA = await connectParticipant(
      loggedInA.account,
      config,
      loggedInA.stateName,
    );
    const accountB = await connectParticipant(
      loggedInB.account,
      config,
      loggedInB.stateName,
    );
    const accountC = await connectParticipant(
      loggedInC.account,
      config,
      loggedInC.stateName,
    );
    await expectTrustedE2eeHealth(accountA, loggedInA.account);
    await expectTrustedE2eeHealth(accountB, loggedInB.account);
    await expectTrustedE2eeHealth(accountC, loggedInC.account);

    const plainRoomId = await controlClient.createRoom({
      preset: "private_chat",
      visibility: "private",
      is_direct: true,
      invite: [accountBUserId],
      name: `umg mautrix plain ${runId}`,
    });
    roomsToLeave.push(plainRoomId);
    await waitForChat(accountA.provider, plainRoomId);
    await waitForInvite(accountB.provider, plainRoomId);
    await accountB.provider.acceptInvite(plainRoomId);
    await waitForChat(accountB.provider, plainRoomId);

    const plainMessage = `umg mautrix plaintext ${runId}`;
    const receivedPlainByB = waitForMessage(
      accountB,
      (message) =>
        message.chatId === plainRoomId && message.content === plainMessage,
    );
    await accountA.provider.sendMessage(plainRoomId, plainMessage);
    expect(await receivedPlainByB).toMatchObject({
      transport: "matrix",
      chatId: plainRoomId,
      content: plainMessage,
      isGroupChat: false,
      wasMentioned: false,
    });

    const formattedMessage = `umg mautrix **bold** \`code\` ${runId}`;
    const receivedFormattedByB = waitForMessage(
      accountB,
      (message) =>
        message.chatId === plainRoomId && message.content === formattedMessage,
    );
    await accountA.provider.sendMessage(plainRoomId, formattedMessage);
    const formattedAtB = await receivedFormattedByB;
    const rawFormattedEvent = await controlClient.getEvent(
      plainRoomId,
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

    const attachmentMediaId = `mxc://example.org/umg-mautrix-${runId}`;
    const receivedAttachmentByB = waitForMessage(
      accountB,
      (message) =>
        message.chatId === plainRoomId &&
        message.attachments?.[0]?.mediaId === attachmentMediaId,
    );
    await controlClient.sendMessage(plainRoomId, {
      msgtype: "m.file",
      body: "mautrix-smoke.txt",
      url: attachmentMediaId,
      info: { mimetype: "text/plain", size: 42 },
    });
    expect(await receivedAttachmentByB).toMatchObject({
      transport: "matrix",
      chatId: plainRoomId,
      content: "mautrix-smoke.txt",
      attachments: [
        {
          mediaId: attachmentMediaId,
          kind: "file",
          fileName: "mautrix-smoke.txt",
          mimeType: "text/plain",
          sizeBytes: 42,
        },
      ],
    });

    const encryptedRoomId = await controlClient.createRoom({
      preset: "private_chat",
      visibility: "private",
      is_direct: true,
      invite: [accountBUserId],
      name: `umg mautrix encrypted ${runId}`,
      initial_state: [
        {
          type: "m.room.encryption",
          state_key: "",
          content: { algorithm: "m.megolm.v1.aes-sha2" },
        },
      ],
    });
    roomsToLeave.push(encryptedRoomId);
    await waitForChat(accountA.provider, encryptedRoomId);
    await waitForInvite(accountB.provider, encryptedRoomId);
    await accountB.provider.acceptInvite(encryptedRoomId);
    await waitForChat(accountB.provider, encryptedRoomId);

    const seedMessage = `umg mautrix encrypted seed ${runId}`;
    const receivedSeedByA = waitForMessage(
      accountA,
      (message) =>
        message.chatId === encryptedRoomId && message.content === seedMessage,
    );
    await accountB.provider.sendMessage(encryptedRoomId, seedMessage);
    await receivedSeedByA;

    const encryptedMessage = `umg mautrix encrypted before restart ${runId}`;
    const receivedEncryptedByB = waitForMessage(
      accountB,
      (message) =>
        message.chatId === encryptedRoomId &&
        message.content === encryptedMessage,
    );
    await accountA.provider.sendMessage(encryptedRoomId, encryptedMessage);
    const encryptedAtB = await receivedEncryptedByB;
    expect(encryptedAtB).toMatchObject({
      transport: "matrix",
      chatId: encryptedRoomId,
      content: encryptedMessage,
    });
    expect(
      await rawMatrixEventType(
        controlClient,
        encryptedRoomId,
        requiredMessageId(encryptedAtB),
      ),
    ).toBe("m.room.encrypted");

    const replyMessage = `umg mautrix reply ${runId}`;
    const receivedReplyByA = waitForMessage(
      accountA,
      (message) =>
        message.chatId === encryptedRoomId && message.content === replyMessage,
    );
    await accountB.provider.sendMessage(encryptedRoomId, replyMessage, {
      transport: "matrix",
      chatId: encryptedRoomId,
      messageId: requiredMessageId(encryptedAtB),
    });
    const replyAtA = await receivedReplyByA;
    expect(replyAtA).toMatchObject({
      transport: "matrix",
      chatId: encryptedRoomId,
      content: replyMessage,
      replyTo: {
        transport: "matrix",
        chatId: encryptedRoomId,
        messageId: requiredMessageId(encryptedAtB),
      },
    });

    const threadRoot = {
      transport: "matrix" as const,
      chatId: encryptedRoomId,
      messageId: requiredMessageId(encryptedAtB),
    };
    const threadMessage = `umg mautrix thread ${runId}`;
    const receivedThreadByA = waitForMessage(
      accountA,
      (message) =>
        message.chatId === encryptedRoomId && message.content === threadMessage,
    );
    await accountB.provider.sendMessage(
      encryptedRoomId,
      threadMessage,
      undefined,
      threadRoot,
    );
    const threadAtA = await receivedThreadByA;
    expect(threadAtA).toMatchObject({
      transport: "matrix",
      chatId: encryptedRoomId,
      content: threadMessage,
      threadTo: threadRoot,
    });
    expect(threadAtA.replyTo).toBeUndefined();

    const threadReply = `umg mautrix thread reply ${runId}`;
    const receivedThreadReplyByB = waitForMessage(
      accountB,
      (message) =>
        message.chatId === encryptedRoomId && message.content === threadReply,
    );
    await accountA.provider.sendMessage(
      encryptedRoomId,
      threadReply,
      {
        transport: "matrix",
        chatId: encryptedRoomId,
        messageId: requiredMessageId(threadAtA),
      },
      threadRoot,
    );
    expect(await receivedThreadReplyByB).toMatchObject({
      transport: "matrix",
      chatId: encryptedRoomId,
      content: threadReply,
      replyTo: {
        transport: "matrix",
        chatId: encryptedRoomId,
        messageId: requiredMessageId(threadAtA),
      },
      threadTo: threadRoot,
    });

    const reaction = "👍";
    const receivedReactionByB = waitForReaction(
      accountB,
      (event) =>
        event.chatId === encryptedRoomId &&
        event.messageId === requiredMessageId(replyAtA) &&
        event.reaction === reaction,
    );
    await accountA.provider.sendReaction(
      encryptedRoomId,
      requiredMessageId(replyAtA),
      reaction,
    );
    expect(await receivedReactionByB).toMatchObject({
      transport: "matrix",
      chatId: encryptedRoomId,
      messageId: requiredMessageId(replyAtA),
      reaction,
    });

    const gatewayOutput = collectOutput();
    const gatewayManager = new TransportManager([accountA.provider]);
    gatewayManager.onMessage((message) => {
      accountA.messages.push(message);
      writeGatewayEvent(gatewayOutput, { type: "message", message });
    });
    gatewayManager.onReaction((event) => accountA.reactions.push(event));
    gatewayManager.onError((_transport, error) => accountA.errors.push(error));

    const gatewayMessage = `umg mautrix gateway ${runId}`;
    const receivedGatewayMessageByB = waitForMessage(
      accountB,
      (message) =>
        message.chatId === encryptedRoomId &&
        message.content === gatewayMessage,
    );
    expect(
      await runGatewayStdio({
        input: Readable.from([
          `${JSON.stringify({ type: "send_typing", transport: "matrix", chatId: encryptedRoomId })}\n`,
          `${JSON.stringify({ type: "send_message", transport: "matrix", chatId: encryptedRoomId, text: gatewayMessage })}\n`,
        ]),
        errorOutput: collectOutput(),
        handleCommand: (command) => gatewayManager.handleCommand(command),
      }),
    ).toBe(0);
    expect(await receivedGatewayMessageByB).toMatchObject({
      transport: "matrix",
      chatId: encryptedRoomId,
      content: gatewayMessage,
    });

    const gatewayThreadMessage = `umg mautrix gateway thread ${runId}`;
    const receivedGatewayThreadByB = waitForMessage(
      accountB,
      (message) =>
        message.chatId === encryptedRoomId &&
        message.content === gatewayThreadMessage,
    );
    await gatewayManager.handleCommand({
      type: "send_message",
      transport: "matrix",
      chatId: encryptedRoomId,
      text: gatewayThreadMessage,
      threadTo: threadRoot,
    });
    expect(await receivedGatewayThreadByB).toMatchObject({
      transport: "matrix",
      chatId: encryptedRoomId,
      content: gatewayThreadMessage,
      threadTo: threadRoot,
    });

    const gatewayInbound = `umg mautrix gateway inbound ${runId}`;
    const receivedGatewayInboundByA = waitForMessage(
      accountA,
      (message) =>
        message.chatId === encryptedRoomId &&
        message.content === gatewayInbound,
    );
    await accountB.provider.sendMessage(encryptedRoomId, gatewayInbound);
    const gatewayInboundAtA = await receivedGatewayInboundByA;
    expect(readGatewayEvents(gatewayOutput)).toContainEqual({
      type: "message",
      message: expect.objectContaining({
        chatId: encryptedRoomId,
        content: gatewayInbound,
        messageId: requiredMessageId(gatewayInboundAtA),
      }),
    });

    const groupRoomId = await controlClient.createRoom({
      preset: "private_chat",
      visibility: "private",
      invite: [accountBUserId, accountCUserId],
      name: `umg mautrix group ${runId}`,
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

    const groupMessage = `${accountAUserId} umg mautrix group mention ${runId}`;
    const groupMessageContent = `umg mautrix group mention ${runId}`;
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

    await accountB.provider.leaveChat(plainRoomId, "mautrix smoke leave");
    await waitFor(
      async () => !(await hasChat(accountB.provider, plainRoomId)),
      `Matrix room ${plainRoomId} still appears after leave`,
    );

    const rejectedRoomId = await controlClient.createRoom({
      preset: "private_chat",
      visibility: "private",
      is_direct: true,
      invite: [accountBUserId],
      name: `umg mautrix reject ${runId}`,
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
    await accountB.provider.rejectInvite(
      rejectedRoomId,
      "mautrix smoke reject",
    );
    await waitFor(
      async () => !(await hasInvite(accountB.provider, rejectedRoomId)),
    );
    expect(await hasChat(accountB.provider, rejectedRoomId)).toBe(false);

    await accountB.provider.disconnect();
    connectedParticipants.splice(connectedParticipants.indexOf(accountB), 1);
    const restartedB = await connectParticipant(
      loggedInB.account,
      config,
      loggedInB.stateName,
    );
    await waitForChat(restartedB.provider, encryptedRoomId);

    const afterRestartMessage = `umg mautrix encrypted after restart ${runId}`;
    const receivedAfterRestartByB = waitForMessage(
      restartedB,
      (message) =>
        message.chatId === encryptedRoomId &&
        message.content === afterRestartMessage,
    );
    await accountA.provider.sendMessage(encryptedRoomId, afterRestartMessage);
    expect(await receivedAfterRestartByB).toMatchObject({
      transport: "matrix",
      chatId: encryptedRoomId,
      content: afterRestartMessage,
    });

    restartedB.provider.shutdownForProcessExit();
    expect(restartedB.provider.isConnected).toBe(false);
    expectNoUnexpectedErrors(accountA);
    expectNoUnexpectedErrors(accountB);
    expectNoUnexpectedErrors(accountC);
    expectNoUnexpectedErrors(restartedB);
  },
);

async function matrixUserId(
  homeserverUrl: string,
  accessToken: string,
): Promise<string> {
  return await new MatrixControlClient(homeserverUrl, accessToken).getUserId();
}

async function loginSmokeAccount(
  account: SmokeAccount,
  config: SmokeConfig,
  label: string,
  userId: string,
  runId: string,
): Promise<LoggedInSmokeAccount> {
  if (!account.accountPassword) {
    return { account, stateName: stateName(label, userId), userId };
  }

  const client = await passwordLogin(
    config.homeserverUrl,
    userId,
    account.accountPassword,
    `umg-mautrix-smoke-${runId}`,
  );
  return {
    account: { ...account, accessToken: client.accessToken },
    stateName: stateName(label, `${userId}-${client.deviceId ?? runId}`),
    userId,
  };
}

function stateName(label: string, userId: string): string {
  return `${label}-${userId.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
}

async function connectParticipant(
  account: SmokeAccount,
  config: SmokeConfig,
  name: string,
): Promise<SmokeParticipant> {
  const provider = new MautrixMatrixProvider(
    {
      homeserverUrl: config.homeserverUrl,
      accessToken: account.accessToken,
      ...(account.recoveryKey ? { recoveryKey: account.recoveryKey } : {}),
      ...(config.pythonPath ? { pythonPath: config.pythonPath } : {}),
    },
    join(config.stateDir, "mautrix", name),
  );
  const participant: SmokeParticipant = {
    provider,
    messages: [],
    reactions: [],
    invites: [],
    errors: [],
  };
  provider.onMessage((message) => participant.messages.push(message));
  provider.onReaction((reaction) => participant.reactions.push(reaction));
  provider.onInvite((invite) => participant.invites.push(invite));
  provider.onError((error) => participant.errors.push(error));
  await provider.connect();
  connectedParticipants.push(participant);
  return participant;
}

async function expectTrustedE2eeHealth(
  participant: SmokeParticipant,
  account: SmokeAccount,
): Promise<void> {
  if (!account.recoveryKey) {
    return;
  }

  const e2ee = (await participant.provider.health()).find(
    (check) => check.category === "matrix-e2ee",
  );
  expect(e2ee).toMatchObject({ status: "ready" });
  const details = e2ee?.details?.join("\n") ?? "";
  expect(details).toContain("recovery key: present");
  expect(details).toContain("cross-sign import: imported");
  expect(details).toContain("cross-signing identity: present");
  expect(details).toContain("device signature: self-signed");
  expect(details).toContain("own device trust:");
  expect(details).not.toContain(account.recoveryKey);
}

async function cleanupJoinedRooms(
  provider: MautrixMatrixProvider,
): Promise<void> {
  const joinedRoomIds = new Set(
    (await provider.listChats()).map((chat) => chat.chatId),
  );
  await Promise.all(
    roomsToLeave
      .filter((roomId) => joinedRoomIds.has(roomId))
      .map((roomId) =>
        provider.leaveChat(roomId, "mautrix smoke cleanup").catch(() => {}),
      ),
  );
}

async function cleanupSmokeAccounts(config: SmokeConfig): Promise<void> {
  await Promise.all([
    cleanupSmokeAccount(config.homeserverUrl, config.accountA.accessToken),
    cleanupSmokeAccount(config.homeserverUrl, config.accountB.accessToken),
    cleanupSmokeAccount(config.homeserverUrl, config.accountC.accessToken),
  ]);
}

async function cleanupSmokeAccount(
  homeserverUrl: string,
  accessToken: string,
): Promise<void> {
  const client = new MatrixControlClient(homeserverUrl, accessToken);
  const sync = await client.syncNow();
  const joinedRoomIds = Object.keys(sync.rooms?.join ?? {});
  const invitedRoomIds = Object.keys(sync.rooms?.invite ?? {});

  await Promise.all(
    [...joinedRoomIds, ...invitedRoomIds].map((roomId) =>
      client.leaveRoom(roomId, "mautrix smoke cleanup").catch(() => {}),
    ),
  );
}

async function waitForChat(
  provider: MautrixMatrixProvider,
  roomId: string,
): Promise<void> {
  await waitFor(async () => {
    const chats = await provider.listChats();
    return chats.some((chat) => chat.chatId === roomId);
  }, `Matrix room ${roomId} did not appear in joined chats`);
}

async function waitForInvite(
  provider: MautrixMatrixProvider,
  inviteId: string,
): Promise<TransportInvite> {
  return await waitFor(async () => {
    const invites = await provider.listInvites();
    return invites.find((invite) => invite.inviteId === inviteId);
  });
}

async function hasChat(
  provider: MautrixMatrixProvider,
  roomId: string,
): Promise<boolean> {
  const chats = await provider.listChats();
  return chats.some((chat) => chat.chatId === roomId);
}

async function hasInvite(
  provider: MautrixMatrixProvider,
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

async function rawMatrixEventType(
  client: MatrixControlClient,
  roomId: string,
  eventId: string,
): Promise<string | undefined> {
  const event = (await client.getEvent(roomId, eventId)) as {
    type?: string;
  };
  return event.type;
}

function expectNoUnexpectedErrors(participant: SmokeParticipant): void {
  expect(participant.errors.filter(isUnexpectedSmokeError)).toEqual([]);
}

function isUnexpectedSmokeError(error: unknown): boolean {
  return !(error instanceof Error && error.message.includes("SYNC_ERRORED"));
}

async function waitFor<T>(
  read: () => T | undefined | false | Promise<T | undefined | false>,
  message = "Timed out waiting for Matrix mautrix smoke condition",
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
    { text: () => contents },
  );
}

function matrixMautrixSmokeConfig(): SmokeConfig | undefined {
  if (
    process.env.UMG_MATRIX_SMOKE !== "1" ||
    process.env.UMG_MATRIX_MAUTRIX_SMOKE !== "1"
  ) {
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
      "Matrix mautrix smoke test requires UMG_MATRIX_HOMESERVER_URL, UMG_MATRIX_A_ACCESS_TOKEN, UMG_MATRIX_B_ACCESS_TOKEN, and UMG_MATRIX_C_ACCESS_TOKEN",
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
    ...(process.env.UMG_MATRIX_MAUTRIX_PYTHON
      ? { pythonPath: process.env.UMG_MATRIX_MAUTRIX_PYTHON }
      : {}),
  };
}
