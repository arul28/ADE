import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertGhSupportsAttach,
  publishProofToPullRequest,
  resolveStoredProofFile,
  type PublishableArtifact,
} from "./proofPublish";

type Run = typeof spawnSync;
type RunResult = { status: number; stdout?: string; stderr?: string };

function ghVersion(version: string) {
  return (_cmd: string, args: readonly string[]): RunResult | null => (
    args[0] === "--version"
      ? { status: 0, stdout: `gh version ${version} (2024-01-01)\nhttps://github.com/cli/cli/releases` }
      : null
  );
}

function artifact(overrides: Partial<PublishableArtifact> = {}): PublishableArtifact {
  return {
    id: "artifact-1",
    kind: "screenshot",
    title: "Login works",
    description: null,
    uri: ".ade/artifacts/pic.png",
    mimeType: "image/png",
    ...overrides,
  };
}

describe("assertGhSupportsAttach", () => {
  it("refuses a missing gh and a version older than --attach", () => {
    const missing = vi.fn(() => ({ status: null, error: Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }) }));
    expect(() => assertGhSupportsAttach(missing as unknown as Run)).toThrow(/not installed/);

    const old = vi.fn(ghVersion("2.98.0")) as unknown as Run;
    expect(() => assertGhSupportsAttach(old)).toThrow(/2\.98\.0 cannot attach files/);

    const unknown = vi.fn(() => ({ status: 0, stdout: "something else" }));
    expect(() => assertGhSupportsAttach(unknown as unknown as Run)).toThrow(/cannot attach files/);

    expect(() => assertGhSupportsAttach(vi.fn(ghVersion("2.99.0")) as unknown as Run)).not.toThrow();
  });
});

describe("resolveStoredProofFile", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function project() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-proof-publish-"));
    dirs.push(root);
    fs.mkdirSync(path.join(root, ".ade", "artifacts"), { recursive: true });
    return root;
  }

  it("returns a real file inside the artifact store", () => {
    const root = project();
    fs.writeFileSync(path.join(root, ".ade", "artifacts", "pic.png"), "png");
    expect(resolveStoredProofFile(root, ".ade/artifacts/pic.png"))
      .toBe(fs.realpathSync(path.join(root, ".ade", "artifacts", "pic.png")));
  });

  it("refuses a symlink inside the store that points outside it", () => {
    const root = project();
    const outside = path.join(root, "secret.png");
    fs.writeFileSync(outside, "secret");
    fs.symlinkSync(outside, path.join(root, ".ade", "artifacts", "link.png"));

    expect(resolveStoredProofFile(root, ".ade/artifacts/link.png")).toBeNull();
  });

  it("refuses a path outside the store, an http url, and a missing file", () => {
    const root = project();
    fs.writeFileSync(path.join(root, "outside.png"), "png");
    expect(resolveStoredProofFile(root, "outside.png")).toBeNull();
    expect(resolveStoredProofFile(root, "https://example.com/pic.png")).toBeNull();
    expect(resolveStoredProofFile(root, ".ade/artifacts/missing.png")).toBeNull();
  });
});

describe("publishProofToPullRequest", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function project() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-proof-publish-"));
    dirs.push(root);
    fs.mkdirSync(path.join(root, ".ade", "artifacts"), { recursive: true });
    return root;
  }

  const PR_URL = "https://github.com/owner/repo/pull/12";

  function gh(calls: string[][]) {
    return vi.fn((_cmd: string, args: readonly string[]) => {
      calls.push([...args]);
      if (args[0] === "--version") return { status: 0, stdout: "gh version 2.101.0 (2024-01-01)" };
      if (args[0] === "pr" && args[1] === "view") return { status: 0, stdout: `${PR_URL}\n` };
      if (args[0] === "pr" && args[1] === "comment") return { status: 0, stdout: `${PR_URL}#issuecomment-99\n` };
      return { status: 1, stderr: "unexpected gh call" };
    }) as unknown as Run;
  }

  it("posts the chosen proof as one comment with each file attached under its caption", () => {
    const root = project();
    fs.writeFileSync(path.join(root, ".ade", "artifacts", "pic.png"), "picture");
    fs.writeFileSync(path.join(root, ".ade", "artifacts", "clip.mp4"), "video");

    const calls: string[][] = [];
    let body = "";
    const run = vi.fn((cmd: string, args: readonly string[], options?: { cwd?: string }) => {
      calls.push([...args]);
      if (args[0] === "--version") return { status: 0, stdout: "gh version 2.101.0 (2024-01-01)" };
      if (args[0] === "pr" && args[1] === "view") return { status: 0, stdout: `${PR_URL}\n` };
      if (args[0] === "pr" && args[1] === "comment") {
        body = fs.readFileSync(path.join(options!.cwd!, "body.md"), "utf8");
        return { status: 0, stdout: `${PR_URL}#issuecomment-99\n` };
      }
      return { status: 1, stderr: "unexpected" };
    }) as unknown as Run;

    const result = publishProofToPullRequest({
      pr: "12",
      projectRoot: root,
      run,
      artifacts: [
        artifact({ description: "Login works now" }),
        artifact({ id: "artifact-2", kind: "video_recording", mimeType: "video/mp4", title: "Checkout flow", uri: ".ade/artifacts/clip.mp4" }),
      ],
    });

    expect(result.commentUrl).toBe(`${PR_URL}#issuecomment-99`);
    expect(result.posted.map((entry) => entry.caption)).toEqual(["Login works now", "Checkout flow"]);
    expect(body).toContain("![Login works now](./proof-1.png)");
    expect(body).toContain("![Checkout flow](./proof-2.mp4)");
    expect(calls.find((args) => args[1] === "comment")).toEqual(
      expect.arrayContaining(["pr", "comment", PR_URL, "--attach", "./proof-1.png", "--attach", "./proof-2.mp4"]),
    );
  });

  it("skips an unsupported kind and a picture over the limit, and throws when nothing is left", () => {
    const root = project();
    fs.writeFileSync(path.join(root, ".ade", "artifacts", "big.png"), Buffer.alloc(10 * 1024 * 1024 + 1));
    const run = gh([]);

    expect(() => publishProofToPullRequest({
      pr: "12",
      projectRoot: root,
      run,
      artifacts: [
        artifact({ id: "trace", kind: "browser_trace", uri: ".ade/artifacts/trace.har" }),
        artifact({ id: "big", title: "Big", uri: ".ade/artifacts/big.png" }),
      ],
    })).toThrow(/nothing to post/);
  });

  it("surfaces a gh failure to find the pull request", () => {
    const root = project();
    fs.writeFileSync(path.join(root, ".ade", "artifacts", "pic.png"), "picture");
    const run = vi.fn((_cmd: string, args: readonly string[]) => {
      if (args[0] === "--version") return { status: 0, stdout: "gh version 2.101.0 (2024-01-01)" };
      return { status: 1, stderr: "no pull requests found" };
    }) as unknown as Run;

    expect(() => publishProofToPullRequest({
      pr: "999",
      projectRoot: root,
      run,
      artifacts: [artifact()],
    })).toThrow(/no pull requests found/);
  });
});
