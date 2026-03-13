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
import { TimelineEntry } from "./shared/TimelineEntry";
import { cardCls, shellBodyCls, shellTabBarCls } from "./shared/designTokens";

/* ── Tab types ── */

type TabId = "chat" | "team" | "linear" | "settings";

const TABS: { id: TabId; label: string; icon: React.ElementType }[] = [
  { id: "chat", label: "Chat", icon: ChatCircle },
  { id: "team", label: "Team", icon: UsersThree },
  { id: "linear", label: "Linear", icon: GitBranch },
  { id: "settings", label: "Settings", icon: Gear },
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
      ? window.ade.cto.ensureAgentSession({ agentId: selectedAgentId, laneId, permissionMode: "full-auto" })
      : window.ade.cto.ensureSession({ laneId, permissionMode: "full-auto" });
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

  const persistentIdentityPresentation = useMemo<ChatSurfacePresentation>(() => ({
    mode: "standard",
    profile: "persistent_identity",
    title: selectedWorker ? selectedWorker.name : (ctoIdentity?.name?.trim() || "CTO"),
    subtitle: selectedWorker
      ? "Persistent employee session with durable memory and smooth model switching."
      : summarizeText(
          coreMemory?.projectSummary,
          "Always-on project operator with durable memory. You can swap models without changing who this agent is.",
        ),
    accentColor: selectedWorker ? "#60A5FA" : "#22D3EE",
    chips: selectedWorker
      ? [
        { label: "persistent memory", tone: "accent" },
        { label: "employee", tone: "info" },
        { label: session?.permissionMode === "full-auto" ? "full access" : "default permissions", tone: session?.permissionMode === "full-auto" ? "success" : "warning" },
      ]
      : [
        { label: "persistent memory", tone: "accent" },
        { label: "project operator", tone: "success" },
        { label: session?.permissionMode === "full-auto" ? "full access" : "default permissions", tone: session?.permissionMode === "full-auto" ? "success" : "warning" },
      ],
    showMcpStatus: false,
  }), [coreMemory?.projectSummary, ctoIdentity?.name, selectedWorker, session?.permissionMode]);

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

  const identitySummaryCards = useMemo(() => {
    const currentBrain = session
      ? [session.provider, session.model].filter(Boolean).join(" / ")
      : selectedWorker
        ? [selectedWorker.adapterType, String((selectedWorker.adapterConfig as { model?: string } | null)?.model ?? "adaptive")].join(" / ")
        : [ctoIdentity?.modelPreferences.provider, ctoIdentity?.modelPreferences.model].filter(Boolean).join(" / ");

    return [
      {
        label: "Current brain",
        value: currentBrain || "Adaptive runtime",
        detail: selectedWorker ? "You can swap models without resetting this employee's memory." : "Choose a new model anytime; the CTO identity stays intact.",
      },
      {
        label: "Access",
        value: session?.permissionMode === "full-auto" ? "Full access" : "Default permissions",
        detail: session ? `${capabilityLabel(session.capabilityMode)} runtime · ${bridgeSummary}` : bridgeSummary,
      },
      {
        label: selectedWorker ? "Worker focus" : "Memory focus",
        value: selectedWorker
          ? summarizeList(selectedWorker.capabilities, "Generalist execution")
          : summarizeList(coreMemory?.activeFocus, "Keeps durable project memory warm across sessions"),
        detail: selectedWorker
          ? summarizeText(selectedWorker.title || selectedWorker.role, "Persistent employee identity")
          : summarizeList(coreMemory?.criticalConventions, "Project conventions will accumulate here over time"),
      },
    ];
  }, [
    bridgeSummary,
    coreMemory?.activeFocus,
    coreMemory?.criticalConventions,
    ctoIdentity?.modelPreferences.model,
    ctoIdentity?.modelPreferences.provider,
    selectedWorker,
    session,
  ]);

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

        <div className="border-b border-white/[0.06] px-4 py-4">
          <div
            className="overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.03] shadow-float"
            style={{
              backgroundImage: "radial-gradient(circle at top left, rgba(34, 211, 238, 0.16), transparent 42%), radial-gradient(circle at bottom right, rgba(59, 130, 246, 0.12), transparent 44%)",
            }}
          >
            <div className="flex flex-col gap-5 px-5 py-5">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0 max-w-4xl">
                  <div className="font-mono text-[10px] font-bold uppercase tracking-[0.22em] text-cyan-300/80">
                    {selectedWorker ? "Persistent employee" : "Persistent CTO"}
                  </div>
                  <div className="mt-2 font-sans text-[26px] font-semibold tracking-[-0.02em] text-fg">
                    {selectedWorker ? selectedWorker.name : (ctoIdentity?.name?.trim() || "CTO")}
                  </div>
                  <div className="mt-2 max-w-3xl text-sm leading-6 text-fg/70">
                    {selectedWorker
                      ? summarizeText(
                          selectedWorker.title || selectedWorker.role,
                          "Long-running employee identity with durable memory, warm runtime continuity, and smooth model swaps.",
                        )
                      : summarizeText(
                          coreMemory?.projectSummary,
                          "Always-on project operator with durable memory, cross-model continuity, and a single long-lived session for the workspace.",
                        )}
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <Chip className="border-cyan-400/25 bg-cyan-500/10 text-[10px] text-cyan-100">Always on</Chip>
                  <Chip className="border-emerald-400/20 bg-emerald-500/10 text-[10px] text-emerald-100">
                    {session?.permissionMode === "full-auto" ? "Default: full access" : "Default permissions"}
                  </Chip>
                  <Chip className="border-white/10 bg-black/15 text-[10px] text-fg/70">{bridgeSummary}</Chip>
                  {laneId ? (
                    <Chip className="border-white/10 bg-black/15 text-[10px] text-fg/70">{`Lane ${laneId}`}</Chip>
                  ) : null}
                </div>
              </div>

              <div className="grid gap-3 lg:grid-cols-3">
                {identitySummaryCards.map((card) => (
                  <div
                    key={card.label}
                    className="rounded-xl border border-white/[0.08] bg-black/20 px-4 py-3 backdrop-blur"
                  >
                    <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-fg/45">{card.label}</div>
                    <div className="mt-2 text-sm font-semibold text-fg">{card.value}</div>
                    <div className="mt-1 text-xs leading-5 text-muted-fg/65">{card.detail}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Tab bar */}
        <div className={cn(shellTabBarCls, "px-4 py-3")} style={{ minHeight: 56 }}>
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setActiveTab(id)}
              className={cn(
                "flex items-center gap-2 rounded-full border px-3.5 py-2 font-mono text-[10px] font-semibold uppercase tracking-[0.18em] transition-all duration-150",
                activeTab === id
                  ? "border-cyan-400/25 bg-cyan-500/10 text-cyan-100"
                  : "border-transparent text-muted-fg/60 hover:border-white/10 hover:bg-white/[0.03] hover:text-fg",
              )}
            >
              <Icon size={14} weight={activeTab === id ? "bold" : "regular"} />
              {label}
            </button>
          ))}

          {/* Right side: agent context */}
          <div className="ml-auto flex items-center gap-2.5 pr-4">
            {session && (
              <Chip className={cn("text-[10px]", session.capabilityMode === "full_mcp" ? "text-success" : "text-warning")} data-testid="cto-capability-badge">
                {capabilityLabel(session.capabilityMode)}
              </Chip>
            )}
            <span className="font-mono text-xs text-muted-fg/50">
              {selectedWorker ? selectedWorker.name : "CTO"}
            </span>
          </div>
        </div>

        {/* Tab content */}
        <div className="flex-1 min-h-0 overflow-hidden">
          {/* Chat tab */}
          {activeTab === "chat" && (
            <div className="flex h-full min-h-0 flex-col p-4 pt-0">
              {loading && <div className="px-1 py-2 font-mono text-[10px] text-muted-fg/55" data-testid="cto-loading">Connecting persistent session...</div>}
              {error && <div className="px-1 py-2 font-mono text-[10px] text-error" data-testid="cto-error">{error}</div>}
              {!laneId && (
                <div className="px-1 py-2 font-mono text-[10px] text-muted-fg/55" data-testid="cto-no-lane">
                  Create a lane to start the persistent CTO session.
                </div>
              )}

              <div className="min-h-0 flex-1 overflow-hidden rounded-2xl border border-white/[0.06] bg-black/10">
                <AgentChatPane
                  laneId={laneId}
                  lockSessionId={session?.id ?? null}
                  initialSessionSummary={lockedSessionSummary}
                  hideSessionTabs
                  presentation={persistentIdentityPresentation}
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
                  <UsersThree size={48} weight="thin" className="text-muted-fg/15 mb-4" />
                  <div className="font-sans text-base font-bold text-fg">Your Team</div>
                  <div className="font-mono text-xs text-muted-fg/50 mt-2 text-center max-w-[44ch] leading-relaxed">
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
                          <div className="mt-1 font-mono text-xs text-muted-fg/50">
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
                          <div key={item.label} className={cn(cardCls, "p-4")}>
                            <div className="font-mono text-[10px] uppercase tracking-wide text-muted-fg/50">{item.label}</div>
                            <div className="mt-2 font-sans text-2xl font-bold text-fg">{item.value}</div>
                          </div>
                        ))}
                      </div>

                      <div className={cn(cardCls, "p-4")} data-testid="cto-subordinate-activity">
                        <div className="mb-3 flex items-center justify-between">
                          <div>
                            <div className="font-sans text-sm font-bold text-fg">Recent Department Activity</div>
                            <div className="mt-1 font-mono text-xs text-muted-fg/50">
                              Existing worker runs and direct worker chat activity flowing up to the CTO.
                            </div>
                          </div>
                        </div>
                        <div className="space-y-1">
                          {subordinateActivity.length === 0 ? (
                            <div className="py-4 font-mono text-xs text-muted-fg/40">No department activity recorded yet.</div>
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
