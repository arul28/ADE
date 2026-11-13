import type { CloudDesktopBridge } from "../../../../desktop/src/main/services/adeCloud/cloudAgentActions";
import { createDesktopBridgeConnection } from "./desktopBridgeConnection";

/**
 * cloud machine making as the runtime daemon reaches it: create, copy and
 * move sign the new machine in through the desktop app's approval window, so
 * the brain asks the desktop attached to it over the bridge socket. A lane
 * launch the brain runs itself borrows only the window (`approveWindow`).
 */

export const CLOUD_BRIDGE_PREFIX = "cloud.";
export const CLOUD_BRIDGE_METHODS = ["create", "copy", "move", "approveWindow", "closeApprovalWindow"] as const;
export type CloudBridgeMethod = (typeof CLOUD_BRIDGE_METHODS)[number];

export function isCloudBridgeMethod(name: string): name is CloudBridgeMethod {
  return (CLOUD_BRIDGE_METHODS as readonly string[]).includes(name);
}

export const CLOUD_NO_DESKTOP = "Making a machine signs it in through the ADE desktop app, and none is attached to this ADE.";

/** Longer than the desktop's own deadlines (a create's join, a fork, a move's copy), so its clearer error arrives first. */
const CREATE_TIMEOUT_MS = 10 * 60_000;
const COPY_TIMEOUT_MS = 25 * 60_000;
const MOVE_TIMEOUT_MS = 60 * 60_000;
/** The desktop's window gives up after 5 minutes; this covers it. */
const APPROVE_WINDOW_TIMEOUT_MS = 6 * 60_000;

export function createCloudDesktopBridgeClient(args: { socketPath: string }): CloudDesktopBridge & { dispose(): void } {
  const connection = createDesktopBridgeConnection({
    ...args,
    unavailableMessage: CLOUD_NO_DESKTOP,
    closedMessage: "The ADE Cloud bridge was disposed.",
  });
  return {
    create: (input) => connection.request(`${CLOUD_BRIDGE_PREFIX}create`, { input }, CREATE_TIMEOUT_MS),
    copy: (input) => connection.request(`${CLOUD_BRIDGE_PREFIX}copy`, { input }, COPY_TIMEOUT_MS),
    move: (input) => connection.request(`${CLOUD_BRIDGE_PREFIX}move`, { input }, MOVE_TIMEOUT_MS),
    approveWindow: (input) => connection.request(`${CLOUD_BRIDGE_PREFIX}approveWindow`, { input }, APPROVE_WINDOW_TIMEOUT_MS),
    closeApprovalWindow: async (input) => {
      await connection.request(`${CLOUD_BRIDGE_PREFIX}closeApprovalWindow`, { input }, 30_000);
    },
    dispose: () => connection.close(),
  };
}
