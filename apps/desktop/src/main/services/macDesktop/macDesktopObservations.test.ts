import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { MacDesktopObservation } from "../../../shared/types/macDesktop";
import {
  createMacDesktopObservations,
  MAC_DESKTOP_OBSERVATION_CACHE_DIR,
  MAC_DESKTOP_OBSERVATION_RETENTION,
} from "./macDesktopObservations";

function makeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mac-desktop-obs-"));
}

function observation(id: string, elementCount = 2): MacDesktopObservation {
  return {
    id,
    laneId: "lane-1",
    capturedAt: new Date(0).toISOString(),
    screenshotPath: "/tmp/does-not-exist.png",
    mapPath: null,
    display: { width: 2560, height: 1440, scale: 2 },
    windows: [],
    elements: Array.from({ length: elementCount }, (_, index) => ({
      index,
      handle: `${id}:e:${index}`,
      role: "AXButton",
      subrole: null,
      title: `Button ${index}`,
      label: null,
      value: null,
      identifier: null,
      help: null,
      enabled: true,
      focused: false,
      actions: ["AXPress"],
      frame: { x: 0, y: 0, width: 10, height: 10 },
      center: { x: 5, y: 5 },
      windowId: 1,
      pid: 10,
      parentIndex: null,
    })),
    elementCount,
    truncated: false,
    caption: null,
  };
}

describe("macDesktopObservations handles", () => {
  it("resolves a handle from a retained observation", () => {
    const store = createMacDesktopObservations({ projectRoot: makeRoot() });
    store.remember(observation("obs-abc"));
    const resolved = store.resolveHandle("lane-1", "obs-abc:e:1");
    expect(resolved.element.title).toBe("Button 1");
    expect(resolved.observation.id).toBe("obs-abc");
  });

  it("refuses a handle whose observation has aged out", () => {
    const store = createMacDesktopObservations({ projectRoot: makeRoot() });
    store.remember(observation("obs-old"));
    for (let index = 0; index < MAC_DESKTOP_OBSERVATION_RETENTION; index += 1) {
      store.remember(observation(`obs-${index}`));
    }
    expect(() => store.resolveHandle("lane-1", "obs-old:e:0")).toThrowError(/MAC_DESKTOP_HANDLE_EXPIRED|no longer holds/);
    try {
      store.resolveHandle("lane-1", "obs-old:e:0");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("MAC_DESKTOP_HANDLE_EXPIRED");
    }
  });

  it("refuses an element index that is not in its observation", () => {
    const store = createMacDesktopObservations({ projectRoot: makeRoot() });
    store.remember(observation("obs-abc", 2));
    try {
      store.resolveHandle("lane-1", "obs-abc:e:9");
      throw new Error("expected a refusal");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("MAC_DESKTOP_HANDLE_EXPIRED");
    }
  });

  it("refuses a string that is not a handle at all", () => {
    const store = createMacDesktopObservations({ projectRoot: makeRoot() });
    try {
      store.resolveHandle("lane-1", "the OK button");
      throw new Error("expected a refusal");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("MAC_DESKTOP_HANDLE_EXPIRED");
    }
  });
});

describe("macDesktopObservations out paths", () => {
  it("resolves a relative path inside the lane worktree", async () => {
    const projectRoot = makeRoot();
    const worktree = path.join(projectRoot, "worktrees", "lane-1");
    fs.mkdirSync(worktree, { recursive: true });
    const store = createMacDesktopObservations({
      projectRoot,
      resolveLaneWorktreePath: () => worktree,
    });
    const resolved = await store.resolveOutPath({ laneId: "lane-1", out: "shots/login.png" });
    expect(resolved).toBe(path.join(worktree, "shots", "login.png"));
    expect(fs.existsSync(path.dirname(resolved))).toBe(true);
  });

  it("resolves an absolute path under the OS temp directory", async () => {
    // The proof skill tells agents to write `$TMPDIR/…`; both the lane worktree
    // and the temp dir are agent-owned scratch space. Refusing one of the two
    // made a documented command impossible.
    const projectRoot = makeRoot();
    const worktree = path.join(projectRoot, "worktrees", "lane-1");
    fs.mkdirSync(worktree, { recursive: true });
    const store = createMacDesktopObservations({
      projectRoot,
      resolveLaneWorktreePath: () => worktree,
    });
    const out = path.join(os.tmpdir(), `ade-out-${Date.now()}`, "proof.png");
    const resolved = await store.resolveOutPath({ laneId: "lane-1", out });
    expect(resolved).toBe(path.resolve(out));
    expect(fs.existsSync(path.dirname(resolved))).toBe(true);
    try { fs.rmSync(path.dirname(resolved), { recursive: true, force: true }); } catch { /* best effort */ }

    // The same directory by its resolved spelling (`/var` → `/private/var` on
    // macOS) is the same root, not somewhere outside it.
    const realTemp = fs.realpathSync(os.tmpdir());
    const realOut = path.join(realTemp, `ade-out-real-${Date.now()}`, "proof.png");
    const realResolved = await store.resolveOutPath({ laneId: "lane-1", out: realOut });
    expect(realResolved).toBe(path.resolve(realOut));
    try { fs.rmSync(path.dirname(realResolved), { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it("still refuses a symlink out of the temp directory", async () => {
    const projectRoot = makeRoot();
    const worktree = path.join(projectRoot, "worktrees", "lane-1");
    fs.mkdirSync(worktree, { recursive: true });
    // The target has to be outside BOTH allowed roots. A fresh directory under
    // the home dir is outside the temp dir; one under the project root is not,
    // because the test's project root itself lives in the temp dir.
    const outside = fs.mkdtempSync(path.join(os.homedir(), "ade-outside-"));
    const link = path.join(os.tmpdir(), `ade-out-link-${Date.now()}`);
    fs.symlinkSync(outside, link, "dir");
    const store = createMacDesktopObservations({
      projectRoot,
      resolveLaneWorktreePath: () => worktree,
    });
    // The string is inside the temp root; the real directory is not.
    await expect(store.resolveOutPath({ laneId: "lane-1", out: path.join(link, "escape.png") }))
      .rejects.toMatchObject({ code: "MAC_DESKTOP_OUT_PATH_OUTSIDE_ROOT" });
    try { fs.unlinkSync(link); } catch { /* best effort */ }
    try { fs.rmSync(outside, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it("refuses a path that escapes the worktree", async () => {
    const projectRoot = makeRoot();
    const worktree = path.join(projectRoot, "worktrees", "lane-1");
    fs.mkdirSync(worktree, { recursive: true });
    const store = createMacDesktopObservations({
      projectRoot,
      resolveLaneWorktreePath: () => worktree,
    });
    // `../escape.png` lands in the temp dir (the test's project root lives
    // there), which is now an allowed root on purpose — see the two-root rule.
    // What must still be refused is anything outside both roots.
    for (const out of [
      path.join(os.homedir(), ".zshrc"),
      path.join(path.sep, "etc", "passwd"),
      path.join(worktree, "..", "..", "..", "..", "..", "..", "..", "..", "etc", "passwd"),
    ]) {
      let code: string | null = null;
      try {
        await store.resolveOutPath({ laneId: "lane-1", out });
      } catch (error) {
        code = (error as { code?: string }).code ?? null;
      }
      expect(code).toBe("MAC_DESKTOP_OUT_PATH_OUTSIDE_ROOT");
    }
    // Escaping the worktree but staying in the OS temp dir is the documented
    // exception, not a hole: both are agent-owned scratch space.
    await expect(store.resolveOutPath({ laneId: "lane-1", out: path.join("..", "escape.png") }))
      .resolves.toBe(path.join(projectRoot, "worktrees", "escape.png"));
  });

  it("refuses a symlink that points out of the worktree", async () => {
    const projectRoot = makeRoot();
    const worktree = path.join(projectRoot, "worktrees", "lane-1");
    // Outside BOTH allowed roots: a target under the project root is inside the
    // test's temp dir, which is now allowed on purpose.
    const outside = fs.mkdtempSync(path.join(os.homedir(), "ade-outside-"));
    fs.mkdirSync(worktree, { recursive: true });
    fs.symlinkSync(outside, path.join(worktree, "link"), "dir");
    const store = createMacDesktopObservations({
      projectRoot,
      resolveLaneWorktreePath: () => worktree,
    });
    let code: string | null = null;
    try {
      await store.resolveOutPath({ laneId: "lane-1", out: path.join("link", "escape.png") });
    } catch (error) {
      code = (error as { code?: string }).code ?? null;
    }
    expect(code).toBe("MAC_DESKTOP_OUT_PATH_OUTSIDE_ROOT");
    try { fs.rmSync(outside, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it("refuses a leaf that is itself a symlink", async () => {
    const projectRoot = makeRoot();
    const worktree = path.join(projectRoot, "worktrees", "lane-1");
    const outside = path.join(projectRoot, "outside");
    fs.mkdirSync(worktree, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "secret"), "x", "utf8");
    // Planted by anything that can write one file in the worktree. Every
    // directory on the way is inside the root, so only the leaf gives it away
    // — and the capture would otherwise be written straight through the link.
    fs.symlinkSync(path.join(outside, "secret"), path.join(worktree, "shot.png"));
    const store = createMacDesktopObservations({
      projectRoot,
      resolveLaneWorktreePath: () => worktree,
    });
    await expect(store.resolveOutPath({ laneId: "lane-1", out: "shot.png" })).rejects.toMatchObject({
      code: "MAC_DESKTOP_OUT_PATH_OUTSIDE_ROOT",
    });
  });

  it("refuses an empty path", async () => {
    const store = createMacDesktopObservations({ projectRoot: makeRoot() });
    await expect(store.resolveOutPath({ laneId: "lane-1", out: "   " })).rejects.toMatchObject({
      code: "MAC_DESKTOP_OUT_PATH_OUTSIDE_ROOT",
    });
  });
});

describe("macDesktopObservations turn clips", () => {
  it("finds and ends a lane's clip whichever chat opened it", () => {
    const store = createMacDesktopObservations({ projectRoot: makeRoot() });
    store.beginTurnRecording({
      laneId: "lane-1",
      chatSessionId: "chat-1",
      turnId: "turn-1",
      filePath: "/tmp/a.mp4",
    });
    // The helper has one recorder per lane, so "is a clip running here" is a
    // lane question, not a chat question.
    expect(store.findTurnRecordingForLane("lane-1")).toMatchObject({ turnId: "turn-1" });
    expect(store.findTurnRecordingForLane("lane-2")).toBeNull();
    expect(store.endTurnRecordingsForLane("lane-1").map((entry) => entry.turnId)).toEqual(["turn-1"]);
    expect(store.findTurnRecordingForLane("lane-1")).toBeNull();
  });
});

describe("macDesktopObservations frames", () => {
  it("writes frames into the one root the Work tools mirror serves from", () => {
    const projectRoot = makeRoot();
    const store = createMacDesktopObservations({ projectRoot });
    const framePath = store.observationPath("lane/1", "1700000000-abc", "png");
    expect(framePath.startsWith(path.join(projectRoot, MAC_DESKTOP_OBSERVATION_CACHE_DIR))).toBe(true);
    expect(fs.existsSync(path.dirname(framePath))).toBe(true);
  });

  it("writes the sidecar that binds a frame to its lane", () => {
    const projectRoot = makeRoot();
    const store = createMacDesktopObservations({ projectRoot });
    const framePath = store.observationPath("lane-1", "frame", "png");
    fs.writeFileSync(framePath, "not-really-a-png");
    const sidecarPath = store.writeObservationSidecar({
      imagePath: framePath,
      laneId: "lane-1",
      capturedAt: "2026-01-01T00:00:00.000Z",
      caption: "click · Sign in",
    });
    expect(sidecarPath).toBe(framePath.replace(/\.png$/, ".json"));
    const parsed = JSON.parse(fs.readFileSync(sidecarPath!, "utf8"));
    expect(parsed).toMatchObject({
      filePath: framePath,
      ownerLaneId: "lane-1",
      capturedAt: "2026-01-01T00:00:00.000Z",
      title: "click · Sign in",
    });
  });

  it("deletes an evicted observation's bytes", () => {
    const projectRoot = makeRoot();
    const store = createMacDesktopObservations({ projectRoot });
    const framePath = store.observationPath("lane-1", "frame-0", "png");
    fs.writeFileSync(framePath, "bytes");
    store.writeObservationSidecar({ imagePath: framePath, laneId: "lane-1", capturedAt: "x" });
    store.remember({ ...observation("obs-0"), screenshotPath: framePath });
    for (let index = 1; index <= MAC_DESKTOP_OBSERVATION_RETENTION; index += 1) {
      store.remember(observation(`obs-${index}`));
    }
    expect(fs.existsSync(framePath)).toBe(false);
    expect(fs.existsSync(framePath.replace(/\.png$/, ".json"))).toBe(false);
  });
});

describe("macDesktopObservations proof", () => {
  it("owns a record by lane, chat, and the lane's primary pull request", async () => {
    const ingested: unknown[] = [];
    const store = createMacDesktopObservations({
      projectRoot: makeRoot(),
      resolvePrimaryPrUrl: () => "https://github.com/acme/app/pull/12",
      ingestArtifacts: (request) => {
        ingested.push(request);
        return { artifacts: [], links: [] };
      },
    });
    await store.ingestProof({
      laneId: "lane-1",
      chatSessionId: "chat-1",
      toolName: "desktop proof",
      title: "Login screen",
      caption: "after sign-in",
      filePath: "/tmp/frame.png",
      kind: "screenshot",
      provenance: { source: "ade-capture" },
    });
    expect(ingested).toHaveLength(1);
    expect(ingested[0]).toMatchObject({
      backend: { name: "ade-mac-desktop", style: "manual", toolName: "desktop proof" },
      // Passed through as given: the broker decides the checks from it.
      provenance: { source: "ade-capture" },
      owners: [
        { kind: "lane", id: "lane-1", relation: "attached_to" },
        { kind: "chat_session", id: "chat-1", relation: "attached_to" },
        { kind: "github_pr", id: "https://github.com/acme/app/pull/12", relation: "published_to" },
      ],
    });
  });

  it("files nothing when no broker is wired", async () => {
    const store = createMacDesktopObservations({ projectRoot: makeRoot() });
    await expect(store.ingestProof({
      laneId: "lane-1",
      toolName: "desktop proof",
      title: "x",
      filePath: "/tmp/frame.png",
      kind: "screenshot",
      provenance: { source: "ade-capture" },
    })).resolves.toBeNull();
  });
});

describe("macDesktopObservations turn clips", () => {
  it("keeps at most one frame a second and caps the clip", () => {
    let clock = 1_000;
    const store = createMacDesktopObservations({ projectRoot: makeRoot(), now: () => clock });
    store.beginTurnRecording({ laneId: "lane-1", chatSessionId: "chat-1", turnId: "turn-1", filePath: "/tmp/x.mp4" });
    expect(store.noteTurnFrame("lane-1", "chat-1")).toBe(true);
    expect(store.noteTurnFrame("lane-1", "chat-1")).toBe(false);
    clock += 1_500;
    expect(store.noteTurnFrame("lane-1", "chat-1")).toBe(true);
    expect(store.getTurnRecording("lane-1", "chat-1")?.frameCount).toBe(2);
    const ended = store.endTurnRecording("lane-1", "chat-1");
    expect(ended?.turnId).toBe("turn-1");
    expect(store.getTurnRecording("lane-1", "chat-1")).toBeNull();
  });
});
