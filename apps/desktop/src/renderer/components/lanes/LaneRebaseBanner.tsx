import type {
  AutoRebaseLaneStatus,
  LaneSummary,
  RebaseSuggestion,
  RebaseSuggestionDisplay,
} from "../../../shared/types";
import { DEFAULT_LANE_BANNER_BUDGET, DEFAULT_REBASE_SUGGESTIONS } from "../../../shared/types/config";
import { COLORS, LABEL_STYLE, SANS_FONT, inlineBadge, outlineButton, primaryButton } from "./laneDesignTokens";
import { SmartTooltip } from "../ui/SmartTooltip";

/**
 * Rebase and auto-rebase notices above the lane list.
 *
 * This used to render two independent full-width strips unconditionally, each
 * listing up to three lanes — on a busy stack that permanently ate ~200px above
 * the thing you came here to look at, with no setting to turn it down.
 *
 * `display` now decides how loud it gets:
 *   banner — the strips, as before
 *   badge  — a single quiet summary line
 *   off    — nothing (and the scan itself is skipped upstream)
 *
 * `bannerBudget` caps how many strips may stack at once; anything over budget
 * degrades to the summary line rather than being dropped silently.
 */
export function LaneRebaseBanner({
  visibleRebaseSuggestions,
  visibleAutoRebaseNeedsAttention,
  lanesById,
  rebaseSuggestionError,
  onViewRebaseDetails,
  onDismissRebase,
  onDismissAutoRebase,
  display = DEFAULT_REBASE_SUGGESTIONS,
  bannerBudget = DEFAULT_LANE_BANNER_BUDGET,
}: {
  visibleRebaseSuggestions: RebaseSuggestion[];
  visibleAutoRebaseNeedsAttention: AutoRebaseLaneStatus[];
  lanesById: Map<string, LaneSummary>;
  rebaseSuggestionError: string | null;
  onViewRebaseDetails: (laneId?: string | null) => void;
  onDismissRebase: (laneId: string) => void;
  onDismissAutoRebase: (laneId: string) => void;
  display?: RebaseSuggestionDisplay;
  bannerBudget?: number;
}) {
  const hasSuggestions = visibleRebaseSuggestions.length > 0;
  const hasAutoRebase = visibleAutoRebaseNeedsAttention.length > 0;

  // Auto-rebase failures are a broken state, not a suggestion — they stay
  // visible even when suggestions are turned off. Only the "you could rebase"
  // nudge is suppressible.
  const showSuggestionBanner = display === "banner" && hasSuggestions;
  const showAutoRebaseBanner = hasAutoRebase;

  const requestedBanners = (showSuggestionBanner ? 1 : 0) + (showAutoRebaseBanner ? 1 : 0);
  const overBudget = requestedBanners > Math.max(0, bannerBudget);

  // Over budget, or in badge mode: collapse to one line instead of stacking.
  if (overBudget || (display === "badge" && hasSuggestions) || (display === "off" && hasAutoRebase)) {
    return (
      <>
        <RebaseSummaryLine
          suggestionCount={display === "off" ? 0 : visibleRebaseSuggestions.length}
          attentionCount={visibleAutoRebaseNeedsAttention.length}
          onViewRebaseDetails={onViewRebaseDetails}
        />
        {rebaseSuggestionError ? <RebaseErrorStrip message={rebaseSuggestionError} /> : null}
      </>
    );
  }

  return (
    <>
      {showSuggestionBanner ? (
        <div style={{ background: "color-mix(in srgb, var(--color-warning) 8%, transparent)", borderBottom: `1px solid ${COLORS.border}`, padding: "8px 12px" }}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span style={LABEL_STYLE}>REBASE SUGGESTED</span>
            <span style={inlineBadge(COLORS.warning, { fontSize: 9 })}>
              {visibleRebaseSuggestions.length} LANE{visibleRebaseSuggestions.length === 1 ? "" : "S"}
            </span>
          </div>
          <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
            {visibleRebaseSuggestions.slice(0, 3).map((s) => {
              const lane = lanesById.get(s.laneId) ?? null;
              if (!lane) return null;
              return (
                <div
                  key={`rebase:${s.laneId}`}
                  style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.border}`, padding: 10 }}
                  className="flex flex-wrap items-start justify-between gap-2"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span style={{ fontSize: 12, fontWeight: 600, color: COLORS.textPrimary }} className="truncate">{lane.name}</span>
                      {s.hasPr ? <span style={inlineBadge(COLORS.info, { fontSize: 9 })}>PR</span> : null}
                      <span style={inlineBadge(COLORS.warning, { fontSize: 9 })}>{s.behindCount} BEHIND</span>
                    </div>
                    <div style={{ marginTop: 2, fontSize: 11, color: COLORS.textMuted }}>
                      Rebase this lane onto {s.baseLabel?.trim() || "parent branch"} to pick up new commits.
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                    <SmartTooltip content={{ label: "View in Rebase/Merge tab", description: "Open the Rebase/Merge tab for this lane." }}>
                      <button
                        type="button"
                        style={primaryButton({ height: 24, padding: "0 8px", fontSize: 10 })}
                        onClick={() => onViewRebaseDetails(s.laneId)}
                      >
                        View in Rebase/Merge tab
                      </button>
                    </SmartTooltip>
                    <SmartTooltip content={{ label: "Dismiss", description: "Remove this rebase suggestion permanently until new parent commits arrive." }}>
                      <button
                        type="button"
                        style={outlineButton({ height: 24, padding: "0 6px", fontSize: 10 })}
                        onClick={() => onDismissRebase(s.laneId)}
                        title="Dismiss this rebase suggestion"
                      >
                        Dismiss
                      </button>
                    </SmartTooltip>
                  </div>
                </div>
              );
            })}
            {visibleRebaseSuggestions.length > 3 ? (
              <div style={{ fontSize: 11, color: COLORS.textMuted }}>+ {visibleRebaseSuggestions.length - 3} more suggestions.</div>
            ) : null}
          </div>
        </div>
      ) : null}

      {rebaseSuggestionError ? <RebaseErrorStrip message={rebaseSuggestionError} /> : null}

      {showAutoRebaseBanner ? (
        <div style={{ background: "color-mix(in srgb, var(--color-warning) 8%, transparent)", borderBottom: `1px solid ${COLORS.border}`, padding: "8px 12px" }}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span style={LABEL_STYLE}>AUTO-REBASE NEEDS ATTENTION</span>
            <span style={inlineBadge(COLORS.warning, { fontSize: 9 })}>
              {visibleAutoRebaseNeedsAttention.length} LANE{visibleAutoRebaseNeedsAttention.length === 1 ? "" : "S"}
            </span>
          </div>
          <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
            {visibleAutoRebaseNeedsAttention.slice(0, 3).map((status) => {
              const lane = lanesById.get(status.laneId) ?? null;
              if (!lane) return null;
              return (
                <div
                  key={`auto-rebase:${status.laneId}`}
                  style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.border}`, padding: 10 }}
                  className="flex flex-wrap items-start justify-between gap-2"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span style={{ fontSize: 12, fontWeight: 600, color: COLORS.textPrimary }} className="truncate">{lane.name}</span>
                      {status.state === "rebaseConflict" ? (
                        <span style={inlineBadge(COLORS.danger, { fontSize: 9 })}>CONFLICT</span>
                      ) : status.state === "rebaseFailed" ? (
                        <span style={inlineBadge(COLORS.danger, { fontSize: 9 })}>FAILED</span>
                      ) : (
                        <span style={inlineBadge(COLORS.warning, { fontSize: 9 })}>PENDING</span>
                      )}
                    </div>
                    <div style={{ marginTop: 2, fontSize: 11, color: COLORS.textMuted }}>
                      {status.message ?? "Manual rebase and publish may be required for this lane."}
                    </div>
                  </div>
                  <div className="shrink-0 flex items-center gap-1.5">
                    <SmartTooltip content={{ label: "View in Rebase/Merge tab", description: "Open the Rebase/Merge tab for this lane." }}>
                      <button
                        type="button"
                        style={primaryButton({ height: 24, padding: "0 8px", fontSize: 10 })}
                        onClick={() => onViewRebaseDetails(status.laneId)}
                      >
                        View in Rebase/Merge tab
                      </button>
                    </SmartTooltip>
                    <SmartTooltip content={{ label: "Dismiss", description: "Hide this alert until the parent or base changes again." }}>
                      <button
                        type="button"
                        style={outlineButton({ height: 24, padding: "0 6px", fontSize: 10 })}
                        onClick={() => onDismissAutoRebase(status.laneId)}
                      >
                        Dismiss
                      </button>
                    </SmartTooltip>
                  </div>
                </div>
              );
            })}
            {visibleAutoRebaseNeedsAttention.length > 3 ? (
              <div style={{ fontSize: 11, color: COLORS.textMuted }}>+ {visibleAutoRebaseNeedsAttention.length - 3} more lanes.</div>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}

/**
 * The quiet form: one line, no per-lane cards, no dismiss buttons. Used in
 * badge mode and whenever the banner budget is exceeded, so a busy stack
 * costs one row instead of two full strips.
 */
function RebaseSummaryLine({
  suggestionCount,
  attentionCount,
  onViewRebaseDetails,
}: {
  suggestionCount: number;
  attentionCount: number;
  onViewRebaseDetails: (laneId?: string | null) => void;
}) {
  if (suggestionCount === 0 && attentionCount === 0) return null;

  const parts: string[] = [];
  if (attentionCount > 0) {
    parts.push(`${attentionCount} lane${attentionCount === 1 ? "" : "s"} need${attentionCount === 1 ? "s" : ""} attention`);
  }
  if (suggestionCount > 0) {
    parts.push(`${suggestionCount} behind`);
  }

  // Anything needing attention is a failure state; a plain "behind" count is not.
  const tone = attentionCount > 0 ? COLORS.warning : COLORS.textMuted;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        padding: "5px 12px",
        borderBottom: `1px solid ${COLORS.border}`,
        background: attentionCount > 0
          ? "color-mix(in srgb, var(--color-warning) 6%, transparent)"
          : "transparent",
      }}
    >
      <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        <span aria-hidden style={{ width: 6, height: 6, borderRadius: 999, background: tone, flexShrink: 0 }} />
        <span style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textSecondary }} className="truncate">
          {parts.join(" · ")}
        </span>
      </span>
      <button
        type="button"
        style={outlineButton({ height: 22, padding: "0 8px", fontSize: 10 })}
        onClick={() => onViewRebaseDetails(null)}
      >
        Review
      </button>
    </div>
  );
}

function RebaseErrorStrip({ message }: { message: string }) {
  return (
    <div
      style={{
        background: "color-mix(in srgb, var(--color-error) 15%, transparent)",
        borderBottom: "1px solid color-mix(in srgb, var(--color-error) 30%, transparent)",
        padding: "8px 12px",
        fontSize: 12,
        color: COLORS.danger,
      }}
    >
      {message}
    </div>
  );
}
