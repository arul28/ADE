import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ArrowCounterClockwise, Lightbulb, Question } from "@phosphor-icons/react";
import { openAdeTips } from "../tips/AdeTipsDialog";
import { FLOATS_OVER_BROWSER_PROPS, modalOpen } from "../../ui/overlayState";
import { isAnchorVisible, prefersReducedMotion, readFrame } from "./anchorGeometry";
import type { TourCursorMotion } from "./tourCursor";
import { watchTourDom } from "./tourWatch";

/**
 * The tour's last moment: a calm card in the middle of the window that says
 * thanks and where to learn more (ADE Tips, the help menu, the tour again),
 * with the ADE cursor resting on the help button when it is on screen. One
 * primary button closes it; closing records the tour as done, so it shows
 * once. Waits while a dialog is open (the last step can open Connections).
 */

const HELP_BUTTON_SELECTOR = '[aria-label="Help menu"]';

function findHelpButton(): HTMLElement | null {
  for (const node of document.querySelectorAll<HTMLElement>(HELP_BUTTON_SELECTOR)) {
    if (isAnchorVisible(node)) return node;
  }
  return null;
}

export function TourFinishCard({
  cursor,
  onReplay,
  onDone,
}: {
  cursor: TourCursorMotion;
  onReplay: () => void;
  onDone: () => void;
}) {
  const titleId = useId();
  const [blocked, setBlocked] = useState(modalOpen);
  const [helpButton, setHelpButton] = useState<HTMLElement | null>(null);
  const doneRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const watch = watchTourDom(() => {
      setBlocked(modalOpen());
      setHelpButton((current) => (current && isAnchorVisible(current) ? current : findHelpButton()));
    }, { minIntervalMs: 400 });
    return () => watch.dispose();
  }, []);

  // The cursor glides to the help button and rests there; without one on
  // screen it steps aside.
  useEffect(() => {
    if (blocked || !helpButton) {
      cursor.hide();
      return;
    }
    const frame = readFrame(helpButton);
    cursor.glideTo(
      { x: frame.left + frame.width / 2, y: frame.top + frame.height / 2 },
      { reduced: prefersReducedMotion(), press: false, viewport: { x: frame.vw, y: frame.vh } },
      () => undefined,
    );
  }, [blocked, cursor, helpButton]);

  useEffect(() => {
    if (blocked) return undefined;
    if (!document.activeElement || document.activeElement === document.body) {
      doneRef.current?.focus({ preventScroll: true });
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDone();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [blocked, onDone]);

  const openTips = useCallback(() => {
    onDone();
    openAdeTips();
  }, [onDone]);

  if (blocked) return null;
  return (
    <div className="ade-tour-finish-wrap">
      <section className="kit-card ade-tour-card ade-tour-finish" data-float="true" {...FLOATS_OVER_BROWSER_PROPS} aria-labelledby={titleId}>
        <span className="ade-tour-count">Tour complete</span>
        <h2 id={titleId} className="ade-tour-finish-title">You're all set</h2>
        <p className="ade-tour-line">Thanks for installing ADE. When you want more, it's all one click away.</p>
        <ul className="ade-tour-finish-list">
          <li>
            <Lightbulb size={15} aria-hidden />
            <span className="ade-tour-finish-text">
              <b>ADE Tips</b>
              <span>Every feature, one line each.</span>
            </span>
            <button type="button" className="kit-btn kit-btn-ghost" data-size="sm" onClick={openTips}>
              Open
            </button>
          </li>
          <li>
            <Question size={15} aria-hidden />
            <span className="ade-tour-finish-text">
              <b>Help menu</b>
              <span>The ? in a project's sidebar: tips, docs and what's new.</span>
            </span>
          </li>
          <li>
            <ArrowCounterClockwise size={15} aria-hidden />
            <span className="ade-tour-finish-text">
              <b>Show me around again</b>
              <span>Replay this tour from the help menu, or now.</span>
            </span>
            <button type="button" className="kit-btn kit-btn-ghost" data-size="sm" onClick={onReplay}>
              Replay
            </button>
          </li>
        </ul>
        <div className="ade-tour-finish-actions">
          <button ref={doneRef} type="button" className="kit-btn kit-btn-primary" onClick={onDone}>
            Start building
          </button>
        </div>
      </section>
    </div>
  );
}
