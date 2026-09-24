import type { LaneEnvInitConfig, LaneEnvInitProgress, LaneTemplate } from "../../../shared/types";
import { mergeLaneEnvInitConfig, mergeLaneOverrides } from "./laneEnvInitMerge";
import { resolveLaneOverlayContext, type LaneOverlayContextDependencies } from "./laneOverlayContext";
import type { createLaneEnvironmentService } from "./laneEnvironmentService";
import type { createLaneTemplateService } from "./laneTemplateService";

/**
 * The one way a lane's environment is set up after creation: with a lane
 * template (merged over the project's lane-environment config), or with the
 * project config alone. Shared by the `lane.initEnv` / `lane.applyTemplate`
 * actions, the sync host's `lanes.initEnv` / `lanes.applyTemplate` commands,
 * and the chat-launch service so they can never drift.
 */
export type LaneEnvironmentSetupDeps = LaneOverlayContextDependencies & {
  laneEnvironmentService: ReturnType<typeof createLaneEnvironmentService>;
  laneTemplateService?: Pick<ReturnType<typeof createLaneTemplateService>, "getTemplate" | "resolveTemplateAsEnvInit"> | null;
};

export async function runLaneEnvironmentSetup(
  deps: LaneEnvironmentSetupDeps,
  args: {
    laneId: string;
    templateId?: string | null;
    /** Resolve archived lanes too (default true, the action domain's rule; the sync host passes false). */
    includeArchived?: boolean;
  },
): Promise<LaneEnvInitProgress> {
  const context = await resolveLaneOverlayContext(deps, args.laneId, { includeArchived: args.includeArchived ?? true });
  const templateId = args.templateId?.trim() || null;
  if (!templateId) {
    if (!context.envInitConfig) {
      const now = new Date().toISOString();
      return { laneId: args.laneId, steps: [], startedAt: now, completedAt: now, overallStatus: "completed" };
    }
    return deps.laneEnvironmentService.initLaneEnvironment(context.lane, context.envInitConfig, context.overrides);
  }
  const laneTemplateService = deps.laneTemplateService;
  if (!laneTemplateService) throw new Error("Lane template service not available.");
  const template: LaneTemplate | null = laneTemplateService.getTemplate(templateId);
  if (!template) throw new Error(`Template not found: ${templateId}`);
  const templateEnvInit = laneTemplateService.resolveTemplateAsEnvInit(template);
  const mergedOverrides = mergeLaneOverrides(context.overrides, {
    ...(template.envVars ? { env: template.envVars } : {}),
    ...(!context.overrides.portRange && template.portRange ? { portRange: template.portRange } : {}),
    envInit: templateEnvInit,
  });
  const mergedEnvInitConfig = mergeLaneEnvInitConfig(context.envInitConfig, templateEnvInit) ?? templateEnvInit;
  return deps.laneEnvironmentService.initLaneEnvironment(context.lane, mergedEnvInitConfig, mergedOverrides);
}

function envInitConfigHasWork(config: LaneEnvInitConfig | null | undefined): boolean {
  if (!config) return false;
  return Boolean(
    config.envFiles?.length
      || config.docker
      || config.dependencies?.length
      || config.mountPoints?.length
      || config.copyPaths?.length
      || config.setupScript,
  );
}

/**
 * Whether a brand-new lane will get any environment setup — decided before the
 * lane exists, from project config alone. Overlay policies can only match a
 * lane by name/branch, so any policy that carries env init counts; the setup
 * step itself reports zero steps (and the launch drops the stage) when none of
 * it actually applies to the new lane.
 */
export type ChatLaunchEnvironmentPlan = {
  /** A default lane template or a project lane-environment config applies. */
  hasEnvironment: boolean;
  templateId: string | null;
  templateName: string | null;
};

export function planNewLaneEnvironment(args: {
  laneEnvInit?: LaneEnvInitConfig | null;
  laneOverlayPolicies?: Array<{ enabled?: boolean; overrides?: { envInit?: LaneEnvInitConfig | null } | null }> | null;
  defaultTemplate: Pick<LaneTemplate, "id" | "name"> | null;
}): ChatLaunchEnvironmentPlan {
  const template = args.defaultTemplate;
  const hasEnvironment = Boolean(template)
    || envInitConfigHasWork(args.laneEnvInit)
    || (args.laneOverlayPolicies ?? []).some((policy) => policy?.enabled !== false && envInitConfigHasWork(policy?.overrides?.envInit));
  return {
    hasEnvironment,
    templateId: template?.id ?? null,
    templateName: template?.name?.trim() || template?.id || null,
  };
}
