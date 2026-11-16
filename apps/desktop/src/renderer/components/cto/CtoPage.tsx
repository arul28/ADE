import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  AgentChatSession,
  AgentChatSessionSummary,
  ChatSurfacePresentation,
  CtoAvatarState,
  CtoIdentity,
  CtoSnapshot,
} from "../../../shared/types";
import { AgentChatPane } from "../chat/AgentChatPane";
import type { ComposerMachineChipAction } from "../chat/AgentChatComposer";
import { useChatMachineLanes } from "../chat/ChatRuntimeScope";
import { selectActiveProjectStateKey, useAppStore } from "../../state/appStore";
import { pinKey } from "../../state/pinKey";
import { useStableBinding } from "../../state/laneMachineRouting";
import { usePinTargetsTab } from "../../state/crossMachineLanes";
import { Dialog } from "../ui/dialog";
import { TechnicalDetailsFold } from "../app/errorSurfaceKit";
import { CtoHomeChooser } from "./CtoHomeChooser";
import { ctoHomeCandidates } from "./ctoHomeMachine";
import { useAdeCloudLaneComputers } from "../../state/adeCloudLaneIndex";
import { useCtoHome, type CtoHomeState } from "./useCtoHome";
import { CtoSettingsPage, type CtoIdentityPatch, type CtoSettingsSection } from "./CtoSettingsPage";
import { resolveModelSelection, useCtoModelOptions } from "./useCtoModelOptions";
import { CtoAvatar, deriveCtoAvatarState, useCtoAvatarState } from "./avatar/CtoAvatar";
import { resolveCtoAvatarLook } from "./avatar/ctoAvatarLook";
import { CtoLookProvider, rememberCtoLook } from "./ctoLook";
import { CtoHeaderPill } from "./CtoHeaderPill";
import { CtoSidePanel, type CtoPanelTab } from "./CtoSidePanel";
import { CtoWelcome } from "./CtoWelcome";
import { useCtoLiveState } from "./useCtoLiveState";
import { useCtoActivityData } from "./useCtoActivityData";
import {
  CTO_PANEL_DOCK_MIN_WIDTH,
  ctoStatusPhrase,
  readCtoPanelOpen,
  resolveCtoPrimaryLaneId,
  writeCtoPanelOpen,
} from "./ctoSessionViewState";
import { useCtoCloudHome } from "./useCtoCloudHome";
import { useCloudMachines } from "../remoteTargets/useCloudMachines";
import { showToast } from "../app/toast/toastStore";
import type { CtoAdoptAccountCopyResult } from "../../../shared/ctoAccountCopy";
import { CtoGreeting } from "./CtoGreeting";
import "./ctoPage.css";

const MAX_WAKING_RETRIES = 4;

/** Says what came along when the CTO moved and its new home restored it from the account copy. */
function announceCtoMove(adopted: CtoAdoptAccountCopyResult | null): void {
  if (!adopted?.restored) return;
  showToast({
    id: "cto-home-moved",
    tone: "success",
    title: `Moved from ${adopted.fromName ?? "the old machine"}`,
    message: "Notes, routines and recent chat came along.",
    durationMs: 6_000,
  });
}
/** How long the welcome stays up after a pick, so the avatar's wake-up plays. */
const WELCOME_WAKE_MS = 1_400;

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

/** Which whole-page view the stage shows. */
type CtoPageStage =
  | "bridgeMissing"
  | "chooser"
  | "loading"
  | "cloudGone"
  | "cloudAsleep"
  | "away"
  | "welcome"
  | "thread"
  | "error"
  | "waking";

/** The stage's view. Order matters: the first match wins. */
function ctoPageStage(input: {
  bridgeMissing: boolean;
  showChooser: boolean;
  homeStatus: CtoHomeState["status"];
  /** The home is an ADE Cloud computer that can't be reached right now. */
  awayCloud: boolean;
  awayCloudGone: boolean;
  showWelcome: boolean;
  threadReady: boolean;
  failed: boolean;
}): CtoPageStage {
  if (input.bridgeMissing) return "bridgeMissing";
  if (input.showChooser) return "chooser";
  if (input.homeStatus === "loading") return "loading";
  if (input.homeStatus === "offline") {
    if (!input.awayCloud) return "away";
    return input.awayCloudGone ? "cloudGone" : "cloudAsleep";
  }
  if (input.showWelcome) return "welcome";
  if (input.threadReady) return "thread";
  return input.failed ? "error" : "waking";
}

/**
 * The header's status word. A home on another machine that can't be reached
 * is away, not asleep; only an ADE Cloud computer sleeps, or is gone. Null
 * until there is a CTO to describe.
 */
function ctoPageStatusPhrase(input: {
  offline: boolean;
  awayCloud: boolean;
  awayCloudGone: boolean;
  identityLoaded: boolean;
  facts: Parameters<typeof ctoStatusPhrase>[0];
}): string | null {
  if (input.offline && !input.awayCloud) return "Away";
  if (input.awayCloudGone) return "Gone";
  if (input.identityLoaded || input.offline) return ctoStatusPhrase(input.facts);
  return null;
}

/** Width of the page's own box, for docking the panel. Container width, not the window's. */
function useContainerWidth(): [React.RefCallback<HTMLDivElement>, number] {
  const [width, setWidth] = useState(0);
  const observerRef = useRef<ResizeObserver | null>(null);
  const ref = useCallback((node: HTMLDivElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!node || typeof ResizeObserver === "undefined") return;
    setWidth(node.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width;
      if (next != null) setWidth((prev) => (Math.abs(prev - next) < 1 ? prev : next));
    });
    observer.observe(node);
    observerRef.current = observer;
  }, []);
  useLayoutEffect(() => () => observerRef.current?.disconnect(), []);
  return [ref, width];
}

export function CtoPage({ active = true }: { active?: boolean } = {}) {
  const ctoHome = useCtoHome(active);
  const { computers: laneComputers } = useAdeCloudLaneComputers();
  /** Every CTO call carries this. Null until the home is reachable: call nothing then. */
  // Held by its key, so a rebuilt pin for the same machine restarts nothing.
  const ctoPin = useStableBinding(ctoHome.status === "ready" ? ctoHome.pin : null);
  const homeReady = ctoPin != null;
  const pinTargetsTab = usePinTargetsTab(ctoPin);
  const scopeKey = useAppStore(selectActiveProjectStateKey);
  const sessionCacheKey = `${scopeKey ?? ""}|${pinKey(ctoPin)}`;
  // The home machine's lanes, not the tab's: the CTO's primary lane is there.
  const lanes = useChatMachineLanes(ctoPin);
  const [chooserOpen, setChooserOpen] = useState(false);
  const onCloudChosen = useCallback(({ adopted }: { adopted: CtoAdoptAccountCopyResult | null }) => {
    setChooserOpen(false);
    announceCtoMove(adopted);
  }, []);
  const cloudHome = useCtoCloudHome({
    active,
    origin: ctoHome.origin,
    machines: ctoHome.machines,
    choose: ctoHome.choose,
    onChosen: onCloudChosen,
  });
  // The home's ADE Cloud computer, read only while it is away: asleep, or
  // deleted by the idle cleanup (then a new one is made from the account copy).
  const awayCloudInstanceId = ctoHome.status === "offline" ? ctoHome.cloudInstanceId : null;
  const cloudMachines = useCloudMachines(active && awayCloudInstanceId != null);
  const awayCloudMachine = awayCloudInstanceId
    ? cloudMachines.result?.machines.find((machine) => machine.instanceId === awayCloudInstanceId) ?? null
    : null;
  const awayCloudGone = awayCloudInstanceId != null
    && cloudMachines.result?.state === "ok"
    && (!awayCloudMachine || awayCloudMachine.state === "deleting");
  const [waking, setWaking] = useState(false);
  const wakeCloudHome = useCallback(async () => {
    if (!awayCloudInstanceId) return;
    setWaking(true);
    try {
      // A paired computer wakes by connecting; one this app has no
      // connection to yet is woken through ADE Cloud.
      const target = ctoHome.home && !ctoHome.home.isThisMachine ? ctoHome.home.machineId : null;
      if (target && window.ade?.remoteRuntime?.connect) await window.ade.remoteRuntime.connect(target);
      else await window.ade?.cloud?.machineAction?.({ instanceId: awayCloudInstanceId, action: "wake" });
    } catch (err) {
      showToast({
        id: "cto-home-wake-failed",
        tone: "error",
        title: "Couldn't wake the computer",
        message: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setWaking(false);
      cloudMachines.refresh();
    }
  }, [awayCloudInstanceId, cloudMachines, ctoHome.home]);
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<CtoSettingsSection>("look");
  const [switchingModel, setSwitchingModel] = useState(false);
  /** A model was just picked from the welcome: hold it while the avatar wakes. */
  const [welcomeWaking, setWelcomeWaking] = useState(false);
  const [panelOpen, setPanelOpenState] = useState(() => readCtoPanelOpen(scopeKey));
  const [panelTab, setPanelTab] = useState<CtoPanelTab>("activity");
  const [pageRef, pageWidth] = useContainerWidth();

  const wakingRetriesRef = useRef(0);

  const { availableModelIds, loadingModels, openProviderSettings } = useCtoModelOptions(ctoPin);

  const primaryLaneId = useMemo(() => resolveCtoPrimaryLaneId(lanes), [lanes]);

  const ctoDisplayName = ctoIdentity?.name?.trim() || "CTO";
  const look = useMemo(() => resolveCtoAvatarLook(ctoIdentity?.avatar ?? null), [ctoIdentity?.avatar]);
  const accent = look.color;

  // The sidebar's CTO entry wears the same look, from the first frame next launch.
  useEffect(() => {
    if (ctoIdentity) rememberCtoLook(scopeKey, look);
  }, [ctoIdentity, look, scopeKey]);

  useEffect(() => {
    setPanelOpenState(readCtoPanelOpen(scopeKey));
  }, [scopeKey]);
  const setPanelOpen = useCallback((open: boolean) => {
    setPanelOpenState(open);
    writeCtoPanelOpen(scopeKey, open);
  }, [scopeKey]);

  const currentModelId = session?.modelId
    ?? ctoIdentity?.modelPreferences?.modelId
    ?? "";
  const currentReasoningEffort = session?.reasoningEffort
    ?? ctoIdentity?.modelPreferences?.reasoningEffort
    ?? null;
  const currentFastMode = session?.fastMode === true;
  // Null preferences mean nobody has picked a model the CTO can actually run
  // on. The welcome takes the thread's place until one is chosen — the session
  // itself is untouched, so a pick resumes the same thread rather than a new one.
  const needsModelPick = Boolean(ctoIdentity) && !ctoIdentity?.modelPreferences;
  // A null identity means the snapshot has not landed yet — it is not a CTO
  // that happens to have a model. Waking on it would materialize the session
  // ahead of the picker, which is the one thing the pick gate exists to stop.
  const identityLoaded = Boolean(ctoIdentity);

  /* ── Data loading ── */

  const loadSummary = useCallback(async () => {
    if (!window.ade?.cto || !ctoPin) return;
    const key = sessionCacheKey;
    try {
      const snapshot = await window.ade.cto.getState({}, ctoPin);
      if (isCurrentCto(key)) {
        setCtoIdentity(snapshot.identity);
        setHomeCrossMachine(readCrossMachineCapability(snapshot));
      }
    } catch {
      // Non-fatal: keep the waking state and let the session/lane effects retry.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- isCurrentCto reads a ref
  }, [ctoPin, sessionCacheKey]);

  // A different home (or tab) is a different CTO. Drop everything read from
  // the previous one before anything reads from the new one.
  useEffect(() => {
    if (lastCacheKeyRef.current === sessionCacheKey) return;
    lastCacheKeyRef.current = sessionCacheKey;
    setSession(ctoPrimarySessions.get(sessionCacheKey) ?? null);
    setCtoIdentity(null);
    setHomeCrossMachine(null);
    setError(null);
    setWelcomeWaking(false);
    wakingRetriesRef.current = 0;
  }, [sessionCacheKey]);

  // Opening settings re-reads the identity: the phone, the CLI or a usage-limit
  // move may have changed the model or account since this page loaded.
  useEffect(() => {
    if (!active) return;
    void loadSummary();
  }, [active, loadSummary, settingsOpen]);

  // The CTO keeps the person's clock: routines and "now" use this zone even
  // when it lives on a computer in another one (ADE Cloud runs on UTC). Written
  // only when it differs, so opening the page costs nothing on a match.
  const storedTimeZone = ctoIdentity?.timeZone ?? null;
  useEffect(() => {
    if (!active || !identityLoaded || !ctoPin || !window.ade?.cto) return;
    let zone: string | null = null;
    try {
      zone = Intl.DateTimeFormat().resolvedOptions().timeZone || null;
    } catch {
      zone = null;
    }
    if (!zone || zone === storedTimeZone) return;
    const key = sessionCacheKey;
    void window.ade.cto.updateIdentity({ patch: { timeZone: zone } }, ctoPin)
      .then((snapshot) => {
        if (isCurrentCto(key)) setCtoIdentity(snapshot.identity);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps -- isCurrentCto reads a ref; keyed on the pin's key
  }, [active, identityLoaded, ctoPin?.key, storedTimeZone, sessionCacheKey]);

  // Ensure the persistent session. Re-runs when the primary lane hydrates (D6
  // race) so a slow lanes store shows the waking state, never an error card.
  useEffect(() => {
    if (!active || !window.ade?.cto || !ctoPin) return;
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
  }, [active, ctoPin, identityLoaded, needsModelPick, primaryLaneId, sessionCacheKey, wakeAttempt]);

  // The welcome's wake-up plays once, then the thread takes the page.
  useEffect(() => {
    if (!welcomeWaking) return;
    const timer = setTimeout(() => setWelcomeWaking(false), WELCOME_WAKE_MS);
    return () => clearTimeout(timer);
  }, [welcomeWaking]);

  /* ── Callbacks ── */

  const refreshSession = useCallback(async () => {
    if (!window.ade?.cto || !primaryLaneId || !ctoPin) return null;
    const next = await window.ade.cto.ensureSession({}, ctoPin);
    ctoPrimarySessions.set(sessionCacheKey, next);
    setSession(next);
    return next;
  }, [ctoPin, primaryLaneId, sessionCacheKey]);

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
    if (!window.ade?.cto || switchingModel || !ctoPin) return false;
    const selection = resolveModelSelection(modelId, reasoningEffort);
    if (!selection) return false;
    // Fast mode is a property of the model, not of the picker: carrying a true
    // onto a model that has no fast tier asks the chat service for a mode that
    // does not exist there.
    const nextFastMode = currentFastMode && selection.supportsFastMode;
    setSwitchingModel(true);
    setError(null);
    try {
      const saved = await window.ade.cto.updateIdentity({
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
      setCtoIdentity(saved.identity);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't switch the model.");
      return false;
    } finally {
      setSwitchingModel(false);
    }
  }, [ctoPin, currentFastMode, refreshSession, session, sessionCacheKey, switchingModel]);

  /**
   * Which account runs the main model (null: the provider's default). Saved
   * on the identity; the next ensure moves the thread there with its history.
   * While a turn runs the move waits for the next turn to start.
   */
  const handleAccountChange = useCallback(async (instanceId: string | null) => {
    if (!window.ade?.cto || switchingModel || !ctoPin) return;
    const current = ctoIdentity?.modelPreferences;
    if (!current) return;
    setSwitchingModel(true);
    setError(null);
    try {
      const { instanceId: _previous, ...rest } = current;
      const saved = await window.ade.cto.updateIdentity({
        patch: { modelPreferences: instanceId ? { ...rest, instanceId } : { ...rest, instanceId: null } },
      }, ctoPin);
      await refreshSession();
      setCtoIdentity(saved.identity);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't switch the account.");
    } finally {
      setSwitchingModel(false);
    }
  }, [ctoIdentity, ctoPin, refreshSession, switchingModel]);

  /** The welcome's pick: save the model, then let the avatar wake before the thread shows. */
  const handleWelcomePick = useCallback((modelId: string) => {
    void handleModelChange(modelId, currentReasoningEffort).then((ok) => {
      if (ok) setWelcomeWaking(true);
    });
  }, [currentReasoningEffort, handleModelChange]);

  /**
   * Save identity fields (name, look, personality, instructions, …).
   *
   * `updateIdentity` answers the whole snapshot, so the local copy is replaced
   * rather than patched — a merge here would drift from whatever the service
   * normalized on the way in.
   */
  const handleIdentityChange = useCallback(async (patch: CtoIdentityPatch) => {
    if (!window.ade?.cto || !ctoPin) throw new Error("Home machine unreachable");
    // Rejects on failure: the settings page says "Couldn't save" itself.
    const snapshot = await window.ade.cto.updateIdentity({ patch }, ctoPin);
    if (isCurrentCto(sessionCacheKey)) setCtoIdentity(snapshot.identity);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- isCurrentCto reads a ref
  }, [ctoPin, sessionCacheKey]);

  const handleFastModeChange = useCallback(async (enabled: boolean) => {
    if (!window.ade?.cto || switchingModel || !ctoPin) return;
    setSwitchingModel(true);
    setError(null);
    try {
      const targetSession = session ?? await refreshSession();
      if (!targetSession) throw new Error("Still waking up");
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
  }, [ctoPin, refreshSession, session, sessionCacheKey, switchingModel]);

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
    subtitle: "Your project's CTO",
    accentColor: accent,
    chips: [],
    showMcpStatus: false,
    assistantLabel: ctoDisplayName,
    messagePlaceholder: `Message ${ctoDisplayName}…`,
  }), [accent, ctoDisplayName]);

  /* ── Live state: avatar, status phrase, panel ── */

  const sessionReady = Boolean(session) && Boolean(primaryLaneId);
  const ctoSessionId = session?.id ?? null;
  const live = useCtoLiveState(ctoSessionId, ctoPin, active);
  const ctoAttentionWaiting = useAppStore((state) => state.ctoAttention.awaitingInput);
  const awaitingInput = live.awaitingInput || ctoAttentionWaiting;
  const offline = ctoHome.status === "offline";
  const docked = pageWidth === 0 || pageWidth >= CTO_PANEL_DOCK_MIN_WIDTH;
  const panelAvailable = sessionReady && homeReady && !settingsOpen;
  const panelShown = panelAvailable && panelOpen;
  const activity = useCtoActivityData({
    ctoSessionId,
    pin: ctoPin,
    visible: active && sessionReady,
    libraryOpen: panelShown && panelTab === "library",
  });
  const runningChildren = useMemo(() => activity.children.filter((child) => child.running).length, [activity.children]);

  const baseAvatarState = welcomeWaking
    ? "happy"
    : deriveCtoAvatarState({
      status: live.turnActive ? "active" : "idle",
      awaitingInput,
      streamingText: live.streamingText,
      lastTurnFailed: live.lastTurnFailed,
      offline,
      noModel: needsModelPick,
    });
  const avatarState = useCtoAvatarState(baseAvatarState);
  const statusPhrase = ctoPageStatusPhrase({
    offline,
    awayCloud: awayCloudInstanceId != null,
    awayCloudGone,
    identityLoaded,
    facts: {
      turnActive: live.turnActive,
      streamingText: live.streamingText,
      awaitingInput,
      asleep: offline || needsModelPick,
      runningChildren,
    },
  });

  const greeting = useMemo(
    () => (ctoSessionId ? <CtoGreeting look={look} name={ctoDisplayName} sessionId={ctoSessionId} /> : null),
    [ctoDisplayName, ctoSessionId, look],
  );

  /* ── Render ── */

  const bridgeMissing = active && typeof window !== "undefined" && !window.ade?.cto;

  // A computer being made for the CTO keeps its progress on screen until it moves in.
  const cloudJobLive = cloudHome.job?.phase === "running" || cloudHome.job?.phase === "ready";
  const showChooser = ctoHome.status === "choose" || chooserOpen || cloudJobLive;
  // With a cloud home that is there, its own row is the "Current" one; a
  // second ADE Cloud row would only find the same computer.
  const chooserCloud = cloudHome.job || !(ctoHome.cloudInstanceId && ctoHome.home) ? cloudHome : null;
  const otherMachineCount = useMemo(
    () => ctoHomeCandidates(ctoHome.machines, ctoHome.home?.machineId ?? null, laneComputers)
      .filter((machine) => !machine.isThisMachine).length,
    [ctoHome.home?.machineId, ctoHome.machines, laneComputers],
  );
  // Settings offers "Change" when the chooser has somewhere else to go:
  // another machine, or ADE Cloud (a free plan is sent to the upgrade there).
  const canMoveHome = otherMachineCount > 0 || Boolean(chooserCloud?.shown);
  const homeLabel = ctoHome.homeName ?? "this machine";
  const machineChipAction = useMemo<ComposerMachineChipAction>(() => ({
    tooltip: `Runs on ${homeLabel}. Click to change.`,
    offline: ctoHome.status === "offline",
    // A home machine on an ADE build without the cross-machine tools answers
    // "I can't reach other machines". Only worth saying when there are others.
    // This computer runs the build that is showing this page, so the hint is
    // only ever about another home machine.
    note: homeCrossMachine === false && otherMachineCount > 0 && ctoHome.home?.isThisMachine !== true
      ? `Update ADE on ${homeLabel} to reach other machines.`
      : null,
    onClick: () => {
      setSettingsOpen(false);
      setChooserOpen(true);
    },
  }), [ctoHome.home?.isThisMachine, ctoHome.status, homeCrossMachine, homeLabel, otherMachineCount]);
  const openSettings = useCallback((section: CtoSettingsSection = "look") => {
    setSettingsSection(section);
    setSettingsOpen(true);
  }, []);
  const settingsHome = useMemo(
    () => (canMoveHome
      ? {
        machineName: homeLabel,
        onChange: () => {
          setSettingsOpen(false);
          setChooserOpen(true);
        },
      }
      : null),
    [canMoveHome, homeLabel],
  );
  const settingsVisible = settingsOpen && homeReady && !showChooser;
  const showWelcome = !bridgeMissing && !showChooser && homeReady && (needsModelPick || welcomeWaking);
  const stage = ctoPageStage({
    bridgeMissing,
    showChooser,
    homeStatus: ctoHome.status,
    awayCloud: awayCloudInstanceId != null,
    awayCloudGone,
    showWelcome,
    threadReady: sessionReady && lockedSessionSummary != null && primaryLaneId != null,
    failed: Boolean(error),
  });

  const panel = (sheet: boolean) => (
    <CtoSidePanel
      look={look}
      name={ctoDisplayName}
      statusPhrase={statusPhrase ?? "Idle"}
      avatarState={avatarState}
      ctoSessionId={ctoSessionId}
      pin={ctoPin}
      pinTargetsTab={pinTargetsTab}
      lanes={lanes}
      primaryLaneId={primaryLaneId}
      turnActive={live.turnActive}
      liveStep={live.step}
      turnsFinished={live.finishedCount}
      data={activity}
      tab={panelTab}
      onTabChange={setPanelTab}
      onOpenSettings={(section) => {
        if (sheet) setPanelOpen(false);
        openSettings(section ?? "look");
      }}
      onClose={() => setPanelOpen(false)}
      sheet={sheet}
    />
  );

  const renderStage = (): React.ReactNode => {
    switch (stage) {
      case "bridgeMissing":
        return <CtoStateCard look={look} name={ctoDisplayName} avatar="error" status="Reopen ADE to reconnect" tone="crit" />;
      case "chooser":
        return (
          <CtoHomeChooser
            look={look}
            name={ctoDisplayName}
            machines={ctoHome.machines}
            current={ctoHome.status === "choose" ? null : ctoHome.home}
            currentName={ctoHome.status === "choose" ? null : ctoHome.homeName}
            copyFollows={!ctoHome.localOnly}
            cloud={chooserCloud}
            onChoose={async (machine) => {
              announceCtoMove(await ctoHome.choose(machine));
              setChooserOpen(false);
            }}
            onCancel={chooserOpen && ctoHome.status !== "choose" ? () => setChooserOpen(false) : undefined}
          />
        );
      case "loading":
        return <CtoStateCard look={look} name={ctoDisplayName} avatar="thinking" status="Waking up…" />;
      case "cloudGone":
        return (
          <CtoStateCard
            look={look}
            name={ctoDisplayName}
            avatar="asleep"
            status="Its ADE Cloud computer is gone"
            statusHint="ADE Cloud deletes a computer that sits idle. A new one picks up from the copy in your account."
            action={{
              label: "Make a new computer",
              onClick: () => {
                setChooserOpen(true);
                void cloudHome.start();
              },
            }}
            secondaryAction={{ label: "Move to…", onClick: () => setChooserOpen(true) }}
          />
        );
      case "cloudAsleep":
        return (
          <CtoStateCard
            look={look}
            name={ctoDisplayName}
            avatar="asleep"
            status={waking ? "Waking up…" : "Asleep on ADE Cloud"}
            statusHint={`${ctoHome.homeName ?? "Its computer"} sleeps when idle. Waking it takes a moment.`}
            action={{ label: waking ? "Waking…" : "Wake", onClick: () => void wakeCloudHome(), disabled: waking }}
            secondaryAction={{ label: "Move to…", onClick: () => setChooserOpen(true) }}
          />
        );
      case "away":
        return (
          <CtoStateCard
            look={look}
            name={ctoDisplayName}
            avatar="asleep"
            status={`Away on ${ctoHome.homeName ?? "another machine"}`}
            statusHint={ctoHome.localOnly
              ? `${ctoHome.offlineReason ?? "Can't be reached right now."} Notes and chat are safe there and pick up when it's back.`
              : `${ctoHome.offlineReason ?? "Can't be reached right now."} Move it to keep going; its notes and recent chat come along.`}
            action={{ label: "Move to…", onClick: () => setChooserOpen(true) }}
          />
        );
      case "welcome":
        return (
          <CtoWelcome
            look={look}
            name={ctoDisplayName}
            availableModelIds={availableModelIds}
            loadingModels={loadingModels}
            switchingModel={switchingModel}
            waking={welcomeWaking}
            error={error}
            onPick={handleWelcomePick}
            onOpenProviderSettings={openProviderSettings}
          />
        );
      case "thread":
        if (!lockedSessionSummary || !primaryLaneId) return null;
        return (
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
            emptyTranscript={greeting}
          />
        );
      case "error":
        return (
          <CtoStateCard
            look={look}
            name={ctoDisplayName}
            avatar="error"
            status="Couldn't wake up"
            statusHint="ADE tried a few times. Nothing was lost."
            tone="crit"
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
        );
      case "waking":
        return <CtoStateCard look={look} name={ctoDisplayName} avatar="thinking" status="Waking up…" />;
    }
  };

  return (
    <CtoLookProvider look={look}>
    <div
      ref={pageRef}
      className="ade-cto-page"
      style={{ "--cto-accent": accent } as React.CSSProperties}
      data-testid="cto-page"
    >
      <div className="ade-cto-main">
        <CtoHeaderPill
          look={look}
          name={ctoDisplayName}
          statusPhrase={statusPhrase}
          avatarState={avatarState}
          panelOpen={panelShown}
          settingsOpen={settingsVisible}
          controlsDisabled={!homeReady}
          onTogglePanel={() => {
            if (settingsOpen) setSettingsOpen(false);
            setPanelOpen(!panelShown);
          }}
          onOpenSettings={() => {
            if (settingsOpen) setSettingsOpen(false);
            else openSettings("look");
          }}
        />

        {settingsVisible ? (
          <div className="ade-cto-settings">
            <CtoSettingsPage
              active={active}
              pin={ctoPin}
              identity={ctoIdentity}
              sessionId={ctoSessionId}
              currentModelId={currentModelId}
              currentReasoningEffort={currentReasoningEffort}
              currentFastMode={currentFastMode}
              availableModelIds={availableModelIds}
              loadingModels={loadingModels}
              switchingModel={switchingModel}
              onModelChange={(modelId, reasoningEffort) => void handleModelChange(modelId, reasoningEffort)}
              onAccountChange={handleAccountChange}
              onFastModeChange={(enabled) => void handleFastModeChange(enabled)}
              onOpenProviderSettings={openProviderSettings}
              onIdentityChange={handleIdentityChange}
              crossMachineAvailable={homeCrossMachine === true}
              home={settingsHome}
              initialSection={settingsSection}
              onBack={() => setSettingsOpen(false)}
            />
          </div>
        ) : null}

        {/* Thread / welcome / waking */}
        <div className="ade-cto-stage" hidden={settingsVisible}>
          {renderStage()}
        </div>
      </div>

      {panelShown && docked ? panel(false) : null}
      {panelAvailable && !docked ? (
        <Dialog
          open={panelOpen}
          onOpenChange={setPanelOpen}
          placement="right"
          width={360}
          hideHeader
          hideClose
          bodyPadding={false}
          title={`${ctoDisplayName} profile`}
          testId="cto-side-sheet"
        >
          {panel(true)}
        </Dialog>
      ) : null}
    </div>
    </CtoLookProvider>
  );
}

/**
 * A whole-page state (waking, away, failed). The avatar carries it; under it
 * the name, one status word and at most one action. The why goes in the
 * status's tooltip, the raw error in the fold.
 */
function CtoStateCard({
  look,
  name,
  avatar,
  status,
  statusHint,
  tone,
  detail = null,
  action,
  secondaryAction,
}: {
  look: ReturnType<typeof resolveCtoAvatarLook>;
  name: string;
  avatar: CtoAvatarState;
  status: string;
  /** The longer why, as the status's tooltip. */
  statusHint?: string;
  tone?: "crit";
  /** Raw failure text. Never on the main line; it goes in the fold. */
  detail?: string | null;
  /** A failure pane with no way out is a dead end; give it one. */
  action?: { label: string; onClick: () => void; disabled?: boolean };
  /** A quieter second way out. */
  secondaryAction?: { label: string; onClick: () => void };
}) {
  return (
    <div className="ade-cto-waking" data-testid="cto-waking">
      <div className="ade-cto-waking-inner">
        <div className="ade-cto-welcome-avatar">
          <div className="ade-cto-profile-halo" aria-hidden />
          <CtoAvatar look={look} state={avatar} size={104} motion="live" title={`${name}, ${status}`} />
        </div>
        <div className="ade-cto-waking-title">{name}</div>
        <p className="ade-cto-status-word" data-tone={tone} title={statusHint ?? status} role="status">
          <span>{status}</span>
        </p>
        {action || secondaryAction ? (
          <div className="flex items-center justify-center gap-2">
            {action ? (
              <button type="button" className="kit-btn" data-size="sm" onClick={action.onClick} disabled={action.disabled}>
                {action.label}
              </button>
            ) : null}
            {secondaryAction ? (
              <button type="button" className="kit-btn kit-btn-ghost" data-size="sm" onClick={secondaryAction.onClick}>
                {secondaryAction.label}
              </button>
            ) : null}
          </div>
        ) : null}
        {detail ? (
          <TechnicalDetailsFold text={detail} className="mt-4 w-full max-w-[420px] text-left" />
        ) : null}
      </div>
    </div>
  );
}
