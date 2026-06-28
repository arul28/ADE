import fs from "node:fs";
import path from "node:path";
import type { AdeDb } from "../state/kvDb";
import type { Logger } from "../logging/logger";
import type { createLaneService } from "../lanes/laneService";
import type { createProjectConfigService } from "../config/projectConfigService";
import type {
  OnboardingDetectionIndicator,
  OnboardingDetectionResult,
  OnboardingExistingLaneCandidate,
  OnboardingHelpState,
  OnboardingStatus,
  ProjectConfigFile
} from "../../../shared/types";
import { runGit, runGitOrThrow } from "../git/git";
import { dirExists, fileExists, nowIso } from "../shared/utils";
import { buildSuggestedConfig, parseGithubWorkflowRuns } from "./onboardingSuggestedConfig";

const STATUS_KEY = "onboarding:status";
// Historical storage key retained only so existing glossary terms are not lost
// when upgrading from the removed tour/tutorial system.
const HELP_STATE_KEY = "onboarding:tourProgress";

function emptyHelpState(): OnboardingHelpState {
  return {
    glossaryTermsSeen: [],
  };
}

function normalizeHelpState(raw: unknown): OnboardingHelpState {
  if (!raw || typeof raw !== "object") return emptyHelpState();
  const r = raw as Partial<OnboardingHelpState>;
  const seen = Array.isArray(r.glossaryTermsSeen)
    ? Array.from(
        new Set(
          r.glossaryTermsSeen
            .filter((v): v is string => typeof v === "string")
            .map((v) => v.trim())
            .filter((v) => v.length > 0),
        ),
      )
    : [];
  return {
    glossaryTermsSeen: seen,
  };
}

export function createOnboardingService(args: {
  db: AdeDb;
  logger: Logger;
  projectRoot: string;
  projectId: string;
  baseRef: string;
  freshProject: boolean;
  laneService: ReturnType<typeof createLaneService>;
  projectConfigService: ReturnType<typeof createProjectConfigService>;
}) {
  const { db, logger, projectRoot, baseRef, freshProject, laneService, projectConfigService } = args;

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

  const getHelpState = (): OnboardingHelpState => {
    const stored = db.getJson<OnboardingHelpState>(HELP_STATE_KEY);
    return normalizeHelpState(stored);
  };

  const writeHelpState = (next: OnboardingHelpState): OnboardingHelpState => {
    db.setJson(HELP_STATE_KEY, next);
    return next;
  };

  const markGlossaryTermSeen = (termId: string): OnboardingHelpState => {
    const id = termId.trim();
    if (!id) return getHelpState();
    const current = getHelpState();
    if (current.glossaryTermsSeen.includes(id)) return current;
    return writeHelpState({
      ...current,
      glossaryTermsSeen: [...current.glossaryTermsSeen, id],
    });
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

  const detectExistingLanes = async (): Promise<OnboardingExistingLaneCandidate[]> => {
    const existing = await laneService.list({ includeArchived: true });
    const laneBranchRefs = new Set(existing.map((lane) => lane.branchRef));

    const currentBranch = (await runGitOrThrow(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: projectRoot, timeoutMs: 8_000 })).trim();

    const refs = await runGitOrThrow(["for-each-ref", "refs/heads", "--format=%(refname:short)"], { cwd: projectRoot, timeoutMs: 10_000 });
    const branchRefs = refs
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((ref) => !laneBranchRefs.has(ref));

    const remoteRefs = await runGit(["for-each-ref", "refs/remotes/origin", "--format=%(refname:short)"], { cwd: projectRoot, timeoutMs: 10_000 });
    const remoteSet = new Set(
      remoteRefs.exitCode === 0
        ? remoteRefs.stdout
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .map((ref) => ref.replace(/^origin\//, ""))
        : []
    );

    const candidates: OnboardingExistingLaneCandidate[] = [];
    for (const branchRef of branchRefs.slice(0, 200)) {
      const counts = await runGit(["rev-list", "--left-right", "--count", `${baseRef}...${branchRef}`], {
        cwd: projectRoot,
        timeoutMs: 8_000
      });
      let behind = 0;
      let ahead = 0;
      if (counts.exitCode === 0) {
        const parts = counts.stdout.trim().split(/\s+/).filter(Boolean);
        behind = Number(parts[0] ?? 0) || 0;
        ahead = Number(parts[1] ?? 0) || 0;
      }
      candidates.push({
        branchRef,
        isCurrent: branchRef === currentBranch,
        hasRemote: remoteSet.has(branchRef),
        ahead,
        behind
      });
    }

    candidates.sort((a, b) => {
      if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
      const delta = b.ahead - a.ahead;
      if (delta !== 0) return delta;
      return a.branchRef.localeCompare(b.branchRef);
    });

    return candidates;
  };

  return {
    getStatus,
    complete,
    setDismissed,
    detectDefaults,
    detectExistingLanes,
    getHelpState,
    markGlossaryTermSeen,

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
