import { randomUUID } from "node:crypto";
import type {
  CtoFlowPolicyRevision,
  LinearAutoDispatchAction,
  LinearSyncConfig,
} from "../../../shared/types";
import type { AdeDb } from "../state/kvDb";
import { isRecord, nowIso, safeJsonParse } from "../shared/utils";

const DEFAULT_POLICY: LinearSyncConfig = {
  enabled: false,
  pollingIntervalSec: 300,
  projects: [],
  routing: { byLabel: {} },
  assignment: { setAssigneeOnDispatch: false },
  autoDispatch: {
    rules: [],
    default: "escalate",
  },
  concurrency: {
    global: 5,
    byState: {
      todo: 3,
      in_progress: 5,
    },
  },
  reconciliation: {
    enabled: true,
    stalledTimeoutSec: 300,
  },
  classification: {
    mode: "hybrid",
    confidenceThreshold: 0.7,
  },
  artifacts: {
    mode: "links",
  },
};

type ProjectConfigServiceLike = {
  getEffective: () => { linearSync?: LinearSyncConfig };
  get: () => { shared: Record<string, unknown>; local: Record<string, unknown> };
  save: (candidate: { shared: Record<string, unknown>; local: Record<string, unknown> }) => unknown;
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function asAction(value: unknown, fallback: LinearAutoDispatchAction): LinearAutoDispatchAction {
  return value === "auto" || value === "escalate" || value === "queue-night-shift"
    ? value
    : fallback;
}

function normalizePolicy(input?: LinearSyncConfig | null): LinearSyncConfig {
  const policy = isRecord(input) ? input : {};
  const projectsRaw = Array.isArray(policy.projects) ? policy.projects : [];

  const projects = projectsRaw
    .filter((entry) => isRecord(entry) && typeof entry.slug === "string" && entry.slug.trim().length > 0)
    .map((entry) => {
      const stateMap = isRecord(entry.stateMap) ? entry.stateMap : null;
      const nextStateMap: Record<string, string> = {};
      if (stateMap) {
        for (const [key, value] of Object.entries(stateMap)) {
          if (typeof value !== "string" || !value.trim().length) continue;
          nextStateMap[key] = value.trim();
        }
      }
      return {
        slug: String(entry.slug).trim(),
        ...(typeof entry.defaultWorker === "string" && entry.defaultWorker.trim().length
          ? { defaultWorker: entry.defaultWorker.trim() }
          : {}),
        ...(typeof entry.teamKey === "string" && entry.teamKey.trim().length
          ? { teamKey: entry.teamKey.trim() }
          : {}),
        ...(Object.keys(nextStateMap).length ? { stateMap: nextStateMap } : {}),
      };
    });

  const byLabel = (() => {
    const next: Record<string, string> = {};
    const raw = isRecord(policy.routing?.byLabel) ? policy.routing?.byLabel : null;
    if (!raw) return next;
    for (const [label, workerSlug] of Object.entries(raw)) {
      if (typeof workerSlug !== "string" || !workerSlug.trim().length) continue;
      next[label.trim().toLowerCase()] = workerSlug.trim();
    }
    return next;
  })();

  const rules = Array.isArray(policy.autoDispatch?.rules)
    ? policy.autoDispatch.rules
        .filter((entry) => isRecord(entry))
        .map((entry, idx) => {
          const action = asAction(entry.action, "escalate");
          const labels = Array.isArray(entry.match?.labels)
            ? entry.match.labels.map((label) => String(label).trim().toLowerCase()).filter(Boolean)
            : undefined;
          const priorities = Array.isArray(entry.match?.priority)
            ? entry.match.priority.map((priority) => String(priority).trim().toLowerCase()).filter(Boolean)
            : undefined;
          const projectSlugs = Array.isArray(entry.match?.projectSlugs)
            ? entry.match.projectSlugs.map((slug) => String(slug).trim()).filter(Boolean)
            : undefined;
          const owner = Array.isArray(entry.match?.owner)
            ? entry.match.owner.map((value) => String(value).trim()).filter(Boolean)
            : undefined;

          return {
            id: typeof entry.id === "string" && entry.id.trim().length ? entry.id.trim() : `rule-${idx + 1}`,
            action,
            ...(typeof entry.template === "string" && entry.template.trim().length
              ? { template: entry.template.trim() }
              : {}),
            ...(labels?.length || priorities?.length || projectSlugs?.length || owner?.length
              ? {
                  match: {
                    ...(labels?.length ? { labels } : {}),
                    ...(priorities?.length ? { priority: priorities as any } : {}),
                    ...(projectSlugs?.length ? { projectSlugs } : {}),
                    ...(owner?.length ? { owner } : {}),
                  },
                }
              : {}),
          };
        })
    : [];

  const confidenceThresholdRaw = Number(policy.classification?.confidenceThreshold);

  return {
    enabled: policy.enabled === true,
    pollingIntervalSec: Math.max(5, Math.floor(Number(policy.pollingIntervalSec ?? DEFAULT_POLICY.pollingIntervalSec ?? 300))),
    projects,
    routing: { byLabel },
    assignment: {
      setAssigneeOnDispatch:
        typeof policy.assignment?.setAssigneeOnDispatch === "boolean"
          ? policy.assignment.setAssigneeOnDispatch
          : Boolean(DEFAULT_POLICY.assignment?.setAssigneeOnDispatch),
    },
    autoDispatch: {
      rules,
      default: asAction(policy.autoDispatch?.default, DEFAULT_POLICY.autoDispatch?.default ?? "escalate"),
    },
    concurrency: {
      global: Math.max(1, Math.floor(Number(policy.concurrency?.global ?? DEFAULT_POLICY.concurrency?.global ?? 5))),
      byState: {
        ...DEFAULT_POLICY.concurrency?.byState,
        ...(isRecord(policy.concurrency?.byState) ? policy.concurrency?.byState : {}),
      },
    },
    reconciliation: {
      enabled:
        typeof policy.reconciliation?.enabled === "boolean"
          ? policy.reconciliation.enabled
          : Boolean(DEFAULT_POLICY.reconciliation?.enabled),
      stalledTimeoutSec: Math.max(
        30,
        Math.floor(Number(policy.reconciliation?.stalledTimeoutSec ?? DEFAULT_POLICY.reconciliation?.stalledTimeoutSec ?? 300))
      ),
    },
    classification: {
      mode:
        policy.classification?.mode === "heuristics" || policy.classification?.mode === "ai" || policy.classification?.mode === "hybrid"
          ? policy.classification.mode
          : DEFAULT_POLICY.classification?.mode,
      confidenceThreshold:
        Number.isFinite(confidenceThresholdRaw) && confidenceThresholdRaw >= 0 && confidenceThresholdRaw <= 1
          ? confidenceThresholdRaw
          : DEFAULT_POLICY.classification?.confidenceThreshold,
    },
    artifacts: {
      mode: policy.artifacts?.mode === "attachments" ? "attachments" : "links",
    },
  };
}

function diffPolicyPaths(previous: unknown, next: unknown, basePath = "linearSync"): string[] {
  if (JSON.stringify(previous) === JSON.stringify(next)) return [];
  const prevRecord = isRecord(previous) ? previous : null;
  const nextRecord = isRecord(next) ? next : null;
  if (!prevRecord || !nextRecord) {
    return [basePath];
  }

  const keys = new Set<string>([...Object.keys(prevRecord), ...Object.keys(nextRecord)]);
  const changes: string[] = [];
  for (const key of keys) {
    const childPath = `${basePath}.${key}`;
    const prevValue = prevRecord[key];
    const nextValue = nextRecord[key];

    if (Array.isArray(prevValue) || Array.isArray(nextValue)) {
      if (JSON.stringify(prevValue) !== JSON.stringify(nextValue)) {
        changes.push(childPath);
      }
      continue;
    }

    if (isRecord(prevValue) && isRecord(nextValue)) {
      const nested = diffPolicyPaths(prevValue, nextValue, childPath);
      changes.push(...nested);
      continue;
    }

    if (JSON.stringify(prevValue) !== JSON.stringify(nextValue)) {
      changes.push(childPath);
    }
  }

  return Array.from(new Set(changes)).sort();
}

export function createFlowPolicyService(args: {
  db: AdeDb;
  projectId: string;
  projectConfigService: ProjectConfigServiceLike;
}) {
  const getPolicyRow = (): { policy_json: string; active_revision_id: string | null } | null =>
    args.db.get<{ policy_json: string; active_revision_id: string | null }>(
      `select policy_json, active_revision_id from cto_flow_policies where project_id = ? limit 1`,
      [args.projectId]
    );

  const readPolicyFromDb = (): LinearSyncConfig | null => {
    const row = getPolicyRow();
    if (!row?.policy_json) return null;
    return normalizePolicy(safeJsonParse<LinearSyncConfig>(row.policy_json, {}));
  };

  const readPolicyFromConfig = (): LinearSyncConfig => {
    const effective = args.projectConfigService.getEffective();
    return normalizePolicy(effective.linearSync ?? undefined);
  };

  const persistPolicy = (policy: LinearSyncConfig, revisionId: string, actor: string): void => {
    const timestamp = nowIso();
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
      [args.projectId, JSON.stringify(policy), revisionId, timestamp, actor]
    );
  };

  const insertRevision = (policy: LinearSyncConfig, actor: string): CtoFlowPolicyRevision => {
    const current = readPolicyFromDb() ?? readPolicyFromConfig();
    const revision: CtoFlowPolicyRevision = {
      id: randomUUID(),
      actor,
      createdAt: nowIso(),
      policy: clone(policy),
    };
    const changedPaths = diffPolicyPaths(current, policy);
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
        JSON.stringify(changedPaths),
        revision.createdAt,
      ]
    );
    persistPolicy(policy, revision.id, actor);
    return revision;
  };

  const savePolicyToConfig = (policy: LinearSyncConfig): void => {
    const snapshot = args.projectConfigService.get();
    const nextLocal = {
      ...snapshot.local,
      linearSync: policy,
    };
    args.projectConfigService.save({
      shared: snapshot.shared,
      local: nextLocal,
    });
  };

  const getPolicy = (): LinearSyncConfig => {
    const fromDb = readPolicyFromDb();
    if (fromDb) return fromDb;
    const fromConfig = readPolicyFromConfig();
    insertRevision(fromConfig, "bootstrap");
    return fromConfig;
  };

  const validatePolicy = (policy: LinearSyncConfig): { ok: boolean; issues: string[] } => {
    const issues: string[] = [];
    const normalized = normalizePolicy(policy);
    if ((normalized.projects ?? []).length === 0) {
      issues.push("At least one Linear project slug is required.");
    }
    const seenProjectSlugs = new Set<string>();
    for (const project of normalized.projects ?? []) {
      const key = project.slug.toLowerCase();
      if (seenProjectSlugs.has(key)) {
        issues.push(`Duplicate project slug: ${project.slug}`);
      }
      seenProjectSlugs.add(key);
    }
    if ((normalized.concurrency?.global ?? 1) < 1) {
      issues.push("Global concurrency must be >= 1.");
    }
    const threshold = normalized.classification?.confidenceThreshold;
    if (threshold != null && (threshold < 0 || threshold > 1)) {
      issues.push("Classification confidence threshold must be between 0 and 1.");
    }
    return { ok: issues.length === 0, issues };
  };

  const savePolicy = (policy: LinearSyncConfig, actor = "user"): LinearSyncConfig => {
    const normalized = normalizePolicy(policy);
    const validation = validatePolicy(normalized);
    if (!validation.ok) {
      throw new Error(`Invalid flow policy: ${validation.issues.join(" ")}`);
    }

    savePolicyToConfig(normalized);
    insertRevision(normalized, actor);
    return normalized;
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
        const parsed = safeJsonParse<LinearSyncConfig | null>(row.policy_json, null);
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

  const rollbackRevision = (revisionId: string, actor = "user"): LinearSyncConfig => {
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
    const parsed = safeJsonParse<LinearSyncConfig | null>(row.policy_json, null);
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
    defaults: clone(DEFAULT_POLICY),
  };
}

export type FlowPolicyService = ReturnType<typeof createFlowPolicyService>;
