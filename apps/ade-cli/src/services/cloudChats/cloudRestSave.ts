/**
 * The save an ADE Cloud computer makes before it rests (sleeps, stops or is
 * deleted), so every client can read the lane with no computer awake:
 *
 * 1. The saved chat copies get their last parts (`uploadPendingCloudChats`).
 * 2. Copies of shells and agent CLIs (`PUT /cloud/sessions/:m/:s`): a shell's
 *    last `CLOUD_SESSION_MAX_LINES` lines as text, a CLI's stored terminal
 *    screen (xterm), the `CLOUD_SESSION_MAX_PER_COMPUTER` newest. A copy
 *    whose terminal wrote nothing since the last save is not sent again.
 * 3. A Git summary per lane (`PUT /cloud/git/:m/:lane`), sent only when it
 *    changed.
 * 0. A backup of each lane's work that is not on GitHub yet
 *    (`cloudLaneBackup.ts`), then a report of every lane's state, which a
 *    cleanup reads to delete the computer with no wake. Before the copies:
 *    code is what a person needs back most.
 * 4. With `capsules` (the delete path only): a
 *    fork capsule per chat and agent CLI whose provider has its own history
 *    (Claude, Codex, OpenCode chats; Claude Code and Codex CLIs). A new
 *    computer restores the chat from it with the same chat id. Every other
 *    provider needs none: the restore replays the saved transcript.
 *
 * Only projects whose runtime is open count: a project nobody opened since
 * boot has no new terminal output and no new chat turns.
 *
 * Runs at the idle step (`cloudKeepAwake` `saveForRest`, no capsules), in
 * `prepare-stop`, and as `ade cloud save-for-rest [--capsules] --json`.
 * Text is redacted (`redactSecrets`) before it leaves the computer, and no
 * log line names a chat's text, a lane name or a path.
 */

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import type {
  CloudGitChangedFile,
  CloudGitSummaryInput,
  CloudSaveForRestReport,
  CloudSessionRowInput,
} from "../../../../account-directory/src/cloud/contract";
import {
  CLOUD_CAPSULE_MAX_BYTES,
  CLOUD_CAPSULE_MAX_PART_BYTES,
  CLOUD_GIT_MAX_CHANGED,
  CLOUD_SESSION_MAX_BYTES,
  CLOUD_SESSION_MAX_LINES,
  CLOUD_SESSION_MAX_PER_COMPUTER,
} from "../../../../account-directory/src/cloud/contract";
import type { CloudApiClient } from "../../../../desktop/src/shared/cloudApiClient";
import { normalizeGitRemoteIdentity } from "../../../../desktop/src/shared/crossMachineHandoff";
import { isChatToolType } from "../../../../desktop/src/shared/sessionSpawnNesting";
import { isTrackedAgentCliToolType, type TerminalSessionSummary } from "../../../../desktop/src/shared/types/sessions";
import { readGitOriginUrl } from "../../../../desktop/src/main/services/projects/recentProjectSummary";
import { redactSecrets } from "../../../../desktop/src/main/services/shared/utils";
import type { AdeRuntime } from "../../bootstrap";
import type { CloudChatUploadPendingResult } from "./cloudChatUploader";
import { runLaneBackups, type BackupLane } from "./cloudLaneBackup";

type Logger = {
  info: (event: string, meta?: Record<string, unknown>) => void;
  warn: (event: string, meta?: Record<string, unknown>) => void;
};

/** Uploads at once, across copies, summaries and capsule parts. */
const UPLOAD_PARALLEL = 4;
/** A shell's tail is read at most this large before it is cut to its last lines. */
const SHELL_TAIL_READ_BYTES = 4 * 1024 * 1024;
/** Chat providers whose own history travels in a capsule (CONTRACTS §8). */
const CAPSULE_CHAT_PROVIDERS: ReadonlySet<string> = new Set(["claude", "codex", "opencode"]);
/** CLI tool types whose conversation travels in a capsule. */
const CAPSULE_CLI_TOOLS: ReadonlySet<string> = new Set(["claude", "codex"]);
const GIT_TIMEOUT_MS = 15_000;
const STATE_FILE = "rest-save.json";

export type CloudRestSaveOptions = {
  /** Fork capsules too (the delete path, after prepare-stop). */
  capsules: boolean;
  /**
   * Time for the whole save, counted from the call: a save that waits behind
   * an earlier one has that much less. Work not started by then waits for the
   * next save.
   */
  budgetMs: number;
  reason: string;
  /** The idle step: false once someone used the computer, so the save stops early. */
  stillIdle?: () => boolean;
};

export type CloudRestSaveDeps = {
  adeHome: string;
  instanceId: string;
  logger: Logger;
  api: () => Promise<CloudApiClient | null>;
  machineKey: () => string | null;
  /** The runtimes open now, with the registry's project id; a project not open has nothing new to save. */
  openRuntimes: () => Promise<Array<{ projectId: string; runtime: AdeRuntime }>>;
  /** Every project's pending chat parts (`uploadPendingCloudChats`). */
  flushChats: (timeoutMs: number) => Promise<CloudChatUploadPendingResult>;
  /** The signed-in account's user id: an account topic names it. */
  accountUserId: () => string | null;
  /**
   * One native subagent's saved copy, as a chat row under its parent
   * (`uploadSubagentCloudCopy`). Left out, no subagent is saved.
   */
  uploadSubagentCopy?: (parentSessionId: string, copy: { chatId: string; text: string; title: string | null; lastActivityAt: string | null }) => Promise<boolean>;
  /** Every lane on the computer for its backup (`cloudLaneBackup.ts`). Left out, no backup is made. */
  backupLanes?: () => Promise<{ complete: boolean; lanes: BackupLane[] }>;
};

export type CloudRestSave = {
  /** One save. Saves run one after another, never two at once. */
  save: (options: CloudRestSaveOptions) => Promise<CloudSaveForRestReport>;
};

type RestSaveState = {
  v: 1;
  machineKey: string | null;
  /** Session id → what was saved (the terminal's write offset, and the screen file's time for a CLI). */
  sessions: Record<string, string>;
  /** Lane id → hash of the summary saved. */
  git: Record<string, string>;
  /** Chat or CLI id → the activity mark its capsule was made at. */
  capsules: Record<string, string>;
  /** The event-wake topics the server holds for this computer, sorted; null before the first write. */
  eventWakes?: string[] | null;
  /** Subagent copy id → the mark of what was saved (message count and last message id). */
  subagents?: Record<string, string>;
  /** Parent chat id → the activity mark its subagents were last read at. */
  subagentScans?: Record<string, string>;
};

const emptyState = (machineKey: string | null): RestSaveState => ({ v: 1, machineKey, sessions: {}, git: {}, capsules: {}, eventWakes: null });

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Splits a capsule into its parts: each at most `partBytes`, in order, and
 * none empty. Null when the capsule is over `maxBytes` (it is not saved; the
 * restore replays the saved transcript).
 */
export function splitCapsule(bytes: Uint8Array, partBytes: number = CLOUD_CAPSULE_MAX_PART_BYTES, maxBytes: number = CLOUD_CAPSULE_MAX_BYTES): Uint8Array[] | null {
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes || partBytes <= 0) return null;
  const parts: Uint8Array[] = [];
  for (let start = 0; start < bytes.byteLength; start += partBytes) {
    parts.push(bytes.subarray(start, Math.min(bytes.byteLength, start + partBytes)));
  }
  return parts;
}

/** The last `maxLines` lines of `text`, then cut from the front to `maxBytes`. */
export function lastLines(text: string, maxLines: number, maxBytes: number): { text: string; lineCount: number } {
  let lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  if (lines.length > maxLines) lines = lines.slice(lines.length - maxLines);
  let out = lines.join("\n");
  while (Buffer.byteLength(out, "utf8") > maxBytes && lines.length > 1) {
    // Drop about the share of lines that is over, at least one.
    const over = Buffer.byteLength(out, "utf8") - maxBytes;
    const drop = Math.max(1, Math.floor((lines.length * over) / Buffer.byteLength(out, "utf8")));
    lines = lines.slice(drop);
    out = lines.join("\n");
  }
  if (Buffer.byteLength(out, "utf8") > maxBytes) {
    out = Buffer.from(out, "utf8").subarray(-maxBytes).toString("utf8");
  }
  return { text: out, lineCount: lines.length };
}

function runGit(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    execFile("git", args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      // A status read takes no index lock, so it never blocks an agent's own git.
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
    }, (error, stdout) => resolve({ ok: !error, stdout: String(stdout ?? "") }));
  });
}

/** One porcelain v2 status letter: the index's change, else the worktree's. */
function statusLetter(xy: string): string {
  const x = xy[0] ?? ".";
  const y = xy[1] ?? ".";
  return x !== "." ? x : y !== "." ? y : "M";
}

/** A lane's Git summary from `git status --porcelain=v2 --branch -z` and `git diff --numstat -z HEAD`. */
export async function readLaneGitSummary(worktreePath: string, now: number): Promise<CloudGitSummaryInput | null> {
  const status = await runGit(worktreePath, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=normal"]);
  if (!status.ok) return null;
  let branch: string | null = null;
  let upstream: string | null = null;
  let headSha: string | null = null;
  let ahead = 0;
  let behind = 0;
  const entries: Array<{ path: string; status: string }> = [];
  const fields = status.stdout.split("\0");
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]!;
    if (!field) continue;
    if (field.startsWith("# branch.oid ")) {
      const oid = field.slice("# branch.oid ".length).trim();
      headSha = /^[0-9a-f]{40,64}$/.test(oid) ? oid : null;
    } else if (field.startsWith("# branch.head ")) {
      const head = field.slice("# branch.head ".length).trim();
      branch = head && head !== "(detached)" ? head : null;
    } else if (field.startsWith("# branch.upstream ")) {
      upstream = field.slice("# branch.upstream ".length).trim() || null;
    } else if (field.startsWith("# branch.ab ")) {
      const match = /^\+(\d+) -(\d+)$/.exec(field.slice("# branch.ab ".length).trim());
      if (match) {
        ahead = Number(match[1]);
        behind = Number(match[2]);
      }
    } else if (field.startsWith("1 ")) {
      // 1 XY sub mH mI mW hH hI path
      const parts = field.split(" ");
      entries.push({ status: statusLetter(parts[1] ?? ""), path: parts.slice(8).join(" ") });
    } else if (field.startsWith("2 ")) {
      // 2 XY sub mH mI mW hH hI Xscore path, then the original path as the next field.
      const parts = field.split(" ");
      entries.push({ status: statusLetter(parts[1] ?? ""), path: parts.slice(9).join(" ") });
      index += 1;
    } else if (field.startsWith("u ")) {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      entries.push({ status: "U", path: field.split(" ").slice(10).join(" ") });
    } else if (field.startsWith("? ")) {
      entries.push({ status: "?", path: field.slice(2) });
    }
  }
  const counts = new Map<string, { added: number; removed: number }>();
  if (headSha && entries.length) {
    const numstat = await runGit(worktreePath, ["diff", "--numstat", "-z", "HEAD"]);
    if (numstat.ok) {
      const parts = numstat.stdout.split("\0");
      for (let index = 0; index < parts.length; index += 1) {
        const part = parts[index]!;
        const match = /^(-|\d+)\t(-|\d+)\t(.*)$/.exec(part);
        if (!match) continue;
        let file = match[3]!;
        // A rename: the old and the new path are the next two fields.
        if (!file) {
          file = parts[index + 2] ?? "";
          index += 2;
        }
        counts.set(file, { added: match[1] === "-" ? 0 : Number(match[1]), removed: match[2] === "-" ? 0 : Number(match[2]) });
      }
    }
  }
  const changed: CloudGitChangedFile[] = entries.slice(0, CLOUD_GIT_MAX_CHANGED).map((entry) => ({
    path: entry.path.slice(0, 1_000),
    status: entry.status,
    added: counts.get(entry.path)?.added ?? 0,
    removed: counts.get(entry.path)?.removed ?? 0,
  }));
  return {
    branch,
    upstream,
    ahead,
    behind,
    headSha,
    dirty: entries.length > 0,
    changed,
    truncated: entries.length > CLOUD_GIT_MAX_CHANGED,
    checkedAt: now,
  };
}

/** Chats whose own runtime keeps native subagent transcripts that `getSubagentTranscript` reads. */
const SUBAGENT_COPY_PROVIDERS = new Set(["claude", "muse", "opencode"]);
/** The newest subagents saved per chat. */
const SUBAGENTS_PER_CHAT = 20;
/** One subagent copy is one part: at most this much text (under `CLOUD_CHAT_MAX_PART_BYTES`). */
const SUBAGENT_COPY_MAX_BYTES = 4 * 1024 * 1024;
/** How much of the parent's transcript is read for its subagent starts. */
const SUBAGENT_SCAN_BYTES = 4 * 1024 * 1024;

/** A saved row id for one subagent (the server's `[A-Za-z0-9._:-]{1,160}`). */
export function subagentCopyId(parentSessionId: string, agentId: string): string {
  const clean = (value: string) => value.replace(/[^A-Za-z0-9._-]/g, "-");
  return `${clean(parentSessionId)}:sub:${clean(agentId)}`.slice(0, 160);
}

/**
 * The native subagents a chat started (`subagent_started` with no
 * `provider`: an ADE child chat has one, and is saved as its own chat), the
 * newest `SUBAGENTS_PER_CHAT`, oldest first.
 */
export function readNativeSubagents(transcriptPath: string): Array<{ agentId: string; taskId: string | null; description: string | null }> {
  let text = "";
  try {
    const fd = fs.openSync(transcriptPath, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const length = Math.min(size, SUBAGENT_SCAN_BYTES);
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, size - length);
      text = buffer.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
  const byAgent = new Map<string, { agentId: string; taskId: string | null; description: string | null }>();
  for (const line of text.split("\n")) {
    if (!line.includes('"subagent_started"')) continue;
    try {
      const event = (JSON.parse(line) as { event?: Record<string, unknown> }).event;
      if (!event || event.type !== "subagent_started" || event.provider) continue;
      const agentId = typeof event.agentId === "string" && event.agentId.trim() ? event.agentId.trim() : null;
      if (!agentId) continue;
      // The newest start of an agent goes last.
      byAgent.delete(agentId);
      byAgent.set(agentId, {
        agentId,
        taskId: typeof event.taskId === "string" ? event.taskId : null,
        description: typeof event.description === "string" ? event.description.slice(0, 300) : null,
      });
    } catch {
      // A line cut by the read window, or not JSON.
    }
  }
  return [...byAgent.values()].slice(-SUBAGENTS_PER_CHAT);
}

/** A subagent message's words: its own text, else the text blocks of its content. */
function subagentMessageText(message: { text?: string | null; message: unknown }): string {
  if (typeof message.text === "string" && message.text.trim()) return message.text;
  const content = (message.message as { content?: unknown } | null)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block && typeof block === "object" && (block as { type?: unknown }).type === "text" ? String((block as { text?: unknown }).text ?? "") : ""))
    .filter(Boolean)
    .join("\n");
}

/**
 * The subagent's messages as saved chat events (JSON lines): its prompts as
 * `user_message`, its answers as `text`, the newest that fit in one part.
 */
export function subagentCopyText(
  chatId: string,
  messages: ReadonlyArray<{ type: string; uuid: string; text?: string | null; message: unknown; timestamp?: string | null }>,
): { text: string; lastAt: string | null } {
  const lines: string[] = [];
  let bytes = 0;
  let lastAt: string | null = null;
  const now = new Date().toISOString();
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.type !== "user" && message.type !== "assistant") continue;
    const words = subagentMessageText(message);
    if (!words.trim()) continue;
    const timestamp = message.timestamp || now;
    lastAt ??= message.timestamp ?? null;
    const line = JSON.stringify({
      sessionId: chatId,
      timestamp,
      sequence: index + 1,
      event: message.type === "user" ? { type: "user_message", text: words } : { type: "text", text: words, messageId: message.uuid },
    });
    const size = Buffer.byteLength(line, "utf8") + 1;
    if (bytes + size > SUBAGENT_COPY_MAX_BYTES) break;
    bytes += size;
    lines.push(line);
  }
  return { text: lines.reverse().join("\n"), lastAt };
}

/** At most this many topics (`CLOUD_EVENT_WAKE_MAX_TOPICS`). */
const MAX_EVENT_WAKE_TOPICS = 20;
const TOPIC_ID = /^[A-Za-z0-9_.:-]{1,200}$/;

/**
 * The event topics this computer acts on (CONTRACTS 3.3; topic names in
 * `CloudEventWakesRequest`): `linear-org:<id>` for a workspace a rule or the
 * Linear agent here wants events from, `linear-account:<user>` when the
 * Linear agent runs here, `hooks-account:<user>` when a webhook automation
 * here is registered with the relay. Sorted, with no repeats.
 */
export function eventWakeTopics(runtimes: readonly AdeRuntime[], userId: string | null): string[] {
  const topics = new Set<string>();
  const ownUser = userId && TOPIC_ID.test(userId) ? userId : null;
  for (const runtime of runtimes) {
    try {
      const linear = runtime.linearIngressService;
      const organizationId = linear?.getStatus().organizationId ?? null;
      if (linear && organizationId && TOPIC_ID.test(organizationId) && linear.wantsEvents()) {
        topics.add(`linear-org:${organizationId}`);
        if (ownUser && runtime.linearAgentRuntime) topics.add(`linear-account:${ownUser}`);
      }
    } catch {
      // A Linear status that can't be read asks for no wake.
    }
    try {
      const hook = ownUser
        ? runtime.db.get<{ found: number }>(
            "select 1 as found from automation_webhook_hooks where project_id = ? and relay_registered_at is not null limit 1",
            [runtime.projectId],
          )
        : null;
      if (hook) topics.add(`hooks-account:${ownUser}`);
    } catch {
      // No webhook table yet: no hook to wake for.
    }
  }
  return [...topics].sort().slice(0, MAX_EVENT_WAKE_TOPICS);
}

/** Runs `tasks` at most `limit` at a time; a task started after `deadline` is skipped. */
async function runLimited(tasks: Array<() => Promise<void>>, limit: number, deadline: number): Promise<number> {
  let next = 0;
  let skipped = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const task = tasks[next++]!;
      if (Date.now() >= deadline) {
        skipped += 1;
        continue;
      }
      await task();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return skipped;
}

export function createCloudRestSave(deps: CloudRestSaveDeps): CloudRestSave {
  const { logger, instanceId } = deps;
  const statePath = path.join(deps.adeHome, "cloud", STATE_FILE);
  let queue: Promise<unknown> = Promise.resolve();

  const readState = (machineKey: string): RestSaveState => {
    try {
      const parsed = JSON.parse(fs.readFileSync(statePath, "utf8")) as Partial<RestSaveState>;
      // A copy of the disk under a new machine key saves everything again.
      if (parsed?.v === 1 && parsed.machineKey === machineKey) {
        return {
          v: 1,
          machineKey,
          sessions: parsed.sessions ?? {},
          git: parsed.git ?? {},
          capsules: parsed.capsules ?? {},
          eventWakes: Array.isArray(parsed.eventWakes) ? parsed.eventWakes : null,
          subagents: parsed.subagents ?? {},
          subagentScans: parsed.subagentScans ?? {},
        };
      }
    } catch {
      // Missing or unreadable: save everything.
    }
    return emptyState(machineKey);
  };
  const writeState = (state: RestSaveState): void => {
    try {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      const temp = `${statePath}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
      fs.renameSync(temp, statePath);
    } catch (error) {
      logger.warn("cloud.rest_save_state_write_failed", { error: error instanceof Error ? error.name : "unknown" });
    }
  };

  const run = async (options: CloudRestSaveOptions, deadline: number): Promise<CloudSaveForRestReport> => {
    const started = Date.now();
    const idle = () => options.stillIdle?.() ?? true;
    const report: CloudSaveForRestReport = { ok: true, capsules: 0, sessions: 0, git: 0, skipped: 0 };
    const api = await deps.api().catch(() => null);
    const machineKey = deps.machineKey();
    if (!api || !machineKey || !instanceId) {
      return { ...report, ok: false, error: !api ? "not_signed_in" : "no_machine_key" };
    }
    const state = readState(machineKey);
    const open = await deps.openRuntimes();
    const runtimes = open.map((entry) => entry.runtime);
    const registryIdOf = new Map(open.map((entry) => [entry.runtime, entry.projectId]));

    // 1. The chats' last parts, before anything else: they are what a person reads first.
    const flushMs = Math.max(2_000, Math.min(45_000, Math.floor((deadline - Date.now()) / 3)));
    await deps.flushChats(flushMs).catch((error: unknown) => {
      logger.warn("cloud.rest_save_chats_failed", { error: errorText(error) });
    });

    // 0. Each lane's work not on GitHub, and the report a cleanup reads. A lane the time or a use cuts off counts as not saved.
    if (deps.backupLanes) {
      report.backups = await runLaneBackups({
        api,
        instanceId,
        machineKey,
        logger,
        lanes: deps.backupLanes,
        mayGoOn: () => idle() && Date.now() < deadline,
      }).catch((error: unknown) => {
        logger.warn("cloud.rest_save_backups_failed", { error: errorText(error) });
        return null;
      });
    }

    const projectKeyOf = new Map<AdeRuntime, string | null>();
    const projectKey = (runtime: AdeRuntime): string | null => {
      if (!projectKeyOf.has(runtime)) {
        let key: string | null = null;
        try {
          key = normalizeGitRemoteIdentity(readGitOriginUrl(runtime.projectRoot)) || null;
        } catch {
          key = null;
        }
        projectKeyOf.set(runtime, key);
      }
      return projectKeyOf.get(runtime) ?? null;
    };

    // 2. Shell and CLI copies: the newest across every open project.
    const terminals: Array<{ runtime: AdeRuntime; row: TerminalSessionSummary }> = [];
    for (const runtime of runtimes) {
      let rows: TerminalSessionSummary[] = [];
      try {
        rows = runtime.sessionService.list({ limit: 200, includeArchived: false });
      } catch (error) {
        logger.warn("cloud.rest_save_sessions_read_failed", { error: errorText(error) });
      }
      for (const row of rows) {
        if (!row.tracked || !row.transcriptPath || isChatToolType(row.toolType)) continue;
        terminals.push({ runtime, row });
      }
    }
    const activity = (row: TerminalSessionSummary) => Date.parse(row.lastActivityAt ?? row.startedAt) || 0;
    terminals.sort((a, b) => activity(b.row) - activity(a.row));
    const sessionTasks = terminals.slice(0, CLOUD_SESSION_MAX_PER_COMPUTER).map(({ runtime, row }) => async () => {
      if (!idle()) return;
      try {
        const isCli = isTrackedAgentCliToolType(row.toolType);
        const window = runtime.ptyService.getTranscriptWindow(row.id);
        let snapshotMark = "";
        let snapshot: string | null = null;
        if (isCli) {
          const file = runtime.ptyService.terminalSnapshotPath(row.id);
          try {
            snapshotMark = String(fs.statSync(file).mtimeMs);
            const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { serialized?: unknown };
            snapshot = typeof parsed.serialized === "string" && parsed.serialized ? parsed.serialized : null;
          } catch {
            snapshot = null;
          }
        }
        const mark = `${window?.endOffset ?? "none"}|${snapshotMark}|${row.status}`;
        if (state.sessions[row.id] === mark) return;
        let format: "text" | "xterm" = "text";
        let text: string;
        let lineCount: number;
        const redactedScreen = snapshot ? redactSecrets(snapshot) : null;
        if (redactedScreen && Buffer.byteLength(redactedScreen, "utf8") <= CLOUD_SESSION_MAX_BYTES) {
          format = "xterm";
          text = redactedScreen;
          lineCount = redactedScreen.split("\n").length;
        } else {
          const tail = await runtime.ptyService.readTranscriptTail({ sessionId: row.id, maxBytes: SHELL_TAIL_READ_BYTES, alignToLineBoundary: true });
          ({ text, lineCount } = lastLines(redactSecrets(tail), CLOUD_SESSION_MAX_LINES, CLOUD_SESSION_MAX_BYTES));
        }
        if (!text.trim()) {
          state.sessions[row.id] = mark;
          return;
        }
        const rowInput: CloudSessionRowInput = {
          kind: isCli ? "cli" : "shell",
          title: redactSecrets(row.title ?? "").slice(0, 300) || null,
          laneId: row.laneId ?? null,
          laneName: redactSecrets(row.laneName ?? "").slice(0, 200) || null,
          toolType: isCli ? row.toolType ?? null : null,
          projectKey: projectKey(runtime),
          projectId: registryIdOf.get(runtime) ?? runtime.projectId,
          parentChatId: row.orchestrationParentSessionId ?? null,
          status: row.status ?? null,
          lastActivityAt: row.lastActivityAt ?? row.startedAt ?? null,
        };
        await api.putSessionCopy(machineKey, row.id, { instanceId, row: rowInput, format, text, lineCount });
        state.sessions[row.id] = mark;
        report.sessions += 1;
      } catch (error) {
        logger.warn("cloud.rest_save_session_failed", { sessionId: row.id, error: errorText(error) });
      }
    });

    // 3. A Git summary per lane, when it changed.
    const gitTasks: Array<() => Promise<void>> = [];
    for (const runtime of runtimes) {
      let lanes: Awaited<ReturnType<AdeRuntime["laneService"]["list"]>> = [];
      try {
        lanes = await runtime.laneService.list({ includeArchived: false, includeStatus: false });
      } catch (error) {
        logger.warn("cloud.rest_save_lanes_read_failed", { error: errorText(error) });
      }
      for (const lane of lanes) {
        if (!lane.worktreePath || !fs.existsSync(lane.worktreePath)) continue;
        gitTasks.push(async () => {
          if (!idle()) return;
          try {
            const summary = await readLaneGitSummary(lane.worktreePath, Date.now());
            if (!summary) return;
            const { checkedAt: _checkedAt, ...shape } = summary;
            const hash = createHash("sha256").update(JSON.stringify(shape)).digest("hex");
            if (state.git[lane.id] === hash) return;
            const answer = await api.putGitSummary(machineKey, lane.id, { instanceId, projectKey: projectKey(runtime), summary });
            state.git[lane.id] = hash;
            if (!answer.kept) report.git += 1;
          } catch (error) {
            logger.warn("cloud.rest_save_git_failed", { laneId: lane.id, error: errorText(error) });
          }
        });
      }
    }

    // 4. Capsules: the delete path only (after prepare-stop), never at the idle step.
    const capsuleTasks: Array<() => Promise<void>> = [];
    if (options.capsules) {
      for (const runtime of runtimes) {
        const chat = runtime.agentChatService;
        if (!chat) continue;
        let rows: TerminalSessionSummary[] = [];
        try {
          rows = runtime.sessionService.list({ limit: 500, includeArchived: false });
        } catch (error) {
          logger.warn("cloud.rest_save_sessions_read_failed", { error: errorText(error) });
        }
        for (const row of rows) {
          const isChat = isChatToolType(row.toolType);
          const isCli = !isChat && Boolean(row.toolType && CAPSULE_CLI_TOOLS.has(row.toolType));
          if (!isChat && !isCli) continue;
          capsuleTasks.push(async () => {
            try {
              let provider: string;
              let modelId: string;
              let mark: string;
              if (isChat) {
                const summary = await chat.getSessionSummary(row.id);
                if (!summary || (summary.surface ?? "work") !== "work") return;
                provider = summary.provider;
                if (!CAPSULE_CHAT_PROVIDERS.has(provider)) {
                  // Replayed from the saved transcript: no capsule needed.
                  report.skipped += 1;
                  return;
                }
                modelId = summary.modelId ?? summary.model;
                mark = `${summary.lastActivityAt ?? ""}|${modelId}`;
              } else {
                provider = row.toolType === "codex" ? "codex" : "claude";
                modelId = "";
                mark = `${row.lastActivityAt ?? row.startedAt}|${row.status}`;
              }
              if (state.capsules[row.id] === mark) return;
              const prepared = await chat.prepareCrossMachineHandoff({
                sourceSessionId: row.id,
                handoffId: `cloud-rest-${randomUUID()}`,
                mode: "fork",
                targetModelId: modelId,
              });
              const capsule = prepared.capsule;
              const transportKind = isChat
                ? capsule.forkTransport?.kind ?? null
                : capsule.cli?.conversation?.kind ?? null;
              if (!transportKind) {
                // No native history to carry (a Codex `.zst` rollout, a CLI that starts fresh): the restore replays.
                report.skipped += 1;
                state.capsules[row.id] = mark;
                return;
              }
              // The restore reads the FULL saved transcript, so the capsule leaves out its own newest-3-MiB copy.
              const { transcriptEnvelopes: _envelopes, ...kept } = capsule;
              const bytes = gzipSync(Buffer.from(JSON.stringify({ v: 1, capsule: kept }), "utf8"));
              const parts = splitCapsule(bytes);
              if (!parts) {
                logger.warn("cloud.rest_capsule_over_cap", { sessionId: row.id, bytes: bytes.byteLength });
                report.skipped += 1;
                state.capsules[row.id] = mark;
                return;
              }
              for (let index = 0; index < parts.length; index += 1) {
                await api.putCapsulePart(machineKey, row.id, index + 1, instanceId, parts[index]!);
              }
              await api.commitCapsule(machineKey, row.id, {
                instanceId,
                parts: parts.length,
                bytes: bytes.byteLength,
                provider,
                transportKind,
                laneId: row.laneId ?? null,
                sessionKind: isChat ? "chat" : "cli",
              });
              state.capsules[row.id] = mark;
              report.capsules += 1;
            } catch (error) {
              // A lane that isn't pushed, a chat with a turn running, a server that refused: replay instead.
              report.skipped += 1;
              logger.warn("cloud.rest_capsule_failed", { sessionId: row.id, error: errorText(error) });
            }
          });
        }
      }
    }

    // 4b. Native subagents (Claude, Muse, OpenCode): each one's transcript as a saved chat under its parent.
    const subagentTasks: Array<() => Promise<void>> = [];
    if (deps.uploadSubagentCopy) {
      const upload = deps.uploadSubagentCopy;
      state.subagents ??= {};
      state.subagentScans ??= {};
      for (const runtime of runtimes) {
        const chat = runtime.agentChatService;
        if (!chat) continue;
        let rows: TerminalSessionSummary[] = [];
        try {
          rows = runtime.sessionService.list({ limit: 200, includeArchived: false });
        } catch (error) {
          logger.warn("cloud.rest_save_sessions_read_failed", { error: errorText(error) });
        }
        for (const row of rows) {
          if (!isChatToolType(row.toolType)) continue;
          subagentTasks.push(async () => {
            if (!idle()) return;
            try {
              const summary = await chat.getSessionSummary(row.id);
              if (!summary || !SUBAGENT_COPY_PROVIDERS.has(summary.provider)) return;
              // OpenCode's subagents are read through its server; the idle step never starts one.
              if (summary.provider === "opencode" && options.reason === "idle") return;
              const scanMark = summary.lastActivityAt ?? "";
              if (state.subagentScans![row.id] === scanMark) return;
              const spawned = readNativeSubagents(path.join(runtime.paths.chatTranscriptsDir, `${row.id}.jsonl`));
              let complete = true;
              for (const sub of spawned) {
                if (!idle() || Date.now() >= deadline) {
                  complete = false;
                  break;
                }
                const messages = await chat.getSubagentTranscript({ sessionId: row.id, agentId: sub.agentId, ...(sub.taskId ? { taskId: sub.taskId } : {}) }).catch(() => null);
                if (!messages?.length) continue;
                const chatId = subagentCopyId(row.id, sub.agentId);
                const mark = `${messages.length}|${messages[messages.length - 1]?.uuid ?? ""}`;
                if (state.subagents![chatId] === mark) continue;
                const copy = subagentCopyText(chatId, messages);
                if (!copy.text) continue;
                if (await upload(row.id, { chatId, text: copy.text, title: sub.description, lastActivityAt: copy.lastAt })) {
                  state.subagents![chatId] = mark;
                } else {
                  complete = false;
                }
              }
              if (complete) state.subagentScans![row.id] = scanMark;
            } catch (error) {
              logger.warn("cloud.rest_save_subagents_failed", { sessionId: row.id, error: errorText(error) });
            }
          });
        }
      }
    }

    // Git first (small), then capsules (what a continue needs), then the copies, then subagents.
    const notStarted = await runLimited([...gitTasks, ...capsuleTasks, ...sessionTasks, ...subagentTasks], UPLOAD_PARALLEL, deadline);
    // 5. The events that wake this computer at rest: a Linear workspace or webhook a rule here acts on.
    if (idle()) {
      const topics = eventWakeTopics(runtimes, deps.accountUserId());
      const same = state.eventWakes != null && state.eventWakes.join("\n") === topics.join("\n");
      if (!same) {
        try {
          // An older server (null) has no event wakes: it is not asked again for the same list.
          await api.putEventWakes(instanceId, topics);
          state.eventWakes = topics;
        } catch (error) {
          logger.warn("cloud.rest_save_event_wakes_failed", { error: errorText(error) });
        }
      }
    }
    // A terminal gone from the list no longer needs its mark.
    const kept = new Set(terminals.map(({ row }) => row.id));
    for (const id of Object.keys(state.sessions)) if (!kept.has(id)) delete state.sessions[id];
    writeState(state);
    if (notStarted > 0) report.error = "The save ran out of time; the rest is saved next time.";
    logger.info("cloud.rest_save", {
      reason: options.reason,
      capsules: report.capsules,
      sessions: report.sessions,
      git: report.git,
      skipped: report.skipped,
      notStarted,
      ms: Date.now() - started,
    });
    return report;
  };

  return {
    save: (options) => {
      // The caller's budget starts now, not when an earlier save ends (the server's exec has its own limit).
      const deadline = Date.now() + Math.max(5_000, options.budgetMs);
      const next = queue.catch(() => undefined).then(() => run(options, deadline));
      queue = next;
      return next;
    },
  };
}
