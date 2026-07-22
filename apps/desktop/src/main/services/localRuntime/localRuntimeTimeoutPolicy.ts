export const LOCAL_RUNTIME_PROJECT_TIMEOUT_MS = 120_000;
export const LOCAL_RUNTIME_IPC_PROJECT_SETUP_TIMEOUT_MS = 150_000;
export const LOCAL_RUNTIME_IPC_COMPLETION_HEADROOM_MS = 15_000;

const LONG_RUNNING_LOCAL_RUNTIME_ACTION_TIMEOUTS: ReadonlyMap<string, number> = new Map([
  // Lane deletion can legitimately include a 60s worktree removal followed by
  // a 45s remote-branch deletion. The old 30s client budget reported failure
  // while the daemon kept mutating state to a successful completion.
  ["lane.delete", 4 * 60_000],
  ["lane.archive", 120_000],
  ["lane.unarchive", 120_000],
  ["chat.suggestLaneNameFromPrompt", 120_000],
  // Handoff = AI brief generation (bounded at 45s) + session creation +
  // provider dispatch of the first message; the 30s default fired a false
  // timeout while the daemon-side handoff kept running to a late "surprise"
  // success (ADE-122).
  ["chat.handoffSession", 120_000],
  ["chat.prepareCrossMachineHandoff", 120_000],
]);

const DESTRUCTIVE_LANE_ACTIONS = new Set([
  "lane.archive",
  "lane.delete",
  "lane.unarchive",
]);

export function longRunningLocalRuntimeActionTimeoutMs(
  actionKey: string,
): number | null {
  return LONG_RUNNING_LOCAL_RUNTIME_ACTION_TIMEOUTS.get(actionKey) ?? null;
}

// The renderer-side IPC timer starts before a cold project is registered and
// connected, while the daemon action timer starts afterwards. Compose those
// sequential budgets and retain explicit delivery headroom so IPC cannot
// report a false timeout immediately before a destructive action resolves.
export function destructiveLaneLocalRuntimeIpcTimeoutMs(
  domain: string,
  action: string,
): number | null {
  const actionKey = `${domain}.${action}`;
  if (!DESTRUCTIVE_LANE_ACTIONS.has(actionKey)) return null;
  const actionTimeoutMs = longRunningLocalRuntimeActionTimeoutMs(actionKey);
  if (actionTimeoutMs == null) return null;
  return LOCAL_RUNTIME_IPC_PROJECT_SETUP_TIMEOUT_MS
    + actionTimeoutMs
    + LOCAL_RUNTIME_IPC_COMPLETION_HEADROOM_MS;
}
