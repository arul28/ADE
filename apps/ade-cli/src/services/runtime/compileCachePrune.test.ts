import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { pruneStaleCompileCacheTags } from "./compileCachePrune";

const CURRENT = "v24.15.0-arm64-e27d4a24-501";
const OLD = "v24.14.0-arm64-9e3ad1fa-501";
const NEWER = "v24.13.0-arm64-bbbbbbbb-501";
const OLDER = "v22.13.1-arm64-aaaaaaaa-501";
const HOUR = 60 * 60 * 1000;

describe("pruneStaleCompileCacheTags", () => {
  // Data safety: only a stale cache tag is deleted, never the active build, a recent one, or a non-tag directory.
  it("removes a stale build and nothing else", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-compile-cache-prune-"));
    try {
      const makeTag = (name: string, ageMs = 0) => {
        fs.mkdirSync(path.join(root, name));
        const blob = path.join(root, name, "blob.bin");
        fs.writeFileSync(blob, "compiled");
        const when = new Date(Date.now() - ageMs);
        fs.utimesSync(blob, when, when);
        fs.utimesSync(path.join(root, name), when, when);
      };
      makeTag(CURRENT);
      makeTag(NEWER, HOUR);
      makeTag(OLDER, 2 * HOUR);
      makeTag(OLD, 40 * 24 * HOUR);
      makeTag("notes", 40 * 24 * HOUR);

      expect(await pruneStaleCompileCacheTags(path.join(root, CURRENT))).toEqual([OLD]);
      expect(fs.readdirSync(root).sort()).toEqual([CURRENT, NEWER, OLDER, "notes"].sort());
      expect(fs.existsSync(path.join(root, CURRENT, "blob.bin"))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
