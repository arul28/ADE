import React from "react";
import { COLORS } from "../../../lanes/laneDesignTokens";

/** Shared pill button for viewer mode toggles (markdown Preview↔Source, CSV Table↔Source). */
export function ViewerModeToggleButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs"
      style={{
        color: active ? COLORS.textPrimary : COLORS.textMuted,
        background: active ? "rgba(255,255,255,0.07)" : "transparent",
      }}
    >
      {icon} {label}
    </button>
  );
}
