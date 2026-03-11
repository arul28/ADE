import React, { useState } from "react";
import {
  X,
  Lightning,
  PencilSimple,
  Trash,
  ChatCircle,
} from "@phosphor-icons/react";
import type {
  AgentIdentity,
  AgentCoreMemory,
  AgentSessionLogEntry,
  AgentConfigRevision,
  WorkerAgentRun,
} from "../../../shared/types";
import { AgentStatusBadge } from "./shared/AgentStatusBadge";
import { TimelineEntry } from "./shared/TimelineEntry";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { PaneHeader } from "../ui/PaneHeader";
import { cn } from "../ui/cn";
import { cardCls, labelCls, textareaCls } from "./shared/designTokens";

type TabId = "overview" | "activity" | "memory" | "config";

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch { return iso; }
}

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function runStatusVariant(status: string): "info" | "success" | "warning" | "error" | "muted" {
  if (status === "running") return "info";
  if (status === "completed") return "success";
  if (status === "failed") return "error";
  if (status === "deferred") return "warning";
  return "muted";
}

export function WorkerDetailSlideOut({
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
  onEdit,
  onRemove,
  onChat,
  onRollbackRevision,
  onSaveCoreMemory,
  onClose,
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
  onEdit: () => void;
  onRemove: () => void;
  onChat: () => void;
  onRollbackRevision: (id: string) => void;
  onSaveCoreMemory: (patch: Record<string, unknown>) => Promise<void>;
  onClose: () => void;
}) {
  const [activeTab, setActiveTab] = useState<TabId>("overview");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [memoryEditing, setMemoryEditing] = useState(false);
  const [memoryDraft, setMemoryDraft] = useState("");

  const TABS: { id: TabId; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "activity", label: "Activity" },
    { id: "memory", label: "Memory" },
    { id: "config", label: "Config" },
  ];

  return (
    <div
      className="fixed top-0 right-0 bottom-0 z-40 flex flex-col border-l border-border/30 shadow-float overflow-hidden"
      style={{ width: 480, background: "var(--color-bg)" }}
    >
      {/* Header */}
      <div className="shrink-0 flex items-center justify-between px-4 py-3 border-b border-border/20">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex items-center justify-center w-8 h-8 bg-accent/10 border border-accent/20 shrink-0">
            <span className="font-mono text-[10px] font-bold text-accent">
              {worker.name.charAt(0).toUpperCase()}
            </span>
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-sans text-sm font-bold text-fg truncate">{worker.name}</span>
              <AgentStatusBadge status={worker.status} />
            </div>
            <div className="font-mono text-[9px] text-muted-fg/50 mt-0.5">
              {worker.role}{worker.title ? ` · ${worker.title}` : ""} · {worker.adapterType}
            </div>
          </div>
        </div>
        <button type="button" onClick={onClose} className="text-muted-fg/40 hover:text-fg transition-colors">
          <X size={16} />
        </button>
      </div>

      {/* Tab bar */}
      <div className="shrink-0 flex border-b border-border/20">
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            onClick={() => setActiveTab(id)}
            className={cn(
              "px-4 py-2 font-mono text-[10px] font-bold uppercase tracking-[1px] border-b-2 transition-all",
              activeTab === id
                ? "border-b-accent text-accent"
                : "border-b-transparent text-muted-fg hover:text-fg",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
        {/* Overview */}
        {activeTab === "overview" && (
          <>
            {/* Quick actions */}
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={onWakeNow} disabled={waking}>
                <Lightning size={10} weight="bold" />
                {waking ? "Waking..." : "Wake"}
              </Button>
              <Button variant="outline" size="sm" onClick={onChat}>
                <ChatCircle size={10} weight="bold" />
                Chat
              </Button>
              <Button variant="outline" size="sm" onClick={onEdit}>
                <PencilSimple size={10} />
                Edit
              </Button>
              {confirmRemove ? (
                <div className="flex gap-1">
                  <Button variant="danger" size="sm" onClick={() => { onRemove(); setConfirmRemove(false); }}>Confirm</Button>
                  <Button variant="ghost" size="sm" onClick={() => setConfirmRemove(false)}>Cancel</Button>
                </div>
              ) : (
                <Button variant="ghost" size="sm" onClick={() => setConfirmRemove(true)}>
                  <Trash size={10} />
                </Button>
              )}
            </div>

            {wakeStatus && <div className="text-[10px] text-success font-mono">{wakeStatus}</div>}
            {wakeError && <div className="text-[10px] text-error font-mono">{wakeError}</div>}
            {opsError && <div className="text-xs text-error">{opsError}</div>}

            {/* Capabilities */}
            {worker.capabilities.length > 0 && (
              <div>
                <div className={cn(labelCls, "mb-1")}>Capabilities</div>
                <div className="flex flex-wrap gap-1">
                  {worker.capabilities.map((cap) => (
                    <span key={cap} className="font-mono text-[9px] text-muted-fg/60 bg-surface-recessed border border-border/10 px-1.5 py-0.5">{cap}</span>
                  ))}
                </div>
              </div>
            )}

            {/* Budget */}
            <div className={cardCls}>
              <div className="p-3">
                <div className={cn(labelCls, "mb-1")}>Budget</div>
                <div className="flex items-center gap-3">
                  <span className="font-mono text-sm text-fg font-bold">{dollars(worker.spentMonthlyCents)}</span>
                  {worker.budgetMonthlyCents > 0 && (
                    <>
                      <span className="font-mono text-[10px] text-muted-fg/40">/ {dollars(worker.budgetMonthlyCents)}</span>
                      <div className="flex-1 h-1.5 bg-border/20 overflow-hidden">
                        <div
                          className={cn(
                            "h-full transition-all",
                            worker.spentMonthlyCents >= worker.budgetMonthlyCents ? "bg-error" : "bg-accent/60",
                          )}
                          style={{ width: `${Math.min(100, (worker.spentMonthlyCents / worker.budgetMonthlyCents) * 100)}%` }}
                        />
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* Last heartbeat */}
            {worker.lastHeartbeatAt && (
              <div className="font-mono text-[9px] text-muted-fg/40">
                Last heartbeat: {formatDate(worker.lastHeartbeatAt)}
              </div>
            )}
          </>
        )}

        {/* Activity */}
        {activeTab === "activity" && (
          <>
            <div className={cn(labelCls, "mb-1")}>Runs ({runs.length})</div>
            <div className="space-y-1">
              {runs.length === 0 ? (
                <div className="text-[10px] text-muted-fg/50 py-2">No runs yet.</div>
              ) : runs.map((run) => (
                <TimelineEntry
                  key={run.id}
                  timestamp={run.createdAt}
                  title={run.wakeupReason}
                  subtitle={[run.taskKey, run.issueKey, run.errorMessage].filter(Boolean).join(" · ")}
                  status={run.status}
                  statusVariant={runStatusVariant(run.status)}
                />
              ))}
            </div>
            <div className={cn(labelCls, "mb-1 mt-4")}>Sessions ({sessionLogs.length})</div>
            <div className="space-y-1">
              {sessionLogs.length === 0 ? (
                <div className="text-[10px] text-muted-fg/50 py-2">No sessions yet.</div>
              ) : sessionLogs.map((s) => (
                <TimelineEntry
                  key={s.id}
                  timestamp={s.createdAt}
                  title={s.summary}
                  status={s.capabilityMode}
                  statusVariant={s.capabilityMode === "full_mcp" ? "success" : "muted"}
                />
              ))}
            </div>
          </>
        )}

        {/* Memory */}
        {activeTab === "memory" && (
          <>
            {coreMemory ? (
              <div className={cardCls}>
                <PaneHeader
                  title="Core Memory"
                  right={
                    <Button variant="ghost" size="sm" className="!h-5 !px-1.5" onClick={() => {
                      setMemoryEditing(!memoryEditing);
                      if (!memoryEditing) setMemoryDraft(coreMemory.projectSummary);
                    }}>
                      <PencilSimple size={10} />
                    </Button>
                  }
                />
                <div className="p-3">
                  {memoryEditing ? (
                    <div className="space-y-2">
                      <textarea
                        className={cn(textareaCls, "min-h-[60px]")}
                        value={memoryDraft}
                        onChange={(e) => setMemoryDraft(e.target.value)}
                      />
                      <div className="flex gap-2">
                        <Button variant="primary" size="sm" onClick={async () => {
                          await onSaveCoreMemory({ projectSummary: memoryDraft });
                          setMemoryEditing(false);
                        }}>Save</Button>
                        <Button variant="ghost" size="sm" onClick={() => setMemoryEditing(false)}>Cancel</Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="font-mono text-[10px] text-muted-fg leading-relaxed">
                        {coreMemory.projectSummary || "No summary yet."}
                      </div>
                      {[
                        { items: coreMemory.criticalConventions, label: "Conventions" },
                        { items: coreMemory.activeFocus, label: "Focus" },
                        { items: coreMemory.userPreferences, label: "Prefs" },
                        { items: coreMemory.notes, label: "Notes" },
                      ].filter(({ items }) => items.length > 0).map(({ items, label }) => (
                        <div key={label} className="mt-1.5">
                          <span className="font-mono text-[9px] text-muted-fg/40">{label}: </span>
                          <span className="font-mono text-[9px] text-muted-fg/60">{items.join(", ")}</span>
                        </div>
                      ))}
                    </>
                  )}
                </div>
              </div>
            ) : (
              <div className="text-[10px] text-muted-fg/50 py-4">No memory data.</div>
            )}
          </>
        )}

        {/* Config */}
        {activeTab === "config" && (
          <>
            <div className={cn(labelCls, "mb-1")}>Config Revisions ({revisions.length})</div>
            <div className="space-y-1">
              {revisions.length === 0 ? (
                <div className="text-[10px] text-muted-fg/50 py-2">No revisions yet.</div>
              ) : revisions.map((rev) => (
                <div key={rev.id} className="bg-surface-recessed border border-border/10 px-2.5 py-2">
                  <div className="font-mono text-[9px] text-muted-fg/40">{formatDate(rev.createdAt)}</div>
                  <div className="font-mono text-[10px] text-muted-fg mt-0.5">
                    {rev.changedKeys.length > 0 ? rev.changedKeys.slice(0, 4).join(", ") : "Created"}
                  </div>
                  {rev.hadRedactions && <div className="text-[9px] text-warning mt-1">Redacted</div>}
                  {!rev.hadRedactions && (
                    <Button variant="ghost" size="sm" className="mt-1 !h-5 !px-1.5 !text-[8px]" onClick={() => onRollbackRevision(rev.id)}>
                      Rollback
                    </Button>
                  )}
                </div>
              ))}
            </div>

            {/* Adapter details */}
            <div className={cardCls}>
              <PaneHeader title="Adapter" />
              <div className="p-3 space-y-1">
                <div className="font-mono text-[10px]">
                  <span className="text-muted-fg/40">Type: </span>
                  <span className="text-fg">{worker.adapterType}</span>
                </div>
                <div className="font-mono text-[10px]">
                  <span className="text-muted-fg/40">Created: </span>
                  <span className="text-fg">{formatDate(worker.createdAt)}</span>
                </div>
                <div className="font-mono text-[10px]">
                  <span className="text-muted-fg/40">Updated: </span>
                  <span className="text-fg">{formatDate(worker.updatedAt)}</span>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
