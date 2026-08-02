import React from "react";
import type { PrSummary } from "../../../shared/types";
import { lanePrStateColor, lanePrStateLabel } from "../../lib/lanePrBadge";
import { GitHubStackBadge } from "../prs/shared/GitHubStackBadge";

/**
 * Compact PR status chip for a lane in the Work sidebar: state-coloured dot +
 * `#<number>` + one-word state. Clicking deep-links into the PRs tab.
 *
 * Shared deliberately, not copied. "Does this lane have a PR, and where is it
 * at" has to survive every place the lane header is minimized or absent — the
 * full divider, a collapsed quiet divider, and (with no divider at all) the
 * singleton lane's lone card. Three copies of this markup would drift into
 * three different PR badges; one component cannot.
 *
 * `span role="button"`, never a native `<button>`: both hosts are themselves
 * interactive (the header is a real `<button>`, the session card is a
 * `div role="button"`), so a nested native button would be illegal markup in
 * the first case and a nested control in both. The chip stops propagation so
 * activating it never also toggles the section or selects the row.
 */
export function LanePrBadge({ pr, onOpen }: { pr: PrSummary; onOpen: () => void }) {
  const color = lanePrStateColor(pr.state);
  const label = lanePrStateLabel(pr.state);
  const stackDescription = pr.stack
    ? `, position ${pr.stack.position} of ${pr.stack.size} in GitHub Stack #${pr.stack.number}`
    : "";
  const open = (event: React.SyntheticEvent) => {
    event.stopPropagation();
    onOpen();
  };
  return (
    <span
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          open(event);
        }
      }}
      className="inline-flex shrink-0 items-center gap-1 rounded-full border border-white/10 bg-white/[0.04] px-1.5 py-px text-[10px] font-medium leading-none text-muted-fg/70 transition-colors hover:bg-white/[0.09]"
      title={`Pull request #${pr.githubPrNumber} · ${label}${stackDescription}`}
      aria-label={`Pull request #${pr.githubPrNumber}, ${label}${stackDescription}`}
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: color }} />
      <span className="tabular-nums">#{pr.githubPrNumber}</span>
      <GitHubStackBadge stack={pr.stack} compact bare />
      <span style={{ color }}>{label}</span>
    </span>
  );
}
