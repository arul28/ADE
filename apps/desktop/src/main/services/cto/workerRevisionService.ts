import { randomUUID } from "node:crypto";
import type { AgentConfigRevision, AgentIdentity, AgentUpsertInput } from "../../../shared/types";
import type { AdeDb } from "../state/kvDb";
import type { WorkerAgentService } from "./workerAgentService";
import { safeJsonParse } from "../shared/utils";

type WorkerRevisionServiceArgs = {
  db: AdeDb;
  projectId: string;
  workerAgentService: WorkerAgentService;
};

type RedactionResult<T> = {
  payload: T;
  hadRedactions: boolean;
};

const ENV_REF_PATTERN = /^\$\{env:[A-Z0-9_]+\}$/;
const ENV_REF_TOKEN_PATTERN = /\$\{env:[A-Z0-9_]+\}/;

function nowIso(): string {
  return new Date().toISOString();
}

function isEnvRef(value: string): boolean {
  return ENV_REF_PATTERN.test(value.trim());
}

function hasEnvRefToken(value: string): boolean {
  return ENV_REF_TOKEN_PATTERN.test(value);
}

function looksSensitiveKey(key: string): boolean {
  return /(token|secret|password|api[_-]?key|authorization)/i.test(key);
}

function looksSensitiveValue(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed.length) return false;
  if (/^bearer\s+/i.test(trimmed)) return true;
  if (/^sk-[a-z0-9]{12,}/i.test(trimmed)) return true;
  if (/^gh[pousr]_[a-z0-9]{20,}/i.test(trimmed)) return true;
  if (/api[_-]?key|secret|token|password/i.test(trimmed)) return true;
  return false;
}

function redactSecrets<T>(input: T): RedactionResult<T> {
  let hadRedactions = false;

  const walk = (value: unknown, parentKey = ""): unknown => {
    if (Array.isArray(value)) return value.map((entry) => walk(entry, parentKey));
    if (!value || typeof value !== "object") {
      if (typeof value === "string") {
        const sensitive = looksSensitiveKey(parentKey) || looksSensitiveValue(value);
        if (sensitive && !isEnvRef(value) && !hasEnvRefToken(value)) {
          hadRedactions = true;
          return "__REDACTED__";
        }
      }
      return value;
    }
    const next: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      next[key] = walk(child, key);
    }
    return next;
  };

  return {
    payload: walk(input) as T,
    hadRedactions,
  };
}

function flattenPaths(input: unknown, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  if (Array.isArray(input)) {
    input.forEach((entry, index) => {
      const childPrefix = `${prefix}[${index}]`;
      for (const [key, value] of flattenPaths(entry, childPrefix)) {
        out.set(key, value);
      }
    });
    return out;
  }
  if (input && typeof input === "object") {
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      const childPrefix = prefix ? `${prefix}.${key}` : key;
      for (const [childKey, childValue] of flattenPaths(value, childPrefix)) {
        out.set(childKey, childValue);
      }
    }
    if (!Object.keys(input as Record<string, unknown>).length && prefix) {
      out.set(prefix, "{}");
    }
    return out;
  }
  if (!prefix) return out;
  out.set(prefix, JSON.stringify(input));
  return out;
}

function detectChangedKeys(before: AgentIdentity, after: AgentIdentity): string[] {
  const beforeMap = flattenPaths(before);
  const afterMap = flattenPaths(after);
  const paths = new Set<string>([...beforeMap.keys(), ...afterMap.keys()]);
  const changed: string[] = [];
  for (const path of paths) {
    if (beforeMap.get(path) !== afterMap.get(path)) changed.push(path);
  }
  return changed.sort();
}

export function createWorkerRevisionService(args: WorkerRevisionServiceArgs) {
  const mapRevisionRow = (row: Record<string, unknown>): AgentConfigRevision | null => {
    const before = safeJsonParse(row.before_json as string | null | undefined, null);
    const after = safeJsonParse(row.after_json as string | null | undefined, null);
    if (!before || !after || typeof before !== "object" || typeof after !== "object") {
      return null;
    }
    return {
      id: String(row.id ?? ""),
      agentId: String(row.agent_id ?? ""),
      before: before as AgentIdentity,
      after: after as AgentIdentity,
      changedKeys: safeJsonParse(row.changed_keys_json as string | null | undefined, []),
      hadRedactions: Number(row.had_redactions ?? 0) === 1,
      actor: String(row.actor ?? "system"),
      createdAt: String(row.created_at ?? nowIso()),
    };
  };

  const insertRevision = (
    agentId: string,
    before: AgentIdentity,
    after: AgentIdentity,
    actor: string
  ): AgentConfigRevision => {
    const beforeRedacted = redactSecrets(before);
    const afterRedacted = redactSecrets(after);
    const hadRedactions = beforeRedacted.hadRedactions || afterRedacted.hadRedactions;
    const changedKeys = detectChangedKeys(before, after);
    const revision: AgentConfigRevision = {
      id: randomUUID(),
      agentId,
      before: beforeRedacted.payload,
      after: afterRedacted.payload,
      changedKeys,
      hadRedactions,
      actor: actor.trim() || "user",
      createdAt: nowIso(),
    };
    args.db.run(
      `
        insert into worker_agent_revisions(
          id, project_id, agent_id, before_json, after_json, changed_keys_json, had_redactions, actor, created_at
        )
        values(?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        revision.id,
        args.projectId,
        revision.agentId,
        JSON.stringify(revision.before),
        JSON.stringify(revision.after),
        JSON.stringify(revision.changedKeys),
        revision.hadRedactions ? 1 : 0,
        revision.actor,
        revision.createdAt,
      ]
    );
    return revision;
  };

  const saveAgent = (input: AgentUpsertInput, actor = "user"): AgentIdentity => {
    const before = input.id ? args.workerAgentService.getAgent(input.id, { includeDeleted: true }) : null;
    const after = args.workerAgentService.saveAgent(input);
    if (before) {
      insertRevision(after.id, before, after, actor);
    } else {
      insertRevision(after.id, after, after, actor);
    }
    return after;
  };

  const listAgentRevisions = (agentId: string, limit = 50): AgentConfigRevision[] => {
    const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    const rows = args.db.all<Record<string, unknown>>(
      `
        select id, agent_id, before_json, after_json, changed_keys_json, had_redactions, actor, created_at
        from worker_agent_revisions
        where project_id = ? and agent_id = ?
        order by datetime(created_at) desc
        limit ?
      `,
      [args.projectId, agentId, safeLimit]
    );
    return rows.map(mapRevisionRow).filter((entry): entry is AgentConfigRevision => entry != null);
  };

  const rollbackAgentRevision = (agentId: string, revisionId: string, actor = "user"): AgentIdentity => {
    const row = args.db.get<Record<string, unknown>>(
      `
        select id, agent_id, before_json, after_json, changed_keys_json, had_redactions, actor, created_at
        from worker_agent_revisions
        where project_id = ? and agent_id = ? and id = ?
        limit 1
      `,
      [args.projectId, agentId, revisionId]
    );
    const revision = row ? mapRevisionRow(row) : null;
    if (!revision) throw new Error(`Revision '${revisionId}' was not found for agent '${agentId}'.`);
    if (revision.hadRedactions) {
      throw new Error("Rollback blocked because the selected revision contains redacted secret fields.");
    }

    const current = args.workerAgentService.getAgent(agentId, { includeDeleted: true });
    if (!current) throw new Error(`Unknown worker agent '${agentId}'.`);

    const snapshot = revision.before;
    if (snapshot.id !== agentId) {
      throw new Error("Revision snapshot does not match the requested agent.");
    }
    const restored = args.workerAgentService.replaceAgentSnapshot({
      ...snapshot,
      spentMonthlyCents: current.spentMonthlyCents,
      deletedAt: null,
    });
    insertRevision(agentId, current, restored, `${actor.trim() || "user"} (rollback:${revisionId})`);
    return restored;
  };

  return {
    saveAgent,
    listAgentRevisions,
    rollbackAgentRevision,
  };
}

export type WorkerRevisionService = ReturnType<typeof createWorkerRevisionService>;
