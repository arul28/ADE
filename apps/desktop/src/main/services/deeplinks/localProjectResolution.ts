/**
 * Resolving a deeplink's project against *this* machine's own projects.
 *
 * Three id spaces can arrive at a deeplink handler, which is the whole reason
 * this is a named function rather than a condition inline in the dispatcher:
 *
 *   - a link minted today carries the machine-independent `project_<hash>`
 *     (`deriveProjectId(rootPath)`),
 *   - an older link carries the *publishing* machine's private `randomUUID()`,
 *     which is meaningful nowhere else,
 *   - and this machine's own contexts are keyed by its own private uuid.
 *
 * So an id match alone is not enough, and neither is a path match: the only
 * honest strategy is to try each identity in the order that can't produce a
 * wrong answer — exact id, then the root path the link carried, then a
 * recomputed canonical id for a link whose item had no root path at all.
 *
 * The remote equivalent lives in `services/ipc/runtimeBridge.ts`
 * (`resolveRemoteProjectBinding`); keep the two in step.
 */
export type LocalProjectCandidate = {
  /** Absolute path of a project this machine knows about. */
  root: string;
  /** This machine's own id for it. */
  projectId: string;
};

export type LocalProjectResolutionDeps = {
  /** Every project this machine can route to: open contexts plus recents. */
  candidates: () => readonly LocalProjectCandidate[];
  /** Path comparison, platform-correct for this machine. */
  pathsEqual: (a: string, b: string) => boolean;
  /** `deriveProjectId`. May throw on a malformed root; treated as "no match". */
  deriveProjectId: (rootPath: string) => string;
};

/**
 * The root path to navigate to, or `null` when this machine does not have the
 * project. `null` is a real answer — the caller routes the request to the owning
 * machine instead of guessing.
 */
export function resolveLocalProjectRoot(
  projectId: string,
  projectRoot: string | null,
  deps: LocalProjectResolutionDeps,
): string | null {
  const candidates = deps.candidates().filter((entry) => Boolean(entry.root));

  // 1. Exact id. Correct for this machine's own links, and for a canonical-id
  //    link once the registry and the publisher agree on the hash.
  const byId = candidates.find((entry) => entry.projectId === projectId);
  if (byId) return byId.root;

  // 2. The root path the link carried. The one identity every producer agrees
  //    on, which is why links carry it alongside the id.
  const trimmedRoot = projectRoot?.trim();
  if (trimmedRoot) {
    const byRoot = candidates.find((entry) => deps.pathsEqual(entry.root, trimmedRoot));
    if (byRoot) return byRoot.root;
  }

  // 3. Recompute the canonical id from each known root. Last resort for a
  //    canonical-id link whose item carried no root path.
  const byCanonicalId = candidates.find((entry) => {
    try {
      return deps.deriveProjectId(entry.root) === projectId;
    } catch {
      return false;
    }
  });
  return byCanonicalId?.root ?? null;
}
