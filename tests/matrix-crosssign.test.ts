import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  readAccessToken,
  readAccountPassword,
  readRecoveryKey,
} from "../src/transports/matrix-crosssign.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
  tempDirs.length = 0;
});

test("reads Matrix secrets from state files", async () => {
  const stateDir = await tempStateDir();
  await writeFile(join(stateDir, "matrix-access-token.txt"), "access-token\n");
  await writeFile(join(stateDir, "matrix-recovery-key.txt"), "recovery-key\n");
  await writeFile(join(stateDir, "matrix-password.txt"), "password\n");
  await chmod(join(stateDir, "matrix-access-token.txt"), 0o600);
  await chmod(join(stateDir, "matrix-recovery-key.txt"), 0o600);
  await chmod(join(stateDir, "matrix-password.txt"), 0o600);

  expect(readAccessToken(stateDir)).toBe("access-token");
  expect(readRecoveryKey(stateDir)).toBe("recovery-key");
  expect(readAccountPassword(stateDir)).toBe("password");
});

test("refuses Matrix secret files with group or world permissions", async () => {
  const stateDir = await tempStateDir();
  await writeFile(join(stateDir, "matrix-recovery-key.txt"), "recovery-key\n");
  await chmod(join(stateDir, "matrix-recovery-key.txt"), 0o644);

  expect(readRecoveryKey(stateDir)).toBeUndefined();
});

async function tempStateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "umg-matrix-secrets-"));
  tempDirs.push(dir);
  return dir;
}
