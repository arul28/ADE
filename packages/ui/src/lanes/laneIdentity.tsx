/**
 * Lane identity bits the combobox draws with: the mark, its colour fallback,
 * and the ref → short-branch reduction.
 *
 * All three are ported verbatim from the desktop app — `LaneLogoMark` and
 * `laneDisplayColor` from `components/terminals/LaneChip.tsx`,
 * `branchNameFromLaneRef` from `shared/laneBaseResolution.ts`. They live here
 * rather than in the component so a host that only needs a lane swatch does not
 * pull the whole popover.
 *
 * The file is `.tsx` rather than `.ts` because `LaneLogoMark` is JSX.
 */

import { LaneIcon } from "../primitives/vcsIcons";

const DEFAULT_LANE_COLOR = "#ffffff";

export function laneDisplayColor(laneColor?: string | null): string {
  const trimmed = laneColor?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_LANE_COLOR;
}

export function LaneLogoMark({
  color,
  size = 10,
}: {
  color: string;
  size?: number;
}) {
  return <LaneIcon size={size} weight="regular" className="shrink-0" style={{ color }} />;
}

/** Short display branch for a ref (`refs/heads/foo`, `origin/foo`, `foo`). */
export function branchNameFromLaneRef(ref?: string | null): string {
  const trimmed = (ref ?? "").trim();
  if (trimmed.startsWith("refs/heads/")) return trimmed.slice("refs/heads/".length);
  if (trimmed.startsWith("refs/remotes/")) {
    const remoteRef = trimmed.slice("refs/remotes/".length);
    const slashIndex = remoteRef.indexOf("/");
    return slashIndex >= 0 ? remoteRef.slice(slashIndex + 1) : remoteRef;
  }
  if (trimmed.startsWith("origin/")) return trimmed.slice("origin/".length);
  return trimmed;
}
