import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { DevinCloudAuthStatus } from "../../../shared/types";
import devinMark from "../../assets/provider-logos/devin.svg";
import { useAppStore } from "../../state/appStore";
import {
  ADE_BROWSER_VIEW_OCCLUSION_END_EVENT,
  ADE_BROWSER_VIEW_OCCLUSION_START_EVENT,
} from "../../lib/workSidebarBrowserResize";
import { DevinCloudFleetModal } from "./DevinCloudFleetModal";

// Keep the entry point on the same visibility cadence as Linear and Cursor.
// Both integrations are connection-gated and should appear/disappear together
// while a provider key is being verified or a remote runtime reconnects.
const INITIAL_VISIBILITY_CHECK_DELAY_MS = 2_000;
const VISIBILITY_RETRY_INTERVAL_MS = 3_000;
const REMOTE_VISIBILITY_RETRY_INTERVAL_MS = 15_000;
const VISIBILITY_CONNECTED_CACHE_TTL_MS = 60_000;
const VISIBILITY_DISCONNECTED_CACHE_TTL_MS = 1_500;
const HEADER_STATUS_MENU_ROW_CLASS =
  "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11px] font-medium text-muted-fg/80 transition-colors duration-150 hover:bg-white/[0.06] hover:text-fg/90";

type VisibilityCacheEntry = {
  reader: unknown;
  value: boolean;
  checkedAtMs: number;
  inFlight: Promise<boolean> | null;
};

const visibilityCacheByProject = new Map<string, VisibilityCacheEntry>();

/**
 * The fleet entry point only exists while a Devin API token does. Reads the
 * credential state through the cached reader so opening Work never pays an
 * extra auth probe in its startup window.
 */
function readDevinVisibilityCached(
  args: {
    cacheKey: string | null | undefined;
    reader: (() => Promise<DevinCloudAuthStatus>) | undefined;
    force?: boolean;
  },
): Promise<boolean> {
  const { cacheKey, reader, force = false } = args;
  if (!cacheKey || !reader) return Promise.resolve(false);
  const now = Date.now();
  const existing = visibilityCacheByProject.get(cacheKey);
  const entry = existing && existing.reader === reader
    ? existing
    : { reader, value: false, checkedAtMs: 0, inFlight: null };
  visibilityCacheByProject.set(cacheKey, entry);
  if (entry.inFlight) return entry.inFlight;
  const ttl = entry.value ? VISIBILITY_CONNECTED_CACHE_TTL_MS : VISIBILITY_DISCONNECTED_CACHE_TTL_MS;
  if (!force && now - entry.checkedAtMs < ttl) return Promise.resolve(entry.value);

  entry.inFlight = Promise.resolve()
    .then(() => reader())
    .then((status) => {
      const nextValue = status.configured === true;
      entry.value = nextValue;
      entry.checkedAtMs = Date.now();
      return nextValue;
    })
    .catch(() => {
      entry.value = false;
      entry.checkedAtMs = Date.now();
      return false;
    })
    .finally(() => {
      entry.inFlight = null;
    });
  return entry.inFlight;
}

export function DevinCloudQuickViewButton({
  variant = "icon",
  onMenuActivate,
}: {
  variant?: "icon" | "menu-row";
  onMenuActivate?: () => void;
} = {}) {
  const project = useAppStore((s) => s.project);
  const projectBinding = useAppStore((s) => s.projectBinding);
  const activeProjectRoot =
    projectBinding?.kind === "remote" ? projectBinding.rootPath : project?.rootPath;
  // Remote hosts can expose the same project root path. The binding key is the
  // host identity, so a disconnected result from one machine must never hide a
  // connected Devin Cloud entry on another machine.
  const activeProjectVisibilityKey = projectBinding?.key ?? activeProjectRoot;
  const projectName = project?.displayName ?? null;

  const [visible, setVisible] = useState(false);
  const [open, setOpen] = useState(false);
  const openRef = useRef(open);
  openRef.current = open;

  const readDevinAuthStatus = useCallback(
    () => window.ade.ai.devinCloudGetAuthStatus(),
    [],
  );

  const loadVisibility = useCallback(
    (force = false) => readDevinVisibilityCached({
      cacheKey: activeProjectVisibilityKey,
      reader: typeof window !== "undefined" && typeof window.ade?.ai?.devinCloudGetAuthStatus === "function"
        ? readDevinAuthStatus
        : undefined,
      force,
    }),
    [activeProjectVisibilityKey, readDevinAuthStatus],
  );

  const shouldAutoCheckVisibility = Boolean(activeProjectRoot);
  const visibilityRetryIntervalMs = projectBinding?.kind === "remote"
    ? REMOTE_VISIBILITY_RETRY_INTERVAL_MS
    : VISIBILITY_RETRY_INTERVAL_MS;

  // Delayed, cached, bridge-triggered — never in the Work startup IPC window.
  useEffect(() => {
    setVisible(false);
    setOpen(false);
    if (!shouldAutoCheckVisibility) return undefined;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void loadVisibility().then((next) => {
        if (!cancelled) setVisible(next);
      });
    }, INITIAL_VISIBILITY_CHECK_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activeProjectVisibilityKey, activeProjectRoot, loadVisibility, shouldAutoCheckVisibility]);

  useEffect(() => {
    if (!shouldAutoCheckVisibility || visible) return undefined;
    let cancelled = false;
    let timer: number | null = null;
    // Queue the same delayed re-check on bridge-ready rather than firing an
    // immediate auth probe — this must never land in the Work startup IPC
    // window. The timer is cancelled with the effect so a project switch
    // cannot let a stale probe resolve.
    const queue = () => {
      if (timer != null) return;
      timer = window.setTimeout(() => {
        timer = null;
        if (cancelled) return;
        void loadVisibility(true).then((next) => {
          if (!cancelled) setVisible(next);
        });
      }, INITIAL_VISIBILITY_CHECK_DELAY_MS);
    };
    if ((window as { __adeRuntimeBridge?: unknown }).__adeRuntimeBridge) queue();
    window.addEventListener("ade:runtime-bridge-ready", queue);
    return () => {
      cancelled = true;
      if (timer != null) window.clearTimeout(timer);
      window.removeEventListener("ade:runtime-bridge-ready", queue);
    };
  }, [activeProjectVisibilityKey, activeProjectRoot, visible, loadVisibility, shouldAutoCheckVisibility]);

  useEffect(() => {
    if (!shouldAutoCheckVisibility || !activeProjectRoot) return undefined;
    let cancelled = false;
    const refresh = () => {
      void loadVisibility(true).then((next) => {
        if (!cancelled) setVisible(next);
      });
    };
    window.addEventListener("focus", refresh);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", refresh);
    };
  }, [activeProjectVisibilityKey, activeProjectRoot, loadVisibility, shouldAutoCheckVisibility]);

  // Keep polling while connected too — at the cache's connected TTL, so a
  // credential removed in this same window hides the button within a minute
  // instead of surviving until the next focus event or remount.
  useEffect(() => {
    if (!shouldAutoCheckVisibility || !activeProjectRoot) return undefined;
    let cancelled = false;
    const interval = window.setInterval(() => {
      void loadVisibility().then((next) => {
        if (!cancelled) setVisible(next);
      });
    }, visible ? VISIBILITY_CONNECTED_CACHE_TTL_MS : visibilityRetryIntervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [activeProjectVisibilityKey, activeProjectRoot, loadVisibility, shouldAutoCheckVisibility, visibilityRetryIntervalMs, visible]);

  const occludesNativeBrowser = open;

  useEffect(() => {
    if (!occludesNativeBrowser || typeof window === "undefined") return undefined;
    window.dispatchEvent(new Event(ADE_BROWSER_VIEW_OCCLUSION_START_EVENT));
    return () => {
      window.dispatchEvent(new Event(ADE_BROWSER_VIEW_OCCLUSION_END_EVENT));
    };
  }, [occludesNativeBrowser]);

  if (!visible) return null;

  const handleToggle = () => {
    setOpen((current) => !current);
    onMenuActivate?.();
  };

  const iconSize = variant === "menu-row" ? 12 : 13;
  const icon = (
    <img
      src={devinMark}
      alt=""
      aria-hidden
      className="rounded-[3px]"
      style={{ width: iconSize, height: iconSize }}
    />
  );

  return (
    <>
      <button
        type="button"
        role={variant === "menu-row" ? "menuitem" : undefined}
        aria-label="Devin Cloud fleet"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Devin Cloud sessions"
        data-devin-cloud-button="true"
        data-state={open ? "open" : undefined}
        className={variant === "menu-row"
          ? HEADER_STATUS_MENU_ROW_CLASS
          : "ade-shell-control relative inline-flex h-[20px] w-[20px] items-center justify-center transition-[background-color,color,border-color,box-shadow] duration-150"}
        style={{
          WebkitAppRegion: "no-drag",
        } as React.CSSProperties}
        onClick={handleToggle}
      >
        {icon}
        {variant !== "icon" ? <span className="ade-tab-label min-w-0 flex-1 truncate">Devin Cloud</span> : null}
      </button>
      {open ? createPortal(
        <DevinCloudFleetModal
          projectRoot={activeProjectRoot ?? null}
          projectName={projectName}
          onClose={() => setOpen(false)}
        />,
        document.body,
      ) : null}
    </>
  );
}
