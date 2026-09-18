/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MAC_DESKTOP_LIVE_VIEW_CARD_PRIORITY,
  MAC_DESKTOP_LIVE_VIEW_PANE_PRIORITY,
  acquireMacDesktopLiveViewLease,
  macDesktopLiveViewLeaseState,
  resetMacDesktopLiveViewLeasesForTests,
} from "./macDesktopLiveViewLease";

const stopStream = vi.fn(async () => ({
  laneId: "lane-1",
  running: false,
  fps: 0,
  idle: false,
  bitrateKbps: null,
  transport: null,
  lastError: null,
  clients: 0,
  viewerChatSessionIds: [],
}));

beforeEach(() => {
  resetMacDesktopLiveViewLeasesForTests();
  stopStream.mockClear();
  (window as unknown as { ade: unknown }).ade = { macDesktop: { stopStream } };
});

afterEach(() => {
  resetMacDesktopLiveViewLeasesForTests();
});

describe("macDesktopLiveViewLease", () => {
  it("makes the first holder the decoder owner", () => {
    const pane = acquireMacDesktopLiveViewLease({ laneId: "lane-1" });
    expect(pane.ownsDecoder()).toBe(true);
    expect(macDesktopLiveViewLeaseState("lane-1")).toEqual({ holders: 1, decoderOwnerId: 1 });
    pane.release();
  });

  it("keeps the card passive while the pane holds the lane", () => {
    const pane = acquireMacDesktopLiveViewLease({ laneId: "lane-1" });
    const cardChanges: boolean[] = [];
    const card = acquireMacDesktopLiveViewLease({
      laneId: "lane-1",
      priority: MAC_DESKTOP_LIVE_VIEW_CARD_PRIORITY,
      onDecoderOwnershipChange: (owns) => cardChanges.push(owns),
    });
    expect(pane.ownsDecoder()).toBe(true);
    expect(card.ownsDecoder()).toBe(false);
    expect(cardChanges).toEqual([]);
    pane.release();
    card.release();
  });

  it("promotes the remaining holder when the pane releases, without stopping the stream", () => {
    const pane = acquireMacDesktopLiveViewLease({ laneId: "lane-1" });
    const cardChanges: boolean[] = [];
    const card = acquireMacDesktopLiveViewLease({
      laneId: "lane-1",
      priority: MAC_DESKTOP_LIVE_VIEW_CARD_PRIORITY,
      onDecoderOwnershipChange: (owns) => cardChanges.push(owns),
    });

    pane.release();
    // The hand-off is the whole point: the card is told to start decoding and
    // the encoder is never asked to stop while anyone still holds the lane.
    expect(cardChanges).toEqual([true]);
    expect(card.ownsDecoder()).toBe(true);
    expect(stopStream).not.toHaveBeenCalled();

    card.release();
    expect(stopStream).toHaveBeenCalledTimes(1);
    expect(stopStream).toHaveBeenCalledWith({ laneId: "lane-1" }, null);
    expect(macDesktopLiveViewLeaseState("lane-1")).toBeNull();
  });

  it("lets a reopened pane take the decoder back from the card", () => {
    const pane = acquireMacDesktopLiveViewLease({ laneId: "lane-1" });
    const cardChanges: boolean[] = [];
    const card = acquireMacDesktopLiveViewLease({
      laneId: "lane-1",
      priority: MAC_DESKTOP_LIVE_VIEW_CARD_PRIORITY,
      onDecoderOwnershipChange: (owns) => cardChanges.push(owns),
    });
    pane.release();
    expect(card.ownsDecoder()).toBe(true);

    const reopenedPaneChanges: boolean[] = [];
    const reopenedPane = acquireMacDesktopLiveViewLease({
      laneId: "lane-1",
      priority: MAC_DESKTOP_LIVE_VIEW_PANE_PRIORITY,
      onDecoderOwnershipChange: (owns) => reopenedPaneChanges.push(owns),
    });
    // Highest priority wins, so the card is demoted instead of holding a
    // decoder the pane cannot draw into.
    expect(reopenedPaneChanges).toEqual([true]);
    expect(cardChanges).toEqual([true, false]);
    expect(reopenedPane.ownsDecoder()).toBe(true);
    expect(card.ownsDecoder()).toBe(false);

    reopenedPane.release();
    expect(cardChanges).toEqual([true, false, true]);
    expect(card.ownsDecoder()).toBe(true);
    expect(stopStream).not.toHaveBeenCalled();
    card.release();
    expect(stopStream).toHaveBeenCalledTimes(1);
  });

  it("keeps two lanes independent", () => {
    const a = acquireMacDesktopLiveViewLease({ laneId: "lane-a" });
    const b = acquireMacDesktopLiveViewLease({ laneId: "lane-b" });
    expect(a.ownsDecoder()).toBe(true);
    expect(b.ownsDecoder()).toBe(true);
    a.release();
    expect(stopStream).toHaveBeenCalledWith({ laneId: "lane-a" }, null);
    expect(b.ownsDecoder()).toBe(true);
    b.release();
    expect(stopStream).toHaveBeenCalledTimes(2);
  });

  it("is inert after release, so a double release cannot free someone else's stream", () => {
    const first = acquireMacDesktopLiveViewLease({ laneId: "lane-1" });
    first.release();
    expect(stopStream).toHaveBeenCalledTimes(1);

    const second = acquireMacDesktopLiveViewLease({ laneId: "lane-1" });
    expect(second.ownsDecoder()).toBe(true);
    expect(stopStream).toHaveBeenCalledTimes(1);
    first.release();
    expect(stopStream).toHaveBeenCalledTimes(1);
    expect(second.ownsDecoder()).toBe(true);
    second.release();
    expect(stopStream).toHaveBeenCalledTimes(2);
  });
});
