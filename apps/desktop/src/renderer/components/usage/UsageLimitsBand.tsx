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
import { ArrowClockwise, ArrowSquareOut, Gauge } from "@phosphor-icons/react";
import type {
  AiProviderConnectionStatus,
  AiProviderConnections,
  ExtraUsage,
  UsageProvider,
  UsageProviderStatus,
  UsageSnapshot,
  UsageWindow,
} from "../../../shared/types";
import { usageProviderAccountUrl } from "../../../shared/types";
import { formatCost } from "../../lib/format";
import { openExternalUrl } from "../../lib/openExternal";
import { usePrefersReducedMotion } from "../../hooks/usePrefersReducedMotion";
import { type ThemeId, useAppStore } from "../../state/appStore";
import { cn } from "../ui/cn";
import { Banner } from "../ui/notice";
import { providerColor } from "./providerColors";
import { ProviderMark, UsageAccountRow } from "./UsageAccountRow";
import {
  USAGE_BAR_TRACK_CLASS,
  USAGE_CARD_CLASS,
  USAGE_DIVIDER_COLOR_CLASS,
  USAGE_NUMERIC_CLASS,
  USAGE_TEXT,
  usagePressureColor,
} from "./usageDesign";
import { formatUpdatedAge } from "./usageWindowFormat";
import {
  type AccountLimitRow,
  type UsageAccountView,
  buildAccountRows,
  poolAccounts,
  quotaPopoverProviders,
} from "./usageLimitModel";
import type { UsageRefreshOutcome, UsageSnapshotSource } from "./useUsageSnapshot";

// Display names only. The limits URL is NOT re-listed here: it comes from
// `usageProviderAccountUrl`, which is also what the host stamps onto
// `UsageProviderStatus.accountUrl` for iOS and the web client. A second map of
// the same thing is one edit away from the popover and the heading opening
// different pages.
function providerConnection(
  connections: AiProviderConnections | null,
  provider: UsageProvider,
): AiProviderConnectionStatus | null {
  if (!connections || provider === "opencode") return null;
  return connections[provider] ?? null;
}

const PROVIDER_META: Record<UsageProvider, { label: string }> = {
  claude: { label: "Claude" },
  codex: { label: "Codex" },
  cursor: { label: "Cursor" },
  copilot: { label: "Copilot" },
  grok: { label: "Grok" },
  opencode: { label: "OpenCode" },
  kimi: { label: "Kimi" },
};

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

  // The provider's sentence is already the first line of this notice;
  // repeating it here just says it twice.
  const failureLine = !blocked && phase === "failed"
    ? (failureDetail && failureDetail !== message
      ? `Still failing: ${failureDetail}`
      : "Tried again just now — still failing.")
    : undefined;

  const outcomeLine = blocked ? (
    <span style={{ fontSize: 11.5, lineHeight: 1.45, color: "var(--color-muted-fg)" }}>
      Retries again in {formatWaitShort(blockedForMs)}.
    </span>
  ) : phase === "succeeded" ? (
    <span style={{ fontSize: 11.5, lineHeight: 1.45, color: "var(--color-muted-fg)" }}>Refreshed.</span>
  ) : undefined;

  return (
    <Banner
      layout="inline"
      model={{
        id: `usage-provider-status:${status.state}`,
        tone: "warning",
        title: message,
        // The bars below are still real. Say so, so "couldn't refresh" is never
        // read as "the numbers are gone".
        detail: hasReadings ? (
          <>
            Figures below are the last good reading, from{" "}
            {formatUpdatedAge(status.lastSuccessAt ?? status.updatedAt, nowMs)}.
          </>
        ) : undefined,
        actions: [
          {
            label: actionLabel,
            icon: <ArrowClockwise size={11} />,
            onClick: () => void handleRetry(),
            busy: phase === "pending",
            disabled: blocked,
            title: blocked ? "Rate-limited — the next attempt runs on its own" : undefined,
          },
        ],
        dismiss: { onDismiss, title: "Dismiss until you open usage again", label: "Dismiss this warning" },
        extra: outcomeLine,
        error: failureLine,
      }}
    />
  );
}

/** A quiet inline notice with an optional action, on theme tokens. */
function NoticeRow({
  message,
  actionLabel,
  onAction,
  actionDisabled,
}: {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  actionDisabled?: boolean;
}) {
  return (
    <Banner
      layout="inline"
      model={{
        id: `usage-notice:${message}`,
        tone: "neutral",
        title: message,
        actions: actionLabel && onAction
          ? [{ label: actionLabel, onClick: onAction, disabled: actionDisabled }]
          : undefined,
      }}
    />
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

  const visibleProviders = useMemo<UsageProvider[]>(() => quotaPopoverProviders({
    connections: providerConnections,
    windows: snapshot?.windows,
    statuses: snapshot?.providerStatus,
  }), [providerConnections, snapshot?.windows, snapshot?.providerStatus]);

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

  // Accounts are pooled once for the whole band: the same login reported by two
  // machines is one account everywhere it appears, not once per provider row.
  const accounts = useMemo(() => poolAccounts(snapshot?.accounts), [snapshot?.accounts]);

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
        // A logo, a hairline, then the accounts. The old rounded box made every
        // provider a card stacked on the popover's own card.
        <div className="flex flex-col">
          {visibleProviders.map((provider) => (
            <ProviderLimitsRow
              key={provider}
              provider={provider}
              theme={theme}
              windows={windowsByProvider[provider] ?? []}
              accounts={accounts}
              connection={providerConnection(providerConnections, provider)}
              status={snapshot?.providerStatus?.[provider] ?? null}
              messages={(snapshot?.providerMessages ?? []).filter((message) => message.provider === provider)}
              spendControlReached={provider === "codex" && snapshot?.spendControlReached === true}
              nowMs={nowMs}
              reducedMotion={reducedMotion}
              refreshing={refreshing}
              onRefresh={refreshNow}
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
  accounts,
  connection,
  status,
  messages,
  spendControlReached,
  nowMs,
  reducedMotion,
  refreshing,
  onRefresh,
}: {
  provider: UsageProvider;
  theme: ThemeId;
  windows: UsageWindow[];
  accounts: UsageAccountView[];
  connection: AiProviderConnectionStatus | null;
  status: UsageProviderStatus | null;
  messages: NonNullable<UsageSnapshot["providerMessages"]>;
  spendControlReached: boolean;
  nowMs: number;
  reducedMotion: boolean;
  refreshing: boolean;
  onRefresh: () => Promise<UsageRefreshOutcome>;
}) {
  const meta = PROVIDER_META[provider];
  const isAuthed = connection?.authAvailable !== false;
  const isUsageUnauthed = status?.state === "unauthed";

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

  const usageUrl = status?.accountUrl ?? usageProviderAccountUrl(provider);
  const sourceLine = providerSourceLine(status, nowMs);
  // One row per account, each with that account's own windows stacked.
  const rows = buildAccountRows(provider, windows, accounts, nowMs);
  const dim = windows.length === 0 && (!isAuthed || isUsageUnauthed);

  /**
   * The row a provider shows before it has any readings.
   *
   * Its key is the one `buildAccountRows` gives an account-less row, so the
   * first real reading REPLACES this row rather than remounting beside it. A
   * different key here made React tear the row down and build a new one the
   * moment the snapshot landed, which threw away hover and popover state.
   */
  const identityRows: AccountLimitRow[] = rows.length > 0
    ? rows
    : [{ key: `${provider}:this-machine`, provider, account: null, cells: [] }];

  return (
    <section data-provider-limits={provider} className="flex min-w-0 flex-col gap-2 py-2 first:pt-0">
      {/* Logo, then a hairline, then the accounts. The name stays for the
          screen reader; the mark is what the row shows. */}
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2" title={`${meta.label} · ${sourceLine}`}>
          <ProviderMark provider={provider} size={18} dim={dim} />
          <span className="sr-only">{meta.label}</span>
        </span>
        {usageUrl ? (
          <button
            type="button"
            onClick={() => openExternalUrl(usageUrl)}
            className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-fg hover:bg-muted hover:text-fg"
            aria-label={`Open ${meta.label} limits in browser`}
            title={`Open ${meta.label} limits in browser`}
          >
            <ArrowSquareOut size={12} weight="regular" />
          </button>
        ) : null}
      </div>
      <div data-provider-divider className={cn("border-b", USAGE_DIVIDER_COLOR_CLASS)} />

      <div className="flex min-w-0 flex-col gap-2">
      {spendControlReached ? <NoticeRow message="Spending cap reached" /> : null}

      {/* A failed refresh sits above the readings it could not update — with
          the provider's own words, an honest retry, and a dismiss (see
          `ProviderStatusNotice`). It never claims the bars are gone. */}
      {statusNotice}

      {messages.slice(0, 1).map((message) => (
        <Banner
          key={message.id}
          layout="inline"
          model={{
            id: `usage-message:${message.id}`,
            tone: "info",
            title: message.kind === "headline" ? "Notice" : "Update",
            detail: message.message,
          }}
        />
      ))}

      {identityRows.map((row) => (
        <UsageAccountRow
          key={row.key}
          row={row}
          theme={theme}
          providerTitle={sourceLine}
          fallbackAccountUrl={usageUrl}
          fallbackEmail={status?.accountEmail ?? null}
          nowMs={nowMs}
          reducedMotion={reducedMotion}
          dim={dim}
        />
      ))}

      {rows.length > 0 ? null : dim ? (
        statusNotice ? null : (
          <NoticeRow
            message={status?.message ?? "Not signed in"}
            actionLabel="Reconnect"
            onAction={() => void onRefresh()}
            actionDisabled={refreshing}
          />
        )
      ) : status?.state === "error" ? (
        <div className={cn(USAGE_TEXT.detail, "text-muted-fg")}>
          {status.message ?? "Couldn't reach this provider — retrying"}
        </div>
      ) : (
        <SkeletonRows />
      )}
      </div>
    </section>
  );
}

function ProviderHeading({
  provider,
  label,
  usageUrl,
}: {
  provider: UsageProvider;
  label: string;
  usageUrl?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <ProviderMark provider={provider} size={16} />
      <span className={cn(USAGE_TEXT.body, "font-semibold tracking-[-0.01em] text-fg")}>{label}</span>
      {usageUrl ? (
        <button
          type="button"
          onClick={() => openExternalUrl(usageUrl)}
          className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-fg hover:bg-muted hover:text-fg"
          aria-label={`Open ${label} usage in browser`}
          title={`Open ${label} usage in browser`}
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
          label={`${meta.label} extra usage`}
          usageUrl={usageProviderAccountUrl(extra.provider)}
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
