import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CliDeeplinkUsageError,
  runDeeplinkCommand,
  runDeeplinkCommandAsync,
  runLinearInstall,
  runLinkCommand,
  runOpenCommand,
} from "./deeplinks";

const UUID = "550e8400-e29b-41d4-a716-446655440000";

describe("ade link", () => {
  it("emits an https lane link by default", () => {
    const r = runLinkCommand(["lane", UUID, "--no-clipboard"]);
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain(`https://ade-app.dev/open?type=lane&id=${UUID}`);
  });

  it("emits the ade:// form when --ade is set", () => {
    const r = runLinkCommand(["lane", UUID, "--ade", "--no-clipboard"]);
    expect(r.output).toContain(`ade://lane/${UUID}`);
  });

  it("emits a session link with an optional lane hint", () => {
    const r = runLinkCommand(["session", "session-123", "--lane", UUID, "--no-clipboard"]);
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("https://ade-app.dev/open?type=session");
    expect(r.output).toContain("id=session-123");
    expect(r.output).toContain(`lane=${UUID}`);
  });

  it("emits file, commit, and artifact links", () => {
    const file = runLinkCommand(["file", "src/index.ts", "--line", "12", "--lane", UUID, "--ade", "--no-clipboard"]);
    expect(file.output).toContain(`ade://file/src/index.ts?line=12&lane=${UUID}`);

    const commit = runLinkCommand(["commit", "abc1234", "--lane", UUID, "--ade", "--no-clipboard"]);
    expect(commit.output).toContain(`ade://commit/abc1234?lane=${UUID}`);

    const artifact = runLinkCommand(["artifact", "proof-123", "--ade", "--no-clipboard"]);
    expect(artifact.output).toContain("ade://artifact/proof-123");
  });

  it("adds envelopes through the async link command", async () => {
    const r = await runDeeplinkCommandAsync(["link", "commit", "abc1234", "--lane", UUID, "--ade", "--no-clipboard"], {
      resolveEnvelope: async () => ({
        repoOwner: "owner",
        repoName: "repo",
        branch: "feat",
        prNumber: 42,
      }),
    });
    expect(r.output).toContain("ade://commit/abc1234?");
    expect(r.output).toContain("repo=owner%2Frepo");
    expect(r.output).toContain("branch=feat");
    expect(r.output).toContain("pr=42");
  });

  it("skips async envelope lookup when --no-envelope is set", async () => {
    const resolveEnvelope = vi.fn(async () => ({ repoOwner: "owner", repoName: "repo" }));
    const r = await runDeeplinkCommandAsync(
      ["link", "lane", UUID, "--ade", "--no-envelope", "--no-clipboard"],
      { resolveEnvelope },
    );
    expect(resolveEnvelope).not.toHaveBeenCalled();
    expect(r.output).toContain(`ade://lane/${UUID}`);
    expect(r.output).not.toContain("repo=");
  });

  it("refuses to mint links the shared parser rejects", () => {
    // Traversal file paths, absolute paths, and malformed shas must be
    // rejected up front — the ade:// path form URL-normalizes dot segments,
    // so `--ade` would otherwise silently mint a link to a DIFFERENT
    // in-repo path instead of failing.
    for (const form of [[], ["--ade"]]) {
      expect(() => runLinkCommand(["file", "../secret", ...form, "--no-clipboard"])).toThrow(/repo-relative|invalid link/);
      expect(() => runLinkCommand(["file", "/etc/passwd", ...form, "--no-clipboard"])).toThrow(/repo-relative|invalid link/);
      expect(() => runLinkCommand(["file", "src/../../x", ...form, "--no-clipboard"])).toThrow(/repo-relative|invalid link/);
    }
    expect(() => runLinkCommand(["commit", "not-a-sha", "--no-clipboard"])).toThrow(/invalid link|sha/);
  });

  it("emits a branch link", () => {
    const r = runLinkCommand(["branch", "a/b", "feat", "--no-clipboard"]);
    expect(r.output).toContain("https://ade-app.dev/open?type=branch");
    expect(r.output).toContain("repo=a%2Fb");
    expect(r.output).toContain("branch=feat");
  });

  it("emits a branch link with --pr", () => {
    const r = runLinkCommand(["branch", "a/b", "feat", "--pr", "42", "--no-clipboard"]);
    expect(r.output).toContain("pr=42");
  });

  it("emits a pr link", () => {
    const r = runLinkCommand(["pr", "a/b", "1234", "--no-clipboard"]);
    expect(r.output).toContain("https://ade-app.dev/open?type=pr");
    expect(r.output).toContain("number=1234");
  });

  it("rejects malformed repo", () => {
    expect(() => runLinkCommand(["branch", "no-slash", "feat", "--no-clipboard"])).toThrow(
      CliDeeplinkUsageError,
    );
  });

  it("rejects bad --pr value", () => {
    expect(() => runLinkCommand(["branch", "a/b", "f", "--pr", "abc", "--no-clipboard"])).toThrow(
      CliDeeplinkUsageError,
    );
  });

  it("round-trips an existing URL", () => {
    const r = runLinkCommand([`ade://lane/${UUID}`, "--no-clipboard"]);
    expect(r.output).toContain(`https://ade-app.dev/open?type=lane&id=${UUID}`);
  });

  it("emits a linear-issue link", () => {
    const r = runLinkCommand(["linear-issue", "ADE-123", "--no-clipboard"]);
    expect(r.output).toContain("https://ade-app.dev/open?type=linear-issue");
    expect(r.output).toContain("issue=ADE-123");
  });

  it("emits a linear-issue link with branch hint", () => {
    const r = runLinkCommand([
      "linear-issue",
      "ADE-123",
      "--branch",
      "arul/ade-123-feat",
      "--no-clipboard",
    ]);
    expect(r.output).toContain("issue=ADE-123");
    expect(r.output).toContain("branch=arul%2Fade-123-feat");
  });

  it("emits ade:// form for linear-issue when --ade is set", () => {
    const r = runLinkCommand(["linear-issue", "ADE-123", "--ade", "--no-clipboard"]);
    expect(r.output).toContain("ade://linear-issue/ADE-123");
  });

  it("rejects empty linear-issue identifier", () => {
    expect(() => runLinkCommand(["linear-issue", "--no-clipboard"])).toThrow(
      CliDeeplinkUsageError,
    );
  });
});

describe("ade linear install", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ade-linear-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("writes coding-tools.json when none exists", () => {
    const r = runLinearInstall([], { home: tmpHome, argv0: "/usr/local/bin/ade" });
    expect(r.exitCode).toBe(0);
    const cfg = JSON.parse(
      fs.readFileSync(path.join(tmpHome, ".linear", "coding-tools.json"), "utf8"),
    );
    expect(cfg).toHaveProperty("openIssue");
    expect(cfg.openIssue).toHaveProperty("path", "/usr/local/bin/ade");
    expect(cfg.openIssue.args[0]).toBe("open");
    // Linear placeholders used in args must be ones Linear actually substitutes.
    // {{issue.identifier}} and {{issue.branchName}} are documented; we must
    // NOT reference made-up placeholders like {{issue.workspaceKey}} (which
    // Linear ignores and would render literally).
    const argString = cfg.openIssue.args.join(" ");
    expect(argString).toContain("{{issue.identifier}}");
    expect(argString).toContain("{{issue.branchName}}");
    expect(argString).not.toMatch(/\{\{issue\.workspaceKey\}\}/);
  });

  it("backs up an existing config", () => {
    fs.mkdirSync(path.join(tmpHome, ".linear"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, ".linear", "coding-tools.json"),
      JSON.stringify({ otherTool: { path: "/x" } }, null, 2),
    );
    const r = runLinearInstall([], { home: tmpHome, argv0: "/usr/local/bin/ade" });
    expect(r.exitCode).toBe(0);
    const entries = fs.readdirSync(path.join(tmpHome, ".linear"));
    expect(entries).toEqual(expect.arrayContaining([
      expect.stringMatching(/^coding-tools\.json\.bak-/),
    ]));
    const cfg = JSON.parse(
      fs.readFileSync(path.join(tmpHome, ".linear", "coding-tools.json"), "utf8"),
    );
    expect(cfg).toHaveProperty("openIssue");
    expect(cfg).toHaveProperty("otherTool");
  });

  it("dry-run prints without writing", () => {
    const r = runLinearInstall(["--dry-run"], { home: tmpHome, argv0: "/usr/local/bin/ade" });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("Would write");
    expect(fs.existsSync(path.join(tmpHome, ".linear", "coding-tools.json"))).toBe(false);
  });
});

describe("runDeeplinkCommand", () => {
  it("returns help when no args", () => {
    const r = runDeeplinkCommand([]);
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("ade open");
    expect(r.output).toContain("ade link");
    expect(r.output).toContain("ade linear");
  });

  it("rejects unknown verbs", () => {
    expect(() => runDeeplinkCommand(["frobnicate"])).toThrow(CliDeeplinkUsageError);
  });
});

describe("ade open --help", () => {
  it("returns help including --linear-issue form", () => {
    const r = runOpenCommand(["--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("--linear-issue");
    expect(r.output).toContain("--branch");
  });

  it("rejects invalid URL", () => {
    expect(() => runOpenCommand(["not a url"])).toThrow(CliDeeplinkUsageError);
  });

  it("rejects unknown ade-host URLs (non-https)", () => {
    expect(() => runOpenCommand(["ade://surprise/anything"])).toThrow(CliDeeplinkUsageError);
  });
});
