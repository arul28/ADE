import { parseGithubRemoteUrl } from "../../../shared/githubRemote";
import { THIS_MACHINE_ID, THIS_MACHINE_NAME } from "../../../shared/machineIdentity";
import type {
  RecentProjectSummary,
  RemoteRuntimeConnectionSnapshot,
} from "../../../shared/types";
import { cachedGitRemoteIdentity } from "../lanes/laneMachines";

/**
 * The pieces every "copy of a repository on a machine" surface shares: the Add
 * project form, the copies menu on a project tab, and the clone jobs behind
 * both. Pure, so the surfaces cannot disagree about which machine has a copy.
 */

/** One machine that can hold a copy: this computer or a saved machine. */
export type CopyMachine = {
  /** `THIS_MACHINE_ID` for this computer, else the saved machine's target id. */
  machineId: string;
  name: string;
  /** Null for this computer; the target every call for the machine goes to. */
  targetId: string | null;
  isLocal: boolean;
  /** Connected now. A machine that is not is never called (and never woken). */
  online: boolean;
};

/** A copy of the repository that a machine already has. */
export type ExistingCopy = {
  machineId: string;
  rootPath: string;
  displayName: string;
  /** The machine's project id, for a copy on another machine. */
  projectId: string | null;
};

/** Where a project opens once its copy is there. */
export type CopyOpenTarget =
  | { kind: "local"; rootPath: string; displayName: string }
  | { kind: "remote"; targetId: string; projectId: string; rootPath: string; displayName: string };

// `user@host:owner/repo` or `ssh://user@host/owner/repo` through an ssh config
// alias (`git@github.com-work:…`). The clone call on the machine resolves the
// alias, and it accepts only GitHub, so a form that lets an alias through
// treats it as the GitHub repository it names.
const SCP_ALIAS = /^(?:[^@\s/:]+@)?([A-Za-z0-9][A-Za-z0-9._-]*):([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/;
const SSH_URL_ALIAS = /^ssh:\/\/(?:[^@\s/]+@)?([A-Za-z0-9][A-Za-z0-9._-]*)(?::\d+)?\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i;

/**
 * An ssh config alias of GitHub: `github.com-work`, `github-personal`, or a
 * bare name with no dot (`work`). A real host such as `gitlab.com` is not one.
 */
function githubAliasSlug(url: string): { owner: string; repo: string } | null {
  const match = SCP_ALIAS.exec(url) ?? SSH_URL_ALIAS.exec(url);
  const host = match?.[1]?.toLowerCase() ?? "";
  if (!match?.[2] || !match[3] || !host) return null;
  if (!host.startsWith("github") && host.includes(".")) return null;
  return { owner: match[2], repo: match[3] };
}
const OWNER_REPO_SHORTHAND = /^([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+?)(?:\.git)?$/;

// `user@host:owner/repo` or `ssh://user@host/owner/repo` through an ssh config
// alias. Only the machine that clones can read its ssh config, so the form
// lets the shape through and the clone call decides whether it is GitHub.
const SSH_ALIAS_REPO_PATTERNS = [
  /^[^@\s/:]+@[A-Za-z0-9][A-Za-z0-9._-]*:[^/\s]+\/[^/\s]+$/,
  /^ssh:\/\/(?:[^@\s/]+@)?[A-Za-z0-9][A-Za-z0-9._-]*(?::\d+)?\/[^/\s]+\/[^/\s]+$/i,
];

/**
 * The URL shapes the clone call accepts, so the form shows a hint before the
 * call would reject with `invalid_github_url`.
 */
export function isGitHubRepoUrl(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  return parseGithubRemoteUrl(trimmed) !== null || SSH_ALIAS_REPO_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/** Accepts `owner/repo` as well as a URL; returns the URL to clone. */
export function expandRepoInput(raw: string): string {
  const trimmed = raw.trim();
  const shorthand = OWNER_REPO_SHORTHAND.exec(trimmed);
  return shorthand ? `https://github.com/${shorthand[1]}/${shorthand[2]}` : trimmed;
}

/**
 * The key one repository has on every machine, from any of its URLs: https,
 * scp-style ssh, `ssh://`, or an ssh alias of GitHub all give the same key.
 * Null when the text names no repository.
 */
export function repoKeyForUrl(url: string | null | undefined): string | null {
  const trimmed = typeof url === "string" ? url.trim() : "";
  if (!trimmed) return null;
  const slug = parseGithubRemoteUrl(trimmed);
  if (slug) return `github.com/${slug.owner}/${slug.repo}`.toLowerCase();
  const alias = githubAliasSlug(trimmed);
  if (alias) return `github.com/${alias.owner}/${alias.repo}`.toLowerCase();
  return cachedGitRemoteIdentity(trimmed);
}

/**
 * The repo key of a tab's origin, which the tab bar keeps already normalized
 * (`host/owner/repo`). An ssh alias host of GitHub (`github.com-work`) names
 * the same repository as `github.com`.
 */
export function repoKeyForOriginIdentity(origin: string | null | undefined): string | null {
  const trimmed = typeof origin === "string" ? origin.trim().toLowerCase() : "";
  if (!trimmed) return null;
  const parts = /^([^/]+)\/([^/]+)\/([^/]+)$/.exec(trimmed);
  if (parts && parts[1]!.startsWith("github.com")) return `github.com/${parts[2]}/${parts[3]}`;
  return trimmed;
}

/** The repository's name, used as the folder name on every machine. */
export function repoNameForUrl(url: string): string {
  const trimmed = url.trim();
  const slug = parseGithubRemoteUrl(trimmed);
  if (slug) return slug.repo;
  const alias = githubAliasSlug(trimmed);
  if (alias) return alias.repo;
  const tail = trimmed.match(/([^/:]+?)(?:\.git)?\/?$/);
  return tail?.[1] ?? "";
}

/**
 * Every machine that can hold a copy, from the connection snapshot the app
 * already holds: this computer first (not in the hosted web client, which has
 * no computer of its own), then every saved machine, connected or not.
 */
export function copyMachines(
  snapshot: RemoteRuntimeConnectionSnapshot | null | undefined,
  opts: { includeLocal: boolean },
): CopyMachine[] {
  const machines: CopyMachine[] = [];
  if (opts.includeLocal) {
    machines.push({
      machineId: THIS_MACHINE_ID,
      name: THIS_MACHINE_NAME,
      targetId: null,
      isLocal: true,
      online: true,
    });
  }
  for (const connection of snapshot?.connections ?? []) {
    machines.push({
      machineId: connection.target.id,
      name: connection.target.name?.trim() || connection.target.hostname,
      targetId: connection.target.id,
      isLocal: false,
      online: connection.state === "connected",
    });
  }
  return machines;
}

/**
 * The copy each machine already has of `repoKey`: this computer's from its
 * recent projects (never a lane worktree, never a missing folder), another
 * machine's from its project list in the snapshot.
 */
export function existingCopiesForRepo(
  repoKey: string | null,
  sources: {
    recents: readonly RecentProjectSummary[];
    snapshot: RemoteRuntimeConnectionSnapshot | null | undefined;
  },
): Map<string, ExistingCopy> {
  const copies = new Map<string, ExistingCopy>();
  if (!repoKey) return copies;
  for (const recent of sources.recents) {
    if (recent.kind === "remote" || recent.exists === false || recent.worktreeOf) continue;
    if (repoKeyForUrl(recent.gitOriginUrl) !== repoKey) continue;
    copies.set(THIS_MACHINE_ID, {
      machineId: THIS_MACHINE_ID,
      rootPath: recent.rootPath,
      displayName: recent.displayName,
      projectId: null,
    });
    break;
  }
  for (const connection of sources.snapshot?.connections ?? []) {
    const project = (connection.projects ?? []).find(
      (entry) => entry.exists !== false && repoKeyForUrl(entry.gitOriginUrl) === repoKey,
    );
    if (!project) continue;
    copies.set(connection.target.id, {
      machineId: connection.target.id,
      rootPath: project.rootPath,
      displayName: project.displayName,
      projectId: project.projectId,
    });
  }
  return copies;
}

/**
 * Splits a list of machines for a long list: the rows that always show (this
 * computer, connected machines, and any row `keepVisible` names, such as an
 * offline machine with a copy), in their order, and the offline rest, which a
 * list collapses into one "N machines offline" row.
 */
export function splitOfflineMachines<T>(
  items: readonly T[],
  machineOf: (item: T) => CopyMachine,
  keepVisible: (item: T) => boolean = () => false,
): { visible: T[]; offline: T[] } {
  const visible: T[] = [];
  const offline: T[] = [];
  for (const item of items) {
    const machine = machineOf(item);
    if (machine.isLocal || machine.online || keepVisible(item)) visible.push(item);
    else offline.push(item);
  }
  return { visible, offline };
}

export function offlineMachinesLabel(count: number): string {
  return `${count} ${count === 1 ? "machine" : "machines"} offline`;
}

/**
 * Whether any copy of `repoKey` may still exist on any machine once the
 * entries in `gone` are removed. Every copy counts, not one per machine: a
 * second copy on the same machine, a copy whose folder is missing, a copy on a
 * machine that is offline or runs an older ADE. A machine that is not
 * connected and whose project list ADE does not know may hold one.
 */
export function repoCopyMayRemain(
  repoKey: string,
  sources: {
    recents: readonly RecentProjectSummary[];
    snapshot: RemoteRuntimeConnectionSnapshot | null | undefined;
  },
  gone: ReadonlySet<string>,
): boolean {
  for (const recent of sources.recents) {
    if (recent.kind === "remote" || recent.worktreeOf) continue;
    if (repoKeyForUrl(recent.gitOriginUrl) === repoKey && !gone.has(recent.rootPath)) return true;
  }
  for (const connection of sources.snapshot?.connections ?? []) {
    const projects = connection.projects ?? [];
    if (connection.state !== "connected" && projects.length === 0) return true;
    const remains = projects.some((project) =>
      repoKeyForUrl(project.gitOriginUrl) === repoKey
      && !gone.has(`remote:${connection.target.id}:${project.projectId}`));
    if (remains) return true;
  }
  return false;
}

export type CopyFailureKind =
  | "github_sign_in"
  | "folder_exists"
  | "disk_full"
  | "offline"
  | "no_access"
  | "invalid_url"
  | "unsupported"
  | "web"
  | "unknown";

export type CopyFailure = {
  kind: CopyFailureKind;
  /** A short reason for the row, in plain words. */
  reason: string;
  /** The raw error, for the report and the tooltip. */
  detail: string;
};

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : String(error ?? "");
}

/**
 * The plain reason a copy failed on one machine. `online` is whether the
 * machine was still connected when the failure arrived: a machine that dropped
 * mid-clone fails with whatever its socket said, and that is not the reason.
 */
export function describeCopyFailure(error: unknown, online: boolean): CopyFailure {
  const detail = errorText(error);
  const text = detail.toLowerCase();
  const failure = (kind: CopyFailureKind, reason: string): CopyFailure => ({ kind, reason, detail });
  if (text.startsWith("copy_web_unsupported")) return failure("web", "Needs the desktop app");
  if (!online) return failure("offline", "Went offline");
  if (text.includes("target_exists") || text.includes("already exists")) {
    return failure("folder_exists", "Folder already exists");
  }
  if (text.includes("enospc") || text.includes("no space left")) {
    return failure("disk_full", "Not enough disk space");
  }
  if (
    text.includes("github_not_connected")
    || text.includes("authentication failed")
    || text.includes("could not read username")
    || text.includes("terminal prompts disabled")
    || text.includes("permission denied (publickey)")
    || text.includes("invalid username or password")
  ) {
    return failure("github_sign_in", "GitHub sign-in needed");
  }
  if (
    text.includes("repository not found")
    || (text.includes("repository") && text.includes("does not exist"))
    || text.includes("access denied")
    || text.includes("error: 403")
    || text.includes("error: 404")
  ) {
    return failure("no_access", "Repo not found or no access");
  }
  if (text.includes("invalid_github_url")) return failure("invalid_url", "Not a GitHub repo");
  if (
    text.startsWith("copy_unsupported")
    || text.includes("unknown method")
    || text.includes("method not found")
  ) {
    return failure("unsupported", "Update ADE on this machine");
  }
  return failure("unknown", "Couldn't add the copy");
}

/** A failure the person fixes on their side, so ADE is not told about it. */
export function isUserFixableCopyFailure(kind: CopyFailureKind): boolean {
  return kind !== "unknown" && kind !== "unsupported";
}
