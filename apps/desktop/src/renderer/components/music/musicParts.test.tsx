/* @vitest-environment jsdom */

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MusicItem, MusicPage } from "../../../shared/types/music";
import { CollectionTile } from "./musicParts";

/**
 * A playlist tile's cover, through the `window.ade.music` bridge (the IPC
 * boundary). A playlist Apple sends without loadable artwork reads its first
 * four songs and shows their covers; at most four such reads run at a time.
 */
const ART = "https://is1-ssl.mzstatic.com/image/thumb/Music/";

function item(id: string, kind: MusicItem["kind"], artworkUrl: string | null): MusicItem {
  return {
    id,
    kind,
    title: id,
    subtitle: "Artist",
    album: null,
    artwork: artworkUrl ? { url: artworkUrl, width: 600, height: 600, bgColor: null } : null,
    durationMs: 1_000,
    library: true,
    catalogId: null,
    trackCount: null,
    releaseYear: null,
    explicit: false,
  };
}

/** Each `tracks` read the tiles made, answered by the test. */
let reads: Array<{ id: string; answer: (covers: Array<string | null>) => Promise<void> }> = [];

function tile(playlist: MusicItem) {
  return render(<CollectionTile item={playlist} onOpen={() => {}} />);
}

/** Lets the tiles that are on screen start their reads. */
const started = () => act(async () => {});

const coverImages = (container: HTMLElement) => Array.from(container.querySelectorAll("img"), (img) => img.getAttribute("src") ?? "");

beforeEach(() => {
  reads = [];
  // Every tile is on screen as soon as it is observed.
  vi.stubGlobal("IntersectionObserver", class {
    constructor(private readonly seen: (entries: unknown[]) => void) {}
    observe(el: Element) {
      this.seen([{ isIntersecting: true, target: el, boundingClientRect: { width: 168 } }]);
    }
    disconnect() {}
  });
  (window as unknown as { ade: unknown }).ade = {
    music: {
      tracks: ({ id }: { id: string }) =>
        new Promise<MusicPage>((resolve) => {
          reads.push({
            id,
            answer: async (covers) => {
              await act(async () => {
                resolve({ items: covers.map((url, at) => item(`${id}-song-${at}`, "song", url)), nextOffset: null, total: covers.length });
              });
            },
          });
        }),
    },
  };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("playlist tile covers", () => {
  it.each([
    ["no artwork from Apple: its first four songs' covers", null, [`${ART}a/{w}x{h}.jpg`, `${ART}b/{w}x{h}.jpg`, `${ART}c/{w}x{h}.jpg`, `${ART}d/{w}x{h}.jpg`], 4],
    ["an uploaded cover ADE cannot load: its songs' covers instead", "https://store-033.blobstore.apple.com/cover/{w}x{h}.jpg", [`${ART}e/{w}x{h}.jpg`, `${ART}f/{w}x{h}.jpg`, `${ART}g/{w}x{h}.jpg`, `${ART}h/{w}x{h}.jpg`], 4],
    ["songs that share an album: that one cover", null, [`${ART}i/{w}x{h}.jpg`, `${ART}i/{w}x{h}.jpg`, `${ART}i/{w}x{h}.jpg`, `${ART}i/{w}x{h}.jpg`], 1],
    ["uploaded songs whose art cannot load are skipped", null, ["https://store-032.blobstore.apple.com/song/{w}x{h}.jpg", `${ART}j/{w}x{h}.jpg`, null, null], 1],
  ])("%s", async (label, artwork, songCovers, shown) => {
    const { container } = tile(item(`pl:${label}`, "playlist", artwork));
    await started();
    expect(reads.map((read) => read.id)).toEqual([`pl:${label}`]);
    expect(coverImages(container)).toEqual([]);

    await reads[0]!.answer(songCovers);

    const images = coverImages(container);
    expect(images).toHaveLength(shown);
    expect(images.every((src) => src.startsWith(ART))).toBe(true);
  });

  it("shows Apple's own artwork without reading any songs", async () => {
    const { container } = tile(item("pl:own-art", "playlist", `${ART}own/{w}x{h}.jpg`));
    await started();
    expect(reads).toEqual([]);
    expect(coverImages(container)).toHaveLength(1);
    expect(coverImages(container)[0]).toContain(`${ART}own/`);
  });

  it("still reads a waiting tile's cover after the tiles ahead of it left the page", async () => {
    // Four reads run; four more tiles wait their turn, then leave (the user opened a playlist).
    const running = ["run-1", "run-2", "run-3", "run-4"].map((id) => tile(item(id, "playlist", null)));
    const leaving = ["gone-1", "gone-2", "gone-3", "gone-4"].map((id) => tile(item(id, "playlist", null)));
    await started();
    expect(reads.map((read) => read.id)).toEqual(["run-1", "run-2", "run-3", "run-4"]);
    leaving.forEach((view) => view.unmount());
    const waiting = tile(item("still-here", "playlist", null));
    await started();

    for (const read of reads.slice(0, 4)) await read.answer([`${ART}k/{w}x{h}.jpg`]);

    // The tiles that left were never read; the one still on the page was.
    expect(reads.map((read) => read.id)).toEqual(["run-1", "run-2", "run-3", "run-4", "still-here"]);
    await reads[4]!.answer([`${ART}l/{w}x{h}.jpg`, `${ART}m/{w}x{h}.jpg`, `${ART}n/{w}x{h}.jpg`, `${ART}o/{w}x{h}.jpg`]);
    expect(coverImages(waiting.container)).toHaveLength(4);
    expect(coverImages(running[0]!.container)).toHaveLength(1);
  });
});
