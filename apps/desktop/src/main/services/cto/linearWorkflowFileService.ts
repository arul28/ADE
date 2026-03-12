import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import YAML from "yaml";
import type {
  LinearSyncConfig,
  LinearWorkflowConfig,
  LinearWorkflowConfigFileMeta,
  LinearWorkflowDefinition,
  LinearWorkflowSettings,
  LinearWorkflowWorkerSelector,
} from "../../../shared/types";
import { resolveAdeLayout } from "../../../shared/adeLayout";
import { isRecord } from "../shared/utils";

const WORKFLOW_VERSION = 1 as const;
const SETTINGS_FILE = "_settings.yaml";
const LEGACY_SNAPSHOT_FILE = "legacy-linear-sync.snapshot.json";

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

function normalizeWorkflow(input: unknown, fallbackId: string): LinearWorkflowDefinition | null {
  if (!isRecord(input)) return null;
  const id = typeof input.id === "string" && input.id.trim().length ? input.id.trim() : fallbackId;
  const name = typeof input.name === "string" && input.name.trim().length ? input.name.trim() : id;
  if (!isRecord(input.target) || !isRecord(input.triggers)) return null;
  const targetType = input.target.type;
  if (
    targetType !== "mission" &&
    targetType !== "employee_session" &&
    targetType !== "worker_run" &&
    targetType !== "pr_resolution" &&
    targetType !== "review_gate"
  ) {
    return null;
  }

  const workerSelector = isRecord(input.target.workerSelector)
    ? input.target.workerSelector
    : null;
  const normalizedSelector: LinearWorkflowWorkerSelector | undefined = workerSelector
    && (workerSelector.mode === "id" || workerSelector.mode === "slug" || workerSelector.mode === "capability" || workerSelector.mode === "none")
    ? workerSelector.mode === "none"
      ? { mode: "none" }
      : typeof workerSelector.value === "string" && workerSelector.value.trim().length
        ? {
            mode: workerSelector.mode,
            value: workerSelector.value.trim(),
          } as LinearWorkflowWorkerSelector
        : undefined
    : undefined;

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
        }
      : undefined,
    target: {
      type: targetType,
      ...(normalizedSelector ? { workerSelector: normalizedSelector } : {}),
      ...(typeof input.target.employeeIdentityKey === "string" && input.target.employeeIdentityKey.trim().length
        ? { employeeIdentityKey: input.target.employeeIdentityKey.trim() as LinearWorkflowDefinition["target"]["employeeIdentityKey"] }
        : {}),
      ...(typeof input.target.sessionTemplate === "string" ? { sessionTemplate: input.target.sessionTemplate } : {}),
      ...(typeof input.target.missionTemplate === "string" ? { missionTemplate: input.target.missionTemplate } : {}),
      ...(input.target.executorKind === "cto" || input.target.executorKind === "employee" || input.target.executorKind === "worker"
        ? { executorKind: input.target.executorKind }
        : {}),
      ...(input.target.runMode === "autopilot" || input.target.runMode === "assisted" || input.target.runMode === "manual"
        ? { runMode: input.target.runMode }
        : {}),
      ...(typeof input.target.phaseProfile === "string" ? { phaseProfile: input.target.phaseProfile } : {}),
      ...(isRecord(input.target.prStrategy) ? { prStrategy: input.target.prStrategy as LinearWorkflowDefinition["target"]["prStrategy"] } : {}),
    },
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
          }))
      : [],
    closeout: isRecord(input.closeout)
      ? {
          ...(typeof input.closeout.successState === "string" ? { successState: input.closeout.successState } : {}),
          ...(typeof input.closeout.failureState === "string" ? { failureState: input.closeout.failureState } : {}),
          ...(typeof input.closeout.successComment === "string" ? { successComment: input.closeout.successComment } : {}),
          ...(typeof input.closeout.failureComment === "string" ? { failureComment: input.closeout.failureComment } : {}),
          ...(ensureStringArray(input.closeout.applyLabels).length ? { applyLabels: ensureStringArray(input.closeout.applyLabels) } : {}),
          ...(typeof input.closeout.reopenOnFailure === "boolean" ? { reopenOnFailure: input.closeout.reopenOnFailure } : {}),
          ...(typeof input.closeout.resolveOnSuccess === "boolean" ? { resolveOnSuccess: input.closeout.resolveOnSuccess } : {}),
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

function buildStarterWorkflow(args: {
  id: string;
  name: string;
  description: string;
  target: LinearWorkflowDefinition["target"];
  labels?: string[];
}): LinearWorkflowDefinition {
  const reviewRequired = args.target.type === "review_gate";
  return {
    id: args.id,
    name: args.name,
    enabled: true,
    priority: 100,
    description: args.description,
    source: "generated",
    triggers: {
      assignees: ["CTO"],
      ...(args.labels?.length ? { labels: args.labels } : {}),
    },
    target: args.target,
    steps: [
      { id: "launch", type: "launch_target", name: "Launch target" },
      ...(reviewRequired
        ? [{ id: "review", type: "request_human_review", name: "Request human review" } as const]
        : [{ id: "wait", type: "wait_for_target_status", name: "Wait for completion", targetStatus: "completed" } as const]),
      { id: "complete", type: "complete_issue", name: "Complete issue" },
    ],
    closeout: {
      successState: "done",
      failureState: "blocked",
      applyLabels: ["ade"],
      resolveOnSuccess: true,
      reopenOnFailure: true,
      artifactMode: "links",
    },
    humanReview: reviewRequired ? { required: true } : undefined,
    retry: { maxAttempts: 3, baseDelaySec: 30 },
    concurrency: { maxActiveRuns: 5, perIssue: 1 },
    observability: { emitNotifications: true, captureIssueSnapshot: true, persistTimeline: true },
  };
}

function migrateLegacyConfig(legacy: LinearSyncConfig | null | undefined): LinearWorkflowConfig {
  const baseWorkflow = buildStarterWorkflow({
    id: "cto-mission-autopilot",
    name: "CTO -> Mission autopilot",
    description: "Default migrated mission-backed workflow.",
    target: { type: "mission", runMode: "autopilot", missionTemplate: "default" },
  });

  if (!legacy) {
    return {
      version: WORKFLOW_VERSION,
      source: "generated",
      settings: { ctoLinearAssigneeName: "CTO", ctoLinearAssigneeAliases: ["cto"] },
      workflows: [
        baseWorkflow,
        buildStarterWorkflow({
          id: "cto-direct-employee-session",
          name: "CTO -> Direct employee session",
          description: "Opens a direct tracked employee session.",
          target: { type: "employee_session", runMode: "assisted" },
          labels: ["employee-session"],
        }),
        buildStarterWorkflow({
          id: "cto-pr-fast-lane",
          name: "CTO -> PR-only fast lane",
          description: "Routes directly to a PR-oriented worker run.",
          target: { type: "pr_resolution", runMode: "autopilot" },
          labels: ["fast-lane"],
        }),
        buildStarterWorkflow({
          id: "cto-human-review-gate",
          name: "CTO -> Human review gate",
          description: "Creates a tracked run that blocks for approval.",
          target: { type: "review_gate", runMode: "manual" },
          labels: ["needs-triage"],
        }),
      ],
      files: [],
      migration: {
        hasLegacyConfig: false,
        needsSave: true,
      },
      legacyConfig: null,
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
  const workflowDir = path.join(layout.adeDir, "workflows", "linear");
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

  const readSettings = (): LinearWorkflowSettings => {
    if (!fs.existsSync(settingsPath)) return {};
    const raw = fs.readFileSync(settingsPath, "utf8");
    const parsed = YAML.parse(raw);
    if (!isRecord(parsed)) return {};
    return {
      ...(typeof parsed.ctoLinearAssigneeId === "string" ? { ctoLinearAssigneeId: parsed.ctoLinearAssigneeId } : {}),
      ...(typeof parsed.ctoLinearAssigneeName === "string" ? { ctoLinearAssigneeName: parsed.ctoLinearAssigneeName } : {}),
      ...(ensureStringArray(parsed.ctoLinearAssigneeAliases).length
        ? { ctoLinearAssigneeAliases: ensureStringArray(parsed.ctoLinearAssigneeAliases) }
        : {}),
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

    const settings = readSettings();
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
      settings,
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
