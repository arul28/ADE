// ---------------------------------------------------------------------------
// CLI subcommands for ADE deeplinks: `ade open`, `ade link`, `ade linear`.
//
// The three commands cover the inbound (open), outbound (link), and Linear-
// integration (linear install) surfaces described in the deeplinks plan.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  ADE_DEEPLINK_HTTPS_BASE_URL,
  ADE_DEEPLINK_HTTPS_PATH,
  buildDeeplink,
  isAdeDeeplinkHttpsHost,
  parseDeeplink,
  type DeeplinkEnvelope,
  type DeeplinkTarget,
} from "../../../desktop/src/shared/deeplinks";
import { copyToClipboard } from "../lib/clipboard";

export class CliDeeplinkUsageError extends Error {}

export type DeeplinkCliResult = {
  output: string;
  exitCode: number;
};

export type LinkEnvelopeContext = {
  targetKind: "lane" | "session" | "commit";
  laneId: string;
};

export type DeeplinkCommandOptions = {
  resolveEnvelope?: (
    context: LinkEnvelopeContext,
  ) => DeeplinkEnvelope | null | Promise<DeeplinkEnvelope | null>;
};

const HELP_OPEN = [
  "Usage:",
  "  ade open <url>",
  "  ade open --linear-issue <id> --branch <branch>",
  "",
  "  Opens an `ade://` or `https://ade-app.dev/open?...` URL via the OS, which",
  "  routes it back to the running ADE desktop app (or launches it cold).",
  "",
  "  The --linear-issue / --branch form is what Linear's 'Open in coding",
  "  tool' menu passes us (Linear doesn't surface the GitHub repo, so the",
  "  desktop renderer resolves it from the active project).",
].join("\n");

const HELP_LINK = [
  "Usage:",
  "  ade link lane <lane-uuid>",
  "  ade link session <session-id> [--lane <lane-uuid>]",
  "  ade link file <path> [--line <number>] [--lane <lane-uuid>]",
  "  ade link commit <sha> [--lane <lane-uuid>]",
  "  ade link artifact <id>",
  "  ade link branch <owner/repo> <branch> [--pr <number>]",
  "  ade link pr <owner/repo> <number>",
  "  ade link linear-issue <ADE-123> [--branch <branch>]",
  "  ade link <url>            # round-trip — parse + re-print canonical form",
  "",
  "Options:",
  "  --ade           Emit the custom `ade://` form (default: https)",
  "  --no-envelope   Skip best-effort repo/branch/PR envelope lookup",
  "  --no-clipboard  Print the URL but don't copy to clipboard",
].join("\n");

const HELP_LINEAR = [
  "Usage: ade linear install",
  "",
  "  Writes ~/.linear/coding-tools.json so Linear's 'Open issue in coding",
  "  tool' dropdown can launch ADE. Backs up any existing file alongside.",
].join("\n");

export function runDeeplinkCommand(rest: string[]): DeeplinkCliResult {
  if (rest.length === 0) {
    return { output: `${HELP_OPEN}\n${HELP_LINK}\n${HELP_LINEAR}\n`, exitCode: 0 };
  }
  const [verb, ...verbArgs] = rest;
  switch (verb) {
    case "open":
      return runOpenCommand(verbArgs);
    case "link":
      return runLinkCommand(verbArgs);
    case "linear":
      return runLinearCommand(verbArgs);
    default:
      throw new CliDeeplinkUsageError(
        `Unknown deeplink subcommand: ${verb}. Try 'ade open <url>', 'ade link ...', or 'ade linear install'.`,
      );
  }
}

export async function runDeeplinkCommandAsync(
  rest: string[],
  options: DeeplinkCommandOptions = {},
): Promise<DeeplinkCliResult> {
  if (rest.length === 0) {
    return { output: `${HELP_OPEN}\n${HELP_LINK}\n${HELP_LINEAR}\n`, exitCode: 0 };
  }
  const [verb, ...verbArgs] = rest;
  switch (verb) {
    case "open":
      return runOpenCommand(verbArgs);
    case "link":
      return runLinkCommandAsync(verbArgs, options);
    case "linear":
      return runLinearCommand(verbArgs);
    default:
      throw new CliDeeplinkUsageError(
        `Unknown deeplink subcommand: ${verb}. Try 'ade open <url>', 'ade link ...', or 'ade linear install'.`,
      );
  }
}

// ---------------------------------------------------------------------------
// ade open <url>
// ---------------------------------------------------------------------------

export function runOpenCommand(args: string[]): DeeplinkCliResult {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    return { output: `${HELP_OPEN}\n`, exitCode: 0 };
  }

  // Flag form: --linear-issue <id> --branch <branch> (Linear coding-tool entry)
  const flags = extractFlags(args, {
    booleans: [],
    valued: ["linear-issue", "branch"],
  });
  const linearIssue = flags.valued.get("linear-issue");
  const branch = flags.valued.get("branch");
  if (linearIssue || branch) {
    if (!linearIssue) {
      throw new CliDeeplinkUsageError("--linear-issue is required when using --branch");
    }
    // Build an https://ade-app.dev/open URL with the hints Linear gave us. The
    // landing page (and the renderer-side handler) interpret the linear-issue
    // hint by looking up the lane/project that owns it.
    const params = new URLSearchParams();
    params.set("type", "linear-issue");
    if (linearIssue) params.set("issue", linearIssue);
    if (branch) params.set("branch", branch);
    return openAndReport(`${ADE_DEEPLINK_HTTPS_BASE_URL}?${params.toString()}`);
  }

  // URL form.
  const url = flags.positional[0];
  if (!url) {
    throw new CliDeeplinkUsageError("ade open <url>  (or --linear-issue / --branch)");
  }
  const parsed = parseDeeplink(url);
  if (parsed.ok) return openAndReport(url);
  // Allow unknown_type URLs (like the linear-issue form above) to still pass
  // through to the OS opener — the landing page / desktop can decide what
  // to do.
  if (parsed.error.kind === "unknown_type" && looksLikeAdeOpenUrl(url)) {
    return openAndReport(url);
  }
  throw new CliDeeplinkUsageError(
    `Invalid deeplink: ${(parsed.error as { kind: string; reason?: string }).reason ?? parsed.error.kind}`,
  );
}

function openAndReport(url: string): DeeplinkCliResult {
  const result = openUrlViaOs(url);
  if (result.failed) {
    return {
      output: `Could not invoke OS opener for ${url}: ${result.message}\n`,
      exitCode: 1,
    };
  }
  return { output: `Opened ${url}\n`, exitCode: 0 };
}

function openUrlViaOs(url: string): { failed: boolean; message: string } {
  const platform = process.platform;
  let cmd: string;
  let args: string[];
  if (platform === "darwin") {
    cmd = "open";
    args = [url];
  } else if (platform === "win32") {
    cmd = "cmd";
    args = ["/c", "start", "", url];
  } else {
    cmd = "xdg-open";
    args = [url];
  }
  try {
    const r = spawnSync(cmd, args, { stdio: "ignore", timeout: 10_000 });
    if (r.error) return { failed: true, message: r.error.message };
    if (r.signal) return { failed: true, message: `${cmd} exited with signal ${r.signal}` };
    if (typeof r.status === "number" && r.status !== 0) {
      return { failed: true, message: `${cmd} exited with ${r.status}` };
    }
    return { failed: false, message: "" };
  } catch (err) {
    return {
      failed: true,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

function looksLikeAdeOpenUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "https:"
      && isAdeDeeplinkHttpsHost(url.hostname)
      && url.pathname === ADE_DEEPLINK_HTTPS_PATH;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// ade link <type> ...
// ---------------------------------------------------------------------------

export function runLinkCommand(args: string[]): DeeplinkCliResult {
  const plan = buildLinkPlan(args);
  if ("result" in plan) return plan.result;
  return finishLink(buildDeeplink(plan.target, { form: plan.form }), plan.skipClipboard);
}

export async function runLinkCommandAsync(
  args: string[],
  options: DeeplinkCommandOptions = {},
): Promise<DeeplinkCliResult> {
  const plan = buildLinkPlan(args);
  if ("result" in plan) return plan.result;
  let target = plan.target;
  if (!plan.noEnvelope && plan.envelopeContext && options.resolveEnvelope) {
    const envelope = await Promise.resolve(options.resolveEnvelope(plan.envelopeContext)).catch(() => null);
    if (envelope) {
      if (target.kind === "lane") target = { ...target, envelope };
      if (target.kind === "session") target = { ...target, envelope };
      if (target.kind === "commit") target = { ...target, envelope };
    }
  }
  return finishLink(buildDeeplink(target, { form: plan.form }), plan.skipClipboard);
}

type LinkPlan =
  | { result: DeeplinkCliResult }
  | {
      target: DeeplinkTarget;
      form: "ade" | "https";
      skipClipboard: boolean;
      noEnvelope: boolean;
      envelopeContext?: LinkEnvelopeContext;
    };

function buildLinkPlan(args: string[]): LinkPlan {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    return { result: { output: `${HELP_LINK}\n`, exitCode: 0 } };
  }
  const flags = extractFlags(args, {
    booleans: ["ade", "no-envelope", "no-clipboard"],
    valued: ["pr", "branch", "lane", "line"],
  });
  const positional = flags.positional;
  const form = flags.booleans.has("ade") ? "ade" : "https";
  const skipClipboard = flags.booleans.has("no-clipboard");
  const noEnvelope = flags.booleans.has("no-envelope");
  const plan = (target: DeeplinkTarget, envelopeContext?: LinkEnvelopeContext): LinkPlan => ({
    target,
    form,
    skipClipboard,
    noEnvelope,
    ...(envelopeContext ? { envelopeContext } : {}),
  });

  // `ade link <url>` — accept a deeplink and re-emit it in the chosen form.
  if (positional.length === 1) {
    const parsed = parseDeeplink(positional[0]);
    if (parsed.ok) return plan(parsed.target);
  }

  const verb = positional[0];
  if (verb === "lane") {
    const laneId = positional[1];
    if (!laneId) {
      throw new CliDeeplinkUsageError("ade link lane <lane-uuid>");
    }
    return plan({ kind: "lane", laneId }, { targetKind: "lane", laneId });
  }
  if (verb === "session") {
    const sessionId = positional[1];
    if (!sessionId) {
      throw new CliDeeplinkUsageError("ade link session <session-id> [--lane <lane-uuid>]");
    }
    const laneId = flags.valued.get("lane");
    return plan(
      laneId ? { kind: "session", sessionId, laneId } : { kind: "session", sessionId },
      laneId ? { targetKind: "session", laneId } : undefined,
    );
  }
  if (verb === "file") {
    const filePath = positional[1];
    if (!filePath) {
      throw new CliDeeplinkUsageError("ade link file <path> [--line <number>] [--lane <lane-uuid>]");
    }
    const lineRaw = flags.valued.get("line");
    const line = lineRaw != null ? parsePositiveInteger(lineRaw, "--line") : undefined;
    const laneId = flags.valued.get("lane");
    return plan({
      kind: "file",
      path: filePath,
      ...(line != null ? { line } : {}),
      ...(laneId ? { laneId } : {}),
    });
  }
  if (verb === "commit") {
    const sha = positional[1];
    if (!sha) {
      throw new CliDeeplinkUsageError("ade link commit <sha> [--lane <lane-uuid>]");
    }
    const laneId = flags.valued.get("lane");
    return plan(
      { kind: "commit", sha, ...(laneId ? { laneId } : {}) },
      laneId ? { targetKind: "commit", laneId } : undefined,
    );
  }
  if (verb === "artifact") {
    const artifactId = positional[1];
    if (!artifactId) {
      throw new CliDeeplinkUsageError("ade link artifact <id>");
    }
    return plan({ kind: "artifact", artifactId });
  }
  if (verb === "branch") {
    const repo = positional[1];
    const branch = positional[2];
    if (!repo || !branch) {
      throw new CliDeeplinkUsageError(
        "ade link branch <owner/repo> <branch> [--pr <number>]",
      );
    }
    const { repoOwner, repoName } = parseRepoSlug(repo);
    const prNumberRaw = flags.valued.get("pr");
    const prNumber = prNumberRaw != null ? parsePositiveInteger(prNumberRaw, "--pr") : undefined;
    return plan(prNumber != null
      ? { kind: "branch", repoOwner, repoName, branch, prNumber }
      : { kind: "branch", repoOwner, repoName, branch });
  }
  if (verb === "pr") {
    const repo = positional[1];
    const numberRaw = positional[2];
    if (!repo || !numberRaw) {
      throw new CliDeeplinkUsageError("ade link pr <owner/repo> <number>");
    }
    const { repoOwner, repoName } = parseRepoSlug(repo);
    const prNumber = parsePositiveInteger(numberRaw, "PR number");
    return plan({ kind: "pr", repoOwner, repoName, prNumber });
  }
  if (verb === "linear-issue") {
    const issueIdentifier = positional[1];
    if (!issueIdentifier) {
      throw new CliDeeplinkUsageError("ade link linear-issue <ADE-123> [--branch <branch>]");
    }
    const branchHint = flags.valued.get("branch");
    return plan(branchHint
      ? { kind: "linear-issue", issueIdentifier, branch: branchHint }
      : { kind: "linear-issue", issueIdentifier });
  }

  throw new CliDeeplinkUsageError(HELP_LINK);
}

function parseRepoSlug(repo: string): { repoOwner: string; repoName: string } {
  const parts = repo.split("/");
  if (parts.length !== 2) {
    throw new CliDeeplinkUsageError("Repo must be in 'owner/repo' form");
  }
  const [repoOwner, repoName] = parts;
  if (!repoOwner || !repoName) {
    throw new CliDeeplinkUsageError("Repo must be in 'owner/repo' form");
  }
  return { repoOwner, repoName };
}

function parsePositiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new CliDeeplinkUsageError(`${label} must be a positive integer`);
  }
  return parsed;
}

function finishLink(url: string, skipClipboard: boolean): DeeplinkCliResult {
  // Round-trip gate: never print/copy a link the shared parser would reject
  // (e.g. `ade link file ../secret` or a malformed commit sha).
  const roundTrip = parseDeeplink(url);
  if (!roundTrip.ok) {
    const reason = "reason" in roundTrip.error ? roundTrip.error.reason : roundTrip.error.kind;
    throw new CliDeeplinkUsageError(`refusing to mint an invalid link (${reason}): ${url}`);
  }
  let clipboardNote = "";
  if (!skipClipboard) {
    if (copyToClipboard(url)) {
      clipboardNote = "\n(copied to clipboard)";
    }
  }
  return { output: `${url}${clipboardNote}\n`, exitCode: 0 };
}

// ---------------------------------------------------------------------------
// ade linear install
// ---------------------------------------------------------------------------

export function runLinearCommand(args: string[]): DeeplinkCliResult {
  const verb = args[0];
  if (!verb || verb === "--help" || verb === "-h") {
    return { output: `${HELP_LINEAR}\n`, exitCode: 0 };
  }
  if (verb === "install") {
    return runLinearInstall(args.slice(1));
  }
  throw new CliDeeplinkUsageError(`Unknown linear subcommand: ${verb}`);
}

export function runLinearInstall(args: string[], opts: { home?: string; argv0?: string } = {}): DeeplinkCliResult {
  const home = opts.home ?? os.homedir();
  const cfgDir = path.join(home, ".linear");
  const cfgPath = path.join(cfgDir, "coding-tools.json");
  const bin = opts.argv0 ?? resolveAdeBinaryPath();
  const dryRun = args.includes("--dry-run");

  // Linear's coding-tool placeholder set only includes the Linear issue
  // identifier, branch name, project name, prompt, and PR-comment id. It does
  // NOT include the GitHub repo owner/name — tools are expected to resolve
  // that locally from the issue identifier + active workspace.
  //
  // For v1 we hand the CLI just the branch name and Linear issue identifier;
  // the receiving `ade open` invocation builds an `ade://` URL based on the
  // active desktop project's GitHub remote (resolved via RPC) and opens the
  // inbound-deeplink flow from there. If the desktop can't resolve the repo,
  // it falls back to opening ADE on the lanes page so the user can pick.
  const desiredEntry = {
    openIssue: {
      path: bin,
      args: [
        "open",
        "--linear-issue",
        "{{issue.identifier}}",
        "--branch",
        "{{issue.branchName}}",
      ],
      env: ["LINEAR_PROMPT", "LINEAR_ISSUE_IDENTIFIER", "LINEAR_ISSUE_BRANCH_NAME"],
    },
  };

  let existing: Record<string, unknown> | null = null;
  if (fs.existsSync(cfgPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
    } catch {
      existing = null;
    }
  }

  const merged = existing ? { ...existing, ...desiredEntry } : desiredEntry;
  const serialized = JSON.stringify(merged, null, 2) + "\n";

  if (dryRun) {
    return {
      output: `Would write ${cfgPath}\n\n${serialized}`,
      exitCode: 0,
    };
  }

  fs.mkdirSync(cfgDir, { recursive: true });

  if (existing) {
    const backupPath = `${cfgPath}.bak-${new Date()
      .toISOString()
      .replace(/[:.]/g, "")
      .slice(0, 15)}`;
    fs.copyFileSync(cfgPath, backupPath);
    fs.writeFileSync(cfgPath, serialized);
    return {
      output: `Wrote ${cfgPath} (backup at ${backupPath})\n`,
      exitCode: 0,
    };
  }
  fs.writeFileSync(cfgPath, serialized);
  return { output: `Wrote ${cfgPath}\n`, exitCode: 0 };
}

function resolveAdeBinaryPath(): string {
  // When invoked via the bundled binary, argv[0] is the absolute path. When
  // run via node, argv[0] is node — fall back to bare `ade` and hope it's on
  // PATH (the Linear coding-tool spawner inherits the user's PATH).
  const argv0 = process.argv[0] ?? "";
  return /\bade\b/.test(argv0) ? argv0 : "ade";
}

// ---------------------------------------------------------------------------
// Argument helpers
// ---------------------------------------------------------------------------

type FlagSpec = {
  booleans: string[];
  valued: string[];
};

type FlagResult = {
  booleans: Set<string>;
  valued: Map<string, string>;
  positional: string[];
};

function extractFlags(args: string[], spec: FlagSpec): FlagResult {
  const booleans = new Set<string>();
  const valued = new Map<string, string>();
  const positional: string[] = [];
  const booleanSet = new Set(spec.booleans);
  const valuedSet = new Set(spec.valued);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      if (booleanSet.has(name)) {
        booleans.add(name);
        continue;
      }
      if (valuedSet.has(name)) {
        const next = args[i + 1];
        if (next == null || next.startsWith("--")) {
          throw new CliDeeplinkUsageError(`--${name} requires a value`);
        }
        valued.set(name, next);
        i += 1;
        continue;
      }
      throw new CliDeeplinkUsageError(`Unknown flag: ${arg}`);
    }
    positional.push(arg);
  }
  return { booleans, valued, positional };
}
