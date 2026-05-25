import { expect, test } from "vitest";
import {
  MatrixConfigError,
  MatrixProvider,
  createConfiguredTransports,
  parseMatrixConfig,
} from "../src/index.js";

test("parses Matrix transport settings", () => {
  expect(
    parseMatrixConfig({
      enabled: true,
      settings: {
        homeserverUrl: "https://matrix.example",
        accessToken: "token",
        encryption: true,
        selfCrossSign: "reset",
      },
    }),
  ).toEqual({
    homeserverUrl: "https://matrix.example",
    accessToken: "token",
    encryption: true,
    selfCrossSign: "reset",
  });
});

test("rejects Matrix config without homeserver or token", () => {
  expect(() => parseMatrixConfig({ enabled: true, settings: {} })).toThrow(
    MatrixConfigError,
  );
  expect(() =>
    parseMatrixConfig({
      enabled: true,
      settings: { homeserverUrl: "https://matrix.example" },
    }),
  ).toThrow(MatrixConfigError);
});

test("default registry creates Matrix transport", () => {
  const transports = createConfiguredTransports(
    {
      transports: {
        matrix: {
          enabled: true,
          settings: {
            homeserverUrl: "https://matrix.example",
            accessToken: "token",
          },
        },
      },
    },
    { stateDir: "/state" },
  );

  expect(transports).toHaveLength(1);
  expect(transports[0]).toBeInstanceOf(MatrixProvider);
});
