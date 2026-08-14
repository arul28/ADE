import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  consumeFirstOpenStabilityMarker,
  markFirstOpenStability,
} from "./projectLocalDatabase";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("first-open stability marker", () => {
  it("is consumed once after scaffold marks it", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-first-open-"));
    tempDirs.push(projectRoot);

    expect(consumeFirstOpenStabilityMarker(projectRoot)).toBe(false);
    markFirstOpenStability(projectRoot);
    expect(
      fs.existsSync(path.join(projectRoot, ".ade", "cache", "first-open-stability")),
    ).toBe(true);
    expect(consumeFirstOpenStabilityMarker(projectRoot)).toBe(true);
    expect(consumeFirstOpenStabilityMarker(projectRoot)).toBe(false);
  });
});
