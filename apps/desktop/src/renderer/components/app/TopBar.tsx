import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowSquareOut,
  ChatCircleDots,
  CircleNotch,
  DesktopTower,
  DeviceMobile,
  Folder,
  FolderOpen,
  Plus,
  Minus,
  Trash,
  UploadSimple,
  X,
} from "@phosphor-icons/react";
import * as Dialog from "@radix-ui/react-dialog";

import { useAppStore } from "../../state/appStore";
import { isRunOwnedSession } from "../../lib/sessions";
import { useGithubProjectRemote } from "../../lib/useGithubProjectRemote";
import {
  ZOOM_LEVEL_KEY,
  MIN_ZOOM_LEVEL,
  MAX_ZOOM_LEVEL,
  displayZoomToLevel,
  getStoredZoomLevel,
} from "../../lib/zoom";
import { cn } from "../ui/cn";
import { SmartTooltip } from "../ui/SmartTooltip";
import type {
  ProcessRuntime,
  ProjectIcon,
  OpenProjectBinding,
  RecentProjectSummary,
  RemoteRuntimeConnectionSnapshot,
  SyncRoleSnapshot,
} from "../../../shared/types";
import { AutoUpdateControl } from "./AutoUpdateControl";
import { FeedbackReporterModal } from "./FeedbackReporterModal";
import { HelpMenu } from "../onboarding/HelpMenu";
import { LinearQuickViewButton } from "./LinearQuickViewButton";
import { PublishToGitHubDialog } from "../projects/PublishToGitHubDialog";
import { RemoteTargetList } from "../remoteTargets/RemoteTargetList";
import { SyncDevicesSection } from "../settings/SyncDevicesSection";
import { HeaderUsageControl } from "../usage/HeaderUsageControl";

const RUNNING_LANE_PROCESS_STATES: ProcessRuntime["status"][] = [
  "starting",
  "running",
  "degraded",
];
const ADE_PROJECT_TAB_ROOT_MIME = "application/x-ade-project-root";
const ADE_PROJECT_TAB_WINDOW_MIME = "application/x-ade-window-id";

// Bounded LRU so we don't accumulate icons for every project ever opened in
// long-lived sessions. 24 entries keeps the working set hot for typical usage
// (current project + a few recents in the tab list) without unbounded growth.
const PROJECT_ICON_CACHE_MAX = 24;
const projectIconCache = new Map<string, ProjectIcon>();
const PROJECT_ICON_ACCENT_CACHE_MAX = 48;
const projectIconAccentCache = new Map<string, string | null>();
const RECENT_PROJECTS_CACHE_TTL_MS = 2_500;
const PHONE_SYNC_STARTUP_DELAY_MS = 5_000;
let recentProjectsCache:
  | { rows: RecentProjectSummary[]; fetchedAtMs: number }
  | null = null;
let recentProjectsInFlight: Promise<RecentProjectSummary[]> | null = null;
let recentProjectsCacheSource:
  | (() => Promise<RecentProjectSummary[]>)
  | null = null;
type RemoteProjectTab = Extract<OpenProjectBinding, { kind: "remote" }>;

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
function setProjectIconAccentCache(
  cacheKey: string,
  color: string | null,
): void {
  if (projectIconAccentCache.has(cacheKey)) {
    projectIconAccentCache.delete(cacheKey);
  } else if (projectIconAccentCache.size >= PROJECT_ICON_ACCENT_CACHE_MAX) {
    const oldestKey = projectIconAccentCache.keys().next().value;
    if (oldestKey !== undefined) projectIconAccentCache.delete(oldestKey);
  }
  projectIconAccentCache.set(cacheKey, color);
}

function toHexByte(value: number): string {
  return Math.max(0, Math.min(255, Math.round(value)))
    .toString(16)
    .padStart(2, "0");
}

function balancedAccentColor(red: number, green: number, blue: number): string {
  const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  let mixTarget = 0;
  let mixAmount = 0;
  if (luminance < 64) {
    mixTarget = 255;
    mixAmount = 0.34;
  } else if (luminance > 214) {
    mixTarget = 0;
    mixAmount = 0.22;
  }
  const mix = (channel: number) => channel + (mixTarget - channel) * mixAmount;
  return `#${toHexByte(mix(red))}${toHexByte(mix(green))}${toHexByte(mix(blue))}`;
}

async function deriveIconAccentColor(dataUrl: string): Promise<string | null> {
  if (projectIconAccentCache.has(dataUrl))
    return projectIconAccentCache.get(dataUrl) ?? null;
  if (typeof document === "undefined" || typeof Image === "undefined")
    return null;

  const color = await new Promise<string | null>((resolve) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        const width = Math.max(
          1,
          Math.min(24, image.naturalWidth || image.width || 24),
        );
        const height = Math.max(
          1,
          Math.min(24, image.naturalHeight || image.height || 24),
        );
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) {
          resolve(null);
          return;
        }
        ctx.clearRect(0, 0, width, height);
        ctx.drawImage(image, 0, 0, width, height);
        const pixels = ctx.getImageData(0, 0, width, height).data;
        let redTotal = 0;
        let greenTotal = 0;
        let blueTotal = 0;
        let weightTotal = 0;
        for (let index = 0; index < pixels.length; index += 4) {
          const alpha = pixels[index + 3] / 255;
          if (alpha < 0.25) continue;
          const red = pixels[index];
          const green = pixels[index + 1];
          const blue = pixels[index + 2];
          const max = Math.max(red, green, blue);
          const min = Math.min(red, green, blue);
          const saturation = max === 0 ? 0 : (max - min) / max;
          const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
          if (saturation < 0.08 && (luminance < 28 || luminance > 230))
            continue;
          const weight = alpha * (0.18 + saturation * 1.65);
          redTotal += red * weight;
          greenTotal += green * weight;
          blueTotal += blue * weight;
          weightTotal += weight;
        }
        if (weightTotal <= 0) {
          resolve(null);
          return;
        }
        resolve(
          balancedAccentColor(
            redTotal / weightTotal,
            greenTotal / weightTotal,
            blueTotal / weightTotal,
          ),
        );
      } catch {
        resolve(null);
      }
    };
    image.onerror = () => resolve(null);
    image.src = dataUrl;
  });

  setProjectIconAccentCache(dataUrl, color);
  return color;
}
const PHONE_SYNC_FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function getFocusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(PHONE_SYNC_FOCUSABLE_SELECTOR),
  ).filter(
    (element) =>
      element.getAttribute("aria-hidden") !== "true" &&
      !element.hasAttribute("disabled") &&
      element.tabIndex >= 0,
  );
}

function syncDotClass(snapshot: SyncRoleSnapshot): string {
  if (snapshot.client.state === "error") return "ade-status-dot-error";
  if (snapshot.client.state === "connected" || snapshot.role === "brain")
    return "ade-status-dot-active";
  return "ade-status-dot-warning";
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
  const unavailableReason = typeof snapshot.localDevice.metadata?.unavailableReason === "string"
    ? snapshot.localDevice.metadata.unavailableReason
    : null;
  if (
    unavailableReason === "local_runtime_daemon_disabled"
    || snapshot.localDevice.deviceId === "local-runtime-disabled"
  ) {
    return "Phone sync unavailable";
  }
  if (snapshot.client.state === "error") return "Phone sync error";
  if (snapshot.role === "brain") {
    const count = snapshot.connectedPeers.length;
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
  onAccentColorChange,
}: {
  rootPath: string;
  isCurrent: boolean;
  animate: boolean;
  disabled: boolean;
  readOnly?: boolean;
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

  useEffect(() => {
    setFailed(false);
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
  }, [disabled, isCurrent, rootPath]);

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
      size={16}
      weight="regular"
      className={cn(
        "shrink-0 transition-opacity duration-150",
        isCurrent ? "opacity-90" : "opacity-70",
        animate && "animate-pulse",
      )}
    />
  );

  const iconNode =
    !icon?.dataUrl || failed ? (
      fallbackIcon
    ) : (
      <img
        src={icon.dataUrl}
        alt=""
        className={cn(
          "h-[18px] w-[18px] shrink-0 rounded-[4px] object-contain transition-opacity duration-150",
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
          "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[5px] text-current",
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
            "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[5px]",
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

export function TopBar() {
  const project = useAppStore((s) => s.project);
  const projectBinding = useAppStore((s) => s.projectBinding);
  const projectHydrated = useAppStore((s) => s.projectHydrated);
  const showWelcome = useAppStore((s) => s.showWelcome);
  const closeProject = useAppStore((s) => s.closeProject);
  const terminalAttention = useAppStore((s) => s.terminalAttention);
  const openRepo = useAppStore((s) => s.openRepo);
  const isNewTabOpen = useAppStore((s) => s.isNewTabOpen);
  const openNewTab = useAppStore((s) => s.openNewTab);
  const cancelNewTab = useAppStore((s) => s.cancelNewTab);
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
  const [projectAccentColors, setProjectAccentColors] = useState<
    Record<string, string | null>
  >({});
  const [relocatingPath, setRelocatingPath] = useState<string | null>(null);
  const [zoom, setZoom] = useState(getStoredZoomLevel);
  const [syncSnapshot, setSyncSnapshot] = useState<SyncRoleSnapshot | null>(
    null,
  );
  const [phoneSyncOpen, setPhoneSyncOpen] = useState(false);
  const [remotePanelOpen, setRemotePanelOpen] = useState(false);
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
  const remotePanelRef = useRef<HTMLDivElement | null>(null);
  const dragCounterRef = useRef(0);
  const isProjectBusy = projectTransition != null || relocatingPath != null;
  const remoteBinding =
    projectBinding?.kind === "remote" ? projectBinding : null;
  const workspaceProjectOpen =
    projectHydrated === true &&
    showWelcome !== true &&
    isNewTabOpen !== true &&
    Boolean(project?.rootPath) &&
    !remoteBinding;

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
  const remoteButtonLabel =
    connectedRemoteCount > 0 ? `Remote ${connectedRemoteCount}` : "Remote";
  const showSyncControl = workspaceProjectOpen;

  useEffect(() => {
    openProjectTabRootsRef.current = openProjectTabRoots;
  }, [openProjectTabRoots]);

  useEffect(() => {
    window.ade.app.setWindowProjectTabs(openProjectTabRoots).catch(() => {});
  }, [openProjectTabRoots]);

  useEffect(() => {
    openRemoteProjectTabsRef.current = openRemoteProjectTabs;
  }, [openRemoteProjectTabs]);

  const applyZoom = useCallback((pct: number) => {
    const clamped = Math.max(MIN_ZOOM_LEVEL, Math.min(MAX_ZOOM_LEVEL, pct));
    window.ade.zoom.setLevel(displayZoomToLevel(clamped));
    localStorage.setItem(ZOOM_LEVEL_KEY, String(clamped));
    setZoom(clamped);
  }, []);

  const zoomIn = useCallback(() => applyZoom(zoom + 10), [applyZoom, zoom]);
  const zoomOut = useCallback(() => applyZoom(zoom - 10), [applyZoom, zoom]);

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
      // Only wipe local tabs when the user has explicitly closed the project
      // (welcome screen visible, no remote binding, no transition in flight).
      // Otherwise we'd nuke other tabs whenever `project` is briefly null mid
      // open/switch/close.
      if (
        !remoteBinding &&
        projectTransition == null &&
        showWelcome === true
      ) {
        setOpenProjectTabRoots([]);
      }
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
  }, [project?.rootPath, remoteBinding, projectTransition, showWelcome]);

  useEffect(() => {
    if (!remoteBinding) return;
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
        const recent = recentProjects.find(
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
    [openProjectTabRoots, project, recentProjects],
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
          setOpenProjectTabRoots(session.openProjectTabs.map((entry) => entry.rootPath));
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
    if (!phoneSyncOpen) return;
    const frame = window.requestAnimationFrame(() => {
      phoneSyncPanelRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [phoneSyncOpen]);

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
    if (!remotePanelOpen) return;
    const frame = window.requestAnimationFrame(() => {
      remotePanelRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [remotePanelOpen]);

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
    if (!project?.rootPath || remoteBinding) {
      setSyncSnapshot(null);
      setPhoneSyncOpen(false);
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
    setSyncSnapshot(null);
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
      phoneSyncOpen ? 0 : PHONE_SYNC_STARTUP_DELAY_MS,
    );
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      if (startupTimer != null) window.clearTimeout(startupTimer);
      window.removeEventListener("focus", onFocus);
      disposeSyncEvents?.();
    };
    // Background projects don't broadcast sync-status events (main.ts filters
    // them to the active project), so we re-run this effect on rootPath change
    // and let the delayed startup check pick up the current state. Focus and
    // explicit drawer opens still refresh immediately.
  }, [phoneSyncOpen, project?.rootPath, remoteBinding]);

  const checkForActiveWorkloads = useCallback(
    async (projectRootPath: string): Promise<boolean> => {
      if (project?.rootPath !== projectRootPath) return true;

      try {
        const [lanes, runningSessions, agentChats, activeMissions] =
          await Promise.all([
            window.ade.lanes.list({ includeArchived: false }),
            window.ade.sessions.list({ status: "running" }),
            window.ade.agentChat.list(),
            window.ade.missions.list({ status: "active" }),
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
        if (activeMissions.length > 0) {
          warnings.push(
            `${activeMissions.length} active mission${activeMissions.length === 1 ? "" : "s"}`,
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
  }, [isProjectBusy, openNewTab]);

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
      setDragIdx(null);
      setDropIdx(null);
      if (!draggedOutside || droppedOnAdeTarget || !rootPath) return;

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

  const handlePhoneSyncDialogKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setPhoneSyncOpen(false);
        return;
      }
      if (event.key !== "Tab") return;

      const panel = phoneSyncPanelRef.current;
      if (!panel) return;
      const focusable = getFocusableElements(panel);
      if (focusable.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (document.activeElement === panel) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [],
  );

  const handleRemotePanelKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setRemotePanelOpen(false);
        return;
      }
      if (event.key !== "Tab") return;

      const panel = remotePanelRef.current;
      if (!panel) return;
      const focusable = getFocusableElements(panel);
      if (focusable.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (document.activeElement === panel) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [],
  );

  const syncLabel = deriveSyncLabel(syncSnapshot) ?? "Phone sync";
  const transitionTargetName = projectTransition?.rootPath
    ? (projectTabs.find(
        (entry) => entry.rootPath === projectTransition.rootPath,
      )?.displayName ??
      recentProjects.find(
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
        style={{ height: 26 }}
        draggable={false}
      />

      {/* Divider */}
      <div className="ade-shell-header-divider h-4 w-px shrink-0" />

      {/* Project tabs — the container stays draggable, only interactive elements opt out */}
      <div
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto scrollbar-none"
        onDragOver={handleProjectTabDragOver}
        onDrop={handleProjectTabDrop}
      >
        {openRemoteProjectTabs.length > 0 ||
        projectTabs.length > 0 ||
        isNewTabOpen ? (
          <>
            {openRemoteProjectTabs.map((remoteTab) => {
              const isCurrentRemote = remoteBinding?.key === remoteTab.key;
              return (
                <div
                  key={remoteTab.key}
                  role="button"
                  tabIndex={0}
                  data-state={isCurrentRemote ? "active" : undefined}
                  aria-current={isCurrentRemote ? "true" : undefined}
                  className={cn(
                    "ade-shell-project-tab group inline-flex w-[clamp(128px,16vw,220px)] max-w-[220px] min-w-0 shrink-0 items-center gap-2 px-3 py-0.5",
                    "font-semibold transition-[background-color,color,border-color,box-shadow,opacity] duration-150",
                    "cursor-pointer border border-warning/40",
                  )}
                  style={
                    { WebkitAppRegion: "no-drag" } as React.CSSProperties
                  }
                  title={`${remoteTab.runtimeName}: ${remoteTab.rootPath}`}
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
                  />
                  <span className="min-w-0 flex-1 truncate text-center text-[12px]">
                    {remoteTab.displayName}
                  </span>
                  <DesktopTower
                    size={11}
                    weight="duotone"
                    className="shrink-0 text-warning"
                    aria-label={`Remote: ${remoteTab.runtimeName}`}
                  />
                  <button
                    type="button"
                    className={cn(
                      "ade-shell-control ml-auto inline-flex h-5 w-5 shrink-0 items-center justify-center text-current",
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
              else if (isCurrent) projectTabState = "active";
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
                    "ade-shell-project-tab group inline-flex w-[clamp(128px,16vw,220px)] max-w-[220px] min-w-0 shrink-0 items-center gap-2 px-3 py-0.5",
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
                        className="ade-shell-control inline-flex h-5 w-5 items-center justify-center text-current transition-[background-color,color,border-color,box-shadow] duration-100"
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
                        className="ade-shell-control inline-flex h-5 w-5 items-center justify-center text-current transition-[background-color,color,border-color,box-shadow] duration-100"
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
                        "ade-shell-control ml-auto inline-flex h-5 w-5 shrink-0 items-center justify-center text-current",
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
            {isNewTabOpen && (
              <div
                className={cn(
                  "ade-shell-project-tab group inline-flex w-[clamp(128px,16vw,220px)] max-w-[220px] min-w-0 items-center gap-2 px-3 py-0.5",
                  "transition-[background-color,color,border-color,box-shadow] duration-150",
                  "font-semibold",
                )}
                data-state="active"
                style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
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
                <button
                  type="button"
                  className={cn(
                    "ade-shell-control ml-auto inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm",
                    "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity duration-150",
                  )}
                  data-variant="ghost"
                  disabled={isProjectBusy}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (isProjectBusy) return;
                    cancelNewTab();
                  }}
                  title="Close new tab"
                >
                  <X size={11} weight="regular" />
                </button>
              </div>
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
            connectedRemoteCount > 0
              ? `${connectedRemoteCount} remote device${connectedRemoteCount === 1 ? "" : "s"} available`
              : "Open another project"
          }
          style={
            {
              WebkitAppRegion: "no-drag",
              ...(connectedRemoteCount > 0
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

      {/* Trailing groups: status · actions · view, gap-6 between, gap-2 within */}
      <div className="flex items-center gap-6 shrink-0">
      <div className="flex items-center gap-2">
      <LinearQuickViewButton />

      <button
        type="button"
        className={cn(
          "ade-shell-control shrink-0 inline-flex items-center gap-1.5 rounded-md px-2.5 py-1",
          "text-[11px] font-medium transition-colors duration-150",
        )}
        style={
          {
            WebkitAppRegion: "no-drag",
            color: "#FBBF24",
            background:
              connectedRemoteCount > 0
                ? "rgba(245,158,11,0.16)"
                : "rgba(245,158,11,0.08)",
            border: "1px solid rgba(245,158,11,0.34)",
            boxShadow:
              connectedRemoteCount > 0
                ? "0 0 18px -8px rgba(245,158,11,0.9)"
                : undefined,
          } as React.CSSProperties
        }
        title="Manage remote machines"
        aria-expanded={remotePanelOpen}
        onClick={() => setRemotePanelOpen((open) => !open)}
      >
        <DesktopTower
          size={12}
          weight="regular"
          className="shrink-0 opacity-90"
        />
        <span
          className={cn(
            "ade-status-dot h-1.5 w-1.5 shrink-0",
            connectedRemoteCount > 0 ? "bg-emerald-400" : "bg-amber-400/65",
          )}
        />
        {remoteButtonLabel}
      </button>

      {showSyncControl ? (
        <button
          type="button"
          className={cn(
            "ade-shell-control shrink-0 inline-flex items-center gap-1.5 rounded-md px-2.5 py-1",
            "text-[11px] font-medium transition-colors duration-150",
          )}
          data-variant="ghost"
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          title="Connect a phone to this machine"
          aria-expanded={phoneSyncOpen}
          onClick={() => setPhoneSyncOpen((open) => !open)}
        >
          <DeviceMobile
            size={12}
            weight="regular"
            className="shrink-0 opacity-85"
          />
          <span
            className={cn(
              "ade-status-dot h-1.5 w-1.5 shrink-0",
              syncSnapshot ? syncDotClass(syncSnapshot) : "bg-white/30",
            )}
          />
          {syncLabel}
        </button>
      ) : null}

      <HeaderUsageControl />
      </div>
      {/* /status group */}

      <div className="flex items-center gap-2">
      <AutoUpdateControl />

      <HelpMenu />

      <button
        type="button"
        className={cn(
          "ade-shell-control inline-flex h-[20px] w-[20px] items-center justify-center",
          "transition-[background-color,color,border-color,box-shadow] duration-150",
        )}
        onClick={() => setFeedbackOpen(true)}
        title="Report bug or suggest feature"
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      >
        <ChatCircleDots size={12} weight="regular" />
      </button>
      </div>
      {/* /actions group */}

      {/* Zoom controls (view group) */}
      <div
        className="shrink-0 inline-flex items-center gap-0"
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      >
        <button
          type="button"
          className={cn(
            "ade-shell-control inline-flex h-[20px] w-[20px] items-center justify-center",
            "transition-[background-color,color,border-color,box-shadow] duration-150",
          )}
          onClick={zoomOut}
          title="Zoom out"
        >
          <Minus size={12} weight="bold" />
        </button>
        <span
          className={cn(
            "ade-shell-control-kbd inline-flex h-[20px] items-center justify-center border-x-0 px-1.5",
            "text-[10px] font-mono select-none",
            "min-w-[36px] text-center",
          )}
        >
          {zoom}%
        </span>
        <button
          type="button"
          className={cn(
            "ade-shell-control inline-flex h-[20px] w-[20px] items-center justify-center",
            "transition-[background-color,color,border-color,box-shadow] duration-150",
          )}
          onClick={zoomIn}
          title="Zoom in"
        >
          <Plus size={12} weight="bold" />
        </button>
      </div>
      </div>
      {/* /trailing groups */}

      {/* Overlay panels & modals — kept outside the gap-6 wrapper so they
          never participate in flex gap accounting when toggled open. */}
      {remotePanelOpen ? (
        <div
          className="fixed inset-0 z-[80]"
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          onClick={() => setRemotePanelOpen(false)}
        >
          <div
            ref={remotePanelRef}
            className={cn(
              "absolute right-3 top-10 max-h-[calc(100vh-72px)] w-[min(820px,calc(100vw-24px))] overflow-y-auto",
              "rounded-xl border border-white/10 bg-[color:var(--ade-shell-surface,#121019)] shadow-2xl shadow-black/45",
            )}
            role="dialog"
            aria-modal="true"
            aria-labelledby="remote-connections-title"
            tabIndex={-1}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={handleRemotePanelKeyDown}
          >
            <div className="sticky top-0 z-10 flex items-center justify-between border-b border-white/10 bg-[color:var(--ade-shell-surface,#121019)] px-4 py-3">
              <div className="flex min-w-0 items-center gap-2">
                <DesktopTower
                  size={16}
                  weight="regular"
                  className="shrink-0 text-[#FBBF24]"
                />
                <div className="min-w-0">
                  <div
                    id="remote-connections-title"
                    className="truncate text-[13px] font-semibold"
                  >
                    Remote machines
                  </div>
                  <div className="truncate text-[11px] text-white/55">
                    {connectedRemoteCount} connected
                  </div>
                </div>
              </div>
              <button
                type="button"
                className="ade-shell-control inline-flex h-7 w-7 items-center justify-center rounded-md"
                data-variant="ghost"
                onClick={() => setRemotePanelOpen(false)}
                title="Close remote machines"
              >
                <X size={13} weight="regular" />
              </button>
            </div>
            <div className="p-4">
              <RemoteTargetList />
            </div>
          </div>
        </div>
      ) : null}

      {phoneSyncOpen ? (
        <div
          className="fixed inset-0 z-[80]"
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          onClick={() => setPhoneSyncOpen(false)}
        >
          <div
            ref={phoneSyncPanelRef}
            className={cn(
              "absolute right-3 top-10 max-h-[calc(100vh-72px)] w-[min(620px,calc(100vw-24px))] overflow-y-auto",
              "rounded-xl border border-white/10 bg-[color:var(--ade-shell-surface,#121019)] shadow-2xl shadow-black/45",
            )}
            role="dialog"
            aria-modal="true"
            aria-labelledby="phone-sync-title"
            tabIndex={-1}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={handlePhoneSyncDialogKeyDown}
          >
            <div className="sticky top-0 z-10 flex items-center justify-between border-b border-white/10 bg-[color:var(--ade-shell-surface,#121019)] px-4 py-3">
              <div className="flex min-w-0 items-center gap-2">
                <DeviceMobile
                  size={16}
                  weight="regular"
                  className="shrink-0 opacity-85"
                />
                <div className="min-w-0">
                  <div
                    id="phone-sync-title"
                    className="truncate text-[13px] font-semibold"
                  >
                    Connect to the ADE mobile app
                  </div>
                  <div className="truncate text-[11px] text-white/55">
                    {syncLabel}
                  </div>
                </div>
              </div>
              <button
                type="button"
                className="ade-shell-control inline-flex h-7 w-7 items-center justify-center rounded-md"
                data-variant="ghost"
                onClick={() => setPhoneSyncOpen(false)}
                title="Close phone sync"
              >
                <X size={13} weight="regular" />
              </button>
            </div>
            <div className="p-4">
              <SyncDevicesSection />
            </div>
          </div>
        </div>
      ) : null}

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
