import type {
  AgentChatCrossMachineHandoffMachineOption,
  AgentChatSessionSummary,
  TerminalSessionSummary,
} from "../../../shared/types";
import { providerSupportsCrossMachineHandoffFork } from "../../../shared/types/chat";
import { isTrackedAgentCliToolType } from "../../../shared/types/sessions";
import { chatToolProvider, isChatToolType } from "../../../shared/sessionSpawnNesting";
import { crossMachineMoveLock } from "../../../shared/crossMachineMoveLock";

/**
 * Where a lane moves from, which decides how its move runs:
 *
 * - `own`: one of the person's computers. The brain's batch move carries the
 *   lane and its chats to the other computer.
 * - `cloud`: an awake ADE Cloud computer. The same batch move runs; when it
 *   is done and checked, ADE deletes the cloud computer.
 * - `cloudAsleep`: an ADE Cloud computer at rest. The destination restores the
 *   lane from what the computer saved when it went to sleep, so nothing wakes.
 * - `cloudGone`: the lane's ADE Cloud computer was deleted. The destination
 *   restores the lane from the same saved copies.
 */
export type LaneMoveSourceKind = "own" | "cloud" | "cloudAsleep" | "cloudGone";

/** A move from saved copies runs on the destination; a live move runs on the lane's own brain. */
export function laneMoveRestores(kind: LaneMoveSourceKind): boolean {
  return kind === "cloudAsleep" || kind === "cloudGone";
}

/** How much of a chat's history arrives: all of it, or a written summary of it. */
export type LaneMoveChatHistory = "full" | "summary";

/** A chat or tracked agent CLI the move carries, as the dialog lists it. */
export type LaneMoveItem = {
  sessionId: string;
  title: string;
  kind: "chat" | "cli";
  /** The provider or CLI tool, for its logo. */
  provider: string;
  history: LaneMoveChatHistory;
};

/** The CLIs whose own conversation file a move carries (`cliCrossMachineMove.ts`); the rest start again from a summary. */
const CLI_TOOLS_WITH_FULL_HISTORY = new Set(["claude", "codex", "claude-orchestrated", "codex-orchestrated"]);

/**
 * What a live move carries for a lane: its Work chats and tracked agent CLIs,
 * as the source brain's batch selects them. `rows` is the lane's session list
 * on its machine; `workChats` its chat list there, which leaves out chats of
 * other surfaces (CTO, personal), so a batch is never refused for one. A chat
 * that already continues on another machine is that machine's and stays out.
 */
export function laneMoveItems(
  rows: readonly TerminalSessionSummary[],
  workChats: readonly Pick<AgentChatSessionSummary, "sessionId" | "provider" | "surface">[],
): LaneMoveItem[] {
  const work = new Map(workChats.filter((chat) => (chat.surface ?? "work") === "work").map((chat) => [chat.sessionId, chat]));
  const items: LaneMoveItem[] = [];
  for (const row of rows) {
    if (row.archivedAt || crossMachineMoveLock(row.crossMachineHandoff)) continue;
    if (isChatToolType(row.toolType)) {
      const chat = work.get(row.id);
      if (!chat || row.settledAt) continue;
      const provider = chat.provider || chatToolProvider(row.toolType) || "";
      items.push({
        sessionId: row.id,
        title: row.title?.trim() || "Untitled chat",
        kind: "chat",
        provider,
        history: providerSupportsCrossMachineHandoffFork(provider) ? "full" : "summary",
      });
    } else if (row.tracked && isTrackedAgentCliToolType(row.toolType)) {
      const tool = row.toolType ?? "";
      items.push({
        sessionId: row.id,
        title: row.title?.trim() || "CLI session",
        kind: "cli",
        provider: tool.replace(/-orchestrated$/, "").replace(/-cli$/, ""),
        history: CLI_TOOLS_WITH_FULL_HISTORY.has(tool) ? "full" : "summary",
      });
    }
  }
  return items;
}

/**
 * The machines a lane may move to, in menu order: this computer first, then
 * those that can take it now, then the rest, each by name. The lane's own
 * machine never shows: a move needs another one.
 */
export function orderLaneMoveMachines(
  machines: readonly AgentChatCrossMachineHandoffMachineOption[],
  options: { thisMachineKey: string | null; sourceMachineKey: string | null },
): AgentChatCrossMachineHandoffMachineOption[] {
  const same = (a: string | null, b: string | null) => Boolean(a && b && a.toLowerCase() === b.toLowerCase());
  const rank = (machine: AgentChatCrossMachineHandoffMachineOption) =>
    same(machine.machineKey, options.thisMachineKey) ? 0 : laneMoveMachineReady(machine) ? 1 : 2;
  return machines
    .filter((machine) => !same(machine.machineKey, options.sourceMachineKey))
    .slice()
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/** The machine can take a lane now: it is on, and its brain names no reason it can't. */
export function laneMoveMachineReady(machine: AgentChatCrossMachineHandoffMachineOption): boolean {
  return machine.online && !machine.unavailableReason;
}
