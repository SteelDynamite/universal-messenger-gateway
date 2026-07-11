import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, expect, test } from "vitest";
import type {
  GatewayEvent,
  InboundMessage,
  InboundReaction,
  InboundTypingSnapshot,
  TransportInvite,
  TransportProvider,
} from "../src/index.js";
import {
  MatrixDecryptionError,
  MatrixProvider,
  TransportManager,
  createConfiguredTransports,
  loadGatewayConfig,
  runAdminCli,
  runGatewayStdio,
} from "../src/index.js";
import { MatrixControlClient, passwordLogin } from "./matrix-control-client.js";

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
  typings: InboundTypingSnapshot[];
  invites: TransportInvite[];
  errors: unknown[];
};

type LoggedInSmokeAccount = {
  account: SmokeAccount;
  stateName: string;
  userId: string;
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
  if (config) {
    await cleanupSmokeAccounts(config).catch(() => {});
  }
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

async function cleanupSmokeAccounts(config: SmokeConfig): Promise<void> {
  await Promise.all([
    cleanupSmokeAccount(config.homeserverUrl, config.accountA),
    cleanupSmokeAccount(config.homeserverUrl, config.accountB),
    cleanupSmokeAccount(config.homeserverUrl, config.accountC),
  ]);
}

async function cleanupSmokeAccount(
  homeserverUrl: string,
  account: SmokeAccount,
): Promise<void> {
  const client = new MatrixControlClient(homeserverUrl, account.accessToken);
  const userId = await client.getUserId();
  const sync = await client.syncNow();
  const joinedRoomIds = Object.keys(sync.rooms?.join ?? {});
  const invitedRoomIds = Object.keys(sync.rooms?.invite ?? {});

  await Promise.all(
    [...joinedRoomIds, ...invitedRoomIds].map((roomId) =>
      client.leaveRoom(roomId, "matrix smoke cleanup").catch(() => {}),
    ),
  );

  if (!account.accountPassword) return;
  const staleSmokeDeviceIds = (await client.listDevices())
    .filter((device) => device.display_name?.startsWith("umg-smoke-"))
    .map((device) => device.device_id);
  await client
    .deleteDevices(staleSmokeDeviceIds, userId, account.accountPassword)
    .catch(() => {});
}

runMatrixSmoke(
  "round-trips encrypted Matrix messages between live accounts",
  { timeout: SMOKE_TIMEOUT_MS },
  async () => {
    if (!config) {
      return;
    }

    const accountAUserId = await new MatrixControlClient(
      config.homeserverUrl,
      config.accountA.accessToken,
    ).getUserId();
    const accountBUserId = await new MatrixControlClient(
      config.homeserverUrl,
      config.accountB.accessToken,
    ).getUserId();
    const accountCUserId = await new MatrixControlClient(
      config.homeserverUrl,
      config.accountC.accessToken,
    ).getUserId();
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

    const accountA = await connectAdminConfiguredParticipant(
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
    const inviteEventForB = await waitFor(() =>
      accountB.invites.find((invite) => invite.inviteId === roomId),
    );
    expect(inviteEventForB).toMatchObject({
      inviteId: roomId,
      inviter: accountAUserId,
    });
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

    const threadRoot = {
      transport: "matrix" as const,
      chatId: roomId,
      messageId: requiredMessageId(messageAAtB),
    };
    const threadMessageFromB = `umg smoke thread b->a ${runId}`;
    const receivedThreadByA = waitForMessage(
      accountA,
      (message) =>
        message.chatId === roomId && message.content === threadMessageFromB,
    );
    await accountB.provider.sendMessage(
      roomId,
      threadMessageFromB,
      undefined,
      threadRoot,
    );
    const threadMessageAtA = await receivedThreadByA;
    expect(threadMessageAtA).toMatchObject({
      transport: "matrix",
      chatId: roomId,
      content: threadMessageFromB,
      threadTo: threadRoot,
    });
    expect(threadMessageAtA.replyTo).toBeUndefined();

    const threadReplyFromA = `umg smoke thread reply a->b ${runId}`;
    const receivedThreadReplyByB = waitForMessage(
      accountB,
      (message) =>
        message.chatId === roomId && message.content === threadReplyFromA,
    );
    await accountA.provider.sendMessage(
      roomId,
      threadReplyFromA,
      {
        transport: "matrix",
        chatId: roomId,
        messageId: requiredMessageId(threadMessageAtA),
      },
      threadRoot,
    );
    expect(await receivedThreadReplyByB).toMatchObject({
      transport: "matrix",
      chatId: roomId,
      content: threadReplyFromA,
      replyTo: {
        transport: "matrix",
        chatId: roomId,
        messageId: requiredMessageId(threadMessageAtA),
      },
      threadTo: threadRoot,
    });

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
    gatewayManager.onTyping((typing) =>
      writeGatewayEvent(gatewayOutput, { type: "typing", typing }),
    );
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
          `${JSON.stringify({ type: "set_typing", transport: "matrix", chatId: roomId, typing: true, timeoutMs: 10_000 })}\n`,
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
    expect(
      await waitForTyping(
        accountB,
        (typing) =>
          typing.chatId === roomId && typing.userIds.includes(accountAUserId),
      ),
    ).toMatchObject({ transport: "matrix", chatId: roomId });
    await gatewayManager.handleCommand({
      type: "set_typing",
      transport: "matrix",
      chatId: roomId,
      typing: false,
    });
    expect(
      await waitForTyping(
        accountB,
        (typing) =>
          typing.chatId === roomId && !typing.userIds.includes(accountAUserId),
      ),
    ).toMatchObject({ transport: "matrix", chatId: roomId });

    const gatewayThreadMessage = `umg smoke gateway thread ${runId}`;
    const receivedGatewayThreadByB = waitForMessage(
      accountB,
      (message) =>
        message.chatId === roomId && message.content === gatewayThreadMessage,
    );
    await gatewayManager.handleCommand({
      type: "send_message",
      transport: "matrix",
      chatId: roomId,
      text: gatewayThreadMessage,
      threadTo: threadRoot,
    });
    expect(await receivedGatewayThreadByB).toMatchObject({
      transport: "matrix",
      chatId: roomId,
      content: gatewayThreadMessage,
      threadTo: threadRoot,
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
    await accountB.provider.setTyping(roomId, true, 10_000);
    expect(
      await waitFor(() =>
        readGatewayEvents(gatewayOutput).find(
          (event) =>
            event.type === "typing" &&
            event.typing.chatId === roomId &&
            event.typing.userIds.includes(accountBUserId),
        ),
      ),
    ).toMatchObject({
      type: "typing",
      typing: expect.objectContaining({
        transport: "matrix",
        chatId: roomId,
        userIds: expect.arrayContaining([accountBUserId]),
      }),
    });
    await accountB.provider.setTyping(roomId, false);

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

    const outboundFileName = `umg-smoke-export-${runId}.html`;
    const outboundFilePath = join(config.stateDir, outboundFileName);
    await writeFile(outboundFilePath, `<html>${runId}</html>`);
    const receivedFileByB = waitForMessage(
      accountB,
      (message) =>
        message.chatId === formattedRoomId &&
        message.attachments?.[0]?.kind === "file" &&
        message.attachments[0].fileName === outboundFileName,
    );
    if (!accountA.provider.sendFile)
      throw new Error("Matrix provider missing sendFile");
    await accountA.provider.sendFile(
      formattedRoomId,
      outboundFilePath,
      outboundFileName,
      "text/html",
    );
    const fileAtB = await receivedFileByB;
    expect(fileAtB.attachments?.[0]).toMatchObject({
      kind: "file",
      fileName: outboundFileName,
      mimeType: "text/html",
    });

    const attachmentBody = `umg smoke attachment ${runId}`;
    const attachmentMediaId = await controlClient.uploadMedia(
      attachmentBody,
      "text/plain",
      "smoke.txt",
    );
    const receivedAttachmentByB = waitForMessage(
      accountB,
      (message) =>
        message.chatId === formattedRoomId &&
        message.attachments?.[0]?.mediaId === attachmentMediaId,
    );
    await controlClient.sendMessage(formattedRoomId, {
      msgtype: "m.file",
      body: "smoke.txt",
      url: attachmentMediaId,
      info: { mimetype: "text/plain", size: attachmentBody.length },
    });
    const attachmentAtB = await receivedAttachmentByB;
    expect(attachmentAtB).toMatchObject({
      transport: "matrix",
      chatId: formattedRoomId,
      content: "smoke.txt",
      attachments: [
        {
          mediaId: attachmentMediaId,
          kind: "file",
          fileName: "smoke.txt",
          mimeType: "text/plain",
          sizeBytes: attachmentBody.length,
          download: {
            status: "downloaded",
            sizeBytes: attachmentBody.length,
          },
        },
      ],
    });
    const downloadedAttachmentPath =
      attachmentAtB.attachments?.[0]?.download?.localPath;
    expect(downloadedAttachmentPath).toEqual(expect.any(String));
    expect(attachmentAtB.attachments?.[0]?.download?.sha256).toEqual(
      expect.any(String),
    );
    expect(await readFile(downloadedAttachmentPath ?? "", "utf8")).toBe(
      attachmentBody,
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(
      accountB.messages.filter(
        (message) =>
          message.chatId === formattedRoomId &&
          message.attachments?.[0]?.mediaId === attachmentMediaId,
      ),
    ).toHaveLength(1);

    await controlClient.sendStateEvent(
      formattedRoomId,
      "m.room.encryption",
      "",
      { algorithm: "m.megolm.v1.aes-sha2" },
    );

    const transitionMessageFromB = `umg smoke encrypted-after-transition b->a ${runId}`;
    const receivedTransitionByA = waitForMessage(
      accountA,
      (message) =>
        message.chatId === formattedRoomId &&
        message.content === transitionMessageFromB,
    );
    await accountB.provider.sendMessage(
      formattedRoomId,
      transitionMessageFromB,
    );
    const transitionMessageAtA = await receivedTransitionByA;
    expect(transitionMessageAtA).toMatchObject({
      transport: "matrix",
      chatId: formattedRoomId,
      content: transitionMessageFromB,
    });
    expect(
      await rawMatrixEventType(
        controlClient,
        formattedRoomId,
        requiredMessageId(transitionMessageAtA),
      ),
    ).toBe("m.room.encrypted");

    const transitionMessageFromA = `umg smoke encrypted-after-transition a->b ${runId}`;
    const receivedTransitionByB = waitForMessage(
      accountB,
      (message) =>
        message.chatId === formattedRoomId &&
        message.content === transitionMessageFromA,
    );
    await accountA.provider.sendMessage(
      formattedRoomId,
      transitionMessageFromA,
    );
    const transitionMessageAtB = await receivedTransitionByB;
    expect(transitionMessageAtB).toMatchObject({
      transport: "matrix",
      chatId: formattedRoomId,
      content: transitionMessageFromA,
    });
    expect(
      await rawMatrixEventType(
        controlClient,
        formattedRoomId,
        requiredMessageId(transitionMessageAtB),
      ),
    ).toBe("m.room.encrypted");

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
    `umg-smoke-${runId}`,
  );
  return {
    account: {
      ...account,
      accessToken: client.accessToken,
    },
    stateName: stateName(label, `${userId}-${client.deviceId ?? runId}`),
    userId,
  };
}

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
    typings: [],
    invites: [],
    errors: [],
  };
  participant.provider.onMessage((message) =>
    participant.messages.push(message),
  );
  participant.provider.onReaction((reaction) =>
    participant.reactions.push(reaction),
  );
  participant.provider.onTyping((typing) => participant.typings.push(typing));
  participant.provider.onInvite((invite) => participant.invites.push(invite));
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
  expect(statusOutput.text()).not.toContain("accessToken");
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
    typings: [],
    invites: [],
    errors: [],
  };
  participant.provider.onMessage((message) =>
    participant.messages.push(message),
  );
  participant.provider.onReaction((reaction) =>
    participant.reactions.push(reaction),
  );
  participant.provider.onTyping((typing) => participant.typings.push(typing));
  participant.provider.onInvite((invite) => participant.invites.push(invite));
  participant.provider.onError((error) => participant.errors.push(error));
  return participant;
}

async function expectTrustedE2eeHealth(
  participant: SmokeParticipant,
  account: SmokeAccount,
): Promise<void> {
  if (!account.recoveryKey) {
    return;
  }

  const health = await participant.provider.health?.();
  const e2ee = health?.find((check) => check.category === "matrix-e2ee");
  expect(e2ee).toMatchObject({ status: "ready" });
  const details = e2ee?.details?.join("\n") ?? "";
  expect(details).toContain("recovery key: present");
  expect(details).toContain("cross-sign import: imported");
  expect(details).toContain("cross-signing identity: present");
  expect(details).toContain("device signature: self-signed");
  expect(details).toContain("own device trust:");
  expect(details).not.toContain(account.recoveryKey);
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

async function waitForTyping(
  participant: SmokeParticipant,
  predicate: (typing: InboundTypingSnapshot) => boolean,
): Promise<InboundTypingSnapshot> {
  return await waitFor(() => participant.typings.find(predicate));
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
  if (
    error instanceof Error &&
    error.message.startsWith("Matrix cross-sign skipped:")
  ) {
    return false;
  }

  if (error instanceof MatrixDecryptionError) {
    return roomsToLeave.includes(error.roomId);
  }

  return true;
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
