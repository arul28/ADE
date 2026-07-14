import { TreeStructure } from "@phosphor-icons/react";
import type { WorktreeParentRef } from "../../../shared/types";

export function WorktreeBadge({
  worktreeOf,
  compact = false,
}: {
  worktreeOf: WorktreeParentRef;
  compact?: boolean;
}) {
  return (
    <span
      title={`Worktree of ${worktreeOf.displayName}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        flexShrink: 0,
        maxWidth: compact ? undefined : 180,
        overflow: "hidden",
        padding: compact ? "2px 6px" : "2px 7px",
        borderRadius: compact ? 6 : 8,
        border: "1px solid color-mix(in srgb, var(--color-accent) 30%, transparent)",
        background: `color-mix(in srgb, var(--color-accent) ${compact ? 14 : 16}%, transparent)`,
        color: "var(--color-accent)",
        fontSize: 9,
        fontWeight: 700,
        letterSpacing: "0.04em",
        lineHeight: compact ? "12px" : undefined,
        textTransform: "uppercase",
      }}
    >
      <TreeStructure
        size={compact ? 9 : 10}
        weight="bold"
        style={{ flexShrink: 0 }}
      />
      <span
        style={{
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {compact ? "worktree" : `worktree of ${worktreeOf.displayName}`}
      </span>
    </span>
  );
}
