import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import YAML from "yaml";
import type {
  LinearSyncConfig,
  LinearWorkflowConfig,
  LinearWorkflowConfigFileMeta,
  LinearWorkflowDefinition,
  LinearWorkflowIntake,
  LinearWorkflowSettings,
  LinearWorkflowWorkerSelector,
} from "../../../shared/types";
import { resolveAdeLayout } from "../../../shared/adeLayout";
import { createDefaultLinearWorkflowConfig, createWorkflowPreset } from "../../../shared/linearWorkflowPresets";
import { isRecord } from "../shared/utils";

const WORKFLOW_VERSION = 1 as const;
const SETTINGS_FILE = "_settings.yaml";
const LEGACY_SNAPSHOT_FILE = "legacy-linear-sync.snapshot.json";
const DEFAULT_ACTIVE_STATE_TYPES = ["backlog", "unstarted", "started"] as const;
const DEFAULT_TERMINAL_STATE_TYPES = ["completed", "canceled"] as const;

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function ensureStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "workflow";
}

function normalizeIntake(input: unknown): LinearWorkflowIntake {
  const source = isRecord(input) ? input : {};
  return {
    ...(ensureStringArray(source.projectSlugs).length
      ? { projectSlugs: ensureStringArray(source.projectSlugs) }
      : {}),
    ...(ensureStringArray(source.activeStateTypes).length
      ? { activeStateTypes: ensureStringArray(source.activeStateTypes) }
      : { activeStateTypes: [...DEFAULT_ACTIVE_STATE_TYPES] }),
    ...(ensureStringArray(source.terminalStateTypes).length
      ? { terminalStateTypes: ensureStringArray(source.terminalStateTypes) }
      : { terminalStateTypes: [...DEFAULT_TERMINAL_STATE_TYPES] }),
  };
}

function normalizeWorkerSelector(input: unknown): LinearWorkflowWorkerSelector | undefined {
  const workerSelector = isRecord(input) ? input : null;
  if (!workerSelector) return undefined;
  if (
    workerSelector.mode !== "id"
    && workerSelector.mode !== "slug"
    && workerSelector.mode !== "capability"
    && workerSelector.mode !== "none"
  ) {
    return undefined;
  }
  if (workerSelector.mode === "none") return { mode: "none" };
  if (typeof workerSelector.value !== "string" || workerSelector.value.trim().length === 0) return undefined;
  return {
    mode: workerSelector.mode,
    value: workerSelector.value.trim(),
  } as LinearWorkflowWorkerSelector;
}

function normalizeTarget(input: unknown): LinearWorkflowDefinition["target"] | null {
  if (!isRecord(input)) return null;
  const targetType = input.type;
  if (
    targetType !== "mission"
    && targetType !== "employee_session"
    && targetType !== "worker_run"
    && targetType !== "pr_resolution"
    && targetType !== "review_gate"
  ) {
    return null;
  }

  const normalizedSelector = normalizeWorkerSelector(input.workerSelector);

  const downstreamTarget = normalizeTarget(input.downstreamTarget);

  return {
    type: targetType,
    ...(normalizedSelector ? { workerSelector: normalizedSelector } : {}),
    ...(typeof input.employeeIdentityKey === "string" && input.employeeIdentityKey.trim().length
      ? { employeeIdentityKey: input.employeeIdentityKey.trim() as LinearWorkflowDefinition["target"]["employeeIdentityKey"] }
      : {}),
    ...(typeof input.sessionTemplate === "string" ? { sessionTemplate: input.sessionTemplate } : {}),
    ...(typeof input.missionTemplate === "string" ? { missionTemplate: input.missionTemplate } : {}),
    ...(input.executorKind === "cto" || input.executorKind === "employee" || input.executorKind === "worker"
      ? { executorKind: input.executorKind }
      : {}),
    ...(input.runMode === "autopilot" || input.runMode === "assisted" || input.runMode === "manual"
      ? { runMode: input.runMode }
      : {}),
    ...(input.prTiming === "after_start" || input.prTiming === "after_target_complete" || input.prTiming === "none"
      ? { prTiming: input.prTiming }
      : {}),
    ...(input.laneSelection === "primary" || input.laneSelection === "fresh_issue_lane" || input.laneSelection === "operator_prompt"
      ? { laneSelection: input.laneSelection }
      : {}),
    ...(input.sessionReuse === "reuse_existing" || input.sessionReuse === "fresh_session"
      ? { sessionReuse: input.sessionReuse }
      : {}),
    ...(typeof input.freshLaneName === "string" ? { freshLaneName: input.freshLaneName } : {}),
    ...(typeof input.phaseProfile === "string" ? { phaseProfile: input.phaseProfile } : {}),
    ...(isRecord(input.prStrategy) ? { prStrategy: input.prStrategy as LinearWorkflowDefinition["target"]["prStrategy"] } : {}),
    ...(downstreamTarget ? { downstreamTarget } : {}),
  };
}

function normalizeWorkflow(input: unknown, fallbackId: string): LinearWorkflowDefinition | null {
  if (!isRecord(input)) return null;
  const id = typeof input.id === "string" && input.id.trim().length ? input.id.trim() : fallbackId;
  const name = typeof input.name === "string" && input.name.trim().length ? input.name.trim() : id;
  if (!isRecord(input.target) || !isRecord(input.triggers)) return null;
  const target = normalizeTarget(input.target);
  if (!target) return null;

  return {
    id,
    name,
    enabled: input.enabled !== false,
    priority: Number.isFinite(Number(input.priority)) ? Math.floor(Number(input.priority)) : 100,
    ...(typeof input.description === "string" && input.description.trim().length
      ? { description: input.description.trim() }
      : {}),
    source: input.source === "repo" ? "repo" : "generated",
    triggers: {
      assignees: ensureStringArray(input.triggers.assignees),
      labels: ensureStringArray(input.triggers.labels),
      projectSlugs: ensureStringArray(input.triggers.projectSlugs),
      teamKeys: ensureStringArray(input.triggers.teamKeys),
      priority: ensureStringArray(input.triggers.priority) as LinearWorkflowDefinition["triggers"]["priority"],
      owner: ensureStringArray(input.triggers.owner),
      creator: ensureStringArray(input.triggers.creator),
      metadataTags: ensureStringArray(input.triggers.metadataTags),
      stateTransitions: Array.isArray(input.triggers.stateTransitions)
        ? input.triggers.stateTransitions
            .filter(isRecord)
            .map((entry) => ({
              ...(ensureStringArray(entry.from).length ? { from: ensureStringArray(entry.from) } : {}),
              to: ensureStringArray(entry.to),
            }))
            .filter((entry) => entry.to.length > 0)
        : [],
    },
    routing: isRecord(input.routing)
      ? {
          ...(ensureStringArray(input.routing.metadataTags).length
            ? { metadataTags: ensureStringArray(input.routing.metadataTags) }
            : {}),
          ...(typeof input.routing.watchOnly === "boolean" ? { watchOnly: input.routing.watchOnly } : {}),
        }
      : undefined,
    target,
    steps: Array.isArray(input.steps)
      ? input.steps
          .filter(isRecord)
          .map((entry, index) => ({
            id: typeof entry.id === "string" && entry.id.trim().length ? entry.id.trim() : `step-${index + 1}`,
            type: String(entry.type) as LinearWorkflowDefinition["steps"][number]["type"],
            ...(typeof entry.name === "string" ? { name: entry.name } : {}),
            ...(typeof entry.comment === "string" ? { comment: entry.comment } : {}),
            ...(typeof entry.state === "string" ? { state: entry.state as LinearWorkflowDefinition["steps"][number]["state"] } : {}),
            ...(typeof entry.assigneeId === "string" || entry.assigneeId === null ? { assigneeId: entry.assigneeId ?? null } : {}),
            ...(typeof entry.label === "string" ? { label: entry.label } : {}),
            ...(typeof entry.notificationTitle === "string" ? { notificationTitle: entry.notificationTitle } : {}),
            ...(typeof entry.targetStatus === "string" ? { targetStatus: entry.targetStatus as LinearWorkflowDefinition["steps"][number]["targetStatus"] } : {}),
            ...(typeof entry.reviewerIdentityKey === "string"
              ? { reviewerIdentityKey: entry.reviewerIdentityKey as LinearWorkflowDefinition["steps"][number]["reviewerIdentityKey"] }
              : {}),
            ...(entry.rejectAction === "cancel" || entry.rejectAction === "reopen_issue" || entry.rejectAction === "loop_back"
              ? { rejectAction: entry.rejectAction }
              : {}),
            ...(typeof entry.loopToStepId === "string" || entry.loopToStepId === null ? { loopToStepId: entry.loopToStepId ?? null } : {}),
          }))
      : [],
    closeout: isRecord(input.closeout)
      ? {
          ...(typeof input.closeout.successState === "string" ? { successState: input.closeout.successState } : {}),
          ...(typeof input.closeout.failureState === "string" ? { failureState: input.closeout.failureState } : {}),
          ...(typeof input.closeout.successComment === "string" ? { successComment: input.closeout.successComment } : {}),
          ...(typeof input.closeout.failureComment === "string" ? { failureComment: input.closeout.failureComment } : {}),
          ...(typeof input.closeout.commentTemplate === "string" ? { commentTemplate: input.closeout.commentTemplate } : {}),
          ...(ensureStringArray(input.closeout.applyLabels).length ? { applyLabels: ensureStringArray(input.closeout.applyLabels) } : {}),
          ...(ensureStringArray(input.closeout.labels).length ? { labels: ensureStringArray(input.closeout.labels) } : {}),
          ...(typeof input.closeout.reopenOnFailure === "boolean" ? { reopenOnFailure: input.closeout.reopenOnFailure } : {}),
          ...(typeof input.closeout.resolveOnSuccess === "boolean" ? { resolveOnSuccess: input.closeout.resolveOnSuccess } : {}),
          ...(input.closeout.reviewReadyWhen === "work_complete" || input.closeout.reviewReadyWhen === "pr_created" || input.closeout.reviewReadyWhen === "pr_ready"
            ? { reviewReadyWhen: input.closeout.reviewReadyWhen }
            : {}),
          ...(input.closeout.artifactMode === "attachments" ? { artifactMode: "attachments" } : {}),
        }
      : undefined,
    humanReview: isRecord(input.humanReview)
      ? {
          ...(typeof input.humanReview.required === "boolean" ? { required: input.humanReview.required } : {}),
          ...(ensureStringArray(input.humanReview.reviewers).length ? { reviewers: ensureStringArray(input.humanReview.reviewers) } : {}),
          ...(typeof input.humanReview.instructions === "string" ? { instructions: input.humanReview.instructions } : {}),
        }
      : undefined,
    retry: isRecord(input.retry)
      ? {
          ...(Number.isFinite(Number(input.retry.maxAttempts)) ? { maxAttempts: Math.max(0, Math.floor(Number(input.retry.maxAttempts))) } : {}),
          ...(Number.isFinite(Number(input.retry.baseDelaySec)) ? { baseDelaySec: Math.max(5, Math.floor(Number(input.retry.baseDelaySec))) } : {}),
          ...(Number.isFinite(Number(input.retry.backoffSeconds)) ? { backoffSeconds: Math.max(5, Math.floor(Number(input.retry.backoffSeconds))) } : {}),
        }
      : undefined,
    concurrency: isRecord(input.concurrency)
      ? {
          ...(Number.isFinite(Number(input.concurrency.maxActiveRuns))
            ? { maxActiveRuns: Math.max(1, Math.floor(Number(input.concurrency.maxActiveRuns))) }
            : {}),
          ...(Number.isFinite(Number(input.concurrency.perIssue))
            ? { perIssue: Math.max(1, Math.floor(Number(input.concurrency.perIssue))) }
            : {}),
          ...(typeof input.concurrency.dedupeByIssue === "boolean" ? { dedupeByIssue: input.concurrency.dedupeByIssue } : {}),
        }
      : undefined,
    observability: isRecord(input.observability)
      ? {
          ...(typeof input.observability.emitNotifications === "boolean" ? { emitNotifications: input.observability.emitNotifications } : {}),
          ...(typeof input.observability.captureIssueSnapshot === "boolean" ? { captureIssueSnapshot: input.observability.captureIssueSnapshot } : {}),
          ...(typeof input.observability.persistTimeline === "boolean" ? { persistTimeline: input.observability.persistTimeline } : {}),
        }
      : undefined,
  };
}

function migrateLegacyConfig(legacy: LinearSyncConfig | null | undefined): LinearWorkflowConfig {
  const baseWorkflow = createWorkflowPreset("mission", {
    id: "cto-mission-autopilot",
    name: "CTO -> Mission autopilot",
    description: "Default migrated mission-backed workflow.",
  });
  baseWorkflow.target = { ...baseWorkflow.target, type: "mission", runMode: "autopilot", missionTemplate: "default" };

  if (!legacy) {
    const base = createDefaultLinearWorkflowConfig();
    return {
      ...base,
      intake: normalizeIntake(null),
      workflows: [
        baseWorkflow,
        {
          ...createWorkflowPreset("employee_session", {
            id: "cto-direct-employee-session",
            name: "CTO -> Direct employee session",
            description: "Opens a direct tracked employee session.",
            triggerLabels: ["employee-session"],
          }),
          target: {
            ...createWorkflowPreset("employee_session").target,
            type: "employee_session",
            runMode: "assisted",
            sessionTemplate: "default",
            laneSelection: "fresh_issue_lane",
            sessionReuse: "fresh_session",
            prTiming: "none",
          },
        },
        {
          ...createWorkflowPreset("worker_run", {
            id: "cto-worker-run-autopilot",
            name: "CTO -> Worker run autopilot",
            description: "Launches a worker run that waits for explicit ADE completion.",
            triggerLabels: ["worker-run"],
          }),
          target: {
            ...createWorkflowPreset("worker_run").target,
            type: "worker_run",
            runMode: "autopilot",
          },
        },
        {
          ...createWorkflowPreset("pr_resolution", {
            id: "cto-pr-fast-lane",
            name: "CTO -> PR-only fast lane",
            description: "Routes directly to a PR-oriented worker run.",
            triggerLabels: ["fast-lane"],
          }),
          target: {
            ...createWorkflowPreset("pr_resolution").target,
            type: "pr_resolution",
            runMode: "autopilot",
          },
        },
        {
          ...createWorkflowPreset("review_gate", {
            id: "cto-human-review-gate",
            name: "CTO -> Human review gate",
            description: "Creates a tracked run that blocks for approval.",
            triggerLabels: ["needs-triage"],
          }),
          target: {
            ...createWorkflowPreset("review_gate").target,
            type: "review_gate",
            runMode: "manual",
          },
        },
      ],
      migration: {
        hasLegacyConfig: false,
        needsSave: true,
      },
    };
  }

  const projects = legacy.projects ?? [];
  const workflows: LinearWorkflowDefinition[] = [];
  const defaultProjectSlug = projects[0]?.slug ?? null;

  for (const [index, rule] of (legacy.autoDispatch?.rules ?? []).entries()) {
    const targetType = rule.action === "auto" ? "mission" : "review_gate";
    const labelMatch = rule.match?.labels?.[0]?.trim().toLowerCase() ?? null;
    const labelRoute = labelMatch ? legacy.routing?.byLabel?.[labelMatch] : null;
    const projectWorker = defaultProjectSlug
      ? projects.find((entry) => entry.slug === defaultProjectSlug)?.defaultWorker ?? null
      : null;

    workflows.push({
      id: rule.id?.trim() || `legacy-rule-${index + 1}`,
      name: rule.id?.trim() || `Migrated rule ${index + 1}`,
      enabled: true,
      priority: 100 - index,
      description: `Migrated from legacy LinearSyncConfig rule ${rule.id ?? index + 1}.`,
      source: "generated",
      triggers: {
        assignees: ["CTO"],
        ...(rule.match?.labels?.length ? { labels: rule.match.labels } : {}),
        ...(rule.match?.projectSlugs?.length ? { projectSlugs: rule.match.projectSlugs } : {}),
        ...(rule.match?.priority?.length ? { priority: rule.match.priority } : {}),
        ...(rule.match?.owner?.length ? { owner: rule.match.owner } : {}),
      },
      target: {
        type: targetType,
        runMode: targetType === "review_gate" ? "manual" : "autopilot",
        missionTemplate: rule.template ?? "default",
        ...(labelRoute
          ? { workerSelector: { mode: "slug", value: labelRoute } as const }
          : projectWorker
            ? { workerSelector: { mode: "slug", value: projectWorker } as const }
            : {}),
      },
      steps: [
        { id: "launch", type: "launch_target", name: "Launch target" },
        ...(targetType === "review_gate"
          ? [{ id: "review", type: "request_human_review", name: "Review gate" } as const]
          : [{ id: "wait", type: "wait_for_target_status", name: "Wait for mission", targetStatus: "completed" } as const]),
        { id: "complete", type: "complete_issue", name: "Complete issue" },
      ],
      closeout: {
        successState: "done",
        failureState: "blocked",
        applyLabels: ["ade"],
        resolveOnSuccess: true,
        reopenOnFailure: true,
        artifactMode: legacy.artifacts?.mode === "attachments" ? "attachments" : "links",
      },
      retry: {
        maxAttempts: 3,
        baseDelaySec: 30,
      },
      concurrency: {
        maxActiveRuns: legacy.concurrency?.global ?? 5,
        perIssue: 1,
      },
      observability: {
        emitNotifications: true,
        captureIssueSnapshot: true,
        persistTimeline: true,
      },
    });
  }

  if (!workflows.length) {
    workflows.push(baseWorkflow);
  }

  return {
    version: WORKFLOW_VERSION,
    source: "generated",
    intake: {
      projectSlugs: projects.map((project) => project.slug).filter(Boolean),
      activeStateTypes: [...DEFAULT_ACTIVE_STATE_TYPES],
      terminalStateTypes: [...DEFAULT_TERMINAL_STATE_TYPES],
    },
    settings: { ctoLinearAssigneeName: "CTO", ctoLinearAssigneeAliases: ["cto"] },
    workflows,
    files: [],
    migration: {
      hasLegacyConfig: true,
      needsSave: true,
    },
    legacyConfig: legacy,
  };
}

export function createLinearWorkflowFileService(args: {
  projectRoot: string;
}) {
  const layout = resolveAdeLayout(args.projectRoot);
  const workflowDir = layout.linearWorkflowsDir;
  const cacheDir = path.join(layout.cacheDir, "workflows", "linear");
  const settingsPath = path.join(workflowDir, SETTINGS_FILE);
  const cacheIndexPath = path.join(cacheDir, "index.json");
  const legacySnapshotPath = path.join(cacheDir, LEGACY_SNAPSHOT_FILE);

  const listWorkflowFiles = (): string[] => {
    if (!fs.existsSync(workflowDir)) return [];
    return fs
      .readdirSync(workflowDir)
      .filter((entry) => entry.endsWith(".yaml") || entry.endsWith(".yml"))
      .sort()
      .map((entry) => path.join(workflowDir, entry));
  };

  const readSettings = (): { settings: LinearWorkflowSettings; intake: LinearWorkflowIntake } => {
    if (!fs.existsSync(settingsPath)) {
      return {
        settings: {},
        intake: normalizeIntake(null),
      };
    }
    const raw = fs.readFileSync(settingsPath, "utf8");
    const parsed = YAML.parse(raw);
    if (!isRecord(parsed)) return { settings: {}, intake: normalizeIntake(null) };
    return {
      settings: {
        ...(typeof parsed.ctoLinearAssigneeId === "string" ? { ctoLinearAssigneeId: parsed.ctoLinearAssigneeId } : {}),
        ...(typeof parsed.ctoLinearAssigneeName === "string" ? { ctoLinearAssigneeName: parsed.ctoLinearAssigneeName } : {}),
        ...(ensureStringArray(parsed.ctoLinearAssigneeAliases).length
          ? { ctoLinearAssigneeAliases: ensureStringArray(parsed.ctoLinearAssigneeAliases) }
          : {}),
      },
      intake: normalizeIntake(parsed.intake),
    };
  };

  const load = (legacyConfig?: LinearSyncConfig | null): LinearWorkflowConfig => {
    const files = listWorkflowFiles();
    const workflowFiles = files.filter((filePath) => path.basename(filePath) !== SETTINGS_FILE);
    if (!workflowFiles.length) {
      const generated = migrateLegacyConfig(legacyConfig);
      return {
        ...generated,
        migration: {
          hasLegacyConfig: generated.migration?.hasLegacyConfig === true,
          needsSave: generated.migration?.needsSave === true,
          compatibilitySnapshotPath: legacyConfig ? legacySnapshotPath : null,
        },
      };
    }

    const settingsDoc = readSettings();
    const workflows = workflowFiles
      .map((filePath, index) => {
        const raw = fs.readFileSync(filePath, "utf8");
        return normalizeWorkflow(YAML.parse(raw), `workflow-${index + 1}`);
      })
      .filter((entry): entry is LinearWorkflowDefinition => entry != null)
      .sort((left, right) => right.priority - left.priority || left.name.localeCompare(right.name));

    const fileEntries: LinearWorkflowConfigFileMeta[] = files.map((filePath) => {
      const raw = fs.readFileSync(filePath, "utf8");
      const kind: LinearWorkflowConfigFileMeta["kind"] = path.basename(filePath) === SETTINGS_FILE ? "settings" : "workflow";
      const workflowId = kind === "workflow"
        ? normalizeWorkflow(YAML.parse(raw), path.basename(filePath, path.extname(filePath)))?.id ?? null
        : null;
      return {
        path: filePath,
        workflowId,
        kind,
        hash: hashContent(raw),
      };
    });

    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(
      cacheIndexPath,
      JSON.stringify(
        {
          version: WORKFLOW_VERSION,
          loadedAt: new Date().toISOString(),
          files: fileEntries,
        },
        null,
        2
      ),
      "utf8"
    );

    return {
      version: WORKFLOW_VERSION,
      source: "repo",
      intake: settingsDoc.intake,
      settings: settingsDoc.settings,
      workflows,
      files: fileEntries,
      migration: {
        hasLegacyConfig: Boolean(legacyConfig),
        needsSave: false,
        compatibilitySnapshotPath: fs.existsSync(legacySnapshotPath) ? legacySnapshotPath : null,
      },
      legacyConfig: legacyConfig ?? null,
    };
  };

  const save = (config: LinearWorkflowConfig): LinearWorkflowConfig => {
    fs.mkdirSync(workflowDir, { recursive: true });
    fs.mkdirSync(cacheDir, { recursive: true });

    const existing = new Set(listWorkflowFiles());
    const nextWorkflowPaths = new Set<string>();

    const settingsYaml = YAML.stringify({
      ctoLinearAssigneeId: config.settings.ctoLinearAssigneeId ?? null,
      ctoLinearAssigneeName: config.settings.ctoLinearAssigneeName ?? "CTO",
      ctoLinearAssigneeAliases: config.settings.ctoLinearAssigneeAliases ?? ["cto"],
      intake: normalizeIntake(config.intake),
    }, { indent: 2 });
    fs.writeFileSync(settingsPath, settingsYaml, "utf8");
    nextWorkflowPaths.add(settingsPath);

    for (const workflow of config.workflows) {
      const filePath = path.join(workflowDir, `${slugify(workflow.id)}.yaml`);
      nextWorkflowPaths.add(filePath);
      fs.writeFileSync(filePath, YAML.stringify({ ...workflow, source: "repo" }, { indent: 2 }), "utf8");
    }

    for (const filePath of existing) {
      if (nextWorkflowPaths.has(filePath)) continue;
      fs.rmSync(filePath, { force: true });
    }

    if (config.legacyConfig) {
      fs.writeFileSync(legacySnapshotPath, JSON.stringify(config.legacyConfig, null, 2), "utf8");
    }

    return load(config.legacyConfig ?? null);
  };

  return {
    workflowDir,
    cacheDir,
    cacheIndexPath,
    legacySnapshotPath,
    load,
    save,
  };
}

export type LinearWorkflowFileService = ReturnType<typeof createLinearWorkflowFileService>;
