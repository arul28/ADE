import React from "react";
import { MagnifyingGlass } from "@phosphor-icons/react";
import { COLORS } from "../../lanes/laneDesignTokens";
import { getFileIcon } from "../filePresentation";
import {
  WORK_TOOL_PRIMARY_BUTTON,
  WORK_TOOL_SECTION_LABEL,
} from "../../terminals/workToolChrome";

/**
 * Editor-area state when no file is open.
 *
 * The same anatomy as every other Work tool's empty state — one line, one
 * primary action — because they are the same moment in different tools. It
 * used to be the only tool in the pane with marketing chrome: a 200px "ADE"
 * wordmark floating on a purple wash, which is a launch screen, not an empty
 * state, and which said nothing about files. What remains under the button is
 * the recents list, which is not decoration: it is the shortest path back to
 * what you were reading, and it is scoped per workspace.
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
      <p className="font-sans text-[14px] font-medium" style={{ color: COLORS.textPrimary }}>
        No file open
      </p>

      <button type="button" onClick={onSearch} className={WORK_TOOL_PRIMARY_BUTTON}>
        <MagnifyingGlass size={14} weight="bold" />
        <span>Open a file</span>
      </button>

      {recents.length > 0 ? (
        <div className="mt-3 w-full max-w-[280px]">
          <div className={WORK_TOOL_SECTION_LABEL}>Recent</div>
          <div className="mt-1 flex flex-col">
            {recents.slice(0, 5).map((path) => {
              const name = path.split("/").pop() ?? path;
              const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
              const { icon: Icon, color } = getFileIcon(name);
              return (
                <button
                  key={path}
                  type="button"
                  onClick={() => onOpen(path)}
                  className={[
                    "flex h-7 items-center gap-2 rounded-[6px] px-2 text-left text-[12px]",
                    "transition-colors duration-[120ms] ease-out hover:bg-white/[0.05]",
                    "focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)]",
                  ].join(" ")}
                  style={{ color: COLORS.textMuted }}
                  title={path}
                >
                  <Icon size={16} color={color} />
                  <span className="truncate" style={{ color: COLORS.textSecondary }}>{name}</span>
                  {dir ? (
                    <span className="ml-auto truncate pl-3 text-[11px]" style={{ color: COLORS.textDim }}>{dir}</span>
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
