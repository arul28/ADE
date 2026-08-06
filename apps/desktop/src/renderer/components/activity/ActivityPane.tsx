import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowClockwise,
  WarningCircle,
  WifiHigh,
  WifiSlash,
  X,
} from "@phosphor-icons/react";

import {
  attentionDestinationDeepLink,
  type AttentionAction,
  type AttentionItem,
} from "../../../shared/types";
import { relativeWhen } from "../../lib/format";
import { openAdeDeeplink } from "../../lib/openExternal";
import {
  ADE_BROWSER_VIEW_OCCLUSION_END_EVENT,
  ADE_BROWSER_VIEW_OCCLUSION_START_EVENT,
} from "../../lib/workSidebarBrowserResize";
import {
  acknowledgeActivityItem,
  acknowledgeActivityItems,
  activityStore,
  selectActivityHideDetails,
  useActivityStore,
} from "../../state/activityStore";
import { ActivityDetailSheet } from "./ActivityDetailSheet";
import {
  ActivityFilters,
  activityFiltersAreEmpty,
  applyActivityFilters,
  EMPTY_ACTIVITY_FILTERS,
  type ActivityFilterState,
} from "./ActivityFilters";
import { ActivityInboxColumn } from "./ActivityInboxColumn";
import { ActivitySessionsColumn } from "./ActivitySessionsColumn";
import { ActivitySettingsPopover } from "./ActivitySettingsPopover";
import { activityFooterLine, summarizeActivity } from "./activityPriority";
import { refreshActivitySnapshot } from "./useActivitySync";
import "./Activity.css";

function navigationErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  return "ADE couldn’t open the exact machine and project for this item.";
}

/**
 * Failure copy for a dismiss. The count matters: "nothing was cleared" is a
 * different fact from "this row would not clear", and the bulk path is the one
 * a user is most likely to try twice.
 */
function dismissErrorMessage(error: unknown, count: number): string {
  const detail = error instanceof Error && error.message.trim() ? error.message.trim() : "";
  const subject = count === 1
    ? "ADE couldn’t dismiss that item."
    : `ADE couldn’t clear ${count} items.`;
  return detail ? `${subject} ${detail}` : `${subject} Refresh Activity, then try again.`;
}

/** "1 item" / "N items", the noun every partial-outcome sentence shares. */
function itemsPhrase(count: number): string {
  return count === 1 ? "1 item" : `${count} items`;
}

/**
 * Partial-outcome copy. The host acknowledges per item and refuses only what
 * actually moved underneath it, so the honest report names how many stayed
 * rather than implying the whole gesture failed.
 */
function staleClearMessage(staleCount: number, total: number): string {
  const cleared = total - staleCount;
  const stayed = itemsPhrase(staleCount);
  return cleared > 0
    ? `Cleared ${cleared} of ${total}. ${stayed} changed while you were reading — refresh Activity to see where they got to.`
    : `${stayed} changed while you were reading, so nothing cleared. Refresh Activity, then try again.`;
}

/**
 * The OTHER partial outcome, and the reason it is not the one above.
 *
 * A bulk clear aborts at the first chunk that fails, so the rows in and after
 * that chunk were never answered for: the call did not complete. They roll back
 * exactly like a stale refusal, but "changed while you were reading" is simply
 * false for them — nothing changed, and refreshing Activity shows the same list
 * back. What that user needs is the failure and the invitation to retry.
 */
function unreachedClearMessage(
  unreachedCount: number,
  staleCount: number,
  total: number,
  reason?: string,
): string {
  const cleared = total - unreachedCount - staleCount;
  const unreached = itemsPhrase(unreachedCount);
  const detail = reason?.trim();
  const head = cleared > 0
    ? `Cleared ${cleared} of ${total}. ADE couldn’t reach ${unreached}, so nothing changed for them — try again.`
    : `ADE couldn’t reach ${unreached}, so nothing cleared. Try again in a moment.`;
  // A batch can hit both at once: an earlier chunk refuses a row, a later one
  // never lands. Say both rather than pick the tidier half.
  const alsoStale = staleCount > 0
    ? ` ${itemsPhrase(staleCount)} changed while you were reading — refresh Activity to see where they got to.`
    : "";
  return `${head}${detail ? ` ${detail}` : ""}${alsoStale}`;
}

/** Nothing to say when every row cleared; otherwise the honest sentence. */
function clearOutcomeMessage(
  outcome: { stale: readonly string[]; unreached: readonly string[]; unreachedReason?: string },
  total: number,
): string | null {
  if (outcome.unreached.length > 0) {
    return unreachedClearMessage(
      outcome.unreached.length,
      outcome.stale.length,
      total,
      outcome.unreachedReason,
    );
  }
  return outcome.stale.length > 0 ? staleClearMessage(outcome.stale.length, total) : null;
}

/**
 * The expanded Activity surface: a modal popup over whatever tab is in front,
 * modelled on `app/LinearPaneModal` so ADE's two big overlay surfaces feel like
 * the same object. It replaces the `/attention` full-page route and the
 * tabs-plus-roster-plus-detail IA that route encoded.
 *
 * Split view, not a master/detail swap. Sessions and Inbox are both always
 * visible because they answer different questions — "what is running" and
 * "what is waiting on me" — and the detail slides over the top so opening one
 * row never costs you your place in either list.
 */
export function ActivityPane({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const itemsById = useActivityStore((state) => state.itemsById);
  const syncStatus = useActivityStore((state) => state.syncStatus);
  const syncError = useActivityStore((state) => state.syncError);
  const generatedAt = useActivityStore((state) => state.generatedAt);
  const availability = useActivityStore((state) => state.availability);
  const acknowledgementErrors = useActivityStore((state) => state.acknowledgementErrors);
  const hideDetails = useActivityStore(selectActivityHideDetails);

  const paneRef = useRef<HTMLDivElement | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [filters, setFilters] = useState<ActivityFilterState>(EMPTY_ACTIVITY_FILTERS);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [pendingActionId, setPendingActionId] = useState<string | null>(null);
  const [navigationError, setNavigationError] = useState<string | null>(null);

  const allItems = useMemo(() => Object.values(itemsById), [itemsById]);
  const visibleItems = useMemo(
    () => applyActivityFilters(allItems, filters),
    [allItems, filters],
  );
  const summary = useMemo(() => summarizeActivity(visibleItems, now), [now, visibleItems]);
  const selectedItem = selectedItemId ? itemsById[selectedItemId] ?? null : null;

  useEffect(() => {
    if (!open) return;
    setNavigationError(null);
    setNow(Date.now());
    void refreshActivitySnapshot();
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [open]);

  // The pane is a header surface too: while it is up, presence reporting should
  // say the user is looking at Activity.
  useEffect(() => {
    if (!open) return;
    activityStore.getState().setHeaderSurfaceVisible(true);
    return () => activityStore.getState().setHeaderSurfaceVisible(false);
  }, [open]);

  // An embedded BrowserView paints above the DOM, so tell it to step aside.
  useEffect(() => {
    if (!open || typeof window === "undefined") return;
    window.dispatchEvent(new Event(ADE_BROWSER_VIEW_OCCLUSION_START_EVENT));
    return () => {
      window.dispatchEvent(new Event(ADE_BROWSER_VIEW_OCCLUSION_END_EVENT));
    };
  }, [open]);

  const closeSheet = useCallback(() => setSelectedItemId(null), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // The settings popover is a dialog inside this one and owns its own
      // Escape; closing both at once would be a single key undoing two steps.
      if (document.querySelector(".activity-settings-popover")) return;
      event.preventDefault();
      // Escape peels one layer: the detail sheet first, the pane only once
      // nothing is stacked on top of it.
      if (selectedItemId) closeSheet();
      else onClose();
    };
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target || paneRef.current?.contains(target)) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [closeSheet, onClose, open, selectedItemId]);

  // A dismissed or expired row cannot keep a sheet open over an empty list.
  useEffect(() => {
    if (selectedItemId && !itemsById[selectedItemId]) setSelectedItemId(null);
  }, [itemsById, selectedItemId]);

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
    onClose();
  }, [onClose]);

  const runAction = useCallback(async (item: AttentionItem, action: AttentionAction) => {
    if (pendingActionId) return;
    if (action.kind === "open") {
      await openItem(item);
      return;
    }
    setPendingActionId(action.id);
    try {
      if (action.kind === "dismiss" || action.kind === "mark_seen") {
        await acknowledgeActivityItem(
          item.id,
          action.kind === "dismiss" ? "dismiss" : "seen",
        );
        if (action.kind === "dismiss") closeSheet();
      } else {
        // Everything else is a remote mutation ADE cannot yet perform from
        // here, so the honest fallback is to take the user to where it can be
        // done rather than to pretend the button did it.
        await openItem(item);
      }
    } catch {
      // `acknowledgeActivityItem` rolls its own optimistic state back and
      // records the message in the store; the sheet renders it.
    } finally {
      setPendingActionId(null);
    }
  }, [closeSheet, openItem, pendingActionId]);

  const dismissItem = useCallback((item: AttentionItem) => {
    setNavigationError(null);
    void acknowledgeActivityItem(item.id, "dismiss").catch((error: unknown) => {
      // A dismiss that silently failed and rolled back is exactly how this
      // surface earned "the button does nothing" — say what happened.
      setNavigationError(dismissErrorMessage(error, 1));
    });
  }, []);

  /**
   * Clear all, as ONE call. It used to fire an acknowledge per row: every one
   * of them raced the revision fence, every one that lost rolled its optimistic
   * dismiss back, and every rejection was swallowed by a bare `.catch(() => {})`
   * — so the rows reappeared and nothing on screen admitted why.
   *
   * The host now answers per item, so there are four outcomes and all four are
   * said out loud: everything cleared, some rows changed underneath us, some
   * rows could not be reached at all, or the call itself failed. The middle two
   * used to share the "changed while you were reading" sentence, which was a
   * lie for the half of them the request never reached.
   */
  const clearInbox = useCallback((items: readonly AttentionItem[]) => {
    if (items.length === 0) return;
    setNavigationError(null);
    void acknowledgeActivityItems(items.map((item) => item.id), "dismiss")
      .then((outcome) => {
        const message = clearOutcomeMessage(outcome, items.length);
        if (message) setNavigationError(message);
      })
      .catch((error: unknown) => {
        setNavigationError(dismissErrorMessage(error, items.length));
      });
  }, []);

  if (!open || typeof document === "undefined") return null;

  const degraded = availability != null
    && availability.state !== "ready"
    && availability.state !== "signed_out";
  const freshness = degraded
    ? { tone: "error" as const, label: availability.title, retry: true }
    : syncStatus === "error"
      ? { tone: "error" as const, label: "Sync failed", retry: true }
      : syncStatus === "syncing"
        ? { tone: "syncing" as const, label: "Syncing", retry: false }
        : generatedAt
          ? { tone: "ready" as const, label: `Synced ${relativeWhen(generatedAt)}`, retry: false }
          : null;
  const footerLine = activityFooterLine(summary);
  const filtered = !activityFiltersAreEmpty(filters);

  return createPortal(
    <>
      <button
        type="button"
        aria-label="Close Activity backdrop"
        data-activity-pane-backdrop="true"
        className="fixed inset-0 z-[9998] cursor-default bg-black/55 backdrop-blur-md"
        onClick={onClose}
        tabIndex={-1}
      />
      <div
        ref={paneRef}
        role="dialog"
        aria-modal="true"
        aria-label="Activity"
        data-testid="activity-pane"
        className="activity-pane fixed left-1/2 top-1/2 z-[9999] flex h-[min(820px,calc(100dvh-28px))] w-[min(1280px,calc(100vw-28px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-white/10 text-fg shadow-2xl shadow-black/50"
      >
        <header className="activity-pane-head">
          <h2>Activity</h2>
          <span className="activity-pane-machines">{footerLine}</span>
          {freshness ? (
            freshness.retry ? (
              <button
                type="button"
                className="activity-pane-freshness is-error"
                onClick={() => void refreshActivitySnapshot()}
                title={availability?.message ?? syncError ?? "Retry Activity sync"}
              >
                <WifiSlash size={11} />
                {freshness.label} · Retry
              </button>
            ) : (
              <span className="activity-pane-freshness">
                {freshness.tone === "syncing" ? (
                  <ArrowClockwise size={11} className="activity-pane-spin" />
                ) : (
                  <WifiHigh size={11} />
                )}
                {freshness.label}
              </span>
            )
          ) : null}
          <button
            type="button"
            className="activity-pane-icon-button"
            onClick={() => void refreshActivitySnapshot()}
            aria-label="Refresh Activity"
            title="Refresh"
          >
            <ArrowClockwise size={13} />
          </button>
          <ActivitySettingsPopover />
          <button
            type="button"
            className="activity-pane-icon-button"
            onClick={onClose}
            aria-label="Close Activity"
            title="Close"
          >
            <X size={13} />
          </button>
        </header>

        <ActivityFilters items={allItems} filters={filters} onChange={setFilters} />

        {/* While the sheet is up it covers this strip, so the failure is
            reported there instead — one alert, wherever the click was. */}
        {navigationError && !selectedItem ? (
          <div className="activity-pane-alert" role="alert">
            <WarningCircle size={14} weight="fill" />
            <span>{navigationError}</span>
          </div>
        ) : null}

        <div className="activity-pane-body">
          <ActivitySessionsColumn
            items={visibleItems}
            hideDetails={hideDetails}
            selectedItemId={selectedItemId}
            filtered={filtered}
            loading={allItems.length === 0 && syncStatus !== "ready" && syncStatus !== "error"}
            onOpenItem={(item) => setSelectedItemId(item.id)}
            onDismissItem={dismissItem}
          />
          <ActivityInboxColumn
            items={visibleItems}
            selectedItemId={selectedItemId}
            filtered={filtered}
            onOpenItem={(item) => setSelectedItemId(item.id)}
            onDismissItem={dismissItem}
            onClearAll={clearInbox}
          />
          {selectedItem ? (
            <ActivityDetailSheet
              item={selectedItem}
              hideDetails={hideDetails}
              pendingActionId={pendingActionId}
              errorMessage={
                navigationError ?? acknowledgementErrors[selectedItem.id] ?? null
              }
              onClose={closeSheet}
              onOpen={(item) => void openItem(item)}
              onAction={(item, action) => void runAction(item, action)}
            />
          ) : null}
        </div>
      </div>
    </>,
    document.body,
  );
}
