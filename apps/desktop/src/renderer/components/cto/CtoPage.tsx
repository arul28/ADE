import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Gear, Robot, Strategy } from "@phosphor-icons/react";
import type {
  AgentChatSession,
  AgentChatSessionSummary,
  ChatSurfacePresentation,
  CtoIdentity,
  CtoSessionLogEntry,
  CtoStartFreshSessionResult,
  CtoThreadHealth,
} from "../../../shared/types";
import { AgentChatPane } from "../chat/AgentChatPane";
import { useAppStore } from "../../state/appStore";
import { cn } from "../ui/cn";
import { CtoTalkButton } from "./CtoTalkButton";
import { CtoSettingsPage } from "./CtoSettingsPage";
import { ctoModelSupportsLiveRedirect, resolveModelSelection, useCtoModelOptions } from "./useCtoModelOptions";
import { ModelPicker } from "../shared/ModelPicker/ModelPicker";
import { resolveCtoPrimaryLaneId } from "./ctoSessionViewState";
import { shellBodyCls } from "./shared/designTokens";
import { TechnicalDetailsFold } from "../app/errorSurfaceKit";

const CTO_ACCENT = "#22D3EE";
/** `CTO_ACCENT` as an "r, g, b" triplet, for the rgba() tints below. */
const CTO_ACCENT_RGB = "34, 211, 238";
const MAX_WAKING_RETRIES = 4;

// The CTO is a single project-level thread. There is only ever one session; the
// module-level cache keeps it warm across tab switches so re-entry is instant.
let ctoPrimarySession: AgentChatSession | null = null;

export function CtoPage({ active = true }: { active?: boolean } = {}) {
  const lanes = useAppStore((s) => s.lanes);

  const [session, setSession] = useState<AgentChatSession | null>(() => ctoPrimarySession);
  const [error, setError] = useState<string | null>(null);
  // Bumped by "Try again" on the failure pane; re-runs the wake effect from a
  // clean retry budget instead of leaving the user stranded on the error.
  const [wakeAttempt, setWakeAttempt] = useState(0);
  const [ctoIdentity, setCtoIdentity] = useState<CtoIdentity | null>(null);
  const [sessionLogs, setSessionLogs] = useState<CtoSessionLogEntry[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** Why the last call could not start. Its own line, so the header never moves. */
  const [talkNotice, setTalkNotice] = useState<string | null>(null);
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

  const { availableModelIds, loadingModels, openProviderSettings } = useCtoModelOptions();

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
    if (!window.ade?.cto) return;
    try {
      const snapshot = await window.ade.cto.getState({ recentLimit: 0 });
      setCtoIdentity(snapshot.identity);
    } catch {
      // Non-fatal: keep the waking state and let the session/lane effects retry.
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

  /**
   * Ask whether this thread is running out of room.
   *
   * Same cadence as the snapshot above — on entering the tab, and again
   * whenever the session identity changes — rather than a timer. The banner is
   * an offer, not an alarm, so it does not need to be true to the second.
   */
  const loadThreadHealth = useCallback(async () => {
    if (!window.ade?.cto?.getThreadHealth) return;
    try {
      setThreadHealth(await window.ade.cto.getThreadHealth());
    } catch {
      // Non-fatal: no banner is better than an error about a banner.
    }
  }, []);

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
    if (!active || !window.ade?.cto) return;
    if (!identityLoaded || needsModelPick || !primaryLaneId) return;

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
  }, [active, identityLoaded, needsModelPick, primaryLaneId, wakeAttempt]);

  /* ── Callbacks ── */

  const refreshSession = useCallback(async () => {
    if (!window.ade?.cto || !primaryLaneId) return null;
    const next = await window.ade.cto.ensureSession();
    ctoPrimarySession = next;
    setSession(next);
    return next;
  }, [primaryLaneId]);

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
    if (!window.ade?.cto || switchingModel) return;
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
      });
      if (session) {
        const modelUpdate = selection.modelId === session.modelId
          ? { reasoningEffort: selection.reasoningEffort }
          : {};
        const updated = await window.ade.agentChat.updateSession({
          sessionId: session.id,
          modelId: selection.modelId,
          ...modelUpdate,
          fastMode: nextFastMode,
        });
        ctoPrimarySession = updated;
        setSession(updated);
      } else {
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

  /**
   * Save the name and the standing instructions.
   *
   * `updateIdentity` answers the whole snapshot, so the local copy is replaced
   * rather than patched — a merge here would drift from whatever the service
   * normalized on the way in.
   */
  const handleIdentityChange = useCallback(async (patch: {
    name?: string;
    systemPromptExtension?: string;
    voiceName?: string;
    voiceBackchannels?: boolean;
  }) => {
    if (!window.ade?.cto) return;
    setError(null);
    try {
      const snapshot = await window.ade.cto.updateIdentity({ patch });
      setCtoIdentity(snapshot.identity);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save the CTO's identity.");
    }
  }, []);

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
    setRotating(true);
    try {
      const result = await startFresh();
      ctoPrimarySession = null;
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
  }, [loadSummary, loadThreadHealth]);

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
  const showRotationPrompt = Boolean(threadHealth?.rotationAdvised)
    && !settingsOpen
    && rotationDismissedFor !== (threadHealth?.sessionId ?? "none");

  return (
    <div className={cn(shellBodyCls, "relative flex-col")}>
      {/* Header */}
      <div className="flex flex-col border-b border-white/[0.06]">
        <div className="flex items-center gap-3 px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-2.5">
            {/* The same glyph as the tab rail and as iOS, not the first character
                of whatever the user renamed the CTO to. One mark, every surface. */}
            <Robot size={22} weight="regular" className="shrink-0" style={{ color: CTO_ACCENT }} />
            <span className="truncate text-[13px] font-semibold text-fg">{ctoDisplayName}</span>
          </div>

          <div className="ml-auto flex shrink-0 items-center gap-2">
            <CtoTalkButton onNotice={setTalkNotice} />
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              aria-label="CTO settings"
              className={cn(
                "flex h-8 w-8 items-center justify-center rounded-full border transition-colors",
                settingsOpen
                  ? "border-white/15 bg-white/[0.06] text-fg"
                  : "border-white/[0.07] text-muted-fg/55 hover:bg-white/[0.04] hover:text-fg",
              )}
            >
              <Gear size={15} weight={settingsOpen ? "fill" : "regular"} />
            </button>
          </div>
        </div>
        {talkNotice ? (
          <p
            data-testid="cto-talk-error"
            role="status"
            className="truncate border-t border-white/[0.05] px-4 py-1.5 text-[11px] leading-[1.5] text-amber-300/85"
            title={talkNotice}
          >
            {talkNotice}
          </p>
        ) : null}
      </div>

      {showRotationPrompt && threadHealth ? (
        <CtoRotationPrompt
          blocked={!threadHealth.canTakeTurn}
          busy={rotating}
          onStart={() => { void handleStartFreshSession().catch(() => {}); }}
          onDismiss={() => setRotationDismissedFor(threadHealth.sessionId ?? "none")}
        />
      ) : null}

      {settingsOpen ? (
        <CtoSettingsPage
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
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}

      {/* Thread / waking */}
      <div className={cn("min-h-0 flex-1 overflow-hidden", settingsOpen && "hidden")}>
        {bridgeMissing ? (
          <WakingState title="The CTO isn't available" subtitle="Reopen ADE to reconnect." />
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
            lockSessionId={session?.id ?? null}
            lockSessionProvider={lockedSessionSummary.provider ?? null}
            initialSessionSummary={lockedSessionSummary}
            hideSessionTabs
            hideNativeControls
            hideModelControls
            hideWorkspaceChrome
            hideSurfaceHeader
            presentation={presentation}
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
            className="mt-4 rounded-lg border border-white/[0.1] px-3 py-1.5 text-[12px] font-medium text-fg/85 transition-colors hover:bg-white/[0.05]"
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
          : "border-white/[0.05] bg-white/[0.02]",
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
            ? "The CTO can't answer until you start a fresh session. Nothing it remembers is lost, and this conversation stays in History."
            : "Starting a fresh session keeps everything the CTO remembers — this conversation stays in History. ADE won't do it on its own."}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          data-testid="cto-rotation-start"
          disabled={busy}
          onClick={onStart}
          className="rounded-lg border border-white/[0.1] px-2.5 py-1 text-[11.5px] font-medium text-fg/85 transition-colors hover:bg-white/[0.05] disabled:opacity-60"
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
