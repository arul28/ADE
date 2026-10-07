import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AppWindow,
  ArrowLineRight,
  ArrowSquareOut,
  ChatCircleDots,
  CircleNotch,
  DownloadSimple,
  Folder,
  FolderOpen,
  GearSix,
  Plus,
  Plugs,
  TextT,
  Trash,
  UploadSimple,
  WarningCircle,
  X,
  XSquare,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import {
  ContextMenu,
  type ContextMenuEntry,
  type ContextMenuState,
} from "../ui/ContextMenu";
import { CloneLocallyDialog, type CloneLocallyTarget } from "../projects/CloneLocallyDialog";
import { cloneTargetFor, projectMenuSections } from "../projects/projectMenuEntries";
import { ProjectIconDialog, type ProjectIconDialogTarget } from "../projects/ProjectIconDialog";
import {
  getProjectIconFromCache,
  setProjectIconCache,
  subscribeProjectIcon,
} from "../../lib/projectIconCache";

import { useAppStore } from "../../state/appStore";
import { WorkToolPickerBackdrop } from "../terminals/WorkToolPickerBackdrop";
import { useGithubProjectRemote } from "../../lib/useGithubProjectRemote";
import { isWebClientMode } from "../../lib/webClientMode";
import { remoteProjectBindingKey } from "../../../shared/projectIdentity";
import { rememberProjectOriginSummaries } from "../lanes/laneMachines";
import { resetAppZoom, zoomAppIn, zoomAppOut } from "../../lib/appZoom";
import { consumeAppMenuCommand } from "../../lib/appMenuCommands";
import { consumeAppZoomCommand } from "../../lib/appZoomCommands";
import { cn } from "../ui/cn";
import {
  readStoredProjectRoute,
  removeStoredProjectRoute,
} from "./projectRouteStorage";
import { ProjectSidebarToggle } from "./projectSidebar/ProjectSidebarToggle";
import {
  PROJECT_SIDEBAR_TOGGLE_KEYBINDING,
  projectSidebarShortcutLabel,
} from "./projectSidebar/projectSidebarTabs";
import {
  activeMachineForGroup,
  groupProjectTabs,
  localCheckoutForRemote,
  recentProjectLocationKey,
  remoteBindingFromRecent,
  resolveProjectTabFallback,
  tabOrderKey,
  type ProjectTabGroup,
  type ProjectTabMachine,
} from "./projectTabGrouping";
import { deriveIconAccentColor } from "../../lib/iconAccent";
import { PROJECT_TAB_KEY_ATTR } from "./useProjectTabDrag";
import { useProjectTabLifecycle } from "./useProjectTabLifecycle";
import { SmartTooltip } from "../ui/SmartTooltip";
import { confirmDialog } from "../ui/dialog/confirm";
import { isMac } from "../../lib/platform";
import type {
  ProjectIcon,
  RemoteOpenProjectBinding,
  RecentProjectSummary,
  GitHubStatus,
  RemoteRuntimeConnectionSnapshot,
  RemoteRuntimeConnectionState,
  RemoteRuntimeTarget,
  SyncRoleSnapshot,
  AppResourceUsageSnapshot,
} from "../../../shared/types";
import { AutoUpdateControl } from "./AutoUpdateControl";
import { AccountBalanceIndicator } from "./AccountBalanceIndicator";
import { ChannelBadge } from "./ChannelBadge";
import { HeaderSheet } from "./HeaderSheet";
import { LinearQuickViewButton } from "./LinearQuickViewButton";
import { CloudAgentsQuickViewButton } from "./cloudAgents/CloudAgentsQuickViewButton";
import { PublishToGitHubDialog } from "../projects/PublishToGitHubDialog";
import { ConnectionsPanel } from "./ConnectionsPanel";
import {
  subscribeOpenConnectionsPanel,
  type ConnectionsPanelTab,
} from "../../lib/connectionsPanel";
import { HeaderActivityControl } from "../activity/HeaderActivityControl";
import { HeaderUsageControl } from "../usage/HeaderUsageControl";
import { useUsageHeaderPreferences } from "../usage/usageHeaderPreferences";
import { GlobalVoiceCaptureIndicator } from "../voice/GlobalVoiceCaptureIndicator";
import { appResourcePressureLevel, getAppResourceUsageCoalesced, resourcePressureDescription } from "../../lib/resourcePressure";
import { ShellNavTab } from "./ShellNavTab";
import { StoragePressureIndicator } from "./StoragePressureIndicator";
import {
  ADE_BROWSER_VIEW_OCCLUSION_END_EVENT,
  ADE_BROWSER_VIEW_OCCLUSION_START_EVENT,
} from "../../lib/workSidebarBrowserResize";
import { settingsRouteFor } from "../settings/settingsManifest";
import { AccountAvatar } from "../account/AccountAvatar";
import { useAccountStatus } from "../../lib/account";

// Hosted-client only: kept out of the desktop bundle's critical path, and out
// of the desktop bundle's dependency graph for the sync client entirely.
const WebConnectionsChip = React.lazy(() =>
  import("../../webclient/workspace/WebConnectionsChip").then((module) => ({
    default: module.WebConnectionsChip,
  })),
);

const RECENT_PROJECTS_CACHE_TTL_MS = 2_500;
const PHONE_SYNC_STARTUP_DELAY_MS = 5_000;
const RESOURCE_PRESSURE_SAMPLE_MS = 2_000;
let recentProjectsCache:
  | { rows: RecentProjectSummary[]; fetchedAtMs: number }
  | null = null;
let recentProjectsInFlight: Promise<RecentProjectSummary[]> | null = null;
let recentProjectsCacheSource:
  | (() => Promise<RecentProjectSummary[]>)
  | null = null;

function rememberRecentProjects(rows: RecentProjectSummary[]): void {
  recentProjectsCache = { rows, fetchedAtMs: Date.now() };
  rememberProjectOriginSummaries(rows, { replace: true });
}

function listRecentProjectsCached(options?: {
  force?: boolean;
}): Promise<RecentProjectSummary[]> {
  const source = window.ade.project.listRecent;
  if (recentProjectsCacheSource !== source) {
    recentProjectsCacheSource = source;
    recentProjectsCache = null;
    recentProjectsInFlight = null;
  }
  const now = Date.now();
  if (
    !options?.force &&
    recentProjectsCache &&
    now - recentProjectsCache.fetchedAtMs < RECENT_PROJECTS_CACHE_TTL_MS
  ) {
    return Promise.resolve(recentProjectsCache.rows);
  }
  if (!options?.force && recentProjectsInFlight) return recentProjectsInFlight;
  recentProjectsInFlight = window.ade.project
    .listRecent()
    .then((rows) => {
      rememberRecentProjects(rows);
      return rows;
    })
    .finally(() => {
      recentProjectsInFlight = null;
    });
  return recentProjectsInFlight;
}
function isSyncConnected(snapshot: SyncRoleSnapshot | null): boolean {
  if (!snapshot) return false;
  if (snapshot.client.state === "error") return false;
  if (snapshot.role === "brain") {
    return snapshot.connectedPeers.some((peer) => peer.deviceType === "phone");
  }
  return snapshot.client.state === "connected";
}

function connectedWebClients(snapshot: SyncRoleSnapshot | null) {
  if (!snapshot) return [];
  if (snapshot.client.state === "error") return [];
  return snapshot.connectedPeers.filter((peer) => peer.deviceType === "browser");
}

function HeaderAccountAvatar() {
  const { status } = useAccountStatus();
  const [githubStatus, setGithubStatus] = useState<GitHubStatus | null>(null);

  useEffect(() => {
    if (!status.signedIn || status.imageUrl) {
      setGithubStatus(null);
      return;
    }
    let cancelled = false;
    const apply = (next: GitHubStatus) => {
      if (cancelled) return;
      setGithubStatus(next);
    };
    void window.ade.github?.getStatus?.().then(apply).catch(() => {});
    const unsubscribe = window.ade.github?.onStatusChanged?.(apply);
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [status.imageUrl, status.signedIn]);

  return (
    <AccountAvatar
      status={status}
      githubLogin={githubStatus?.userLogin ?? null}
      githubConnected={Boolean(githubStatus?.connected)}
      size={15}
    />
  );
}

function isWebSyncConnected(snapshot: SyncRoleSnapshot | null): boolean {
  return connectedWebClients(snapshot).length > 0;
}


const HEADER_STATUS_COMPACT_MAX_WIDTH_PX = 767;

function useHeaderStatusCompactLayout(): boolean {
  const [compact, setCompact] = useState(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return false;
    }
    return window.matchMedia(`(max-width: ${HEADER_STATUS_COMPACT_MAX_WIDTH_PX}px)`).matches;
  });

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(`(max-width: ${HEADER_STATUS_COMPACT_MAX_WIDTH_PX}px)`);
    const update = () => setCompact(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  return compact;
}

function useResourcePressureUsage(enabled: boolean): AppResourceUsageSnapshot | null {
  const [usage, setUsage] = useState<AppResourceUsageSnapshot | null>(null);

  useEffect(() => {
    if (!enabled) {
      setUsage(null);
      return;
    }

    let cancelled = false;
    let requestVersion = 0;
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      const version = ++requestVersion;
      void getAppResourceUsageCoalesced()
        .then((snapshot) => {
          if (!cancelled && version === requestVersion) setUsage(snapshot);
        })
    };

    refresh();
    const interval = window.setInterval(refresh, RESOURCE_PRESSURE_SAMPLE_MS);
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [enabled]);

  return usage;
}

function ResourcePressureIndicator({ usage }: { usage: AppResourceUsageSnapshot | null }) {
  const level = appResourcePressureLevel(usage);
  if (level === 0) return null;
  const color =
    level >= 4 ? "#F87171" : level === 3 ? "#FB7185" : level === 2 ? "#FB923C" : "#FBBF24";
  const description = resourcePressureDescription(usage);
  return (
    <SmartTooltip
      forceEnabled
      side="bottom"
      content={{
        label: "ADE is under load",
        description,
      }}
      wrapperStyle={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
    >
      <button
        type="button"
        role="status"
        aria-label={`ADE resource pressure level ${level}`}
        title={description}
        data-ade-resource-pressure-level={level}
        data-ade-resource-pressure-active-ptys={usage?.activePtyCount ?? 0}
        data-ade-resource-pressure-pty-processes={usage?.ptyProcessCount ?? 0}
        data-ade-resource-pressure-pty-cpu={usage?.ptyCpuPercent ?? ""}
        data-ade-resource-pressure-pty-memory-mb={usage?.ptyMemoryMB ?? ""}
        data-ade-resource-pressure-sample-status={usage?.processSample?.status ?? ""}
        className={cn(
          "ade-shell-control inline-flex h-[24px] w-[24px] shrink-0 items-center justify-center rounded-md",
          "border transition-[background-color,color,border-color,box-shadow] duration-150",
        )}
        style={{
          color,
          borderColor: `${color}80`,
          background: `${color}1f`,
          boxShadow: `0 0 0 1px ${color}22, 0 0 16px -10px ${color}`,
          outline: "none",
        }}
        onClick={() => {
          window.location.hash = `#${settingsRouteFor("storage.diagnostics")}`;
        }}
      >
        <WarningCircle size={14} weight="fill" />
      </button>
    </SmartTooltip>
  );
}

const HEADER_STATUS_MENU_ROW_CLASS =
  "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11px] font-medium text-muted-fg/80 transition-colors duration-150 hover:bg-fg/[0.06] hover:text-fg/90";

function ShellConnectionChip({
  label,
  icon,
  connected,
  title,
  ariaExpanded,
  onClick,
  trailing,
  layout = "chip",
}: {
  label: string;
  icon: React.ReactNode;
  connected: boolean;
  title: string;
  ariaExpanded?: boolean;
  onClick: () => void;
  trailing?: React.ReactNode;
  layout?: "chip" | "menu-row";
}) {
  return (
    <button
      type="button"
      className={cn(
        layout === "menu-row"
          ? HEADER_STATUS_MENU_ROW_CLASS
          : "ade-shell-control shrink-0 inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium text-muted-fg/75 transition-colors duration-150 hover:text-fg/90",
      )}
      data-variant={layout === "chip" ? "ghost" : undefined}
      role={layout === "menu-row" ? "menuitem" : undefined}
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      title={title}
      aria-label={`${label}, ${connected ? "connected" : "not connected"}`}
      aria-expanded={ariaExpanded}
      onClick={onClick}
    >
      {layout === "menu-row" ? icon : <span>{label}</span>}
      {layout === "menu-row" ? (
        <span className="min-w-0 flex-1 truncate">{label}</span>
      ) : (
        icon
      )}
      <span
        className={cn(
          "h-1.5 w-1.5 shrink-0 rounded-full",
          connected ? "bg-emerald-400" : "bg-red-400",
        )}
        aria-hidden
      />
      {trailing}
    </button>
  );
}


function HeaderStatusMenu({
  remoteConnected,
  syncConnected,
  showSyncControl,
  children,
}: {
  remoteConnected: boolean;
  syncConnected: boolean;
  showSyncControl: boolean;
  children: (close: () => void) => React.ReactNode;
}) {
  const compact = useHeaderStatusCompactLayout();
  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const close = useCallback(() => {
    setOpen(false);
    setMenuPos(null);
  }, []);

  const openMenu = useCallback(() => {
    const el = buttonRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setMenuPos({
      top: rect.bottom + 6,
      right: Math.max(8, window.innerWidth - rect.right),
    });
    setOpen(true);
  }, []);

  useEffect(() => {
    if (!compact) close();
  }, [close, compact]);

  const anyConnected = remoteConnected || (showSyncControl && syncConnected);

  if (!compact) return null;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={cn(
          "ade-shell-control relative inline-flex h-[24px] w-[24px] shrink-0 items-center justify-center",
          "transition-[background-color,color,border-color,box-shadow] duration-150",
        )}
        data-variant="ghost"
        aria-label="Connections and usage"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Connections and usage"
        onClick={() => (open ? close() : openMenu())}
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      >
        <Plugs size={14} weight="regular" />
        <span
          className={cn(
            "absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full border border-black/40",
            anyConnected ? "bg-emerald-400" : "bg-red-400",
          )}
          aria-hidden
        />
      </button>
      <HeaderSheet
        open={open && menuPos !== null}
        panelRef={menuRef}
        title="Connections and usage"
        bare
        width="w-max min-w-[220px] max-w-[calc(100vw-16px)]"
        panelStyle={menuPos ? {
          top: menuPos.top,
          right: menuPos.right,
          left: "auto",
          maxHeight: "calc(100vh - 80px)",
          overflowY: "auto",
        } : undefined}
        surfaceClassName="min-w-[220px] overflow-hidden rounded-xl border border-fg/10 bg-[color:var(--ade-shell-surface,#121019)] p-1.5 shadow-2xl shadow-black/45"
        onClose={close}
      >
        <div role="menu" aria-label="Connections and usage">
          {children(close)}
        </div>
      </HeaderSheet>
    </>
  );
}

function fallbackProjectName(rootPath: string): string {
  return rootPath.split(/[\\/]/).filter(Boolean).pop() ?? rootPath;
}



/** An accent call-to-action in the header, such as Publish or Clone locally. */
function HeaderActionPill({
  icon: Icon,
  label,
  ariaLabel,
  tooltip,
  disabled = false,
  onClick,
}: {
  icon: PhosphorIcon;
  label: string;
  ariaLabel?: string;
  tooltip: { label: string; description: string };
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <SmartTooltip
      content={tooltip}
      wrapperStyle={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
    >
      <button
        type="button"
        aria-label={ariaLabel ?? label}
        onClick={onClick}
        disabled={disabled}
        className="shrink-0 inline-flex items-center gap-1.5 rounded-md px-2 py-1 transition-colors duration-150"
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "var(--color-accent)",
          background:
            "color-mix(in srgb, var(--color-accent) 18%, transparent)",
          border:
            "1px solid color-mix(in srgb, var(--color-accent) 36%, transparent)",
          borderRadius: 6,
          cursor: disabled ? "not-allowed" : "pointer",
          opacity: disabled ? 0.55 : 1,
        }}
      >
        <Icon size={11} weight="bold" />
        {label}
      </button>
    </SmartTooltip>
  );
}

function ProjectTabIcon({
  rootPath,
  isCurrent,
  animate,
  disabled,
  iconDataUrlOverride,
  onAccentColorChange,
}: {
  rootPath: string;
  isCurrent: boolean;
  animate: boolean;
  disabled: boolean;
  /**
   * When defined, the caller owns this tab's icon (a project on another
   * machine, whose icon the host resolves). A non-empty data URL is rendered
   * directly; null falls back to the folder glyph. Either way the local
   * resolveIcon path is skipped, since it can only read the local filesystem.
   */
  iconDataUrlOverride?: string | null;
  onAccentColorChange?: (rootPath: string, color: string | null) => void;
}) {
  const [icon, setIcon] = useState<ProjectIcon | null>(() =>
    disabled ? null : (getProjectIconFromCache(rootPath) ?? null),
  );
  const [failed, setFailed] = useState(false);

  const managedIcon = iconDataUrlOverride !== undefined;
  const overrideIcon: ProjectIcon | null = iconDataUrlOverride
    ? { dataUrl: iconDataUrlOverride, sourcePath: null, mimeType: null }
    : null;
  const displayIcon: ProjectIcon | null = managedIcon ? overrideIcon : icon;

  useEffect(() => {
    if (managedIcon || disabled) return;
    return subscribeProjectIcon(rootPath, () => {
      setFailed(false);
      setIcon(getProjectIconFromCache(rootPath) ?? null);
    });
  }, [disabled, managedIcon, rootPath]);

  useEffect(() => {
    setFailed(false);
    if (managedIcon) {
      setIcon(null);
      return;
    }
    // Honor `disabled` (e.g. project marked missing) BEFORE consulting the
    // cache. Otherwise a project that was successfully resolved earlier in
    // the session keeps showing its stale icon after it goes missing.
    if (disabled) {
      setIcon(null);
      return;
    }
    const cached = getProjectIconFromCache(rootPath);
    if (cached) {
      setIcon(cached);
      return;
    }
    if (!isCurrent) {
      setIcon(null);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      window.ade.project
        .resolveIcon(rootPath)
        .then((nextIcon) => {
          if (cancelled) return;
          setProjectIconCache(rootPath, nextIcon);
          setIcon(nextIcon);
        })
        .catch(() => {
          if (!cancelled) setIcon(null);
        });
    }, 100);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [disabled, isCurrent, rootPath, managedIcon, iconDataUrlOverride]);

  useEffect(() => {
    let cancelled = false;
    const dataUrl = displayIcon?.dataUrl;
    if (!dataUrl || failed) {
      onAccentColorChange?.(rootPath, null);
      return () => {
        cancelled = true;
      };
    }
    deriveIconAccentColor(dataUrl)
      .then((color) => {
        if (!cancelled) onAccentColorChange?.(rootPath, color);
      })
      .catch(() => {
        if (!cancelled) onAccentColorChange?.(rootPath, null);
      });
    return () => {
      cancelled = true;
    };
  }, [failed, displayIcon?.dataUrl, onAccentColorChange, rootPath]);

  return (
    <span
      aria-hidden
      className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] text-current"
    >
      {!displayIcon?.dataUrl || failed ? (
        <Folder
          size={14}
          weight="regular"
          className={cn(
            "shrink-0 transition-opacity duration-150",
            isCurrent ? "opacity-90" : "opacity-70",
            animate && "animate-pulse",
          )}
        />
      ) : (
        <img
          src={displayIcon.dataUrl}
          alt=""
          className={cn(
            "h-[14px] w-[14px] shrink-0 rounded-[3px] object-contain transition-opacity duration-150",
            isCurrent ? "opacity-95" : "opacity-75",
            animate && "animate-pulse",
          )}
          draggable={false}
          onError={() => setFailed(true)}
        />
      )}
    </span>
  );
}

export function TopBar({
  personalChatsRouteActive = false,
  accountRouteActive = false,
  hubRouteActive = false,
  settingsRouteActive = false,
  onOpenActivityPane,
  onNavigate,
}: {
  personalChatsRouteActive?: boolean;
  accountRouteActive?: boolean;
  hubRouteActive?: boolean;
  /** The `#/settings` route is in front. Drives the standalone Settings tab. */
  settingsRouteActive?: boolean;
  onNavigate?: (path: string, opts?: { replace?: boolean }) => void;
  /** Raises the shell's Activity pane over whatever tab is in front. */
  onOpenActivityPane?: () => void;
} = {}) {
  const project = useAppStore((s) => s.project);
  const theme = useAppStore((s) => s.theme);
  const usageHeaderPreferences = useUsageHeaderPreferences();
  const hasProject = Boolean(project?.rootPath);
  const projectBinding = useAppStore((s) => s.projectBinding);
  const projectHydrated = useAppStore((s) => s.projectHydrated);
  const showWelcome = useAppStore((s) => s.showWelcome);
  const terminalAttention = useAppStore((s) => s.terminalAttention);
  const openRepo = useAppStore((s) => s.openRepo);
  const isNewTabOpen = useAppStore((s) => s.isNewTabOpen);
  const openNewTab = useAppStore((s) => s.openNewTab);
  const cancelNewTab = useAppStore((s) => s.cancelNewTab);
  // Settings with no project open — the new-project screen's own Settings
  // entry. It gets a tab of its own, the way a new tab does, so the header
  // always says which surface is in front.
  const standaloneSettingsOpen = useAppStore((s) => s.standaloneSettingsOpen);
  const setStandaloneSettingsOpen = useAppStore((s) => s.setStandaloneSettingsOpen);
  const isSettingsTabOpen = settingsRouteActive && !hasProject && standaloneSettingsOpen;
  const personalChatsTabOpen = useAppStore((s) => s.personalChatsTabOpen);
  const closePersonalChatsTab = useAppStore((s) => s.closePersonalChatsTab);
  const projectTransition = useAppStore((s) => s.projectTransition);
  const switchProjectToPath = useAppStore((s) => s.switchProjectToPath);
  const switchRemoteProject = useAppStore((s) => s.switchRemoteProject);
  const [recentProjects, setRecentProjects] = useState<RecentProjectSummary[]>(
    [],
  );
  const localRecentProjects = useMemo(
    () => recentProjects.filter((entry) => entry.kind !== "remote"),
    [recentProjects],
  );
  const [projectAccentColors, setProjectAccentColors] = useState<
    Record<string, string | null>
  >({});
  const [relocatingPath, setRelocatingPath] = useState<string | null>(null);
  // In the browser web client there are no OS windows to open/close and no
  // desktop auto-updater; hide those controls so web shows no dead buttons.
  const webMode = isWebClientMode();
  const [syncSnapshot, setSyncSnapshot] = useState<SyncRoleSnapshot | null>(
    null,
  );
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [connectionsTab, setConnectionsTab] = useState<ConnectionsPanelTab>("machines");
  const [remoteSnapshot, setRemoteSnapshot] =
    useState<RemoteRuntimeConnectionSnapshot | null>(null);
  const applyRemoteSnapshot = useCallback(
    (snapshot: RemoteRuntimeConnectionSnapshot) => {
      setRemoteSnapshot((current) =>
        current && current.updatedAt > snapshot.updatedAt ? current : snapshot,
      );
    },
    [],
  );
  const [publishOpen, setPublishOpen] = useState(false);
  const openProjectTabRoots = useAppStore((s) => s.openProjectTabRoots);
  const setOpenProjectTabRoots = useAppStore((s) => s.setOpenProjectTabRoots);
  const openRemoteProjectTabs = useAppStore((s) => s.openRemoteProjectTabs);
  const setOpenRemoteProjectTabs = useAppStore(
    (s) => s.setOpenRemoteProjectTabs,
  );
  const openProjectTabRootsRef = useRef(openProjectTabRoots);
  const openRemoteProjectTabsRef = useRef(openRemoteProjectTabs);
  // Tab groups and the connection snapshot are both derived later in the
  // component; the removal handler reads them through refs so it can stay a
  // stable callback with empty deps.
  const tabGroupsRef = useRef<ProjectTabGroup[]>([]);
  const remoteSnapshotRef = useRef<RemoteRuntimeConnectionSnapshot | null>(
    null,
  );
  // A logical repo tab remembers its chosen checkout even while another repo
  // is active. This is deliberately per TopBar/window instance: opening a
  // local counterpart must not make an inactive remote tab fall back to the
  // first (local) machine in its group.
  const [preferredBindingKeyByGroup, setPreferredBindingKeyByGroup] = useState<
    Record<string, string>
  >({});
  /** The user's tab order, as binding keys, across every kind of tab. */
  const [tabOrder, setTabOrder] = useState<string[]>([]);
  const [windowId, setWindowId] = useState<number | null>(null);
  const [windowSessionRestored, setWindowSessionRestored] = useState(false);
  const connectionsPanelRef = useRef<HTMLDivElement | null>(null);
  const closeConnections = useCallback(() => setConnectionsOpen(false), []);
  const openConnections = useCallback((tab: ConnectionsPanelTab = "machines") => {
    if (webMode) {
      // The hosted client has no header Connections panel — the connections
      // chip in the top right owns that surface, and it listens for this event
      // (WEB_OPEN_CONNECTIONS_EVENT in webclient/workspace/WebConnectionsChip).
      // Returning early here is what left "Connect another machine…" inert.
      window.dispatchEvent(new CustomEvent("ade-web:open-connections", { detail: { tab } }));
      return;
    }
    setConnectionsTab(tab);
    setConnectionsOpen(true);
  }, [webMode]);
  const isProjectBusy = projectTransition != null || relocatingPath != null;
  const remoteBinding =
    projectBinding?.kind === "remote" ? projectBinding : null;
  const chromePanelOccludesNativeBrowser = !webMode && connectionsOpen;
  const workspaceProjectOpen =
    projectHydrated === true &&
    showWelcome !== true &&
    isNewTabOpen !== true &&
    Boolean(project?.rootPath) &&
    !remoteBinding;
  const resourceUsage = useResourcePressureUsage(workspaceProjectOpen);
  // The sidebar toggle only shows while a project surface is on screen: not on
  // the welcome page, a new tab, Chats, or the account page.
  const projectSurfaceVisible =
    projectHydrated === true &&
    showWelcome !== true &&
    isNewTabOpen !== true &&
    Boolean(project?.rootPath) &&
    !personalChatsRouteActive &&
    !accountRouteActive &&
    !hubRouteActive;
  const keybindings = useAppStore((s) => s.keybindings);
  const sidebarToggleShortcut = projectSidebarShortcutLabel(keybindings, PROJECT_SIDEBAR_TOGGLE_KEYBINDING);

  const projectRootForRemote = workspaceProjectOpen
    ? (project?.rootPath ?? null)
    : null;
  const {
    hasGitHubRemote,
    hasOrigin,
    refresh: refreshRemote,
  } = useGithubProjectRemote(projectRootForRemote);
  const publishDefaultName = useMemo(() => {
    const root = project?.rootPath;
    if (!root) return "";
    const segments = root.split(/[\\/]/).filter(Boolean);
    return segments[segments.length - 1] ?? "";
  }, [project?.rootPath]);
  // Hide the Publish CTA when ANY origin remote is configured — including
  // non-GitHub origins, which would cause publishCurrentProject to throw
  // remote_already_exists.
  const showPublishPill =
    workspaceProjectOpen &&
    Boolean(project?.rootPath) &&
    hasGitHubRemote === false &&
    hasOrigin === false;
  const connectedRemoteCount = remoteSnapshot?.connectedCount ?? 0;
  const remoteStatusCount = Math.max(connectedRemoteCount, openRemoteProjectTabs.length);
  const remoteConnected = connectedRemoteCount > 0;
  const syncConnected = isSyncConnected(syncSnapshot);
  const webConnected = isWebSyncConnected(syncSnapshot);
  const showSyncControl = projectHydrated === true;
  const syncStatusTargetKey =
    remoteBinding?.key ?? project?.rootPath ?? "machine";
  const syncStatusTargetRef = useRef(syncStatusTargetKey);

  useEffect(() => {
    openProjectTabRootsRef.current = openProjectTabRoots;
  }, [openProjectTabRoots]);

  useEffect(() => {
    // The first paint has an empty tab list. Sending it before the window
    // session is read would replace the tabs the main process restored.
    if (!windowSessionRestored) return;
    window.ade.app.setWindowProjectTabs(openProjectTabRoots).catch(() => {});
  }, [openProjectTabRoots, windowSessionRestored]);

  useEffect(() => {
    if (!windowSessionRestored) return;
    const persistBindings = window.ade.app.setWindowProjectBindings;
    if (!persistBindings) return;
    void persistBindings(openRemoteProjectTabs).catch(() => {});
  }, [openRemoteProjectTabs, windowSessionRestored]);

  useEffect(() => {
    openRemoteProjectTabsRef.current = openRemoteProjectTabs;
  }, [openRemoteProjectTabs]);

  // Route native View-menu (and keyboard) zoom through the shared zoom store,
  // the same path the settings sidebar's zoom buttons use, so the display %,
  // persistence, and the traffic-light inset stay in sync. The bar has no zoom
  // buttons of its own; it listens here because it is always mounted.
  useEffect(() => {
    const onCommand = window.ade?.zoom?.onCommand;
    if (typeof onCommand !== "function") return;
    return onCommand((command) => {
      // Electron consumes CmdOrCtrl+=/−/0 as menu accelerators before any
      // renderer keydown, so a surface that wants those chords for its own
      // content — the built-in browser's page zoom — has to be offered the
      // command here. It declines unless it actually has focus.
      if (consumeAppZoomCommand(command)) return;
      if (command === "in") zoomAppIn();
      else if (command === "out") zoomAppOut();
      else resetAppZoom();
    });
  }, []);

  /**
   * ⌘F and ⌘W, offered to the pane that has the keyboard before the app
   * answers them.
   *
   * Both are native menu accelerators, so a renderer keydown binding never sees
   * them on the packaged app — and the built-in browser's page is a different
   * WebContents, so when you are clicked into a page this renderer gets no key
   * event at all. Whatever claims the command handles it; ⌘W otherwise means
   * what it always meant, which is the ordinary window close WITH its prompt.
   */
  useEffect(() => {
    const onMenuCommand = window.ade?.app?.onMenuCommand;
    if (typeof onMenuCommand !== "function") return;
    return onMenuCommand((command) => {
      if (consumeAppMenuCommand(command)) return;
      if (command === "close-tab") {
        void window.ade?.app?.requestWindowClose?.().catch(() => {});
        return;
      }
      /*
        Unclaimed ⌘F. There is no app-wide find, so the last thing worth trying
        is the surface that actually has the keyboard: replay the chord as a
        keydown on the focused element, which is the path any panel with a
        local `onKeyDown` find binding already listens on. The event is
        untrusted, so it can trigger no browser default — if nothing handles
        it, this is a no-op, which is the correct outcome for a screen with
        nothing to find in.
      */
      const target = document.activeElement;
      if (!(target instanceof HTMLElement) || !target.isConnected) return;
      target.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "f",
          code: "KeyF",
          metaKey: isMac,
          ctrlKey: !isMac,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
  }, []);

  const fetchRecent = useCallback((options?: { force?: boolean }) => {
    listRecentProjectsCached(options)
      .then((rows) => setRecentProjects(rows))
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchRecent({ force: true });
  }, [project?.rootPath, fetchRecent]);

  useEffect(() => {
    const rootPath = project?.rootPath ?? null;
    if (!rootPath) {
      // Do NOT wipe the tab list here. `project` goes briefly null on every
      // remote bind/unbind: `bindWindowToRemoteProject` emits
      // projectChanged(null) and projectBindingChanged(remote) as two separate
      // IPC messages, so the renderer momentarily sees
      // project==null && !remoteBinding && showWelcome==true even though the
      // window is just switching to a remote project — and wiping here would
      // delete every local tab (any path). A genuine close already clears the
      // list authoritatively in closeProject() (appStore), so this effect only
      // needs to ADD the current local root, never remove.
      return;
    }
    if (remoteBinding) {
      return;
    }
    // Skip while a transition targeting a *different* root is in flight.
    // During switch/close, `project` briefly points at the OLD root before
    // the await resolves; re-adding it here would resurrect a tab the user
    // just removed via handleRemoveTab.
    if (projectTransition != null && projectTransition.rootPath !== rootPath) {
      return;
    }
    setOpenProjectTabRoots((prev) =>
      prev.includes(rootPath) ? prev : [...prev, rootPath],
    );
  }, [project?.rootPath, remoteBinding, projectTransition]);

  useEffect(() => {
    if (!remoteBinding) return;
    setOpenProjectTabRoots((prev) =>
      useAppStore.getState().projectInfoByRoot[remoteBinding.rootPath]
        ? prev
        : prev.filter((rootPath) => rootPath !== remoteBinding.rootPath),
    );
    setOpenRemoteProjectTabs((prev) => {
      const existingIndex = prev.findIndex(
        (entry) => entry.key === remoteBinding.key,
      );
      if (existingIndex === -1) return [...prev, remoteBinding];
      const next = [...prev];
      next[existingIndex] = remoteBinding;
      return next;
    });
  }, [remoteBinding]);

  useEffect(() => {
    if (project || remoteBinding) return;
    // Same guard as above: only wipe remote tabs on a true close, not while a
    // transition is in flight or before the welcome screen is shown.
    if (projectTransition != null || showWelcome !== true) return;
    setOpenRemoteProjectTabs([]);
  }, [project, remoteBinding, projectTransition, showWelcome]);

  const projectTabs = useMemo<RecentProjectSummary[]>(
    () =>
      openProjectTabRoots.map((rootPath) => {
        const recent = localRecentProjects.find(
          (entry) => entry.rootPath === rootPath,
        );
        if (recent) return recent;
        return {
          rootPath,
          displayName:
            project?.rootPath === rootPath
              ? (project.displayName ?? fallbackProjectName(rootPath))
              : fallbackProjectName(rootPath),
          exists: true,
          lastOpenedAt: "",
        };
      }),
    [localRecentProjects, openProjectTabRoots, project],
  );

  const remoteConnectionState = useCallback(
    (targetId: string): RemoteRuntimeConnectionState =>
      remoteSnapshot?.connections.find((entry) => entry.target.id === targetId)
        ?.state ?? "idle",
    [remoteSnapshot],
  );

  // The join key for the remote side of a repo group. It comes straight from
  // the connection snapshot the renderer already holds — no extra IPC, no poll.
  const remoteOriginByKey = useMemo(() => {
    const byKey: Record<string, string | null> = {};
    for (const tab of openRemoteProjectTabs) {
      const connection =
        remoteSnapshot?.connections.find(
          (entry) => entry.target.id === tab.targetId,
        ) ?? null;
      byKey[tab.key] =
        connection?.projects.find((entry) => entry.projectId === tab.projectId)
          ?.gitOriginUrl ?? tab.gitOriginUrl ?? null;
    }
    return byKey;
  }, [openRemoteProjectTabs, remoteSnapshot]);

  const activeTabBindingKey = remoteBinding?.key ?? project?.rootPath ?? null;
  const knownRemoteProjectTabs = useMemo<RemoteOpenProjectBinding[]>(() => {
    const byKey = new Map<string, RemoteOpenProjectBinding>();
    const add = (binding: RemoteOpenProjectBinding) => {
      byKey.set(binding.key, binding);
    };
    for (const recent of recentProjects) {
      const binding = remoteBindingFromRecent(recent);
      if (binding) add(binding);
    }
    for (const connection of remoteSnapshot?.connections ?? []) {
      for (const remoteProject of connection.projects ?? []) {
        add({
          kind: "remote",
          key: remoteProjectBindingKey(connection.target.id, remoteProject.projectId),
          targetId: connection.target.id,
          runtimeName: connection.target.name,
          hostname: connection.target.hostname,
          projectId: remoteProject.projectId,
          rootPath: remoteProject.rootPath,
          displayName: remoteProject.displayName,
          gitOriginUrl: remoteProject.gitOriginUrl,
          iconDataUrl: remoteProject.icon?.dataUrl ?? null,
        });
      }
    }
    return [...byKey.values()];
  }, [recentProjects, remoteSnapshot]);

  // One tab per repository. Local and remote checkouts of the same repo collapse
  // into a single group. The tab is the repo: its machines are not picked here,
  // every tab shows all of them (see docs/plans/unified-machines.md).
  const tabGroups = useMemo(
    () =>
      groupProjectTabs({
        localTabs: projectTabs,
        remoteTabs: openRemoteProjectTabs,
        knownLocalTabs: localRecentProjects,
        knownRemoteTabs: knownRemoteProjectTabs,
        remoteOriginByKey,
        activeBindingKey: activeTabBindingKey,
        preferredBindingKeyByGroup,
        order: tabOrder,
      }),
    [
      activeTabBindingKey,
      knownRemoteProjectTabs,
      localRecentProjects,
      openRemoteProjectTabs,
      preferredBindingKeyByGroup,
      projectTabs,
      remoteOriginByKey,
      tabOrder,
    ],
  );

  useEffect(() => {
    tabGroupsRef.current = tabGroups;
  }, [tabGroups]);

  useEffect(() => {
    remoteSnapshotRef.current = remoteSnapshot;
  }, [remoteSnapshot]);

  useEffect(() => {
    if (!activeTabBindingKey) return;
    const activeGroup = tabGroups.find((group) =>
      group.machines.some((machine) => machine.bindingKey === activeTabBindingKey));
    if (!activeGroup) return;
    setPreferredBindingKeyByGroup((current) =>
      current[activeGroup.id] === activeTabBindingKey
        ? current
        : { ...current, [activeGroup.id]: activeTabBindingKey });
  }, [activeTabBindingKey, tabGroups]);

  // A tab runs on this computer's checkout whenever this computer has the
  // repo. When the active tab is on another machine's copy of a repo that is
  // also here, it moves back here in place: same tab position, no second tab.
  // Other machines' lanes and chats stay reachable from Lanes and Work, which
  // list every machine. The Chats page is the one surface that picks a
  // machine on purpose, so it is left alone.
  const localFallbackAttemptRef = useRef<string | null>(null);
  useEffect(() => {
    if (webMode || !windowSessionRestored || personalChatsRouteActive) return;
    if (!remoteBinding || isProjectBusy) return;
    if (localFallbackAttemptRef.current === remoteBinding.key) return;
    const rootPath = localCheckoutForRemote({
      remoteOrigin: remoteOriginByKey[remoteBinding.key] ?? remoteBinding.gitOriginUrl ?? null,
      openLocalTabs: projectTabs,
      knownLocalTabs: localRecentProjects,
    });
    if (!rootPath) return;
    // One attempt per binding: a checkout that fails to open must not loop.
    localFallbackAttemptRef.current = remoteBinding.key;
    const remoteKey = remoteBinding.key;
    void switchProjectToPath(rootPath)
      .then(() => {
        setOpenRemoteProjectTabs((prev) => prev.filter((entry) => entry.key !== remoteKey));
        setTabOrder((prev) => {
          if (!prev.includes(remoteKey)) return prev;
          const without = prev.filter((key) => key !== rootPath);
          return without.map((key) => (key === remoteKey ? rootPath : key));
        });
      })
      .catch(() => {});
  }, [
    isProjectBusy,
    localRecentProjects,
    personalChatsRouteActive,
    projectTabs,
    remoteBinding,
    remoteOriginByKey,
    setOpenRemoteProjectTabs,
    switchProjectToPath,
    webMode,
    windowSessionRestored,
  ]);

  useEffect(() => {
    let cancelled = false;
    window.ade.app
      .getWindowSession()
      .then((session) => {
        if (cancelled) return;
        setWindowId(session.windowId);
        if (session.openProjectBindings?.length) {
          const restoredRemoteBindings = session.openProjectBindings.filter(
            (entry): entry is RemoteOpenProjectBinding => entry.kind === "remote",
          );
          if (restoredRemoteBindings.length > 0) {
            setOpenRemoteProjectTabs((current) => {
              const byKey = new Map(current.map((entry) => [entry.key, entry]));
              for (const entry of restoredRemoteBindings) byKey.set(entry.key, entry);
              return [...byKey.values()];
            });
          }
        }
        // Every local tab root the window had, loaded or not. A project whose
        // context was released while idle still has its tab; dropping it here
        // is what left a remote-bound window with only the other machine's tab.
        const restoredRoots = [
          ...session.openProjectTabs.map((entry) => entry.rootPath),
          ...(session.openProjectTabRoots ?? []),
        ].filter((root, index, all) => all.indexOf(root) === index);
        if (restoredRoots.length > 0) {
          for (const tabProject of session.openProjectTabs) {
            useAppStore.getState().rememberProjectInfo(tabProject);
          }
          // Merge, don't replace: keep any extra local roots the renderer
          // already knows about after the restored ones.
          const restored = restoredRoots;
          setOpenProjectTabRoots((prev) => {
            const merged = [...restored];
            for (const root of prev) {
              if (!merged.includes(root)) merged.push(root);
            }
            return merged;
          });
        } else if (!session.binding && !session.project) {
          // Only wipe on a genuinely empty session. A remote-bound window with
          // an empty snapshot must NOT clear local tabs — that's the reload
          // variant of the disappearing-tab bug.
          setOpenProjectTabRoots([]);
        }
        setWindowSessionRestored(true);
      })
      .catch(() => {
        if (!cancelled) {
          setWindowId(null);
          setWindowSessionRestored(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [setOpenProjectTabRoots]);

  useEffect(() => {
    const remoteRuntime = window.ade.remoteRuntime;
    if (!remoteRuntime?.getConnectionSnapshot) return;
    let cancelled = false;
    void remoteRuntime
      .getConnectionSnapshot()
      .then((snapshot) => {
        if (!cancelled) applyRemoteSnapshot(snapshot);
      })
      .catch(() => {});
    const unsubscribe =
      remoteRuntime.onConnectionSnapshotChanged?.((snapshot) => {
        if (!cancelled) applyRemoteSnapshot(snapshot);
      }) ?? (() => {});
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [applyRemoteSnapshot]);

  useEffect(() => {
    if (!chromePanelOccludesNativeBrowser || typeof window === "undefined") return undefined;
    window.dispatchEvent(new Event(ADE_BROWSER_VIEW_OCCLUSION_START_EVENT));
    return () => {
      window.dispatchEvent(new Event(ADE_BROWSER_VIEW_OCCLUSION_END_EVENT));
    };
  }, [chromePanelOccludesNativeBrowser]);

  // Re-fetch when app regains focus (catches external deletions).
  useEffect(() => {
    const onFocus = () => fetchRecent();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [fetchRecent]);

  // Re-fetch when the main process reports a missing project.
  useEffect(() => {
    const unsub = window.ade.project.onMissing(() => fetchRecent({ force: true }));
    return unsub;
  }, [fetchRecent]);

  useEffect(() => {
    let cancelled = false;
    let statusRequestVersion = 0;
    let started = false;
    let startupTimer: number | null = null;
    let disposeSyncEvents: (() => void) | null = null;
    if (!showSyncControl) {
      setSyncSnapshot(null);
      setConnectionsOpen(false);
      return () => {
        cancelled = true;
      };
    }
    const refreshSyncStatus = () => {
      const requestVersion = ++statusRequestVersion;
      void window.ade.sync
        .getStatus({ includeTransferReadiness: false })
        .then((snapshot) => {
          if (!cancelled && requestVersion === statusRequestVersion)
            setSyncSnapshot(snapshot);
        })
        .catch(() => {
          if (!cancelled && requestVersion === statusRequestVersion)
            setSyncSnapshot(null);
        });
    };
    if (syncStatusTargetRef.current !== syncStatusTargetKey) {
      syncStatusTargetRef.current = syncStatusTargetKey;
      setSyncSnapshot(null);
    }
    const startSyncStatus = () => {
      if (cancelled || started) return;
      started = true;
      refreshSyncStatus();
      disposeSyncEvents = window.ade.sync.onEvent((event) => {
        if (!cancelled && event.type === "sync-status") {
          statusRequestVersion += 1;
          setSyncSnapshot(event.snapshot);
        }
      });
    };
    const onFocus = () => {
      if (started) {
        refreshSyncStatus();
      } else {
        startSyncStatus();
      }
    };
    startupTimer = window.setTimeout(
      startSyncStatus,
      connectionsOpen ? 0 : PHONE_SYNC_STARTUP_DELAY_MS,
    );
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      if (startupTimer != null) window.clearTimeout(startupTimer);
      window.removeEventListener("focus", onFocus);
      disposeSyncEvents?.();
    };
    // Background projects don't broadcast sync-status events (main.ts filters
    // them to the active project), so we re-run this effect when the routed
    // runtime target changes and let the delayed startup check pick up the
    // current state. With no project open, sync calls fall back to the
    // machine-level brain service. Focus and explicit drawer opens still
    // refresh immediately.
  }, [connectionsOpen, showSyncControl, syncStatusTargetKey]);

  // Let other surfaces (e.g. the Account page) open the Connections panel to a
  // specific tab.
  useEffect(() => {
    if (webMode) return;
    return subscribeOpenConnectionsPanel((tab) => {
      openConnections(tab);
    });
  }, [openConnections, webMode]);

  const checkForActiveWorkloads = useCallback(
    async (projectRootPath: string): Promise<boolean> => {
      if (project?.rootPath !== projectRootPath) return true;

      try {
        const [runningSessions, agentChats] =
          await Promise.all([
            window.ade.sessions.list({ status: "running" }),
            window.ade.agentChat.list(),
          ]);

        const activeSessionCount = runningSessions.filter(
          (session) => session.status === "running",
        ).length;
        const activeChatCount = agentChats.filter(
          (chat) => chat.status === "active",
        ).length;

        const warnings: string[] = [];
        if (activeSessionCount > 0) {
          warnings.push(
            `${activeSessionCount} running terminal session${activeSessionCount === 1 ? "" : "s"}`,
          );
        }
        if (activeChatCount > 0) {
          warnings.push(
            `${activeChatCount} active chat${activeChatCount === 1 ? "" : "s"}`,
          );
        }
        if (warnings.length === 0) return true;

        const message = [
          "The following active work items will be terminated:",
          ...warnings.map((line) => `- ${line}`),
          "",
          "Do you want to continue?",
        ].join("\n");

        return await confirmDialog({
          title: "You are about to close this project.",
          message,
          confirmLabel: "Continue",
          destructive: true,
        });
      } catch {
        return true;
      }
    },
    [project?.rootPath],
  );

  const handleOpenNew = useCallback(() => {
    if (isProjectBusy) return;
    openNewTab();
    if (personalChatsRouteActive || accountRouteActive || hubRouteActive) onNavigate?.("/work");
  }, [accountRouteActive, hubRouteActive, isProjectBusy, onNavigate, openNewTab, personalChatsRouteActive]);
  // The batch launcher's model picker needs a way out of its empty Harnesses
  // tab. It routes through the same `onNavigate` the shell supplies, so a top
  // bar rendered without a router (tests) simply has no CTA.
  const openHarnessSettings = useMemo(
    () => (onNavigate ? () => onNavigate(settingsRouteFor("agents.harnesses")) : undefined),
    [onNavigate],
  );

  const handleOpenNewWindow = useCallback(() => {
    if (isProjectBusy) return;
    window.ade.app.newWindow().catch(() => {});
  }, [isProjectBusy]);

  // Activity is account-wide, so it never depends on a project being open — and
  // it is a modal, not a tab, so opening it flips shell state instead of
  // navigating. The `/activity` pathname still works as a deep link; the shell
  // turns it back into this same flip.
  const handleOpenActivityPane = useCallback(() => {
    if (onOpenActivityPane) onOpenActivityPane();
    else onNavigate?.("/activity");
  }, [onNavigate, onOpenActivityPane]);

  // Clicking a project tab while either the personal-chats or account machine
  // route is foreground must leave it, or ProjectTabHost's route replay never
  // surfaces the project. Navigate to the CURRENT binding's stored route so the
  // route-cache effect writes that same value back instead of stamping /work
  // over the project's remembered position.
  const leaveMachineRoute = useCallback(() => {
    if (!personalChatsRouteActive && !accountRouteActive && !hubRouteActive) return;
    const currentBindingKey = remoteBinding
      ? remoteBinding.key
      : project?.rootPath
        ? `local:${project.rootPath}`
        : null;
    const route = (currentBindingKey ? readStoredProjectRoute(currentBindingKey) : null) ?? "/work";
    onNavigate?.(route, { replace: true });
  }, [accountRouteActive, hubRouteActive, onNavigate, personalChatsRouteActive, project?.rootPath, remoteBinding]);

  // Resolves when the switch has settled, so a caller that has to reconcile tab
  // state afterwards runs against the new binding rather than racing the
  // in-flight transition.
  const handleSwitchProject = useCallback(
    (rootPath: string, opts?: { skipWorktreeGate?: boolean }): Promise<void> => {
      if (isProjectBusy) return Promise.resolve();
      leaveMachineRoute();
      if (!remoteBinding && project?.rootPath === rootPath) {
        cancelNewTab();
        return Promise.resolve();
      }
      // Called without the options argument at all when there is nothing to
      // pass, so the store action keeps its single-argument call shape.
      const switching = opts
        ? switchProjectToPath(rootPath, opts)
        : switchProjectToPath(rootPath);
      return switching.then(() => {}).catch(() => {});
    },
    [
      cancelNewTab,
      isProjectBusy,
      leaveMachineRoute,
      project?.rootPath,
      remoteBinding,
      switchProjectToPath,
    ],
  );

  const handleSwitchRemoteProject = useCallback(
    (binding: RemoteOpenProjectBinding): Promise<void> => {
      if (isProjectBusy) return Promise.resolve();
      leaveMachineRoute();
      if (remoteBinding?.key === binding.key && !hubRouteActive) {
        cancelNewTab();
        return Promise.resolve();
      }
      return switchRemoteProject(binding.targetId, binding.projectId).then(() => {}).catch(() => {});
    },
    [
      cancelNewTab,
      hubRouteActive,
      isProjectBusy,
      leaveMachineRoute,
      remoteBinding?.key,
      switchRemoteProject,
    ],
  );

  const {
    closeTabGroups,
    handleRemoveTab,
    handleCloseRemoteTab,
    handleClonedLocally,
    handleMoveTabToNewWindow,
    tabStripRef,
    projectTabDrag,
  } = useProjectTabLifecycle({
    tabGroupsRef,
    openProjectTabRootsRef,
    openRemoteProjectTabsRef,
    setTabOrder,
    checkForActiveWorkloads,
    isProjectBusy,
  });

  const confirmAndCloseRemoteTargetTabs = useCallback(
    async (
      target: RemoteRuntimeTarget,
      action: "disconnect" | "remove",
    ): Promise<boolean> => {
      const latestRemoteTabs = openRemoteProjectTabsRef.current;
      const affectedTabs = latestRemoteTabs.filter(
        (entry) => entry.targetId === target.id,
      );
      const targetName = target.name || target.hostname;
      const affectedCount = affectedTabs.length;
      // A project is not closed by removing one machine: it moves to another
      // checkout of the same repo when one exists (see
      // resolveProjectTabFallback). Only a repo that lives nowhere else closes.
      const connectedTargetIds = new Set(
        (remoteSnapshotRef.current?.connections ?? [])
          .filter((connection) => connection.state === "connected")
          .map((connection) => connection.target.id),
      );
      const openRemoteBindingKeys = openRemoteProjectTabsRef.current.map(
        (entry) => entry.key,
      );
      const plans = affectedTabs.map((tab) => ({
        tab,
        fallback: resolveProjectTabFallback({
          bindingKey: tab.key,
          groups: tabGroupsRef.current,
          openLocalRoots: openProjectTabRootsRef.current,
          openRemoteBindingKeys,
          connectedTargetIds,
          excludeTargetId: target.id,
        }),
      }));
      const stayingTabs = plans.filter((plan) => plan.fallback);
      const closingTabs = plans.filter((plan) => !plan.fallback);
      const reconnectCopy = action === "remove"
        ? "Add the machine again to reconnect."
        : "ADE will not reconnect to this machine until you connect again.";
      const message = (() => {
        if (affectedCount === 0) {
          return action === "remove"
            ? "Removing this machine will delete its saved SSH details."
            : "Disconnecting will stop this remote connection. ADE will not reconnect to this machine until you connect again.";
        }
        const lines: string[] = [];
        if (stayingTabs.length > 0) {
          const plural = stayingTabs.length === 1 ? "" : "s";
          lines.push(
            `${stayingTabs.length} open project tab${plural} also exist${stayingTabs.length === 1 ? "s" : ""} elsewhere:`,
            stayingTabs.map((plan) => `- ${plan.tab.displayName}`).join("\n"),
            "",
            `${stayingTabs.length === 1 ? "It stays" : "They stay"} open. ${action === "remove" ? "Removing" : "Disconnecting"} ${targetName} only removes its work from inside ${stayingTabs.length === 1 ? "it" : "them"}.`,
          );
        }
        if (closingTabs.length > 0) {
          if (lines.length > 0) lines.push("");
          lines.push(
            `${closingTabs.length} open project tab${closingTabs.length === 1 ? "" : "s"} exist only on ${targetName} and will close:`,
            closingTabs.map((plan) => `- ${plan.tab.displayName}`).join("\n"),
          );
        }
        lines.push("", reconnectCopy);
        return lines.join("\n");
      })();

      const confirmed = await confirmDialog({
        title: action === "remove"
          ? `Remove ${targetName}?`
          : `Disconnect ${targetName}?`,
        message,
        confirmLabel: action === "remove" ? "REMOVE" : "DISCONNECT",
        destructive: true,
      });
      if (!confirmed) return false;
      if (affectedTabs.length === 0) return true;

      const affectedKeys = new Set(affectedTabs.map((entry) => entry.key));
      const fallbackRemoteBindings = stayingTabs
        .map((plan) =>
          plan.fallback?.kind === "remote" ? plan.fallback.binding : null,
        )
        .filter(
          (binding): binding is RemoteOpenProjectBinding =>
            binding !== null && !affectedKeys.has(binding.key),
        );
      const fallbackLocalRoots = stayingTabs
        .map((plan) =>
          plan.fallback?.kind === "local" ? plan.fallback.rootPath : null,
        )
        .filter((rootPath): rootPath is string => rootPath !== null);
      const nextRemoteTabs = (() => {
        const byKey = new Map<string, RemoteOpenProjectBinding>();
        for (const entry of latestRemoteTabs) {
          if (!affectedKeys.has(entry.key)) byKey.set(entry.key, entry);
        }
        // Keep a surviving repo tab alive by opening the checkout it falls back
        // to. A fallback that is already open is a no-op here.
        for (const binding of fallbackRemoteBindings) {
          byKey.set(binding.key, binding);
        }
        return [...byKey.values()];
      })();
      // A disconnect is temporary: the machine can come back, so keep the view
      // state (which chat/tile was open) and the remembered route, and only drop
      // the data snapshots that could be stale against a remote that changed
      // while it was unreachable. Removing a machine deletes its saved details,
      // so that stays a full eviction — as does an explicit tab close.
      const evictForAction = (bindingKey: string) => {
        if (action === "remove") {
          useAppStore.getState().evictProjectState(bindingKey);
          removeStoredProjectRoute(bindingKey);
          return;
        }
        useAppStore.getState().evictProjectDataCaches(bindingKey);
      };
      const finishAffectedTabClose = () => {
        openRemoteProjectTabsRef.current = nextRemoteTabs;
        setOpenRemoteProjectTabs(nextRemoteTabs);
        if (fallbackLocalRoots.length > 0) {
          setOpenProjectTabRoots((prev) => {
            const next = [...prev];
            for (const rootPath of fallbackLocalRoots) {
              if (!next.includes(rootPath)) next.push(rootPath);
            }
            return next;
          });
        }
        for (const binding of affectedTabs) {
          evictForAction(binding.key);
        }
      };

      const latestState = useAppStore.getState();
      const latestRemoteBinding =
        latestState.projectBinding?.kind === "remote"
          ? latestState.projectBinding
          : null;
      if (!latestRemoteBinding || !affectedKeys.has(latestRemoteBinding.key)) {
        finishAffectedTabClose();
        return true;
      }

      // The active project is one of the tabs losing its machine. Move it to
      // another checkout of the same repo before the binding goes away; only
      // when the repo lives nowhere else do we fall back to another tab, and
      // finally close.
      const activePlan =
        plans.find((plan) => plan.tab.key === latestRemoteBinding.key) ?? null;
      try {
        if (activePlan?.fallback?.kind === "local") {
          await latestState.switchProjectToPath(activePlan.fallback.rootPath);
        } else if (activePlan?.fallback?.kind === "remote") {
          await latestState.switchRemoteProject(
            activePlan.fallback.binding.targetId,
            activePlan.fallback.binding.projectId,
          );
        } else {
          const nextRemoteTab = nextRemoteTabs[0] ?? null;
          if (nextRemoteTab) {
            await latestState.switchRemoteProject(
              nextRemoteTab.targetId,
              nextRemoteTab.projectId,
            );
          } else {
            const nextLocalRoot =
              openProjectTabRootsRef.current[
                openProjectTabRootsRef.current.length - 1
              ] ?? null;
            if (nextLocalRoot) {
              await latestState.switchProjectToPath(nextLocalRoot);
            } else {
              // No project tab left to fall back to. A disconnect must still
              // keep the view state (which chat/tile was open) and the route
              // memory so reconnecting lands where the user left off; a remove
              // drops both.
              await latestState.closeProject({
                preserveRemoteViewState: action === "disconnect",
              });
              if (action === "remove") {
                for (const binding of affectedTabs) {
                  removeStoredProjectRoute(binding.key);
                }
              }
              return true;
            }
          }
        }
      } catch {
        return false;
      }
      finishAffectedTabClose();
      return true;
    },
    [
      setOpenProjectTabRoots,
      setOpenRemoteProjectTabs,
    ],
  );

  const handleRemoteTargetDisconnectRequested = useCallback(
    (target: RemoteRuntimeTarget): Promise<boolean> =>
      confirmAndCloseRemoteTargetTabs(target, "disconnect"),
    [confirmAndCloseRemoteTargetTabs],
  );

  const handleRemoteTargetRemoveRequested = useCallback(
    (target: RemoteRuntimeTarget): Promise<boolean> =>
      confirmAndCloseRemoteTargetTabs(target, "remove"),
    [confirmAndCloseRemoteTargetTabs],
  );

  const handleRelocate = useCallback(
    (oldPath: string) => {
      setRelocatingPath(oldPath);
      void (async () => {
        const newProject = await openRepo().catch(() => null);
        if (!newProject) return;
        const nextRows = await window.ade.project
          .forgetRecent(oldPath)
          .catch(() => null);
        if (nextRows) {
          rememberRecentProjects(nextRows);
          setRecentProjects(nextRows);
        }
      })()
        .catch(() => {})
        .finally(() => setRelocatingPath(null));
    },
    [openRepo],
  );

  const [tabMenu, setTabMenu] = useState<(NonNullable<ContextMenuState> & { groupId: string }) | null>(null);
  const closeTabMenu = useCallback(() => setTabMenu(null), []);
  const [iconDialogTarget, setIconDialogTarget] = useState<ProjectIconDialogTarget | null>(null);
  const closeIconDialog = useCallback(() => setIconDialogTarget(null), []);
  const [cloneLocallyTarget, setCloneLocallyTarget] = useState<CloneLocallyTarget | null>(null);

  /** The host's latest icon per project, so a changed icon shows at once. */
  const hostIconByKey = useMemo(() => {
    const byKey = new Map<string, string | null>();
    for (const binding of knownRemoteProjectTabs) byKey.set(binding.key, binding.iconDataUrl ?? null);
    return byKey;
  }, [knownRemoteProjectTabs]);

  const cloneTargetForGroup = useCallback(
    (group: ProjectTabGroup): CloneLocallyTarget | null => {
      const binding = group.machines[0]?.binding;
      return cloneTargetFor({
        binding,
        hasLocalCheckout: group.machines.some((machine) => machine.isLocal),
        gitOriginUrl: binding?.kind === "remote"
          ? (remoteOriginByKey[binding.key] ?? binding.gitOriginUrl)
          : null,
      });
    },
    [remoteOriginByKey],
  );

  const activeCloneTarget = useMemo(() => {
    if (!remoteBinding) return null;
    const group = tabGroups.find((entry) =>
      entry.machines.some((machine) => machine.bindingKey === remoteBinding.key),
    );
    return group ? cloneTargetForGroup(group) : null;
  }, [cloneTargetForGroup, remoteBinding, tabGroups]);

  const recentForMachine = useCallback(
    (machine: ProjectTabMachine): RecentProjectSummary | null => {
      const binding = machine.binding;
      if (binding?.kind === "remote") {
        return recentProjects.find(
          (entry) =>
            entry.kind === "remote"
            && entry.remote?.targetId === binding.targetId
            && entry.remote?.projectId === binding.projectId,
        ) ?? null;
      }
      return recentProjects.find(
        (entry) => entry.kind !== "remote" && entry.rootPath === machine.rootPath,
      ) ?? null;
    },
    [recentProjects],
  );

  const tabMenuEntries = useMemo((): ContextMenuEntry[] => {
    if (!tabMenu) return [];
    const index = tabGroups.findIndex((group) => group.id === tabMenu.groupId);
    const group = index === -1 ? null : tabGroups[index]!;
    const machine = group ? activeMachineForGroup(group) : null;
    if (!group || !machine) return [];
    const binding = machine.binding ?? null;
    const recent = recentForMachine(machine);
    const sections = projectMenuSections(
      {
        rootPath: machine.rootPath,
        displayName: machine.displayName,
        binding,
        available: !(machine.isLocal && !machine.exists),
        pinned: recent ? Boolean(recent.pinned) : null,
        hostIconDataUrl: binding?.kind === "remote" ? (hostIconByKey.get(binding.key) ?? null) : null,
        cloneTarget: cloneTargetForGroup(group),
      },
      { webMode },
      {
        onChangeIcon: setIconDialogTarget,
        onClone: setCloneLocallyTarget,
        onTogglePin: () => {
          if (!recent) return;
          void window.ade.project
            .setRecentPinned(recentProjectLocationKey(recent), !recent.pinned)
            .then((rows) => {
              rememberRecentProjects(rows);
              setRecentProjects(rows);
            })
            .catch(() => {});
        },
      },
    );
    const otherIds = tabGroups.filter((entry) => entry.id !== group.id).map((entry) => entry.id);
    const rightIds = tabGroups.slice(index + 1).map((entry) => entry.id);
    // Closing a tab on this machine asks first and checks for running work;
    // a project on another machine keeps running there, so it closes at once.
    const closeOptions = machine.isLocal
      ? { confirm: true, checkWorkloads: true, forgetState: true }
      : { confirm: false, checkWorkloads: false, forgetState: true };
    const closeMany = (ids: string[]) =>
      void closeTabGroups(ids, { confirm: true, checkWorkloads: true, forgetState: true });
    const entries: Array<ContextMenuEntry | null> = [
      !webMode && tabGroups.length > 1
        ? {
            kind: "item",
            key: "new-window",
            label: "Move to new window",
            icon: AppWindow,
            disabled: isProjectBusy,
            onSelect: () => handleMoveTabToNewWindow(group),
          }
        : null,
      ...sections.open,
      { kind: "separator", key: "sep-project" },
      ...sections.project,
      { kind: "separator", key: "sep-copy" },
      ...sections.copy,
      {
        kind: "item",
        key: "copy-name",
        label: "Copy name",
        icon: TextT,
        onSelect: () => void window.ade.app.writeClipboardText(machine.displayName).catch(() => {}),
      },
      { kind: "separator", key: "sep-close" },
      {
        kind: "item",
        key: "close",
        label: "Close tab",
        icon: X,
        disabled: isProjectBusy,
        onSelect: () => void closeTabGroups([group.id], closeOptions),
      },
      otherIds.length > 0
        ? {
            kind: "item",
            key: "close-others",
            label: "Close other tabs",
            icon: XSquare,
            disabled: isProjectBusy,
            onSelect: () => closeMany(otherIds),
          }
        : null,
      rightIds.length > 0
        ? {
            kind: "item",
            key: "close-right",
            label: "Close tabs to the right",
            icon: ArrowLineRight,
            disabled: isProjectBusy,
            onSelect: () => closeMany(rightIds),
          }
        : null,
    ];
    return entries.filter((entry): entry is ContextMenuEntry => entry != null);
  }, [
    closeTabGroups,
    cloneTargetForGroup,
    handleMoveTabToNewWindow,
    hostIconByKey,
    isProjectBusy,
    recentForMachine,
    tabGroups,
    tabMenu,
    webMode,
  ]);

  const openTabMenu = useCallback((event: React.MouseEvent, groupId: string) => {
    event.preventDefault();
    event.stopPropagation();
    setTabMenu({ x: event.clientX, y: event.clientY, groupId });
  }, []);

  const handleProjectAccentColorChange = useCallback(
    (rootPath: string, color: string | null) => {
      setProjectAccentColors((prev) => {
        if ((prev[rootPath] ?? null) === color) return prev;
        return { ...prev, [rootPath]: color };
      });
    },
    [],
  );

  const anyConnectionActive = remoteConnected || syncConnected || webConnected;

  const renderDesktopIntegrationControls = () => (
    <>
      <CloudAgentsQuickViewButton provider="devin" showTrigger={projectSurfaceVisible} />
      <CloudAgentsQuickViewButton provider="cursor" showTrigger={projectSurfaceVisible} />
      <LinearQuickViewButton
        onOpenHarnessSettings={openHarnessSettings}
        showTrigger={projectSurfaceVisible}
      />
    </>
  );

  const renderDesktopUsageControl = () => usageHeaderPreferences.showInHeader
    ? <HeaderUsageControl deferInitialRead={Boolean(remoteBinding)} />
    : null;

  const renderWebConnectionsControl = () => (
    <React.Suspense fallback={null}>
      <WebConnectionsChip />
    </React.Suspense>
  );

  const renderDesktopConnectionsControl = () => webMode
    ? renderWebConnectionsControl()
    : (
      <ShellConnectionChip
        label="Connections"
        connected={anyConnectionActive}
        title="Machines, mobile, and web clients"
        ariaExpanded={connectionsOpen}
        onClick={() => (connectionsOpen ? closeConnections() : openConnections("machines"))}
        icon={<Plugs size={12} weight="regular" className="shrink-0 opacity-85" />}
        trailing={<HeaderAccountAvatar />}
      />
    );

  const renderCompactStatusMenu = (onActivate: () => void) => (
    <div className="flex flex-col gap-0.5">
      <CloudAgentsQuickViewButton
        provider="devin"
        variant="menu-row"
        onMenuActivate={onActivate}
        showTrigger={projectSurfaceVisible}
      />
      <CloudAgentsQuickViewButton
        provider="cursor"
        variant="menu-row"
        onMenuActivate={onActivate}
        showTrigger={projectSurfaceVisible}
      />
      <LinearQuickViewButton
        variant="menu-row"
        onMenuActivate={onActivate}
        onOpenHarnessSettings={openHarnessSettings}
        showTrigger={projectSurfaceVisible}
      />
      {usageHeaderPreferences.showInHeader ? (
        <HeaderUsageControl
          variant="menu-row"
          onMenuActivate={onActivate}
          deferInitialRead={Boolean(remoteBinding)}
        />
      ) : null}
      {webMode ? renderWebConnectionsControl() : (
        <ShellConnectionChip
          layout="menu-row"
          label="Connections"
          connected={anyConnectionActive}
          title="Machines, mobile, and web clients"
          ariaExpanded={connectionsOpen}
          onClick={() => {
            openConnections("machines");
            onActivate();
          }}
          icon={<Plugs size={12} weight="regular" className="shrink-0 opacity-85" />}
          trailing={<HeaderAccountAvatar />}
        />
      )}
    </div>
  );

  const transitionTargetName = projectTransition?.rootPath
    ? (projectTabs.find(
        (entry) => entry.rootPath === projectTransition.rootPath,
      )?.displayName ??
      localRecentProjects.find(
        (entry) => entry.rootPath === projectTransition.rootPath,
      )?.displayName ??
      fallbackProjectName(projectTransition.rootPath) ??
      "project")
    : "project";
  let projectTransitionLabel: string | null = null;
  if (projectTransition != null) {
    switch (projectTransition.kind) {
      case "opening":
        projectTransitionLabel = "Opening project…";
        break;
      case "switching":
        projectTransitionLabel = `Switching to ${transitionTargetName}…`;
        break;
      case "closing":
        projectTransitionLabel = "Closing project…";
        break;
    }
  }

  return (
    <header
      className="ade-shell-header relative isolate flex items-center gap-3"
      style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
    >
      {/* The top bar's part of the window gradient. It is one field with the
          welcome screen and the new chat pane, so where they meet there is
          no seam. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
        <WorkToolPickerBackdrop theme={theme} field="window" />
      </div>
      {projectSurfaceVisible ? <ProjectSidebarToggle shortcut={sidebarToggleShortcut} /> : null}

      {/* Branding */}
      <img
        src="./logo.png"
        alt="ADE"
        className="shrink-0 select-none"
        style={{ height: 20 }}
        draggable={false}
      />

      {/* Channel chip — nothing on stable. Sits with the app identity, before
          the project tabs, and opts out of the drag region like every other
          interactive header child. */}
      <ChannelBadge />

      {/* Divider */}
      <div className="ade-shell-header-divider h-3 w-px shrink-0" />

      {/* Project tabs — the container stays draggable, only interactive elements opt out */}
      <div
        ref={tabStripRef}
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto scrollbar-none"
      >
        {tabGroups.length > 0 ||
        isNewTabOpen ||
        isSettingsTabOpen ||
        personalChatsTabOpen ? (
          <>
            {tabGroups.map((group) => {
              const machine = activeMachineForGroup(group);
              if (!machine) return null;
              if (!machine.isLocal) {
                const remoteTab =
                  openRemoteProjectTabs.find(
                    (entry) => entry.key === machine.bindingKey,
                  )
                  ?? (machine.binding?.kind === "remote" ? machine.binding : null);
                if (!remoteTab) return null;
                const isCurrentRemote = remoteBinding?.key === remoteTab.key;
                const remoteTabState = remoteConnectionState(remoteTab.targetId);
                const remoteTabConnected = remoteTabState === "connected";
                const remoteTabConnecting = remoteTabState === "connecting";
                const remoteTabParked = remoteTabState === "parked";
                const remoteTabDisconnected =
                  remoteTabState === "error" || remoteTabState === "idle";
                const remoteTabStatusLabel = remoteTabConnected
                  ? "Connected"
                  : remoteTabConnecting
                    ? "Reconnecting"
                    : remoteTabParked
                      ? "Parked"
                      : "Disconnected";
                const remoteTabKey = tabOrderKey(group);
                return (
                  <div
                    key={group.id}
                    role="button"
                    tabIndex={0}
                    {...{ [PROJECT_TAB_KEY_ATTR]: remoteTabKey }}
                    onPointerDown={(event) => {
                      if (!isProjectBusy) projectTabDrag.onTabPointerDown(event, remoteTabKey);
                    }}
                    onContextMenu={(event) => openTabMenu(event, group.id)}
                    data-state={isCurrentRemote && !personalChatsRouteActive && !hubRouteActive ? "active" : undefined}
                    data-remote-state={remoteTabState}
                    aria-current={isCurrentRemote ? "true" : undefined}
                    // A project tab looks the same wherever its checkout
                    // lives. The machine is in the tooltip; only a connection
                    // problem, which stops the tab from loading, is marked.
                    className={cn(
                      "ade-shell-project-tab group inline-flex w-auto min-w-[104px] max-w-[180px] shrink-0 items-center gap-1.5 px-2.5",
                      "transition-[background-color,color,border-color,box-shadow,opacity] duration-150",
                      "cursor-pointer",
                      isCurrentRemote && "font-semibold",
                    )}
                    style={
                      {
                        WebkitAppRegion: "no-drag",
                        ...projectTabDrag.tabDragStyle(remoteTabKey),
                      } as React.CSSProperties
                    }
                    title={`${remoteTab.runtimeName}: ${remoteTab.rootPath} (${remoteTabStatusLabel})`}
                    onClick={() => {
                      if (projectTabDrag.isDragClick()) return;
                      handleSwitchRemoteProject(remoteTab);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        handleSwitchRemoteProject(remoteTab);
                      }
                    }}
                  >
                    <ProjectTabIcon
                      rootPath={remoteTab.rootPath}
                      isCurrent={isCurrentRemote}
                      animate={false}
                      disabled={false}
                      iconDataUrlOverride={
                        hostIconByKey.get(remoteTab.key) ?? remoteTab.iconDataUrl ?? null
                      }
                    />
                    <span className="min-w-0 flex-1 truncate text-center text-[12px]">
                      {remoteTab.displayName}
                    </span>
                    {remoteTabConnecting ? (
                      <CircleNotch
                        size={11}
                        weight="bold"
                        className="shrink-0 animate-spin text-amber-300"
                        aria-label={`Reconnecting: ${remoteTab.runtimeName}`}
                      />
                    ) : remoteTabDisconnected ? (
                      <WarningCircle
                        size={11}
                        weight="fill"
                        className="shrink-0 text-red-300"
                        aria-label={`Disconnected: ${remoteTab.runtimeName}`}
                      />
                    ) : null}
                    <button
                      type="button"
                      className={cn(
                        "ade-shell-control inline-flex h-4 w-4 shrink-0 items-center justify-center text-current",
                        "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity duration-150",
                      )}
                      data-variant="ghost"
                      disabled={isProjectBusy}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleCloseRemoteTab(remoteTab);
                      }}
                      title="Close remote project"
                    >
                      <X size={13} weight="regular" />
                    </button>
                  </div>
                );
              }

              const idx = projectTabs.findIndex(
                (entry) => entry.rootPath === machine.rootPath,
              );
              const rp = idx === -1 ? null : projectTabs[idx];
              if (!rp) return null;
              const isCurrent =
                !remoteBinding && project?.rootPath === rp.rootPath;
              const isMissing = !rp.exists;
              const isRelocating = relocatingPath === rp.rootPath;
              const isSwitchTarget =
                projectTransition?.kind === "switching" &&
                projectTransition.rootPath === rp.rootPath;
              const isClosingTarget =
                projectTransition?.kind === "closing" && isCurrent;
              const localTabKey = tabOrderKey(group);
              const canDragTab = !isMissing && !isRelocating && !isProjectBusy;
              const projectAccentColor =
                projectAccentColors[rp.rootPath] ?? null;
              const projectTabStyle = {
                WebkitAppRegion: "no-drag",
                ...(projectAccentColor
                  ? { "--project-tab-accent": projectAccentColor }
                  : {}),
              } as React.CSSProperties;
              let projectTabState: string | undefined;
              if (isRelocating) projectTabState = "open";
              else if (isMissing) projectTabState = "missing";
              // While the Chats machine tab is the foreground surface, the
              // bound project tab stays rendered but must not also read active.
              else if (isCurrent && !personalChatsRouteActive && !hubRouteActive) projectTabState = "active";
              const indicator = terminalAttention?.indicator;
              return (
                <div
                  key={group.id}
                  role={isMissing ? undefined : "button"}
                  tabIndex={isMissing ? -1 : 0}
                  data-state={projectTabState}
                  data-tour={
                    isCurrent && workspaceProjectOpen
                      ? "project.activeTab"
                      : undefined
                  }
                  aria-current={isCurrent ? "true" : undefined}
                  aria-disabled={
                    isRelocating || isProjectBusy ? true : undefined
                  }
                  {...{ [PROJECT_TAB_KEY_ATTR]: localTabKey }}
                  onPointerDown={(event) => {
                    if (canDragTab) projectTabDrag.onTabPointerDown(event, localTabKey);
                  }}
                  onContextMenu={(event) => openTabMenu(event, group.id)}
                  className={cn(
                    "ade-shell-project-tab group inline-flex w-auto min-w-[104px] max-w-[180px] shrink-0 items-center gap-1.5 px-2.5",
                    "transition-[background-color,color,border-color,box-shadow,opacity] duration-150",
                    !isMissing && "cursor-pointer",
                    isCurrent && "font-semibold",
                    isRelocating && "pointer-events-none opacity-80",
                    (isSwitchTarget || isClosingTarget) &&
                      "pointer-events-none opacity-80",
                  )}
                  style={{ ...projectTabStyle, ...projectTabDrag.tabDragStyle(localTabKey) }}
                  onClick={() => {
                    if (projectTabDrag.isDragClick()) return;
                    if (!isMissing) handleSwitchProject(rp.rootPath);
                  }}
                  onKeyDown={(event) => {
                    if (isMissing) return;
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      handleSwitchProject(rp.rootPath);
                    }
                  }}
                  title={isMissing ? `Missing: ${rp.rootPath}` : rp.rootPath}
                >
                  <ProjectTabIcon
                    rootPath={rp.rootPath}
                    isCurrent={isCurrent}
                    animate={isSwitchTarget || isClosingTarget}
                    disabled={isMissing}
                    onAccentColorChange={handleProjectAccentColorChange}
                  />
                  {isSwitchTarget || isClosingTarget ? (
                    <CircleNotch
                      size={12}
                      weight="bold"
                      className="shrink-0 animate-spin opacity-80"
                    />
                  ) : null}
                  {isCurrent && indicator != null && indicator !== "none" ? (
                    <span
                      title={
                        indicator === "running-needs-attention"
                          ? `${terminalAttention.needsAttentionCount} running terminal${terminalAttention.needsAttentionCount === 1 ? " needs" : "s need"} input`
                          : `${terminalAttention.runningCount} running terminal${terminalAttention.runningCount === 1 ? "" : "s"}`
                      }
                      className={cn(
                        "ade-status-dot h-1.5 w-1.5 shrink-0",
                        indicator === "running-needs-attention"
                          ? "ade-status-dot-warning"
                          : "ade-status-dot-active",
                      )}
                    />
                  ) : null}
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate text-center",
                      isMissing && "line-through",
                    )}
                  >
                    {rp.displayName}
                  </span>
                  {isMissing ? (
                    <span className="inline-flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity duration-150">
                      <button
                        type="button"
                        className="ade-shell-control inline-flex h-4 w-4 items-center justify-center text-current transition-[background-color,color,border-color,box-shadow] duration-100"
                        data-variant="ghost"
                        data-state={isRelocating ? "open" : undefined}
                        disabled={isRelocating || isProjectBusy}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (isRelocating || isProjectBusy) return;
                          handleRelocate(rp.rootPath);
                        }}
                        title="Relocate project"
                      >
                        <FolderOpen
                          size={13}
                          weight="regular"
                          className={cn(isRelocating && "animate-pulse")}
                        />
                      </button>
                      <button
                        type="button"
                        className="ade-shell-control inline-flex h-4 w-4 items-center justify-center text-current transition-[background-color,color,border-color,box-shadow] duration-100"
                        data-variant="ghost"
                        disabled={isProjectBusy}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (isProjectBusy) return;
                          handleRemoveTab(rp.rootPath);
                        }}
                        title="Remove from list"
                      >
                        <Trash size={13} weight="regular" />
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className={cn(
                        "ade-shell-control inline-flex h-4 w-4 shrink-0 items-center justify-center text-current",
                        "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity duration-150",
                      )}
                      data-variant="ghost"
                      disabled={isProjectBusy}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (isProjectBusy) return;
                        handleRemoveTab(rp.rootPath);
                      }}
                      title="Remove project"
                    >
                      <X size={13} weight="regular" />
                    </button>
                  )}
                </div>
              );
            })}
            {personalChatsTabOpen ? (
              <ShellNavTab
                active={personalChatsRouteActive}
                label="Chats"
                onActivate={() => {
                  if (!personalChatsRouteActive) onNavigate?.("/chats");
                }}
                onClose={() => {
                  closePersonalChatsTab();
                  if (personalChatsRouteActive) {
                    onNavigate?.("/work", { replace: true });
                  }
                }}
                closeTitle="Close chats"
              >
                <ChatCircleDots size={15} weight="duotone" className="shrink-0 text-accent" />
                <span className="min-w-0 flex-1 truncate text-center text-[12px]">Chats</span>
              </ShellNavTab>
            ) : null}
            {isSettingsTabOpen && (
              <ShellNavTab
                active
                label="Settings"
                // Its own content is already in front; activating closes nothing.
                onActivate={() => {}}
                onClose={() => {
                  setStandaloneSettingsOpen(false);
                  onNavigate?.("/work", { replace: true });
                }}
                closeTitle="Close settings"
              >
                <GearSix size={15} weight="duotone" className="shrink-0 text-accent" />
                <span className="min-w-0 flex-1 truncate text-center text-[12px]">Settings</span>
              </ShellNavTab>
            )}
            {isNewTabOpen && (
              <ShellNavTab
                active={!personalChatsRouteActive && !isSettingsTabOpen}
                label="New Tab"
                onActivate={() => {
                  if (personalChatsRouteActive) onNavigate?.("/work");
                }}
                onClose={() => {
                  if (isProjectBusy) return;
                  cancelNewTab();
                  if (!hasProject && personalChatsTabOpen) {
                    onNavigate?.("/chats");
                  }
                }}
                closeTitle="Close new tab"
                closeDisabled={isProjectBusy}
              >
                {projectTransition?.kind === "opening" ? (
                  <CircleNotch
                    size={13}
                    weight="bold"
                    className="animate-spin"
                  />
                ) : (
                  <img
                    src="./logo.png"
                    alt=""
                    style={{ height: 16, width: 34, objectFit: "contain" }}
                    draggable={false}
                  />
                )}
                <span className="min-w-0 flex-1 truncate text-[12px]">
                  {projectTransition?.kind === "opening"
                    ? "Opening…"
                    : "New Tab"}
                </span>
              </ShellNavTab>
            )}
          </>
        ) : null}

        {/* Add project button */}
        <button
          type="button"
          data-tour="project.addProject"
          className={cn(
            "ade-shell-control inline-flex h-5.5 w-5.5 shrink-0 items-center justify-center",
            "transition-[background-color,color,border-color,box-shadow] duration-150",
          )}
          data-variant="ghost"
          onClick={handleOpenNew}
          disabled={isProjectBusy}
          title={
            webMode
              ? "Open another project"
              : remoteStatusCount > 0
              ? `${remoteStatusCount} remote device${remoteStatusCount === 1 ? "" : "s"} available`
              : "Open another project"
          }
          style={
            {
              WebkitAppRegion: "no-drag",
              ...(remoteStatusCount > 0
                ? {
                    color: "#FBBF24",
                    borderColor: "rgba(245,158,11,0.58)",
                    boxShadow:
                      "0 0 0 1px rgba(245,158,11,0.20), 0 0 16px -8px rgba(245,158,11,0.9)",
                  }
                : {}),
            } as React.CSSProperties
          }
        >
          <Plus size={12} weight="regular" />
        </button>
        {!webMode ? (
        <button
          type="button"
          className={cn(
            "ade-shell-control inline-flex h-5.5 w-5.5 shrink-0 items-center justify-center",
            "transition-[background-color,color,border-color,box-shadow] duration-150",
          )}
          data-variant="ghost"
          onClick={handleOpenNewWindow}
          disabled={isProjectBusy}
          title="New window"
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        >
          <ArrowSquareOut size={12} weight="regular" />
        </button>
        ) : null}
      </div>

      {projectTransitionLabel ? (
        <div
          aria-live="polite"
          className={cn(
            "ade-shell-control shrink-0 inline-flex items-center gap-1.5 rounded-md px-2.5 py-1",
            "text-[11px] font-medium",
          )}
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          title={projectTransitionLabel}
        >
          <CircleNotch size={12} weight="bold" className="animate-spin" />
          <span className="max-w-[240px] truncate">{projectTransitionLabel}</span>
        </div>
      ) : null}

      {activeCloneTarget && !isProjectBusy ? (
        <HeaderActionPill
          icon={DownloadSimple}
          label="Clone locally"
          tooltip={{
            label: "Clone locally",
            description: `${activeCloneTarget.displayName} runs on ${activeCloneTarget.machineName}. Clone it to this machine to work on it here too.`,
          }}
          onClick={() => setCloneLocallyTarget(activeCloneTarget)}
        />
      ) : null}

      {showPublishPill ? (
        <HeaderActionPill
          icon={UploadSimple}
          label="Publish"
          ariaLabel="Publish to GitHub"
          tooltip={{
            label: "Publish to GitHub",
            description:
              "Create a GitHub repository for this project and push the current branch.",
          }}
          disabled={isProjectBusy}
          onClick={() => setPublishOpen(true)}
        />
      ) : null}

      {/* Trailing controls follow the user's visual priority: update and
          diagnostics first, then provider controls, activity, and connections.
          The group must be able to shrink: the header reserves room for the
          native window controls (macOS traffic lights at the start, Windows
          caption buttons at the end) with padding, and a shrink-0 group would
          simply overflow that padding at narrow widths and slide back under
          them, so it clips instead. Feedback, help, and zoom live in the
          settings sidebar. */}
      <div className="flex min-w-0 items-center gap-2 overflow-hidden">
        {!webMode ? <AutoUpdateControl /> : null}
        {!webMode ? <AccountBalanceIndicator /> : null}
        <ResourcePressureIndicator usage={resourceUsage} />
        <StoragePressureIndicator enabled={workspaceProjectOpen} />

        {/* App-global voice capture — visible from any tab while recording. */}
        <GlobalVoiceCaptureIndicator />

        <div className="hidden md:flex items-center gap-1.5">
          {renderDesktopIntegrationControls()}
          {renderDesktopUsageControl()}
        </div>

        {/* Account-wide Activity — the one place every machine's work surfaces,
            reachable from every tab and project without a nav detour. */}
        <HeaderActivityControl onOpenPane={handleOpenActivityPane} />

        {/* App settings with no project surface in front (welcome page, new
            tab, Chats). A project's own sidebar carries Settings otherwise. */}
        {!webMode && !projectSurfaceVisible && !isSettingsTabOpen ? (
          <SmartTooltip
            forceEnabled
            side="bottom"
            content={{ label: "Settings", description: "App preferences" }}
            wrapperStyle={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          >
            <button
              type="button"
              className="ade-shell-control inline-flex h-[24px] w-[24px] shrink-0 items-center justify-center rounded-md"
              data-variant="ghost"
              data-tour="project.settings"
              aria-label="Settings"
              style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
              onClick={() => {
                // Leave the new-tab state first: it is what holds the welcome
                // page in front, so a bare navigate would leave Settings behind it.
                cancelNewTab();
                setStandaloneSettingsOpen(true);
                onNavigate?.("/settings");
              }}
            >
              <GearSix size={14} weight="regular" />
            </button>
          </SmartTooltip>
        ) : null}

        <div className="hidden md:flex items-center gap-1.5">
          {renderDesktopConnectionsControl()}
        </div>

        <HeaderStatusMenu
          remoteConnected={remoteConnected}
          syncConnected={syncConnected || (!webMode && webConnected)}
          showSyncControl={showSyncControl}
        >
          {renderCompactStatusMenu}
        </HeaderStatusMenu>
      </div>

      {/* Overlay panels & modals — kept outside the gap-6 wrapper so they
          never participate in flex gap accounting when toggled open. */}
      <HeaderSheet
        open={connectionsOpen && !webMode}
        bare
        panelRef={connectionsPanelRef}
        title="Connections"
        width="w-[min(560px,calc(100vw-24px))]"
        onClose={closeConnections}
      >
        <ConnectionsPanel
          initialTab={connectionsTab}
          onClose={closeConnections}
          onDisconnectRequested={handleRemoteTargetDisconnectRequested}
          onRemoveRequested={handleRemoteTargetRemoveRequested}
        />
      </HeaderSheet>

      <ContextMenu
        menu={tabMenu}
        entries={tabMenuEntries}
        onClose={closeTabMenu}
        label="Project tab"
      />
      <ProjectIconDialog target={iconDialogTarget} onClose={closeIconDialog} />
      <CloneLocallyDialog
        target={cloneLocallyTarget}
        onClose={() => setCloneLocallyTarget(null)}
        onCloned={(result) => {
          if (cloneLocallyTarget) void handleClonedLocally(result.rootPath, cloneLocallyTarget.remoteKey);
        }}
      />
      <PublishToGitHubDialog
        open={publishOpen}
        onOpenChange={setPublishOpen}
        defaultRepoName={publishDefaultName}
        onPublished={() => {
          refreshRemote();
        }}
      />
    </header>
  );
}
