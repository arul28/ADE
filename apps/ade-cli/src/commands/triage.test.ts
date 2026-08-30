import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveExecutableFromKnownLocations } from "../../../desktop/src/main/services/ai/cliExecutableResolver";
import type { DoctorCommandResult } from "./doctor";
import type { ReportIssueResult } from "./reportIssue";
import { runTriageCommand } from "./triage";
import {
  buildTriageContext,
  buildTriagePrompt,
  createTriageBundleDir,
  extractRecentErrorLines,
  orderTriageDoctorRows,
} from "./triageContext";
import {
  buildTriageLaunchPlan,
  defaultTriageExecutableResolver,
  detectTriageProviders,
  parseTriageProviderName,
  TRIAGE_PROVIDERS,
  type DetectedTriageProvider,
  type TriageLaunchPlan,
} from "./triageLaunch";
import { TriageUsageError } from "./triageErrors";
import {
  readLocalTriagePlaybook,
  resolveTriagePlaybook,
  TRIAGE_NO_FETCH_ENV,
  TRIAGE_PLAYBOOK_PATH_ENV,
  TRIAGE_PLAYBOOK_REMOTE_URL,
} from "./triagePlaybook";

const tempDirs: string[] = [];

function tempDir(prefix = "ade-triage-test-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const AT = new Date("2026-08-29T10:00:00.000Z");

function doctorResult(overrides: Partial<DoctorCommandResult> = {}): DoctorCommandResult {
  return {
    ok: false,
    checkedAt: AT.toISOString(),
    online: false,
    rows: [
      { key: "app", label: "App", status: "ok", detail: "1.2.68 installed" },
      { key: "storage", label: "Storage", status: "warn", detail: "Project on iCloud Drive" },
      { key: "brain", label: "Brain", status: "fail", detail: "Not responding on the socket" },
    ],
    app: {
      installedVersion: "1.2.68",
      latestKnownVersion: "1.2.68",
      path: "/Applications/ADE.app",
      online: false,
    },
    brain: {
      running: false,
      version: null,
      buildHash: null,
      pid: null,
      uptimeMs: null,
      mismatchReason: null,
      error: "connect ENOENT",
    },
    wedge: null,
    syncPort: null,
    portDiagnoses: [],
    publishHealth: null,
    relayHealth: null,
    account: { signedIn: null, source: null, error: null },
    credentials: null,
    storage: null as unknown as DoctorCommandResult["storage"],
    diagnostics: { enabled: true, sendsInWindow: 0, limit: 3 },
    ...overrides,
  };
}

function reportResult(overrides: Partial<ReportIssueResult> = {}): ReportIssueResult {
  const adeDir = tempDir("ade-triage-home-");
  return {
    report: "# ADE diagnostic report\n\nEverything nominal.\n",
    issueUrl: "https://github.com/arul28/ADE/issues/new",
    installId: "install-1",
    appVersion: "1.2.68",
    secretsDir: path.join(adeDir, "secrets"),
    reportsDir: path.join(adeDir, "diagnostic-reports"),
    redaction: { homeDir: "/Users/ada", username: "ada", hostname: "ada-mbp", projectRoots: [] },
    ...overrides,
  };
}

function contextInput(
  overrides: Partial<Parameters<typeof buildTriageContext>[0]> = {},
): Parameters<typeof buildTriageContext>[0] {
  return {
    generatedAt: AT,
    cliVersion: "1.2.68",
    platform: "darwin",
    arch: "arm64",
    osRelease: "25.3.0",
    nodeVersion: "22.13.0",
    projectRoot: null,
    adeHome: "/Users/ada/.ade",
    socketPath: "/Users/ada/.ade/sock/ade.sock",
    layoutError: null,
    doctor: doctorResult(),
    doctorError: null,
    report: "# ADE diagnostic report\n\nnothing here\n",
    reportError: null,
    redaction: { homeDir: "/Users/ada", username: "ada", hostname: "ada-mbp", projectRoots: [] },
    playbook: { source: "local", origin: "/repo/docs/triage/PLAYBOOK.md", path: "/tmp/x/PLAYBOOK.md" },
    ...overrides,
  };
}

describe("buildTriageContext", () => {
  it("puts failing doctor rows first and names the install", () => {
    const context = buildTriageContext(contextInput());

    const failIndex = context.indexOf("| Brain |");
    const warnIndex = context.indexOf("| Storage |");
    const okIndex = context.indexOf("| App |");
    expect(failIndex).toBeGreaterThan(-1);
    expect(failIndex).toBeLessThan(warnIndex);
    expect(warnIndex).toBeLessThan(okIndex);
    expect(context).toContain("1 failing row(s), listed first");
    expect(context).toContain("ADE CLI version: 1.2.68");
    expect(context).toContain("platform: darwin arm64");
    expect(context).toContain("node: 22.13.0");
    expect(context).toContain("responding: no");
    expect(context).toContain("PLAYBOOK.md");
  });

  // The context file is written for someone to hand to a third-party agent, so
  // the redaction that protects `ade report-issue` has to cover everything this
  // command adds around it — including doctor row details, which are built by
  // doctor.ts and never passed through the report's own redaction pass.
  it("redacts home paths, account names, emails and tokens from every section", () => {
    const context = buildTriageContext(contextInput({
      doctor: doctorResult({
        rows: [
          {
            key: "credentials",
            label: "Credentials",
            status: "fail",
            detail: "Could not read /Users/ada/.ade/secrets/credentials.json.enc",
          },
        ],
      }),
      report: [
        "# ADE diagnostic report",
        "",
        "signed in as ada@example.com on ada-mbp",
        "authorization: Bearer sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "error: open /Users/ada/.ade/ade.db failed",
      ].join("\n"),
    }));

    expect(context).not.toContain("/Users/ada");
    expect(context).not.toContain("ada@example.com");
    expect(context).not.toContain("ada-mbp");
    expect(context).not.toContain("sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    // Still useful: the redacted shape keeps the fact, drops the identity.
    expect(context).toContain("credentials.json.enc");
  });

  it("records a doctor probe that could not run instead of implying the checks passed", () => {
    const context = buildTriageContext(contextInput({
      doctor: null,
      doctorError: "runtime socket unavailable",
    }));

    expect(context).toContain("could not complete: runtime socket unavailable");
    expect(context).toContain("not probed");
  });

  it("says the diagnostic report could not be collected instead of showing an empty one", () => {
    const context = buildTriageContext(contextInput({
      report: "",
      reportError: "ENOSPC: no space left on device",
    }));

    expect(context).toContain("could not be collected: ENOSPC: no space left on device");
    // The absent report must not read as a clean one.
    expect(context).not.toContain("versions, service");
  });

  it("says the ADE home could not be resolved instead of printing a guessed path", () => {
    const context = buildTriageContext(contextInput({
      adeHome: null,
      socketPath: null,
      layoutError: "EACCES reading the home directory",
    }));

    expect(context).toContain("ADE home: unknown");
    expect(context).toContain("could not be resolved: EACCES reading the home directory");
  });
});

describe("orderTriageDoctorRows / extractRecentErrorLines", () => {
  it("orders fail, then warn, then ok", () => {
    const ordered = orderTriageDoctorRows(doctorResult().rows);
    expect(ordered.map((row) => row.status)).toEqual(["fail", "warn", "ok"]);
  });

  it("keeps only error-shaped lines, most recent last", () => {
    const lines = extractRecentErrorLines(
      [
        "all good",
        "brain.jsonl: EADDRINUSE 0.0.0.0:8787",
        "# heading with error in it",
        "database is locked",
      ].join("\n"),
    );
    expect(lines).toEqual(["brain.jsonl: EADDRINUSE 0.0.0.0:8787", "database is locked"]);
  });
});

describe("resolveTriagePlaybook", () => {
  function localOnlyOptions(): {
    cwd: string;
    dirname: string;
    argv1: null;
    resourcesPath: null;
    env: NodeJS.ProcessEnv;
  } {
    // Point every search root at empty directories so the repo's own committed
    // copy cannot satisfy a test that is about the fallback.
    const empty = tempDir("ade-triage-empty-");
    return { cwd: empty, dirname: empty, argv1: null, resourcesPath: null, env: {} };
  }

  /** A minimal ADE install tree: `<root>/apps/ade-cli/dist` + the doc. */
  function installTree(): { entryDir: string; playbookPath: string } {
    const root = tempDir("ade-triage-install-");
    const entryDir = path.join(root, "apps", "ade-cli", "dist");
    fs.mkdirSync(entryDir, { recursive: true });
    const playbookPath = path.join(root, "docs", "triage", "PLAYBOOK.md");
    fs.mkdirSync(path.dirname(playbookPath), { recursive: true });
    fs.writeFileSync(playbookPath, "# install playbook\n", "utf8");
    return { entryDir, playbookPath };
  }

  it("prefers the copy on GitHub main and records it as remote", async () => {
    const fetchImpl = vi.fn(async () => new Response("# remote playbook\n", { status: 200 }));

    const playbook = await resolveTriagePlaybook({
      ...localOnlyOptions(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(playbook.source).toBe("remote");
    expect(playbook.origin).toBe(TRIAGE_PLAYBOOK_REMOTE_URL);
    expect(playbook.text).toContain("remote playbook");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refuses to follow a redirect off the pinned URL", async () => {
    const dir = tempDir();
    const localPath = path.join(dir, "PLAYBOOK.md");
    fs.writeFileSync(localPath, "# local playbook\n", "utf8");
    let seenRedirect: RequestRedirect | undefined;
    // This is the text a coding agent is about to be pointed at, so a proxy or
    // a hijacked DNS answer must not be able to substitute its own.
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      seenRedirect = init?.redirect;
      if (init?.redirect === "error") throw new TypeError("unexpected redirect");
      return new Response("# attacker playbook\n", { status: 200 });
    });

    const playbook = await resolveTriagePlaybook({
      ...localOnlyOptions(),
      env: { [TRIAGE_PLAYBOOK_PATH_ENV]: localPath },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(seenRedirect).toBe("error");
    expect(playbook.source).toBe("local");
    expect(playbook.text).toContain("local playbook");
  });

  it("falls back to the local copy when the fetch fails", async () => {
    const dir = tempDir();
    const localPath = path.join(dir, "PLAYBOOK.md");
    fs.writeFileSync(localPath, "# local playbook\n", "utf8");
    const fetchImpl = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND raw.githubusercontent.com");
    });

    const playbook = await resolveTriagePlaybook({
      ...localOnlyOptions(),
      env: { [TRIAGE_PLAYBOOK_PATH_ENV]: localPath },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(playbook.source).toBe("local");
    expect(playbook.origin).toBe(localPath);
    expect(playbook.text).toContain("local playbook");
  });

  it("falls back to the local copy on a non-200 response", async () => {
    const dir = tempDir();
    const localPath = path.join(dir, "PLAYBOOK.md");
    fs.writeFileSync(localPath, "# local playbook\n", "utf8");

    const playbook = await resolveTriagePlaybook({
      ...localOnlyOptions(),
      env: { [TRIAGE_PLAYBOOK_PATH_ENV]: localPath },
      fetchImpl: (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch,
    });

    expect(playbook.source).toBe("local");
    expect(playbook.text).toContain("local playbook");
  });

  it("refuses an oversized body before reading it", async () => {
    const dir = tempDir();
    const localPath = path.join(dir, "PLAYBOOK.md");
    fs.writeFileSync(localPath, "# local playbook\n", "utf8");
    const readBody = vi.fn(async () => "x");

    const playbook = await resolveTriagePlaybook({
      ...localOnlyOptions(),
      env: { [TRIAGE_PLAYBOOK_PATH_ENV]: localPath },
      fetchImpl: (async () => ({
        ok: true,
        headers: { get: () => String(64 * 1024 * 1024) },
        text: readBody,
      })) as unknown as typeof fetch,
    });

    expect(readBody).not.toHaveBeenCalled();
    expect(playbook.source).toBe("local");
  });

  it("aborts the fetch on its own timeout rather than hanging the command", async () => {
    let seenSignal: AbortSignal | null = null;
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
      seenSignal = init?.signal ?? null;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });

    const playbook = await resolveTriagePlaybook({
      ...localOnlyOptions(),
      timeoutMs: 1,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(seenSignal).not.toBeNull();
    expect(playbook.source).toBe("local");
  });

  it("skips the network entirely when the kill switch is set", async () => {
    const fetchImpl = vi.fn(async () => new Response("# remote", { status: 200 }));

    const playbook = await resolveTriagePlaybook({
      ...localOnlyOptions(),
      env: { [TRIAGE_NO_FETCH_ENV]: "1" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(playbook.source).toBe("local");
  });

  it("still produces a playbook when this build shipped without the doc and the network is gone", async () => {
    const playbook = await resolveTriagePlaybook({
      ...localOnlyOptions(),
      fetchImpl: null,
    });

    expect(playbook.source).toBe("local");
    expect(playbook.origin).toBe("built into this ADE CLI");
    // The reduced copy is still a playbook: the safety rules survive.
    expect(playbook.text).toContain("Never kill processes by name or pattern");
    expect(playbook.text).toContain("ade doctor --text");
  });

  it("finds the copy committed in this repository", () => {
    const playbook = readLocalTriagePlaybook({ env: {} });
    expect(playbook.origin.endsWith(path.join("docs", "triage", "PLAYBOOK.md"))).toBe(true);
    expect(playbook.text).toContain("ADE triage playbook");
  });

  it("ranks the packaged copy above whatever repository the shell is sitting in", () => {
    // `ade triage` is run from wherever the user happens to be. An old clone, a
    // fork, or a vendored copy must not out-rank the playbook this build ships.
    const resourcesPath = tempDir("ade-triage-resources-");
    const packaged = path.join(resourcesPath, "docs", "triage", "PLAYBOOK.md");
    fs.mkdirSync(path.dirname(packaged), { recursive: true });
    fs.writeFileSync(packaged, "# packaged playbook\n", "utf8");
    const cwd = tempDir("ade-triage-cwd-");
    const checkedOut = path.join(cwd, "docs", "triage", "PLAYBOOK.md");
    fs.mkdirSync(path.dirname(checkedOut), { recursive: true });
    fs.writeFileSync(checkedOut, "# some other checkout\n", "utf8");

    const playbook = readLocalTriagePlaybook({ env: {}, cwd, dirname: cwd, resourcesPath });

    expect(playbook.origin).toBe(packaged);
    expect(playbook.text).toContain("packaged playbook");
  });

  it("still lets the explicit override beat the packaged copy", () => {
    const resourcesPath = tempDir("ade-triage-resources-");
    const packaged = path.join(resourcesPath, "docs", "triage", "PLAYBOOK.md");
    fs.mkdirSync(path.dirname(packaged), { recursive: true });
    fs.writeFileSync(packaged, "# packaged playbook\n", "utf8");
    const overridePath = path.join(tempDir(), "PLAYBOOK.md");
    fs.writeFileSync(overridePath, "# my working copy\n", "utf8");

    const playbook = readLocalTriagePlaybook({
      env: { [TRIAGE_PLAYBOOK_PATH_ENV]: overridePath },
      cwd: resourcesPath,
      dirname: resourcesPath,
      resourcesPath,
    });

    expect(playbook.origin).toBe(overridePath);
    expect(playbook.text).toContain("my working copy");
  });

  it("looks for exactly one packaged path, the one packaging actually ships", () => {
    // A second guessed layout would mask a packaging change instead of failing
    // loudly, so `<resources>/triage/PLAYBOOK.md` must not be consulted.
    const resourcesPath = tempDir("ade-triage-resources-");
    const speculative = path.join(resourcesPath, "triage", "PLAYBOOK.md");
    fs.mkdirSync(path.dirname(speculative), { recursive: true });
    fs.writeFileSync(speculative, "# speculative layout\n", "utf8");
    const empty = tempDir("ade-triage-empty-");

    const playbook = readLocalTriagePlaybook({
      env: {},
      cwd: empty,
      dirname: empty,
      resourcesPath,
    });

    expect(playbook.origin).toBe("built into this ADE CLI");
  });

  it("ranks the copy in the install this CLI runs from above the shell's working directory", () => {
    // The rung the whole ordering rests on: cwd is last, and an ADE checkout
    // the shell happens to be sitting in must not out-rank the install's own
    // playbook. Nothing else in this describe block pins that boundary.
    const install = installTree();
    const cwd = tempDir("ade-triage-cwd-");
    const checkedOut = path.join(cwd, "docs", "triage", "PLAYBOOK.md");
    fs.mkdirSync(path.dirname(checkedOut), { recursive: true });
    fs.writeFileSync(checkedOut, "# some other checkout\n", "utf8");

    const playbook = readLocalTriagePlaybook({
      env: {},
      cwd,
      dirname: install.entryDir,
      argv1: null,
      resourcesPath: null,
    });

    expect(playbook.origin).toBe(fs.realpathSync(install.playbookPath));
    expect(playbook.text).toContain("install playbook");
  });

  it("falls back to the entry script when the bundle has no __dirname", () => {
    // `tsx src/cli.ts` and any ESM loader leave `__dirname` undefined, so
    // `argv[1]` is the only thing pointing at the install. Every other test
    // pins `dirname`, which suppresses this rung entirely.
    const install = installTree();
    const cwd = tempDir("ade-triage-cwd-");
    const checkedOut = path.join(cwd, "docs", "triage", "PLAYBOOK.md");
    fs.mkdirSync(path.dirname(checkedOut), { recursive: true });
    fs.writeFileSync(checkedOut, "# some other checkout\n", "utf8");

    const playbook = readLocalTriagePlaybook({
      env: {},
      cwd,
      dirname: tempDir("ade-triage-empty-"),
      argv1: path.join(install.entryDir, "cli.cjs"),
      resourcesPath: null,
    });

    expect(playbook.origin).toBe(fs.realpathSync(install.playbookPath));
    expect(playbook.text).toContain("install playbook");
  });

  it("refuses a playbook from an ancestor that is not an ADE install", () => {
    // The walk used to climb eight unmarked levels, which from an npm-global
    // install reaches the home directory: a `~/docs/triage/PLAYBOOK.md` anyone
    // could drop there would have become the instructions a coding agent
    // follows while repairing this machine. No ADE marker, no candidate.
    const home = tempDir("ade-triage-home-walk-");
    const planted = path.join(home, "docs", "triage", "PLAYBOOK.md");
    fs.mkdirSync(path.dirname(planted), { recursive: true });
    fs.writeFileSync(planted, "# planted playbook\n", "utf8");
    const entryDir = path.join(home, ".npm-global", "lib", "node_modules", "someones-cli", "dist");
    fs.mkdirSync(entryDir, { recursive: true });

    const playbook = readLocalTriagePlaybook({
      env: {},
      cwd: tempDir("ade-triage-empty-"),
      dirname: entryDir,
      argv1: null,
      resourcesPath: null,
    });

    expect(playbook.text).not.toContain("planted playbook");
    expect(playbook.origin).toBe("built into this ADE CLI");
  });

  it("finds the packaged copy beside the unpacked CLI in an installed app", () => {
    // `<Resources>/ade-cli/cli.cjs` with `<Resources>/docs/triage` beside it is
    // what `extraResources` actually ships, and a plain node process has no
    // `process.resourcesPath` to shortcut it — the walk has to reach it.
    const resources = tempDir("ade-triage-resources-");
    const entryDir = path.join(resources, "ade-cli");
    fs.mkdirSync(entryDir, { recursive: true });
    const packaged = path.join(resources, "docs", "triage", "PLAYBOOK.md");
    fs.mkdirSync(path.dirname(packaged), { recursive: true });
    fs.writeFileSync(packaged, "# packaged playbook\n", "utf8");

    const playbook = readLocalTriagePlaybook({
      env: {},
      cwd: tempDir("ade-triage-empty-"),
      dirname: entryDir,
      argv1: null,
      resourcesPath: null,
    });

    expect(playbook.origin).toBe(fs.realpathSync(packaged));
    expect(playbook.text).toContain("packaged playbook");
  });
});

describe("detectTriageProviders", () => {
  it("returns installed agents in the documented detection order", () => {
    const installed = new Set(["droid", "codex", "opencode"]);
    const detected = detectTriageProviders({
      env: {},
      resolve: (command) =>
        installed.has(command) ? { path: `/fake/bin/${command}`, source: "path" } : null,
    });

    expect(detected.map((provider) => provider.name)).toEqual(["codex", "opencode", "droid"]);
    expect(detected[0]?.path).toBe("/fake/bin/codex");
  });

  it("treats a resolver failure as 'not installed' instead of failing the command", () => {
    const detected = detectTriageProviders({
      env: {},
      resolve: (command) => {
        if (command === "claude") throw new Error("EACCES reading a PATH entry");
        return command === "codex" ? { path: "/fake/bin/codex", source: "path" } : null;
      },
    });

    expect(detected.map((provider) => provider.name)).toEqual(["codex"]);
  });

  // Windows cannot execute an extension-less file, so detection must go through
  // the shared PATHEXT-aware resolver rather than an `fs.existsSync` of the bare
  // name — that probe finds `codex` (an sh script) and never `codex.cmd`.
  it("resolves through the shared PATHEXT-aware executable resolver", () => {
    const env = { PATHEXT: ".COM;.EXE;.CMD" };
    const seen: string[] = [];
    const detected = detectTriageProviders({
      env,
      resolve: (command, resolverEnv) => {
        seen.push(command);
        expect(resolverEnv).toBe(env);
        return command === "claude"
          ? { path: "C:\\Users\\ada\\AppData\\Roaming\\npm\\claude.cmd", source: "path" }
          : null;
      },
    });

    expect(seen).toEqual(TRIAGE_PROVIDERS.map((provider) => provider.command));
    expect(detected[0]?.path).toBe("C:\\Users\\ada\\AppData\\Roaming\\npm\\claude.cmd");
    expect(defaultTriageExecutableResolver("claude", env))
      .toEqual(resolveExecutableFromKnownLocations("claude", env));
  });

  it("rejects an unknown --provider and accepts the documented aliases", () => {
    expect(parseTriageProviderName("cursor")).toBe("cursor-agent");
    expect(parseTriageProviderName("Claude-Code")).toBe("claude");
    expect(() => parseTriageProviderName("gemini")).toThrow(TriageUsageError);
  });
});

describe("buildTriageLaunchPlan", () => {
  function provider(name: DetectedTriageProvider["name"]): DetectedTriageProvider {
    const spec = TRIAGE_PROVIDERS.find((entry) => entry.name === name)!;
    return { ...spec, path: `/fake/bin/${spec.command}` };
  }

  it("passes the prompt as the trailing positional argument", () => {
    const prompt = buildTriagePrompt({ contextPath: "/tmp/t/context.md", playbookPath: "/tmp/t/PLAYBOOK.md" });
    const plan = buildTriageLaunchPlan(provider("claude"), prompt, {}, "darwin");

    expect(plan.command).toBe("/fake/bin/claude");
    expect(plan.args).toEqual([prompt]);
    expect(plan.promptDelivered).toBe(true);
  });

  // `opencode [project]` takes a DIRECTORY, not a prompt: passing one there
  // launches OpenCode in a folder that does not exist.
  it("launches OpenCode bare, because its positional argument is a project directory", () => {
    const plan = buildTriageLaunchPlan(provider("opencode"), "prompt text", {}, "darwin");

    expect(plan.args).toEqual([]);
    expect(plan.promptDelivered).toBe(false);
  });

  it("spawns a Windows .exe directly and keeps the prompt on argv", () => {
    const prompt = "line one\nline two";
    const plan = buildTriageLaunchPlan(
      { ...provider("claude"), path: "C:\\Program Files\\claude\\claude.exe" },
      prompt,
      { ComSpec: "C:\\Windows\\system32\\cmd.exe" },
      "win32",
    );

    expect(plan.command).toBe("C:\\Program Files\\claude\\claude.exe");
    expect(plan.args).toEqual([prompt]);
    expect(plan.promptDelivered).toBe(true);
  });

  // A `.cmd` shim can only be launched through `cmd.exe /d /s /c`, which
  // rewrites the command line before the CLI sees argv: newlines flatten to
  // spaces and `%VAR%` expands. The triage prompt is multi-line and full of
  // paths, so it must not ride there.
  it("keeps the prompt off the command line when Windows has to wrap the launch", () => {
    const plan = buildTriageLaunchPlan(
      { ...provider("claude"), path: "C:\\Users\\ada\\AppData\\Roaming\\npm\\claude.cmd" },
      "line one\nline two",
      { ComSpec: "C:\\Windows\\system32\\cmd.exe" },
      "win32",
    );

    expect(plan.promptDelivered).toBe(false);
    expect(plan.command).toBe("C:\\Windows\\system32\\cmd.exe");
    expect(plan.args.join(" ")).not.toContain("line one");
    expect(plan.args.join(" ")).toContain("claude.cmd");
    expect(plan.windowsVerbatimArguments).toBe(true);
  });
});

describe("runTriageCommand", () => {
  function dependencies(overrides: Record<string, unknown> = {}) {
    const home = tempDir("ade-triage-home-");
    return {
      cliVersion: "1.2.68",
      projectRoot: null,
      runDoctor: async () => doctorResult(),
      buildReport: async () => reportResult(),
      resolvePlaybook: async () => ({
        text: "# playbook\n",
        source: "local" as const,
        origin: "/repo/docs/triage/PLAYBOOK.md",
      }),
      detectProviders: () => [] as DetectedTriageProvider[],
      now: () => AT,
      env: { ADE_HOME: home },
      tmpRoot: tempDir("ade-triage-root-"),
      platform: "darwin" as NodeJS.Platform,
      writeNotice: () => {},
      ...overrides,
    };
  }

  it("--agent writes the bundle, prints the handoff, and launches nothing", async () => {
    const spawnAgent = vi.fn(async () => 0);

    const { payload, exitCode } = await runTriageCommand(
      { agent: true, provider: null },
      dependencies({
        spawnAgent,
        detectProviders: () => [
          { ...TRIAGE_PROVIDERS[0]!, path: "/fake/bin/claude" },
        ] as DetectedTriageProvider[],
      }),
    );

    expect(spawnAgent).not.toHaveBeenCalled();
    expect(exitCode).toBe(0);
    expect(payload.mode).toBe("agent");
    expect(payload.playbookSource).toBe("local");
    expect(payload.playbookOrigin).toBe("/repo/docs/triage/PLAYBOOK.md");
    expect(payload.providers).toEqual([
      { name: "claude", label: "Claude Code", path: "/fake/bin/claude" },
    ]);
    expect(payload.suggestedPrompt).toContain(payload.contextPath);
    expect(payload.suggestedPrompt).toContain(payload.playbookPath);

    expect(path.basename(payload.contextPath)).toBe("context.md");
    expect(path.basename(path.dirname(payload.contextPath)).startsWith("ade-triage-")).toBe(true);
    expect(fs.readFileSync(payload.contextPath, "utf8")).toContain("# ADE triage context");
    expect(fs.readFileSync(payload.playbookPath, "utf8")).toContain("# playbook");

    // The JSON body is what an already-running agent consumes; it must survive
    // a round trip with every field the caller was promised.
    const parsed = JSON.parse(JSON.stringify(payload)) as typeof payload;
    expect(parsed.contextPath).toBe(payload.contextPath);
    expect(parsed.playbookSource).toBe("local");
  });

  it("falls back to the embedded playbook when the resolver rejects", async () => {
    // Every other collector in this command is wrapped in `settle` because the
    // machine running triage is by definition broken. The playbook resolver is
    // no different: it reads the same disk, and an unhandled rejection here
    // used to take the whole bundle — context file included — down with it.
    const { payload, exitCode } = await runTriageCommand(
      { agent: true, provider: null },
      dependencies({
        resolvePlaybook: async () => {
          throw new Error("EIO: playbook read failed");
        },
      }),
    );

    expect(exitCode).toBe(0);
    expect(payload.playbookSource).toBe("local");
    expect(payload.playbookOrigin).toBe("built into this ADE CLI");
    expect(fs.readFileSync(payload.playbookPath, "utf8")).toContain("ADE triage playbook");
    // The rest of the handoff still has to be there — that is the whole point.
    expect(fs.readFileSync(payload.contextPath, "utf8")).toContain("# ADE triage context");
  });

  it("keeps the handoff (and exit 0) when no agent CLI is installed", async () => {
    const spawnAgent = vi.fn(async () => 0);

    const { payload, exitCode } = await runTriageCommand(
      { agent: false, provider: null },
      dependencies({ spawnAgent }),
    );

    expect(spawnAgent).not.toHaveBeenCalled();
    expect(exitCode).toBe(0);
    expect(payload.mode).toBe("no-provider");
    expect(payload.message).toContain("No agent CLI found");
    expect(fs.existsSync(payload.contextPath)).toBe(true);
  });

  it("launches the first detected agent and exits with its status", async () => {
    const plans: TriageLaunchPlan[] = [];
    const notices: string[] = [];

    const { payload, exitCode } = await runTriageCommand(
      { agent: false, provider: null },
      dependencies({
        detectProviders: () => [
          { ...TRIAGE_PROVIDERS[1]!, path: "/fake/bin/codex" },
          { ...TRIAGE_PROVIDERS[4]!, path: "/fake/bin/droid" },
        ] as DetectedTriageProvider[],
        spawnAgent: async (plan: TriageLaunchPlan) => {
          plans.push(plan);
          return 3;
        },
        writeNotice: (text: string) => notices.push(text),
      }),
    );

    expect(exitCode).toBe(3);
    expect(payload.mode).toBe("launch");
    expect(payload.launched).toEqual({ provider: "codex", label: "Codex", promptDelivered: true });
    expect(plans).toHaveLength(1);
    expect(plans[0]?.command).toBe("/fake/bin/codex");
    expect(plans[0]?.args[0]).toContain(payload.contextPath);
    // The launch replaces this process's stdio, so both paths have to be said
    // before it starts or they are never said at all.
    expect(notices.join("")).toContain(payload.contextPath);
    expect(notices.join("")).toContain(payload.playbookPath);
  });

  it("honours --provider and tells the truth when that one is missing", async () => {
    const spawnAgent = vi.fn(async () => 0);

    const { payload, exitCode } = await runTriageCommand(
      { agent: false, provider: "claude" },
      dependencies({
        spawnAgent,
        detectProviders: () => [
          { ...TRIAGE_PROVIDERS[1]!, path: "/fake/bin/codex" },
        ] as DetectedTriageProvider[],
      }),
    );

    expect(spawnAgent).not.toHaveBeenCalled();
    expect(exitCode).toBe(0);
    expect(payload.mode).toBe("no-provider");
    expect(payload.message).toContain("claude is not installed");
  });

  it("pastes the prompt into the notice for an agent that cannot take it on argv", async () => {
    const notices: string[] = [];

    const { payload } = await runTriageCommand(
      { agent: false, provider: "opencode" },
      dependencies({
        detectProviders: () => [
          { ...TRIAGE_PROVIDERS[3]!, path: "/fake/bin/opencode" },
        ] as DetectedTriageProvider[],
        spawnAgent: async () => 0,
        writeNotice: (text: string) => notices.push(text),
      }),
    );

    expect(payload.launched?.promptDelivered).toBe(false);
    expect(notices.join("")).toContain("Paste this in:");
    expect(notices.join("")).toContain(payload.playbookPath);
  });

  it("still produces the handoff when the doctor probe itself fails", async () => {
    const { payload, exitCode } = await runTriageCommand(
      { agent: true, provider: null },
      dependencies({
        runDoctor: async () => {
          throw new Error("runtime socket unavailable");
        },
      }),
    );

    expect(exitCode).toBe(0);
    expect(fs.readFileSync(payload.contextPath, "utf8"))
      .toContain("could not complete: runtime socket unavailable");
  });

  // The report reads files on the disk that may be the thing that is broken.
  // Losing it costs the log tails; taking the command down with it costs the
  // handoff, which is the entire product of `ade triage`.
  it("still produces the handoff when the diagnostic report cannot be collected", async () => {
    const { payload, exitCode } = await runTriageCommand(
      { agent: true, provider: null },
      dependencies({
        buildReport: async () => {
          throw new Error("EROFS: read-only file system, open '/Users/ada/.ade/logs/brain.jsonl'");
        },
      }),
    );

    expect(exitCode).toBe(0);
    const context = fs.readFileSync(payload.contextPath, "utf8");
    expect(context).toContain("could not be collected");
    expect(context).toContain("read-only file system");
    // The report carries the redaction rules; without it they are derived here,
    // so the failure message cannot become the one unredacted path in the file.
    expect(context).not.toContain("/Users/ada/.ade/logs");
    // The doctor rows still made it: one failed collector is not all of them.
    expect(context).toContain("| Brain |");
  });
});

describe("createTriageBundleDir", () => {
  it("names the directory for the run and never reuses one", () => {
    const root = tempDir("ade-triage-root-");
    const first = createTriageBundleDir(AT, root);
    const second = createTriageBundleDir(AT, root);

    expect(path.basename(first)).toMatch(/^ade-triage-2026-08-29T10-00-00-000Z-/);
    expect(first).not.toBe(second);
    expect(fs.statSync(first).isDirectory()).toBe(true);
  });
});
