import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowClockwise,
  ArrowRight,
  BellRinging,
  BellSimpleSlash,
  WarningCircle,
  WifiHigh,
  WifiSlash,
  X,
} from "@phosphor-icons/react";

import {
  attentionDestinationDeepLink,
  type AttentionItem,
  type AttentionNotchHealth,
} from "../../../shared/types";
import { useAccountStatus } from "../../lib/account";
import { relativeWhen } from "../../lib/format";
import { openAdeDeeplink } from "../../lib/openExternal";
import {
  ADE_BROWSER_VIEW_OCCLUSION_END_EVENT,
  ADE_BROWSER_VIEW_OCCLUSION_START_EVENT,
} from "../../lib/workSidebarBrowserResize";
import {
  acknowledgeActivityItem,
  activityStore,
  selectActivityHideDetails,
  useActivityStore,
} from "../../state/activityStore";
import { useDialogFocusTrap } from "../app/HeaderSheet";
import { cn } from "../ui/cn";
import { ActivityCard } from "./ActivityCard";
import { ActivitySettingsPopover } from "./ActivitySettingsPopover";
import {
  ACTIVITY_SECTION_TONE,
  activityTriggerLabel,
  summarizeActivity,
  type ActivitySection,
} from "./activityPriority";
import { refreshActivitySnapshot } from "./useActivitySync";
import "./HeaderActivityControl.css";

/**
 * Rows shown per section before the overflow line hands off to the pane. Six,
 * not four: the sections are now priority-flat, so a single "Working" section
 * routinely carries what three buckets used to split.
 */
const MAX_ROWS_PER_SECTION = 6;
const RELATIVE_TIME_TICK_MS = 30_000;
const IDLE_TICK_MS = 120_000;

function navigationErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  return "ADE couldn’t open the exact machine and project for this item.";
}

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function ActivityHeaderSection({
  section,
  hideDetails,
  onOpenItem,
  onOpenPane,
}: {
  section: ActivitySection;
  hideDetails: boolean;
  onOpenItem: (item: AttentionItem) => void;
  onOpenPane: () => void;
}) {
  const shown = section.items.slice(0, MAX_ROWS_PER_SECTION);
  const overflow = section.items.length - shown.length;
  return (
    <section
      data-activity-section={section.id}
      className={cn("activity-hdr-section", `activity-tone-${ACTIVITY_SECTION_TONE[section.id]}`)}
    >
      <h3 className="activity-hdr-section-heading">
        <span className="activity-hdr-section-dot" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{section.label}</span>
        <span className="activity-hdr-section-count">{section.items.length}</span>
      </h3>
      {shown.map((item) => (
        <ActivityCard
          key={item.id}
          item={item}
          hideDetails={hideDetails}
          onOpen={onOpenItem}
        />
      ))}
      {overflow > 0 ? (
        <button type="button" className="activity-hdr-overflow" onClick={onOpenPane}>
          {overflow} more
          <ArrowRight size={11} weight="bold" />
        </button>
      ) : null}
    </section>
  );
}

/**
 * Account-wide Activity, promoted into the global header so live work, things
 * that need you, and finished-but-unreviewed outcomes are one glance away from
 * every tab and every project. Three priority-flat sections — needs you,
 * working, done — and a handoff to the full pane for everything past the cap.
 */
export function HeaderActivityControl({
  onOpenPane,
}: {
  /** Opens the full Activity surface — the shell owns how. */
  onOpenPane: () => void;
}) {
  const itemsById = useActivityStore((state) => state.itemsById);
  const syncStatus = useActivityStore((state) => state.syncStatus);
  const syncError = useActivityStore((state) => state.syncError);
  const generatedAt = useActivityStore((state) => state.generatedAt);
  const availability = useActivityStore((state) => state.availability);
  const hideDetails = useActivityStore(selectActivityHideDetails);
  const { status: accountStatus, loading: accountLoading } = useAccountStatus();
  const signedIn = accountStatus.signedIn;

  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const [notchHealth, setNotchHealth] = useState<AttentionNotchHealth | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const summary = useMemo(() => summarizeActivity(itemsById, now), [itemsById, now]);

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  const openPopover = useCallback(() => {
    setOpen(true);
    // Event name, properties and dedupe key are deliberately unchanged through
    // the Attention → Activity rename: forking them would fork the PostHog
    // series and lose every comparison against the surface this replaces.
    void window.ade?.analytics?.capture({
      event: "ade_feature_used",
      properties: {
        feature: "attention",
        action: "header_opened",
        outcome: "opened",
        source: "renderer_route",
      },
      dedupeKey: "attention_header_opened",
      minimumIntervalMs: 60 * 60_000,
    }).catch(() => undefined);
  }, []);

  const trapKeyDown = useDialogFocusTrap(
    panelRef as React.RefObject<HTMLDivElement>,
    close,
    open,
  );

  // An expired item must stop being counted even if nobody opens the popover,
  // so the clock keeps moving while closed — just far more slowly, and never
  // while the window is hidden.
  useEffect(() => {
    setNow(Date.now());
    const period = open ? RELATIVE_TIME_TICK_MS : IDLE_TICK_MS;
    const timer = window.setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      setNow(Date.now());
    }, period);
    return () => window.clearInterval(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setNavigationError(null);
    void refreshActivitySnapshot();
    void window.ade?.attentionNotch?.getHealth?.()
      .then(setNotchHealth)
      .catch(() => setNotchHealth(null));
  }, [open]);

  useEffect(() => {
    activityStore.getState().setHeaderSurfaceVisible(open);
    return () => {
      activityStore.getState().setHeaderSurfaceVisible(false);
    };
  }, [open]);

  const retryNotch = useCallback(async () => {
    const retry = window.ade?.attentionNotch?.retry;
    if (!retry) return;
    setNotchHealth(await retry());
  }, []);

  // An embedded BrowserView paints above the DOM, so tell it to step aside for
  // as long as this popover is up.
  useEffect(() => {
    if (!open || typeof window === "undefined") return;
    window.dispatchEvent(new Event(ADE_BROWSER_VIEW_OCCLUSION_START_EVENT));
    return () => {
      window.dispatchEvent(new Event(ADE_BROWSER_VIEW_OCCLUSION_END_EVENT));
    };
  }, [open]);

  const openItem = useCallback(async (item: AttentionItem) => {
    setNavigationError(null);
    try {
      const bridge = typeof window !== "undefined" ? window.ade?.attention : null;
      if (bridge?.openItem) await bridge.openItem(item);
      else openAdeDeeplink(attentionDestinationDeepLink(item.destination, item));
    } catch (error) {
      setNavigationError(navigationErrorMessage(error));
      return;
    }
    // Only a destination that actually resolved earns the item leaving unseen.
    await acknowledgeActivityItem(item.id, "seen").catch(() => {});
    setOpen(false);
  }, []);

  const openPane = useCallback(() => {
    setOpen(false);
    onOpenPane();
  }, [onOpenPane]);

  const onPanelKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      // The settings popover is a dialog of its own inside this one. While
      // focus is in it, its keys are its business — otherwise Escape would
      // close both at once and an arrow key would yank focus out to a row.
      if ((event.target as HTMLElement | null)?.closest?.(".activity-settings-popover")) {
        return;
      }
      const delta = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
      const rows = Array.from(
        event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-activity-row]"),
      );
      if (delta !== 0 && rows.length > 0) {
        event.preventDefault();
        const current = rows.indexOf(document.activeElement as HTMLButtonElement);
        const next = current < 0
          ? (delta > 0 ? 0 : rows.length - 1)
          : (current + delta + rows.length) % rows.length;
        rows[next]?.focus();
        return;
      }
      if ((event.key === "Home" || event.key === "End") && rows.length > 0) {
        event.preventDefault();
        (event.key === "Home" ? rows[0] : rows[rows.length - 1])?.focus();
        return;
      }
      trapKeyDown(event);
    },
    [trapKeyDown],
  );

  // A signed-out window has no account stream, so it must not keep advertising
  // counts left over from whoever was signed in a moment ago.
  const signedOut = availability?.state === "signed_out"
    || (!signedIn && !accountLoading);
  const degraded = availability != null
    && availability.state !== "ready"
    && availability.state !== "signed_out";
  const signedOutEmpty = signedOut && summary.trackedCount === 0;
  const badgeCount = summary.needsYouCount;
  const hasLiveOnly = badgeCount === 0 && summary.workingCount > 0;
  const baseLabel = activityTriggerLabel(summary).replace(/^Activity · /, "");
  const triggerLabel = signedOut
    ? signedOutEmpty
      ? "Activity · sign in to sync across machines"
      : `Activity · this machine only · ${baseLabel} · sign in to sync`
    : degraded
      ? `Activity · ${availability.title} · ${baseLabel}`
      : activityTriggerLabel(summary);
  const state = signedOutEmpty
    ? "signed-out"
    : degraded
      ? "degraded"
      : badgeCount > 0
        ? "waiting"
        : hasLiveOnly
          ? "live"
          : "clear";

  const freshness = degraded
    ? {
        tone: "error" as const,
        label: availability.title,
        retry: availability.recovery === "retry",
      }
    : syncStatus === "error"
      ? { tone: "error" as const, label: "Sync failed", retry: true }
      : syncStatus === "syncing"
        ? { tone: "syncing" as const, label: "Syncing", retry: false }
        : generatedAt
          ? { tone: "ready" as const, label: `Synced ${relativeWhen(generatedAt)}`, retry: false }
          : null;
  const notchNeedsAttention = notchHealth != null
    && notchHealth.state !== "disabled"
    && notchHealth.state !== "starting"
    && notchHealth.state !== "running"
    && notchHealth.state !== "unsupported";

  const populatedSections = summary.sections.filter((section) => section.items.length > 0);
  const machineLine = summary.machinesTotal === 0
    ? null
    : summary.machinesOnline === summary.machinesTotal
      ? pluralize(summary.machinesTotal, "machine")
      : `${summary.machinesOnline} of ${pluralize(summary.machinesTotal, "machine")} online`;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={cn(
          "ade-shell-control activity-hdr-trigger inline-flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-1",
          `activity-tone-${summary.tone}`,
        )}
        data-variant="ghost"
        data-state={state}
        data-testid="header-activity-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={triggerLabel}
        title={triggerLabel}
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        onClick={() => {
          if (open) setOpen(false);
          else openPopover();
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !open) {
            event.preventDefault();
            openPopover();
          }
        }}
      >
        {state === "signed-out" ? (
          <BellSimpleSlash size={14} weight="regular" className="shrink-0 opacity-70" />
        ) : (
          <BellRinging
            size={14}
            weight={badgeCount > 0 ? "fill" : "regular"}
            className="activity-hdr-trigger-icon shrink-0"
          />
        )}
        {badgeCount > 0 ? (
          <span className="activity-hdr-trigger-count">{Math.min(99, badgeCount)}</span>
        ) : hasLiveOnly ? (
          <span className="activity-hdr-trigger-live" aria-hidden />
        ) : null}
      </button>

      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              className="activity-hdr-scrim fixed inset-0 z-[110]"
              style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
              onClick={() => setOpen(false)}
            >
              <div
                ref={panelRef}
                className="activity-hdr-panel"
                role="dialog"
                aria-modal="true"
                aria-labelledby="activity-hdr-title"
                tabIndex={-1}
                onClick={(event) => event.stopPropagation()}
                onKeyDown={onPanelKeyDown}
              >
                <header className="activity-hdr-panel-head">
                  {/* No sub-caption. The line that used to sit here only ever
                      restated the surface's own name ("Account Activity is
                      live"), and a header that describes itself is a header
                      that has nothing to say. */}
                  <h2 id="activity-hdr-title">Activity</h2>
                  {freshness ? (
                    freshness.tone === "error" && freshness.retry ? (
                      <button
                        type="button"
                        className="activity-hdr-freshness is-error"
                        onClick={() => void refreshActivitySnapshot()}
                        title={availability?.message ?? syncError ?? "Retry Activity sync"}
                      >
                        <WifiSlash size={11} />
                        {freshness.label} · Retry
                      </button>
                    ) : (
                      <span className="activity-hdr-freshness">
                        {freshness.tone === "syncing" ? (
                          <ArrowClockwise size={11} className="activity-hdr-spin" />
                        ) : (
                          <WifiHigh size={11} />
                        )}
                        {freshness.label}
                      </span>
                    )
                  ) : null}
                  <ActivitySettingsPopover />
                  <button
                    type="button"
                    className="activity-hdr-icon-button"
                    onClick={close}
                    title="Close"
                    aria-label="Close Activity"
                  >
                    <X size={13} />
                  </button>
                </header>

                {navigationError ? (
                  <div className="activity-hdr-alert" role="alert">
                    <WarningCircle size={14} weight="fill" />
                    <span>{navigationError}</span>
                  </div>
                ) : null}

                {degraded ? (
                  <div className="activity-hdr-note" role="status">
                    <WifiSlash size={12} />
                    <span>{availability.message}</span>
                  </div>
                ) : null}

                {signedOut && !signedOutEmpty ? (
                  <div className="activity-hdr-note" role="status">
                    <BellSimpleSlash size={12} />
                    <span>
                      {availability?.message
                        ?? "Showing work from this machine. Sign in to combine every ADE machine."}
                    </span>
                  </div>
                ) : null}

                {notchNeedsAttention ? (
                  <div className="activity-hdr-note activity-hdr-notch-health" role="status">
                    <WarningCircle size={12} weight="fill" />
                    <span>
                      <strong>{notchHealth.title}</strong>
                      {" "}
                      {notchHealth.message}
                    </span>
                    <button type="button" onClick={() => void retryNotch()}>
                      Check again
                    </button>
                  </div>
                ) : null}

                {summary.staleMachineCount > 0 ? (
                  <div className="activity-hdr-note">
                    <WifiSlash size={12} />
                    <span>
                      {summary.staleMachineCount} item
                      {summary.staleMachineCount === 1 ? " is" : "s are"} last-known state
                      from an offline machine.
                    </span>
                  </div>
                ) : null}

                <div className="activity-hdr-body">
                  {signedOutEmpty ? (
                    <div className="activity-hdr-empty">
                      <BellSimpleSlash size={22} weight="duotone" />
                      <strong>Signed out</strong>
                      <p>
                        Sign in to ADE to follow agents and pull requests across every
                        machine on your account.
                      </p>
                    </div>
                  ) : populatedSections.length === 0 ? (
                    <div className="activity-hdr-empty" data-activity-empty="all-clear">
                      <span className="activity-hdr-calm-dot" aria-hidden />
                      <strong>All agents idle</strong>
                      <p>
                        {syncStatus === "error"
                          ? syncError ?? "Activity couldn’t sync, so this may be stale."
                          : "Nothing needs you."}
                      </p>
                    </div>
                  ) : (
                    populatedSections.map((section) => (
                      <ActivityHeaderSection
                        key={section.id}
                        section={section}
                        hideDetails={hideDetails}
                        onOpenItem={(item) => void openItem(item)}
                        onOpenPane={openPane}
                      />
                    ))
                  )}
                </div>

                <footer className="activity-hdr-panel-foot">
                  <span>
                    {pluralize(summary.trackedCount, "session")}
                    {machineLine ? ` · ${machineLine}` : ""}
                  </span>
                  <button type="button" className="activity-hdr-open-all" onClick={openPane}>
                    Open all
                    <ArrowRight size={12} weight="bold" />
                  </button>
                </footer>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
