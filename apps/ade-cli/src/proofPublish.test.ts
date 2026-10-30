import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertGhSupportsAttach,
  publishProofIntoPullRequestBody,
  publishProofToPullRequest,
} from "./proofPublish";
import { resolveStoredProofFile, type PublishableArtifact } from "../../desktop/src/main/services/prs/prBodyProofStaging";

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

describe("publishProofIntoPullRequestBody", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  const PR_URL = "https://github.com/owner/repo/pull/12";

  /** A project with the named proof files, and a gh that holds `body` as the PR text. */
  function setup(body: string, files: string[]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-proof-publish-"));
    dirs.push(root);
    fs.mkdirSync(path.join(root, ".ade", "artifacts"), { recursive: true });
    for (const file of files) fs.writeFileSync(path.join(root, ".ade", "artifacts", file), file);
    const sent = { body: null as string | null, attached: [] as string[], staged: [] as string[] };
    const run = vi.fn((_cmd: string, args: readonly string[], options?: { cwd?: string }) => {
      if (args[0] === "--version") return { status: 0, stdout: "gh version 2.101.0 (2024-01-01)" };
      if (args[0] === "pr" && args[1] === "view") return { status: 0, stdout: JSON.stringify({ url: PR_URL, body }) };
      if (args[0] === "pr" && args[1] === "edit") {
        sent.body = fs.readFileSync(path.join(options!.cwd!, "body.md"), "utf8");
        sent.attached = args.filter((_arg, index) => args[index - 1] === "--attach");
        sent.staged = fs.readdirSync(options!.cwd!).filter((name) => name !== "body.md").sort();
        return { status: 0, stdout: PR_URL };
      }
      return { status: 1, stderr: "unexpected gh call" };
    }) as unknown as Run;
    return { root, run, sent };
  }

  const picture = (id: string, file: string) => artifact({ id, uri: `.ade/artifacts/${file}`, description: `Caption of ${id}` });

  it("uploads the proof the PR text cites and rewrites each citation where it stands", () => {
    const body = [
      "## Evidence",
      "![The new list](ade-proof://pic-a)",
      "",
      "```proof-compare",
      "before: pic-b Old",
      "after: pic-c New",
      "```",
      "",
      "<!-- ade:link -->footer ADE added<!-- /ade:link -->",
    ].join("\n");
    const { root, run, sent } = setup(body, ["a.png", "b.png", "c.png", "unused.png"]);

    const result = publishProofIntoPullRequestBody({
      pr: "12",
      projectRoot: root,
      run,
      // A record the text does not cite is not uploaded.
      artifacts: [picture("pic-a", "a.png"), picture("pic-b", "b.png"), picture("pic-c", "c.png"), picture("pic-z", "unused.png")],
    });

    expect(result.prUrl).toBe(PR_URL);
    expect(result.posted.map((entry) => entry.id)).toEqual(["pic-a", "pic-b", "pic-c"]);
    expect(sent.attached).toEqual(["./proof-1.png", "./proof-2.png", "./proof-3.png"]);
    expect(sent.staged).toEqual(["proof-1.png", "proof-2.png", "proof-3.png"]);
    // The text GitHub held is what goes back, with only the citations changed.
    expect(sent.body).toContain("![The new list](./proof-1.png)<!-- ade-proof:pic-a -->");
    expect(sent.body).toContain("| Before | After |");
    expect(sent.body).toContain("<!-- ade:link -->footer ADE added<!-- /ade:link -->");
    expect(sent.body).not.toContain("ade-proof://");
  });

  it("does not attach one side of a comparison whose other side cannot go up, and says which items stayed behind", () => {
    const body = "![Alone](ade-proof://pic-a)\n\n```proof-compare\nbefore: pic-b Old\nafter: gone New\n```\n\n![Not mine](ade-proof://other-chat)";
    const { root, run, sent } = setup(body, ["a.png", "b.png"]);

    const result = publishProofIntoPullRequestBody({
      pr: "12",
      projectRoot: root,
      run,
      artifacts: [picture("pic-a", "a.png"), picture("pic-b", "b.png"), picture("gone", "missing.png")],
    });

    expect(result.posted.map((entry) => entry.id)).toEqual(["pic-a"]);
    expect(sent.attached).toEqual(["./proof-1.png"]);
    expect(Object.fromEntries(result.skipped.map((entry) => [entry.id, entry.reason]))).toEqual({
      "gone": expect.stringContaining("not on this machine"),
      "pic-b": "the other side of its comparison could not be uploaded",
      "other-chat": "not in this chat's or lane's proof",
    });
    // The pair is still the citation the author wrote, so ADE can show it.
    expect(sent.body).toContain("```proof-compare\nbefore: pic-b Old\nafter: gone New\n```");
    expect(result.warnings).toEqual([]);

    // The same item cited alone too: it goes up for that citation, and the
    // author is told that the comparison stayed behind.
    const twice = setup(`![Old alone](ade-proof://pic-b)\n\n\`\`\`proof-compare\nbefore: pic-b Old\nafter: gone New\n\`\`\``, ["b.png"]);
    const second = publishProofIntoPullRequestBody({
      pr: "12",
      projectRoot: twice.root,
      run: twice.run,
      artifacts: [picture("pic-b", "b.png"), picture("gone", "missing.png")],
    });
    expect(second.posted.map((entry) => entry.id)).toEqual(["pic-b"]);
    expect(twice.sent.attached).toEqual(["./proof-1.png"]);
    expect(second.warnings).toEqual([expect.stringContaining("pic-b is uploaded, but it also stays as a citation")]);
  });

  it("changes nothing on GitHub when no cited proof can go up", () => {
    const { root, run, sent } = setup("![Lost](ade-proof://gone)", []);
    expect(() => publishProofIntoPullRequestBody({ pr: "12", projectRoot: root, run, artifacts: [picture("gone", "missing.png")] }))
      .toThrow(/nothing to upload: gone \(its stored file is not on this machine/);
    expect(sent.body).toBeNull();
  });
});
