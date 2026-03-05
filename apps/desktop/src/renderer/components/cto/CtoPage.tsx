import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Brain,
  CaretDown,
  CaretRight,
  PencilSimple,
  Robot,
  Plus,
  ArrowCounterClockwise,
  Warning,
  Lightning,
  Pulse,
  Clock,
  Trash,
} from "@phosphor-icons/react";
import type {
  AgentBudgetSnapshot,
  AgentChatSession,
  AgentConfigRevision,
  AgentCoreMemory,
  AgentIdentity,
  AgentSessionLogEntry,
  AgentRole,
  AdapterType,
  HeartbeatPolicy,
  CtoCoreMemory,
  CtoIdentity,
  CtoSessionLogEntry,
  WorkerAgentRun,
} from "../../../shared/types";
import { AgentChatPane } from "../chat/AgentChatPane";
import { useAppStore } from "../../state/appStore";
import { COLORS, MONO_FONT, SANS_FONT, LABEL_STYLE, inlineBadge, outlineButton, primaryButton, dangerButton, cardStyle } from "../lanes/laneDesignTokens";

/* ── Helpers ── */

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function splitTrimmed(val: string): string[] {
  return val.split(",").map((s) => s.trim()).filter(Boolean);
}

function capabilityLabel(mode: AgentChatSession["capabilityMode"] | null | undefined): string {
  return mode === "full_mcp" ? "FULL MCP" : "FALLBACK";
}

function statusDotColor(status: AgentIdentity["status"]): string {
  if (status === "running") return COLORS.info;
  if (status === "active") return COLORS.success;
  if (status === "paused") return COLORS.warning;
  return COLORS.textDim;
}

function runStatusColor(status: WorkerAgentRun["status"]): string {
  if (status === "running") return COLORS.info;
  if (status === "completed") return COLORS.success;
  if (status === "failed") return COLORS.danger;
  if (status === "deferred") return COLORS.warning;
  return COLORS.textMuted;
}

function roleBadgeLabel(role: AgentRole): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/* ── Section Toggle ── */

function SectionToggle({
  label,
  open,
  onToggle,
  action,
  count,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  action?: React.ReactNode;
  count?: number;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 12, marginBottom: 4 }}>
      <button
        type="button"
        onClick={onToggle}
        style={{
          ...LABEL_STYLE,
          display: "flex",
          alignItems: "center",
          gap: 5,
          background: "none",
          border: "none",
          cursor: "pointer",
          padding: 0,
        }}
      >
        {open ? <CaretDown size={9} weight="bold" /> : <CaretRight size={9} weight="bold" />}
        {label}
        {count != null && count > 0 && (
          <span style={{ ...inlineBadge(COLORS.textMuted), fontSize: 9, padding: "1px 5px" }}>{count}</span>
        )}
      </button>
      {action}
    </div>
  );
}

/* ── Core Memory (shared between CTO + workers) ── */

type CoreMemoryLike = {
  version: number;
  updatedAt: string;
  projectSummary: string;
  criticalConventions: string[];
  userPreferences: string[];
  activeFocus: string[];
  notes: string[];
};

type CoreMemoryPatch = Partial<Omit<CoreMemoryLike, "version" | "updatedAt">>;

const DRAFT_FIELDS = [
  { key: "projectSummary", label: "Summary", multiline: true },
  { key: "criticalConventions", label: "Conventions", multiline: false },
  { key: "userPreferences", label: "Preferences", multiline: false },
  { key: "activeFocus", label: "Focus", multiline: false },
  { key: "notes", label: "Notes", multiline: false },
] as const;

function CoreMemorySection({
  label = "Core Memory",
  testIdPrefix = "core-memory",
  coreMemory,
  onSave,
}: {
  label?: string;
  testIdPrefix?: string;
  coreMemory: CoreMemoryLike;
  onSave: (patch: CoreMemoryPatch) => Promise<void>;
}) {
  const [open, setOpen] = useState(true);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => ({
    projectSummary: coreMemory.projectSummary,
    criticalConventions: coreMemory.criticalConventions.join(", "),
    userPreferences: coreMemory.userPreferences.join(", "),
    activeFocus: coreMemory.activeFocus.join(", "),
    notes: coreMemory.notes.join(", "),
  }));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!editing) setDraft({
      projectSummary: coreMemory.projectSummary,
      criticalConventions: coreMemory.criticalConventions.join(", "),
      userPreferences: coreMemory.userPreferences.join(", "),
      activeFocus: coreMemory.activeFocus.join(", "),
      notes: coreMemory.notes.join(", "),
    });
  }, [coreMemory, editing]);

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await onSave({
        projectSummary: draft.projectSummary.trim() || coreMemory.projectSummary,
        criticalConventions: splitTrimmed(draft.criticalConventions),
        userPreferences: splitTrimmed(draft.userPreferences),
        activeFocus: splitTrimmed(draft.activeFocus),
        notes: splitTrimmed(draft.notes),
      });
      setEditing(false);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  };

  const inputStyle: React.CSSProperties = {
    width: "100%",
    background: COLORS.recessedBg,
    border: `1px solid ${COLORS.border}`,
    borderRadius: 0,
    padding: "5px 8px",
    fontSize: 11,
    fontFamily: MONO_FONT,
    color: COLORS.textPrimary,
    outline: "none",
    resize: "none",
  };

  return (
    <div>
      <SectionToggle
        label={label}
        open={open}
        onToggle={() => setOpen((o) => !o)}
        action={!editing ? (
          <button type="button" onClick={(e) => { e.stopPropagation(); setOpen(true); setEditing(true); }}
            style={{ background: "none", border: "none", cursor: "pointer", color: COLORS.textMuted, padding: 0 }}
            title="Edit core memory" data-testid={`${testIdPrefix}-edit-btn`}>
            <PencilSimple size={12} />
          </button>
        ) : undefined}
      />
      {open && (
        <div style={{ marginTop: 4 }}>
          {editing ? (
            <div style={{ ...cardStyle({ padding: 10 }), borderColor: `${COLORS.accent}40` }}>
              {DRAFT_FIELDS.map(({ key, label: fieldLabel, multiline }) => (
                <div key={key} style={{ marginBottom: 6 }}>
                  <div style={{ ...LABEL_STYLE, marginBottom: 3 }}>{fieldLabel}</div>
                  {multiline ? (
                    <textarea style={{ ...inputStyle, minHeight: 40 }} rows={2}
                      value={draft[key]} onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))} />
                  ) : (
                    <input type="text" style={inputStyle} placeholder="comma-separated"
                      value={draft[key]} onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))} />
                  )}
                </div>
              ))}
              {saveError && <div style={{ fontSize: 11, color: COLORS.danger, marginBottom: 6 }} data-testid={`${testIdPrefix}-save-error`}>{saveError}</div>}
              <div style={{ display: "flex", gap: 6 }}>
                <button type="button" onClick={handleSave} disabled={saving}
                  style={{ ...primaryButton({ flex: 1, height: 28, opacity: saving ? 0.5 : 1 }) }} data-testid={`${testIdPrefix}-save-btn`}>
                  {saving ? "Saving\u2026" : "Save"}
                </button>
                <button type="button" onClick={() => { setEditing(false); setSaveError(null); }} disabled={saving}
                  style={{ ...outlineButton({ flex: 1, height: 28 }) }} data-testid={`${testIdPrefix}-cancel-btn`}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div data-testid={`${testIdPrefix}-view`}>
              <div style={{ background: COLORS.recessedBg, padding: "8px 10px", fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textSecondary, lineHeight: 1.5 }}>
                {coreMemory.projectSummary || "No project summary yet."}
              </div>
              {[
                { items: coreMemory.criticalConventions, label: "Conventions" },
                { items: coreMemory.activeFocus, label: "Focus" },
                { items: coreMemory.userPreferences, label: "Prefs" },
                { items: coreMemory.notes, label: "Notes" },
              ].filter(({ items }) => items.length > 0).map(({ items, label: l }) => (
                <div key={l} style={{ padding: "2px 4px", marginTop: 2 }}>
                  <span style={{ fontSize: 10, color: COLORS.textDim }}>{l}: </span>
                  <span style={{ fontSize: 10, color: COLORS.textMuted }}>{items.join(", ")}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Session History ── */

function SessionHistorySection({
  label = "Recent Sessions",
  testId = "session-history-list",
  sessions,
}: {
  label?: string;
  testId?: string;
  sessions: Array<{ id: string; summary: string; createdAt: string }>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <SectionToggle label={label} open={open} onToggle={() => setOpen((o) => !o)} count={sessions.length} />
      {open && (
        <div data-testid={testId}>
          {sessions.length === 0 ? (
            <div style={{ fontSize: 11, color: COLORS.textDim, padding: "4px 0" }}>No sessions recorded yet.</div>
          ) : sessions.map((s) => (
            <div key={s.id} style={{ background: COLORS.recessedBg, padding: "6px 8px", marginBottom: 3 }}>
              <div style={{ fontSize: 10, color: COLORS.textDim }}>{formatDate(s.createdAt)}</div>
              <div style={{ fontSize: 11, color: COLORS.textSecondary, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>{s.summary}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Heartbeat Run History ── */

function WorkerRunHistorySection({
  runs,
  waking,
  wakeStatus,
  wakeError,
  onWakeNow,
}: {
  runs: WorkerAgentRun[];
  waking: boolean;
  wakeStatus: string | null;
  wakeError: string | null;
  onWakeNow: () => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div>
      <SectionToggle
        label="Heartbeat Runs"
        open={open}
        onToggle={() => setOpen((v) => !v)}
        count={runs.length}
        action={
          <button type="button" onClick={(e) => { e.stopPropagation(); onWakeNow(); }} disabled={waking}
            style={{ ...outlineButton({ height: 22, padding: "0 8px", fontSize: 10, opacity: waking ? 0.5 : 1 }) }}
            data-testid="worker-wake-now-btn">
            <Lightning size={10} weight="bold" />
            {waking ? "Waking\u2026" : "Wake now"}
          </button>
        }
      />
      {wakeStatus && <div style={{ fontSize: 10, color: COLORS.success, marginTop: 2 }} data-testid="worker-wake-status">{wakeStatus}</div>}
      {wakeError && <div style={{ fontSize: 10, color: COLORS.danger, marginTop: 2 }} data-testid="worker-wake-error">{wakeError}</div>}
      {open && (
        <div data-testid="worker-run-history-list">
          {runs.length === 0 ? (
            <div style={{ fontSize: 11, color: COLORS.textDim, padding: "4px 0" }}>No runs yet.</div>
          ) : runs.map((run) => (
            <div key={run.id} style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.border}`, padding: "6px 8px", marginBottom: 3 }} data-testid={`worker-run-row-${run.id}`}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
                <span style={{ fontSize: 10, color: COLORS.textDim }}>{formatDate(run.createdAt)}</span>
                <span style={{ ...inlineBadge(runStatusColor(run.status)), fontSize: 9, padding: "1px 6px" }}>{run.status}</span>
              </div>
              <div style={{ fontSize: 11, color: COLORS.textSecondary, marginTop: 3, fontFamily: MONO_FONT }}>
                {run.wakeupReason}{run.issueKey ? ` \u00B7 ${run.issueKey}` : ""}{run.taskKey ? ` \u00B7 ${run.taskKey}` : ""}
              </div>
              {run.errorMessage && <div style={{ fontSize: 10, color: COLORS.danger, marginTop: 2 }}>{run.errorMessage}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Worker Editor Draft ── */

type WorkerEditorDraft = {
  id?: string;
  name: string;
  role: AgentRole;
  title: string;
  reportsTo: string;
  capabilities: string;
  adapterType: AdapterType;
  model: string;
  webhookUrl: string;
  authHeader: string;
  processCommand: string;
  budgetDollars: number;
  heartbeatEnabled: boolean;
  heartbeatIntervalSec: number;
  wakeOnDemand: boolean;
  activeHoursEnabled: boolean;
  activeHoursStart: string;
  activeHoursEnd: string;
  activeHoursTimezone: string;
  maxConcurrentRuns: number;
};

function workerDraftFromAgent(agent?: AgentIdentity | null): WorkerEditorDraft {
  const adapterConfig = (agent?.adapterConfig ?? {}) as Record<string, unknown>;
  const runtimeConfig = (agent?.runtimeConfig ?? {}) as Record<string, unknown>;
  const heartbeat = runtimeConfig.heartbeat as Record<string, unknown> | undefined;
  const activeHours = heartbeat?.activeHours as Record<string, unknown> | undefined;
  return {
    ...(agent?.id ? { id: agent.id } : {}),
    name: agent?.name ?? "",
    role: agent?.role ?? "engineer",
    title: agent?.title ?? "",
    reportsTo: agent?.reportsTo ?? "",
    capabilities: (agent?.capabilities ?? []).join(", "),
    adapterType: agent?.adapterType ?? "claude-local",
    model: typeof adapterConfig.model === "string" ? adapterConfig.model : "",
    webhookUrl: typeof adapterConfig.url === "string" ? adapterConfig.url : "",
    authHeader: typeof (adapterConfig.headers as Record<string, unknown> | undefined)?.Authorization === "string"
      ? String((adapterConfig.headers as Record<string, unknown>).Authorization) : "",
    processCommand: typeof adapterConfig.command === "string" ? adapterConfig.command : "",
    budgetDollars: (agent?.budgetMonthlyCents ?? 0) / 100,
    heartbeatEnabled: heartbeat?.enabled === true,
    heartbeatIntervalSec: Number(heartbeat?.intervalSec ?? 300),
    wakeOnDemand: heartbeat?.wakeOnDemand !== false,
    activeHoursEnabled: Boolean(activeHours?.start),
    activeHoursStart: typeof activeHours?.start === "string" ? activeHours.start : "09:00",
    activeHoursEnd: typeof activeHours?.end === "string" ? activeHours.end : "22:00",
    activeHoursTimezone: typeof activeHours?.timezone === "string" ? activeHours.timezone : "local",
    maxConcurrentRuns: Math.max(1, Math.min(10, Math.floor(Number(runtimeConfig.maxConcurrentRuns ?? 1)))),
  };
}

/* ── Main Page ── */

export function CtoPage() {
  const lanes = useAppStore((s) => s.lanes);
  const selectedLaneId = useAppStore((s) => s.selectedLaneId);

  const [session, setSession] = useState<AgentChatSession | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [ctoIdentity, setCtoIdentity] = useState<CtoIdentity | null>(null);
  const [coreMemory, setCoreMemory] = useState<CtoCoreMemory | null>(null);
  const [sessionLogs, setSessionLogs] = useState<CtoSessionLogEntry[]>([]);

  const [agents, setAgents] = useState<AgentIdentity[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [revisions, setRevisions] = useState<AgentConfigRevision[]>([]);
  const [budgetSnapshot, setBudgetSnapshot] = useState<AgentBudgetSnapshot | null>(null);
  const [workerCoreMemory, setWorkerCoreMemory] = useState<AgentCoreMemory | null>(null);
  const [workerSessionLogs, setWorkerSessionLogs] = useState<AgentSessionLogEntry[]>([]);
  const [workerRuns, setWorkerRuns] = useState<WorkerAgentRun[]>([]);
  const [workerOpsError, setWorkerOpsError] = useState<string | null>(null);
  const [workerWakeStatus, setWorkerWakeStatus] = useState<string | null>(null);
  const [workerWakeError, setWorkerWakeError] = useState<string | null>(null);
  const [wakingWorker, setWakingWorker] = useState(false);

  const [editorOpen, setEditorOpen] = useState(false);
  const [workerDraft, setWorkerDraft] = useState<WorkerEditorDraft>(workerDraftFromAgent(null));
  const [savingWorker, setSavingWorker] = useState(false);
  const [workerError, setWorkerError] = useState<string | null>(null);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const editorRef = useRef<HTMLDivElement>(null);

  const laneId = useMemo(() => {
    if (selectedLaneId && lanes.some((lane) => lane.id === selectedLaneId)) return selectedLaneId;
    return lanes[0]?.id ?? null;
  }, [lanes, selectedLaneId]);

  const selectedWorker = useMemo(
    () => (selectedAgentId ? agents.find((a) => a.id === selectedAgentId) ?? null : null),
    [agents, selectedAgentId]
  );

  const budgetByWorkerId = useMemo(() => {
    const map = new Map<string, AgentBudgetSnapshot["workers"][number]>();
    for (const w of budgetSnapshot?.workers ?? []) map.set(w.agentId, w);
    return map;
  }, [budgetSnapshot]);

  /* ── Data loading ── */

  const loadCtoState = useCallback(async () => {
    if (!window.ade?.cto) return;
    try {
      const snapshot = await window.ade.cto.getState({ recentLimit: 20 });
      setCtoIdentity(snapshot.identity);
      setCoreMemory(snapshot.coreMemory);
      setSessionLogs(snapshot.recentSessions);
    } catch { /* non-fatal */ }
  }, []);

  const loadWorkersAndBudget = useCallback(async () => {
    if (!window.ade?.cto) return;
    try {
      const [nextAgents, nextBudget] = await Promise.all([
        window.ade.cto.listAgents({ includeDeleted: false }),
        window.ade.cto.getBudgetSnapshot({}),
      ]);
      setAgents(nextAgents);
      setBudgetSnapshot(nextBudget);
      if (selectedAgentId && !nextAgents.some((a) => a.id === selectedAgentId)) {
        setSelectedAgentId(null);
      }
    } catch { /* non-fatal */ }
  }, [selectedAgentId]);

  useEffect(() => {
    void Promise.all([loadCtoState(), loadWorkersAndBudget()]);
  }, [loadCtoState, loadWorkersAndBudget]);

  // Load revisions when a worker is selected
  useEffect(() => {
    if (!window.ade?.cto || !selectedAgentId) { setRevisions([]); return; }
    void window.ade.cto.listAgentRevisions({ agentId: selectedAgentId, limit: 20 }).then(setRevisions).catch(() => setRevisions([]));
  }, [selectedAgentId]);

  // Load worker details when selected
  useEffect(() => {
    if (!window.ade?.cto || !selectedAgentId) {
      setWorkerCoreMemory(null); setWorkerSessionLogs([]); setWorkerRuns([]); setWorkerOpsError(null); setWorkerWakeStatus(null); setWorkerWakeError(null);
      return;
    }
    let cancelled = false;
    void Promise.all([
      window.ade.cto.getAgentCoreMemory({ agentId: selectedAgentId }),
      window.ade.cto.listAgentSessionLogs({ agentId: selectedAgentId, limit: 20 }),
      window.ade.cto.listAgentRuns({ agentId: selectedAgentId, limit: 20 }),
    ]).then(([memory, sessions, runs]) => {
      if (cancelled) return;
      setWorkerCoreMemory(memory); setWorkerSessionLogs(sessions); setWorkerRuns(runs); setWorkerOpsError(null);
    }).catch((err) => {
      if (cancelled) return;
      setWorkerOpsError(err instanceof Error ? err.message : "Failed to load worker details.");
      setWorkerCoreMemory(null); setWorkerSessionLogs([]); setWorkerRuns([]);
    });
    return () => { cancelled = true; };
  }, [selectedAgentId]);

  // Establish chat session
  useEffect(() => {
    if (!laneId) { setSession(null); return; }
    if (!window.ade?.cto) { setError("CTO bridge is unavailable."); setSession(null); return; }
    let cancelled = false;
    setLoading(true); setError(null);
    const promise = selectedAgentId
      ? window.ade.cto.ensureAgentSession({ agentId: selectedAgentId, laneId })
      : window.ade.cto.ensureSession({ laneId });
    void promise
      .then((next) => { if (!cancelled) setSession(next); })
      .catch((err) => { if (!cancelled) { setError(err instanceof Error ? err.message : String(err)); setSession(null); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [laneId, selectedAgentId]);

  useEffect(() => {
    if (editorOpen && editorRef.current) editorRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [editorOpen]);

  /* ── Callbacks ── */

  const handleSaveCoreMemory = useCallback(async (patch: CoreMemoryPatch) => {
    if (!window.ade?.cto) throw new Error("CTO bridge unavailable.");
    const snapshot = await window.ade.cto.updateCoreMemory({ patch });
    setCoreMemory(snapshot.coreMemory);
  }, []);

  const handleSaveWorkerCoreMemory = useCallback(async (patch: CoreMemoryPatch) => {
    if (!window.ade?.cto || !selectedAgentId) throw new Error("Select a worker first.");
    const updated = await window.ade.cto.updateAgentCoreMemory({ agentId: selectedAgentId, patch });
    setWorkerCoreMemory(updated);
  }, [selectedAgentId]);

  const handleSaveCtoIdentity = useCallback(async (draft: { name: string; persona: string; provider: string; model: string; reasoningEffort: string }) => {
    if (!window.ade?.cto) throw new Error("CTO bridge unavailable.");
    const snapshot = await window.ade.cto.updateIdentity({
      patch: { name: draft.name, persona: draft.persona, modelPreferences: { provider: draft.provider, model: draft.model, reasoningEffort: draft.reasoningEffort || null } },
    });
    setCtoIdentity(snapshot.identity);
  }, []);

  const saveWorker = useCallback(async () => {
    if (!window.ade?.cto) return;
    setSavingWorker(true); setWorkerError(null);
    try {
      const at = workerDraft.adapterType;
      const adapterConfig: Record<string, unknown> =
        at === "openclaw-webhook" ? { url: workerDraft.webhookUrl, ...(workerDraft.authHeader.trim() ? { headers: { Authorization: workerDraft.authHeader.trim() } } : {}) }
        : at === "process" ? { command: workerDraft.processCommand }
        : { ...(workerDraft.model.trim() ? { model: workerDraft.model.trim() } : {}) };

      const heartbeat: HeartbeatPolicy = {
        enabled: workerDraft.heartbeatEnabled,
        intervalSec: Math.max(0, Math.floor(workerDraft.heartbeatIntervalSec)),
        wakeOnDemand: workerDraft.wakeOnDemand,
        ...(workerDraft.activeHoursEnabled ? { activeHours: { start: workerDraft.activeHoursStart.trim() || "09:00", end: workerDraft.activeHoursEnd.trim() || "22:00", timezone: workerDraft.activeHoursTimezone.trim() || "local" } } : {}),
      };

      await window.ade.cto.saveAgent({
        agent: {
          ...(workerDraft.id ? { id: workerDraft.id } : {}),
          name: workerDraft.name, role: workerDraft.role,
          ...(workerDraft.title.trim() ? { title: workerDraft.title.trim() } : {}),
          reportsTo: workerDraft.reportsTo.trim() || null,
          capabilities: splitTrimmed(workerDraft.capabilities),
          adapterType: at, adapterConfig,
          runtimeConfig: { heartbeat, maxConcurrentRuns: Math.max(1, Math.min(10, Math.floor(workerDraft.maxConcurrentRuns || 1))) },
          budgetMonthlyCents: Math.max(0, Math.round(workerDraft.budgetDollars * 100)),
        },
      });
      setEditorOpen(false);
      await loadWorkersAndBudget();
    } catch (err) {
      setWorkerError(err instanceof Error ? err.message : "Failed to save worker.");
    } finally {
      setSavingWorker(false);
    }
  }, [loadWorkersAndBudget, workerDraft]);

  const removeWorker = useCallback(async (agentId: string) => {
    if (!window.ade?.cto) return;
    await window.ade.cto.removeAgent({ agentId });
    setConfirmRemoveId(null);
    if (selectedAgentId === agentId) setSelectedAgentId(null);
    await loadWorkersAndBudget();
  }, [loadWorkersAndBudget, selectedAgentId]);

  const rollbackRevision = useCallback(async (revisionId: string) => {
    if (!window.ade?.cto || !selectedAgentId) return;
    await window.ade.cto.rollbackAgentRevision({ agentId: selectedAgentId, revisionId });
    await loadWorkersAndBudget();
    const next = await window.ade.cto.listAgentRevisions({ agentId: selectedAgentId, limit: 20 });
    setRevisions(next);
  }, [loadWorkersAndBudget, selectedAgentId]);

  const wakeSelectedWorker = useCallback(async () => {
    if (!window.ade?.cto || !selectedAgentId) return;
    setWakingWorker(true); setWorkerWakeError(null);
    try {
      const wake = await window.ade.cto.triggerAgentWakeup({ agentId: selectedAgentId, reason: "manual", context: { source: "cto_ui" } });
      setWorkerWakeStatus(`Wake: ${wake.status}`);
      const nextRuns = await window.ade.cto.listAgentRuns({ agentId: selectedAgentId, limit: 20 });
      setWorkerRuns(nextRuns);
    } catch (err) {
      setWorkerWakeError(err instanceof Error ? err.message : "Failed to wake worker.");
    } finally {
      setWakingWorker(false);
    }
  }, [selectedAgentId]);

  /* ── Styles ── */

  const inputStyle: React.CSSProperties = {
    width: "100%", background: COLORS.recessedBg, border: `1px solid ${COLORS.border}`, borderRadius: 0,
    padding: "5px 8px", fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textPrimary, outline: "none",
  };

  const selectStyle: React.CSSProperties = { ...inputStyle, appearance: "none" as const };

  /* ── Render worker tree ── */

  const renderWorkerTree = (parentId: string | null, depth = 0): React.ReactNode => {
    const children = agents.filter((a) => (a.reportsTo ?? null) === parentId).sort((a, b) => a.name.localeCompare(b.name));
    return children.map((agent) => {
      const budget = budgetByWorkerId.get(agent.id);
      const isSelected = selectedAgentId === agent.id;
      const isConfirmingRemove = confirmRemoveId === agent.id;
      const budgetBreached = (budget?.budgetMonthlyCents ?? 0) > 0 && (budget?.spentMonthlyCents ?? 0) >= (budget?.budgetMonthlyCents ?? 0);

      return (
        <div key={agent.id}>
          <div
            role="button" tabIndex={0}
            onClick={() => setSelectedAgentId(agent.id)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelectedAgentId(agent.id); } }}
            data-testid={`worker-row-${agent.id}`}
            style={{
              background: isSelected ? `${COLORS.accent}12` : "transparent",
              borderLeft: isSelected ? `2px solid ${COLORS.accent}` : "2px solid transparent",
              padding: "8px 10px",
              paddingLeft: 10 + depth * 14,
              cursor: "pointer",
              transition: "all 0.15s",
            }}
            onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = COLORS.hoverBg; }}
            onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = "transparent"; }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ width: 7, height: 7, borderRadius: "50%", background: statusDotColor(agent.status), flexShrink: 0 }} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 12, fontFamily: MONO_FONT, color: COLORS.textPrimary, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {agent.name}
                  {agent.title && <span style={{ fontWeight: 400, color: COLORS.textMuted, marginLeft: 6, fontSize: 11 }}>{agent.title}</span>}
                </div>
                <div style={{ fontSize: 10, color: COLORS.textDim, fontFamily: MONO_FONT, marginTop: 1 }}>
                  {roleBadgeLabel(agent.role)} \u00B7 {agent.adapterType}
                  {budget ? ` \u00B7 ${dollars(budget.spentMonthlyCents)}` : ""}
                </div>
              </div>
              <span style={{ ...inlineBadge(statusDotColor(agent.status)), fontSize: 9, padding: "1px 5px" }}>{agent.status}</span>
            </div>

            {agent.capabilities.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginTop: 5, marginLeft: 15 }}>
                {agent.capabilities.slice(0, 4).map((cap) => (
                  <span key={cap} style={{ fontSize: 9, fontFamily: MONO_FONT, color: COLORS.textDim, background: COLORS.recessedBg, border: `1px solid ${COLORS.border}`, padding: "1px 5px" }}>{cap}</span>
                ))}
                {agent.capabilities.length > 4 && <span style={{ fontSize: 9, color: COLORS.textDim }}>+{agent.capabilities.length - 4}</span>}
              </div>
            )}

            {budgetBreached && agent.status === "paused" && (
              <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 4, marginLeft: 15, fontSize: 10, color: COLORS.warning }}>
                <Warning size={10} /> Budget cap reached
              </div>
            )}

            <div style={{ display: "flex", gap: 4, marginTop: 6, marginLeft: 15 }} onClick={(e) => e.stopPropagation()}>
              {isConfirmingRemove ? (
                <>
                  <button type="button" onClick={() => void removeWorker(agent.id)} style={{ ...dangerButton({ height: 22, padding: "0 8px", fontSize: 9 }) }}>Confirm</button>
                  <button type="button" onClick={() => setConfirmRemoveId(null)} style={{ ...outlineButton({ height: 22, padding: "0 8px", fontSize: 9 }) }}>Cancel</button>
                </>
              ) : (
                <>
                  <button type="button" onClick={() => { setWorkerDraft(workerDraftFromAgent(agent)); setWorkerError(null); setEditorOpen(true); }}
                    style={{ ...outlineButton({ height: 22, padding: "0 8px", fontSize: 9 }) }}>Edit</button>
                  <button type="button" onClick={() => setConfirmRemoveId(agent.id)}
                    style={{ ...outlineButton({ height: 22, padding: "0 8px", fontSize: 9, color: `${COLORS.danger}99` }) }}>
                    <Trash size={9} />
                  </button>
                </>
              )}
            </div>
          </div>
          {renderWorkerTree(agent.id, depth + 1)}
        </div>
      );
    });
  };

  /* ── CTO Identity Editor ── */

  const [identityEditing, setIdentityEditing] = useState(false);
  const [identityDraft, setIdentityDraft] = useState({ name: "", persona: "", provider: "", model: "", reasoningEffort: "" });
  const [identitySaving, setIdentitySaving] = useState(false);
  const [identityError, setIdentityError] = useState<string | null>(null);

  useEffect(() => {
    if (!identityEditing && ctoIdentity) {
      setIdentityDraft({
        name: ctoIdentity.name, persona: ctoIdentity.persona,
        provider: ctoIdentity.modelPreferences.provider, model: ctoIdentity.modelPreferences.model,
        reasoningEffort: ctoIdentity.modelPreferences.reasoningEffort ?? "",
      });
    }
  }, [ctoIdentity, identityEditing]);

  const handleSaveIdentity = async () => {
    setIdentitySaving(true); setIdentityError(null);
    try { await handleSaveCtoIdentity(identityDraft); setIdentityEditing(false); }
    catch (err) { setIdentityError(err instanceof Error ? err.message : "Failed to update."); }
    finally { setIdentitySaving(false); }
  };

  /* ── Layout ── */

  return (
    <div style={{ height: "100%", width: "100%", overflow: "hidden", background: COLORS.pageBg, color: COLORS.textPrimary, fontFamily: MONO_FONT }}>
      <div style={{ display: "grid", gridTemplateColumns: "320px minmax(0,1fr)", height: "100%" }}>

        {/* ── SIDEBAR ── */}
        <aside style={{ display: "flex", flexDirection: "column", overflow: "hidden", borderRight: `1px solid ${COLORS.border}`, background: COLORS.cardBg }}>
          {/* Sidebar header */}
          <div style={{ padding: "14px 16px 10px", borderBottom: `1px solid ${COLORS.border}` }}>
            <div style={{ ...LABEL_STYLE, display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
              <Brain size={14} /> ORG CHART
            </div>

            {/* CTO card */}
            <div
              role="button" tabIndex={0}
              onClick={() => setSelectedAgentId(null)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelectedAgentId(null); } }}
              style={{
                background: !selectedAgentId ? `${COLORS.accent}12` : COLORS.recessedBg,
                borderLeft: !selectedAgentId ? `2px solid ${COLORS.accent}` : "2px solid transparent",
                padding: "10px 12px",
                cursor: "pointer",
                transition: "all 0.15s",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div>
                  <div style={{ fontSize: 14, fontFamily: SANS_FONT, fontWeight: 700, color: COLORS.textPrimary }}>CTO</div>
                  <div style={{ fontSize: 10, color: COLORS.textDim, marginTop: 2 }}>Persistent project lead</div>
                </div>
                {ctoIdentity && (
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontSize: 10, color: COLORS.textMuted }}>{ctoIdentity.modelPreferences.provider}</div>
                    <div style={{ fontSize: 10, color: COLORS.textDim }}>{ctoIdentity.modelPreferences.model}</div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Scrollable sidebar content */}
          <div style={{ flex: 1, overflowY: "auto", padding: "0 16px 16px" }}>

            {/* CTO Identity settings */}
            {ctoIdentity && (
              <div>
                <SectionToggle label="CTO Settings" open={identityEditing} onToggle={() => setIdentityEditing((v) => !v)}
                  action={!identityEditing ? <button type="button" onClick={(e) => { e.stopPropagation(); setIdentityEditing(true); }}
                    style={{ background: "none", border: "none", cursor: "pointer", color: COLORS.textMuted, padding: 0 }}><PencilSimple size={12} /></button> : undefined}
                />
                {identityEditing && (
                  <div style={{ ...cardStyle({ padding: 10 }), borderColor: `${COLORS.accent}40` }}>
                    <input style={inputStyle} placeholder="Name" value={identityDraft.name} onChange={(e) => setIdentityDraft((d) => ({ ...d, name: e.target.value }))} />
                    <textarea style={{ ...inputStyle, resize: "none" as const, marginTop: 6, minHeight: 50 }} placeholder="Persona" value={identityDraft.persona} onChange={(e) => setIdentityDraft((d) => ({ ...d, persona: e.target.value }))} />
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginTop: 6 }}>
                      <input style={inputStyle} placeholder="Provider" value={identityDraft.provider} onChange={(e) => setIdentityDraft((d) => ({ ...d, provider: e.target.value }))} />
                      <input style={inputStyle} placeholder="Model" value={identityDraft.model} onChange={(e) => setIdentityDraft((d) => ({ ...d, model: e.target.value }))} />
                    </div>
                    <input style={{ ...inputStyle, marginTop: 6 }} placeholder="Reasoning effort (high/medium/low)" value={identityDraft.reasoningEffort} onChange={(e) => setIdentityDraft((d) => ({ ...d, reasoningEffort: e.target.value }))} />
                    {identityError && <div style={{ fontSize: 11, color: COLORS.danger, marginTop: 6 }}>{identityError}</div>}
                    <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                      <button type="button" onClick={handleSaveIdentity} disabled={identitySaving} style={{ ...primaryButton({ flex: 1, height: 28, opacity: identitySaving ? 0.5 : 1 }) }}>{identitySaving ? "Saving\u2026" : "Save"}</button>
                      <button type="button" onClick={() => setIdentityEditing(false)} disabled={identitySaving} style={{ ...outlineButton({ flex: 1, height: 28 }) }}>Cancel</button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* CTO Core Memory */}
            {coreMemory && <CoreMemorySection coreMemory={coreMemory} onSave={handleSaveCoreMemory} />}

            {/* CTO Session History */}
            <SessionHistorySection sessions={sessionLogs} />

            {/* Workers section */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 20, marginBottom: 8 }}>
              <span style={LABEL_STYLE}>WORKERS</span>
              <button type="button" onClick={() => { setWorkerDraft(workerDraftFromAgent(null)); setWorkerError(null); setEditorOpen(true); }}
                style={{ ...outlineButton({ height: 24, padding: "0 8px", fontSize: 10 }) }} data-testid="worker-create-btn">
                <Plus size={10} weight="bold" /> Hire
              </button>
            </div>

            <div data-testid="worker-tree">
              {agents.filter((a) => a.reportsTo === null).length === 0 && !editorOpen ? (
                <div style={{ border: `1px dashed ${COLORS.border}`, padding: "20px 16px", textAlign: "center" }}>
                  <Robot size={20} style={{ margin: "0 auto 8px", display: "block", color: COLORS.textDim }} />
                  <div style={{ fontSize: 11, color: COLORS.textMuted }}>No workers yet.</div>
                  <button type="button" onClick={() => { setWorkerDraft(workerDraftFromAgent(null)); setWorkerError(null); setEditorOpen(true); }}
                    style={{ fontSize: 11, color: COLORS.accent, background: "none", border: "none", cursor: "pointer", marginTop: 6 }}>
                    Hire your first worker
                  </button>
                </div>
              ) : renderWorkerTree(null)}
            </div>

            {/* Worker editor */}
            {editorOpen && (
              <div ref={editorRef} style={{ ...cardStyle({ padding: 12 }), borderColor: `${COLORS.accent}40`, marginTop: 8 }}>
                <div style={{ ...LABEL_STYLE, marginBottom: 8 }}>{workerDraft.id ? "Edit Worker" : "Hire Worker"}</div>
                <input style={inputStyle} placeholder="Name" value={workerDraft.name} onChange={(e) => setWorkerDraft((d) => ({ ...d, name: e.target.value }))} />
                <input style={{ ...inputStyle, marginTop: 6 }} placeholder="Title (optional)" value={workerDraft.title} onChange={(e) => setWorkerDraft((d) => ({ ...d, title: e.target.value }))} />
                <div style={{ marginTop: 6 }}>
                  <div style={{ ...LABEL_STYLE, marginBottom: 3 }}>Role</div>
                  <select style={selectStyle} value={workerDraft.role} onChange={(e) => setWorkerDraft((d) => ({ ...d, role: e.target.value as AgentRole }))}>
                    <option value="engineer">Engineer</option><option value="qa">QA</option><option value="designer">Designer</option>
                    <option value="devops">DevOps</option><option value="researcher">Researcher</option><option value="general">General</option>
                  </select>
                </div>
                <div style={{ marginTop: 6 }}>
                  <div style={{ ...LABEL_STYLE, marginBottom: 3 }}>Reports to</div>
                  <select style={selectStyle} value={workerDraft.reportsTo} onChange={(e) => setWorkerDraft((d) => ({ ...d, reportsTo: e.target.value }))}>
                    <option value="">CTO (root)</option>
                    {agents.filter((a) => a.id !== workerDraft.id).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </div>
                <div style={{ marginTop: 6 }}>
                  <div style={{ ...LABEL_STYLE, marginBottom: 3 }}>Capabilities</div>
                  <input style={inputStyle} placeholder="api, db, react-native (comma-sep)" value={workerDraft.capabilities} onChange={(e) => setWorkerDraft((d) => ({ ...d, capabilities: e.target.value }))} />
                </div>
                <div style={{ marginTop: 6 }}>
                  <div style={{ ...LABEL_STYLE, marginBottom: 3 }}>Adapter</div>
                  <select style={selectStyle} value={workerDraft.adapterType} onChange={(e) => setWorkerDraft((d) => ({ ...d, adapterType: e.target.value as AdapterType }))}>
                    <option value="claude-local">claude-local</option><option value="codex-local">codex-local</option>
                    <option value="openclaw-webhook">openclaw-webhook</option><option value="process">process</option>
                  </select>
                </div>
                {(workerDraft.adapterType === "claude-local" || workerDraft.adapterType === "codex-local") && (
                  <input style={{ ...inputStyle, marginTop: 6 }} placeholder="Model (e.g. claude-sonnet-4-6)" value={workerDraft.model} onChange={(e) => setWorkerDraft((d) => ({ ...d, model: e.target.value }))} />
                )}
                {workerDraft.adapterType === "openclaw-webhook" && (
                  <>
                    <input style={{ ...inputStyle, marginTop: 6 }} placeholder="Webhook URL" value={workerDraft.webhookUrl} onChange={(e) => setWorkerDraft((d) => ({ ...d, webhookUrl: e.target.value }))} />
                    <input style={{ ...inputStyle, marginTop: 6 }} placeholder="Auth header (${env:TOKEN})" value={workerDraft.authHeader} onChange={(e) => setWorkerDraft((d) => ({ ...d, authHeader: e.target.value }))} />
                  </>
                )}
                {workerDraft.adapterType === "process" && (
                  <input style={{ ...inputStyle, marginTop: 6 }} placeholder="Process command" value={workerDraft.processCommand} onChange={(e) => setWorkerDraft((d) => ({ ...d, processCommand: e.target.value }))} />
                )}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginTop: 8 }}>
                  <div>
                    <div style={{ ...LABEL_STYLE, marginBottom: 3 }}>Budget $/mo</div>
                    <input style={inputStyle} type="number" min={0} step={1} placeholder="0 = no cap"
                      value={workerDraft.budgetDollars || ""} onChange={(e) => setWorkerDraft((d) => ({ ...d, budgetDollars: Number(e.target.value || 0) }))} />
                  </div>
                  <div>
                    <div style={{ ...LABEL_STYLE, marginBottom: 3 }}>Max concurrent</div>
                    <input style={inputStyle} type="number" min={1} max={10}
                      value={workerDraft.maxConcurrentRuns} onChange={(e) => setWorkerDraft((d) => ({ ...d, maxConcurrentRuns: Number(e.target.value || 1) }))} />
                  </div>
                </div>

                {/* Heartbeat config */}
                <div style={{ border: `1px solid ${COLORS.border}`, padding: 8, marginTop: 8 }}>
                  <div style={{ ...LABEL_STYLE, marginBottom: 6 }}>Heartbeat</div>
                  <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: COLORS.textSecondary, cursor: "pointer" }}>
                    <input type="checkbox" checked={workerDraft.heartbeatEnabled} onChange={(e) => setWorkerDraft((d) => ({ ...d, heartbeatEnabled: e.target.checked }))} />
                    Timer-based heartbeat
                  </label>
                  {workerDraft.heartbeatEnabled && (
                    <div style={{ marginTop: 6 }}>
                      <div style={{ fontSize: 10, color: COLORS.textDim, marginBottom: 2 }}>Interval (seconds)</div>
                      <input style={inputStyle} type="number" min={0} placeholder="300" value={workerDraft.heartbeatIntervalSec}
                        onChange={(e) => setWorkerDraft((d) => ({ ...d, heartbeatIntervalSec: Number(e.target.value || 0) }))} />
                    </div>
                  )}
                  <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: COLORS.textSecondary, cursor: "pointer", marginTop: 6 }}>
                    <input type="checkbox" checked={workerDraft.wakeOnDemand} onChange={(e) => setWorkerDraft((d) => ({ ...d, wakeOnDemand: e.target.checked }))} />
                    Wake on demand
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: COLORS.textSecondary, cursor: "pointer", marginTop: 6 }}>
                    <input type="checkbox" checked={workerDraft.activeHoursEnabled} onChange={(e) => setWorkerDraft((d) => ({ ...d, activeHoursEnabled: e.target.checked }))} />
                    Active hours
                  </label>
                  {workerDraft.activeHoursEnabled && (
                    <div style={{ marginTop: 4, paddingLeft: 20 }}>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
                        <div>
                          <div style={{ fontSize: 10, color: COLORS.textDim }}>Start</div>
                          <input type="time" style={inputStyle} value={workerDraft.activeHoursStart} onChange={(e) => setWorkerDraft((d) => ({ ...d, activeHoursStart: e.target.value }))} />
                        </div>
                        <div>
                          <div style={{ fontSize: 10, color: COLORS.textDim }}>End</div>
                          <input type="time" style={inputStyle} value={workerDraft.activeHoursEnd} onChange={(e) => setWorkerDraft((d) => ({ ...d, activeHoursEnd: e.target.value }))} />
                        </div>
                      </div>
                      <div style={{ marginTop: 4 }}>
                        <div style={{ fontSize: 10, color: COLORS.textDim }}>Timezone</div>
                        <input style={inputStyle} placeholder="local or America/New_York" value={workerDraft.activeHoursTimezone} onChange={(e) => setWorkerDraft((d) => ({ ...d, activeHoursTimezone: e.target.value }))} />
                      </div>
                    </div>
                  )}
                </div>

                {workerError && <div style={{ fontSize: 11, color: COLORS.danger, marginTop: 6 }}>{workerError}</div>}
                <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                  <button type="button" onClick={() => void saveWorker()} disabled={savingWorker}
                    style={{ ...primaryButton({ flex: 1, height: 28, opacity: savingWorker ? 0.5 : 1 }) }}>{savingWorker ? "Saving\u2026" : "Save"}</button>
                  <button type="button" onClick={() => setEditorOpen(false)} disabled={savingWorker}
                    style={{ ...outlineButton({ flex: 1, height: 28 }) }}>Cancel</button>
                </div>
              </div>
            )}

            {/* Budget summary */}
            <div style={{ ...cardStyle({ padding: 10 }), marginTop: 16 }}>
              <div style={LABEL_STYLE}>BUDGET</div>
              <div style={{ fontSize: 12, color: COLORS.textSecondary, marginTop: 6, fontFamily: MONO_FONT }} data-testid="budget-company-row">
                Company: {dollars(budgetSnapshot?.companySpentMonthlyCents ?? 0)}
                {(budgetSnapshot?.companyBudgetMonthlyCents ?? 0) > 0 ? ` / ${dollars(budgetSnapshot!.companyBudgetMonthlyCents)}/mo` : " (no cap)"}
              </div>
            </div>

            {/* Selected worker details panel */}
            {selectedWorker && (
              <div style={{ ...cardStyle({ padding: 10 }), marginTop: 12 }} data-testid="worker-ops-panel">
                <div style={{ ...LABEL_STYLE, marginBottom: 6 }}>{selectedWorker.name} \u2014 Runtime</div>
                {workerOpsError ? (
                  <div style={{ fontSize: 11, color: COLORS.danger }} data-testid="worker-ops-error">{workerOpsError}</div>
                ) : (
                  <>
                    {workerCoreMemory && (
                      <CoreMemorySection label="Worker Memory" testIdPrefix="worker-core-memory" coreMemory={workerCoreMemory} onSave={handleSaveWorkerCoreMemory} />
                    )}
                    <SessionHistorySection label="Worker Sessions" testId="worker-session-history-list" sessions={workerSessionLogs} />
                    <WorkerRunHistorySection runs={workerRuns} waking={wakingWorker} wakeStatus={workerWakeStatus} wakeError={workerWakeError} onWakeNow={() => void wakeSelectedWorker()} />
                  </>
                )}
              </div>
            )}

            {/* Revisions panel for selected worker */}
            {selectedWorker && (
              <div style={{ ...cardStyle({ padding: 10 }), marginTop: 12 }} data-testid="revision-panel">
                <div style={{ ...LABEL_STYLE, marginBottom: 6 }}>{selectedWorker.name} \u2014 Revisions</div>
                {revisions.length === 0 ? (
                  <div style={{ fontSize: 11, color: COLORS.textDim }}>No revisions yet.</div>
                ) : revisions.map((rev) => (
                  <div key={rev.id} style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.border}`, padding: "6px 8px", marginBottom: 3 }}>
                    <div style={{ fontSize: 10, color: COLORS.textDim }}>{formatDate(rev.createdAt)}</div>
                    <div style={{ fontSize: 11, color: COLORS.textSecondary, marginTop: 2 }}>
                      {rev.changedKeys.length > 0 ? rev.changedKeys.slice(0, 3).join(", ") : "Created"}
                    </div>
                    {rev.hadRedactions && <div style={{ fontSize: 10, color: COLORS.warning, marginTop: 2 }}>Redacted secrets \u2014 rollback blocked</div>}
                    {!rev.hadRedactions && (
                      <button type="button" onClick={() => void rollbackRevision(rev.id)}
                        style={{ ...outlineButton({ height: 22, padding: "0 8px", fontSize: 9, marginTop: 4 }) }} data-testid={`rollback-btn-${rev.id}`}>
                        <ArrowCounterClockwise size={9} /> Rollback
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </aside>

        {/* ── MAIN CHAT AREA ── */}
        <section style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
          <header style={{ borderBottom: `1px solid ${COLORS.border}`, padding: "12px 20px", background: COLORS.cardBg }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Brain size={16} style={{ color: COLORS.accent }} />
              <span style={{ fontSize: 14, fontFamily: SANS_FONT, fontWeight: 700 }}>
                {selectedWorker ? selectedWorker.name : "CTO"} Chat
              </span>
              {session && (
                <span style={{ ...inlineBadge(session.capabilityMode === "full_mcp" ? COLORS.success : COLORS.warning), marginLeft: 4 }} data-testid="cto-capability-badge">
                  {capabilityLabel(session.capabilityMode)}
                </span>
              )}
            </div>
            <div style={{ fontSize: 11, color: COLORS.textDim, marginTop: 4, fontFamily: MONO_FONT }}>
              {laneId
                ? (selectedWorker ? `Direct chat with ${selectedWorker.name}` : "Persistent CTO session is locked to this project context.")
                : "Create a lane to start CTO chat."}
            </div>
            {loading && <div style={{ fontSize: 11, color: COLORS.textMuted, marginTop: 4 }} data-testid="cto-loading">Connecting session\u2026</div>}
            {error && <div style={{ fontSize: 11, color: COLORS.danger, marginTop: 4 }} data-testid="cto-error">{error}</div>}
          </header>

          <div style={{ flex: 1, minHeight: 0 }}>
            <AgentChatPane laneId={laneId} lockSessionId={session?.id ?? null} />
          </div>
        </section>
      </div>
    </div>
  );
}
