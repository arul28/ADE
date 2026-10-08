import { CaretRight, Queue, WarningCircle } from "@phosphor-icons/react";

import type { MusicQueue } from "../../../shared/types/music";
import { MusicEmpty, SongRow } from "./musicParts";
import { musicActions } from "./musicStore";
import { useLoad, ViewHeader, type RowProps } from "./musicViewParts";

/** Up Next: the player's own queue (catalog songs), the current one first. */
export function QueueView({ nowPlayingId, isPlaying, revision, hostStatus }: RowProps & { revision: number; hostStatus: string }) {
  const { data, error } = useLoad<MusicQueue>(() => window.ade!.music!.queue(), [revision, nowPlayingId, hostStatus]);
  const position = data?.position ?? -1;
  const items = data?.items ?? [];
  const current = position >= 0 ? items[position] : undefined;
  const upcoming = position >= 0 ? items.slice(position + 1) : items;
  return (
    <div className="ade-music-view" data-testid="music-queue">
      <ViewHeader title="Up Next">
        {hostStatus === "suspended" ? <span className="kit-tag">Resumes where you left off</span> : null}
      </ViewHeader>
      <div className="ade-music-scroll">
        {error ? <MusicEmpty icon={<WarningCircle size={22} />} title="Couldn't read the queue" hint={error} /> : null}
        {!items.length && !error ? (
          <MusicEmpty icon={<Queue size={22} />} title="Nothing queued" hint="Play a song, album or playlist and what comes next shows here." />
        ) : null}
        {current ? (
          <section className="ade-music-section">
            <h3 className="kit-eyebrow">Now playing</h3>
            <div className="ade-music-songs" role="table">
              <SongRow item={current} index={position} current playing={isPlaying} onPlay={() => void musicActions.toggle()} />
            </div>
          </section>
        ) : null}
        {upcoming.length ? (
          <section className="ade-music-section">
            <h3 className="kit-eyebrow">
              Next <span className="kit-num">{upcoming.length}</span>
            </h3>
            <div className="ade-music-songs" role="table">
              {upcoming.slice(0, 200).map((item, i) => {
                const index = position + 1 + i;
                return (
                  <SongRow
                    key={`${item.id}:${index}`}
                    item={item}
                    index={i}
                    current={false}
                    playing={false}
                    onPlay={() => void musicActions.playAt(index)}
                  />
                );
              })}
            </div>
            {upcoming.length > 200 ? (
              <div className="ade-music-more kit-num">
                and {upcoming.length - 200} more <CaretRight size={11} />
              </div>
            ) : null}
          </section>
        ) : null}
      </div>
    </div>
  );
}
