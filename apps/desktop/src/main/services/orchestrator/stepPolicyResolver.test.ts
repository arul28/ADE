import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readDocPaths } from "./stepPolicyResolver";

const tempRoots: string[] = [];

function makeTempProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-step-policy-"));
  tempRoots.push(root);
  return root;
}

function writeFile(root: string, relPath: string, content = "doc\n") {
  const filePath = path.join(root, relPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("readDocPaths", () => {
  it("ignores ADE internals and nested lane docs while keeping project docs", () => {
    const root = makeTempProject();
    writeFile(root, "README.md");
    writeFile(root, "docs/overview.md");
    writeFile(root, ".ade/worktrees/old-lane/README.md");
    writeFile(root, ".ade/worktrees/old-lane/docs/ARCHITECTURE.md");
    writeFile(root, ".ade/artifacts/context.md");

    const relPaths = readDocPaths(root).map((filePath) => path.relative(root, filePath).replace(/\\/g, "/"));

    expect(relPaths).toContain("README.md");
    expect(relPaths).toContain("docs/overview.md");
    expect(relPaths.some((relPath) => relPath.startsWith(".ade/"))).toBe(false);
  });
});
