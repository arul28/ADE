import os from "node:os";
import path from "node:path";
import { isInsideTempFolder } from "../../../../desktop/src/main/services/shared/pathCompare";
import type { AccountProjectView } from "../../../../desktop/src/shared/accountProject";
import { samePathOnPlatform } from "../../../../desktop/src/shared/pathContainment";
import { parseAccountProjectSelector, recordMatchesAccountProject, resolveAccountProject } from "../projects/accountProjectSelector";
import { readProjectFolderStates, type ProjectFolderState } from "../projects/projectFolderPresence";

/** A project registered on this computer, as ADE MCP sees it. */
export type RemoteMcpProject = {
  projectId: string;
  rootPath: string;
  displayName: string;
  lastOpenedAt: number;
  /** The account project this folder is a copy of, when known. */
  accountProjectId?: string | null;
  gitOriginUrl?: string | null;
};

/** Where a call runs: a project's folder, or the home folder when this computer has no project. */
export type ResolvedProject = { cwd: string; project: RemoteMcpProject | null };

/** An every-project sweep reads the projects opened in this window, newest first, at most this many. */
const EVERY_PROJECT_WINDOW_MS = 30 * 24 * 60 * 60_000;
const EVERY_PROJECT_MAX = 6;

/** Which project an ADE MCP call means, and what to say when its folder is gone. */
export function createRemoteMcpProjects(deps: {
  machineName: () => string;
  listProjects: () => RemoteMcpProject[];
  /** The account's projects as this computer last read them, or null when signed out or never read. */
  accountProjects?: () => Readonly<Record<string, AccountProjectView>> | null;
}) {
  /**
   * The registered projects with their folder's state, newest first. A
   * registry keeps projects whose folder was deleted (test projects in a temp
   * folder) or sits on a drive that is not plugged in; neither may win a name
   * or a default.
   */
  const projectsByState = async (projects: readonly RemoteMcpProject[]) => {
    const states = await readProjectFolderStates(projects);
    const stateOf = new Map<RemoteMcpProject, ProjectFolderState>(projects.map((project, index) => [project, states[index]!]));
    return { stateOf, ordered: byLastOpened([...projects]) };
  };
  /**
   * The projects a call may run in, newest first: those whose folder is
   * confirmed there, or, only when none is, those that could not be checked
   * in time (a hung network mount). Never a deleted folder or an unplugged drive.
   */
  const usableProjects = (ordered: readonly RemoteMcpProject[], stateOf: ReadonlyMap<RemoteMcpProject, ProjectFolderState>): RemoteMcpProject[] => {
    const present = ordered.filter((project) => stateOf.get(project) === "present");
    return present.length ? present : ordered.filter((project) => stateOf.get(project) === "unknown");
  };
  const byLastOpened = (projects: RemoteMcpProject[]): RemoteMcpProject[] =>
    projects.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);

  /** The projects an every-project sweep reads: opened in the last 30 days, at most six. */
  const recentProjects = async (): Promise<RemoteMcpProject[]> => {
    const { stateOf, ordered } = await projectsByState(deps.listProjects());
    const projects = usableProjects(ordered, stateOf);
    const cutoff = Date.now() - EVERY_PROJECT_WINDOW_MS;
    const recent = projects.filter((project) => project.lastOpenedAt >= cutoff);
    return (recent.length ? recent : projects.slice(0, 1)).slice(0, EVERY_PROJECT_MAX);
  };

  const describeCandidate = (project: RemoteMcpProject): string => `${project.displayName} (id ${project.projectId}, ${project.rootPath})`;
  const driveNotConnected = (project: RemoteMcpProject): string =>
    `${project.displayName}'s drive isn't connected on ${deps.machineName()} (${project.rootPath}). `
    + "Connect it, or pick another project.";
  const folderGone = (project: RemoteMcpProject): string =>
    `${project.displayName}'s folder is gone (${project.rootPath}). Clone it again with projects_clone, `
    + "or remove the stale entry with [\"projects\",\"prune\"].";
  /**
   * What a run says when its folder vanished between the pick and the start,
   * from a fresh look at the folder: a deleted folder on a drive that is
   * plugged in is gone, not disconnected.
   */
  const missingFolderMessage = async (project: RemoteMcpProject | null, cwd: string): Promise<string> => {
    if (!project) return `The folder ${cwd} isn't on ${deps.machineName()}.`;
    const [state] = await readProjectFolderStates([project], { fresh: true });
    if (state === "driveMissing") return driveNotConnected(project);
    if (state === "gone") return folderGone(project);
    return `${project.displayName}'s folder (${project.rootPath}) can't be read on ${deps.machineName()} right now. Try again shortly.`;
  };

  /**
   * The project a call runs in. Without `project`, the most recently opened
   * one whose folder is there, which changes when the person opens another:
   * every result names it, so a call never lands in a different repo
   * unnoticed. An id or path picks exactly; a name picks among the projects
   * whose folder is there, and two with the same name are refused with both.
   */
  const resolveProject = async (requested: unknown): Promise<ResolvedProject | { error: string }> => {
    const all = deps.listProjects();
    const { stateOf, ordered } = await projectsByState(all);
    const found = (project: RemoteMcpProject): ResolvedProject => ({ cwd: project.rootPath, project });
    const refusal = (project: RemoteMcpProject) => ({
      error: stateOf.get(project) === "driveMissing" ? driveNotConnected(project) : folderGone(project),
    });
    const usable = usableProjects(ordered, stateOf);
    if (typeof requested !== "string" || !requested.trim()) {
      // A throwaway test project must not become where an app's call lands.
      const recent = usable.find((project) => !isInsideTempFolder(project.rootPath)) ?? usable[0];
      // No project at all: machine-wide commands (`projects list`, `doctor`) still work.
      return recent ? found(recent) : { cwd: os.homedir(), project: null };
    }
    const wanted = requested.trim();
    const lower = wanted.toLowerCase();
    // Asked for by id or path: run there unless it is known to be unreachable.
    const reachable = (project: RemoteMcpProject) => {
      const state = stateOf.get(project);
      return state === "present" || state === "unknown";
    };
    const exact = all.filter((project) =>
      project.projectId === wanted
      || (path.isAbsolute(wanted) && samePathOnPlatform(project.rootPath, wanted)));
    if (exact.length === 1) return reachable(exact[0]!) ? found(exact[0]!) : refusal(exact[0]!);
    const named = ordered.filter((project) =>
      project.displayName.toLowerCase() === lower || path.basename(project.rootPath).toLowerCase() === lower);
    const namedPresent = named.filter((project) => stateOf.get(project) === "present");
    const liveNamed = namedPresent.length ? namedPresent : named.filter((project) => stateOf.get(project) === "unknown");
    if (liveNamed.length === 1) return found(liveNamed[0]!);
    if (liveNamed.length > 1) {
      return {
        error: `More than one project is called "${wanted}": ${liveNamed.map(describeCandidate).join("; ")}. Pass its id or path as \`project\`.`,
      };
    }
    if (named.length > 0) return refusal(named.find((project) => stateOf.get(project) === "driveMissing") ?? named[0]!);
    // An account project id (`ap_…`) or a GitHub `owner/name` (L30).
    const selector = parseAccountProjectSelector(wanted);
    if (selector) {
      const resolvedAccount = resolveAccountProject(selector, deps.accountProjects?.() ?? {});
      if (resolvedAccount.kind === "removed") {
        return { error: `${resolvedAccount.name} was removed from the ADE account. Add it again from ADE to use it.` };
      }
      if (resolvedAccount.kind === "found") {
        const copies = usable.filter((project) => recordMatchesAccountProject(project, resolvedAccount));
        if (copies.length > 0) return found(copies[0]!);
        return {
          error: `${resolvedAccount.name} has no copy on ${deps.machineName()}. `
            + "Run on a machine that has one, or add one here with projects_clone.",
        };
      }
      if (selector.kind === "id") {
        return { error: `The ADE account has no project ${wanted}, or ${deps.machineName()} has not read the account's projects yet.` };
      }
    }
    const known = usable.map((project) => project.displayName).join(", ") || "none";
    return { error: `No project "${wanted}" on this machine. Projects: ${known}. A new repository can be added with projects_clone.` };
  };

  /** The projects to pick from, last opened first. */
  const projectChoices = async (): Promise<RemoteMcpProject[]> => {
    const { stateOf, ordered } = await projectsByState(deps.listProjects());
    return usableProjects(ordered, stateOf).slice(0, 8);
  };

  return { resolveProject, recentProjects, missingFolderMessage, projectChoices };
}
