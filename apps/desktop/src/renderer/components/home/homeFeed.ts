import type { AttentionItem } from "../../../shared/types/attention";
import type { AutoUpdateSnapshot, NormalizedLinearIssue } from "../../../shared/types";
import type { HomePr } from "../projects/ProjectWelcomeHome";
import { normalizePathForComparison } from "../../lib/pathUtils";

/**
 * The home feed: one timeline of what happened across projects and machines,
 * built only from what the renderer already holds or one cheap read returns —
 * the Activity stream (chats and PRs on every machine), the open project's PR
 * snapshot, the auto-update state, Linear's assigned issues (only when Linear
 * is connected) and the machine list. Nothing here fetches; the widget feeds
 * it.
 */

export type HomeFeedKind =
  | "pr_merged"
  | "chat_done"
  | "chat_failed"
  | "chat_needs_you"
  | "release"
  | "linear_assigned"
  | "machine_online"
  | "machine_offline";

export type HomeFeedTarget =
  | { kind: "attention"; item: AttentionItem }
  | { kind: "prs" }
  | { kind: "url"; url: string }
  | { kind: "linear"; identifier: string; url: string | null }
  | { kind: "machines" }
  | { kind: "none" };

export type HomeFeedProject = { name: string; rootPath?: string | null; canonicalId?: string | null };

export type HomeFeedEvent = {
  /** Stable across rebuilds, so React keeps rows and dedupe works. */
  id: string;
  kind: HomeFeedKind;
  /** Epoch ms. */
  at: number;
  title: string;
  /** Project, machine or state, already joined for the second line. */
  detail: string | null;
  project: HomeFeedProject | null;
  /** The machine a machine_online / machine_offline event is about. */
  machineName?: string;
  target: HomeFeedTarget;
};

function epoch(value: string | number | null | undefined): number | null {
  if (value == null) return null;
  const ms = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function joinDetail(...parts: Array<string | null | undefined>): string | null {
  const kept = parts.map((part) => part?.trim()).filter((part): part is string => Boolean(part));
  return kept.length > 0 ? kept.join(" · ") : null;
}

/** Chats and PRs from the account's Activity stream, on every machine. */
export function feedFromAttention(items: Iterable<AttentionItem>): HomeFeedEvent[] {
  const events: HomeFeedEvent[] = [];
  for (const item of items) {
    if (item.dismissedAt) continue;
    const at = epoch(item.statusSince) ?? epoch(item.updatedAt) ?? epoch(item.occurredAt);
    if (at == null) continue;
    const project: HomeFeedProject = { name: item.project.name, rootPath: item.project.rootPath, canonicalId: item.project.canonicalId };
    if (item.kind === "pull_request") {
      if (item.phase !== "merged") continue;
      const destination = item.destination.kind === "pull_request" ? item.destination : null;
      events.push({
        id: prKey(destination?.repoName ?? item.project.name, destination?.number ?? null, item.id),
        kind: "pr_merged",
        at,
        // The Activity title is "PR #12 merged"; the preview carries the PR's own title.
        title: item.preview?.trim() || item.title,
        detail: joinDetail(destination ? `#${destination.number}` : null, item.project.name),
        project,
        target: { kind: "attention", item },
      });
      continue;
    }
    const kind: HomeFeedKind | null = item.phase === "completed"
      ? "chat_done"
      : item.phase === "failed"
        ? "chat_failed"
        : item.phase === "needs_you"
          ? "chat_needs_you"
          : null;
    if (!kind) continue;
    events.push({
      id: `chat:${item.id}`,
      kind,
      at,
      title: item.title,
      detail: joinDetail(item.project.name, item.machine.name),
      project,
      target: { kind: "attention", item },
    });
  }
  return events;
}

function prKey(repo: string, number: number | null, fallback: string): string {
  return number != null ? `pr:${repo.toLowerCase()}#${number}` : `pr:${fallback}`;
}

/** The open project's merges, from the PR snapshot the home page already holds. */
export function feedFromProjectPrs(prs: readonly HomePr[], projectName: string | null, projectRoot: string | null): HomeFeedEvent[] {
  const events: HomeFeedEvent[] = [];
  for (const pr of prs) {
    if (pr.state !== "merged") continue;
    const at = epoch(pr.mergedAt) ?? epoch(pr.updatedAt);
    if (at == null) continue;
    const repo = pr.repo.split("/").at(-1) ?? pr.repo;
    events.push({
      id: prKey(repo, pr.number, pr.id),
      kind: "pr_merged",
      at,
      title: pr.title,
      detail: joinDetail(`#${pr.number}`, projectName ?? pr.repo, pr.author),
      project: projectName ? { name: projectName, rootPath: projectRoot } : null,
      target: { kind: "prs" },
    });
  }
  return events;
}

/** An ADE release this computer installed. */
export function feedFromUpdate(snapshot: AutoUpdateSnapshot | null): HomeFeedEvent[] {
  const installed = snapshot?.recentlyInstalled;
  const at = epoch(installed?.installedAt);
  if (!installed || at == null) return [];
  const url = installed.releaseNotesUrl ?? installed.githubReleaseUrl;
  return [{
    id: `release:${installed.version}`,
    kind: "release",
    at,
    title: `ADE ${installed.version} installed`,
    detail: url ? "Release notes" : null,
    project: null,
    target: url ? { kind: "url", url } : { kind: "none" },
  }];
}

const LINEAR_CLOSED = new Set(["completed", "canceled", "cancelled"]);

/** Open Linear issues assigned to you. */
export function feedFromLinear(issues: readonly NormalizedLinearIssue[]): HomeFeedEvent[] {
  const events: HomeFeedEvent[] = [];
  for (const issue of issues) {
    if (LINEAR_CLOSED.has(issue.stateType) || issue.archivedAt) continue;
    const at = epoch(issue.updatedAt) ?? epoch(issue.createdAt);
    if (at == null) continue;
    events.push({
      id: `linear:${issue.id}`,
      kind: "linear_assigned",
      at,
      title: `${issue.identifier} ${issue.title}`,
      detail: joinDetail(issue.stateName, issue.projectName ?? issue.teamName),
      project: null,
      target: { kind: "linear", identifier: issue.identifier, url: issue.url },
    });
  }
  return events;
}

export type MachinePresenceEntry = { key: string; name: string; online: boolean; at: number };

export function feedFromMachines(entries: readonly MachinePresenceEntry[]): HomeFeedEvent[] {
  return entries.map((entry) => ({
    id: `machine:${entry.key}:${entry.at}`,
    kind: entry.online ? "machine_online" : "machine_offline",
    at: entry.at,
    title: `${entry.name} ${entry.online ? "came online" : "went offline"}`,
    detail: null,
    project: null,
    machineName: entry.name,
    target: { kind: "machines" },
  }));
}

/** Newest first; one row per id (the Activity copy of a PR wins over the snapshot's). */
export function mergeFeed(...sources: HomeFeedEvent[][]): HomeFeedEvent[] {
  const byId = new Map<string, HomeFeedEvent>();
  for (const source of sources) {
    for (const event of source) {
      if (!byId.has(event.id)) byId.set(event.id, event);
    }
  }
  return [...byId.values()].sort((a, b) => b.at - a.at);
}

/** Folds case only for Windows-shaped paths: a Linux checkout's case is significant. */
function normalizePath(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? normalizePathForComparison(trimmed) || null : null;
}

export type PinnedProjectRef = { name: string; rootPaths: string[] };

/**
 * Only what happened in a pinned project. Events that are not about a project
 * (releases, Linear, machines) are about you, so they stay.
 */
export function filterToPinned(events: readonly HomeFeedEvent[], pinned: readonly PinnedProjectRef[]): HomeFeedEvent[] {
  const paths = new Set(pinned.flatMap((ref) => ref.rootPaths.map(normalizePath).filter((p): p is string => p != null)));
  const names = new Set(pinned.map((ref) => ref.name.trim().toLowerCase()).filter(Boolean));
  return events.filter((event) => {
    if (!event.project) return true;
    const path = normalizePath(event.project.rootPath);
    if (path && paths.has(path)) return true;
    return names.has(event.project.name.trim().toLowerCase());
  });
}

export type HomeFeedGroup = { id: "today" | "yesterday" | "week"; label: string; events: HomeFeedEvent[] };

function startOfDay(ms: number): number {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** Today, Yesterday, This week (the five days before). Older events are dropped. */
export function groupFeed(events: readonly HomeFeedEvent[], now = Date.now()): HomeFeedGroup[] {
  const today = startOfDay(now);
  const yesterday = startOfDay(today - 1);
  const weekStart = startOfDay(today - 6 * 86_400_000);
  const groups: HomeFeedGroup[] = [
    { id: "today", label: "Today", events: [] },
    { id: "yesterday", label: "Yesterday", events: [] },
    { id: "week", label: "This week", events: [] },
  ];
  for (const event of events) {
    if (event.at >= today) groups[0]!.events.push(event);
    else if (event.at >= yesterday) groups[1]!.events.push(event);
    else if (event.at >= weekStart) groups[2]!.events.push(event);
  }
  return groups.filter((group) => group.events.length > 0);
}

/** How long a gap counts as "away". */
export const HOME_AWAY_THRESHOLD_MS = 4 * 3_600_000;

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function formatGap(ms: number): string {
  const hours = Math.round(ms / 3_600_000);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)} days`;
}

/**
 * "While you were away" from the same events: counts per kind since the user
 * was last here, in a fixed order (what needs you first). Null when nothing
 * happened or the gap was short.
 */
export function awaySummary(events: readonly HomeFeedEvent[], awaySince: number | null, now = Date.now()): { gap: string; parts: string[] } | null {
  if (awaySince == null || now - awaySince < HOME_AWAY_THRESHOLD_MS) return null;
  const counts = new Map<HomeFeedKind, number>();
  const cameOnline = new Set<string>();
  for (const event of events) {
    if (event.at < awaySince) continue;
    counts.set(event.kind, (counts.get(event.kind) ?? 0) + 1);
    if (event.kind === "machine_online" && event.machineName) cameOnline.add(event.machineName);
  }
  const parts: string[] = [];
  const add = (kind: HomeFeedKind, text: (n: number) => string) => {
    const n = counts.get(kind) ?? 0;
    if (n > 0) parts.push(text(n));
  };
  add("chat_needs_you", (n) => `${plural(n, "chat")} need${n === 1 ? "s" : ""} you`);
  add("chat_failed", (n) => `${plural(n, "chat")} failed`);
  add("pr_merged", (n) => `${plural(n, "PR")} merged`);
  add("chat_done", (n) => `${plural(n, "chat")} finished`);
  add("linear_assigned", (n) => `${plural(n, "Linear issue")} for you`);
  add("release", () => "ADE updated");
  if (cameOnline.size > 0) parts.push(`${[...cameOnline].slice(0, 2).join(" and ")}${cameOnline.size > 2 ? ` and ${cameOnline.size - 2} more` : ""} came online`);
  add("machine_offline", (n) => `${plural(n, "machine")} went offline`);
  if (parts.length === 0) return null;
  return { gap: formatGap(now - awaySince), parts };
}
