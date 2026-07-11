import { expect, test } from "vitest";
import type { TransportProvider } from "../src/index.js";
import {
  UnavailableTransportError,
  createConfiguredTransports,
} from "../src/index.js";

test("creates enabled transports from the registry", () => {
  const transports = createConfiguredTransports(
    {
      transports: {
        matrix: { enabled: true, settings: { homeserverUrl: "https://m" } },
        slack: { enabled: false },
      },
    },
    {
      stateDir: "/state",
    },
    {
      matrix: (config) => new FakeTransport("matrix", config.settings),
      slack: (config) => new FakeTransport("slack", config.settings),
    },
  );

  expect(transports).toHaveLength(1);
  expect(transports[0]?.type).toBe("matrix");
});

test("rejects enabled transports absent from the build registry", () => {
  expect(() =>
    createConfiguredTransports(
      { transports: { matrix: { enabled: true } } },
      { stateDir: "/state" },
      {},
    ),
  ).toThrow(UnavailableTransportError);
});

class FakeTransport implements TransportProvider {
  isConnected = false;

  constructor(
    readonly type: TransportProvider["type"],
    readonly settings: unknown,
  ) {}

  async connect(): Promise<void> {
    this.isConnected = true;
  }

  async disconnect(): Promise<void> {
    this.isConnected = false;
  }

  async sendMessage(): Promise<void> {}

  async setTyping(): Promise<void> {}

  onMessage(): void {}

  onError(): void {}
}
