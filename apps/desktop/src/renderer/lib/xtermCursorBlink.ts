import type { IDisposable, Terminal } from "@xterm/xterm";

const CLOCK_CLASS = "ade-xterm-blink-clock";
const OFF_CLASS = "ade-xterm-blink-off";
// xterm's blink animation is `1s step-end infinite`: on for 500 ms, off for 500 ms.
const HALF_PERIOD_MS = 500;

/**
 * xterm's DOM renderer blinks a focused cursor with an infinite `step-end` CSS
 * animation. Even stepped, a running main-thread animation re-runs style every
 * display frame — ~8% of a renderer core for an idle focused shell on a 240 Hz
 * display. With the clock class on `host`, index.css pauses that animation and
 * holds it on one of its two keyframes; this flips between them on the same
 * 500 ms schedule. It restarts at "on" whenever xterm re-renders the cursor row
 * or the terminal takes focus, the moments the CSS animation restarted, so the
 * blink looks the same. The colours still come from xterm's own keyframes.
 */
export function attachCursorBlinkClock(term: Terminal, host: HTMLElement): IDisposable {
  host.classList.add(CLOCK_CLASS);
  let timer: number | null = null;

  const stop = () => {
    if (timer != null) {
      window.clearInterval(timer);
      timer = null;
    }
    host.classList.remove(OFF_CLASS);
  };
  const restart = () => {
    stop();
    timer = window.setInterval(() => host.classList.toggle(OFF_CLASS), HALF_PERIOD_MS);
  };
  const onFocusIn = () => {
    if (term.textarea && term.textarea === host.ownerDocument.activeElement) restart();
  };
  const onFocusOut = () => stop();

  host.addEventListener("focusin", onFocusIn);
  host.addEventListener("focusout", onFocusOut);
  const renderSub = term.onRender(({ start, end }) => {
    if (timer == null) return;
    const buffer = term.buffer.active;
    const cursorRow = buffer.baseY + buffer.cursorY - buffer.viewportY;
    if (cursorRow >= start && cursorRow <= end) restart();
  });
  onFocusIn();

  return {
    dispose: () => {
      stop();
      renderSub.dispose();
      host.removeEventListener("focusin", onFocusIn);
      host.removeEventListener("focusout", onFocusOut);
      host.classList.remove(CLOCK_CLASS);
    },
  };
}
