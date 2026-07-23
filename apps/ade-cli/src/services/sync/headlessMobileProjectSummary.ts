import { mobileProjectRepositoryIdentityFromGitOrigin } from "../../../../desktop/src/shared/syncMobileProjectIdentity";
import type { SyncMobileProjectSummary } from "../../../../desktop/src/shared/types/sync";
import type { ProjectRecord } from "../projects/projectRegistry";

/**
 * Build the project-catalog row emitted by the machine-owned headless brain.
 * Keep its defaults here so paired and relay clients receive the same wire
 * shape regardless of which catalog path sent it.
 */
export function headlessMobileProjectSummary(
  record: ProjectRecord,
  iconDataUrl: string | null,
  overrides: Partial<SyncMobileProjectSummary> = {},
): SyncMobileProjectSummary {
  return {
    id: record.projectId,
    displayName: record.displayName,
    rootPath: record.rootPath,
    ...mobileProjectRepositoryIdentityFromGitOrigin(record.gitOriginUrl),
    defaultBaseRef: null,
    lastOpenedAt:
      record.lastOpenedAt > 0
        ? new Date(record.lastOpenedAt).toISOString()
        : null,
    iconDataUrl,
    laneCount: 0,
    isAvailable: true,
    isCached: true,
    isOpen: false,
    ...overrides,
  };
}
