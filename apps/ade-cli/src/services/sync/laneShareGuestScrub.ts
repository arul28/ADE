import type { LaneShareRights } from "../../../../desktop/src/shared/laneShareRights";
import { isUserOnlyConsentCard } from "../../../../desktop/src/shared/types/macDesktop";
import type { LaneShareGuestGrant } from "./laneShareGuestPolicy";

/**
 * What the host takes out of a payload before a lane share guest gets it:
 * cards only the owner may answer, model and machine names the rights hide,
 * history from before the share, and ADE's own files. The gates that decide
 * whether a guest gets a payload at all are in `laneShareGuestPolicy.ts`.
 */

/** What a guest sees of a card only the owner may answer. */
const LANE_SHARE_OWNER_ONLY_CARD_TEXT = "Waiting for the owner. Only the owner can answer this.";

const OWNER_ONLY_CARD_KEPT_KEYS = ["requestId", "itemId", "kind", "turnId", "source", "blocking", "createdAt"] as const;

function ownerOnlyCardRequest(request: Record<string, unknown>): Record<string, unknown> | null {
  const metadata = request.providerMetadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  if (!isUserOnlyConsentCard(metadata as Record<string, unknown>)) return null;
  const kept: Record<string, unknown> = {};
  for (const key of OWNER_ONLY_CARD_KEPT_KEYS) if (key in request) kept[key] = request[key];
  return {
    ...kept,
    title: LANE_SHARE_OWNER_ONLY_CARD_TEXT,
    description: LANE_SHARE_OWNER_ONLY_CARD_TEXT,
    questions: [],
    allowsFreeform: false,
    providerMetadata: { laneShareOwnerOnly: true },
  };
}

/**
 * A payload for a guest with each card only the owner may answer
 * (`isUserOnlyConsentCard`: a secret, an MCP server, an integration
 * connect, the Mac real-input lease, a shared-desktop consent, an MCP App
 * call) reduced to its ids and a "waiting for the owner" line. The card's
 * text, questions and metadata can name a secret, a command line or an
 * account, and a guest can never answer it anyway. Covers the card itself
 * (pending lists) and the `approval_request` event that carries it.
 */
export function laneShareScrubOwnerOnlyCards<T>(value: T, depth = 0): T {
  if (depth > 12 || !value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((entry) => laneShareScrubOwnerOnlyCards(entry, depth + 1)) as T;
  const record = value as Record<string, unknown>;
  const card = ownerOnlyCardRequest(record);
  if (card) return card as T;
  if (record.type === "approval_request" && record.detail && typeof record.detail === "object") {
    const request = (record.detail as Record<string, unknown>).request;
    const scrubbed = request && typeof request === "object" ? ownerOnlyCardRequest(request as Record<string, unknown>) : null;
    if (scrubbed) return { ...record, description: LANE_SHARE_OWNER_ONLY_CARD_TEXT, detail: { request: scrubbed } } as T;
  }
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    const next = laneShareScrubOwnerOnlyCards(entry, depth + 1);
    if (next !== entry) changed = true;
    out[key] = next;
  }
  return (changed ? out : value) as T;
}

/** The right that answers a pending card of `kind`. A kind not listed here is refused under any rights. */
export function rowField(row: unknown, key: string): unknown {
  return row && typeof row === "object" ? (row as Record<string, unknown>)[key] : undefined;
}

/**
 * Keys whose string value names a model: `model`, `models`, `modelId`,
 * `modelIds`, and camel-case keys that end in `Model`, `ModelId` or
 * `ModelIds` (`toModelId`, `servedModel`, `availableModelIds`, ...).
 */
const MODEL_VALUE_KEY = /^(?:models?|modelIds?|modelProvider)$|[a-z](?:Model|ModelId|ModelIds)$/;
/** Keys whose whole value is about the host's models or presets: always null. */
const MODEL_DROP_KEYS = new Set(["modelHandoffHistory", "modelManifest", "modelConfigId", "presetId"]);
const MAX_SCRUB_DEPTH = 64;

function scrubModels(value: unknown, allowed: ReadonlySet<string>, modelKey: boolean, depth: number): unknown {
  if (typeof value === "string") return modelKey && !allowed.has(value) ? null : value;
  if (!value || typeof value !== "object") return value;
  // Deeper than any ADE payload: dropped, never sent unread.
  if (depth >= MAX_SCRUB_DEPTH) return null;
  if (Array.isArray(value)) {
    let copy: unknown[] | null = null;
    for (let index = 0; index < value.length; index += 1) {
      const next = scrubModels(value[index], allowed, modelKey, depth + 1);
      if (next !== value[index]) {
        copy ??= value.slice();
        copy[index] = next;
      }
    }
    return copy ?? value;
  }
  let copy: Record<string, unknown> | null = null;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const next = MODEL_DROP_KEYS.has(key)
      ? (entry == null ? entry : null)
      : scrubModels(entry, allowed, MODEL_VALUE_KEY.test(key), depth + 1);
    if (next !== entry) {
      copy ??= { ...(value as Record<string, unknown>) };
      copy[key] = next;
    }
  }
  return copy ?? value;
}

/**
 * With `privacy.hideModels` on, everything the host sends a guest goes
 * through this one function: a model name in a structured field is kept only
 * when it is one the guest may use (`run.models`); every other one becomes
 * null, and preset ids and model histories are null. Unchanged parts keep
 * their identity, so a payload with no model costs one walk and no copy.
 *
 * Free text is not changed: a model name inside an agent reply, a notice, an
 * error message, a tool's output or terminal output reaches the guest as is.
 */
export function laneShareHideModels<T>(value: T, rights: LaneShareRights): T {
  if (!rights.privacy.hideModels) return value;
  return scrubModels(value, new Set(rights.run.models), false, 0) as T;
}

/**
 * Keys whose value names or identifies a computer: device ids and names,
 * machine keys, names and platforms (also with a prefix, such as
 * `targetMachineName` or `hostDeviceId`), host names and site ids.
 */
const MACHINE_VALUE_KEY = /^(?:deviceId|deviceName|machineKey|machineName|machinePlatform|machineLabel|hostname|hostName|siteId)$|[a-z](?:DeviceId|DeviceName|MachineKey|MachineName|MachinePlatform|MachineLabel|HostName|Hostname|SiteId)$/;

function scrubMachines(value: unknown, depth: number): unknown {
  if (!value || typeof value !== "object") return value;
  if (depth >= MAX_SCRUB_DEPTH) return null;
  if (Array.isArray(value)) {
    let copy: unknown[] | null = null;
    for (let index = 0; index < value.length; index += 1) {
      const next = scrubMachines(value[index], depth + 1);
      if (next !== value[index]) {
        copy ??= value.slice();
        copy[index] = next;
      }
    }
    return copy ?? value;
  }
  let copy: Record<string, unknown> | null = null;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const next = MACHINE_VALUE_KEY.test(key) ? (entry == null ? entry : null) : scrubMachines(entry, depth + 1);
    if (next !== entry) {
      copy ??= { ...(value as Record<string, unknown>) };
      copy[key] = next;
    }
  }
  return copy ?? value;
}

/**
 * With `privacy.hideMachines` on, everything the host sends a guest (except
 * the hello reply, which the host builds with an id made for the share)
 * goes through this: every field that names or identifies a computer
 * (`MACHINE_VALUE_KEY`) becomes null. Unchanged parts keep their identity.
 * Free text (an agent reply, terminal output) is not changed.
 */
export function laneShareHideMachines<T>(value: T, rights: LaneShareRights): T {
  if (!rights.privacy.hideMachines) return value;
  return scrubMachines(value, 0) as T;
}

function timestampMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Keeps rows at or after the cutoff. A row with no time is dropped: default refuse. */
function keptIndexes(rows: unknown[], cutoffMs: number): number[] {
  const kept: number[] = [];
  rows.forEach((row, index) => {
    const at = timestampMs(rowField(row, "timestamp") ?? rowField(row, "createdAt") ?? rowField(row, "at"));
    if (at != null && at >= cutoffMs) kept.push(index);
  });
  return kept;
}

/** Arrays positionally aligned with `events` that must lose the same rows. */
const ALIGNED_WITH_EVENTS = ["envelopeStartOffsets"];

/**
 * History from before the share's start, removed (the "history before the
 * share" switch off). Works on the shapes that carry chat history: `events`
 * (event history snapshots and pages, chat subscribe and history replies),
 * `pinnedEvents`, `entries` (transcripts) and `messages` (subagent
 * transcripts). When a row was removed, the answer also says there is
 * nothing older, so a client stops paging back. Anything else passes as is.
 */
export function filterLaneShareHistory(value: unknown, cutoffMs: number | null): unknown {
  if (cutoffMs == null || !value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  let changed = false;
  let dropped = false;
  const out: Record<string, unknown> = { ...record };
  for (const key of ["events", "pinnedEvents", "entries", "messages"]) {
    const rows = record[key];
    if (!Array.isArray(rows)) continue;
    const kept = keptIndexes(rows, cutoffMs);
    if (kept.length === rows.length) continue;
    changed = true;
    dropped = true;
    out[key] = kept.map((index) => rows[index]);
    if (key === "events") {
      for (const aligned of ALIGNED_WITH_EVENTS) {
        const list = record[aligned];
        if (Array.isArray(list) && list.length === rows.length) out[aligned] = kept.map((index) => list[index]);
        else if (aligned in record) delete out[aligned];
      }
    }
  }
  if (!changed) return value;
  if (dropped) {
    if ("hasOlderHistory" in out) out.hasOlderHistory = false;
    if ("hasMore" in out) out.hasMore = false;
    if ("nextCursor" in out) out.nextCursor = null;
    if ("startOffset" in out) out.startOffset = 0;
  }
  return out;
}

/** Text fields of a session or chat row that repeat its history (previews, summaries, goals). */
const HISTORY_TEXT_KEYS = [
  "lastOutputPreview",
  "lastMessagePreview",
  "lastUserMessagePreview",
  "lastAssistantMessagePreview",
  "preview",
  "summary",
  "summaryText",
  "goal",
  "excerpt",
  "finalSummary",
  "statusNote",
  "attentionMessage",
  "codexGoal",
  "claudeGoal",
] as const;

function rowStartedMs(row: unknown): number | null {
  return timestampMs(rowField(row, "startedAt"))
    ?? timestampMs(rowField(row, "startTimestamp"))
    ?? timestampMs(rowField(row, "createdAt"));
}

/** A row that began before the cutoff (or has no time) loses its history text. */
function withoutHistoryText(row: unknown, cutoffMs: number): unknown {
  if (!row || typeof row !== "object" || Array.isArray(row)) return row;
  const started = rowStartedMs(row);
  if (started != null && started >= cutoffMs) return row;
  const out: Record<string, unknown> = { ...(row as Record<string, unknown>) };
  let changed = false;
  for (const key of HISTORY_TEXT_KEYS) {
    if (key in out) {
      delete out[key];
      changed = true;
    }
  }
  return changed ? out : row;
}

function mapRows(value: unknown, keys: readonly string[], map: (rows: unknown[]) => unknown[]): unknown {
  if (Array.isArray(value)) return map(value);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    if (Array.isArray(record[key])) return { ...record, [key]: map(record[key] as unknown[]) };
  }
  return value;
}

/**
 * The history filter for answers that are not event lists: thread comments
 * written before the cutoff go (their excerpts quote the history);
 * subagents started before it go; session and chat rows that began before
 * it keep their ids and state but lose previews, summaries and goals.
 */
export function filterLaneShareActionHistory(action: string, value: unknown, cutoffMs: number | null): unknown {
  if (cutoffMs == null) return value;
  const after = (row: unknown) => {
    const at = rowStartedMs(row);
    return at != null && at >= cutoffMs;
  };
  switch (action) {
    case "chat.listThreadComments":
      return mapRows(value, ["comments", "items"], (rows) => rows.filter(after));
    case "chat.listSubagents":
      return mapRows(value, ["subagents", "items"], (rows) => rows.filter(after));
    case "work.listSessions":
    case "chat.listSessions":
      return mapRows(value, ["sessions", "items"], (rows) => rows.map((row) => withoutHistoryText(row, cutoffMs)));
    case "work.getSession":
    case "chat.getSummary":
      return withoutHistoryText(value, cutoffMs);
    default:
      return value;
  }
}

/** One line and its line end. No other control character: C0, DEL or C1 (escape sequences, Ctrl-C, Tab, Backspace). */
/** One chat event envelope from before the cutoff: never sent with the history switch off. */
export function laneShareEventBeforeCutoff(payload: unknown, cutoffMs: number | null): boolean {
  if (cutoffMs == null) return false;
  const at = timestampMs(rowField(payload, "timestamp"));
  return at == null || at < cutoffMs;
}

/**
 * The guest's history cutoff on the host clock, or null when it may read the
 * history. The share's start from the directory; without one, when this host
 * first stored the share; without that either, now.
 */
export function laneShareHistoryCutoff(
  rights: LaneShareRights,
  grant: LaneShareGuestGrant | undefined,
  fallbackMs: number,
): number | null {
  if (rights.see.historyBeforeShare) return null;
  return grant?.sharedAtMs ?? fallbackMs;
}

/** A path inside `.ade/`: ADE's own state on this computer, never shared. */
export function laneShareIsAdeStatePath(relPath: string): boolean {
  return relPath.replace(/\\/g, "/").split("/").find((segment) => segment !== "" && segment !== ".")?.toLowerCase() === ".ade";
}

const FILE_ROW_PATH_KEYS = ["path", "relPath", "relativePath"] as const;

/**
 * A file reply for a guest without rows inside `.ade/` (tree nodes, quick
 * open items, search matches). The listing already hides what git ignores.
 */
export function laneShareScrubFileResponse<T>(value: T, depth = 0): T {
  if (depth > 12 || !value || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value
      .filter((row) => {
        if (!row || typeof row !== "object") return true;
        const record = row as Record<string, unknown>;
        return !FILE_ROW_PATH_KEYS.some((key) => typeof record[key] === "string" && laneShareIsAdeStatePath(record[key] as string));
      })
      .map((row) => laneShareScrubFileResponse(row, depth + 1)) as T;
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) out[key] = laneShareScrubFileResponse(entry, depth + 1);
  return out as T;
}
