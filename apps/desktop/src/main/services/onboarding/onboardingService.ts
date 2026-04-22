import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { AdeDb } from "../state/kvDb";
import type { Logger } from "../logging/logger";
import type { createLaneService } from "../lanes/laneService";
import type { createProjectConfigService } from "../config/projectConfigService";
import type {
  OnboardingDetectionIndicator,
  OnboardingDetectionResult,
  OnboardingExistingLaneCandidate,
  OnboardingStatus,
  OnboardingTourEntry,
  OnboardingTourEntryV2,
  OnboardingTourProgress,
  OnboardingTourVariant,
  OnboardingTourVariantEntry,
  OnboardingTutorialState,
  ProjectConfigFile
} from "../../../shared/types";
import { runGit, runGitOrThrow } from "../git/git";
import { dirExists, fileExists, nowIso, safeReadText } from "../shared/utils";

const STATUS_KEY = "onboarding:status";
const TOUR_PROGRESS_KEY = "onboarding:tourProgress";

const EMPTY_TOUR_ENTRY: OnboardingTourEntry = {
  completedAt: null,
  dismissedAt: null,
  lastStepIndex: 0,
};

const EMPTY_VARIANT_ENTRY: OnboardingTourVariantEntry = {
  completedAt: null,
  dismissedAt: null,
  lastStepIndex: 0,
};

function emptyVariantEntry(): OnboardingTourVariantEntry {
  return { ...EMPTY_VARIANT_ENTRY };
}

function emptyTourEntryV2(): OnboardingTourEntryV2 {
  return {
    full: emptyVariantEntry(),
    highlights: emptyVariantEntry(),
  };
}

function emptyTutorialState(): OnboardingTutorialState {
  return {
    completedAt: null,
    dismissedAt: null,
    silenced: false,
    inProgress: false,
    lastActIndex: 0,
    ctxSnapshot: {},
  };
}

function emptyTourProgress(): OnboardingTourProgress {
  return {
    wizardCompletedAt: null,
    wizardDismissedAt: null,
    tours: {},
    tourVariants: {},
    tutorial: emptyTutorialState(),
    glossaryTermsSeen: [],
  };
}

function normalizeTourEntry(raw: unknown): OnboardingTourEntry {
  if (!raw || typeof raw !== "object") return { ...EMPTY_TOUR_ENTRY };
  const r = raw as Partial<OnboardingTourEntry>;
  return {
    completedAt: typeof r.completedAt === "string" ? r.completedAt : null,
    dismissedAt: typeof r.dismissedAt === "string" ? r.dismissedAt : null,
    lastStepIndex:
      typeof r.lastStepIndex === "number" && Number.isFinite(r.lastStepIndex) && r.lastStepIndex >= 0
        ? Math.floor(r.lastStepIndex)
        : 0,
  };
}

function normalizeVariantEntry(raw: unknown): OnboardingTourVariantEntry {
  if (!raw || typeof raw !== "object") return emptyVariantEntry();
  const r = raw as Partial<OnboardingTourVariantEntry>;
  return {
    completedAt: typeof r.completedAt === "string" ? r.completedAt : null,
    dismissedAt: typeof r.dismissedAt === "string" ? r.dismissedAt : null,
    lastStepIndex:
      typeof r.lastStepIndex === "number" && Number.isFinite(r.lastStepIndex) && r.lastStepIndex >= 0
        ? Math.floor(r.lastStepIndex)
        : 0,
  };
}

/**
 * Accepts either the legacy flat `OnboardingTourEntry` shape or the new
 * `{ full, highlights }` variant shape. Legacy entries are treated as the
 * "full" variant with defaults for "highlights".
 */
function normalizeTourEntryV2(raw: unknown): OnboardingTourEntryV2 {
  if (!raw || typeof raw !== "object") return emptyTourEntryV2();
  const r = raw as Record<string, unknown>;
  const hasVariantShape =
    ("full" in r && typeof r.full === "object") ||
    ("highlights" in r && typeof r.highlights === "object");
  if (hasVariantShape) {
    return {
      full: normalizeVariantEntry(r.full),
      highlights: normalizeVariantEntry(r.highlights),
    };
  }
  // Legacy flat entry — map onto the "full" variant.
  return {
    full: normalizeVariantEntry(r),
    highlights: emptyVariantEntry(),
  };
}

function normalizeTutorialState(raw: unknown): OnboardingTutorialState {
  if (!raw || typeof raw !== "object") return emptyTutorialState();
  const r = raw as Partial<OnboardingTutorialState>;
  const snapshot =
    r.ctxSnapshot && typeof r.ctxSnapshot === "object" && !Array.isArray(r.ctxSnapshot)
      ? (r.ctxSnapshot as Record<string, unknown>)
      : {};
  return {
    completedAt: typeof r.completedAt === "string" ? r.completedAt : null,
    dismissedAt: typeof r.dismissedAt === "string" ? r.dismissedAt : null,
    silenced: typeof r.silenced === "boolean" ? r.silenced : false,
    inProgress: typeof r.inProgress === "boolean" ? r.inProgress : false,
    lastActIndex:
      typeof r.lastActIndex === "number" && Number.isFinite(r.lastActIndex) && r.lastActIndex >= 0
        ? Math.floor(r.lastActIndex)
        : 0,
    ctxSnapshot: { ...snapshot },
  };
}

function normalizeTourProgress(raw: unknown): OnboardingTourProgress {
  if (!raw || typeof raw !== "object") return emptyTourProgress();
  const r = raw as Partial<OnboardingTourProgress> & {
    tourVariants?: Record<string, unknown>;
    tutorial?: unknown;
  };
  const tours: Record<string, OnboardingTourEntry> = {};
  if (r.tours && typeof r.tours === "object") {
    for (const [id, value] of Object.entries(r.tours)) {
      if (!id) continue;
      tours[id] = normalizeTourEntry(value);
    }
  }
  const tourVariants: Record<string, OnboardingTourEntryV2> = {};
  if (r.tourVariants && typeof r.tourVariants === "object") {
    for (const [id, value] of Object.entries(r.tourVariants)) {
      if (!id) continue;
      tourVariants[id] = normalizeTourEntryV2(value);
    }
  }
  // Back-fill: any tour touched via the legacy flat shape is mirrored into
  // the "full" variant so variant-aware readers see a consistent view.
  for (const [id, legacy] of Object.entries(tours)) {
    const existing = tourVariants[id];
    if (!existing) {
      tourVariants[id] = {
        full: { ...legacy },
        highlights: emptyVariantEntry(),
      };
      continue;
    }
    // Preserve existing variant data but ensure "full" at minimum reflects legacy.
    const fullTouched =
      existing.full.completedAt !== null ||
      existing.full.dismissedAt !== null ||
      existing.full.lastStepIndex > 0;
    if (!fullTouched) {
      tourVariants[id] = { ...existing, full: { ...legacy } };
    }
  }
  const seen = Array.isArray(r.glossaryTermsSeen)
    ? Array.from(
        new Set(
          r.glossaryTermsSeen.filter((v): v is string => typeof v === "string" && v.length > 0),
        ),
      )
    : [];
  return {
    wizardCompletedAt: typeof r.wizardCompletedAt === "string" ? r.wizardCompletedAt : null,
    wizardDismissedAt: typeof r.wizardDismissedAt === "string" ? r.wizardDismissedAt : null,
    tours,
    tourVariants,
    tutorial: normalizeTutorialState(r.tutorial),
    glossaryTermsSeen: seen,
  };
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
        const run = typeof runRaw === "string" ? runRaw.trim() : "";
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
      name: "Session end: predict conflicts",
      enabled: true,
      trigger: { type: "session-end" },
      actions: [
        { type: "predict-conflicts" }
      ]
    }
  ];

  out.providers = {
    contextTools: {
      generators: {
        codex: {
          command: ["codex", "exec", "-"]
        },
        claude: {
          command: ["claude", "--print"]
        }
      },
      conflictResolvers: {
        codex: {
          command: ["codex", "exec", "-"]
        },
        claude: {
          command: ["claude", "--print"]
        }
      }
    }
  };

  return out;
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

  type NormalizedTourProgress = OnboardingTourProgress & {
    tourVariants: Record<string, OnboardingTourEntryV2>;
    tutorial: OnboardingTutorialState;
  };

  const getTourProgress = (): NormalizedTourProgress => {
    const stored = db.getJson<OnboardingTourProgress>(TOUR_PROGRESS_KEY);
    return normalizeTourProgress(stored) as NormalizedTourProgress;
  };

  const writeTourProgress = (next: OnboardingTourProgress): OnboardingTourProgress => {
    db.setJson(TOUR_PROGRESS_KEY, next);
    return next;
  };

  const markWizardCompleted = (): OnboardingTourProgress => {
    const current = getTourProgress();
    return writeTourProgress({
      ...current,
      wizardCompletedAt: nowIso(),
      wizardDismissedAt: null,
    });
  };

  const markWizardDismissed = (): OnboardingTourProgress => {
    const current = getTourProgress();
    return writeTourProgress({
      ...current,
      wizardDismissedAt: nowIso(),
    });
  };

  const DEFAULT_VARIANT: OnboardingTourVariant = "full";

  const coerceVariant = (variant: OnboardingTourVariant | undefined): OnboardingTourVariant =>
    variant === "highlights" ? "highlights" : "full";

  const updateTourEntry = (
    tourId: string,
    patch: Partial<OnboardingTourEntry>,
  ): OnboardingTourProgress => {
    const id = tourId.trim();
    if (!id) return getTourProgress();
    const current = getTourProgress();
    const entry = current.tours[id] ?? { ...EMPTY_TOUR_ENTRY };
    const nextEntry: OnboardingTourEntry = { ...entry, ...patch };
    // Mirror legacy writes onto the "full" variant so variant-aware readers
    // stay in sync without requiring every call site to migrate at once.
    const existingVariant = current.tourVariants[id] ?? emptyTourEntryV2();
    const mirrored: OnboardingTourEntryV2 = {
      full: { ...nextEntry },
      highlights: existingVariant.highlights,
    };
    return writeTourProgress({
      ...current,
      tours: {
        ...current.tours,
        [id]: nextEntry,
      },
      tourVariants: {
        ...current.tourVariants,
        [id]: mirrored,
      },
    });
  };

  const updateTourVariantEntry = (
    tourId: string,
    variant: OnboardingTourVariant,
    patch: Partial<OnboardingTourVariantEntry>,
  ): OnboardingTourProgress => {
    const id = tourId.trim();
    if (!id) return getTourProgress();
    const v = coerceVariant(variant);
    const current = getTourProgress();
    const existing = current.tourVariants[id] ?? emptyTourEntryV2();
    const nextVariantEntry: OnboardingTourVariantEntry = { ...existing[v], ...patch };
    const nextV2: OnboardingTourEntryV2 = { ...existing, [v]: nextVariantEntry };
    // Keep the legacy flat `tours[id]` mirrored to the "full" variant so
    // existing renderer code continues to work until callers migrate.
    const nextTours =
      v === "full"
        ? { ...current.tours, [id]: { ...nextVariantEntry } }
        : current.tours;
    return writeTourProgress({
      ...current,
      tours: nextTours,
      tourVariants: {
        ...current.tourVariants,
        [id]: nextV2,
      },
    });
  };

  const markTourCompleted = (
    tourId: string,
    variant: OnboardingTourVariant = DEFAULT_VARIANT,
  ): OnboardingTourProgress =>
    updateTourVariantEntry(tourId, variant, { completedAt: nowIso(), dismissedAt: null });

  const markTourDismissed = (
    tourId: string,
    variant: OnboardingTourVariant = DEFAULT_VARIANT,
  ): OnboardingTourProgress =>
    updateTourVariantEntry(tourId, variant, { dismissedAt: nowIso() });

  const updateTourStep = (
    tourId: string,
    indexOrVariant: number | OnboardingTourVariant,
    maybeIndex?: number,
  ): OnboardingTourProgress => {
    // Backward-compat overload: (tourId, index) — legacy signature, writes to "full".
    // New overload: (tourId, variant, index) — variant-aware.
    let variant: OnboardingTourVariant;
    let rawIndex: number;
    if (typeof indexOrVariant === "number") {
      variant = DEFAULT_VARIANT;
      rawIndex = indexOrVariant;
    } else {
      variant = coerceVariant(indexOrVariant);
      rawIndex = typeof maybeIndex === "number" ? maybeIndex : 0;
    }
    const safeIndex =
      typeof rawIndex === "number" && Number.isFinite(rawIndex) && rawIndex >= 0
        ? Math.floor(rawIndex)
        : 0;
    return updateTourVariantEntry(tourId, variant, { lastStepIndex: safeIndex });
  };

  // Tutorial (Round 2) -----------------------------------------------------

  const TUTORIAL_ACT_MIN = 0;
  const TUTORIAL_ACT_MAX = 12;

  const writeTutorial = (
    patch: Partial<OnboardingTutorialState>,
  ): OnboardingTourProgress => {
    const current = getTourProgress();
    const base = current.tutorial;
    const nextTutorial: OnboardingTutorialState = {
      completedAt: patch.completedAt !== undefined ? patch.completedAt : base.completedAt,
      dismissedAt: patch.dismissedAt !== undefined ? patch.dismissedAt : base.dismissedAt,
      silenced: patch.silenced !== undefined ? patch.silenced : base.silenced,
      inProgress: patch.inProgress !== undefined ? patch.inProgress : base.inProgress,
      lastActIndex: patch.lastActIndex !== undefined ? patch.lastActIndex : base.lastActIndex,
      ctxSnapshot: { ...(patch.ctxSnapshot ?? base.ctxSnapshot) },
    };
    return writeTourProgress({ ...current, tutorial: nextTutorial });
  };

  const markTutorialStarted = (): OnboardingTourProgress =>
    writeTutorial({ inProgress: true, dismissedAt: null });

  const markTutorialDismissed = (permanent: boolean): OnboardingTourProgress =>
    writeTutorial({
      dismissedAt: nowIso(),
      silenced: permanent ? true : getTourProgress().tutorial.silenced,
      inProgress: false,
    });

  const markTutorialCompleted = (): OnboardingTourProgress =>
    writeTutorial({
      completedAt: nowIso(),
      dismissedAt: null,
      inProgress: false,
    });

  const updateTutorialAct = (
    actIndex: number,
    ctxSnapshot?: Record<string, unknown>,
  ): OnboardingTourProgress => {
    const safeIndex =
      typeof actIndex === "number" && Number.isFinite(actIndex)
        ? Math.max(TUTORIAL_ACT_MIN, Math.min(TUTORIAL_ACT_MAX, Math.floor(actIndex)))
        : TUTORIAL_ACT_MIN;
    const snapshot =
      ctxSnapshot && typeof ctxSnapshot === "object" && !Array.isArray(ctxSnapshot)
        ? ctxSnapshot
        : undefined;
    const patch: Partial<OnboardingTutorialState> = { lastActIndex: safeIndex, inProgress: true };
    if (snapshot) patch.ctxSnapshot = snapshot;
    return writeTutorial(patch);
  };

  const setTutorialSilenced = (silenced: boolean): OnboardingTourProgress =>
    writeTutorial({ silenced: Boolean(silenced) });

  const clearTutorialSessionDismissal = (): OnboardingTourProgress =>
    writeTutorial({ dismissedAt: null });

  const shouldPromptTutorial = (): boolean => {
    const { tutorial } = getTourProgress();
    if (tutorial.completedAt) return false;
    if (tutorial.silenced) return false;
    if (tutorial.dismissedAt) return false;
    return true;
  };

  const markGlossaryTermSeen = (termId: string): OnboardingTourProgress => {
    const id = termId.trim();
    if (!id) return getTourProgress();
    const current = getTourProgress();
    if (current.glossaryTermsSeen.includes(id)) return current;
    return writeTourProgress({
      ...current,
      glossaryTermsSeen: [...current.glossaryTermsSeen, id],
    });
  };

  const resetTourProgress = (tourId?: string): OnboardingTourProgress => {
    if (tourId === undefined) {
      return writeTourProgress(emptyTourProgress());
    }
    const id = tourId.trim();
    if (!id) return getTourProgress();
    const current = getTourProgress();
    const hasLegacy = id in current.tours;
    const hasVariant = id in current.tourVariants;
    if (!hasLegacy && !hasVariant) return current;
    const nextTours = { ...current.tours };
    delete nextTours[id];
    const nextVariants = { ...current.tourVariants };
    delete nextVariants[id];
    return writeTourProgress({
      ...current,
      tours: nextTours,
      tourVariants: nextVariants,
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
    getTourProgress,
    markWizardCompleted,
    markWizardDismissed,
    markTourCompleted,
    markTourDismissed,
    updateTourStep,
    markGlossaryTermSeen,
    resetTourProgress,

    // Tutorial (Round 2)
    markTutorialStarted,
    markTutorialDismissed,
    markTutorialCompleted,
    updateTutorialAct,
    setTutorialSilenced,
    clearTutorialSessionDismissal,
    shouldPromptTutorial,

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
