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
