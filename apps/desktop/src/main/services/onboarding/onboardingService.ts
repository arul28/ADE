import fs from "node:fs";
import path from "node:path";
import type { AdeDb } from "../state/kvDb";
import type { Logger } from "../logging/logger";
import type { createProjectConfigService } from "../config/projectConfigService";
import type {
  OnboardingDetectionIndicator,
  OnboardingDetectionResult,
  OnboardingStatus,
  ProjectConfigFile
} from "../../../shared/types";
import { dirExists, fileExists, nowIso } from "../shared/utils";
import { buildSuggestedConfig, parseGithubWorkflowRuns } from "./onboardingSuggestedConfig";

const STATUS_KEY = "onboarding:status";

export function createOnboardingService(args: {
  db: AdeDb;
  logger: Logger;
  projectRoot: string;
  projectId: string;
  freshProject: boolean;
  projectConfigService: ReturnType<typeof createProjectConfigService>;
}) {
  const { db, logger, projectRoot, freshProject, projectConfigService } = args;

  const getStatus = (): OnboardingStatus => {
    const stored = db.getJson<OnboardingStatus>(STATUS_KEY);
    const completedAt = typeof stored?.completedAt === "string" ? stored.completedAt : null;
    const dismissedAt = typeof stored?.dismissedAt === "string" ? stored.dismissedAt : null;
    return { completedAt, dismissedAt, freshProject };
  };

  const complete = (): OnboardingStatus => {
    const status: OnboardingStatus = { completedAt: nowIso(), dismissedAt: null, freshProject };
    db.setJson(STATUS_KEY, status);
    return status;
  };

  const setDismissed = (dismissed: boolean): OnboardingStatus => {
    const current = getStatus();
    const status: OnboardingStatus = {
      completedAt: current.completedAt,
      dismissedAt: dismissed ? nowIso() : null,
      freshProject,
    };
    db.setJson(STATUS_KEY, status);
    return status;
  };

  const detectDefaults = async (): Promise<OnboardingDetectionResult> => {
    const indicators: OnboardingDetectionIndicator[] = [];
    const projectTypes: string[] = [];
    const suggestedWorkflows: Array<{ path: string; kind: "github-actions" | "gitlab-ci" | "other" }> = [];
    const workflowCommands: string[] = [];

    const push = (file: string, type: string, confidence: number, projectType?: string) => {
      indicators.push({ file, type, confidence });
      if (projectType) projectTypes.push(projectType);
    };

    const packageJson = path.join(projectRoot, "package.json");
    if (fileExists(packageJson)) push("package.json", "node", 0.95, "node");
    if (fileExists(path.join(projectRoot, "Cargo.toml"))) push("Cargo.toml", "rust", 0.95, "rust");
    if (fileExists(path.join(projectRoot, "go.mod"))) push("go.mod", "go", 0.95, "go");
    if (fileExists(path.join(projectRoot, "pyproject.toml"))) push("pyproject.toml", "python", 0.95, "python");
    if (fileExists(path.join(projectRoot, "Makefile"))) push("Makefile", "make", 0.8, "make");
    if (fileExists(path.join(projectRoot, "docker-compose.yml")) || fileExists(path.join(projectRoot, "docker-compose.yaml"))) {
      push("docker-compose.yml", "docker", 0.8, "docker");
    }

    const workflowsDir = path.join(projectRoot, ".github", "workflows");
    if (dirExists(workflowsDir)) {
      push(".github/workflows", "github-actions", 0.7, "ci");
      const entries = fs.readdirSync(workflowsDir).filter((name) => name.endsWith(".yml") || name.endsWith(".yaml")).slice(0, 32);
      for (const name of entries) {
        const abs = path.join(workflowsDir, name);
        suggestedWorkflows.push({ path: path.relative(projectRoot, abs), kind: "github-actions" });
        workflowCommands.push(...parseGithubWorkflowRuns(abs));
      }
    }

    const uniqueTypes = Array.from(new Set(projectTypes.filter(Boolean)));
    const suggestedConfig = buildSuggestedConfig({ projectRoot, indicators, suggestedWorkflowCommands: workflowCommands });

    logger.info("onboarding.detectDefaults", {
      indicators: indicators.map((i) => i.type),
      workflows: suggestedWorkflows.length
    });

    return {
      projectTypes: uniqueTypes,
      indicators,
      suggestedConfig,
      suggestedWorkflows
    };
  };

  return {
    getStatus,
    complete,
    setDismissed,
    detectDefaults,

    // Convenience hook for UI flows: apply suggested config as local draft.
    applySuggestedConfig: async (suggestedConfig: ProjectConfigFile): Promise<void> => {
      const snapshot = projectConfigService.get();
      await projectConfigService.save({
        shared: { ...snapshot.shared, ...suggestedConfig },
        local: snapshot.local
      });
    }
  };
}
