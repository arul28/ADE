import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Desktop, Gear, X } from "@phosphor-icons/react";
import type {
  AgentChatSession,
  AgentChatSessionSummary,
  ChatSurfacePresentation,
  CtoIdentity,
  CtoOnboardingState,
  CtoSessionLogEntry,
} from "../../../shared/types";
import { AgentChatPane } from "../chat/AgentChatPane";
import { useAppStore } from "../../state/appStore";
import { cn } from "../ui/cn";
import { CtoSettingsPanel } from "./CtoSettingsPanel";
import { CtoOnboardingCard } from "./CtoOnboardingCard";
import { getPersonalityTheme } from "./personalityTheme";
import { resolveModelSelection, useCtoModelOptions } from "./useCtoModelOptions";
import { resolveCtoPrimaryLaneId } from "./ctoSessionViewState";
import { shellBodyCls } from "./shared/designTokens";

const CTO_ACCENT = "#22D3EE";
const MAX_WAKING_RETRIES = 4;

// The CTO is a single project-level thread. There is only ever one session; the
// module-level cache keeps it warm across tab switches so re-entry is instant.
let ctoPrimarySession: AgentChatSession | null = null;

export function CtoPage({ active = true }: { active?: boolean } = {}) {
  const lanes = useAppStore((s) => s.lanes);

  const [session, setSession] = useState<AgentChatSession | null>(() => ctoPrimarySession);
  const [error, setError] = useState<string | null>(null);
  const [ctoIdentity, setCtoIdentity] = useState<CtoIdentity | null>(null);
  const [sessionLogs, setSessionLogs] = useState<CtoSessionLogEntry[]>([]);
  const [onboardingState, setOnboardingState] = useState<CtoOnboardingState | null>(null);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [switchingModel, setSwitchingModel] = useState(false);

  const historyLoadedRef = useRef(false);
  const wakingRetriesRef = useRef(0);

  const { availableModelIds, loadingModels, openProviderSettings } = useCtoModelOptions();

  const primaryLaneId = useMemo(() => resolveCtoPrimaryLaneId(lanes), [lanes]);

  const onboardingComplete = Boolean(onboardingState?.completedAt)
    || Boolean(onboardingState?.completedSteps.includes("identity"));
  const needsOnboarding = Boolean(
    onboardingState && !onboardingComplete && !onboardingState.dismissedAt,
  );
  const onboardingVisible = showOnboarding || needsOnboarding;

  const ctoDisplayName = ctoIdentity?.name?.trim() || "CTO";
  const personality = ctoIdentity?.personality ?? "strategic";
  const theme = getPersonalityTheme(personality);

  const currentModelId = session?.modelId
    ?? ctoIdentity?.modelPreferences.modelId
    ?? "";
  const currentReasoningEffort = session?.reasoningEffort
    ?? ctoIdentity?.modelPreferences.reasoningEffort
    ?? null;
  const currentFastMode = session?.fastMode === true;

  /* ── Data loading ── */

  const loadSummary = useCallback(async () => {
    if (!window.ade?.cto) return;
    try {
      const [snapshot, obState] = await Promise.all([
        window.ade.cto.getState({ recentLimit: 0 }),
        window.ade.cto.getOnboardingState(),
      ]);
      setCtoIdentity(snapshot.identity);
      setOnboardingState(obState);
    } catch {
      // Non-fatal: keep the waking state and let the session/lane effects retry.
      setOnboardingState((prev) => prev ?? { completedSteps: [] });
    }
  }, []);

  const loadHistory = useCallback(async () => {
    if (!window.ade?.cto) return;
    try {
      const snapshot = await window.ade.cto.getState({ recentLimit: 20 });
      setCtoIdentity(snapshot.identity);
      setSessionLogs(snapshot.recentSessions);
      historyLoadedRef.current = true;
    } catch {
      // non-fatal
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    void loadSummary();
  }, [active, loadSummary]);

  useEffect(() => {
    if (!active || !settingsOpen || historyLoadedRef.current) return;
    void loadHistory();
  }, [active, settingsOpen, loadHistory]);

  // Ensure the persistent session. Re-runs when the primary lane hydrates (D6
  // race) so a slow lanes store shows the waking state, never an error card.
  useEffect(() => {
    if (!active || !window.ade?.cto) return;
    if (!onboardingState || onboardingVisible || !primaryLaneId) return;

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    if (ctoPrimarySession) setSession(ctoPrimarySession);
    setError(null);

    const attempt = () => {
      void window.ade.cto!.ensureSession()
        .then((next) => {
          if (cancelled) return;
          ctoPrimarySession = next;
          wakingRetriesRef.current = 0;
          setSession(next);
        })
        .catch((err) => {
          if (cancelled) return;
          if (wakingRetriesRef.current < MAX_WAKING_RETRIES) {
            wakingRetriesRef.current += 1;
            retryTimer = setTimeout(attempt, 800);
          } else {
            setError(err instanceof Error ? err.message : String(err));
          }
        });
    };
    attempt();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [active, onboardingState, onboardingVisible, primaryLaneId]);

  /* ── Callbacks ── */

  const refreshSession = useCallback(async () => {
    if (!window.ade?.cto || !primaryLaneId || onboardingVisible) return null;
    const next = await window.ade.cto.ensureSession();
    ctoPrimarySession = next;
    setSession(next);
    return next;
  }, [onboardingVisible, primaryLaneId]);

  const handleSaveIdentity = useCallback(async (patch: Record<string, unknown>) => {
    if (!window.ade?.cto) throw new Error("The CTO isn't available right now.");
    const snapshot = await window.ade.cto.updateIdentity({ patch });
    setCtoIdentity(snapshot.identity);
    await refreshSession();
  }, [refreshSession]);

  // Settings owns model selection for the CTO. With a live session it moves the
  // running thread via updateSession, which also persists the choice into
  // identity prefs. Before the session exists it writes identity prefs so
  // ensureSession reconciles the model in.
  const handleModelChange = useCallback(async (modelId: string, reasoningEffort: string | null) => {
    if (!window.ade?.cto || switchingModel) return;
    const selection = resolveModelSelection(modelId, reasoningEffort);
    if (!selection) return;
    setSwitchingModel(true);
    setError(null);
    try {
      if (session) {
        const updated = await window.ade.agentChat.updateSession({
          sessionId: session.id,
          modelId: selection.modelId,
          reasoningEffort: selection.reasoningEffort,
          fastMode: selection.supportsFastMode && currentFastMode,
        });
        ctoPrimarySession = updated;
        setSession(updated);
      } else {
        await window.ade.cto.updateIdentity({
          patch: {
            modelPreferences: {
              provider: selection.provider,
              model: selection.model,
              modelId: selection.modelId,
              reasoningEffort: selection.reasoningEffort,
            },
          },
        });
        await refreshSession();
      }
      const snap = await window.ade.cto.getState({ recentLimit: 0 });
      setCtoIdentity(snap.identity);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't switch the model.");
    } finally {
      setSwitchingModel(false);
    }
  }, [currentFastMode, refreshSession, session, switchingModel]);

  const handleFastModeChange = useCallback(async (enabled: boolean) => {
    if (!window.ade?.cto || switchingModel) return;
    setSwitchingModel(true);
    setError(null);
    try {
      const targetSession = session ?? await refreshSession();
      if (!targetSession) throw new Error("The CTO chat is still waking up.");
      const updated = await window.ade.agentChat.updateSession({
        sessionId: targetSession.id,
        fastMode: enabled,
      });
      ctoPrimarySession = updated;
      setSession(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't update Fast mode.");
    } finally {
      setSwitchingModel(false);
    }
  }, [refreshSession, session, switchingModel]);

  const handleOnboardingComplete = useCallback(async () => {
    setShowOnboarding(false);
    await loadSummary();
  }, [loadSummary]);

  const handleOnboardingSkip = useCallback(async () => {
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
      await loadSummary();
    } catch {
      // Let the user continue even if persistence fails.
    }
  }, [loadSummary]);

  const handleResetOnboarding = useCallback(async () => {
    if (!window.ade?.cto) return;
    setSettingsOpen(false);
    await window.ade.cto.resetOnboarding();
    setShowOnboarding(true);
    await loadSummary();
  }, [loadSummary]);

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
      fastMode: session.fastMode === true,
      executionMode: session.executionMode ?? null,
      identityKey: session.identityKey,
      capabilityMode: session.capabilityMode,
      status: session.status,
      startedAt: session.createdAt,
      endedAt: session.status === "ended" ? session.lastActivityAt : null,
      lastActivityAt: session.lastActivityAt,
      lastOutputPreview: null,
      summary: null,
      nextWakeAt: null,
      threadId: session.threadId,
    };
  }, [session]);

  const presentation = useMemo<ChatSurfacePresentation>(() => ({
    mode: "standard",
    profile: "persistent_identity",
    title: ctoDisplayName,
    subtitle: "Your persistent CTO for this project. It keeps its memory across model switches and compaction.",
    accentColor: CTO_ACCENT,
    chips: [],
    showMcpStatus: false,
    assistantLabel: ctoDisplayName,
    messagePlaceholder: `Message ${ctoDisplayName}…`,
  }), [ctoDisplayName]);

  /* ── Render ── */

  const bridgeMissing = active && typeof window !== "undefined" && !window.ade?.cto;

  // First-run: a single setup card owns the whole surface.
  if (!bridgeMissing && onboardingVisible && onboardingState) {
    return (
      <div className={cn(shellBodyCls, "flex-col")}>
        <CtoOnboardingCard onComplete={handleOnboardingComplete} onSkip={handleOnboardingSkip} />
      </div>
    );
  }

  const avatarInitial = ctoDisplayName.charAt(0).toUpperCase();
  const sessionReady = Boolean(session) && Boolean(primaryLaneId);

  return (
    <div className={cn(shellBodyCls, "relative flex-col")}>
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-white/[0.06] px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <div
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[11px] font-bold"
            style={{
              background: `rgba(${theme.rgb}, 0.14)`,
              border: `1px solid rgba(${theme.rgb}, 0.32)`,
              color: theme.hex,
            }}
          >
            {avatarInitial}
          </div>
          <span className="truncate text-[13px] font-semibold text-fg">{ctoDisplayName}</span>
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-2">
          {/* The CTO thread is pinned to the local primary lane by design, so
              the machine is stated as a fact — never offered as a choice. */}
          <span
            data-testid="cto-machine-indicator"
            title="The CTO thread is pinned to This Mac and cannot be moved."
            className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md border border-dashed border-white/[0.12] px-2 font-sans text-[10px] font-medium text-muted-fg/55"
            style={{ whiteSpace: "nowrap" }}
          >
            <Desktop size={11} aria-hidden />
            Always runs on This Mac
          </span>
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            aria-label="CTO settings"
            className={cn(
              "flex h-7 w-7 items-center justify-center rounded-lg border transition-colors",
              settingsOpen
                ? "border-white/15 bg-white/[0.06] text-fg"
                : "border-white/[0.07] text-muted-fg/55 hover:bg-white/[0.04] hover:text-fg",
            )}
          >
            <Gear size={15} weight={settingsOpen ? "fill" : "regular"} />
          </button>
        </div>
      </div>

      {/* Thread / waking */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {bridgeMissing ? (
          <WakingState theme={theme} title="The CTO isn't available" subtitle="Reopen ADE to reconnect." />
        ) : sessionReady && lockedSessionSummary && primaryLaneId ? (
          <AgentChatPane
            laneId={primaryLaneId}
            lockSessionId={session?.id ?? null}
            initialSessionSummary={lockedSessionSummary}
            hideSessionTabs
            hideNativeControls
            hideModelControls
            hideWorkspaceChrome
            hideSurfaceHeader
            presentation={presentation}
          />
        ) : error ? (
          <WakingState theme={theme} title="Couldn't reach the CTO" subtitle={error} />
        ) : (
          <WakingState
            theme={theme}
            title="Waking the CTO"
            subtitle="Restoring identity, memory, and recent context."
            pulsing
          />
        )}
      </div>

      {/* Settings overlay */}
      {settingsOpen && (
        <>
          <button
            type="button"
            aria-label="Close settings"
            onClick={() => setSettingsOpen(false)}
            className="absolute inset-0 z-30 cursor-default bg-black/40"
          />
          <div
            role="dialog"
            aria-label="CTO settings"
            className="absolute inset-y-0 right-0 z-40 flex w-[440px] max-w-full flex-col border-l border-white/[0.08] bg-[#0C0B12] shadow-[-16px_0_44px_rgba(0,0,0,0.5)]"
          >
            <div className="flex items-center justify-between border-b border-white/[0.07] px-5 py-3">
              <div className="text-[13px] font-semibold text-fg">Settings</div>
              <button
                type="button"
                onClick={() => setSettingsOpen(false)}
                aria-label="Close settings"
                className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-fg/55 transition-colors hover:bg-white/[0.05] hover:text-fg"
              >
                <X size={15} />
              </button>
            </div>
            <CtoSettingsPanel
              identity={ctoIdentity}
              sessionLogs={sessionLogs}
              currentModelId={currentModelId}
              currentReasoningEffort={currentReasoningEffort}
              currentFastMode={currentFastMode}
              availableModelIds={availableModelIds}
              loadingModels={loadingModels}
              switchingModel={switchingModel}
              onSaveIdentity={handleSaveIdentity}
              onModelChange={(modelId, reasoningEffort) => void handleModelChange(modelId, reasoningEffort)}
              onFastModeChange={(enabled) => void handleFastModeChange(enabled)}
              onOpenProviderSettings={openProviderSettings}
              onResetOnboarding={handleResetOnboarding}
            />
          </div>
        </>
      )}
    </div>
  );
}

function WakingState({
  theme,
  title,
  subtitle,
  pulsing = false,
}: {
  theme: ReturnType<typeof getPersonalityTheme>;
  title: string;
  subtitle: string;
  pulsing?: boolean;
}) {
  const Icon = theme.icon;
  return (
    <div className="flex h-full items-center justify-center p-6" data-testid="cto-waking">
      <div className="flex flex-col items-center text-center">
        <div
          className={cn(
            "flex h-12 w-12 items-center justify-center rounded-2xl",
            pulsing && "motion-safe:animate-pulse",
          )}
          style={{
            background: `rgba(${theme.rgb}, 0.12)`,
            border: `1px solid rgba(${theme.rgb}, 0.28)`,
          }}
        >
          <Icon size={20} weight="duotone" style={{ color: theme.hex }} />
        </div>
        <div className="mt-4 text-[14px] font-semibold text-fg">{title}</div>
        <div className="mt-1 max-w-xs text-[12.5px] leading-5 text-muted-fg/50">{subtitle}</div>
      </div>
    </div>
  );
}
