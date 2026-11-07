import type { ReactNode } from "react";
import { PictureInPicture } from "@phosphor-icons/react";
import { PaneTooltip } from "../ui/PaneTooltip";
import { cn } from "../ui/cn";

type DataAttributes = Record<`data-${string}`, string>;

/**
 * The chat-chrome chip shown while a lane device runs and no pane shows it.
 * Open shows the device's tool; Float puts it in the floating player. The
 * Apple and Android pills give the glyph, the words and the data attributes.
 */
export function DeviceRunningPill({
  icon,
  label,
  title,
  dataAttributes,
  openDataAttributes,
  floatDataAttributes,
  floatTooltip = "Float",
  floatDisabled = false,
  onOpen,
  onFloat,
}: {
  icon: ReactNode;
  label: string;
  title: string;
  dataAttributes: DataAttributes;
  openDataAttributes?: DataAttributes;
  floatDataAttributes: DataAttributes;
  floatTooltip?: string;
  floatDisabled?: boolean;
  onOpen: () => void;
  onFloat: () => void;
}) {
  return (
    <span
      className={cn(
        "inline-flex max-w-[280px] items-center gap-1 rounded-full border py-0.5 pl-2 pr-1",
        "border-cyan-300/20 bg-cyan-400/[0.06] font-sans text-[10px] font-medium text-cyan-100/75",
      )}
      title={title}
      {...dataAttributes}
    >
      {icon}
      <span className="min-w-0 truncate">{label}</span>
      <button
        type="button"
        onClick={onOpen}
        {...openDataAttributes}
        className="shrink-0 rounded-full px-1.5 text-cyan-200/70 transition-colors hover:text-cyan-50"
      >
        Open
      </button>
      <PaneTooltip label={floatTooltip}>
        <button
          type="button"
          aria-label="Float"
          {...floatDataAttributes}
          disabled={floatDisabled}
          onClick={onFloat}
          className={cn(
            "inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full",
            "text-cyan-200/70 transition-colors hover:text-cyan-50",
            "disabled:cursor-not-allowed disabled:opacity-40",
          )}
        >
          <PictureInPicture size={10} weight="bold" />
        </button>
      </PaneTooltip>
    </span>
  );
}
