/**
 * A project scope the brain has already booted, for machine-level usage reads.
 *
 * The brain polls provider quota once per machine and exposes it through the
 * per-project `usage` action domain. Desktop main and the unbound IPC fallback
 * both need "any booted scope" and must pick by the same rule, or a window
 * could subscribe to one root and read from another.
 */
export type BootedUsageScopeContext = {
  db?: unknown;
  project?: { rootPath?: string | null } | null;
};

export function bootedUsageScopeRoot(
  contexts: ReadonlyArray<BootedUsageScopeContext>,
): string | null {
  for (const ctx of contexts) {
    // `db` is the local-runtime discriminator: the dormant context has none.
    if (!ctx.db) continue;
    const root = ctx.project?.rootPath?.trim();
    if (root) return root;
  }
  return null;
}
