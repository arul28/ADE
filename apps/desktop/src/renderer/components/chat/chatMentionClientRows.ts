/**
 * The @-menu rows a window builds itself, with no brain to ask.
 *
 * A chat's menu normally comes from the chat's own machine
 * (`listMentionSuggestions` by its pin). An ADE Cloud chat whose computer
 * rests answers nothing, and a read must never wake it. So the window builds
 * the rows from what it already has: the account's machines (an account
 * read, no pin) and the resting computer's saved chats, lanes and PRs (its
 * Work slice). While the computer is awake, its answer comes first and the
 * account's machines fill only a kind it left empty.
 */

import { accountMachineMentionSuggestion } from "../../../shared/accountMachineSnapshot";
import { isChatMentionId, rankChatMentionMenu } from "../../../shared/chatMentions";
import { isChatToolType } from "../../../shared/sessionSpawnNesting";
import type { AdeAccountMachine } from "../../../shared/types/account";
import type { ChatMentionSuggestion } from "../../../shared/types/chatMentions";
import type { CrossMachineMachineLanes } from "../../state/appStore";

/** The account's machine list is a network read: one read serves the menu this long. */
const MACHINE_CACHE_TTL_MS = 30_000;
/** How long one menu query waits for a cold machine read before it answers without it. */
const MACHINE_MENU_WAIT_MS = 800;

type MachineList = AdeAccountMachine[];

let machineCache: { at: number; promise: Promise<MachineList | null> } | null = null;

function readAccountMachines(): Promise<MachineList | null> {
  const now = Date.now();
  if (machineCache && now - machineCache.at < MACHINE_CACHE_TTL_MS) return machineCache.promise;
  const list = window.ade?.account?.listMachines;
  const promise: Promise<MachineList | null> = list
    ? list().then((result) => (result.state === "ok" ? result.machines : null), () => null)
    : Promise.resolve(null);
  const entry = { at: now, promise };
  machineCache = entry;
  // Only a good read is kept; a failed one is asked again on the next keystroke.
  void promise.then((machines) => {
    if (!machines && machineCache === entry) machineCache = null;
  });
  return promise;
}

/**
 * The account's machines as menu rows. A cold read waits at most
 * `MACHINE_MENU_WAIT_MS`; it goes on and fills the cache for the next query.
 * `localMachineKey` is the chat's own machine, labeled "this machine".
 */
export async function accountMachineMentionRows(localMachineKey: string | null): Promise<ChatMentionSuggestion[]> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const machines = await Promise.race([
    readAccountMachines(),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), MACHINE_MENU_WAIT_MS);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
  if (!machines) return [];
  const nowMs = Date.now();
  return machines.map((machine) => accountMachineMentionSuggestion(machine, { activityItems: null, localMachineKey, nowMs }));
}

function firstLine(value: string | null | undefined, max = 120): string | null {
  const line = value?.split("\n").map((part) => part.trim()).find(Boolean) ?? "";
  if (!line) return null;
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

function epoch(value: string | null | undefined): number | null {
  const ms = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ms) ? ms : null;
}

/**
 * A resting computer's chats, lanes and open PRs as its saved Work slice
 * shows them: the same ids its own menu gives, so a sent chip resolves on
 * the computer once it is awake. Terminals are left out (their processes do
 * not outlast a sleep).
 */
export function restingMachineMentionRows(
  entry: Pick<CrossMachineMachineLanes, "sessions" | "lanes" | "prs">,
  excludeSessionId: string | null,
): ChatMentionSuggestion[][] {
  const laneNames = new Map(entry.lanes.map((lane) => [lane.id, lane.name]));
  const chats: ChatMentionSuggestion[] = entry.sessions
    .filter((session) => isChatToolType(session.toolType) && !session.archivedAt && session.id !== excludeSessionId)
    .map((session) => ({
      kind: "chat",
      id: session.id,
      title: firstLine(session.title) ?? firstLine(session.goal) ?? `Chat ${session.id.slice(0, 8)}`,
      subtitle: [laneNames.get(session.laneId) ?? session.laneName, session.status].filter(Boolean).join(" · "),
      lastActivityAt: epoch(session.lastActivityAt) ?? epoch(session.startedAt),
    }));
  const lanes: ChatMentionSuggestion[] = entry.lanes
    .filter((lane) => !lane.archivedAt)
    .map((lane) => ({
      kind: "lane",
      id: lane.id,
      title: lane.name,
      subtitle: lane.branchRef,
      lastActivityAt: epoch(lane.createdAt),
    }));
  const prs: ChatMentionSuggestion[] = entry.prs
    .filter((pr) => (pr.state === "open" || pr.state === "draft") && isChatMentionId(pr.id))
    .map((pr) => ({
      kind: "pr",
      id: pr.id,
      title: `#${pr.githubPrNumber} ${firstLine(pr.title) ?? "Untitled pull request"}`,
      subtitle: [pr.repoOwner && pr.repoName ? `${pr.repoOwner}/${pr.repoName}` : null, laneNames.get(pr.laneId), pr.state === "draft" ? "draft" : null]
        .filter(Boolean)
        .join(" · "),
      lastActivityAt: epoch(pr.updatedAt) ?? epoch(pr.createdAt),
      pr: { number: pr.githubPrNumber, state: pr.state, checks: pr.checksStatus },
    }));
  return [chats, lanes, prs];
}

/**
 * The menu from the chat machine's own rows and the window's rows. A kind the
 * machine answered keeps its rows; the window's rows fill a kind it left
 * empty (all of them while the computer rests). Ranked as the brain ranks.
 */
export function mergeMentionRows(machineRows: ChatMentionSuggestion[], windowRows: ChatMentionSuggestion[][], rawQuery: string): ChatMentionSuggestion[] {
  const answered = new Set(machineRows.map((row) => row.kind));
  const fill = windowRows.flat().filter((row) => !answered.has(row.kind));
  if (fill.length === 0) return machineRows;
  const byKind = new Map<string, ChatMentionSuggestion[]>();
  for (const row of [...machineRows, ...fill]) {
    const list = byKind.get(row.kind) ?? [];
    if (!list.some((other) => other.id === row.id)) list.push(row);
    byKind.set(row.kind, list);
  }
  return rankChatMentionMenu([...byKind.values()], rawQuery);
}
