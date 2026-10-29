import type {
  LaneTemplate,
  LaneEnvInitConfig,
} from "../../../shared/types";

import type { Logger } from "../logging/logger";
import type { createProjectConfigService } from "../config/projectConfigService";
import type { NewLaneSettingsStore } from "./newLaneSettingsStore";

/**
 * Lane templates and the default one.
 *
 * A project's own templates and its default template live in the project's
 * new-lane settings (account settings for the repository when the host has
 * them), so they follow the user to every computer. Templates committed in the
 * shared `.ade/ade.yaml` still appear for everyone.
 */
export function createLaneTemplateService({
  projectConfigService,
  logger,
  newLaneSettings,
}: {
  projectConfigService: ReturnType<typeof createProjectConfigService>;
  logger: Logger;
  newLaneSettings: NewLaneSettingsStore;
}) {

  /** Templates from the shared `.ade/ade.yaml`, which no account copy replaces. */
  function sharedTemplates(): LaneTemplate[] {
    const snapshot = projectConfigService.get();
    const localIds = new Set((snapshot.local.laneTemplates ?? []).map((template) => template.id));
    return (snapshot.effective.laneTemplates ?? []).filter((template) => !localIds.has(template.id));
  }

  function listTemplates(): LaneTemplate[] {
    const own = newLaneSettings.getTemplates();
    const ownIds = new Set(own.map((template) => template.id));
    return [...sharedTemplates().filter((template) => !ownIds.has(template.id)), ...own];
  }

  function getTemplate(templateId: string): LaneTemplate | null {
    const templates = listTemplates();
    return templates.find((t) => t.id === templateId) ?? null;
  }

  function getDefaultTemplateId(): string | null {
    const templateId = newLaneSettings.getDefaults().templateId;
    return templateId && listTemplates().some((template) => template.id === templateId) ? templateId : null;
  }

  function setDefaultTemplateId(templateId: string | null): void {
    if (templateId && !listTemplates().some((template) => template.id === templateId)) {
      throw new Error(`Unknown lane template: ${templateId}`);
    }
    newLaneSettings.setDefaults({ ...newLaneSettings.getDefaults(), templateId: templateId ?? null });
    logger.info("lane_template.default_set", { templateId });
  }

  function resolveTemplateAsEnvInit(template: LaneTemplate): LaneEnvInitConfig {
    return {
      envFiles: template.envFiles,
      docker: template.docker,
      dependencies: template.dependencies,
      mountPoints: template.mountPoints,
      copyPaths: template.copyPaths,
      // Carried into env init so the configured setup script actually runs;
      // `laneEnvironmentService` executes it as the final step.
      setupScript: template.setupScript,
    };
  }

  function saveTemplate(template: LaneTemplate): void {
    const own = newLaneSettings.getTemplates().filter((entry) => entry.id !== template.id);
    newLaneSettings.setTemplates([...own, template]);
    logger.info("lane_template.saved", { templateId: template.id });
  }

  function deleteTemplate(templateId: string): void {
    const own = newLaneSettings.getTemplates();
    const filtered = own.filter((entry) => entry.id !== templateId);
    if (filtered.length === own.length) throw new Error(`Template not found: ${templateId}`);
    newLaneSettings.setTemplates(filtered);
    const defaults = newLaneSettings.getDefaults();
    if (defaults.templateId === templateId) newLaneSettings.setDefaults({ ...defaults, templateId: null });
    logger.info("lane_template.deleted", { templateId });
  }

  return {
    listTemplates,
    getTemplate,
    getDefaultTemplateId,
    setDefaultTemplateId,
    resolveTemplateAsEnvInit,
    saveTemplate,
    deleteTemplate,
  };
}
