import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  type GatewayEvent,
  createGateway,
  loadGatewayConfig,
} from "../src/index.js";

const originalCwd = process.cwd();

afterEach(() => {
  process.chdir(originalCwd);
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
