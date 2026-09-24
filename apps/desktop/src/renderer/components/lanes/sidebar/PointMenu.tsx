import React from "react";
import { createPortal } from "react-dom";
import { useClampedFixedPosition } from "../../../hooks/useClampedFixedPosition";
import { COLORS } from "../laneDesignTokens";

/**
 * A right-click menu pinned to a point and portaled to `document.body`.
 * The sidebar and lane rows are containing blocks for `position: fixed`, so
 * an inline menu would land away from the pointer.
 */
export function PointMenu({
  point,
  remeasureKey,
  testId,
  minWidth,
  maxHeight,
  onClose,
  children,
}: {
  point: { x: number; y: number };
  remeasureKey: string;
  testId: string;
  minWidth: number;
  maxHeight?: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const { ref: menuRef, position } = useClampedFixedPosition(point, remeasureKey);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    const onPointerDown = () => onClose();
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [onClose]);

  React.useEffect(() => {
    menuRef.current?.focus();
  }, [menuRef]);

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      tabIndex={-1}
      data-testid={testId}
      className="ade-liquid-glass-menu"
      style={{
        position: "fixed",
        zIndex: 40,
        minWidth,
        maxHeight,
        overflowY: maxHeight ? "auto" : undefined,
        border: `1px solid ${COLORS.outlineBorder}`,
        padding: "4px 0",
        left: position?.left ?? point.x,
        top: position?.top ?? point.y,
        visibility: position ? "visible" : "hidden",
      }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  );
}
