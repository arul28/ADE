import type { ProjectInfo } from "../../../../shared/types";
import type { SyncBrainStatusPayload, SyncMobileProjectSummary } from "../../../../shared/types/sync";
import type { AdeSyncClient } from "../../sync";

export type AdapterProjectState = {
  bindProject(project: ProjectInfo | null): void;
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
    bindProject(nextProject: ProjectInfo | null): void {
      project = nextProject;
    },
    getProject(): ProjectInfo | null {
      return project;
    },
    getProjectId(): string | null {
      const activeProjectId = client.getStatus().activeProjectId;
      if (activeProjectId) return activeProjectId;
      if (!project) return null;
      return catalogProjects.find((entry) => entry.rootPath === project?.rootPath)?.id ?? null;
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
