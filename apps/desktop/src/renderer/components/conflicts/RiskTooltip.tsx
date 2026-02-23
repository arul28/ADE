import React from "react";
import { cn } from "../ui/cn";

function compactFilePath(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 2) return normalized;
  const file = parts[parts.length - 1]!;
  const parent = parts[parts.length - 2]!;
  return `${parent}/${file}`;
}

export function RiskTooltip({
  open,
  anchorRect,
  files,
  title
}: {
  open: boolean;
  anchorRect: DOMRect | null;
  files: string[];
  title: string;
}) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const [style, setStyle] = React.useState<React.CSSProperties>({ left: -9999, top: -9999 });

  React.useLayoutEffect(() => {
    if (!open || !anchorRect || !ref.current) return;
    const tooltipRect = ref.current.getBoundingClientRect();
    const gap = 10;
    let left = anchorRect.right + gap;
    let top = anchorRect.top + anchorRect.height / 2 - tooltipRect.height / 2;

    if (left + tooltipRect.width > window.innerWidth - 8) {
      left = anchorRect.left - tooltipRect.width - gap;
    }
    if (left < 8) left = 8;

    if (top + tooltipRect.height > window.innerHeight - 8) {
      top = window.innerHeight - tooltipRect.height - 8;
    }
    if (top < 8) top = 8;

    setStyle({ left, top });
  }, [open, anchorRect, files.length]);

  const shown = files.slice(0, 10);
  const hiddenCount = Math.max(0, files.length - shown.length);

  return (
    <div
      ref={ref}
      className={cn(
        "pointer-events-none fixed z-[80] w-[300px] rounded bg-card/95 p-3 shadow-float ade-tooltip-motion",
        open ? "ade-tooltip-open duration-150" : "ade-tooltip-closed duration-100"
      )}
      style={style}
    >
      <div className="mb-1 text-xs font-semibold text-fg">{title}</div>
      <div className="max-h-[220px] overflow-auto rounded-lg bg-bg/30 p-1">
        {shown.length === 0 ? (
          <div className="px-1 py-0.5 text-xs text-muted-fg">No overlapping files.</div>
        ) : (
          shown.map((file) => (
            <div key={file} className="truncate px-1 py-0.5 text-xs text-fg" title={file}>
              {compactFilePath(file)}
            </div>
          ))
        )}
      </div>
      {hiddenCount > 0 ? <div className="mt-1 text-xs text-muted-fg">+{hiddenCount} more</div> : null}
    </div>
  );
}
