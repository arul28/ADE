/**
 * Rate limits as radial gauges: one per provider window (5-hour, weekly,
 * monthly…), pooled across that provider's accounts.
 *
 * The gauge reads in "% left", the same convention as the top-bar rings and
 * the welcome page, and only takes a colour when it means something: warn at
 * 20% left, critical at 5%. A tick on the arc marks where a perfectly steady
 * burn would be by now, so "ahead of pace" is visible without a sentence, and
 * the tag under the number says it in a word (on track / watch / low).
 *
 * Under each gauge, the window's own cycle — "Day 3 of 7" — as a thin bar, the
 * way a billing page shows where you are in the month. Headroom and elapsed
 * time side by side is what tells you whether 40% left is fine (day 6 of 7)
 * or a problem (day 1 of 7).
 */
import React from "react";
import type { UsageWindow } from "../../../shared/types";
import { ProviderMark } from "./UsageAccountRow";
import {
  type LimitCard,
  buildLimitCards,
  headerUsageProviders,
  orderLimitCards,
  poolAccounts,
} from "./usageLimitModel";
import { formatCountdown } from "./usageWindowFormat";
import { useUsageSnapshot } from "./useUsageSnapshot";
import "./usageSurfaces.css";
import { humanizeProvider } from "./usageProviderNames";
import { usageLeftLevel } from "./usageDesign";


const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const DEFAULT_DURATION: Record<UsageWindow["windowType"], number> = {
  five_hour: 5 * HOUR,
  weekly: 7 * DAY,
  weekly_oauth_apps: 7 * DAY,
  weekly_cowork: 7 * DAY,
  monthly: 30 * DAY,
};

const GAUGE = 104;
const STROKE = 7;
const SWEEP = 270;


function polar(cx: number, cy: number, r: number, degrees: number): [number, number] {
  const radians = ((degrees - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(radians), cy + r * Math.sin(radians)];
}

/** An SVG arc from `from` to `to` degrees, clockwise, 0° at 12 o'clock. */
function arcPath(from: number, to: number): string {
  const c = GAUGE / 2;
  const r = (GAUGE - STROKE) / 2;
  const [x1, y1] = polar(c, c, r, from);
  const [x2, y2] = polar(c, c, r, to);
  const large = to - from > 180 ? 1 : 0;
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

/** Where a steady burn would leave this window now, in % left; null if unknown. */
function expectedLeft(card: LimitCard): number | null {
  const expected = card.segments
    .map((segment) => segment.window.pacing?.expectedPercent)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (expected.length === 0) return null;
  const mean = expected.reduce((sum, value) => sum + value, 0) / expected.length;
  return Math.max(0, Math.min(100, 100 - mean));
}

function statusTag(left: number, expected: number | null): { text: string; tone: "ok" | "warn" | "crit" } {
  if (left <= 5) return { text: "low", tone: "crit" };
  if (left <= 20) return { text: "watch", tone: "warn" };
  if (expected != null && left < expected - 10) return { text: "watch", tone: "warn" };
  return { text: "on track", tone: "ok" };
}

/** "Day 3 of 7" / "2h 10m of 5h" for the window the card's soonest reset belongs to. */
function cycleProgress(card: LimitCard): { label: string; fraction: number } | null {
  const segment = card.segments.reduce<LimitCard["segments"][number] | null>(
    (soonest, candidate) => (!soonest || candidate.resetsInMs < soonest.resetsInMs ? candidate : soonest),
    null,
  );
  if (!segment) return null;
  const duration = segment.window.windowDurationMs ?? DEFAULT_DURATION[segment.window.windowType];
  if (!duration || duration <= 0) return null;
  const elapsed = Math.max(0, Math.min(duration, duration - segment.resetsInMs));
  const fraction = elapsed / duration;
  if (duration <= DAY) {
    return { label: `${formatCountdown(elapsed)} of ${Math.round(duration / HOUR)}h`, fraction };
  }
  const totalDays = Math.round(duration / DAY);
  const day = Math.min(totalDays, Math.max(1, Math.ceil(elapsed / DAY)));
  return { label: `Day ${day} of ${totalDays}`, fraction };
}

function Gauge({ card }: { card: LimitCard }) {
  const left = Math.round(card.percentLeft);
  const level = usageLeftLevel(card.percentLeft);
  const expected = expectedLeft(card);
  const tag = statusTag(card.percentLeft, expected);
  const cycle = cycleProgress(card);
  const start = -SWEEP / 2;
  const valueEnd = start + (SWEEP * Math.max(0, Math.min(100, card.percentLeft))) / 100;
  const soonest = card.segments.reduce((min, segment) => Math.min(min, segment.resetsInMs), Number.POSITIVE_INFINITY);
  const fill = level ? `var(--kit-${level})` : "var(--kit-fill)";
  const c = GAUGE / 2;
  const tick = expected != null ? start + (SWEEP * expected) / 100 : null;
  const [tx1, ty1] = tick != null ? polar(c, c, c - STROKE - 3, tick) : [0, 0];
  const [tx2, ty2] = tick != null ? polar(c, c, c + 1, tick) : [0, 0];

  return (
    <div className="usage-gauge" data-level={level}>
      <span className="usage-gauge-title" title={`${humanizeProvider(card.provider)} · ${card.label}`}>
        <ProviderMark provider={card.provider} size={12} />
        <span className="usage-gauge-provider">{humanizeProvider(card.provider)}</span>
        <span className="kit-eyebrow">{card.label}</span>
      </span>
      <div className="usage-gauge-dial" role="img" aria-label={`${humanizeProvider(card.provider)} ${card.label}: ${left}% left${expected != null ? `, steady pace would leave ${Math.round(expected)}%` : ""}`}>
        <svg
          width={GAUGE}
          height={GAUGE}
          viewBox={`0 0 ${GAUGE} ${GAUGE}`}
          aria-hidden
        >
          <path d={arcPath(start, start + SWEEP)} fill="none" stroke="var(--kit-track)" strokeWidth={STROKE} strokeLinecap="round" />
          {card.percentLeft > 0.5 ? (
            <path d={arcPath(start, valueEnd)} fill="none" stroke={fill} strokeWidth={STROKE} strokeLinecap="round" className="usage-gauge-value" />
          ) : null}
          {tick != null ? (
            <line x1={tx1} y1={ty1} x2={tx2} y2={ty2} stroke="var(--color-fg)" strokeOpacity={0.55} strokeWidth={1.5} strokeLinecap="round">
              <title>{`Steady pace would leave ${Math.round(expected ?? 0)}% by now`}</title>
            </line>
          ) : null}
        </svg>
        <div className="usage-gauge-center">
          <span className="usage-gauge-num">{left}<small>%</small></span>
          <span className="kit-tag" data-tone={tag.tone}>{tag.text}</span>
        </div>
      </div>
      <div className="usage-gauge-foot">
        <span>{Number.isFinite(soonest) ? `resets in ${formatCountdown(soonest)}` : "\u00a0"}</span>
      </div>
      {cycle ? (
        <div className="usage-gauge-cycle" title="Where this window is in its cycle">
          <div className="kit-meter"><span style={{ width: `${(cycle.fraction * 100).toFixed(1)}%` }} /></div>
          <span>{cycle.label}</span>
        </div>
      ) : null}
      {card.segments.length > 1 ? <span className="usage-gauge-accounts">{card.segments.length} accounts pooled</span> : null}
    </div>
  );
}

/**
 * This machine's live limits. Reads the same snapshot subscription as the
 * top-bar popover; nothing here polls on its own.
 */
export function UsageLimitGauges() {
  const usage = useUsageSnapshot({ readSnapshot: true, noteDemand: true });
  const { snapshot, bridgeMissing } = usage;
  const [nowMs, setNowMs] = React.useState(() => Date.now());
  React.useEffect(() => {
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [snapshot]);

  const groups = React.useMemo(() => {
    if (!snapshot) return [];
    const accounts = poolAccounts(snapshot.accounts);
    const providers = headerUsageProviders({ connections: null, windows: snapshot.windows, statuses: snapshot.providerStatus });
    return providers
      .map((provider) => ({
        provider,
        cards: orderLimitCards(buildLimitCards(provider, snapshot.windows, accounts, nowMs)),
      }))
      .filter((group) => group.cards.length > 0);
  }, [nowMs, snapshot]);

  if (bridgeMissing) return null;
  if (!snapshot) return <p className="usage-footnote py-6 text-center">Reading limits…</p>;
  if (groups.length === 0) {
    return <p className="usage-footnote py-6 text-center">No provider on this machine reports rate limits yet.</p>;
  }
  // One grid for every provider's windows: each tile names its provider, so
  // five providers with two windows each read as two rows, not five sections.
  return (
    <div className="usage-gauge-grid">
      {groups.flatMap(({ cards }) => cards.map((card) => <Gauge key={card.key} card={card} />))}
    </div>
  );
}
