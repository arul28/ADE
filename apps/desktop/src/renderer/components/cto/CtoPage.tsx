import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  AgentChatSessionSummary,
  HeartbeatPolicy,
  OpenclawBridgeStatus,
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

function splitTrimmed(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

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
  const [openclawStatus, setOpenclawStatus] = useState<OpenclawBridgeStatus | null>(null);

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
  const [externalMcpServerNames, setExternalMcpServerNames] = useState<string[]>([]);
  const [budgetLoading, setBudgetLoading] = useState(false);

  // Worker creation wizard
  const [showWorkerWizard, setShowWorkerWizard] = useState(false);

  const [editorOpen, setEditorOpen] = useState(false);
  const [workerDraft, setWorkerDraft] = useState<WorkerEditorDraft>(workerDraftFromAgent(null));
  const [savingWorker, setSavingWorker] = useState(false);
  const [workerError, setWorkerError] = useState<string | null>(null);
  const ctoHistoryLoadedRef = useRef(false);
  const lastBudgetLoadAtRef = useRef(0);

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

  const loadCtoSummary = useCallback(async () => {
    if (!window.ade?.cto) return;
    try {
      const [snapshot, obState] = await Promise.all([
        window.ade.cto.getState({ recentLimit: 0 }),
        window.ade.cto.getOnboardingState(),
      ]);
      setCtoIdentity(snapshot.identity);
      setCoreMemory(snapshot.coreMemory);
      setOnboardingState(obState);
      // Auto-show onboarding if first run
      if (obState.completedSteps.length === 0 && !obState.dismissedAt && !obState.completedAt) {
        setShowOnboarding(true);
      }
    } catch { /* non-fatal */ }
  }, []);

  const loadCtoHistory = useCallback(async () => {
    if (!window.ade?.cto) return;
    try {
      const snapshot = await window.ade.cto.getState({ recentLimit: 20 });
      setCtoIdentity(snapshot.identity);
      setCoreMemory(snapshot.coreMemory);
      setSessionLogs(snapshot.recentSessions);
      setSubordinateActivity(snapshot.recentSubordinateActivity);
      ctoHistoryLoadedRef.current = true;
    } catch {
      // non-fatal
    }
  }, []);

  const loadAgents = useCallback(async () => {
    if (!window.ade?.cto) return;
    try {
      const nextAgents = await window.ade.cto.listAgents({ includeDeleted: false });
      setAgents(nextAgents);
      if (selectedAgentId && !nextAgents.some((a) => a.id === selectedAgentId)) {
        setSelectedAgentId(null);
      }
    } catch { /* non-fatal */ }
  }, [selectedAgentId]);

  const loadBudgetSnapshot = useCallback(async (options?: { force?: boolean }) => {
    if (!window.ade?.cto || budgetLoading) return;
    const now = Date.now();
    if (!options?.force && budgetSnapshot && now - lastBudgetLoadAtRef.current < 30_000) {
      return;
    }
    setBudgetLoading(true);
    try {
      const nextBudget = await window.ade.cto.getBudgetSnapshot({});
      setBudgetSnapshot(nextBudget);
      lastBudgetLoadAtRef.current = Date.now();
    } catch {
      // non-fatal
    } finally {
      setBudgetLoading(false);
    }
  }, [budgetLoading, budgetSnapshot]);

  const loadExternalMcpRegistry = useCallback(async () => {
    if (!window.ade?.externalMcp) return;
    try {
      const configs = await window.ade.externalMcp.listConfigs();
      setExternalMcpServerNames(configs.map((entry) => entry.name).sort((a, b) => a.localeCompare(b)));
    } catch {
      setExternalMcpServerNames([]);
    }
  }, []);

  useEffect(() => {
    void loadCtoSummary();
  }, [loadCtoSummary]);

  useEffect(() => {
    if (!onboardingState || needsOnboarding) return;
    void loadAgents();
  }, [loadAgents, needsOnboarding, onboardingState]);

  useEffect(() => {
    if (!onboardingState || needsOnboarding) return;
    if (activeTab !== "team" && activeTab !== "settings") return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (!cancelled) {
        void loadBudgetSnapshot();
      }
    }, 900);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activeTab, loadBudgetSnapshot, needsOnboarding, onboardingState]);

  useEffect(() => {
    if ((activeTab !== "team" && activeTab !== "settings") || ctoHistoryLoadedRef.current) return;
    void loadCtoHistory();
  }, [activeTab, loadCtoHistory]);

  useEffect(() => {
    if (activeTab !== "settings" && !editorOpen) return;
    if (externalMcpServerNames.length > 0) return;
    void loadExternalMcpRegistry();
  }, [activeTab, editorOpen, externalMcpServerNames.length, loadExternalMcpRegistry]);

  useEffect(() => {
    const unsubscribe = window.ade?.cto?.onOpenclawConnectionStatus?.((status) => {
      setOpenclawStatus(status);
    });
    return () => unsubscribe?.();
  }, []);

  // Load revisions when worker selected
  useEffect(() => {
    if (!window.ade?.cto || !selectedAgentId) { setRevisions([]); return; }
    if (activeTab !== "team") return;
    void window.ade.cto.listAgentRevisions({ agentId: selectedAgentId, limit: 20 }).then(setRevisions).catch(() => setRevisions([]));
  }, [activeTab, selectedAgentId]);

  // Load worker details when selected
  useEffect(() => {
    if (!window.ade?.cto || !selectedAgentId) {
      setWorkerCoreMemory(null); setWorkerSessionLogs([]); setWorkerRuns([]);
      setWorkerOpsError(null); setWorkerWakeStatus(null); setWorkerWakeError(null);
      return;
    }
    if (activeTab !== "team") return;
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
  }, [activeTab, selectedAgentId]);

  // Establish chat session
  useEffect(() => {
    if (activeTab !== "chat") {
      setLoading(false);
      setSession(null);
      return;
    }
    if (!window.ade?.cto) {
      setLoading(false);
      setError("CTO bridge is unavailable.");
      setSession(null);
      return;
    }
    if (!onboardingState || showOnboarding || needsOnboarding) {
      setLoading(false);
      setSession(null);
      return;
    }
    if (!laneId) { setSession(null); return; }
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
  }, [activeTab, laneId, needsOnboarding, onboardingState, selectedAgentId, showOnboarding]);

  // Deep links for guided setup flows
  useEffect(() => {
    const syncHash = () => {
      const hash = window.location.hash.toLowerCase();
      if (hash.includes("linear-sync")) {
        setActiveTab("linear");
      } else if (hash.includes("team-setup")) {
        setActiveTab("team");
      }
    };
    syncHash();
    window.addEventListener("hashchange", syncHash);
    return () => window.removeEventListener("hashchange", syncHash);
  }, []);

  useEffect(() => {
    console.info(`renderer.tab_change ${JSON.stringify({
      page: "cto",
      tab: activeTab,
      workerId: selectedAgentId,
    })}`);
  }, [activeTab, selectedAgentId]);

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
          ...(
            splitTrimmed(workerDraft.linearUserIds).length
            || splitTrimmed(workerDraft.linearDisplayNames).length
            || splitTrimmed(workerDraft.linearAliases).length
              ? {
                  linearIdentity: {
                    userIds: splitTrimmed(workerDraft.linearUserIds),
                    displayNames: splitTrimmed(workerDraft.linearDisplayNames),
                    aliases: splitTrimmed(workerDraft.linearAliases),
                  },
                }
              : {}
          ),
          externalMcpAccess: {
            allowAll: workerDraft.externalMcpAllowAll,
            allowedServers: workerDraft.externalMcpAllowedServers,
            blockedServers: workerDraft.externalMcpBlockedServers,
          },
          budgetMonthlyCents: Math.max(0, Math.round(workerDraft.budgetDollars * 100)),
        },
      });
      setEditorOpen(false);
      await loadAgents();
      await loadBudgetSnapshot({ force: true });
    } catch (err) {
      setWorkerError(err instanceof Error ? err.message : "Failed to save worker.");
    } finally {
      setSavingWorker(false);
    }
  }, [loadAgents, loadBudgetSnapshot, workerDraft]);

  const removeWorker = useCallback(async (agentId: string) => {
    if (!window.ade?.cto) return;
    await window.ade.cto.removeAgent({ agentId });
    if (selectedAgentId === agentId) {
      setSelectedAgentId(null);
    }
    await loadAgents();
    await loadBudgetSnapshot({ force: true });
  }, [loadAgents, loadBudgetSnapshot, selectedAgentId]);

  const setSelectedWorkerStatus = useCallback(async (status: AgentStatus) => {
    if (!window.ade?.cto || !selectedAgentId) return;
    await window.ade.cto.setAgentStatus({ agentId: selectedAgentId, status });
    await loadAgents();
    await loadBudgetSnapshot({ force: true });
  }, [loadAgents, loadBudgetSnapshot, selectedAgentId]);

  const rollbackRevision = useCallback(async (revisionId: string) => {
    if (!window.ade?.cto || !selectedAgentId) return;
    await window.ade.cto.rollbackAgentRevision({ agentId: selectedAgentId, revisionId });
    await loadAgents();
    await loadBudgetSnapshot({ force: true });
    const next = await window.ade.cto.listAgentRevisions({ agentId: selectedAgentId, limit: 20 });
    setRevisions(next);
  }, [loadAgents, loadBudgetSnapshot, selectedAgentId]);

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
    const completedAt = new Date().toISOString();
    setOnboardingState((current) => ({
      completedSteps: Array.from(new Set([...(current?.completedSteps ?? []), "identity", "project", "integrations"])),
      completedAt: current?.completedAt ?? completedAt,
      dismissedAt: current?.dismissedAt,
    }));
    setShowOnboarding(false);
    try {
      await loadCtoSummary();
    } catch {
      // Keep the local optimistic state even if the refresh fails.
    }
  }, [loadCtoSummary]);

  const handleDismissOnboarding = useCallback(async () => {
    const dismissedAt = new Date().toISOString();
    setOnboardingState((current) => ({
      completedSteps: current?.completedSteps ?? [],
      completedAt: current?.completedAt,
      dismissedAt,
    }));
    setShowOnboarding(false);
    if (!window.ade?.cto) return;
    try {
      await window.ade.cto.dismissOnboarding();
      await loadCtoSummary();
    } catch {
      // Let the user continue even if persistence or refresh fails.
    }
  }, [loadCtoSummary]);

  const handleResetOnboarding = useCallback(async () => {
    if (!window.ade?.cto) return;
    await window.ade.cto.resetOnboarding();
    setShowOnboarding(true);
    await loadCtoSummary();
  }, [loadCtoSummary]);

  const lockedSessionSummary = useMemo<AgentChatSessionSummary | null>(() => {
    if (!session) return null;
    return {
      sessionId: session.id,
      laneId: session.laneId,
      provider: session.provider,
      model: session.model,
      modelId: session.modelId,
      sessionProfile: session.sessionProfile,
      title: null,
      goal: null,
      reasoningEffort: session.reasoningEffort ?? null,
      executionMode: session.executionMode ?? null,
      permissionMode: session.permissionMode,
      identityKey: session.identityKey,
      capabilityMode: session.capabilityMode,
      computerUse: session.computerUse,
      status: session.status,
      startedAt: session.createdAt,
      endedAt: session.status === "ended" ? session.lastActivityAt : null,
      lastActivityAt: session.lastActivityAt,
      lastOutputPreview: null,
      summary: null,
      threadId: session.threadId,
    };
  }, [session]);

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

  const sidebarCtoModelInfo = useMemo(
    () => (
      ctoIdentity
        ? {
          provider: ctoIdentity.modelPreferences.provider,
          model: ctoIdentity.modelPreferences.model,
        }
        : null
    ),
    [ctoIdentity],
  );

  const handleSelectSidebarAgent = useCallback((id: string) => {
    setSelectedAgentId(id);
    setActiveTab("team");
  }, []);

  const handleSelectSidebarCto = useCallback(() => {
    setSelectedAgentId(null);
    setActiveTab("chat");
  }, []);

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
        onSelectAgent={handleSelectSidebarAgent}
        onSelectCto={handleSelectSidebarCto}
        isCtoSelected={!selectedAgentId}
        budgetSnapshot={budgetSnapshot}
        onHireWorker={handleHireWorker}
        ctoModelInfo={sidebarCtoModelInfo}
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
              <div className="shrink-0 px-4 py-2.5 border-b border-white/[0.06] bg-white/[0.03] backdrop-blur-xl">
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
                {openclawStatus && (
                  <div className="mt-1 font-mono text-[10px] text-muted-fg/60">
                    OpenClaw:{" "}
                    <span className={cn(
                      openclawStatus.state === "connected"
                        ? "text-success"
                        : openclawStatus.state === "connecting" || openclawStatus.state === "reconnecting"
                          ? "text-warning"
                          : "text-muted-fg/60",
                    )}>
                      {openclawStatus.state}
                    </span>
                    {openclawStatus.lastMessageAt ? ` · last bridge activity ${new Date(openclawStatus.lastMessageAt).toLocaleTimeString()}` : ""}
                  </div>
                )}
                {loading && <div className="font-mono text-[10px] text-muted-fg mt-1" data-testid="cto-loading">Connecting session...</div>}
                {error && <div className="font-mono text-[10px] text-error mt-1" data-testid="cto-error">{error}</div>}
              </div>

              {/* Chat pane */}
              <div className="flex-1 min-h-0">
                <AgentChatPane
                  laneId={laneId}
                  lockSessionId={session?.id ?? null}
                  initialSessionSummary={lockedSessionSummary}
                  hideSessionTabs
                />
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
                      await loadAgents();
                      await loadBudgetSnapshot({ force: true });
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
                    availableExternalMcpServers={externalMcpServerNames}
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
                    Hire workers to handle tasks autonomously. Start from a template or configure from scratch, then map their Linear identities so assignee-based workflows can route issues to them.
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
                            Pick a worker from the sidebar to inspect details, hire a new teammate, or edit Linear identity mappings so CTO &gt; Linear can route assignee-based workflows correctly.
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
                  availableExternalMcpServers={externalMcpServerNames}
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
