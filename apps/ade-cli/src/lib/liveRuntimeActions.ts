/**
 * Which ADE calls only the running brain can answer.
 *
 * When no brain answers, the CLI runs a command on an in-process runtime. That
 * is right for project state on disk (lanes, git, PRs, settings), and wrong for
 * anything whose state lives in the brain: its chat service there is a stub
 * that mints `chat-<uuid>` ids and never runs a turn, and its terminals,
 * devices, browsers and schedules die with the command. So `ade new chat`
 * reported success for a chat that never existed, and `chat list` was empty
 * (ledger #48, #49). Every such call now fails with the reason no brain was
 * used, instead of reaching the stub.
 *
 * Decided per call (domain and action), not per command: one rule covers every
 * command, including those whose steps pick their domain at run time.
 */

/** Domains whose every action needs the live brain. */
const LIVE_ONLY_DOMAINS: ReadonlySet<string> = new Set([
  "chat",
  "session",
  "pty",
  "terminal",
  "work_tools",
  "ios_simulator",
  "mac_desktop",
  "app_control",
  "built_in_browser",
  "linear_agent",
  "keep_awake",
  "attention",
  "cto_state",
  "proxy",
]);

/**
 * Actions that change brain-held state in a domain whose reads work from
 * disk: scheduled automations and their ingress, test runs, lane proxies and
 * port leases.
 */
const LIVE_ONLY_ACTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  automations: new Set([
    "saveRule", "deleteRule", "toggleRule", "triggerManually", "planTest", "runTest", "cleanUpTestRun",
    "startIngress", "cancelScheduledCleanup", "linearIngressSetup", "linearIngressTeardown",
    "linearIngressPollNow", "webhookCreateEndpoint", "webhookRotateEndpoint", "webhookReplayDelivery",
    "webhookSendTest", "webhookCreateAutomation", "webhookRetire",
  ]),
  tests: new Set(["run", "stop"]),
  lane: new Set([
    "proxyAddRoute", "proxyRemoveRoute", "proxyStart", "proxyStop",
    "portAcquire", "portGetLease", "portRecoverOrphans", "portRelease",
  ]),
};

/** ADE tools (not `run_ade_action`) that start or drive brain-held work. */
const LIVE_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "start_cli_session",
  "preview_scene",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * `domain.action` (or the tool name) when this JSON-RPC call needs the live
 * brain, else null. Only `ade/actions/call` is inspected; everything else the
 * CLI sends (initialize, projects.*, listing actions) works in-process.
 */
export function liveOnlyCallLabel(method: string, params: unknown): string | null {
  if (method !== "ade/actions/call") return null;
  const call = asRecord(params);
  const name = typeof call?.name === "string" ? call.name : "";
  if (LIVE_ONLY_TOOLS.has(name)) return name;
  if (name !== "run_ade_action") return null;
  const args = asRecord(call?.arguments);
  const domain = typeof args?.domain === "string" ? args.domain : "";
  const action = typeof args?.action === "string" ? args.action : "";
  if (!domain) return null;
  if (LIVE_ONLY_DOMAINS.has(domain) || LIVE_ONLY_ACTIONS[domain]?.has(action)) {
    return action ? `${domain}.${action}` : domain;
  }
  return null;
}
