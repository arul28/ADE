import type { MusicItem } from "../../../shared/types/music";
import { musicActions } from "./musicStore";

/**
 * Every song the Music page plays goes through here.
 *
 * MusicKit's queue takes catalog ids: a list with a library id (`i.…`) in it
 * fails with REQUEST_ERROR, and Play Next / Play Later reject one too. Library
 * songs carry their catalog id, so they are queued by that. The player then
 * reports catalog ids, so "is this row playing" compares catalog ids as well.
 */

/** Songs handed to MusicKit at once: hours of music, still quick to load. */
const QUEUE_WINDOW = 300;
/** Songs kept before the chosen one, so previous works. */
const QUEUE_BACK = 50;

/** The id MusicKit can queue for this song, or null (a library song with no catalog match). */
export function queueableId(item: MusicItem): string | null {
  return item.library ? item.catalogId : item.id;
}

/** Whether this row is the song the player reports as now playing. */
export function isNowPlayingItem(item: MusicItem, nowPlayingId: string | null): boolean {
  return nowPlayingId !== null && (item.catalogId ?? item.id) === nowPlayingId;
}

/**
 * Queue songs from a list the page already loaded, starting at `index`.
 * Songs with no queueable id are skipped (the chosen one still plays on its
 * own). Shuffle mixes the whole list before taking a window, so it reaches
 * every song.
 */
export function queueFromList(items: readonly MusicItem[], index: number, shuffle?: boolean): void {
  const chosen = items[index];
  const playable = items
    .map((item, at) => ({ id: queueableId(item), at }))
    .filter((entry): entry is { id: string; at: number } => Boolean(entry.id));
  if (!shuffle && chosen && !playable.some((entry) => entry.at === index)) {
    void musicActions.playItems([chosen.id], 0);
    return;
  }
  if (!playable.length) return;
  if (shuffle) {
    const ids = playable.map((entry) => entry.id);
    for (let i = ids.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    void musicActions.playItems(ids.slice(0, QUEUE_WINDOW), 0, true);
    return;
  }
  const position = Math.max(0, playable.findIndex((entry) => entry.at === index));
  const start = Math.max(0, Math.min(position - QUEUE_BACK, playable.length - QUEUE_WINDOW));
  void musicActions.playItems(playable.slice(start, start + QUEUE_WINDOW).map((entry) => entry.id), position - start);
}

/**
 * Play Next / Play Later handlers for one song row, or undefined (no menu
 * entries) when the song has nothing MusicKit can queue.
 */
export function queueActions(item: MusicItem): { onPlayNext?: () => void; onPlayLater?: () => void } {
  const id = queueableId(item);
  if (!id) return {};
  return {
    onPlayNext: () => void musicActions.playNext([id]),
    onPlayLater: () => void musicActions.playLater([id]),
  };
}
