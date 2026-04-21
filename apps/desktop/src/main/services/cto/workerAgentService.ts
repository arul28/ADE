import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import YAML from "yaml";
import type {
  AgentCoreMemory,
  AgentIdentity,
  AgentLinearIdentity,
  AgentRole,
  AgentSessionLogEntry,
  AgentStatus,
  AgentUpsertInput,
  AdapterType,
} from "../../../shared/types";
import type { AdeDb } from "../state/kvDb";
import {
  safeJsonParse,
  nowIso,
  parseIsoToEpoch,
  writeTextAtomic,
  uniqueStrings,
  isEnvRef,
  hasEnvRefToken,
  looksSensitiveKey,
  looksSensitiveValue,
  stableStringify,
} from "../shared/utils";
import { createLogIntegrityService } from "../projects/logIntegrityService";

type WorkerAgentServiceArgs = {
  db: AdeDb;
  projectId: string;
  adeDir: string;
};

type PersistedDoc<T> = {
  payload: T;
  updatedAt: string;
};

export type WorkerOrgNode = AgentIdentity & {
  reports: WorkerOrgNode[];
};

type CoreMemoryPatch = Partial<Omit<AgentCoreMemory, "version" | "updatedAt">>;

type AppendWorkerSessionLogArgs = {
  sessionId: string;
  summary: string;
  startedAt: string;
  endedAt: string | null;
  provider: string;
  modelId: string | null;
  capabilityMode: "full_tooling" | "fallback";
};

const ALLOWED_ROLES = new Set<AgentRole>([
  "cto",
  "engineer",
  "qa",
  "designer",
  "devops",
  "researcher",
  "general",
]);
const ALLOWED_STATUSES = new Set<AgentStatus>(["idle", "active", "paused", "running"]);
const ALLOWED_ADAPTER_TYPES = new Set<AdapterType>([
  "claude-local",
  "codex-local",
  "openclaw-webhook",
  "process",
]);


function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}


function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "worker";
}


function assertEnvRefSecretPolicy(value: unknown, pathLabel: string): void {
  if (!value || typeof value !== "object") return;
  const stack: Array<{ value: unknown; path: string }> = [{ value, path: pathLabel }];
  while (stack.length) {
    const next = stack.pop()!;
    if (Array.isArray(next.value)) {
      for (let i = 0; i < next.value.length; i += 1) {
        stack.push({ value: next.value[i], path: `${next.path}[${i}]` });
      }
      continue;
    }
    if (!next.value || typeof next.value !== "object") continue;
    for (const [key, raw] of Object.entries(next.value as Record<string, unknown>)) {
      const keyPath = `${next.path}.${key}`;
      if (raw && typeof raw === "object") {
        stack.push({ value: raw, path: keyPath });
        continue;
      }
      if (typeof raw !== "string") continue;
      const trimmed = raw.trim();
      if (!trimmed.length) continue;
      if (looksSensitiveKey(key) || looksSensitiveValue(trimmed)) {
        if (!(isEnvRef(trimmed) || hasEnvRefToken(trimmed))) {
          throw new Error(`Raw secret-like value is not allowed at '${keyPath}'. Use \${env:VAR_NAME}.`);
        }
      }
    }
  }
}

function normalizeWorkerCoreMemory(input: unknown): AgentCoreMemory | null {
  if (!input || typeof input !== "object") return null;
  const source = input as Record<string, unknown>;
  const version = Math.max(1, Math.floor(Number(source.version ?? 1)));
  const updatedAt = typeof source.updatedAt === "string" && source.updatedAt.trim().length
    ? source.updatedAt
    : nowIso();

  return {
    version,
    updatedAt,
    projectSummary:
      typeof source.projectSummary === "string" && source.projectSummary.trim().length
        ? source.projectSummary.trim()
        : "Worker context is being built through direct sessions and CTO delegation.",
    criticalConventions: uniqueStrings(asStringArray(source.criticalConventions)),
    userPreferences: uniqueStrings(asStringArray(source.userPreferences)),
    activeFocus: uniqueStrings(asStringArray(source.activeFocus)),
    notes: uniqueStrings(asStringArray(source.notes)),
  };
}

function normalizeWorkerSessionLogEntry(input: unknown): AgentSessionLogEntry | null {
  if (!input || typeof input !== "object") return null;
  const source = input as Record<string, unknown>;
  const sessionId = typeof source.sessionId === "string" ? source.sessionId.trim() : "";
  const createdAt = typeof source.createdAt === "string" ? source.createdAt.trim() : "";
  const summary = typeof source.summary === "string" ? source.summary.trim() : "";
  const startedAt = typeof source.startedAt === "string" ? source.startedAt.trim() : "";
  const provider = typeof source.provider === "string" ? source.provider.trim() : "";
  if (!sessionId || !createdAt || !summary || !startedAt || !provider) return null;

  const capabilityMode = source.capabilityMode === "full_tooling" ? "full_tooling" : "fallback";
  return {
    id: typeof source.id === "string" && source.id.trim().length ? source.id.trim() : randomUUID(),
    prevHash: typeof source.prevHash === "string" && source.prevHash.trim().length ? source.prevHash.trim() : null,
    sessionId,
    summary,
    startedAt,
    endedAt: typeof source.endedAt === "string" && source.endedAt.trim().length ? source.endedAt.trim() : null,
    provider,
    modelId: typeof source.modelId === "string" && source.modelId.trim().length ? source.modelId.trim() : null,
    capabilityMode,
    createdAt,
  };
}

function normalizeIdentity(input: unknown): AgentIdentity | null {
  if (!input || typeof input !== "object") return null;
  const source = input as Record<string, unknown>;
  const id = typeof source.id === "string" ? source.id.trim() : "";
  const name = typeof source.name === "string" ? source.name.trim() : "";
  const slug = typeof source.slug === "string" ? source.slug.trim() : "";
  const roleRaw = typeof source.role === "string" ? source.role.trim() : "";
  const statusRaw = typeof source.status === "string" ? source.status.trim() : "";
  const adapterTypeRaw = typeof source.adapterType === "string" ? source.adapterType.trim() : "";
  if (!id || !name || !slug || !ALLOWED_ROLES.has(roleRaw as AgentRole)) return null;
  if (!ALLOWED_STATUSES.has(statusRaw as AgentStatus)) return null;
  if (!ALLOWED_ADAPTER_TYPES.has(adapterTypeRaw as AdapterType)) return null;

  const updatedAt = typeof source.updatedAt === "string" && source.updatedAt.trim().length
    ? source.updatedAt.trim()
    : nowIso();
  const createdAt = typeof source.createdAt === "string" && source.createdAt.trim().length
    ? source.createdAt.trim()
    : updatedAt;

  return {
    id,
    name,
    slug,
    role: roleRaw as AgentRole,
    ...(typeof source.title === "string" && source.title.trim().length ? { title: source.title.trim() } : {}),
    reportsTo: typeof source.reportsTo === "string" && source.reportsTo.trim().length ? source.reportsTo.trim() : null,
    capabilities: uniqueStrings(asStringArray(source.capabilities)),
    status: statusRaw as AgentStatus,
    adapterType: adapterTypeRaw as AdapterType,
    adapterConfig: source.adapterConfig && typeof source.adapterConfig === "object"
      ? source.adapterConfig as Record<string, unknown>
      : {},
    runtimeConfig: source.runtimeConfig && typeof source.runtimeConfig === "object"
      ? source.runtimeConfig as Record<string, unknown>
      : {},
    ...(normalizeLinearIdentity(source.linearIdentity)
      ? { linearIdentity: normalizeLinearIdentity(source.linearIdentity)! }
      : {}),
    budgetMonthlyCents: Number.isFinite(Number(source.budgetMonthlyCents))
      ? Math.max(0, Math.floor(Number(source.budgetMonthlyCents)))
      : 0,
    spentMonthlyCents: Number.isFinite(Number(source.spentMonthlyCents))
      ? Math.max(0, Math.floor(Number(source.spentMonthlyCents)))
      : 0,
    ...(typeof source.lastHeartbeatAt === "string" && source.lastHeartbeatAt.trim().length
      ? { lastHeartbeatAt: source.lastHeartbeatAt.trim() }
      : {}),
    createdAt,
    updatedAt,
    deletedAt: typeof source.deletedAt === "string" && source.deletedAt.trim().length ? source.deletedAt.trim() : null,
  };
}

function normalizeLinearIdentity(value: unknown): AgentLinearIdentity | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  const userIds = uniqueStrings(asStringArray(source.userIds));
  const displayNames = uniqueStrings(asStringArray(source.displayNames));
  const aliases = uniqueStrings(asStringArray(source.aliases));
  if (!userIds.length && !displayNames.length && !aliases.length) return undefined;
  return {
    userIds,
    displayNames,
    aliases,
  };
}

function normalizeAdapterConfig(adapterType: AdapterType, config: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const timeoutMs = Number(config.timeoutMs);

  if (adapterType === "claude-local") {
    if (typeof config.model === "string" && config.model.trim()) result.model = config.model.trim();
    if (typeof config.modelId === "string" && config.modelId.trim()) result.modelId = config.modelId.trim();
    if (typeof config.cwd === "string" && config.cwd.trim()) result.cwd = config.cwd.trim();
    if (Array.isArray(config.cliArgs)) result.cliArgs = asStringArray(config.cliArgs);
    if (typeof config.instructions === "string" && config.instructions.trim()) {
      result.instructions = config.instructions.trim();
    }
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) result.timeoutMs = Math.floor(timeoutMs);
    return result;
  }

  if (adapterType === "codex-local") {
    if (typeof config.model === "string" && config.model.trim()) result.model = config.model.trim();
    if (typeof config.modelId === "string" && config.modelId.trim()) result.modelId = config.modelId.trim();
    if (typeof config.cwd === "string" && config.cwd.trim()) result.cwd = config.cwd.trim();
    if (Array.isArray(config.cliArgs)) result.cliArgs = asStringArray(config.cliArgs);
    if (typeof config.reasoningEffort === "string" && config.reasoningEffort.trim()) {
      result.reasoningEffort = config.reasoningEffort.trim();
    } else if (config.reasoningEffort == null) {
      result.reasoningEffort = null;
    }
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) result.timeoutMs = Math.floor(timeoutMs);
    return result;
  }

  if (adapterType === "openclaw-webhook") {
    const url = typeof config.url === "string" ? config.url.trim() : "";
    if (!/^https?:\/\//i.test(url)) {
      throw new Error("openclaw-webhook adapter requires an absolute http(s) url.");
    }
    result.url = url;
    if (config.method != null) {
      const method = String(config.method).trim().toUpperCase();
      if (method !== "POST") throw new Error("openclaw-webhook only supports method=POST.");
      result.method = "POST";
    }
    if (config.headers != null) {
      if (!config.headers || typeof config.headers !== "object" || Array.isArray(config.headers)) {
        throw new Error("openclaw-webhook headers must be a key/value object.");
      }
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(config.headers as Record<string, unknown>)) {
        if (typeof value !== "string") continue;
        headers[key] = value.trim();
      }
      result.headers = headers;
    }
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) result.timeoutMs = Math.floor(timeoutMs);
    if (typeof config.bodyTemplate === "string" && config.bodyTemplate.trim()) {
      result.bodyTemplate = config.bodyTemplate;
    }
    return result;
  }

  if (adapterType === "process") {
    const command = typeof config.command === "string" ? config.command.trim() : "";
    if (!command.length) throw new Error("process adapter requires a non-empty command.");
    result.command = command;
    if (Array.isArray(config.args)) result.args = asStringArray(config.args);
    if (typeof config.cwd === "string" && config.cwd.trim()) result.cwd = config.cwd.trim();
    if (config.env != null) {
      if (!config.env || typeof config.env !== "object" || Array.isArray(config.env)) {
        throw new Error("process adapter env must be a key/value object.");
      }
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(config.env as Record<string, unknown>)) {
        if (typeof value !== "string") continue;
        env[key] = value.trim();
      }
      result.env = env;
    }
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) result.timeoutMs = Math.floor(timeoutMs);
    if (typeof config.shell === "boolean") result.shell = config.shell;
    return result;
  }

  return result;
}

export function createWorkerAgentService(args: WorkerAgentServiceArgs) {
  const logIntegrityService = createLogIntegrityService();
  const agentsRootDir = path.join(args.adeDir, "agents");
  fs.mkdirSync(agentsRootDir, { recursive: true });

  const agentDirForSlug = (slug: string): string => path.join(agentsRootDir, slug);
  const identityPathForSlug = (slug: string): string => path.join(agentDirForSlug(slug), "identity.yaml");
  const coreMemoryPathForSlug = (slug: string): string => path.join(agentDirForSlug(slug), "core-memory.json");
  const sessionsPathForSlug = (slug: string): string => path.join(agentDirForSlug(slug), "sessions.jsonl");
  const taskSessionsPathForSlug = (slug: string): string => path.join(agentDirForSlug(slug), "task-sessions.jsonl");

  const ensureAgentFiles = (identity: AgentIdentity): void => {
    const slug = identity.slug.trim();
    const dir = agentDirForSlug(slug);
    fs.mkdirSync(dir, { recursive: true });
    writeTextAtomic(identityPathForSlug(slug), YAML.stringify(identity, { indent: 2 }));
    if (!fs.existsSync(coreMemoryPathForSlug(slug))) {
      const memory = makeDefaultCoreMemory(identity.name);
      writeTextAtomic(coreMemoryPathForSlug(slug), `${JSON.stringify(memory, null, 2)}\n`);
    }
    if (!fs.existsSync(sessionsPathForSlug(slug))) {
      fs.writeFileSync(sessionsPathForSlug(slug), "", "utf8");
    }
    if (!fs.existsSync(taskSessionsPathForSlug(slug))) {
      fs.writeFileSync(taskSessionsPathForSlug(slug), "", "utf8");
    }
  };

  const mapRowToIdentity = (row: Record<string, unknown>): AgentIdentity | null => {
    return normalizeIdentity({
      id: row.id,
      name: row.name,
      slug: row.slug,
      role: row.role,
      title: row.title,
      reportsTo: row.reports_to,
      capabilities: safeJsonParse(typeof row.capabilities_json === "string" ? row.capabilities_json : null, []),
      status: row.status,
      adapterType: row.adapter_type,
      adapterConfig: safeJsonParse(typeof row.adapter_config_json === "string" ? row.adapter_config_json : null, {}),
      runtimeConfig: safeJsonParse(typeof row.runtime_config_json === "string" ? row.runtime_config_json : null, {}),
      linearIdentity: safeJsonParse(typeof row.linear_identity_json === "string" ? row.linear_identity_json : null, {}),
      budgetMonthlyCents: row.budget_monthly_cents,
      spentMonthlyCents: row.spent_monthly_cents,
      lastHeartbeatAt: row.last_heartbeat_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deletedAt: row.deleted_at,
    });
  };

  const insertOrUpdateRow = (identity: AgentIdentity): void => {
    args.db.run(
      `
        insert into worker_agents(
          id, project_id, slug, name, role, title, reports_to, capabilities_json, status,
          adapter_type, adapter_config_json, runtime_config_json, linear_identity_json, budget_monthly_cents, spent_monthly_cents,
          last_heartbeat_at, created_at, updated_at, deleted_at
        )
        values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(id) do update set
          slug = excluded.slug,
          name = excluded.name,
          role = excluded.role,
          title = excluded.title,
          reports_to = excluded.reports_to,
          capabilities_json = excluded.capabilities_json,
          status = excluded.status,
          adapter_type = excluded.adapter_type,
          adapter_config_json = excluded.adapter_config_json,
          runtime_config_json = excluded.runtime_config_json,
          linear_identity_json = excluded.linear_identity_json,
          budget_monthly_cents = excluded.budget_monthly_cents,
          spent_monthly_cents = excluded.spent_monthly_cents,
          last_heartbeat_at = excluded.last_heartbeat_at,
          updated_at = excluded.updated_at,
          deleted_at = excluded.deleted_at
      `,
      [
        identity.id,
        args.projectId,
        identity.slug,
        identity.name,
        identity.role,
        identity.title ?? null,
        identity.reportsTo,
        JSON.stringify(identity.capabilities),
        identity.status,
        identity.adapterType,
        JSON.stringify(identity.adapterConfig ?? {}),
        JSON.stringify(identity.runtimeConfig ?? {}),
        JSON.stringify(identity.linearIdentity ?? {}),
        identity.budgetMonthlyCents,
        identity.spentMonthlyCents,
        identity.lastHeartbeatAt ?? null,
        identity.createdAt,
        identity.updatedAt,
        identity.deletedAt ?? null,
      ]
    );
  };

  const readFromDb = (includeDeleted = true): AgentIdentity[] => {
    const rows = includeDeleted
      ? args.db.all<Record<string, unknown>>(
          `select * from worker_agents where project_id = ? order by datetime(updated_at) desc`,
          [args.projectId]
        )
      : args.db.all<Record<string, unknown>>(
          `select * from worker_agents where project_id = ? and deleted_at is null order by datetime(updated_at) desc`,
          [args.projectId]
        );
    return rows.map(mapRowToIdentity).filter((entry): entry is AgentIdentity => entry != null);
  };

  const readIdentityFromFile = (identityPath: string): PersistedDoc<AgentIdentity> | null => {
    if (!fs.existsSync(identityPath)) return null;
    try {
      const parsed = YAML.parse(fs.readFileSync(identityPath, "utf8"));
      const payload = normalizeIdentity(parsed);
      if (!payload) return null;
      return { payload, updatedAt: payload.updatedAt };
    } catch {
      return null;
    }
  };

  const chooseCanonical = <T extends { updatedAt: string }>(
    fromFile: PersistedDoc<T> | null,
    fromDb: PersistedDoc<T> | null,
  ): T | null => {
    if (!fromFile && !fromDb) return null;
    if (fromFile && !fromDb) return fromFile.payload;
    if (!fromFile && fromDb) return fromDb.payload;

    const fileUpdated = parseIsoToEpoch(fromFile!.updatedAt);
    const dbUpdated = parseIsoToEpoch(fromDb!.updatedAt);
    if (Number.isFinite(fileUpdated) && Number.isFinite(dbUpdated)) {
      if (fileUpdated > dbUpdated) return fromFile!.payload;
      if (dbUpdated > fileUpdated) return fromDb!.payload;
    } else if (Number.isFinite(fileUpdated)) {
      return fromFile!.payload;
    } else if (Number.isFinite(dbUpdated)) {
      return fromDb!.payload;
    }
    return fromFile!.payload;
  };

  const reconcileStorage = (): void => {
    fs.mkdirSync(agentsRootDir, { recursive: true });

    const dbEntries = readFromDb(true);
    const dbById = new Map(dbEntries.map((entry) => [entry.id, entry] as const));

    const fileEntries: AgentIdentity[] = [];
    const dirs = fs.existsSync(agentsRootDir)
      ? fs.readdirSync(agentsRootDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
      : [];
    for (const slug of dirs) {
      const hit = readIdentityFromFile(identityPathForSlug(slug));
      if (!hit) continue;
      fileEntries.push({ ...hit.payload, slug });
    }

    const fileById = new Map(fileEntries.map((entry) => [entry.id, entry] as const));
    const ids = new Set<string>([...dbById.keys(), ...fileById.keys()]);
    for (const id of ids) {
      const fromDb = dbById.get(id) ? { payload: dbById.get(id)!, updatedAt: dbById.get(id)!.updatedAt } : null;
      const fromFile = fileById.get(id) ? { payload: fileById.get(id)!, updatedAt: fileById.get(id)!.updatedAt } : null;
      const canonical = chooseCanonical(fromFile, fromDb);
      if (!canonical) continue;
      insertOrUpdateRow(canonical);
      ensureAgentFiles(canonical);
    }
  };

  const listAgents = (options: { includeDeleted?: boolean } = {}): AgentIdentity[] => {
    reconcileStorage();
    const includeDeleted = options.includeDeleted === true;
    const entries = readFromDb(includeDeleted);
    return entries.sort((a, b) => a.name.localeCompare(b.name));
  };

  const getAgent = (agentId: string, options: { includeDeleted?: boolean } = {}): AgentIdentity | null => {
    reconcileStorage();
    const includeDeleted = options.includeDeleted === true;
    const row = includeDeleted
      ? args.db.get<Record<string, unknown>>(
          `select * from worker_agents where project_id = ? and id = ? limit 1`,
          [args.projectId, agentId]
        )
      : args.db.get<Record<string, unknown>>(
          `select * from worker_agents where project_id = ? and id = ? and deleted_at is null limit 1`,
          [args.projectId, agentId]
        );
    if (!row) return null;
    return mapRowToIdentity(row);
  };

  const ensureUniqueSlug = (base: string, ignoreId?: string): string => {
    let candidate = slugify(base);
    let counter = 1;
    while (true) {
      const existing = args.db.get<{ id: string }>(
        `
          select id from worker_agents
          where project_id = ? and slug = ? and (? is null or id != ?)
          limit 1
        `,
        [args.projectId, candidate, ignoreId ?? null, ignoreId ?? null]
      );
      if (!existing?.id) return candidate;
      counter += 1;
      candidate = `${slugify(base)}-${counter}`;
    }
  };

  const assertManagerChainValid = (agentId: string, reportsTo: string | null): void => {
    if (!reportsTo) return;
    if (reportsTo === agentId) {
      throw new Error("An agent cannot report to itself.");
    }

    let cursor: string | null = reportsTo;
    let hops = 0;
    while (cursor) {
      hops += 1;
      if (hops > 50) {
        throw new Error("Org chart cycle detected (chain exceeds 50 hops).");
      }
      if (cursor === agentId) {
        throw new Error("Org chart cycle detected.");
      }
      const parent = getAgent(cursor);
      if (!parent) {
        throw new Error(`Manager '${cursor}' does not exist or is deleted.`);
      }
      cursor = parent.reportsTo;
    }
  };

  const saveAgent = (input: AgentUpsertInput): AgentIdentity => {
    reconcileStorage();
    const existing = input.id ? getAgent(input.id, { includeDeleted: true }) : null;

    const now = nowIso();
    const id = existing?.id ?? randomUUID();
    const rawName = typeof input.name === "string" ? input.name.trim() : "";
    if (!rawName.length) throw new Error("Agent name is required.");
    const role = ALLOWED_ROLES.has(input.role as AgentRole) ? input.role : "general";
    const adapterType = ALLOWED_ADAPTER_TYPES.has(input.adapterType as AdapterType)
      ? input.adapterType
      : null;
    if (!adapterType) throw new Error("Invalid adapterType.");
    const status = ALLOWED_STATUSES.has((input.status ?? existing?.status) as AgentStatus)
      ? (input.status ?? existing?.status ?? "idle")
      : "idle";
    const reportsToRaw = typeof input.reportsTo === "string" ? input.reportsTo.trim() : input.reportsTo;
    const reportsTo = reportsToRaw ? reportsToRaw : null;
    assertManagerChainValid(id, reportsTo);

    const adapterConfig = normalizeAdapterConfig(
      adapterType,
      (input.adapterConfig ?? existing?.adapterConfig ?? {}) as Record<string, unknown>
    );
    assertEnvRefSecretPolicy(adapterConfig, "adapterConfig");

    const runtimeConfig = (input.runtimeConfig ?? existing?.runtimeConfig ?? {}) as Record<string, unknown>;
    assertEnvRefSecretPolicy(runtimeConfig, "runtimeConfig");
    const linearIdentity =
      normalizeLinearIdentity(input.linearIdentity)
      ?? existing?.linearIdentity
      ?? undefined;

    const identity: AgentIdentity = {
      id,
      name: rawName,
      slug: ensureUniqueSlug(existing?.slug ?? rawName, existing?.id),
      role,
      ...(typeof input.title === "string" && input.title.trim().length ? { title: input.title.trim() } : {}),
      reportsTo,
      capabilities: uniqueStrings(input.capabilities ?? existing?.capabilities ?? []),
      status: status as AgentStatus,
      adapterType,
      adapterConfig,
      runtimeConfig,
      ...(linearIdentity ? { linearIdentity } : {}),
      budgetMonthlyCents: Math.max(0, Math.floor(Number(input.budgetMonthlyCents ?? existing?.budgetMonthlyCents ?? 0))),
      spentMonthlyCents: existing?.spentMonthlyCents ?? 0,
      ...(existing?.lastHeartbeatAt ? { lastHeartbeatAt: existing.lastHeartbeatAt } : {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      deletedAt: null,
    };

    insertOrUpdateRow(identity);
    ensureAgentFiles(identity);
    return identity;
  };

  const replaceAgentSnapshot = (snapshot: AgentIdentity): AgentIdentity => {
    reconcileStorage();
    assertManagerChainValid(snapshot.id, snapshot.reportsTo);
    const normalized: AgentIdentity = {
      ...snapshot,
      slug: ensureUniqueSlug(snapshot.slug || snapshot.name, snapshot.id),
      name: snapshot.name.trim(),
      capabilities: uniqueStrings(snapshot.capabilities ?? []),
      ...(normalizeLinearIdentity(snapshot.linearIdentity)
        ? { linearIdentity: normalizeLinearIdentity(snapshot.linearIdentity)! }
        : {}),
      budgetMonthlyCents: Math.max(0, Math.floor(Number(snapshot.budgetMonthlyCents ?? 0))),
      spentMonthlyCents: Math.max(0, Math.floor(Number(snapshot.spentMonthlyCents ?? 0))),
      updatedAt: nowIso(),
      deletedAt: snapshot.deletedAt ?? null,
    };
    assertEnvRefSecretPolicy(normalized.adapterConfig, "adapterConfig");
    assertEnvRefSecretPolicy(normalized.runtimeConfig, "runtimeConfig");
    insertOrUpdateRow(normalized);
    ensureAgentFiles(normalized);
    return normalized;
  };

  const removeAgent = (agentId: string): void => {
    reconcileStorage();
    const current = getAgent(agentId);
    if (!current) return;
    const timestamp = nowIso();
    args.db.run(
      `update worker_agents set reports_to = null, updated_at = ? where project_id = ? and reports_to = ? and deleted_at is null`,
      [timestamp, args.projectId, agentId]
    );
    args.db.run(
      `update worker_agents set status = 'paused', deleted_at = ?, updated_at = ? where project_id = ? and id = ?`,
      [timestamp, timestamp, args.projectId, agentId]
    );
  };

  const setAgentStatus = (agentId: string, status: AgentStatus): void => {
    if (!ALLOWED_STATUSES.has(status)) return;
    args.db.run(
      `update worker_agents set status = ?, updated_at = ? where project_id = ? and id = ? and deleted_at is null`,
      [status, nowIso(), args.projectId, agentId]
    );
  };

  const updateAgentSpentMonthlyCents = (agentId: string, cents: number): void => {
    args.db.run(
      `update worker_agents set spent_monthly_cents = ?, updated_at = ? where project_id = ? and id = ?`,
      [Math.max(0, Math.floor(cents)), nowIso(), args.projectId, agentId]
    );
  };

  const setAgentHeartbeatAt = (agentId: string, heartbeatAt = nowIso()): void => {
    args.db.run(
      `update worker_agents set last_heartbeat_at = ?, updated_at = ? where project_id = ? and id = ? and deleted_at is null`,
      [heartbeatAt, nowIso(), args.projectId, agentId]
    );
  };

  const listOrgTree = (): WorkerOrgNode[] => {
    const entries = listAgents();
    const byId = new Map<string, WorkerOrgNode>();
    for (const entry of entries) {
      byId.set(entry.id, { ...entry, reports: [] });
    }
    const roots: WorkerOrgNode[] = [];
    for (const entry of byId.values()) {
      if (entry.reportsTo && byId.has(entry.reportsTo)) {
        byId.get(entry.reportsTo)!.reports.push(entry);
      } else {
        roots.push(entry);
      }
    }
    const sortNode = (node: WorkerOrgNode): void => {
      node.reports.sort((a, b) => a.name.localeCompare(b.name));
      for (const child of node.reports) sortNode(child);
    };
    roots.sort((a, b) => a.name.localeCompare(b.name));
    for (const root of roots) sortNode(root);
    return roots;
  };

  const getChainOfCommand = (agentId: string): AgentIdentity[] => {
    const chain: AgentIdentity[] = [];
    let cursor = getAgent(agentId);
    let hops = 0;
    while (cursor) {
      hops += 1;
      if (hops > 50) break;
      chain.push(cursor);
      if (!cursor.reportsTo) break;
      cursor = getAgent(cursor.reportsTo);
    }
    return chain;
  };

  const makeDefaultCoreMemory = (name: string): AgentCoreMemory => {
    const timestamp = nowIso();
    return {
      version: 1,
      updatedAt: timestamp,
      projectSummary: `${name} memory initialized. Capture worker-specific context and conventions here.`,
      criticalConventions: [],
      userPreferences: [],
      activeFocus: [],
      notes: [],
    };
  };

  const getCoreMemory = (agentId: string): AgentCoreMemory => {
    reconcileStorage();
    const identity = getAgent(agentId, { includeDeleted: true });
    if (!identity) throw new Error(`Unknown worker agent '${agentId}'.`);
    const filePath = coreMemoryPathForSlug(identity.slug);
    if (!fs.existsSync(filePath)) {
      const next = makeDefaultCoreMemory(identity.name);
      writeTextAtomic(filePath, `${JSON.stringify(next, null, 2)}\n`);
      return next;
    }
    const parsed = safeJsonParse<unknown>(fs.readFileSync(filePath, "utf8"), null);
    const normalized = normalizeWorkerCoreMemory(parsed);
    if (normalized) return normalized;
    const fallback = makeDefaultCoreMemory(identity.name);
    writeTextAtomic(filePath, `${JSON.stringify(fallback, null, 2)}\n`);
    return fallback;
  };

  const updateCoreMemory = (agentId: string, patch: CoreMemoryPatch): AgentCoreMemory => {
    const current = getCoreMemory(agentId);
    const timestamp = nowIso();
    const next: AgentCoreMemory = {
      ...current,
      version: current.version + 1,
      updatedAt: timestamp,
      ...(typeof patch.projectSummary === "string" ? { projectSummary: patch.projectSummary.trim() } : {}),
      ...(patch.criticalConventions ? { criticalConventions: uniqueStrings(asStringArray(patch.criticalConventions)) } : {}),
      ...(patch.userPreferences ? { userPreferences: uniqueStrings(asStringArray(patch.userPreferences)) } : {}),
      ...(patch.activeFocus ? { activeFocus: uniqueStrings(asStringArray(patch.activeFocus)) } : {}),
      ...(patch.notes ? { notes: uniqueStrings(asStringArray(patch.notes)) } : {}),
    };
    const identity = getAgent(agentId, { includeDeleted: true });
    if (!identity) throw new Error(`Unknown worker agent '${agentId}'.`);
    writeTextAtomic(coreMemoryPathForSlug(identity.slug), `${JSON.stringify(next, null, 2)}\n`);
    return next;
  };

  const listSessionLogs = (agentId: string, limit = 20): AgentSessionLogEntry[] => {
    reconcileStorage();
    const identity = getAgent(agentId, { includeDeleted: true });
    if (!identity) throw new Error(`Unknown worker agent '${agentId}'.`);
    const filePath = sessionsPathForSlug(identity.slug);
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, "utf8");
    const entries: AgentSessionLogEntry[] = [];
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.length) continue;
      const parsed = safeJsonParse(trimmed, null);
      const normalized = normalizeWorkerSessionLogEntry(parsed);
      if (normalized) entries.push(normalized);
    }
    return entries
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, Math.max(1, Math.min(500, Math.floor(limit))));
  };

  const appendSessionLog = (agentId: string, entry: AppendWorkerSessionLogArgs): AgentSessionLogEntry => {
    reconcileStorage();
    const identity = getAgent(agentId, { includeDeleted: true });
    if (!identity) throw new Error(`Unknown worker agent '${agentId}'.`);
    const next: AgentSessionLogEntry = {
      id: randomUUID(),
      sessionId: entry.sessionId,
      summary: entry.summary.trim() || "Session completed.",
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      provider: entry.provider,
      modelId: entry.modelId,
      capabilityMode: entry.capabilityMode,
      createdAt: nowIso(),
    };
    return logIntegrityService.appendEntry(sessionsPathForSlug(identity.slug), next) as AgentSessionLogEntry;
  };

  const buildReconstructionContext = (agentId: string, recentLimit = 8): string => {
    const identity = getAgent(agentId, { includeDeleted: true });
    if (!identity) return "";
    const memory = getCoreMemory(agentId);
    const sessions = listSessionLogs(agentId, recentLimit);
    const sections: string[] = [];
    sections.push("Worker Identity");
    sections.push(`- Name: ${identity.name}`);
    sections.push(`- Role: ${identity.role}`);
    if (identity.title) sections.push(`- Title: ${identity.title}`);
    sections.push(`- Capabilities: ${identity.capabilities.join("; ") || "none listed"}`);
    sections.push(`- Adapter: ${identity.adapterType}`);
    sections.push("");
    sections.push("Core Memory");
    sections.push(`- Project summary: ${memory.projectSummary}`);
    if (memory.criticalConventions.length) {
      sections.push(`- Critical conventions: ${memory.criticalConventions.join("; ")}`);
    }
    if (memory.userPreferences.length) {
      sections.push(`- User preferences: ${memory.userPreferences.join("; ")}`);
    }
    if (memory.activeFocus.length) {
      sections.push(`- Active focus: ${memory.activeFocus.join("; ")}`);
    }
    if (memory.notes.length) {
      sections.push(`- Notes: ${memory.notes.join("; ")}`);
    }
    if (sessions.length) {
      sections.push("");
      sections.push("Recent Sessions");
      for (const session of sessions) {
        sections.push(`- [${session.createdAt}] ${session.summary}`);
      }
    }
    return sections.join("\n").trim();
  };

  const listIdentityFiles = (): string[] => {
    if (!fs.existsSync(agentsRootDir)) return [];
    return fs.readdirSync(agentsRootDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => identityPathForSlug(entry.name))
      .filter((candidate) => fs.existsSync(candidate));
  };

  // Initialize and reconcile file/database state once on startup.
  reconcileStorage();
  for (const identityFile of listIdentityFiles()) {
    const parsed = readIdentityFromFile(identityFile);
    if (parsed) ensureAgentFiles(parsed.payload);
  }

  return {
    listAgents,
    getAgent,
    saveAgent,
    replaceAgentSnapshot,
    removeAgent,
    listOrgTree,
    getChainOfCommand,
    getCoreMemory,
    updateCoreMemory,
    listSessionLogs,
    appendSessionLog,
    buildReconstructionContext,
    setAgentStatus,
    updateAgentSpentMonthlyCents,
    setAgentHeartbeatAt,
  };
}

export type WorkerAgentService = ReturnType<typeof createWorkerAgentService>;
