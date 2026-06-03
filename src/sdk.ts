import { runAdminCli } from "./admin.js";
import { loadGatewayConfig } from "./config.js";
import { type GatewayClient, ManagerGatewayClient } from "./gateway-client.js";
import { createConfiguredTransportList } from "./runtime.js";
import { STATE_DIR_ENV, resolveStateDir } from "./state.js";
import { TransportManager } from "./transports/manager.js";

export type CreateGatewayOptions = {
  stateDir?: string;
};

export type Gateway = GatewayClient;

export async function createGateway(
  options: CreateGatewayOptions = {},
): Promise<Gateway> {
  const stateDir = options.stateDir ?? resolveStateDir();
  const config = await loadGatewayConfig(stateDir);
  const manager = new TransportManager(
    await createConfiguredTransportList(config, stateDir),
  );

  return new ManagerGatewayClient({
    manager,
    stateDir,
    async reloadTransports() {
      const updatedConfig = await loadGatewayConfig(stateDir);
      await manager.replaceTransports(
        await createConfiguredTransportList(updatedConfig, stateDir),
      );
      await manager.connectAll();
    },
    async runAdminCommand(args, output, errorOutput) {
      return runAdminCli({
        args,
        output,
        errorOutput,
        env: { ...process.env, [STATE_DIR_ENV]: stateDir },
      });
    },
  });
}
