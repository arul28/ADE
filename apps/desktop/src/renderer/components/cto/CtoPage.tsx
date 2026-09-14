import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Desktop, Gear, Strategy, X } from "@phosphor-icons/react";
import type {
  AgentChatSession,
  AgentChatSessionSummary,
  ChatSurfacePresentation,
  CtoIdentity,
  CtoSessionLogEntry,
} from "../../../shared/types";
import { AgentChatPane } from "../chat/AgentChatPane";
import { useAppStore } from "../../state/appStore";
import { cn } from "../ui/cn";
import { CtoMark } from "./CtoMark";
import { CtoTalkButton } from "./CtoTalkButton";
import { CtoSettingsPanel } from "./CtoSettingsPanel";
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
  const [switchingModel, setSwitchingModel] = useState(false);

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
        const modelUpdate = selection.modelId === session.modelId
          ? { reasoningEffort: selection.reasoningEffort }
          : {};
        const updated = await window.ade.agentChat.updateSession({
          sessionId: session.id,
          modelId: selection.modelId,
          ...modelUpdate,
          fastMode: currentFastMode,
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

  return (
    <div className={cn(shellBodyCls, "relative flex-col")}>
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-white/[0.06] px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          {/* The mark, not a letter in a box: the CTO is named, so it gets the
              same glyph here as in the tab rail rather than the first character
              of whatever the user renamed it to. No chip around it — the ring
              is already a frame, and two were one too many. */}
          <CtoMark size={22} className="shrink-0" style={{ color: CTO_ACCENT }} />
          <span className="truncate text-[13px] font-semibold text-fg">{ctoDisplayName}</span>
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-2">
          <CtoTalkButton />
          {/* The CTO thread is pinned to the local primary lane by design, so
              the machine is stated as a fact — never offered as a choice. */}
          <span
            data-testid="cto-machine-indicator"
            title="The CTO thread is pinned to This computer and cannot be moved."
            className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md border border-dashed border-white/[0.12] px-2 font-sans text-[10px] font-medium text-muted-fg/55"
            style={{ whiteSpace: "nowrap" }}
          >
            <Desktop size={11} aria-hidden />
            Always runs on This computer
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
            />
          </div>
        </>
      )}
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
