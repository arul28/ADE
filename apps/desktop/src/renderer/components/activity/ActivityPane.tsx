import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowClockwise,
  ArrowSquareOut,
  Checks,
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
import { ActivityPanel } from "./ActivityPanel";
import { ActivitySettingsPopover } from "./ActivitySettingsPopover";
import { activityFooterLine, summarizeActivity } from "./activityPriority";
import { refreshActivitySnapshot } from "./useActivitySync";
import { Dialog } from "../ui/dialog";
import { Banner } from "../ui/notice/Banner";
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

/** "Couldn't mark 2 of 5 seen", or null when every row took the mark. */
function seenOutcomeMessage(
  outcome: { stale: readonly string[]; unreached: readonly string[] },
  total: number,
): string | null {
  const missed = outcome.stale.length + outcome.unreached.length;
  if (missed === 0) return null;
  return `ADE couldn’t mark ${missed} of ${total} seen. Refresh Activity, then try again.`;
}

/**
 * The most rows one Open press opens. Each one is a chat tab, or a window for
 * another machine's project, so an unbounded press is a tab storm.
 */
const MAX_BULK_OPEN = 8;

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
 * The expanded Activity view, behind "Open all": the same panel as the top-bar
 * popover (`ActivityPanel`), wider, with what only fits here — the machine /
 * project / type / model filters, multi-select with bulk actions, and the
 * detail sheet that slides over the list so opening a row never costs you
 * your place in it.
 *
 * Bulk actions are only the ones that are safe for rows from other machines:
 * Mark seen and Dismiss go through the account acknowledgement path, and Open
 * goes through the same cross-machine open as a click. Snooze and Settle are
 * not offered: they are session mutations on the owning machine, and this
 * window can only reach its own (see the note at the top of `ActivityCard`).
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

  const [now, setNow] = useState(() => Date.now());
  const [filters, setFilters] = useState<ActivityFilterState>(EMPTY_ACTIVITY_FILTERS);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [pendingActionId, setPendingActionId] = useState<string | null>(null);
  const [navigationError, setNavigationError] = useState<string | null>(null);
  /**
   * Checked rows, each with the alert fingerprint it had when the user checked
   * it. A row whose alert changes since (a working agent that now asks a
   * question) leaves the selection, so a bulk action never acknowledges an
   * alert the user did not see.
   */
  const [checked, setChecked] = useState<ReadonlyMap<string, string | null>>(() => new Map());
  const checkedIds = useMemo<ReadonlySet<string>>(() => new Set(checked.keys()), [checked]);
  const [bulkPending, setBulkPending] = useState(false);

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

  // Esc and outside presses are the Dialog's (Radix). Escape peels one layer:
  // the settings popover (a dialog inside this one) owns its own Escape, then
  // the detail sheet closes, and the pane only once nothing is stacked on it.
  const handleEscapeKeyDown = useCallback((event: KeyboardEvent) => {
    if (document.querySelector(".activity-settings-popover")) {
      event.preventDefault();
      return;
    }
    if (selectedItemId) {
      event.preventDefault();
      closeSheet();
    }
  }, [closeSheet, selectedItemId]);

  // A dismissed or expired row cannot keep a sheet open over an empty list, and
  // cannot stay counted in a selection the user can no longer see.
  useEffect(() => {
    if (selectedItemId && !itemsById[selectedItemId]) setSelectedItemId(null);
    setChecked((current) => {
      if (current.size === 0) return current;
      const next = new Map([...current].filter(([id, fingerprint]) => {
        const item = itemsById[id];
        return Boolean(item) && !item.dismissedAt && (item.alertFingerprint ?? null) === fingerprint;
      }));
      return next.size === current.size ? current : next;
    });
  }, [itemsById, selectedItemId]);

  useEffect(() => {
    if (!open) setChecked(new Map());
  }, [open]);

  const toggleChecked = useCallback((item: AttentionItem) => {
    setChecked((current) => {
      const next = new Map(current);
      if (next.has(item.id)) next.delete(item.id);
      else next.set(item.id, item.alertFingerprint ?? null);
      return next;
    });
  }, []);

  /** Opens one row's destination; resolves false when it could not. */
  const openDestination = useCallback(async (item: AttentionItem): Promise<boolean> => {
    try {
      const bridge = typeof window !== "undefined" ? window.ade?.attention : null;
      if (bridge?.openItem) await bridge.openItem(item);
      else openAdeDeeplink(attentionDestinationDeepLink(item.destination, item));
    } catch (error) {
      setNavigationError(navigationErrorMessage(error));
      return false;
    }
    // Only a destination that actually resolved earns the item leaving unseen.
    await acknowledgeActivityItem(item.id, "seen").catch(() => {});
    return true;
  }, []);

  const openItem = useCallback(async (item: AttentionItem) => {
    setNavigationError(null);
    if (await openDestination(item)) onClose();
  }, [onClose, openDestination]);

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

  const checkedItems = useMemo(
    () => [...checkedIds].map((id) => itemsById[id]).filter((item): item is AttentionItem => Boolean(item)),
    [checkedIds, itemsById],
  );

  const bulkAcknowledge = useCallback(async (kind: "seen" | "dismiss") => {
    if (checkedItems.length === 0 || bulkPending) return;
    setNavigationError(null);
    setBulkPending(true);
    try {
      const outcome = await acknowledgeActivityItems(checkedItems.map((item) => item.id), kind);
      const message = kind === "seen"
        ? seenOutcomeMessage(outcome, checkedItems.length)
        : clearOutcomeMessage(outcome, checkedItems.length);
      if (message) setNavigationError(message);
      setChecked(new Map());
    } catch (error) {
      setNavigationError(
        kind === "seen"
          ? "ADE couldn’t mark those items seen. Refresh Activity, then try again."
          : dismissErrorMessage(error, checkedItems.length),
      );
    } finally {
      setBulkPending(false);
    }
  }, [bulkPending, checkedItems]);

  /**
   * Opens each checked row in turn and stops at the first one that fails, so
   * the error names the row that broke rather than the last one tried.
   */
  const bulkOpen = useCallback(async () => {
    if (checkedItems.length === 0 || bulkPending) return;
    setNavigationError(null);
    setBulkPending(true);
    try {
      for (const item of checkedItems.slice(0, MAX_BULK_OPEN)) {
        if (!(await openDestination(item))) return;
      }
      setChecked(new Map());
      onClose();
    } finally {
      setBulkPending(false);
    }
  }, [bulkPending, checkedItems, onClose, openDestination]);

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

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="Activity"
      hideHeader
      testId="activity-pane"
      panelClassName="activity-pane"
      width={880}
      height="min(820px, calc(100dvh - 28px))"
      maxHeight="calc(100dvh - 28px)"
      bodyPadding={false}
      scrollBody={false}
      bodyStyle={{ display: "flex", flexDirection: "column", color: "var(--color-fg)" }}
      // Nothing in the pane grabs focus on open; the panel holds it.
      preventAutoFocus
      panelStyle={{ background: "var(--activity-surface)", borderRadius: 12 }}
      onEscapeKeyDown={handleEscapeKeyDown}
    >
        <header className="activity-pane-head">
          <h2 aria-hidden="true">Activity</h2>
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
          <Banner
            model={{ id: "activity-navigation-error", tone: "error", title: navigationError }}
            layout="inline"
            style={{ margin: "8px 12px" }}
          />
        ) : null}

        <div className="activity-pane-body">
          <ActivityPanel
            size="expanded"
            items={visibleItems}
            now={now}
            hideDetails={hideDetails}
            loading={allItems.length === 0 && !generatedAt && syncStatus !== "error"}
            filtered={filtered}
            selectedItemId={selectedItemId}
            checkedIds={checkedIds}
            onToggleChecked={toggleChecked}
            onOpenItem={(item) => setSelectedItemId(item.id)}
            onDismissItem={dismissItem}
            onClearInbox={clearInbox}
            toolbarEnd={checkedItems.length > 0 ? (
              <div className="activity-bulk-bar" role="toolbar" aria-label="Selected sessions">
                <span className="activity-bulk-count">
                  <span className="kit-num">{checkedItems.length}</span> selected
                </span>
                <button
                  type="button"
                  className="kit-btn kit-btn-ghost"
                  disabled={bulkPending}
                  onClick={() => void bulkAcknowledge("seen")}
                >
                  <Checks size={13} />
                  Mark seen
                </button>
                <button
                  type="button"
                  className="kit-btn kit-btn-ghost"
                  disabled={bulkPending}
                  onClick={() => void bulkAcknowledge("dismiss")}
                >
                  <X size={12} />
                  Dismiss
                </button>
                <button
                  type="button"
                  className="kit-btn kit-btn-ghost"
                  disabled={bulkPending}
                  title={checkedItems.length > MAX_BULK_OPEN
                    ? `Opens the first ${MAX_BULK_OPEN}`
                    : undefined}
                  onClick={() => void bulkOpen()}
                >
                  <ArrowSquareOut size={13} />
                  Open
                </button>
                <button
                  type="button"
                  className="kit-icon-btn"
                  aria-label="Clear selection"
                  title="Clear selection"
                  onClick={() => setChecked(new Map())}
                >
                  <X size={12} />
                </button>
              </div>
            ) : null}
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
    </Dialog>
  );
}
