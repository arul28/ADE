/**
 * A brain has no caller identity of its own.
 *
 * ADE stamps every agent shell with who is calling: the chat session, the
 * orchestration run. A CLI run
 * from that shell reads them to say "this call is that agent's". A brain must
 * not: it serves every client on the machine, and the env caller context in
 * `adeRpcServer` falls back to the process env for EVERY connection that did
 * not name its own chat. A brain started from an agent's shell therefore
 * clamps every client — the desktop included — to that agent's identity.
 *
 * On 2026-09-22 a brain started by hand from a chat shell carried
 * `ADE_CHAT_SESSION_ID` of that chat. The desktop connected as `cto`, was
 * clamped to `agent`, and the Mac Desktop panel answered "Action
 * 'mac_desktop.startStream' requires elevated role." The dev launcher already
 * strips these keys (`sanitizeParentEnvForDevRuntime` in scripts/dev-shared.mjs);
 * a brain started any other way did not.
 *
 * `ADE_DEFAULT_ROLE` is not caller identity. When caller keys identify an
 * agent shell, `runServe` removes its inherited role after resolving this
 * brain's role.
 */

import type { AdeRuntimeRole } from "../../runtimeRoles";

/** Who-is-calling keys an agent shell carries, which a brain must never adopt. */
export const BRAIN_INHERITED_CALLER_ENV_KEYS = [
  "ADE_CHAT_SESSION_ID",
  "ADE_PARENT_CHAT_SESSION_ID",
  "ADE_SPAWN_KIND",
  "ADE_RUN_ID",
  "ADE_STEP_ID",
  "ADE_ATTEMPT_ID",
  "ADE_OWNER_ID",
] as const;

/**
 * Removes inherited caller identity from `env` in place and returns the keys it
 * removed. Blank values count as absent: they carry no identity.
 */
export function dropInheritedCallerIdentity(env: NodeJS.ProcessEnv): string[] {
  const dropped: string[] = [];
  for (const key of BRAIN_INHERITED_CALLER_ENV_KEYS) {
    const value = env[key];
    if (value === undefined) continue;
    if (value.trim()) dropped.push(key);
    delete env[key];
  }
  return dropped;
}

/**
 * Where the launching agent stood: its project, lane worktree and browser
 * capability. Dropped only when the shell was an agent's (it carried a caller
 * identity), so an operator who sets `ADE_PROJECT_ROOT` for a brain on purpose
 * keeps it.
 *
 * On 2026-10-20 a brain started from an agent shell under a scratch
 * `ADE_HOME` read the agent's `ADE_PROJECT_ROOT`, registered the owner's real
 * project, and opened its database. The dev launcher already strips these
 * (`sanitizeParentEnvForDevRuntime` in scripts/dev-shared.mjs).
 */
export const BRAIN_INHERITED_AGENT_LOCATION_ENV_KEYS = [
  "ADE_LANE_ID",
  "ADE_PROJECT_ROOT",
  "ADE_WORKSPACE_ROOT",
  "ADE_BROWSER_ACTOR_TOKEN",
] as const;

/**
 * Removes the agent's location keys from `env` in place when the caller
 * identity drop found an agent shell; returns the keys it removed.
 */
export function dropInheritedAgentLocation(
  env: NodeJS.ProcessEnv,
  droppedCallerIdentity: readonly string[],
): string[] {
  if (droppedCallerIdentity.length === 0) return [];
  const dropped: string[] = [];
  for (const key of BRAIN_INHERITED_AGENT_LOCATION_ENV_KEYS) {
    const value = env[key];
    if (value === undefined) continue;
    if (value.trim()) dropped.push(key);
    delete env[key];
  }
  return dropped;
}

export function describeDroppedCallerIdentity(dropped: readonly string[]): string | null {
  if (dropped.length === 0) return null;
  return `This brain was started from an agent's shell. It ignores that shell's caller identity (${dropped.join(", ")}), so each client keeps its own identity.`;
}

/** Describe inherited agent settings without claiming they identify the shell. */
export function describeDroppedAgentEnv(dropped: readonly string[]): string | null {
  if (dropped.length === 0) return null;
  return `This brain ignores inherited agent environment (${dropped.join(", ")}).`;
}

/**
 * The sentence for a brain whose role ceiling refuses the desktop. Desktop,
 * phone and web clients connect at `cto`; a lower ceiling refuses them at the
 * handshake with "default role … cannot serve CLI role cto".
 *
 * An embedded runtime (the ADE SDK's sidecar, `--profile embedded`) is silent:
 * it serves exactly one host at role `agent` on purpose, so the desktop,
 * phone and web clients this sentence warns about are not there to be refused,
 * and the command it recommends does not apply.
 */
export function describeBrainRoleCeiling(
  role: AdeRuntimeRole,
  opts: { embedded?: boolean } = {},
): string | null {
  if (role === "cto") return null;
  if (opts.embedded) return null;
  return `This brain serves at role ${role}, so ADE desktop, phone and web clients (role cto) will be refused. Start it as \`ade --role cto serve\` to serve them.`;
}
