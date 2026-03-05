import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Brain, CaretDown, CaretRight, PencilSimple, Robot } from "@phosphor-icons/react";
import type { AgentChatSession, CtoCoreMemory, CtoSessionLogEntry } from "../../../shared/types";
import { AgentChatPane } from "../chat/AgentChatPane";
import { useAppStore } from "../../state/appStore";
import { cn } from "../ui/cn";

function capabilityLabel(mode: AgentChatSession["capabilityMode"] | null | undefined): string {
  return mode === "full_mcp" ? "Full MCP" : "Fallback Tools";
}

function formatSessionDate(iso: string): string {
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

type CoreMemoryDraft = {
  projectSummary: string;
  criticalConventions: string;
  userPreferences: string;
  activeFocus: string;
  notes: string;
};

function draftFromMemory(m: CtoCoreMemory): CoreMemoryDraft {
  return {
    projectSummary: m.projectSummary,
    criticalConventions: m.criticalConventions.join(", "),
    userPreferences: m.userPreferences.join(", "),
    activeFocus: m.activeFocus.join(", "),
    notes: m.notes.join(", "),
  };
}

function splitTrimmed(val: string): string[] {
  return val
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function SectionToggle({
  label,
  open,
  onToggle,
  action,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  action?: React.ReactNode;
}) {
  return (
    <div className="mt-3 flex items-center justify-between">
      <button
        type="button"
        onClick={onToggle}
        className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.12em] text-muted-fg hover:text-fg transition-colors"
      >
        {open ? <CaretDown size={10} weight="bold" /> : <CaretRight size={10} weight="bold" />}
        {label}
      </button>
      {action}
    </div>
  );
}

const DRAFT_FIELDS = [
  { key: "projectSummary", label: "Summary", multiline: true },
  { key: "criticalConventions", label: "Conventions", multiline: false },
  { key: "userPreferences", label: "Preferences", multiline: false },
  { key: "activeFocus", label: "Focus", multiline: false },
  { key: "notes", label: "Notes", multiline: false },
] as const;

function CoreMemorySection({
  coreMemory,
  onSave,
}: {
  coreMemory: CtoCoreMemory;
  onSave: (patch: Partial<CtoCoreMemory>) => Promise<void>;
}) {
  const [open, setOpen] = useState(true);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<CoreMemoryDraft>(() => draftFromMemory(coreMemory));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!editing) setDraft(draftFromMemory(coreMemory));
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

  const handleCancel = () => {
    setDraft(draftFromMemory(coreMemory));
    setEditing(false);
    setSaveError(null);
  };

  const editAction = !editing ? (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        setOpen(true);
        setEditing(true);
      }}
      className="text-muted-fg hover:text-accent transition-colors"
      title="Edit core memory"
      data-testid="core-memory-edit-btn"
    >
      <PencilSimple size={12} />
    </button>
  ) : null;

  return (
    <div>
      <SectionToggle
        label="Core Memory"
        open={open}
        onToggle={() => setOpen((o) => !o)}
        action={editAction}
      />

      {open && (
        <div className="mt-1.5">
          {editing ? (
            <div className="space-y-2 rounded-md border border-accent/30 bg-card/40 p-2.5">
              {DRAFT_FIELDS.map(({ key, label, multiline }) => (
                <div key={key}>
                  <div className="mb-0.5 text-[10px] uppercase tracking-wide text-muted-fg">{label}</div>
                  {multiline ? (
                    <textarea
                      className="w-full resize-none rounded border border-border/40 bg-bg px-2 py-1 text-xs text-fg outline-none focus:border-accent/40"
                      rows={2}
                      value={draft[key]}
                      onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
                    />
                  ) : (
                    <input
                      type="text"
                      className="w-full rounded border border-border/40 bg-bg px-2 py-0.5 text-xs text-fg outline-none focus:border-accent/40"
                      placeholder="comma-separated"
                      value={draft[key]}
                      onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
                    />
                  )}
                </div>
              ))}

              {saveError && (
                <div className="text-xs text-danger-fg" data-testid="core-memory-save-error">
                  {saveError}
                </div>
              )}

              <div className="flex gap-2 pt-0.5">
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={saving}
                  className="flex-1 rounded border border-accent/40 bg-accent/10 px-2 py-0.5 text-[11px] text-accent hover:bg-accent/20 disabled:opacity-50"
                  data-testid="core-memory-save-btn"
                >
                  {saving ? "Saving…" : "Save"}
                </button>
                <button
                  type="button"
                  onClick={handleCancel}
                  disabled={saving}
                  className="flex-1 rounded border border-border/40 px-2 py-0.5 text-[11px] text-muted-fg hover:text-fg disabled:opacity-50"
                  data-testid="core-memory-cancel-btn"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-1" data-testid="core-memory-view">
              <div className="rounded-md bg-card/30 px-2.5 py-2 text-xs text-fg/80">
                {coreMemory.projectSummary}
              </div>
              {coreMemory.criticalConventions.length > 0 && (
                <div className="px-0.5">
                  <span className="text-[10px] text-muted-fg">Conventions: </span>
                  <span className="text-[10px] text-fg/70">{coreMemory.criticalConventions.join(", ")}</span>
                </div>
              )}
              {coreMemory.activeFocus.length > 0 && (
                <div className="px-0.5">
                  <span className="text-[10px] text-muted-fg">Focus: </span>
                  <span className="text-[10px] text-fg/70">{coreMemory.activeFocus.join(", ")}</span>
                </div>
              )}
              {coreMemory.userPreferences.length > 0 && (
                <div className="px-0.5">
                  <span className="text-[10px] text-muted-fg">Prefs: </span>
                  <span className="text-[10px] text-fg/70">{coreMemory.userPreferences.join(", ")}</span>
                </div>
              )}
              {coreMemory.notes.length > 0 && (
                <div className="px-0.5">
                  <span className="text-[10px] text-muted-fg">Notes: </span>
                  <span className="text-[10px] text-fg/70">{coreMemory.notes.join(", ")}</span>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SessionHistorySection({ sessions }: { sessions: CtoSessionLogEntry[] }) {
  const [open, setOpen] = useState(false);

  return (
    <div>
      <SectionToggle
        label="Recent Sessions"
        open={open}
        onToggle={() => setOpen((o) => !o)}
      />
      {open && (
        <div className="mt-1.5 space-y-1" data-testid="session-history-list">
          {sessions.length === 0 ? (
            <div className="px-0.5 text-[11px] text-muted-fg">No sessions recorded yet.</div>
          ) : (
            sessions.map((s) => (
              <div key={s.id} className="rounded-md bg-card/30 px-2.5 py-1.5">
                <div className="text-[10px] text-muted-fg">{formatSessionDate(s.createdAt)}</div>
                <div className="mt-0.5 line-clamp-2 text-xs text-fg/80">{s.summary}</div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export function CtoPage() {
  const lanes = useAppStore((s) => s.lanes);
  const selectedLaneId = useAppStore((s) => s.selectedLaneId);
  const [session, setSession] = useState<AgentChatSession | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [coreMemory, setCoreMemory] = useState<CtoCoreMemory | null>(null);
  const [sessionLogs, setSessionLogs] = useState<CtoSessionLogEntry[]>([]);

  const laneId = useMemo(() => {
    if (selectedLaneId && lanes.some((lane) => lane.id === selectedLaneId)) return selectedLaneId;
    return lanes[0]?.id ?? null;
  }, [lanes, selectedLaneId]);

  // Load CTO state (core memory + session history) once on mount.
  useEffect(() => {
    if (!window.ade?.cto) return;
    void window.ade.cto.getState({ recentLimit: 10 }).then((snapshot) => {
      setCoreMemory(snapshot.coreMemory);
      setSessionLogs(snapshot.recentSessions);
    });
    // Non-fatal if this fails — chat still works.
  }, []);

  // Establish / resume the CTO chat session when laneId changes.
  useEffect(() => {
    if (!laneId) {
      setSession(null);
      return;
    }
    if (!window.ade?.cto) {
      setError("CTO bridge is unavailable.");
      setSession(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void window.ade.cto.ensureSession({ laneId }).then((next) => {
      if (cancelled) return;
      setSession(next);
    }).catch((err) => {
      if (cancelled) return;
      setError(err instanceof Error ? err.message : String(err));
      setSession(null);
    }).finally(() => {
      if (cancelled) return;
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [laneId]);

  const handleSaveCoreMemory = useCallback(async (patch: Partial<CtoCoreMemory>) => {
    if (!window.ade?.cto) throw new Error("CTO bridge unavailable.");
    const snapshot = await window.ade.cto.updateCoreMemory({ patch });
    setCoreMemory(snapshot.coreMemory);
  }, []);

  return (
    <div className="h-full w-full overflow-hidden bg-bg text-fg">
      <div className="grid h-full grid-cols-[260px_minmax(0,1fr)]">
        <aside className="flex flex-col overflow-y-auto border-r border-border/60 bg-card/30 p-3">
          <div className="mb-3 flex items-center gap-2 text-xs uppercase tracking-[0.16em] text-muted-fg">
            <Brain size={15} />
            <span>Org Chart</span>
          </div>

          <div className="rounded-md border border-accent/60 bg-accent/10 px-3 py-2">
            <div className="text-sm font-medium">CTO</div>
            <div className="text-xs text-muted-fg">Persistent project lead</div>
          </div>

          {coreMemory && (
            <CoreMemorySection coreMemory={coreMemory} onSave={handleSaveCoreMemory} />
          )}

          <SessionHistorySection sessions={sessionLogs} />

          <div className="mb-2 mt-4 text-[11px] uppercase tracking-[0.12em] text-muted-fg">Workers</div>
          <div className="rounded-md border border-border/60 bg-card/40 px-3 py-2">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Robot size={14} />
              <span>Deferred To W2</span>
            </div>
            <div className="mt-1 text-xs text-muted-fg">
              Worker persistence/runtime and org editing ship in Phase 4 W2.
            </div>
          </div>
        </aside>

        <section className="flex min-h-0 flex-col">
          <header className="border-b border-border/60 px-4 py-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Brain size={16} />
              <span>CTO Chat</span>
              {session && (
                <span
                  className={cn(
                    "ml-1 rounded-full border px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide",
                    session.capabilityMode === "full_mcp"
                      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                      : "border-amber-500/40 bg-amber-500/10 text-amber-300"
                  )}
                  data-testid="cto-capability-badge"
                >
                  {capabilityLabel(session.capabilityMode)}
                </span>
              )}
            </div>
            <div className="mt-1 text-xs text-muted-fg">
              {laneId
                ? "Persistent CTO session is locked to this project context."
                : "Create a lane to start CTO chat."}
            </div>
            {loading && (
              <div className="mt-1 text-xs text-muted-fg" data-testid="cto-loading">
                Connecting CTO session…
              </div>
            )}
            {error && (
              <div className="mt-1 text-xs text-danger-fg" data-testid="cto-error">
                {error}
              </div>
            )}
          </header>

          <div className="min-h-0 flex-1">
            <AgentChatPane laneId={laneId} lockSessionId={session?.id ?? null} />
          </div>
        </section>
      </div>
    </div>
  );
}
