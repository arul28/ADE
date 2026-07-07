import type { ProjectInfo } from "../../../shared/types";
import type { SyncMobileProjectSummary } from "../../../shared/types/sync";
import type { AdapterInfra, AdeNamespace } from "./types";
import { projectInfoFromCatalog } from "./infra/projectState";

export function createProjectNamespace(infra: AdapterInfra): AdeNamespace<"project"> {
  const { client, events, localState, state } = infra;

  async function refreshCatalog(): Promise<SyncMobileProjectSummary[]> {
    const catalog = await client.getProjectCatalog().catch(() => ({ projects: state.getCatalogProjects() }));
    state.updateCatalog(catalog.projects);
    return catalog.projects;
  }

  async function listRecent() {
    const projects = await refreshCatalog();
    return projects.map((project) => ({
      rootPath: project.rootPath,
      displayName: project.displayName,
      baseRef: project.defaultBaseRef,
      lastOpenedAt: project.lastOpenedAt,
      isAvailable: project.isAvailable,
      isCached: project.isCached,
      isOpen: project.isOpen,
      iconDataUrl: project.iconDataUrl ?? null,
    })) as never;
  }

  async function switchToProject(project: SyncMobileProjectSummary): Promise<ProjectInfo> {
    const result = await client.switchProject(project.id);
    const nextProject =
      result.ok && result.project
        ? {
            rootPath: result.project.rootPath ?? project.rootPath ?? "",
            displayName: result.project.displayName,
            baseRef: result.project.defaultBaseRef ?? project.defaultBaseRef ?? "main",
          }
        : projectInfoFromCatalog(project);
    state.bindProject(nextProject);
    events.emit("projectChanged", nextProject);
    events.emit("projectBindingChanged", null);
    return nextProject;
  }

  async function switchToPath(rootPath: string): Promise<ProjectInfo> {
    const projects = await refreshCatalog();
    const project = projects.find((entry) => entry.rootPath === rootPath);
    if (!project) {
      events.emit("projectMissing", { rootPath });
      return state.getProject() ?? { rootPath, displayName: rootPath.split("/").pop() || rootPath, baseRef: "main" };
    }
    return await switchToProject(project);
  }

  const projectNamespace: Record<string, unknown> = {
    async listRecent() {
      return await listRecent();
    },
    async getCurrent() {
      return state.getProject();
    },
    async getProject() {
      return state.getProject();
    },
    switchToPath,
    async openRepo(args: string | { rootPath?: string | null } = {}) {
      const rootPath = typeof args === "string" ? args : args.rootPath;
      if (!rootPath) return state.getProject();
      return await switchToPath(rootPath);
    },
    async closeCurrent() {
      state.bindProject(null);
      events.emit("projectChanged", null);
      events.emit("projectBindingChanged", null);
    },
    async browseDirectories() {
      const projects = await refreshCatalog();
      return {
        inputPath: "",
        resolvedPath: "",
        directoryPath: "",
        parentPath: null,
        exactDirectoryPath: null,
        openableProjectRoot: null,
        entries: projects.map((project) => ({
          kind: "directory",
          path: project.rootPath ?? "",
          name: project.displayName,
          displayName: project.displayName,
        })),
      };
    },
    async getDetail(rootPath: string) {
      const project = state.getCatalogProjects().find((entry) => entry.rootPath === rootPath);
      return project
        ? {
            rootPath: project.rootPath ?? rootPath,
            isGitRepo: true,
            branchName: project.defaultBaseRef ?? null,
            dirtyCount: null,
            dirtyBreakdown: null,
            aheadBehind: null,
            lastCommit: null,
            readmeExcerpt: null,
            languages: [],
            laneCount: project.laneCount ?? null,
            lastOpenedAt: project.lastOpenedAt,
            subdirectoryCount: null,
          }
        : {
            rootPath,
            isGitRepo: false,
            branchName: null,
            dirtyCount: null,
            dirtyBreakdown: null,
            aheadBehind: null,
            lastCommit: null,
            readmeExcerpt: null,
            languages: [],
            laneCount: null,
            lastOpenedAt: null,
            subdirectoryCount: null,
          };
    },
    async resolveIcon(rootPath: string) {
      return {
        dataUrl: state.getCatalogProjects().find((entry) => entry.rootPath === rootPath)?.iconDataUrl ?? null,
        sourcePath: null,
        mimeType: null,
      };
    },
    async chooseDirectory() {
      return null;
    },
    async chooseIcon() {
      return null;
    },
    async saveIcon() {
      return { ok: false, error: "unsupported" };
    },
    async removeIcon() {
      return { dataUrl: null, sourcePath: null, mimeType: null };
    },
    async forget(rootPath: string) {
      localState.set(
        "forgottenProjects",
        Array.from(new Set([...localState.get<string[]>("forgottenProjects", []), rootPath]))
      );
      return await listRecent();
    },
    async setPinned(rootPath: string, pinned: boolean) {
      const pinnedProjects = new Set(localState.get<string[]>("pinnedProjects", []));
      if (pinned) pinnedProjects.add(rootPath);
      else pinnedProjects.delete(rootPath);
      localState.set("pinnedProjects", Array.from(pinnedProjects));
      return await listRecent();
    },
    async reorder(rootPaths: string[]) {
      localState.set("projectOrder", rootPaths);
      return await listRecent();
    },
    getDroppedPath() {
      return "";
    },
    onMissing(listener: (event: { rootPath: string }) => void) {
      return events.on("projectMissing", listener);
    },
    onStateEvent() {
      return () => {};
    },
  };
  return projectNamespace as AdeNamespace<"project">;
}
