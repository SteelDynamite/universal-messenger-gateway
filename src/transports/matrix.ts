import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { TransportConfig } from "../config.js";
import type { MessageReference } from "../protocol.js";
import type { TransportProvider } from "./interface.js";
import {
  type MautrixMatrixConfig,
  MautrixMatrixDecryptionError,
  MautrixMatrixProvider,
} from "./matrix-mautrix.js";

export type MatrixTransportConfig = MautrixMatrixConfig & {
  selfCrossSign?: boolean | "reset";
  accountPassword?: string;
  recoveryKey?: string;
};

type MatrixLogger = {
  info(module: string, ...args: unknown[]): void;
  warn(module: string, ...args: unknown[]): void;
  debug(module: string, ...args: unknown[]): void;
  trace(module: string, ...args: unknown[]): void;
  error(module: string, ...args: unknown[]): void;
};

export class MatrixConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MatrixConfigError";
  }
}

export const MatrixDecryptionError = MautrixMatrixDecryptionError;
export type MatrixDecryptionError = MautrixMatrixDecryptionError;

export class MatrixProvider extends MautrixMatrixProvider {
  constructor(config: MatrixTransportConfig, stateDir: string) {
    super(
      {
        ...config,
        ...(config.pythonPath
          ? {}
          : process.env.UMG_MATRIX_MAUTRIX_PYTHON
            ? { pythonPath: process.env.UMG_MATRIX_MAUTRIX_PYTHON }
            : {}),
      },
      stateDir,
    );
  }
}

type MatrixEventContent = {
  msgtype?: string;
  body?: string;
  url?: string;
  file?: { url?: string };
  info?: {
    mimetype?: string;
    size?: number;
  };
  format?: unknown;
  formatted_body?: unknown;
  "m.relates_to"?: {
    "m.in_reply_to"?: {
      event_id?: unknown;
    };
    event_id?: unknown;
    is_falling_back?: unknown;
    key?: unknown;
    rel_type?: unknown;
  };
};

export function messageReferences(
  roomId: string,
  content: MatrixEventContent | undefined,
  transport: "matrix",
): { replyTo?: MessageReference; threadTo?: MessageReference } {
  const relatesTo = content?.["m.relates_to"];
  const threadRootId =
    relatesTo?.rel_type === "m.thread" && typeof relatesTo.event_id === "string"
      ? relatesTo.event_id
      : undefined;
  const replyEventId = relatesTo?.["m.in_reply_to"]?.event_id;
  const replyIsThreadFallback =
    threadRootId !== undefined && relatesTo?.is_falling_back === true;

  return {
    ...(typeof replyEventId === "string" && !replyIsThreadFallback
      ? { replyTo: { transport, chatId: roomId, messageId: replyEventId } }
      : {}),
    ...(threadRootId
      ? { threadTo: { transport, chatId: roomId, messageId: threadRootId } }
      : {}),
  };
}

export function matrixRelatesTo(
  chatId: string,
  transport: "matrix",
  replyTo?: MessageReference,
  threadTo?: MessageReference,
): MatrixEventContent["m.relates_to"] | undefined {
  const validReplyTo =
    replyTo?.transport === transport && replyTo.chatId === chatId
      ? replyTo
      : undefined;
  const validThreadTo =
    threadTo?.transport === transport && threadTo.chatId === chatId
      ? threadTo
      : undefined;

  if (validThreadTo) {
    return {
      rel_type: "m.thread",
      event_id: validThreadTo.messageId,
      "m.in_reply_to": {
        event_id: validReplyTo?.messageId ?? validThreadTo.messageId,
      },
      ...(validReplyTo ? {} : { is_falling_back: true }),
    };
  }

  return validReplyTo
    ? {
        "m.in_reply_to": { event_id: validReplyTo.messageId },
      }
    : undefined;
}

export function createMatrixProvider(
  config: TransportConfig,
  context: { stateDir: string },
): TransportProvider {
  const implementation =
    config.settings?.implementation ?? config.settings?.adapter;
  if (
    implementation !== undefined &&
    implementation !== "mautrix" &&
    implementation !== "sidecar"
  ) {
    throw new MatrixConfigError(
      `Unsupported Matrix implementation: ${String(implementation)}`,
    );
  }

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
  if (typeof settings.accessToken === "string" && settings.accessToken) {
    throw new MatrixConfigError(
      "Matrix settings.accessToken is not supported; store the token in state/matrix-access-token.txt with chmod 600",
    );
  }
  const accessToken = readAccessToken(stateDir);

  if (typeof homeserverUrl !== "string" || !homeserverUrl) {
    throw new MatrixConfigError("Matrix settings.homeserverUrl is required");
  }
  if (!accessToken) {
    throw new MatrixConfigError(
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

function readAccessToken(stateDir?: string): string | undefined {
  return readSecretFile(stateDir, "matrix-access-token.txt");
}

function readSecretFile(
  stateDir: string | undefined,
  fileName: string,
): string | undefined {
  if (!stateDir) return undefined;
  const filePath = join(stateDir, fileName);
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

export function createMatrixLogger(
  output: Pick<NodeJS.WritableStream, "write"> = process.stderr,
): MatrixLogger {
  const write = (level: string, module: string, ...args: unknown[]) => {
    output.write(
      `${new Date().toUTCString()} [${level}] [${module}] ${args.map(formatLogArg).join(" ")}\n`,
    );
  };
  return {
    info: (module, ...args) => write("INFO", module, ...args),
    warn: (module, ...args) => write("WARN", module, ...args),
    debug: (module, ...args) => write("DEBUG", module, ...args),
    trace: (module, ...args) => write("TRACE", module, ...args),
    error: (module, ...args) => write("ERROR", module, ...args),
  };
}

export function createSyncFilterLogger(
  defaultLogger: MatrixLogger,
): MatrixLogger {
  return {
    info: (module, ...args) => defaultLogger.info(module, ...args),
    warn: (module, ...args) => defaultLogger.warn(module, ...args),
    debug: (module, ...args) => defaultLogger.debug(module, ...args),
    trace: (module, ...args) => defaultLogger.trace(module, ...args),
    error: (module, ...args) => {
      const message = args.map(formatLogArg).join(" ");
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

function formatLogArg(arg: unknown): string {
  if (typeof arg === "string") {
    return arg;
  }
  if (arg instanceof Error) {
    return arg.stack ?? arg.message;
  }
  try {
    return JSON.stringify(arg) ?? String(arg);
  } catch {
    return String(arg);
  }
}
