import React from "react";
import { ClockCounterClockwise } from "@phosphor-icons/react";
import { COLORS } from "../../lanes/laneDesignTokens";
import { getFileIcon } from "../filePresentation";

function Shortcut({ keys }: { keys: string[] }) {
  return (
    <span className="ml-auto flex items-center gap-1">
      {keys.map((k) => (
        <kbd
          key={k}
          className="rounded px-1.5 py-0.5 text-[10px]"
          style={{ background: "color-mix(in srgb, var(--color-fg) 8%, transparent)", color: COLORS.textDim, border: `1px solid ${COLORS.border}` }}
        >
          {k}
        </kbd>
      ))}
    </span>
  );
}

/**
 * Editor-area state when no file is open. VSCode-style: an accent ADE mark over
 * a soft workspace wash, with the content sitting naturally on the
 * background (no card / no rail), a primary search action, and recents.
 */
export function WarmEmptyState({
  workspaceName,
  branch,
  recents,
  onOpen,
  onSearch,
  modifierKey,
}: {
  workspaceName: string | null;
  branch: string | null;
  dirtyCount?: number;
  recents: string[];
  onOpen: (path: string) => void;
  onSearch: () => void;
  modifierKey: string;
}) {
  return (
    <div
      className="relative flex h-full min-h-0 flex-col items-center justify-center overflow-auto p-8"
      style={{ background: "color-mix(in srgb, var(--color-card) 80%, var(--color-accent) 16%)" }}
    >
      <img
        src="./logo.png"
        alt=""
        aria-hidden
        className="pointer-events-none mb-6 select-none"
        style={{ width: 200, filter: "drop-shadow(0 18px 42px color-mix(in srgb, var(--color-accent) 28%, transparent))", opacity: 0.16 }}
      />

      <div className="w-full max-w-md">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-semibold" style={{ color: COLORS.textPrimary }}>
            {workspaceName ?? "Files"}
          </span>
          {branch ? (
            <span className="text-xs" style={{ color: COLORS.textDim }}>
              {branch}
            </span>
          ) : null}
        </div>
        <div className="mt-0.5 text-xs" style={{ color: COLORS.textMuted }}>
          Pick a file from the explorer, or search this workspace.
        </div>

        {/* Primary action */}
        <button
          type="button"
          onClick={onSearch}
          className="mt-4 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs transition-colors"
          style={{ background: COLORS.accentSubtle, border: `1px solid ${COLORS.accentBorder}`, color: COLORS.textPrimary }}
          onMouseEnter={(e) => { e.currentTarget.style.background = "color-mix(in srgb, var(--color-accent) 26%, transparent)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = COLORS.accentSubtle; }}
        >
          <span style={{ color: "var(--color-accent-bright)" }}>Search files</span>
          <Shortcut keys={[`${modifierKey}P`]} />
        </button>

        {/* Recents */}
        {recents.length > 0 ? (
          <div className="mt-5">
            <div className="mb-1.5 flex items-center gap-1.5 text-[10px] uppercase tracking-wide" style={{ color: COLORS.textDim }}>
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
                    {dir ? <span className="ml-auto truncate pl-3 text-[10px]" style={{ color: COLORS.textDim }}>{dir}</span> : null}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
