import type {
  LaneTemplate,
  LaneEnvInitConfig,
} from "../../../shared/types";

import type { Logger } from "../logging/logger";
import type { createProjectConfigService } from "../config/projectConfigService";

export function createLaneTemplateService({
  projectConfigService,
  logger,
}: {
  projectConfigService: ReturnType<typeof createProjectConfigService>;
  logger: Logger;
}) {
  function listTemplates(): LaneTemplate[] {
    const snapshot = projectConfigService.get();
    return snapshot.effective.laneTemplates ?? [];
  }

  function getTemplate(templateId: string): LaneTemplate | null {
    const templates = listTemplates();
    return templates.find((t) => t.id === templateId) ?? null;
  }

  function getDefaultTemplateId(): string | null {
    const snapshot = projectConfigService.get();
    return snapshot.effective.defaultLaneTemplate ?? null;
  }

  function setDefaultTemplateId(templateId: string | null): void {
    const snapshot = projectConfigService.get();
    snapshot.local.defaultLaneTemplate = templateId ?? undefined;
    projectConfigService.save({ shared: snapshot.shared, local: snapshot.local });
    logger.info("lane_template.default_set", { templateId });
  }

  function resolveTemplateAsEnvInit(template: LaneTemplate): LaneEnvInitConfig {
    return {
      envFiles: template.envFiles,
      docker: template.docker,
      dependencies: template.dependencies,
      mountPoints: template.mountPoints,
    };
  }

  return {
    listTemplates,
    getTemplate,
    getDefaultTemplateId,
    setDefaultTemplateId,
    resolveTemplateAsEnvInit,
  };
}
