import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CliDeeplinkUsageError,
  openUrlViaOs,
  runDeeplinkCommand,
  runDeeplinkCommandAsync,
  runLinearInstall,
  runLinkCommand,
  runOpenCommand,
} from "./deeplinks";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(() => ({ status: 0, signal: null, error: undefined })),
}));

const UUID = "550e8400-e29b-41d4-a716-446655440000";

describe("openUrlViaOs", () => {
  it.runIf(process.platform === "win32")(
    "passes Windows URLs containing shell metacharacters as one opaque argv value",
    () => {
      const url = 'https://accounts.google.com/o/oauth2/auth?client=a b&percent=%PATH%&quote="yes"&meta=^|<>()!';

      expect(openUrlViaOs(url)).toEqual({ failed: false, message: "" });
      expect(spawnSync).toHaveBeenCalledWith(
        "rundll32.exe",
        ["url.dll,FileProtocolHandler", url],
        {
          shell: false,
          stdio: "ignore",
          timeout: 10_000,
          windowsHide: true,
        },
      );
    },
  );
});

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

  it("emits the hosted web client form when --web is set", () => {
    const r = runLinkCommand(["lane", UUID, "--web", "--no-clipboard"]);
    expect(r.output).toContain(`https://app.ade-app.dev/open?type=lane&id=${UUID}`);
  });

  it("rejects mutually exclusive link forms", () => {
    expect(() => runLinkCommand(["lane", UUID, "--web", "--ade", "--no-clipboard"])).toThrow(
      CliDeeplinkUsageError,
    );
  });

  it("carries a lane drawer in both forms", () => {
    const https = runLinkCommand(["lane", UUID, "--drawer", "stack", "--no-clipboard"]);
    expect(https.output).toContain(`https://ade-app.dev/open?type=lane&id=${UUID}&drawer=stack`);
    const ade = runLinkCommand(["lane", UUID, "--drawer", "stack", "--ade", "--no-clipboard"]);
    expect(ade.output).toContain(`ade://lane/${UUID}?drawer=stack`);
  });

  // The parser drops an unknown drawer and still opens the lane; minting one
  // would hand back a link quietly missing what was asked for.
  it("refuses a drawer name the shared parser does not know", () => {
    expect(() => runLinkCommand(["lane", UUID, "--drawer", "graph", "--no-clipboard"]))
      .toThrow(CliDeeplinkUsageError);
  });

  it("emits a welcome link in both forms", () => {
    const https = runLinkCommand(["welcome", "--no-clipboard"]);
    expect(https.output).toContain("https://ade-app.dev/open?type=welcome");
    const ade = runLinkCommand(["welcome", "--ade", "--no-clipboard"]);
    expect(ade.output).toContain("ade://welcome");
    const web = runLinkCommand(["welcome", "--web", "--no-clipboard"]);
    expect(web.output).toContain("https://app.ade-app.dev/open?type=welcome");
  });

  it("round-trips a welcome link and a lane drawer link", () => {
    expect(runLinkCommand(["ade://welcome", "--no-clipboard"]).output)
      .toContain("https://ade-app.dev/open?type=welcome");
    expect(runLinkCommand([`ade://lane/${UUID}?drawer=stack`, "--ade", "--no-clipboard"]).output)
      .toContain(`ade://lane/${UUID}?drawer=stack`);
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

  it("round-trips an existing URL to the hosted web client form", () => {
    const r = runLinkCommand([`ade://lane/${UUID}`, "--web", "--no-clipboard"]);
    expect(r.output).toContain(`https://app.ade-app.dev/open?type=lane&id=${UUID}`);
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

  it("emits a provider-neutral issue link in both forms", () => {
    const https = runLinkCommand(["issue", "jira", "PROJ-9", "--no-clipboard"]);
    expect(https.output).toContain("https://ade-app.dev/open?type=issue");
    expect(https.output).toContain("provider=jira");
    expect(https.output).toContain("issue=PROJ-9");
    const ade = runLinkCommand(["issue", "jira", "PROJ-9", "--ade", "--no-clipboard"]);
    expect(ade.output).toContain("ade://issue/jira/PROJ-9");
  });

  it("carries the branch and plugin hints on an issue link", () => {
    const r = runLinkCommand([
      "issue",
      "jira",
      "PROJ-9",
      "--branch",
      "arul/proj-9",
      "--plugin",
      "ade-jira",
      "--ade",
      "--no-clipboard",
    ]);
    expect(r.output).toContain("ade://issue/jira/PROJ-9?branch=arul%2Fproj-9&plugin=ade-jira");
  });

  it("accepts the issue flags in place of the positionals", () => {
    const r = runLinkCommand([
      "issue",
      "--issue-provider",
      "jira",
      "--issue-key",
      "PROJ-9",
      "--ade",
      "--no-clipboard",
    ]);
    expect(r.output).toContain("ade://issue/jira/PROJ-9");
  });

  // The `--ctx` rule: minting refuses loudly rather than handing back a link
  // quietly missing what was asked for.
  it("refuses an issue provider, key or plugin id the shared parser would reject", () => {
    expect(() => runLinkCommand(["issue", "ji ra", "PROJ-9", "--no-clipboard"]))
      .toThrow(CliDeeplinkUsageError);
    expect(() => runLinkCommand(["issue", "jira", "PROJ 9", "--no-clipboard"]))
      .toThrow(CliDeeplinkUsageError);
    expect(() => runLinkCommand(["issue", "jira", "K".repeat(129), "--no-clipboard"]))
      .toThrow(CliDeeplinkUsageError);
    expect(() => runLinkCommand(["issue", "jira", "PROJ-9", "--plugin", "Ade Jira", "--no-clipboard"]))
      .toThrow(CliDeeplinkUsageError);
    expect(() => runLinkCommand(["issue", "--no-clipboard"])).toThrow(CliDeeplinkUsageError);
  });

  // `linear-issue` is a permanent alias, not a deprecated one: the CLI keeps
  // minting Linear links in the spelling every older ADE understands.
  it("keeps minting linear-issue for Linear even though the issue kind exists", () => {
    expect(runLinkCommand(["linear-issue", "ADE-123", "--ade", "--no-clipboard"]).output)
      .toContain("ade://linear-issue/ADE-123");
    expect(runLinkCommand(["issue", "linear", "ADE-123", "--ade", "--no-clipboard"]).output)
      .toContain("ade://issue/linear/ADE-123");
  });

  it("emits a plugin panel link in both forms", () => {
    const https = runLinkCommand(["plugin", "ade-graph", "overview", "--no-clipboard"]);
    expect(https.output).toContain("type=plugin");
    expect(https.output).toContain("plugin=ade-graph");
    expect(https.output).toContain("panel=overview");
    const ade = runLinkCommand(["plugin", "ade-graph", "overview", "--ade", "--no-clipboard"]);
    expect(ade.output).toContain("ade://plugin/ade-graph/overview");
  });

  it("carries --ctx through as the panel's context", () => {
    const r = runLinkCommand([
      "plugin",
      "ade-graph",
      "overview",
      "--ctx",
      '{"issue":"ISS-14"}',
      "--ade",
      "--no-clipboard",
    ]);
    expect(r.output).toContain("ctx=%7B%22issue%22%3A%22ISS-14%22%7D");
  });

  it("refuses a --ctx that is not a JSON object", () => {
    expect(() => runLinkCommand(["plugin", "ade-graph", "overview", "--ctx", "nope"]))
      .toThrow(CliDeeplinkUsageError);
    expect(() => runLinkCommand(["plugin", "ade-graph", "overview", "--ctx", "[1,2]"]))
      .toThrow(CliDeeplinkUsageError);
  });

  it("refuses a --ctx over the 2 KiB ceiling instead of dropping it silently", () => {
    const oversized = JSON.stringify({ blob: "x".repeat(3000) });
    expect(() => runLinkCommand(["plugin", "ade-graph", "overview", "--ctx", oversized]))
      .toThrow(CliDeeplinkUsageError);
  });

  // The web client has no route for a plugin panel, so a --web link would round
  // -trip cleanly and then open the welcome screen for whoever was sent it.
  it("refuses --web for a plugin panel rather than minting a link to nowhere", () => {
    expect(() => runLinkCommand(["plugin", "ade-graph", "overview", "--web", "--no-clipboard"]))
      .toThrow(CliDeeplinkUsageError);
  });

  it("refuses plugin or panel ids the shared parser would reject", () => {
    expect(() => runLinkCommand(["plugin", "Ade Graph", "overview", "--no-clipboard"]))
      .toThrow(CliDeeplinkUsageError);
    expect(() => runLinkCommand(["plugin", "ade-graph", "--no-clipboard"]))
      .toThrow(CliDeeplinkUsageError);
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

  it("documents the lane drawer and welcome forms in link help", () => {
    const r = runDeeplinkCommand(["link", "--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("--drawer stack");
    expect(r.output).toContain("ade link welcome");
  });
});

describe("ade open --help", () => {
  it("returns help including --linear-issue form", () => {
    const r = runOpenCommand(["--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("--linear-issue");
    expect(r.output).toContain("--branch");
    expect(r.output).toContain("--issue-provider");
    expect(r.output).toContain("--issue-key");
  });

  it("opens the Linear coding-tool hand-off in the alias spelling, unchanged", () => {
    const r = runOpenCommand(["--linear-issue", "ADE-123", "--branch", "arul/ade-123"]);
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("type=linear-issue");
    expect(r.output).toContain("issue=ADE-123");
  });

  it("opens a provider-neutral issue hand-off", () => {
    const r = runOpenCommand([
      "--issue-provider",
      "jira",
      "--issue-key",
      "PROJ-9",
      "--branch",
      "arul/proj-9",
      "--plugin",
      "ade-jira",
    ]);
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("type=issue");
    expect(r.output).toContain("provider=jira");
    expect(r.output).toContain("issue=PROJ-9");
    expect(r.output).toContain("plugin=ade-jira");
  });

  it("refuses half an issue hand-off rather than opening the wrong thing", () => {
    expect(() => runOpenCommand(["--issue-provider", "jira"])).toThrow(CliDeeplinkUsageError);
    expect(() => runOpenCommand(["--issue-key", "PROJ-9"])).toThrow(CliDeeplinkUsageError);
    expect(() => runOpenCommand(["--issue-provider", "ji ra", "--issue-key", "PROJ-9"]))
      .toThrow(CliDeeplinkUsageError);
  });

  it("rejects invalid URL", () => {
    expect(() => runOpenCommand(["not a url"])).toThrow(CliDeeplinkUsageError);
  });

  it("rejects unknown ade-host URLs (non-https)", () => {
    expect(() => runOpenCommand(["ade://surprise/anything"])).toThrow(CliDeeplinkUsageError);
  });
});
