import type { Agent37DesktopBridge } from "../../../../desktop/src/main/services/agent37/agent37AgentActions";
import { createDesktopBridgeConnection } from "./desktopBridgeConnection";

/**
 * Agent 37 machine making as the runtime daemon reaches it: create, copy and
 * move sign the new machine in through the desktop app's approval window, so
 * the brain asks the desktop attached to it over the bridge socket.
 */

export const AGENT37_BRIDGE_PREFIX = "agent37.";
export const AGENT37_BRIDGE_METHODS = ["create", "copy", "move", "ready_refresh"] as const;
export type Agent37BridgeMethod = (typeof AGENT37_BRIDGE_METHODS)[number];

export function isAgent37BridgeMethod(name: string): name is Agent37BridgeMethod {
  return (AGENT37_BRIDGE_METHODS as readonly string[]).includes(name);
}

export const AGENT37_NO_DESKTOP = "Making a machine signs it in through the ADE desktop app, and none is attached to this ADE.";

/** Longer than the desktop's own deadlines (a create's join, a fork, a move's copy), so its clearer error arrives first. */
const CREATE_TIMEOUT_MS = 10 * 60_000;
const COPY_TIMEOUT_MS = 25 * 60_000;
const MOVE_TIMEOUT_MS = 60 * 60_000;

export function createAgent37DesktopBridgeClient(args: { socketPath: string }): Agent37DesktopBridge & { dispose(): void } {
  const connection = createDesktopBridgeConnection({
    ...args,
    unavailableMessage: AGENT37_NO_DESKTOP,
    closedMessage: "The Agent 37 bridge was disposed.",
  });
  return {
    create: (input) => connection.request(`${AGENT37_BRIDGE_PREFIX}create`, { input }, CREATE_TIMEOUT_MS),
    copy: (input) => connection.request(`${AGENT37_BRIDGE_PREFIX}copy`, { input }, COPY_TIMEOUT_MS),
    move: (input) => connection.request(`${AGENT37_BRIDGE_PREFIX}move`, { input }, MOVE_TIMEOUT_MS),
    readyRefresh: () => connection.request(`${AGENT37_BRIDGE_PREFIX}ready_refresh`, {}, 60_000),
    dispose: () => connection.close(),
  };
}
