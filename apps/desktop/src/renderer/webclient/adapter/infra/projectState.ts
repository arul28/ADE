import type { ProjectInfo } from "../../../../shared/types";
import type { SyncBrainStatusPayload, SyncMobileProjectSummary } from "../../../../shared/types/sync";
import type { AdeSyncClient } from "../../sync";

export type AdapterProjectState = {
  bindProject(project: ProjectInfo | null, projectId?: string | null): void;
  getProject(): ProjectInfo | null;
  getProjectId(): string | null;
  getCatalogProjects(): SyncMobileProjectSummary[];
  getOpenProjectTabs(): ProjectInfo[];
  getBrainStatus(): SyncBrainStatusPayload | null;
  setBrainStatus(status: SyncBrainStatusPayload | null): void;
  updateCatalog(projects: SyncMobileProjectSummary[]): void;
  dispose(): void;
};

export function projectInfoFromCatalog(project: SyncMobileProjectSummary): ProjectInfo {
  return {
    rootPath: project.rootPath ?? "",
    displayName: project.displayName,
    baseRef: project.defaultBaseRef ?? "main",
  };
}

export function createProjectState(client: AdeSyncClient): AdapterProjectState {
  let project: ProjectInfo | null = null;
  let boundProjectId: string | null = null;
  let catalogProjects: SyncMobileProjectSummary[] = [];
  let brainStatus: SyncBrainStatusPayload | null = null;
  const disposers: Array<() => void> = [];

  function updateCatalog(projects: SyncMobileProjectSummary[]): void {
    catalogProjects = projects.slice();
  }

  disposers.push(
    client.onProjectCatalog((payload) => {
      updateCatalog(payload.projects);
    })
  );

  return {
    bindProject(nextProject: ProjectInfo | null, projectId?: string | null): void {
      project = nextProject;
      boundProjectId = nextProject ? projectId ?? null : null;
    },
    getProject(): ProjectInfo | null {
      return project;
    },
    getProjectId(): string | null {
      // The shell binds the selected project immediately after a switch. During
      // reconnect, the sync client's persisted activeProjectId can briefly
      // still name the prior project. Prefer the bound catalog entry so file
      // requests and project commands cannot be stamped with that stale id.
      if (project) {
        if (boundProjectId) return boundProjectId;
        const catalogProjectId = catalogProjects.find(
          (entry) => entry.rootPath === project?.rootPath,
        )?.id;
        if (catalogProjectId) return catalogProjectId;
        return null;
      }
      return client.getStatus().activeProjectId ?? null;
    },
    getCatalogProjects(): SyncMobileProjectSummary[] {
      return catalogProjects.slice();
    },
    getOpenProjectTabs(): ProjectInfo[] {
      const open = catalogProjects.filter((entry) => entry.isOpen).map(projectInfoFromCatalog);
      if (!project) return open;
      return open.some((entry) => entry.rootPath === project?.rootPath) ? open : [project, ...open];
    },
    getBrainStatus(): SyncBrainStatusPayload | null {
      return brainStatus;
    },
    setBrainStatus(status: SyncBrainStatusPayload | null): void {
      brainStatus = status;
    },
    updateCatalog,
    dispose(): void {
      for (const dispose of disposers.splice(0)) dispose();
    },
  };
}
