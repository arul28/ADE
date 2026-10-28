/**
 * Which ADE calls only the running brain can answer.
 *
 * When no brain answers, the CLI runs a command on an in-process runtime. That
 * is right for project state on disk and wrong for state the brain holds, so
 * every such call fails with the reason no brain was used instead of reaching
 * a stand-in (a stub chat service reports success for a chat that never runs).
 *
 * Actions declare it on the action policy (`live` in shared/adeActionAccess.ts),
 * so a new action cannot drift from this check. Decided per call (domain and
 * action), not per command: one rule covers every command, including those
 * whose steps pick their domain at run time.
 */
import { isLiveOnlyAdeAction } from "../../../desktop/src/shared/adeActionAccess";

/**
 * ADE tools (not `run_ade_action`) that start or drive brain-held work. Tools
 * are not actions, so the action policy cannot declare them.
 */
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
  const args = asRecord(call?.arguments);
  // A test run that returns before it finishes keeps running in the runtime
  // that started it; an in-process one dies with the command. A waited run
  // (the tool's default) ends before the command does.
  if (name === "run_tests") return args?.waitForCompletion === false ? name : null;
  if (name !== "run_ade_action") return null;
  const domain = typeof args?.domain === "string" ? args.domain : "";
  const action = typeof args?.action === "string" ? args.action : "";
  if (!domain) return null;
  if (isLiveOnlyAdeAction(domain, action)) {
    return action ? `${domain}.${action}` : domain;
  }
  return null;
}
