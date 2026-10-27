import { memo } from "react";
import { MagnifyingGlass } from "@phosphor-icons/react";

import { COLORS, SANS_FONT, fgTint } from "../../lanes/laneDesignTokens";
import { isImeComposing } from "../../../lib/imeComposition";

export type GitHubPrSearchInputProps = {
  value: string;
  onChange: (value: string) => void;
  /** Enter, outside IME composition (reads a last `label:x` still being typed). */
  onSubmit?: () => void;
  placeholder?: string;
};

export const GitHubPrSearchInput = memo(function GitHubPrSearchInput({
  value,
  onChange,
  onSubmit,
  placeholder = "Search pull requests",
}: GitHubPrSearchInputProps) {
  return (
    <div
      data-testid="github-pr-search-input"
      className="min-w-0 flex-1"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        height: 28,
        padding: "0 9px",
        background: COLORS.cardBg,
        border: `1px solid ${fgTint(6)}`,
        borderRadius: 8,
      }}
    >
      <MagnifyingGlass size={13} style={{ color: COLORS.textDim, flexShrink: 0 }} />
      <input
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && onSubmit && !isImeComposing(event)) {
            event.preventDefault();
            onSubmit();
          }
        }}
        placeholder={placeholder}
        aria-label="Search pull requests"
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
