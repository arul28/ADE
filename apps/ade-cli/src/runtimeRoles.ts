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
