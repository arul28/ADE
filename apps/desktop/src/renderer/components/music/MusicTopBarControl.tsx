import React from "react";
import { MusicNotes } from "@phosphor-icons/react";

import { musicActions, useMusicNowPlaying } from "./musicStore";
import { musicTabAvailable } from "./musicTab";
import "./music.css";

const noDrag = { WebkitAppRegion: "no-drag" } as React.CSSProperties;

/**
 * The top bar's way into Music while the Music tab is closed: one quiet
 * music-note button. Once the tab is open, the tab itself is the mini player
 * (`MusicTabContent`), so this hides.
 */
export function MusicTopBarControl({ shortcutLabel, active }: { shortcutLabel?: string; active?: boolean }) {
  const view = useMusicNowPlaying();
  if (!musicTabAvailable() || !view.available) return null;
  return (
    <button
      type="button"
      className="ade-shell-control inline-flex h-[24px] w-[24px] shrink-0 items-center justify-center rounded-md"
      data-variant="ghost"
      data-active={active ? "true" : undefined}
      aria-label="Music"
      title={shortcutLabel ? `Music (${shortcutLabel})` : "Music"}
      style={noDrag}
      onClick={musicActions.open}
      data-testid="topbar-music"
    >
      <MusicNotes size={14} weight={active ? "fill" : "regular"} />
    </button>
  );
}
