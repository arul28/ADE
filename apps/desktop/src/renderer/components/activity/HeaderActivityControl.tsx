import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowClockwise,
  ArrowRight,
  BellRinging,
  BellSimpleSlash,
  CaretDown,
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
import { ActivityAllClear } from "./ActivityAllClear";
import { ActivityCard } from "./ActivityCard";
import { ActivitySectionHeader } from "./ActivitySectionHeader";
import { ActivitySettingsPopover } from "./ActivitySettingsPopover";
import {
  ACTIVITY_POPOVER_SECTION_IDS,
  ACTIVITY_SECTION_TONE,
  activityFooterLine,
  activityTriggerLabel,
  summarizeActivity,
  type ActivityOfflineMachine,
  type ActivitySection,
} from "./activityPriority";
import { useActivitySectionCollapse } from "./activitySectionCollapse";
import { useAllClearBeat } from "./useAllClearBeat";
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

function ActivityHeaderSection({
  section,
  hideDetails,
  collapsed,
  onToggleCollapsed,
  onOpenItem,
  onDismissItem,
  onOpenPane,
}: {
  section: ActivitySection;
  hideDetails: boolean;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onOpenItem: (item: AttentionItem) => void;
  onDismissItem: (item: AttentionItem) => void;
  onOpenPane: () => void;
}) {
  const shown = section.items.slice(0, MAX_ROWS_PER_SECTION);
  const overflow = section.items.length - shown.length;
  const regionId = `activity-hdr-section-${section.id}`;
  return (
    <section
      className={cn("activity-hdr-section", `activity-tone-${ACTIVITY_SECTION_TONE[section.id]}`)}
    >
      <ActivitySectionHeader
        variant="popover"
        sectionId={section.id}
        regionId={regionId}
        label={section.label}
        count={section.items.length}
        group={section.id}
        collapsed={collapsed}
        onToggle={onToggleCollapsed}
      />
      <div id={regionId} className="activity-section-rows" hidden={collapsed}>
        {collapsed ? null : (
          <>
            {shown.map((item) => (
              <ActivityCard
                key={item.id}
                item={item}
                hideDetails={hideDetails}
                onOpen={onOpenItem}
                onDismiss={onDismissItem}
              />
            ))}
            {overflow > 0 ? (
              <button type="button" className="activity-hdr-overflow" onClick={onOpenPane}>
                {overflow} more
                <ArrowRight size={11} weight="bold" />
              </button>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}

/**
 * Which machines the last-known-state note is about, on demand. The note itself
 * is the honest headline — some of what you are reading is remembered, not
 * observed — but "which machines, and how long ago" is a follow-up question,
 * and answering it unprompted would spend four lines of a dropdown on a state
 * that is usually momentary.
 */
function ActivityOfflineDisclosure({
  machines,
  itemCount,
}: {
  machines: readonly ActivityOfflineMachine[];
  itemCount: number;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="activity-hdr-note activity-hdr-offline">
      <WifiSlash size={12} />
      <div className="activity-hdr-offline-body">
        <div className="activity-hdr-offline-head">
          <span>
            {itemCount} item{itemCount === 1 ? " is" : "s are"} last-known state
            from an offline machine.
          </span>
          <button
            type="button"
            className="activity-hdr-offline-toggle"
            aria-expanded={open}
            aria-controls="activity-hdr-offline-list"
            onClick={() => setOpen((value) => !value)}
          >
            {machines.length === 1 ? "1 machine" : `${machines.length} machines`}
            <CaretDown
              size={9}
              weight="bold"
              aria-hidden
              className={cn("activity-hdr-offline-caret", open && "is-open")}
            />
          </button>
        </div>
        <ul id="activity-hdr-offline-list" className="activity-hdr-offline-list" hidden={!open}>
          {machines.map((machine) => (
            <li key={machine.machineKey}>
              <span className="truncate">{machine.name}</span>
              <span>
                {machine.lastSeenAt
                  ? `last seen ${relativeWhen(machine.lastSeenAt)}`
                  : "never seen"}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
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
  const collapse = useActivitySectionCollapse("popover");
  // The beat only plays while the popover is up: a celebration nobody is
  // looking at is a wasted one, and firing it on open would make it a greeting.
  const allClear = useAllClearBeat(summary.needsYouCount, open);

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

  const dismissItem = useCallback((item: AttentionItem) => {
    setNavigationError(null);
    void acknowledgeActivityItem(item.id, "dismiss").catch((error: unknown) => {
      setNavigationError(
        error instanceof Error && error.message.trim()
          ? error.message.trim()
          : "ADE couldn’t dismiss that item.",
      );
    });
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

  // The dropdown is live work only. Done is the most final and the most common
  // state there is, and letting it in turns a glance into a scroll past
  // yesterday's finished runs. The count below still tells the truth about it.
  const populatedSections = summary.sections.filter((section) =>
    section.items.length > 0 && ACTIVITY_POPOVER_SECTION_IDS.includes(section.id));
  const footerLine = activityFooterLine(summary);

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

                {summary.staleMachineCount > 0 && summary.offlineMachines.length > 0 ? (
                  <ActivityOfflineDisclosure
                    machines={summary.offlineMachines}
                    itemCount={summary.staleMachineCount}
                  />
                ) : null}

                <div className="activity-hdr-body">
                  {allClear ? <ActivityAllClear compact /> : null}
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
                          : summary.doneCount > 0
                            ? "Nothing needs you. Finished work is in the full list."
                            : "Nothing needs you."}
                      </p>
                    </div>
                  ) : (
                    populatedSections.map((section) => (
                      <ActivityHeaderSection
                        key={section.id}
                        section={section}
                        hideDetails={hideDetails}
                        collapsed={collapse.isCollapsed(section.id)}
                        onToggleCollapsed={() => collapse.toggle(section.id)}
                        onOpenItem={(item) => void openItem(item)}
                        onDismissItem={dismissItem}
                        onOpenPane={openPane}
                      />
                    ))
                  )}
                  {/* Done is hidden here, so the handoff has to be explicit:
                      the count is the promise that nothing was thrown away. */}
                  {populatedSections.length > 0 && summary.doneCount > 0 ? (
                    <button
                      type="button"
                      className="activity-hdr-done-handoff"
                      onClick={openPane}
                    >
                      {summary.doneCount} done in the full list
                      <ArrowRight size={11} weight="bold" />
                    </button>
                  ) : null}
                </div>

                <footer className="activity-hdr-panel-foot">
                  <span>{footerLine}</span>
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
