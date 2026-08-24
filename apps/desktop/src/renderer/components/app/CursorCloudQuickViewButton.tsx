import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Cursor } from "@lobehub/icons";

import type { CursorCloudFleetEvent } from "../../../shared/types";
import { useAppStore } from "../../state/appStore";
import {
  ADE_BROWSER_VIEW_OCCLUSION_END_EVENT,
  ADE_BROWSER_VIEW_OCCLUSION_START_EVENT,
} from "../../lib/workSidebarBrowserResize";
import { CursorCloudFleetModal } from "./CursorCloudFleetModal";

const INITIAL_VISIBILITY_CHECK_DELAY_MS = 4_000;
const VISIBILITY_CONNECTED_CACHE_TTL_MS = 120_000;
const VISIBILITY_DISCONNECTED_CACHE_TTL_MS = 5_000;
const CURSOR_BADGE_VIOLET = "#8B5CF6";

type VisibilityCacheEntry = {
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
  projectRoot: string | null | undefined,
  force = false,
): Promise<boolean> {
  if (!projectRoot) return Promise.resolve(false);
  const now = Date.now();
  const entry = visibilityCacheByProject.get(projectRoot)
    ?? { value: false, checkedAtMs: 0, inFlight: null };
  visibilityCacheByProject.set(projectRoot, entry);
  if (entry.inFlight) return entry.inFlight;
  const ttl = entry.value ? VISIBILITY_CONNECTED_CACHE_TTL_MS : VISIBILITY_DISCONNECTED_CACHE_TTL_MS;
  if (!force && now - entry.checkedAtMs < ttl) return Promise.resolve(entry.value);

  entry.inFlight = window.ade.ai
    .getStatus()
    .then((status) => {
      const nextValue = status.providerConnections?.cursor?.authAvailable === true
        || status.availableProviders.cursor === true;
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

export function CursorCloudQuickViewButton() {
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

  const loadVisibility = useCallback(
    (force = false) => readCursorVisibilityCached(activeProjectRoot, force),
    [activeProjectRoot],
  );

  // Delayed, cached, bridge-triggered — never in the Work startup IPC window.
  useEffect(() => {
    setVisible(false);
    setOpen(false);
    setUnreadFinished(0);
    if (!activeProjectRoot) return undefined;
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
  }, [activeProjectRoot, loadVisibility]);

  useEffect(() => {
    if (!activeProjectRoot || visible) return undefined;
    // Queue the same delayed re-check on bridge-ready rather than firing an
    // immediate forced `ai.getStatus` — this must never land in the Work
    // startup IPC window.
    const queue = () => {
      window.setTimeout(() => {
        void loadVisibility(true).then((next) => setVisible(next));
      }, INITIAL_VISIBILITY_CHECK_DELAY_MS);
    };
    if ((window as { __adeRuntimeBridge?: unknown }).__adeRuntimeBridge) queue();
    window.addEventListener("ade:runtime-bridge-ready", queue);
    return () => window.removeEventListener("ade:runtime-bridge-ready", queue);
  }, [activeProjectRoot, visible, loadVisibility]);

  // Relay-driven finish badge. No polling: the same event that wakes the
  // fleet rows lights the pill when the modal is closed.
  useEffect(() => {
    if (!visible) return undefined;
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

  return (
    <>
      <button
        type="button"
        aria-label="Cursor Cloud fleet"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Cursor Cloud agents"
        data-cursor-cloud-button="true"
        className="relative inline-flex h-[20px] w-[20px] items-center justify-center rounded-md transition-[background-color,color,box-shadow] duration-150 hover:bg-white/[0.08]"
        style={{
          WebkitAppRegion: "no-drag",
          color: open ? "#C4B5FD" : "rgba(255,255,255,0.55)",
        } as React.CSSProperties}
        onClick={() => setOpen((current) => !current)}
      >
        <Cursor.Avatar size={13} />
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
