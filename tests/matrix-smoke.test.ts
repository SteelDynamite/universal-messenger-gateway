import { join } from "node:path";
import { MatrixClient } from "matrix-bot-sdk";
import { afterEach, expect, test } from "vitest";
import type { InboundMessage } from "../src/index.js";
import { MatrixProvider } from "../src/index.js";

const SMOKE_TIMEOUT_MS = 90_000;
const WAIT_TIMEOUT_MS = 45_000;

type SmokeConfig = {
  homeserverUrl: string;
  accountA: SmokeAccount;
  accountB: SmokeAccount;
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
  errors: unknown[];
};

const config = matrixSmokeConfig();
const runMatrixSmoke = config ? test : test.skip;
const connectedParticipants: SmokeParticipant[] = [];
const roomsToLeave: string[] = [];

afterEach(async () => {
  await Promise.all(
    connectedParticipants.flatMap(({ provider }) =>
      roomsToLeave.map((roomId) =>
        provider.leaveChat(roomId, "matrix smoke cleanup").catch(() => {}),
      ),
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

runMatrixSmoke(
  "round-trips encrypted Matrix messages between two accounts",
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
    const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    const accountA = await connectParticipant(config.accountA, config, "a");
    const accountB = await connectParticipant(config.accountB, config, "b");

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
    await waitForInvite(accountB.provider, roomId);
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
    expect(await receivedByB).toMatchObject({
      transport: "matrix",
      chatId: roomId,
      content: messageFromA,
      isGroupChat: false,
      wasMentioned: false,
    });

    const messageFromB = `umg smoke b->a ${runId}`;
    const receivedByA = waitForMessage(
      accountA,
      (message) =>
        message.chatId === roomId && message.content === messageFromB,
    );
    await accountB.provider.sendMessage(roomId, messageFromB);
    expect(await receivedByA).toMatchObject({
      transport: "matrix",
      chatId: roomId,
      content: messageFromB,
      isGroupChat: false,
      wasMentioned: false,
    });

    expect(accountA.messages).toContainEqual(
      expect.objectContaining({ chatId: roomId, content: messageFromB }),
    );
    expect(accountB.messages).toContainEqual(
      expect.objectContaining({ chatId: roomId, content: messageFromA }),
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
    errors: [],
  };
  participant.provider.onMessage((message) =>
    participant.messages.push(message),
  );
  participant.provider.onError((error) => participant.errors.push(error));

  await participant.provider.connect();
  connectedParticipants.push(participant);
  return participant;
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
): Promise<void> {
  await waitFor(async () => await hasInvite(provider, inviteId));
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
  return await waitFor(() => participant.messages.find(predicate));
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

  if (!homeserverUrl || !accountAAccessToken || !accountBAccessToken) {
    throw new Error(
      "Matrix smoke test requires UMG_MATRIX_HOMESERVER_URL, UMG_MATRIX_A_ACCESS_TOKEN, and UMG_MATRIX_B_ACCESS_TOKEN",
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
    stateDir: process.env.UMG_MATRIX_SMOKE_STATE_DIR ?? "state/matrix-smoke",
  };
}
