import { randomUUID } from "node:crypto";
import type {
  CtoFlowPolicyRevision,
  LinearSyncConfig,
  LinearWorkflowConfig,
  LinearWorkflowDefinition,
  LinearWorkflowIntake,
} from "../../../shared/types";
import type { AdeDb } from "../state/kvDb";
import { nowIso, safeJsonParse } from "../shared/utils";
import type { LinearWorkflowFileService } from "./linearWorkflowFileService";

type ProjectConfigServiceLike = {
  getEffective: () => { linearSync?: LinearSyncConfig };
};

const DEFAULT_POLICY: LinearWorkflowConfig = {
  version: 1,
  source: "generated",
  intake: {
    activeStateTypes: ["backlog", "unstarted", "started"],
    terminalStateTypes: ["completed", "canceled"],
  },
  settings: {
    ctoLinearAssigneeName: "CTO",
    ctoLinearAssigneeAliases: ["cto"],
  },
  workflows: [],
  files: [],
  migration: {
    hasLegacyConfig: false,
    needsSave: true,
  },
  legacyConfig: null,
};

function uniqueStrings(values: Array<string | null | undefined> | null | undefined): string[] {
  return Array.from(
    new Set(
      (values ?? [])
        .map((entry) => entry?.trim() ?? "")
        .filter((entry) => entry.length > 0)
    )
  );
}

function normalizeIntake(
  input: LinearWorkflowIntake | null | undefined,
  workflows: LinearWorkflowDefinition[],
  legacy: LinearSyncConfig | null | undefined,
): LinearWorkflowIntake {
  const workflowProjectSlugs = workflows.flatMap((workflow) => workflow.triggers.projectSlugs ?? []);
  const legacyProjectSlugs = legacy?.projects?.map((entry) => entry.slug) ?? [];
  const projectSlugs = uniqueStrings([
    ...(input?.projectSlugs ?? []),
    ...workflowProjectSlugs,
    ...legacyProjectSlugs,
  ]);
  return {
    ...(projectSlugs.length ? { projectSlugs } : {}),
    activeStateTypes: uniqueStrings(input?.activeStateTypes ?? DEFAULT_POLICY.intake.activeStateTypes),
    terminalStateTypes: uniqueStrings(input?.terminalStateTypes ?? DEFAULT_POLICY.intake.terminalStateTypes),
  };
}

function normalizeTarget(target: LinearWorkflowDefinition["target"]): LinearWorkflowDefinition["target"] {
  return {
    ...target,
    ...(target.workerSelector ? { workerSelector: structuredClone(target.workerSelector) } : {}),
    ...(target.prStrategy ? { prStrategy: structuredClone(target.prStrategy) } : {}),
    ...(target.downstreamTarget ? { downstreamTarget: normalizeTarget(target.downstreamTarget) } : {}),
  };
}

function normalizePolicy(input?: LinearWorkflowConfig | null): LinearWorkflowConfig {
  const source = input ?? DEFAULT_POLICY;
  const workflows = (source.workflows ?? [])
    .map<LinearWorkflowDefinition>((entry) => {
      const target = entry.target ?? ({} as LinearWorkflowDefinition["target"]);
      const triggers = entry.triggers ?? ({} as LinearWorkflowDefinition["triggers"]);
      return {
      ...entry,
      id: entry.id?.trim() || "",
      name: entry.name?.trim() || "",
      source: entry.source === "repo" ? "repo" : "generated",
      priority: Number.isFinite(Number(entry.priority)) ? Math.floor(Number(entry.priority)) : 100,
      enabled: entry.enabled !== false,
      target: normalizeTarget(target),
      triggers: {
        assignees: uniqueStrings(triggers.assignees),
        labels: uniqueStrings(triggers.labels),
        projectSlugs: uniqueStrings(triggers.projectSlugs),
        teamKeys: uniqueStrings(triggers.teamKeys),
        priority: uniqueStrings(triggers.priority) as LinearWorkflowDefinition["triggers"]["priority"],
        stateTransitions: (triggers.stateTransitions ?? [])
          .map((transition) => {
            const from = uniqueStrings(transition?.from);
            const to = uniqueStrings(transition?.to);
            return {
              ...(from.length ? { from } : {}),
              ...(to.length ? { to } : {}),
            };
          })
          .filter((transition) => (transition.to?.length ?? 0) > 0),
        owner: uniqueStrings(triggers.owner),
        creator: uniqueStrings(triggers.creator),
        metadataTags: uniqueStrings(triggers.metadataTags),
      },
      ...(entry.routing
        ? (() => {
            const routeTags = uniqueStrings(entry.routing.metadataTags);
            return {
              routing: {
                ...(routeTags.length ? { metadataTags: routeTags } : {}),
                ...(entry.routing.watchOnly === true ? { watchOnly: true } : {}),
              },
            };
          })()
        : {}),
      steps: (entry.steps ?? []).map((step, index) => ({
        ...step,
        id: step.id?.trim() || `step-${index + 1}`,
      })),
      ...(entry.closeout
        ? (() => {
            const applyLabels = uniqueStrings(entry.closeout.applyLabels);
            const labels = uniqueStrings(entry.closeout.labels);
            return {
              closeout: {
                ...entry.closeout,
                ...(applyLabels.length ? { applyLabels } : {}),
                ...(labels.length ? { labels } : {}),
              },
            };
          })()
        : {}),
      ...(entry.humanReview
        ? (() => {
            const reviewers = uniqueStrings(entry.humanReview.reviewers);
            return {
              humanReview: {
                ...entry.humanReview,
                ...(reviewers.length ? { reviewers } : {}),
              },
            };
          })()
        : {}),
      ...(entry.retry
        ? {
            retry: {
              ...entry.retry,
              ...(Number.isFinite(Number(entry.retry.maxAttempts))
                ? { maxAttempts: Math.max(0, Math.floor(Number(entry.retry.maxAttempts))) }
                : {}),
              ...(Number.isFinite(Number(entry.retry.baseDelaySec))
                ? { baseDelaySec: Math.max(5, Math.floor(Number(entry.retry.baseDelaySec))) }
                : {}),
              ...(Number.isFinite(Number(entry.retry.backoffSeconds))
                ? { backoffSeconds: Math.max(5, Math.floor(Number(entry.retry.backoffSeconds))) }
                : {}),
            },
          }
        : {}),
      ...(entry.concurrency
        ? {
            concurrency: {
              ...entry.concurrency,
              ...(Number.isFinite(Number(entry.concurrency.maxActiveRuns))
                ? { maxActiveRuns: Math.max(1, Math.floor(Number(entry.concurrency.maxActiveRuns))) }
                : {}),
              ...(Number.isFinite(Number(entry.concurrency.perIssue))
                ? { perIssue: Math.max(1, Math.floor(Number(entry.concurrency.perIssue))) }
                : {}),
              ...(typeof entry.concurrency.dedupeByIssue === "boolean"
                ? { dedupeByIssue: entry.concurrency.dedupeByIssue }
                : {}),
            },
          }
        : {}),
    };
    })
    .sort((left, right) => right.priority - left.priority || left.name.localeCompare(right.name));
  return {
    version: 1,
    source: source.source === "repo" ? "repo" : "generated",
    intake: normalizeIntake(source.intake, workflows, source.legacyConfig),
    settings: {
      ...(typeof source.settings?.ctoLinearAssigneeId === "string" ? { ctoLinearAssigneeId: source.settings.ctoLinearAssigneeId } : {}),
      ctoLinearAssigneeName: source.settings?.ctoLinearAssigneeName?.trim() || "CTO",
      ctoLinearAssigneeAliases: (source.settings?.ctoLinearAssigneeAliases ?? ["cto"])
        .map((entry) => entry.trim())
        .filter(Boolean),
    },
    workflows,
    files: Array.isArray(source.files) ? source.files : [],
    migration: source.migration
      ? {
          hasLegacyConfig: source.migration.hasLegacyConfig === true,
          needsSave: source.migration.needsSave === true,
          ...(source.migration.compatibilitySnapshotPath ? { compatibilitySnapshotPath: source.migration.compatibilitySnapshotPath } : {}),
        }
      : {
          hasLegacyConfig: false,
          needsSave: false,
        },
    legacyConfig: source.legacyConfig ?? null,
  };
}

function diffPolicyPaths(previous: unknown, next: unknown, basePath = "linearWorkflows"): string[] {
  if (previous === next) return [];
  if (
    previous == null ||
    next == null ||
    typeof previous !== "object" ||
    typeof next !== "object" ||
    Array.isArray(previous) ||
    Array.isArray(next)
  ) {
    return [basePath];
  }

  const keys = new Set<string>([...Object.keys(previous), ...Object.keys(next)]);
  const changes: string[] = [];
  for (const key of keys) {
    const childPath = `${basePath}.${key}`;
    const prevValue = (previous as Record<string, unknown>)[key];
    const nextValue = (next as Record<string, unknown>)[key];
    changes.push(...diffPolicyPaths(prevValue, nextValue, childPath));
  }
  return Array.from(new Set(changes)).sort();
}

export function createFlowPolicyService(args: {
  db: AdeDb;
  projectId: string;
  projectConfigService: ProjectConfigServiceLike;
  workflowFileService: LinearWorkflowFileService;
}) {
  const getPolicyRow = (): { policy_json: string; active_revision_id: string | null } | null =>
    args.db.get<{ policy_json: string; active_revision_id: string | null }>(
      `select policy_json, active_revision_id from cto_flow_policies where project_id = ? limit 1`,
      [args.projectId]
    );

  const legacyConfig = (): LinearSyncConfig | null => args.projectConfigService.getEffective().linearSync ?? null;

  const readPolicyFromDb = (): LinearWorkflowConfig | null => {
    const row = getPolicyRow();
    if (!row?.policy_json) return null;
    return normalizePolicy(safeJsonParse<LinearWorkflowConfig>(row.policy_json, DEFAULT_POLICY));
  };

  const readPolicyFromRepo = (): LinearWorkflowConfig => {
    return normalizePolicy(args.workflowFileService.load(legacyConfig()));
  };

  const persistPolicy = (policy: LinearWorkflowConfig, revisionId: string, actor: string): void => {
    args.db.run(
      `
        insert into cto_flow_policies(project_id, policy_json, active_revision_id, updated_at, updated_by)
        values(?, ?, ?, ?, ?)
        on conflict(project_id) do update set
          policy_json = excluded.policy_json,
          active_revision_id = excluded.active_revision_id,
          updated_at = excluded.updated_at,
          updated_by = excluded.updated_by
      `,
      [args.projectId, JSON.stringify(policy), revisionId, nowIso(), actor]
    );
  };

  const insertRevision = (policy: LinearWorkflowConfig, actor: string): CtoFlowPolicyRevision => {
    const current = readPolicyFromDb() ?? readPolicyFromRepo();
    const revision: CtoFlowPolicyRevision = {
      id: randomUUID(),
      actor,
      createdAt: nowIso(),
      policy: structuredClone(policy),
    };
    args.db.run(
      `
        insert into cto_flow_policy_revisions(id, project_id, actor, policy_json, diff_json, created_at)
        values(?, ?, ?, ?, ?, ?)
      `,
      [
        revision.id,
        args.projectId,
        actor,
        JSON.stringify(policy),
        JSON.stringify(diffPolicyPaths(current, policy)),
        revision.createdAt,
      ]
    );
    persistPolicy(policy, revision.id, actor);
    return revision;
  };

  const getPolicy = (): LinearWorkflowConfig => {
    const fromDb = readPolicyFromDb();
    if (fromDb) return fromDb;
    const fromRepo = readPolicyFromRepo();
    insertRevision(fromRepo, "bootstrap");
    return fromRepo;
  };

  const validatePolicy = (policy: LinearWorkflowConfig): { ok: boolean; issues: string[] } => {
    const issues: string[] = [];
    const normalized = normalizePolicy(policy);
    if (!normalized.intake.activeStateTypes?.length) {
      issues.push("At least one intake active state type is required.");
    }
    if (!normalized.intake.terminalStateTypes?.length) {
      issues.push("At least one intake terminal state type is required.");
    }
    if (!normalized.workflows.length) {
      issues.push("At least one workflow is required.");
    }

    const ids = new Set<string>();
    for (const workflow of normalized.workflows) {
      const key = workflow.id.toLowerCase();
      if (ids.has(key)) issues.push(`Duplicate workflow id: ${workflow.id}`);
      ids.add(key);
      if (!workflow.steps.length) issues.push(`Workflow '${workflow.name}' requires at least one step.`);
      if (!workflow.target?.type) issues.push(`Workflow '${workflow.name}' requires a target.`);
      if (
        !workflow.triggers.assignees?.length &&
        !workflow.triggers.labels?.length &&
        !workflow.triggers.projectSlugs?.length &&
        !workflow.triggers.teamKeys?.length &&
        !workflow.triggers.priority?.length &&
        !workflow.triggers.stateTransitions?.length &&
        !workflow.triggers.owner?.length &&
        !workflow.triggers.creator?.length &&
        !workflow.triggers.metadataTags?.length
      ) {
        issues.push(`Workflow '${workflow.name}' requires at least one trigger.`);
      }
    }

    return { ok: issues.length === 0, issues };
  };

  const savePolicy = (policy: LinearWorkflowConfig, actor = "user"): LinearWorkflowConfig => {
    const normalized = normalizePolicy(policy);
    const validation = validatePolicy(normalized);
    if (!validation.ok) {
      throw new Error(`Invalid flow policy: ${validation.issues.join(" ")}`);
    }

    const saved = normalizePolicy(args.workflowFileService.save(normalized));
    insertRevision(saved, actor);
    return saved;
  };

  const listRevisions = (limit = 20): CtoFlowPolicyRevision[] => {
    const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
    const rows = args.db.all<{ id: string; actor: string; policy_json: string; created_at: string }>(
      `
        select id, actor, policy_json, created_at
        from cto_flow_policy_revisions
        where project_id = ?
        order by created_at desc
        limit ?
      `,
      [args.projectId, safeLimit]
    );

    return rows
      .map((row) => {
        const parsed = safeJsonParse<LinearWorkflowConfig | null>(row.policy_json, null);
        if (!parsed) return null;
        return {
          id: row.id,
          actor: row.actor,
          createdAt: row.created_at,
          policy: normalizePolicy(parsed),
        };
      })
      .filter((entry): entry is CtoFlowPolicyRevision => entry != null);
  };

  const rollbackRevision = (revisionId: string, actor = "user"): LinearWorkflowConfig => {
    const row = args.db.get<{ policy_json: string }>(
      `
        select policy_json
        from cto_flow_policy_revisions
        where project_id = ?
          and id = ?
        limit 1
      `,
      [args.projectId, revisionId]
    );
    if (!row?.policy_json) {
      throw new Error(`Flow policy revision not found: ${revisionId}`);
    }
    const parsed = safeJsonParse<LinearWorkflowConfig | null>(row.policy_json, null);
    if (!parsed) {
      throw new Error(`Flow policy revision payload is invalid: ${revisionId}`);
    }
    return savePolicy(parsed, actor);
  };

  return {
    getPolicy,
    savePolicy,
    listRevisions,
    rollbackRevision,
    validatePolicy,
    normalizePolicy,
    diffPolicyPaths,
    defaults: structuredClone(DEFAULT_POLICY),
  };
}

export type FlowPolicyService = ReturnType<typeof createFlowPolicyService>;
