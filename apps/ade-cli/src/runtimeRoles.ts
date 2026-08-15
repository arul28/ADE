export const ADE_RUNTIME_ROLES = [
  "cto",
  "orchestrator",
  "agent",
  "external",
  "evaluator",
] as const;

export type AdeRuntimeRole = (typeof ADE_RUNTIME_ROLES)[number];

export function normalizeAdeRuntimeRole(value: unknown): AdeRuntimeRole | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return (ADE_RUNTIME_ROLES as readonly string[]).includes(trimmed)
    ? (trimmed as AdeRuntimeRole)
    : null;
}

export function resolveAdeDefaultRole(
  value: unknown,
  fallback: AdeRuntimeRole,
): AdeRuntimeRole {
  return normalizeAdeRuntimeRole(value) ?? fallback;
}

/**
 * Whether a runtime spawned at `defaultRole` (its ADE_DEFAULT_ROLE ceiling) is
 * allowed to serve a client that requested `requestedRole`. The default role is
 * a ceiling: a caller may assert an equal-or-lower role, never a higher one.
 * `external` is always serviceable (it is the lowest, unprivileged role).
 */
export function canDefaultRoleServeRequestedRole(
  defaultRole: AdeRuntimeRole | null,
  requestedRole: AdeRuntimeRole,
): boolean {
  if (requestedRole === "external") return true;
  if (!defaultRole) return false;
  if (defaultRole === "cto") return true;
  if (defaultRole === "orchestrator") return requestedRole !== "cto";
  if (defaultRole === "agent") return requestedRole === "agent";
  if (defaultRole === "evaluator") return requestedRole === "evaluator";
  return false;
}

/**
 * Resolve the effective session role from the runtime's default-role ceiling
 * and the client's requested role. With no default role the caller is
 * unprivileged (`external`); with no requested role the caller inherits the
 * default; otherwise the requested role is honored only when the ceiling
 * permits it, and clamped down to the default role when it does not.
 */
export function resolveSessionRole(
  defaultRole: AdeRuntimeRole | null,
  requestedRole: AdeRuntimeRole | null,
): AdeRuntimeRole {
  if (!defaultRole) return "external";
  if (!requestedRole) return defaultRole;
  return canDefaultRoleServeRequestedRole(defaultRole, requestedRole)
    ? requestedRole
    : defaultRole;
}

/**
 * The identity a terminal opened by an ADE agent carries in its environment.
 *
 * Listed in the order someone would type after `unset`, and exported so the
 * refusal message below cannot drift from the clamp that produced it.
 */
export const ADE_SESSION_IDENTITY_ENV_VARS = [
  "ADE_CHAT_SESSION_ID",
  "ADE_RUN_ID",
  "ADE_STEP_ID",
  "ADE_ATTEMPT_ID",
  "ADE_OWNER_ID",
  "ADE_DEFAULT_ROLE",
] as const;

/**
 * Why `--role cto` did not take, in the caller's own terms — or null when the
 * caller carries no session and the clamp below was not the reason.
 *
 * The refusal it decorates used to say "run it from your own terminal", which is
 * true and unusable: an ADE-owned terminal looks exactly like a terminal you
 * opened, and nothing on screen says it is carrying an agent identity. In the
 * alpha test that produced `docs/reports/ade-tipsy-plugin-alpha-ux-retrospective.md`
 * the user retried with the role the error itself named, got the identical
 * refusal, and only got through after discovering six inherited variables. The
 * clamp is correct — a chat-session binding must never elevate itself — so the
 * fix is to name it.
 */
export function describeSessionBoundRoleClamp(
  chatSessionId: string | null | undefined,
): string | null {
  if (!chatSessionId) return null;
  return "This terminal carries an ADE agent session (ADE_CHAT_SESSION_ID is set),"
    + " so --role cto is clamped to agent. Run from a terminal you opened yourself,"
    + ` or unset ${ADE_SESSION_IDENTITY_ENV_VARS.join(" ")}.`;
}

/**
 * A chat-session binding is an authority boundary, not a source of elevation.
 * In particular, a client launched from ADE's CTO-capable runtime must not
 * inherit the daemon's machine-wide CTO role merely because it omitted (or
 * copied) a narrower role. Preserve explicit lower-privilege identities, allow
 * an explicitly-declared orchestrator to coordinate, and otherwise clamp a
 * session-bound CTO result to a regular agent.
 */
export function resolveSessionBoundRole(args: {
  defaultRole: AdeRuntimeRole | null;
  requestedRole: AdeRuntimeRole | null;
  chatSessionId: string | null;
}): AdeRuntimeRole {
  const resolvedRole = resolveSessionRole(args.defaultRole, args.requestedRole);
  const { requestedRole, chatSessionId } = args;
  if (!chatSessionId || resolvedRole !== "cto") return resolvedRole;
  if (
    requestedRole === "orchestrator"
    || requestedRole === "agent"
    || requestedRole === "external"
    || requestedRole === "evaluator"
  ) {
    return requestedRole;
  }
  return "agent";
}
