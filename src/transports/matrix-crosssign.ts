import * as fs from "node:fs";
import * as path from "node:path";
import {
  SecretStorageItems,
  SecretStorageKey,
} from "@matrix-org/matrix-sdk-crypto-nodejs";
import type { MatrixClient } from "matrix-bot-sdk";
import { RustEngine } from "matrix-bot-sdk/lib/e2ee/RustEngine.js";

type MatrixMachine = {
  bootstrapCrossSigning(reset: boolean): Promise<BootstrapRequests>;
  crossSigningStatus(): Promise<CrossSigningStatus>;
  deviceId?: { toString(): string };
  importSecretsFromSecretStorage(
    key: SecretStorageKey,
    items: SecretStorageItems,
  ): Promise<OutgoingRequest | undefined>;
  markRequestAsSent(id: string, type: number, response: string): Promise<void>;
  outgoingRequests(): Promise<OutgoingRequest[]>;
};

(function patchRustEngineForNewBindings() {
  const proto = (
    RustEngine as unknown as { prototype?: Record<string, unknown> }
  ).prototype;
  if (!proto || proto.__umgXsignPatched) {
    return;
  }

  proto.processToDeviceRequest =
    async function processToDeviceRequest(request: {
      body?: string;
      eventType?: string;
      event_type?: string;
      txnId?: string;
      txn_id?: string;
    }) {
      const body = request.body ? JSON.parse(request.body) : {};
      const txnId = request.txnId ?? request.txn_id ?? body.txn_id;
      const eventType =
        request.eventType ?? request.event_type ?? body.event_type;
      await (
        this as {
          actuallyProcessToDeviceRequest(...args: unknown[]): Promise<void>;
        }
      ).actuallyProcessToDeviceRequest(txnId, eventType, body.messages);
    };
  proto.__umgXsignPatched = true;
})();

export type CrossSignOptions = {
  password?: string;
  recoveryKey?: string;
  reset?: boolean;
  log?: (message: string) => void;
  warn?: (message: string) => void;
};

type CrossSigningStatus = {
  hasMaster: boolean;
  hasSelfSigning: boolean;
  hasUserSigning: boolean;
};

type OutgoingRequest = {
  id: string;
  type: number;
  body: string;
  eventType?: string;
  txnId?: string;
};

type BootstrapRequests = {
  uploadKeysReq?: OutgoingRequest;
  uploadSigningKeysReq: string;
  uploadSignaturesReq: OutgoingRequest;
};

const REQ_KEYS_UPLOAD = 0;
const REQ_KEYS_QUERY = 1;
const REQ_KEYS_CLAIM = 2;
const REQ_TO_DEVICE = 3;
const REQ_SIGNATURE_UPLOAD = 4;
const REQ_ROOM_MESSAGE = 5;
const REQ_KEYS_BACKUP = 6;

const REQ_NAME: Record<number, string> = {
  [REQ_KEYS_UPLOAD]: "KeysUpload",
  [REQ_KEYS_QUERY]: "KeysQuery",
  [REQ_KEYS_CLAIM]: "KeysClaim",
  [REQ_TO_DEVICE]: "ToDevice",
  [REQ_SIGNATURE_UPLOAD]: "SignatureUpload",
  [REQ_ROOM_MESSAGE]: "RoomMessage",
  [REQ_KEYS_BACKUP]: "KeysBackup",
};

export function readAccessToken(stateDir?: string): string | undefined {
  return readSecret(
    "UNIVERSAL_MESSENGER_GATEWAY_MATRIX_ACCESS_TOKEN",
    "UNIVERSAL_MESSENGER_GATEWAY_MATRIX_ACCESS_TOKEN_FILE",
    stateDir ? path.join(stateDir, "matrix-access-token.txt") : undefined,
    "access token",
  );
}

export function readAccountPassword(stateDir?: string): string | undefined {
  return readSecret(
    "UNIVERSAL_MESSENGER_GATEWAY_MATRIX_ACCOUNT_PASSWORD",
    "UNIVERSAL_MESSENGER_GATEWAY_MATRIX_PASSWORD_FILE",
    stateDir ? path.join(stateDir, "matrix-password.txt") : undefined,
    "password",
  );
}

export function readRecoveryKey(stateDir?: string): string | undefined {
  return readSecret(
    "UNIVERSAL_MESSENGER_GATEWAY_MATRIX_RECOVERY_KEY",
    "UNIVERSAL_MESSENGER_GATEWAY_MATRIX_RECOVERY_KEY_FILE",
    stateDir ? path.join(stateDir, "matrix-recovery-key.txt") : undefined,
    "recovery key",
  );
}

export async function ensureSelfCrossSigned(
  client: MatrixClient,
  opts: CrossSignOptions = {},
): Promise<{
  status: "skipped" | "already" | "bootstrapped";
  reason?: string;
}> {
  const log = opts.log ?? ((message) => console.log(message));
  const warn = opts.warn ?? ((message) => console.warn(message));
  const machine = (
    client as unknown as { crypto?: { engine?: { machine?: MatrixMachine } } }
  ).crypto?.engine?.machine;

  if (!machine) {
    return {
      status: "skipped",
      reason: "no OlmMachine on client (crypto disabled?)",
    };
  }

  const botUserId = await client.getUserId();

  if (opts.recoveryKey) {
    log("[Matrix xsign] importing existing cross-signing identity from SSSS");
    await importViaRecoveryKey(
      client,
      machine,
      botUserId,
      opts.recoveryKey,
      log,
      warn,
    );
    return { status: "bootstrapped" };
  }

  const status = await machine.crossSigningStatus();
  const alreadyHasIdentity =
    status.hasMaster && status.hasSelfSigning && status.hasUserSigning;

  if (!alreadyHasIdentity && !opts.reset) {
    const reason = "no recoveryKey on disk and reset not explicitly requested";
    warn(
      `[Matrix xsign] refusing to generate a fresh cross-signing identity: ${reason}`,
    );
    return { status: "skipped", reason };
  }

  if (
    alreadyHasIdentity &&
    !opts.reset &&
    (await isDeviceCrossSigned(client, botUserId))
  ) {
    log("[Matrix xsign] device already cross-signed");
    return { status: "already" };
  }

  const bootstrap = await machine.bootstrapCrossSigning(opts.reset ?? false);
  if (!bootstrap?.uploadSigningKeysReq) {
    return {
      status: "skipped",
      reason: "crypto binding returned no cross-sign requests",
    };
  }

  if (bootstrap.uploadKeysReq) {
    const response = await client.doRequest(
      "POST",
      "/_matrix/client/v3/keys/upload",
      undefined,
      JSON.parse(bootstrap.uploadKeysReq.body),
    );
    await machine.markRequestAsSent(
      bootstrap.uploadKeysReq.id,
      REQ_KEYS_UPLOAD,
      JSON.stringify(response ?? {}),
    );
  }

  await postWithUia(
    client,
    "/_matrix/client/v3/keys/device_signing/upload",
    JSON.parse(bootstrap.uploadSigningKeysReq),
    opts.password,
    log,
  );

  const rawSignatureBody = JSON.parse(bootstrap.uploadSignaturesReq.body);
  const signatureBody = rawSignatureBody.signed_keys ?? rawSignatureBody;
  const signatureResponse = await client.doRequest(
    "POST",
    "/_matrix/client/v3/keys/signatures/upload",
    undefined,
    signatureBody,
  );
  await machine.markRequestAsSent(
    bootstrap.uploadSignaturesReq.id,
    REQ_SIGNATURE_UPLOAD,
    JSON.stringify(signatureResponse ?? {}),
  );

  await drainOutgoingRequests(client, machine, opts.password, log, warn);
  return { status: "bootstrapped" };
}

function readSecret(
  envVar: string,
  fileEnvVar: string,
  defaultPath: string | undefined,
  label: string,
): string | undefined {
  const direct = process.env[envVar];
  if (direct?.trim()) {
    return direct.trim();
  }

  const filePath = process.env[fileEnvVar] || defaultPath;
  if (!filePath) {
    return undefined;
  }

  if (!fs.existsSync(filePath)) {
    return undefined;
  }

  try {
    const mode = fs.statSync(filePath).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      console.warn(
        `[Matrix xsign] ${label} file ${filePath} has insecure perms ${mode.toString(8)}`,
      );
      return undefined;
    }

    return fs.readFileSync(filePath, "utf8").trim() || undefined;
  } catch (error) {
    console.warn(
      `[Matrix xsign] could not read ${label} file ${filePath}: ${(error as Error).message}`,
    );
    return undefined;
  }
}

async function importViaRecoveryKey(
  client: MatrixClient,
  machine: MatrixMachine,
  botUserId: string,
  recoveryKey: string,
  log: (message: string) => void,
  warn: (message: string) => void,
): Promise<void> {
  const userPath = encodeURIComponent(botUserId);
  const defaultKey = await client.doRequest(
    "GET",
    `/_matrix/client/v3/user/${userPath}/account_data/m.secret_storage.default_key`,
  );
  const keyId = defaultKey?.key;
  if (!keyId) {
    throw new Error(
      "m.secret_storage.default_key is present but has no .key field",
    );
  }

  const keyEventType = `m.secret_storage.key.${keyId}`;
  const keyContent = await client.doRequest(
    "GET",
    `/_matrix/client/v3/user/${userPath}/account_data/${encodeURIComponent(keyEventType)}`,
  );
  const secretStorageKey = SecretStorageKey.fromAccountData(
    recoveryKey,
    keyEventType,
    JSON.stringify(keyContent),
  );

  const fetchSecret = (name: string) =>
    client.doRequest(
      "GET",
      `/_matrix/client/v3/user/${userPath}/account_data/${encodeURIComponent(name)}`,
    );

  const items = new SecretStorageItems({
    masterKey: JSON.stringify(await fetchSecret("m.cross_signing.master")),
    selfSigningKey: JSON.stringify(
      await fetchSecret("m.cross_signing.self_signing"),
    ),
    userSigningKey: JSON.stringify(
      await fetchSecret("m.cross_signing.user_signing"),
    ),
  });

  const signatureRequest = await machine.importSecretsFromSecretStorage(
    secretStorageKey,
    items,
  );
  log("[Matrix xsign] imported cross-signing secrets from SSSS");

  if (signatureRequest?.body) {
    const rawBody = JSON.parse(signatureRequest.body);
    const body = rawBody.signed_keys ?? rawBody;
    const response = await client.doRequest(
      "POST",
      "/_matrix/client/v3/keys/signatures/upload",
      undefined,
      body,
    );
    await machine.markRequestAsSent(
      signatureRequest.id,
      REQ_SIGNATURE_UPLOAD,
      JSON.stringify(response ?? {}),
    );
  } else {
    warn(
      "[Matrix xsign] import returned no signature request; device may already be signed",
    );
  }

  await drainOutgoingRequests(client, machine, undefined, log, warn);
}

async function isDeviceCrossSigned(
  client: MatrixClient,
  botUserId: string,
): Promise<boolean> {
  const machine = (
    client as unknown as { crypto?: { engine?: { machine?: MatrixMachine } } }
  ).crypto?.engine?.machine;
  const deviceId = machine?.deviceId?.toString() ?? "";
  if (!deviceId) {
    return false;
  }

  try {
    const response = await client.doRequest(
      "POST",
      "/_matrix/client/v3/keys/query",
      undefined,
      {
        device_keys: { [botUserId]: [] },
        timeout: 5000,
      },
    );
    const selfSigningKeys = response?.self_signing_keys?.[botUserId];
    const selfSigningKeyId = selfSigningKeys?.keys
      ? Object.keys(selfSigningKeys.keys)[0]
      : undefined;
    const signatures =
      response?.device_keys?.[botUserId]?.[deviceId]?.signatures?.[botUserId];

    return Boolean(selfSigningKeyId && signatures?.[selfSigningKeyId]);
  } catch {
    return false;
  }
}

async function drainOutgoingRequests(
  client: MatrixClient,
  machine: MatrixMachine,
  password: string | undefined,
  log: (message: string) => void,
  warn: (message: string) => void,
): Promise<number> {
  let handled = 0;

  for (let iter = 0; iter < 20; iter += 1) {
    const requests = await machine.outgoingRequests();
    if (!requests.length) {
      break;
    }

    for (const request of requests) {
      try {
        const response = await dispatch(client, request, password, log);
        await machine.markRequestAsSent(
          request.id,
          request.type,
          JSON.stringify(response ?? {}),
        );
        handled += 1;
        log(`[Matrix xsign] sent ${REQ_NAME[request.type] ?? request.type}`);
      } catch (error) {
        warn(`[Matrix xsign] request failed: ${(error as Error).message}`);
        return handled;
      }
    }
  }

  return handled;
}

async function dispatch(
  client: MatrixClient,
  request: OutgoingRequest,
  password: string | undefined,
  log: (message: string) => void,
): Promise<unknown> {
  const body = request.body ? JSON.parse(request.body) : {};

  switch (request.type) {
    case REQ_KEYS_UPLOAD:
      return postWithUia(
        client,
        "/_matrix/client/v3/keys/upload",
        body,
        password,
        log,
      );
    case REQ_KEYS_QUERY:
      return client.doRequest(
        "POST",
        "/_matrix/client/v3/keys/query",
        undefined,
        body,
      );
    case REQ_KEYS_CLAIM:
      return client.doRequest(
        "POST",
        "/_matrix/client/v3/keys/claim",
        undefined,
        body,
      );
    case REQ_TO_DEVICE:
      return client.doRequest(
        "PUT",
        `/_matrix/client/v3/sendToDevice/${encodeURIComponent(request.eventType ?? "m.room.encrypted")}/${encodeURIComponent(request.txnId ?? `xsign-${Date.now()}-${request.id.slice(0, 6)}`)}`,
        undefined,
        body,
      );
    case REQ_SIGNATURE_UPLOAD:
      return client.doRequest(
        "POST",
        "/_matrix/client/v3/keys/signatures/upload",
        undefined,
        body,
      );
    case REQ_ROOM_MESSAGE:
      throw new Error(
        "RoomMessage request unexpected during cross-signing drain",
      );
    case REQ_KEYS_BACKUP:
      throw new Error(
        "KeysBackup request unexpected during cross-signing drain",
      );
    default:
      throw new Error(`Unknown request type ${request.type}`);
  }
}

async function postWithUia(
  client: MatrixClient,
  endpoint: string,
  body: unknown,
  password: string | undefined,
  log: (message: string) => void,
): Promise<unknown> {
  try {
    return await client.doRequest("POST", endpoint, undefined, body);
  } catch (error) {
    const err = error as {
      statusCode?: number;
      body?: { flows?: Array<{ stages?: string[] }>; session?: string };
    };
    const flows = err.body?.flows;
    if (err.statusCode !== 401 || !Array.isArray(flows)) {
      throw error;
    }
    if (!password) {
      throw new Error(
        "UIA required but no Matrix account password is available",
      );
    }
    if (!flows.some((flow) => flow.stages?.includes("m.login.password"))) {
      throw new Error(
        `UIA required but m.login.password was not offered: ${JSON.stringify(flows)}`,
      );
    }

    log(`[Matrix xsign] UIA required on ${endpoint}; retrying with password`);
    return client.doRequest("POST", endpoint, undefined, {
      ...(body as Record<string, unknown>),
      auth: {
        type: "m.login.password",
        identifier: { type: "m.id.user", user: await client.getUserId() },
        password,
        session: err.body?.session,
      },
    });
  }
}
