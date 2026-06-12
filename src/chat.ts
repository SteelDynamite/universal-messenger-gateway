import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import { type GatewayClient, ManagerGatewayClient } from "./gateway-client.js";
import {
  type GatewayCommand,
  type GatewayEvent,
  type TransportName,
  isTransportName,
} from "./protocol.js";
import type { TransportHealth } from "./transports/interface.js";
import {
  type TransportManager,
  UnknownTransportError,
} from "./transports/manager.js";

type ChatTarget = {
  transport: TransportName;
  chatId: string;
};

type ChatState = {
  currentTarget: ChatTarget | undefined;
  knownTargets: Map<TransportName, Map<string, string | undefined>>;
  knownInvites: Map<TransportName, Map<string, string | undefined>>;
};

type TtyInput = Readable & {
  isTTY?: boolean;
  setRawMode?(mode: boolean): void;
  resume(): void;
  pause(): void;
};

type TtyOutput = Writable & {
  isTTY?: boolean;
};

type Suggestion = {
  label: string;
  value: string;
};

const SLASH_COMMANDS = [
  "/target",
  "/accept",
  "/reject",
  "/leave",
  "/status",
  "/configure",
  "/connect",
  "/disconnect",
  "/quit",
] as const;

export type RunChatCliOptions = {
  input: Readable;
  output: Writable;
  errorOutput: Writable;
  manager?: TransportManager;
  client?: GatewayClient;
  runAdminCommand?: (
    args: string[],
    output: Writable,
    errorOutput: Writable,
  ) => Promise<number>;
  reloadTransports?: () => Promise<void>;
};

export async function runChatCli({
  input,
  output,
  errorOutput,
  manager,
  client,
  runAdminCommand,
  reloadTransports,
}: RunChatCliOptions): Promise<number> {
  const gatewayClient =
    client ??
    (manager
      ? new ManagerGatewayClient({
          manager,
          ...(runAdminCommand ? { runAdminCommand } : {}),
          ...(reloadTransports ? { reloadTransports } : {}),
        })
      : undefined);
  if (!gatewayClient) {
    throw new Error(
      "runChatCli requires a gateway client or transport manager",
    );
  }

  const state: ChatState = {
    currentTarget: undefined,
    knownTargets: new Map(),
    knownInvites: new Map(),
  };
  const write = (message: string) => output.write(message);
  const writeError = (message: string) => errorOutput.write(message);

  if (isInteractiveTerminal(input, output)) {
    return await runInteractiveChat({
      input,
      output,
      client: gatewayClient,
      state,
      write,
      writeError,
      runAdminCommand,
      reloadTransports,
    });
  }

  return await runLineChat({
    input,
    output,
    client: gatewayClient,
    state,
    write,
    writeError,
    runAdminCommand,
    reloadTransports,
  });
}

type ChatRuntime = {
  client: GatewayClient;
  state: ChatState;
  write(message: string): boolean;
  writeError(message: string): boolean;
  runAdminCommand:
    | ((
        args: string[],
        output: Writable,
        errorOutput: Writable,
      ) => Promise<number>)
    | undefined;
  reloadTransports: (() => Promise<void>) | undefined;
};

type PromptRuntime = ChatRuntime & {
  refreshPrompt(): void;
};

async function startChatSession(context: ChatRuntime): Promise<void> {
  const { client, state, write, writeError } = context;
  if (client.configuredTransports().size === 0) {
    write(noTransportsMessage());
    return;
  }

  await client.connect();
  await rememberListedChats(client, state, writeError);
  await rememberListedInvites(client, state, writeError);
  await writeTransportHealth(context, {
    includeDetails: false,
    onlyProblems: true,
  });
  write(
    "Connected. Type a message, /target <transport> <chatId>, /accept, /reject, /leave, /status, /configure, /connect, /disconnect, or /quit.\n",
  );
}

function noTransportsMessage(): string {
  return [
    "No transports are enabled.",
    "",
    "Start here:",
    "  Create state/config.json with Matrix settings, and store secrets in:",
    "    state/matrix-access-token.txt",
    "    state/matrix-recovery-key.txt  # for encrypted rooms",
    "  Then run: umg chat",
    "",
    "Quick unencrypted setup:",
    "  /configure matrix --enable --set homeserverUrl=https://matrix.example --set encryption=false",
    "  # plus state/matrix-access-token.txt with chmod 600",
    "",
  ].join("\n");
}

async function runLineChat({
  input,
  output,
  client,
  state,
  write,
  writeError,
  runAdminCommand,
  reloadTransports,
}: ChatRuntime & { input: Readable; output: Writable }): Promise<number> {
  const readline = createInterface({ input, output, terminal: false });
  let readlineClosed = false;
  readline.once("close", () => {
    readlineClosed = true;
  });
  const refreshPrompt = () => {
    if (readlineClosed) {
      return;
    }
    readline.setPrompt(`${formatPromptTarget(state.currentTarget)} > `);
    readline.prompt();
  };

  registerGatewayClientHandlers({
    client,
    state,
    write,
    writeError,
    runAdminCommand,
    reloadTransports,
    refreshPrompt,
  });
  await startChatSession({
    client,
    state,
    write,
    writeError,
    runAdminCommand,
    reloadTransports,
  });
  refreshPrompt();

  try {
    for await (const line of readline) {
      const shouldQuit = await handleInputLine(line, {
        client,
        state,
        write,
        writeError,
        runAdminCommand,
        reloadTransports,
      });

      if (shouldQuit) {
        break;
      }

      refreshPrompt();
    }

    return 0;
  } finally {
    readline.close();
    await client.disconnect();
  }
}

async function runInteractiveChat({
  input,
  output,
  client,
  state,
  write,
  writeError,
  runAdminCommand,
  reloadTransports,
}: ChatRuntime & { input: TtyInput; output: TtyOutput }): Promise<number> {
  let buffer = "";
  let cursorIndex = 0;
  let suggestions: Suggestion[] = [];
  let selectedSuggestion = 0;
  let renderedLineCount = 0;
  let done = false;
  let showSuggestions = true;

  const refreshSuggestions = () => {
    suggestions = showSuggestions ? suggestionsFor(buffer, state, client) : [];
    if (selectedSuggestion >= suggestions.length) {
      selectedSuggestion = 0;
    }
  };
  const render = () => {
    refreshSuggestions();
    renderedLineCount = renderPrompt(
      output,
      state.currentTarget,
      buffer,
      cursorIndex,
      suggestions,
      selectedSuggestion,
      renderedLineCount,
    );
  };
  const clearRenderedPrompt = () => {
    clearPrompt(output, renderedLineCount);
    renderedLineCount = 0;
  };

  registerGatewayClientHandlers({
    client,
    state,
    write(message) {
      clearRenderedPrompt();
      const result = write(message);
      render();
      return result;
    },
    writeError,
    runAdminCommand,
    reloadTransports,
    refreshPrompt: render,
  });

  await startChatSession({
    client,
    state,
    write,
    writeError,
    runAdminCommand,
    reloadTransports,
  });
  input.setRawMode?.(true);
  input.resume();
  render();

  try {
    await new Promise<void>((resolve, reject) => {
      const onData = (chunk: Buffer) => {
        void handleKeypress(String(chunk)).catch(reject);
      };
      const handleKeypress = async (key: string) => {
        const submitInput = async () => {
          const selectedValue = suggestions[selectedSuggestion]?.value;
          if (selectedValue && selectedValue !== buffer) {
            buffer = selectedValue;
            cursorIndex = buffer.length;
            selectedSuggestion = 0;
            showSuggestions = true;
            render();
            return;
          }

          clearRenderedPrompt();
          if (buffer.trim()) {
            output.write("\n");
          }
          const shouldQuit = await handleInputLine(buffer, {
            client,
            state,
            write,
            writeError,
            runAdminCommand,
            reloadTransports,
          });
          buffer = "";
          cursorIndex = 0;
          showSuggestions = true;

          if (shouldQuit) {
            done = true;
            resolve();
            return;
          }

          render();
        };

        const insertText = (text: string) => {
          if (!text) {
            return;
          }
          buffer = `${buffer.slice(0, cursorIndex)}${text}${buffer.slice(cursorIndex)}`;
          cursorIndex += text.length;
          selectedSuggestion = 0;
          showSuggestions = true;
          render();
        };

        if (key.includes("\u001b[200~")) {
          insertText(normalizePastedText(stripBracketedPaste(key)));
          return;
        }
        if (key.length > 1 && !key.startsWith("\u001b")) {
          insertText(normalizePastedText(key));
          return;
        }
        if (key === "\u0003") {
          done = true;
          resolve();
          return;
        }
        if (key === "\u0001" || key === "\u001b[H" || key === "\u001b[1~") {
          cursorIndex = 0;
          render();
          return;
        }
        if (key === "\u0005" || key === "\u001b[F" || key === "\u001b[4~") {
          cursorIndex = buffer.length;
          render();
          return;
        }
        if (key === "\u0004") {
          if (buffer.length === 0) {
            done = true;
            resolve();
            return;
          }
          if (cursorIndex < buffer.length) {
            buffer = `${buffer.slice(0, cursorIndex)}${buffer.slice(cursorIndex + 1)}`;
            selectedSuggestion = 0;
            showSuggestions = true;
            render();
          }
          return;
        }
        if (key === "\u0015") {
          buffer = buffer.slice(cursorIndex);
          cursorIndex = 0;
          selectedSuggestion = 0;
          showSuggestions = true;
          render();
          return;
        }
        if (key === "\u000b") {
          buffer = buffer.slice(0, cursorIndex);
          selectedSuggestion = 0;
          showSuggestions = true;
          render();
          return;
        }
        if (key === "\u0017") {
          const newCursorIndex = previousWordStart(buffer, cursorIndex);
          buffer = `${buffer.slice(0, newCursorIndex)}${buffer.slice(cursorIndex)}`;
          cursorIndex = newCursorIndex;
          selectedSuggestion = 0;
          showSuggestions = true;
          render();
          return;
        }
        if (key === "\f") {
          render();
          return;
        }
        if (key === "\r" || key === "\n") {
          await submitInput();
          return;
        }
        if (key === "\u001b") {
          showSuggestions = false;
          selectedSuggestion = 0;
          render();
          return;
        }
        if (key === "\u001b[A" && suggestions.length > 0) {
          selectedSuggestion = wrapSuggestion(
            selectedSuggestion - 1,
            suggestions,
          );
          render();
          return;
        }
        if (key === "\u001b[B" && suggestions.length > 0) {
          selectedSuggestion = wrapSuggestion(
            selectedSuggestion + 1,
            suggestions,
          );
          render();
          return;
        }
        if (key === "\u001b[D") {
          cursorIndex = Math.max(0, cursorIndex - 1);
          render();
          return;
        }
        if (key === "\u001b[C") {
          cursorIndex = Math.min(buffer.length, cursorIndex + 1);
          render();
          return;
        }
        if (key === "\u001b[3~") {
          if (cursorIndex < buffer.length) {
            buffer = `${buffer.slice(0, cursorIndex)}${buffer.slice(cursorIndex + 1)}`;
            selectedSuggestion = 0;
            showSuggestions = true;
            render();
          }
          return;
        }
        if (key === "\u007f" || key === "\b") {
          if (cursorIndex > 0) {
            buffer = `${buffer.slice(0, cursorIndex - 1)}${buffer.slice(cursorIndex)}`;
            cursorIndex -= 1;
            selectedSuggestion = 0;
            showSuggestions = true;
            render();
          }
          return;
        }
        if (isPrintable(key)) {
          insertText(key);
        }
      };

      input.on("data", onData);
      input.once("end", () => resolve());
      const cleanup = () => {
        input.off("data", onData);
      };
      if (done) {
        cleanup();
      }
    });

    return 0;
  } finally {
    client.shutdownForProcessExit?.();
    input.setRawMode?.(false);
    input.pause();
    clearRenderedPrompt();
  }
}

async function rememberListedChats(
  client: GatewayClient,
  state: ChatState,
  writeError: (message: string) => boolean,
): Promise<void> {
  await Promise.all(
    [...client.configuredTransports()].map(async (transport) => {
      try {
        for (const chat of await client.listChats(transport)) {
          rememberTarget(
            state.knownTargets,
            transport,
            chat.chatId,
            chat.displayName,
          );
        }
      } catch (error) {
        writeError(`Could not list chats for ${transport}: ${String(error)}\n`);
      }
    }),
  );
}

async function rememberListedInvites(
  client: GatewayClient,
  state: ChatState,
  writeError: (message: string) => boolean,
): Promise<void> {
  await Promise.all(
    [...client.configuredTransports()].map(async (transport) => {
      try {
        const invites = new Map<string, string | undefined>();
        for (const invite of await client.listInvites(transport)) {
          invites.set(invite.inviteId, invite.displayName);
        }
        state.knownInvites.set(transport, invites);
      } catch (error) {
        writeError(
          `Could not list invites for ${transport}: ${String(error)}\n`,
        );
      }
    }),
  );
}

function registerGatewayClientHandlers({
  client,
  state,
  write,
  writeError,
  refreshPrompt,
}: PromptRuntime): void {
  client.onEvent((event) => {
    if (event.type === "admin_result") {
      write(event.output);
      if (event.ok && event.command !== "status") {
        write("Transport configuration applied.\n");
      }
      refreshPrompt();
      return;
    }
    if (event.type === "command_error") {
      write(commandErrorText(event));
      refreshPrompt();
      return;
    }
    if (event.type === "reaction") {
      return;
    }
    if (event.type === "invite") {
      const invites =
        state.knownInvites.get(event.invite.transport) ?? new Map();
      invites.set(event.invite.inviteId, event.invite.displayName);
      state.knownInvites.set(event.invite.transport, invites);
      write(
        `[${event.invite.transport} invite] ${formatTargetLabel(event.invite.inviteId, event.invite.displayName)}${event.invite.inviter ? ` from ${event.invite.inviter}` : ""}\n`,
      );
      refreshPrompt();
      return;
    }

    const { message } = event;
    rememberTarget(state.knownTargets, message.transport, message.chatId);
    state.currentTarget ??= {
      transport: message.transport,
      chatId: message.chatId,
    };
    write(
      `[${message.transport} ${message.chatId}] ${formatSender(message)}: ${message.content}\n`,
    );
    refreshPrompt();
  });
  client.onError((transport, error) => {
    const matrixDecryptionError = asMatrixDecryptionError(error);
    if (matrixDecryptionError) {
      rememberTarget(
        state.knownTargets,
        transport,
        matrixDecryptionError.roomId,
      );
      state.currentTarget ??= {
        transport,
        chatId: matrixDecryptionError.roomId,
      };
      write(
        `\n[${transport} ${matrixDecryptionError.roomId}] encrypted event could not be decrypted; target selected so you can send a message to bootstrap room-key sharing.\n`,
      );
      refreshPrompt();
      return;
    }

    writeError(`Transport error from ${transport}: ${String(error)}\n`);
  });
}

function commandErrorText(
  event: Extract<GatewayEvent, { type: "command_error" }>,
): string {
  const target = [
    event.transport,
    event.chatId,
    event.messageId,
    event.inviteId,
  ]
    .filter((value) => value !== undefined)
    .join(" ");
  return target
    ? `Command failed (${event.command} ${target}): ${event.error}\n`
    : `Command failed (${event.command}): ${event.error}\n`;
}

function asMatrixDecryptionError(
  error: unknown,
): { roomId: string } | undefined {
  if (
    error instanceof Error &&
    error.name === "MatrixDecryptionError" &&
    "roomId" in error &&
    typeof error.roomId === "string"
  ) {
    return { roomId: error.roomId };
  }

  return undefined;
}

async function handleInputLine(
  line: string,
  context: ChatRuntime,
): Promise<boolean> {
  const inputLine = line.trim();

  if (!inputLine) {
    return false;
  }

  if (inputLine.startsWith("/")) {
    return handleSlashCommand(inputLine, context);
  }

  if (!context.state.currentTarget) {
    context.write(
      "No target selected yet. Wait for an inbound message or use /target <transport> <chatId>.\n",
    );
    return false;
  }

  try {
    await context.client.send({
      type: "send_message",
      transport: context.state.currentTarget.transport,
      chatId: context.state.currentTarget.chatId,
      text: inputLine,
    });
    context.write(
      `[${context.state.currentTarget.transport} ${context.state.currentTarget.chatId}] me: ${inputLine}\n`,
    );
  } catch (error) {
    writeTransportActionError(
      error,
      context.state.currentTarget.transport,
      context,
    );
  }

  return false;
}

async function handleSlashCommand(
  line: string,
  context: ChatRuntime,
): Promise<boolean> {
  const [command, ...args] = line.split(/\s+/);

  switch (command) {
    case "/quit":
      return true;
    case "/status":
      await writeStatus(context);
      return false;
    case "/target":
      setTarget(args, context);
      return false;
    case "/accept":
      await acceptInvite(args, context);
      return false;
    case "/reject":
      await rejectInvite(args, context);
      return false;
    case "/leave":
      await leaveTarget(args, context);
      return false;
    case "/configure":
    case "/connect":
    case "/disconnect":
      await runAdminSlashCommand(command.slice(1), args, context);
      return false;
    default:
      context.write(
        "Unknown command. Available: /target, /accept, /reject, /leave, /status, /configure, /connect, /disconnect, /quit.\n",
      );
      return false;
  }
}

async function runAdminSlashCommand(
  command: string,
  args: string[],
  context: ChatRuntime,
): Promise<void> {
  const gatewayCommand = adminSlashToGatewayCommand(command, args, context);
  if (!gatewayCommand) {
    return;
  }

  try {
    await context.client.send(gatewayCommand);
  } catch (error) {
    writeTransportActionError(
      error,
      "transport" in gatewayCommand ? gatewayCommand.transport : "matrix",
      context,
    );
    return;
  }

  if (
    context.state.currentTarget &&
    !context.client
      .configuredTransports()
      .has(context.state.currentTarget.transport)
  ) {
    context.state.currentTarget = undefined;
  }
  await rememberListedChats(context.client, context.state, context.writeError);
  await rememberListedInvites(
    context.client,
    context.state,
    context.writeError,
  );
}

function adminSlashToGatewayCommand(
  command: string,
  args: string[],
  context: ChatRuntime,
): GatewayCommand | undefined {
  if (command === "connect" || command === "disconnect") {
    const [transport, extra] = args;
    if (!isTransportName(transport) || extra) {
      context.write(`Usage: /${command} <transport>\n`);
      return undefined;
    }
    return {
      type:
        command === "connect" ? "connect_transport" : "disconnect_transport",
      transport,
    };
  }

  if (command === "configure") {
    const [transport, ...flags] = args;
    if (!isTransportName(transport)) {
      context.write(
        "Usage: /configure <transport> [--enable|--disable] [--set key=value]...\n",
      );
      return undefined;
    }

    const parsed = parseConfigureSlashFlags(flags, context);
    if (!parsed) {
      return undefined;
    }

    return {
      type: "configure_transport",
      transport,
      ...(parsed.enabled === undefined ? {} : { enabled: parsed.enabled }),
      ...(Object.keys(parsed.settings).length === 0
        ? {}
        : { settings: parsed.settings }),
    };
  }

  return undefined;
}

function parseConfigureSlashFlags(
  args: string[],
  context: ChatRuntime,
): { enabled?: boolean; settings: Record<string, unknown> } | undefined {
  const settings: Record<string, unknown> = {};
  let enabled: boolean | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--enable") {
      enabled = true;
      continue;
    }
    if (arg === "--disable") {
      enabled = false;
      continue;
    }
    const assignment =
      arg === "--set"
        ? args[++index]
        : arg?.startsWith("--set=")
          ? arg.slice("--set=".length)
          : undefined;
    if (assignment !== undefined) {
      const separator = assignment.indexOf("=");
      if (separator <= 0) {
        context.write("Settings must use key=value\n");
        return undefined;
      }
      settings[assignment.slice(0, separator)] = parseSettingValue(
        assignment.slice(separator + 1),
      );
      continue;
    }

    context.write(`Unknown configure option: ${arg}\n`);
    return undefined;
  }

  return { ...(enabled === undefined ? {} : { enabled }), settings };
}

function parseSettingValue(value: string): unknown {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return value;
}

async function acceptInvite(
  args: string[],
  context: ChatRuntime,
): Promise<void> {
  const target = targetFromArgs(args, undefined);

  if (!target) {
    context.write("Usage: /accept <transport> <invite>\n");
    return;
  }

  try {
    await context.client.acceptInvite(target.transport, target.chatId);
  } catch (error) {
    writeTransportActionError(error, target.transport, context);
    return;
  }
  context.state.knownInvites.get(target.transport)?.delete(target.chatId);
  rememberTarget(context.state.knownTargets, target.transport, target.chatId);
  context.state.currentTarget = target;
  context.write(`Accepted ${target.transport} ${target.chatId}\n`);
}

async function rejectInvite(
  args: string[],
  context: ChatRuntime,
): Promise<void> {
  const { target, reason } = inviteActionArgs(args);

  if (!target) {
    context.write("Usage: /reject <transport> <invite> [reason]\n");
    return;
  }

  try {
    await context.client.rejectInvite(target.transport, target.chatId, reason);
  } catch (error) {
    writeTransportActionError(error, target.transport, context);
    return;
  }
  context.state.knownInvites.get(target.transport)?.delete(target.chatId);
  context.write(`Rejected ${target.transport} ${target.chatId}\n`);
}

function writeTransportActionError(
  error: unknown,
  transport: TransportName,
  context: ChatRuntime,
): void {
  if (error instanceof UnknownTransportError) {
    context.write(`Transport is not configured: ${error.transport}\n`);
    return;
  }
  if (error instanceof Error) {
    context.write(`${error.message}\n`);
    return;
  }
  context.write(`Transport action failed for ${transport}: ${String(error)}\n`);
}

function setTarget(args: string[], context: ChatRuntime): void {
  const [transport, chatId] = args;

  if (!isTransportName(transport) || !chatId) {
    context.write("Usage: /target <transport> <chatId>\n");
    return;
  }

  if (!context.client.configuredTransports().has(transport)) {
    context.write(`Transport is not configured: ${transport}\n`);
    return;
  }

  rememberTarget(context.state.knownTargets, transport, chatId);
  context.state.currentTarget = { transport, chatId };
  context.write(`Target set to ${transport} ${chatId}\n`);
}

async function leaveTarget(
  args: string[],
  context: ChatRuntime,
): Promise<void> {
  const { target, reason } = leaveArgs(args, context.state.currentTarget);

  if (!target) {
    context.write("Usage: /leave [transport] [chatId] [reason]\n");
    return;
  }

  try {
    await context.client.leaveChat(target.transport, target.chatId, reason);
  } catch (error) {
    writeTransportActionError(error, target.transport, context);
    return;
  }
  if (sameTarget(context.state.currentTarget, target)) {
    context.state.currentTarget = undefined;
  }
  context.write(`Left ${target.transport} ${target.chatId}\n`);
}

function commandCompletionValue(command: string): string {
  return command === "/target" ||
    command === "/accept" ||
    command === "/reject" ||
    command === "/leave"
    ? `${command} `
    : command;
}

function inviteActionArgs(args: string[]): {
  target: ChatTarget | undefined;
  reason?: string;
} {
  const [transport, inviteId, ...reasonParts] = args;

  if (!isTransportName(transport) || !inviteId) {
    return { target: undefined };
  }

  return {
    target: { transport, chatId: inviteId },
    ...optionalReason(reasonParts.join(" ")),
  };
}

function leaveArgs(
  args: string[],
  currentTarget: ChatTarget | undefined,
): { target: ChatTarget | undefined; reason?: string } {
  if (args.length === 0) {
    return { target: currentTarget };
  }

  const [transport, chatId, ...reasonParts] = args;

  if (isTransportName(transport) && chatId) {
    return {
      target: { transport, chatId },
      ...optionalReason(reasonParts.join(" ")),
    };
  }

  return {
    target: currentTarget,
    ...optionalReason(args.join(" ")),
  };
}

function optionalReason(reason: string): { reason?: string } {
  const parsed = stripWrappingQuotes(reason.trim());
  return parsed ? { reason: parsed } : {};
}

function stripWrappingQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1).trim();
  }

  return value;
}

function suggestionsFor(
  buffer: string,
  state: ChatState,
  client: GatewayClient,
): Suggestion[] {
  if (!buffer.startsWith("/")) {
    return [];
  }

  const hasTrailingSpace = /\s$/.test(buffer);
  const parts = buffer.split(/\s+/);
  const command = parts[0] ?? "";

  if (!hasTrailingSpace && parts.length === 1) {
    return SLASH_COMMANDS.filter((candidate) =>
      candidate.startsWith(command),
    ).map((candidate) => ({
      label: candidate,
      value: commandCompletionValue(candidate),
    }));
  }

  if (command === "/target") {
    return targetSuggestions(buffer, state, client);
  }

  if (command === "/leave") {
    return leaveSuggestions(buffer, state);
  }

  if (command === "/accept" || command === "/reject") {
    return inviteSuggestions(buffer, state, command);
  }

  return [];
}

function targetSuggestions(
  buffer: string,
  state: ChatState,
  client: GatewayClient,
): Suggestion[] {
  const args = commandArgs(buffer);
  const hasTrailingSpace = /\s$/.test(buffer);
  const [transport, chatIdPrefix = ""] = args;

  if (!transport || (args.length === 1 && !hasTrailingSpace)) {
    return [...client.configuredTransports()]
      .filter((candidate) => candidate.startsWith(transport ?? ""))
      .map((candidate) => ({
        label: candidate,
        value: `/target ${candidate} `,
      }));
  }

  if (!isTransportName(transport)) {
    return [];
  }

  return [...(state.knownTargets.get(transport) ?? new Map())]
    .filter(([chatId, displayName]) =>
      targetMatches(chatId, displayName, chatIdPrefix),
    )
    .map(([chatId, displayName]) => ({
      label: formatTargetLabel(chatId, displayName),
      value: `/target ${transport} ${chatId}`,
    }));
}

function leaveSuggestions(buffer: string, state: ChatState): Suggestion[] {
  const args = commandArgs(buffer);
  const [transportPrefix = "", chatIdPrefix = ""] = args;

  if (args.length <= 1 && !/\s$/.test(buffer)) {
    return [...state.knownTargets.keys()]
      .filter((transport) => transport.startsWith(transportPrefix))
      .map((transport) => ({
        label: transport,
        value: `/leave ${transport} `,
      }));
  }

  if (!isTransportName(transportPrefix)) {
    return currentTargetSuggestion(state);
  }

  return [...(state.knownTargets.get(transportPrefix) ?? new Map())]
    .filter(([chatId, displayName]) =>
      targetMatches(chatId, displayName, chatIdPrefix),
    )
    .map(([chatId, displayName]) => ({
      label: formatTargetLabel(chatId, displayName),
      value: `/leave ${transportPrefix} ${chatId}`,
    }));
}

function inviteSuggestions(
  buffer: string,
  state: ChatState,
  command: "/accept" | "/reject",
): Suggestion[] {
  const args = commandArgs(buffer);
  const [transportPrefix = "", invitePrefix = ""] = args;

  if (args.length <= 1 && !/\s$/.test(buffer)) {
    return [...state.knownInvites.entries()]
      .filter(([, invites]) => invites.size > 0)
      .map(([transport]) => transport)
      .filter((transport) => transport.startsWith(transportPrefix))
      .map((transport) => ({
        label: transport,
        value: `${command} ${transport} `,
      }));
  }

  if (!isTransportName(transportPrefix)) {
    return [];
  }

  return [...(state.knownInvites.get(transportPrefix) ?? new Map())]
    .filter(([inviteId, displayName]) =>
      targetMatches(inviteId, displayName, invitePrefix),
    )
    .map(([inviteId, displayName]) => ({
      label: formatTargetLabel(inviteId, displayName),
      value: `${command} ${transportPrefix} ${inviteId}`,
    }));
}

function targetMatches(
  chatId: string,
  displayName: string | undefined,
  prefix: string,
): boolean {
  return (
    chatId.startsWith(prefix) ||
    Boolean(displayName?.toLowerCase().startsWith(prefix.toLowerCase()))
  );
}

function formatTargetLabel(
  chatId: string,
  displayName: string | undefined,
): string {
  return displayName ? `${displayName} (${chatId})` : chatId;
}

function currentTargetSuggestion(state: ChatState): Suggestion[] {
  if (!state.currentTarget) {
    return [];
  }

  return [
    {
      label: `${state.currentTarget.transport} ${state.currentTarget.chatId}`,
      value: `/leave ${state.currentTarget.transport} ${state.currentTarget.chatId}`,
    },
  ];
}

function commandArgs(buffer: string): string[] {
  const [, ...args] = buffer.split(/\s+/);

  if (/\s$/.test(buffer)) {
    return [...args, ""];
  }

  return args;
}

function renderPrompt(
  output: Writable,
  target: ChatTarget | undefined,
  buffer: string,
  cursorIndex: number,
  suggestions: Suggestion[],
  selectedSuggestion: number,
  previousLineCount: number,
): number {
  clearPrompt(output, previousLineCount);
  const promptPrefix = `${formatPromptTarget(target)} > `;
  const prompt = `${promptPrefix}${buffer}`;
  output.write(prompt);

  if (suggestions.length === 0) {
    moveCursorToInputIndex(output, promptPrefix.length, cursorIndex);
    return 1;
  }

  for (const [index, suggestion] of suggestions.entries()) {
    output.write(
      `\n${index === selectedSuggestion ? ">" : " "} ${suggestion.label}`,
    );
  }
  output.write(`\x1b[${suggestions.length}A`);
  moveCursorToInputIndex(output, promptPrefix.length, cursorIndex);

  return 1 + suggestions.length;
}

function moveCursorToInputIndex(
  output: Writable,
  promptPrefixLength: number,
  cursorIndex: number,
): void {
  output.write("\r");
  const column = promptPrefixLength + cursorIndex;
  if (column > 0) {
    output.write(`\x1b[${column}C`);
  }
}

function stripBracketedPaste(value: string): string {
  return value.replaceAll("\u001b[200~", "").replaceAll("\u001b[201~", "");
}

function normalizePastedText(value: string): string {
  let normalized = "";
  let previousWasNewline = false;

  for (const character of value) {
    if (character === "\r" || character === "\n") {
      if (!previousWasNewline) {
        normalized += " ";
      }
      previousWasNewline = true;
      continue;
    }

    previousWasNewline = false;
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 32 || codePoint === 127) {
      continue;
    }
    normalized += character;
  }

  return normalized;
}

function previousWordStart(value: string, cursorIndex: number): number {
  let index = cursorIndex;
  while (index > 0 && /\s/.test(value[index - 1] ?? "")) {
    index -= 1;
  }
  while (index > 0 && !/\s/.test(value[index - 1] ?? "")) {
    index -= 1;
  }
  return index;
}

function clearPrompt(output: Writable, renderedLineCount: number): void {
  void renderedLineCount;
  output.write("\r");
  output.write("\x1b[2K");
  output.write("\x1b[J");
}

function wrapSuggestion(index: number, suggestions: Suggestion[]): number {
  if (suggestions.length === 0) {
    return 0;
  }

  return (index + suggestions.length) % suggestions.length;
}

function isPrintable(key: string): boolean {
  return key.length === 1 && key >= " " && key !== "\u007f";
}

function targetFromArgs(
  args: string[],
  currentTarget: ChatTarget | undefined,
): ChatTarget | undefined {
  if (args.length === 0) {
    return currentTarget;
  }

  const [transport, chatId] = args;
  if (!isTransportName(transport) || !chatId) {
    return undefined;
  }

  return { transport, chatId };
}

function sameTarget(
  left: ChatTarget | undefined,
  right: ChatTarget | undefined,
): boolean {
  return Boolean(
    left &&
      right &&
      left.transport === right.transport &&
      left.chatId === right.chatId,
  );
}

async function writeStatus(context: ChatRuntime): Promise<void> {
  await context.client.send({ type: "status" });
  await rememberListedInvites(
    context.client,
    context.state,
    context.writeError,
  );
  const transports = [...context.client.configuredTransports()].join(", ");
  const target = context.state.currentTarget
    ? `${context.state.currentTarget.transport} ${context.state.currentTarget.chatId}`
    : "none";
  const knownTargetCount = [...context.state.knownTargets.values()].reduce(
    (count, chatIds) => count + chatIds.size,
    0,
  );
  const pendingInviteCount = [...context.state.knownInvites.values()].reduce(
    (count, invites) => count + invites.size,
    0,
  );

  context.write(`Target: ${target}\n`);
  context.write(`Transports: ${transports || "none"}\n`);
  context.write(`Known targets: ${knownTargetCount}\n`);
  context.write(`Pending invites: ${pendingInviteCount}\n`);
  await writeTransportHealth(context, {
    includeDetails: true,
    onlyProblems: false,
  });
}

async function writeTransportHealth(
  context: ChatRuntime,
  opts: { includeDetails: boolean; onlyProblems: boolean },
): Promise<void> {
  for (const transport of context.client.configuredTransports()) {
    let checks: TransportHealth[];
    try {
      checks = await context.client.health(transport);
    } catch (error) {
      context.writeError(
        `Could not read health for ${transport}: ${String(error)}\n`,
      );
      continue;
    }

    for (const check of checks) {
      if (opts.onlyProblems && check.status === "ready") {
        continue;
      }
      context.write(
        `${transport} ${check.category}: ${check.status}, ${check.summary}\n`,
      );
      if (opts.includeDetails) {
        for (const detail of check.details ?? []) {
          context.write(`  - ${detail}\n`);
        }
      }
    }
  }
}

function rememberTarget(
  knownTargets: Map<TransportName, Map<string, string | undefined>>,
  transport: TransportName,
  chatId: string,
  displayName?: string,
): void {
  let chats = knownTargets.get(transport);
  if (!chats) {
    chats = new Map();
    knownTargets.set(transport, chats);
  }

  chats.set(chatId, displayName ?? chats.get(chatId));
}

function formatPromptTarget(target: ChatTarget | undefined): string {
  return target ? `[${target.transport} ${target.chatId}]` : "[no target]";
}

function formatSender(message: { username?: string; userId?: string }): string {
  return message.username ?? message.userId ?? "unknown";
}

function isInteractiveTerminal(
  input: Readable,
  output: Writable,
): input is TtyInput {
  return (
    "isTTY" in input &&
    input.isTTY === true &&
    "isTTY" in output &&
    output.isTTY === true
  );
}
