import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowClockwise,
  ArrowRight,
  BellRinging,
  BellSimpleSlash,
  GitPullRequest,
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
  acknowledgeAttentionItem,
  attentionStore,
  useAttentionStore,
} from "../../state/attentionStore";
import { useDialogFocusTrap } from "../app/HeaderSheet";
import { ProviderLogo } from "../shared/ProviderLogos";
import { cn } from "../ui/cn";
import {
  attentionPhasePresentation,
  type AttentionTone,
} from "./attentionPresentation";
import {
  attentionHeaderTriggerLabel,
  summarizeAttentionForHeader,
  type AttentionHeaderBucket,
} from "./attentionHeaderSummary";
import { refreshAttentionSnapshot } from "./useAttentionSync";
import "./HeaderAttentionControl.css";

/** Rows shown per section before the overflow hands off to the full center. */
const MAX_ROWS_PER_BUCKET = 4;
const RELATIVE_TIME_TICK_MS = 30_000;
const IDLE_TICK_MS = 120_000;

function toneClass(tone: AttentionTone): string {
  return `attention-tone-${tone}`;
}

function itemIcon(item: AttentionItem, size: number): React.ReactNode {
  if (item.kind === "pull_request") return <GitPullRequest size={size} weight="duotone" />;
  return <ProviderLogo family={item.provider || "agent"} size={size} />;
}

function navigationErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  return "ADE couldn’t open the exact machine and project for this item.";
}

function machineLine(item: AttentionItem): string {
  return item.machine.online
    ? `${item.project.name} · ${item.machine.name}`
    : `${item.project.name} · ${item.machine.name} (offline)`;
}

function AttentionHeaderRow({
  item,
  onOpen,
}: {
  item: AttentionItem;
  onOpen: () => void;
}) {
  const phase = attentionPhasePresentation(item.phase);
  return (
    <button
      type="button"
      data-attention-header-row={item.id}
      className={cn("attn-hdr-row", toneClass(phase.tone))}
      onClick={onOpen}
      title={`${item.title} — ${machineLine(item)}`}
    >
      <span className="attn-hdr-row-icon" aria-hidden>
        {itemIcon(item, 15)}
      </span>
      <span className="attn-hdr-row-copy">
        <span className="attn-hdr-row-title">
          <strong>{item.title}</strong>
          <time dateTime={item.updatedAt}>{relativeWhen(item.updatedAt)}</time>
        </span>
        <span className="attn-hdr-row-meta">
          <span className="attn-hdr-phase">
            <span
              className={cn(
                "attn-hdr-phase-dot",
                phase.active && item.machine.online && "is-active",
              )}
            />
            {phase.label}
          </span>
          <span className="attn-hdr-row-where">{machineLine(item)}</span>
        </span>
      </span>
      {item.seenAt ? null : <span className="attn-hdr-unseen" aria-label="Unseen" />}
    </button>
  );
}

function AttentionHeaderSection({
  bucket,
  onOpenItem,
  onOpenCenter,
}: {
  bucket: AttentionHeaderBucket;
  onOpenItem: (item: AttentionItem) => void;
  onOpenCenter: () => void;
}) {
  const shown = bucket.items.slice(0, MAX_ROWS_PER_BUCKET);
  const overflow = bucket.items.length - shown.length;
  return (
    <section className={cn("attn-hdr-section", toneClass(bucket.tone))}>
      <h3 className="attn-hdr-section-heading">
        <span className="attn-hdr-section-dot" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{bucket.label}</span>
        <span className="attn-hdr-section-count">{bucket.items.length}</span>
      </h3>
      {shown.map((item) => (
        <AttentionHeaderRow key={item.id} item={item} onOpen={() => onOpenItem(item)} />
      ))}
      {overflow > 0 ? (
        <button type="button" className="attn-hdr-overflow" onClick={onOpenCenter}>
          {overflow} more in Attention
          <ArrowRight size={11} weight="bold" />
        </button>
      ) : null}
    </section>
  );
}

/**
 * Account-wide Attention, promoted into the global header so live work, things
 * that need you, failures, and finished-but-unreviewed outcomes are one glance
 * away from every tab and every project. The full Attention center stays the
 * place to triage at length; this is the doorway to it.
 */
export function HeaderAttentionControl({
  onOpenCenter,
}: {
  /** Routes to the full Attention center — the shell owns navigation. */
  onOpenCenter: () => void;
}) {
  const itemsById = useAttentionStore((state) => state.itemsById);
  const syncStatus = useAttentionStore((state) => state.syncStatus);
  const syncError = useAttentionStore((state) => state.syncError);
  const generatedAt = useAttentionStore((state) => state.generatedAt);
  const availability = useAttentionStore((state) => state.availability);
  const { status: accountStatus, loading: accountLoading } = useAccountStatus();
  const signedIn = accountStatus.signedIn;

  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const [notchHealth, setNotchHealth] = useState<AttentionNotchHealth | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const summary = useMemo(
    () => summarizeAttentionForHeader(itemsById, now),
    [itemsById, now],
  );

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  const openPopover = useCallback(() => {
    setOpen(true);
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
    void refreshAttentionSnapshot();
    void window.ade?.attentionNotch?.getHealth?.()
      .then(setNotchHealth)
      .catch(() => setNotchHealth(null));
  }, [open]);

  useEffect(() => {
    attentionStore.getState().setHeaderSurfaceVisible(open);
    return () => {
      attentionStore.getState().setHeaderSurfaceVisible(false);
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
    await acknowledgeAttentionItem(item.id, "seen").catch(() => {});
    setOpen(false);
  }, []);

  const openCenter = useCallback(() => {
    setOpen(false);
    onOpenCenter();
  }, [onOpenCenter]);

  const onPanelKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const delta = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
      const rows = Array.from(
        event.currentTarget.querySelectorAll<HTMLButtonElement>(
          "[data-attention-header-row]",
        ),
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
  const badgeCount = summary.waitingCount;
  const hasLiveOnly = badgeCount === 0 && summary.liveCount > 0;
  const triggerLabel = signedOut
    ? signedOutEmpty
      ? "Attention · sign in to sync across machines"
      : `Attention · this machine only · ${attentionHeaderTriggerLabel(summary).replace(/^Attention · /, "")} · sign in to sync`
    : degraded
      ? `Attention · ${availability.title} · ${attentionHeaderTriggerLabel(summary).replace(/^Attention · /, "")}`
      : attentionHeaderTriggerLabel(summary);
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

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={cn(
          "ade-shell-control attn-hdr-trigger inline-flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-1",
          toneClass(summary.tone),
        )}
        data-variant="ghost"
        data-state={state}
        data-testid="header-attention-trigger"
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
            className="attn-hdr-trigger-icon shrink-0"
          />
        )}
        {badgeCount > 0 ? (
          <span className="attn-hdr-trigger-count">{Math.min(99, badgeCount)}</span>
        ) : hasLiveOnly ? (
          <span className="attn-hdr-trigger-live" aria-hidden />
        ) : null}
      </button>

      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              className="attn-hdr-scrim fixed inset-0 z-[110]"
              style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
              onClick={() => setOpen(false)}
            >
              <div
                ref={panelRef}
                className="attn-hdr-panel"
                role="dialog"
                aria-modal="true"
                aria-labelledby="attn-hdr-title"
                tabIndex={-1}
                onClick={(event) => event.stopPropagation()}
                onKeyDown={onPanelKeyDown}
              >
                <header className="attn-hdr-panel-head">
                  <div className="min-w-0 flex-1">
                    <h2 id="attn-hdr-title">Attention</h2>
                    <p>
                      {signedOut
                        ? availability?.title ?? "This machine only"
                        : availability?.title
                          ? availability.title
                        : summary.machinesTotal > 0
                          ? `${summary.machinesOnline} of ${summary.machinesTotal} machine${summary.machinesTotal === 1 ? "" : "s"} online`
                          : "Across every machine on your account"}
                    </p>
                  </div>
                  {freshness ? (
                    freshness.tone === "error" && freshness.retry ? (
                      <button
                        type="button"
                        className="attn-hdr-freshness is-error"
                        onClick={() => void refreshAttentionSnapshot()}
                        title={availability?.message ?? syncError ?? "Retry Attention sync"}
                      >
                        <WifiSlash size={11} />
                        {freshness.label} · Retry
                      </button>
                    ) : (
                      <span className="attn-hdr-freshness">
                        {freshness.tone === "syncing" ? (
                          <ArrowClockwise size={11} className="attn-hdr-spin" />
                        ) : (
                          <WifiHigh size={11} />
                        )}
                        {freshness.label}
                      </span>
                    )
                  ) : null}
                  <button
                    type="button"
                    className="attn-hdr-icon-button"
                    onClick={close}
                    title="Close"
                    aria-label="Close Attention"
                  >
                    <X size={13} />
                  </button>
                </header>

                {navigationError ? (
                  <div className="attn-hdr-alert" role="alert">
                    <WarningCircle size={14} weight="fill" />
                    <span>{navigationError}</span>
                  </div>
                ) : null}

                {degraded ? (
                  <div className="attn-hdr-note" role="status">
                    <WifiSlash size={12} />
                    <span>{availability.message}</span>
                  </div>
                ) : null}

                {signedOut && !signedOutEmpty ? (
                  <div className="attn-hdr-note" role="status">
                    <BellSimpleSlash size={12} />
                    <span>
                      {availability?.message
                        ?? "Showing work from this machine. Sign in to combine every ADE machine."}
                    </span>
                  </div>
                ) : null}

                {notchNeedsAttention ? (
                  <div className="attn-hdr-note attn-hdr-notch-health" role="status">
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
                  <div className="attn-hdr-note">
                    <WifiSlash size={12} />
                    <span>
                      {summary.staleMachineCount} item
                      {summary.staleMachineCount === 1 ? " is" : "s are"} last-known state
                      from an offline machine.
                    </span>
                  </div>
                ) : null}

                <div className="attn-hdr-body">
                  {signedOutEmpty ? (
                    <div className="attn-hdr-empty">
                      <BellSimpleSlash size={22} weight="duotone" />
                      <strong>Signed out</strong>
                      <p>
                        Sign in to ADE to follow agents and pull requests across every
                        machine on your account.
                      </p>
                    </div>
                  ) : summary.buckets.length === 0 ? (
                    <div className="attn-hdr-empty">
                      <BellRinging size={22} weight="duotone" />
                      <strong>All clear</strong>
                      <p>
                        {availability?.message
                          ?? (syncStatus === "error"
                          ? syncError ?? "Attention couldn’t sync, so this may be stale."
                          : "Nothing is running, waiting on you, or newly finished.")}
                      </p>
                    </div>
                  ) : (
                    summary.buckets.map((bucket) => (
                      <AttentionHeaderSection
                        key={bucket.id}
                        bucket={bucket}
                        onOpenItem={(item) => void openItem(item)}
                        onOpenCenter={openCenter}
                      />
                    ))
                  )}
                </div>

                <footer className="attn-hdr-panel-foot">
                  <span>
                    {summary.trackedCount} tracked
                    {summary.liveCount > 0 && badgeCount > 0
                      ? ` · ${summary.liveCount} live`
                      : ""}
                  </span>
                  <button type="button" className="attn-hdr-open-all" onClick={openCenter}>
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

export default HeaderAttentionControl;
