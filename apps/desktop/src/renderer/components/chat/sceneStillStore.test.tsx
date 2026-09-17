/* @vitest-environment jsdom */

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import {
  readCallStills,
  readSceneStill,
  rememberCallStill,
  rememberSceneStill,
  resetSceneStillsForTest,
  sceneStillSrc,
  useCallStills,
  useSceneStillRecord,
} from "./sceneStillStore";
import { stubSceneCaptureBridge } from "./sceneStillTestHarness";

/**
 * The cache in front of "a scene always leaves a picture".
 *
 * The durable index is the artifact broker; this module is a window-lifetime
 * cache over it. So the cases that matter are the seams: what the window itself
 * captured, what the broker answers on a reopen, and what happens when the two
 * disagree.
 */

const record = (uri: string, title = "Merged PRs") => ({ uri, artifactId: "a1", title });

const stillArtifact = (args: {
  id: string;
  uri: string;
  sceneScopeKey?: string;
  voiceCallId?: string;
  sceneTitle?: string;
}) => ({
  id: args.id,
  uri: args.uri,
  title: args.sceneTitle ?? "Generated view",
  metadata: {
    kind: "scene_still",
    ...(args.sceneScopeKey ? { sceneScopeKey: args.sceneScopeKey } : {}),
    ...(args.voiceCallId ? { voiceCallId: args.voiceCallId } : {}),
    ...(args.sceneTitle ? { sceneTitle: args.sceneTitle } : {}),
  },
});

afterEach(() => {
  cleanup();
  resetSceneStillsForTest();
  vi.restoreAllMocks();
  delete (window as unknown as { ade?: unknown }).ade;
});

function SceneProbe({ sessionId, scopeKey }: { sessionId: string | null; scopeKey: string }) {
  const still = useSceneStillRecord(sessionId, scopeKey);
  return <div data-testid="probe">{still?.record?.uri ?? "none"}</div>;
}

function CallProbe({ sessionId, callId }: { sessionId: string | null; callId: string }) {
  const stills = useCallStills(sessionId, callId);
  return <div data-testid="probe">{stills.map((entry) => entry.title).join(",") || "none"}</div>;
}

describe("scene stills", () => {
  it("keeps both halves of a still and prefers the pixels already in memory", () => {
    rememberSceneStill("row-1", { dataUrl: "data:image/png;base64,AAA" });
    rememberSceneStill("row-1", { record: record(".ade/artifacts/computer-use/a.png") });
    const still = readSceneStill("row-1");
    expect(still?.dataUrl).toBe("data:image/png;base64,AAA");
    expect(still?.record?.uri).toBe(".ade/artifacts/computer-use/a.png");
    expect(sceneStillSrc(still?.record, still?.dataUrl)).toBe("data:image/png;base64,AAA");
  });

  it("has nothing to say about a scene it has never seen", () => {
    expect(readSceneStill("row-missing")).toBeNull();
    expect(readSceneStill(null)).toBeNull();
    expect(sceneStillSrc(null)).toBeNull();
  });

  /**
   * The bug this replaces: the renderer kept its own durable list of artifact
   * uris in `localStorage`, which main could not prune with the bytes.
   */
  it("keeps no durable state of its own", () => {
    rememberSceneStill("row-2", { record: record(".ade/artifacts/computer-use/b.png") });
    rememberCallStill("call-2", record(".ade/artifacts/computer-use/c.png"));
    expect(localStorage.length).toBe(0);
  });

  it("refuses an absolute path as an image source rather than drawing a broken tile", () => {
    // `ade-artifact://project/` resolves PROJECT-RELATIVE uris. An absolute one
    // is a still from somewhere this window cannot serve.
    expect(sceneStillSrc({ uri: "/tmp/elsewhere.png", artifactId: null, title: "x" })).toBeNull();
    expect(sceneStillSrc({ uri: "https://example.com/x.png", artifactId: null, title: "x" })).toBeNull();
    expect(sceneStillSrc({ uri: ".ade/artifacts/computer-use/b.png", artifactId: null, title: "x" }))
      .toBe("ade-artifact://project/.ade/artifacts/computer-use/b.png");
  });

  it("collects a call's stills in order, once each", () => {
    rememberCallStill("call-1", record(".ade/artifacts/computer-use/1.png", "First"));
    rememberCallStill("call-1", record(".ade/artifacts/computer-use/2.png", "Second"));
    // The same view re-settling is the same picture, not a second one.
    rememberCallStill("call-1", record(".ade/artifacts/computer-use/1.png", "First"));
    expect(readCallStills("call-1").map((entry) => entry.title)).toEqual(["First", "Second"]);
    expect(readCallStills("call-2")).toEqual([]);
  });

  describe("reading the index back", () => {
    /** A reopened window: nothing in memory, everything in the broker. */
    it("finds a scene's still by its scope key", async () => {
      const bridge = stubSceneCaptureBridge({
        artifacts: [stillArtifact({
          id: "a9",
          uri: ".ade/artifacts/computer-use/old.png",
          sceneScopeKey: "row-9:abc",
        })],
      });
      render(<SceneProbe sessionId="chat-1" scopeKey="row-9:abc" />);
      await waitFor(() =>
        expect(screen.getByTestId("probe").textContent).toBe(".ade/artifacts/computer-use/old.png"));
      expect(bridge.listArtifacts.mock.calls[0]?.[0]).toMatchObject({
        ownerKind: "chat_session",
        ownerId: "chat-1",
        metadataKinds: ["scene_still"],
      });
    });

    it("asks the broker once per chat however many scenes are on screen", async () => {
      const bridge = stubSceneCaptureBridge({ artifacts: [] });
      render(
        <>
          <SceneProbe sessionId="chat-2" scopeKey="row-a" />
          <SceneProbe sessionId="chat-2" scopeKey="row-b" />
          <SceneProbe sessionId="chat-2" scopeKey="row-c" />
        </>,
      );
      await waitFor(() => expect(bridge.listArtifacts).toHaveBeenCalledTimes(1));
    });

    /** The call card's pictures come from the same query, filtered by call id. */
    it("gives a call the stills filed under it, oldest first", async () => {
      stubSceneCaptureBridge({
        artifacts: [
          // Newest first, the order the broker answers in.
          stillArtifact({ id: "a2", uri: ".ade/2.png", voiceCallId: "call-7", sceneTitle: "Second" }),
          stillArtifact({ id: "a1", uri: ".ade/1.png", voiceCallId: "call-7", sceneTitle: "First" }),
          stillArtifact({ id: "a3", uri: ".ade/3.png", voiceCallId: "call-8", sceneTitle: "Other" }),
        ],
      });
      render(<CallProbe sessionId="chat-3" callId="call-7" />);
      await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("First,Second"));
    });

    /** A picture this window captured beats the same row read back off disk. */
    it("never overwrites a still this window took", async () => {
      rememberSceneStill("row-live", {
        dataUrl: "data:image/png;base64,LIVE",
        record: record(".ade/artifacts/computer-use/live.png"),
      });
      stubSceneCaptureBridge({
        artifacts: [stillArtifact({
          id: "stale",
          uri: ".ade/artifacts/computer-use/stale.png",
          sceneScopeKey: "row-live",
        })],
      });
      render(<SceneProbe sessionId="chat-4" scopeKey="row-live" />);
      await waitFor(() => expect(screen.getByTestId("probe").textContent)
        .toBe(".ade/artifacts/computer-use/live.png"));
      expect(readSceneStill("row-live")?.dataUrl).toBe("data:image/png;base64,LIVE");
    });
  });
});
