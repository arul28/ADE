import { GitBranch, GitFork, type IconProps } from "@phosphor-icons/react";
import { cn } from "./cn";

/** ADE lane / worktree identity (matches Lanes tab and lane chips). */
export function LaneIcon({ size = 14, weight = "regular", className, ...props }: IconProps) {
  return (
    <GitBranch
      size={size}
      weight={weight}
      className={cn("ade-vcs-lane-icon shrink-0", className)}
      aria-hidden
      {...props}
    />
  );
}

/** Git branch ref (e.g. `main`, `refs/heads/feature`). */
export function BranchIcon({ size = 12, weight = "regular", className, ...props }: IconProps) {
  return (
    <GitFork
      size={size}
      weight={weight}
      className={cn("ade-vcs-branch-icon shrink-0", className)}
      aria-hidden
      {...props}
    />
  );
}
