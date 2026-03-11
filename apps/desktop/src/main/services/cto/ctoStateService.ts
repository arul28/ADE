import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import YAML from "yaml";
import type {
  CtoCoreMemory,
  CtoIdentity,
  CtoOnboardingState,
  CtoSessionLogEntry,
  CtoSubordinateActivityEntry,
  CtoSnapshot,
  CtoSystemPromptPreview,
} from "../../../shared/types";
import type { AdeDb } from "../state/kvDb";
import { nowIso, parseIsoToEpoch, safeJsonParse, uniqueStrings, writeTextAtomic } from "../shared/utils";

type CtoStateServiceArgs = {
  db: AdeDb;
  projectId: string;
  adeDir: string;
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

  return {
    name,
    version,
    persona,
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
    updatedAt,
  };
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
    persona:
      "You are the CTO for this project. You retain durable technical context and guide implementation decisions.",
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
    updatedAt: timestamp,
  };
}

function makeDefaultCoreMemory(): CtoCoreMemory {
  const timestamp = nowIso();
  return {
    version: 1,
    updatedAt: timestamp,
    projectSummary: "CTO memory initialized. Capture project goals and critical architecture decisions here.",
    criticalConventions: [],
    userPreferences: [],
    activeFocus: [],
    notes: [],
  };
}

export function createCtoStateService(args: CtoStateServiceArgs) {
  const ctoDir = path.join(args.adeDir, "cto");
  const identityPath = path.join(ctoDir, "identity.yaml");
  const coreMemoryPath = path.join(ctoDir, "core-memory.json");
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

  const appendSessionLogToFile = (entry: CtoSessionLogEntry): void => {
    fs.mkdirSync(path.dirname(sessionsPath), { recursive: true });
    fs.appendFileSync(sessionsPath, `${JSON.stringify(entry)}\n`, "utf8");
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
    return getSnapshot();
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
    appendSessionLogToFile(next);
    return next;
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
    return next;
  };

  const buildReconstructionContext = (recentLimit = 8): string => {
    const snapshot = getSnapshot(recentLimit);
    const sections: string[] = [];
    sections.push("CTO Identity");
    sections.push(`- Name: ${snapshot.identity.name}`);
    sections.push(`- Persona: ${snapshot.identity.persona}`);
    sections.push(`- Preferred model: ${snapshot.identity.modelPreferences.provider}/${snapshot.identity.modelPreferences.model}`);
    sections.push("");
    sections.push("Core Memory");
    sections.push(`- Project summary: ${snapshot.coreMemory.projectSummary}`);
    if (snapshot.coreMemory.criticalConventions.length) {
      sections.push(`- Critical conventions: ${snapshot.coreMemory.criticalConventions.join("; ")}`);
    }
    if (snapshot.coreMemory.userPreferences.length) {
      sections.push(`- User preferences: ${snapshot.coreMemory.userPreferences.join("; ")}`);
    }
    if (snapshot.coreMemory.activeFocus.length) {
      sections.push(`- Active focus: ${snapshot.coreMemory.activeFocus.join("; ")}`);
    }
    if (snapshot.coreMemory.notes.length) {
      sections.push(`- Notes: ${snapshot.coreMemory.notes.join("; ")}`);
    }
    if (snapshot.recentSessions.length) {
      sections.push("");
      sections.push("Recent Sessions");
      for (const entry of snapshot.recentSessions) {
        sections.push(`- [${entry.createdAt}] ${entry.summary}`);
      }
    }
    if (snapshot.recentSubordinateActivity.length) {
      sections.push("");
      sections.push("Recent Employee Activity");
      for (const entry of snapshot.recentSubordinateActivity) {
        const detailParts = [
          entry.taskKey ? `task ${entry.taskKey}` : "",
          entry.issueKey ? `issue ${entry.issueKey}` : "",
        ].filter((part) => part.length > 0);
        sections.push(
          `- [${entry.createdAt}] ${entry.agentName} (${entry.activityType}${detailParts.length ? `; ${detailParts.join(", ")}` : ""}): ${entry.summary}`
        );
      }
    }
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
      version: current.version + 1,
      updatedAt: timestamp,
    };
    writeIdentityToFile(next);
    writeIdentityToDb(next);
    return getSnapshot();
  };

  /* ── System prompt preview ── */

  const previewSystemPrompt = (identityOverride?: Partial<CtoIdentity>): CtoSystemPromptPreview => {
    const identity = identityOverride
      ? { ...getIdentity(), ...identityOverride }
      : getIdentity();

    const sections: string[] = [];

    sections.push(`You are ${identity.name}.`);

    if (identity.persona?.trim()) {
      sections.push("", identity.persona.trim());
    }

    if (identity.personality && identity.personality !== "custom") {
      sections.push("", `Personality: ${identity.personality}`);
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

    const prompt = sections.join("\n").trim();
    return {
      prompt,
      tokenEstimate: Math.ceil(prompt.length / 4),
    };
  };

  // Ensure the state is initialized as soon as the service is created.
  reconcileAll();

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
  };
}

export type CtoStateService = ReturnType<typeof createCtoStateService>;
