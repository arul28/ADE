import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChatCircle,
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
  ChatSurfacePresentation,
  HeartbeatPolicy,
  OpenclawBridgeStatus,
  WorkerAgentRun,
} from "../../../shared/types";
import { AgentChatPane } from "../chat/AgentChatPane";
import { useAppStore } from "../../state/appStore";
import { Button } from "../ui/Button";
import { cn } from "../ui/cn";
import { AgentSidebar } from "./AgentSidebar";
import { WorkerDetailPanel, WorkerEditorPanel, workerDraftFromAgent } from "./TeamPanel";
import type { WorkerEditorDraft } from "./TeamPanel";
import { LinearSyncPanel } from "./LinearSyncPanel";
import { CtoSettingsPanel } from "./CtoSettingsPanel";
import { OnboardingWizard } from "./OnboardingWizard";
import { OnboardingBanner } from "./OnboardingBanner";
import { WorkerCreationWizard } from "./WorkerCreationWizard";
import { TimelineEntry } from "./shared/TimelineEntry";
import { cardCls, shellBodyCls } from "./shared/designTokens";

/* ── Tab types ── */

type TabId = "chat" | "team" | "workflows" | "settings";

const TABS: { id: TabId; label: string; icon: React.ElementType; color: string }[] = [
  { id: "chat", label: "Chat", icon: ChatCircle, color: "#A78BFA" },
  { id: "team", label: "Team", icon: UsersThree, color: "#60A5FA" },
  { id: "workflows", label: "Workflows", icon: GitBranch, color: "#34D399" },
  { id: "settings", label: "Settings", icon: Gear, color: "#F472B6" },
];

function splitTrimmed(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function summarizeList(values: string[] | null | undefined, emptyFallback: string): string {
  const entries = (values ?? []).map((value) => value.trim()).filter(Boolean);
  if (!entries.length) return emptyFallback;
  return entries.slice(0, 3).join(" · ");
}

function summarizeText(value: string | null | undefined, fallback: string): string {
  const normalized = value?.trim();
  if (!normalized) return fallback;
  return normalized.length > 180 ? `${normalized.slice(0, 177).trimEnd()}...` : normalized;
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
  const ctoDisplayName = "CTO";

  const laneId = useMemo(() => {
    if (selectedLaneId && lanes.some((lane) => lane.id === selectedLaneId)) return selectedLaneId;
    return lanes.find((lane) => lane.laneType === "primary")?.id ?? lanes[0]?.id ?? null;
  }, [lanes, selectedLaneId]);

  const selectedWorker = useMemo(
    () => (selectedAgentId ? agents.find((a) => a.id === selectedAgentId) ?? null : null),
    [agents, selectedAgentId],
  );

  const onboardingComplete = Boolean(onboardingState?.completedAt)
    || Boolean(onboardingState?.completedSteps.includes("identity"));

  // Onboarding detection
  const needsOnboarding = onboardingState
    && !onboardingComplete
    && !onboardingState.dismissedAt;

  const showBanner = onboardingState
    && !needsOnboarding
    && !onboardingComplete
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
      if (!obState.completedAt && !obState.completedSteps.includes("identity") && !obState.dismissedAt) {
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
        setActiveTab("workflows");
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

  const refreshPersistentCtoSession = useCallback(async () => {
    if (!window.ade?.cto || !laneId || showOnboarding || needsOnboarding) {
      return null;
    }
    const next = await window.ade.cto.ensureSession({ laneId });
    if (!selectedAgentId) {
      setSession(next);
    }
    return next;
  }, [laneId, needsOnboarding, selectedAgentId, showOnboarding]);

  const handleSaveCoreMemory = useCallback(async (patch: Record<string, unknown>) => {
    if (!window.ade?.cto) throw new Error("CTO bridge unavailable.");
    const snapshot = await window.ade.cto.updateCoreMemory({ patch });
    setCoreMemory(snapshot.coreMemory);
    await refreshPersistentCtoSession();
  }, [refreshPersistentCtoSession]);

  const handleSaveWorkerCoreMemory = useCallback(async (patch: Record<string, unknown>) => {
    if (!window.ade?.cto || !selectedAgentId) throw new Error("Select a worker first.");
    const updated = await window.ade.cto.updateAgentCoreMemory({ agentId: selectedAgentId, patch });
    setWorkerCoreMemory(updated);
  }, [selectedAgentId]);

  const handleSaveCtoIdentity = useCallback(async (patch: Record<string, unknown>) => {
    if (!window.ade?.cto) throw new Error("CTO bridge unavailable.");
    const snapshot = await window.ade.cto.updateIdentity({ patch });
    setCtoIdentity(snapshot.identity);
    await refreshPersistentCtoSession();
  }, [refreshPersistentCtoSession]);


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
      completedSteps: Array.from(new Set([...(current?.completedSteps ?? []), "identity"])),
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

  const teamStats = useMemo(() => {
    const counts = {
      total: agents.length,
      active: agents.filter((agent) => agent.status === "active").length,
      running: agents.filter((agent) => agent.status === "running").length,
      paused: agents.filter((agent) => agent.status === "paused").length,
    };
    return counts;
  }, [agents]);

  const persistentIdentityPresentation = useMemo<ChatSurfacePresentation>(() => ({
    mode: "standard",
    profile: "persistent_identity",
    modelSwitchPolicy: selectedWorker ? "same-family-after-launch" : "any-after-launch",
    title: selectedWorker ? selectedWorker.name : ctoDisplayName,
    subtitle: selectedWorker
      ? "Persistent employee session with durable memory and same-family model switching."
      : summarizeText(
          coreMemory?.projectSummary,
          "Your persistent CTO identity for this project. ADE restores continuity across compaction and fresh session resumes.",
        ),
    accentColor: selectedWorker ? "#60A5FA" : "#22D3EE",
    chips: [],
    showMcpStatus: false,
    assistantLabel: selectedWorker ? selectedWorker.name : ctoDisplayName,
    messagePlaceholder: selectedWorker ? `Message ${selectedWorker.name}...` : "Message the CTO...",
  }), [coreMemory?.projectSummary, ctoDisplayName, selectedWorker]);

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

  const bridgeSummary = useMemo(() => {
    if (!openclawStatus) return "Local ADE runtime";
    if (openclawStatus.state === "connected") return "Bridge connected";
    if (openclawStatus.state === "connecting" || openclawStatus.state === "reconnecting") return "Bridge warming up";
    return "Bridge offline";
  }, [openclawStatus]);

  const currentBrainSummary = useMemo(() => (
    session
      ? [session.provider, session.model].filter(Boolean).join(" / ")
      : selectedWorker
        ? [selectedWorker.adapterType, String((selectedWorker.adapterConfig as { model?: string } | null)?.model ?? "adaptive")].join(" / ")
        : [ctoIdentity?.modelPreferences.provider, ctoIdentity?.modelPreferences.model].filter(Boolean).join(" / ")
  ), [ctoIdentity?.modelPreferences.model, ctoIdentity?.modelPreferences.provider, selectedWorker, session]);

  const focusSummary = useMemo(() => (
    selectedWorker
      ? summarizeList(selectedWorker.capabilities, "Generalist execution")
      : summarizeList(coreMemory?.activeFocus, "No focus saved yet")
  ), [coreMemory?.activeFocus, selectedWorker]);

  const pageTitle = selectedWorker ? selectedWorker.name : ctoDisplayName;
  const pageSubtitle = selectedWorker
    ? summarizeText(
        selectedWorker.title || summarizeList(selectedWorker.capabilities, ""),
        "Persistent worker session with durable memory and delegated execution context.",
      )
    : summarizeText(
        coreMemory?.projectSummary,
        "Your persistent project CTO with layered memory, durable context, and full ADE reach.",
      );

  return (
    <div className={shellBodyCls}>
      {/* Onboarding wizard overlay */}
      {showOnboarding && (
        <OnboardingWizard
          onComplete={handleOnboardingComplete}
          onSkip={handleDismissOnboarding}
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

        {/* Minimal single-row header */}
        <div className="flex items-center gap-4 border-b border-white/[0.06] px-5 py-2.5">
          {/* Left: Avatar + name */}
          <div className="flex items-center gap-2.5 shrink-0">
            <div
              className="flex h-7 w-7 items-center justify-center rounded-lg border border-accent/20"
              style={{ background: "var(--color-accent-muted)" }}
            >
              <span className="text-xs font-bold text-accent">
                {pageTitle.charAt(0).toUpperCase()}
              </span>
            </div>
            <span className="text-sm font-semibold text-fg">{pageTitle}</span>
          </div>

          {/* Center: Tab buttons */}
          <div className="flex flex-1 items-center gap-1">
            {TABS.map(({ id, label, icon: Icon }) => {
              const active = activeTab === id;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => setActiveTab(id)}
                  className={cn(
                    "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-all duration-150",
                    active
                      ? "bg-accent/10 text-accent border border-accent/20"
                      : "text-muted-fg/50 hover:text-muted-fg/80 hover:bg-white/[0.03] border border-transparent",
                  )}
                >
                  <Icon size={13} weight={active ? "fill" : "regular"} />
                  {label}
                </button>
              );
            })}
          </div>

          {/* Right: Model badge */}
          {currentBrainSummary ? (
            <div className="shrink-0 rounded-md border border-white/[0.06] bg-white/[0.03] px-2.5 py-1 text-[10px] font-medium text-muted-fg/60">
              {currentBrainSummary}
            </div>
          ) : null}
        </div>

        {/* Tab content */}
        <div className="flex-1 min-h-0 overflow-hidden">
          {/* Chat tab */}
          <div className={cn("h-full min-h-0 flex-col p-4 pt-0", activeTab === "chat" ? "flex" : "hidden")}>
            {loading && <div className="px-1 py-2 text-xs text-muted-fg/55" data-testid="cto-loading">Connecting persistent session...</div>}
            {error && <div className="px-1 py-2 text-xs text-error" data-testid="cto-error">{error}</div>}
            {!laneId && (
              <div className="px-1 py-2 text-xs text-muted-fg/55" data-testid="cto-no-lane">
                Create a lane to start the persistent CTO session.
              </div>
            )}

            <div
              className="min-h-0 flex-1 overflow-hidden rounded-[24px] border border-white/[0.07]"
              style={{
                background: "radial-gradient(circle at top left, rgba(56,189,248,0.08), transparent 26%), linear-gradient(180deg, rgba(13,18,27,0.88), rgba(9,12,18,0.94))",
              }}
            >
              {showOnboarding || needsOnboarding ? (
                <div className="flex h-full items-center justify-center p-6 text-center">
                  <div className="max-w-sm space-y-3">
                    <div className="text-sm font-semibold text-fg">Complete setup to unlock the CTO session</div>
                    <div className="text-[12px] leading-6 text-muted-fg/42">
                      ADE needs the identity and long-term brief before it can keep the CTO stable across compaction and chat resumes.
                    </div>
                    <Button variant="primary" onClick={() => setShowOnboarding(true)}>
                      Continue setup
                    </Button>
                  </div>
                </div>
              ) : !session ? (
                <div className="flex h-full items-center justify-center p-6 text-center">
                  <div className="space-y-2">
                    <div className="text-sm font-medium text-fg/70">Connecting the persistent session…</div>
                    <div className="text-[12px] leading-6 text-muted-fg/40">
                      Rehydrating identity, memory, and recent continuity.
                    </div>
                  </div>
                </div>
              ) : (
                <AgentChatPane
                  laneId={laneId}
                  lockSessionId={session?.id ?? null}
                  initialSessionSummary={lockedSessionSummary}
                  hideSessionTabs
                  presentation={persistentIdentityPresentation}
                />
              )}
            </div>
          </div>

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
                  <div className="flex h-12 w-12 items-center justify-center rounded-2xl mb-4" style={{ background: "rgba(56, 189, 248, 0.12)", border: "1px solid rgba(56, 189, 248, 0.16)" }}>
                    <UsersThree size={22} weight="duotone" style={{ color: "#38BDF8" }} />
                  </div>
                  <div className="font-sans text-base font-semibold text-fg">No workers yet</div>
                  <div className="text-xs text-muted-fg/45 mt-1.5 text-center max-w-[36ch]">
                    Hire autonomous workers from templates or build custom ones.
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
                        <div className="font-sans text-sm font-semibold text-fg">Team Overview</div>
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
                          <div key={item.label} className={cn(cardCls, "p-4")}>
                            <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-fg/45">{item.label}</div>
                            <div className="mt-2 font-sans text-2xl font-bold text-fg">{item.value}</div>
                          </div>
                        ))}
                      </div>

                      <div className={cn(cardCls, "p-4")} data-testid="cto-subordinate-activity">
                        <div className="mb-3">
                          <div className="font-sans text-sm font-semibold text-fg">Recent Activity</div>
                        </div>
                        <div className="space-y-1">
                          {subordinateActivity.length === 0 ? (
                            <div className="py-4 font-sans text-xs text-muted-fg/40">No department activity recorded yet.</div>
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

          {/* Linear tab */}
          {activeTab === "workflows" && <LinearSyncPanel lanes={lanes} selectedLaneId={laneId} />}

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
