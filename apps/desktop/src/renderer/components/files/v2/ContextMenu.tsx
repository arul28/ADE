import React, { useEffect, useRef } from "react";
import { COLORS } from "../../lanes/laneDesignTokens";

export type ContextMenuItem =
  | { type: "separator" }
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

/** A lightweight right-click menu positioned at (x, y), clamped to the viewport. */
export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

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
  const estHeight = items.reduce((h, it) => h + (it.type === "separator" ? 9 : ROW_H), 8);
  const left = Math.max(6, Math.min(x, window.innerWidth - width - 6));
  const top = Math.max(6, Math.min(y, window.innerHeight - estHeight - 6));

  return (
    <div
      ref={ref}
      className="fixed z-[200] py-1"
      style={{
        left,
        top,
        width,
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
