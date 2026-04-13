import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAppStore } from "../../state/appStore";

export type SmartTooltipContent = {
  /** Button/action name */
  label: string;
  /** What this action does */
  description: string;
  /** The git command that runs, e.g. "git push origin main" */
  gitCommand?: string;
  /** Contextual: what would happen right now, e.g. "Push 2 commits to origin/main" */
  effect?: string;
  /** Warning text shown in danger color */
  warning?: string;
  /** Keyboard shortcut hint */
  shortcut?: string;
};

type SmartTooltipProps = {
  children: React.ReactElement;
  content: SmartTooltipContent;
  /** Override the global toggle (used for the toggle button itself) */
  forceEnabled?: boolean;
  side?: "top" | "bottom";
};

const HOVER_DELAY = 320;
const GAP = 6;
const VIEWPORT_PAD = 10;

export function SmartTooltip({
  children,
  content,
  forceEnabled,
  side: preferredSide = "top",
}: SmartTooltipProps) {
  const globalEnabled = useAppStore((s) => s.smartTooltipsEnabled);
  const enabled = forceEnabled ?? globalEnabled;

  const [visible, setVisible] = useState(false);
  const [coords, setCoords] = useState<{ x: number; y: number; side: "top" | "bottom" } | null>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback(() => {
    if (!enabled) return;
    timerRef.current = setTimeout(() => {
      const el = triggerRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;

      // Pick side: prefer requested, but flip if no room
      let side = preferredSide;
      if (side === "top" && r.top < 140) side = "bottom";
      else if (side === "bottom" && window.innerHeight - r.bottom < 140) side = "top";

      setCoords({
        x: cx,
        y: side === "top" ? r.top - GAP : r.bottom + GAP,
        side,
      });
      setVisible(true);
    }, HOVER_DELAY);
  }, [enabled, preferredSide]);

  const hide = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setVisible(false);
  }, []);

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  // Clamp horizontal position after first paint
  useEffect(() => {
    if (!visible || !tooltipRef.current || !coords) return;
    const tt = tooltipRef.current;
    const ttRect = tt.getBoundingClientRect();
    const vw = window.innerWidth;
    const half = ttRect.width / 2;
    let x = coords.x;
    if (x - half < VIEWPORT_PAD) x = half + VIEWPORT_PAD;
    if (x + half > vw - VIEWPORT_PAD) x = vw - half - VIEWPORT_PAD;
    if (x !== coords.x) setCoords((prev) => prev ? { ...prev, x } : prev);
  }, [visible, coords]);

  const hasExtra = Boolean(content.gitCommand || content.effect || content.warning || content.shortcut);

  return (
    <>
      <div
        ref={triggerRef}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        style={{ display: "inline-flex" }}
      >
        {children}
      </div>
      {visible && coords
        ? createPortal(
            <div
              ref={tooltipRef}
              className="ade-smart-tooltip"
              data-side={coords.side}
              style={{
                position: "fixed",
                zIndex: 9999,
                left: coords.x,
                top: coords.y,
                transform: coords.side === "top" ? "translate(-50%, -100%)" : "translate(-50%, 0)",
                pointerEvents: "none",
              }}
            >
              {/* Header row: label + optional shortcut */}
              <div className="ade-stt-head">
                <span className="ade-stt-label">{content.label}</span>
                {content.shortcut ? <kbd className="ade-stt-kbd">{content.shortcut}</kbd> : null}
              </div>

              {/* Description */}
              <p className="ade-stt-desc">{content.description}</p>

              {/* Extra section: command, effect, warning */}
              {hasExtra ? (
                <div className="ade-stt-extra">
                  {content.gitCommand ? (
                    <code className="ade-stt-cmd">{content.gitCommand}</code>
                  ) : null}
                  {content.effect ? (
                    <span className="ade-stt-effect">{content.effect}</span>
                  ) : null}
                  {content.warning ? (
                    <span className="ade-stt-warn">{content.warning}</span>
                  ) : null}
                </div>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
