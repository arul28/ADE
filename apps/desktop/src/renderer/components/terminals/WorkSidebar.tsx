import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Desktop,
  DeviceMobile,
  FolderOpen,
  GitBranch,
  Globe,
  Terminal,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { useNavigate } from "react-router-dom";
import type {
  AgentChatFileRef,
  AppControlContextItem,
  AppControlSession,
  GitCommitSummary,
  IosElementContextItem,
  IosSimulatorSession,
  LaneSummary,
  OpenProjectBinding,
  TerminalSessionSummary,
  TerminalToolType,
} from "../../../shared/types";
import { selectActiveProjectRoot, useAppStore, type WorkDraftKind, type WorkSidebarTab } from "../../state/appStore";
import {
  formatAppControlContextForPrompt,
  formatBuiltInBrowserContextForPrompt,
  formatIosElementContextForPrompt,
  normalizeBuiltInBrowserContextItem,
} from "../../lib/visualContextFormatting";
import {
  dispatchWorkPtyContextInserted,
  type WorkPtyContextInsertKind,
} from "../../lib/workPtyContextEvents";
import { useLanesForPin, useMachineEntryForBinding } from "../../state/crossMachineLanes";
import { machineNameForBinding } from "../../../shared/machineIdentity";
import { formatToolTypeLabel, isChatToolType, isPtyContextInsertableToolType } from "../../lib/sessions";
import { isMacPlatform } from "../../lib/platform";
import { ChatAppControlPanel } from "../chat/ChatAppControlPanel";
import { ChatBuiltInBrowserPanel } from "../chat/ChatBuiltInBrowserPanel";
import { ChatIosSimulatorPanel } from "../chat/ChatIosSimulatorPanel";
import { ChatTerminalDrawer } from "../chat/ChatTerminalDrawer";
import { FilesTab } from "../files/FilesTab";
import { LaneDiffPane } from "../lanes/LaneDiffPane";
import { LaneGitActionsPane } from "../lanes/LaneGitActionsPane";
import { GlowMenu, type GlowMenuItem } from "../ui/GlowMenu";
import { cn } from "../ui/cn";
import { settingsRouteFor } from "../settings/settingsManifest";
import { useBuiltinGateInput } from "../plugins/useBuiltinTabs";
import { isBuiltinSurfaceVisible } from "../plugins/builtinTabs";
import {
  isPluginPanelSlotId,
  parsePluginPanelSlotId,
  PluginSlotPanel,
  pluginSessionContext,
  usePluginPanelSlots,
  type PluginPanelSlot,
} from "../plugins/sockets";
import type { PluginBuiltinSurfaceId } from "../../../shared/plugins/manifest";

/**
 * The glow behind a rail item is the item's own colour at low alpha, so the two
 * are one decision, not two. Deriving it here means a theme overrides a single
 * `--work-rail-*` token and gets both.
 */
function railGlow(token: string, percent: number): string {
  return `radial-gradient(circle, color-mix(in srgb, var(${token}) ${percent}%, transparent) 0%, transparent 70%)`;
}

const WORK_SIDEBAR_TABS: Array<GlowMenuItem<WorkSidebarTab>> = [
  {
    id: "terminal",
    label: "Terminal",
    icon: Terminal,
    gradient: railGlow("--work-rail-terminal", 38),
    color: "var(--work-rail-terminal)",
  },
  {
    id: "git",
    label: "Git",
    icon: GitBranch,
    gradient: railGlow("--work-rail-git", 42),
    color: "var(--work-rail-git)",
  },
  {
    id: "files",
    label: "Files",
    icon: FolderOpen,
    gradient: railGlow("--work-rail-files", 38),
    color: "var(--work-rail-files)",
  },
  {
    id: "ios",
    label: "iOS Sim",
    icon: DeviceMobile,
    gradient: railGlow("--work-rail-ios", 40),
    color: "var(--work-rail-ios)",
  },
  {
    id: "app-control",
    label: "Electron Control",
    icon: Desktop,
    gradient: railGlow("--work-rail-app-control", 42),
    color: "var(--work-rail-app-control)",
  },
  {
    id: "browser",
    label: "Browser",
    icon: Globe,
    gradient: railGlow("--work-rail-browser", 38),
    color: "var(--work-rail-browser)",
  },
];

const REMOTE_WORK_SIDEBAR_TAB_IDS = new Set<WorkSidebarTab>(["terminal", "git", "files"]);

function isRemoteWorkSidebarTab(tab: WorkSidebarTab): boolean {
  return REMOTE_WORK_SIDEBAR_TAB_IDS.has(tab);
}

/**
 * Terminal, Git, Files and Browser are ADE itself and are never gated. iOS Sim
 * and Electron Control are compiled panes a plugin can replace, so each needs
 * its compiled surface visible — or, once the owner is installed, the plugin's
 * own work-rail-pane, which the rail then mounts as the same compiled pane.
 *
 * Pure on purpose: the caller passes the gate in, so the rail filter, the
 * fallback and the force-switch effect all ask the same question, and the
 * answer can be tested without rendering a sidebar.
 */
export function isAvailableWorkSidebarTab(
  tab: WorkSidebarTab,
  options: {
    isRemoteProject: boolean;
    supportsIosSimulator: boolean;
    builtinSurfaceVisible: (id: PluginBuiltinSurfaceId) => boolean;
    /** Slot ids currently contributed to the rail. Absent means none. */
    pluginPaneIds?: ReadonlySet<string>;
  },
): boolean {
  // A contributed pane is available exactly while its contribution is, and it
  // is asked FIRST: the remote and macOS gates below describe host capabilities
  // the six built-ins need, and a plugin panel is a vocabulary schema read from
  // the local plugin host — none of which a remote checkout changes.
  if (isPluginPanelSlotId(tab)) return options.pluginPaneIds?.has(tab) === true;
  if (tab === "ios" && !options.builtinSurfaceVisible("ios")) return false;
  if (tab === "app-control" && !options.builtinSurfaceVisible("app-control")) return false;
  if (options.isRemoteProject) return isRemoteWorkSidebarTab(tab);
  return tab !== "ios" || options.supportsIosSimulator;
}

const APP_CONTROL_PLUGIN_ID = "ade-app-control";
const IOS_SIM_PLUGIN_ID = "ade-ios-sim";

/** Which compiled Work pane a contributed slot should mount, if any. */
export function hostEngineForPluginPane(
  pane: Pick<PluginPanelSlot, "pluginId"> | null,
): "app-control" | "ios" | null {
  if (!pane) return null;
  if (pane.pluginId === APP_CONTROL_PLUGIN_ID) return "app-control";
  if (pane.pluginId === IOS_SIM_PLUGIN_ID) return "ios";
  return null;
}

/**
 * Control and Simulator still need a local machine. A remote checkout has
 * nothing to attach a CDP session or a simulator to, and Simulator still
 * needs a Mac.
 */
export function allowWorkRailPluginPane(
  pane: Pick<PluginPanelSlot, "pluginId">,
  options: { isRemoteProject: boolean; supportsIosSimulator: boolean },
): boolean {
  if (pane.pluginId === IOS_SIM_PLUGIN_ID) {
    return !options.isRemoteProject && options.supportsIosSimulator;
  }
  if (pane.pluginId === APP_CONTROL_PLUGIN_ID) {
    return !options.isRemoteProject;
  }
  return true;
}

/**
 * Keep the user on the same product across the install flip.
 *
 * Compiled Control/Sim persist as `ios` / `app-control`. The plugin panes
 * persist as `plugin:<id>:<panelId>`. Without this remap, installing the owner
 * hides the compiled tab and the rail writes Git, and disabling it leaves a
 * dead plugin id that also falls back to Git. Graph already does the same
 * thing for `/graph` → `/plugin/ade-graph`.
 */
export function remapWorkRailTabAfterPolarity(
  tab: WorkSidebarTab,
  options: {
    pluginPanes: readonly Pick<PluginPanelSlot, "id" | "pluginId">[];
    builtinSurfaceVisible: (id: PluginBuiltinSurfaceId) => boolean;
    /**
     * Whether the plugin registry has answered yet. Absent reads as "yes", for
     * the callers that have no registry to wait on.
     *
     * Load-bearing in one direction only. A superseded surface reads as VISIBLE
     * before the registry resolves — that is the "the product without plugins is
     * the product ADE always shipped" rule — so on every cold launch a persisted
     * plugin pane would remap onto the compiled id, get written to storage, and
     * flip back a tick later when the contribution landed. The reader saw the
     * wrong pane flash, and the rail wrote its selection twice.
     */
    pluginsResolved?: boolean;
  },
): WorkSidebarTab {
  const resolved = options.pluginsResolved ?? true;
  if (tab === "ios" || tab === "app-control") {
    if (options.builtinSurfaceVisible(tab)) return tab;
    const pane = options.pluginPanes.find((entry) => hostEngineForPluginPane(entry) === tab);
    return pane ? pane.id as WorkSidebarTab : tab;
  }
  const parsed = typeof tab === "string" ? parsePluginPanelSlotId(tab) : null;
  if (!parsed) return tab;
  const compiled = hostEngineForPluginPane(parsed);
  if (!compiled) return tab;
  if (options.pluginPanes.some((entry) => entry.id === tab)) return tab;
  // "We do not know yet" is not "the plugin is gone". Waiting costs the reader
  // one render of the Git fallback; guessing costs them a wrong pane and a
  // clobbered selection.
  if (!resolved) return tab;
  if (options.builtinSurfaceVisible(compiled)) return compiled;
  return tab;
}

/**
 * Whether a compiled Control/Sim selection should sit still rather than fall
 * back to Git.
 *
 * The gate hides the compiled tab the moment the owner plugin is installed, and
 * the plugin's own pane arrives a tick later — writing Git in that window would
 * erase a selection the pane is about to restore. So the rail waits.
 *
 * It must NOT wait forever. `allowWorkRailPluginPane` refuses the Simulator
 * pane on a machine that is not a Mac and both panes on a remote checkout, so
 * on those hosts the contribution the rail is waiting for can never arrive: a
 * persisted `ios` never healed, and the rail showed Git under a selection it
 * would not overwrite. Waiting is therefore conditional on the pane being
 * possible here at all.
 */
export function shouldWaitForWorkRailPluginPane(
  tab: WorkSidebarTab,
  options: {
    isRemoteProject: boolean;
    supportsIosSimulator: boolean;
    builtinSurfaceVisible: (id: PluginBuiltinSurfaceId) => boolean;
  },
): boolean {
  if (tab !== "ios" && tab !== "app-control") return false;
  if (options.builtinSurfaceVisible(tab)) return false;
  const ownerPluginId = tab === "ios" ? IOS_SIM_PLUGIN_ID : APP_CONTROL_PLUGIN_ID;
  return allowWorkRailPluginPane({ pluginId: ownerPluginId }, options);
}

/** Native rail colour and label when a contributed pane IS the compiled product. */
export function workRailItemForPluginPane(
  pane: PluginPanelSlot,
): GlowMenuItem<WorkSidebarTab> {
  const host = hostEngineForPluginPane(pane);
  const native = host ? WORK_SIDEBAR_TABS.find((item) => item.id === host) : undefined;
  return {
    id: pane.id as WorkSidebarTab,
    label: native?.label ?? pane.label,
    icon: native?.icon ?? pane.icon,
    gradient: native?.gradient ?? railGlow("--work-rail-plugin", 34),
    color: native?.color ?? "var(--work-rail-plugin)",
  };
}

/**
 * The six built-ins in product order, with Control/Sim plugin panes sitting in
 * the same slots the compiled tabs occupy. Other contributed panes still follow
 * after Browser.
 */
export function buildWorkSidebarTabItems(
  pluginPanes: readonly PluginPanelSlot[],
  tabAvailability: {
    isRemoteProject: boolean;
    supportsIosSimulator: boolean;
    builtinSurfaceVisible: (id: PluginBuiltinSurfaceId) => boolean;
    pluginPaneIds?: ReadonlySet<string>;
  },
): Array<GlowMenuItem<WorkSidebarTab>> {
  const items: Array<GlowMenuItem<WorkSidebarTab>> = [];
  const seated = new Set<string>();
  // The compiled tabs this rail is already drawing. Control and Simulator can
  // be here at the same time as their plugin's pane: the compiled tab reads
  // `installedPlugins` through the gate while the panes read the contribution
  // store, and those two resolve a tick apart on every install and every
  // disable. In that window the plugin's pane would be seated again below,
  // under the SAME label and the SAME icon as the compiled tab — two identical
  // buttons that do the same thing, which reads as a duplicated rail.
  const drawnHosts = new Set<"ios" | "app-control">();
  for (const item of WORK_SIDEBAR_TABS) {
    if (isAvailableWorkSidebarTab(item.id, tabAvailability)) {
      items.push(item);
      if (item.id === "ios" || item.id === "app-control") drawnHosts.add(item.id);
      continue;
    }
    const host = item.id === "ios" || item.id === "app-control" ? item.id : null;
    if (!host) continue;
    const pane = pluginPanes.find((entry) => hostEngineForPluginPane(entry) === host);
    if (!pane) continue;
    items.push(workRailItemForPluginPane(pane));
    seated.add(pane.id);
    drawnHosts.add(host);
  }
  for (const pane of pluginPanes) {
    if (seated.has(pane.id)) continue;
    // The compiled tab wins the slot while both are visible: it is the one the
    // rail's own persisted ids name, and `remapWorkRailTabAfterPolarity` moves
    // the reader onto the plugin pane the moment the gate catches up.
    const host = hostEngineForPluginPane(pane);
    if (host && drawnHosts.has(host)) continue;
    items.push(workRailItemForPluginPane(pane));
  }
  return items;
}

export type WorkSidebarContextTarget =
  | { kind: "chat"; sessionId: string }
  | { kind: "draft"; draftTargetId: string; laneId: string; draftKind: WorkDraftKind }
  | { kind: "pty"; sessionId: string; ptyId: string; toolType: TerminalToolType | null };

const NO_CONTEXT_TARGET_ERROR = "Open a chat, draft, or agent CLI session in this lane before inserting tool context.";
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

function shortLaneId(laneId: string): string {
  return laneId.length <= 8 ? laneId : `${laneId.slice(0, 4)}...${laneId.slice(-3)}`;
}

function laneDisplayName(lanes: LaneSummary[], laneId: string | null): string {
  if (!laneId) return "another lane";
  return lanes.find((lane) => lane.id === laneId)?.name ?? shortLaneId(laneId);
}

function laneMismatchMessage(
  toolName: string,
  ownerLaneId: string | null,
  activeLaneId: string | null,
  lanes: LaneSummary[],
): string {
  const ownerLane = laneDisplayName(lanes, ownerLaneId);
  const activeLane = laneDisplayName(lanes, activeLaneId);
  return `This ${toolName} view is claimed by ${ownerLane}, not ${activeLane}. You can still view, inspect, and attach context here. Claim it from ${activeLane} to move ownership.`;
}

function dispatchAgentChatEvent<T>(
  eventName: string,
  target: Extract<WorkSidebarContextTarget, { kind: "chat" | "draft" }>,
  key: string,
  value: T,
): void {
  const targetDetail = target.kind === "chat"
    ? { sessionId: target.sessionId }
    : {
        draftTargetId: target.draftTargetId,
        laneId: target.laneId,
        draftKind: target.draftKind,
      };
  window.dispatchEvent(new CustomEvent(eventName, {
    detail: {
      ...targetDetail,
      [key]: value,
    },
  }));
}

function bracketedPaste(text: string): string {
  return `${BRACKETED_PASTE_START}${text.trimEnd()}\n${BRACKETED_PASTE_END}`;
}

function formatAttachmentForPty(attachment: AgentChatFileRef): string {
  return [
    "ADE visual attachment saved by the Work sidebar.",
    `Path: ${attachment.path}`,
    `Type: ${attachment.type}`,
    "",
  ].join("\n");
}

function hideBuiltInBrowserView(projectRoot: string | null): void {
  const browser = window.ade?.builtInBrowser;
  if (!browser) return;
  const scope = projectRoot ? { projectRoot } : {};
  void browser.stopInspect(scope).catch(() => {});
  void browser.setBounds({
    ...scope,
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    visible: false,
  }).catch(() => {});
}

function WarningBanner({ message }: { message: string }) {
  return (
    <div className="flex shrink-0 items-start gap-2 border-b border-amber-400/15 bg-amber-500/[0.055] px-3 py-2 text-[11px] leading-4 text-amber-100/85">
      <WarningCircle size={14} weight="fill" className="mt-0.5 shrink-0 text-amber-200/80" />
      <span>{message}</span>
    </div>
  );
}

function TerminalPanelEmpty({ message }: { message: string }) {
  return (
    <div className="flex h-full items-center justify-center px-4 text-center text-[12px] leading-5 text-muted-fg">
      {message}
    </div>
  );
}

export function WorkSidebar({
  active = true,
  laneId,
  lanes,
  activeSession,
  tab,
  onTabChange,
  onClose,
  contextTarget,
  contextDisabledReason: targetDisabledReason,
  runtimePin = null,
}: {
  active?: boolean;
  laneId: string | null;
  lanes: LaneSummary[];
  activeSession: TerminalSessionSummary | null;
  tab: WorkSidebarTab;
  onTabChange: (tab: WorkSidebarTab) => void;
  onClose: () => void;
  contextTarget: WorkSidebarContextTarget | null;
  contextDisabledReason: string | null;
  /**
   * The machine the active Work session actually runs on. Null means this
   * tab's bound machine. Every tool in here follows the chat: a chat on
   * another machine gets THAT machine's git, terminals, and files.
   */
  runtimePin?: OpenProjectBinding | null;
}) {
  const navigate = useNavigate();
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedMode, setSelectedMode] = useState<"staged" | "unstaged" | null>(null);
  const [selectedCommit, setSelectedCommit] = useState<GitCommitSummary | null>(null);
  const [appControlSession, setAppControlSession] = useState<AppControlSession | null>(null);
  const [iosSession, setIosSession] = useState<IosSimulatorSession | null>(null);
  const projectRoot = useAppStore(selectActiveProjectRoot);
  // The browser view is owned by THIS window's main process. A pin on another
  // checkout of this computer still drives that view, just under the pinned
  // checkout's tab collection, so hiding it on leave has to follow the pin. A
  // pin on another machine never opens a view here — the panel explains that
  // instead of driving a browser nobody in this window can see.
  const browserViewRoot = runtimePin?.kind === "local" ? runtimePin.rootPath : projectRoot;
  const isRemoteProject = useAppStore((state) => state.projectBinding?.kind === "remote");
  const supportsIosSimulator = isMacPlatform();
  const sidebarRef = useRef<HTMLElement | null>(null);
  const [compactTabs, setCompactTabs] = useState(false);
  const builtinGateInput = useBuiltinGateInput();
  const builtinSurfaceVisible = useCallback(
    (id: PluginBuiltinSurfaceId) => isBuiltinSurfaceVisible(id, builtinGateInput),
    [builtinGateInput],
  );
  // The session the rail sits beside, as a plugin sees it. Also what selects a
  // plugin's per-session `work-rail-pane` rows, so one chat can be offered a
  // different pane than another.
  const railSessionContext = useMemo(
    () => (activeSession
      ? pluginSessionContext({
        id: activeSession.id,
        title: activeSession.goal ?? activeSession.title,
        provider: activeSession.toolType,
        status: activeSession.runtimeState,
      })
      : null),
    [activeSession],
  );
  const contributedPanes = usePluginPanelSlots("work", "work-rail-pane", {
    active,
    context: railSessionContext,
  });
  const pluginPanes = useMemo(
    () => contributedPanes.filter((pane) => allowWorkRailPluginPane(pane, { isRemoteProject, supportsIosSimulator })),
    [contributedPanes, isRemoteProject, supportsIosSimulator],
  );
  const pluginPaneIds = useMemo(
    () => new Set(pluginPanes.map((pane) => pane.id)),
    [pluginPanes],
  );
  const tabAvailability = useMemo(
    () => ({ isRemoteProject, supportsIosSimulator, builtinSurfaceVisible, pluginPaneIds }),
    [builtinSurfaceVisible, isRemoteProject, pluginPaneIds, supportsIosSimulator],
  );
  const sidebarTabs = useMemo(
    () => buildWorkSidebarTabItems(pluginPanes, tabAvailability),
    [pluginPanes, tabAvailability],
  );
  // The registry has answered exactly when both are true. A host with no plugin
  // support never has a contribution to wait for, so it counts as resolved.
  const pluginsResolved = !builtinGateInput.pluginSupport || builtinGateInput.pluginsLoaded;
  const remappedTab = remapWorkRailTabAfterPolarity(tab, {
    pluginPanes,
    builtinSurfaceVisible,
    pluginsResolved,
  });
  const effectiveTab: WorkSidebarTab = isAvailableWorkSidebarTab(remappedTab, tabAvailability)
    ? remappedTab
    : "git";
  const selectedPluginPane = useMemo(
    () => pluginPanes.find((pane) => pane.id === effectiveTab) ?? null,
    [effectiveTab, pluginPanes],
  );
  const hostEngineTab = hostEngineForPluginPane(selectedPluginPane);

  // A foreign chat's lane is absent from the tab-bound `lanes` array, so the
  // worktree path (and therefore iOS / App Control) resolved to null. Fall
  // back to the machine's slice of the cross-machine union.
  const pinnedMachine = useMachineEntryForBinding(runtimePin);
  const pinnedLanes = useLanesForPin(runtimePin);
  const scopedLanes = pinnedLanes ?? lanes;
  const activeLane = useMemo(
    () => (laneId ? scopedLanes.find((lane) => lane.id === laneId) ?? null : null),
    [laneId, scopedLanes],
  );
  const laneRoot = activeLane?.worktreePath ?? null;
  // Pinned calls have no local fallback, so a machine that is not answering
  // gets one plain line instead of a wall of rejected IPC.
  const pinnedMachineOffline = Boolean(runtimePin) && pinnedMachine?.online === false;
  const pinnedMachineName = runtimePin ? machineNameForBinding(runtimePin) : null;

  useEffect(() => {
    setSelectedPath(null);
    setSelectedMode(null);
    setSelectedCommit(null);
  }, [laneId, runtimePin?.key]);

  // Also the uninstall path: the pane the user is sitting in can lose its
  // plugin mid-session, and `tabAvailability` changing is what moves them off
  // it instead of leaving a rail with a selected tab that has no matching
  // entry. Control and Simulator remap onto the compiled tab rather than Git
  // — `remapWorkRailTabAfterPolarity` is that hop.
  //
  // A contributed pane is deliberately exempt from a Git WRITE. Contributions
  // load a tick after the rail mounts, so a persisted plugin pane is
  // unavailable on the first render of every launch — and writing "git" there
  // would erase the user's selected pane before the plugin that owns it had a
  // chance to arrive. `effectiveTab` already falls back for the render, so the
  // pane shows Git until the contribution lands and then restores itself; a
  // plugin that is genuinely gone simply never restores, and the stale id is
  // overwritten the next time a tab is picked.
  useEffect(() => {
    if (remappedTab !== tab) {
      onTabChange(remappedTab);
      return;
    }
    if (isPluginPanelSlotId(tab)) return;
    // Installing the owner hides the compiled tab one tick before the
    // contribution lands. Writing Git here would erase a Control/Sim
    // selection the plugin pane is about to restore — but only while that pane
    // can actually arrive on this host.
    if (shouldWaitForWorkRailPluginPane(tab, {
      isRemoteProject,
      supportsIosSimulator,
      builtinSurfaceVisible,
    })) return;
    if (!isAvailableWorkSidebarTab(tab, tabAvailability)) {
      onTabChange("git");
    }
  }, [
    builtinSurfaceVisible,
    isRemoteProject,
    onTabChange,
    remappedTab,
    supportsIosSimulator,
    tab,
    tabAvailability,
  ]);

  useEffect(() => {
    const el = sidebarRef.current;
    if (!el) return undefined;
    const update = () => {
      setCompactTabs(el.getBoundingClientRect().width < 460);
    };
    update();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const previousBrowserTabRef = useRef(effectiveTab === "browser");
  useEffect(() => {
    const wasBrowser = previousBrowserTabRef.current;
    const isBrowser = active && effectiveTab === "browser";
    if (wasBrowser && !isBrowser) hideBuiltInBrowserView(browserViewRoot);
    previousBrowserTabRef.current = isBrowser;
    return () => {
      if (previousBrowserTabRef.current) hideBuiltInBrowserView(browserViewRoot);
    };
  }, [active, browserViewRoot, effectiveTab]);

  useEffect(() => {
    if (!active) return undefined;
    if (effectiveTab !== "app-control" && hostEngineTab !== "app-control") return undefined;
    if (pinnedMachineOffline) return undefined;
    const appControl = window.ade?.appControl;
    if (!appControl?.getStatus || !appControl.onEvent) return undefined;
    let cancelled = false;
    void appControl.getStatus(runtimePin)
      .then((status) => {
        if (!cancelled) setAppControlSession(status.activeSession ?? null);
      })
      .catch(() => {
        if (!cancelled) setAppControlSession(null);
      });
    const unsubscribe = appControl.onEvent((event) => {
      if (event.type === "session-started" || event.type === "session-updated") {
        setAppControlSession(event.session ?? null);
      } else if (event.type === "session-stopped") {
        setAppControlSession(null);
      }
    }, runtimePin);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [active, effectiveTab, hostEngineTab, pinnedMachineOffline, runtimePin]);

  useEffect(() => {
    if (!active) return undefined;
    if (effectiveTab !== "ios" && hostEngineTab !== "ios") return undefined;
    if (pinnedMachineOffline) return undefined;
    const iosSimulator = window.ade?.iosSimulator;
    if (!iosSimulator?.getStatus || !iosSimulator.onEvent) return undefined;
    let cancelled = false;
    void iosSimulator.getStatus(runtimePin)
      .then((status) => {
        if (!cancelled) setIosSession(status.activeSession ?? null);
      })
      .catch(() => {
        if (!cancelled) setIosSession(null);
      });
    const unsubscribe = iosSimulator.onEvent((event) => {
      if (event.type === "session-started" || event.type === "session-updated") {
        setIosSession(event.session ?? null);
      } else if (event.type === "session-released") {
        setIosSession(null);
      }
    }, runtimePin);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [active, effectiveTab, hostEngineTab, pinnedMachineOffline, runtimePin]);

  function resolveToolAttributionReason(): string | null {
    if (!laneId) return null;
    if ((effectiveTab === "app-control" || hostEngineTab === "app-control") && appControlSession?.laneId && appControlSession.laneId !== laneId) {
      return laneMismatchMessage("Electron Control", appControlSession.laneId, laneId, scopedLanes);
    }
    if ((effectiveTab === "ios" || hostEngineTab === "ios") && iosSession?.laneId && iosSession.laneId !== laneId) {
      return laneMismatchMessage("iOS Simulator", iosSession.laneId, laneId, scopedLanes);
    }
    return null;
  }
  const toolAttributionReason = resolveToolAttributionReason();
  const contextDisabledReason = targetDisabledReason;
  const warningReason = toolAttributionReason ?? contextDisabledReason;
  const canInsertContext = Boolean(contextTarget && !contextDisabledReason);
  const shouldPersistPanelAttachment = canInsertContext && contextTarget?.kind === "pty";
  const panelSessionId = contextTarget?.kind === "chat" ? contextTarget.sessionId : null;
  // Terminal ownership is an identity question, not a permission one: any chat
  // or running agent-CLI session can host attached terminals, including one on
  // another machine. Deriving it from `contextTarget` conflated the two and
  // showed foreign chats an "open a chat..." empty state instead of a terminal.
  const terminalOwnerSessionId = useMemo(() => {
    if (activeSession) {
      if (isChatToolType(activeSession.toolType)) return activeSession.id;
      if (
        activeSession.status === "running"
        && activeSession.ptyId
        && isPtyContextInsertableToolType(activeSession.toolType)
      ) {
        return activeSession.id;
      }
      return null;
    }
    return contextTarget?.kind === "chat" || contextTarget?.kind === "pty"
      ? contextTarget.sessionId
      : null;
  }, [activeSession, contextTarget]);

  const dispatchTargetRef = useRef({ contextTarget, contextDisabledReason });
  dispatchTargetRef.current = { contextTarget, contextDisabledReason };

  const insertIntoPty = useCallback((
    target: Extract<WorkSidebarContextTarget, { kind: "pty" }>,
    text: string,
    kind: WorkPtyContextInsertKind,
  ) => {
    const payload = text.trimEnd();
    if (!payload) return;
    void window.ade.terminal.write({
      terminalId: target.sessionId,
      ptyId: target.ptyId,
      data: bracketedPaste(payload),
    }, runtimePin)
      .then(() => {
        dispatchWorkPtyContextInserted({
          sessionId: target.sessionId,
          ptyId: target.ptyId,
          toolType: target.toolType,
          kind,
        });
      })
      .catch((error: unknown) => {
        console.error("[WorkSidebar] Failed to insert context into PTY", {
          sessionId: target.sessionId,
          toolType: target.toolType,
          error,
        });
      });
  }, [runtimePin]);

  const withContextTarget = useCallback((
    fallbackError: string,
    action: (target: WorkSidebarContextTarget) => void,
  ) => {
    const { contextTarget: target, contextDisabledReason: targetReason } = dispatchTargetRef.current;
    if (!target || targetReason) {
      throw new Error(targetReason ?? fallbackError);
    }
    action(target);
  }, []);

  const insertContext = useCallback(<T,>(
    eventName: string,
    key: string,
    value: T,
    kind: WorkPtyContextInsertKind,
    formatForPty: (value: T) => string | null,
  ) => {
    withContextTarget(NO_CONTEXT_TARGET_ERROR, (target) => {
      if (target.kind === "chat" || target.kind === "draft") {
        dispatchAgentChatEvent(eventName, target, key, value);
        return;
      }
      const text = formatForPty(value);
      if (text) insertIntoPty(target, text, kind);
    });
  }, [insertIntoPty, withContextTarget]);

  const addAttachment = useCallback((attachment: AgentChatFileRef) => {
    insertContext(
      "ade:agent-chat:add-attachment",
      "attachment",
      attachment,
      "attachment",
      formatAttachmentForPty,
    );
  }, [insertContext]);
  const addIosContext = useCallback((item: IosElementContextItem) => {
    insertContext(
      "ade:agent-chat:add-ios-context",
      "item",
      item,
      "ios",
      (value) => formatIosElementContextForPrompt([value]),
    );
  }, [insertContext]);
  const addAppControlContext = useCallback((item: AppControlContextItem) => {
    insertContext(
      "ade:agent-chat:add-app-control-context",
      "item",
      item,
      "app-control",
      (value) => formatAppControlContextForPrompt([value]),
    );
  }, [insertContext]);
  const addBuiltInBrowserContext = useCallback((item: unknown) => {
    insertContext(
      "ade:agent-chat:add-builtin-browser-context",
      "item",
      item,
      "browser",
      (value) => {
        const browserItem = normalizeBuiltInBrowserContextItem(value);
        return browserItem ? formatBuiltInBrowserContextForPrompt([browserItem]) : null;
      },
    );
  }, [insertContext]);
  const insertDraft = useCallback((text: string) => {
    withContextTarget("Open a chat, draft, or agent CLI session in this lane before inserting draft text.", (target) => {
      if (target.kind === "chat" || target.kind === "draft") {
        dispatchAgentChatEvent("ade:agent-chat:insert-draft", target, "text", text);
        return;
      }
      insertIntoPty(target, text, "draft");
    });
  }, [insertIntoPty, withContextTarget]);

  const content = useMemo(() => {
    if (!active) return null;
    // Before the lane guard below: a plugin pane's subject is its own data and
    // the chat beside it, so it works in a window with no lane selected — which
    // is exactly the case a "no lane" placeholder would wrongly claim it needs.
    if (selectedPluginPane && !hostEngineTab) {
      return (
        <div className="min-h-0 flex-1 overflow-auto px-3 py-3">
          <PluginSlotPanel slot={selectedPluginPane} active={active} context={railSessionContext} />
        </div>
      );
    }
    if (effectiveTab === "terminal") {
      if (!laneId) {
        return <TerminalPanelEmpty message="Select a lane or open a Work session to attach terminals." />;
      }
      if (!terminalOwnerSessionId) {
        const message = activeSession?.status && activeSession.status !== "running"
          ? `Continue this ${formatToolTypeLabel(activeSession.toolType)} session before opening an attached terminal.`
          : "Open a chat or running agent CLI session to attach terminals.";
        return <TerminalPanelEmpty message={message} />;
      }
      if (pinnedMachineOffline) {
        return <TerminalPanelEmpty message={`${pinnedMachineName} is offline.`} />;
      }
      return (
        <ChatTerminalDrawer
          // Remount on a machine change so a foreign machine's tabs can never
          // paint into the machine you just switched to.
          key={`work-terminal:${runtimePin?.key ?? "bound"}:${terminalOwnerSessionId}`}
          variant="panel"
          open
          onToggle={onClose}
          laneId={laneId}
          chatSessionId={terminalOwnerSessionId}
          runtimePin={runtimePin}
          emptyMessage="Create a terminal to work alongside this session."
        />
      );
    }

    if (effectiveTab === "browser") {
      return (
        <div className="flex h-full min-h-0 flex-col">
          {warningReason ? <WarningBanner message={warningReason} /> : null}
          <div className="min-h-0 flex-1 overflow-hidden">
            <ChatBuiltInBrowserPanel
              key={`work-browser:${runtimePin?.key ?? "bound"}`}
              sessionId={panelSessionId}
              runtimePin={runtimePin}
              onAddAttachment={shouldPersistPanelAttachment ? addAttachment : undefined}
              onAddContext={canInsertContext ? addBuiltInBrowserContext : undefined}
              onInsertDraft={canInsertContext ? insertDraft : undefined}
            />
          </div>
        </div>
      );
    }

    if (!laneId) {
      return (
        <div className="flex h-full items-center justify-center px-4 text-center text-[12px] text-muted-fg">
          Select a lane or open a Work session to use the sidebar.
        </div>
      );
    }

    if (effectiveTab === "git") {
      if (pinnedMachineOffline) {
        return <TerminalPanelEmpty message={`${pinnedMachineName} is offline.`} />;
      }
      const hasDiffSelection = Boolean(selectedPath || selectedCommit);
      return (
        <div className="flex h-full min-h-0 flex-col">
          <div className={cn("min-h-0 overflow-auto", hasDiffSelection ? "max-h-[58%] shrink-0" : "flex-1")}>
            <LaneGitActionsPane
              key={`work-git:${runtimePin?.key ?? "bound"}:${laneId}`}
              laneId={laneId}
              runtimePin={runtimePin}
              autoRebaseEnabled={false}
              onOpenSettings={() => navigate(settingsRouteFor("lanes-git.lane-templates"))}
              onSelectFile={(path, mode) => {
                setSelectedPath(path);
                setSelectedMode(mode);
                setSelectedCommit(null);
              }}
              onSelectCommit={(commit) => {
                setSelectedCommit(commit);
                if (commit) {
                  setSelectedPath(null);
                  setSelectedMode(null);
                }
              }}
              onClearDiffSelection={() => {
                setSelectedPath(null);
                setSelectedMode(null);
                setSelectedCommit(null);
              }}
              selectedPath={selectedPath}
              selectedMode={selectedMode}
              selectedCommit={selectedCommit}
              selectedCommitSha={selectedCommit?.sha ?? null}
            />
          </div>
          {hasDiffSelection ? (
            <div className="min-h-0 flex-1 border-t border-white/[0.08]">
              <LaneDiffPane
                laneId={laneId}
                runtimePin={runtimePin}
                selectedPath={selectedPath}
                selectedFileMode={selectedMode}
                selectedCommit={selectedCommit}
                liveSync
              />
            </div>
          ) : null}
        </div>
      );
    }

    if (effectiveTab === "files") {
      return (
        <FilesTab
          key={`work-files:${runtimePin?.key ?? "bound"}`}
          preferredLaneId={laneId}
          pin={runtimePin}
          embedded
        />
      );
    }

    const panel = (effectiveTab === "ios" || hostEngineTab === "ios") ? (
      <ChatIosSimulatorPanel
        key={`work-ios:${runtimePin?.key ?? "bound"}`}
        sessionId={panelSessionId}
        laneId={laneId}
        runtimePin={runtimePin}
        projectRoot={laneRoot}
        controlDisabledReason={null}
        ignoreChatOwnership
        onAddAttachment={shouldPersistPanelAttachment ? addAttachment : undefined}
        onAddContext={canInsertContext ? addIosContext : undefined}
        onInsertDraft={canInsertContext ? insertDraft : undefined}
      />
    ) : (
      <ChatAppControlPanel
        key={`work-appcontrol:${runtimePin?.key ?? "bound"}`}
        sessionId={panelSessionId}
        laneId={laneId}
        runtimePin={runtimePin}
        projectRoot={laneRoot}
        controlDisabledReason={null}
        onAddAttachment={shouldPersistPanelAttachment ? addAttachment : undefined}
        onAddContext={canInsertContext ? addAppControlContext : undefined}
        onInsertDraft={canInsertContext ? insertDraft : undefined}
      />
    );
    return (
      <div className="flex h-full min-h-0 flex-col">
        {warningReason ? <WarningBanner message={warningReason} /> : null}
        <div className="min-h-0 flex-1 overflow-auto px-3 py-3">{panel}</div>
      </div>
    );
  }, [
    addAppControlContext,
    addAttachment,
    addBuiltInBrowserContext,
    addIosContext,
    panelSessionId,
    canInsertContext,
    insertDraft,
    laneId,
    warningReason,
    shouldPersistPanelAttachment,
    laneRoot,
    navigate,
    selectedCommit,
    selectedMode,
    selectedPath,
    active,
    effectiveTab,
    activeSession,
    onClose,
    pinnedMachineName,
    pinnedMachineOffline,
    runtimePin,
    terminalOwnerSessionId,
    railSessionContext,
    selectedPluginPane,
    hostEngineTab,
  ]);

  return (
    <aside
      ref={sidebarRef}
      className="flex h-full min-h-0 min-w-[280px] flex-col border-l border-white/[0.08] bg-surface/85"
    >
      <div className="flex min-h-[42px] shrink-0 items-stretch border-b border-white/[0.08]">
        <GlowMenu
          variant="flat"
          className="min-w-0"
          items={sidebarTabs}
          activeItem={effectiveTab}
          compact={compactTabs}
          onItemClick={(nextTab) => {
            if (effectiveTab === "browser" && nextTab !== "browser") hideBuiltInBrowserView(browserViewRoot);
            onTabChange(nextTab);
          }}
        />
        <button
          type="button"
          className="ade-shell-control inline-flex w-9 shrink-0 items-center justify-center self-stretch rounded-none border-l border-white/[0.08] text-muted-fg/70 transition-colors hover:bg-white/[0.04] hover:text-fg"
          data-variant="ghost"
          onClick={() => {
            if (effectiveTab === "browser") hideBuiltInBrowserView(browserViewRoot);
            onClose();
          }}
          title="Close Tools sidebar"
          aria-label="Close Tools sidebar"
        >
          <X size={13} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {content}
      </div>
    </aside>
  );
}
