import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import YAML from "yaml";
import type {
  CtoCoreMemory,
  CtoIdentity,
  ExternalMcpAccessPolicy,
  OpenclawContextPolicy,
  CtoOnboardingState,
  CtoSessionLogEntry,
  CtoSubordinateActivityEntry,
  CtoSnapshot,
  CtoSystemPromptPreview,
} from "../../../shared/types";
import type { createUnifiedMemoryService, Memory, MemoryCategory } from "../memory/unifiedMemoryService";
import type { AdeDb } from "../state/kvDb";
import { nowIso, parseIsoToEpoch, safeJsonParse, uniqueStrings, writeTextAtomic } from "../shared/utils";
import { createLogIntegrityService } from "../projects/logIntegrityService";

type CtoStateServiceArgs = {
  db: AdeDb;
  projectId: string;
  adeDir: string;
  memoryService?: Pick<ReturnType<typeof createUnifiedMemoryService>, "listMemories">;
};

type CoreMemoryPatch = Partial<Omit<CtoCoreMemory, "version" | "updatedAt">>;

type AppendCtoSessionLogArgs = {
  sessionId: string;
  summary: string;
  startedAt: string;
  endedAt: string | null;
  provider: string;
  modelId: string | null;
  capabilityMode: "full_mcp" | "fallback";
};

type AppendCtoSubordinateActivityArgs = {
  agentId: string;
  agentName: string;
  activityType: "chat_turn" | "worker_run";
  summary: string;
  sessionId?: string | null;
  taskKey?: string | null;
  issueKey?: string | null;
};

type PersistedDoc<T> = {
  payload: T;
  updatedAt: string;
};

const CTO_LONG_TERM_MEMORY_RELATIVE_PATH = ".ade/cto/MEMORY.md";
const CTO_CURRENT_CONTEXT_RELATIVE_PATH = ".ade/cto/CURRENT.md";
const DURABLE_MEMORY_CATEGORY_ORDER: MemoryCategory[] = [
  "decision",
  "convention",
  "pattern",
  "gotcha",
  "preference",
  "fact",
];

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const normalized = typeof item === "string" ? item.trim() : "";
    if (!normalized.length) continue;
    out.push(normalized);
  }
  return out;
}

function safeYamlParse<T>(raw: string): T | null {
  try {
    return YAML.parse(raw) as T;
  } catch {
    return null;
  }
}

function normalizeOnboardingState(value: unknown): CtoOnboardingState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  const completedSteps = uniqueStrings(asStringArray(source.completedSteps));
  const dismissedAt =
    typeof source.dismissedAt === "string" && source.dismissedAt.trim().length
      ? source.dismissedAt.trim()
      : undefined;
  const completedAt =
    typeof source.completedAt === "string" && source.completedAt.trim().length
      ? source.completedAt.trim()
      : undefined;
  return {
    completedSteps,
    ...(dismissedAt ? { dismissedAt } : {}),
    ...(completedAt ? { completedAt } : {}),
  };
}

function normalizePersonalityPreset(value: unknown): CtoIdentity["personality"] | undefined {
  return value === "strategic"
    || value === "professional"
    || value === "hands_on"
    || value === "casual"
    || value === "minimal"
    || value === "custom"
    ? value
    : undefined;
}

function personalityInstructionForPreset(value: CtoIdentity["personality"]): string | null {
  switch (value) {
    case "strategic":
      return "Operate as a strategic technical leader: strong architectural judgment, clear prioritization, and crisp tradeoff calls.";
    case "professional":
      return "Operate as a calm executive technical lead: structured, accountable, and steady under pressure.";
    case "hands_on":
      return "Operate as a hands-on CTO: stay close to implementation details, jump into debugging, and unblock execution quickly.";
    case "casual":
      return "Operate as a collaborative CTO: warm, human, and easy to work with while still making strong technical calls.";
    case "minimal":
      return "Operate as a concise CTO: low-noise, direct, and focused on decisions, blockers, and next actions.";
    case "custom":
    default:
      return null;
  }
}

function normalizeIdentity(input: unknown): CtoIdentity | null {
  if (!input || typeof input !== "object") return null;
  const source = input as Record<string, unknown>;
  const name = typeof source.name === "string" && source.name.trim().length ? source.name.trim() : "CTO";
  const persona = typeof source.persona === "string" && source.persona.trim().length
    ? source.persona.trim()
    : "Persistent technical lead for this project.";
  const version = Math.max(1, Math.floor(Number(source.version ?? 1)));
  const updatedAt = typeof source.updatedAt === "string" && source.updatedAt.trim().length
    ? source.updatedAt
    : nowIso();
  const modelPreferencesRaw =
    source.modelPreferences && typeof source.modelPreferences === "object"
      ? (source.modelPreferences as Record<string, unknown>)
      : {};
  const memoryPolicyRaw =
    source.memoryPolicy && typeof source.memoryPolicy === "object"
      ? (source.memoryPolicy as Record<string, unknown>)
      : {};
  const communicationStyleRaw =
    source.communicationStyle && typeof source.communicationStyle === "object"
      ? (source.communicationStyle as Record<string, unknown>)
      : {};
  const externalMcpAccess = normalizeExternalMcpAccess(source.externalMcpAccess);
  const openclawContextPolicy = normalizeOpenclawContextPolicy(source.openclawContextPolicy);
  const onboardingState = normalizeOnboardingState(source.onboardingState);
  const personality = normalizePersonalityPreset(source.personality);
  const customPersonality =
    typeof source.customPersonality === "string" && source.customPersonality.trim().length
      ? source.customPersonality.trim()
      : undefined;
  const communicationStyle: CtoIdentity["communicationStyle"] =
    typeof communicationStyleRaw.verbosity === "string"
    && typeof communicationStyleRaw.proactivity === "string"
    && typeof communicationStyleRaw.escalationThreshold === "string"
      ? {
          verbosity:
            communicationStyleRaw.verbosity === "detailed"
            || communicationStyleRaw.verbosity === "adaptive"
              ? communicationStyleRaw.verbosity
              : "concise",
          proactivity:
            communicationStyleRaw.proactivity === "balanced"
            || communicationStyleRaw.proactivity === "proactive"
              ? communicationStyleRaw.proactivity
              : "reactive",
          escalationThreshold:
            communicationStyleRaw.escalationThreshold === "low"
            || communicationStyleRaw.escalationThreshold === "high"
              ? communicationStyleRaw.escalationThreshold
              : "medium",
        }
      : undefined;
  const constraints = uniqueStrings(asStringArray(source.constraints));
  const systemPromptExtension =
    typeof source.systemPromptExtension === "string" && source.systemPromptExtension.trim().length
      ? source.systemPromptExtension.trim()
      : undefined;

  return {
    name,
    version,
    persona,
    ...(personality ? { personality } : {}),
    ...(customPersonality ? { customPersonality } : {}),
    ...(communicationStyle ? { communicationStyle } : {}),
    ...(constraints.length > 0 ? { constraints } : {}),
    ...(systemPromptExtension ? { systemPromptExtension } : {}),
    modelPreferences: {
      provider: typeof modelPreferencesRaw.provider === "string" && modelPreferencesRaw.provider.trim().length
        ? modelPreferencesRaw.provider.trim()
        : "claude",
      model: typeof modelPreferencesRaw.model === "string" && modelPreferencesRaw.model.trim().length
        ? modelPreferencesRaw.model.trim()
        : "sonnet",
      ...(typeof modelPreferencesRaw.modelId === "string" && modelPreferencesRaw.modelId.trim().length
        ? { modelId: modelPreferencesRaw.modelId.trim() }
        : {}),
      ...(typeof modelPreferencesRaw.reasoningEffort === "string" || modelPreferencesRaw.reasoningEffort == null
        ? { reasoningEffort: (modelPreferencesRaw.reasoningEffort as string | null | undefined) ?? null }
        : {}),
    },
    memoryPolicy: {
      autoCompact: memoryPolicyRaw.autoCompact !== false,
      compactionThreshold: Number.isFinite(Number(memoryPolicyRaw.compactionThreshold))
        ? Math.max(0.1, Math.min(1, Number(memoryPolicyRaw.compactionThreshold)))
        : 0.7,
      preCompactionFlush: memoryPolicyRaw.preCompactionFlush !== false,
      temporalDecayHalfLifeDays: Number.isFinite(Number(memoryPolicyRaw.temporalDecayHalfLifeDays))
        ? Math.max(1, Math.floor(Number(memoryPolicyRaw.temporalDecayHalfLifeDays)))
        : 30,
    },
    ...(externalMcpAccess ? { externalMcpAccess } : {}),
    ...(openclawContextPolicy ? { openclawContextPolicy } : {}),
    ...(onboardingState ? { onboardingState } : {}),
    updatedAt,
  };
}

function normalizeExternalMcpAccess(value: unknown): ExternalMcpAccessPolicy | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  const toStringArray = (input: unknown): string[] =>
    Array.isArray(input)
      ? [...new Set(input.map((entry) => String(entry ?? "").trim()).filter((entry) => entry.length > 0))]
      : [];
  return {
    allowAll: source.allowAll !== false,
    allowedServers: toStringArray(source.allowedServers),
    blockedServers: toStringArray(source.blockedServers),
  };
}

function normalizeOpenclawContextPolicy(value: unknown): OpenclawContextPolicy | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  const blockedCategories = Array.isArray(source.blockedCategories)
    ? [...new Set(source.blockedCategories.map((entry) => String(entry ?? "").trim()).filter((entry) => entry.length > 0))]
    : [];
  return {
    shareMode: source.shareMode === "full" ? "full" : "filtered",
    blockedCategories,
  };
}

function squishText(value: string): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function clipText(value: string, maxLength = 220): string {
  const normalized = squishText(value);
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

function labelForMemoryCategory(category: MemoryCategory): string {
  switch (category) {
    case "decision":
      return "Decisions";
    case "convention":
      return "Conventions";
    case "pattern":
      return "Patterns";
    case "gotcha":
      return "Gotchas";
    case "preference":
      return "Preferences";
    case "fact":
      return "Facts";
    default:
      return "Other";
  }
}

function normalizeCoreMemory(input: unknown): CtoCoreMemory | null {
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
        : "Project context is being built through conversations and mission outcomes.",
    criticalConventions: uniqueStrings(asStringArray(source.criticalConventions)),
    userPreferences: uniqueStrings(asStringArray(source.userPreferences)),
    activeFocus: uniqueStrings(asStringArray(source.activeFocus)),
    notes: uniqueStrings(asStringArray(source.notes)),
  };
}

function normalizeSessionLogEntry(input: unknown): CtoSessionLogEntry | null {
  if (!input || typeof input !== "object") return null;
  const source = input as Record<string, unknown>;
  const sessionId = typeof source.sessionId === "string" ? source.sessionId.trim() : "";
  const createdAt = typeof source.createdAt === "string" ? source.createdAt.trim() : "";
  const summary = typeof source.summary === "string" ? source.summary.trim() : "";
  const startedAt = typeof source.startedAt === "string" ? source.startedAt.trim() : "";
  const provider = typeof source.provider === "string" ? source.provider.trim() : "";
  if (!sessionId || !createdAt || !summary || !startedAt || !provider) return null;

  const capabilityMode = source.capabilityMode === "full_mcp" ? "full_mcp" : "fallback";
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

function normalizeSubordinateActivityEntry(input: unknown): CtoSubordinateActivityEntry | null {
  if (!input || typeof input !== "object") return null;
  const source = input as Record<string, unknown>;
  const agentId = typeof source.agentId === "string" ? source.agentId.trim() : "";
  const agentName = typeof source.agentName === "string" ? source.agentName.trim() : "";
  const summary = typeof source.summary === "string" ? source.summary.trim() : "";
  const createdAt = typeof source.createdAt === "string" ? source.createdAt.trim() : "";
  if (!agentId || !agentName || !summary || !createdAt) return null;
  const activityType = source.activityType === "worker_run" ? "worker_run" : "chat_turn";
  return {
    id: typeof source.id === "string" && source.id.trim().length ? source.id.trim() : randomUUID(),
    agentId,
    agentName,
    activityType,
    summary,
    sessionId: typeof source.sessionId === "string" && source.sessionId.trim().length ? source.sessionId.trim() : null,
    taskKey: typeof source.taskKey === "string" && source.taskKey.trim().length ? source.taskKey.trim() : null,
    issueKey: typeof source.issueKey === "string" && source.issueKey.trim().length ? source.issueKey.trim() : null,
    createdAt,
  };
}

function makeDefaultIdentity(): CtoIdentity {
  const timestamp = nowIso();
  return {
    name: "CTO",
    version: 1,
    persona: [
      "You are the CTO for this project inside ADE.",
      "You are not a generic assistant, Codex, or Claude speaking abstractly about the codebase.",
      "You are the persistent technical lead who owns architecture, execution quality, engineering continuity, and team direction.",
      "You hold the complete mental model of the codebase — architecture, conventions, active work, known pitfalls, and the reasoning behind past decisions.",
      "You can inspect the repo, edit code, run validation, coordinate worker agents, and use ADE's connected tools when needed.",
      "",
      "Your core responsibilities:",
      "- Own the technical vision and ensure all work aligns with it",
      "- Remember what matters: decisions, conventions, gotchas, and why things are the way they are",
      "- When asked about past work, search your memory before guessing",
      "- When you learn something important, save it to memory immediately",
      "- Guide implementation decisions with context that workers lack",
      "- Proactively surface risks, conflicts, or forgotten context",
      "",
      "When asked who you are, answer as the project's CTO.",
      "When asked what you can do, answer in terms of ADE's capabilities and your leadership role on this project.",
      "",
      "You think like a senior engineer who has been on this project for years.",
      "You are direct, opinionated when you have evidence, and honest when you don't know something.",
    ].join("\n"),
    personality: "strategic",
    modelPreferences: {
      provider: "claude",
      model: "sonnet",
      reasoningEffort: "high",
    },
    memoryPolicy: {
      autoCompact: true,
      compactionThreshold: 0.7,
      preCompactionFlush: true,
      temporalDecayHalfLifeDays: 30,
    },
    externalMcpAccess: {
      allowAll: true,
      allowedServers: [],
      blockedServers: [],
    },
    openclawContextPolicy: {
      shareMode: "filtered",
      blockedCategories: ["secret", "token", "system_prompt"],
    },
    updatedAt: timestamp,
  };
}

function makeDefaultCoreMemory(): CtoCoreMemory {
  const timestamp = nowIso();
  return {
    version: 1,
    updatedAt: timestamp,
    projectSummary: "No CTO brief saved yet. Add the project purpose, rules, and current priorities here.",
    criticalConventions: [],
    userPreferences: [],
    activeFocus: [],
    notes: [],
  };
}

export function createCtoStateService(args: CtoStateServiceArgs) {
  const logIntegrityService = createLogIntegrityService();
  const ctoDir = path.join(args.adeDir, "cto");
  const identityPath = path.join(ctoDir, "identity.yaml");
  // Only identity.yaml belongs to the shared Git-tracked ADE scaffold in W3.
  // The remaining files here are generated local/runtime state.
  const coreMemoryPath = path.join(ctoDir, "core-memory.json");
  const memoryDocPath = path.join(ctoDir, "MEMORY.md");
  const currentContextDocPath = path.join(ctoDir, "CURRENT.md");
  const sessionsPath = path.join(ctoDir, "sessions.jsonl");
  const subordinateActivityPath = path.join(ctoDir, "subordinate-activity.jsonl");

  fs.mkdirSync(ctoDir, { recursive: true });

  const readIdentityFromFile = (): PersistedDoc<CtoIdentity> | null => {
    if (!fs.existsSync(identityPath)) return null;
    const parsed = safeYamlParse<unknown>(fs.readFileSync(identityPath, "utf8"));
    const payload = normalizeIdentity(parsed);
    if (!payload) return null;
    return { payload, updatedAt: payload.updatedAt };
  };

  const readIdentityFromDb = (): PersistedDoc<CtoIdentity> | null => {
    const row = args.db.get<{ payload_json: string; updated_at: string }>(
      `select payload_json, updated_at from cto_identity_state where project_id = ? limit 1`,
      [args.projectId]
    );
    if (!row?.payload_json) return null;
    const payload = normalizeIdentity(safeJsonParse(row.payload_json, null));
    if (!payload) return null;
    const updatedAt = row.updated_at?.trim() || payload.updatedAt;
    return { payload: { ...payload, updatedAt }, updatedAt };
  };

  const writeIdentityToFile = (payload: CtoIdentity): void => {
    writeTextAtomic(identityPath, YAML.stringify(payload, { indent: 2 }));
  };

  const writeIdentityToDb = (payload: CtoIdentity): void => {
    args.db.run(
      `
        insert into cto_identity_state(project_id, version, payload_json, updated_at)
        values(?, ?, ?, ?)
        on conflict(project_id) do update set
          version = excluded.version,
          payload_json = excluded.payload_json,
          updated_at = excluded.updated_at
      `,
      [args.projectId, payload.version, JSON.stringify(payload), payload.updatedAt]
    );
  };

  const readCoreMemoryFromFile = (): PersistedDoc<CtoCoreMemory> | null => {
    if (!fs.existsSync(coreMemoryPath)) return null;
    const parsed = safeJsonParse<unknown>(fs.readFileSync(coreMemoryPath, "utf8"), null);
    const payload = normalizeCoreMemory(parsed);
    if (!payload) return null;
    return { payload, updatedAt: payload.updatedAt };
  };

  const readCoreMemoryFromDb = (): PersistedDoc<CtoCoreMemory> | null => {
    const row = args.db.get<{ payload_json: string; updated_at: string }>(
      `select payload_json, updated_at from cto_core_memory_state where project_id = ? limit 1`,
      [args.projectId]
    );
    if (!row?.payload_json) return null;
    const payload = normalizeCoreMemory(safeJsonParse(row.payload_json, null));
    if (!payload) return null;
    const updatedAt = row.updated_at?.trim() || payload.updatedAt;
    return { payload: { ...payload, updatedAt }, updatedAt };
  };

  const writeCoreMemoryToFile = (payload: CtoCoreMemory): void => {
    writeTextAtomic(coreMemoryPath, `${JSON.stringify(payload, null, 2)}\n`);
  };

  const writeCoreMemoryToDb = (payload: CtoCoreMemory): void => {
    args.db.run(
      `
        insert into cto_core_memory_state(project_id, version, payload_json, updated_at)
        values(?, ?, ?, ?)
        on conflict(project_id) do update set
          version = excluded.version,
          payload_json = excluded.payload_json,
          updated_at = excluded.updated_at
      `,
      [args.projectId, payload.version, JSON.stringify(payload), payload.updatedAt]
    );
  };

  const chooseCanonical = <T extends { updatedAt: string }>(
    fromFile: PersistedDoc<T> | null,
    fromDb: PersistedDoc<T> | null,
    defaultFactory: () => T,
  ): T => {
    if (!fromFile && !fromDb) return defaultFactory();
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

    // Tied timestamps or both invalid: prefer file source.
    return fromFile!.payload;
  };

  const listSessionLogsFromDb = (): CtoSessionLogEntry[] => {
    const rows = args.db.all<Record<string, unknown>>(
      `
        select id, session_id, summary, started_at, ended_at, provider, model_id, capability_mode, created_at
        from cto_session_logs
        where project_id = ?
        order by datetime(created_at) desc
      `,
      [args.projectId]
    );
    return rows
      .map((row) =>
        normalizeSessionLogEntry({
          id: row.id,
          sessionId: row.session_id,
          summary: row.summary,
          startedAt: row.started_at,
          endedAt: row.ended_at,
          provider: row.provider,
          modelId: row.model_id,
          capabilityMode: row.capability_mode,
          createdAt: row.created_at,
        })
      )
      .filter((entry): entry is CtoSessionLogEntry => entry != null);
  };

  const listSessionLogsFromFile = (): CtoSessionLogEntry[] => {
    if (!fs.existsSync(sessionsPath)) return [];
    const raw = fs.readFileSync(sessionsPath, "utf8");
    const entries: CtoSessionLogEntry[] = [];
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.length) continue;
      const parsed = safeJsonParse<unknown>(trimmed, null);
      const normalized = normalizeSessionLogEntry(parsed);
      if (normalized) entries.push(normalized);
    }
    return entries;
  };

  const appendSessionLogToFile = (entry: CtoSessionLogEntry): CtoSessionLogEntry => {
    fs.mkdirSync(path.dirname(sessionsPath), { recursive: true });
    return logIntegrityService.appendEntry(sessionsPath, entry) as CtoSessionLogEntry;
  };

  const listSubordinateActivityFromFile = (): CtoSubordinateActivityEntry[] => {
    if (!fs.existsSync(subordinateActivityPath)) return [];
    const raw = fs.readFileSync(subordinateActivityPath, "utf8");
    const entries: CtoSubordinateActivityEntry[] = [];
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.length) continue;
      const parsed = safeJsonParse<unknown>(trimmed, null);
      const normalized = normalizeSubordinateActivityEntry(parsed);
      if (normalized) entries.push(normalized);
    }
    return entries;
  };

  const appendSubordinateActivityToFile = (entry: CtoSubordinateActivityEntry): void => {
    fs.mkdirSync(path.dirname(subordinateActivityPath), { recursive: true });
    fs.appendFileSync(subordinateActivityPath, `${JSON.stringify(entry)}\n`, "utf8");
  };

  const insertSessionLogToDb = (entry: CtoSessionLogEntry): void => {
    args.db.run(
      `
        insert or ignore into cto_session_logs(
          id, project_id, session_id, summary, started_at, ended_at, provider, model_id, capability_mode, created_at
        )
        values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        entry.id,
        args.projectId,
        entry.sessionId,
        entry.summary,
        entry.startedAt,
        entry.endedAt,
        entry.provider,
        entry.modelId,
        entry.capabilityMode,
        entry.createdAt,
      ]
    );
  };

  const reconcileDocs = (): { identity: CtoIdentity; coreMemory: CtoCoreMemory } => {
    const identity = chooseCanonical(readIdentityFromFile(), readIdentityFromDb(), makeDefaultIdentity);
    const coreMemory = chooseCanonical(readCoreMemoryFromFile(), readCoreMemoryFromDb(), makeDefaultCoreMemory);

    writeIdentityToFile(identity);
    writeIdentityToDb(identity);
    writeCoreMemoryToFile(coreMemory);
    writeCoreMemoryToDb(coreMemory);

    return { identity, coreMemory };
  };

  const reconcileSessionLogs = (): void => {
    const dbEntries = listSessionLogsFromDb();
    const fileEntries = listSessionLogsFromFile();
    const dbKeySet = new Set(dbEntries.map((entry) => `${entry.sessionId}::${entry.createdAt}`));
    const fileKeySet = new Set(fileEntries.map((entry) => `${entry.sessionId}::${entry.createdAt}`));

    for (const entry of fileEntries) {
      const key = `${entry.sessionId}::${entry.createdAt}`;
      if (dbKeySet.has(key)) continue;
      insertSessionLogToDb(entry);
      dbKeySet.add(key);
    }

    for (const entry of dbEntries) {
      const key = `${entry.sessionId}::${entry.createdAt}`;
      if (fileKeySet.has(key)) continue;
      appendSessionLogToFile(entry);
      fileKeySet.add(key);
    }
  };

  const reconcileAll = (): { identity: CtoIdentity; coreMemory: CtoCoreMemory } => {
    const docs = reconcileDocs();
    reconcileSessionLogs();
    return docs;
  };

  const getIdentity = (): CtoIdentity => reconcileAll().identity;

  const getCoreMemory = (): CtoCoreMemory => reconcileAll().coreMemory;

  const getSessionLogs = (limit = 20): CtoSessionLogEntry[] => {
    reconcileAll();
    const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    return args.db
      .all<Record<string, unknown>>(
        `
          select id, session_id, summary, started_at, ended_at, provider, model_id, capability_mode, created_at
          from cto_session_logs
          where project_id = ?
          order by datetime(created_at) desc
          limit ?
        `,
        [args.projectId, safeLimit]
      )
      .map((row) =>
        normalizeSessionLogEntry({
          id: row.id,
          sessionId: row.session_id,
          summary: row.summary,
          startedAt: row.started_at,
          endedAt: row.ended_at,
          provider: row.provider,
          modelId: row.model_id,
          capabilityMode: row.capability_mode,
          createdAt: row.created_at,
        })
      )
      .filter((entry): entry is CtoSessionLogEntry => entry != null);
  };

  const getSnapshot = (recentLimit = 20): CtoSnapshot => {
    const docs = reconcileAll();
    return {
      identity: docs.identity,
      coreMemory: docs.coreMemory,
      recentSessions: getSessionLogs(recentLimit),
      recentSubordinateActivity: getSubordinateActivityLogs(recentLimit),
    };
  };

  const listProjectContextDocPaths = (): string[] => {
    const projectRoot = path.dirname(args.adeDir);
    return [".ade/context/PRD.ade.md", ".ade/context/ARCHITECTURE.ade.md"].filter((rel) => {
      try {
        return fs.existsSync(path.join(projectRoot, rel));
      } catch {
        return false;
      }
    });
  };

  const listDurableMemoryHighlights = (limit = 12): Memory[] => {
    if (!args.memoryService) return [];
    const promoted = args.memoryService.listMemories({
      projectId: args.projectId,
      scope: "project",
      status: "promoted",
      categories: DURABLE_MEMORY_CATEGORY_ORDER,
      limit: Math.max(limit * 2, 24),
    });
    const curated = promoted.filter((memory) =>
      memory.pinned
      || memory.tier === 1
      || memory.importance === "high"
    );
    return (curated.length > 0 ? curated : promoted).slice(0, limit);
  };

  const buildDurableHighlightLines = (memories: ReadonlyArray<Memory>): string[] => {
    if (memories.length === 0) {
      return ["- No promoted durable memories yet. Use memoryAdd for reusable decisions, patterns, and gotchas."];
    }

    const lines: string[] = [];
    for (const category of DURABLE_MEMORY_CATEGORY_ORDER) {
      const group = memories.filter((memory) => memory.category === category);
      if (group.length === 0) continue;
      lines.push(`### ${labelForMemoryCategory(category)}`);
      for (const memory of group) {
        lines.push(`- ${clipText(memory.content, 260)}${memory.pinned ? " (pinned)" : ""}`);
      }
      lines.push("");
    }
    while (lines[lines.length - 1] === "") lines.pop();
    return lines;
  };

  const listRecentDailyLogSnippets = (lineLimits = [14, 8]): Array<{ date: string; lines: string[] }> => {
    return listDailyLogs(lineLimits.length)
      .map((date, index) => {
        const raw = readDailyLog(date)?.trim();
        if (!raw) return null;
        const entries = raw.split("\n").map((line) => line.trim()).filter(Boolean);
        if (entries.length === 0) return null;
        const sliceSize = lineLimits[index] ?? lineLimits[lineLimits.length - 1] ?? 8;
        return {
          date,
          lines: entries.length > sliceSize ? entries.slice(-sliceSize) : entries,
        };
      })
      .filter((entry): entry is { date: string; lines: string[] } => Boolean(entry));
  };

  const buildLongTermMemoryLines = (snapshot: CtoSnapshot): string[] => {
    const lines: string[] = [];
    lines.push("## Core brief");
    lines.push(`- Project summary: ${snapshot.coreMemory.projectSummary}`);
    lines.push(
      snapshot.coreMemory.criticalConventions.length > 0
        ? `- Critical conventions: ${snapshot.coreMemory.criticalConventions.join("; ")}`
        : "- Critical conventions: none captured yet",
    );
    if (snapshot.coreMemory.userPreferences.length > 0) {
      lines.push(`- User preferences: ${snapshot.coreMemory.userPreferences.join("; ")}`);
    }
    if (snapshot.coreMemory.activeFocus.length > 0) {
      lines.push(`- Active focus: ${snapshot.coreMemory.activeFocus.join("; ")}`);
    }
    if (snapshot.coreMemory.notes.length > 0) {
      lines.push(`- Notes: ${snapshot.coreMemory.notes.join("; ")}`);
    }

    lines.push("");
    lines.push("## Durable project memory highlights");
    lines.push(...buildDurableHighlightLines(listDurableMemoryHighlights()));
    return lines;
  };

  const buildCurrentContextLines = (snapshot: CtoSnapshot): string[] => {
    const lines: string[] = [];
    lines.push("## Active context");
    if (snapshot.coreMemory.activeFocus.length > 0) {
      lines.push(...snapshot.coreMemory.activeFocus.map((item) => `- Focus: ${item}`));
    } else {
      lines.push("- Focus: no active focus captured yet");
    }
    if (snapshot.coreMemory.notes.length > 0) {
      lines.push(...snapshot.coreMemory.notes.map((item) => `- Note: ${item}`));
    }

    if (snapshot.recentSessions.length > 0) {
      lines.push("");
      lines.push("## Recent CTO sessions");
      for (const entry of snapshot.recentSessions) {
        lines.push(`- [${entry.createdAt}] ${clipText(entry.summary, 220)}`);
      }
    }

    if (snapshot.recentSubordinateActivity.length > 0) {
      lines.push("");
      lines.push("## Recent worker activity");
      for (const entry of snapshot.recentSubordinateActivity) {
        const detailParts = [
          entry.taskKey ? `task ${entry.taskKey}` : "",
          entry.issueKey ? `issue ${entry.issueKey}` : "",
        ].filter((part) => part.length > 0);
        lines.push(
          `- [${entry.createdAt}] ${entry.agentName}${detailParts.length ? ` (${detailParts.join(", ")})` : ""}: ${clipText(entry.summary, 220)}`
        );
      }
    }

    const contextDocs = listProjectContextDocPaths();
    if (contextDocs.length > 0) {
      lines.push("");
      lines.push("## Project context docs");
      lines.push(...contextDocs.map((docPath) => `- ${docPath}`));
    }

    const recentLogs = listRecentDailyLogSnippets();
    if (recentLogs.length > 0) {
      lines.push("");
      lines.push("## Daily carry-forward");
      for (const log of recentLogs) {
        lines.push(`### ${log.date}`);
        lines.push(...log.lines);
        lines.push("");
      }
      while (lines[lines.length - 1] === "") lines.pop();
    }

    return lines;
  };

  const renderGeneratedMemoryDoc = (
    title: string,
    intro: string,
    bodyLines: ReadonlyArray<string>,
  ): string => {
    return [
      `# ${title}`,
      "",
      intro,
      "",
      ...bodyLines,
    ].join("\n").trim();
  };

  const syncDerivedMemoryDocs = (snapshot = getSnapshot(8)): void => {
    const longTermDoc = renderGeneratedMemoryDoc(
      "CTO Memory",
      "Internal ADE-generated long-term CTO memory. This mirrors the always-on brief layer plus promoted durable project memory.",
      buildLongTermMemoryLines(snapshot),
    );
    const currentContextDoc = renderGeneratedMemoryDoc(
      "CTO Current Context",
      "Internal ADE-generated working context for continuity across compaction and session resumes.",
      buildCurrentContextLines(snapshot),
    );
    writeTextAtomic(memoryDocPath, `${longTermDoc}\n`);
    writeTextAtomic(currentContextDocPath, `${currentContextDoc}\n`);
  };

  const updateCoreMemory = (patch: CoreMemoryPatch): CtoSnapshot => {
    const current = getCoreMemory();
    const timestamp = nowIso();
    const next: CtoCoreMemory = {
      ...current,
      version: current.version + 1,
      updatedAt: timestamp,
      ...(typeof patch.projectSummary === "string" ? { projectSummary: patch.projectSummary.trim() } : {}),
      ...(patch.criticalConventions ? { criticalConventions: uniqueStrings(asStringArray(patch.criticalConventions)) } : {}),
      ...(patch.userPreferences ? { userPreferences: uniqueStrings(asStringArray(patch.userPreferences)) } : {}),
      ...(patch.activeFocus ? { activeFocus: uniqueStrings(asStringArray(patch.activeFocus)) } : {}),
      ...(patch.notes ? { notes: uniqueStrings(asStringArray(patch.notes)) } : {}),
    };
    writeCoreMemoryToFile(next);
    writeCoreMemoryToDb(next);
    const snapshot = getSnapshot();
    syncDerivedMemoryDocs(snapshot);
    return snapshot;
  };

  const appendSessionLog = (entry: AppendCtoSessionLogArgs): CtoSessionLogEntry => {
    reconcileAll();
    const next: CtoSessionLogEntry = {
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
    insertSessionLogToDb(next);
    const written = appendSessionLogToFile(next);
    syncDerivedMemoryDocs();
    return written;
  };

  const getSubordinateActivityLogs = (limit = 20): CtoSubordinateActivityEntry[] => {
    reconcileAll();
    const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    return listSubordinateActivityFromFile()
      .sort((a, b) => parseIsoToEpoch(b.createdAt) - parseIsoToEpoch(a.createdAt))
      .slice(0, safeLimit);
  };

  const appendSubordinateActivity = (entry: AppendCtoSubordinateActivityArgs): CtoSubordinateActivityEntry => {
    reconcileAll();
    const next: CtoSubordinateActivityEntry = {
      id: randomUUID(),
      agentId: entry.agentId.trim(),
      agentName: entry.agentName.trim() || entry.agentId.trim(),
      activityType: entry.activityType,
      summary: entry.summary.trim() || "Worker activity recorded.",
      sessionId: typeof entry.sessionId === "string" && entry.sessionId.trim().length ? entry.sessionId.trim() : null,
      taskKey: typeof entry.taskKey === "string" && entry.taskKey.trim().length ? entry.taskKey.trim() : null,
      issueKey: typeof entry.issueKey === "string" && entry.issueKey.trim().length ? entry.issueKey.trim() : null,
      createdAt: nowIso(),
    };
    appendSubordinateActivityToFile(next);
    syncDerivedMemoryDocs();
    return next;
  };

  const buildReconstructionContext = (recentLimit = 8): string => {
    const snapshot = getSnapshot(recentLimit);
    const sections: string[] = [];
    sections.push("CTO Memory Stack");
    sections.push(`- Layer 1 — runtime identity and operating doctrine. Hidden system instructions and identity.yaml keep you in the CTO role.`);
    sections.push(`- Layer 2 — long-term CTO brief at ${CTO_LONG_TERM_MEMORY_RELATIVE_PATH}. Update this layer with memoryUpdateCore when the project summary, conventions, preferences, focus, or standing notes change.`);
    sections.push(`- Layer 3 — current working context at ${CTO_CURRENT_CONTEXT_RELATIVE_PATH}. This layer carries active focus, recent sessions, worker activity, and daily logs through compaction.`);
    sections.push("- Layer 4 — searchable durable project memory. Use memorySearch before non-trivial work and memoryAdd for reusable decisions, conventions, patterns, gotchas, and stable preferences.");
    sections.push("");
    sections.push("CTO Identity");
    sections.push(`- Name: ${snapshot.identity.name}`);
    sections.push(`- Persona: ${snapshot.identity.persona}`);
    sections.push(`- Preferred model: ${snapshot.identity.modelPreferences.provider}/${snapshot.identity.modelPreferences.model}`);
    sections.push("");
    sections.push("Layer 2 — Long-term CTO brief");
    sections.push(...buildLongTermMemoryLines(snapshot));
    sections.push("");
    sections.push("Layer 3 — Current working context");
    sections.push(...buildCurrentContextLines(snapshot));

    return sections.join("\n").trim();
  };

  /* ── Onboarding state ── */

  const getOnboardingState = (): CtoOnboardingState => {
    const identity = getIdentity();
    return identity.onboardingState ?? { completedSteps: [] };
  };

  const completeOnboardingStep = (stepId: string): CtoOnboardingState => {
    const identity = getIdentity();
    const current = identity.onboardingState ?? { completedSteps: [] };
    if (current.completedSteps.includes(stepId)) return current;

    const next: CtoOnboardingState = {
      ...current,
      completedSteps: [...current.completedSteps, stepId],
    };
    // If all 3 steps complete, mark completed
    if (next.completedSteps.length >= 3 && !next.completedAt) {
      next.completedAt = nowIso();
    }

    const updated: CtoIdentity = {
      ...identity,
      onboardingState: next,
      version: identity.version + 1,
      updatedAt: nowIso(),
    };
    writeIdentityToFile(updated);
    writeIdentityToDb(updated);
    syncDerivedMemoryDocs();
    return next;
  };

  const dismissOnboarding = (): CtoOnboardingState => {
    const identity = getIdentity();
    const current = identity.onboardingState ?? { completedSteps: [] };
    const next: CtoOnboardingState = { ...current, dismissedAt: nowIso() };
    const updated: CtoIdentity = {
      ...identity,
      onboardingState: next,
      version: identity.version + 1,
      updatedAt: nowIso(),
    };
    writeIdentityToFile(updated);
    writeIdentityToDb(updated);
    syncDerivedMemoryDocs();
    return next;
  };

  const resetOnboarding = (): CtoOnboardingState => {
    const identity = getIdentity();
    const next: CtoOnboardingState = { completedSteps: [] };
    const updated: CtoIdentity = {
      ...identity,
      onboardingState: next,
      version: identity.version + 1,
      updatedAt: nowIso(),
    };
    writeIdentityToFile(updated);
    writeIdentityToDb(updated);
    syncDerivedMemoryDocs();
    return next;
  };

  /* ── Identity update (full patch) ── */

  const updateIdentity = (patch: Partial<Omit<CtoIdentity, "version" | "updatedAt">>): CtoSnapshot => {
    const current = getIdentity();
    const timestamp = nowIso();
    const next: CtoIdentity = {
      ...current,
      ...patch,
      modelPreferences: { ...current.modelPreferences, ...(patch.modelPreferences ?? {}) },
      memoryPolicy: { ...current.memoryPolicy, ...(patch.memoryPolicy ?? {}) },
      externalMcpAccess: normalizeExternalMcpAccess(patch.externalMcpAccess) ?? current.externalMcpAccess,
      openclawContextPolicy: normalizeOpenclawContextPolicy(patch.openclawContextPolicy) ?? current.openclawContextPolicy,
      version: current.version + 1,
      updatedAt: timestamp,
    };
    writeIdentityToFile(next);
    writeIdentityToDb(next);
    const snapshot = getSnapshot();
    syncDerivedMemoryDocs(snapshot);
    return snapshot;
  };

  /* ── System prompt preview ── */

  const previewSystemPrompt = (identityOverride?: Partial<CtoIdentity>): CtoSystemPromptPreview => {
    const identity = identityOverride
      ? { ...getIdentity(), ...identityOverride }
      : getIdentity();

    const sections: string[] = [];

    sections.push(`You are ${identity.name}.`);
    sections.push("You are the CTO for the current project inside ADE.");
    sections.push("Do not introduce yourself as Codex, Claude, or a generic assistant.");
    sections.push("When the user asks who you are, answer as the project's CTO and technical lead.");

    if (identity.persona?.trim()) {
      sections.push("", identity.persona.trim());
    }

    const presetInstruction = personalityInstructionForPreset(identity.personality);
    if (presetInstruction) {
      sections.push("", presetInstruction);
    } else if (identity.customPersonality?.trim()) {
      sections.push("", `Personality: ${identity.customPersonality.trim()}`);
    }

    if (identity.communicationStyle) {
      const cs = identity.communicationStyle;
      sections.push(
        "",
        "Communication Style:",
        `- Verbosity: ${cs.verbosity}`,
        `- Proactivity: ${cs.proactivity}`,
        `- Escalation threshold: ${cs.escalationThreshold}`,
      );
    }

    if (identity.constraints?.length) {
      sections.push("", "Constraints:", ...identity.constraints.map((c) => `- ${c}`));
    }

    if (identity.systemPromptExtension?.trim()) {
      sections.push("", identity.systemPromptExtension.trim());
    }

    // Memory protocol — baked into CTO DNA, not optional
    sections.push(
      "",
      "## Memory Stack",
      "You operate with four memory layers:",
      "1. Runtime identity and operating doctrine. This keeps you in the CTO role and is always re-applied after compaction.",
      `2. Long-term CTO brief (${CTO_LONG_TERM_MEMORY_RELATIVE_PATH}). Use memoryUpdateCore when the project summary, conventions, user preferences, active focus, or standing notes change.`,
      `3. Current working context (${CTO_CURRENT_CONTEXT_RELATIVE_PATH}). This is generated from recent sessions, worker activity, and daily logs for continuity.`,
      "4. Durable searchable project memory. Use memorySearch to retrieve it and memoryAdd to save reusable lessons.",
      "",
      "## Memory Protocol",
      "You have persistent memory that survives across conversations. Use it.",
      "- Before starting non-trivial work: search memory for relevant conventions, decisions, and known pitfalls",
      "- When the project brief itself changes: update Layer 2 with memoryUpdateCore",
      "- When you learn something important: save it to memory immediately using memoryAdd",
      "- Save reusable rules, decisions, patterns, gotchas, and stable preferences with memoryAdd",
      "- When corrected on a mistake: save the correction as a convention or gotcha",
      "- When a decision is made: save the decision AND the reasoning behind it",
      "- When a session is winding down or context is getting large: distill the active state into memoryUpdateCore or memoryAdd before compaction erases detail",
      "Do NOT save: file paths, raw errors, task status, things derivable from git log or the code itself.",
      "",
      "## Daily Context",
      "At the start of each conversation, orient yourself:",
      "1. Re-ground yourself in Layer 2 and Layer 3",
      "2. Search durable memory for active focus areas, recent decisions, and relevant gotchas",
      "3. Check what workers have been doing (subordinate activity)",
      "This gives you continuity. You are not starting fresh — you are picking up where you left off.",
      "",
      "## Decision Framework",
      "- Make autonomous decisions when they are safe and reversible",
      "- Escalate to the user when a decision is risky, irreversible, or ambiguous",
      "- When you lack context, search memory and the repo before asking the user",
      "- State your reasoning concisely — the user wants decisions, not analysis paralysis",
      "",
      "## Role Boundaries",
      "- Act as the project's CTO and technical lead, not as a detached coding chatbot",
      "- Speak with authority about the project once you have repo or memory evidence",
      "- Use ADE's tools, workers, and connected systems when they help move the project forward",
    );

    const prompt = sections.join("\n").trim();
    return {
      prompt,
      tokenEstimate: Math.ceil(prompt.length / 4),
    };
  };

  /* ── Daily log ── */

  const dailyLogDir = path.join(ctoDir, "daily");

  const getDailyLogPath = (date?: string): string => {
    const day = date ?? nowIso().slice(0, 10); // YYYY-MM-DD
    return path.join(dailyLogDir, `${day}.md`);
  };

  const appendDailyLog = (entry: string, date?: string): void => {
    fs.mkdirSync(dailyLogDir, { recursive: true });
    const logPath = getDailyLogPath(date);
    const timestamp = nowIso().slice(11, 19); // HH:MM:SS
    fs.appendFileSync(logPath, `- [${timestamp}] ${entry.trim()}\n`, "utf8");
    syncDerivedMemoryDocs();
  };

  const readDailyLog = (date?: string): string | null => {
    const logPath = getDailyLogPath(date);
    if (!fs.existsSync(logPath)) return null;
    return fs.readFileSync(logPath, "utf8");
  };

  const listDailyLogs = (limit = 7): string[] => {
    if (!fs.existsSync(dailyLogDir)) return [];
    return fs.readdirSync(dailyLogDir)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .reverse()
      .slice(0, limit)
      .map((f) => f.replace(/\.md$/, ""));
  };

  const appendContinuityCheckpoint = (args: {
    reason: "compaction" | "manual";
    entries: Array<{ role: "user" | "assistant"; text: string }>;
  }): void => {
    const latestUser = [...args.entries].reverse().find((entry) => entry.role === "user" && squishText(entry.text).length > 0);
    const latestAssistant = [...args.entries].reverse().find((entry) => entry.role === "assistant" && squishText(entry.text).length > 0);
    const detailParts = [
      latestUser ? `user: ${clipText(latestUser.text, 180)}` : "",
      latestAssistant ? `cto: ${clipText(latestAssistant.text, 180)}` : "",
    ].filter((value) => value.length > 0);
    if (detailParts.length === 0) return;
    appendDailyLog(
      `${args.reason === "compaction" ? "Compaction checkpoint" : "Continuity checkpoint"} — ${detailParts.join(" | ")}`
    );
  };

  // Ensure the state is initialized as soon as the service is created.
  reconcileAll();
  syncDerivedMemoryDocs();

  return {
    getIdentity,
    getCoreMemory,
    getSessionLogs,
    getSubordinateActivityLogs,
    getSnapshot,
    updateCoreMemory,
    updateIdentity,
    appendSessionLog,
    appendSubordinateActivity,
    buildReconstructionContext,
    getOnboardingState,
    completeOnboardingStep,
    dismissOnboarding,
    resetOnboarding,
    previewSystemPrompt,
    appendDailyLog,
    appendContinuityCheckpoint,
    readDailyLog,
    listDailyLogs,
    syncDerivedMemoryDocs,
  };
}

export type CtoStateService = ReturnType<typeof createCtoStateService>;
