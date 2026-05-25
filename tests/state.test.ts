import { expect, test } from "vitest";
import { STATE_DIR_ENV, resolveStateDir } from "../src/index.js";

test("defaults state to ./state under the current working directory", () => {
  expect(resolveStateDir({}, "/repo")).toBe("/repo/state");
});

test("allows the state dir to be overridden by environment", () => {
  expect(resolveStateDir({ [STATE_DIR_ENV]: "/tmp/umg-state" }, "/repo")).toBe(
    "/tmp/umg-state",
  );
});
