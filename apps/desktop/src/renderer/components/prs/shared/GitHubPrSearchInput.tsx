import { memo } from "react";
import { MagnifyingGlass } from "@phosphor-icons/react";

import { COLORS, SANS_FONT } from "../../lanes/laneDesignTokens";

export type GitHubPrSearchInputProps = {
  value: string;
  onChange: (value: string) => void;
  compact?: boolean;
};

export const GitHubPrSearchInput = memo(function GitHubPrSearchInput({
  value,
  onChange,
  compact = false,
}: GitHubPrSearchInputProps) {
  return (
    <div
      data-testid="github-pr-search-input"
      className="min-w-0 flex-1"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        height: compact ? 30 : 32,
        padding: "0 10px",
        maxWidth: compact ? 420 : undefined,
        background: "rgba(255,255,255,0.03)",
        border: "1px solid rgba(255,255,255,0.06)",
        borderRadius: 8,
      }}
    >
      <MagnifyingGlass size={13} style={{ color: COLORS.textDim, flexShrink: 0 }} />
      <input
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Search pull requests..."
        style={{
          flex: 1,
          minWidth: 0,
          background: "transparent",
          border: "none",
          outline: "none",
          fontFamily: SANS_FONT,
          fontSize: 12,
          color: COLORS.textPrimary,
        }}
      />
      {value ? (
        <button
          type="button"
          onClick={() => onChange("")}
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            padding: 0,
            color: COLORS.textDim,
            display: "flex",
          }}
          aria-label="Clear search"
        >
          <span style={{ fontSize: 11 }}>×</span>
        </button>
      ) : null}
    </div>
  );
});

export default GitHubPrSearchInput;
