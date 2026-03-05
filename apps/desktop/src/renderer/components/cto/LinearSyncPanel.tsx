import React, { useCallback, useEffect, useState } from "react";
import {
  ArrowCounterClockwise,
  ArrowClockwise,
  Lightning,
  Plugs,
  Funnel,
  GitBranch,
  Play,
  ShieldCheck,
  Package,
} from "@phosphor-icons/react";
import type {
  CtoFlowPolicyRevision,
  LinearConnectionStatus,
  LinearRouteDecision,
  LinearSyncConfig,
  LinearSyncDashboard,
  LinearSyncQueueItem,
} from "../../../shared/types";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { PaneHeader } from "../ui/PaneHeader";
import { cn } from "../ui/cn";

/* ── Helpers ── */

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch { return iso; }
}

function parseMappingLines(input: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of input.split("\n")) {
    const line = raw.trim();
    if (!line.length) continue;
    const [left, ...right] = line.split("=");
    const key = (left ?? "").trim().toLowerCase();
    const value = right.join("=").trim();
    if (!key.length || !value.length) continue;
    out[key] = value;
  }
  return out;
}

function toMappingLines(input: Record<string, string> | null | undefined): string {
  if (!input) return "";
  return Object.entries(input).sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => `${k}=${v}`).join("\n");
}

export function linearDefaultPolicy(): LinearSyncConfig {
  return {
    enabled: false,
    pollingIntervalSec: 300,
    projects: [],
    routing: { byLabel: {} },
    assignment: { setAssigneeOnDispatch: false },
    autoDispatch: { default: "escalate", rules: [] },
    concurrency: { global: 5, byState: { todo: 3, in_progress: 5 } },
    reconciliation: { enabled: true, stalledTimeoutSec: 300 },
    classification: { mode: "hybrid", confidenceThreshold: 0.7 },
    artifacts: { mode: "links" },
  };
}

/* ── Shared styles ── */

const inputCls =
  "h-8 w-full border border-border/15 bg-surface-recessed px-3 text-xs font-mono text-fg placeholder:text-muted-fg/50 focus:border-accent/40 focus:outline-none transition-colors";
const selectCls = `${inputCls} appearance-none`;
const labelCls = "text-[10px] font-mono font-bold uppercase tracking-[1px] text-muted-fg/60";
const textareaCls =
  "w-full border border-border/15 bg-surface-recessed p-3 text-xs font-mono text-fg placeholder:text-muted-fg/50 focus:border-accent/40 focus:outline-none resize-vertical transition-colors";

/* ── Step nav icons ── */

type StepId = "connection" | "intake" | "routing" | "execution" | "escalation" | "closeout";

const STEPS: { id: StepId; label: string; icon: React.ElementType }[] = [
  { id: "connection", label: "Connection", icon: Plugs },
  { id: "intake", label: "Intake", icon: Funnel },
  { id: "routing", label: "Routing", icon: GitBranch },
  { id: "execution", label: "Execution", icon: Play },
  { id: "escalation", label: "Escalation", icon: ShieldCheck },
  { id: "closeout", label: "Closeout", icon: Package },
];

/* ── Main Panel ── */

export function LinearSyncPanel() {
  const [connection, setConnection] = useState<LinearConnectionStatus | null>(null);
  const [dashboard, setDashboard] = useState<LinearSyncDashboard | null>(null);
  const [policy, setPolicy] = useState<LinearSyncConfig>(linearDefaultPolicy());
  const [queue, setQueue] = useState<LinearSyncQueueItem[]>([]);
  const [revisions, setRevisions] = useState<CtoFlowPolicyRevision[]>([]);
  const [tokenInput, setTokenInput] = useState("");
  const [routeMapText, setRouteMapText] = useState("");
  const [rulesText, setRulesText] = useState("[]");
  const [projectText, setProjectText] = useState("");
  const [simulationInput, setSimulationInput] = useState(
    JSON.stringify({ identifier: "SIM-42", title: "Fix flaky auth test on CI", description: "Auth integration test intermittently fails.", labels: ["bug", "backend"], priorityLabel: "high", projectSlug: "my-project" }, null, 2),
  );
  const [simulationResult, setSimulationResult] = useState<LinearRouteDecision | null>(null);
  const [step, setStep] = useState<StepId>("connection");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusNote, setStatusNote] = useState<string | null>(null);

  const hydrateEditor = useCallback((p: LinearSyncConfig) => {
    setPolicy(p);
    setRouteMapText(toMappingLines(p.routing?.byLabel ?? {}));
    setRulesText(JSON.stringify(p.autoDispatch?.rules ?? [], null, 2));
    const projects = (p.projects ?? []).map((e) => e.slug).filter(Boolean);
    setProjectText(projects.join(", "));
  }, []);

  const loadAll = useCallback(async () => {
    if (!window.ade?.cto) return;
    setLoading(true); setError(null);
    try {
      const [conn, pol, dash, q, revs] = await Promise.all([
        window.ade.cto.getLinearConnectionStatus(),
        window.ade.cto.getFlowPolicy(),
        window.ade.cto.getLinearSyncDashboard(),
        window.ade.cto.listLinearSyncQueue(),
        window.ade.cto.listFlowPolicyRevisions(),
      ]);
      setConnection(conn); setDashboard(dash); setQueue(q); setRevisions(revs);
      hydrateEditor(pol);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load.");
    } finally { setLoading(false); }
  }, [hydrateEditor]);

  useEffect(() => { void loadAll(); }, [loadAll]);

  const buildPolicyFromEditor = useCallback((): LinearSyncConfig => {
    const projects = projectText.split(",").map((e) => e.trim()).filter(Boolean).map((slug) => ({ slug }));
    type Rules = NonNullable<NonNullable<LinearSyncConfig["autoDispatch"]>["rules"]>;
    let parsedRules: Rules = [];
    try { const p = JSON.parse(rulesText); if (Array.isArray(p)) parsedRules = p as Rules; } catch { parsedRules = policy.autoDispatch?.rules ?? []; }
    return { ...policy, projects, routing: { ...(policy.routing ?? {}), byLabel: parseMappingLines(routeMapText) }, autoDispatch: { ...(policy.autoDispatch ?? {}), rules: parsedRules ?? [] } };
  }, [policy, projectText, routeMapText, rulesText]);

  const savePolicy = useCallback(async () => {
    if (!window.ade?.cto) return;
    setSaving(true); setError(null); setStatusNote(null);
    try {
      const saved = await window.ade.cto.saveFlowPolicy({ policy: buildPolicyFromEditor(), actor: "user" });
      hydrateEditor(saved);
      const [dash, revs] = await Promise.all([window.ade.cto.getLinearSyncDashboard(), window.ade.cto.listFlowPolicyRevisions()]);
      setDashboard(dash); setRevisions(revs);
      setStatusNote("Flow policy saved.");
    } catch (err) { setError(err instanceof Error ? err.message : "Save failed."); } finally { setSaving(false); }
  }, [buildPolicyFromEditor, hydrateEditor]);

  const runSyncNow = useCallback(async () => {
    if (!window.ade?.cto) return;
    setStatusNote(null); setError(null);
    try {
      const [dash, q] = await Promise.all([window.ade.cto.runLinearSyncNow(), window.ade.cto.listLinearSyncQueue()]);
      setDashboard(dash); setQueue(q); setStatusNote("Sync cycle executed.");
    } catch (err) { setError(err instanceof Error ? err.message : "Sync failed."); }
  }, []);

  const setLinearToken = useCallback(async () => {
    if (!window.ade?.cto || !tokenInput.trim()) return;
    setError(null); setStatusNote(null);
    try {
      const s = await window.ade.cto.setLinearToken({ token: tokenInput.trim() });
      setConnection(s); setTokenInput(""); setStatusNote(s.connected ? "Token saved and verified." : "Token saved.");
    } catch (err) { setError(err instanceof Error ? err.message : "Failed."); }
  }, [tokenInput]);

  const clearToken = useCallback(async () => {
    if (!window.ade?.cto) return;
    setError(null); setStatusNote(null);
    try { const s = await window.ade.cto.clearLinearToken(); setConnection(s); setStatusNote("Token cleared."); } catch (err) { setError(err instanceof Error ? err.message : "Failed."); }
  }, []);

  const simulateRoute = useCallback(async () => {
    if (!window.ade?.cto) return;
    setError(null); setStatusNote(null);
    try { const parsed = JSON.parse(simulationInput); const r = await window.ade.cto.simulateFlowRoute({ issue: parsed }); setSimulationResult(r); setStatusNote("Simulation complete."); } catch (err) { setSimulationResult(null); setError(err instanceof Error ? err.message : "Simulation failed."); }
  }, [simulationInput]);

  const rollbackPolicy = useCallback(async (revId: string) => {
    if (!window.ade?.cto) return;
    setError(null); setStatusNote(null);
    try {
      const saved = await window.ade.cto.rollbackFlowPolicyRevision({ revisionId: revId, actor: "user" });
      hydrateEditor(saved);
      const [dash, revs] = await Promise.all([window.ade.cto.getLinearSyncDashboard(), window.ade.cto.listFlowPolicyRevisions()]);
      setDashboard(dash); setRevisions(revs); setStatusNote("Rolled back.");
    } catch (err) { setError(err instanceof Error ? err.message : "Rollback failed."); }
  }, [hydrateEditor]);

  const resolveQueueItem = useCallback(async (queueItemId: string, action: "approve" | "reject" | "retry") => {
    if (!window.ade?.cto) return;
    setError(null); setStatusNote(null);
    try {
      await window.ade.cto.resolveLinearSyncQueueItem({ queueItemId, action });
      const [q, dash] = await Promise.all([window.ade.cto.listLinearSyncQueue(), window.ade.cto.getLinearSyncDashboard()]);
      setQueue(q); setDashboard(dash); setStatusNote(`Item ${action}d.`);
    } catch (err) { setError(err instanceof Error ? err.message : "Failed."); }
  }, []);

  const pendingQueue = queue.filter((item) => item.status === "escalated" || item.status === "retry_wait" || item.status === "queued");

  return (
    <div className="flex flex-col h-full min-h-0" data-testid="linear-sync-panel">
      {/* Top status bar */}
      <div className="shrink-0 flex items-center justify-between gap-3 px-4 py-3 border-b border-border/40" style={{ background: "var(--color-surface)" }}>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-sans text-sm font-bold text-fg">Linear Sync</span>
            {connection && (
              <Chip className={cn("text-[9px]", connection.connected ? "text-success" : "text-warning")}>
                {connection.connected ? "Connected" : "Disconnected"}
              </Chip>
            )}
          </div>
          <div className="font-mono text-[10px] text-muted-fg mt-0.5">
            {dashboard
              ? `enabled=${dashboard.enabled ? "yes" : "no"} · running=${dashboard.running ? "yes" : "no"} · queue=${dashboard.queue.queued + dashboard.queue.escalated + dashboard.queue.retryWaiting}`
              : "Loading..."}
            {connection?.connected && connection.viewerName && ` · ${connection.viewerName}`}
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <Button variant="outline" size="sm" onClick={() => void runSyncNow()} disabled={loading} data-testid="linear-run-now-btn">
            <Lightning size={10} weight="bold" /> Sync now
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void loadAll()}>
            <ArrowClockwise size={10} />
          </Button>
        </div>
      </div>

      {/* Feedback */}
      {(statusNote || error) && (
        <div className="px-4 py-1.5 border-b border-border/20">
          {statusNote && <div className="font-mono text-[10px] text-success">{statusNote}</div>}
          {error && <div className="font-mono text-[10px] text-error">{error}</div>}
        </div>
      )}

      <div className="flex flex-1 min-h-0">
        {/* Step navigation */}
        <nav className="shrink-0 w-40 border-r border-border/20 py-2" style={{ background: "var(--color-surface-recessed)" }}>
          {STEPS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setStep(id)}
              className={cn(
                "w-full flex items-center gap-2 px-3 py-2 text-left transition-all duration-100",
                "border-l-2",
                step === id
                  ? "border-l-accent bg-accent/8 text-accent"
                  : "border-l-transparent text-muted-fg hover:text-fg hover:bg-muted/30",
              )}
            >
              <Icon size={12} weight={step === id ? "bold" : "regular"} />
              <span className="font-mono text-[10px] font-semibold">{label}</span>
            </button>
          ))}

          <div className="mx-3 my-2 border-t border-border/20" />

          <button
            type="button"
            onClick={() => setStep("connection")}
            className="w-full text-left px-3 py-1.5"
          >
            <span className="font-mono text-[9px] text-muted-fg/40 uppercase">Queue ({pendingQueue.length})</span>
          </button>
          <button
            type="button"
            onClick={() => setStep("connection")}
            className="w-full text-left px-3 py-1.5"
          >
            <span className="font-mono text-[9px] text-muted-fg/40 uppercase">History ({revisions.length})</span>
          </button>
        </nav>

        {/* Step content */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">

          {step === "connection" && (
            <>
              <div className="border border-border/10 bg-card/60 backdrop-blur-sm shadow-card p-4 space-y-3">
                <div className="font-sans text-xs font-bold text-fg">API Token</div>
                <label className="flex items-center gap-2 text-xs text-muted-fg cursor-pointer">
                  <input type="checkbox" checked={policy.enabled === true} onChange={(e) => setPolicy((p) => ({ ...p, enabled: e.target.checked }))} />
                  Enable Linear sync
                </label>
                <input className={inputCls} type="password" placeholder="lin_api_..." value={tokenInput} onChange={(e) => setTokenInput(e.target.value)} />
                <div className="flex gap-2">
                  <Button variant="primary" size="sm" onClick={() => void setLinearToken()}>Save token</Button>
                  <Button variant="outline" size="sm" onClick={() => void clearToken()}>Clear token</Button>
                </div>
              </div>

              {/* Queue */}
              <div className="border border-border/10 bg-card/60 backdrop-blur-sm shadow-card">
                <PaneHeader title="Escalation Queue" meta={`${pendingQueue.length}`} />
                <div className="p-3 space-y-1.5" data-testid="linear-queue-list">
                  {pendingQueue.length === 0 ? (
                    <div className="text-[10px] text-muted-fg/50 py-2">No pending items.</div>
                  ) : pendingQueue.slice(0, 8).map((item) => (
                    <div key={item.id} className="bg-surface-recessed border border-border/10 px-3 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-[10px] text-muted-fg">{item.identifier}</span>
                        <Chip className="text-[8px]">{item.status}</Chip>
                      </div>
                      <div className="text-xs text-fg mt-1 truncate">{item.title}</div>
                      <div className="flex gap-1.5 mt-2">
                        <Button variant="outline" size="sm" className="!h-5 !text-[8px]" onClick={() => void resolveQueueItem(item.id, "approve")}>Approve</Button>
                        <Button variant="outline" size="sm" className="!h-5 !text-[8px]" onClick={() => void resolveQueueItem(item.id, "retry")}>Retry</Button>
                        <Button variant="danger" size="sm" className="!h-5 !text-[8px]" onClick={() => void resolveQueueItem(item.id, "reject")}>Reject</Button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Policy history */}
              <div className="border border-border/10 bg-card/60 backdrop-blur-sm shadow-card">
                <PaneHeader title="Policy History" meta={`${revisions.length}`} />
                <div className="p-3 space-y-1.5" data-testid="linear-history-list">
                  {revisions.length === 0 ? (
                    <div className="text-[10px] text-muted-fg/50 py-2">No revisions yet.</div>
                  ) : revisions.slice(0, 6).map((rev) => (
                    <div key={rev.id} className="bg-surface-recessed border border-border/10 px-3 py-2">
                      <div className="font-mono text-[9px] text-muted-fg/40">{formatDate(rev.createdAt)} · {rev.actor}</div>
                      <div className="font-mono text-[9px] text-muted-fg/50 mt-0.5">{rev.id.slice(0, 8)}</div>
                      <Button variant="ghost" size="sm" className="mt-1 !h-5 !px-1.5 !text-[8px]" onClick={() => void rollbackPolicy(rev.id)}>
                        <ArrowCounterClockwise size={8} /> Rollback
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}

          {step === "intake" && (
            <div className="border border-border/10 bg-card/60 backdrop-blur-sm shadow-card p-4 space-y-3">
              <div className="font-sans text-xs font-bold text-fg">Intake Configuration</div>
              <label className="space-y-1 block">
                <div className={labelCls}>Project slugs (comma-separated)</div>
                <input className={inputCls} placeholder="my-project, mobile-app" value={projectText} onChange={(e) => setProjectText(e.target.value)} />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="space-y-1">
                  <div className={labelCls}>Polling interval (sec)</div>
                  <input className={inputCls} type="number" min={5} value={policy.pollingIntervalSec ?? 300} onChange={(e) => setPolicy((p) => ({ ...p, pollingIntervalSec: Math.max(5, Number(e.target.value || 300)) }))} />
                </label>
                <label className="space-y-1">
                  <div className={labelCls}>Stall timeout (sec)</div>
                  <input className={inputCls} type="number" min={30} value={policy.reconciliation?.stalledTimeoutSec ?? 300} onChange={(e) => setPolicy((p) => ({ ...p, reconciliation: { ...(p.reconciliation ?? {}), stalledTimeoutSec: Math.max(30, Number(e.target.value || 300)) } }))} />
                </label>
              </div>
            </div>
          )}

          {step === "routing" && (
            <div className="border border-border/10 bg-card/60 backdrop-blur-sm shadow-card p-4 space-y-3">
              <div className="font-sans text-xs font-bold text-fg">Routing Rules</div>
              <label className="space-y-1 block">
                <div className={labelCls}>Label routes (label=worker, one per line)</div>
                <textarea className={cn(textareaCls, "min-h-[80px]")} value={routeMapText} onChange={(e) => setRouteMapText(e.target.value)} />
              </label>
              <label className="space-y-1 block">
                <div className={labelCls}>Auto-dispatch rules (JSON array)</div>
                <textarea className={cn(textareaCls, "min-h-[100px]")} value={rulesText} onChange={(e) => setRulesText(e.target.value)} />
              </label>

              {/* Route simulation */}
              <div className="border-t border-border/20 pt-3 mt-3">
                <div className={labelCls}>Route Simulation</div>
                <textarea className={cn(textareaCls, "min-h-[100px] mt-2")} value={simulationInput} onChange={(e) => setSimulationInput(e.target.value)} data-testid="linear-simulation-input" />
                <Button variant="outline" size="sm" className="mt-2 w-full" onClick={() => void simulateRoute()} data-testid="linear-simulate-btn">
                  Simulate route
                </Button>
                {simulationResult && (
                  <div className="mt-2 bg-surface-recessed border border-border/10 p-3" data-testid="linear-simulation-result">
                    <div className="font-mono text-[10px] text-muted-fg">
                      action={simulationResult.action} · worker={simulationResult.workerSlug ?? "none"} · template={simulationResult.templateId}
                    </div>
                    <div className="text-xs text-fg mt-1">{simulationResult.reason}</div>
                  </div>
                )}
              </div>
            </div>
          )}

          {step === "execution" && (
            <div className="border border-border/10 bg-card/60 backdrop-blur-sm shadow-card p-4 space-y-3">
              <div className="font-sans text-xs font-bold text-fg">Concurrency & Assignment</div>
              <div className="grid grid-cols-3 gap-3">
                <label className="space-y-1">
                  <div className={labelCls}>Global max</div>
                  <input className={inputCls} type="number" min={1} value={policy.concurrency?.global ?? 5} onChange={(e) => setPolicy((p) => ({ ...p, concurrency: { ...(p.concurrency ?? {}), global: Math.max(1, Number(e.target.value || 5)) } }))} />
                </label>
                <label className="space-y-1">
                  <div className={labelCls}>Todo max</div>
                  <input className={inputCls} type="number" min={0} value={policy.concurrency?.byState?.todo ?? 3} onChange={(e) => setPolicy((p) => ({ ...p, concurrency: { ...(p.concurrency ?? {}), byState: { ...(p.concurrency?.byState ?? {}), todo: Math.max(0, Number(e.target.value || 3)) } } }))} />
                </label>
                <label className="space-y-1">
                  <div className={labelCls}>In Progress max</div>
                  <input className={inputCls} type="number" min={0} value={policy.concurrency?.byState?.in_progress ?? 5} onChange={(e) => setPolicy((p) => ({ ...p, concurrency: { ...(p.concurrency ?? {}), byState: { ...(p.concurrency?.byState ?? {}), in_progress: Math.max(0, Number(e.target.value || 5)) } } }))} />
                </label>
              </div>
              <label className="flex items-center gap-2 text-xs text-muted-fg cursor-pointer">
                <input type="checkbox" checked={policy.assignment?.setAssigneeOnDispatch === true} onChange={(e) => setPolicy((p) => ({ ...p, assignment: { ...(p.assignment ?? {}), setAssigneeOnDispatch: e.target.checked } }))} />
                Set assignee on dispatch when worker mapping available
              </label>
            </div>
          )}

          {step === "escalation" && (
            <div className="border border-border/10 bg-card/60 backdrop-blur-sm shadow-card p-4 space-y-3">
              <div className="font-sans text-xs font-bold text-fg">Escalation & Classification</div>
              <label className="space-y-1 block">
                <div className={labelCls}>Default action</div>
                <select className={selectCls} value={policy.autoDispatch?.default ?? "escalate"} onChange={(e) => setPolicy((p) => ({ ...p, autoDispatch: { ...(p.autoDispatch ?? {}), default: e.target.value as NonNullable<LinearSyncConfig["autoDispatch"]>["default"] } }))}>
                  <option value="auto">auto</option>
                  <option value="escalate">escalate</option>
                  <option value="queue-night-shift">queue-night-shift</option>
                </select>
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="space-y-1">
                  <div className={labelCls}>Classification mode</div>
                  <select className={selectCls} value={policy.classification?.mode ?? "hybrid"} onChange={(e) => setPolicy((p) => ({ ...p, classification: { ...(p.classification ?? {}), mode: e.target.value as NonNullable<LinearSyncConfig["classification"]>["mode"] } }))}>
                    <option value="heuristics">heuristics</option>
                    <option value="hybrid">hybrid</option>
                    <option value="ai">ai</option>
                  </select>
                </label>
                <label className="space-y-1">
                  <div className={labelCls}>Confidence threshold</div>
                  <input className={inputCls} type="number" min={0} max={1} step={0.05} value={policy.classification?.confidenceThreshold ?? 0.7} onChange={(e) => setPolicy((p) => ({ ...p, classification: { ...(p.classification ?? {}), confidenceThreshold: Math.max(0, Math.min(1, Number(e.target.value || 0.7))) } }))} />
                </label>
              </div>
            </div>
          )}

          {step === "closeout" && (
            <div className="border border-border/10 bg-card/60 backdrop-blur-sm shadow-card p-4 space-y-3">
              <div className="font-sans text-xs font-bold text-fg">Closeout & Artifacts</div>
              <label className="space-y-1 block">
                <div className={labelCls}>Artifacts mode</div>
                <select className={selectCls} value={policy.artifacts?.mode ?? "links"} onChange={(e) => setPolicy((p) => ({ ...p, artifacts: { ...(p.artifacts ?? {}), mode: e.target.value as NonNullable<LinearSyncConfig["artifacts"]>["mode"] } }))}>
                  <option value="links">links</option>
                  <option value="attachments">attachments</option>
                </select>
              </label>
              <div className="text-[10px] text-muted-fg/50 leading-relaxed">
                Links mode updates the workpad with artifact paths. Attachments uploads files directly to Linear.
              </div>
            </div>
          )}

          {/* Save bar */}
          <div className="flex gap-2 pt-1">
            <Button variant="primary" className="flex-1" disabled={saving} onClick={() => void savePolicy()} data-testid="linear-save-policy-btn">
              {saving ? "Saving..." : "Save policy"}
            </Button>
            <Button variant="outline" className="flex-1" onClick={() => void loadAll()}>
              Reload
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
