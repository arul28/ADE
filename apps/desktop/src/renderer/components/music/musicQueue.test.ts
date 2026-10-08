/* @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MusicCommand, MusicItem } from "../../../shared/types/music";
import { isNowPlayingItem, queueActions, queueFromList } from "./musicQueue";

/**
 * What the Music page hands the player for a list of songs, through the
 * `window.ade.music` bridge (the IPC boundary). MusicKit queues catalog ids
 * only: a library id in a queue fails the whole queue.
 */
function song(id: string, overrides: Partial<MusicItem> = {}): MusicItem {
  return {
    id,
    kind: "song",
    title: id,
    subtitle: "Artist",
    album: null,
    artwork: null,
    durationMs: 1_000,
    library: false,
    catalogId: null,
    trackCount: null,
    releaseYear: null,
    explicit: false,
    ...overrides,
  };
}

const sent: MusicCommand[] = [];

beforeEach(() => {
  sent.length = 0;
  Object.defineProperty(window, "ade", {
    configurable: true,
    writable: true,
    value: { music: { command: vi.fn(async (command: MusicCommand) => { sent.push(command); return { ok: true }; }) } },
  });
});

describe("queueing songs from a list", () => {
  const list = [
    song("i.lib-1", { library: true, catalogId: "101" }),
    song("i.lib-2", { library: true, catalogId: null }),
    song("202"),
    song("i.lib-3", { library: true, catalogId: "303" }),
  ];

  it.each([
    ["a catalog song", 2, { type: "playItems", ids: ["101", "202", "303"], index: 1 }],
    ["a library song with a catalog match, by its catalog id", 3, { type: "playItems", ids: ["101", "202", "303"], index: 2 }],
    ["a library song with no catalog match, on its own", 1, { type: "playItems", ids: ["i.lib-2"], index: 0 }],
  ])("plays %s", async (_label, index, command) => {
    queueFromList(list, index);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject(command);
  });

  it("offers Play Next and Play Later only for a song MusicKit can queue, by its catalog id", async () => {
    expect(queueActions(list[1]!)).toEqual({});
    const actions = queueActions(list[0]!);
    actions.onPlayNext?.();
    actions.onPlayLater?.();
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent).toEqual([{ type: "playNext", ids: ["101"] }, { type: "playLater", ids: ["101"] }]);
  });

  it.each([
    ["a library row whose catalog id is playing", song("i.lib-1", { library: true, catalogId: "101" }), "101", true],
    ["a library row by its library id", song("i.lib-1", { library: true, catalogId: "101" }), "i.lib-1", false],
    ["a catalog row", song("202"), "202", true],
    ["nothing playing", song("202"), null, false],
  ])("marks %s as now playing: %s", (_label, item, nowPlayingId, expected) => {
    expect(isNowPlayingItem(item, nowPlayingId)).toBe(expected);
  });
});
