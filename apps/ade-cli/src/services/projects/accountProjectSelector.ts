import {
  githubRepoIdentityFromOrigin,
  githubRepoKey,
  type AccountProjectView,
} from "../../../../desktop/src/shared/accountProject";

/**
 * A project named by the account (L30): its account project id
 * (`ap_<32 hex>`) or its GitHub `owner/name`. Commands that take a project
 * accept either, on this computer (`--project-root`) and on another machine
 * (`--machine <name> --machine-project`).
 */
export type AccountProjectSelector =
  | { kind: "id"; id: string }
  | { kind: "repo"; owner: string; name: string; repoKey: string };

const ACCOUNT_PROJECT_ID = /^ap_[0-9a-f]{32}$/;
/** GitHub's own rules: an owner is letters, digits and single hyphens; a name adds `.` and `_`. */
const GITHUB_SLUG = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/;

/**
 * The selector `value` names, or null when it is neither form. A caller that
 * also accepts a path checks the path first: `src/app` that exists is a
 * folder, not a repository.
 */
export function parseAccountProjectSelector(value: string): AccountProjectSelector | null {
  const text = value.trim();
  if (ACCOUNT_PROJECT_ID.test(text)) return { kind: "id", id: text };
  const slug = GITHUB_SLUG.exec(text.replace(/\.git$/i, ""));
  if (!slug) return null;
  const [, owner, name] = slug as unknown as [string, string, string];
  if (name === "." || name === "..") return null;
  return { kind: "repo", owner, name, repoKey: githubRepoKey("github.com", owner, name) };
}

export type ResolvedAccountProject =
  | {
    kind: "found";
    /** The project the selector names after merges, or null for a repository the account does not list. */
    project: AccountProjectView | null;
    /** The ids a folder may still be linked to: the named id and each project it merged into. */
    ids: ReadonlySet<string>;
    /** The repository addresses of the project (`repo:<host>/<owner>/<name>`). */
    repoKeys: ReadonlySet<string>;
    name: string;
  }
  | { kind: "removed"; name: string }
  | { kind: "unknown" };

/**
 * Finds the selector in the account's list as this machine last read it.
 * A merged id follows to the project it merged into; a removed project says
 * so. A repository the list does not hold is still found by its address,
 * so a folder of it matches by its origin.
 */
export function resolveAccountProject(
  selector: AccountProjectSelector,
  projects: Readonly<Record<string, AccountProjectView>>,
): ResolvedAccountProject {
  const values = Object.values(projects);
  let start: AccountProjectView | null;
  if (selector.kind === "id") {
    start = projects[selector.id] ?? null;
    if (!start) return { kind: "unknown" };
  } else {
    const key = selector.repoKey;
    start = values.find((project) => project.repoKey.toLowerCase() === key || project.aliases.some((alias) => alias.toLowerCase() === key)) ?? null;
  }
  const ids = new Set<string>();
  let project = start;
  for (let hops = 0; project && hops < 8; hops += 1) {
    ids.add(project.id);
    if (!project.mergedInto) break;
    project = projects[project.mergedInto] ?? null;
  }
  if (project && project.removedAt !== null) return { kind: "removed", name: project.name };
  const repoKeys = new Set<string>();
  if (selector.kind === "repo") repoKeys.add(selector.repoKey);
  for (const key of project ? [project.repoKey, ...project.aliases] : []) repoKeys.add(key.toLowerCase());
  const name = project?.name ?? (selector.kind === "repo" ? selector.name : selector.id);
  return { kind: "found", project, ids, repoKeys, name };
}

/** Whether a registry row is a copy of the resolved project: by its account link, else by its origin. */
export function recordMatchesAccountProject(
  record: { accountProjectId?: string | null; gitOriginUrl?: string | null },
  resolved: Extract<ResolvedAccountProject, { kind: "found" }>,
): boolean {
  if (record.accountProjectId && resolved.ids.has(record.accountProjectId)) return true;
  const identity = githubRepoIdentityFromOrigin(record.gitOriginUrl ?? null);
  return identity !== null && resolved.repoKeys.has(identity.repoKey.toLowerCase());
}
