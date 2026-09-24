import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSessionHomeResolver, type SessionHomeLane } from "./sessionHome";

let root: string;

function lane(id: string, name: string, worktreePath: string, laneType: SessionHomeLane["laneType"] = "worktree"): SessionHomeLane {
  return { id, name, branchRef: `refs/heads/${id}`, color: null, laneType, worktreePath };
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "session-home-")));
  for (const dir of [".ade/worktrees/apple-dca9f144/apps/desktop", ".ade/worktrees/gone-1234", "apps/web"]) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("createSessionHomeResolver", () => {
  it("names the lane by its lane name even when the folder has an old name", () => {
    const resolve = createSessionHomeResolver([
      lane("primary", "main", root, "primary"),
      lane("dca9f144", "Apple Sim Preview and Live Stream", path.join(root, ".ade/worktrees/apple-dca9f144")),
    ]);
    expect(resolve(path.join(root, ".ade/worktrees/apple-dca9f144"))).toMatchObject({
      kind: "lane",
      laneId: "dca9f144",
      laneName: "Apple Sim Preview and Live Stream",
      atLaneRoot: true,
    });
    expect(resolve(path.join(root, ".ade/worktrees/apple-dca9f144/apps/desktop"))).toMatchObject({
      kind: "lane",
      laneId: "dca9f144",
      atLaneRoot: false,
    });
  });

  it("gives the primary lane its own folders but not other lanes' folders", () => {
    const resolve = createSessionHomeResolver([lane("primary", "main", root, "primary")]);
    expect(resolve(path.join(root, "apps/web"))).toMatchObject({ kind: "lane", laneId: "primary", atLaneRoot: false });
    expect(resolve(path.join(root, ".ade/worktrees/gone-1234"))).toMatchObject({ kind: "removed-lane", laneId: null });
  });

  it("marks folders outside every lane", () => {
    const resolve = createSessionHomeResolver([lane("primary", "main", root, "primary")]);
    expect(resolve(os.tmpdir())).toMatchObject({ kind: "outside", laneId: null });
    expect(resolve(null)).toBeNull();
  });
});
