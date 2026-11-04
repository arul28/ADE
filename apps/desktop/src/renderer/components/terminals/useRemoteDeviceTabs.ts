import { useEffect } from "react";
import {
  activeRemoteWorkOnRow,
  remoteAndroidEmulatorUses,
  remoteSimulatorUses,
  remoteWorkUseKey,
} from "../../../shared/chatRemoteWork";
import type { TerminalSessionSummary } from "../../../shared/types/sessions";
import type { WorkSidebarTab } from "../../state/appStore";

/** The device tools a chat can drive on another machine, and how to find those uses. */
const REMOTE_DEVICE_TOOLS: ReadonlyArray<{
  tool: WorkSidebarTab;
  uses: (row: TerminalSessionSummary) => ReturnType<typeof remoteSimulatorUses>;
}> = [
  { tool: "ios", uses: remoteSimulatorUses },
  { tool: "android", uses: remoteAndroidEmulatorUses },
];

const SEEN_STORAGE_KEY = "ade.work.remoteDeviceTabs.seen.v1";
/** Enough for many chats' turns; the oldest go first. */
const SEEN_LIMIT = 200;

/**
 * The remote device uses of a chat's current turn, one key each.
 *
 * A use is one tool on one machine (and project there) in one turn. Turn
 * start, not `lastStartedAt`, ends the key: every command on that machine
 * moves `lastStartedAt`, and a tab the person closed must stay closed for the
 * rest of the turn. A device flag that turns true mid-turn is a new key,
 * because the tool is part of it.
 */
export function remoteDeviceUseKeys(
  row: TerminalSessionSummary | null | undefined,
): Array<{ tool: WorkSidebarTab; key: string }> {
  if (!row) return [];
  const active = new Set(activeRemoteWorkOnRow(row).map(remoteWorkUseKey));
  if (!active.size) return [];
  const out: Array<{ tool: WorkSidebarTab; key: string }> = [];
  for (const { tool, uses } of REMOTE_DEVICE_TOOLS) {
    for (const use of uses(row)) {
      const useKey = remoteWorkUseKey(use);
      if (!active.has(useKey)) continue;
      out.push({ tool, key: `${row.id}|${tool}|${useKey}|${row.currentTurnStartedAt || use.lastStartedAt}` });
    }
  }
  return out;
}

function readSeen(): string[] {
  try {
    const raw = window.localStorage.getItem(SEEN_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function writeSeen(seen: string[]): void {
  try {
    window.localStorage.setItem(SEEN_STORAGE_KEY, JSON.stringify(seen.slice(-SEEN_LIMIT)));
  } catch {
    // Without storage a reload can add a closed tab back; nothing breaks.
  }
}

/**
 * When the pane's chat starts using a device on another machine (iOS
 * Simulator or Android emulator), adds that tool's tab to the open pane's
 * strip, behind the tab on screen.
 *
 * Once per use: the keys it has acted on are kept across reloads, so a tab
 * the person closes does not come back. A closed pane or a tab already in the
 * strip gets nothing more than the live dot on the tile, and the use still
 * counts as seen, so opening the pane later does not add the tab either.
 */
export function useRemoteDeviceTabs({
  session,
  paneOpen,
  openTools,
  addTool,
}: {
  /** The chat the pane serves; null when the pane serves no chat. */
  session: TerminalSessionSummary | null;
  paneOpen: boolean;
  openTools: readonly WorkSidebarTab[];
  addTool: (tool: WorkSidebarTab) => void;
}): void {
  const uses = remoteDeviceUseKeys(session);
  const signature = uses.map((use) => use.key).join("\n");
  const stripKey = openTools.join(",");
  useEffect(() => {
    if (!signature) return;
    const seen = readSeen();
    const fresh = uses.filter((use) => !seen.includes(use.key));
    if (!fresh.length) return;
    for (const use of fresh) {
      if (paneOpen && !openTools.includes(use.tool)) addTool(use.tool);
    }
    writeSeen([...seen, ...fresh.map((use) => use.key)]);
    // The signature and the strip key stand for `uses` and `openTools`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addTool, paneOpen, signature, stripKey]);
}
