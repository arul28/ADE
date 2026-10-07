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
import { formatCountdown } from "./usageWindowFormat";
import "./usageSurfaces.css";
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
    <button type="button" onClick={onClick} aria-pressed={active}>
      {children}
    </button>
  );
}

function meterLevel(percentLeft: number): "warn" | "crit" | undefined {
  if (percentLeft <= 5) return "crit";
  if (percentLeft <= 20) return "warn";
  return undefined;
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
  const percent = Math.round(card.percentLeft);
  // One account and one reading: its reset is the card's reset, so the row
  // list below would only repeat the headline.
  const single = card.segments.length === 1 ? card.segments[0]! : null;
  return (
    <div className="usage-pool-card">
      <span className="kit-eyebrow">{card.label}</span>
      <div className="flex items-baseline gap-1.5">
        <span className="usage-fact-value" style={meterLevel(card.percentLeft) ? { color: `var(--kit-${meterLevel(card.percentLeft)})` } : undefined}>{percent}%</span>
        <span className="usage-card-sub">left</span>
      </div>
      <div
        className="flex gap-1"
        role="img"
        aria-label={`${label}: ${percent} percent left across ${card.segments.length} account${card.segments.length === 1 ? "" : "s"}`}
      >
        {card.segments.map((segment, index) => (
          <div key={segment.account?.id ?? index} className="kit-meter flex-1" data-level={meterLevel(segment.percentLeft)}>
            <span style={{ width: `${segment.percentLeft}%` }} />
          </div>
        ))}
      </div>
      <span className="usage-stat-detail">
        {card.forecast
          ? `↻ +${Math.round(card.forecast.percent)}% in ${formatCountdown(card.forecast.resetsInMs)}`
          : single
            ? `resets in ${formatCountdown(single.resetsInMs)}`
            : "\u00a0"}
        {single ? ` · ${accountLabel(single)}` : ""}
      </span>
      {single ? null : (
        <div className="flex flex-col">
          {card.segments.map((segment, index) => {
            const key = `${card.key}:${segment.account?.id ?? index}`;
            const open = openKey === key;
            const detail = accountDetail(segment.account);
            return (
              <div key={key} style={{ borderTop: "1px solid var(--kit-rule)" }}>
                <button
                  type="button"
                  onClick={() => onToggle(open ? null : key)}
                  aria-expanded={open}
                  className="flex w-full items-center justify-between gap-2 py-1 text-left"
                  title={detail ? `${accountLabel(segment)} — ${detail}` : accountLabel(segment)}
                >
                  <span className="usage-account-email" style={{ fontSize: 11.5 }}>
                    {accountLabel(segment)}
                  </span>
                  <span className="usage-limit-value">
                    {Math.round(segment.percentLeft)}% · {formatCountdown(segment.resetsInMs)}
                  </span>
                </button>
                {open && detail ? (
                  <p className="usage-footnote pb-1.5">{detail}</p>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
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
    <section className="flex flex-col gap-4" aria-label="Pooled live limits">
      {/* The machine filter only earns its space with more than one machine. */}
      {environments.length > 1 ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="kit-eyebrow">
            Pooled across {selectedCount} computer{selectedCount === 1 ? "" : "s"}
          </span>
          <div className="kit-seg flex-wrap" data-case="sentence" role="group" aria-label="Computers">
            <FilterChip active={selected === null} onClick={() => setSelected(null)}>All</FilterChip>
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
      ) : null}
      {selectedCount === 0 ? (
        <p className="usage-footnote">
          No computers selected. Pick one above to see its limits.
        </p>
      ) : groups.length === 0 ? (
        <p className="usage-footnote">
          {onlyFailedSelection
            ? "That computer didn't report its limits."
            : "No live limits reported by the selected computers."}
        </p>
      ) : (
        groups.map(({ provider, cards }) => (
          <div key={provider} className="flex flex-col gap-2.5">
            <span className="usage-provider-name">
              {PROVIDER_LABEL[provider] ?? provider}
            </span>
            <div className="usage-pool-grid">
              {cards.map((card) => (
                <PooledCard key={card.key} card={card} openKey={openKey} onToggle={setOpenKey} />
              ))}
            </div>
          </div>
        ))
      )}
    </section>
  );
}
