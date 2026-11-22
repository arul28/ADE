/**
 * Antigravity's tool-call quirks, corrected before ADE reads an update.
 * Each one was seen on the wire (agy 1.5.6, Windows x64, 2026-11-12):
 *
 * - An edit's finished update names its file as a URL path, `/C:/Users/…`,
 *   where the permission request had `C:\Users\…`. A leading slash before a
 *   drive letter is dropped, so the row links to the real file.
 * - `write_file`'s finished diff gives one newline more than the file got
 *   (`alpha\n\n` for a file holding `alpha\n`). Its `Content` argument is
 *   what was written, so a new file's text comes from there.
 * - An edit's diff is only the replaced snippet (`oldText` "alpha", `newText`
 *   "beta"), so a hunk would always sit at line 1. When the edit has finished
 *   and the new snippet occurs exactly once in the file, the diff becomes the
 *   whole file before and after, so the hunk lands on its real lines. Any
 *   doubt (several matches, a large or unreadable file) keeps the snippet.
 * - `run_command` output starts with a header ("Created At: …", "Completed
 *   At: …", "Command exited with code N."), then "Command output:" and the
 *   output, or "No output from the command.". The row shows the output; the
 *   exit code is in `rawOutput.exit_code` and goes on the row.
 */

import fs from "node:fs";

import type { AcpSessionUpdate, AcpToolCallContent } from "../acpProtocolTypes";

/** A file this size or smaller is read to place an edit's hunk. */
const EDIT_LOCATE_MAX_BYTES = 512 * 1024;

const WINDOWS_URL_PATH = /^\/([A-Za-z]:[\\/])/;
const COMMAND_HEADER = /^Created At: [^\n]*\nCompleted At: [^\n]*\nCommand exited with code -?\d+\.\n\n/;
const COMMAND_OUTPUT = "Command output:\n";
const NO_OUTPUT = "No output from the command.";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function commandOutput(text: string): string {
  const header = COMMAND_HEADER.exec(text);
  if (!header) return text;
  const rest = text.slice(header[0].length);
  if (rest.startsWith(COMMAND_OUTPUT)) return rest.slice(COMMAND_OUTPUT.length);
  return rest.trim() === NO_OUTPUT ? "" : rest;
}

/**
 * The whole file before and after a finished snippet edit, when the new
 * snippet occurs once in the file as it is now. `null` when it cannot be sure.
 */
function placedEdit(path: string, oldText: string, newText: string): { oldText: string; newText: string } | null {
  if (!newText.length || oldText === newText) return null;
  let after: string;
  try {
    const stat = fs.statSync(path);
    if (!stat.isFile() || stat.size > EDIT_LOCATE_MAX_BYTES) return null;
    after = fs.readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const at = after.indexOf(newText);
  if (at < 0 || after.indexOf(newText, at + 1) >= 0) return null;
  return { oldText: `${after.slice(0, at)}${oldText}${after.slice(at + newText.length)}`, newText: after };
}

function fixContent(item: AcpToolCallContent, writtenContent: string | null, finished: boolean): AcpToolCallContent {
  if (item.type === "diff") {
    const path = item.path.replace(WINDOWS_URL_PATH, "$1");
    const created = item.oldText === null || item.oldText === undefined || item.oldText === "";
    if (created) {
      const newText = writtenContent ?? item.newText;
      return path === item.path && newText === item.newText ? item : { ...item, path, newText };
    }
    const placed = finished ? placedEdit(path, item.oldText ?? "", item.newText) : null;
    if (placed) return { ...item, path, ...placed };
    return path === item.path ? item : { ...item, path };
  }
  if (item.type === "content" && item.content.type === "text") {
    const text = commandOutput(item.content.text);
    return text === item.content.text ? item : { ...item, content: { ...item.content, text } };
  }
  return item;
}

export function normalizeAntigravitySessionUpdate(update: AcpSessionUpdate): AcpSessionUpdate {
  if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") return update;
  if (!update.content?.length) return update;
  const input = record(update.rawInput);
  const writtenContent = update.name === "write_file" && typeof input?.Content === "string" ? input.Content : null;
  const isCommand = update.kind === "execute";
  const finished = update.status === "completed";
  let changed = false;
  const content = update.content.map((item) => {
    // Command output is only rewritten on a command, never on other tools' text.
    if (item.type === "content" && !isCommand) return item;
    const next = fixContent(item, writtenContent, finished);
    if (next !== item) changed = true;
    return next;
  });
  return changed ? { ...update, content } : update;
}
