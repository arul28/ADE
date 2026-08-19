import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDiagnosticReport } from "./diagnosticReport";
import {
  collectMachineDiagnosticSources,
  collectMachineDiagnosticSourcesAsync,
  readFileHead,
  resolveMostRecentProjectRoot,
  type DiagnosticCommandRunner,
} from "./diagnosticSources";

/**
 * These cover the sources a report was missing when a user's decisive evidence
 * turned out to be two lines in a file the collector never read: the background
 * service's *stdout* stream, the service definition that says what the runtime
 * was told to be, and the project logs — which used to require a project to be
 * open on a machine where nothing opens.
 */

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A machine home with a runtime directory, and nothing else by default. */
function machineHome(): { home: string; adeDir: string; runtimeDir: string } {
  const home = tempDir("ade-diag-home-");
  const adeDir = path.join(home, ".ade");
  const runtimeDir = path.join(adeDir, "runtime");
  fs.mkdirSync(runtimeDir, { recursive: true });
  return { home, adeDir, runtimeDir };
}

/** A project with the two logs a report cares about. */
function project(home: string, name: string, logs: Record<string, string> = {}): string {
  const root = path.join(home, name);
  const logsDir = path.join(root, ".ade", "transcripts", "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  for (const [file, contents] of Object.entries(logs)) {
    fs.writeFileSync(path.join(logsDir, file), contents, "utf8");
  }
  return root;
}

/** The unit file whose presence gates the journald query. */
function writeSystemdUnit(home: string, contents = "[Service]\nExecStart=/usr/bin/ade serve\n"): string {
  const unitDir = path.join(home, ".config", "systemd", "user");
  fs.mkdirSync(unitDir, { recursive: true });
  const unitPath = path.join(unitDir, "com.ade.runtime.service");
  fs.writeFileSync(unitPath, contents, "utf8");
  return unitPath;
}

function writeRegistry(adeDir: string, projects: unknown[]): void {
  fs.mkdirSync(adeDir, { recursive: true });
  fs.writeFileSync(
    path.join(adeDir, "projects.json"),
    JSON.stringify({ version: 2, projects }, null, 2),
    "utf8",
  );
}

/** Refuses to run anything: proves a path does not depend on a subprocess. */
const noCommands: DiagnosticCommandRunner = () => null;

function collect(args: {
  home: string;
  platform?: NodeJS.Platform;
  projectRoot?: string | null;
  runCommand?: DiagnosticCommandRunner;
}) {
  return collectMachineDiagnosticSources({
    env: { ADE_HOME: path.join(args.home, ".ade") },
    homeDir: args.home,
    platform: args.platform ?? "darwin",
    projectRoot: args.projectRoot ?? null,
    runCommand: args.runCommand ?? noCommands,
    // statfs on a temp dir is real and slow-ish; the figures are not under test.
    readVolume: () => null,
  });
}

describe("collectMachineDiagnosticSources — service output streams", () => {
  it("collects launchd stdout as well as stderr", () => {
    // The regression this exists for: the early-startup lines that name which
    // process ADE actually booted are written with `console.log` before the
    // structured logger exists, so they land in stdout and NOWHERE else.
    const { home, runtimeDir } = machineHome();
    fs.writeFileSync(path.join(runtimeDir, "launchd.err.log"), "boom\n", "utf8");
    fs.writeFileSync(
      path.join(runtimeDir, "launchd.out.log"),
      "[main] deeplink.scheme_claimed\n[main] deeplink.single_instance.lock_lost\n",
      "utf8",
    );

    const { logs } = collect({ home });
    const stdout = logs.find((log) => log.label === "Background service (stdout)");

    expect(stdout?.text).toContain("deeplink.single_instance.lock_lost");
    expect(logs.find((log) => log.label === "Background service (stderr)")?.text).toContain("boom");
  });

  it("notes an absent stdout stream instead of failing", () => {
    const { home, runtimeDir } = machineHome();
    fs.writeFileSync(path.join(runtimeDir, "launchd.err.log"), "boom\n", "utf8");

    const stdout = collect({ home }).logs.find(
      (log) => log.label === "Background service (stdout)",
    );

    expect(stdout?.error).toBe("(not present)");
    expect(stdout?.text).toBeUndefined();
  });

  it("reads the Windows supervisor log, which already merges both streams", () => {
    const { home } = machineHome();

    const { logs } = collect({ home, platform: "win32" });

    expect(logs.map((log) => log.label)).toContain("Background service supervisor");
    // No launchd paths on a platform that has no launchd: a report claiming to
    // have looked at `launchd.err.log` on Windows is worse than one that did not.
    expect(logs.some((log) => log.path.includes("launchd"))).toBe(false);
  });

  it("asks journald for the service's output on Linux, where there is no file", () => {
    const { home } = machineHome();
    writeSystemdUnit(home);
    const run = vi.fn((_command: string, _args: readonly string[]) => ({
      status: 0,
      stdout: "Aug 19 12:00:00 host ade[1]: brain.started\n",
    }));

    const journal = collect({ home, platform: "linux", runCommand: run }).logs.find(
      (log) => log.label === "Background service (journal)",
    );

    expect(journal?.text).toContain("brain.started");
    expect(run).toHaveBeenCalledWith(
      "journalctl",
      expect.arrayContaining(["--user-unit", "com.ade.runtime.service", "--no-pager"]),
    );
  });

  it("degrades to a noted absence when journalctl is not installed", () => {
    const { home } = machineHome();
    writeSystemdUnit(home);

    const journal = collect({ home, platform: "linux", runCommand: () => null }).logs.find(
      (log) => log.label === "Background service (journal)",
    );

    expect(journal?.error).toBe("(could not be read)");
  });

  it("does not spawn journalctl at all when no unit is installed", () => {
    const { home } = machineHome();
    const run = vi.fn((_command: string, _args: readonly string[]) => ({ status: 0, stdout: "" }));

    const journal = collect({ home, platform: "linux", runCommand: run }).logs.find(
      (log) => log.label === "Background service (journal)",
    );

    expect(run).not.toHaveBeenCalled();
    expect(journal?.error).toBe("(not present)");
  });
});

/**
 * The same report, gathered without stopping the process that asks for it.
 *
 * These commands are the only part of the collection that can take seconds — a
 * PowerShell `Export-ScheduledTask`, a `journalctl` — and the desktop runs the
 * collection on Electron's main process, where a synchronous spawn freezes
 * every window and every IPC call for the duration.
 */
describe("collectMachineDiagnosticSourcesAsync", () => {
  function collectAsync(args: {
    home: string;
    platform?: NodeJS.Platform;
    runCommandAsync?: (
      command: string,
      commandArgs: readonly string[],
    ) => Promise<{ status: number | null; stdout: string } | null>;
  }) {
    return collectMachineDiagnosticSourcesAsync({
      env: { ADE_HOME: path.join(args.home, ".ade") },
      homeDir: args.home,
      platform: args.platform ?? "darwin",
      projectRoot: null,
      readVolume: () => null,
      runCommandAsync: args.runCommandAsync
        ?? (async () => {
          throw new Error("no command was expected");
        }),
    });
  }

  it("renders a command's output from the answer it awaited, not a blocking spawn", async () => {
    const { home } = machineHome();
    writeSystemdUnit(home);
    const run = vi.fn(async (_command: string, _args: readonly string[]) => ({
      status: 0,
      stdout: "Aug 19 12:00:00 host ade[1]: brain.started\n",
    }));

    const sources = await collectAsync({ home, platform: "linux", runCommandAsync: run });
    const journal = sources.logs.find((log) => log.label === "Background service (journal)");

    // The prefetch and the collector have to agree on the exact command, or the
    // report would say "(could not be read)" about a source that read fine.
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(
      "journalctl",
      ["--user-unit", "com.ade.runtime.service", "--no-pager", "--lines", "200"],
    );
    expect(journal?.text).toContain("brain.started");
  });

  it("runs the Windows scheduled-task export ahead of the collection", async () => {
    const { home } = machineHome();
    const run = vi.fn(async (_command: string, _args: readonly string[]) => ({
      status: 0,
      stdout: "<Task><Actions><Exec><Command>powershell.exe</Command></Exec></Actions></Task>",
    }));

    const sources = await collectAsync({ home, platform: "win32", runCommandAsync: run });

    expect(run).toHaveBeenCalledTimes(1);
    expect(sources.serviceDefinition[1]?.text).toContain("<Command>powershell.exe</Command>");
  });

  it("spawns nothing on a platform or a machine with no command to run", async () => {
    // macOS keeps every source in a file, and a Linux box with no unit
    // installed has nothing to ask journald about. Either way the collection
    // must not pay for a subprocess — the seam above throws if one is started.
    const darwin = machineHome();
    await expect(collectAsync({ home: darwin.home })).resolves.toBeTruthy();

    const linux = machineHome();
    const sources = await collectAsync({ home: linux.home, platform: "linux" });
    expect(sources.logs.find((log) => log.label === "Background service (journal)")?.error)
      .toBe("(not present)");
  });

  it("degrades to a noted absence when the prefetched command could not run", async () => {
    const { home } = machineHome();
    writeSystemdUnit(home);

    const sources = await collectAsync({
      home,
      platform: "linux",
      runCommandAsync: async () => null,
    });

    expect(sources.logs.find((log) => log.label === "Background service (journal)")?.error)
      .toBe("(could not be read)");
  });
});

describe("collectMachineDiagnosticSources — service definition", () => {
  it("collects the launchd plist, from the front", () => {
    const { home } = machineHome();
    const agents = path.join(home, "Library", "LaunchAgents");
    fs.mkdirSync(agents, { recursive: true });
    fs.writeFileSync(
      path.join(agents, "com.ade.runtime.plist"),
      "<plist><key>ELECTRON_RUN_AS_NODE</key><string>1</string></plist>\n",
      "utf8",
    );

    const definition = collect({ home }).serviceDefinition;

    expect(definition).toHaveLength(1);
    expect(definition[0]?.label).toBe("launchd agent");
    // The whole reason this section exists: a plist written without it boots the
    // desktop app as the background service.
    expect(definition[0]?.text).toContain("ELECTRON_RUN_AS_NODE");
  });

  it("follows the channel's service name rather than the frozen default", () => {
    const { home } = machineHome();
    const agents = path.join(home, "Library", "LaunchAgents");
    fs.mkdirSync(agents, { recursive: true });
    fs.writeFileSync(path.join(agents, "com.ade.runtime.beta.plist"), "<plist/>\n", "utf8");

    const definition = collectMachineDiagnosticSources({
      env: { ADE_HOME: path.join(home, ".ade"), ADE_PACKAGE_CHANNEL: "beta" },
      homeDir: home,
      platform: "darwin",
      runCommand: noCommands,
      readVolume: () => null,
    }).serviceDefinition;

    expect(definition[0]?.path).toContain("com.ade.runtime.beta.plist");
    expect(definition[0]?.text).toContain("<plist/>");
  });

  it("notes a missing plist rather than throwing", () => {
    const { home } = machineHome();

    const definition = collect({ home }).serviceDefinition;

    expect(definition[0]?.error).toBe("(not present)");
  });

  it("reads the systemd unit on Linux", () => {
    const { home } = machineHome();
    writeSystemdUnit(home);

    const definition = collect({ home, platform: "linux" }).serviceDefinition;

    expect(definition[0]?.label).toBe("systemd user unit");
    expect(definition[0]?.text).toContain("ExecStart=");
  });

  it("reads both halves of the Windows definition — launcher and scheduled task", () => {
    const { home } = machineHome();
    const run = vi.fn((_command: string, _args: readonly string[]) => ({
      status: 0,
      stdout: "<Task><Actions><Exec><Command>powershell.exe</Command></Exec></Actions></Task>",
    }));

    const definition = collect({ home, platform: "win32", runCommand: run }).serviceDefinition;

    expect(definition.map((entry) => entry.label)).toEqual([
      "Background service launcher",
      "Scheduled task",
    ]);
    expect(definition[1]?.text).toContain("<Command>powershell.exe</Command>");
  });

  it("notes an unreadable scheduled task without failing the report", () => {
    const { home } = machineHome();

    const definition = collect({ home, platform: "win32", runCommand: () => null }).serviceDefinition;

    expect(definition[1]?.error).toBe("(could not be read)");
    expect(definition[0]?.error).toBe("(not present)");
  });

  it("marks a definition that was truncated, so a short read is not read as a short file", () => {
    const dir = tempDir("ade-diag-head-");
    const file = path.join(dir, "big.ps1");
    fs.writeFileSync(file, "x".repeat(200), "utf8");

    const entry = readFileHead("launcher", file, 50);

    expect(entry.text?.startsWith("x".repeat(50))).toBe(true);
    expect(entry.text).toContain("truncated: 200 bytes on disk");
  });
});

describe("collectMachineDiagnosticSources — project logs with no project open", () => {
  it("falls back to the most recently opened project and says that it did", () => {
    const { home, adeDir } = machineHome();
    const stale = project(home, "stale", { "main.jsonl": '{"event":"old"}\n' });
    const recent = project(home, "recent", {
      "main.jsonl": '{"event":"ade_cli.auto_install"}\n',
      "ade-cli.jsonl": '{"event":"cli.started"}\n',
    });
    writeRegistry(adeDir, [
      { rootPath: stale, lastOpenedAt: 1_000, catalogVisibility: "recent" },
      { rootPath: recent, lastOpenedAt: 9_000, catalogVisibility: "recent" },
    ]);

    const sources = collect({ home, projectRoot: null });

    expect(sources.projectRoot).toBe(recent);
    expect(sources.projectRootIsFallback).toBe(true);
    // The machine-level event that was unreachable without a project open.
    expect(sources.logs.find((log) => log.label === "Desktop main (project)")?.text).toContain(
      "ade_cli.auto_install",
    );
    expect(sources.logs.find((log) => log.label === "ADE CLI")?.text).toContain("cli.started");
    // An absence the reader was never told about is worse than no fallback.
    expect(sources.notes.join("\n")).toContain("no project was open");
  });

  it("prefers the open project and does not mark it as a fallback", () => {
    const { home, adeDir } = machineHome();
    const other = project(home, "other", { "main.jsonl": '{"event":"other"}\n' });
    const open = project(home, "open", { "main.jsonl": '{"event":"open"}\n' });
    writeRegistry(adeDir, [{ rootPath: other, lastOpenedAt: 9_000, catalogVisibility: "recent" }]);

    const sources = collect({ home, projectRoot: open });

    expect(sources.projectRoot).toBe(open);
    expect(sources.projectRootIsFallback).toBe(false);
    expect(sources.logs.find((log) => log.label === "Desktop main (project)")?.text).toContain('"open"');
    expect(sources.notes.join("\n")).not.toContain("no project was open");
  });

  it("skips a registered project whose directory is gone", () => {
    const { home, adeDir } = machineHome();
    const alive = project(home, "alive", { "main.jsonl": '{"event":"alive"}\n' });
    writeRegistry(adeDir, [
      { rootPath: path.join(home, "deleted"), lastOpenedAt: 9_999, catalogVisibility: "recent" },
      { rootPath: alive, lastOpenedAt: 1, catalogVisibility: "recent" },
    ]);

    expect(collect({ home }).projectRoot).toBe(alive);
  });

  it("says so when the machine has no project at all", () => {
    const { home } = machineHome();

    const sources = collect({ home });

    expect(sources.projectRoot).toBeNull();
    expect(sources.notes.join("\n")).toContain("no project is registered");
    expect(sources.logs.map((log) => log.label)).not.toContain("Desktop main (project)");
  });

  // The fallback above is a mitigation: it still needs SOME project to have
  // been opened, and to guess the right one. The machine log needs neither.
  it("carries the desktop's machine log with no project on the machine at all", () => {
    const { home, runtimeDir } = machineHome();
    fs.writeFileSync(
      path.join(runtimeDir, "desktop-main.jsonl"),
      '{"event":"desktop.main_started"}\n{"event":"ade_cli.auto_install"}\n',
      "utf8",
    );

    const sources = collect({ home });

    expect(sources.projectRoot).toBeNull();
    const machineLog = sources.logs.find((log) => log.label === "Desktop main (machine)");
    expect(machineLog?.text).toContain("desktop.main_started");
    // The machine-scoped fact that used to be filed under whichever project
    // happened to open, and was therefore unreachable from a report like this.
    expect(machineLog?.text).toContain("ade_cli.auto_install");
  });

  it("notes an absent machine log rather than omitting the section", () => {
    const { home } = machineHome();

    const machineLog = collect({ home }).logs.find(
      (log) => log.label === "Desktop main (machine)",
    );

    expect(machineLog?.error).toBe("(not present)");
  });

  it("never writes to or throws on a registry it cannot understand", () => {
    // `ProjectRegistry` migrates a v1 file by writing it back and throws on an
    // unknown version. A collector that runs on a damaged machine may do
    // neither: the report is the last thing that still works there.
    const { home, adeDir } = machineHome();
    const registryPath = path.join(adeDir, "projects.json");
    fs.mkdirSync(adeDir, { recursive: true });
    fs.writeFileSync(registryPath, '{"version":99,"projects":[', "utf8");
    const before = fs.readFileSync(registryPath, "utf8");

    expect(() => collect({ home })).not.toThrow();
    expect(collect({ home }).projectRoot).toBeNull();
    expect(fs.readFileSync(registryPath, "utf8")).toBe(before);
  });

  it("treats a legacy v1 record with no visibility as usable", () => {
    const { home, adeDir } = machineHome();
    const root = project(home, "legacy", { "main.jsonl": '{"event":"legacy"}\n' });
    fs.writeFileSync(
      path.join(adeDir, "projects.json"),
      JSON.stringify({ version: 1, projects: [{ rootPath: root }] }),
      "utf8",
    );

    expect(resolveMostRecentProjectRoot(path.join(adeDir, "projects.json"))).toBe(root);
  });

  it("prefers a recent entry over a system one even when the system one is newer", () => {
    const { home, adeDir } = machineHome();
    const system = project(home, "system", {});
    const recent = project(home, "recent", {});
    writeRegistry(adeDir, [
      { rootPath: system, lastOpenedAt: 9_999, catalogVisibility: "system" },
      { rootPath: recent, lastOpenedAt: 1, catalogVisibility: "recent" },
    ]);

    expect(resolveMostRecentProjectRoot(path.join(adeDir, "projects.json"))).toBe(recent);
  });
});

describe("the new sources go through redaction", () => {
  it("redacts a token and the user's home out of the service definition", () => {
    const { home } = machineHome();
    const agents = path.join(home, "Library", "LaunchAgents");
    fs.mkdirSync(agents, { recursive: true });
    // Assembled from segments so the working tree never carries a
    // secret-shaped literal (same convention as diagnosticReport.test.ts).
    const fakeKey = ["sk", "live", "abcdefghijklmnopqrstuvwxyz012345"].join("-");
    fs.writeFileSync(
      path.join(agents, "com.ade.runtime.plist"),
      [
        "<plist><dict>",
        "<key>ANTHROPIC_API_KEY</key>",
        `<string>${fakeKey}</string>`,
        "<key>ADE_HOME</key>",
        `<string>${path.join(home, ".ade")}</string>`,
        "</dict></plist>",
      ].join("\n"),
      "utf8",
    );
    const sources = collect({ home });

    const report = buildDiagnosticReport({
      generatedAt: "2026-08-19T00:00:00.000Z",
      app: { version: "1.2.61", platform: "darwin", arch: "arm64" },
      identity: { installId: "ade_test" },
      context: { surface: "cli" },
      serviceDefinition: sources.serviceDefinition,
      logs: sources.logs,
      notes: sources.notes,
      redaction: { ...sources.redaction, homeDir: home, username: "ada" },
    });

    expect(report).toContain("## Background service definition");
    expect(report).not.toContain(fakeKey);
    expect(report).toContain("<token>");
    expect(report).not.toContain(home);
  });

  it("redacts the fallback project's path out of the log tails it added", () => {
    const { home, adeDir } = machineHome();
    const root = project(home, "photon", {
      "main.jsonl": '{"event":"open_failed","projectRoot":"__ROOT__"}\n',
    });
    fs.writeFileSync(
      path.join(root, ".ade", "transcripts", "logs", "main.jsonl"),
      `{"event":"open_failed","projectRoot":"${root}"}\n`,
      "utf8",
    );
    writeRegistry(adeDir, [{ rootPath: root, lastOpenedAt: 5, catalogVisibility: "recent" }]);
    const sources = collect({ home });

    const report = buildDiagnosticReport({
      generatedAt: "2026-08-19T00:00:00.000Z",
      app: { version: "1.2.61", platform: "darwin", arch: "arm64" },
      identity: { installId: "ade_test" },
      // No project open: the fallback root reaches the report only through the
      // collector's redaction context, so if that is not wired the project's
      // absolute path ships in a document the user pastes into a public issue.
      context: { surface: "cli", projectRoot: null },
      logs: sources.logs,
      redaction: { ...sources.redaction, homeDir: home },
    });

    expect(report).toContain("open_failed");
    expect(report).not.toContain(root);
    expect(report).toContain("<project:photon#");
  });
});
