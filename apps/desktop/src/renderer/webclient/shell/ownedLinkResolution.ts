// ---------------------------------------------------------------------------
// Opening an owned link on the web: the machine and project it names.
//
// Chat, lane and PR links carry `ownership` ({accountMachineKey, projectId}):
// they mean something only on the computer and project that published them.
// The web client mirrors the desktop's owner-aware dispatch
// (`main/services/deeplinks/ownerAwareNavigation.ts`) and its project matching
// (`main/services/deeplinks/localProjectResolution.ts`,
// `resolveRemoteProjectBinding` in `main/services/ipc/runtimeBridge.ts`):
// find the machine by account key, connect it, match the project (id, then the
// legacy root path, then the repo), open it, then check the chat or lane is
// still there. Every step that can fail says which step and how to go on.
// Keep the three in step.
// ---------------------------------------------------------------------------

import {
  accountProjectIdOfTarget,
  ownershipOfTarget,
  type DeeplinkOwnership,
  type DeeplinkTarget,
} from "../../../shared/deeplinks";
export { ownershipOfTarget } from "../../../shared/deeplinks";
import type { SyncMobileProjectSummary } from "../../../shared/types/sync";
import type { WebMachineEntry } from "../workspace/webWorkspaceModel";
import { targetToWebPath } from "./webRoutes";

/** The GitHub repo a target names, when it names one. */
function targetRepo(target: DeeplinkTarget): { owner: string; name: string } | null {
  if (target.kind === "pr") {
    return target.repoOwner && target.repoName ? { owner: target.repoOwner, name: target.repoName } : null;
  }
  if (target.kind === "session" || target.kind === "lane") {
    const envelope = target.envelope;
    return envelope?.repoOwner && envelope.repoName
      ? { owner: envelope.repoOwner, name: envelope.repoName }
      : null;
  }
  return null;
}

/** The machine an ownership key names, among this account's machines. */
export function findOwnerMachine(
  machines: readonly WebMachineEntry[],
  accountMachineKey: string,
): WebMachineEntry | null {
  return machines.find((machine) => machine.accountMachine?.machineKey === accountMachineKey) ?? null;
}

/**
 * Comparison key for a project root from the owning machine, whose OS this
 * browser does not know. The path's own shape decides: a drive letter or a
 * backslash means Windows. `fold` gives the case-insensitive reading; callers
 * try the exact key first, as `matchRemoteProjectByRootPath` does.
 */
function rootKey(value: string, fold: boolean): string {
  const trimmed = value.trim();
  const windows = /^[a-z]:[\\/]/i.test(trimmed) || trimmed.includes("\\");
  let key = windows ? trimmed.replace(/\\/g, "/") : trimmed;
  key = key.replace(/\/{2,}/g, "/");
  if (key.length > 1 && !/^[a-z]:\/$/i.test(key)) key = key.replace(/\/+$/, "");
  return fold || windows ? key.toLowerCase() : key;
}

function matchByRoot(
  projects: readonly SyncMobileProjectSummary[],
  projectRoot: string,
): SyncMobileProjectSummary | null {
  const exactKey = rootKey(projectRoot, false);
  const exact = projects.find((project) => project.rootPath && rootKey(project.rootPath, false) === exactKey);
  if (exact) return exact;
  const foldedKey = rootKey(projectRoot, true);
  const folded = projects.filter((project) => project.rootPath && rootKey(project.rootPath, true) === foldedKey);
  return folded.length === 1 ? folded[0]! : null;
}

function matchByRepo(
  projects: readonly SyncMobileProjectSummary[],
  repo: { owner: string; name: string },
): SyncMobileProjectSummary | null {
  const owner = repo.owner.toLowerCase();
  const name = repo.name.toLowerCase();
  const matches = projects.filter((project) => (
    project.repoOwner?.toLowerCase() === owner && project.repoName?.toLowerCase() === name
  ));
  if (matches.length === 1) return matches[0]!;
  // Two clones of one repo: only the one open on that machine is a safe guess.
  const open = matches.filter((project) => project.isOpen);
  return open.length === 1 ? open[0]! : null;
}

export type OwnedProjectMatch =
  | { kind: "found"; project: SyncMobileProjectSummary }
  | { kind: "missing" }
  /** The machine's catalog has nothing to match a link against: ADE there is too old. */
  | { kind: "outdated" };

/**
 * Which of the owning machine's projects a link means: exact catalog id, then
 * the root path a legacy link carried, then the link's repo against the
 * catalog's repo. Never guesses between two equally good candidates.
 */
export function matchOwnedProject(
  projects: readonly SyncMobileProjectSummary[],
  ownership: DeeplinkOwnership,
  target: DeeplinkTarget,
): OwnedProjectMatch {
  const byId = projects.find((project) => project.id === ownership.projectId);
  if (byId) return { kind: "found", project: byId };
  if (ownership.projectRoot) {
    const byRoot = matchByRoot(projects, ownership.projectRoot);
    if (byRoot) return { kind: "found", project: byRoot };
  }
  const repo = targetRepo(target);
  if (repo) {
    const byRepo = matchByRepo(projects, repo);
    if (byRepo) return { kind: "found", project: byRepo };
  }
  // Current hosts publish canonical `project_…` ids and the repo fields (as
  // strings or nulls). A catalog with neither came from an ADE that predates
  // shareable links, so "not there" would be a guess.
  const outdated = projects.length > 0 && projects.every((project) => (
    project.repoOwner === undefined && !project.id.startsWith("project_")
  ));
  return outdated ? { kind: "outdated" } : { kind: "missing" };
}

export type OwnedLinkStage =
  | { kind: "connecting"; machineName: string }
  | { kind: "opening"; machineName: string; projectName: string }
  | { kind: "finding"; entity: "chat" | "lane"; projectName: string };

export function ownedLinkStageText(stage: OwnedLinkStage): string {
  switch (stage.kind) {
    case "connecting":
      return `Connecting to ${stage.machineName}…`;
    case "opening":
      return `Opening ${stage.projectName} on ${stage.machineName}…`;
    case "finding":
      return `Finding the ${stage.entity} in ${stage.projectName}…`;
  }
}

export type OwnedLinkFailureKind =
  | "machine-unknown"
  | "directory-unavailable"
  | "machine-offline"
  | "connect-failed"
  | "project-missing"
  | "host-outdated"
  | "open-failed"
  | "entity-missing"
  /** The link's account project was removed from the account. */
  | "project-removed"
  /** The account does not hold the link's account project. */
  | "project-unknown"
  /** No computer that is online has a copy; the repository opened with no machine. */
  | "no-copy";

export type OwnedLinkFailure = {
  kind: OwnedLinkFailureKind;
  title: string;
  detail?: string;
  /** Trying again can help (the machine may come up, the project may be added). */
  retryable: boolean;
  /** "Your computers" is the way forward (the machine is the problem). */
  offerComputers: boolean;
  /** The opened project's route to land on, when the project did open. */
  projectPath?: string;
};

export type OwnedLinkResult =
  | { ok: true; path: string; targetId: string; projectId: string }
  | { ok: false; failure: OwnedLinkFailure };

export type OwnedLinkResolverDeps = {
  /** Merged machine rows for the signed-in account, read fresh. */
  machines(): WebMachineEntry[];
  /** The account directory could not be read, so "not in your account" is unknown. */
  directoryUnavailable(): boolean;
  /** Connect the machine (live session reused) and return its target id. */
  connect(machine: WebMachineEntry): Promise<string>;
  /** That machine's live project catalog. */
  catalog(targetId: string): SyncMobileProjectSummary[];
  /** Open (or re-bind to) the project. Already-open projects are not switched again. */
  openProject(targetId: string, projectId: string): Promise<void>;
  /** True/false when the owning machine answered; null when it could not say. */
  sessionExists(sessionId: string): Promise<boolean | null>;
  laneExists(laneId: string): Promise<boolean | null>;
  onStage(stage: OwnedLinkStage): void;
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message.trim() : String(error ?? "").trim();
}

/**
 * Connect, open and check, in that order. Resolves the route to navigate to,
 * or the failure to show. Never throws.
 */
export async function resolveOwnedLink(
  target: DeeplinkTarget,
  ownership: DeeplinkOwnership,
  deps: OwnedLinkResolverDeps,
): Promise<OwnedLinkResult> {
  const machine = findOwnerMachine(deps.machines(), ownership.accountMachineKey);
  if (!machine) {
    if (deps.directoryUnavailable()) {
      return {
        ok: false,
        failure: {
          kind: "directory-unavailable",
          title: "ADE couldn't load your computers to open this link.",
          retryable: true,
          offerComputers: false,
        },
      };
    }
    return {
      ok: false,
      failure: {
        kind: "machine-unknown",
        title: "This link is from a computer that isn't in your ADE account.",
        detail: "Sign in with the ADE account that computer uses to open it.",
        retryable: true,
        offerComputers: true,
      },
    };
  }

  const machineName = machine.name;
  const offline = {
    ok: false as const,
    failure: {
      kind: "machine-offline" as const,
      title: `${machineName} is offline. Start ADE there, then try again.`,
      retryable: true,
      offerComputers: true,
    },
  };
  if (machine.status === "offline") return offline;

  deps.onStage({ kind: "connecting", machineName });
  let targetId: string;
  try {
    targetId = await deps.connect(machine);
  } catch (error) {
    const detail = errorText(error);
    if (/offline|not reachable|unreachable|timed out|timeout/i.test(detail)) return offline;
    return {
      ok: false,
      failure: {
        kind: "connect-failed",
        title: `Couldn't connect to ${machineName}.`,
        ...(detail ? { detail } : {}),
        retryable: true,
        offerComputers: true,
      },
    };
  }

  const repo = targetRepo(target);
  const match = matchOwnedProject(deps.catalog(targetId), ownership, target);
  if (match.kind === "outdated") {
    return {
      ok: false,
      failure: {
        kind: "host-outdated",
        title: `Update ADE on ${machineName} to open links from the web.`,
        retryable: true,
        offerComputers: false,
      },
    };
  }
  if (match.kind === "missing") {
    return {
      ok: false,
      failure: {
        kind: "project-missing",
        title: repo?.name ? `The ${repo.name} project isn't in ADE on ${machineName}.` : `That project isn't in ADE on ${machineName}.`,
        detail: "Add the project in ADE on that computer, then try again.",
        retryable: true,
        offerComputers: false,
      },
    };
  }

  const project = match.project;
  const projectName = project.displayName || repo?.name || "the project";
  deps.onStage({ kind: "opening", machineName, projectName });
  try {
    await deps.openProject(targetId, project.id);
  } catch (error) {
    const detail = errorText(error);
    return {
      ok: false,
      failure: {
        kind: "open-failed",
        title: `Couldn't open ${projectName} on ${machineName}.`,
        ...(detail ? { detail } : {}),
        retryable: true,
        offerComputers: false,
      },
    };
  }

  const done = { ok: true as const, path: targetToWebPath(target), targetId, projectId: project.id };
  if (target.kind !== "session" && target.kind !== "lane") return done;

  const entity = target.kind === "session" ? "chat" : "lane";
  deps.onStage({ kind: "finding", entity, projectName });
  let exists: boolean | null;
  try {
    exists = target.kind === "session"
      ? await deps.sessionExists(target.sessionId)
      : await deps.laneExists(target.laneId);
  } catch {
    exists = null;
  }
  // Only a definite "no" is a failure: a host that could not answer still gets
  // the route, and the page shows what it finds.
  if (exists !== false) return done;
  return {
    ok: false,
    failure: {
      kind: "entity-missing",
      title: `That ${entity} isn't in ${projectName} any more.`,
      retryable: false,
      offerComputers: false,
      projectPath: entity === "chat" ? "/work" : "/lanes",
    },
  };
}

/**
 * Move the mounted app to `path` from outside its router. The shared App's
 * `BrowserHashRouteBridge` turns a `#/route` hash into a replace navigation,
 * which is the one door the hosted shell has into the router once it is up.
 */
export function navigateMountedApp(path: string): void {
  if (!path.startsWith("/")) return;
  window.location.hash = `#${path}`;
}

/** A link this resolver handles: one with an owner pair or an account project id. */
export function isOwnedOrAccountLink(target: DeeplinkTarget | null | undefined): target is DeeplinkTarget {
  return Boolean(target && (ownershipOfTarget(target) || accountProjectIdOfTarget(target)));
}
