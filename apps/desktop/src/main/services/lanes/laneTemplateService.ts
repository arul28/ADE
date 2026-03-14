import type {
  LaneTemplate,
  LaneEnvInitConfig,
} from "../../../shared/types";
import { NO_DEFAULT_LANE_TEMPLATE } from "../../../shared/types";

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
    const templateId = snapshot.effective.defaultLaneTemplate ?? null;
    if (!templateId || templateId === NO_DEFAULT_LANE_TEMPLATE) return null;
    return listTemplates().some((template) => template.id === templateId) ? templateId : null;
  }

  function setDefaultTemplateId(templateId: string | null): void {
    const snapshot = projectConfigService.get();
    if (templateId && !listTemplates().some((template) => template.id === templateId)) {
      throw new Error(`Unknown lane template: ${templateId}`);
    }
    const nextLocal = {
      ...snapshot.local,
      defaultLaneTemplate: templateId
        ? templateId
        : snapshot.shared.defaultLaneTemplate
          ? NO_DEFAULT_LANE_TEMPLATE
          : undefined,
    };
    projectConfigService.save({ shared: snapshot.shared, local: nextLocal });
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
