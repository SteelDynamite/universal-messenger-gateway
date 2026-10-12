import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  type GatewayEvent,
  ManagerGatewayClient,
  TransportManager,
  createGateway,
  loadGatewayConfig,
} from "../src/index.js";

const originalCwd = process.cwd();

afterEach(() => {
  process.chdir(originalCwd);
  vi.unstubAllEnvs();
});

test("createGateway resolves the default state dir and creates a manager", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "umg-sdk-cwd-"));
  process.chdir(cwd);

  const gateway = await createGateway();

  expect(gateway.configuredTransports()).toEqual(new Set());
});

test("createGateway uses the provided state dir for admin configure reloads", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "umg-sdk-state-"));
  const gateway = await createGateway({ stateDir });
  const events: GatewayEvent[] = [];
  gateway.onEvent((event) => events.push(event));

  await gateway.send({
    type: "configure_transport",
    transport: "matrix",
    enabled: false,
    settings: { homeserverUrl: "https://matrix.example" },
  });

  await expect(loadGatewayConfig(stateDir)).resolves.toEqual({
    transports: {
      matrix: {
        enabled: false,
        settings: { homeserverUrl: "https://matrix.example" },
      },
    },
  });
  expect(events.at(-1)).toMatchObject({
    type: "admin_result",
    command: "configure_transport",
    ok: true,
  });
});

test("createGateway uses the provided state dir for connect and disconnect admin reloads", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "umg-sdk-state-"));
  const gateway = await createGateway({ stateDir });
  const events: GatewayEvent[] = [];
  gateway.onEvent((event) => events.push(event));

  await gateway.send({ type: "disconnect_transport", transport: "matrix" });
  expect(await loadGatewayConfig(stateDir)).toEqual({
    transports: { matrix: { enabled: false } },
  });
  expect(events.at(-1)).toMatchObject({ ok: true });

  await gateway.send({ type: "connect_transport", transport: "matrix" });
  expect(await loadGatewayConfig(stateDir)).toEqual({
    transports: { matrix: { enabled: true } },
  });
  expect(events.at(-1)).toMatchObject({
    type: "admin_result",
    command: "connect_transport",
    ok: false,
  });
  expect(events.at(-1)).toHaveProperty(
    "output",
    expect.stringContaining("could not be applied"),
  );
});

test("manager client admin commands stay inside its configured state directory", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "umg-client-state-"));
  const otherStateDir = await mkdtemp(join(tmpdir(), "umg-other-state-"));
  vi.stubEnv("UNIVERSAL_MESSENGER_GATEWAY_STATE_DIR", otherStateDir);
  const client = new ManagerGatewayClient({
    manager: new TransportManager(),
    stateDir,
  });
  const events: GatewayEvent[] = [];
  client.onEvent((event) => events.push(event));

  await client.send({
    type: "configure_transport",
    transport: "matrix",
    enabled: false,
    settings: { accessToken: "test-secret" },
  });
  await client.send({ type: "status" });
  expect(events).toHaveLength(2);
  expect(events[0]).toMatchObject({ ok: true });
  expect(events[1]).toMatchObject({
    ok: true,
    output: expect.stringContaining(`State: ${stateDir}`),
  });
  expect(await loadGatewayConfig(stateDir)).toEqual({
    transports: { matrix: { enabled: false } },
  });
  expect(
    await readFile(join(stateDir, "matrix-access-token.txt"), "utf8"),
  ).toContain("test-secret");
  await expect(
    readFile(join(otherStateDir, "config.json")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  await expect(
    readFile(join(otherStateDir, "matrix-access-token.txt")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

test("gateway event subscriptions return idempotent unsubscribe functions", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "umg-sdk-state-"));
  const gateway = await createGateway({ stateDir });
  const events: GatewayEvent[] = [];
  const unsubscribe = gateway.onEvent((event) => events.push(event));

  await gateway.send({ type: "status" });
  unsubscribe();
  unsubscribe();
  await gateway.send({ type: "status" });

  expect(events).toHaveLength(1);
  expect(
    await readFile(join(stateDir, "config.json"), "utf8").catch(() => ""),
  ).toBe("");
});
