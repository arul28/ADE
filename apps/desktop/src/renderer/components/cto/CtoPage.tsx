import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Brain,
  ChatCircle,
  Database,
  Gear,
  GitBranch,
  UsersThree,
} from "@phosphor-icons/react";
import type {
  AgentBudgetSnapshot,
  AgentChatSession,
  AgentConfigRevision,
  AgentCoreMemory,
  AgentIdentity,
  AgentSessionLogEntry,
  CtoCoreMemory,
  CtoIdentity,
  CtoOnboardingState,
  CtoSessionLogEntry,
  CtoSubordinateActivityEntry,
  AgentStatus,
  HeartbeatPolicy,
  WorkerAgentRun,
} from "../../../shared/types";
import { AgentChatPane } from "../chat/AgentChatPane";
import { useAppStore } from "../../state/appStore";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { cn } from "../ui/cn";
import { AgentSidebar } from "./AgentSidebar";
import { WorkerDetailPanel, WorkerEditorPanel, workerDraftFromAgent } from "./TeamPanel";
import type { WorkerEditorDraft } from "./TeamPanel";
import { LinearSyncPanel } from "./LinearSyncPanel";
import { CtoSettingsPanel } from "./CtoSettingsPanel";
import { OnboardingWizard } from "./OnboardingWizard";
import { OnboardingBanner } from "./OnboardingBanner";
import { WorkerCreationWizard } from "./WorkerCreationWizard";
import { CtoMemoryBrowser } from "./CtoMemoryBrowser";
import { TimelineEntry } from "./shared/TimelineEntry";
import { cardCls, shellBodyCls, shellTabBarCls } from "./shared/designTokens";

/* ── Tab types ── */

type TabId = "chat" | "team" | "memory" | "linear" | "settings";

const TABS: { id: TabId; label: string; icon: React.ElementType }[] = [
  { id: "chat", label: "Chat", icon: ChatCircle },
  { id: "team", label: "Team", icon: UsersThree },
  { id: "memory", label: "Memory", icon: Database },
  { id: "linear", label: "Linear", icon: GitBranch },
  { id: "settings", label: "Settings", icon: Gear },
];

/* ── Main Page ── */

export function CtoPage() {
  const lanes = useAppStore((s) => s.lanes);
  const selectedLaneId = useAppStore((s) => s.selectedLaneId);

  const [activeTab, setActiveTab] = useState<TabId>("chat");
  const [session, setSession] = useState<AgentChatSession | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [ctoIdentity, setCtoIdentity] = useState<CtoIdentity | null>(null);
  const [coreMemory, setCoreMemory] = useState<CtoCoreMemory | null>(null);
  const [sessionLogs, setSessionLogs] = useState<CtoSessionLogEntry[]>([]);
  const [subordinateActivity, setSubordinateActivity] = useState<CtoSubordinateActivityEntry[]>([]);

  // Onboarding state
  const [onboardingState, setOnboardingState] = useState<CtoOnboardingState | null>(null);
  const [showOnboarding, setShowOnboarding] = useState(false);

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

  // Worker creation wizard
  const [showWorkerWizard, setShowWorkerWizard] = useState(false);

  const [editorOpen, setEditorOpen] = useState(false);
  const [workerDraft, setWorkerDraft] = useState<WorkerEditorDraft>(workerDraftFromAgent(null));
  const [savingWorker, setSavingWorker] = useState(false);
  const [workerError, setWorkerError] = useState<string | null>(null);

  const laneId = useMemo(() => {
    if (selectedLaneId && lanes.some((lane) => lane.id === selectedLaneId)) return selectedLaneId;
    return lanes[0]?.id ?? null;
  }, [lanes, selectedLaneId]);

  const selectedWorker = useMemo(
    () => (selectedAgentId ? agents.find((a) => a.id === selectedAgentId) ?? null : null),
    [agents, selectedAgentId],
  );

  // Onboarding detection
  const needsOnboarding = onboardingState
    && onboardingState.completedSteps.length === 0
    && !onboardingState.dismissedAt
    && !onboardingState.completedAt;

  const showBanner = onboardingState
    && !needsOnboarding
    && !onboardingState.completedAt
    && Boolean(onboardingState.dismissedAt)
    && !showOnboarding;

  /* ── Data loading ── */

  const loadCtoState = useCallback(async () => {
    if (!window.ade?.cto) return;
    try {
      const [snapshot, obState] = await Promise.all([
        window.ade.cto.getState({ recentLimit: 20 }),
        window.ade.cto.getOnboardingState(),
      ]);
      setCtoIdentity(snapshot.identity);
      setCoreMemory(snapshot.coreMemory);
      setSessionLogs(snapshot.recentSessions);
      setSubordinateActivity(snapshot.recentSubordinateActivity);
      setOnboardingState(obState);
      // Auto-show onboarding if first run
      if (obState.completedSteps.length === 0 && !obState.dismissedAt && !obState.completedAt) {
        setShowOnboarding(true);
      }
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

  // Load revisions when worker selected
  useEffect(() => {
    if (!window.ade?.cto || !selectedAgentId) { setRevisions([]); return; }
    void window.ade.cto.listAgentRevisions({ agentId: selectedAgentId, limit: 20 }).then(setRevisions).catch(() => setRevisions([]));
  }, [selectedAgentId]);

  // Load worker details when selected
  useEffect(() => {
    if (!window.ade?.cto || !selectedAgentId) {
      setWorkerCoreMemory(null); setWorkerSessionLogs([]); setWorkerRuns([]);
      setWorkerOpsError(null); setWorkerWakeStatus(null); setWorkerWakeError(null);
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
      setWorkerOpsError(err instanceof Error ? err.message : "Failed to load.");
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

  // Deep link to linear-sync
  useEffect(() => {
    if (window.location.hash.toLowerCase().includes("linear-sync")) {
      setActiveTab("linear");
    }
  }, []);

  /* ── Callbacks ── */

  const handleSaveCoreMemory = useCallback(async (patch: Record<string, unknown>) => {
    if (!window.ade?.cto) throw new Error("CTO bridge unavailable.");
    const snapshot = await window.ade.cto.updateCoreMemory({ patch });
    setCoreMemory(snapshot.coreMemory);
  }, []);

  const handleSaveWorkerCoreMemory = useCallback(async (patch: Record<string, unknown>) => {
    if (!window.ade?.cto || !selectedAgentId) throw new Error("Select a worker first.");
    const updated = await window.ade.cto.updateAgentCoreMemory({ agentId: selectedAgentId, patch });
    setWorkerCoreMemory(updated);
  }, [selectedAgentId]);

  const handleSaveCtoIdentity = useCallback(async (patch: Record<string, unknown>) => {
    if (!window.ade?.cto) throw new Error("CTO bridge unavailable.");
    const snapshot = await window.ade.cto.updateIdentity({ patch });
    setCtoIdentity(snapshot.identity);
  }, []);

  const saveWorker = useCallback(async () => {
    if (!window.ade?.cto) return;
    setSavingWorker(true); setWorkerError(null);
    try {
      const at = workerDraft.adapterType;
      const adapterConfig: Record<string, unknown> =
        at === "openclaw-webhook"
          ? { url: workerDraft.webhookUrl, ...(workerDraft.authHeader.trim() ? { headers: { Authorization: workerDraft.authHeader.trim() } } : {}) }
          : at === "process"
            ? { command: workerDraft.processCommand }
            : { ...(workerDraft.model.trim() ? { model: workerDraft.model.trim() } : {}) };

      const heartbeat: HeartbeatPolicy = {
        enabled: workerDraft.heartbeatEnabled,
        intervalSec: Math.max(0, Math.floor(workerDraft.heartbeatIntervalSec)),
        wakeOnDemand: workerDraft.wakeOnDemand,
        ...(workerDraft.activeHoursEnabled
          ? { activeHours: { start: workerDraft.activeHoursStart.trim() || "09:00", end: workerDraft.activeHoursEnd.trim() || "22:00", timezone: workerDraft.activeHoursTimezone.trim() || "local" } }
          : {}),
      };

      await window.ade.cto.saveAgent({
        agent: {
          ...(workerDraft.id ? { id: workerDraft.id } : {}),
          name: workerDraft.name,
          role: workerDraft.role,
          ...(workerDraft.title.trim() ? { title: workerDraft.title.trim() } : {}),
          reportsTo: workerDraft.reportsTo.trim() || null,
          capabilities: workerDraft.capabilities.split(",").map((s) => s.trim()).filter(Boolean),
          adapterType: at,
          adapterConfig,
          runtimeConfig: {
            heartbeat,
            maxConcurrentRuns: Math.max(1, Math.min(10, Math.floor(workerDraft.maxConcurrentRuns || 1))),
          },
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
    if (selectedAgentId === agentId) {
      setSelectedAgentId(null);
    }
    await loadWorkersAndBudget();
  }, [loadWorkersAndBudget, selectedAgentId]);

  const setSelectedWorkerStatus = useCallback(async (status: AgentStatus) => {
    if (!window.ade?.cto || !selectedAgentId) return;
    await window.ade.cto.setAgentStatus({ agentId: selectedAgentId, status });
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

  const handleHireWorker = useCallback(() => {
    setShowWorkerWizard(true);
    setActiveTab("team");
  }, []);

  const handleEditWorker = useCallback(() => {
    if (!selectedWorker) return;
    setWorkerDraft(workerDraftFromAgent(selectedWorker));
    setWorkerError(null);
    setEditorOpen(true);
  }, [selectedWorker]);

  const handleOnboardingComplete = useCallback(async () => {
    setShowOnboarding(false);
    await loadCtoState();
  }, [loadCtoState]);

  const handleDismissOnboarding = useCallback(async () => {
    if (!window.ade?.cto) return;
    await window.ade.cto.dismissOnboarding();
    setShowOnboarding(false);
    await loadCtoState();
  }, [loadCtoState]);

  const handleResetOnboarding = useCallback(async () => {
    if (!window.ade?.cto) return;
    await window.ade.cto.resetOnboarding();
    setShowOnboarding(true);
    await loadCtoState();
  }, [loadCtoState]);

  /* ── Render ── */

  function capabilityLabel(mode: AgentChatSession["capabilityMode"] | null | undefined): string {
    return mode === "full_mcp" ? "FULL MCP" : "FALLBACK";
  }

  const teamStats = useMemo(() => {
    const counts = {
      total: agents.length,
      active: agents.filter((agent) => agent.status === "active").length,
      running: agents.filter((agent) => agent.status === "running").length,
      paused: agents.filter((agent) => agent.status === "paused").length,
    };
    return counts;
  }, [agents]);

  return (
    <div className={shellBodyCls}>
      {/* Onboarding wizard overlay */}
      {showOnboarding && (
        <OnboardingWizard
          onComplete={handleOnboardingComplete}
          onSkip={handleDismissOnboarding}
          completedSteps={onboardingState?.completedSteps ?? []}
        />
      )}

      {/* Agent sidebar */}
      <AgentSidebar
        agents={agents}
        selectedAgentId={selectedAgentId}
        onSelectAgent={(id) => {
          setSelectedAgentId(id);
          setActiveTab("team");
        }}
        onSelectCto={() => { setSelectedAgentId(null); setActiveTab("chat"); }}
        isCtoSelected={!selectedAgentId}
        budgetSnapshot={budgetSnapshot}
        onHireWorker={handleHireWorker}
        ctoModelInfo={ctoIdentity ? { provider: ctoIdentity.modelPreferences.provider, model: ctoIdentity.modelPreferences.model } : null}
      />

      {/* Main content */}
      <div className="flex flex-1 flex-col min-w-0 min-h-0">
        {/* Onboarding banner */}
        {showBanner && (
          <OnboardingBanner
            onContinue={() => setShowOnboarding(true)}
            onDismiss={handleDismissOnboarding}
          />
        )}

        {/* Tab bar */}
        <div className={shellTabBarCls} style={{ minHeight: 36 }}>
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setActiveTab(id)}
              className={cn(
                "flex items-center gap-1.5 px-4 py-2 font-mono text-[10px] font-bold uppercase tracking-[1px] transition-all duration-100 border-b-2",
                activeTab === id
                  ? "border-b-accent text-accent"
                  : "border-b-transparent text-muted-fg hover:text-fg",
              )}
            >
              <Icon size={12} weight={activeTab === id ? "bold" : "regular"} />
              {label}
            </button>
          ))}

          {/* Right side: agent context */}
          <div className="ml-auto flex items-center gap-2 pr-4">
            {session && (
              <Chip className={cn("text-[9px]", session.capabilityMode === "full_mcp" ? "text-success" : "text-warning")} data-testid="cto-capability-badge">
                {capabilityLabel(session.capabilityMode)}
              </Chip>
            )}
            <span className="font-mono text-[10px] text-muted-fg/50">
              {selectedWorker ? selectedWorker.name : "CTO"}
            </span>
          </div>
        </div>

        {/* Tab content */}
        <div className="flex-1 min-h-0 overflow-hidden">
          {/* Chat tab */}
          {activeTab === "chat" && (
            <div className="flex flex-col h-full min-h-0">
              {/* Chat header */}
              <div className="shrink-0 px-4 py-2.5 border-b border-border/20" style={{ background: "var(--color-card)" }}>
                <div className="flex items-center gap-2">
                  <Brain size={14} className="text-accent" />
                  <span className="font-sans text-xs font-bold text-fg">
                    {selectedWorker ? selectedWorker.name : "CTO"} Chat
                  </span>
                </div>
                <div className="font-mono text-[10px] text-muted-fg/50 mt-0.5">
                  {laneId
                    ? (selectedWorker ? `Direct chat with ${selectedWorker.name}` : "Persistent CTO session is locked to this project context.")
                    : "Create a lane to start CTO chat."}
                </div>
                {loading && <div className="font-mono text-[10px] text-muted-fg mt-1" data-testid="cto-loading">Connecting session...</div>}
                {error && <div className="font-mono text-[10px] text-error mt-1" data-testid="cto-error">{error}</div>}
              </div>

              {/* Chat pane */}
              <div className="flex-1 min-h-0">
                <AgentChatPane laneId={laneId} lockSessionId={session?.id ?? null} />
              </div>
            </div>
          )}

          {/* Team tab */}
          {activeTab === "team" && (
            <div className="flex flex-col h-full min-h-0 overflow-y-auto">
              {showWorkerWizard ? (
                <div className="p-4">
                  <WorkerCreationWizard
                    agents={agents}
                    onComplete={async () => {
                      setShowWorkerWizard(false);
                      await loadWorkersAndBudget();
                    }}
                    onCancel={() => setShowWorkerWizard(false)}
                  />
                </div>
              ) : editorOpen ? (
                <div className="p-4">
                  <WorkerEditorPanel
                    draft={workerDraft}
                    setDraft={setWorkerDraft}
                    agents={agents}
                    saving={savingWorker}
                    error={workerError}
                    onSave={() => void saveWorker()}
                    onCancel={() => setEditorOpen(false)}
                  />
                </div>
              ) : agents.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full p-8">
                  <UsersThree size={48} weight="thin" className="text-muted-fg/20 mb-4" />
                  <div className="font-sans text-sm font-bold text-fg">Your Team</div>
                  <div className="font-mono text-[10px] text-muted-fg/50 mt-1 text-center max-w-[40ch]">
                    Hire workers to handle tasks autonomously. Start from a template or configure from scratch.
                  </div>
                  <Button variant="primary" className="mt-4" onClick={handleHireWorker}>
                    Hire Worker
                  </Button>
                </div>
              ) : (
                <div className="p-4">
                  {!selectedWorker ? (
                    <div className="space-y-4" data-testid="team-overview">
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="font-sans text-sm font-bold text-fg">Department Overview</div>
                          <div className="mt-1 font-mono text-[10px] text-muted-fg/60">
                            Pick a worker from the sidebar to inspect details, or hire a new teammate.
                          </div>
                        </div>
                        <Button variant="outline" size="sm" onClick={handleHireWorker}>
                          Hire Worker
                        </Button>
                      </div>

                      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
                        {[
                          { label: "Workers", value: String(teamStats.total) },
                          { label: "Active", value: String(teamStats.active) },
                          { label: "Running", value: String(teamStats.running) },
                          { label: "Paused", value: String(teamStats.paused) },
                        ].map((item) => (
                          <div key={item.label} className={cn(cardCls, "p-3")}>
                            <div className="font-mono text-[9px] uppercase tracking-[1px] text-muted-fg/50">{item.label}</div>
                            <div className="mt-2 font-sans text-2xl font-bold text-fg">{item.value}</div>
                          </div>
                        ))}
                      </div>

                      <div className={cn(cardCls, "p-4")} data-testid="cto-subordinate-activity">
                        <div className="mb-3 flex items-center justify-between">
                          <div>
                            <div className="font-sans text-sm font-bold text-fg">Recent Department Activity</div>
                            <div className="mt-1 font-mono text-[10px] text-muted-fg/55">
                              Existing worker runs and direct worker chat activity flowing up to the CTO.
                            </div>
                          </div>
                        </div>
                        <div className="space-y-1">
                          {subordinateActivity.length === 0 ? (
                            <div className="py-4 font-mono text-[10px] text-muted-fg/50">No department activity recorded yet.</div>
                          ) : subordinateActivity.map((entry) => (
                            <TimelineEntry
                              key={entry.id}
                              timestamp={entry.createdAt}
                              title={`${entry.agentName} · ${entry.activityType === "worker_run" ? "Worker run" : "Chat turn"}`}
                              subtitle={[entry.summary, entry.issueKey, entry.taskKey].filter(Boolean).join(" · ")}
                              status={entry.activityType === "worker_run" ? "run" : "chat"}
                              statusVariant={entry.activityType === "worker_run" ? "info" : "muted"}
                            />
                          ))}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <WorkerDetailPanel
                      worker={selectedWorker}
                      coreMemory={workerCoreMemory}
                      sessionLogs={workerSessionLogs}
                      runs={workerRuns}
                      revisions={revisions}
                      opsError={workerOpsError}
                      wakeStatus={workerWakeStatus}
                      wakeError={workerWakeError}
                      waking={wakingWorker}
                      onWakeNow={() => void wakeSelectedWorker()}
                      onSetStatus={(status) => void setSelectedWorkerStatus(status)}
                      onEdit={handleEditWorker}
                      onRemove={() => void removeWorker(selectedWorker.id)}
                      onRollbackRevision={(id) => void rollbackRevision(id)}
                      onSaveCoreMemory={handleSaveWorkerCoreMemory}
                    />
                  )}
                </div>
              )}
            </div>
          )}

          {/* Memory tab */}
          {activeTab === "memory" && <CtoMemoryBrowser />}

          {/* Linear tab */}
          {activeTab === "linear" && <LinearSyncPanel />}

          {/* Settings tab */}
          {activeTab === "settings" && (
            <CtoSettingsPanel
              identity={ctoIdentity}
              coreMemory={coreMemory}
              sessionLogs={sessionLogs}
              onSaveIdentity={handleSaveCtoIdentity}
              onSaveCoreMemory={handleSaveCoreMemory}
              onResetOnboarding={handleResetOnboarding}
            />
          )}
        </div>
      </div>

    </div>
  );
}
