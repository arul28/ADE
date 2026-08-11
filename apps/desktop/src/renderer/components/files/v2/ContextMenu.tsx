import React, { useEffect } from "react";
import { COLORS } from "../../lanes/laneDesignTokens";
import { useClampedFixedPosition } from "../../../hooks/useClampedFixedPosition";

export type ContextMenuItem =
  | { type: "separator" }
  /** A section heading. Not selectable — it says who the rows below belong to. */
  | { type: "header"; label: string }
  | {
      type: "item";
      label: string;
      icon?: React.ReactNode;
      onClick: () => void;
      danger?: boolean;
      disabled?: boolean;
      shortcut?: string;
    };

const ROW_H = 28;

/**
 * Drop separators that fence nothing: leading, trailing, or doubled.
 *
 * These menus are assembled from optional sections — a plugin section that
 * turned out to be the whole menu, a section whose rows were all unavailable —
 * and every caller would otherwise have to know what came before it to decide
 * whether its own rule was earned.
 */
function withoutStraySeparators(items: ContextMenuItem[]): ContextMenuItem[] {
  const kept: ContextMenuItem[] = [];
  for (const item of items) {
    const previous = kept[kept.length - 1];
    if (item.type === "separator" && (!previous || previous.type === "separator")) continue;
    kept.push(item);
  }
  while (kept[kept.length - 1]?.type === "separator") kept.pop();
  return kept;
}

/** A lightweight right-click menu positioned at (x, y), clamped to the viewport. */
export function ContextMenu({
  x,
  y,
  items: rawItems,
  onClose,
}: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}) {
  const items = withoutStraySeparators(rawItems);
  const itemsKey = items
    .map((item) => {
      if (item.type === "separator") return "|";
      if (item.type === "header") return `#${item.label}`;
      return `${item.label}:${item.disabled ? "0" : "1"}`;
    })
    .join("\0");
  const { ref, position } = useClampedFixedPosition({ x, y }, itemsKey);

  useEffect(() => {
    const onDocMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDocMouseDown, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onClose);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  const width = 220;

  return (
    <div
      ref={ref}
      className="fixed z-[200] py-1"
      style={{
        left: position?.left ?? x,
        top: position?.top ?? y,
        width,
        visibility: position ? "visible" : "hidden",
        background: COLORS.cardBgSolid,
        border: `1px solid ${COLORS.outlineBorder}`,
        borderRadius: 10,
        boxShadow: "0 16px 44px rgba(0,0,0,0.5)",
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) => {
        if (item.type === "separator") {
          return <div key={`sep-${i}`} className="my-1 h-px" style={{ background: COLORS.border }} />;
        }
        if (item.type === "header") {
          return (
            <div
              key={`header-${i}`}
              role="presentation"
              className="px-3 pb-0.5 pt-1.5 text-[9px] font-semibold uppercase tracking-[0.12em]"
              style={{ color: COLORS.textDim }}
            >
              {item.label}
            </div>
          );
        }
        return (
          <button
            key={`${item.label}-${i}`}
            type="button"
            disabled={item.disabled}
            onClick={() => {
              item.onClick();
              onClose();
            }}
            className="flex w-full items-center gap-2 px-3 text-left text-xs disabled:opacity-40"
            style={{ height: ROW_H, color: item.danger ? COLORS.danger : COLORS.textSecondary }}
            onMouseEnter={(e) => {
              if (!item.disabled) e.currentTarget.style.background = item.danger ? "color-mix(in srgb, var(--color-error) 16%, transparent)" : COLORS.accentSubtle;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent";
            }}
          >
            {item.icon ? <span className="flex w-4 justify-center">{item.icon}</span> : <span className="w-4" />}
            <span className="truncate">{item.label}</span>
            {item.shortcut ? <span className="ml-auto pl-3 text-[10px]" style={{ color: COLORS.textDim }}>{item.shortcut}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
