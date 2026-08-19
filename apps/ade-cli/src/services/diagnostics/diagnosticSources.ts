import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  LOG_TAIL_COMPACT_MAX_BYTES,
  LOG_TAIL_COMPACT_MAX_LINES,
  projectPathLabel,
  SERVICE_DEFINITION_MAX_BYTES,
  tailLogText,
  type DiagnosticLogTail,
  type DiagnosticRedactionContext,
  type DiagnosticVolumeSpace,
} from "./diagnosticReport";
import { resolveMachineAdeLayout } from "../projects/machineLayout";
import { resolveRuntimeServiceName } from "../../serviceManager/common";
import { launchAgentPath } from "../../serviceManager/installLaunchd";
import { servicePath as systemdUnitPath } from "../../serviceManager/installSystemd";
import {
  buildWindowsExportTaskArgs,
  resolveWindowsServiceLauncherPath,
  resolveWindowsSupervisorLogPath,
  resolveWindowsTaskName,
  windowsPowerShellCommand,
} from "../../serviceManager/installWindows";

/**
 * Everything a diagnostic report reads off this machine.
 *
 * `diagnosticReport.ts` renders and redacts; this reads. The desktop's
 * "Report issue" button and `ade report-issue` need the same logs, the same
 * volume pair and the same redaction context, and they had two copies of all
 * of it — so a log added to one report never appeared in the other.
 *
 * Electron-only inputs (`readVolumeSpace`, the desktop's own userData jsonl
 * logs, the typed last-failure store) stay in the desktop service and are
 * layered on top. Everything a headless box can read — both of the background
 * service's output streams, its service definition, and the project logs of
 * whichever project this machine used last — belongs HERE, so the desktop's
 * button and `ade report-issue --send` produce the same document.
 */

/** The reason a source is absent, in the two words the report renders. */
function unreadableReason(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
  return code === "ENOENT" ? "(not present)" : "(could not be read)";
}

/** Reads the last 512 KB of a file and tails it. Never throws. */
export function readLogTail(
  label: string,
  filePath: string,
  limits: { maxLines?: number; maxBytes?: number } = {},
): DiagnosticLogTail {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return { label, path: filePath, error: "(not a file)" };
    const readBytes = Math.min(stat.size, 512 * 1024);
    const handle = fs.openSync(filePath, "r");
    try {
      const buffer = Buffer.alloc(readBytes);
      fs.readSync(handle, buffer, 0, readBytes, Math.max(0, stat.size - readBytes));
      return { label, path: filePath, text: tailLogText(buffer.toString("utf8"), limits) };
    } finally {
      fs.closeSync(handle);
    }
  } catch (error) {
    return { label, path: filePath, error: unreadableReason(error) };
  }
}

/**
 * The first `maxBytes` of a file, for configuration rather than logs — see
 * {@link SERVICE_DEFINITION_MAX_BYTES} for why the front and not the tail.
 * Same never-throws contract as {@link readLogTail}: an absent file is a noted
 * absence in the report, never an error out of the collector.
 */
export function readFileHead(
  label: string,
  filePath: string,
  maxBytes: number = SERVICE_DEFINITION_MAX_BYTES,
): DiagnosticLogTail {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return { label, path: filePath, error: "(not a file)" };
    const readBytes = Math.min(stat.size, maxBytes);
    const handle = fs.openSync(filePath, "r");
    try {
      const buffer = Buffer.alloc(readBytes);
      fs.readSync(handle, buffer, 0, readBytes, 0);
      // A cut at `maxBytes` can land inside a multi-byte character, which
      // decodes to a trailing replacement char; drop it rather than ship a
      // glyph that looks like corruption in the file itself.
      const text = buffer.toString("utf8").replace(/�+$/, "");
      const truncated = stat.size > readBytes;
      return {
        label,
        path: filePath,
        text: truncated ? `${text}\n… (truncated: ${stat.size} bytes on disk)` : text,
      };
    } finally {
      fs.closeSync(handle);
    }
  } catch (error) {
    return { label, path: filePath, error: unreadableReason(error) };
  }
}

/**
 * Reads a definition that is not a file — journald's copy of the service's
 * output, a Windows scheduled task. Injected in tests; production shells out.
 *
 * Bounded and non-interactive by construction. This collector's whole premise
 * is that it works on a machine where ADE does not, so a command that could
 * block would defeat it.
 */
export type DiagnosticCommandRunner = (
  command: string,
  args: readonly string[],
) => { status: number | null; stdout: string } | null;

export function runDiagnosticCommand(
  command: string,
  args: readonly string[],
): { status: number | null; stdout: string } | null {
  try {
    const result = spawnSync(command, [...args], {
      encoding: "utf8",
      timeout: 4_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 2 * 1024 * 1024,
    });
    if (result.error) return null;
    return { status: result.status, stdout: typeof result.stdout === "string" ? result.stdout : "" };
  } catch {
    return null;
  }
}

/** A command's output as a report entry, with the same absence semantics. */
function readCommandOutput(
  label: string,
  display: string,
  command: string,
  args: readonly string[],
  run: DiagnosticCommandRunner,
  limits: { maxLines?: number; maxBytes?: number } = {},
): DiagnosticLogTail {
  const result = run(command, args);
  if (!result) return { label, path: display, error: "(could not be read)" };
  if (result.status !== 0) return { label, path: display, error: "(not present)" };
  return { label, path: display, text: tailLogText(result.stdout, limits) };
}

/** Parses a JSON file, or null for anything that is missing or malformed. */
export function readDiagnosticJsonFile(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  } catch {
    return null;
  }
}

/**
 * The most recently opened project on this machine, read straight out of
 * `~/.ade/projects.json`.
 *
 * Deliberately NOT through `ProjectRegistry`: that class migrates a legacy v1
 * file by writing it back and throws on a version it does not know, and a
 * diagnostic collector may do neither. It runs on a machine whose state is
 * already suspect, it must never be the thing that mutates it, and a registry
 * it cannot parse has to degrade to "no project" rather than take the report
 * down with it.
 *
 * Entries are considered newest-first and the first one that still has a
 * `.ade` directory wins, so a project the user deleted does not shadow the one
 * they are actually working in. `recent` entries are preferred over the
 * `system` ones ADE registers for itself, but a machine that only has `system`
 * entries still gets project logs rather than none.
 */
export function resolveMostRecentProjectRoot(projectsPath: string): string | null {
  const parsed = readDiagnosticJsonFile(projectsPath);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const projects = (parsed as { projects?: unknown }).projects;
  if (!Array.isArray(projects)) return null;

  const candidates: { root: string; lastOpenedAt: number; recent: boolean }[] = [];
  for (const entry of projects) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const root = typeof record.rootPath === "string" ? record.rootPath.trim() : "";
    if (!root) continue;
    const lastOpenedAt = typeof record.lastOpenedAt === "number" && Number.isFinite(record.lastOpenedAt)
      ? record.lastOpenedAt
      : 0;
    candidates.push({
      root,
      lastOpenedAt,
      // A v1 registry has no `catalogVisibility` at all; treating those as
      // recent keeps a machine that has not been migrated from looking empty.
      recent: record.catalogVisibility !== "system",
    });
  }
  candidates.sort((left, right) => {
    if (left.recent !== right.recent) return left.recent ? -1 : 1;
    return right.lastOpenedAt - left.lastOpenedAt;
  });

  for (const candidate of candidates) {
    try {
      if (fs.statSync(path.join(candidate.root, ".ade")).isDirectory()) return candidate.root;
    } catch {
      // Deleted, unmounted, or unreadable: try the next one.
    }
  }
  return null;
}

/** Free space via `statfs`. The desktop passes its own Electron-aware reader. */
export function readVolumeViaStatfs(label: string, dirPath: string): DiagnosticVolumeSpace | null {
  try {
    const stats = fs.statfsSync(dirPath, { bigint: true });
    return {
      label,
      path: dirPath,
      freeBytes: Number(stats.bavail * stats.bsize),
      totalBytes: Number(stats.blocks * stats.bsize),
    };
  } catch {
    return null;
  }
}

/** `os.userInfo()` throws when the uid has no passwd entry (slim containers). */
export function readOsUsername(): string | null {
  try {
    return os.userInfo().username;
  } catch {
    return null;
  }
}

/**
 * The one note every report carries: neither entry point starts the brain to
 * collect a report, because the machine where the brain will not start is
 * exactly where the report is needed.
 */
export const DIAGNOSTIC_COLLECTION_NOTES = [
  "doctor: not run (the report is collected without starting the background service)",
] as const;

export function diagnosticRedactionContext(
  projectRoot: string | null,
): DiagnosticRedactionContext {
  return {
    homeDir: os.homedir(),
    username: readOsUsername(),
    hostname: os.hostname(),
    // Only the project root is collapsed to a `<project:…>` label; the ADE
    // home is already reduced to `~/.ade` by the home-directory rule, and
    // labelling it would hide which channel's home this machine uses.
    projectRoots: projectRoot ? [projectRoot] : [],
  };
}

/** Tail caps for the two supporting project logs. */
const PROJECT_LOG_LIMITS = {
  maxLines: LOG_TAIL_COMPACT_MAX_LINES,
  maxBytes: LOG_TAIL_COMPACT_MAX_BYTES,
} as const;

/** The project's own `.ade/transcripts/logs`, per `resolveAdeLayout`. */
function projectLogsDir(projectRoot: string): string {
  return path.join(projectRoot, ".ade", "transcripts", "logs");
}

/**
 * How this machine's background service is defined, per platform.
 *
 * macOS and Linux keep it in one file. Windows keeps it in two — the generated
 * PowerShell launcher holds the environment and the command, and the scheduled
 * task holds what runs the launcher and as whom — so both are collected: a task
 * pointing at a launcher from an older channel is exactly the kind of drift
 * this section exists to make visible.
 */
function collectServiceDefinition(args: {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  homeDir: string;
  run: DiagnosticCommandRunner;
}): DiagnosticLogTail[] {
  const serviceName = resolveRuntimeServiceName(args.env);

  if (args.platform === "darwin") {
    return [readFileHead("launchd agent", launchAgentPath(args.homeDir, serviceName))];
  }
  if (args.platform === "win32") {
    const entries = [
      readFileHead(
        "Background service launcher",
        resolveWindowsServiceLauncherPath({ env: args.env, serviceName }),
      ),
    ];
    // Both the task name (which folds in the Windows user) and locating
    // PowerShell can throw on a broken box; neither may take the report with
    // it, and the reader still has to be told we looked.
    const task = (() => {
      try {
        const taskName = resolveWindowsTaskName({ serviceName });
        return {
          taskName,
          shell: windowsPowerShellCommand(),
          args: buildWindowsExportTaskArgs(taskName),
        };
      } catch {
        return null;
      }
    })();
    entries.push(
      task
        ? readCommandOutput(
          "Scheduled task",
          `Export-ScheduledTask -TaskName "${task.taskName}"`,
          task.shell,
          task.args,
          args.run,
          { maxBytes: SERVICE_DEFINITION_MAX_BYTES },
        )
        : {
          label: "Scheduled task",
          path: "Export-ScheduledTask",
          error: "(could not be read)",
        },
    );
    return entries;
  }
  return [readFileHead("systemd user unit", systemdUnitPath(args.homeDir, serviceName))];
}

/**
 * The service's own stdout and stderr — BOTH of them, wherever the platform
 * keeps them.
 *
 * Collecting only stderr is how a user ended up reading two decisive lines off
 * his own disk to us by hand: the early-startup lines that name the process
 * ADE actually booted (`deeplink.scheme_claimed`,
 * `deeplink.single_instance.lock_lost`) are written with `console.log` before
 * the structured logger exists, so they land in stdout and nowhere else.
 *
 * The three platforms keep those streams in three different places: launchd
 * splits them into two files, the Windows supervisor merges its own into one,
 * and systemd hands them to journald, which is not a file at all.
 */
function collectServiceOutputLogs(args: {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  homeDir: string;
  runtimeDir: string;
  run: DiagnosticCommandRunner;
}): DiagnosticLogTail[] {
  if (args.platform === "win32") {
    // One merged stream by construction: the supervisor appends its own lines
    // and the brain it starts inherits no redirection.
    return [
      readLogTail("Background service supervisor", resolveWindowsSupervisorLogPath({ env: args.env })),
    ];
  }
  if (args.platform === "darwin") {
    return [
      readLogTail("Background service (stderr)", path.join(args.runtimeDir, "launchd.err.log")),
      readLogTail("Background service (stdout)", path.join(args.runtimeDir, "launchd.out.log")),
    ];
  }
  const serviceName = resolveRuntimeServiceName(args.env);
  const unit = `${serviceName}.service`;
  const display = `journalctl --user-unit ${unit}`;
  // Gated on the unit file, so a machine that never installed the service is
  // never charged a subprocess to be told nothing — the definition section
  // already reports the missing unit, which is the more useful fact anyway.
  if (!fs.existsSync(systemdUnitPath(args.homeDir, serviceName))) {
    return [{ label: "Background service (journal)", path: display, error: "(not present)" }];
  }
  return [
    readCommandOutput(
      "Background service (journal)",
      display,
      "journalctl",
      ["--user-unit", unit, "--no-pager", "--lines", "200"],
      args.run,
    ),
  ];
}

export type MachineDiagnosticSourceOptions = {
  env?: NodeJS.ProcessEnv;
  projectRoot?: string | null;
  /** Test seams; production reads the real machine. */
  homeDir?: string;
  platform?: NodeJS.Platform;
  runCommand?: DiagnosticCommandRunner;
  /** Overridden by the desktop, which reads volumes through Electron's helper. */
  readVolume?: (label: string, dirPath: string) => DiagnosticVolumeSpace | null;
};

export type MachineDiagnosticSources = {
  layout: ReturnType<typeof resolveMachineAdeLayout>;
  logs: DiagnosticLogTail[];
  /** The launchd plist / systemd unit / Windows launcher + scheduled task. */
  serviceDefinition: DiagnosticLogTail[];
  storage: DiagnosticVolumeSpace[];
  state: {
    machineLastFailure: unknown;
    projectLastFailure: unknown;
    lastWedge: unknown;
  };
  /**
   * The project whose logs and state this report carries: the caller's open
   * project, else the most recently opened one on the machine. Callers that
   * layer their own project-scoped sources on top must key them off THIS, or a
   * report with no project open silently mixes two projects.
   */
  projectRoot: string | null;
  /** True when {@link projectRoot} is the fallback rather than an open project. */
  projectRootIsFallback: boolean;
  notes: string[];
  redaction: DiagnosticRedactionContext;
};

export function collectMachineDiagnosticSources(
  options: MachineDiagnosticSourceOptions = {},
): MachineDiagnosticSources {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? os.homedir();
  const run = options.runCommand ?? runDiagnosticCommand;
  const openProjectRoot = options.projectRoot?.trim() || null;
  const layout = resolveMachineAdeLayout(env);
  const readVolume = options.readVolume ?? readVolumeViaStatfs;

  // A report is worth least on the machine where nothing is open, which is
  // exactly the machine that cannot open anything. `main.jsonl` carries the
  // machine-level events — the CLI auto-install outcome among them — so a
  // report that omits it because no window happens to be showing a project is
  // missing evidence that was on disk the whole time.
  const fallbackProjectRoot = openProjectRoot
    ? null
    : resolveMostRecentProjectRoot(layout.projectsPath);
  const projectRoot = openProjectRoot ?? fallbackProjectRoot;

  const logs: DiagnosticLogTail[] = [
    ...collectServiceOutputLogs({ env, platform, homeDir, runtimeDir: layout.runtimeDir, run }),
    readLogTail("Brain", path.join(layout.runtimeDir, "brain.jsonl")),
  ];
  if (projectRoot) {
    const logsDir = projectLogsDir(projectRoot);
    logs.push(readLogTail("Desktop main", path.join(logsDir, "main.jsonl"), PROJECT_LOG_LIMITS));
    logs.push(readLogTail("ADE CLI", path.join(logsDir, "ade-cli.jsonl"), PROJECT_LOG_LIMITS));
  }

  const storage = [
    readVolume("ADE home", layout.adeDir),
    projectRoot ? readVolume("Project", projectRoot) : null,
  ].filter((entry): entry is DiagnosticVolumeSpace => entry != null);

  const notes: string[] = [...DIAGNOSTIC_COLLECTION_NOTES];
  if (fallbackProjectRoot) {
    notes.push(
      `project logs: no project was open, so the most recently opened project on this machine was used (${projectPathLabel(fallbackProjectRoot)})`,
    );
  } else if (!projectRoot) {
    notes.push("project logs: no project is registered on this machine, so none were collected");
  }

  return {
    layout,
    logs,
    serviceDefinition: collectServiceDefinition({ env, platform, homeDir, run }),
    storage,
    state: {
      machineLastFailure: readDiagnosticJsonFile(path.join(layout.runtimeDir, "last-failure.json")),
      projectLastFailure: projectRoot
        ? readDiagnosticJsonFile(path.join(projectRoot, ".ade", "runtime", "last-failure.json"))
        : null,
      lastWedge: readDiagnosticJsonFile(path.join(layout.runtimeDir, "last-wedge.json")),
    },
    projectRoot,
    projectRootIsFallback: fallbackProjectRoot != null,
    notes,
    redaction: diagnosticRedactionContext(projectRoot),
  };
}
