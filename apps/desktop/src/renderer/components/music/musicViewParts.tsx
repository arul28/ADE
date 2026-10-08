import React from "react";

import type { MusicItem } from "../../../shared/types/music";
import { CollectionTile } from "./musicParts";
import { friendlyMusicError } from "./musicStore";

/** What every view that lists songs needs to mark the playing row. */
export type RowProps = { nowPlayingId: string | null; isPlaying: boolean };

export function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return friendlyMusicError(raw) ?? "Something went wrong with Apple Music. Try again.";
}

/** Run an async read whenever `deps` change; keep the last result while the next loads. */
export function useLoad<T>(load: (() => Promise<T>) | null, deps: React.DependencyList) {
  const [data, setData] = React.useState<T | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [nonce, setNonce] = React.useState(0);
  React.useEffect(() => {
    if (!load) return undefined;
    let live = true;
    setLoading(true);
    setError(null);
    load().then(
      (value) => {
        if (!live) return;
        setData(value);
        setLoading(false);
      },
      (err: unknown) => {
        if (!live) return;
        setError(errorText(err));
        setLoading(false);
      },
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);
  return { data, error, loading, reload: () => setNonce((n) => n + 1) };
}

export function ViewHeader({ title, eyebrow, children }: { title: string; eyebrow?: string; children?: React.ReactNode }) {
  return (
    <header className="ade-music-view-head">
      <div className="min-w-0">
        {eyebrow ? <div className="kit-eyebrow">{eyebrow}</div> : null}
        <h2>{title}</h2>
      </div>
      {children}
    </header>
  );
}

export function TileSection({
  title,
  items,
  onOpen,
  onPlay,
  shelf = false,
}: {
  title: string;
  items: MusicItem[];
  onOpen: (item: MusicItem) => void;
  onPlay?: (item: MusicItem) => void;
  /** One scrolling row instead of a grid. */
  shelf?: boolean;
}) {
  return (
    <section className="ade-music-section">
      <h3 className="ade-music-section-title">{title}</h3>
      <div className={shelf ? "ade-music-tiles is-shelf" : "ade-music-tiles is-grid"}>
        {items.slice(0, 12).map((item) => (
          <CollectionTile key={`${item.kind}:${item.id}`} item={item} onOpen={() => onOpen(item)} onPlay={onPlay ? () => onPlay(item) : undefined} />
        ))}
      </div>
    </section>
  );
}
