import React, { useState } from "react";
import {
  PencilSimple,
  Trash,
  ArrowCounterClockwise,
  Lightning,
} from "@phosphor-icons/react";
import type {
  AgentIdentity,
  AgentRole,
  AgentStatus,
  AdapterType,
  AgentConfigRevision,
  AgentCoreMemory,
  AgentSessionLogEntry,
  HeartbeatPolicy,
  WorkerAgentRun,
} from "../../../shared/types";
import { Button } from "../ui/Button";
import { PaneHeader } from "../ui/PaneHeader";
import { cn } from "../ui/cn";
import { AgentStatusBadge } from "./shared/AgentStatusBadge";
import { WorkerActivityFeed } from "./WorkerActivityFeed";

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

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/* ── Worker Editor Draft ── */

export type WorkerEditorDraft = {
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

export function workerDraftFromAgent(agent?: AgentIdentity | null): WorkerEditorDraft {
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
    authHeader:
      typeof (adapterConfig.headers as Record<string, unknown> | undefined)?.Authorization === "string"
        ? String((adapterConfig.headers as Record<string, unknown>).Authorization)
        : "",
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

const inputCls =
  "h-8 w-full border border-border/15 bg-surface-recessed px-3 text-xs font-mono text-fg placeholder:text-muted-fg/50 focus:border-accent/40 focus:outline-none transition-colors";
const selectCls = `${inputCls} appearance-none`;
const labelCls = "text-[10px] font-mono font-bold uppercase tracking-[1px] text-muted-fg/60";

/* ── Worker Editor ── */

export function WorkerEditorPanel({
  draft,
  setDraft,
  agents,
  saving,
  error,
  onSave,
  onCancel,
}: {
  draft: WorkerEditorDraft;
  setDraft: React.Dispatch<React.SetStateAction<WorkerEditorDraft>>;
  agents: AgentIdentity[];
  saving: boolean;
  error: string | null;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="border border-accent/20 bg-card/80 p-4 space-y-3 backdrop-blur-sm shadow-card">
      <div className="font-sans text-sm font-bold text-fg">
        {draft.id ? "Edit Worker" : "Hire Worker"}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <label className="space-y-1 col-span-2 sm:col-span-1">
          <div className={labelCls}>Name</div>
          <input className={inputCls} placeholder="Backend Dev" value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />
        </label>
        <label className="space-y-1 col-span-2 sm:col-span-1">
          <div className={labelCls}>Title</div>
          <input className={inputCls} placeholder="Optional title" value={draft.title} onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))} />
        </label>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <label className="space-y-1">
          <div className={labelCls}>Role</div>
          <select className={selectCls} value={draft.role} onChange={(e) => setDraft((d) => ({ ...d, role: e.target.value as AgentRole }))}>
            <option value="engineer">Engineer</option>
            <option value="qa">QA</option>
            <option value="designer">Designer</option>
            <option value="devops">DevOps</option>
            <option value="researcher">Researcher</option>
            <option value="general">General</option>
          </select>
        </label>
        <label className="space-y-1">
          <div className={labelCls}>Reports to</div>
          <select className={selectCls} value={draft.reportsTo} onChange={(e) => setDraft((d) => ({ ...d, reportsTo: e.target.value }))}>
            <option value="">CTO (root)</option>
            {agents.filter((a) => a.id !== draft.id).map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </label>
      </div>

      <label className="space-y-1 block">
        <div className={labelCls}>Capabilities</div>
        <input className={inputCls} placeholder="api, db, react-native (comma-separated)" value={draft.capabilities} onChange={(e) => setDraft((d) => ({ ...d, capabilities: e.target.value }))} />
      </label>

      <div className="grid grid-cols-2 gap-3">
        <label className="space-y-1">
          <div className={labelCls}>Adapter</div>
          <select className={selectCls} value={draft.adapterType} onChange={(e) => setDraft((d) => ({ ...d, adapterType: e.target.value as AdapterType }))}>
            <option value="claude-local">claude-local</option>
            <option value="codex-local">codex-local</option>
            <option value="openclaw-webhook">openclaw-webhook</option>
            <option value="process">process</option>
          </select>
        </label>
        {(draft.adapterType === "claude-local" || draft.adapterType === "codex-local") && (
          <label className="space-y-1">
            <div className={labelCls}>Model</div>
            <input className={inputCls} placeholder="claude-sonnet-4-6" value={draft.model} onChange={(e) => setDraft((d) => ({ ...d, model: e.target.value }))} />
          </label>
        )}
        {draft.adapterType === "openclaw-webhook" && (
          <>
            <label className="space-y-1">
              <div className={labelCls}>Webhook URL</div>
              <input className={inputCls} value={draft.webhookUrl} onChange={(e) => setDraft((d) => ({ ...d, webhookUrl: e.target.value }))} />
            </label>
            <label className="space-y-1 col-span-2">
              <div className={labelCls}>Auth header</div>
              <input className={inputCls} placeholder="${env:TOKEN}" value={draft.authHeader} onChange={(e) => setDraft((d) => ({ ...d, authHeader: e.target.value }))} />
            </label>
          </>
        )}
        {draft.adapterType === "process" && (
          <label className="space-y-1">
            <div className={labelCls}>Command</div>
            <input className={inputCls} value={draft.processCommand} onChange={(e) => setDraft((d) => ({ ...d, processCommand: e.target.value }))} />
          </label>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <label className="space-y-1">
          <div className={labelCls}>Budget $/mo</div>
          <input className={inputCls} type="number" min={0} step={1} placeholder="0 = no cap" value={draft.budgetDollars || ""} onChange={(e) => setDraft((d) => ({ ...d, budgetDollars: Number(e.target.value || 0) }))} />
        </label>
        <label className="space-y-1">
          <div className={labelCls}>Max concurrent</div>
          <input className={inputCls} type="number" min={1} max={10} value={draft.maxConcurrentRuns} onChange={(e) => setDraft((d) => ({ ...d, maxConcurrentRuns: Number(e.target.value || 1) }))} />
        </label>
      </div>

      {/* Heartbeat */}
      <div className="border border-border/10 bg-card/60 p-3 space-y-2">
        <div className={labelCls}>Heartbeat</div>
        <label className="flex items-center gap-2 text-xs text-muted-fg cursor-pointer">
          <input type="checkbox" checked={draft.heartbeatEnabled} onChange={(e) => setDraft((d) => ({ ...d, heartbeatEnabled: e.target.checked }))} />
          Timer-based heartbeat
        </label>
        {draft.heartbeatEnabled && (
          <label className="space-y-1 block pl-5">
            <div className="text-[9px] text-muted-fg/50">Interval (seconds)</div>
            <input className={inputCls} type="number" min={0} placeholder="300" value={draft.heartbeatIntervalSec} onChange={(e) => setDraft((d) => ({ ...d, heartbeatIntervalSec: Number(e.target.value || 0) }))} />
          </label>
        )}
        <label className="flex items-center gap-2 text-xs text-muted-fg cursor-pointer">
          <input type="checkbox" checked={draft.wakeOnDemand} onChange={(e) => setDraft((d) => ({ ...d, wakeOnDemand: e.target.checked }))} />
          Wake on demand
        </label>
        <label className="flex items-center gap-2 text-xs text-muted-fg cursor-pointer">
          <input type="checkbox" checked={draft.activeHoursEnabled} onChange={(e) => setDraft((d) => ({ ...d, activeHoursEnabled: e.target.checked }))} />
          Active hours
        </label>
        {draft.activeHoursEnabled && (
          <div className="grid grid-cols-3 gap-2 pl-5">
            <label className="space-y-1">
              <div className="text-[9px] text-muted-fg/50">Start</div>
              <input type="time" className={inputCls} value={draft.activeHoursStart} onChange={(e) => setDraft((d) => ({ ...d, activeHoursStart: e.target.value }))} />
            </label>
            <label className="space-y-1">
              <div className="text-[9px] text-muted-fg/50">End</div>
              <input type="time" className={inputCls} value={draft.activeHoursEnd} onChange={(e) => setDraft((d) => ({ ...d, activeHoursEnd: e.target.value }))} />
            </label>
            <label className="space-y-1">
              <div className="text-[9px] text-muted-fg/50">TZ</div>
              <input className={inputCls} placeholder="local" value={draft.activeHoursTimezone} onChange={(e) => setDraft((d) => ({ ...d, activeHoursTimezone: e.target.value }))} />
            </label>
          </div>
        )}
      </div>

      {error && <div className="text-xs text-error">{error}</div>}

      <div className="flex gap-2 pt-1">
        <Button variant="primary" className="flex-1" disabled={saving} onClick={onSave}>
          {saving ? "Saving..." : "Save"}
        </Button>
        <Button variant="outline" className="flex-1" disabled={saving} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/* ── Worker Detail ── */

export function WorkerDetailPanel({
  worker,
  coreMemory,
  sessionLogs,
  runs,
  revisions,
  opsError,
  wakeStatus,
  wakeError,
  waking,
  onWakeNow,
  onSetStatus,
  onEdit,
  onRemove,
  onRollbackRevision,
  onSaveCoreMemory,
}: {
  worker: AgentIdentity;
  coreMemory: AgentCoreMemory | null;
  sessionLogs: AgentSessionLogEntry[];
  runs: WorkerAgentRun[];
  revisions: AgentConfigRevision[];
  opsError: string | null;
  wakeStatus: string | null;
  wakeError: string | null;
  waking: boolean;
  onWakeNow: () => void;
  onSetStatus: (status: AgentStatus) => void;
  onEdit: () => void;
  onRemove: () => void;
  onRollbackRevision: (id: string) => void;
  onSaveCoreMemory: (patch: Record<string, unknown>) => Promise<void>;
}) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [memoryEditing, setMemoryEditing] = useState(false);

  return (
    <div className="flex flex-col h-full min-h-0 overflow-y-auto p-4 gap-4">
      {/* Worker header */}
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-sans text-sm font-bold text-fg truncate">{worker.name}</span>
            <AgentStatusBadge status={worker.status} />
          </div>
          <div className="font-mono text-[10px] text-muted-fg mt-0.5">
            {worker.role} · {worker.adapterType}
            {worker.title ? ` · ${worker.title}` : ""}
          </div>
          {worker.capabilities.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-2">
              {worker.capabilities.map((cap) => (
                <span key={cap} className="font-mono text-[9px] text-muted-fg/60 bg-surface-recessed border border-border/10 px-1.5 py-0.5">{cap}</span>
              ))}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <Button variant="outline" size="sm" onClick={onWakeNow} disabled={waking} data-testid="worker-wake-now-btn">
            <Lightning size={10} weight="bold" />
            {waking ? "Waking..." : "Wake"}
          </Button>
          {worker.status === "paused" ? (
            <Button variant="outline" size="sm" onClick={() => onSetStatus("idle")} data-testid="worker-resume-btn">
              Resume
            </Button>
          ) : (
            <Button variant="outline" size="sm" onClick={() => onSetStatus("paused")} data-testid="worker-pause-btn">
              Pause
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={onEdit}>Edit</Button>
          {confirmRemove ? (
            <div className="flex gap-1">
              <Button variant="danger" size="sm" onClick={() => { onRemove(); setConfirmRemove(false); }}>Confirm</Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirmRemove(false)}>No</Button>
            </div>
          ) : (
            <Button variant="ghost" size="sm" onClick={() => setConfirmRemove(true)}>
              <Trash size={10} />
            </Button>
          )}
        </div>
      </div>

      {wakeStatus && <div className="text-[10px] text-success font-mono" data-testid="worker-wake-status">{wakeStatus}</div>}
      {wakeError && <div className="text-[10px] text-error font-mono" data-testid="worker-wake-error">{wakeError}</div>}
      {opsError && <div className="text-xs text-error" data-testid="worker-ops-error">{opsError}</div>}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Activity */}
        <div className="border border-border/10 bg-card/60 backdrop-blur-sm shadow-card" data-testid="worker-run-history-list">
          <PaneHeader title="Worker Activity" meta={`${runs.length + sessionLogs.length}`} />
          <div className="p-3 max-h-60 overflow-y-auto">
            <WorkerActivityFeed runs={runs} sessions={sessionLogs} />
          </div>
        </div>

        {/* Core memory */}
        {coreMemory && (
          <div className="border border-border/10 bg-card/60 backdrop-blur-sm shadow-card" data-testid="worker-ops-panel">
            <PaneHeader
              title="Worker Memory"
              right={
                <Button variant="ghost" size="sm" className="!h-5 !px-1.5" onClick={() => setMemoryEditing(!memoryEditing)} data-testid="worker-core-memory-edit-btn">
                  <PencilSimple size={10} />
                </Button>
              }
            />
            <div className="p-3">
              <div className="font-mono text-[10px] text-muted-fg leading-relaxed" data-testid="worker-core-memory-view">
                {coreMemory.projectSummary || "No summary yet."}
              </div>
              {[
                { items: coreMemory.criticalConventions, label: "Conventions" },
                { items: coreMemory.activeFocus, label: "Focus" },
                { items: coreMemory.userPreferences, label: "Prefs" },
                { items: coreMemory.notes, label: "Notes" },
              ].filter(({ items }) => items.length > 0).map(({ items, label }) => (
                <div key={label} className="mt-1">
                  <span className="font-mono text-[9px] text-muted-fg/40">{label}: </span>
                  <span className="font-mono text-[9px] text-muted-fg/60">{items.join(", ")}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Revisions */}
        <div className="border border-border/10 bg-card/60 backdrop-blur-sm shadow-card" data-testid="revision-panel">
          <PaneHeader title="Config Revisions" meta={`${revisions.length}`} />
          <div className="p-3 max-h-48 overflow-y-auto space-y-1.5">
            {revisions.length === 0 ? (
              <div className="text-[10px] text-muted-fg/50 py-2">No revisions yet.</div>
            ) : revisions.map((rev) => (
              <div key={rev.id} className="bg-surface-recessed border border-border/10 px-2.5 py-2">
                <div className="font-mono text-[9px] text-muted-fg/40">{formatDate(rev.createdAt)}</div>
                <div className="font-mono text-[10px] text-muted-fg mt-0.5">
                  {rev.changedKeys.length > 0 ? rev.changedKeys.slice(0, 3).join(", ") : "Created"}
                </div>
                {rev.hadRedactions && <div className="text-[9px] text-warning mt-1">Redacted — rollback blocked</div>}
                {!rev.hadRedactions && (
                  <Button variant="ghost" size="sm" className="mt-1 !h-5 !px-1.5 !text-[8px]" onClick={() => onRollbackRevision(rev.id)} data-testid={`rollback-btn-${rev.id}`}>
                    <ArrowCounterClockwise size={8} /> Rollback
                  </Button>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
