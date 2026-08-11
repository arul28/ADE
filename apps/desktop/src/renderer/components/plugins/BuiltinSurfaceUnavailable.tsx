/**
 * What a compiled surface's route shows when its owner plugin is not installed.
 *
 * Deliberately a dead end. There is no Install button and no link to the
 * Marketplace, because the whole point of hiding a surface is that ADE stops
 * talking about it: a page that offers to bring it back is an advertisement for
 * something the user removed, and it makes "hidden" mean "one click away" —
 * which is the state this round was built to get rid of.
 *
 * It is also not a crash. `PageErrorBoundary` exists for pages that broke; this
 * one worked perfectly and simply is not part of this ADE, so it reads as a
 * plain statement rather than an error card with a Retry button.
 */

import { PuzzlePiece } from "@phosphor-icons/react";

export function BuiltinSurfaceUnavailable({ title }: { title: string }) {
  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center gap-3 p-8 text-center"
      style={{ background: "var(--color-bg)" }}
    >
      <PuzzlePiece size={28} weight="duotone" className="text-muted-fg" aria-hidden />
      <div className="text-sm font-medium text-fg">{title} isn't part of this ADE</div>
      <p className="max-w-[380px] text-xs leading-relaxed text-muted-fg">
        It comes from a plugin that isn't installed on this computer.
      </p>
    </div>
  );
}
