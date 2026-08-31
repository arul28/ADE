/**
 * The one status vocabulary for the CI / Checks surface.
 *
 * Colour is never the only signal. Every state carries three independent
 * channels — a distinct glyph SHAPE, a distinct border style, and a written
 * word — so the tab reads correctly for a red/green-colour-blind user, in a
 * greyscale screenshot, and to a screen reader.
 *
 * This module is imported by both the eagerly-loaded tab and the lazily-loaded
 * React Flow canvas, so it must stay free of heavy imports.
 */

import { memo } from "react";
import {
  ArrowSquareOut,
  CheckCircle,
  CircleDashed,
  CircleNotch,
  MinusCircle,
  Question,
  XCircle,
} from "@phosphor-icons/react";

import type { PrPipelineState } from "../../../../shared/types";
import { COLORS } from "../../lanes/laneDesignTokens";
import { formatDurationMs } from "../../../lib/format";

/** Every state colour resolves through the semantic palette — no hex literals. */
export const STATE_COLOR: Record<PrPipelineState, string> = {
  passed: COLORS.checkPass,
  failed: COLORS.danger,
  running: COLORS.warning,
  queued: COLORS.textDim,
  skipped: COLORS.textDim,
  unknown: COLORS.textMuted,
};

export const STATE_LABEL: Record<PrPipelineState, string> = {
  passed: "passed",
  failed: "failed",
  running: "running",
  queued: "queued",
  skipped: "skipped",
  unknown: "unknown",
};

/**
 * Second non-colour channel: a solid outline means "this ran", a dashed one
 * means "this has not run". Legible with no colour at all.
 */
export const STATE_BORDER_STYLE: Record<PrPipelineState, "solid" | "dashed"> = {
  passed: "solid",
  failed: "solid",
  running: "solid",
  queued: "dashed",
  skipped: "dashed",
  unknown: "dashed",
};

export function tint(color: string, pct: number): string {
  return `color-mix(in srgb, ${color} ${pct}%, transparent)`;
}

export function fmtMs(ms: number | null | undefined): string | null {
  if (ms == null) return null;
  const label = formatDurationMs(ms);
  return label === "--" ? "0s" : label;
}

/**
 * The status glyph. Six visually distinct shapes — tick, cross, spinner ring,
 * dashed ring, minus, question — rather than six coloured dots.
 */
export const StateIcon = memo(function StateIcon({
  state,
  size = 13,
}: {
  state: PrPipelineState;
  size?: number;
}) {
  const color = STATE_COLOR[state];
  const shared = { size, style: { color, flexShrink: 0 } } as const;
  switch (state) {
    case "passed":
      return <CheckCircle {...shared} weight="fill" aria-label="passed" />;
    case "failed":
      return <XCircle {...shared} weight="fill" aria-label="failed" />;
    case "running":
      return (
        <CircleNotch
          {...shared}
          weight="bold"
          className="motion-safe:animate-spin"
          aria-label="running"
        />
      );
    case "skipped":
      return <MinusCircle {...shared} weight="fill" aria-label="skipped" />;
    case "queued":
      return <CircleDashed {...shared} weight="bold" aria-label="queued" />;
    default:
      return <Question {...shared} weight="bold" aria-label="unknown" />;
  }
});

/**
 * "Open this check on GitHub" — one control, used by both the list rows and the
 * graph nodes.
 *
 * Both sit inside a larger activatable element, so `click` AND `keydown` have to
 * stop here: without the keydown guard the parent's Enter/Space handler calls
 * `preventDefault` and eats this button's native activation. Keeping one copy is
 * what stops the two views from disagreeing about that.
 */
export const OpenOnGitHubButton = memo(function OpenOnGitHubButton({
  url,
  name,
  padding = 2,
}: {
  url: string;
  name: string;
  padding?: number;
}) {
  return (
    <button
      type="button"
      data-testid="pr-checks-open-on-github"
      onClick={(event) => {
        event.stopPropagation();
        // The main-side handler rejects any non-http(s) scheme, and a check
        // run's `details_url` is not constrained by GitHub — so this can reject.
        void window.ade?.app?.openExternal?.(url)?.catch?.(() => {});
      }}
      onKeyDown={(event) => event.stopPropagation()}
      className="shrink-0 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
      style={{ background: "none", border: "none", cursor: "pointer", color: COLORS.textMuted, padding }}
      aria-label={`Open ${name} on GitHub`}
    >
      <ArrowSquareOut size={11} />
    </button>
  );
});
