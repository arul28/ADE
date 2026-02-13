import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { AdeDb } from "../state/kvDb";
import type { Logger } from "../logging/logger";
import type { createLaneService } from "../lanes/laneService";
import type { createPackService } from "../packs/packService";
import type { createProjectConfigService } from "../config/projectConfigService";
import type {
  OnboardingDetectionIndicator,
  OnboardingDetectionResult,
  OnboardingExistingLaneCandidate,
  OnboardingStatus,
  ProjectConfigFile
} from "../../../shared/types";
import { runGit, runGitOrThrow } from "../git/git";

const STATUS_KEY = "onboarding:status";

function fileExists(absPath: string): boolean {
  try {
    return fs.statSync(absPath).isFile();
  } catch {
    return false;
  }
}

function dirExists(absPath: string): boolean {
  try {
    return fs.statSync(absPath).isDirectory();
  } catch {
    return false;
  }
}

function safeReadText(absPath: string, maxBytes: number): string {
  try {
    const fd = fs.openSync(absPath, "r");
    try {
      const buf = Buffer.alloc(maxBytes);
      const read = fs.readSync(fd, buf, 0, maxBytes, 0);
      return buf.slice(0, Math.max(0, read)).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

function uniqueById<T extends { id: string }>(items: T[]): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const id = item.id.trim();
    if (!id) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(item);
  }
  return out;
}

function parseGithubWorkflowRuns(absPath: string): string[] {
  const raw = safeReadText(absPath, 220_000);
  if (!raw.trim()) return [];
  try {
    const parsed = YAML.parse(raw) as any;
    const jobs = parsed?.jobs;
    if (!jobs || typeof jobs !== "object") return [];
    const commands: string[] = [];
    for (const job of Object.values(jobs)) {
      const steps = (job as any)?.steps;
      if (!Array.isArray(steps)) continue;
      for (const step of steps) {
        const runRaw = (step as any)?.run;
        const run = typeof runRaw === "string" ? String(runRaw).trim() : "";
        if (!run) continue;
        // Keep it light: capture only single-line commands; multi-line gets noisy.
        const first = run.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0];
        if (first) commands.push(first);
      }
    }
    return commands;
  } catch {
    return [];
  }
}

function guessNodePackageManager(projectRoot: string): "npm" | "yarn" | "pnpm" {
  if (fileExists(path.join(projectRoot, "pnpm-lock.yaml"))) return "pnpm";
  if (fileExists(path.join(projectRoot, "yarn.lock"))) return "yarn";
  return "npm";
}

function buildSuggestedConfig(args: {
  projectRoot: string;
  indicators: OnboardingDetectionIndicator[];
  suggestedWorkflowCommands: string[];
}): ProjectConfigFile {
  const out: ProjectConfigFile = {
    version: 1,
    processes: [],
    stackButtons: [],
    testSuites: [],
    laneOverlayPolicies: [],
    automations: []
  };

  const addProcess = (id: string, name: string, command: string[], cwd = ".") => {
    out.processes!.push({ id, name, command, cwd });
  };
  const addTest = (id: string, name: string, command: string[], cwd = ".", tags: any[] = ["custom"]) => {
    out.testSuites!.push({ id, name, command, cwd, tags });
  };
  const addStack = (id: string, name: string, processIds: string[]) => {
    out.stackButtons!.push({ id, name, processIds, startOrder: "parallel" });
  };

  const has = (type: string) => args.indicators.some((ind) => ind.type === type);

  if (has("node")) {
    const pm = guessNodePackageManager(args.projectRoot);
    if (pm === "pnpm") {
      addProcess("install", "Install dependencies", ["pnpm", "install"]);
      addTest("unit", "Unit tests", ["pnpm", "test"], ".", ["unit"]);
      addProcess("build", "Build", ["pnpm", "build"]);
    } else if (pm === "yarn") {
      addProcess("install", "Install dependencies", ["yarn", "install", "--frozen-lockfile"]);
      addTest("unit", "Unit tests", ["yarn", "test"], ".", ["unit"]);
      addProcess("build", "Build", ["yarn", "build"]);
    } else {
      addProcess("install", "Install dependencies", ["npm", "install"]);
      addTest("unit", "Unit tests", ["npm", "test"], ".", ["unit"]);
      addProcess("build", "Build", ["npm", "run", "build"]);
    }
  }

  if (has("make")) {
    addProcess("make", "Make", ["make"]);
    addTest("make-test", "Make test", ["make", "test"], ".", ["custom"]);
  }

  if (has("docker")) {
    addProcess("docker-up", "Docker compose up", ["docker", "compose", "up"], ".");
    addStack("dev", "Dev", ["docker-up"]);
  }

  if (has("rust")) {
    addProcess("cargo-build", "Cargo build", ["cargo", "build"]);
    addTest("cargo-test", "Cargo test", ["cargo", "test"], ".", ["unit"]);
  }

  if (has("go")) {
    addProcess("go-build", "Go build", ["go", "build", "./..."]);
    addTest("go-test", "Go test", ["go", "test", "./..."], ".", ["unit"]);
  }

  if (has("python")) {
    addProcess("py-install", "Install (editable)", ["python", "-m", "pip", "install", "-e", "."]);
    addTest("pytest", "Pytest", ["pytest"], ".", ["unit"]);
  }

  // CI-derived commands: keep only a few obvious ones to avoid spamming config.
  const ciCandidates = args.suggestedWorkflowCommands
    .map((cmd) => cmd.trim())
    .filter(Boolean)
    .filter((cmd) =>
      /(npm|pnpm|yarn)\s+(test|run\s+test|lint|run\s+lint)|go\s+test|cargo\s+test|pytest|make\s+test/i.test(cmd)
    )
    .slice(0, 6);
  for (const [idx, cmd] of ciCandidates.entries()) {
    const id = `ci-${idx + 1}`;
    addTest(id, `CI: ${cmd}`, cmd.split(/\s+/), ".", ["custom"]);
  }

  out.processes = uniqueById(out.processes ?? []);
  out.testSuites = uniqueById(out.testSuites ?? []);
  out.stackButtons = uniqueById(out.stackButtons ?? []);

  out.automations = [
    {
      id: "session-end-local",
      name: "Session end: refresh packs + conflicts",
      enabled: true,
      trigger: { type: "session-end" },
      actions: [
        { type: "update-packs" },
        { type: "predict-conflicts" }
      ]
    },
    {
      id: "hourly-mirror-sync",
      name: "Hourly mirror sync (hosted)",
      enabled: false,
      trigger: { type: "schedule", cron: "0 * * * *" },
      actions: [
        { type: "sync-to-mirror", condition: "hosted-enabled" }
      ]
    }
  ];

  return out;
}

export function createOnboardingService(args: {
  db: AdeDb;
  logger: Logger;
  projectRoot: string;
  projectId: string;
  baseRef: string;
  laneService: ReturnType<typeof createLaneService>;
  packService: ReturnType<typeof createPackService>;
  projectConfigService: ReturnType<typeof createProjectConfigService>;
}) {
  const { db, logger, projectRoot, baseRef, laneService, packService, projectConfigService } = args;

  const nowIso = () => new Date().toISOString();

  const getStatus = (): OnboardingStatus => {
    const stored = db.getJson<OnboardingStatus>(STATUS_KEY);
    const completedAt = typeof stored?.completedAt === "string" ? stored.completedAt : null;
    return { completedAt };
  };

  const complete = (): OnboardingStatus => {
    const status: OnboardingStatus = { completedAt: nowIso() };
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

  const generateInitialPacks = async (args: { laneIds?: string[] } = {}): Promise<void> => {
    const lanes = await laneService.list({ includeArchived: false });
    const laneIds = args.laneIds?.length ? args.laneIds : lanes.map((lane) => lane.id);

    logger.info("onboarding.generateInitialPacks.begin", { laneCount: laneIds.length });

    await packService.refreshProjectPack({ reason: "onboarding_init" });
    for (const laneId of laneIds) {
      await packService.refreshLanePack({ laneId, reason: "onboarding_init" });
    }

    logger.info("onboarding.generateInitialPacks.done", { laneCount: laneIds.length });
  };

  return {
    getStatus,
    complete,
    detectDefaults,
    detectExistingLanes,
    generateInitialPacks,

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
