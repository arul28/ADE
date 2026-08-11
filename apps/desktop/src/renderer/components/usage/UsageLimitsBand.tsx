/**
 * Live Limits — the body of the top-bar usage popover, and its only caller.
 *
 * Quota used to appear twice: here and again on the Usage page. The page is
 * about spend and history, the popover is on screen in every tab and updates
 * continuously, so the second copy was the least relevant thing on a page it
 * sat at the top of. It was removed, and with it this component's reasons to
 * be configurable — the layout, the card chrome, and the cross-panel highlight
 * plumbing all had exactly one caller passing exactly one set of values.
 *
 * What is left is a stack of one compact row per provider. Formatting, the pace
 * bar, and the type/colour vocabulary come from the shared modules
 * (`usageWindowFormat`, `UsagePaceBar`, `usageDesign`).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowClockwise, ArrowSquareOut, Gauge, X } from "@phosphor-icons/react";
import type {
  AiProviderConnectionStatus,
  AiProviderConnections,
  ExtraUsage,
  UsageProvider,
  UsageProviderStatus,
  UsageSnapshot,
  UsageWindow,
} from "../../../shared/types";
import { hasLocalProviderConnectionSignal } from "../../lib/aiProviderStatus";
import { formatCost, formatTokens } from "../../lib/format";
import { openExternalUrl } from "../../lib/openExternal";
import { usePrefersReducedMotion } from "../../hooks/usePrefersReducedMotion";
import { type ThemeId, useAppStore } from "../../state/appStore";
import { ClaudeLogo, CodexLogo } from "../terminals/ToolLogos";
import { cn } from "../ui/cn";
import { providerColor } from "./providerColors";
import { UsagePaceBar } from "./UsagePaceBar";
import {
  USAGE_BAR_TRACK_CLASS,
  USAGE_BUTTON_CLASS,
  USAGE_CARD_CLASS,
  USAGE_HAIRLINE_CLASS,
  USAGE_NUMERIC_CLASS,
  USAGE_TEXT,
  usagePressureColor,
} from "./usageDesign";
import {
  WEEKDAYS,
  formatUpdatedAge,
} from "./usageWindowFormat";
import type { UsageRefreshOutcome, UsageSnapshotSource } from "./useUsageSnapshot";

const PROVIDER_ORDER: UsageProvider[] = ["claude", "codex"];

const PROVIDER_META: Record<UsageProvider, { label: string; usageUrl?: string }> = {
  claude: { label: "Claude", usageUrl: "https://claude.ai/new#settings/usage" },
  codex: {
    label: "Codex",
    usageUrl: "https://chatgpt.com/codex/cloud/settings/analytics#usage",
  },
  cursor: { label: "Cursor" },
};

function providerConnection(
  connections: AiProviderConnections | null,
  provider: UsageProvider,
): AiProviderConnectionStatus | null {
  return connections?.[provider] ?? null;
}

function providerSourceLabel(status: UsageProviderStatus | null): string {
  if (status?.source === "oauth") return "OAuth";
  if (status?.source === "http") return "HTTP";
  if (status?.source === "cli") return "CLI";
  return "Waiting";
}

/** "OAuth · 2m ago" — where the reading came from and how old it is. */
function providerSourceLine(status: UsageProviderStatus | null, nowMs: number): string {
  return `${providerSourceLabel(status)} · ${formatUpdatedAge(status?.updatedAt ?? status?.lastSuccessAt, nowMs)}`;
}

/**
 * How long a provider is still under service-side backoff.
 *
 * `usageTrackingService` honours its per-provider backoff for a *user* refresh
 * when the last failure was `rate_limited` — the provider is skipped and the
 * previous status is carried forward verbatim. A Retry in that state produces a
 * byte-identical snapshot, which is exactly the "Retry does nothing" report.
 * Rather than offer a button that cannot work, the notice says when the next
 * attempt happens and disables it until then.
 */
function retryBlockedForMs(status: UsageProviderStatus, nowMs: number): number {
  if (status.errorKind !== "rate_limited") return 0;
  if (!status.nextRetryAt) return 0;
  const at = Date.parse(status.nextRetryAt);
  if (!Number.isFinite(at)) return 0;
  return Math.max(0, at - nowMs);
}

function formatWaitShort(ms: number): string {
  const minutes = Math.ceil(ms / 60_000);
  if (minutes <= 1) return "under a minute";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.ceil(minutes / 60);
  return `${hours}h`;
}

/**
 * A provider problem, said plainly.
 *
 * Three things were wrong with the version this replaces. It showed a
 * three-word summary and buried the provider's own sentence in a `title`
 * tooltip, so the only legible text was "Couldn't refresh". Its Retry could not
 * be told apart from a no-op — no pending state, no outcome, and in the
 * rate-limited case the service genuinely skipped the poll. And it could not be
 * dismissed, so a provider that stays unhappy left a warn dot on the row
 * forever even though the numbers below it were fine.
 *
 * Now: the real message, a retry that reports what happened, and a dismiss that
 * lasts until the surface is next opened. Dismissal is component state, not
 * storage — closing the popover or leaving the page brings it back, which is
 * the right half-life for "I've seen this, stop shouting".
 */
function ProviderStatusNotice({
  status,
  hasReadings,
  nowMs,
  onRetry,
  onDismiss,
}: {
  status: UsageProviderStatus;
  hasReadings: boolean;
  nowMs: number;
  onRetry: () => Promise<UsageRefreshOutcome>;
  onDismiss: () => void;
}) {
  const [phase, setPhase] = useState<"idle" | "pending" | "failed" | "succeeded">("idle");
  const [failureDetail, setFailureDetail] = useState<string | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // The outcome is a moment, not a state: it says something happened and then
  // gets out of the way. The notice itself disappears on success because the
  // status it is derived from turns "ok".
  useEffect(() => {
    if (phase !== "failed" && phase !== "succeeded") return;
    const timer = window.setTimeout(() => {
      if (mountedRef.current) setPhase("idle");
    }, 6_000);
    return () => window.clearTimeout(timer);
  }, [phase]);

  const unauthed = status.state === "unauthed";
  const blockedForMs = retryBlockedForMs(status, nowMs);
  const blocked = blockedForMs > 0;

  const message = status.message
    ?? (unauthed
      ? "Sign-in needed to read this provider's limits."
      : "Couldn't refresh this provider.");

  const handleRetry = useCallback(async () => {
    setPhase("pending");
    setFailureDetail(null);
    const outcome = await onRetry();
    if (!mountedRef.current) return;
    if (outcome.ok) {
      setPhase("succeeded");
    } else {
      setFailureDetail(outcome.error);
      setPhase("failed");
    }
  }, [onRetry]);

  const actionLabel = phase === "pending"
    ? (unauthed ? "Reconnecting" : "Retrying")
    : unauthed
      ? "Reconnect"
      : "Retry";

  return (
    <div
      role="status"
      className={cn(
        "flex min-w-0 flex-col gap-1.5 rounded-md border bg-surface-recessed px-2.5 py-2",
        USAGE_HAIRLINE_CLASS,
      )}
      style={{
        borderColor: "color-mix(in srgb, var(--color-usage-warn, #F5A623) 35%, transparent)",
      }}
    >
      <div className="flex min-w-0 items-start gap-2">
        <span
          aria-hidden
          className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ background: "var(--color-usage-warn, #F5A623)" }}
        />
        <p className={cn(USAGE_TEXT.micro, "m-0 min-w-0 flex-1 leading-relaxed text-fg/80")}>
          {message}
        </p>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss this warning"
          title="Dismiss until you open usage again"
          className="-mr-1 -mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-fg transition-colors duration-150 hover:bg-muted hover:text-fg motion-reduce:transition-none"
        >
          <X size={11} weight="regular" />
        </button>
      </div>

      {/* The bars below are still real. Say so, so "couldn't refresh" is never
          read as "the numbers are gone". */}
      {hasReadings ? (
        <p className={cn(USAGE_TEXT.micro, "m-0 pl-3.5 text-muted-fg")}>
          Figures below are the last good reading, from{" "}
          {formatUpdatedAge(status.lastSuccessAt ?? status.updatedAt, nowMs)}.
        </p>
      ) : null}

      <div className="flex min-w-0 items-center gap-2 pl-3.5">
        <button
          type="button"
          onClick={() => void handleRetry()}
          disabled={phase === "pending" || blocked}
          title={blocked ? "Rate-limited — the next attempt runs on its own" : undefined}
          className={cn(USAGE_BUTTON_CLASS, "min-h-7 px-2", USAGE_TEXT.micro)}
        >
          <ArrowClockwise
            size={11}
            className={phase === "pending" ? "animate-spin motion-reduce:animate-none" : undefined}
          />
          {actionLabel}
        </button>
        {blocked ? (
          <span className={cn(USAGE_TEXT.micro, "min-w-0 truncate text-muted-fg")}>
            Retries again in {formatWaitShort(blockedForMs)}.
          </span>
        ) : phase === "failed" ? (
          <span
            className={cn(USAGE_TEXT.micro, "min-w-0 truncate")}
            style={{ color: "var(--color-usage-warn, #F5A623)" }}
            title={failureDetail ?? undefined}
          >
            {/* The provider's sentence is already the first line of this
                notice; repeating it here just truncates it twice. */}
            {failureDetail && failureDetail !== message
              ? `Still failing: ${failureDetail}`
              : "Tried again just now — still failing."}
          </span>
        ) : phase === "succeeded" ? (
          <span className={cn(USAGE_TEXT.micro, "min-w-0 truncate text-muted-fg")}>Refreshed.</span>
        ) : null}
      </div>
    </div>
  );
}

/** A quiet inline notice with an optional action, on theme tokens. */
function NoticeRow({
  message,
  actionLabel,
  onAction,
  actionDisabled,
  className,
}: {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  actionDisabled?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 rounded-md border bg-surface-recessed px-2.5 py-1.5",
        USAGE_HAIRLINE_CLASS,
        className,
      )}
    >
      <span className={cn(USAGE_TEXT.micro, "min-w-0 text-muted-fg")}>{message}</span>
      {actionLabel && onAction ? (
        <button
          type="button"
          onClick={onAction}
          disabled={actionDisabled}
          className={cn(USAGE_BUTTON_CLASS, "min-h-8 shrink-0 px-2", USAGE_TEXT.micro)}
        >
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}

// ── band ─────────────────────────────────────────────────────────

/**
 * @param nowMs The popover's clock, which ticks only while it is open.
 * @param usage The popover's snapshot subscription. Passed in rather than owned
 *   so there is one subscription, one ordering guard, and one refresh path
 *   behind this surface — see `useUsageSnapshot`.
 */
export function UsageLimitsBand({
  nowMs,
  usage,
}: {
  nowMs: number;
  usage: UsageSnapshotSource;
}) {
  const { snapshot, bridgeMissing, refreshing, bindingRevision, refreshNow } = usage;
  const [providerConnections, setProviderConnections] = useState<AiProviderConnections | null>(null);
  const theme = useAppStore((state) => state.theme);
  const reducedMotion = usePrefersReducedMotion();

  // Re-read on rebind: which provider CLIs are configured is answered by the
  // runtime the project is bound to.
  //
  // Deliberately not cleared first, unlike the header's chips. Null here means
  // "not answered yet", and this component renders that as the full provider
  // order — so clearing would flash every provider on screen for as long as the
  // new answer takes, which is louder than briefly keeping the old rows.
  useEffect(() => {
    let cancelled = false;
    if (!window.ade?.ai?.getStatus) return;
    window.ade.ai
      .getStatus()
      .then((status) => {
        if (!cancelled) setProviderConnections(status.providerConnections ?? null);
      })
      .catch(() => {
        if (!cancelled) setProviderConnections(null);
      });
    return () => {
      cancelled = true;
    };
  }, [bindingRevision]);

  const visibleProviders = useMemo<UsageProvider[]>(() => {
    if (!providerConnections) return PROVIDER_ORDER;
    return PROVIDER_ORDER.filter((provider) => {
      const conn = providerConnection(providerConnections, provider);
      return hasLocalProviderConnectionSignal(conn);
    });
  }, [providerConnections]);

  const windowsByProvider = useMemo(() => {
    const grouped: Partial<Record<UsageProvider, UsageWindow[]>> = {};
    for (const provider of visibleProviders) {
      grouped[provider] = snapshot?.windows.filter((window) => window.provider === provider) ?? [];
    }
    return grouped;
  }, [snapshot?.windows, visibleProviders]);

  const extraUsage = useMemo(
    () => (snapshot?.extraUsage ?? []).filter((extra) => extra.provider !== "cursor"),
    [snapshot?.extraUsage],
  );

  if (bridgeMissing) {
    return (
      <div className={cn("rounded-lg px-3 py-6 text-center text-muted-fg", USAGE_TEXT.detail)}>
        Usage isn't available in this view.
      </div>
    );
  }

  return (
    <section className="flex flex-col gap-3">
      {visibleProviders.length === 0 ? (
        <div className={cn(USAGE_CARD_CLASS, "flex flex-col items-center justify-center py-9 text-center")}>
          <Gauge size={30} weight="regular" className="mb-3 text-muted-fg" />
          <div className={cn(USAGE_TEXT.body, "font-semibold text-fg")}>No provider CLIs detected</div>
          <div className={cn(USAGE_TEXT.detail, "mt-1.5 max-w-[44ch] text-muted-fg")}>
            Install Claude Code or the Codex CLI to start tracking usage here.
          </div>
        </div>
      ) : (
        // The provider stack and the empty state are each their own card: this
        // band is rendered into the header popover's bare surface, so without
        // it they float on the popover background with no edge of their own.
        <div className={USAGE_CARD_CLASS}>
          {visibleProviders.map((provider, index) => (
            <ProviderLimitsRow
              key={provider}
              provider={provider}
              theme={theme}
              windows={windowsByProvider[provider] ?? []}
              connection={providerConnection(providerConnections, provider)}
              status={snapshot?.providerStatus?.[provider] ?? null}
              messages={(snapshot?.providerMessages ?? []).filter((message) => message.provider === provider)}
              spendControlReached={provider === "codex" && snapshot?.spendControlReached === true}
              dailyUsage7d={snapshot?.dailyUsage7d?.[provider] ?? null}
              nowMs={nowMs}
              reducedMotion={reducedMotion}
              refreshing={refreshing}
              onRefresh={refreshNow}
              divided={index > 0}
            />
          ))}
        </div>
      )}

      {extraUsage.length > 0 ? (
        // No inset: `ExtraUsageCard` is already a padded card, and the section
        // it sits in is inside the popover's own padding.
        <div className="grid grid-cols-1 gap-3">
          {extraUsage.map((extra) => (
            <ExtraUsageCard
              key={extra.provider}
              extra={extra}
              theme={theme}
              reducedMotion={reducedMotion}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

// ── supporting reads ─────────────────────────────────────────────

function Sparkline7d({ data, color, nowMs }: { data: number[]; color: string; nowMs: number }) {
  const max = Math.max(1, ...data);
  return (
    <div className="flex h-4 items-end gap-[3px]">
      {data.map((value, index) => {
        const heightPx = Math.max(2, Math.round((value / max) * 16));
        const isToday = index === data.length - 1;
        const dayMs = nowMs - (data.length - 1 - index) * 86_400_000;
        const date = new Date(dayMs);
        const title = `${WEEKDAYS[date.getDay()]} ${date.getMonth() + 1}/${date.getDate()} · ${formatTokens(value)} tokens`;
        return (
          <div
            key={index}
            title={title}
            className="w-full rounded-[2px]"
            style={{ minWidth: 4, height: heightPx, background: color, opacity: isToday ? 0.95 : 0.4 }}
          />
        );
      })}
    </div>
  );
}

function ModelSplitLine({ breakdown }: { breakdown: Record<string, number> }) {
  const entries = Object.entries(breakdown).filter(([, pct]) => pct > 0);
  if (entries.length === 0) return null;
  return (
    <span className={cn(USAGE_TEXT.micro, "truncate text-muted-fg")}>
      {entries.map(([model, pct]) => `${model} ${Math.round(pct)}%`).join(" · ")}
    </span>
  );
}

function SkeletonRows() {
  return (
    <div className="grid grid-cols-1 gap-4" aria-hidden>
      {[0, 1].map((i) => (
        <div key={i} className="space-y-1.5">
          <div className="h-3 w-16 rounded bg-muted" />
          <div className={cn("h-2.5 w-full", USAGE_BAR_TRACK_CLASS)}>
            <div className="h-full w-1/3 animate-pulse rounded-full bg-fg/10" />
          </div>
        </div>
      ))}
    </div>
  );
}

// ── provider row ─────────────────────────────────────────────────

function ProviderLimitsRow({
  provider,
  theme,
  windows,
  connection,
  status,
  messages,
  spendControlReached,
  dailyUsage7d,
  nowMs,
  reducedMotion,
  refreshing,
  onRefresh,
  divided,
}: {
  provider: UsageProvider;
  theme: ThemeId;
  windows: UsageWindow[];
  connection: AiProviderConnectionStatus | null;
  status: UsageProviderStatus | null;
  messages: NonNullable<UsageSnapshot["providerMessages"]>;
  spendControlReached: boolean;
  dailyUsage7d: number[] | null;
  nowMs: number;
  reducedMotion: boolean;
  refreshing: boolean;
  onRefresh: () => Promise<UsageRefreshOutcome>;
  divided: boolean;
}) {
  const meta = PROVIDER_META[provider];
  const tone = providerColor(provider, theme);
  const isAuthed = connection?.authAvailable !== false;
  const isUsageUnauthed = status?.state === "unauthed";

  const [hovering, setHovering] = useState(false);
  const handleEnter = useCallback(() => setHovering(true), []);
  const handleLeave = useCallback(() => setHovering(false), []);

  // Always one column.
  //
  // This carried a `md:grid-cols-[...]` alternative reached through a `dense`
  // prop, but `dense` is a *viewport* query's replacement and the only caller
  // is a 420px popover that always passes it — the two-column branch was
  // unreachable. Hovering warms the row in the provider's own brand colour.
  const rowClass = cn(
    "group grid grid-cols-1 gap-x-6 gap-y-3 px-4 py-3.5 transition-[background-color] duration-150 motion-reduce:transition-none",
    divided && "border-t border-separator",
  );
  const rowStyle = hovering
    ? { background: `color-mix(in srgb, ${tone} 9%, transparent)` }
    : undefined;

  // Dismissal is per mount, so it survives re-renders and provider polls but
  // not closing the popover or leaving the page.
  const [dismissed, setDismissed] = useState(false);
  const dismiss = useCallback(() => setDismissed(true), []);

  /**
   * A retry for *this* provider. Success means this provider's own status came
   * back `ok` — a snapshot that refreshed the other provider and left this one
   * failing is not a success here, and reporting it as one is how the old
   * button managed to look like it worked while nothing changed.
   */
  const retryProvider = useCallback(async (): Promise<UsageRefreshOutcome> => {
    const outcome = await onRefresh();
    if (!outcome.ok) return outcome;
    const nextStatus = outcome.snapshot?.providerStatus?.[provider] ?? null;
    if (nextStatus && nextStatus.state !== "ok") {
      return { ok: false, snapshot: outcome.snapshot, error: nextStatus.message ?? null };
    }
    return outcome;
  }, [onRefresh, provider]);

  const statusNotice = status && status.state !== "ok" && !dismissed
    ? (
      <ProviderStatusNotice
        status={status}
        hasReadings={windows.length > 0}
        nowMs={nowMs}
        onRetry={retryProvider}
        onDismiss={dismiss}
      />
    )
    : null;

  const identity = (
    <div className="flex min-w-0 flex-col gap-1">
      <ProviderHeading
        provider={provider}
        color={tone}
        label={meta.label}
        usageUrl={meta.usageUrl}
        dim={windows.length === 0 && (!isAuthed || isUsageUnauthed)}
      />
      <span className={cn(USAGE_TEXT.micro, USAGE_NUMERIC_CLASS, "text-muted-fg")}>
        {providerSourceLine(status, nowMs)}
      </span>
    </div>
  );

  if (windows.length === 0 && (!isAuthed || isUsageUnauthed)) {
    return (
      <div
        className={rowClass}
        style={rowStyle}
        onMouseEnter={handleEnter}
        onMouseLeave={handleLeave}
      >
        {identity}
        <div className="self-center">
          {statusNotice ?? (
            <NoticeRow
              message={status?.message ?? "Not signed in"}
              actionLabel="Reconnect"
              onAction={() => void onRefresh()}
              actionDisabled={refreshing}
            />
          )}
        </div>
      </div>
    );
  }

  const fiveHourWindow = windows.find((w) => w.windowType === "five_hour");
  const weeklyWindow = windows.find((w) => w.windowType === "weekly");
  const monthlyWindow = windows.find((w) => w.windowType === "monthly");
  const trendWindow = weeklyWindow ?? monthlyWindow;
  const secondaryWindows = [
    ...(monthlyWindow && monthlyWindow !== trendWindow ? [monthlyWindow] : []),
    ...windows.filter((w) => w !== fiveHourWindow && w !== weeklyWindow && w !== monthlyWindow),
  ];
  const has7d = !!dailyUsage7d && dailyUsage7d.some((value) => value > 0);
  const modelBreakdown = trendWindow?.modelBreakdown;

  return (
    <div
      className={rowClass}
      style={rowStyle}
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
    >
      <div className="flex min-w-0 flex-col gap-2">
        {identity}
        {modelBreakdown ? <ModelSplitLine breakdown={modelBreakdown} /> : null}
        {has7d && dailyUsage7d ? (
          <div className="flex items-center gap-2">
            <Sparkline7d data={dailyUsage7d} color={tone} nowMs={nowMs} />
            <span className={cn(USAGE_TEXT.micro, "text-muted-fg")}>7d</span>
          </div>
        ) : null}
      </div>

      <div className="flex min-w-0 flex-col gap-3">
        {spendControlReached ? <NoticeRow message="Spending cap reached" /> : null}

        {/* A failed refresh sits above the readings it could not update — with
            the provider's own words, an honest retry, and a dismiss (see
            `ProviderStatusNotice`). It never claims the bars are gone. */}
        {statusNotice}

        {messages.slice(0, 1).map((message) => (
          <div
            key={message.id}
            className={cn(
              USAGE_TEXT.micro,
              "rounded-md border bg-surface-recessed px-2.5 py-1.5 leading-relaxed text-muted-fg",
              USAGE_HAIRLINE_CLASS,
            )}
            title={message.message}
          >
            <span className="mr-1.5 font-semibold text-fg/75">
              {message.kind === "headline" ? "Notice" : "Update"}
            </span>
            {message.message}
          </div>
        ))}

        {windows.length > 0 ? (
          /* One window per line, always.
           *
           * This was a `sm:grid-cols-2 xl:grid-cols-3` responsive grid. Those
           * are *viewport* queries, and the app window behind the 420px popover
           * satisfies them — which is how two pace bars ended up side by side
           * in a column too narrow for either. A pace bar is a label, a track,
           * and a sentence of pacing text; it wants the full width of whatever
           * it is in. There is no width at which stacking them is wrong, so
           * there is no breakpoint here to get wrong. */
          <div className="grid grid-cols-1 gap-y-4">
            {fiveHourWindow ? (
              <UsagePaceBar
                window={fiveHourWindow}
                providerColor={tone}
                nowMs={nowMs}
                reducedMotion={reducedMotion}
              />
            ) : null}
            {trendWindow ? (
              <UsagePaceBar
                window={trendWindow}
                providerColor={tone}
                nowMs={nowMs}
                reducedMotion={reducedMotion}
                showTrend
              />
            ) : null}
            {secondaryWindows.map((window) => (
              <UsagePaceBar
                key={`${provider}-${window.windowType}`}
                window={window}
                providerColor={tone}
                nowMs={nowMs}
                reducedMotion={reducedMotion}
              />
            ))}
          </div>
        ) : status?.state === "error" ? (
          <div className={cn(USAGE_TEXT.detail, "text-muted-fg")}>
            {status.message ?? "Couldn't reach this provider — retrying"}
          </div>
        ) : (
          <SkeletonRows />
        )}
      </div>
    </div>
  );
}

function ProviderHeading({
  provider,
  color,
  label,
  usageUrl,
  dim,
}: {
  provider: UsageProvider;
  color: string;
  label: string;
  usageUrl?: string;
  dim?: boolean;
}) {
  const Logo = provider === "claude" ? ClaudeLogo : provider === "codex" ? CodexLogo : null;
  const providerLabel = PROVIDER_META[provider].label;
  return (
    <div className="flex items-center gap-2">
      {Logo ? (
        <Logo size={16} className={cn("shrink-0 text-fg", dim && "opacity-55")} />
      ) : (
        <span
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ background: color, opacity: dim ? 0.5 : 1 }}
        />
      )}
      <span className={cn(USAGE_TEXT.body, "font-semibold tracking-[-0.01em] text-fg")}>{label}</span>
      {usageUrl ? (
        <button
          type="button"
          onClick={() => openExternalUrl(usageUrl)}
          className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-fg hover:bg-muted hover:text-fg"
          aria-label={`Open ${providerLabel} usage in browser`}
          title={`Open ${providerLabel} usage in browser`}
        >
          <ArrowSquareOut size={12} weight="regular" />
        </button>
      ) : null}
    </div>
  );
}

// ── extra usage (monthly spend) ──────────────────────────────────

/** ISO 4217 alphabetic code shape — the only thing `Intl` accepts as a currency. */
const ISO_4217 = /^[A-Za-z]{3}$/;

function ExtraUsageCard({
  extra,
  theme,
  reducedMotion,
}: {
  extra: ExtraUsage;
  theme: ThemeId;
  reducedMotion: boolean;
}) {
  if (!extra.isEnabled) return null;
  if (extra.provider === "cursor") return null;

  const meta = PROVIDER_META[extra.provider];
  const tone = providerColor(extra.provider, theme);
  const usedUsd = extra.usedCreditsUsd;
  const limitUsd = extra.monthlyLimitUsd;
  // Clamped at both ends. The provider payload supplies `usedCreditsUsd`
  // unvalidated, and a negative drove both the pressure colour and a negative
  // CSS bar width.
  const percent = limitUsd > 0 ? Math.max(0, Math.min(100, (usedUsd / limitUsd) * 100)) : 0;
  const fillColor = usagePressureColor(percent, tone);
  // `Intl` throws a RangeError — during render, taking the whole band down — on
  // anything that is not a well-formed ISO 4217 code, and the currency arrives
  // from a provider payload. Anything else falls back to USD.
  // `currency` is a required string on `ExtraUsage`, so the guard is about its
  // *value*, not its presence: `Intl` throws a RangeError — during render,
  // taking the whole band down — on anything that is not well-formed ISO 4217.
  const currency = ISO_4217.test(extra.currency) ? extra.currency.toUpperCase() : "USD";
  const formatUsd = (v: number) => formatCost(v, currency);

  return (
    <div className={cn(USAGE_CARD_CLASS, "px-4 py-3.5")}>
      <div className="flex items-center justify-between gap-3">
        <ProviderHeading
          provider={extra.provider}
          color={tone}
          label={`${meta.label} extra usage`}
          usageUrl={meta.usageUrl}
        />
        <span className={cn(USAGE_TEXT.detail, USAGE_NUMERIC_CLASS, "text-fg")}>
          {formatUsd(usedUsd)}
          {limitUsd > 0 ? <span className="text-muted-fg"> / {formatUsd(limitUsd)}</span> : null}
        </span>
      </div>

      {limitUsd > 0 ? (
        <div className={cn("mt-2.5 h-2.5 w-full", USAGE_BAR_TRACK_CLASS)}>
          <div
            className="h-full rounded-full"
            style={{
              width: `${percent}%`,
              background: fillColor,
              transition: reducedMotion ? undefined : "width 700ms cubic-bezier(0.22,1,0.36,1)",
            }}
          />
        </div>
      ) : (
        <div className={cn(USAGE_TEXT.micro, "mt-2 text-muted-fg")}>No monthly limit configured</div>
      )}
    </div>
  );
}
