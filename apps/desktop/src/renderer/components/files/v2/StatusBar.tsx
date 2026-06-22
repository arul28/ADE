import React from "react";
import { GitBranch } from "@phosphor-icons/react";
import { COLORS } from "../../lanes/laneDesignTokens";
import type { EditorTab } from "./editorGroupsStore";

export function StatusBar({
  activeTab,
  activeFullPath,
  branch,
  groupCount,
  openCount,
  dirtyCount,
}: {
  activeTab: EditorTab | null;
  activeFullPath?: string | null;
  branch?: string | null;
  groupCount: number;
  openCount: number;
  dirtyCount: number;
}) {
  return (
    <div
      className="flex shrink-0 items-center gap-3 border-t px-3 py-1 text-[11px]"
      style={{ borderColor: COLORS.border, color: COLORS.textMuted, background: COLORS.recessedBg }}
    >
      {branch ? (
        <span className="inline-flex items-center gap-1">
          <GitBranch size={11} /> {branch}
        </span>
      ) : null}
      {activeFullPath ? (
        <span className="min-w-0 flex-1 truncate" title={activeFullPath} style={{ color: COLORS.textDim }}>
          {activeFullPath}
        </span>
      ) : null}
      {activeTab ? <span style={{ color: COLORS.textDim }}>{activeTab.languageId}</span> : null}
      <span className={activeFullPath ? "shrink-0" : "ml-auto"} style={{ color: COLORS.textDim }}>
        {groupCount > 1 ? `${groupCount} groups · ` : ""}
        {openCount} open{dirtyCount > 0 ? ` · ${dirtyCount} unsaved` : ""}
      </span>
    </div>
  );
}
