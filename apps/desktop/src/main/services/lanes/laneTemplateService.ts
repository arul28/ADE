import type {
  LaneTemplate,
  LaneEnvInitConfig,
} from "../../../shared/types";
import { NO_DEFAULT_LANE_TEMPLATE } from "../../../shared/types";

import type { Logger } from "../logging/logger";
import type { createProjectConfigService } from "../config/projectConfigService";
import type { NewLaneSettingsStore } from "./newLaneSettingsStore";

/**
 * Lane templates and the default one.
 *
 * With `getNewLaneSettings` wired (the brain does), a project's own templates
 * and its default template are account settings for the repository, so they
 * follow the user to every computer. Templates committed in the shared
 * `.ade/ade.yaml` still appear for everyone. Without it (tests, a host with
 * no account store), they stay in this computer's `.ade/local.yaml`.
 */
export function createLaneTemplateService({
  projectConfigService,
  logger,
  getNewLaneSettings,
}: {
  projectConfigService: ReturnType<typeof createProjectConfigService>;
  logger: Logger;
  getNewLaneSettings?: () => NewLaneSettingsStore | null;
}) {
  const accountSettings = (): NewLaneSettingsStore | null => getNewLaneSettings?.() ?? null;

  /** Templates from the shared `.ade/ade.yaml`, which no account copy replaces. */
  function sharedTemplates(): LaneTemplate[] {
    const snapshot = projectConfigService.get();
    const localIds = new Set((snapshot.local.laneTemplates ?? []).map((template) => template.id));
    return (snapshot.effective.laneTemplates ?? []).filter((template) => !localIds.has(template.id));
  }

  function listTemplates(): LaneTemplate[] {
    const store = accountSettings();
    if (!store) return projectConfigService.get().effective.laneTemplates ?? [];
    const own = store.getTemplates();
    const ownIds = new Set(own.map((template) => template.id));
    return [...sharedTemplates().filter((template) => !ownIds.has(template.id)), ...own];
  }

  function getTemplate(templateId: string): LaneTemplate | null {
    const templates = listTemplates();
    return templates.find((t) => t.id === templateId) ?? null;
  }

  function getDefaultTemplateId(): string | null {
    const store = accountSettings();
    if (store) {
      const templateId = store.getDefaults().templateId;
      return templateId && listTemplates().some((template) => template.id === templateId) ? templateId : null;
    }
    const snapshot = projectConfigService.get();
    const templateId = snapshot.effective.defaultLaneTemplate ?? null;
    if (!templateId || templateId === NO_DEFAULT_LANE_TEMPLATE) return null;
    return listTemplates().some((template) => template.id === templateId) ? templateId : null;
  }

  function setDefaultTemplateId(templateId: string | null): void {
    if (templateId && !listTemplates().some((template) => template.id === templateId)) {
      throw new Error(`Unknown lane template: ${templateId}`);
    }
    const store = accountSettings();
    if (store) {
      store.setDefaults({ ...store.getDefaults(), templateId: templateId ?? null });
      logger.info("lane_template.default_set", { templateId });
      return;
    }
    const snapshot = projectConfigService.get();
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
      copyPaths: template.copyPaths,
      // Carried into env init so the configured setup script actually runs;
      // `laneEnvironmentService` executes it as the final step.
      setupScript: template.setupScript,
    };
  }

  function saveTemplate(template: LaneTemplate): void {
    const store = accountSettings();
    if (store) {
      const own = store.getTemplates().filter((entry) => entry.id !== template.id);
      store.setTemplates([...own, template]);
      logger.info("lane_template.saved", { templateId: template.id });
      return;
    }
    const snapshot = projectConfigService.get();
    const existing = [...(snapshot.local.laneTemplates ?? [])];
    const idx = existing.findIndex((t) => t.id === template.id);
    if (idx >= 0) {
      existing[idx] = template;
    } else {
      existing.push(template);
    }
    const nextLocal = { ...snapshot.local, laneTemplates: existing };
    projectConfigService.save({ shared: snapshot.shared, local: nextLocal });
    logger.info("lane_template.saved", { templateId: template.id });
  }

  function deleteTemplate(templateId: string): void {
    const store = accountSettings();
    if (store) {
      const own = store.getTemplates();
      const filtered = own.filter((entry) => entry.id !== templateId);
      if (filtered.length === own.length) throw new Error(`Template not found: ${templateId}`);
      store.setTemplates(filtered);
      const defaults = store.getDefaults();
      if (defaults.templateId === templateId) store.setDefaults({ ...defaults, templateId: null });
      logger.info("lane_template.deleted", { templateId });
      return;
    }
    const snapshot = projectConfigService.get();
    const existing = [...(snapshot.local.laneTemplates ?? [])];
    const filtered = existing.filter((t) => t.id !== templateId);
    if (filtered.length === existing.length) {
      throw new Error(`Template not found: ${templateId}`);
    }
    const nextLocal = { ...snapshot.local, laneTemplates: filtered };
    // Clear default if we're deleting the default template
    const currentDefault = snapshot.local.defaultLaneTemplate;
    if (currentDefault === templateId) {
      nextLocal.defaultLaneTemplate = snapshot.shared.defaultLaneTemplate
        ? NO_DEFAULT_LANE_TEMPLATE
        : undefined;
    }
    projectConfigService.save({ shared: snapshot.shared, local: nextLocal });
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
