import React from "react";
import {
  Camera,
  Clock,
  Command,
  DesktopTower,
  FileCode,
  FolderOpen,
  GearSix,
  GithubLogo,
  GitPullRequest,
  HourglassSimple,
  Lightning,
  Plus,
  Pulse,
  Robot,
  SquaresFour,
  Terminal,
  type Icon,
} from "@phosphor-icons/react";
import { LaneIcon } from "../ui/vcsIcons";
import { WORK_TOOL_DEFINITIONS } from "../terminals/workTools";

/** Palette subtitles stay one short line. */
export function paletteCaption(text: string, maxWords = 7): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (!trimmed) return "";
  const words = trimmed.split(" ");
  if (words.length <= maxWords) return trimmed;
  return words.slice(0, maxWords).join(" ");
}

/**
 * Cut a caption to `maxWords` and report the end index in the original string
 * so match ranges that start past the cut can be dropped.
 */
export function clipCaption(
  text: string,
  maxWords = 7,
): { text: string; end: number } {
  const matches = text.match(/\S+/g);
  if (!matches || matches.length <= maxWords) {
    const trimmed = text.trim();
    return { text: trimmed, end: text.length };
  }
  const re = /\S+/g;
  let count = 0;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) && count < maxWords) {
    count += 1;
    last = match.index + match[0].length;
  }
  return { text: text.slice(0, last).trimEnd(), end: last };
}

const SETTINGS_PALETTE_CAPTIONS: Record<string, string> = {
  secrets: "Keys and tokens for agents",
  stats: "Spend, limits, and pacing",
  appearance: "Theme and terminal text",
  chat: "Transcript and composer",
  agents: "Models and provider setup",
  "lanes-git": "How lanes stay current",
  notifications: "What ADE interrupts you for",
  activity: "What's running everywhere",
  integrations: "GitHub and Linear",
  general: "Runtime, health, and privacy",
  storage: "What ADE keeps on disk",
};

export function settingsPaletteCaption(tabId: string): string | null {
  return SETTINGS_PALETTE_CAPTIONS[tabId] ?? null;
}

type PaletteMark = { color: string; node: React.ReactNode };

function mark(IconComponent: Icon, color: string): PaletteMark {
  return { color, node: <IconComponent size={15} weight="fill" /> };
}

const COMMAND_MARKS: Record<string, PaletteMark> = {
  "project-browse": mark(FolderOpen, "#fbbf24"),
  "project-create": mark(Plus, "#a78bfa"),
  "project-clone": mark(GithubLogo, "#3fb950"),
  "project-remote": mark(DesktopTower, "#22d3ee"),
  "go-lanes": {
    color: "#34d399",
    node: <LaneIcon size={15} weight="fill" />,
  },
  "go-files": mark(FileCode, "#fbbf24"),
  "go-work": mark(Terminal, "#c4b5fd"),
  "go-prs": mark(GitPullRequest, "#3fb950"),
  "go-history": mark(HourglassSimple, "#fb923c"),
  "go-cto": mark(Robot, "#a78bfa"),
  "go-automations": mark(Clock, "#60a5fa"),
  "go-settings": mark(GearSix, "#94a3b8"),
  "capture-screen-for-cto": mark(Camera, "#f472b6"),
  "action-create-lane": mark(Plus, "#34d399"),
  "action-open-terminal": mark(Terminal, "#c4b5fd"),
  "action-refresh-packs": mark(Lightning, "#fbbf24"),
  ping: mark(Pulse, "#94a3b8"),
};

function workToolMark(commandId: string): PaletteMark | null {
  if (!commandId.startsWith("work-tools-")) return null;
  const toolId = commandId.slice("work-tools-".length);
  if (toolId === "picker") return mark(SquaresFour, "#a78bfa");
  const definition = WORK_TOOL_DEFINITIONS.find((entry) => entry.id === toolId);
  if (!definition) return null;
  return mark(definition.icon, definition.color);
}

export function commandPaletteMark(id: string): PaletteMark {
  const tool = workToolMark(id);
  if (tool) return tool;
  if (id.startsWith("go-settings") || id.startsWith("setting-")) {
    return mark(GearSix, "#94a3b8");
  }
  if (id.startsWith("lane-")) {
    return { color: "#34d399", node: <LaneIcon size={15} weight="fill" /> };
  }
  if (id.startsWith("action-")) return mark(Lightning, "#fbbf24");
  return COMMAND_MARKS[id] ?? mark(Command, "#a78bfa");
}

export function PaletteIconTile({
  color,
  children,
}: {
  color: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
      style={{
        backgroundColor: `color-mix(in srgb, ${color} 18%, transparent)`,
        color,
      }}
    >
      {children}
    </span>
  );
}

export function CommandPaletteGlyph({ id }: { id: string }) {
  const glyph = commandPaletteMark(id);
  return <PaletteIconTile color={glyph.color}>{glyph.node}</PaletteIconTile>;
}
