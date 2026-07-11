import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  MautrixMatrixDecryptionError,
  MautrixMatrixProvider,
  createConfiguredTransports,
  parseMautrixMatrixConfig,
} from "../src/index.js";
import type {
  InboundMessage,
  InboundReaction,
  InboundTypingSnapshot,
  TransportInvite,
} from "../src/index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  process.env.UMG_FAKE_MAUTRIX_LOG = undefined;
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
  tempDirs.length = 0;
});

test("default Matrix factory can select the mautrix sidecar implementation", async () => {
  const stateDir = await tempStateDir();
  const sidecarPath = await writeFakeSidecar(stateDir);
  const logPath = join(stateDir, "fake-sidecar.log");
  process.env.UMG_FAKE_MAUTRIX_LOG = logPath;

  await writeFile(join(stateDir, "matrix-access-token.txt"), "token\n");
  await chmod(join(stateDir, "matrix-access-token.txt"), 0o600);

  const transports = createConfiguredTransports(
    {
      transports: {
        matrix: {
          enabled: true,
          settings: {
            homeserverUrl: "https://matrix.example",
            implementation: "mautrix",
            pythonPath: process.execPath,
            sidecarPath,
          },
        },
      },
    },
    { stateDir },
  );

  expect(transports[0]).toBeInstanceOf(MautrixMatrixProvider);
  const provider = transports[0] as MautrixMatrixProvider;
  const messages: InboundMessage[] = [];
  const reactions: InboundReaction[] = [];
  const typings: InboundTypingSnapshot[] = [];
  const invites: TransportInvite[] = [];
  const errors: unknown[] = [];
  provider.onMessage((message) => messages.push(message));
  provider.onReaction((reaction) => reactions.push(reaction));
  provider.onTyping((typing) => typings.push(typing));
  provider.onInvite((invite) => invites.push(invite));
  provider.onError((error) => errors.push(error));

  await provider.connect();
  expect(await provider.listChats()).toEqual([
    { chatId: "!room", displayName: "Room" },
  ]);
  expect(await provider.health()).toEqual([
    { category: "matrix-e2ee", status: "ready", summary: "fake ready" },
  ]);
  expect(
    await provider.searchHistory({
      transport: "matrix",
      query: "history",
      chatIds: ["!room"],
      messageId: "$history",
    }),
  ).toMatchObject({
    messages: [
      {
        transport: "matrix",
        chatId: "!room",
        content: "history match",
        permalink: "https://matrix.to/#/!room/%24history",
        attachments: [
          {
            mediaId: "mxc://example/history",
            kind: "image",
            fileName: "history.png",
          },
        ],
      },
    ],
    scannedChats: 1,
    scannedMessages: 7,
  });
  await provider.sendMessage(
    "!room",
    "hello **matrix**",
    { transport: "matrix", chatId: "!room", messageId: "$reply" },
    { transport: "matrix", chatId: "!room", messageId: "$thread" },
  );
  const exportPath = join(stateDir, "session.html");
  await writeFile(exportPath, "<html>export</html>");
  await provider.sendFile("!room", exportPath, "session.html", "text/html", {
    transport: "matrix",
    chatId: "!room",
    messageId: "$reply",
  });
  await provider.sendReaction("!room", "$event", "👍");
  await provider.setTyping("!room", true, 10_000);
  await provider.setTyping("!room", false);
  await provider.acceptInvite("!invite");
  await provider.disconnect();

  await waitFor(
    () =>
      messages.length === 1 &&
      reactions.length === 1 &&
      typings.length === 1 &&
      invites.length === 1 &&
      errors.length === 1,
  );
  expect(messages[0]).toMatchObject({
    transport: "matrix",
    chatId: "!room",
    content: "from sidecar",
  });
  expect(reactions[0]).toMatchObject({
    transport: "matrix",
    chatId: "!room",
    messageId: "$event",
    reaction: "👍",
  });
  expect(typings).toEqual([
    {
      transport: "matrix",
      chatId: "!room",
      userIds: ["@alice:example"],
      observedAt: 1,
    },
  ]);
  expect(invites[0]).toEqual({ inviteId: "!invite", inviter: "@a:example" });
  expect(errors[0]).toBeInstanceOf(MautrixMatrixDecryptionError);
  expect(errors[0]).toMatchObject({ eventId: "$encrypted" });

  const log = (await readFile(logPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(log).toContainEqual(
    expect.objectContaining({
      type: "connect",
      homeserverUrl: "https://matrix.example",
      accessToken: "token",
      stateDir,
      encryption: true,
    }),
  );
  expect(log).toContainEqual(
    expect.objectContaining({
      type: "search_history",
      messageId: "$history",
    }),
  );
  expect(log).toContainEqual(
    expect.objectContaining({
      type: "send_message",
      chatId: "!room",
      text: "hello **matrix**",
      formattedBody: expect.stringContaining("<strong>matrix</strong>"),
      replyTo: { transport: "matrix", chatId: "!room", messageId: "$reply" },
      threadTo: { transport: "matrix", chatId: "!room", messageId: "$thread" },
    }),
  );
  expect(log).toContainEqual(
    expect.objectContaining({
      type: "set_typing",
      chatId: "!room",
      typing: true,
      timeoutMs: 10_000,
    }),
  );
  expect(log).toContainEqual(
    expect.objectContaining({
      type: "set_typing",
      chatId: "!room",
      typing: false,
    }),
  );
  expect(log).toContainEqual(
    expect.objectContaining({
      type: "send_file",
      chatId: "!room",
      path: exportPath,
      fileName: "session.html",
      mimeType: "text/html",
      replyTo: { transport: "matrix", chatId: "!room", messageId: "$reply" },
    }),
  );
});

test("parses mautrix settings with token from state file", async () => {
  const stateDir = await tempStateDir();
  await writeFile(join(stateDir, "matrix-access-token.txt"), "token\n");
  await chmod(join(stateDir, "matrix-access-token.txt"), 0o600);

  expect(
    parseMautrixMatrixConfig(
      {
        enabled: true,
        settings: {
          homeserverUrl: "https://matrix.example",
          encryption: false,
          pythonPath: "/python",
          sidecarPath: "/sidecar.py",
          startupTimeoutMs: 1234,
          mediaDownloadMaxBytes: 42,
          imageMediaDownloadMaxBytes: 84,
        },
      },
      stateDir,
    ),
  ).toEqual({
    homeserverUrl: "https://matrix.example",
    accessToken: "token",
    encryption: false,
    pythonPath: "/python",
    sidecarPath: "/sidecar.py",
    startupTimeoutMs: 1234,
    mediaDownloadMaxBytes: 42,
    imageMediaDownloadMaxBytes: 84,
  });
});

async function tempStateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "umg-mautrix-"));
  tempDirs.push(dir);
  return dir;
}

async function writeFakeSidecar(dir: string): Promise<string> {
  const path = join(dir, "fake-mautrix-sidecar.mjs");
  await writeFile(
    path,
    `import { appendFileSync } from "node:fs";\nimport { createInterface } from "node:readline";\nconst log = process.env.UMG_FAKE_MAUTRIX_LOG;\nfunction send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }\nfor await (const line of createInterface({ input: process.stdin })) {\n  const command = JSON.parse(line);\n  if (log) appendFileSync(log, JSON.stringify(command) + "\\n");\n  if (command.type === "connect") {\n    send({ id: command.id, ok: true, result: { userId: "@bot:example" } });\n    send({ type: "message", message: { transport: "matrix", chatId: "!room", content: "from sidecar", timestamp: 1, isGroupChat: false, wasMentioned: false } });\n    send({ type: "reaction", reaction: { transport: "matrix", chatId: "!room", messageId: "$event", reaction: "👍", timestamp: 1 } });\n    send({ type: "typing", typing: { transport: "matrix", chatId: "!room", userIds: ["@alice:example"], observedAt: 1 } });\n    send({ type: "invite", invite: { inviteId: "!invite", inviter: "@a:example" } });\n    send({ type: "error", category: "matrix-decryption", eventId: "$encrypted", error: "failed" });\n  } else if (command.type === "list_chats") {\n    send({ id: command.id, ok: true, result: [{ chatId: "!room", displayName: "Room" }] });\n  } else if (command.type === "list_invites") {\n    send({ id: command.id, ok: true, result: [{ inviteId: "!invite" }] });\n  } else if (command.type === "health") {\n    send({ id: command.id, ok: true, result: [{ category: "matrix-e2ee", status: "ready", summary: "fake ready" }] });\n  } else if (command.type === "search_history") {\n    send({ id: command.id, ok: true, result: { messages: [{ transport: "matrix", chatId: "!room", messageId: "$history", content: "history match", timestamp: 2, permalink: "https://matrix.to/#/!room/%24history", attachments: [{ mediaId: "mxc://example/history", kind: "image", fileName: "history.png" }] }], scannedChats: 1, scannedMessages: 7, skippedDecryption: 2, partial: true, errors: ["search returned partial results at deadline"] } });\n  } else {\n    send({ id: command.id, ok: true });\n  }\n}\n`,
  );
  return path;
}

async function waitFor(read: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 1000) {
    if (read()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for condition");
}
