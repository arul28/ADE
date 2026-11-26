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
import {
  chatMentionTitle,
  isMentionablePr,
  laneMentionSuggestion,
  mentionEpoch,
  parseChatMentionKindFilter,
  prMentionSuggestion,
  rankChatMentionMenu,
} from "../../../shared/chatMentions";
import { chatToolProvider, isChatToolType } from "../../../shared/sessionSpawnNesting";
import type { ChatMentionSuggestion } from "../../../shared/types/chatMentions";
import { fetchAccountMachines } from "../../lib/account";
import type { CrossMachineMachineLanes } from "../../state/appStore";
import { laneDisplayName, sessionLaneDisplayName } from "../../../shared/laneDisplayName";

/** How long one menu query waits for a cold machine read before it answers without it. */
const MACHINE_MENU_WAIT_MS = 800;
/** After a failed read, the menu asks again only after this (each keystroke would wait again). */
const MACHINE_FAILURE_PAUSE_MS = 5_000;

let machineReadFailedAt = 0;

/**
 * The account's machines as menu rows, from the window's shared list
 * (`fetchAccountMachines`, kept 15 s, dropped on an account change). A cold
 * read waits at most `MACHINE_MENU_WAIT_MS`; it goes on and fills the cache
 * for the next query. `localMachineKey` is the chat's own machine, labeled
 * "this machine".
 */
async function accountMachineMentionRows(localMachineKey: string | null): Promise<ChatMentionSuggestion[]> {
  if (Date.now() - machineReadFailedAt < MACHINE_FAILURE_PAUSE_MS) return [];
  const read = fetchAccountMachines().then((result) => {
    if (result.state === "ok") return result.machines;
    machineReadFailedAt = Date.now();
    if (result.state !== "signed_out") console.warn("[chat] account machines read for the @ menu failed", result.state, result.message ?? "");
    return null;
  });
  let timer: ReturnType<typeof setTimeout> | null = null;
  const machines = await Promise.race([
    read,
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

/**
 * A resting computer's chats, lanes and open PRs as its saved Work slice
 * shows them: the same ids its own menu gives, so a sent chip resolves on
 * the computer once it is awake. Terminals are left out (their processes do
 * not outlast a sleep).
 */
function restingMachineMentionRows(
  entry: Pick<CrossMachineMachineLanes, "sessions" | "lanes" | "prs">,
  excludeSessionId: string | null,
): ChatMentionSuggestion[][] {
  const laneNames = new Map(entry.lanes.map((lane) => [lane.id, laneDisplayName(lane)]));
  const chats: ChatMentionSuggestion[] = entry.sessions
    .filter((session) => isChatToolType(session.toolType) && !session.archivedAt && session.id !== excludeSessionId)
    .map((session) => ({
      kind: "chat",
      id: session.id,
      title: chatMentionTitle(session),
      // As the brain writes it: lane · provider · status.
      subtitle: [laneNames.get(session.laneId) ?? sessionLaneDisplayName(session), chatToolProvider(session.toolType), session.status].filter(Boolean).join(" · "),
      lastActivityAt: mentionEpoch(session.lastActivityAt) ?? mentionEpoch(session.startedAt),
    }));
  const lanes = entry.lanes.filter((lane) => !lane.archivedAt).map(laneMentionSuggestion);
  const prs = entry.prs.filter(isMentionablePr).map((pr) => prMentionSuggestion(pr, laneNames.get(pr.laneId)));
  return [chats, lanes, prs];
}

/**
 * The menu from the chat machine's own rows and the window's rows. A kind the
 * machine answered keeps its rows; the window's rows fill a kind it left
 * empty (all of them while the computer rests). Ranked as the brain ranks.
 */
function mergeMentionRows(machineRows: ChatMentionSuggestion[], windowRows: ChatMentionSuggestion[][], rawQuery: string): ChatMentionSuggestion[] {
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

/**
 * The chat's @-menu for one query. `away` is the Work slice of the chat's
 * ADE Cloud computer while it rests or is gone: then `machineRows` is never
 * called, since a read must not wake it. The account's machines join only
 * when the machine's answer has none and the query may show machines.
 */
export async function chatMentionMenu(args: {
  query: string;
  machineRows: () => Promise<ChatMentionSuggestion[]>;
  away: Pick<CrossMachineMachineLanes, "sessions" | "lanes" | "prs"> | null;
  excludeSessionId: string | null;
  /** The chat's own machine, labeled "this machine". */
  localMachineKey: string | null;
}): Promise<ChatMentionSuggestion[]> {
  const query = args.query.trim();
  const kind = parseChatMentionKindFilter(query).kind;
  // Started with the machine's read, so a fill never waits after it.
  const accountRead = kind == null || kind === "machine" ? accountMachineMentionRows(args.localMachineKey) : null;
  const fromMachine = args.away ? [] : await args.machineRows();
  const accountMachines = accountRead && !fromMachine.some((row) => row.kind === "machine") ? await accountRead : [];
  const windowRows = args.away
    ? [...restingMachineMentionRows(args.away, args.excludeSessionId), accountMachines]
    : [accountMachines];
  return mergeMentionRows(fromMachine, windowRows, query);
}
