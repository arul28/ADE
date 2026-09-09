import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import {
  Check,
  WarningCircle,
} from "@phosphor-icons/react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useReducedMotion } from "motion/react";
import { machineNameForBinding } from "../../../shared/machineIdentity";
import type { AgentChatFileRef, BrowserLinkOpenMode, OpenProjectBinding } from "../../../shared/types";
import { inferAttachmentType } from "../../../shared/types";
import type {
  BuiltInBrowserEmulationPreset,
  BuiltInBrowserPermissionDecision,
  BuiltInBrowserProfileDiagnostics,
  BuiltInBrowserProjectScopeArgs,
  BuiltInBrowserRecordingFps,
  BuiltInBrowserRecordingStatus,
} from "../../../shared/types/builtInBrowser";
import { BrowserLoginImportDialog } from "./BrowserLoginImportDialog";
import { browserToolbarLayout } from "./browser/builtInBrowserToolbar";
import {
  activeEmulationPresetId,
  deviceMenuPresets,
  emulationDisplayLabel,
  emulationSizeLabel,
  findErrorMessage,
  recordingEndedByMessage,
  simulatorEmulationPreset,
  stepZoomFactor,
  type BrowserFindState,
} from "./browser/browserToolbarLabels";
import {
  browserLetterboxFrame,
  type BrowserViewFrame,
} from "./browser/browserViewGeometry";
import {
  devServerRowLabels,
  devServerThumbLabel,
  mergeDevServer,
  normalizeDevServer,
  normalizeDevServers,
  type BrowserDevServer,
} from "./browser/browserDevServers";
import {
  clearBrowserRecentUrls,
  forgetBrowserRecentUrl,
  readBrowserRecentUrls,
  rememberBrowserRecentUrl,
  type BrowserRecentUrl,
} from "./browser/browserRecentUrls";
import {
  browserUrlOrigin,
  clipboardUrlCandidate,
  splitBrowserUrlForDisplay,
  urlLockKind,
} from "../../lib/browserUrl";
import { claimAppMenuCommands } from "../../lib/appMenuCommands";
import { isTypingTarget } from "../../lib/typingTarget";
import { claimAppZoomCommands } from "../../lib/appZoomCommands";
import { getLinkOpenMode, refreshLinkOpenMode, setLinkOpenMode } from "../../lib/openExternal";
import { showToast } from "../app/toast/toastStore";
import { useChatRuntimeScope, useChatRuntimeScopeForPin } from "./ChatRuntimeScope";
import {
  parseLoopbackUrl,
  remoteTunnelApprovalKey,
  type RemoteLoopbackTunnel,
} from "../../../shared/remoteLoopbackUrl";
import { THIS_MACHINE_NAME } from "../../../shared/machineIdentity";
import { useAppStore, type WorkProjectViewState } from "../../state/appStore";
import {
  commitTunnelApproval,
  reconcileTabTunnels,
  setTabTunnel,
  tunnelApprovalDecision,
  tunnelAwareUrl,
  type TabTunnelMap,
  type TunnelApprovalAnswer,
  type TunnelApprovalState,
} from "./browserRemoteTunnels";
import { cn } from "../ui/cn";
import {
  useNativeBrowserViewBounds,
  type BrowserBounds,
} from "./browser/useNativeBrowserViewBounds";
import { BrowserFindBar } from "./browser/BrowserFindBar";
import { BrowserHandoffBar } from "./browser/BrowserHandoffBar";
import { BrowserOverflowMenu } from "./browser/BrowserOverflowMenu";
import { BrowserProfilePanel } from "./browser/BrowserProfilePanel";
import { BrowserStage, type BrowserLaunchpadGroup } from "./browser/BrowserStage";
import { BrowserTabStrip } from "./browser/BrowserTabStrip";
import { BrowserToolbarRow } from "./browser/BrowserToolbarRow";
import {
  MENU_ITEM_CLASS,
  MENU_LABEL_CLASS,
  MENU_SEPARATOR_CLASS,
  type BrowserChromeShared,
} from "./browser/browserChrome";
import type {
  BrowserCaptureSelection,
  BrowserFrame,
  BuiltInBrowserContextItem,
  BuiltInBrowserEventPayload,
  BuiltInBrowserScreenshot,
  BuiltInBrowserStatus,
} from "./browser/browserPanelTypes";
import {
  browserEventMatchesProject,
  errorMessage,
  frameLabel,
  normalizeContextItem,
  normalizeScreenshot,
  normalizeSelectionResult,
  normalizeStatus,
  normalizeUrlForNavigation,
  numberField,
  stringField,
  stripDataUrlPrefix,
} from "./browser/browserPanelNormalizers";
import {
  browserCaptureFrame,
  cropBrowserScreenshot,
  pointerToCapturePoint,
} from "./browser/browserCapture";

/**
 * The preload's declared browser namespace, with presence relaxed.
 *
 * The panel used to carry a hand-written copy of this whole surface, which is
 * how `getDevServers` came to be re-widened to `Promise<unknown>` after the
 * preload had already declared its result type. The SHAPE is the declaration's
 * business now; the only thing restated here is that a method may be MISSING at
 * runtime — an older main process on a pinned machine, or the hosted web
 * client, whose namespace is a stub. Optional call sites feature-detect; the
 * handful listed below have existed for as long as the namespace has and are
 * treated as load-bearing.
 *
 * Payloads are still normalized on top of this (`normalizeStatus` and friends):
 * a declared return type says what a current main process SENDS, not what
 * arrived.
 */
type BuiltInBrowserNamespace = Window["ade"]["builtInBrowser"];
type BuiltInBrowserApi =
  & Partial<BuiltInBrowserNamespace>
  & Pick<
    BuiltInBrowserNamespace,
    | "getStatus"
    | "setBounds"
    | "navigate"
    | "reload"
    | "goBack"
    | "goForward"
    | "stop"
    | "startInspect"
    | "stopInspect"
    | "captureScreenshot"
    | "selectCurrent"
    | "clearSelection"
    | "onEvent"
  >;

/**
 * A tunnel the agent asked for that a human has not approved yet.
 *
 * The machine-wide `portForward` grant is consent to reach that machine's
 * loopback, not consent to whatever port an agent names — a lane approved for a
 * dev server on 3000 has not approved an admin console on 8080. Human-typed
 * URLs skip this (the human just typed it) but still open the forward.
 */
type PendingTunnelApproval = {
  key: string;
  remotePort: number;
  machineLabel: string;
  decide: (decision: "once" | "always" | "deny") => void;
};

type ChatBuiltInBrowserPanelProps = {
  sessionId: string | null;
  /** Override project tab routing. `null` selects the personal-chat tab collection. */
  projectRootOverride?: string | null;
  onAddContext?: (item: BuiltInBrowserContextItem) => void;
  onAddAttachment?: (attachment: AgentChatFileRef) => void;
  onInsertDraft?: (text: string) => void;
  runtimePin?: OpenProjectBinding | null;
};

type MessageTone = "info" | "error";
type Message = { tone: MessageTone; text: string };

/** Live find, without a request per keystroke. */
const FIND_DEBOUNCE_MS = 150;
/*
  Why the tabs are not renderer <webview> nodes.

  A renderer-owned <webview> loses its backing webContents when the panel
  unmounts, and this panel unmounts every time the Work sidebar shows a
  different tool. Tabs are owned by the main browser service instead, and this
  panel positions that service's WebContentsView over its own bounds — which is
  what lets a tab survive a tool switch, a second window, and a chat that moves
  between panes.
*/

/** How long the load bar takes to snap shut once the page finishes. */
export const PROGRESS_FINISH_MS = 360;
/** After a page settles, wait this long before taking the warm underlay frame. */
const UNDERLAY_SETTLE_SNAPSHOT_MS = 600;

/** Ports worth a one-shot probe for the empty state's "your dev server" chip. */
const DEV_SERVER_PROBE_PORTS = [3000, 5173, 4321, 8080, 8000] as const;

function getBrowserApi(): BuiltInBrowserApi | null {
  return window.ade?.builtInBrowser ?? null;
}

function requireBrowserApi(): BuiltInBrowserApi {
  const api = getBrowserApi();
  if (!api) throw new Error("Built-in browser is not available in this renderer.");
  return api;
}

/**
 * The browser window belongs to ONE computer: it is a view owned by that
 * desktop's main process, positioned over this panel's on-screen bounds. So the
 * pane always drives THIS window's browser, whatever machine the chat is on — a
 * pin naming another machine used to refuse the pane outright, which meant a
 * remote lane had no browser at all.
 *
 * What a remote pin changes is what `localhost` means. The dev server the agent
 * wants is on the pinned machine, and this desktop's loopback is a different box
 * — often nothing, sometimes a *different* project's server, which is the
 * dangerous case. So every loopback URL is rewritten onto a per-(machine, port)
 * TCP forward before it loads, the URL bar keeps showing the remote origin that
 * was asked for, and the first use of a new port needs a human grant even on a
 * machine already trusted for port-forwarding, because the agent picks the port.
 */
export function ChatBuiltInBrowserPanel({
  sessionId,
  projectRootOverride,
  onAddContext,
  onAddAttachment,
  onInsertDraft,
  runtimePin = null,
}: ChatBuiltInBrowserPanelProps) {
  // Also rendered from the Work sidebar and the personal-chats page, so the
  // scope is derived from the pin this panel is handed.
  const chatScope = useChatRuntimeScopeForPin(runtimePin, null);
  // The chat's lane, when this pane sits inside a chat pane. "Always for this
  // lane" tunnel grants are stored against it; outside a chat provider there is
  // no lane and the grant falls back to the project scope.
  const contextLaneId = useChatRuntimeScope().laneId;
  const projectRoot = projectRootOverride === undefined
    ? chatScope.rootPath
    : projectRootOverride;
  /**
   * The machine this pane's work happens on, when that is not this computer.
   *
   * `runtimePin` is null for a chat on the tab's OWN runtime — the Work pane's
   * router deliberately keeps that on the unpinned fast path. On a remote
   * project tab that runtime is another machine, so "unpinned" there still means
   * "the URLs in this pane are that machine's". Without this fallback a remote
   * project tab got a browser with no tunnel: `http://localhost:3000` loaded
   * THIS computer's port 3000, and `ade browser open` over there was published
   * to a desktop that never subscribed.
   */
  /*
    The lint rule below wants the CHAT's scope, which is right nearly everywhere
    and wrong here: the paragraph above is the argument for reading the project
    tab's binding on purpose. An unpinned pane in a remote project tab has no
    chat scope to ask, and answering "this computer" is the bug being fixed.
  */
  // eslint-disable-next-line no-restricted-syntax -- see the paragraph above: the project tab's machine IS this pane's machine when the pane has no pin.
  const activeProjectBinding = useAppStore((state) => state.projectBinding);
  const remotePin = runtimePin
    ? (runtimePin.kind === "remote" ? runtimePin : null)
    : (activeProjectBinding?.kind === "remote" ? activeProjectBinding : null);
  // Every pin-aware `builtInBrowser.*` call below reads this. A remote pin and
  // no pin route identically (the browser is always this window's), so
  // substituting the tab's own remote binding only adds URL localization.
  const browserRuntimePin = runtimePin ?? remotePin;
  const runtimePinRef = useRef<OpenProjectBinding | null>(browserRuntimePin);
  runtimePinRef.current = browserRuntimePin;
  const browserSurfaceRef = useRef<HTMLDivElement | null>(null);
  /** The stage the letterboxed view is centred in (surface minus the caption). */
  const browserStageRef = useRef<HTMLDivElement | null>(null);
  /** The DOM frame the native view is positioned onto, letterbox included. */
  const browserViewportRef = useRef<HTMLDivElement | null>(null);
  const captureImageRef = useRef<HTMLImageElement | null>(null);
  const statusRef = useRef<BuiltInBrowserStatus | null>(null);
  const selectedItemRef = useRef<BuiltInBrowserContextItem | null>(null);
  const captureModeRef = useRef(false);
  /** True while the launchpad owns the surface, so no view paints over it. */
  const launchpadVisibleRef = useRef(false);
  /*
    Suppression is ref-only on purpose.

    Its one React reader was the <webview> layout effect, which was dead and is
    now deleted — every remaining reader (`reportBounds`, the underlay, the
    occlusion observer) runs outside the render closure. Mirroring it into state
    re-rendered the whole panel on every menu open for nobody's benefit.
  */
  const autoAttachedContextIdsRef = useRef(new Set<string>());
  const editingUrlRef = useRef(false);
  const apiAvailable = Boolean(getBrowserApi());
  const [status, setStatus] = useState<BuiltInBrowserStatus | null>(null);
  const [selectedItem, setSelectedItem] = useState<BuiltInBrowserContextItem | null>(null);
  const [urlInput, setUrlInput] = useState("");
  const [editingUrl, setEditingUrl] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [attachmentAck, setAttachmentAck] = useState<string | null>(null);
  const [, setLastScreenshot] = useState<BuiltInBrowserScreenshot | null>(null);
  const [captureBase, setCaptureBase] = useState<BuiltInBrowserScreenshot | null>(null);
  const [captureSelection, setCaptureSelection] = useState<BrowserCaptureSelection | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileDiagnostics, setProfileDiagnostics] = useState<BuiltInBrowserProfileDiagnostics | null>(null);
  const [permissionDecisions, setPermissionDecisions] = useState<BuiltInBrowserPermissionDecision[]>([]);
  const reduceMotion = useReducedMotion() ?? false;
  const panelRef = useRef<HTMLDivElement | null>(null);
  /*
    ONE address field, always the chrome row's.

    The launchpad used to draw a boxed copy of the omnibox in the middle of the
    column, so an empty tab showed two live URL fields writing the same state —
    two answers to "where do I type". The launchpad keeps the offers; the field
    stays where it is on every other page, and gets the caret.
  */
  const urlInputRef = useRef<HTMLInputElement | null>(null);
  const findInputRef = useRef<HTMLInputElement | null>(null);
  const tabStripRef = useRef<HTMLDivElement | null>(null);
  /** The row whose measured width decides what the toolbar can afford. */
  const toolbarRowRef = useRef<HTMLDivElement | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findText, setFindText] = useState("");
  const [findState, setFindState] = useState<BrowserFindState | null>(null);
  const [findError, setFindError] = useState<string | null>(null);
  const findDebounceRef = useRef<number | null>(null);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [deviceMenuOpen, setDeviceMenuOpen] = useState(false);
  const [responsiveWidth, setResponsiveWidth] = useState("1024");
  const [responsiveHeight, setResponsiveHeight] = useState("768");
  const [linkMode, setLinkModeState] = useState<BrowserLinkOpenMode>(() => getLinkOpenMode());
  const [recordingFps, setRecordingFps] = useState<BuiltInBrowserRecordingFps>(30);
  // Re-rendered once a second while recording so the REC pill's clock ticks.
  const [recordingClock, setRecordingClock] = useState(() => Date.now());
  const [importOpen, setImportOpen] = useState(false);
  const [bootedSimulatorName, setBootedSimulatorName] = useState<string | null>(null);
  const [devServers, setDevServers] = useState<BrowserDevServer[]>([]);
  /** The service answered, and had nothing — so the port probe still runs. */
  const [discoveryEmpty, setDiscoveryEmpty] = useState(false);
  const [clipboardUrl, setClipboardUrl] = useState<string | null>(null);
  const [recentUrls, setRecentUrls] = useState<BrowserRecentUrl[]>([]);
  const [failedFavicons, setFailedFavicons] = useState<Record<string, true>>({});
  const [tabStripFades, setTabStripFades] = useState<{ start: boolean; end: boolean }>({ start: false, end: false });
  const [paneWidth, setPaneWidth] = useState<number | null>(null);
  const [progressPhase, setProgressPhase] = useState<"idle" | "loading" | "finishing">("idle");
  const progressPhaseRef = useRef<"idle" | "loading" | "finishing">("idle");
  const [viewFrame, setViewFrame] = useState<BrowserViewFrame>({ left: 1, top: 1, width: 0, height: 0, scale: 1 });
  /** Read by `reportBounds`, which runs outside this render's closure. */
  const viewScaleRef = useRef(1);
  // Which tabs are looking at the pinned machine, and through which forward.
  const [tabTunnels, setTabTunnels] = useState<TabTunnelMap>({});
  const tabTunnelsRef = useRef<TabTunnelMap>(tabTunnels);
  tabTunnelsRef.current = tabTunnels;
  const [pendingApproval, setPendingApproval] = useState<PendingTunnelApproval | null>(null);
  // Approvals answered "Allow once" live only as long as this pane does; the
  // "Always" set is persisted per lane alongside the rest of its view state.
  const sessionApprovedTunnelsRef = useRef<ReadonlySet<string>>(new Set<string>());
  const browserScope = useMemo<BuiltInBrowserProjectScopeArgs>(
    () => (projectRootOverride === null
      ? { tabCollection: "personal" }
      : projectRoot
        ? { projectRoot }
        : {}),
    [projectRoot, projectRootOverride],
  );
  const browserScopeRef = useRef<BuiltInBrowserProjectScopeArgs>(browserScope);
  browserScopeRef.current = browserScope;
  const withBrowserScope = useCallback(<T extends Record<string, unknown>>(args: T): T & BuiltInBrowserProjectScopeArgs => (
    ({ ...args, ...browserScope }) as T & BuiltInBrowserProjectScopeArgs
  ), [browserScope]);
  const remotePinRef = useRef<Extract<OpenProjectBinding, { kind: "remote" }> | null>(remotePin);
  remotePinRef.current = remotePin;

  /** Mirrors `pendingApproval` so the bar can be replaced without a nested setState. */
  const pendingApprovalRef = useRef<PendingTunnelApproval | null>(null);

  const readAlwaysTunnelKeys = useCallback((): string[] => {
    const store = useAppStore.getState();
    return contextLaneId
      ? store.getLaneWorkViewState(projectRoot, contextLaneId).browserTunnelAlwaysKeys
      : store.getWorkViewState(projectRoot).browserTunnelAlwaysKeys;
  }, [contextLaneId, projectRoot]);

  const rememberAlwaysTunnelKey = useCallback((key: string) => {
    const store = useAppStore.getState();
    const patch = (prev: WorkProjectViewState): WorkProjectViewState => (
      prev.browserTunnelAlwaysKeys.includes(key)
        ? prev
        : { ...prev, browserTunnelAlwaysKeys: [...prev.browserTunnelAlwaysKeys, key] }
    );
    if (contextLaneId) store.setLaneWorkViewState(projectRoot, contextLaneId, patch);
    else store.setWorkViewState(projectRoot, patch);
  }, [contextLaneId, projectRoot]);

  /**
   * Record an answer. The rule for what each answer changes lives in
   * `browserRemoteTunnels`, tested without a DOM; this only moves the result
   * into the ref and the persisted list.
   */
  const applyTunnelAnswer = useCallback((key: string, answer: TunnelApprovalAnswer) => {
    const before: TunnelApprovalState = {
      sessionApproved: sessionApprovedTunnelsRef.current,
      alwaysKeys: readAlwaysTunnelKeys(),
    };
    const after = commitTunnelApproval(before, key, answer);
    sessionApprovedTunnelsRef.current = after.sessionApproved;
    if (after.alwaysKeys !== before.alwaysKeys) rememberAlwaysTunnelKey(key);
  }, [readAlwaysTunnelKeys, rememberAlwaysTunnelKey]);

  /**
   * Gate one (machine, port) pair behind a human.
   *
   * The pinned machine already carries a `portForward` grant, but that grant is
   * about the machine, and here the *agent* names the port — so the first use of
   * a port it chose needs a person to say yes. A URL the human typed does not:
   * they just said it out loud by typing it.
   */
  const ensureTunnelApproval = useCallback(async (
    remotePort: number,
    machineLabel: string,
    options: { human: boolean; onAsk?: () => void },
  ): Promise<boolean> => {
    const pin = remotePinRef.current;
    if (!pin) return true;
    const key = remoteTunnelApprovalKey(pin.targetId, remotePort);
    const decision = tunnelApprovalDecision({
      key,
      human: options.human,
      sessionApproved: sessionApprovedTunnelsRef.current,
      alwaysKeys: readAlwaysTunnelKeys(),
    });
    if (decision === "allow") {
      // A human-typed URL self-approves, and the port stays approved for the
      // rest of this pane's life rather than re-asking on the next hop.
      if (options.human) applyTunnelAnswer(key, "once");
      return true;
    }
    options.onAsk?.();
    return await new Promise<boolean>((resolve) => {
      /*
        Replace the open bar OUTSIDE the state updater.

        `setPendingApproval(previous => { previous?.decide("deny"); ... })` ran a
        nested `setPendingApproval(null)` from inside an updater React is free to
        invoke eagerly and again during render — which could apply the nested
        null AFTER this updater's return value and leave `pendingApproval` null
        with a promise nobody would ever resolve. A ref makes the replacement an
        ordinary statement.
      */
      const previous = pendingApprovalRef.current;
      previous?.decide("deny");
      const next: PendingTunnelApproval = {
        key,
        remotePort,
        machineLabel,
        decide: (answer) => {
          if (pendingApprovalRef.current === next) {
            pendingApprovalRef.current = null;
            setPendingApproval(null);
          }
          applyTunnelAnswer(key, answer);
          resolve(answer !== "deny");
        },
      };
      pendingApprovalRef.current = next;
      setPendingApproval(next);
    });
  }, [applyTunnelAnswer, readAlwaysTunnelKeys]);

  /*
    An unanswered bar must not outlive the pane.

    The Work sidebar unmounts this panel whenever another tool is shown, and an
    approval promise left hanging would keep the remote request's async chain
    alive forever. Unmount is a refusal, not an approval.
  */
  useEffect(() => () => {
    const pending = pendingApprovalRef.current;
    pendingApprovalRef.current = null;
    pending?.decide("deny");
  }, []);

  /**
   * Everything a loopback URL needs before it can load on a remote pin: the
   * human grant, then the forward itself. Returns the tunnel so the caller can
   * remember which tab is showing another machine. A non-loopback URL, or a
   * local pin, is a no-op.
   */
  const prepareRemoteNavigation = useCallback(async (
    url: string,
    options: { human: boolean; onAsk?: () => void },
  ): Promise<{ ok: boolean; tunnel: RemoteLoopbackTunnel | null; reason: string | null }> => {
    const pin = remotePinRef.current;
    if (!pin) return { ok: true, tunnel: null, reason: null };
    const parsed = parseLoopbackUrl(url);
    if (!parsed) return { ok: true, tunnel: null, reason: null };
    const machineLabel = machineNameForBinding(pin);
    const approved = await ensureTunnelApproval(parsed.port, machineLabel, options);
    if (!approved) {
      return {
        ok: false,
        tunnel: null,
        reason: `Reaching port ${parsed.port} on ${machineLabel} was not allowed.`,
      };
    }
    const api = getBrowserApi();
    if (!api?.localizeRemoteUrl) return { ok: true, tunnel: null, reason: null };
    const localized = await api.localizeRemoteUrl({ url }, pin);
    return { ok: true, tunnel: localized.forward, reason: null };
  }, [ensureTunnelApproval]);

  const browserTabs = useMemo(() => status?.tabs ?? [], [status?.tabs]);
  const tabIdsSignature = useMemo(() => browserTabs.map((tab) => tab.id).join("|"), [browserTabs]);
  const activeTabId = status?.activeTabId ?? browserTabs[0]?.id ?? null;
  const activeTabTunnel = activeTabId ? tabTunnels[activeTabId] ?? null : null;
  // What the human asked for, not the ephemeral forward port behind it.
  const currentUrl = tunnelAwareUrl(status?.url ?? "", activeTabTunnel);
  const canGoBack = Boolean(status?.canGoBack);
  const canGoForward = Boolean(status?.canGoForward);
  const inspecting = Boolean(status?.inspecting);
  /** Nothing open: the chrome has to stop describing a page that is gone. */
  const hasTab = browserTabs.length > 0;
  /** Read by the zoom claim, which runs outside this render's closure. */
  const hasTabRef = useRef(hasTab);
  hasTabRef.current = hasTab;
  const selectionFrame = frameLabel(selectedItem?.frame ?? null);
  const activeTab = useMemo(
    () => browserTabs.find((tab) => tab.id === activeTabId) ?? null,
    [activeTabId, browserTabs],
  );
  /**
   * Loading, from whichever half of the payload knows.
   *
   * `status.loading` is only set by main processes that send a top-level flag;
   * the per-tab `isLoading` is what `did-start-loading` actually updates, and
   * reading only the first left the progress bar dead on every real navigation
   * while the tab pill's own spinner span.
   */
  const loading = Boolean(status?.loading || activeTab?.isLoading);
  const handoff = activeTab?.handoff ?? null;
  /**
   * Origin the auto hand-back offer is currently suppressed for.
   *
   * "Keep control" must silence the offer only until the NEXT origin change —
   * a sign-in that bounces through three identity-provider hosts would
   * otherwise re-ask on every hop, and a permanent dismissal would lose the
   * offer for the origin the human actually lands on.
   */
  const [handoffOfferSilencedOrigin, setHandoffOfferSilencedOrigin] = useState<string | null>(null);
  const currentHandoffOrigin = useMemo(() => browserUrlOrigin(currentUrl), [currentUrl]);
  const handoffLeftStartOrigin = Boolean(
    handoff?.startedAtOrigin
    && currentHandoffOrigin
    && currentHandoffOrigin !== handoff.startedAtOrigin,
  );
  const showHandoffHandBackOffer = handoffLeftStartOrigin
    && currentHandoffOrigin !== handoffOfferSilencedOrigin;
  const emulation = activeTab?.emulation ?? null;
  const zoomFactor = activeTab?.zoomFactor && activeTab.zoomFactor > 0 ? activeTab.zoomFactor : 1;
  const devToolsOpen = Boolean(activeTab?.devToolsOpen);
  const networkLogging = Boolean(activeTab?.networkLogging);
  const recording: BuiltInBrowserRecordingStatus | null = activeTab?.recording ?? null;
  // A padlock over an empty omnibox is a claim about a connection that does
  // not exist, so the lock belongs to the tab, not to the last string we saw.
  const lockKind = hasTab ? urlLockKind(currentUrl) : "none";
  const captureImageDataUrl = captureBase?.dataUrl ?? captureBase?.screenshotDataUrl ?? null;
  const activeCaptureFrame = useMemo(() => (
    captureBase?.width && captureBase?.height && captureSelection
      ? browserCaptureFrame(captureSelection, captureBase.width, captureBase.height)
      : null
  ), [captureBase?.height, captureBase?.width, captureSelection]);

  useEffect(() => {
    editingUrlRef.current = editingUrl;
  }, [editingUrl]);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    autoAttachedContextIdsRef.current = new Set();
  }, [status?.url, status?.activeTabId]);

  useEffect(() => {
    selectedItemRef.current = selectedItem;
  }, [selectedItem]);

  useEffect(() => {
    if (!attachmentAck) return undefined;
    const timer = window.setTimeout(() => setAttachmentAck(null), 4_000);
    return () => window.clearTimeout(timer);
  }, [attachmentAck]);

  /**
   * Record which tab is looking at another machine, ref first.
   *
   * `applyStatus` runs from an IPC callback that can land before React has
   * re-rendered, and it reads this map to build the omnibox string — so a map
   * that only existed in state showed the raw `127.0.0.1:<ephemeral>` forward
   * for a cycle after every tunneled navigation, which is the one thing the
   * display rule exists to prevent.
   */
  const rememberTabTunnel = useCallback((
    tabId: string | null,
    tunnel: RemoteLoopbackTunnel | null,
  ) => {
    const next = setTabTunnel(tabTunnelsRef.current, tabId, tunnel);
    if (next === tabTunnelsRef.current) return;
    tabTunnelsRef.current = next;
    setTabTunnels(next);
  }, []);

  const applyStatus = useCallback((value: unknown) => {
    const normalized = normalizeStatus(value, statusRef.current);
    statusRef.current = normalized;
    const nextSelection = normalized.selectedItem;
    selectedItemRef.current = nextSelection;
    setStatus(normalized);
    setSelectedItem(nextSelection);
    // Tabs that closed, or left the forwarded origin for a real site, stop
    // being described as the pinned machine's.
    if (Object.keys(tabTunnelsRef.current).length > 0) {
      const reconciled = reconcileTabTunnels(tabTunnelsRef.current, normalized.tabs);
      if (reconciled !== tabTunnelsRef.current) {
        tabTunnelsRef.current = reconciled;
        setTabTunnels(reconciled);
      }
    }
    if (!editingUrlRef.current) {
      // Nothing open means nothing to show: the field goes back to its
      // placeholder rather than holding the address of a tab that is gone.
      if (normalized.tabs.length === 0) {
        setUrlInput("");
        return;
      }
      // Never show the ephemeral forward port: the human asked for the remote
      // origin, and that is the URL they can copy, share, or retype.
      const activeId = normalized.activeTabId;
      setUrlInput(tunnelAwareUrl(
        normalized.url,
        activeId ? tabTunnelsRef.current[activeId] ?? null : null,
      ));
    }
  }, []);

  const refreshStatus = useCallback(async () => {
    const api = requireBrowserApi();
    const nextStatus = await api.getStatus(browserScope, runtimePinRef.current);
    applyStatus(nextStatus);
  }, [applyStatus, browserScope]);

  const attachBrowserContextItem = useCallback(async (
    item: BuiltInBrowserContextItem,
    options: { force?: boolean; auto?: boolean; label?: string } = {},
  ): Promise<BuiltInBrowserContextItem | null> => {
    if (!onAddContext) throw new Error("Context insertion is not available in this panel.");
    if (!options.force && autoAttachedContextIdsRef.current.has(item.id)) return null;

    let attachmentPath = typeof item.metadata?.attachmentPath === "string" ? item.metadata.attachmentPath : null;
    const screenshotDataUrl = item.screenshotDataUrl ?? null;
    if (screenshotDataUrl && !attachmentPath && onAddAttachment) {
      try {
        const saved = await window.ade.agentChat.saveTempAttachment({
          data: stripDataUrlPrefix(screenshotDataUrl),
          filename: item.kind === "built_in_browser_capture" ? "built-in-browser-capture.png" : "built-in-browser-selection.png",
        }, ...(runtimePin ? [runtimePin] as const : []));
        attachmentPath = saved.path;
        onAddAttachment({ path: saved.path, type: inferAttachmentType(saved.path, "image/png") });
      } catch (error) {
        setMessage({ tone: "error", text: `Could not save browser context screenshot: ${errorMessage(error)}` });
      }
    }

    const contextItem: BuiltInBrowserContextItem = {
      ...item,
      sessionId: item.sessionId ?? sessionId,
      metadata: {
        ...item.metadata,
        browserContextPacketVersion: item.metadata.browserContextPacketVersion ?? 1,
        contextSurface: item.metadata.contextSurface ?? "built_in_browser",
        ...(sessionId ? { chatSessionId: sessionId } : {}),
        ...(attachmentPath ? { attachmentPath } : {}),
      },
    };
    onAddContext(contextItem);
    autoAttachedContextIdsRef.current.add(item.id);
    selectedItemRef.current = contextItem;
    setSelectedItem(contextItem);
    setStatus((current) => current ? { ...current, selectedItem: contextItem } : current);
    const isCapture = item.kind === "built_in_browser_capture";
    setAttachmentAck(options.label ?? (isCapture ? "Browser capture attached." : "Browser context attached."));
    let messageText: string;
    if (options.auto) {
      messageText = "Inserted browser inspect context.";
    } else if (isCapture) {
      messageText = "Inserted browser capture with page context.";
    } else {
      messageText = "Inserted the selected browser element context.";
    }
    setMessage({ tone: "info", text: messageText });
    return contextItem;
  }, [onAddAttachment, onAddContext, runtimePin, sessionId]);

  /**
   * Capture the frame the underlay paints, without touching the UI.
   *
   * Kept warm after a page settles so the common case — open a menu on a page
   * that finished loading a moment ago — repaints instantly rather than after
   * an IPC round trip the human would see as a black flash.
   */
  const captureUnderlayFrame = useCallback(async (): Promise<string | null> => {
    const api = getBrowserApi();
    if (!api?.captureScreenshot) return null;
    const result = await api.captureScreenshot(browserScope, runtimePinRef.current);
    const shot = normalizeScreenshot(result, statusRef.current);
    return shot?.dataUrl ?? shot?.screenshotDataUrl ?? null;
  }, [browserScope]);

  const pushBrowserBounds = useCallback(async (bounds: BrowserBounds): Promise<void> => {
    const api = requireBrowserApi();
    await api.setBounds(withBrowserScope(bounds), runtimePinRef.current);
  }, [withBrowserScope]);

  const stopBrowserInspect = useCallback(async (): Promise<void> => {
    const api = requireBrowserApi();
    await api.stopInspect(browserScope, runtimePinRef.current);
  }, [browserScope]);

  const reportBoundsError = useCallback((text: string) => {
    setMessage({ tone: "error", text: `Could not position browser: ${text}` });
  }, []);

  /*
    Bounds, occlusion and the frozen-frame underlay.

    Three ref-driven machines with no JSX of their own: they measure this
    panel's DOM frame, decide when the composited view is allowed to be seen,
    and freeze a frame under every popover that has to hide it.
  */
  const {
    reportBounds,
    hideNativeBrowserView,
    refreshUnderlaySnapshot,
    underlay,
  } = useNativeBrowserViewBounds({
    surfaceRef: browserSurfaceRef,
    stageRef: browserStageRef,
    viewportRef: browserViewportRef,
    panelRef,
    viewScaleRef,
    captureModeRef,
    launchpadVisibleRef,
    enabled: apiAvailable,
    setBounds: pushBrowserBounds,
    stopInspect: stopBrowserInspect,
    captureFrame: captureUnderlayFrame,
    onError: reportBoundsError,
  });

  useEffect(() => {
    const api = getBrowserApi();
    if (!api) {
      setMessage({ tone: "error", text: "Built-in browser API is not available in this renderer." });
      return undefined;
    }
    let cancelled = false;
    api.getStatus(browserScope, runtimePinRef.current)
      .then((nextStatus) => {
        if (!cancelled) applyStatus(nextStatus);
      })
      .catch((error: unknown) => {
        if (!cancelled) setMessage({ tone: "error", text: errorMessage(error) });
      });
    // Widened once, here, on purpose. The preload declares a closed union of
    // what a CURRENT main process sends; this panel also has to survive an older
    // one (a pinned machine on a previous release), whose events carry a subset
    // — and in a couple of cases a differently-spelled field. `event` is read
    // through the same field-by-field normalizers as every other payload, so the
    // widening buys permissiveness at the boundary and nothing beyond it.
    const unsubscribe = api.onEvent((raw) => {
      const event = raw as BuiltInBrowserEventPayload;
      if (!browserEventMatchesProject(event, projectRoot)) return;
      const eventType = typeof event.type === "string" ? event.type : "";
      if (event.status) {
        applyStatus(event.status);
      } else if (
        eventType === "status"
        || eventType === "status-changed"
        || eventType === "updated"
        || eventType === "navigation"
      ) {
        applyStatus(event);
      }
      if (eventType === "found-in-page") {
        // Counts come from the page itself, so the bar updates on the event
        // rather than waiting for the request that started the search.
        setFindError(null);
        setFindState({
          activeMatchOrdinal: numberField(event.activeMatchOrdinal),
          matches: numberField(event.matches),
        });
      }
      if (eventType === "dev-server-detected") {
        setDevServers((previous) => mergeDevServer(
          previous,
          normalizeDevServer(event.server ?? event.devServer ?? event),
        ));
      }
      if (eventType === "recording") {
        // The recording event carries no status, and `tab.recording` is what the
        // REC pill reads — so pull the tab state that just changed. That read is
        // also what clears the pill.
        api.getStatus(browserScope, runtimePinRef.current).then(applyStatus).catch(() => {});
        // A recording nobody stopped stopped anyway. The pill clearing is the
        // only other signal, and a pill that vanishes says nothing about why —
        // which is exactly the question a truncated clip raises.
        // Named by tab: this event is scoped to the project, not to the tab in
        // front of the user, so a background tab hitting the cap would
        // otherwise raise a toast that reads as being about the visible page.
        const endedBy = recordingEndedByMessage(event.endedBy, event.tabTitle);
        if (endedBy) showToast({ title: "Recording stopped", message: endedBy, tone: "info" });
      }
      const nextSelection =
        normalizeContextItem(event.item, statusRef.current)
        ?? normalizeContextItem(event.selection, statusRef.current)
        ?? normalizeContextItem(event.selectedItem, statusRef.current);
      if (nextSelection) {
        selectedItemRef.current = nextSelection;
        setSelectedItem(nextSelection);
        setStatus((current) => current ? { ...current, selectedItem: nextSelection } : current);
        if (!captureModeRef.current && onAddContext) {
          void attachBrowserContextItem(nextSelection, {
            auto: true,
            label: "Browser context attached.",
          }).catch((error: unknown) => {
            setMessage({ tone: "error", text: errorMessage(error) });
          });
        }
      } else if (eventType === "selection-cleared" || eventType === "clear-selection") {
        selectedItemRef.current = null;
        setSelectedItem(null);
        setStatus((current) => current ? { ...current, selectedItem: null } : current);
      }
      const nextScreenshot = normalizeScreenshot(event.screenshot, statusRef.current);
      if (nextScreenshot) {
        // Drop the data URL; only width/height/capturedAt are surfaced in the UI.
        // Retaining multi-MB base64 strings across the panel's lifetime bloats the renderer heap.
        setLastScreenshot({
          width: nextScreenshot.width ?? null,
          height: nextScreenshot.height ?? null,
          capturedAt: nextScreenshot.capturedAt ?? null,
        });
      }
      const nextError = stringField(event.error) ?? stringField(event.message);
      if (nextError && /error|failed/i.test(eventType || "error")) {
        setMessage({ tone: "error", text: nextError });
      }
    }, runtimePinRef.current);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [applyStatus, attachBrowserContextItem, browserScope, onAddContext, projectRoot]);

  /**
   * `ade browser open` run on the pinned machine.
   *
   * That machine has no browser of its own — only `ade serve` — so its daemon
   * publishes the URL and waits for a desktop that has the lane pinned to take
   * it. This is that desktop: the URL goes through the same approval and
   * port-forward path a human navigation does, and the ack is what lets the
   * agent's CLI print where it ended up instead of an error.
   */
  useEffect(() => {
    const api = getBrowserApi();
    const pin = remotePin;
    if (!api?.onRemoteRequest || !pin) return undefined;
    let cancelled = false;
    const unsubscribe = api.onRemoteRequest((request) => {
      // One request, one answering panel.
      //
      // The preload fanout now delivers to every panel mounted for this pin, so
      // a lane's Work pane and a project-level pane would both navigate and both
      // ack the same request. A request that names a lane or a chat belongs to
      // the panel that IS that lane/chat. A panel with no identity of its own
      // still takes it — the project-level pane is the one that answers a
      // request from outside any lane, and dropping those would make
      // `ade browser open` silently do nothing.
      if (request.laneId && contextLaneId && request.laneId !== contextLaneId) return;
      if (request.chatSessionId && sessionId && request.chatSessionId !== sessionId) return;
      void (async () => {
        let accepted = false;
        let reason: string | null = null;
        const acknowledge = async (payload: {
          accepted: boolean;
          awaitingApproval?: boolean;
          reason: string | null;
        }) => {
          await api.acknowledgeRemoteRequest?.(
            { requestId: request.requestId, desktopLabel: THIS_MACHINE_NAME, ...payload },
            pin,
          ).catch(() => {});
        };
        /*
          The requester gives up after 5 seconds, and nobody answers an approval
          bar in 5 seconds. So the moment a bar goes up the desktop says "I took
          this, a person is deciding" — the CLI prints that and exits 0 — and
          the page loads whenever the person gets to it. The real outcome is
          still acked afterwards: by then it usually lands on a requestId nobody
          is waiting on, which the daemon drops, but when the human WAS fast it
          is the answer the CLI gets.
        */
        let awaitingAcked = false;
        try {
          const prepared = await prepareRemoteNavigation(request.url, {
            human: false,
            onAsk: () => {
              awaitingAcked = true;
              void acknowledge({ accepted: true, awaitingApproval: true, reason: null });
            },
          });
          if (cancelled) return;
          if (!prepared.ok) {
            reason = prepared.reason;
          } else {
            await api.navigate(
              withBrowserScope({
                url: request.url,
                ...(request.openPanel ? { openPanel: true } : {}),
                ...(request.laneId ? { laneId: request.laneId } : {}),
                ...(request.chatSessionId ? { chatSessionId: request.chatSessionId } : {}),
              }),
              pin,
            );
            // Before the refresh, not after: the refresh applies a status the
            // omnibox is rendered from, and it has to already know this tab is
            // showing the pinned machine.
            if (prepared.tunnel) {
              rememberTabTunnel(statusRef.current?.activeTabId ?? null, prepared.tunnel);
            }
            await refreshStatus();
            accepted = true;
          }
        } catch (error) {
          reason = errorMessage(error);
        }
        if (cancelled) return;
        if (!accepted && reason) setMessage({ tone: "error", text: reason });
        // Nothing new to say when the request needed no prompt and succeeded —
        // that is exactly what the pre-ack already claimed.
        if (!awaitingAcked || !accepted) await acknowledge({ accepted, reason });
      })();
    }, pin);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [
    contextLaneId,
    prepareRemoteNavigation,
    refreshStatus,
    rememberTabTunnel,
    remotePin,
    sessionId,
    withBrowserScope,
  ]);

  const runBusy = useCallback(async (label: string, action: () => Promise<void>) => {
    setBusy(label);
    setMessage(null);
    try {
      await action();
    } catch (error) {
      setMessage({ tone: "error", text: errorMessage(error) });
    } finally {
      setBusy(null);
    }
  }, []);

  const restoreLiveBrowserView = useCallback(() => {
    captureModeRef.current = false;
    setCaptureBase(null);
    setCaptureSelection(null);
    window.requestAnimationFrame(() => reportBounds());
  }, [reportBounds]);

  /*
   * There is deliberately no "open Google when the pane is empty" effect.
   *
   * An empty browser is not a broken browser — it is a browser waiting to be
   * told where to go, and the launchpad below is that question. Loading a
   * search engine nobody asked for also made "close the last tab" mean "open a
   * new one", which is the opposite of what closing a tab means anywhere else.
   */

  const navigateToUrl = useCallback(
    (raw: string) => {
      const normalized = normalizeUrlForNavigation(raw);
      if (!normalized.ok) {
        setMessage({ tone: "error", text: normalized.reason });
        return;
      }
      const nextUrl = normalized.url;
      if (!nextUrl) return;
      void runBusy("navigate", async () => {
        if (captureModeRef.current) restoreLiveBrowserView();
        const api = requireBrowserApi();
        // The human typed this, so no approval bar — but a loopback URL on a
        // remote pin still has to be tunneled before it means anything here.
        const prepared = await prepareRemoteNavigation(nextUrl, { human: true });
        if (!prepared.ok) {
          setMessage({ tone: "error", text: prepared.reason ?? "Navigation was not allowed." });
          return;
        }
        await api.navigate(withBrowserScope({ url: nextUrl }), runtimePinRef.current);
        setUrlInput(nextUrl);
        /*
          Submitting is the end of typing.

          The page is a native view the compositor paints over this renderer, so
          clicking into it never fires `blur` on the omnibox — without this the
          field stayed "being edited" forever and the submit arrow sat in the
          chrome row over a page nobody was addressing.
        */
        setEditingUrl(false);
        urlInputRef.current?.blur();
        // Before the refresh: see `rememberTabTunnel`.
        if (prepared.tunnel) {
          rememberTabTunnel(statusRef.current?.activeTabId ?? null, prepared.tunnel);
        }
        await refreshStatus();
      });
    },
    [prepareRemoteNavigation, refreshStatus, rememberTabTunnel, restoreLiveBrowserView, runBusy, withBrowserScope],
  );

  const handleNavigate = useCallback(
    (event?: FormEvent<HTMLFormElement>) => {
      event?.preventDefault();
      navigateToUrl(urlInput);
    },
    [navigateToUrl, urlInput],
  );

  /** Launchpad chips: fill the URL field so the bar reflects what loaded. */
  const handleSuggestion = useCallback((url: string) => {
    setUrlInput(url);
    navigateToUrl(url);
  }, [navigateToUrl]);

  /**
   * `+` opens an empty tab, not a page.
   *
   * A new tab is a question ("where to?"), so it lands on the launchpad with
   * the URL field focused rather than on somebody's search engine.
   */
  const handleNewTab = useCallback(() => {
    void runBusy("new-tab", async () => {
      if (captureModeRef.current) restoreLiveBrowserView();
      const api = requireBrowserApi();
      if (!api.createTab) throw new Error("This ADE build does not support browser tabs.");
      const nextStatus = await api.createTab(withBrowserScope({ activate: true }), runtimePinRef.current);
      applyStatus(nextStatus);
      setUrlInput("");
    });
  }, [applyStatus, restoreLiveBrowserView, runBusy, withBrowserScope]);

  const handleSwitchTab = useCallback((tabId: string) => {
    void runBusy("switch-tab", async () => {
      if (captureModeRef.current) restoreLiveBrowserView();
      const api = requireBrowserApi();
      if (api.switchTab) {
        await api.switchTab(withBrowserScope({ tabId }), runtimePinRef.current);
      } else {
        throw new Error("This ADE build does not support browser tab switching.");
      }
      await refreshStatus();
    });
  }, [refreshStatus, restoreLiveBrowserView, runBusy, withBrowserScope]);

  const handleCloseTab = useCallback((tabId: string) => {
    void runBusy("close-tab", async () => {
      if (captureModeRef.current) restoreLiveBrowserView();
      const api = requireBrowserApi();
      if (api.closeTab) {
        await api.closeTab(withBrowserScope({ tabId }), runtimePinRef.current);
      } else {
        throw new Error("This ADE build does not support closing browser tabs.");
      }
      await refreshStatus();
    });
  }, [refreshStatus, restoreLiveBrowserView, runBusy, withBrowserScope]);

  /**
   * ⌘W and the ⋯ menu's "Close tab": close whichever tab is in front.
   *
   * The strip hides itself at one tab, which took its × with it — so the last
   * tab could not be closed at all, and a page you were done with had to be
   * navigated away from instead. Closing the last one leaves the pane on the
   * launchpad, which is what a browser with no page is.
   */
  const handleCloseActiveTab = useCallback(() => {
    const tabId = statusRef.current?.activeTabId ?? null;
    if (!tabId) return false;
    handleCloseTab(tabId);
    return true;
  }, [handleCloseTab]);

  const handleHandBack = useCallback((endedBy: "human" | "auto-offer") => {
    void runBusy("hand-back", async () => {
      const api = requireBrowserApi();
      if (!api.endHandoff) {
        throw new Error("This ADE build does not support handing the browser back.");
      }
      // Deliberately un-pinned. The handed-off tab is THIS Electron process's
      // own WebContentsView; the daemon round trip cannot reach it, and the
      // bridge refuses a user client for having no chat capability. Preload
      // routes this one call straight to local IPC.
      await api.endHandoff(withBrowserScope({ endedBy }));
      setHandoffOfferSilencedOrigin(null);
      await refreshStatus();
    });
  }, [refreshStatus, runBusy, withBrowserScope]);

  const handleKeepHandoffControl = useCallback(() => {
    setHandoffOfferSilencedOrigin(currentHandoffOrigin);
  }, [currentHandoffOrigin]);

  // A new handoff always starts with a live offer, whatever the previous one silenced.
  useEffect(() => {
    if (!handoff) setHandoffOfferSilencedOrigin(null);
  }, [handoff?.startedAt, handoff]);

  const handleBack = useCallback(() => {
    void runBusy("back", async () => {
      const api = requireBrowserApi();
      await api.goBack(browserScope, runtimePinRef.current);
      await refreshStatus();
    });
  }, [browserScope, refreshStatus, runBusy]);

  const handleForward = useCallback(() => {
    void runBusy("forward", async () => {
      const api = requireBrowserApi();
      await api.goForward(browserScope, runtimePinRef.current);
      await refreshStatus();
    });
  }, [browserScope, refreshStatus, runBusy]);

  const handleReload = useCallback(() => {
    void runBusy("reload", async () => {
      const api = requireBrowserApi();
      await api.reload(browserScope, runtimePinRef.current);
      await refreshStatus();
    });
  }, [browserScope, refreshStatus, runBusy]);

  const handleStop = useCallback(() => {
    void runBusy("stop", async () => {
      const api = requireBrowserApi();
      await api.stop(browserScope, runtimePinRef.current);
      await refreshStatus();
    });
  }, [browserScope, refreshStatus, runBusy]);

  const handleInspectToggle = useCallback(() => {
    void runBusy(inspecting ? "inspect-off" : "inspect-on", async () => {
      const api = requireBrowserApi();
      if (inspecting) {
        await api.stopInspect(browserScope, runtimePinRef.current);
      } else {
        await api.startInspect(browserScope, runtimePinRef.current);
      }
      await refreshStatus();
    });
  }, [browserScope, inspecting, refreshStatus, runBusy]);

  const handleClearSelection = useCallback(() => {
    void runBusy("clear-selection", async () => {
      const api = requireBrowserApi();
      await api.clearSelection(browserScope, runtimePinRef.current);
      selectedItemRef.current = null;
      setSelectedItem(null);
      setStatus((current) => current ? { ...current, selectedItem: null } : current);
      setAttachmentAck(null);
    });
  }, [browserScope, runBusy]);

  const handleAttachSelection = useCallback(() => {
    void runBusy("select", async () => {
      const api = requireBrowserApi();
      const result = await api.selectCurrent(browserScope, runtimePinRef.current);
      const item =
        normalizeSelectionResult(result, statusRef.current)
        ?? selectedItemRef.current
        ?? statusRef.current?.selectedItem
        ?? null;
      if (!item) throw new Error("Select an element in Inspect mode first.");
      await attachBrowserContextItem(item, { force: true, label: "Browser context attached." });
    });
  }, [attachBrowserContextItem, browserScope, runBusy]);

  const handleAttachScreenshot = useCallback(() => {
    void runBusy("screenshot", async () => {
      if (!onAddContext) throw new Error("Context insertion is not available in this panel.");
      if (captureModeRef.current) {
        restoreLiveBrowserView();
        setMessage({ tone: "info", text: "Browser screenshot capture cancelled." });
        return;
      }
      const api = requireBrowserApi();
      const result = await api.captureScreenshot(browserScope, runtimePinRef.current);
      const screenshot = normalizeScreenshot(result, statusRef.current);
      if (!screenshot) throw new Error("Browser screenshot capture did not return an image.");
      if (!(screenshot.dataUrl ?? screenshot.screenshotDataUrl) || !screenshot.width || !screenshot.height) {
        throw new Error("Browser screenshot capture did not include crop-ready image data.");
      }
      setLastScreenshot(screenshot);
      captureModeRef.current = true;
      setCaptureBase(screenshot);
      setCaptureSelection(null);
      await hideNativeBrowserView();
      setMessage({ tone: "info", text: "Drag a browser region to attach the screenshot crop and nearby page context." });
    });
  }, [browserScope, hideNativeBrowserView, onAddContext, restoreLiveBrowserView, runBusy]);

  const addBrowserCaptureContext = useCallback(async (frame: BrowserFrame) => {
    if (!captureBase) return;
    if (!onAddContext) throw new Error("Context insertion is not available in this panel.");
    const crop = await cropBrowserScreenshot(captureBase, frame);
    if (!crop) throw new Error("Could not crop browser screenshot.");

    let attachmentPath: string | null = null;
    if (onAddAttachment) {
      const saved = await window.ade.agentChat.saveTempAttachment({
        data: stripDataUrlPrefix(crop.dataUrl),
        filename: "built-in-browser-capture.png",
      }, ...(runtimePin ? [runtimePin] as const : []));
      attachmentPath = saved.path;
      onAddAttachment({ path: saved.path, type: inferAttachmentType(saved.path, "image/png") });
    }

    const centerX = frame.x + frame.width / 2;
    const centerY = frame.y + frame.height / 2;
    const viewportRect = browserSurfaceRef.current?.getBoundingClientRect() ?? null;
    const domPoint = viewportRect && captureBase.width && captureBase.height
      ? {
          x: centerX * (viewportRect.width / captureBase.width),
          y: centerY * (viewportRect.height / captureBase.height),
        }
      : { x: centerX, y: centerY };
    const api = getBrowserApi();
    let domItem: BuiltInBrowserContextItem | null = null;
    if (api?.selectPoint) {
      try {
        const pointResult = await api.selectPoint(withBrowserScope({ x: domPoint.x, y: domPoint.y, includeScreenshot: false }), runtimePinRef.current);
        domItem = normalizeSelectionResult(pointResult, statusRef.current);
      } catch (error) {
        setMessage({ tone: "error", text: `Captured region, but DOM point context failed: ${errorMessage(error)}` });
      }
    }

    const metadata = domItem?.metadata ?? {};
    const contextItem: BuiltInBrowserContextItem = {
      ...(domItem ?? {}),
      kind: "built_in_browser_capture",
      id: `built-in-browser-capture:${Date.now().toString(36)}`,
      sessionId,
      url: domItem?.url ?? statusRef.current?.url ?? null,
      title: domItem?.title ?? statusRef.current?.title ?? null,
      selector: domItem?.selector ?? stringField(metadata.selector),
      text: domItem?.text ?? "Dragged browser screenshot region",
      role: domItem?.role ?? stringField(metadata.role),
      tagName: domItem?.tagName ?? stringField(metadata.tagName),
      frame: crop.frame,
      metadata: {
        ...metadata,
        browserContextPacketVersion: 1,
        contextSurface: "built_in_browser",
        source: domItem ? "browser-region-capture-with-dom-center" : "browser-region-capture",
        sourceConfidence: domItem ? "point-center" : "visual-only",
        captureFrame: crop.frame,
        crop: { width: crop.width, height: crop.height },
        viewport: {
          width: captureBase.width,
          height: captureBase.height,
        },
        capturedAt: captureBase.capturedAt,
        centerPoint: {
          x: Math.round(centerX),
          y: Math.round(centerY),
        },
        domPoint: {
          x: Math.round(domPoint.x),
          y: Math.round(domPoint.y),
        },
        ...(attachmentPath ? { attachmentPath } : {}),
        ...(domItem?.frame ? { domFrame: domItem.frame } : {}),
        selectedElement: domItem ? {
          componentId: stringField(domItem.componentId) ?? domItem.selector ?? stringField(metadata.selector) ?? "browser-element",
          label: domItem.text ?? stringField(metadata.label),
          value: stringField(metadata.value),
          role: domItem.role ?? stringField(metadata.role),
          tagName: domItem.tagName ?? stringField(metadata.tagName),
          selector: domItem.selector ?? stringField(metadata.selector),
          testId: stringField(metadata.testId),
          screenshotFrame: domItem.frame,
        } : {
          source: "browser-region-capture",
          label: "Dragged browser screenshot region",
          screenshotFrame: crop.frame,
        },
        selectionExplanation: domItem
          ? "The user dragged a browser screenshot region. ADE attached the crop as visual evidence and resolved DOM context from the element at the crop center."
          : "The user dragged a browser screenshot region. ADE could not resolve a DOM element at the crop center, so this packet is visual context only.",
      },
      screenshotDataUrl: crop.dataUrl,
      selectedAt: new Date().toISOString(),
    };

    await attachBrowserContextItem(contextItem, {
      force: true,
      label: domItem ? "Browser capture + DOM attached." : "Browser capture attached.",
    });
    restoreLiveBrowserView();
  }, [attachBrowserContextItem, captureBase, onAddAttachment, onAddContext, restoreLiveBrowserView, runtimePin, sessionId, withBrowserScope]);

  const handleBrowserCapturePointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (!captureImageDataUrl || !captureBase?.width || !captureBase.height) return;
    const image = captureImageRef.current;
    if (!image) return;
    const point = pointerToCapturePoint(event, image, captureBase.width, captureBase.height);
    if (!point) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setCaptureSelection({
      startX: point.x,
      startY: point.y,
      currentX: point.x,
      currentY: point.y,
      bounds: point.bounds,
    });
  }, [captureBase?.height, captureBase?.width, captureImageDataUrl]);

  const handleBrowserCapturePointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (!captureImageDataUrl || !captureBase?.width || !captureBase.height || !captureSelection) return;
    const image = captureImageRef.current;
    if (!image) return;
    const point = pointerToCapturePoint(event, image, captureBase.width, captureBase.height, true);
    if (!point) return;
    setCaptureSelection((current) => current
      ? { ...current, currentX: point.x, currentY: point.y, bounds: point.bounds }
      : current);
  }, [captureBase?.height, captureBase?.width, captureImageDataUrl, captureSelection]);

  const finishBrowserCapture = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (!captureSelection || !activeCaptureFrame) return;
    event.preventDefault();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setCaptureSelection(null);
    if (activeCaptureFrame.width < 12 || activeCaptureFrame.height < 12) {
      setMessage({ tone: "info", text: "Drag a larger browser region to capture." });
      return;
    }
    void runBusy("screenshot", async () => {
      await addBrowserCaptureContext(activeCaptureFrame);
    });
  }, [activeCaptureFrame, addBrowserCaptureContext, captureSelection, runBusy]);

  const cancelBrowserCapture = useCallback((event?: PointerEvent<HTMLDivElement>) => {
    if (event?.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setCaptureSelection(null);
  }, []);

  const refreshProfileSecurity = useCallback(async () => {
    const api = requireBrowserApi();
    if (!api.getProfileDiagnostics || !api.listPermissions) {
      throw new Error("This ADE build does not expose browser profile diagnostics.");
    }
    setProfileBusy(true);
    try {
      const [diagnostics, permissions] = await Promise.all([
        api.getProfileDiagnostics(),
        api.listPermissions(),
      ]);
      setProfileDiagnostics(diagnostics);
      setPermissionDecisions(permissions.permissions);
    } finally {
      setProfileBusy(false);
    }
  }, []);

  const handleToggleProfile = useCallback(() => {
    if (profileOpen) {
      setProfileOpen(false);
      return;
    }
    setProfileOpen(true);
    void refreshProfileSecurity().catch((error: unknown) => {
      setMessage({ tone: "error", text: errorMessage(error) });
    });
  }, [profileOpen, refreshProfileSecurity]);

  const clearRememberedPermission = useCallback((
    decision?: Pick<BuiltInBrowserPermissionDecision, "origin" | "permission">,
  ) => {
    if (!decision && !window.confirm("Clear all remembered ADE browser permission decisions?")) return;
    void (async () => {
      const api = requireBrowserApi();
      if (!api.clearPermissions) throw new Error("This ADE build does not support clearing browser permissions.");
      setProfileBusy(true);
      try {
        const result = await api.clearPermissions(decision
          ? { origin: decision.origin, permission: decision.permission }
          : {});
        setPermissionDecisions(result.permissions);
        if (api.getProfileDiagnostics) {
          setProfileDiagnostics(await api.getProfileDiagnostics());
        }
        setMessage({
          tone: "info",
          text: result.removed === 1
            ? "Cleared one remembered browser permission."
            : `Cleared ${result.removed} remembered browser permissions.`,
        });
      } finally {
        setProfileBusy(false);
      }
    })().catch((error: unknown) => {
      setMessage({ tone: "error", text: errorMessage(error) });
    });
  }, []);

  /**
   * Hand the OS the URL that is really loaded, not the one on display.
   *
   * On a tunneled tab those differ: the omnibox shows the remote origin the
   * human asked for (`http://localhost:3000` on machine B) while the page is
   * actually the local forward. Handing the display URL to this machine's
   * opener loads THIS box's port 3000 — a different project's dev server, or an
   * admin console — under the belief that it is the same page.
   */
  const handleOpenExternal = useCallback(() => {
    const url = (statusRef.current?.url ?? currentUrl).trim();
    if (!url) return;
    void window.ade.app.openExternal(url).catch((error: unknown) => {
      setMessage({ tone: "error", text: `Could not open URL externally: ${errorMessage(error)}` });
    });
  }, [currentUrl]);

  /* ── Device emulation ───────────────────────────────────────────────────── */

  /**
   * Picking a device does not deserve a banner.
   *
   * It used to push "Browser is emulating iPhone 17 Pro." into the message row,
   * which cost 34px above the page for a fact the page itself is already
   * showing — and stayed up until it was dismissed. The letterbox caption
   * ("402 × 874 · fit 66%") and the device button's dot say the same thing,
   * quietly and for exactly as long as it is true.
   */
  const applyEmulation = useCallback((
    request: {
      preset?: string | null;
      width?: number | null;
      height?: number | null;
      mobile?: boolean | null;
      deviceScaleFactor?: number | null;
    },
  ) => {
    void runBusy("emulation", async () => {
      const api = requireBrowserApi();
      if (!api.setEmulation) throw new Error("This ADE build does not support browser device emulation.");
      const result = await api.setEmulation(withBrowserScope(request), runtimePinRef.current);
      applyStatus(result.status);
    });
  }, [applyStatus, runBusy, withBrowserScope]);

  const handlePickPreset = useCallback((preset: BuiltInBrowserEmulationPreset) => {
    applyEmulation({ preset: preset.id });
  }, [applyEmulation]);

  const handleEmulationOff = useCallback(() => {
    void runBusy("emulation", async () => {
      const api = requireBrowserApi();
      if (!api.setEmulation) throw new Error("This ADE build does not support browser device emulation.");
      const result = await api.setEmulation(withBrowserScope({ preset: "off" }), runtimePinRef.current);
      applyStatus(result.status);
    });
  }, [applyStatus, runBusy, withBrowserScope]);

  /**
   * Portrait ↔ landscape: the same device, turned over.
   *
   * The preset id rides along with the swapped size so the service keeps the
   * device's DPR, touch and mobile user agent — rotating used to fall back to
   * the desktop "responsive" base, which quietly turned an iPhone into a
   * 852-wide desktop and served the wrong breakpoint.
   */
  const handleRotateEmulation = useCallback(() => {
    const current = statusRef.current?.tabs.find((tab) => tab.id === statusRef.current?.activeTabId)?.emulation;
    if (!current?.width || !current.height) return;
    const rotated = { width: current.height, height: current.width };
    const presetId = activeEmulationPresetId(current);
    applyEmulation({
      ...rotated,
      preset: presetId === "responsive" || presetId === "desktop" ? null : presetId,
      mobile: current.mobile,
      deviceScaleFactor: current.deviceScaleFactor || null,
    });
  }, [applyEmulation]);

  /** One value for the whole device menu, so exactly one row is ever checked. */
  const activePresetId = useMemo(() => activeEmulationPresetId(emulation), [emulation]);

  const handleDeviceMenuValue = useCallback((value: string) => {
    if (value === "desktop") {
      handleEmulationOff();
      return;
    }
    const preset = deviceMenuPresets().find((candidate) => candidate.id === value);
    if (preset) handlePickPreset(preset);
  }, [handleEmulationOff, handlePickPreset]);

  const handleApplyResponsive = useCallback(() => {
    const width = Number.parseInt(responsiveWidth, 10);
    const height = Number.parseInt(responsiveHeight, 10);
    // `> 0`, not just finite: `0 × 768` used to banner "Browser is emulating
    // 0×768" while the device pill showed the size main had clamped it to.
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      setMessage({ tone: "error", text: "Enter a width and a height to size the browser." });
      return;
    }
    setDeviceMenuOpen(false);
    applyEmulation({ width, height });
  }, [applyEmulation, responsiveHeight, responsiveWidth]);

  /* ── Zoom ───────────────────────────────────────────────────────────────── */

  const applyZoom = useCallback((factor: number) => {
    void runBusy("zoom", async () => {
      const api = requireBrowserApi();
      if (!api.setZoom) throw new Error("This ADE build does not support browser zoom.");
      const result = await api.setZoom(withBrowserScope({ factor }), runtimePinRef.current);
      applyStatus(result.status);
    });
  }, [applyStatus, runBusy, withBrowserScope]);

  const handleZoomStep = useCallback((direction: 1 | -1) => {
    applyZoom(stepZoomFactor(zoomFactor, direction));
  }, [applyZoom, zoomFactor]);

  const handleZoomReset = useCallback(() => applyZoom(1), [applyZoom]);

  /* ── Find in page ───────────────────────────────────────────────────────── */

  const runFind = useCallback((text: string, options?: { findNext?: boolean; forward?: boolean }) => {
    const query = text.trim();
    if (!query) {
      setFindState(null);
      return;
    }
    const api = getBrowserApi();
    if (!api?.findInPage) {
      setFindError("Find is not available on this page.");
      return;
    }
    void api.findInPage(
      withBrowserScope({
        text: query,
        findNext: options?.findNext ?? false,
        forward: options?.forward ?? true,
      }),
      runtimePinRef.current,
    )
      .then((result) => {
        setFindError(null);
        setFindState({
          activeMatchOrdinal: result.activeMatchOrdinal ?? null,
          matches: result.matches ?? null,
        });
      })
      .catch((error: unknown) => {
        // A find failure is a fact about this page, not an incident: it belongs
        // in the bar as a sentence, never as a raw IPC error in the banner.
        setFindError(findErrorMessage(error));
        setFindState(null);
      });
  }, [withBrowserScope]);

  /** Typing searches as you type; 150ms is about half a word of typing. */
  const queueFind = useCallback((text: string) => {
    if (findDebounceRef.current != null) window.clearTimeout(findDebounceRef.current);
    if (!text.trim()) {
      findDebounceRef.current = null;
      setFindState(null);
      setFindError(null);
      return;
    }
    findDebounceRef.current = window.setTimeout(() => {
      findDebounceRef.current = null;
      runFind(text);
    }, FIND_DEBOUNCE_MS);
  }, [runFind]);

  /** Enter / Shift-Enter jump immediately — no one waits out a debounce. */
  const findStep = useCallback((text: string, forward: boolean) => {
    if (findDebounceRef.current != null) {
      window.clearTimeout(findDebounceRef.current);
      findDebounceRef.current = null;
    }
    runFind(text, { findNext: true, forward });
  }, [runFind]);

  useEffect(() => () => {
    if (findDebounceRef.current != null) window.clearTimeout(findDebounceRef.current);
  }, []);

  const closeFind = useCallback(() => {
    if (findDebounceRef.current != null) {
      window.clearTimeout(findDebounceRef.current);
      findDebounceRef.current = null;
    }
    setFindOpen(false);
    setFindState(null);
    setFindError(null);
    // Hand the keyboard back to the page: the bar is gone, so a caret still
    // sitting in a removed input would swallow the next keystroke.
    findInputRef.current?.blur();
    const api = getBrowserApi();
    if (!api?.stopFindInPage) return;
    void api.stopFindInPage(withBrowserScope({ action: "clearSelection" as const }), runtimePinRef.current)
      .catch(() => {
        // Nothing to clear is not worth a banner — the bar is already gone.
      });
  }, [withBrowserScope]);

  /**
   * ⌘F on an open bar re-focuses and selects, the way every other find bar
   * behaves: the second press is "search for something else", not a no-op.
   */
  const findFocusFrameRef = useRef<number | null>(null);
  const openFind = useCallback(() => {
    setFindOpen(true);
    const focusInput = () => {
      findFocusFrameRef.current = null;
      const input = findInputRef.current;
      if (!input) return;
      input.focus();
      if (input.value) input.select();
    };
    if (findInputRef.current) focusInput();
    // The bar animates in, so a first open focuses on the next frame rather
    // than into a zero-height container.
    if (findFocusFrameRef.current != null) window.cancelAnimationFrame(findFocusFrameRef.current);
    findFocusFrameRef.current = window.requestAnimationFrame(focusInput);
  }, []);

  /*
    Match counts belong to one page.

    Nothing cleared them on a navigation or a tab switch, so the bar went on
    claiming "3 of 12" over a page with no matches at all — and a switch away
    from the Browser tool unmounted the panel without ever ending the find
    session, leaving Chromium's highlight burnt into the tab.
  */
  useEffect(() => {
    setFindState(null);
    setFindError(null);
  }, [activeTabId, status?.url]);

  useEffect(() => () => {
    if (findFocusFrameRef.current != null) window.cancelAnimationFrame(findFocusFrameRef.current);
    // Closing the LAST tab unmounts this panel, so the cleanup runs with an
    // empty pane — and a find that never existed does not need ending. Main
    // tolerates the call either way; not making it is what keeps the ordinary
    // path free of a round trip that can only answer "there was nothing".
    const tabId = statusRef.current?.activeTabId ?? null;
    if (!tabId) return;
    const api = getBrowserApi();
    void api?.stopFindInPage?.(
      { ...browserScopeRef.current, tabId, action: "clearSelection" as const },
      runtimePinRef.current,
    ).catch(() => {
      // The tab may already be gone; there is nothing left to clear.
    });
  }, []);

  /* ── DevTools, network log ──────────────────────────────────────────────── */

  const handleToggleDevTools = useCallback(() => {
    void runBusy("devtools", async () => {
      const api = requireBrowserApi();
      if (!api.setDevTools) throw new Error("This ADE build does not support opening browser DevTools.");
      const result = await api.setDevTools(withBrowserScope({ open: !devToolsOpen }), runtimePinRef.current);
      applyStatus(result.status);
    });
  }, [applyStatus, devToolsOpen, runBusy, withBrowserScope]);

  const handleToggleNetworkLogging = useCallback(() => {
    void runBusy("network-log", async () => {
      const api = requireBrowserApi();
      if (!api.setNetworkLogging) throw new Error("This ADE build does not support browser network logging.");
      const next = !networkLogging;
      const result = await api.setNetworkLogging(
        withBrowserScope({ enabled: next, ...(next ? { clear: true } : {}) }),
        runtimePinRef.current,
      );
      applyStatus(result.status);
      setMessage({
        tone: "info",
        text: next
          ? "Recording every request on this tab. Export a HAR when you have what you need."
          : "Stopped recording requests on this tab.",
      });
    });
  }, [applyStatus, networkLogging, runBusy, withBrowserScope]);

  const handleExportHar = useCallback(() => {
    void runBusy("export-har", async () => {
      const api = requireBrowserApi();
      if (!api.exportHar) throw new Error("This ADE build does not support HAR export.");
      const result = await api.exportHar(withBrowserScope({}), runtimePinRef.current);
      showToast({
        title: "HAR exported",
        message: `${result.entryCount} ${result.entryCount === 1 ? "request" : "requests"} · ${result.relativePath ?? result.filePath}`,
        tone: "success",
        action: {
          label: "Reveal",
          onClick: () => {
            void window.ade.app.revealPath(result.filePath).catch(() => {});
          },
        },
      });
    });
  }, [runBusy, withBrowserScope]);

  /* ── Recording ──────────────────────────────────────────────────────────── */

  const handleStopRecording = useCallback(() => {
    void runBusy("recording", async () => {
      const api = requireBrowserApi();
      if (!api.stopRecording) throw new Error("This ADE build does not support screen recording.");
      const result = await api.stopRecording(withBrowserScope({}), runtimePinRef.current);
      applyStatus(result.status);
      showToast({
        title: "Recording saved",
        // A caption is what files the clip as proof, so say so rather than
        // leaving the person to wonder whether it went anywhere.
        message: result.caption
          ? `Added to proof · ${result.relativePath ?? result.path}`
          : (result.relativePath ?? result.path),
        tone: "success",
        action: {
          label: "Reveal",
          onClick: () => {
            void window.ade.app.revealPath(result.path).catch(() => {});
          },
        },
      });
    });
  }, [applyStatus, runBusy, withBrowserScope]);

  const handleStartRecording = useCallback(() => {
    void runBusy("recording", async () => {
      const api = requireBrowserApi();
      if (!api.startRecording) throw new Error("This ADE build does not support screen recording.");
      const result = await api.startRecording(withBrowserScope({ fps: recordingFps }), runtimePinRef.current);
      applyStatus(result.status);
    });
  }, [applyStatus, recordingFps, runBusy, withBrowserScope]);

  /**
   * One camera button: click captures, Shift-click records.
   *
   * Two buttons would imply two unrelated things; they are the same intent at
   * two lengths, and the modifier is in the tooltip.
   */
  const handleCameraClick = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    // With nowhere to send a capture the modifier is meaningless: the button is
    // record-only, and the toolbar draws it as one.
    if (event.shiftKey || !onAddContext) {
      if (recording) handleStopRecording();
      else handleStartRecording();
      return;
    }
    handleAttachScreenshot();
  }, [handleAttachScreenshot, handleStartRecording, handleStopRecording, onAddContext, recording]);

  /* ── Link routing ───────────────────────────────────────────────────────── */

  const handleLinkModeChange = useCallback((next: BrowserLinkOpenMode) => {
    const previous = linkMode;
    setLinkModeState(next);
    // Push it into the router now: the next click has to obey the choice that
    // was just made, not the one the config reload eventually reports.
    setLinkOpenMode(next);
    void (async () => {
      const config = window.ade?.projectConfig;
      if (!config) throw new Error("This ADE build cannot save the link preference.");
      const snapshot = await config.get();
      await config.save({
        shared: snapshot.shared,
        local: {
          ...snapshot.local,
          browser: { ...(snapshot.local.browser ?? {}), linkOpenMode: next },
        },
      });
    })().catch((error: unknown) => {
      setLinkModeState(previous);
      setLinkOpenMode(previous);
      setMessage({ tone: "error", text: errorMessage(error) });
    });
  }, [linkMode]);

  const handleInsertSelectionDraft = useCallback(() => {
    if (!onInsertDraft || !selectedItem) return;
    const lines = [
      "Use this browser selection:",
      selectedItem.title ? `Title: ${selectedItem.title}` : null,
      selectedItem.url ? `URL: ${selectedItem.url}` : null,
      selectedItem.selector ? `Selector: ${selectedItem.selector}` : null,
      selectedItem.text ? `Text: ${selectedItem.text}` : null,
    ].filter((line): line is string => Boolean(line));
    onInsertDraft(lines.join("\n"));
  }, [onInsertDraft, selectedItem]);

  /* ── URL field ──────────────────────────────────────────────────────────── */

  const handleUrlFocus = useCallback(() => {
    setEditingUrl(true);
    // Focusing the omnibox means "I am replacing this", so hand over the whole
    // string rather than a caret in the middle of a hostname. Either field can
    // be the one in focus — the launchpad has its own — so this asks the
    // document rather than assuming the chrome row's.
    const active = document.activeElement;
    if (active instanceof HTMLInputElement) active.select();
    else urlInputRef.current?.select();
  }, []);

  const handleUrlKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    setUrlInput(currentUrl);
    event.currentTarget.blur();
  }, [currentUrl]);

  /**
   * Leaving the field, as one rule.
   *
   * An emptied omnibox is not an instruction to navigate to nothing, so blur
   * puts the page's own URL back. This used to live inside the toolbar row,
   * which was the one place a child decided what the parent's state meant.
   */
  const handleUrlEndEdit = useCallback(() => {
    setEditingUrl(false);
    setUrlInput((current) => (current.trim() ? current : currentUrl));
  }, [currentUrl]);

  /* ── Keyboard ───────────────────────────────────────────────────────────── */

  const handlePanelKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    /*
      Capture, so ⌘F works wherever focus is inside the pane — including the
      omnibox, which stops its own keydowns. That puts this handler AHEAD of
      the find bar and the URL field on Escape too, so it stands down for
      anything that is being typed into: those two own their own Escape (one
      closes the bar, the other reverts the address), and this is only the
      fallback for an Escape pressed at the page.
    */
    if (event.key === "Escape") {
      if (!findOpen || isTypingTarget(event.target)) return;
      event.preventDefault();
      closeFind();
      return;
    }
    const mod = event.metaKey || event.ctrlKey;
    if (!mod || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === "f") {
      event.preventDefault();
      event.stopPropagation();
      openFind();
      return;
    }
    if (key === "w") {
      // Only when this pane actually owns a tab: with none, ⌘W still means
      // "close the window", and swallowing it here would make the chord dead.
      if (!handleCloseActiveTab()) return;
      event.preventDefault();
      event.stopPropagation();
    }
    /*
      Page zoom is deliberately NOT bound here. CmdOrCtrl +=/−/0 are registered
      as native View-menu accelerators, and Electron consumes an accelerator in
      the browser process before this keydown ever fires — so a binding here
      would pass every jsdom test and do nothing in the packaged app. The menu's
      zoom command is claimed below instead.

      ⌘F and ⌘W are menu accelerators too, and the claim below is what makes
      them work on the packaged app. They stay bound here as well because that
      is the path a test can drive and the path that still works if the menu
      route is ever unavailable — both ends call the same two functions, so
      they cannot disagree.
    */
  }, [closeFind, findOpen, handleCloseActiveTab, openFind]);

  /**
   * The same two chords, arriving from the native menu instead.
   *
   * ⌘F and ⌘W are registered as menu accelerators, so Electron consumes them in
   * the browser process before any keydown reaches this pane — and once you
   * click into the page, focus is in the page's own WebContents, so this
   * renderer sees no keystroke at all. That is the reported bug: ⋯ advertised
   * ⌘F and the chord did nothing. The ownership test is the zoom claim's, for
   * the same reasons spelled out there.
   */
  useEffect(() => {
    if (!apiAvailable) return undefined;
    return claimAppMenuCommands((command) => {
      const panel = panelRef.current;
      if (!panel || !panel.isConnected || !hasTabRef.current) return false;
      if (panel.closest("[inert]")) return false;
      const active = document.activeElement;
      const ownsKeyboard = active == null || active === document.body || panel.contains(active);
      if (!ownsKeyboard) return false;
      if (command === "find") {
        openFind();
        return true;
      }
      return handleCloseActiveTab();
    });
  }, [apiAvailable, handleCloseActiveTab, openFind]);

  /**
   * Take the app's zoom chords while this pane owns the keyboard.
   *
   * "Owns" includes focus being nowhere in the DOM: clicking into the page
   * moves focus to the native view, which is a different WebContents entirely,
   * so `document.activeElement` falls back to the body. Focus sitting in the
   * chat composer, or any other pane, declines and the whole ADE UI zooms as
   * before.
   */
  useEffect(() => {
    if (!apiAvailable) return undefined;
    return claimAppZoomCommands((command) => {
      const panel = panelRef.current;
      if (!panel || !panel.isConnected || !hasTabRef.current) return false;
      /*
        A mounted panel is not necessarily a visible one.

        `ProjectSurface` keeps inactive project tabs mounted behind `inert` +
        `opacity: 0`, and `ProjectRouteContent` keeps the Work page mounted
        after you navigate away from it. Today the `active &&` guard in
        `WorkSidebar` unmounts this panel in both cases — but "focus is nowhere
        in the DOM" is true of a hidden pane too, so relying on that alone would
        make a hidden browser steal the app's zoom the day that guard changes.
      */
      if (panel.closest("[inert]")) return false;
      const active = document.activeElement;
      const ownsKeyboard = active == null || active === document.body || panel.contains(active);
      if (!ownsKeyboard) return false;
      if (command === "in") handleZoomStep(1);
      else if (command === "out") handleZoomStep(-1);
      else handleZoomReset();
      return true;
    });
  }, [apiAvailable, handleZoomReset, handleZoomStep]);

  /* ── Ambient reads ──────────────────────────────────────────────────────── */

  const recordingStartedAt = recording?.startedAt ?? null;
  useEffect(() => {
    if (!recordingStartedAt) return undefined;
    setRecordingClock(Date.now());
    // `steps(1)` in spirit: one repaint a second, not one a frame.
    const timer = window.setInterval(() => setRecordingClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [recordingStartedAt]);

  useEffect(() => {
    void refreshLinkOpenMode().then(() => setLinkModeState(getLinkOpenMode()));
  }, []);

  // Read once on mount and again whenever the device menu opens: a booted
  // simulator is a fact about right now, and polling for it would cost every
  // panel that never opens the menu.
  useEffect(() => {
    const simulator = window.ade?.iosSimulator;
    if (!simulator?.getStatus) return undefined;
    let cancelled = false;
    void simulator.getStatus(runtimePinRef.current)
      .then((simulatorStatus) => {
        if (cancelled) return;
        setBootedSimulatorName(simulatorStatus?.activeDevice?.name ?? null);
      })
      .catch(() => {
        // No simulator tooling on this machine is not an error to report here.
      });
    return () => {
      cancelled = true;
    };
  }, [deviceMenuOpen]);

  /**
   * The real dev servers, asked for rather than guessed at.
   *
   * The service knows which ports are listening and which command opened them,
   * so the launchpad can say "npm run dev · :5173" instead of offering a
   * hardcoded `localhost:3000` that is usually nothing. An older main process
   * has no such list, so the port probe below stays as the fallback.
   */
  useEffect(() => {
    const api = getBrowserApi();
    if (!api?.getDevServers || remotePin) return undefined;
    let cancelled = false;
    // `Promise.resolve(...)`, not a bare `.then`: the declared return type is
    // what a CURRENT main process sends. A stub namespace or an older build that
    // returns a non-thenable would throw `.then is not a function` synchronously
    // inside the effect body, which React does not treat as a rejection — it
    // unmounts the subtree, so the pane blanks instead of falling back to the
    // port probe below.
    void Promise.resolve(api.getDevServers({ laneId: contextLaneId }))
      .then((value) => {
        if (cancelled) return;
        const discovered = normalizeDevServers(value);
        setDevServers(discovered);
        setDiscoveryEmpty(discovered.length === 0);
      })
      .catch(() => {
        // No detector is not an error; the port probe below covers it.
        if (!cancelled) setDiscoveryEmpty(true);
      });
    return () => {
      cancelled = true;
    };
  }, [contextLaneId, remotePin]);

  /*
    The port probe, as a fallback rather than an alternative.

    `getDevServers` only knows the servers ADE's own PTYs started, so a `npm run
    dev` the human launched in iTerm before opening ADE made the launchpad claim
    there was nothing to open while :5173 was serving. An empty answer is now
    treated the same as no answer at all: probe the usual ports, and label what
    comes back "localhost:5173" — the honest thing to say about a port nobody
    can name a command for.
  */
  useEffect(() => {
    const api = getBrowserApi();
    if (api?.getDevServers && !discoveryEmpty) return undefined;
    if (remotePin) return undefined;
    const probePort = window.ade?.localhost?.probePort;
    if (!probePort) return undefined;
    let cancelled = false;
    void (async () => {
      for (const port of DEV_SERVER_PROBE_PORTS) {
        if (cancelled) return;
        const listening = await probePort(port).catch(() => false);
        if (listening && !cancelled) {
          setDevServers((previous) => mergeDevServer(previous, {
            url: `http://localhost:${port}`,
            port,
            source: null,
          }));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [discoveryEmpty, remotePin]);

  // Only offered when the booted device maps onto metrics ADE actually has.
  const simulatorPreset = useMemo(
    () => simulatorEmulationPreset(bootedSimulatorName),
    [bootedSimulatorName],
  );

  const syncTabStripFades = useCallback(() => {
    const strip = tabStripRef.current;
    if (!strip) return;
    const start = strip.scrollLeft > 2;
    const end = strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 2;
    setTabStripFades((previous) => (
      previous.start === start && previous.end === end ? previous : { start, end }
    ));
  }, []);

  useEffect(() => {
    syncTabStripFades();
  }, [syncTabStripFades, tabIdsSignature]);

  /**
   * Where this pane's recents are filed.
   *
   * The same split the tab collections use: a project's browser and the
   * personal one are different browsers, and offering a work lane's pages in
   * the personal pane would be a leak dressed up as a convenience.
   */
  const recentScope = projectRootOverride === null ? "personal" : projectRoot ?? null;

  useEffect(() => {
    setRecentUrls(readBrowserRecentUrls(recentScope));
  }, [recentScope]);

  /*
    A page counts as visited once it has settled, not when it starts loading:
    a redirect chain would otherwise file three rows for one destination.
  */
  const settledTitle = activeTab?.title ?? null;
  useEffect(() => {
    if (loading || !currentUrl) return;
    setRecentUrls(rememberBrowserRecentUrl(recentScope, {
      url: currentUrl,
      title: settledTitle?.trim() ? settledTitle.trim() : null,
      visitedAt: Date.now(),
    }));
  }, [currentUrl, loading, recentScope, settledTitle]);

  const handleForgetRecent = useCallback((url: string) => {
    setRecentUrls(forgetBrowserRecentUrl(recentScope, url));
  }, [recentScope]);

  const handleClearRecents = useCallback(() => {
    setRecentUrls(clearBrowserRecentUrls(recentScope));
  }, [recentScope]);

  /**
   * The launchpad's groups.
   *
   * Real dev servers first, because that is the page you almost always wanted,
   * then the pages this browser has actually been on. "Paste a link" appears
   * only when the clipboard holds a URL, so it never promises something it
   * cannot deliver.
   */
  const launchpadGroups = useMemo<BrowserLaunchpadGroup[]>(() => {
    const groups: BrowserLaunchpadGroup[] = [];
    if (clipboardUrl) {
      groups.push({
        key: "clipboard",
        label: "Clipboard",
        icon: "history",
        rows: [{
          key: "clipboard",
          title: "Paste a link",
          subtitle: splitBrowserUrlForDisplay(clipboardUrl)?.host ?? clipboardUrl,
          thumbLabel: null,
          live: false,
          icon: "clipboard",
          onSelect: () => handleSuggestion(clipboardUrl),
        }],
      });
    }
    if (devServers.length > 0) {
      groups.push({
        key: "local",
        label: "Local servers",
        icon: "server",
        rows: devServers.map((server) => {
          const labels = devServerRowLabels(server);
          return {
            key: server.url,
            title: labels.title,
            subtitle: labels.subtitle,
            thumbLabel: devServerThumbLabel(server),
            // Everything in this group came from a listening port.
            live: true,
            icon: "server" as const,
            onSelect: () => handleSuggestion(server.url),
          };
        }),
      });
    }
    if (recentUrls.length > 0) {
      groups.push({
        key: "recent",
        label: "Recently used",
        icon: "history",
        rows: recentUrls.map((entry) => ({
          key: entry.url,
          title: entry.title ?? splitBrowserUrlForDisplay(entry.url)?.host ?? entry.url,
          subtitle: entry.url,
          thumbLabel: null,
          live: false,
          icon: "history" as const,
          onSelect: () => handleSuggestion(entry.url),
          onForget: () => handleForgetRecent(entry.url),
        })),
        onClear: { label: "Clear", run: handleClearRecents },
      });
    }
    return groups;
  }, [
    clipboardUrl,
    devServers,
    handleClearRecents,
    handleForgetRecent,
    handleSuggestion,
    recentUrls,
  ]);

  /* ── Layout ─────────────────────────────────────────────────────────────── */

  /*
    Toolbar density follows the row's own measured width, not a media query and
    not a pair of hardcoded pane widths: this panel is a pane inside a window,
    the window is not what got narrow, and the thresholds that used to decide
    this were wrong by ~80px in the middle of the range — the omnibox collapsed
    to nothing at ~420 while every button stayed.

    Observing the row is safe from feedback: its width comes from the pane, and
    nothing the layout removes can change it.
  */
  useLayoutEffect(() => {
    const element = toolbarRowRef.current ?? panelRef.current;
    if (!element) return undefined;
    const measure = () => {
      const width = element.getBoundingClientRect().width;
      setPaneWidth((previous) => (previous != null && Math.abs(previous - width) < 1 ? previous : width));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const deviceLabel = useMemo(() => emulationDisplayLabel(emulation), [emulation]);
  // `recording` and `selectedItem` are fresh objects on every browser event, so
  // depending on them made this memo recompute constantly while looking like it
  // did not. The layout only ever reads them as booleans.
  const isRecording = Boolean(recording);
  const hasSelection = Boolean(selectedItem);
  // Whether this host can receive an inserted element or capture at all. A
  // shell session cannot: there is no chat, draft or agent CLI behind the pane,
  // so Inspect, Attach and "screenshot to chat" are not shown here rather than
  // shown broken.
  const canAttachContext = Boolean(onAddContext);
  const toolbar = useMemo(() => browserToolbarLayout(paneWidth, {
    hasSelection,
    canAttachContext,
    recording: isRecording,
  }), [canAttachContext, hasSelection, isRecording, paneWidth]);
  /**
   * `status != null` matters: before the first status lands the panel knows
   * nothing, and flashing the launchpad there would both blink the surface and
   * steal focus into the URL field — which then holds an empty string against
   * the page that turns out to be loaded.
   */
  const showLaunchpad = Boolean(
    apiAvailable
    && status != null
    && !captureBase
    && (browserTabs.length === 0 || activeTab?.isLaunchpad || !currentUrl),
  );

  const urlDisplay = useMemo(() => splitBrowserUrlForDisplay(currentUrl), [currentUrl]);
  // Only while the field shows exactly what is loaded: mid-edit the person's
  // own text is the truth, and dimming half of it would be a lie.
  const showUrlOverlay = !editingUrl && urlDisplay != null && urlInput === currentUrl;
  // One value per concept, built here because this is where the sequencing
  // rules already live — the row and the ⋮ menu each take a whole group rather
  // than eleven props the parent has to remember to keep in step.
  const urlField = useMemo(() => ({
    inputRef: urlInputRef,
    value: urlInput,
    currentUrl,
    lockKind,
    tunnel: activeTabTunnel,
    display: urlDisplay,
    showOverlay: showUrlOverlay,
    editing: editingUrl,
    onChange: setUrlInput,
    onFocus: handleUrlFocus,
    onKeyDown: handleUrlKeyDown,
    onSubmit: handleNavigate,
    onEndEdit: handleUrlEndEdit,
  }), [
    activeTabTunnel,
    currentUrl,
    editingUrl,
    handleNavigate,
    handleUrlEndEdit,
    handleUrlFocus,
    handleUrlKeyDown,
    lockKind,
    showUrlOverlay,
    urlDisplay,
    urlInput,
  ]);
  const emulationWidth = emulation?.width && emulation.width > 0 ? emulation.width : null;
  const emulationHeight = emulation?.height && emulation.height > 0 ? emulation.height : null;
  const emulationSize = useMemo(
    () => (emulationWidth && emulationHeight ? { width: emulationWidth, height: emulationHeight } : null),
    [emulationHeight, emulationWidth],
  );
  const letterboxed = emulationSize != null;

  // The native view is rectangular, so the DOM frame it is positioned onto is
  // what gives it rounded corners and a hairline — inset by that hairline.
  useLayoutEffect(() => {
    const stage = browserStageRef.current;
    if (!stage) return undefined;
    const measure = () => {
      const rect = stage.getBoundingClientRect();
      const next = browserLetterboxFrame(rect, emulationSize);
      if (viewScaleRef.current !== next.scale) {
        viewScaleRef.current = next.scale;
        // A fit factor that changed mid-drag has to reach main in the same
        // gesture, or the page is drawn at the previous pane's scale.
        reportBounds(undefined, { force: true });
      }
      setViewFrame((previous) => (
        previous.left === next.left
        && previous.top === next.top
        && previous.width === next.width
        && previous.height === next.height
        && previous.scale === next.scale
          ? previous
          : next
      ));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [emulationSize, reportBounds]);

  /* ── Launchpad ──────────────────────────────────────────────────────────── */

  useEffect(() => {
    launchpadVisibleRef.current = showLaunchpad;
    reportBounds(undefined, { force: true });
    // A page arrived under a focused, still-empty launchpad field: the omnibox
    // has to say where we are, not sit blank over a loaded page.
    if (!showLaunchpad) setUrlInput((current) => (current.trim() ? current : currentUrl));
  }, [currentUrl, reportBounds, showLaunchpad]);

  useEffect(() => {
    if (!showLaunchpad) return undefined;
    const read = window.ade?.app?.readClipboardText;
    if (!read) return undefined;
    let cancelled = false;
    void read()
      .then((text) => {
        if (!cancelled) setClipboardUrl(clipboardUrlCandidate(text));
      })
      .catch(() => {
        // An unreadable clipboard just means no chip.
      });
    return () => {
      cancelled = true;
    };
  }, [showLaunchpad]);

  // A new tab is a question, so the caret starts where the answer goes — the
  // one address field this pane has.
  useEffect(() => {
    if (!showLaunchpad) return undefined;
    const frame = window.requestAnimationFrame(() => {
      urlInputRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [showLaunchpad, activeTabId]);

  /* ── Load progress ──────────────────────────────────────────────────────── */

  useEffect(() => {
    if (loading) {
      progressPhaseRef.current = "loading";
      setProgressPhase("loading");
      return undefined;
    }
    if (progressPhaseRef.current === "idle") return undefined;
    progressPhaseRef.current = "finishing";
    setProgressPhase("finishing");
    const timer = window.setTimeout(() => {
      progressPhaseRef.current = "idle";
      setProgressPhase("idle");
    }, PROGRESS_FINISH_MS);
    return () => window.clearTimeout(timer);
  }, [loading]);

  // A page that just settled is the frame a menu will want to freeze, so take
  // it once now rather than round-tripping the moment the menu opens.
  useEffect(() => {
    if (loading || !currentUrl || !apiAvailable) return undefined;
    const timer = window.setTimeout(() => {
      void refreshUnderlaySnapshot();
    }, UNDERLAY_SETTLE_SNAPSHOT_MS);
    return () => window.clearTimeout(timer);
  }, [apiAvailable, currentUrl, loading, refreshUnderlaySnapshot]);

  /**
   * The device list, shared by the toolbar button and the narrow-pane overflow.
   *
   * One definition, two hosts: a device chosen from the ⋮ menu at 300px has to
   * be the same list — and the same "Off" row — as the one at 900px.
   */
  const deviceMenuItems = (
    <DropdownMenu.RadioGroup value={activePresetId} onValueChange={handleDeviceMenuValue}>
      <DropdownMenu.Label className={MENU_LABEL_CLASS}>Device</DropdownMenu.Label>
      {deviceMenuPresets().map((preset) => {
        const current = activePresetId === preset.id;
        return (
          <DropdownMenu.RadioItem
            key={preset.id}
            value={preset.id}
            className={MENU_ITEM_CLASS}
          >
            <Check
              size={11}
              weight="bold"
              aria-hidden="true"
              className={cn("shrink-0 text-[var(--color-accent)]", current ? "opacity-100" : "opacity-0")}
            />
            <span className="min-w-0 flex-1 truncate">{preset.label}</span>
            <span className="shrink-0 font-mono text-[9.5px] text-muted-fg/70">
              {emulationSizeLabel(preset)}
            </span>
          </DropdownMenu.RadioItem>
        );
      })}
      {simulatorPreset ? (
        <>
          <DropdownMenu.Separator className={MENU_SEPARATOR_CLASS} />
          <DropdownMenu.Item
            className={MENU_ITEM_CLASS}
            onSelect={() => handlePickPreset(simulatorPreset)}
          >
            <span className="min-w-0 flex-1 truncate">{`Booted simulator: ${bootedSimulatorName}`}</span>
            <span className="shrink-0 font-mono text-[9.5px] text-muted-fg/70">
              {emulationSizeLabel(simulatorPreset)}
            </span>
          </DropdownMenu.Item>
        </>
      ) : null}
      <DropdownMenu.Separator className={MENU_SEPARATOR_CLASS} />
      {/*
        Responsive is a row of this list too, so a custom size — and a rotated
        preset, which the service also calls responsive — has something checked
        rather than a menu that claims nothing is on.
      */}
      <DropdownMenu.Label className={cn(MENU_LABEL_CLASS, "flex items-center gap-1.5")}>
        <Check
          size={11}
          weight="bold"
          aria-hidden="true"
          data-testid="browser-device-responsive-check"
          className={cn(
            "shrink-0 text-[var(--color-accent)]",
            activePresetId === "responsive" ? "opacity-100" : "opacity-0",
          )}
        />
        Responsive
      </DropdownMenu.Label>
      <div
        className="flex items-center gap-1.5 px-2 pb-1.5"
        onKeyDown={(event) => event.stopPropagation()}
      >
        <input
          value={responsiveWidth}
          onChange={(event) => setResponsiveWidth(event.target.value)}
          inputMode="numeric"
          aria-label="Responsive width"
          className="h-6 w-[58px] rounded-[5px] border border-white/[0.08] bg-black/25 px-1.5 text-center font-mono text-[10.5px] text-fg/85 outline-none focus:border-[color-mix(in_srgb,var(--color-accent)_35%,transparent)]"
        />
        <span aria-hidden="true" className="text-[10px] text-muted-fg/60">×</span>
        <input
          value={responsiveHeight}
          onChange={(event) => setResponsiveHeight(event.target.value)}
          inputMode="numeric"
          aria-label="Responsive height"
          className="h-6 w-[58px] rounded-[5px] border border-white/[0.08] bg-black/25 px-1.5 text-center font-mono text-[10.5px] text-fg/85 outline-none focus:border-[color-mix(in_srgb,var(--color-accent)_35%,transparent)]"
        />
        <button
          type="button"
          onClick={handleApplyResponsive}
          className="ade-shell-control ml-auto inline-flex h-6 items-center px-2 text-[10px] font-medium"
        >
          Apply
        </button>
      </div>
      <DropdownMenu.Separator className={MENU_SEPARATOR_CLASS} />
      {/* "Off" is a choice in the same list, so it carries the same check mark. */}
      <DropdownMenu.RadioItem value="desktop" className={MENU_ITEM_CLASS}>
        <Check
          size={11}
          weight="bold"
          aria-hidden="true"
          className={cn("shrink-0 text-[var(--color-accent)]", emulation ? "opacity-0" : "opacity-100")}
        />
        <span className="min-w-0 flex-1 truncate">Off</span>
        <span className="shrink-0 text-[9.5px] text-muted-fg/70">Full width</span>
      </DropdownMenu.RadioItem>
    </DropdownMenu.RadioGroup>
  );

  /**
   * The chrome the row and the ⋮ menu both take.
   *
   * These eleven values were passed to each of them separately, which made the
   * duplication something a reader had to notice. Built once here, handed to
   * both, so the two surfaces cannot disagree about what "busy" or "inspecting"
   * means. Deliberately NOT memoized: `deviceMenuItems` is fresh JSX on every
   * render already, so a `useMemo` here would be a dependency array that always
   * misses.
   */
  const toolbarChrome: BrowserChromeShared = {
    toolbar,
    busy,
    apiAvailable,
    canAttachContext,
    inspecting,
    onInspectToggle: handleInspectToggle,
    emulation,
    deviceLabel,
    deviceMenuItems,
    selection: {
      has: hasSelection,
      onAttach: handleAttachSelection,
    },
  };

  return (
    <div
      ref={panelRef}
      data-testid="browser-panel"
      onKeyDownCapture={handlePanelKeyDown}
      className="flex h-full min-h-0 min-w-0 flex-col font-sans text-[12px] text-fg/75"
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-md border border-white/[0.08] bg-[var(--color-bg)]">
        <BrowserTabStrip
          stripRef={tabStripRef}
          tabs={browserTabs}
          activeTabId={activeTabId}
          tabTunnels={tabTunnels}
          failedFavicons={failedFavicons}
          setFailedFavicons={setFailedFavicons}
          fades={tabStripFades}
          reduceMotion={reduceMotion}
          busy={busy}
          apiAvailable={apiAvailable}
          onScroll={syncTabStripFades}
          onSwitchTab={handleSwitchTab}
          onCloseTab={handleCloseTab}
          onNewTab={handleNewTab}
        />

        {pendingApproval ? (
          <div
            role="alert"
            className="flex h-8 min-w-0 shrink-0 items-center gap-2 overflow-hidden border-b border-amber-300/15 bg-amber-500/10 px-2.5 text-[11.5px] text-amber-100/90"
          >
            <span className="min-w-0 flex-1 truncate">
              {`Agent wants to reach port ${pendingApproval.remotePort} on ${pendingApproval.machineLabel}`}
            </span>
            <button
              type="button"
              onClick={() => pendingApproval.decide("once")}
              className="inline-flex h-6 shrink-0 items-center rounded-md px-2 text-[11px] font-medium text-amber-50/90 transition-colors duration-[120ms] ease-out hover:bg-amber-400/15"
            >
              Allow once
            </button>
            <button
              type="button"
              onClick={() => pendingApproval.decide("always")}
              className="inline-flex h-6 shrink-0 items-center rounded-md px-2 text-[11px] font-medium text-amber-50/90 transition-colors duration-[120ms] ease-out hover:bg-amber-400/15"
            >
              Always for this lane
            </button>
            <button
              type="button"
              onClick={() => pendingApproval.decide("deny")}
              className="inline-flex h-6 shrink-0 items-center rounded-md px-2 text-[11px] font-medium text-amber-100/65 transition-colors duration-[120ms] ease-out hover:bg-white/[0.06]"
            >
              Deny
            </button>
          </div>
        ) : null}

        <BrowserToolbarRow
          rowRef={toolbarRowRef}
          shared={toolbarChrome}
          urlField={urlField}
          hasTab={hasTab}
          canGoBack={canGoBack}
          canGoForward={canGoForward}
          loading={loading}
          onBack={handleBack}
          onForward={handleForward}
          onReload={handleReload}
          onStop={handleStop}
          recording={recording}
          recordingClock={recordingClock}
          onStopRecording={handleStopRecording}
          deviceMenuOpen={deviceMenuOpen}
          onDeviceMenuOpenChange={setDeviceMenuOpen}
          hasCaptureBase={Boolean(captureBase)}
          onCameraClick={handleCameraClick}
          onOpenExternal={handleOpenExternal}
          progressPhase={progressPhase}
          reduceMotion={reduceMotion}
          overflow={(
            <BrowserOverflowMenu
              open={overflowOpen}
              onOpenChange={setOverflowOpen}
              shared={toolbarChrome}
              zoomFactor={zoomFactor}
              onZoomStep={handleZoomStep}
              onZoomReset={handleZoomReset}
              onAttachScreenshot={handleAttachScreenshot}
              onOpenFind={openFind}
              onNewTab={handleNewTab}
              onCloseTab={hasTab ? handleCloseActiveTab : null}
              devToolsOpen={devToolsOpen}
              onToggleDevTools={handleToggleDevTools}
              networkLogging={networkLogging}
              onToggleNetworkLogging={handleToggleNetworkLogging}
              onExportHar={handleExportHar}
              recordingFps={recordingFps}
              setRecordingFps={setRecordingFps}
              linkMode={linkMode}
              onLinkModeChange={handleLinkModeChange}
              onToggleProfile={handleToggleProfile}
              onOpenLoginImport={() => setImportOpen(true)}
              currentUrl={currentUrl}
              onOpenExternal={handleOpenExternal}
              canInsertDraft={Boolean(onInsertDraft)}
              onInsertSelectionDraft={handleInsertSelectionDraft}
              onClearSelection={handleClearSelection}
              selectionFrame={selectionFrame}
            />
          )}
        />

        <BrowserFindBar
          open={findOpen}
          reduceMotion={reduceMotion}
          inputRef={findInputRef}
          findText={findText}
          setFindText={setFindText}
          queueFind={queueFind}
          findStep={findStep}
          closeFind={closeFind}
          findError={findError}
          findState={findState}
        />

        <BrowserHandoffBar
          handoff={handoff}
          reduceMotion={reduceMotion}
          showHandBackOffer={showHandoffHandBackOffer}
          busy={busy}
          onHandBack={handleHandBack}
          onKeepControl={handleKeepHandoffControl}
        />

        {message ? (
          <div
            className={cn(
              "flex shrink-0 items-start gap-2 border-b border-white/[0.07] px-2.5 py-1.5 text-[11.5px]",
              message.tone === "error" ? "text-rose-200/85" : "text-fg/75",
            )}
            role={message.tone === "error" ? "alert" : "status"}
          >
            <WarningCircle size={12} className="mt-0.5 shrink-0" />
            <span className="min-w-0 break-words">{message.text}</span>
            <button
              type="button"
              onClick={() => setMessage(null)}
              className="ml-auto shrink-0 rounded p-0.5 text-current opacity-50 transition-opacity hover:opacity-100"
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
        ) : null}

        {profileOpen ? (
          <BrowserProfilePanel
            diagnostics={profileDiagnostics}
            permissionDecisions={permissionDecisions}
            busy={profileBusy}
            onRefresh={() => void refreshProfileSecurity().catch((error: unknown) => {
              setMessage({ tone: "error", text: errorMessage(error) });
            })}
            onClearPermission={clearRememberedPermission}
          />
        ) : null}

        <BrowserStage
          surfaceRef={browserSurfaceRef}
          stageRef={browserStageRef}
          viewportRef={browserViewportRef}
          captureImageRef={captureImageRef}
          viewFrame={viewFrame}
          reduceMotion={reduceMotion}
          onViewportAnimationComplete={() => reportBounds(undefined, { force: true })}
          underlay={underlay}
          captureImageDataUrl={captureImageDataUrl}
          captureBase={captureBase}
          captureSelection={captureSelection}
          activeCaptureFrame={activeCaptureFrame}
          onCapturePointerDown={handleBrowserCapturePointerDown}
          onCapturePointerMove={handleBrowserCapturePointerMove}
          onCapturePointerUp={finishBrowserCapture}
          onCapturePointerCancel={cancelBrowserCapture}
          showLaunchpad={showLaunchpad}
          apiAvailable={apiAvailable}
          launchpadGroups={launchpadGroups}
          letterboxed={letterboxed}
          emulation={emulation}
          busy={busy}
          onRotateEmulation={handleRotateEmulation}
        />

      </div>
      <BrowserLoginImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={() => {
          if (profileOpen) {
            void refreshProfileSecurity().catch(() => {
              // The dialog already reported what landed; a stale panel is not
              // worth a second error.
            });
          }
        }}
      />
    </div>
  );
}
