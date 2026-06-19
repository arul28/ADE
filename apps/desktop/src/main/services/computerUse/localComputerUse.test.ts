import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createComputerUseArtifactPath } from "./localComputerUse";

describe("createComputerUseArtifactPath", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-local-computer-use-"));
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it("returns unique paths for same-kind captures within a tight loop", () => {
    const paths = new Set<string>();
    for (let i = 0; i < 500; i++) {
      paths.add(createComputerUseArtifactPath(projectRoot, "untitled", "png"));
    }
    expect(paths.size).toBe(500);
  });
});
