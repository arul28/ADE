import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  ArrowSquareOut,
  ChatCircleDots,
  CircleNotch,
  DesktopTower,
  DeviceMobile,
  Folder,
  FolderOpen,
  Globe,
  Plus,
  Minus,
  Plugs,
  Trash,
  UploadSimple,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import * as Dialog from "@radix-ui/react-dialog";

import { useAppStore } from "../../state/appStore";
import { isRunOwnedSession } from "../../lib/sessions";
import { useGithubProjectRemote } from "../../lib/useGithubProjectRemote";
import { openExternalUrl } from "../../lib/openExternal";
import { isWebClientMode } from "../../lib/webClientMode";
import {
  ZOOM_LEVEL_KEY,
  MIN_ZOOM_LEVEL,
  MAX_ZOOM_LEVEL,
  DEFAULT_ZOOM,
  ZOOM_STEP,
  displayZoomToLevel,
  getStoredZoomLevel,
  applyShellHeaderInset,
} from "../../lib/zoom";
import { cn } from "../ui/cn";
import { deriveIconAccentColor } from "../../lib/iconAccent";
import { SmartTooltip } from "../ui/SmartTooltip";
import { ADE_MOBILE_TESTFLIGHT_URL } from "../../../shared/productLinks";
import { WEB_CLIENT_BASE_URL } from "../../../shared/webClientUrl";
import type {
  ProcessRuntime,
  ProjectIcon,
  OpenProjectBinding,
  RecentProjectSummary,
  RemoteRuntimeConnectionSnapshot,
  RemoteRuntimeTarget,
  SyncRoleSnapshot,
  AppResourceUsageSnapshot,
} from "../../../shared/types";
import { AutoUpdateControl } from "./AutoUpdateControl";
import { FeedbackReporterModal } from "./FeedbackReporterModal";
import { HeaderSheet, useDialogFocusTrap } from "./HeaderSheet";
import { HelpMenu } from "../onboarding/HelpMenu";
import { LinearQuickViewButton } from "./LinearQuickViewButton";
import { PublishToGitHubDialog } from "../projects/PublishToGitHubDialog";
import { RemoteTargetList } from "../remoteTargets/RemoteTargetList";
import { ConfirmDialog, useConfirmDialog } from "../shared/InlineDialogs";
import { SyncDevicesSection } from "../settings/SyncDevicesSection";
import { HeaderUsageControl } from "../usage/HeaderUsageControl";
import { GlobalVoiceCaptureIndicator } from "../voice/GlobalVoiceCaptureIndicator";
import { appResourcePressureLevel, getAppResourceUsageCoalesced, resourcePressureDescription } from "../../lib/resourcePressure";
import { ShellNavTab } from "./ShellNavTab";
import {
  ADE_BROWSER_VIEW_OCCLUSION_END_EVENT,
  ADE_BROWSER_VIEW_OCCLUSION_START_EVENT,
} from "../../lib/workSidebarBrowserResize";

const RUNNING_LANE_PROCESS_STATES: ProcessRuntime["status"][] = [
  "starting",
  "running",
  "degraded",
];
const ADE_PROJECT_TAB_ROOT_MIME = "application/x-ade-project-root";
const ADE_PROJECT_TAB_WINDOW_MIME = "application/x-ade-window-id";
const ADE_PROJECT_TAB_DROP_HANDLED_PREFIX =
  "ade.projectTabDropHandled.v1:";
const ADE_PROJECT_TAB_DROP_HANDLED_TTL_MS = 5_000;

// Bounded LRU so we don't accumulate icons for every project ever opened in
// long-lived sessions. 24 entries keeps the working set hot for typical usage
// (current project + a few recents in the tab list) without unbounded growth.
const PROJECT_ICON_CACHE_MAX = 24;
const projectIconCache = new Map<string, ProjectIcon>();
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
type RemoteProjectTab = Extract<OpenProjectBinding, { kind: "remote" }>;

function projectTabDropMarkerKey(
  sourceWindowId: number | null,
  rootPath: string,
): string {
  return `${ADE_PROJECT_TAB_DROP_HANDLED_PREFIX}${sourceWindowId ?? "unknown"}:${encodeURIComponent(rootPath)}`;
}

function markProjectTabDropHandled(
  sourceWindowId: number | null,
  rootPath: string,
): void {
  try {
    window.localStorage.setItem(
      projectTabDropMarkerKey(sourceWindowId, rootPath),
      String(Date.now()),
    );
  } catch {
    // localStorage may be unavailable in tests or hardened browser contexts.
  }
}

function consumeRecentProjectTabDropHandled(
  sourceWindowId: number | null,
  rootPath: string,
): boolean {
  const key = projectTabDropMarkerKey(sourceWindowId, rootPath);
  try {
    const raw = window.localStorage.getItem(key);
    if (raw == null) return false;
    window.localStorage.removeItem(key);
    const timestamp = Number(raw);
    return (
      Number.isFinite(timestamp) &&
      Date.now() - timestamp < ADE_PROJECT_TAB_DROP_HANDLED_TTL_MS
    );
  } catch {
    return false;
  }
}

function rememberRecentProjects(rows: RecentProjectSummary[]): void {
  recentProjectsCache = { rows, fetchedAtMs: Date.now() };
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
function getProjectIconFromCache(rootPath: string): ProjectIcon | undefined {
  const cached = projectIconCache.get(rootPath);
  if (cached === undefined) return undefined;
  // Touch on read to mark as most-recently-used.
  projectIconCache.delete(rootPath);
  projectIconCache.set(rootPath, cached);
  return cached;
}
function setProjectIconCache(rootPath: string, icon: ProjectIcon): void {
  if (projectIconCache.has(rootPath)) {
    projectIconCache.delete(rootPath);
  } else if (projectIconCache.size >= PROJECT_ICON_CACHE_MAX) {
    // Map iteration order is insertion order, so the first key is the LRU.
    const oldestKey = projectIconCache.keys().next().value;
    if (oldestKey !== undefined) {
      projectIconCache.delete(oldestKey);
    }
  }
  projectIconCache.set(rootPath, icon);
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

function isWebSyncConnected(snapshot: SyncRoleSnapshot | null): boolean {
  return connectedWebClients(snapshot).length > 0;
}

function deriveWebClientTooltip(snapshot: SyncRoleSnapshot | null): string {
  const clients = connectedWebClients(snapshot);
  if (clients.length === 0) return "Pair a browser with this machine";
  const first = clients[0];
  const name = first.deviceName?.trim();
  return name ? `${clients.length} connected · ${name}` : `${clients.length} connected`;
}

function deriveWebSyncLabel(snapshot: SyncRoleSnapshot | null): string | null {
  if (!snapshot) return null;
  if (snapshot.client.state === "error") return "Web client sync error";
  if (snapshot.role === "brain") {
    const count = connectedWebClients(snapshot).length;
    if (count > 0) {
      const machineName = snapshot.localDevice.name.trim() || "this machine";
      return `${count} web client${count === 1 ? "" : "s"} connected to ${machineName}`;
    }
    return "Web client pairing ready";
  }
  if (snapshot.mode === "standalone") return "Web client pairing ready";
  switch (snapshot.client.state) {
    case "connected":
      return `Linked to ${snapshot.currentBrain?.name ?? "host"}`;
    case "connecting":
      return "Connecting…";
    default:
      return "Web client sync offline";
  }
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
      <span
        role="status"
        tabIndex={0}
        aria-label={`ADE resource pressure level ${level}`}
        title={description}
        data-ade-resource-pressure-level={level}
        data-ade-resource-pressure-active-ptys={usage?.activePtyCount ?? 0}
        data-ade-resource-pressure-pty-processes={usage?.ptyProcessCount ?? 0}
        data-ade-resource-pressure-pty-cpu={usage?.ptyCpuPercent ?? ""}
        data-ade-resource-pressure-pty-memory-mb={usage?.ptyMemoryMB ?? ""}
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
      >
        <WarningCircle size={14} weight="fill" />
      </span>
    </SmartTooltip>
  );
}

const HEADER_STATUS_MENU_ROW_CLASS =
  "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11px] font-medium text-muted-fg/80 transition-colors duration-150 hover:bg-white/[0.06] hover:text-fg/90";

function ShellConnectionChip({
  label,
  icon,
  connected,
  title,
  ariaExpanded,
  onClick,
  layout = "chip",
}: {
  label: string;
  icon: React.ReactNode;
  connected: boolean;
  title: string;
  ariaExpanded?: boolean;
  onClick: () => void;
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

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (menuRef.current?.contains(target)) return;
      if (buttonRef.current?.contains(target)) return;
      close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [close, open]);

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
        aria-haspopup="menu"
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
      {open && menuPos
        ? createPortal(
            <div
              ref={menuRef}
              role="menu"
              aria-label="Connections and usage"
              className={cn(
                "fixed z-[90] min-w-[220px] overflow-hidden rounded-xl border border-white/10",
                "bg-[color:var(--ade-shell-surface,#121019)] p-1.5 shadow-2xl shadow-black/45",
              )}
              style={{ top: menuPos.top, right: menuPos.right }}
            >
              {children(close)}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function projectIconErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const cleaned = raw
    .replace(/^Error invoking remote method '[^']+':\s*/i, "")
    .replace(/^Error:\s*/i, "")
    .trim();
  return cleaned || "Failed to update project icon.";
}

function fallbackProjectName(rootPath: string): string {
  return rootPath.split(/[\\/]/).filter(Boolean).pop() ?? rootPath;
}

function confirmProjectTabRemoval(projectName: string): boolean {
  const label = projectName.trim() || "this project";
  return window.confirm(
    `Close "${label}" project tab?\n\nThis does not remove it from Recent Projects or delete any files on disk.`,
  );
}

function deriveSyncLabel(snapshot: SyncRoleSnapshot | null): string | null {
  if (!snapshot) return null;
  if (snapshot.client.state === "error") return "Phone sync error";
  if (snapshot.role === "brain") {
    const count = snapshot.connectedPeers.filter((peer) => peer.deviceType === "phone").length;
    if (count > 0) {
      const machineName = snapshot.localDevice.name.trim() || "this machine";
      return `${count} phone${count === 1 ? "" : "s"} connected to ${machineName}`;
    }
    return "Phone sync ready";
  }
  if (snapshot.mode === "standalone") return "Phone sync ready";
  switch (snapshot.client.state) {
    case "connected":
      return `Linked to ${snapshot.currentBrain?.name ?? "host"}`;
    case "connecting":
      return "Connecting…";
    default:
      return "Phone sync offline";
  }
}

function ProjectTabIcon({
  rootPath,
  isCurrent,
  animate,
  disabled,
  readOnly = false,
  iconDataUrlOverride,
  onAccentColorChange,
}: {
  rootPath: string;
  isCurrent: boolean;
  animate: boolean;
  disabled: boolean;
  readOnly?: boolean;
  /**
   * When defined, the caller owns this tab's icon (remote tabs, whose files
   * live on another machine). A non-empty data URL is rendered directly; null
   * falls back to the folder glyph. Either way the local resolveIcon path is
   * skipped, since it can only read the local filesystem.
   */
  iconDataUrlOverride?: string | null;
  onAccentColorChange?: (rootPath: string, color: string | null) => void;
}) {
  const [icon, setIcon] = useState<ProjectIcon | null>(() =>
    disabled ? null : (getProjectIconFromCache(rootPath) ?? null),
  );
  const [failed, setFailed] = useState(false);
  const [iconDialogOpen, setIconDialogOpen] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [iconError, setIconError] = useState<string | null>(null);

  // Remote tabs supply their icon via the override (resolved on the host), so
  // the local resolveIcon path is bypassed entirely.
  const managedIcon = iconDataUrlOverride !== undefined;
  const overrideIcon: ProjectIcon | null = iconDataUrlOverride
    ? { dataUrl: iconDataUrlOverride, sourcePath: null, mimeType: null }
    : null;
  const displayIcon: ProjectIcon | null = managedIcon ? overrideIcon : icon;

  useEffect(() => {
    setFailed(false);
    // Caller-managed icons (remote tabs) never resolve against the local
    // filesystem — the project lives on another machine.
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
    const dataUrl = icon?.dataUrl;
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
  }, [failed, icon?.dataUrl, onAccentColorChange, rootPath]);

  const fallbackIcon = (
    <Folder
      size={14}
      weight="regular"
      className={cn(
        "shrink-0 transition-opacity duration-150",
        isCurrent ? "opacity-90" : "opacity-70",
        animate && "animate-pulse",
      )}
    />
  );

  const iconNode =
    !displayIcon?.dataUrl || failed ? (
      fallbackIcon
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
    );

  const handleChooseIcon = useCallback(async () => {
    if (disabled || choosing) return;
    setChoosing(true);
    setIconError(null);
    try {
      const nextIcon = await window.ade.project.chooseIcon(rootPath);
      if (nextIcon) {
        setProjectIconCache(rootPath, nextIcon);
        setFailed(false);
        setIcon(nextIcon);
        if (nextIcon.dataUrl) {
          setIconDialogOpen(false);
        } else {
          setIconError(
            "ADE saved the path, but the image could not be rendered as a project icon.",
          );
        }
      }
    } catch (error) {
      // Keep the current icon while surfacing why replacement failed.
      setIconError(projectIconErrorMessage(error));
    } finally {
      setChoosing(false);
    }
  }, [choosing, disabled, rootPath]);

  const handleRemoveIcon = useCallback(async () => {
    if (disabled || removing) return;
    setRemoving(true);
    setIconError(null);
    try {
      const nextIcon = await window.ade.project.removeIcon(rootPath);
      setProjectIconCache(rootPath, nextIcon);
      setFailed(false);
      setIcon(nextIcon);
      setIconDialogOpen(false);
    } catch (error) {
      // Keep the current icon while surfacing why removal failed.
      setIconError(projectIconErrorMessage(error));
    } finally {
      setRemoving(false);
    }
  }, [disabled, removing, rootPath]);

  if (disabled) return iconNode;

  if (readOnly) {
    return (
      <span
        aria-label="Project icon"
        title="Project icon"
        className={cn(
          "inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] text-current",
        )}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {iconNode}
      </span>
    );
  }

  return (
    <Dialog.Root
      open={iconDialogOpen}
      onOpenChange={(open) => {
        setIconDialogOpen(open);
        if (!open) setIconError(null);
      }}
    >
      <Dialog.Trigger asChild>
        <button
          type="button"
          aria-label="Project icon"
          title="Project icon"
          className={cn(
            "inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px]",
            "text-current transition-colors hover:bg-white/10 focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent/70",
          )}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
        >
          {choosing || removing ? (
            <CircleNotch
              size={15}
              weight="bold"
              className="animate-spin opacity-80"
            />
          ) : (
            iconNode
          )}
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[120] bg-black/45 backdrop-blur-sm" />
        <Dialog.Content
          className={cn(
            "fixed left-1/2 top-1/2 z-[121] w-[min(320px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2",
            "rounded-lg border border-border bg-surface p-4 text-fg shadow-2xl",
          )}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <Dialog.Title className="text-sm font-semibold">
                Project icon
              </Dialog.Title>
              <Dialog.Description className="sr-only">
                Preview and manage this project's shared icon.
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-fg transition-colors hover:bg-white/10 hover:text-fg"
                aria-label="Close"
              >
                <X size={15} />
              </button>
            </Dialog.Close>
          </div>

          <div className="mt-4 flex items-center justify-center rounded-md border border-border bg-bg/60 p-5">
            {icon?.dataUrl && !failed ? (
              <img
                src={icon.dataUrl}
                alt=""
                className="h-20 w-20 rounded-md object-contain"
                draggable={false}
              />
            ) : (
              <Folder size={52} className="text-muted-fg" />
            )}
          </div>

          {iconError ? (
            <div
              role="alert"
              className="mt-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs leading-5 text-red-200"
            >
              {iconError}
            </div>
          ) : null}

          <div className="mt-4 flex items-center justify-end gap-2">
            <button
              type="button"
              className="inline-flex h-8 items-center justify-center rounded-md border border-border px-3 text-xs font-medium text-muted-fg transition-colors hover:bg-white/10 hover:text-fg disabled:cursor-not-allowed disabled:opacity-60"
              disabled={choosing || removing}
              onClick={handleRemoveIcon}
            >
              {removing ? (
                <CircleNotch
                  size={13}
                  weight="bold"
                  className="mr-1.5 animate-spin"
                />
              ) : null}
              Remove
            </button>
            <button
              type="button"
              className="inline-flex h-8 items-center justify-center rounded-md bg-accent px-3 text-xs font-semibold text-accent-fg transition-colors hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={choosing || removing}
              onClick={handleChooseIcon}
            >
              {choosing ? (
                <CircleNotch
                  size={13}
                  weight="bold"
                  className="mr-1.5 animate-spin"
                />
              ) : null}
              Replace
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function TopBar({
  personalChatsRouteActive = false,
  onNavigate,
}: {
  personalChatsRouteActive?: boolean;
  onNavigate?: (path: string, opts?: { replace?: boolean }) => void;
} = {}) {
  const project = useAppStore((s) => s.project);
  const hasProject = Boolean(project?.rootPath);
  const projectBinding = useAppStore((s) => s.projectBinding);
  const projectHydrated = useAppStore((s) => s.projectHydrated);
  const showWelcome = useAppStore((s) => s.showWelcome);
  const closeProject = useAppStore((s) => s.closeProject);
  const terminalAttention = useAppStore((s) => s.terminalAttention);
  const openRepo = useAppStore((s) => s.openRepo);
  const isNewTabOpen = useAppStore((s) => s.isNewTabOpen);
  const openNewTab = useAppStore((s) => s.openNewTab);
  const cancelNewTab = useAppStore((s) => s.cancelNewTab);
  const personalChatsTabOpen = useAppStore((s) => s.personalChatsTabOpen);
  const closePersonalChatsTab = useAppStore((s) => s.closePersonalChatsTab);
  const projectTransition = useAppStore((s) => s.projectTransition);
  const projectTransitionError = useAppStore((s) => s.projectTransitionError);
  const clearProjectTransitionError = useAppStore(
    (s) => s.clearProjectTransitionError,
  );
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
  const [zoom, setZoom] = useState(getStoredZoomLevel);
  const [syncSnapshot, setSyncSnapshot] = useState<SyncRoleSnapshot | null>(
    null,
  );
  const [syncPanelOpen, setSyncPanelOpen] = useState<"phone" | "web" | null>(null);
  const [remotePanelOpen, setRemotePanelOpen] = useState(false);
  const {
    state: remoteDisconnectConfirmState,
    confirmAsync: confirmRemoteDisconnect,
    close: closeRemoteDisconnectConfirm,
  } = useConfirmDialog();
  const [remoteSnapshot, setRemoteSnapshot] =
    useState<RemoteRuntimeConnectionSnapshot | null>(null);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const openProjectTabRoots = useAppStore((s) => s.openProjectTabRoots);
  const setOpenProjectTabRoots = useAppStore((s) => s.setOpenProjectTabRoots);
  const [openRemoteProjectTabs, setOpenRemoteProjectTabs] = useState<
    RemoteProjectTab[]
  >([]);
  const openProjectTabRootsRef = useRef(openProjectTabRoots);
  const openRemoteProjectTabsRef = useRef(openRemoteProjectTabs);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dropIdx, setDropIdx] = useState<number | null>(null);
  const [windowId, setWindowId] = useState<number | null>(null);
  const phoneSyncPanelRef = useRef<HTMLDivElement | null>(null);
  const webSyncPanelRef = useRef<HTMLDivElement | null>(null);
  const remotePanelRef = useRef<HTMLDivElement | null>(null);
  const closeSyncPanel = useCallback(() => setSyncPanelOpen(null), []);
  const closeRemotePanel = useCallback(() => setRemotePanelOpen(false), []);
  const handleRemotePanelKeyDown = useDialogFocusTrap(
    remotePanelRef,
    closeRemotePanel,
    remotePanelOpen,
  );
  const dragCounterRef = useRef(0);
  const isProjectBusy = projectTransition != null || relocatingPath != null;
  const remoteBinding =
    projectBinding?.kind === "remote" ? projectBinding : null;
  const phoneSyncOpen = syncPanelOpen === "phone";
  const webSyncOpen = syncPanelOpen === "web";
  const chromePanelOccludesNativeBrowser = remotePanelOpen || syncPanelOpen !== null;
  const workspaceProjectOpen =
    projectHydrated === true &&
    showWelcome !== true &&
    isNewTabOpen !== true &&
    Boolean(project?.rootPath) &&
    !remoteBinding;
  const resourceUsage = useResourcePressureUsage(workspaceProjectOpen);

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
  const webClientTooltip = deriveWebClientTooltip(syncSnapshot);
  const showSyncControl = projectHydrated === true;
  const syncStatusTargetKey =
    remoteBinding?.key ?? project?.rootPath ?? "machine";
  const syncStatusTargetRef = useRef(syncStatusTargetKey);

  useEffect(() => {
    openProjectTabRootsRef.current = openProjectTabRoots;
  }, [openProjectTabRoots]);

  useEffect(() => {
    window.ade.app.setWindowProjectTabs(openProjectTabRoots).catch(() => {});
  }, [openProjectTabRoots]);

  useEffect(() => {
    openRemoteProjectTabsRef.current = openRemoteProjectTabs;
  }, [openRemoteProjectTabs]);

  // Mirrors the latest applied zoom so menu/keyboard commands compound off the
  // current level. Updated synchronously inside applyZoom (not via a passive
  // effect) so back-to-back commands before the next render don't reuse a stale
  // value and collapse multiple steps into one.
  const zoomRef = useRef(zoom);
  const applyZoom = useCallback((pct: number) => {
    const clamped = Math.max(MIN_ZOOM_LEVEL, Math.min(MAX_ZOOM_LEVEL, pct));
    window.ade.zoom.setLevel(displayZoomToLevel(clamped));
    localStorage.setItem(ZOOM_LEVEL_KEY, String(clamped));
    applyShellHeaderInset(clamped);
    zoomRef.current = clamped;
    setZoom(clamped);
  }, []);

  const zoomIn = useCallback(() => applyZoom(zoom + ZOOM_STEP), [applyZoom, zoom]);
  const zoomOut = useCallback(() => applyZoom(zoom - ZOOM_STEP), [applyZoom, zoom]);

  // Route native View-menu (and keyboard) zoom through the same applyZoom path
  // so display %, persistence, and the macOS traffic-light inset stay in sync.
  useEffect(() => {
    const onCommand = window.ade?.zoom?.onCommand;
    if (typeof onCommand !== "function") return;
    return onCommand((command) => {
      if (command === "in") applyZoom(zoomRef.current + ZOOM_STEP);
      else if (command === "out") applyZoom(zoomRef.current - ZOOM_STEP);
      else applyZoom(DEFAULT_ZOOM);
    });
  }, [applyZoom]);

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

  useEffect(() => {
    let cancelled = false;
    window.ade.app
      .getWindowSession()
      .then((session) => {
        if (cancelled) return;
        setWindowId(session.windowId);
        if (session.openProjectTabs.length > 0) {
          for (const tabProject of session.openProjectTabs) {
            useAppStore.getState().rememberProjectInfo(tabProject);
          }
          // Merge, don't replace. The main-process snapshot
          // (projectsForWindowTabs) drops any tab root whose context was
          // evicted while idle, so a remount could otherwise lose a local tab
          // that the renderer still has. Restored roots come first; keep any
          // extra local roots the renderer already knows about.
          const restored = session.openProjectTabs.map((entry) => entry.rootPath);
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
      })
      .catch(() => {
        if (!cancelled) setWindowId(null);
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
        if (!cancelled) setRemoteSnapshot(snapshot);
      })
      .catch(() => {
        if (!cancelled) setRemoteSnapshot(null);
      });
    const unsubscribe =
      remoteRuntime.onConnectionSnapshotChanged?.((snapshot) => {
        if (!cancelled) setRemoteSnapshot(snapshot);
      }) ?? (() => {});
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

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
      setSyncPanelOpen(null);
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
      phoneSyncOpen || webSyncOpen ? 0 : PHONE_SYNC_STARTUP_DELAY_MS,
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
  }, [phoneSyncOpen, webSyncOpen, showSyncControl, syncStatusTargetKey]);

  const checkForActiveWorkloads = useCallback(
    async (projectRootPath: string): Promise<boolean> => {
      if (project?.rootPath !== projectRootPath) return true;

      try {
        const [lanes, runningSessions, agentChats] =
          await Promise.all([
            window.ade.lanes.list({ includeArchived: false }),
            window.ade.sessions.list({ status: "running" }),
            window.ade.agentChat.list(),
          ]);

        const laneRuntimes = await Promise.all(
          lanes.map((lane) =>
            window.ade.processes
              .listRuntime(lane.id)
              .catch(() => [] as ProcessRuntime[]),
          ),
        );

        const activeProcesses = laneRuntimes
          .flat()
          .filter((runtime) =>
            RUNNING_LANE_PROCESS_STATES.includes(runtime.status),
          );
        const activeSessionCount = runningSessions.filter(
          (session) =>
            session.status === "running" && !isRunOwnedSession(session),
        ).length;
        const activeChatCount = agentChats.filter(
          (chat) => chat.status === "active",
        ).length;

        const warnings: string[] = [];
        if (activeProcesses.length > 0) {
          warnings.push(
            `${activeProcesses.length} running lane process${activeProcesses.length === 1 ? "" : "es"}`,
          );
        }
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
          "You are about to close this project.",
          "The following active work items will be terminated:",
          ...warnings.map((line) => `- ${line}`),
          "",
          "Do you want to continue?",
        ].join("\n");

        return window.confirm(message);
      } catch {
        return true;
      }
    },
    [project?.rootPath],
  );

  const handleOpenNew = useCallback(() => {
    if (isProjectBusy) return;
    openNewTab();
    if (personalChatsRouteActive) onNavigate?.("/work");
  }, [isProjectBusy, onNavigate, openNewTab, personalChatsRouteActive]);

  const handleOpenNewWindow = useCallback(() => {
    if (isProjectBusy) return;
    window.ade.app.newWindow().catch(() => {});
  }, [isProjectBusy]);

  const handleSwitchProject = useCallback(
    (rootPath: string) => {
      if (isProjectBusy) return;
      if (!remoteBinding && project?.rootPath === rootPath) {
        cancelNewTab();
        return;
      }
      switchProjectToPath(rootPath).catch(() => {});
    },
    [
      cancelNewTab,
      isProjectBusy,
      project?.rootPath,
      remoteBinding,
      switchProjectToPath,
    ],
  );

  const handleSwitchRemoteProject = useCallback(
    (binding: RemoteProjectTab) => {
      if (isProjectBusy) return;
      if (remoteBinding?.key === binding.key) {
        cancelNewTab();
        return;
      }
      switchRemoteProject(binding.targetId, binding.projectId).catch(() => {});
    },
    [
      cancelNewTab,
      isProjectBusy,
      remoteBinding?.key,
      switchRemoteProject,
    ],
  );

  const handleRemoveTab = useCallback(
    (rootPath: string) => {
      void (async () => {
        const target = projectTabs.find((entry) => entry.rootPath === rootPath);
        const fallbackName = fallbackProjectName(rootPath);
        const confirmed = confirmProjectTabRemoval(
          target?.displayName ?? fallbackName,
        );
        if (!confirmed) return;

        const shouldClose = await checkForActiveWorkloads(rootPath);
        if (!shouldClose) return;

        const latestTabRoots = openProjectTabRootsRef.current;
        const currentIndex = latestTabRoots.indexOf(rootPath);
        if (currentIndex === -1) return;
        const nextTabRoots = latestTabRoots.filter(
          (entry) => entry !== rootPath,
        );
        openProjectTabRootsRef.current = nextTabRoots;
        setOpenProjectTabRoots((prev) =>
          prev.includes(rootPath) ? prev.filter((entry) => entry !== rootPath) : prev,
        );

        const latestState = useAppStore.getState();
        const latestProjectRoot = latestState.project?.rootPath ?? null;
        const latestRemoteBinding =
          latestState.projectBinding?.kind === "remote"
            ? latestState.projectBinding
            : null;
        const latestRemoteTabs = openRemoteProjectTabsRef.current;
        if (!latestRemoteBinding && latestProjectRoot === rootPath) {
          const nextRoot =
            nextTabRoots[currentIndex] ??
            nextTabRoots[currentIndex - 1] ??
            null;
          if (nextRoot) {
            latestState.switchProjectToPath(nextRoot).catch(() => {});
          } else if (latestRemoteTabs[0]) {
            latestState.switchRemoteProject(
              latestRemoteTabs[0].targetId,
              latestRemoteTabs[0].projectId,
            ).catch(() => {});
          } else {
            latestState.closeProject().catch(() => {});
          }
        }
      })().catch(() => {});
    },
    [
      checkForActiveWorkloads,
      projectTabs,
    ],
  );

  const handleCloseRemoteTab = useCallback((binding: RemoteProjectTab) => {
    if (isProjectBusy) return;
    const closedIndex = openRemoteProjectTabs.findIndex(
      (entry) => entry.key === binding.key,
    );
    const nextRemoteTabs = openRemoteProjectTabs.filter(
      (entry) => entry.key !== binding.key,
    );
    setOpenRemoteProjectTabs(nextRemoteTabs);
    if (remoteBinding?.key !== binding.key) return;

    const nextRemoteTab =
      nextRemoteTabs[closedIndex] ?? nextRemoteTabs[closedIndex - 1] ?? null;
    if (nextRemoteTab) {
      switchRemoteProject(nextRemoteTab.targetId, nextRemoteTab.projectId).catch(
        () => {},
      );
      return;
    }

    const nextLocalRoot =
      openProjectTabRoots[openProjectTabRoots.length - 1] ?? null;
    if (nextLocalRoot) {
      switchProjectToPath(nextLocalRoot).catch(() => {});
    } else {
      closeProject().catch(() => {});
    }
  }, [
    closeProject,
    isProjectBusy,
    openProjectTabRoots,
    openRemoteProjectTabs,
    remoteBinding?.key,
    switchProjectToPath,
    switchRemoteProject,
  ]);

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
      const affectedProjectLines =
        affectedTabs.length > 0
          ? affectedTabs.map((entry) => `- ${entry.displayName}`).join("\n")
          : "";
      const verb = action === "remove" ? "Removing" : "Disconnecting";
      const reconnectCopy = action === "remove"
        ? "Add the machine again to reconnect."
        : "ADE will not reconnect to this machine until you connect again.";
      const message =
        affectedCount > 0
          ? [
              `${affectedCount} open project tab${affectedCount === 1 ? "" : "s"} use this remote connection:`,
              affectedProjectLines,
              "",
              `${verb} will close those project tabs. ${reconnectCopy}`,
            ].join("\n")
          : action === "remove"
            ? "Removing this machine will delete its saved SSH details."
            : "Disconnecting will stop this remote connection. ADE will not reconnect to this machine until you connect again.";

      const confirmed = await confirmRemoteDisconnect({
        title: action === "remove"
          ? `Remove ${targetName}?`
          : `Disconnect ${targetName}?`,
        message,
        confirmLabel: action === "remove" ? "REMOVE" : "DISCONNECT",
        danger: true,
      });
      if (!confirmed) return false;
      if (affectedTabs.length === 0) return true;

      const affectedKeys = new Set(affectedTabs.map((entry) => entry.key));
      const nextRemoteTabs = latestRemoteTabs.filter(
        (entry) => !affectedKeys.has(entry.key),
      );
      openRemoteProjectTabsRef.current = nextRemoteTabs;
      setOpenRemoteProjectTabs(nextRemoteTabs);

      const latestState = useAppStore.getState();
      const latestRemoteBinding =
        latestState.projectBinding?.kind === "remote"
          ? latestState.projectBinding
          : null;
      if (!latestRemoteBinding || !affectedKeys.has(latestRemoteBinding.key)) {
        return true;
      }

      const nextRemoteTab = nextRemoteTabs[0] ?? null;
      if (nextRemoteTab) {
        latestState.switchRemoteProject(
          nextRemoteTab.targetId,
          nextRemoteTab.projectId,
        ).catch(() => {});
        return true;
      }

      const nextLocalRoot =
        openProjectTabRootsRef.current[
          openProjectTabRootsRef.current.length - 1
        ] ?? null;
      if (nextLocalRoot) {
        latestState.switchProjectToPath(nextLocalRoot).catch(() => {});
      } else {
        latestState.closeProject().catch(() => {});
      }
      return true;
    },
    [confirmRemoteDisconnect],
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

  const handleDragStart = useCallback(
    (e: React.DragEvent, idx: number, rootPath: string) => {
      setDragIdx(idx);
      dragCounterRef.current = 0;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(idx));
      e.dataTransfer.setData(ADE_PROJECT_TAB_ROOT_MIME, rootPath);
      if (windowId != null) {
        e.dataTransfer.setData(ADE_PROJECT_TAB_WINDOW_MIME, String(windowId));
      }
    },
    [windowId],
  );

  const handleDragOver = useCallback((e: React.DragEvent, idx: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropIdx(idx);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDropIdx(null);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent, targetIdx: number) => {
      if (
        dragIdx === null &&
        Array.from(e.dataTransfer.types).includes(ADE_PROJECT_TAB_ROOT_MIME)
      ) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      setDropIdx(null);
      if (dragIdx === null || dragIdx === targetIdx) {
        setDragIdx(null);
        return;
      }
      const items = [...openProjectTabRoots];
      const [moved] = items.splice(dragIdx, 1);
      items.splice(targetIdx, 0, moved);
      setOpenProjectTabRoots(items);
      setDragIdx(null);
    },
    [dragIdx, openProjectTabRoots],
  );

  const handleProjectTabDrop = useCallback(
    (e: React.DragEvent) => {
      const rootPath = e.dataTransfer.getData(ADE_PROJECT_TAB_ROOT_MIME);
      if (!rootPath) return;
      e.preventDefault();
      setDropIdx(null);
      setDragIdx(null);

      const sourceWindowIdRaw = e.dataTransfer.getData(
        ADE_PROJECT_TAB_WINDOW_MIME,
      );
      const parsedSourceWindowId = sourceWindowIdRaw
        ? Number(sourceWindowIdRaw)
        : null;
      const sourceWindowId =
        parsedSourceWindowId != null && Number.isFinite(parsedSourceWindowId)
          ? parsedSourceWindowId
          : null;
      if (sourceWindowId != null && sourceWindowId === windowId) return;

      markProjectTabDropHandled(sourceWindowId, rootPath);

      if (project?.rootPath === rootPath) {
        if (sourceWindowId != null) {
          window.ade.app.closeWindow(sourceWindowId).catch(() => {});
        }
        return;
      }
      switchProjectToPath(rootPath).catch(() => {});
    },
    [project?.rootPath, switchProjectToPath, windowId],
  );

  const handleProjectTabDragOver = useCallback((e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes(ADE_PROJECT_TAB_ROOT_MIME))
      return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }, []);

  const handleDragEnd = useCallback(
    (e: React.DragEvent, rootPath?: string) => {
      const draggedOutside =
        rootPath &&
        (e.clientX < 0 ||
          e.clientY < 0 ||
          e.clientX > window.innerWidth ||
          e.clientY > window.innerHeight);
      const droppedOnAdeTarget =
        e.dataTransfer.dropEffect && e.dataTransfer.dropEffect !== "none";
      const sourceWindowIdRaw = e.dataTransfer.getData(
        ADE_PROJECT_TAB_WINDOW_MIME,
      );
      const parsedSourceWindowId = sourceWindowIdRaw
        ? Number(sourceWindowIdRaw)
        : null;
      const sourceWindowId =
        parsedSourceWindowId != null && Number.isFinite(parsedSourceWindowId)
          ? parsedSourceWindowId
          : null;
      const handledByAdeDropTarget =
        rootPath && droppedOnAdeTarget
          ? consumeRecentProjectTabDropHandled(sourceWindowId, rootPath)
          : false;
      setDragIdx(null);
      setDropIdx(null);
      if (!draggedOutside || handledByAdeDropTarget || !rootPath) return;

      void (async () => {
        try {
          await window.ade.app.openProjectInNewWindow(rootPath);
        } catch {
          return;
        }

        // Detach skips the confirmation + active workload checks intentionally:
        // the user already committed to detaching by dragging the tab out, and
        // the work is moving to a new window rather than terminating. Only remove
        // the source tab after the destination window has a bound project.
        const latestTabRoots = openProjectTabRootsRef.current;
        const currentIndex = latestTabRoots.indexOf(rootPath);
        if (currentIndex === -1) return;
        const nextTabRoots = latestTabRoots.filter(
          (entry) => entry !== rootPath,
        );
        openProjectTabRootsRef.current = nextTabRoots;
        setOpenProjectTabRoots((prev) =>
          prev.includes(rootPath) ? prev.filter((entry) => entry !== rootPath) : prev,
        );

        const latestState = useAppStore.getState();
        const latestProjectRoot = latestState.project?.rootPath ?? null;
        const latestRemoteBinding =
          latestState.projectBinding?.kind === "remote"
            ? latestState.projectBinding
            : null;
        const latestRemoteTabs = openRemoteProjectTabsRef.current;
        if (!latestRemoteBinding && latestProjectRoot === rootPath) {
          const nextRoot =
            nextTabRoots[currentIndex] ?? nextTabRoots[currentIndex - 1] ?? null;
          if (nextRoot) {
            await latestState.switchProjectToPath(nextRoot).catch(() => {});
          } else if (latestRemoteTabs[0]) {
            await latestState.switchRemoteProject(
              latestRemoteTabs[0].targetId,
              latestRemoteTabs[0].projectId,
            ).catch(() => {});
          } else {
            await latestState.closeProject().catch(() => {});
          }
        }
      })();
    },
    [],
  );

  const handleProjectAccentColorChange = useCallback(
    (rootPath: string, color: string | null) => {
      setProjectAccentColors((prev) => {
        if ((prev[rootPath] ?? null) === color) return prev;
        return { ...prev, [rootPath]: color };
      });
    },
    [],
  );

  const syncLabel = deriveSyncLabel(syncSnapshot) ?? "Phone sync";
  const webSyncLabel = deriveWebSyncLabel(syncSnapshot) ?? "Web client sync";
  const openMobileTestFlight = useCallback(
    () => openExternalUrl(ADE_MOBILE_TESTFLIGHT_URL),
    [],
  );
  const openWebClient = useCallback(
    () => openExternalUrl(WEB_CLIENT_BASE_URL),
    [],
  );

  const renderHeaderStatusControls = useCallback(
    (options?: { menuLayout?: boolean; onActivate?: () => void }) => {
      const menuLayout = options?.menuLayout === true;
      const wrapActivate = (handler: () => void) => () => {
        handler();
        options?.onActivate?.();
      };

      const remoteChip = (
        <ShellConnectionChip
          layout={menuLayout ? "menu-row" : "chip"}
          label="Remote"
          connected={remoteConnected}
          title="Manage remote machines"
          ariaExpanded={remotePanelOpen}
          onClick={
            menuLayout
              ? wrapActivate(() => {
                setSyncPanelOpen(null);
                setRemotePanelOpen(true);
              })
              : () => {
                setSyncPanelOpen(null);
                setRemotePanelOpen((open) => !open);
              }
          }
          icon={(
            <DesktopTower
              size={12}
              weight="regular"
              className="shrink-0 opacity-85"
            />
          )}
        />
      );

      const mobileChip = showSyncControl ? (
        <ShellConnectionChip
          layout={menuLayout ? "menu-row" : "chip"}
          label="Mobile"
          connected={syncConnected}
          title="Connect a phone to this machine"
          ariaExpanded={phoneSyncOpen}
          onClick={
            menuLayout
              ? wrapActivate(() => {
                setRemotePanelOpen(false);
                setSyncPanelOpen("phone");
              })
              : () => {
                setRemotePanelOpen(false);
                setSyncPanelOpen((open) => open === "phone" ? null : "phone");
              }
          }
          icon={(
            <DeviceMobile
              size={12}
              weight="regular"
              className="shrink-0 opacity-85"
            />
          )}
        />
      ) : null;

      const webChip = showSyncControl && !webMode ? (
        <ShellConnectionChip
          layout={menuLayout ? "menu-row" : "chip"}
          label="Web"
          connected={webConnected}
          title={webClientTooltip}
          ariaExpanded={webSyncOpen}
          onClick={
            menuLayout
              ? wrapActivate(() => {
                setRemotePanelOpen(false);
                setSyncPanelOpen("web");
              })
              : () => {
                setRemotePanelOpen(false);
                setSyncPanelOpen((open) => open === "web" ? null : "web");
              }
          }
          icon={(
            <Globe
              size={12}
              weight="regular"
              className="shrink-0 opacity-85"
            />
          )}
        />
      ) : null;

      if (menuLayout) {
        return (
          <div className="flex flex-col gap-0.5">
            <LinearQuickViewButton variant="menu-row" onMenuActivate={options?.onActivate} />
            <HeaderUsageControl
              variant="menu-row"
              onMenuActivate={options?.onActivate}
              deferInitialRead={Boolean(remoteBinding)}
            />
            {remoteChip}
            {mobileChip}
            {webChip}
          </div>
        );
      }

      return (
        <>
          <LinearQuickViewButton />
          {remoteChip}
          {mobileChip}
          {webChip}
          <HeaderUsageControl deferInitialRead={Boolean(remoteBinding)} />
        </>
      );
    },
    [
      phoneSyncOpen,
      webSyncOpen,
      remoteBinding,
      remoteConnected,
      remotePanelOpen,
      showSyncControl,
      syncConnected,
      webMode,
      webConnected,
      webClientTooltip,
    ],
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
      className="ade-shell-header flex items-center gap-3"
      style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
    >
      {/* Branding */}
      <img
        src="./logo.png"
        alt="ADE"
        className="shrink-0 select-none"
        style={{ height: 20 }}
        draggable={false}
      />

      {/* Divider */}
      <div className="ade-shell-header-divider h-3 w-px shrink-0" />

      {/* Project tabs — the container stays draggable, only interactive elements opt out */}
      <div
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto scrollbar-none"
        onDragOver={handleProjectTabDragOver}
        onDrop={handleProjectTabDrop}
      >
        {openRemoteProjectTabs.length > 0 ||
        projectTabs.length > 0 ||
        isNewTabOpen ||
        personalChatsTabOpen ? (
          <>
            {openRemoteProjectTabs.map((remoteTab) => {
              const isCurrentRemote = remoteBinding?.key === remoteTab.key;
              const remoteTabConnection =
                remoteSnapshot?.connections.find(
                  (entry) => entry.target.id === remoteTab.targetId,
                ) ?? null;
              const remoteTabState = remoteTabConnection?.state ?? "idle";
              const remoteTabConnected = remoteTabState === "connected";
              const remoteTabConnecting = remoteTabState === "connecting";
              const remoteTabDisconnected =
                remoteTabState === "error" || remoteTabState === "idle";
              const remoteTabStatusLabel = remoteTabConnected
                ? "Connected"
                : remoteTabConnecting
                  ? "Reconnecting"
                  : "Disconnected";
              return (
                <div
                  key={remoteTab.key}
                  role="button"
                  tabIndex={0}
                  data-state={isCurrentRemote && !personalChatsRouteActive ? "active" : undefined}
                  data-remote-state={remoteTabState}
                  aria-current={isCurrentRemote ? "true" : undefined}
                  className={cn(
                    "ade-shell-project-tab group inline-flex w-[clamp(128px,16vw,220px)] max-w-[220px] min-w-0 shrink-0 items-center gap-1.5 px-2.5",
                    "font-semibold transition-[background-color,color,border-color,box-shadow,opacity] duration-150",
                    "cursor-pointer border",
                    remoteTabConnected
                      ? "border-[color-mix(in_srgb,var(--color-warning)_40%,transparent)]"
                      : remoteTabConnecting
                        ? "border-amber-400/60"
                        : "border-red-400/60",
                  )}
                  style={
                    { WebkitAppRegion: "no-drag" } as React.CSSProperties
                  }
                  title={`${remoteTab.runtimeName}: ${remoteTab.rootPath} (${remoteTabStatusLabel})`}
                  onClick={() => handleSwitchRemoteProject(remoteTab)}
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
                    readOnly={true}
                    iconDataUrlOverride={remoteTab.iconDataUrl ?? null}
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
                  ) : (
                    <DesktopTower
                      size={11}
                      weight="duotone"
                      className="shrink-0 text-[var(--color-warning)]"
                      aria-label={`Remote: ${remoteTab.runtimeName}`}
                    />
                  )}
                  <button
                    type="button"
                    className={cn(
                      "ade-shell-control ml-auto inline-flex h-4 w-4 shrink-0 items-center justify-center text-current",
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
            })}
            {projectTabs.map((rp, idx) => {
              const isCurrent =
                !remoteBinding && project?.rootPath === rp.rootPath;
              const isMissing = !rp.exists;
              const isRelocating = relocatingPath === rp.rootPath;
              const isSwitchTarget =
                projectTransition?.kind === "switching" &&
                projectTransition.rootPath === rp.rootPath;
              const isClosingTarget =
                projectTransition?.kind === "closing" && isCurrent;
              const isDragging = dragIdx === idx;
              const isDropTarget = dropIdx === idx && dragIdx !== idx;
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
              else if (isCurrent && !personalChatsRouteActive) projectTabState = "active";
              const indicator = terminalAttention?.indicator;
              return (
                <div
                  key={rp.rootPath}
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
                  draggable={!isMissing && !isRelocating && !isProjectBusy}
                  onDragStart={(e) => handleDragStart(e, idx, rp.rootPath)}
                  onDragOver={(e) => handleDragOver(e, idx)}
                  onDragLeave={handleDragLeave}
                  onDrop={(e) => handleDrop(e, idx)}
                  onDragEnd={(e) => handleDragEnd(e, rp.rootPath)}
                  className={cn(
                    "ade-shell-project-tab group inline-flex w-[clamp(128px,16vw,220px)] max-w-[220px] min-w-0 shrink-0 items-center gap-1.5 px-2.5",
                    "transition-[background-color,color,border-color,box-shadow,opacity] duration-150",
                    !isMissing && "cursor-pointer",
                    isCurrent && "font-semibold",
                    isRelocating && "pointer-events-none opacity-80",
                    (isSwitchTarget || isClosingTarget) &&
                      "pointer-events-none opacity-80",
                    isDragging && "opacity-40",
                    isDropTarget && "ring-1 ring-accent/50",
                  )}
                  style={projectTabStyle}
                  onClick={() => {
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
                    <span className="ml-auto inline-flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity duration-150">
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
                        "ade-shell-control ml-auto inline-flex h-4 w-4 shrink-0 items-center justify-center text-current",
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
            {isNewTabOpen && (
              <ShellNavTab
                active={!personalChatsRouteActive}
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
        {!webMode ? (
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
            remoteStatusCount > 0
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
        ) : null}
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

      {showPublishPill ? (
        <SmartTooltip
          content={{
            label: "Publish to GitHub",
            description:
              "Create a GitHub repository for this project and push the current branch.",
          }}
          wrapperStyle={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        >
          <button
            type="button"
            aria-label="Publish to GitHub"
            onClick={() => setPublishOpen(true)}
            disabled={isProjectBusy}
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
              cursor: isProjectBusy ? "not-allowed" : "pointer",
              opacity: isProjectBusy ? 0.55 : 1,
            }}
          >
            <UploadSimple size={11} weight="bold" />
            Publish
          </button>
        </SmartTooltip>
      ) : null}

      {projectTransitionLabel ? (
        <div
          className={cn(
            "ade-shell-control shrink-0 inline-flex items-center gap-1.5 rounded-md px-2.5 py-1",
            "text-[11px] font-medium",
          )}
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          title={projectTransitionLabel}
        >
          <CircleNotch size={12} weight="bold" className="animate-spin" />
          <span className="max-w-[240px] truncate">
            {projectTransitionLabel}
          </span>
        </div>
      ) : null}

      {!projectTransitionLabel && projectTransitionError ? (
        <div
          className={cn(
            "ade-shell-control shrink-0 inline-flex items-center gap-1.5 rounded-md px-2.5 py-1",
            "text-[11px] font-medium text-red-300",
          )}
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          title={projectTransitionError}
        >
          <span className="max-w-[320px] truncate">
            {projectTransitionError}
          </span>
          <button
            type="button"
            className="inline-flex h-4 w-4 items-center justify-center rounded-sm text-current opacity-80 transition-opacity hover:opacity-100"
            onClick={clearProjectTransitionError}
            title="Dismiss project error"
          >
            <X size={10} weight="regular" />
          </button>
        </div>
      ) : null}

      {/* Trailing controls: status · updates · utility cluster */}
      <div className="flex shrink-0 items-center gap-2">
        {/* App-global voice capture — visible from any tab while recording. */}
        <GlobalVoiceCaptureIndicator />

        <ResourcePressureIndicator usage={resourceUsage} />

        <div className="hidden md:flex items-center gap-1.5">
          {renderHeaderStatusControls()}
        </div>

        <HeaderStatusMenu
          remoteConnected={remoteConnected}
          syncConnected={syncConnected || (!webMode && webConnected)}
          showSyncControl={showSyncControl}
        >
          {(closeMenu) => renderHeaderStatusControls({ menuLayout: true, onActivate: closeMenu })}
        </HeaderStatusMenu>

        {!webMode ? <AutoUpdateControl /> : null}

        <div
          className="ade-shell-header-utility-cluster inline-flex shrink-0 items-center gap-px rounded-md border border-white/[0.08] bg-white/[0.03] p-px"
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        >
          <button
            type="button"
            className={cn(
              "ade-shell-control ade-shell-header-utility-btn inline-flex items-center justify-center",
              "transition-[background-color,color,border-color,box-shadow] duration-150",
            )}
            data-variant="ghost"
            onClick={() => setFeedbackOpen(true)}
            title="Report bug or suggest feature"
            aria-label="Report bug or suggest feature"
          >
            <ChatCircleDots size={13} weight="regular" />
          </button>

          <HelpMenu compact />

          <div className="inline-flex items-center gap-0">
            <button
              type="button"
              className={cn(
                "ade-shell-control ade-shell-header-utility-btn inline-flex items-center justify-center",
                "transition-[background-color,color,border-color,box-shadow] duration-150",
              )}
              data-variant="ghost"
              onClick={zoomOut}
              title="Zoom out"
              aria-label="Zoom out"
            >
              <Minus size={11} weight="bold" />
            </button>
            <span
              className={cn(
                "ade-shell-control-kbd ade-shell-header-utility-zoom inline-flex items-center justify-center border-x-0",
                "select-none text-center font-mono",
              )}
            >
              {zoom}%
            </span>
            <button
              type="button"
              className={cn(
                "ade-shell-control ade-shell-header-utility-btn inline-flex items-center justify-center",
                "transition-[background-color,color,border-color,box-shadow] duration-150",
              )}
              data-variant="ghost"
              onClick={zoomIn}
              title="Zoom in"
              aria-label="Zoom in"
            >
              <Plus size={11} weight="bold" />
            </button>
          </div>
        </div>
      </div>

      {/* Overlay panels & modals — kept outside the gap-6 wrapper so they
          never participate in flex gap accounting when toggled open. */}
      {typeof document !== "undefined"
        ? createPortal(
            <ConfirmDialog
              state={remoteDisconnectConfirmState}
              onClose={closeRemoteDisconnectConfirm}
            />,
            document.body,
          )
        : null}
      {typeof document !== "undefined"
        ? createPortal(
            <>
              {remotePanelOpen ? (
                <div
                  className="fixed inset-0 z-[120]"
                  style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
                  onClick={closeRemotePanel}
                >
                  <div
                    ref={remotePanelRef}
                    className={cn(
                      "absolute right-3 top-10 max-h-[calc(100vh-72px)] w-[min(820px,calc(100vw-24px))] overflow-y-auto",
                      "rounded-xl border border-white/10 bg-[color:var(--ade-shell-surface,#121019)] shadow-2xl shadow-black/45",
                    )}
                    role="dialog"
                    aria-modal="true"
                    aria-label="Remote machines"
                    tabIndex={-1}
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={handleRemotePanelKeyDown}
                  >
                    <button
                      type="button"
                      className="ade-shell-control absolute right-3 top-3 z-10 inline-flex h-7 w-7 items-center justify-center rounded-md"
                      data-variant="ghost"
                      onClick={closeRemotePanel}
                      title="Close remote machines"
                    >
                      <X size={13} weight="regular" />
                    </button>
                    <div className="p-4 pr-12">
                      <RemoteTargetList
                        onDisconnectRequested={handleRemoteTargetDisconnectRequested}
                        onRemoveRequested={handleRemoteTargetRemoveRequested}
                      />
                    </div>
                  </div>
                </div>
              ) : null}

              <HeaderSheet
                open={phoneSyncOpen}
                panelRef={phoneSyncPanelRef}
                icon={
                  <DeviceMobile
                    size={16}
                    weight="regular"
                    className="shrink-0 opacity-85"
                  />
                }
                title="Connect to the ADE mobile app"
                subtitle={syncLabel}
                headerActions={
                  <button
                    type="button"
                    className="ade-shell-control inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] font-semibold"
                    onClick={openMobileTestFlight}
                    title="Download ADE Mobile from TestFlight"
                  >
                    <ArrowSquareOut size={12} weight="regular" />
                    Download
                  </button>
                }
                onClose={closeSyncPanel}
                ariaLabelledBy="phone-sync-title"
                closeTitle="Close phone sync"
              >
                <div className="p-4">
                  <SyncDevicesSection variant="phone" />
                </div>
              </HeaderSheet>

              <HeaderSheet
                open={webSyncOpen}
                panelRef={webSyncPanelRef}
                icon={
                  <Globe
                    size={16}
                    weight="regular"
                    className="shrink-0 opacity-85"
                  />
                }
                title="Web client"
                subtitle={webSyncLabel}
                headerActions={
                  <button
                    type="button"
                    className="ade-shell-control inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] font-semibold"
                    onClick={openWebClient}
                    title="Open the ADE web client in your browser"
                  >
                    <ArrowSquareOut size={12} weight="regular" />
                    Open in browser
                  </button>
                }
                onClose={closeSyncPanel}
                ariaLabelledBy="web-sync-title"
                closeTitle="Close web client"
              >
                <div className="p-4">
                  <SyncDevicesSection variant="web" />
                </div>
              </HeaderSheet>
            </>,
            document.body,
          )
        : null}

      <FeedbackReporterModal
        open={feedbackOpen}
        onOpenChange={setFeedbackOpen}
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
