// The short action menu every transcript chip shows on a held hover or a
// right-click (see `useChipHoverCard`).
//
// Rules, so every chip's menu reads the same:
//   - At most four rows. The first is the chip's primary action (what a click
//     does) when it has one; the last is always a copy row.
//   - One coloured icon per row, from `MenuIconTone`: blue opens inside ADE,
//     sky opens outside it, violet inserts into the prompt, quiet grey copies.
//   - Every action that reaches an entity goes to the CHAT's machine. The
//     builder never routes anything itself; it calls the openers the chip
//     already resolved with the chat's scope.

import {
  ArrowSquareOut,
  At,
  Browser,
  ChatCircle,
  Copy,
  File,
  FolderOpen,
  GearSix,
  GitBranch,
  GitCommit,
  GitPullRequest,
  Hash,
  Images,
  Link,
  Rows,
  TerminalWindow,
  type Icon,
} from "@phosphor-icons/react";

import type { Chip } from "../../../shared/chips";
import type { OpenProjectBinding } from "../../../shared/types/core";
import { copyTextToClipboard } from "../../lib/launchPromptClipboard";
import type { ContextMenuEntry } from "../ui/ContextMenu";

export type ChipMenuContext = {
  /** The pill's display label, after enrichment. */
  label: string;
  /** The chip's primary action, or null when a click does nothing. */
  open: (() => void) | null;
  /**
   * Kind-specific rows the chip resolved itself (a machine's "Open in
   * Connections"), placed right after the primary row.
   */
  extra?: ContextMenuEntry[];
  /** The chat's machine pin, for "Open in ▸" on a link. */
  runtimePin?: OpenProjectBinding | null;
};

const OPEN_LABEL: Partial<Record<Chip["kind"], { label: string; icon: Icon }>> = {
  chat: { label: "Open chat", icon: ChatCircle },
  lane: { label: "Open lane", icon: Rows },
  terminal: { label: "Open terminal", icon: TerminalWindow },
  file: { label: "Open file", icon: File },
  folder: { label: "Open folder", icon: FolderOpen },
  pr: { label: "Open pull request", icon: GitPullRequest },
  commit: { label: "Open commit", icon: GitCommit },
  branch: { label: "Open branch", icon: GitBranch },
  artifact: { label: "Open proof", icon: Images },
  browser_tab: { label: "Show tab", icon: Browser },
  mcp: { label: "Open MCP settings", icon: GearSix },
};

function copyRow(key: string, label: string, text: string, icon: Icon = Copy): ContextMenuEntry {
  return { kind: "item", key, label, icon, onSelect: () => void copyTextToClipboard(text) };
}

/** What the copy row copies: the thing a user would paste somewhere else. */
function copyRows(chip: Chip): ContextMenuEntry[] {
  const source = chip.source;
  switch (source.origin) {
    case "url":
      return [copyRow("copy-link", "Copy link", source.url, Link)];
    case "deeplink":
      return [copyRow("copy-link", "Copy ADE link", source.url, Link)];
    case "path":
      return [copyRow("copy-path", "Copy path", source.path)];
    case "mention":
      return [copyRow("copy-mention", "Copy mention", chip.token, At)];
    case "skill":
      return [copyRow("copy-command", "Copy command", `/${source.name}`)];
    case "browser_tab":
      return source.url ? [copyRow("copy-link", "Copy link", source.url, Link)] : [];
    case "attachment":
      return [];
    default:
      return [copyRow("copy", "Copy", chip.token)];
  }
}

export function buildChipMenuEntries(chip: Chip, context: ChipMenuContext): ContextMenuEntry[] {
  const rows: ContextMenuEntry[] = [];
  const { open } = context;
  if (open) {
    const preset = OPEN_LABEL[chip.kind];
    const external = chip.source.origin === "url" && preset === undefined;
    rows.push({
      kind: "item",
      key: "open",
      label: preset?.label ?? (external ? "Open link" : "Open"),
      icon: preset?.icon ?? ArrowSquareOut,
      tone: external ? "sky" : "blue",
      onSelect: open,
    });
  }
  rows.push(...(context.extra ?? []));
  const source = chip.source;
  if (source.origin === "url" && /^https?:\/\//i.test(source.url)) {
    rows.push({ kind: "open-link-in", key: "open-in", url: source.url, runtimePin: context.runtimePin ?? null });
  }
  rows.push(...copyRows(chip));
  // A commit's SHA is what people paste, not its URL.
  if (chip.kind === "commit" && /^[0-9a-f]{7,40}$/i.test(chip.label)) {
    rows.push(copyRow("copy-sha", "Copy SHA", chip.label, Hash));
  }
  return rows;
}
