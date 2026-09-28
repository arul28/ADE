/**
 * Pooled live limits — the Usage page's "All machines" view.
 *
 * The top-bar popover keeps this machine's live limits; this panel pools every
 * machine on the ADE account into one reading per account, with an environment
 * filter. The same login signed in on two machines reports the same window, so
 * `poolLiveQuota` counts it once (freshest reading per account + window label),
 * and an account contributes only the windows it actually reports — a
 * monthly-only account adds nothing to a session or weekly bar.
 *
 * The arithmetic is the shared `poolLiveQuota` + `buildLimitCards`, so this
 * panel and the popover can never disagree about one number.
 */
import { useEffect, useMemo, useState } from "react";
import type {
  AdeUsageLiveEnvironment,
  UsageProvider,
} from "../../../shared/types";
import { poolLiveQuota } from "../../../shared/usageLiveQuota";
import { cn } from "../ui/cn";
import { formatCountdown } from "./usageWindowFormat";
import {
  USAGE_BAR_TRACK_CLASS,
  USAGE_CARD_CLASS,
  USAGE_DIVIDER_COLOR_CLASS,
  USAGE_EYEBROW_CLASS,
  USAGE_NUMERIC_CLASS,
  USAGE_PANEL_HEADER_CLASS,
  USAGE_SEGMENT_ITEM_ACTIVE_CLASS,
  USAGE_SEGMENT_ITEM_CLASS,
  USAGE_SEGMENT_ITEM_IDLE_CLASS,
  USAGE_TEXT,
  usageHeadroomColor,
} from "./usageDesign";
import {
  buildLimitCards,
  emailInitials,
  orderLimitCards,
  type LimitCard,
  type LimitSegment,
  type UsageAccountView,
} from "./usageLimitModel";

const PROVIDER_LABEL: Record<UsageProvider, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  copilot: "Copilot",
  grok: "Grok",
  opencode: "OpenCode",
  kimi: "Kimi",
};

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        USAGE_TEXT.micro,
        USAGE_SEGMENT_ITEM_CLASS,
        active ? USAGE_SEGMENT_ITEM_ACTIVE_CLASS : USAGE_SEGMENT_ITEM_IDLE_CLASS,
      )}
    >
      {children}
    </button>
  );
}

function accountLabel(segment: LimitSegment): string {
  const account = segment.account;
  return account?.email ?? account?.label ?? "This machine";
}

function accountDetail(account: UsageAccountView | null): string | null {
  if (!account) return null;
  const machines = account.machines.map((machine) => machine.label).filter(Boolean);
  return [account.plan, machines.join(", ")].filter(Boolean).join(" · ") || null;
}

function PooledCard({
  card,
  openKey,
  onToggle,
}: {
  card: LimitCard;
  openKey: string | null;
  onToggle: (key: string | null) => void;
}) {
  const label = `${card.provider} ${card.label}`;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className={cn(USAGE_TEXT.micro, "text-muted-fg")}>{card.label}</span>
        <span className={cn(USAGE_TEXT.micro, USAGE_NUMERIC_CLASS, "text-fg")}>
          {Math.round(card.percentLeft)}% left
        </span>
      </div>
      <div
        className="flex h-2 gap-0.5"
        role="img"
        aria-label={`${label}: ${Math.round(card.percentLeft)} percent left across ${card.segments.length} account${card.segments.length === 1 ? "" : "s"}`}
      >
        {card.segments.map((segment, index) => (
          <div key={segment.account?.id ?? index} className={cn(USAGE_BAR_TRACK_CLASS, "h-full flex-1")}>
            <div
              className="h-full rounded-full"
              style={{ width: `${segment.percentLeft}%`, background: usageHeadroomColor(segment.percentLeft) }}
            />
          </div>
        ))}
      </div>
      <div className="flex flex-col">
        {card.segments.map((segment, index) => {
          const key = `${card.key}:${segment.account?.id ?? index}`;
          const open = openKey === key;
          const detail = accountDetail(segment.account);
          return (
            <div key={key} className={cn("border-t", USAGE_DIVIDER_COLOR_CLASS, "first:border-t-0")}>
              <button
                type="button"
                onClick={() => onToggle(open ? null : key)}
                aria-expanded={open}
                className="flex w-full items-center justify-between gap-2 py-1 text-left"
                title={detail ? `${accountLabel(segment)} — ${detail}` : accountLabel(segment)}
              >
                <span className={cn(USAGE_TEXT.micro, "min-w-0 truncate text-muted-fg")}>
                  {accountLabel(segment)}
                </span>
                <span className={cn(USAGE_TEXT.micro, USAGE_NUMERIC_CLASS, "shrink-0 text-fg")}>
                  {Math.round(segment.percentLeft)}% · {formatCountdown(segment.resetsInMs)}
                </span>
              </button>
              {open && detail ? (
                <p className={cn(USAGE_TEXT.micro, "m-0 pb-1.5 text-muted-fg")}>{detail}</p>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function UsagePooledLimits({
  environments,
}: {
  environments: AdeUsageLiveEnvironment[];
}) {
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  // Re-pool from the raw per-environment readings so the filter recomputes the
  // cards rather than hiding rows from a pool that still counts them.
  const pooled = useMemo(() => poolLiveQuota(environments, selected), [environments, selected]);
  const accountViews = useMemo<UsageAccountView[]>(
    () => pooled.accounts.map((account) => ({
      ...account,
      initials: emailInitials(account.email, account.label ?? account.machines[0]?.label),
    })),
    [pooled.accounts],
  );
  const groups = useMemo(() => {
    const providers = [...new Set(pooled.windows.map((window) => window.provider))];
    return providers
      .map((provider) => ({
        provider,
        cards: orderLimitCards(buildLimitCards(provider, pooled.windows, accountViews, nowMs)),
      }))
      .filter((group) => group.cards.length > 0);
  }, [pooled.windows, accountViews, nowMs]);

  const selectedCount = selected ? selected.size : environments.length;
  const toggle = (machineKey: string): void => {
    setSelected((current) => {
      const base = current ?? new Set(environments.map((environment) => environment.machineKey));
      const next = new Set(base);
      if (next.has(machineKey)) next.delete(machineKey);
      else next.add(machineKey);
      return next.size === environments.length ? null : next;
    });
  };
  const onlyFailedSelection = selected?.size === 1
    && environments.find((environment) => environment.machineKey === [...selected][0])?.state === "failed";

  return (
    <section className={cn(USAGE_CARD_CLASS, "flex flex-col")} aria-label="Pooled live limits">
      <div className={cn(USAGE_PANEL_HEADER_CLASS, "flex flex-wrap items-center justify-between gap-2 px-4 py-2.5")}>
        <div className="flex flex-wrap items-baseline gap-2">
          <span className={USAGE_EYEBROW_CLASS}>Live limits</span>
          <span className={cn(USAGE_TEXT.micro, "text-muted-fg")}>
            Pooled across {selectedCount} computer{selectedCount === 1 ? "" : "s"}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <FilterChip active={selected === null} onClick={() => setSelected(null)}>All computers</FilterChip>
          {environments.map((environment) => (
            <FilterChip
              key={environment.machineKey}
              active={selected === null || selected.has(environment.machineKey)}
              onClick={() => toggle(environment.machineKey)}
            >
              {environment.label}
            </FilterChip>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-4 px-4 py-4">
        {selectedCount === 0 ? (
          <p className={cn(USAGE_TEXT.detail, "m-0 text-muted-fg")}>
            No computers selected. Pick one above to see its limits.
          </p>
        ) : groups.length === 0 ? (
          <p className={cn(USAGE_TEXT.detail, "m-0 text-muted-fg")}>
            {onlyFailedSelection
              ? "That computer didn't report its limits."
              : "No live limits reported by the selected computers."}
          </p>
        ) : (
          groups.map(({ provider, cards }) => (
            <div key={provider} className="flex flex-col gap-3">
              <span className={cn(USAGE_TEXT.detail, "font-medium text-fg")}>
                {PROVIDER_LABEL[provider] ?? provider}
              </span>
              {cards.map((card) => (
                <PooledCard key={card.key} card={card} openKey={openKey} onToggle={setOpenKey} />
              ))}
            </div>
          ))
        )}
      </div>
    </section>
  );
}
