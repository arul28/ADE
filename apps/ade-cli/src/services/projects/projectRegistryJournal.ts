/**
 * The record of changes to the project list (`projects.json`), and what an
 * error report says about it.
 *
 * Every write appends one line to `projects.journal.jsonl` beside the list:
 * time, pid, which program wrote (the desktop app, the brain, an `ade`
 * command), the operation, and the ids it added or removed. A record a read
 * had to drop, and an id that changed because its folder now resolves
 * differently, are lines too. A person debugging a project that vanished
 * reads it, and so does the report the brain sends when a caller names a
 * project it does not have (`projectRegistryDiagnosticFile`).
 */
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../../../../desktop/src/main/services/state/durableFile";
import { addSentryBreadcrumb, captureProblem } from "../../../../desktop/src/shared/sentry/capture";
import {
  DIAGNOSTIC_ATTACH_TAG,
  diagnosticEventText,
  type DiagnosticAttachment,
  type DiagnosticEvent,
} from "../../../../desktop/src/shared/sentry/diagnostics";
import { forwardLogToSentry } from "../../../../desktop/src/shared/sentry/logBridge";

/** The `diagnostic.attach` value that asks for the project list file. */
export const PROJECT_REGISTRY_ATTACH = "project_registry";

const JOURNAL_MAX_BYTES = 512 * 1024;
const JOURNAL_REPORT_CHARS = 64 * 1024;

type RecordRef = { projectId: string; rootPath: string };

export type ChangedProjectId = { storedId: string; projectId: string; storedRoot: string; rootPath: string };
export type DroppedProjectRecord = { storedId: string | null; storedRoot: string | null; reason: string };

/**
 * A guard that answers true the first time it sees a key, so a condition that
 * lasts (every read of the same file, every poll with the same id) is
 * reported once per process. Past `maxKeys` it answers false.
 */
export function createReportOnce(maxKeys = 200): (key: string) => boolean {
  const seen = new Set<string>();
  return (key) => {
    if (seen.has(key) || seen.size >= maxKeys) return false;
    seen.add(key);
    return true;
  };
}

let writer: string | null = null;

/** Which program this process is: `desktop-main`, `brain`, or the `ade` command it runs. */
export function registryWriter(): string {
  if (writer) return writer;
  const args = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
  writer = (process as { type?: string }).type === "browser"
    ? "desktop-main"
    : args[0] === "serve"
      ? "brain"
      : args.length > 0
        ? `cli ${args.slice(0, 2).join(" ")}`
        : path.basename(process.argv[1] ?? process.argv0 ?? "node");
  return writer;
}

export function registryJournalPath(projectsPath: string): string {
  return path.join(path.dirname(projectsPath), "projects.journal.jsonl");
}

/** Append one line; kept to the newest half once the file passes 512 KB. Never throws. */
export function appendJournalLine(journalPath: string, entry: Record<string, unknown>): void {
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, writer: registryWriter(), ...entry });
    fs.mkdirSync(path.dirname(journalPath), { recursive: true, mode: 0o700 });
    fs.appendFileSync(journalPath, `${line}\n`, { mode: 0o600 });
    if (fs.statSync(journalPath).size <= JOURNAL_MAX_BYTES) return;
    const text = fs.readFileSync(journalPath, "utf8");
    const keep = text.slice(text.length - Math.floor(JOURNAL_MAX_BYTES / 2));
    writeFileAtomic(journalPath, keep.slice(keep.indexOf("\n") + 1), { mode: 0o600 });
  } catch {
    // The journal is diagnostics; a failed append must not fail the write it records.
  }
}

function refsFor(records: readonly RecordRef[], ids: ReadonlySet<string>): RecordRef[] {
  return records
    .filter((record) => ids.has(record.projectId))
    .map((record) => ({ projectId: record.projectId, rootPath: record.rootPath }));
}

/** The journal line for one write to the list, and a breadcrumb when it removed a project. */
export function journalRegistryWrite(args: {
  journalPath: string;
  op: string;
  detail: Record<string, unknown>;
  before: readonly RecordRef[];
  after: readonly RecordRef[];
  lockWaitMs: number | null;
}): void {
  const beforeIds = new Set(args.before.map((record) => record.projectId));
  const afterIds = new Set(args.after.map((record) => record.projectId));
  const added = new Set([...afterIds].filter((id) => !beforeIds.has(id)));
  const removed = new Set([...beforeIds].filter((id) => !afterIds.has(id)));
  if (removed.size > 0) {
    addSentryBreadcrumb("project_registry", `project_registry.${args.op}`, { removed: [...removed], writer: registryWriter() }, "warning");
  }
  appendJournalLine(args.journalPath, {
    op: args.op,
    ...args.detail,
    count: { before: beforeIds.size, after: afterIds.size },
    ...(added.size > 0 ? { added: refsFor(args.after, added) } : {}),
    ...(removed.size > 0 ? { removed: refsFor(args.before, removed) } : {}),
    lockWaitMs: args.lockWaitMs,
  });
}

const reportIdChangeOnce = createReportOnce(500);
const reportDropOnce = createReportOnce(500);

/**
 * A project's id changed under every window and phone that holds the old one;
 * they get "Unknown projectId" from then on unless the alias catches it. One
 * issue per change per process, since this is the cause of that failure.
 */
export function reportChangedProjectIds(changes: readonly ChangedProjectId[], projectsPath: string): void {
  const journalPath = registryJournalPath(projectsPath);
  for (const change of changes) {
    if (!reportIdChangeOnce(`${change.storedId}>${change.projectId}`)) continue;
    const detail = { ...change, writer: registryWriter(), registryPath: projectsPath };
    forwardLogToSentry("warn", "project_registry.project_id_changed", detail);
    appendJournalLine(journalPath, { op: "id_changed", ...change });
    captureProblem("A registered project's id changed when its folder was resolved again", {
      fingerprint: ["project_registry", "project_id_changed"],
      tags: { [DIAGNOSTIC_ATTACH_TAG]: PROJECT_REGISTRY_ATTACH },
      extra: detail,
    });
  }
}

/**
 * A record the next write will not keep: the project disappears for every
 * window that knew it. A log line and a breadcrumb, not an issue, since a
 * duplicate is often the same folder registered twice on purpose.
 */
export function reportDroppedRecords(dropped: readonly DroppedProjectRecord[], projectsPath: string): void {
  const journalPath = registryJournalPath(projectsPath);
  for (const record of dropped) {
    if (!reportDropOnce(`${record.storedId ?? ""}|${record.storedRoot ?? ""}|${record.reason}`)) continue;
    forwardLogToSentry("warn", "project_registry.record_dropped", { ...record, registryPath: projectsPath, writer: registryWriter() });
    appendJournalLine(journalPath, { op: "record_dropped", ...record });
  }
}

/**
 * Whether the newest journal line about `projectId` is its removal: a window
 * or phone that still holds the id of a project the user removed is in an
 * ordinary state, not a failure.
 */
export function wasRemovedFromRegistry(projectsPath: string, projectId: string): boolean {
  try {
    const text = fs.readFileSync(registryJournalPath(projectsPath), "utf8");
    const lines = text.split("\n");
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]!;
      if (!line.includes(projectId)) continue;
      try {
        return (JSON.parse(line) as { op?: unknown }).op === "remove";
      } catch {
        // A line cut by the rotation; look further back.
      }
    }
  } catch {
    // No journal: an older ADE wrote the list.
  }
  return false;
}

function readOrCode(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    return `[${(error as NodeJS.ErrnoException).code ?? "unreadable"}]`;
  }
}

/** The list as it is now, its aliases, and the newest journal lines. */
function projectRegistryDiagnosticFile(paths: { projectsPath: string; aliasesPath: string }): DiagnosticAttachment {
  const journalPath = registryJournalPath(paths.projectsPath);
  const journal = readOrCode(journalPath);
  return {
    filename: "project-registry.txt",
    data: [
      `# ${paths.projectsPath}`,
      readOrCode(paths.projectsPath),
      `# ${paths.aliasesPath}`,
      readOrCode(paths.aliasesPath),
      `# ${journalPath} (newest last)`,
      journal.length > JOURNAL_REPORT_CHARS ? journal.slice(-JOURNAL_REPORT_CHARS) : journal,
    ].join("\n"),
  };
}

/**
 * The project list file for a report that is about it: one the registry or
 * the brain tagged, or any error that names an unknown project id (the
 * desktop's copy of the brain's answer). Every other report goes without it.
 */
export function projectRegistryDiagnosticAttachment(
  paths: { projectsPath: string; aliasesPath: string },
): (event: DiagnosticEvent) => DiagnosticAttachment | null {
  return (event) => {
    const asked = event.tags?.[DIAGNOSTIC_ATTACH_TAG] === PROJECT_REGISTRY_ATTACH;
    if (!asked && !/Unknown projectId/.test(diagnosticEventText(event))) return null;
    return projectRegistryDiagnosticFile(paths);
  };
}
