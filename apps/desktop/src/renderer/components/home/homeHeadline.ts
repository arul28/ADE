import type { AdeUsageDailyPoint } from "../../../shared/types";

/**
 * The line under the greeting, built from what the page already loaded. One
 * sentence, picked by priority:
 *
 *   blocked → momentum → milestone → welcome back → capacity → all clear
 *
 * Blocked is anything waiting on you (a chat asking a question, failing
 * checks, requested changes, the providers you use out of headroom); what is
 * left of the sentence carries momentum. Momentum is work moving (merges,
 * PRs ready, chats working, a streak). A milestone is a streak or record
 * worth a word. Welcome back covers a return after days away. Capacity warns
 * that a limit you would hit is getting tight. All clear is the rest. Never a
 * canned quote: every clause names a number the page can show.
 *
 * Limits only count when they would stop you: a provider you used in the
 * last week, at its best account (a second login with headroom means you are
 * not stuck), or most of your providers at once. One idle provider at 0% is
 * not news.
 */

export type HeadlineKind = "blocked" | "momentum" | "milestone" | "welcomeBack" | "capacity" | "allClear";

export type HomeHeadline = {
  kind: HeadlineKind;
  text: string;
  /** Where a click on the line goes. */
  target?: "prs" | "activity" | "usage";
};

export type HeadlineLimit = {
  /** Provider id (`claude`, `codex`, …), matched against the daily per-provider usage. */
  provider: string;
  providerLabel: string;
  percentLeft: number;
  resetsInMs: number;
};

export type HeadlineInput = {
  needsYou: number;
  working: number;
  /** Null when no project is open (no PR data to speak for). */
  prs: { failing: number; changes: number; ready: number; mergedToday: number; mergedThisWeek: number } | null;
  daily: readonly AdeUsageDailyPoint[] | null;
  streakDays: number;
  longestStreakDays: number;
  limits: readonly HeadlineLimit[];
  today: string;
};

const STREAK_MILESTONES = new Set([7, 14, 21, 30, 50, 75, 100, 150, 200, 250, 300, 365, 500, 730, 1000]);

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function sentence(clauses: string[]): string {
  const parts = clauses.filter(Boolean);
  if (parts.length === 0) return "";
  const joined = parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
  return `${joined.charAt(0).toUpperCase()}${joined.slice(1)}.`;
}

function hoursLabel(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "soon";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `in ${Math.max(1, minutes)}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)} days`;
}

function daysBetween(fromDay: string, toDay: string): number {
  const parse = (day: string) => {
    const [y, m, d] = day.split("-").map(Number);
    return Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  };
  return Math.round((parse(toDay) - parse(fromDay)) / 86_400_000);
}

function active(point: AdeUsageDailyPoint): boolean {
  return point.sessions > 0 || point.totalTokens > 0 || point.commits > 0;
}

/** Days back a provider counts as one you use. */
const RECENT_DAYS = 7;
/** At or under this much headroom a provider stops you. */
const OUT_PERCENT = 5;
/** At or under this much it is getting tight. */
const TIGHT_PERCENT = 20;

type ProviderLimit = HeadlineLimit & { recent: boolean };

/**
 * One entry per provider, at its best account, marked when you used it in
 * the last week. Without a per-provider split of the days (older hosts),
 * nothing is marked: only "most providers are out" can speak then.
 */
function providerLimits(limits: readonly HeadlineLimit[], daily: readonly AdeUsageDailyPoint[] | null, today: string): ProviderLimit[] {
  const used = new Set<string>();
  for (const point of daily ?? []) {
    const age = daysBetween(point.date, today);
    if (age < 0 || age > RECENT_DAYS || !point.byProvider) continue;
    for (const [key, value] of Object.entries(point.byProvider)) if (value.totalTokens > 0) used.add(key.toLowerCase());
  }
  const isRecent = (provider: string) => {
    const id = provider.toLowerCase();
    for (const key of used) if (key === id || key.startsWith(`${id}-`) || key.startsWith(`${id}_`) || key.startsWith(`${id}:`)) return true;
    return false;
  };
  const best = new Map<string, HeadlineLimit>();
  for (const limit of limits) {
    const current = best.get(limit.provider);
    if (!current || limit.percentLeft > current.percentLeft) best.set(limit.provider, limit);
  }
  return [...best.values()].map((limit) => ({ ...limit, recent: isRecent(limit.provider) }));
}

function lowest<T extends { percentLeft: number }>(list: readonly T[]): T {
  return list.reduce((a, b) => (b.percentLeft < a.percentLeft ? b : a));
}

function soonest<T extends { resetsInMs: number }>(list: readonly T[]): T {
  return list.reduce((a, b) => (b.resetsInMs < a.resetsInMs ? b : a));
}

/** The clause for providers that would stop you, or null when none would. */
function outClause(providers: readonly ProviderLimit[]): string | null {
  const out = providers.filter((limit) => limit.percentLeft <= OUT_PERCENT);
  if (out.length === 0) return null;
  // Most of them at once: you are stuck whichever you pick.
  if (providers.length >= 2 && out.length * 3 >= providers.length * 2) {
    const next = soonest(out);
    return out.length === providers.length
      ? `every provider is out until ${next.providerLabel} resets ${hoursLabel(next.resetsInMs)}`
      : `${out.length} of ${providers.length} providers are out until ${next.providerLabel} resets ${hoursLabel(next.resetsInMs)}`;
  }
  const yours = out.filter((limit) => limit.recent);
  if (yours.length === 0) return null;
  const tightest = lowest(yours);
  return `${tightest.providerLabel} is at ${Math.round(tightest.percentLeft)}% until it resets ${hoursLabel(tightest.resetsInMs)}`;
}

export function buildHomeHeadline(input: HeadlineInput): HomeHeadline {
  const { prs } = input;

  const today = input.daily?.find((point) => point.date === input.today) ?? null;
  const providers = providerLimits(input.limits, input.daily, input.today);

  // ── momentum (read first: it fills out a blocked sentence too) ──
  const momentum: string[] = [];
  if (prs && prs.mergedToday > 0) momentum.push(`${plural(prs.mergedToday, "PR")} merged today`);
  if (prs && prs.ready > 0) momentum.push(prs.mergedToday > 0 ? `${prs.ready} ready to merge` : `${plural(prs.ready, "PR")} ready to merge`);
  if (input.working > 0) momentum.push(`${plural(input.working, "chat")} working`);
  if (prs && prs.mergedToday === 0 && prs.mergedThisWeek > 0) momentum.push(`${plural(prs.mergedThisWeek, "PR")} merged this week`);
  if (momentum.length < 2 && today && today.commits > 0) momentum.push(`${plural(today.commits, "commit")} today`);
  // A streak rounds out a sentence; on its own it is a milestone (below).
  const filler = [...momentum, ...(input.streakDays >= 3 ? [`a ${input.streakDays}-day streak`] : [])];

  // ── blocked ──
  const blocked: string[] = [];
  let blockedTarget: HomeHeadline["target"];
  if (input.needsYou > 0) {
    blocked.push(`${plural(input.needsYou, "chat")} ${input.needsYou === 1 ? "is" : "are"} waiting on you`);
    blockedTarget = "activity";
  }
  if (prs && prs.failing > 0) {
    blocked.push(`${plural(prs.failing, "PR")} ${prs.failing === 1 ? "is" : "are"} failing checks`);
    blockedTarget = prs.failing > input.needsYou ? "prs" : blockedTarget ?? "prs";
  }
  if (prs && prs.changes > 0) {
    blocked.push(`${plural(prs.changes, "PR")} ${prs.changes === 1 ? "has" : "have"} changes requested`);
    blockedTarget ??= "prs";
  }
  const out = outClause(providers);
  if (out) {
    blocked.push(out);
    blockedTarget ??= "usage";
  }
  if (blocked.length > 0) {
    // Room left in the sentence goes to what is moving.
    const clauses = [...blocked.slice(0, 3), ...filler].slice(0, Math.max(2, Math.min(3, blocked.length)));
    return { kind: "blocked", text: sentence(clauses), target: blockedTarget };
  }

  if (momentum.length > 0) {
    return {
      kind: "momentum",
      text: sentence(filler.slice(0, 3)),
      target: input.working > 0 && !(prs && (prs.mergedToday > 0 || prs.ready > 0)) ? "activity" : prs ? "prs" : "activity",
    };
  }

  // ── milestone ──
  const streak = input.streakDays;
  if (streak >= 3 && streak === input.longestStreakDays) {
    return { kind: "milestone", text: `${streak} days in a row, your longest streak yet.`, target: "usage" };
  }
  if (STREAK_MILESTONES.has(streak)) {
    return { kind: "milestone", text: `${streak} days in a row. Keep it going.`, target: "usage" };
  }
  if (today && input.daily && today.totalTokens > 0) {
    const month = input.daily.filter((point) => point.date !== input.today && daysBetween(point.date, input.today) <= 30);
    const activeDays = month.filter(active).length;
    if (activeDays >= 7 && month.every((point) => point.totalTokens < today.totalTokens)) {
      return { kind: "milestone", text: "Your busiest day in a month.", target: "usage" };
    }
  }
  if (prs && prs.mergedThisWeek >= 5) {
    return { kind: "milestone", text: `${plural(prs.mergedThisWeek, "PR")} merged this week.`, target: "prs" };
  }

  // ── welcome back ──
  if (input.daily && (!today || !active(today))) {
    const last = [...input.daily].reverse().find((point) => point.date < input.today && active(point));
    if (last) {
      const away = daysBetween(last.date, input.today);
      if (away >= 2) return { kind: "welcomeBack", text: `Welcome back. Your last session was ${away} days ago.` };
    }
  }

  // ── capacity ──
  const tight = providers.filter((limit) => limit.recent && limit.percentLeft <= TIGHT_PERCENT);
  if (tight.length > 0) {
    const tightest = lowest(tight);
    return {
      kind: "capacity",
      text: `${tightest.providerLabel} is down to ${Math.round(tightest.percentLeft)}%. It resets ${hoursLabel(tightest.resetsInMs)}.`,
      target: "usage",
    };
  }

  return { kind: "allClear", text: "All clear. Nothing is failing and nothing is waiting on you." };
}
