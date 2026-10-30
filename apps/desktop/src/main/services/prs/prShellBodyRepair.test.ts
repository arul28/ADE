import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LaneSummary } from "../../../shared/types";
import { createShellPrBodyRepair, type ShellPrBodyRepairArgs, type ShellPrBodyRepairDeps } from "./prShellBodyRepair";

/**
 * The repair is driven through its factory with GitHub, `gh` and the proof
 * broker faked at their process boundaries; the proof files are real.
 */

const FOOTER = "\n\n<sub>Open in ADE</sub>";
const repo = { owner: "acme", name: "app" };
const lane = { id: "lane-1", branchRef: "refs/heads/feature" } as unknown as LaneSummary;

function pullWith(body: string, number = 12) {
  return { state: "open", body, html_url: `https://github.com/acme/app/pull/${number}` };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("createShellPrBodyRepair", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-pr-body-repair-"));
    fs.mkdirSync(path.join(projectRoot, ".ade", "artifacts"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  function build(overrides: Partial<ShellPrBodyRepairDeps>) {
    const deps: ShellPrBodyRepairDeps = {
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never,
      projectRoot,
      resolveChatLane: async () => ({ sessionId: "chat-1", lane, repo, sameRepo: () => true }),
      pullMismatch: () => null,
      lanePrNumber: () => 12,
      fetchPull: async () => pullWith(""),
      stampBody: (text) => (text.endsWith(FOOTER) ? text : `${text}${FOOTER}`),
      patchBody: vi.fn(async () => {}),
      runGh: vi.fn(async () => ({ exitCode: 0, stdout: "gh version 2.99.1 (2026-10-01)\n", stderr: "" })),
      ...overrides,
    };
    return { deps, repair: createShellPrBodyRepair(deps) };
  }

  const request = (overrides: Partial<ShellPrBodyRepairArgs> = {}): ShellPrBodyRepairArgs => ({
    sessionId: "chat-1",
    repoOwner: null,
    repoName: null,
    prNumber: 12,
    listOwnedProof: () => [],
    linkProofToPr: () => {},
    ...overrides,
  });

  it("uploads only the proof the chat owns, puts the footer back, and leaves the rest of the text as written", async () => {
    fs.writeFileSync(path.join(projectRoot, ".ade", "artifacts", "own.png"), "png bytes");
    const body = [
      "Intro line.",
      "![Login works](ade-proof://own-1)",
      "Another chat's: ![Other](ade-proof://other-1)",
      "A link [docs](https://example.com) and ![logo](https://example.com/logo.png).",
    ].join("\n");
    let edited: { body: string; attached: string[] } | null = null;
    const runGh = vi.fn(async (args: string[], opts: { cwd: string }) => {
      if (args[0] === "--version") return { exitCode: 0, stdout: "gh version 2.99.1\n", stderr: "" };
      edited = {
        body: fs.readFileSync(path.join(opts.cwd, args[args.indexOf("--body-file") + 1]!), "utf8"),
        attached: args.flatMap((arg, index) => (args[index - 1] === "--attach" ? [arg] : [])),
      };
      for (const file of edited.attached) expect(fs.existsSync(path.join(opts.cwd, file))).toBe(true);
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const asked: Array<{ ids: string[]; owners: Array<{ kind: string; id: string }> }> = [];
    const linked: Array<{ artifactIds: string[]; prUrl: string }> = [];
    const { deps, repair } = build({ fetchPull: async () => pullWith(body), runGh });

    const result = await repair.repair(request({
      listOwnedProof: (query) => {
        asked.push(query);
        // The broker answers only with proof this chat or lane owns.
        return [{ id: "own-1", kind: "screenshot", title: "Login", description: "Login works", uri: ".ade/artifacts/own.png", mimeType: "image/png" }];
      },
      linkProofToPr: (link) => { linked.push(link); },
    }));

    expect(result).toEqual({
      status: "repaired",
      footer: true,
      uploaded: ["own-1"],
      skipped: [{ id: "other-1", reason: "not in this chat's or lane's proof" }],
    });
    expect(asked[0]?.ids.sort()).toEqual(["other-1", "own-1"]);
    expect(asked[0]?.owners).toEqual([{ kind: "chat_session", id: "chat-1" }, { kind: "lane", id: "lane-1" }]);
    expect(edited).not.toBeNull();
    expect(edited!.attached).toEqual(["./proof-1.png"]);
    expect(edited!.body).toContain("](./proof-1.png)<!-- ade-proof:own-1 -->");
    expect(edited!.body).not.toContain("ade-proof://own-1");
    expect(edited!.body).toContain("![Other](ade-proof://other-1)");
    expect(edited!.body).toContain("Intro line.\n");
    expect(edited!.body).toContain("A link [docs](https://example.com) and ![logo](https://example.com/logo.png).");
    expect(edited!.body.endsWith(FOOTER)).toBe(true);
    expect(linked).toEqual([{ artifactIds: ["own-1"], prUrl: "https://github.com/acme/app/pull/12" }]);
    expect(deps.patchBody).not.toHaveBeenCalled();
  });

  it("writes nothing when the agent changed the text again before the repair could write", async () => {
    const reads = ["Text the agent wrote.", "A newer edit."];
    const { deps, repair } = build({ fetchPull: async () => pullWith(reads.shift() ?? "A newer edit.") });

    const result = await repair.repair(request());

    expect(result).toEqual({ status: "skipped", reason: "superseded" });
    expect(deps.patchBody).not.toHaveBeenCalled();
    expect(reads).toEqual([]);
  });

  it("runs one repair per PR at a time and folds the commands that land meanwhile into one more pass", async () => {
    const gate = deferred<void>();
    const started = deferred<void>();
    const reads: number[] = [];
    const { repair } = build({
      // Already stamped, so each pass is one read and no write.
      fetchPull: async (_repo, prNumber) => {
        reads.push(prNumber);
        if (reads.length === 1) {
          started.resolve();
          await gate.promise;
        }
        return pullWith(`Done.${FOOTER}`, prNumber);
      },
    });

    const first = repair.repair(request());
    await started.promise;
    expect(reads).toEqual([12]);
    const second = repair.repair(request());
    const third = repair.repair(request());
    // Another PR is not held up behind this one.
    await expect(repair.repair(request({ prNumber: 13 }))).resolves.toEqual({ status: "unchanged" });
    expect(reads).toEqual([12, 13]);

    gate.resolve();
    await expect(first).resolves.toEqual({ status: "unchanged" });
    await expect(second).resolves.toEqual({ status: "unchanged" });
    await expect(third).resolves.toEqual({ status: "unchanged" });
    expect(reads).toEqual([12, 13, 12]);

    await repair.repair(request());
    expect(reads).toEqual([12, 13, 12, 12]);
  });
});
