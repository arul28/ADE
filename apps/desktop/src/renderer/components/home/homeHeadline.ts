import type { AdeUsageDailyPoint } from "../../../shared/types";

/**
 * The line under the greeting, built from what the page already loaded. One
 * sentence, picked by priority:
 *
 *   blocked → momentum → milestone → welcome back → capacity → all clear
 *
 * Blocked is anything waiting on you (failing checks, requested changes, a
 * chat asking a question, a provider out of headroom). Momentum is work moving
 * (merges today, PRs ready, chats working). A milestone is a streak or record
 * worth a word. Welcome back covers a return after days away. Capacity warns
 * that a limit is getting tight. All clear is the rest. Never a canned quote:
 * every clause names a number the page can show.
 */

export type HeadlineKind = "blocked" | "momentum" | "milestone" | "welcomeBack" | "capacity" | "allClear";

export type HomeHeadline = {
  kind: HeadlineKind;
  text: string;
  /** Where a click on the line goes. */
  target?: "prs" | "activity" | "usage";
};

export type HeadlineLimit = { providerLabel: string; percentLeft: number; resetsInMs: number };

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

export function buildHomeHeadline(input: HeadlineInput): HomeHeadline {
  const { prs } = input;

  // ── blocked ──
  const blocked: string[] = [];
  let blockedTarget: HomeHeadline["target"];
  if (prs && prs.failing > 0) {
    blocked.push(`${plural(prs.failing, "PR")} ${prs.failing === 1 ? "is" : "are"} failing checks`);
    blockedTarget = "prs";
  }
  if (prs && prs.changes > 0) {
    blocked.push(`${plural(prs.changes, "PR")} ${prs.changes === 1 ? "has" : "have"} changes requested`);
    blockedTarget ??= "prs";
  }
  if (input.needsYou > 0) {
    blocked.push(`${plural(input.needsYou, "chat")} ${input.needsYou === 1 ? "is" : "are"} waiting on you`);
    blockedTarget = input.needsYou >= (prs?.failing ?? 0) ? "activity" : blockedTarget;
  }
  const exhausted = input.limits.filter((limit) => limit.percentLeft <= 5);
  if (exhausted.length > 0) {
    const tightest = exhausted.reduce((a, b) => (b.percentLeft < a.percentLeft ? b : a));
    blocked.push(`${tightest.providerLabel} has ${Math.round(tightest.percentLeft)}% left until it resets ${hoursLabel(tightest.resetsInMs)}`);
    blockedTarget ??= "usage";
  }
  if (blocked.length > 0) return { kind: "blocked", text: sentence(blocked.slice(0, 3)), target: blockedTarget };

  // ── momentum ──
  const today = input.daily?.find((point) => point.date === input.today) ?? null;
  const momentum: string[] = [];
  if (prs && prs.mergedToday > 0) momentum.push(`${plural(prs.mergedToday, "PR")} merged today`);
  if (prs && prs.ready > 0) momentum.push(prs.mergedToday > 0 ? `${prs.ready} ready to merge` : `${plural(prs.ready, "PR")} ready to merge`);
  if (input.working > 0) momentum.push(`${plural(input.working, "chat")} working`);
  if (momentum.length < 2 && today && today.commits > 0) momentum.push(`${plural(today.commits, "commit")} today`);
  if (momentum.length > 0) {
    return {
      kind: "momentum",
      text: sentence(momentum.slice(0, 3)),
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
  const tight = input.limits.filter((limit) => limit.percentLeft <= 20);
  if (tight.length > 0) {
    const tightest = tight.reduce((a, b) => (b.percentLeft < a.percentLeft ? b : a));
    return {
      kind: "capacity",
      text: `${tightest.providerLabel} is down to ${Math.round(tightest.percentLeft)}%. It resets ${hoursLabel(tightest.resetsInMs)}.`,
      target: "usage",
    };
  }

  return { kind: "allClear", text: "All clear. Nothing is failing and nothing is waiting on you." };
}
