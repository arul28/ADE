import React from "react";
import { ClockCounterClockwise, FolderOpen, MagnifyingGlass } from "@phosphor-icons/react";
import { COLORS } from "../../lanes/laneDesignTokens";
import { isMac } from "../../../lib/platform";
import { getFileIcon } from "../filePresentation";

/** "⌘P" on a Mac, "Ctrl+P" everywhere else — a key cap, not the word "Cmd". */
const SEARCH_SHORTCUT = isMac ? "⌘P" : "Ctrl+P";

function Kbd({ label }: { label: string }) {
  return (
    <kbd
      className="ml-auto rounded px-1.5 py-0.5 font-mono text-[10px] leading-4"
      style={{
        background: "color-mix(in srgb, var(--color-fg) 8%, transparent)",
        color: COLORS.textDim,
        border: `1px solid ${COLORS.border}`,
      }}
    >
      {label}
    </kbd>
  );
}

/**
 * Editor-area state when no file is open.
 *
 * Deliberately the same anatomy as the Terminal tool's empty state — muted
 * duotone glyph, one headline, one line of explanation, one action — because
 * they are the same moment in two tools. It used to be the only tool in the
 * pane with marketing chrome: a 200px "ADE" wordmark floating on a purple
 * wash, which is a launch screen, not an empty state, and which said nothing
 * about files. The workspace name and branch are not repeated here either;
 * the explorer header and the status bar below already carry them.
 */
export function WarmEmptyState({
  recents,
  onOpen,
  onSearch,
}: {
  recents: string[];
  onOpen: (path: string) => void;
  onSearch: () => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 overflow-auto p-8">
      <FolderOpen size={22} weight="duotone" style={{ color: "color-mix(in srgb, var(--color-fg) 25%, transparent)" }} />
      <div className="flex flex-col gap-1 text-center">
        <p className="font-sans text-[13px] font-semibold" style={{ color: COLORS.textPrimary }}>
          No file open
        </p>
        <p className="max-w-[260px] font-sans text-[11.5px] leading-[17px]" style={{ color: COLORS.textMuted }}>
          Pick a file from the explorer, or search this workspace.
        </p>
      </div>

      <button
        type="button"
        onClick={onSearch}
        className="flex w-full max-w-[280px] items-center gap-2 rounded-lg px-3 py-2 text-left font-sans text-xs transition-colors focus-visible:outline-none"
        style={{ background: COLORS.accentSubtle, border: `1px solid ${COLORS.accentBorder}`, color: COLORS.textPrimary }}
        onMouseEnter={(e) => { e.currentTarget.style.background = "color-mix(in srgb, var(--color-accent) 26%, transparent)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = COLORS.accentSubtle; }}
      >
        <MagnifyingGlass size={13} weight="bold" style={{ color: "var(--color-accent-bright)" }} />
        <span style={{ color: "var(--color-accent-bright)" }}>Search files</span>
        <Kbd label={SEARCH_SHORTCUT} />
      </button>

      {recents.length > 0 ? (
        <div className="mt-2 w-full max-w-[280px]">
          <div
            className="mb-1.5 flex items-center gap-1.5 text-[10px] uppercase tracking-wide"
            style={{ color: COLORS.textDim }}
          >
            <ClockCounterClockwise size={11} /> Recent
          </div>
          <div className="flex flex-col">
            {recents.slice(0, 5).map((path) => {
              const name = path.split("/").pop() ?? path;
              const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
              const { icon: Icon, color } = getFileIcon(name);
              return (
                <button
                  key={path}
                  type="button"
                  onClick={() => onOpen(path)}
                  className="flex items-center gap-2 rounded px-2 py-1 text-left text-xs transition-colors"
                  style={{ color: COLORS.textMuted }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "color-mix(in srgb, var(--color-fg) 6%, transparent)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                  title={path}
                >
                  <Icon size={14} color={color} />
                  <span className="truncate" style={{ color: COLORS.textSecondary }}>{name}</span>
                  {dir ? (
                    <span className="ml-auto truncate pl-3 text-[10px]" style={{ color: COLORS.textDim }}>{dir}</span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
