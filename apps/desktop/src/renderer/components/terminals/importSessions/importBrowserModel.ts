/**
 * Pure helpers for the Import session dialog: where a session lives, how the
 * list filters and counts, and the small bits of state that outlive a dialog.
 * No React here, so every rule is testable without a DOM.
 */
import type { AgentChatEventEnvelope } from "../../../../shared/types/chat";
import type { ImportSurface } from "../../../../shared/externalSessionPolicy";
import { getDefaultModelDescriptor, resolveModelDescriptor } from "../../../../shared/modelRegistry";
import { branchNameFromRef } from "../../prs/shared/laneBranchTargets";
import type { LaneComboboxLane } from "../LaneCombobox";
import type {
  ExternalSessionMessage,
  ExternalSessionProvider,
  ExternalSessionSummary,
} from "./contract";
import { shortenCwd } from "./affordances";

/** Lane-filter pseudo option for sessions whose folder is not a live lane. */
export const OTHER_FOLDERS_ID = "__ade_import_other_folders__";
export const ALL_LANES_ID = "all";

/** Must stay resolvable through the shared model registry; see the guard test. */
export const DEFAULT_FORK_MODEL = "anthropic/claude-sonnet-5";

export type ProviderFilter = ExternalSessionProvider | "all";

export type ImportedSessionRef = { kind: "chat" | "cli"; sessionId: string };

export function sessionKey(summary: Pick<ExternalSessionSummary, "provider" | "id">): string {
  return `${summary.provider}:${summary.id}`;
}

/** Stable identity for the read-only preview transcript (React key, scroll memory, collapse cache). */
export function previewTranscriptKey(summary: Pick<ExternalSessionSummary, "provider" | "id">): string {
  return `external-preview:${summary.provider}:${summary.id}`;
}

export function hasPrompts(summary: ExternalSessionSummary): boolean {
  return summary.messageCount == null || summary.messageCount > 0;
}

/** Replaces one provider's rows with a fresh scan result, keeping every other provider. */
export function replaceProviderRows(
  prev: ExternalSessionSummary[],
  provider: ExternalSessionProvider,
  rows: ExternalSessionSummary[],
): ExternalSessionSummary[] {
  const byKey = new Map<string, ExternalSessionSummary>();
  for (const row of prev) if (row.provider !== provider) byKey.set(sessionKey(row), row);
  for (const row of rows) byKey.set(sessionKey(row), row);
  return Array.from(byKey.values());
}

export function readImportedSessionRef(summary: ExternalSessionSummary): ImportedSessionRef | null {
  const raw = (summary as { importedSessionRef?: unknown }).importedSessionRef;
  if (!raw || typeof raw !== "object") return null;
  const kind = (raw as { kind?: unknown }).kind;
  const sessionId = (raw as { sessionId?: unknown }).sessionId;
  if ((kind !== "chat" && kind !== "cli") || typeof sessionId !== "string" || !sessionId) {
    return null;
  }
  return { kind, sessionId };
}

/**
 * Where a row says the session lives. Rows name the lane, never the
 * `…/worktrees/<folder>` path; only a session outside every lane falls back to
 * its folder name.
 */
export type SessionPlace =
  | { kind: "lane"; laneId: string; name: string; color: string | null; branch: string | null }
  | { kind: "removed-lane"; name: string }
  | { kind: "outside"; name: string }
  | { kind: "unknown"; name: string };

function lastSegment(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  return cwd.split(/[\\/]/u).filter(Boolean).at(-1) ?? null;
}

export function sessionPlace(
  summary: ExternalSessionSummary,
  lanesById: ReadonlyMap<string, LaneComboboxLane>,
): SessionPlace {
  const home = summary.home ?? null;
  if (home?.kind === "lane" && home.laneId) {
    const lane = lanesById.get(home.laneId);
    const branchRef = lane?.branchRef ?? home.branchRef;
    return {
      kind: "lane",
      laneId: home.laneId,
      name: lane?.name ?? home.laneName ?? "Lane",
      color: lane?.color ?? home.color ?? null,
      branch: branchRef ? branchNameFromRef(branchRef) || null : null,
    };
  }
  if (home?.kind === "removed-lane") return { kind: "removed-lane", name: "Removed lane" };
  if (home?.kind === "outside") {
    return { kind: "outside", name: lastSegment(summary.cwd) ?? "Other folder" };
  }
  // Older hosts send no `home`; the folder is all there is.
  return { kind: "unknown", name: summary.cwd ? shortenCwd(summary.cwd, 2) : "Unknown folder" };
}

/** The lane-filter bucket a session falls in; null when the host sent no home. */
export function laneFilterKey(summary: ExternalSessionSummary): string | null {
  const home = summary.home;
  if (!home) return null;
  if (home.kind === "lane" && home.laneId) return home.laneId;
  return OTHER_FOLDERS_ID;
}

export function matchesLaneFilter(summary: ExternalSessionSummary, filter: string): boolean {
  return filter === ALL_LANES_ID || laneFilterKey(summary) === filter;
}

export function matchesProviderFilter(summary: ExternalSessionSummary, filter: ProviderFilter): boolean {
  return filter === "all" || summary.provider === filter;
}

export function matchesSearch(
  summary: ExternalSessionSummary,
  place: SessionPlace,
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const home = summary.home;
  const haystack = [
    summary.title,
    summary.preview,
    place.name,
    place.kind === "lane" ? place.branch : null,
    home?.laneName,
    home?.branchRef,
    summary.cwd,
    summary.id,
    ...(summary.messages ?? []).map((message) => message.text),
  ];
  return haystack.some((value) => value?.toLowerCase().includes(needle));
}

export function countBy<T>(items: readonly T[], keyOf: (item: T) => string | null): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = keyOf(item);
    if (key == null) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** Newest first; sessions without a timestamp sink to the bottom. */
export function sortByRecent(rows: ExternalSessionSummary[]): ExternalSessionSummary[] {
  return rows.slice().sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

/** The lane a source scans against: the opened lane when the source has it, else its primary. */
export function defaultLaneOf(
  lanes: ReadonlyArray<LaneComboboxLane & { laneType?: string | null }>,
  preferredLaneId: string | null,
): string | null {
  const lane = (preferredLaneId ? lanes.find((candidate) => candidate.id === preferredLaneId) : undefined)
    ?? lanes.find((candidate) => candidate.laneType === "primary")
    ?? lanes.find((candidate) => candidate.name.trim().toLowerCase() === "primary")
    ?? lanes[0];
  return lane?.id ?? null;
}

/** The session's home lane when that lane is one this source can target. */
export function homeLaneIdIn(
  summary: ExternalSessionSummary,
  lanesById: ReadonlyMap<string, unknown>,
): string | null {
  const home = summary.home;
  if (home?.kind !== "lane" || !home.laneId) return null;
  return lanesById.has(home.laneId) ? home.laneId : null;
}

/**
 * The recorded launch model is whatever the foreign CLI wrote down, so it only
 * seeds the picker when the shared registry resolves it — an unresolvable id
 * would leave the copy with no family and no descriptor.
 */
/**
 * The model a chat copy starts on: the one the session recorded, else the
 * same provider's default — a Cursor session stays on Cursor — else ADE's
 * fork default.
 */
export function defaultForkModel(summary: ExternalSessionSummary): string {
  const recorded = summary.launch?.model?.trim();
  if (recorded && resolveModelDescriptor(recorded)) return recorded;
  return getDefaultModelDescriptor(summary.provider)?.id ?? DEFAULT_FORK_MODEL;
}

export function modelDisplayName(model: string | null | undefined): string | null {
  const trimmed = model?.trim();
  if (!trimmed) return null;
  return resolveModelDescriptor(trimmed)?.displayName ?? trimmed;
}

const SURFACE_STORAGE_PREFIX = "ade.importSession.surface.";

export function readSurfacePreference(provider: ExternalSessionProvider): ImportSurface | null {
  try {
    const value = window.localStorage.getItem(`${SURFACE_STORAGE_PREFIX}${provider}`);
    return value === "chat" || value === "cli" ? value : null;
  } catch {
    return null;
  }
}

export function writeSurfacePreference(provider: ExternalSessionProvider, surface: ImportSurface): void {
  try {
    window.localStorage.setItem(`${SURFACE_STORAGE_PREFIX}${provider}`, surface);
  } catch {
    // Storage full or blocked: the choice still holds for this dialog.
  }
}

/**
 * Older hosts send only `messages`; render them through the same transcript as
 * user bubbles and assistant text so the preview never goes blank.
 */
export function eventsFromMessages(
  messages: readonly ExternalSessionMessage[],
  transcriptKey: string,
): AgentChatEventEnvelope[] {
  return messages.map((message, index) => {
    const timestamp = new Date(message.at ?? index).toISOString();
    return {
      sessionId: transcriptKey,
      timestamp,
      sequence: index,
      event: message.role === "user"
        ? { type: "user_message", text: message.text }
        : { type: "text", text: message.text, messageId: `${transcriptKey}:${index}` },
    };
  });
}

function envelopeIdentity(envelope: AgentChatEventEnvelope): string {
  const event = envelope.event as { type: string; itemId?: string; messageId?: string };
  return `${envelope.timestamp}|${event.type}|${event.itemId ?? event.messageId ?? ""}`;
}

/**
 * Applies a fresh newest page on top of events the user already paged back
 * through. The new page replaces everything from its first event onward; when
 * the page no longer overlaps (the session grew past a whole page), the caller
 * gets null and starts over from the new page.
 */
export function spliceNewestPage(
  current: readonly AgentChatEventEnvelope[],
  newest: readonly AgentChatEventEnvelope[],
): AgentChatEventEnvelope[] | null {
  if (!newest.length) return null;
  const first = envelopeIdentity(newest[0]!);
  for (let index = current.length - 1; index >= 0; index -= 1) {
    if (envelopeIdentity(current[index]!) === first) {
      return [...current.slice(0, index), ...newest];
    }
  }
  return null;
}
