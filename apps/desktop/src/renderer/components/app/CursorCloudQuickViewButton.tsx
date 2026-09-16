import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Cursor } from "@lobehub/icons";

import type { CursorCloudFleetEvent } from "../../../shared/types";
import type { AiSettingsStatus } from "../../../shared/types/config";
import { useAppStore } from "../../state/appStore";
import {
  ADE_BROWSER_VIEW_OCCLUSION_END_EVENT,
  ADE_BROWSER_VIEW_OCCLUSION_START_EVENT,
} from "../../lib/workSidebarBrowserResize";
import { CursorCloudFleetModal } from "./CursorCloudFleetModal";

// Keep the entry point on the same visibility cadence as Linear. Both
// integrations are connection-gated and should appear/disappear together
// while a provider key is being verified or a remote runtime reconnects.
const INITIAL_VISIBILITY_CHECK_DELAY_MS = 2_000;
const VISIBILITY_RETRY_INTERVAL_MS = 3_000;
const REMOTE_VISIBILITY_RETRY_INTERVAL_MS = 15_000;
const VISIBILITY_CONNECTED_CACHE_TTL_MS = 60_000;
const VISIBILITY_DISCONNECTED_CACHE_TTL_MS = 1_500;
const CURSOR_BADGE_VIOLET = "#8B5CF6";
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
 * The fleet entry point only exists while a Cursor connection does. Reads the
 * provider connection status through the cached reader so opening Work never
 * pays an extra `ai.getStatus` in its startup window.
 */
function readCursorVisibilityCached(
  args: {
    projectRoot: string | null | undefined;
    reader: (() => Promise<AiSettingsStatus>) | undefined;
    force?: boolean;
  },
): Promise<boolean> {
  const { projectRoot, reader, force = false } = args;
  if (!projectRoot || !reader) return Promise.resolve(false);
  const now = Date.now();
  const existing = visibilityCacheByProject.get(projectRoot);
  const entry = existing && existing.reader === reader
    ? existing
    : { reader, value: false, checkedAtMs: 0, inFlight: null };
  visibilityCacheByProject.set(projectRoot, entry);
  if (entry.inFlight) return entry.inFlight;
  const ttl = entry.value ? VISIBILITY_CONNECTED_CACHE_TTL_MS : VISIBILITY_DISCONNECTED_CACHE_TTL_MS;
  if (!force && now - entry.checkedAtMs < ttl) return Promise.resolve(entry.value);

  entry.inFlight = Promise.resolve()
    .then(() => reader())
    .then((status) => {
      const nextValue = status.providerConnections?.cursor?.authAvailable === true;
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

export function CursorCloudQuickViewButton({
  variant = "icon",
  onMenuActivate,
}: {
  variant?: "icon" | "menu-row" | "sidebar-row";
  onMenuActivate?: () => void;
} = {}) {
  const project = useAppStore((s) => s.project);
  const projectBinding = useAppStore((s) => s.projectBinding);
  const activeProjectRoot =
    projectBinding?.kind === "remote" ? projectBinding.rootPath : project?.rootPath;
  const projectName = project?.displayName ?? null;

  const [visible, setVisible] = useState(false);
  const [open, setOpen] = useState(false);
  const [unreadFinished, setUnreadFinished] = useState(0);
  const openRef = useRef(open);
  openRef.current = open;

  const readCursorStatus = useCallback(() => window.ade.ai.getStatus(), []);

  const loadVisibility = useCallback(
    (force = false) => readCursorVisibilityCached({
      projectRoot: activeProjectRoot,
      reader: typeof window !== "undefined" && typeof window.ade?.ai?.getStatus === "function"
        ? readCursorStatus
        : undefined,
      force,
    }),
    [activeProjectRoot, readCursorStatus],
  );

  const shouldAutoCheckVisibility = Boolean(activeProjectRoot);
  const visibilityRetryIntervalMs = projectBinding?.kind === "remote"
    ? REMOTE_VISIBILITY_RETRY_INTERVAL_MS
    : VISIBILITY_RETRY_INTERVAL_MS;

  // Delayed, cached, bridge-triggered — never in the Work startup IPC window.
  useEffect(() => {
    setVisible(false);
    setOpen(false);
    setUnreadFinished(0);
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
  }, [activeProjectRoot, loadVisibility, shouldAutoCheckVisibility]);

  useEffect(() => {
    if (!shouldAutoCheckVisibility || visible) return undefined;
    let cancelled = false;
    let timer: number | null = null;
    // Queue the same delayed re-check on bridge-ready rather than firing an
    // immediate forced `ai.getStatus` — this must never land in the Work
    // startup IPC window. The timer is cancelled with the effect so a project
    // switch cannot let a stale probe resolve.
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
  }, [activeProjectRoot, visible, loadVisibility, shouldAutoCheckVisibility]);

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
  }, [activeProjectRoot, loadVisibility, shouldAutoCheckVisibility]);

  useEffect(() => {
    if (!shouldAutoCheckVisibility || visible || !activeProjectRoot) return undefined;
    let cancelled = false;
    const interval = window.setInterval(() => {
      void loadVisibility().then((next) => {
        if (!cancelled && next) {
          setVisible(true);
          window.clearInterval(interval);
        }
      });
    }, visibilityRetryIntervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [activeProjectRoot, loadVisibility, shouldAutoCheckVisibility, visibilityRetryIntervalMs, visible]);

  // Relay-driven finish badge. No polling: the same event that wakes the
  // fleet rows lights the pill when the modal is closed.
  useEffect(() => {
    if (!visible) return undefined;
    if (typeof window.ade?.ai?.onCursorCloudFleetEvent !== "function") return undefined;
    const unsubscribe = window.ade.ai.onCursorCloudFleetEvent((event: CursorCloudFleetEvent) => {
      if (!event?.agentId || openRef.current) return;
      if (String(event.status ?? "").toLowerCase() !== "finished") return;
      setUnreadFinished((current) => Math.min(current + 1, 99));
    });
    return unsubscribe;
  }, [visible]);

  useEffect(() => {
    if (open) setUnreadFinished(0);
  }, [open]);

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

  return (
    <>
      <button
        type="button"
        role={variant === "menu-row" ? "menuitem" : undefined}
        aria-label="Cursor Cloud fleet"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Cursor Cloud agents"
        data-cursor-cloud-button="true"
        data-state={open ? "open" : undefined}
        className={variant === "menu-row"
          ? HEADER_STATUS_MENU_ROW_CLASS
          : variant === "sidebar-row"
            ? `ade-shell-sidebar-item group relative flex w-full items-center transition-colors duration-100${open ? " bg-white/[0.08]" : ""}`
            : "ade-shell-control relative inline-flex h-[20px] w-[20px] items-center justify-center transition-[background-color,color,border-color,box-shadow] duration-150"}
        style={{
          WebkitAppRegion: "no-drag",
          color: open ? "#C4B5FD" : undefined,
        } as React.CSSProperties}
        onClick={handleToggle}
      >
        {variant === "sidebar-row" ? (
          <span className="ade-shell-sidebar-icon-slot flex shrink-0 items-center justify-center">
            <Cursor.Avatar size={20} />
          </span>
        ) : (
          <Cursor.Avatar size={variant === "menu-row" ? 12 : 13} />
        )}
        {variant !== "icon" ? <span className="ade-tab-label min-w-0 flex-1 truncate">Cursor Cloud</span> : null}
        {unreadFinished > 0 ? (
          <span
            className="absolute -right-1 -top-1 grid h-[13px] min-w-[13px] place-items-center rounded-full px-[3px] font-mono text-[8px] font-bold leading-none text-white"
            style={{ background: CURSOR_BADGE_VIOLET, boxShadow: "0 0 6px rgba(167,139,250,0.55)" }}
          >
            {unreadFinished > 9 ? "9+" : unreadFinished}
          </span>
        ) : null}
      </button>
      {open ? createPortal(
        <CursorCloudFleetModal
          projectRoot={activeProjectRoot ?? null}
          projectName={projectName}
          onClose={() => setOpen(false)}
        />,
        document.body,
      ) : null}
    </>
  );
}
