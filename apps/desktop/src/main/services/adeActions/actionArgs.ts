/**
 * How an ADE action reads its input.
 *
 * One answer for the whole action surface: every validator that turns an
 * `unknown` action argument into a typed value lives here, so the registry and
 * its sibling action modules (`sessionBoardMove`, and whatever follows it)
 * reject the same shapes with the same words. They live here rather than in
 * `registry.ts` because a sibling importing the registry back would be a cycle,
 * and would make every extracted module depend on the 3,000-line file it was
 * extracted from.
 *
 * Pure `unknown -> typed` only. Nothing here reaches a runtime or a service;
 * the two that need real parsing rules delegate to
 * `sessions/sessionRequestValidation`, which the IPC and agent-tool surfaces
 * share so all three reject the same inputs.
 */

import type {
  FilesWatchArgs,
  LaneBranchDriftResolution,
  SessionSettleOverride,
  SessionWakeReason,
} from "../../../shared/types";
import {
  parseSettleOverrideArg,
  parseSnoozeDeadline,
  parseWakeReason,
} from "../sessions/sessionRequestValidation";

export function readObjectActionArg(value: unknown, actionName: string): Record<string, unknown> {
  if (value == null) return {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error(`${actionName} expects an object input. Use --input-json '{...}' or see \`ade actions list --domain chat --text\`.`);
}

export function optionalNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

export function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`Expected '${field}' to be a non-empty string.`);
  }
  const trimmed = value.trim();
  if (!trimmed.length) {
    throw new Error(`Expected '${field}' to be a non-empty string.`);
  }
  return trimmed;
}

/** Private to the two file-watch readers below; the field never leaves this module. */
const RUNTIME_FILE_WATCH_CLIENT_ID_FIELD = "__adeRuntimeClientId";
const RUNTIME_FILE_WATCH_DEFAULT_SENDER_ID = 1;

export function asActionRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/**
 * Snooze deadlines cross the agent boundary as free text, so they are validated
 * before reaching `sessionService`, which returns a bare `false` for both
 * "no such row" and "unparseable date". Shared with the IPC and agent-tool
 * surfaces so all three reject the same inputs.
 */
export function requireSnoozeDeadline(value: unknown): string {
  return parseSnoozeDeadline(value);
}

export function readSessionIdList(value: unknown, actionName: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${actionName} requires a 'sessionIds' array.`);
  }
  const ids = value.filter((id): id is string => typeof id === "string" && id.trim().length > 0);
  if (!ids.length) {
    throw new Error(`${actionName} requires at least one session id.`);
  }
  return ids;
}

export function readWakeReason(value: unknown, actionName: string): SessionWakeReason {
  return parseWakeReason(value, actionName);
}

export function readSettleOverride(value: unknown, actionName: string): SessionSettleOverride | null {
  return parseSettleOverrideArg(value, actionName);
}

export function readBranchDriftResolution(value: unknown, actionName: string): LaneBranchDriftResolution {
  if (value === "switch-back" || value === "keep-head") return value;
  throw new Error(`${actionName} 'resolution' must be 'switch-back' or 'keep-head'.`);
}

export function readOptionalIntegerActionField(value: unknown, field: string): number | undefined {
  if (value == null || value === "") return undefined;
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number.parseInt(value, 10)
      : NaN;
  if (!Number.isFinite(numeric)) {
    throw new Error(`Expected '${field}' to be a finite number.`);
  }
  return Math.floor(numeric);
}

export function readChatHistoryActionArgs(
  value: unknown,
  actionName: string,
): { sessionId: string; options: Record<string, unknown> } {
  if (Array.isArray(value)) {
    return {
      sessionId: requireNonEmptyString(value[0], "sessionId"),
      options: asActionRecord(value[1]),
    };
  }
  if (typeof value === "string") {
    return {
      sessionId: requireNonEmptyString(value, "sessionId"),
      options: {},
    };
  }
  const record = readObjectActionArg(value, actionName);
  return {
    sessionId: requireNonEmptyString(record.sessionId, "sessionId"),
    options: record,
  };
}

export function readRuntimeFileWatchSenderId(args: Record<string, unknown>): number {
  const raw = args[RUNTIME_FILE_WATCH_CLIENT_ID_FIELD];
  const numeric = typeof raw === "number"
    ? raw
    : typeof raw === "string"
      ? Number.parseInt(raw, 10)
      : NaN;
  if (Number.isSafeInteger(numeric) && numeric > 0) {
    return numeric;
  }
  return RUNTIME_FILE_WATCH_DEFAULT_SENDER_ID;
}

export function toRuntimeFileWatchArgs(args: Record<string, unknown>): FilesWatchArgs {
  const { [RUNTIME_FILE_WATCH_CLIENT_ID_FIELD]: _clientId, ...watchArgs } = args;
  return watchArgs as unknown as FilesWatchArgs;
}

export function readStringActionArg(value: unknown, field: string): string {
  if (typeof value === "string") {
    return requireNonEmptyString(value, field);
  }
  return requireNonEmptyString(asActionRecord(value)[field], field);
}
