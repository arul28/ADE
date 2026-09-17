/* @vitest-environment jsdom */

import React from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatRuntimeScopeProvider } from "./ChatRuntimeScope";
import { MarkdownBlock } from "./chatMarkdownBlock";
import { SceneFrame } from "./SceneFrame";
import { SCENE_STILL_INDEX_WAIT_MS } from "./useSceneStillLatch";
import { readSceneStill, rememberSceneStill, resetSceneStillsForTest } from "./sceneStillStore";
import {
  postSceneMessage,
  SCENE_STILL_DATA_URL,
  stubSceneCaptureBridge,
  stubShellRect,
} from "./sceneStillTestHarness";

/** A chat pinned to another machine: no local artifact protocol, ever. */
const REMOTE_BINDING = {
  kind: "remote" as const,
  key: "remote:target-1:project-1",
  targetId: "target-1",
  runtimeName: "Remote",
  projectId: "project-1",
  rootPath: "/remote/project",
  displayName: "Project",
};

const SCENE = [
  "```scene",
  '<!-- @scene title="Merged pull requests" -->',
  '<div id="n">3</div>',
  "```",
].join("\n");

afterEach(cleanup);

beforeEach(() => {
  // One url per prepared document. A constant made a source swap look like no
  // change at all, so a frame handed a second view never rearmed anything.
  let documents = 0;
  (globalThis as unknown as { URL: typeof URL }).URL.createObjectURL =
    vi.fn(() => `blob:scene-${++documents}`);
  (globalThis as unknown as { URL: typeof URL }).URL.revokeObjectURL = vi.fn();
});

describe("SceneFrame", () => {
  /**
   * The security property the whole feature rests on. `allow-scripts` WITH
   * `allow-same-origin` would hand the frame back its own origin and let it
   * reach into ADE; this assertion is what stops that pair being introduced by
   * a later edit.
   */
  it("sandboxes scripts without ever granting same-origin", async () => {
    render(<SceneFrame source={'<div id="n">3</div>'} live scopeKey={null} voiceCallId={null} />);
    const frame = await screen.findByTestId("chat-scene-frame");
    const sandbox = frame.getAttribute("sandbox") ?? "";
    expect(sandbox).toContain("allow-scripts");
    expect(sandbox).not.toContain("allow-same-origin");
    expect(frame.getAttribute("referrerPolicy") ?? frame.getAttribute("referrerpolicy")).toBe("no-referrer");
  });

  it("shows the title and marks the view as agent-drawn", async () => {
    render(<SceneFrame source={'<!-- @scene title="Merged pull requests" -->\n<p>x</p>'} live scopeKey={null} voiceCallId={null} />);
    await screen.findByTestId("chat-scene-frame");
    const scene = screen.getByTestId("chat-scene");
    expect(scene.textContent).toContain("Merged pull requests");
    // The caption always states which of the three states the view is in, so a
    // frozen snapshot can never be mistaken for something still updating.
    expect(scene.textContent).toMatch(/drawing|live|frozen/);
  });

  it("falls back to a readable code block when the scene cannot be parsed", () => {
    render(<SceneFrame source={"   "} live scopeKey={null} voiceCallId={null} />);
    expect(screen.queryByTestId("chat-scene-frame")).toBeNull();
    expect(screen.getByText(/could not be rendered/i)).toBeTruthy();
  });

  /** Any agent can draw, so the fence must not require a render context. */
  it("renders a ```scene fence from an ordinary markdown body", async () => {
    render(<MarkdownBlock markdown={SCENE} sceneLive />);
    await waitFor(() => expect(screen.getByTestId("chat-scene")).toBeTruthy());
    expect(screen.getByTestId("chat-scene").getAttribute("data-scene-status")).not.toBeNull();
  });

  /**
   * The hosted web client exposes a generic fallback proxy for anything under
   * `window.ade`, so `scene.prepare` IS a function, DOES resolve, and resolves
   * `null`. A bare `typeof === "function"` check passed it, `src` became null,
   * and the scene rendered as a blank gap with no error anywhere.
   */
  it("falls back to a blob URL when prepare resolves a non-string", async () => {
    const prepare = vi.fn(async () => null);
    (window as unknown as { ade?: unknown }).ade = { scene: { prepare } };
    try {
      render(<SceneFrame source={'<div id="n">3</div>'} live scopeKey={null} voiceCallId={null} />);
      const frame = await screen.findByTestId("chat-scene-frame");
      expect(prepare).toHaveBeenCalled();
      expect(frame.getAttribute("src")).toBe("blob:scene-1");
    } finally {
      delete (window as unknown as { ade?: unknown }).ade;
    }
  });

  /**
   * An unterminated fence parses on every streamed tick. Mounting on one
   * prepared a new document and reloaded the iframe several times a second,
   * throwing away whatever the half-written scene had drawn.
   */
  it("holds a placeholder while the scene fence is still streaming", async () => {
    const partial = [
      "```scene",
      '<!-- @scene title="Merged pull requests" -->',
      '<div id="n">3</div>',
    ].join("\n");
    const { rerender } = render(<MarkdownBlock markdown={partial} sceneLive />);
    await waitFor(() => expect(screen.getByTestId("chat-scene")).toBeTruthy());
    expect(screen.getByTestId("chat-scene").getAttribute("data-scene-status")).toBe("drawing");
    expect(screen.queryByTestId("chat-scene-frame")).toBeNull();
    expect(screen.getByTestId("chat-scene").textContent).toContain("Merged pull requests");

    rerender(<MarkdownBlock markdown={SCENE} sceneLive />);
    await screen.findByTestId("chat-scene-frame");
  });

  /** A settled row mounts whatever the fence state says: the turn is over. */
  it("mounts an unterminated fence once the turn is no longer live", async () => {
    render(<MarkdownBlock markdown={"```scene\n<p>truncated"} />);
    await screen.findByTestId("chat-scene-frame");
  });

  /* ───────────────────────── freeze / snapshot ───────────────────────── */

  /**
   * The freeze swap had no test at all, and it is the step that decides what a
   * scene looks like forever: once the turn ends the live frame is replaced by
   * a still, and that same still is what the Proof button files.
   */
  describe("freezing a finished scene", () => {
    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
      delete (window as unknown as { ade?: unknown }).ade;
    });

    async function renderRunningScene(snapshot: (rect: unknown) => Promise<string | null>) {
      (window as unknown as { ade?: unknown }).ade = { scene: { snapshot } };
      const { rerender } = render(<SceneFrame source={'<div id="n">3</div>'} live scopeKey={null} voiceCallId={null} />);
      const frame = await screen.findByTestId("chat-scene-frame");
      // The frame reports ready, which is the draw gate: a capture before the
      // first paint snapshots a blank rect.
      window.dispatchEvent(
        new MessageEvent("message", {
          source: (frame as HTMLIFrameElement).contentWindow,
          data: { __adeScene: 1, type: "ready", payload: { height: 200 } },
        }),
      );
      await waitFor(() =>
        expect(screen.getByTestId("chat-scene").getAttribute("data-scene-status")).toBe("running"),
      );
      return rerender;
    }

    it("swaps the live frame for a still once the turn ends", async () => {
      stubShellRect({});
      const snapshot = vi.fn(async () => "data:image/png;base64,AAAA");
      const rerender = await renderRunningScene(snapshot);

      rerender(<SceneFrame source={'<div id="n">3</div>'} live={false} scopeKey={null} voiceCallId={null} />);
      await waitFor(() => expect(screen.getByTestId("chat-scene-snapshot")).toBeTruthy());
      expect(screen.queryByTestId("chat-scene-frame")).toBeNull();
      expect(screen.getByTestId("chat-scene").getAttribute("data-scene-status")).toBe("frozen");
      expect(snapshot).toHaveBeenCalledWith({ x: 0, y: 0, width: 400, height: 200 });
    });

    /**
     * Main INTERSECTS the capture rect with the content box, so a scene that is
     * half scrolled off freezes to the visible sliver — permanently, and that
     * crop is what Proof files. Never accept a partial capture.
     */
    it("refuses to snapshot a scene that is only partly on screen", async () => {
      stubShellRect({ top: -120, y: -120, bottom: 80 });
      const snapshot = vi.fn(async () => "data:image/png;base64,AAAA");
      const rerender = await renderRunningScene(snapshot);

      rerender(<SceneFrame source={'<div id="n">3</div>'} live={false} scopeKey={null} voiceCallId={null} />);
      await waitFor(() =>
        expect(screen.getByTestId("chat-scene-frame")).toBeTruthy(),
      );
      expect(snapshot).not.toHaveBeenCalled();
      expect(screen.queryByTestId("chat-scene-snapshot")).toBeNull();
    });

    /**
     * The retry has to RE-CHECK, not just fire. The transcript auto-scrolls on
     * its own, constantly, and usually leaves the scene no more visible than it
     * was; a retry that froze on the next scroll whatever the rect said either
     * captured a cropped sliver or gave up while the scene was still partly on
     * screen and could still have come back.
     */
    it("keeps waiting when a scroll leaves the scene still partly off screen", async () => {
      stubShellRect({ top: -120, y: -120, bottom: 80 });
      const snapshot = vi.fn(async () => "data:image/png;base64,AAAA");
      const rerender = await renderRunningScene(snapshot);

      rerender(<SceneFrame source={'<div id="n">3</div>'} live={false} scopeKey={null} voiceCallId={null} />);
      await waitFor(() => expect(screen.getByTestId("chat-scene-frame")).toBeTruthy());

      // Still partial — a different partial, but partial.
      stubShellRect({ top: -40, y: -40, bottom: 160 });
      window.dispatchEvent(new Event("scroll"));
      await waitFor(() => expect(screen.getByTestId("chat-scene-frame")).toBeTruthy());
      expect(snapshot).not.toHaveBeenCalled();
      expect(screen.queryByTestId("chat-scene-snapshot")).toBeNull();
      expect(screen.getByTestId("chat-scene").getAttribute("data-scene-status")).toBe("running");
    });

    /**
     * ...and waiting cannot be forever. A scene taller than the window can
     * never be fully visible, so without a deadline it stays `running` and the
     * iframe keeps executing in scrollback — the exact thing freezing is for.
     */
    it("gives up after the deadline on a scene that can never be fully visible", async () => {
      stubShellRect({ top: -120, y: -120, bottom: 80 });
      const snapshot = vi.fn(async () => "data:image/png;base64,AAAA");
      const rerender = await renderRunningScene(snapshot);

      vi.useFakeTimers();
      rerender(<SceneFrame source={'<div id="n">3</div>'} live={false} scopeKey={null} voiceCallId={null} />);
      // No scroll, no new intersection: the deadline timer is the only thing
      // that can wake this up.
      await act(async () => { await vi.advanceTimersByTimeAsync(4_100); });

      expect(screen.getByTestId("chat-scene").getAttribute("data-scene-status")).toBe("frozen");
      // Frozen WITHOUT a capture: a cropped still is worse than the live view.
      expect(snapshot).not.toHaveBeenCalled();
      expect(screen.queryByTestId("chat-scene-snapshot")).toBeNull();
      expect(screen.getByTestId("chat-scene-frame")).toBeTruthy();
    });

    /** ...and it tries again when the scroll that hid it scrolls it back. */
    it("captures on the retry once the whole scene is back on screen", async () => {
      stubShellRect({ top: -120, y: -120, bottom: 80 });
      const snapshot = vi.fn(async () => "data:image/png;base64,AAAA");
      const rerender = await renderRunningScene(snapshot);

      rerender(<SceneFrame source={'<div id="n">3</div>'} live={false} scopeKey={null} voiceCallId={null} />);
      await waitFor(() => expect(screen.getByTestId("chat-scene-frame")).toBeTruthy());

      stubShellRect({});
      window.dispatchEvent(new Event("scroll"));
      await waitFor(() => expect(screen.getByTestId("chat-scene-snapshot")).toBeTruthy());
      expect(snapshot).toHaveBeenCalledTimes(1);
    });

    /** No capture route at all: keep the working view rather than nothing. */
    it("leaves the frame mounted when the host cannot snapshot", async () => {
      stubShellRect({});
      const { rerender } = render(<SceneFrame source={'<div id="n">3</div>'} live scopeKey={null} voiceCallId={null} />);
      await screen.findByTestId("chat-scene-frame");
      rerender(<SceneFrame source={'<div id="n">3</div>'} live={false} scopeKey={null} voiceCallId={null} />);
      await waitFor(() => expect(screen.getByTestId("chat-scene-frame")).toBeTruthy());
      expect(screen.queryByTestId("chat-scene-snapshot")).toBeNull();
    });
  });

  /* ─────────────────────── settle-time still ─────────────────────── */

  /**
   * The picture a scene leaves behind, taken when it STOPS MOVING rather than
   * when its turn ends.
   *
   * Freezing at the end of the turn answered nothing for the two cases the user
   * actually hits — a scene scrolled out of view by then, and a window too
   * short to ever hold one fully — because both fall through to "leave the live
   * frame up", which leaves scrollback and every reopen with no picture at all.
   */
  describe("keeping a still of a settled scene", () => {
    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
      resetSceneStillsForTest();
      delete (window as unknown as { ade?: unknown }).ade;
    });

    async function renderSettlingScene(options: {
      snapshot?: () => Promise<string | null>;
      storeStill?: (args: unknown) => Promise<{ uri: string; artifactId: string | null; title: string } | null>;
      scopeKey?: string;
      voiceCallId?: string;
      onStill?: (record: { uri: string; artifactId: string | null; title: string }) => void;
    } = {}) {
      const bridge = stubSceneCaptureBridge({
        ...(options.snapshot ? { snapshot: options.snapshot } : {}),
        ...(options.storeStill ? { storeStill: options.storeStill } : {}),
      });
      const { snapshot, storeStill } = bridge;
      const props = {
        source: '<div id="n">3</div>',
        live: true,
        // Always keyed: a scene with no scope key is deliberately never
        // stored, so a default-less harness would test the wrong path.
        scopeKey: options.scopeKey ?? "row-default",
        voiceCallId: options.voiceCallId ?? null,
        ...(options.onStill ? { onStill: options.onStill } : {}),
      };
      const { rerender } = render(<SceneFrame {...props} />);
      const frame = await screen.findByTestId("chat-scene-frame");
      const post = (type: string) => postSceneMessage(frame, type);
      act(() => { post("ready"); });
      await waitFor(() =>
        expect(screen.getByTestId("chat-scene").getAttribute("data-scene-status")).toBe("running"),
      );
      return { rerender, snapshot, storeStill, settle: () => act(() => { post("settled"); }), props };
    }

    it("captures while the scene is still live, and keeps running", async () => {
      stubShellRect({});
      const { snapshot, storeStill, settle } = await renderSettlingScene();

      settle();
      await waitFor(() => expect(snapshot).toHaveBeenCalledTimes(1));
      // The still is taken mid-turn; nothing is torn down for it.
      expect(screen.getByTestId("chat-scene-frame")).toBeTruthy();
      expect(screen.getByTestId("chat-scene").getAttribute("data-scene-status")).toBe("running");
      await waitFor(() => expect(storeStill).toHaveBeenCalledTimes(1));
      expect(storeStill.mock.calls[0]?.[0]).toMatchObject({ dataUrl: SCENE_STILL_DATA_URL });
    });

    /**
     * The case the owner asked for: a scene that had scrolled away by the end
     * of its turn used to freeze with NO picture and a live frame left running.
     * With a settle-time still it freezes to the picture it already has.
     */
    it("shows the still on a scene the freeze could never capture", async () => {
      stubShellRect({});
      const { rerender, settle, props, snapshot } = await renderSettlingScene();
      settle();
      await waitFor(() => expect(snapshot).toHaveBeenCalledTimes(1));

      // Now scroll it half off and end the turn — the freeze capture refuses a
      // partial rect, and before the still existed that meant nothing at all.
      stubShellRect({ top: -120, y: -120, bottom: 80 });
      rerender(<SceneFrame {...props} live={false} />);
      await waitFor(() => expect(screen.getByTestId("chat-scene-snapshot")).toBeTruthy());
      expect(screen.queryByTestId("chat-scene-frame")).toBeNull();
      expect(screen.getByTestId("chat-scene-snapshot").getAttribute("src")).toBe(SCENE_STILL_DATA_URL);
    });

    it("waits for a partly visible scene to come fully on screen before capturing", async () => {
      stubShellRect({ top: -120, y: -120, bottom: 80 });
      const { snapshot, settle } = await renderSettlingScene();

      settle();
      await waitFor(() => expect(screen.getByTestId("chat-scene-frame")).toBeTruthy());
      // A partial capture is cropped by main and kept forever; never take one.
      expect(snapshot).not.toHaveBeenCalled();

      stubShellRect({});
      window.dispatchEvent(new Event("scroll"));
      await waitFor(() => expect(snapshot).toHaveBeenCalledTimes(1));
    });

    it("settles on its own when the frame never says it has", async () => {
      stubShellRect({});
      vi.useFakeTimers();
      (window as unknown as { ade?: unknown }).ade = {
        scene: { snapshot: vi.fn(async () => "data:image/png;base64,STILL") },
      };
      render(<SceneFrame source={'<div id="n">3</div>'} live scopeKey={null} voiceCallId={null} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      const frame = screen.getByTestId("chat-scene-frame");
      act(() => {
        window.dispatchEvent(new MessageEvent("message", {
          source: (frame as HTMLIFrameElement).contentWindow,
          data: { __adeScene: 1, type: "ready", payload: { height: 200 } },
        }));
      });
      // An older prepared document, or a script that threw before the watcher
      // was armed: the host runs the same deadline independently.
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
      const snapshot = (window as unknown as { ade: { scene: { snapshot: ReturnType<typeof vi.fn> } } })
        .ade.scene.snapshot;
      expect(snapshot).toHaveBeenCalledTimes(1);
    });

    it("hands the stored record to a caller that outlives the frame", async () => {
      stubShellRect({});
      const onStill = vi.fn();
      const { settle } = await renderSettlingScene({ scopeKey: "call-1", onStill });
      settle();
      await waitFor(() => expect(onStill).toHaveBeenCalledTimes(1));
      expect(onStill.mock.calls[0]?.[0]).toMatchObject({ uri: ".ade/artifacts/computer-use/s.png" });
      expect(readSceneStill("call-1")?.record?.artifactId).toBe("a1");
    });

    /**
     * A reopened chat: the code must NOT run again. A scene is code an agent
     * wrote and the still exists precisely so scrollback never re-executes it.
     */
    it("shows a stored still instead of re-running the scene on a later mount", async () => {
      rememberSceneStill("row-9", {
        record: { uri: ".ade/artifacts/computer-use/old.png", artifactId: "a9", title: "Merged PRs" },
      });
      render(<SceneFrame source={'<div id="n">3</div>'} live={false} scopeKey="row-9" voiceCallId={null} />);

      await waitFor(() => expect(screen.getByTestId("chat-scene-snapshot")).toBeTruthy());
      expect(screen.queryByTestId("chat-scene-frame")).toBeNull();
      expect(screen.getByTestId("chat-scene-snapshot").getAttribute("src"))
        .toBe("ade-artifact://project/.ade/artifacts/computer-use/old.png");
      expect(screen.getByTestId("chat-scene").getAttribute("data-scene-status")).toBe("frozen");
    });

    /** A scene that IS live on this mount plays out; the still never pre-empts it. */
    it("still runs the code when the turn that drew it is live", async () => {
      rememberSceneStill("row-10", {
        record: { uri: ".ade/artifacts/computer-use/old.png", artifactId: "a10", title: "Merged PRs" },
      });
      render(<SceneFrame source={'<div id="n">3</div>'} live scopeKey="row-10" voiceCallId={null} />);
      expect(await screen.findByTestId("chat-scene-frame")).toBeTruthy();
    });

    it("files the settle still as proof when the freeze never captured one", async () => {
      stubShellRect({});
      const attachProof = vi.fn(async (_args: { dataUrl?: string | null }) => true);
      const snapshot = vi.fn(async () => "data:image/png;base64,STILL");
      (window as unknown as { ade?: unknown }).ade = { scene: { snapshot, attachProof } };
      const { rerender } = render(<SceneFrame source={'<div id="n">3</div>'} live scopeKey={null} voiceCallId={null} />);
      const frame = await screen.findByTestId("chat-scene-frame");
      act(() => {
        for (const type of ["ready", "settled"]) {
          window.dispatchEvent(new MessageEvent("message", {
            source: (frame as HTMLIFrameElement).contentWindow,
            data: { __adeScene: 1, type, payload: { height: 200 } },
          }));
        }
      });
      await waitFor(() => expect(snapshot).toHaveBeenCalledTimes(1));

      // Out of view at the end of the turn, so `snapshot` state is null — the
      // Proof button used to file nothing at all here.
      stubShellRect({ top: -120, y: -120, bottom: 80 });
      rerender(<SceneFrame source={'<div id="n">3</div>'} live={false} scopeKey={null} voiceCallId={null} />);
      await waitFor(() => expect(screen.getByTestId("chat-scene-snapshot")).toBeTruthy());
      act(() => { screen.getByTestId("chat-scene-proof").click(); });
      await waitFor(() => expect(attachProof).toHaveBeenCalledTimes(1));
      expect(attachProof.mock.calls[0]?.[0]).toMatchObject({ dataUrl: "data:image/png;base64,STILL" });
    });

    /**
     * The still's identity in main's index. Without it main cannot tell one
     * scene's picture from another's, so it can neither supersede a redraw nor
     * hand a finished call its own views back.
     */
    it("stores the still under the scene's own key and call", async () => {
      stubShellRect({});
      const { storeStill, settle } = await renderSettlingScene({
        scopeKey: "row-4:zz",
        voiceCallId: "call-9",
      });
      settle();
      await waitFor(() => expect(storeStill).toHaveBeenCalledTimes(1));
      expect(storeStill.mock.calls[0]?.[0]).toMatchObject({
        scopeKey: "row-4:zz",
        voiceCallId: "call-9",
      });
    });

    /**
     * One mounted frame, many documents — the voice HUD's shape.
     *
     * A source swap resets the one-capture latch and the settle flag in the
     * same commit, and the reset's state update is only SCHEDULED: the capture
     * effect re-ran first, against the previous document's `settled`, took a
     * picture of a view that had just been replaced, discarded it when its own
     * effect was torn down, and left the latch burned — so every document after
     * the first filed nothing at all.
     */
    it("files a still for each document a single frame is handed", async () => {
      stubShellRect({});
      const { storeStill, settle, rerender, props } = await renderSettlingScene({
        scopeKey: "view-1",
      });
      settle();
      await waitFor(() => expect(storeStill).toHaveBeenCalledTimes(1));

      // The same frame, a new view — exactly what the HUD does mid-call.
      rerender(<SceneFrame {...props} source={"<p>second view</p>"} scopeKey="view-2" />);
      const frame = await screen.findByTestId("chat-scene-frame");
      await waitFor(() => expect(frame.getAttribute("src")).toBe("blob:scene-2"));
      act(() => { postSceneMessage(frame, "settled"); });

      await waitFor(() => expect(storeStill).toHaveBeenCalledTimes(2));
      expect(storeStill.mock.calls.map((call) => (call[0] as { scopeKey: string }).scopeKey))
        .toEqual(["view-1", "view-2"]);
    });

    /**
     * Two scene fences in one message used to share the transcript row key, so
     * whichever settled last overwrote the other's picture and a reopened chat
     * showed the same view twice.
     */
    it("gives two fences in one message their own stills", async () => {
      stubShellRect({});
      const bridge = stubSceneCaptureBridge();
      const body = [
        "```scene",
        '<!-- @scene title="First" -->',
        "<p>one</p>",
        "```",
        "",
        "```scene",
        '<!-- @scene title="Second" -->',
        "<p>two</p>",
        "```",
      ].join("\n");
      render(<MarkdownBlock markdown={body} sceneScopeKey="row-7" sceneLive />);
      const frames = await screen.findAllByTestId("chat-scene-frame");
      expect(frames).toHaveLength(2);
      act(() => {
        for (const frame of frames) {
          postSceneMessage(frame, "ready");
          postSceneMessage(frame, "settled");
        }
      });
      await waitFor(() => expect(bridge.storeStill).toHaveBeenCalledTimes(2));
      const keys = bridge.storeStill.mock.calls.map((call) => (call[0] as { scopeKey: string }).scopeKey);
      expect(new Set(keys).size).toBe(2);
      for (const key of keys) expect(key.startsWith("row-7:")).toBe(true);
    });

    /**
     * A chat on another machine has no `ade-artifact://` handler, so resolving
     * a stored still to one drew a permanently broken tile. Remote chats read
     * the bytes back through the machine that holds them.
     */
    it("reads a stored still back through the runtime for a remote chat", async () => {
      const bridge = stubSceneCaptureBridge({
        artifacts: [{
          id: "a11",
          uri: ".ade/artifacts/computer-use/remote.png",
          title: "Generated view",
          metadata: { kind: "scene_still", sceneScopeKey: "row-remote" },
        }],
        readArtifactPreview: async () => "data:image/png;base64,REMOTE",
      });
      render(
        <ChatRuntimeScopeProvider
          pin={REMOTE_BINDING}
          binding={REMOTE_BINDING}
          laneId={null}
          sessionId="chat-remote"
        >
          <SceneFrame source={'<div id="n">3</div>'} live={false} scopeKey="row-remote" voiceCallId={null} />
        </ChatRuntimeScopeProvider>,
      );
      await waitFor(() => expect(screen.getByTestId("chat-scene-snapshot").getAttribute("src"))
        .toBe("data:image/png;base64,REMOTE"));
      expect(screen.queryByTestId("chat-scene-frame")).toBeNull();
      expect(bridge.readArtifactPreview.mock.calls[0]?.[0])
        .toMatchObject({ uri: ".ade/artifacts/computer-use/remote.png" });
    });
  });

  /**
   * What a SETTLED mount does while it does not yet know whether it has a
   * picture. Getting this wrong is visible either way: decide too early and a
   * generated view re-runs on every reopen, decide too late — or never — and
   * the user reads a blank box where a chart was.
   */
  describe("deciding whether to run or to show a picture", () => {
    beforeEach(() => {
      stubShellRect();
      stubSceneCaptureBridge();
    });

    /**
     * Reasoning and plan-approval bodies render markdown with no scope key at
     * all. The index is keyed BY that key, so there was never an answer coming
     * — and the latch waited for one forever, leaving a permanently blank box.
     */
    it("runs a settled scene immediately when there is no scope key to look up", async () => {
      render(<SceneFrame source={'<div id="n">3</div>'} live={false} scopeKey={null} voiceCallId={null} />);
      expect(await screen.findByTestId("chat-scene-frame")).toBeTruthy();
    });

    /**
     * A record is not a picture. A still whose bytes cannot be resolved on this
     * machine draws nothing, and latching on the record alone rehydrated to an
     * empty frame that never ran and never showed anything.
     */
    it("runs the scene when the stored still resolves to no picture at all", async () => {
      rememberSceneStill("row-unresolvable", {
        // Absolute paths never resolve through `ade-artifact://project/`.
        record: { uri: "/somewhere/else/old.png", artifactId: "a12", title: "Merged PRs" },
      });
      render(<SceneFrame source={'<div id="n">3</div>'} live={false} scopeKey="row-unresolvable" voiceCallId={null} />);
      expect(await screen.findByTestId("chat-scene-frame")).toBeTruthy();
      expect(screen.queryByTestId("chat-scene-snapshot")).toBeNull();
    });

    /**
     * The index read is an IPC round trip whose only bound is the 30 s call
     * budget on a remote chat, and every settled scene in the transcript sat on
     * a placeholder for all of it. Past the local deadline the mount runs the
     * scene; a picture that arrives afterwards still replaces the frozen frame.
     */
    /**
     * The other half of the same trade, and the one the deadline got wrong.
     *
     * On a remote chat every still needs its OWN cross-machine preview read, so
     * a transcript of settled scenes raced a single 1.5 s deadline against a
     * queue of round trips and lost: each row decided "no picture", re-ran the
     * agent's generated code, and re-filed its still — on every reopen. A
     * RECORD is proof the code already ran, so a mount that has one waits for
     * the bytes however long they take. The deadline bounds the index listing
     * and nothing else.
     */
    it("holds a placeholder for a slow picture rather than re-running the scene", async () => {
      vi.useFakeTimers();
      try {
        let deliver: ((value: string | null) => void) | null = null;
        const bridge = stubSceneCaptureBridge({
          artifacts: [{
            id: "a20",
            uri: ".ade/artifacts/computer-use/slow.png",
            title: "Generated view",
            metadata: { kind: "scene_still", sceneScopeKey: "row-slow-bytes" },
          }],
          readArtifactPreview: () => new Promise((resolve) => { deliver = resolve; }),
        });
        render(
          <ChatRuntimeScopeProvider
            pin={REMOTE_BINDING}
            binding={REMOTE_BINDING}
            laneId={null}
            sessionId="chat-slow-bytes"
          >
            <SceneFrame
              source={'<div id="n">3</div>'}
              live={false}
              scopeKey="row-slow-bytes"
              voiceCallId={null}
            />
          </ChatRuntimeScopeProvider>,
        );

        // Well past the index deadline, with the bytes still in flight: a
        // placeholder, and above all NO frame — the code must not run again.
        await act(async () => { await vi.advanceTimersByTimeAsync(SCENE_STILL_INDEX_WAIT_MS * 4); });
        expect(screen.queryByTestId("chat-scene-frame")).toBeNull();
        expect(screen.queryByTestId("chat-scene-snapshot")).toBeNull();
        expect(bridge.storeStill).not.toHaveBeenCalled();

        await act(async () => {
          deliver?.("data:image/png;base64,SLOW");
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(screen.getByTestId("chat-scene-snapshot").getAttribute("src"))
          .toBe("data:image/png;base64,SLOW");
        expect(screen.queryByTestId("chat-scene-frame")).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("stops waiting for a slow index and runs the scene", async () => {
      vi.useFakeTimers();
      try {
        stubSceneCaptureBridge({});
        // Never answers: the read is in flight for the whole test.
        (window as unknown as { ade: { computerUse: { listArtifacts: unknown } } })
          .ade.computerUse.listArtifacts = vi.fn(() => new Promise(() => {}));
        render(
          <ChatRuntimeScopeProvider
            pin={REMOTE_BINDING}
            binding={REMOTE_BINDING}
            laneId={null}
            sessionId="chat-slow"
          >
            <SceneFrame source={'<div id="n">3</div>'} live={false} scopeKey="row-slow" voiceCallId={null} />
          </ChatRuntimeScopeProvider>,
        );
        expect(screen.queryByTestId("chat-scene-frame")).toBeNull();

        await act(async () => { await vi.advanceTimersByTimeAsync(SCENE_STILL_INDEX_WAIT_MS + 50); });
        expect(screen.getByTestId("chat-scene-frame")).toBeTruthy();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("leaves other fences alone", () => {
    render(<MarkdownBlock markdown={"```ts\nconst a = 1;\n```"} />);
    expect(screen.queryByTestId("chat-scene")).toBeNull();
  });
});
