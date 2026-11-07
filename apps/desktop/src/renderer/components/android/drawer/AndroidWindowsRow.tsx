import { useState } from "react";
import type { AndroidWindowLayoutAction, AndroidWindowLayoutResult } from "../../../../shared/types/androidEmulator";
import { DRAWER_BUTTON, Subhead } from "../../ui/drawerPrimitives";
import type { AndroidDrawerContext } from "./androidDrawerState";

/*
 * Parity: the App group's **Windows** row, `ade android window`'s main moves
 * on a large screen (a tablet, or a foldable open): put the app beside the
 * one behind it, change the sides over, open it in a free window, make it
 * full screen again, or close its window. The answer names the windows after
 * the move, or why Android did not make it.
 */

const MOVES: { action: AndroidWindowLayoutAction; label: string }[] = [
  { action: "split", label: "Split" },
  { action: "swap", label: "Swap sides" },
  { action: "freeform", label: "Free window" },
  { action: "fill", label: "Full screen" },
  { action: "close", label: "Close" },
];

function describe(result: AndroidWindowLayoutResult): string {
  if (!result.applied) return result.reason ?? "Android did not make that change.";
  if (result.windows.length === 0) return "No app windows";
  return result.windows
    .slice(0, 3)
    .map((entry) => `${entry.packageName} (${entry.mode === "freeform" ? "free" : entry.mode})`)
    .join(" · ");
}

export function AndroidWindowsRow({ ctx, packageName }: { ctx: AndroidDrawerContext; packageName: string | null }) {
  const { laneId, pinRef, actions } = ctx;
  const [answer, setAnswer] = useState<string | null>(null);
  const move = (action: AndroidWindowLayoutAction) =>
    actions.act(async () => {
      const result = await window.ade.androidEmulator.windowLayout(
        { laneId, action, packageName: action === "swap" ? null : packageName },
        pinRef.current,
      );
      setAnswer(describe(result));
    });

  return (
    <>
      <Subhead label="Windows" />
      <div className="flex min-h-7 flex-wrap items-center gap-1.5">
        {MOVES.map((entry) => (
          <button
            key={entry.action}
            type="button"
            className={DRAWER_BUTTON}
            disabled={actions.disabled}
            title={entry.action === "split" ? "Put the app beside the app behind it (a large screen only)" : undefined}
            onClick={() => { void move(entry.action); }}
          >
            {entry.label}
          </button>
        ))}
      </div>
      {answer ? <div className="min-h-5 truncate text-[11px] text-muted-fg" title={answer}>{answer}</div> : null}
    </>
  );
}
