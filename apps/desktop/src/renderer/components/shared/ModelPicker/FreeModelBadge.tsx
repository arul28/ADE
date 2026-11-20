import { memo } from "react";
import { Gift } from "@phosphor-icons/react";
import { FREE_MODEL_BADGE_LABELS, type FreeModelBadge as FreeModelBadgeKind } from "../../../../shared/freeModels";
import { cn } from "../../ui/cn";

/**
 * The tag on a free model's row: "Free" (sky, with the gift mark the Free
 * page uses) or "Ad-supported" (quiet outline). iOS draws the same two.
 */
export const FreeModelBadge = memo(function FreeModelBadge({ badge }: { badge: FreeModelBadgeKind }) {
  const label = FREE_MODEL_BADGE_LABELS[badge];
  return (
    <span
      data-free-model-badge={badge}
      title={badge === "free" ? "Free to use, no account or key" : "Free, paid for by ads"}
      className={cn(
        "inline-flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-px text-[9px] font-semibold leading-none",
        badge === "free"
          ? "bg-sky-400/[0.13] text-sky-300/90"
          : "border border-fg/[0.10] font-medium text-muted-fg/80",
      )}
    >
      {badge === "free" ? <Gift size={8} weight="fill" className="shrink-0" aria-hidden /> : null}
      {label}
    </span>
  );
});
