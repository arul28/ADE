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

  it("refuses a path that escapes the worktree", async () => {
    const projectRoot = makeRoot();
    const worktree = path.join(projectRoot, "worktrees", "lane-1");
    fs.mkdirSync(worktree, { recursive: true });
    const store = createMacDesktopObservations({
      projectRoot,
      resolveLaneWorktreePath: () => worktree,
    });
    for (const out of ["../escape.png", "../../escape.png", path.join(os.homedir(), ".zshrc")]) {
      let code: string | null = null;
      try {
        await store.resolveOutPath({ laneId: "lane-1", out });
      } catch (error) {
        code = (error as { code?: string }).code ?? null;
      }
      expect(code).toBe("MAC_DESKTOP_OUT_PATH_OUTSIDE_ROOT");
    }
  });

  it("refuses a symlink that points out of the worktree", async () => {
    const projectRoot = makeRoot();
    const worktree = path.join(projectRoot, "worktrees", "lane-1");
    const outside = path.join(projectRoot, "outside");
    fs.mkdirSync(worktree, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
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
  });

  it("refuses an empty path", async () => {
    const store = createMacDesktopObservations({ projectRoot: makeRoot() });
    await expect(store.resolveOutPath({ laneId: "lane-1", out: "   " })).rejects.toMatchObject({
      code: "MAC_DESKTOP_OUT_PATH_OUTSIDE_ROOT",
    });
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
    });
    expect(ingested).toHaveLength(1);
    expect(ingested[0]).toMatchObject({
      backend: { name: "ade-mac-desktop", style: "manual", toolName: "desktop proof" },
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
