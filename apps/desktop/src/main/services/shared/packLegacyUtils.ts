/**
 * Utility functions formerly in packs/packUtils.ts, retained because they are
 * consumed by sessionDeltaService, conflictService, and other non-pack code.
 */

import fs from "node:fs";
import path from "node:path";
import type { SessionDeltaSummary } from "../../../shared/types";
import { safeJsonParse } from "./utils";

// ── Row types ────────────────────────────────────────────────────────────────

export type LaneSessionRow = {
  id: string;
  lane_id: string;
  tracked: number;
  started_at: string;
  ended_at: string | null;
  head_sha_start: string | null;
  head_sha_end: string | null;
  transcript_path: string;
};

export type SessionDeltaRow = {
  session_id: string;
  lane_id: string;
  started_at: string;
  ended_at: string | null;
  head_sha_start: string | null;
  head_sha_end: string | null;
  files_changed: number;
  insertions: number;
  deletions: number;
  touched_files_json: string;
  failure_lines_json: string;
  computed_at: string;
};

export type ParsedNumStat = {
  insertions: number;
  deletions: number;
  files: Set<string>;
};

// ── Pure helper functions ────────────────────────────────────────────────────

export function safeJsonParseArray(raw: string | null | undefined): string[] {
  const parsed = safeJsonParse<unknown>(raw, null);
  if (!Array.isArray(parsed)) return [];
  return parsed.map((entry) => String(entry));
}

export function readFileIfExists(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

export function ensureDirFor(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

export function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function safeSegment(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "untitled";
  return trimmed.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
}

export function parseNumStat(stdout: string): ParsedNumStat {
  const files = new Set<string>();
  let insertions = 0;
  let deletions = 0;

  const lines = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const ins = parts[0] ?? "0";
    const del = parts[1] ?? "0";
    const filePath = parts.slice(2).join("\t").trim();
    if (filePath.length) files.add(filePath);

    const insNum = ins === "-" ? 0 : Number(ins);
    const delNum = del === "-" ? 0 : Number(del);
    if (Number.isFinite(insNum)) insertions += insNum;
    if (Number.isFinite(delNum)) deletions += delNum;
  }

  return { insertions, deletions, files };
}

export function parsePorcelainPaths(stdout: string): string[] {
  const out = new Set<string>();
  const lines = stdout.split("\n").map((line) => line.trimEnd()).filter(Boolean);
  for (const line of lines) {
    if (line.startsWith("??")) {
      const rel = line.slice(2).trim();
      if (rel.length) out.add(rel);
      continue;
    }

    const raw = line.slice(2).trim();
    const arrow = raw.indexOf("->");
    if (arrow >= 0) {
      const rel = raw.slice(arrow + 2).trim();
      if (rel.length) out.add(rel);
      continue;
    }
    if (raw.length) out.add(raw);
  }
  return [...out];
}

export function parseChatTranscriptDelta(rawTranscript: string): {
  touchedFiles: string[];
  failureLines: string[];
} {
  const touched = new Set<string>();
  const failureLines: string[] = [];
  const seenFailure = new Set<string>();

  const pushFailure = (value: string | null | undefined) => {
    const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
    if (!normalized.length) return;
    const clipped = normalized.length > 320 ? normalized.slice(0, 320) : normalized;
    if (seenFailure.has(clipped)) return;
    seenFailure.add(clipped);
    failureLines.push(clipped);
  };

  for (const rawLine of rawTranscript.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.length) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const event = (parsed as { event?: unknown }).event;
    if (!event || typeof event !== "object" || Array.isArray(event)) continue;
    const eventRecord = event as Record<string, unknown>;
    const type = typeof eventRecord.type === "string" ? eventRecord.type : "";

    if (type === "file_change") {
      const pathValue = String(eventRecord.path ?? "").trim();
      if (pathValue.length && !pathValue.startsWith("(")) touched.add(pathValue);
      continue;
    }

    if (type === "command") {
      const command = String(eventRecord.command ?? "").trim();
      const output = String(eventRecord.output ?? "");
      const status = String(eventRecord.status ?? "").trim();
      const exitCode = typeof eventRecord.exitCode === "number" ? eventRecord.exitCode : null;

      if (status === "failed" || (exitCode != null && exitCode !== 0)) {
        pushFailure(command.length ? `Command failed: ${command}` : "Command failed.");
      }

      for (const outputLine of output.split(/\r?\n/)) {
        const normalized = outputLine.replace(/\s+/g, " ").trim();
        if (!normalized.length) continue;
        if (!/\b(error|failed|exception|fatal|traceback)\b/i.test(normalized)) continue;
        pushFailure(normalized);
      }
      continue;
    }

    if (type === "error") {
      pushFailure(String(eventRecord.message ?? "Chat error."));
      continue;
    }

    if (type === "status") {
      const turnStatus = String(eventRecord.turnStatus ?? "").trim();
      if (turnStatus === "failed") {
        pushFailure(String(eventRecord.message ?? "Turn failed."));
      }
    }
  }

  return {
    touchedFiles: [...new Set(touched)].sort(),
    failureLines: failureLines.slice(-16)
  };
}

export function formatCommand(command: unknown): string {
  if (Array.isArray(command)) {
    return command.map((part) => {
      const value = String(part);
      if (!value.length) return "''";
      if (/^[a-zA-Z0-9_./:-]+$/.test(value)) return value;
      return `'${value.replace(/'/g, `'\"'\"'`)}'`;
    }).join(" ");
  }
  if (typeof command === "string") return command.trim();
  return JSON.stringify(command);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function rowToSessionDelta(row: SessionDeltaRow): SessionDeltaSummary {
  return {
    sessionId: row.session_id,
    laneId: row.lane_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    headShaStart: row.head_sha_start,
    headShaEnd: row.head_sha_end,
    filesChanged: Number(row.files_changed ?? 0),
    insertions: Number(row.insertions ?? 0),
    deletions: Number(row.deletions ?? 0),
    touchedFiles: safeJsonParseArray(row.touched_files_json),
    failureLines: safeJsonParseArray(row.failure_lines_json),
    computedAt: row.computed_at ?? null
  };
}
