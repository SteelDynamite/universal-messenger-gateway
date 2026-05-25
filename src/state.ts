import { resolve } from "node:path";

export const STATE_DIR_ENV = "UNIVERSAL_MESSENGER_GATEWAY_STATE_DIR";

export function resolveStateDir(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): string {
  return resolve(cwd, env[STATE_DIR_ENV] ?? "state");
}
