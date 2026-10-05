import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Gear, Robot, Strategy } from "@phosphor-icons/react";
import type {
  AgentChatSession,
  AgentChatSessionSummary,
  ChatSurfacePresentation,
  CtoIdentity,
  CtoSessionLogEntry,
  CtoSnapshot,
  CtoStartFreshSessionResult,
  CtoThreadHealth,
} from "../../../shared/types";
import { AgentChatPane } from "../chat/AgentChatPane";
import type { ComposerMachineChipAction } from "../chat/AgentChatComposer";
import { useChatMachineLanes } from "../chat/ChatRuntimeScope";
import { selectActiveProjectStateKey, useAppStore } from "../../state/appStore";
import { pinKey } from "../../state/projectMachines";
import { CtoHomeChooser } from "./CtoHomeChooser";
import { CtoHomeProvider, useCtoHome, type CtoHomeScope } from "./useCtoHome";
import { cn } from "../ui/cn";
import { CtoSettingsPage, type CtoIdentityPatch } from "./CtoSettingsPage";
import { ctoModelSupportsLiveRedirect, resolveModelSelection, useCtoModelOptions } from "./useCtoModelOptions";
import { ModelPicker } from "../shared/ModelPicker/ModelPicker";
import { resolveCtoPrimaryLaneId } from "./ctoSessionViewState";
import { shellBodyCls } from "./shared/designTokens";
import { TechnicalDetailsFold } from "../app/errorSurfaceKit";

const CTO_ACCENT = "#22D3EE";
/** `CTO_ACCENT` as an "r, g, b" triplet, for the rgba() tints below. */
const CTO_ACCENT_RGB = "34, 211, 238";
const MAX_WAKING_RETRIES = 4;

// The CTO is a single project-level thread on its home machine. The cache keeps
// it warm across tab switches so re-entry is instant. Keyed by project tab AND
// home machine: a session read from one machine must never be shown (or written
// to) as another machine's CTO after the home moves or the tab changes.
const ctoPrimarySessions = new Map<string, AgentChatSession>();

/**
 * Reads the home machine's cross-machine capability off its CTO snapshot
 * (`capabilities.crossMachine`, set by the brain).
 *
 * The field is new, so an older home machine's snapshot lacks it entirely.
 * Absent is read as "no": that build cannot reach other machines.
 */
function readCrossMachineCapability(snapshot: Pick<CtoSnapshot, "capabilities"> | null | undefined): boolean {
  return snapshot?.capabilities?.crossMachine === true;
}

export function CtoPage({ active = true }: { active?: boolean } = {}) {
  const ctoHome = useCtoHome(active);
  const homeReady = ctoHome.status === "ready";
  /** Every CTO call carries this. Null = the tab's binding is the home. */
  const ctoPin = ctoHome.pin;
  const scopeKey = useAppStore(selectActiveProjectStateKey);
  const sessionCacheKey = `${scopeKey ?? ""}|${pinKey(ctoPin)}`;
  // The home machine's lanes, not the tab's: the CTO's primary lane is there.
  const lanes = useChatMachineLanes(ctoPin);
  const [chooserOpen, setChooserOpen] = useState(false);
  /**
   * Whether the home machine's ADE can reach the account's other machines.
   * Null until its snapshot answers; false for a build that predates it.
   */
  const [homeCrossMachine, setHomeCrossMachine] = useState<boolean | null>(null);
  /** The CTO the page is showing now; a read answered for another is dropped. */
  const lastCacheKeyRef = useRef(sessionCacheKey);
  const isCurrentCto = (key: string) => lastCacheKeyRef.current === key;

  const [session, setSession] = useState<AgentChatSession | null>(() => ctoPrimarySessions.get(sessionCacheKey) ?? null);
  const [error, setError] = useState<string | null>(null);
  // Bumped by "Try again" on the failure pane; re-runs the wake effect from a
  // clean retry budget instead of leaving the user stranded on the error.
  const [wakeAttempt, setWakeAttempt] = useState(0);
  const [ctoIdentity, setCtoIdentity] = useState<CtoIdentity | null>(null);
  const [sessionLogs, setSessionLogs] = useState<CtoSessionLogEntry[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [switchingModel, setSwitchingModel] = useState(false);
  /**
   * Whether ADE thinks this thread should be rotated, and whether it can still
   * answer at all. Read-only: `getThreadHealth` never materializes a session,
   * so asking is safe before the thread exists.
   */
  const [threadHealth, setThreadHealth] = useState<CtoThreadHealth | null>(null);
  /** The owner said "not now". Kept per thread, so a new one asks again. */
  const [rotationDismissedFor, setRotationDismissedFor] = useState<string | null>(null);
  const [rotating, setRotating] = useState(false);

  const historyLoadedRef = useRef(false);
  const wakingRetriesRef = useRef(0);

  const { availableModelIds, loadingModels, openProviderSettings } = useCtoModelOptions(ctoPin);

  const primaryLaneId = useMemo(() => resolveCtoPrimaryLaneId(lanes), [lanes]);

  const ctoDisplayName = ctoIdentity?.name?.trim() || "CTO";

  const currentModelId = session?.modelId
    ?? ctoIdentity?.modelPreferences?.modelId
    ?? "";
  const currentReasoningEffort = session?.reasoningEffort
    ?? ctoIdentity?.modelPreferences?.reasoningEffort
    ?? null;
  const currentFastMode = session?.fastMode === true;
  // Null preferences mean nobody has picked a model the CTO can actually run
  // on. The picker takes the thread's place until one is chosen — the session
  // itself is untouched, so a pick resumes the same thread rather than a new one.
  const needsModelPick = Boolean(ctoIdentity) && !ctoIdentity?.modelPreferences;
  // A null identity means the snapshot has not landed yet — it is not a CTO
  // that happens to have a model. Waking on it would materialize the session
  // ahead of the picker, which is the one thing the pick gate exists to stop.
  const identityLoaded = Boolean(ctoIdentity);

  /* ── Data loading ── */

  const loadSummary = useCallback(async () => {
    if (!window.ade?.cto || !homeReady) return;
    const key = sessionCacheKey;
    try {
      const snapshot = await window.ade.cto.getState({ recentLimit: 0 }, ctoPin);
      if (isCurrentCto(key)) {
        setCtoIdentity(snapshot.identity);
        setHomeCrossMachine(readCrossMachineCapability(snapshot));
      }
    } catch {
      // Non-fatal: keep the waking state and let the session/lane effects retry.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- isCurrentCto reads a ref
  }, [ctoPin, homeReady, sessionCacheKey]);

  const loadHistory = useCallback(async () => {
    if (!window.ade?.cto || !homeReady) return;
    const key = sessionCacheKey;
    try {
      const snapshot = await window.ade.cto.getState({ recentLimit: 20 }, ctoPin);
      if (!isCurrentCto(key)) return;
      setCtoIdentity(snapshot.identity);
      setSessionLogs(snapshot.recentSessions);
      historyLoadedRef.current = true;
    } catch {
      // non-fatal
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- isCurrentCto reads a ref
  }, [ctoPin, homeReady, sessionCacheKey]);

  /**
   * Ask whether this thread is running out of room.
   *
   * Same cadence as the snapshot above — on entering the tab, and again
   * whenever the session identity changes — rather than a timer. The banner is
   * an offer, not an alarm, so it does not need to be true to the second.
   */
  const loadThreadHealth = useCallback(async () => {
    if (!window.ade?.cto?.getThreadHealth || !homeReady) return;
    const key = sessionCacheKey;
    try {
      const health = await window.ade.cto.getThreadHealth(ctoPin);
      if (isCurrentCto(key)) setThreadHealth(health);
    } catch {
      // Non-fatal: no banner is better than an error about a banner.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- isCurrentCto reads a ref
  }, [ctoPin, homeReady, sessionCacheKey]);

  // A different home (or tab) is a different CTO. Drop everything read from
  // the previous one before anything reads from the new one.
  useEffect(() => {
    if (lastCacheKeyRef.current === sessionCacheKey) return;
    lastCacheKeyRef.current = sessionCacheKey;
    setSession(ctoPrimarySessions.get(sessionCacheKey) ?? null);
    setCtoIdentity(null);
    setSessionLogs([]);
    setThreadHealth(null);
    setHomeCrossMachine(null);
    setError(null);
    historyLoadedRef.current = false;
    wakingRetriesRef.current = 0;
  }, [sessionCacheKey]);

  useEffect(() => {
    if (!active) return;
    void loadSummary();
  }, [active, loadSummary]);

  useEffect(() => {
    if (!active) return;
    void loadThreadHealth();
  }, [active, loadThreadHealth, session?.id]);

  useEffect(() => {
    if (!active || !settingsOpen || historyLoadedRef.current) return;
    void loadHistory();
  }, [active, settingsOpen, loadHistory]);

  // Ensure the persistent session. Re-runs when the primary lane hydrates (D6
  // race) so a slow lanes store shows the waking state, never an error card.
  useEffect(() => {
    if (!active || !window.ade?.cto || !homeReady) return;
    if (!identityLoaded || needsModelPick || !primaryLaneId) return;

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const cached = ctoPrimarySessions.get(sessionCacheKey);
    if (cached) setSession(cached);
    setError(null);

    const attempt = () => {
      void window.ade.cto!.ensureSession({}, ctoPin)
        .then((next) => {
          if (cancelled) return;
          ctoPrimarySessions.set(sessionCacheKey, next);
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
  }, [active, ctoPin, homeReady, identityLoaded, needsModelPick, primaryLaneId, sessionCacheKey, wakeAttempt]);

  /* ── Callbacks ── */

  const refreshSession = useCallback(async () => {
    if (!window.ade?.cto || !primaryLaneId || !homeReady) return null;
    const next = await window.ade.cto.ensureSession({}, ctoPin);
    ctoPrimarySessions.set(sessionCacheKey, next);
    setSession(next);
    return next;
  }, [ctoPin, homeReady, primaryLaneId, sessionCacheKey]);

  /**
   * Settings owns model selection for the CTO.
   *
   * The identity preference is the DURABLE record of the choice, and it is
   * written every time — with a live session as well as without one. Leaving it
   * to `updateSession` to persist on the way through does not hold: the page
   * shows the live session's model, so a preference that silently stayed behind
   * is invisible until the next fresh thread is created on a smaller model at a
   * lower reasoning tier than the one on screen.
   *
   * Preference first, session second, so a failure between them leaves the
   * durable record holding what the user picked rather than what they replaced.
   */
  const handleModelChange = useCallback(async (modelId: string, reasoningEffort: string | null) => {
    if (!window.ade?.cto || switchingModel || !homeReady) return;
    const selection = resolveModelSelection(modelId, reasoningEffort);
    if (!selection) return;
    // Fast mode is a property of the model, not of the picker: carrying a true
    // onto a model that has no fast tier asks the chat service for a mode that
    // does not exist there.
    const nextFastMode = currentFastMode && selection.supportsFastMode;
    setSwitchingModel(true);
    setError(null);
    try {
      await window.ade.cto.updateIdentity({
        patch: {
          modelPreferences: {
            provider: selection.provider,
            model: selection.model,
            modelId: selection.modelId,
            reasoningEffort: selection.reasoningEffort,
          },
        },
      }, ctoPin);
      if (session) {
        const modelUpdate = selection.modelId === session.modelId
          ? { reasoningEffort: selection.reasoningEffort }
          : {};
        const updated = await window.ade.agentChat.updateSession({
          sessionId: session.id,
          modelId: selection.modelId,
          ...modelUpdate,
          fastMode: nextFastMode,
        }, ctoPin);
        ctoPrimarySessions.set(sessionCacheKey, updated);
        setSession(updated);
      } else {
        await refreshSession();
      }
      const snap = await window.ade.cto.getState({ recentLimit: 0 }, ctoPin);
      setCtoIdentity(snap.identity);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't switch the model.");
    } finally {
      setSwitchingModel(false);
    }
  }, [ctoPin, currentFastMode, homeReady, refreshSession, session, sessionCacheKey, switchingModel]);

  /**
   * Save the name and the standing instructions.
   *
   * `updateIdentity` answers the whole snapshot, so the local copy is replaced
   * rather than patched — a merge here would drift from whatever the service
   * normalized on the way in.
   */
  const handleIdentityChange = useCallback(async (patch: CtoIdentityPatch) => {
    if (!window.ade?.cto || !homeReady) return;
    setError(null);
    try {
      const snapshot = await window.ade.cto.updateIdentity({ patch }, ctoPin);
      setCtoIdentity(snapshot.identity);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save the CTO's identity.");
    }
  }, [ctoPin, homeReady]);

  const handleFastModeChange = useCallback(async (enabled: boolean) => {
    if (!window.ade?.cto || switchingModel || !homeReady) return;
    setSwitchingModel(true);
    setError(null);
    try {
      const targetSession = session ?? await refreshSession();
      if (!targetSession) throw new Error("The CTO chat is still waking up.");
      const updated = await window.ade.agentChat.updateSession({
        sessionId: targetSession.id,
        fastMode: enabled,
      }, ctoPin);
      ctoPrimarySessions.set(sessionCacheKey, updated);
      setSession(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't update Fast mode.");
    } finally {
      setSwitchingModel(false);
    }
  }, [ctoPin, homeReady, refreshSession, session, sessionCacheKey, switchingModel]);

  /**
   * Retire the thread and open a fresh one.
   *
   * ADE never does this on its own: every caller is a button the owner pressed.
   * The module-level cache is dropped first, because the session it holds is
   * the one that was just retired.
   */
  const handleStartFreshSession = useCallback(async (): Promise<CtoStartFreshSessionResult> => {
    const startFresh = window.ade?.cto?.startFreshSession;
    if (!startFresh) throw new Error("The CTO isn't available in this window.");
    if (!homeReady) throw new Error("The CTO's machine isn't reachable right now.");
    setRotating(true);
    try {
      const result = await startFresh(ctoPin);
      ctoPrimarySessions.delete(sessionCacheKey);
      setSession(null);
      setRotationDismissedFor(null);
      historyLoadedRef.current = false;
      wakingRetriesRef.current = 0;
      setError(null);
      setWakeAttempt((n) => n + 1);
      await loadSummary();
      await loadThreadHealth();
      return result;
    } finally {
      setRotating(false);
    }
  }, [ctoPin, homeReady, loadSummary, loadThreadHealth, sessionCacheKey]);

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

  const sessionReady = Boolean(session) && Boolean(primaryLaneId);

  /**
   * The offer to rotate, and the one rule about it: ADE never rotates on its
   * own. It is advice with a button, dismissible per thread, and it stays out
   * of the way while settings is the thing on screen.
   */
  const showRotationPrompt = homeReady
    && Boolean(threadHealth?.rotationAdvised)
    && !settingsOpen
    && rotationDismissedFor !== (threadHealth?.sessionId ?? "none");

  const showChooser = ctoHome.status === "choose" || chooserOpen;
  const otherMachineCount = ctoHome.machines.filter((machine) => !machine.isThisMachine).length;
  const homeLabel = ctoHome.homeName ?? "this machine";
  const machineChipAction = useMemo<ComposerMachineChipAction>(() => ({
    tooltip: `Runs on ${homeLabel}. Click to change.`,
    offline: ctoHome.status === "offline",
    // A home machine on an ADE build without the cross-machine tools answers
    // "I can't reach other machines". Only worth saying when there are others.
    // This computer runs the build that is showing this page, so the hint is
    // only ever about another home machine.
    note: homeCrossMachine === false && otherMachineCount > 0 && ctoHome.home?.isThisMachine !== true
      ? `Update ADE on ${homeLabel} to let the CTO reach your other machines.`
      : null,
    onClick: () => {
      setSettingsOpen(false);
      setChooserOpen(true);
    },
  }), [ctoHome.home?.isThisMachine, ctoHome.status, homeCrossMachine, homeLabel, otherMachineCount]);
  const homeScope = useMemo<CtoHomeScope>(
    () => ({ pin: ctoPin, machineName: ctoHome.homeName, ready: homeReady }),
    [ctoHome.homeName, ctoPin, homeReady],
  );

  return (
    <CtoHomeProvider scope={homeScope}>
    <div className={cn(shellBodyCls, "relative flex-col")}>
      {/* Header */}
      <div className="flex shrink-0 flex-col">
        {/* One header line with the sidebar's tab row: same height, same hairline. */}
        <div className="ade-page-rail relative gap-3 px-3">
          {/* The name sits in the middle of the bar, like the Work chat title. */}
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 px-24">
            {/* The same glyph as the sidebar and as iOS, not the first character
                of whatever the user renamed the CTO to. One mark, every surface. */}
            <Robot size={16} weight="regular" className="shrink-0" style={{ color: CTO_ACCENT }} />
            <span className="truncate text-[13px] font-semibold text-fg">{ctoDisplayName}</span>
          </div>


          <div className="ml-auto flex shrink-0 items-center gap-2">
            <button
              type="button"
              disabled={!homeReady}
              onClick={() => setSettingsOpen(true)}
              aria-label="CTO settings"
              className={cn(
                "flex h-6 w-6 items-center justify-center transition-colors",
                settingsOpen ? "text-fg" : "text-muted-fg/55 hover:text-fg",
              )}
            >
              <Gear size={13} weight={settingsOpen ? "fill" : "regular"} />
            </button>
          </div>
        </div>
      </div>

      {showRotationPrompt && threadHealth ? (
        <CtoRotationPrompt
          blocked={!threadHealth.canTakeTurn}
          busy={rotating}
          onStart={() => { void handleStartFreshSession().catch(() => {}); }}
          onDismiss={() => setRotationDismissedFor(threadHealth.sessionId ?? "none")}
        />
      ) : null}

      {settingsOpen && homeReady && !showChooser ? (
        <CtoSettingsPage
          active={active}
          identity={ctoIdentity}
          sessionLogs={sessionLogs}
          currentModelId={currentModelId}
          currentReasoningEffort={currentReasoningEffort}
          currentFastMode={currentFastMode}
          availableModelIds={availableModelIds}
          loadingModels={loadingModels}
          switchingModel={switchingModel}
          onModelChange={(modelId, reasoningEffort) => void handleModelChange(modelId, reasoningEffort)}
          onFastModeChange={(enabled) => void handleFastModeChange(enabled)}
          onOpenProviderSettings={openProviderSettings}
          onStartFreshSession={handleStartFreshSession}
          onIdentityChange={(patch) => void handleIdentityChange(patch)}
          crossMachineAvailable={homeCrossMachine === true}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}

      {/* Thread / waking */}
      <div className={cn("min-h-0 flex-1 overflow-hidden", settingsOpen && homeReady && !showChooser && "hidden")}>
        {bridgeMissing ? (
          <WakingState title="The CTO isn't available" subtitle="Reopen ADE to reconnect." />
        ) : showChooser ? (
          <CtoHomeChooser
            machines={ctoHome.machines}
            suggested={ctoHome.suggested}
            current={chooserOpen ? ctoHome.home : null}
            currentName={chooserOpen ? ctoHome.homeName : null}
            onChoose={async (machine) => {
              await ctoHome.choose(machine);
              setChooserOpen(false);
            }}
            onCancel={chooserOpen ? () => setChooserOpen(false) : undefined}
          />
        ) : ctoHome.status === "loading" ? (
          <WakingState title="Opening the CTO" pulsing />
        ) : ctoHome.status === "offline" ? (
          <WakingState
            title={`The CTO runs on ${ctoHome.homeName ?? "another machine"}`}
            subtitle={`${ctoHome.offlineReason ?? "It can't be reached right now."} Its memory, team and thread are safe there, and the CTO picks up where it left off once it's back.`}
            action={{ label: "Run it somewhere else", onClick: () => setChooserOpen(true) }}
          />
        ) : needsModelPick ? (
          <ModelPickCard
            availableModelIds={availableModelIds}
            loadingModels={loadingModels}
            switchingModel={switchingModel}
            error={error}
            onPick={(modelId) => void handleModelChange(modelId, currentReasoningEffort)}
            onOpenProviderSettings={openProviderSettings}
          />
        ) : sessionReady && lockedSessionSummary && primaryLaneId ? (
          <AgentChatPane
            laneId={primaryLaneId}
            // The CTO's thread lives on its home machine; send, history and the
            // drawer must stay there rather than follow the tab's binding.
            runtimePin={ctoPin}
            lockSessionId={session?.id ?? null}
            lockSessionProvider={lockedSessionSummary.provider ?? null}
            initialSessionSummary={lockedSessionSummary}
            hideSessionTabs
            hideNativeControls
            hideModelControls
            hideWorkspaceChrome
            hideSurfaceHeader
            presentation={presentation}
            // The chip that says where this chat runs is where the CTO's home
            // machine is changed; the header does not repeat it.
            machineChipAction={machineChipAction}
          />
        ) : error ? (
          <WakingState
            title="Couldn't reach the CTO"
            subtitle="ADE tried a few times and the CTO didn't answer. Nothing was lost — your thread is still here."
            detail={error}
            action={{
              label: "Try again",
              onClick: () => {
                wakingRetriesRef.current = 0;
                setError(null);
                setWakeAttempt((n) => n + 1);
              },
            }}
          />
        ) : (
          <WakingState
            title="Opening the CTO"
            pulsing
          />
        )}
      </div>

    </div>
    </CtoHomeProvider>
  );
}

/**
 * The CTO's welcome screen, and the one decision first run asks for.
 *
 * There is no setup wizard: personality, work style and name are not choices
 * any more, and the only thing ADE genuinely cannot infer is which model should
 * do the thinking. So the CTO introduces itself in its own voice and the picker
 * is the reply affordance — a first turn, not a form.
 */
function ModelPickCard({
  availableModelIds,
  loadingModels,
  switchingModel,
  error,
  onPick,
  onOpenProviderSettings,
}: {
  availableModelIds: string[];
  loadingModels: boolean;
  switchingModel: boolean;
  error: string | null;
  onPick: (modelId: string) => void;
  onOpenProviderSettings: () => void;
}) {
  return (
    <div className="flex h-full items-center justify-center p-6" data-testid="cto-model-pick">
      <div className="flex w-full max-w-[460px] flex-col">
        <div className="flex items-center gap-2.5">
          <div
            className="flex h-9 w-9 items-center justify-center rounded-xl"
            style={{
              background: `rgba(${CTO_ACCENT_RGB}, 0.12)`,
              border: `1px solid rgba(${CTO_ACCENT_RGB}, 0.28)`,
            }}
          >
            <Strategy size={17} weight="duotone" style={{ color: CTO_ACCENT }} />
          </div>
          <span className="text-[13px] font-semibold text-fg">CTO</span>
        </div>

        <p className="mt-4 text-[13.5px] leading-6 text-fg/85">
          I run point on this project. I know the lanes, the pull requests, the history and the
          memory, and I can drive ADE for you — including explaining ADE itself when something
          is not where you expected it.
        </p>

        <p className="mt-3 text-[12.5px] leading-5 text-muted-fg/60">
          Pick a model that can steer live turns and I will get started. I get interrupted
          constantly — by the chats I start, by my own wake-ups — so I can only run on a model
          that accepts a message into a turn already underway.
        </p>

        <div className="mt-5">
          <ModelPicker
            value=""
            availableModelIds={availableModelIds}
            filter={ctoModelSupportsLiveRedirect}
            disabled={switchingModel}
            onChange={onPick}
            onOpenSignIn={onOpenProviderSettings}
          />
        </div>

        {loadingModels ? (
          <div className="mt-3 text-[11px] text-muted-fg/40">Checking configured models…</div>
        ) : availableModelIds.length === 0 ? (
          <div className="mt-3 rounded-lg border border-amber-500/18 bg-amber-500/[0.06] px-3 py-2 text-[11px] leading-4 text-amber-200/90">
            No model I can run on is configured yet. Sign in to Claude, Codex, or Cursor under
            Settings → AI → Providers.
          </div>
        ) : switchingModel ? (
          <div className="mt-3 text-[11px] text-muted-fg/45">Moving the thread to the new model…</div>
        ) : null}

        {error ? <TechnicalDetailsFold text={error} className="mt-4 w-full text-left" /> : null}
      </div>
    </div>
  );
}

function WakingState({
  title,
  subtitle,
  detail = null,
  pulsing = false,
  action,
}: {
  title: string;
  subtitle?: string;
  /** Raw failure text. Never on the main line — it goes in the fold. */
  detail?: string | null;
  pulsing?: boolean;
  /** A failure pane with no way out is a dead end; give it one. */
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="flex h-full items-center justify-center p-6" data-testid="cto-waking">
      <div className="flex flex-col items-center text-center">
        <div
          className={cn(
            "flex h-12 w-12 items-center justify-center rounded-2xl",
            pulsing && "motion-safe:animate-pulse",
          )}
          style={{
            background: `rgba(${CTO_ACCENT_RGB}, 0.12)`,
            border: `1px solid rgba(${CTO_ACCENT_RGB}, 0.28)`,
          }}
        >
          <Strategy size={20} weight="duotone" style={{ color: CTO_ACCENT }} />
        </div>
        <div className="mt-4 text-[14px] font-semibold text-fg">{title}</div>
        {/* A failure sentence is long — `max-w-xs` broke it into four ragged
            centred lines. */}
        {subtitle ? (
          <div
            className={cn(
              "mt-1 text-[12.5px] leading-5 text-muted-fg/50",
              detail || action ? "max-w-[360px]" : "max-w-xs",
            )}
          >
            {subtitle}
          </div>
        ) : null}
        {action ? (
          <button
            type="button"
            onClick={action.onClick}
            className="mt-4 rounded-lg border border-fg/[0.1] px-3 py-1.5 text-[12px] font-medium text-fg/85 transition-colors hover:bg-fg/[0.05]"
          >
            {action.label}
          </button>
        ) : null}
        {detail ? (
          <TechnicalDetailsFold text={detail} className="mt-4 w-full max-w-[420px] text-left" />
        ) : null}
      </div>
    </div>
  );
}

/**
 * "This thread is getting full, and here is the way out."
 *
 * Quiet, one line of prose, and never in the way: it does not block the
 * composer, it does not reappear once dismissed for this thread, and pressing
 * it is the only thing that retires anything.
 */
function CtoRotationPrompt({
  blocked,
  busy,
  onStart,
  onDismiss,
}: {
  blocked: boolean;
  busy: boolean;
  onStart: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      data-testid="cto-rotation-prompt"
      role="status"
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-2",
        blocked
          ? "border-amber-500/15 bg-amber-500/[0.06]"
          : "border-fg/[0.05] bg-fg/[0.02]",
      )}
    >
      <div className="min-w-0 flex-1">
        <div className={cn("text-[12px] font-medium", blocked ? "text-amber-200/90" : "text-fg/85")}>
          {blocked
            ? "This conversation is over its context limit"
            : "This conversation is getting full"}
        </div>
        <div className="mt-0.5 text-[11.5px] leading-[1.5] text-muted-fg/60">
          {blocked
            ? "The CTO can't answer until you start a fresh session. Nothing it remembers is lost, and this conversation moves to Past threads."
            : "Starting a fresh session keeps everything the CTO remembers — this conversation moves to Past threads. ADE won't do it on its own."}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          data-testid="cto-rotation-start"
          disabled={busy}
          onClick={onStart}
          className="rounded-lg border border-fg/[0.1] px-2.5 py-1 text-[11.5px] font-medium text-fg/85 transition-colors hover:bg-fg/[0.05] disabled:opacity-60"
        >
          {busy ? "Starting…" : "Start a fresh session"}
        </button>
        <button
          type="button"
          data-testid="cto-rotation-dismiss"
          onClick={onDismiss}
          className="rounded-lg px-2 py-1 text-[11.5px] text-muted-fg/55 transition-colors hover:text-fg/80"
        >
          Not now
        </button>
      </div>
    </div>
  );
}
