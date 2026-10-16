/* @vitest-environment jsdom */

import React from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatRuntimeScopeProvider } from "./ChatRuntimeScope";
import { MarkdownBlock } from "./chatMarkdownBlock";
import { SceneFrame } from "./SceneFrame";
import { SCENE_STILL_INDEX_WAIT_MS } from "./useSceneStillLatch";
import { rememberSceneStill, resetSceneStillsForTest } from "./sceneStillStore";
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
    render(<SceneFrame source={'<div id="n">3</div>'} live scopeKey={null} />);
    const frame = await screen.findByTestId("chat-scene-frame");
    const sandbox = frame.getAttribute("sandbox") ?? "";
    expect(sandbox).toContain("allow-scripts");
    expect(sandbox).not.toContain("allow-same-origin");
    expect(frame.getAttribute("referrerPolicy") ?? frame.getAttribute("referrerpolicy")).toBe("no-referrer");
  });

  /**
   * What the view is — a scene a model drew — is said in the hover toolbar,
   * beside the buttons that expand it and file it as proof. There is no
   * always-visible status caption any more; the toolbar carries the title.
   */
  it("shows the scene's title in the hover toolbar", async () => {
    render(<SceneFrame source={'<!-- @scene title="Merged pull requests" -->\n<p>x</p>'} live scopeKey={null} />);
    await screen.findByTestId("chat-scene-frame");
    expect(screen.getByTestId("chat-scene").textContent).toContain("Merged pull requests");
    expect(screen.getByTestId("chat-scene-toolbar").textContent).toContain("Merged pull requests");
  });

  it("falls back to a readable code block when the scene cannot be parsed", () => {
    render(<SceneFrame source={"   "} live scopeKey={null} />);
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
      render(<SceneFrame source={'<div id="n">3</div>'} live scopeKey={null} />);
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

    /** A minimized or hidden window answers with no picture; nothing else would wake the capture. */
    it("tries again after the host returns no picture", async () => {
      stubShellRect({});
      const snapshot = vi.fn(async (): Promise<string | null> => SCENE_STILL_DATA_URL)
        .mockResolvedValueOnce(null);
      const { storeStill, settle } = await renderSettlingScene({ snapshot });

      settle();
      await waitFor(() => expect(snapshot).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(storeStill).toHaveBeenCalledTimes(1));
      expect(storeStill.mock.calls[0]?.[0]).toMatchObject({ dataUrl: SCENE_STILL_DATA_URL });
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
      render(<SceneFrame source={'<div id="n">3</div>'} live scopeKey={null} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      const frame = screen.getByTestId("chat-scene-frame");
      act(() => { postSceneMessage(frame, "ready"); });
      // An older prepared document, or a script that threw before the watcher
      // was armed: the host runs the same deadline independently.
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
      const snapshot = (window as unknown as { ade: { scene: { snapshot: ReturnType<typeof vi.fn> } } })
        .ade.scene.snapshot;
      expect(snapshot).toHaveBeenCalledTimes(1);
    });

    /**
     * A reopened chat: the still stands in for the scene while the restored
     * frame comes up beneath it. The reader sees the picture, the code runs
     * without replaying its entrance, and the frame stays hidden until it has
     * painted so no blank frame flashes where the picture was.
     */
    it("shows a stored still over the restored frame on a later mount", async () => {
      rememberSceneStill("row-9", {
        record: { uri: ".ade/artifacts/computer-use/old.png", artifactId: "a9", title: "Merged PRs" },
      });
      render(<SceneFrame source={'<div id="n">3</div>'} live={false} scopeKey="row-9" />);

      await waitFor(() => expect(screen.getByTestId("chat-scene-snapshot")).toBeTruthy());
      expect(screen.getByTestId("chat-scene-snapshot").getAttribute("src"))
        .toBe("ade-artifact://project/.ade/artifacts/computer-use/old.png");
      // The frame is mounted under the still, not revealed until it paints.
      const frame = screen.getByTestId("chat-scene-frame") as HTMLIFrameElement;
      expect(frame.style.opacity).toBe("0");
      expect(screen.getByTestId("chat-scene-snapshot")).toBeTruthy();
    });

    /** A scene that IS live on this mount plays out; the still never pre-empts it. */
    it("still runs the code when the turn that drew it is live", async () => {
      rememberSceneStill("row-10", {
        record: { uri: ".ade/artifacts/computer-use/old.png", artifactId: "a10", title: "Merged PRs" },
      });
      render(<SceneFrame source={'<div id="n">3</div>'} live scopeKey="row-10" />);
      expect(await screen.findByTestId("chat-scene-frame")).toBeTruthy();
    });

    /**
     * Proof prefers a fresh grab of what is on screen now, but a scene the
     * reader has scrolled partly out can no longer be grabbed. The settle still
     * already taken stands in, so the Proof button never files nothing at all.
     */
    it("files the settle still as proof when the live view cannot be grabbed", async () => {
      stubShellRect({});
      const bridge = stubSceneCaptureBridge({ snapshot: async () => "data:image/png;base64,STILL" });
      const attachProof = vi.fn(async (_args: { dataUrl?: string | null }) => true);
      (window as unknown as { ade: { scene: Record<string, unknown> } }).ade.scene.attachProof = attachProof;
      render(<SceneFrame source={'<div id="n">3</div>'} live scopeKey="row-proof" />);
      const frame = await screen.findByTestId("chat-scene-frame");
      act(() => {
        for (const type of ["ready", "settled"]) postSceneMessage(frame, type);
      });
      await waitFor(() => expect(bridge.snapshot).toHaveBeenCalledTimes(1));
      // The settle still is taken and stored before the reader files it.
      await waitFor(() => expect(bridge.storeStill).toHaveBeenCalledTimes(1));

      // Scrolled half out of view: a fresh grab is refused.
      stubShellRect({ top: -120, y: -120, bottom: 80 });
      act(() => { screen.getByTestId("chat-scene-proof").click(); });
      await waitFor(() => expect(attachProof).toHaveBeenCalledTimes(1));
      expect(attachProof.mock.calls[0]?.[0]).toMatchObject({ dataUrl: "data:image/png;base64,STILL" });
    });

    /**
     * The still's identity in main's index. Without it main cannot tell one
     * scene's picture from another's, so it cannot supersede a redraw.
     */
    it("stores the still under the scene's own key", async () => {
      stubShellRect({});
      const { storeStill, settle } = await renderSettlingScene({
        scopeKey: "row-4:zz",
      });
      settle();
      await waitFor(() => expect(storeStill).toHaveBeenCalledTimes(1));
      expect(storeStill.mock.calls[0]?.[0]).toMatchObject({
        scopeKey: "row-4:zz",
      });
    });

    /**
     * One mounted frame, many documents.
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

      // The same frame, a new view — a caller that reuses one frame.
      rerender(<SceneFrame {...props} source={"<p>second view</p>"} scopeKey="view-2" />);
      const frame = await screen.findByTestId("chat-scene-frame");
      await waitFor(() => expect(frame.getAttribute("src")).toBe("blob:scene-2"));
      act(() => { postSceneMessage(frame, "settled"); });

      await waitFor(() => expect(storeStill).toHaveBeenCalledTimes(2));
      expect(storeStill.mock.calls.map((call) => (call[0] as { scopeKey: string }).scopeKey))
        .toEqual(["view-1", "view-2"]);
    });

    /**
     * A settle belongs to the document that sent it.
     *
     * An iframe's `contentWindow` is the SAME object across a `src` change, so
     * the source check cannot tell the outgoing document from the incoming one.
     * The old document keeps running until the new one loads, and a `settled`
     * it posted in that window was stamped onto the new view — marking a
     * barely-painted document settled and burning its one-still latch. The
     * per-document nonce is what makes the two distinguishable.
     */
    it("ignores a settle sent by the document the frame just replaced", async () => {
      stubShellRect({});
      const { storeStill, rerender, props } = await renderSettlingScene({
        scopeKey: "stale-1",
      });
      const staleNonce = screen.getByTestId("chat-scene-frame").getAttribute("data-scene-nonce");
      expect(staleNonce).toBeTruthy();

      // The same frame, a new view — a caller that reuses one frame.
      rerender(<SceneFrame {...props} source={"<p>second view</p>"} scopeKey="stale-2" />);
      const frame = await screen.findByTestId("chat-scene-frame");
      await waitFor(() => expect(frame.getAttribute("src")).toBe("blob:scene-2"));
      expect(frame.getAttribute("data-scene-nonce")).not.toBe(staleNonce);

      // The outgoing document, still alive, reporting on its own view.
      act(() => { postSceneMessage(frame, "settled", 200, staleNonce); });
      await act(async () => { await Promise.resolve(); });
      expect(storeStill).not.toHaveBeenCalled();

      // The document actually in the frame says the same thing, and is heard.
      act(() => { postSceneMessage(frame, "settled"); });
      await waitFor(() => expect(storeStill).toHaveBeenCalledTimes(1));
      expect((storeStill.mock.calls[0]?.[0] as { scopeKey: string }).scopeKey).toBe("stale-2");
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
          <SceneFrame source={'<div id="n">3</div>'} live={false} scopeKey="row-remote" />
        </ChatRuntimeScopeProvider>,
      );
      await waitFor(() => expect(screen.getByTestId("chat-scene-snapshot").getAttribute("src"))
        .toBe("data:image/png;base64,REMOTE"));
      expect(bridge.readArtifactPreview.mock.calls[0]?.[0])
        .toMatchObject({ uri: ".ade/artifacts/computer-use/remote.png" });
      // The frame comes up restored beneath the cross-machine picture, hidden
      // until it has painted.
      const frame = screen.getByTestId("chat-scene-frame") as HTMLIFrameElement;
      expect(frame.style.opacity).toBe("0");
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
      render(<SceneFrame source={'<div id="n">3</div>'} live={false} scopeKey={null} />);
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
      render(<SceneFrame source={'<div id="n">3</div>'} live={false} scopeKey="row-unresolvable" />);
      expect(await screen.findByTestId("chat-scene-frame")).toBeTruthy();
      expect(screen.queryByTestId("chat-scene-snapshot")).toBeNull();
    });

    /**
     * A FAILED preview read is an answer, not a slow one.
     *
     * The latch waits on a record's bytes however long they take, which is
     * right while they are in flight — but when the read rejects (an
     * unreachable machine, a deleted file, a host with no preview route) no
     * bytes are ever coming. The mount stayed latched on a picture that did
     * not exist: a permanently blank row that never ran the scene and never
     * retried. It now falls back to the local behaviour and runs the code.
     */
    it("runs the scene when the stored still's preview read fails", async () => {
      stubSceneCaptureBridge({
        artifacts: [{
          id: "a21",
          uri: ".ade/artifacts/computer-use/gone.png",
          title: "Generated view",
          metadata: { kind: "scene_still", sceneScopeKey: "row-failed-preview" },
        }],
        readArtifactPreview: async () => { throw new Error("runtime unreachable"); },
      });
      render(
        <ChatRuntimeScopeProvider
          pin={REMOTE_BINDING}
          binding={REMOTE_BINDING}
          laneId={null}
          sessionId="chat-failed-preview"
        >
          <SceneFrame
            source={'<div id="n">3</div>'}
            live={false}
            scopeKey="row-failed-preview"
          />
        </ChatRuntimeScopeProvider>,
      );
      expect(await screen.findByTestId("chat-scene-frame")).toBeTruthy();
      expect(screen.queryByTestId("chat-scene-snapshot")).toBeNull();
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
            <SceneFrame source={'<div id="n">3</div>'} live={false} scopeKey="row-slow" />
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

  /**
   * A scene that throws before it is up collapses to one inline banner instead
   * of holding a tall empty box. A POLICY block is not that: a remote font or
   * image the scene asked for was refused, which is reported, not fatal.
   */
  describe("when a scene fails to draw", () => {
    afterEach(() => {
      vi.restoreAllMocks();
      delete (window as unknown as { ade?: unknown }).ade;
    });

    function throwError(frame: Element, payload: Record<string, unknown>): void {
      window.dispatchEvent(new MessageEvent("message", {
        source: (frame as HTMLIFrameElement).contentWindow,
        data: {
          __adeScene: 1,
          type: "error",
          nonce: frame.getAttribute("data-scene-nonce") ?? undefined,
          payload,
        },
      }));
    }

    it("reports a policy block without collapsing the scene", async () => {
      stubShellRect({});
      stubSceneCaptureBridge();
      render(<SceneFrame source={'<div id="n">3</div>'} live scopeKey="policy-1" />);
      const frame = await screen.findByTestId("chat-scene-frame");

      act(() => { throwError(frame, { message: "Blocked by the scene policy (font-src): https://x/f.woff2", policy: true }); });
      await waitFor(() =>
        expect(screen.getByTestId("chat-scene-toolbar").textContent).toContain("Blocked by the scene policy"),
      );
      expect(screen.getByTestId("chat-scene-frame")).toBeTruthy();
      expect(screen.getByTestId("chat-scene").getAttribute("data-scene-status")).not.toBe("failed");
    });

    it("collapses to a banner on a throw, and Show anyway brings the scene back", async () => {
      stubShellRect({});
      stubSceneCaptureBridge();
      render(<SceneFrame source={'<div id="n">3</div>'} live scopeKey="fail-1" />);
      const frame = await screen.findByTestId("chat-scene-frame");

      act(() => { throwError(frame, { message: "boom" }); });
      await waitFor(() => expect(screen.getByTestId("chat-scene").getAttribute("data-scene-status")).toBe("failed"));
      expect(screen.queryByTestId("chat-scene-frame")).toBeNull();
      expect(screen.getByText(/did not draw/)).toBeTruthy();

      act(() => { screen.getByText("Show anyway").click(); });
      await waitFor(() => expect(screen.getByTestId("chat-scene-frame")).toBeTruthy());
    });

    it("Retry hands the scene a fresh document, not the cached one that failed", async () => {
      stubShellRect({});
      stubSceneCaptureBridge();
      render(<SceneFrame source={'<div id="n">3</div>'} live scopeKey="fail-2" />);
      const first = await screen.findByTestId("chat-scene-frame");
      const firstSrc = first.getAttribute("src");

      act(() => { throwError(first, { message: "boom" }); });
      await waitFor(() => expect(screen.getByTestId("chat-scene").getAttribute("data-scene-status")).toBe("failed"));

      act(() => { screen.getByText("Retry").click(); });
      const next = await screen.findByTestId("chat-scene-frame");
      await waitFor(() => expect(next.getAttribute("src")).not.toBe(firstSrc));
    });
  });

  /**
   * Links are the one way agent-authored scene code reaches outside the frame.
   * The host allows a link only from a focused scene, only at a human click
   * cadence, and — once a scene shows live ADE data — only to destinations the
   * scene was actually written with.
   */
  describe("opening links from a scene", () => {
    // A data scene with one whole URL written into it.
    const DATA_SCENE = '<!-- @scene data="prs" -->\n<p><a href="https://github.com/arul28/ADE">repo</a></p>';
    const WRITTEN_URL = "https://github.com/arul28/ADE";

    afterEach(() => {
      vi.restoreAllMocks();
      delete (window as unknown as { ade?: unknown }).ade;
    });

    function installAde(openExternal: (url: string) => Promise<void>): void {
      // A data scene mounts `SceneDataFeed`, which subscribes to the PR list.
      (window as unknown as { ade?: unknown }).ade = {
        app: { openExternal },
        prs: { onEvent: vi.fn(() => () => {}), listAll: vi.fn(async () => []) },
      };
    }

    function sendOpen(frame: Element, url: string): void {
      window.dispatchEvent(new MessageEvent("message", {
        source: (frame as HTMLIFrameElement).contentWindow,
        data: {
          __adeScene: 1,
          type: "open",
          nonce: frame.getAttribute("data-scene-nonce") ?? undefined,
          payload: { url },
        },
      }));
    }

    async function focusedFrame(source: string): Promise<Element> {
      render(<SceneFrame source={source} live scopeKey={null} />);
      const frame = await screen.findByTestId("chat-scene-frame");
      (frame as HTMLElement).focus();
      expect(document.activeElement, "the scene frame must be focused for a link to open").toBe(frame);
      return frame;
    }

    it("opens an http link from a focused scene in ADE's browser", async () => {
      const openExternal = vi.fn(async () => {});
      installAde(openExternal);
      const frame = await focusedFrame(DATA_SCENE);

      sendOpen(frame, WRITTEN_URL);
      await waitFor(() => expect(openExternal).toHaveBeenCalledWith(WRITTEN_URL));
    });

    /**
     * A scene in a chat pinned to another machine must open its web links on
     * that machine, or a `localhost` link reaches this computer's port instead.
     * The pin rides the built-in-browser navigation.
     */
    it("opens a web link on the chat's machine", async () => {
      const navigate = vi.fn(async (_args: unknown, _pin: unknown) => ({}));
      (window as unknown as { ade?: unknown }).ade = {
        builtInBrowser: { navigate },
        prs: { onEvent: vi.fn(() => () => {}), listAll: vi.fn(async () => []) },
      };
      render(
        <ChatRuntimeScopeProvider
          pin={REMOTE_BINDING}
          binding={REMOTE_BINDING}
          laneId={null}
          sessionId="chat-pin"
        >
          <SceneFrame source={DATA_SCENE} live scopeKey={null} />
        </ChatRuntimeScopeProvider>,
      );
      const frame = await screen.findByTestId("chat-scene-frame");
      (frame as HTMLElement).focus();

      sendOpen(frame, WRITTEN_URL);
      await waitFor(() => expect(navigate).toHaveBeenCalled());
      expect(navigate.mock.calls[0]?.[1]).toEqual(REMOTE_BINDING);
    });

    it("ignores a link from a scene that does not have focus", async () => {
      const openExternal = vi.fn(async () => {});
      installAde(openExternal);
      render(<SceneFrame source={DATA_SCENE} live scopeKey={null} />);
      const frame = await screen.findByTestId("chat-scene-frame");
      (document.activeElement as HTMLElement | null)?.blur?.();

      sendOpen(frame, WRITTEN_URL);
      await act(async () => { await Promise.resolve(); });
      expect(openExternal).not.toHaveBeenCalled();
    });

    it("refuses a second open inside the click-rate limit", async () => {
      const openExternal = vi.fn(async () => {});
      installAde(openExternal);
      const frame = await focusedFrame(DATA_SCENE);

      sendOpen(frame, WRITTEN_URL);
      sendOpen(frame, WRITTEN_URL);
      await waitFor(() => expect(openExternal).toHaveBeenCalledTimes(1));
    });

    it("refuses a scheme that is neither ade: nor http(s), and says why", async () => {
      const openExternal = vi.fn(async () => {});
      installAde(openExternal);
      const frame = await focusedFrame(DATA_SCENE);

      sendOpen(frame, "javascript:alert(1)");
      await waitFor(() =>
        expect(screen.getByTestId("chat-scene-toolbar").textContent).toContain("ADE links"),
      );
      expect(openExternal).not.toHaveBeenCalled();
    });

    it("lets a data scene open only the web links written in it", async () => {
      const openExternal = vi.fn(async () => {});
      installAde(openExternal);
      const frame = await focusedFrame(DATA_SCENE);
      const now = vi.spyOn(Date, "now");
      now.mockReturnValue(1_000_000);

      // Assembled at run time around the live data: refused, and said so.
      sendOpen(frame, "https://evil.example/leak");
      await waitFor(() =>
        expect(screen.getByTestId("chat-scene-toolbar").textContent).toContain("only open the web links"),
      );
      expect(openExternal).not.toHaveBeenCalled();

      // A whole URL the scene was written with: allowed.
      now.mockReturnValue(1_000_000 + 1_000);
      sendOpen(frame, WRITTEN_URL);
      await waitFor(() => expect(openExternal).toHaveBeenCalledWith(WRITTEN_URL));
    });
  });

  it("leaves other fences alone", () => {
    render(<MarkdownBlock markdown={"```ts\nconst a = 1;\n```"} />);
    expect(screen.queryByTestId("chat-scene")).toBeNull();
  });
});
