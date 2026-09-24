import { shortenExternalSessionCwd as shortenCwd } from "../../../desktop/src/shared/externalSessionAffordances";
import {
  planImport,
  type ImportPlan,
  type ImportPlanAction,
  type ImportSurface,
} from "../../../desktop/src/shared/externalSessionPolicy";
import {
  EXTERNAL_SESSION_PROVIDER_LABELS,
  EXTERNAL_SESSION_PROVIDERS,
  type ExternalSessionProvider,
  type ExternalSessionSummary,
} from "../../../desktop/src/shared/types/externalSessions";
import type { RightPaneContent } from "./types";

export { shortenCwd };

type BrowserContent = Extract<RightPaneContent, { kind: "external-session-browser" }>;

export const EXTERNAL_SESSION_SURFACE_LABELS: Record<ImportSurface, string> = {
  chat: "ADE chat",
  cli: "CLI",
};

/** One import the plan offers, flattened into the TUI's action list. */
export type ExternalSessionImportEntry = {
  kind: "import";
  /** Stable per session: `<surface>:<mode>`. */
  key: string;
  surface: ImportSurface;
  action: ImportPlanAction;
  label: string;
  /** The main button of its surface (vs the secondary "Copy"). */
  primary: boolean;
  /** Lane the import runs in; the plan's target after locking. */
  laneId: string | null;
  laneLocked: boolean;
  lockReason: string | null;
  note: string | null;
  /** Continuing a session that may be open elsewhere asks for a second Enter. */
  needsConfirm: boolean;
};

export type ExternalSessionOpenExistingEntry = {
  kind: "open-existing";
  key: "open-existing";
  label: string;
  description: string;
  importedSessionRef: { kind: "chat" | "cli"; sessionId: string };
};

export type ExternalSessionBrowserAction = ExternalSessionImportEntry | ExternalSessionOpenExistingEntry;

export function isImportEntry(action: ExternalSessionBrowserAction): action is ExternalSessionImportEntry {
  return action.kind === "import";
}

/** The session's own lane when it has a live one. */
export function externalSessionHomeLaneId(session: ExternalSessionSummary): string | null {
  const home = session.home;
  return home?.kind === "lane" && home.laneId ? home.laneId : null;
}

/**
 * Where an import goes unless the user picks another lane: the session's home
 * lane, else the lane `/import` was opened from.
 */
export function defaultExternalSessionTargetLane(
  session: ExternalSessionSummary,
  fallbackLaneId: string | null,
): string | null {
  return externalSessionHomeLaneId(session) ?? fallbackLaneId;
}

export type ExternalSessionTargetOptions = {
  /** Lane `/import` was opened from. */
  fallbackLaneId: string | null;
  /** Lane the user picked for this row, if any. */
  targetLaneId?: string | null;
  laneName?: (laneId: string) => string | null;
};

export function resolveExternalSessionTargetLane(
  session: ExternalSessionSummary,
  options: ExternalSessionTargetOptions,
): string | null {
  return options.targetLaneId ?? defaultExternalSessionTargetLane(session, options.fallbackLaneId);
}

/** The plan for every surface the provider offers, in display order. */
export function externalSessionPlans(
  session: ExternalSessionSummary,
  options: ExternalSessionTargetOptions,
): ImportPlan[] {
  const targetLaneId = resolveExternalSessionTargetLane(session, options);
  const first = planImport(session, { surface: null, targetLaneId, laneName: options.laneName });
  return first.surfaces.map((surface) => surface === first.surface
    ? first
    : planImport(session, { surface, targetLaneId, laneName: options.laneName }));
}

function importEntries(
  session: ExternalSessionSummary,
  options: ExternalSessionTargetOptions,
): ExternalSessionImportEntry[] {
  const entries: ExternalSessionImportEntry[] = [];
  for (const plan of externalSessionPlans(session, options)) {
    if (!plan.surface) continue;
    for (const [action, primary] of [[plan.primary, true], [plan.secondary, false]] as const) {
      if (!action) continue;
      entries.push({
        kind: "import",
        key: `${plan.surface}:${action.mode}`,
        surface: plan.surface,
        action,
        label: `${EXTERNAL_SESSION_SURFACE_LABELS[plan.surface]} · ${action.label}`,
        primary,
        laneId: plan.targetLaneId,
        laneLocked: plan.laneLocked,
        lockReason: plan.lockReason,
        // The note describes the main action; the secondary copy never carries it.
        note: primary ? plan.note : null,
        needsConfirm: action.mode === "resume" && session.possiblyActive,
      });
    }
  }
  return entries;
}

/**
 * The action list for one row, straight from `planImport`: one entry per
 * action each surface offers. A row already imported opens its ADE session by
 * default and only offers copies — continuing it again would fork the thread.
 */
export function externalSessionBrowserActions(
  session: ExternalSessionSummary,
  options: ExternalSessionTargetOptions = { fallbackLaneId: null },
): ExternalSessionBrowserAction[] {
  const ref = session.importedSessionRef;
  const validRef = session.alreadyImported
    && ref
    && (ref.kind === "chat" || ref.kind === "cli")
    && ref.sessionId.trim().length > 0
      ? { kind: ref.kind, sessionId: ref.sessionId.trim() }
      : null;
  const imports = importEntries(session, options);
  if (!validRef) return imports;
  return [
    {
      kind: "open-existing",
      key: "open-existing",
      label: "Open existing ADE session",
      description: "Opens the ADE session already linked to this provider session.",
      importedSessionRef: validRef,
    },
    ...imports.filter((entry) => entry.action.mode === "fork"),
  ];
}

/** Target options for the row a browser pane has selected. */
export function externalSessionBrowserTargetOptions(
  content: BrowserContent,
): ExternalSessionTargetOptions {
  const pickedLabel = content.targetLaneId ? content.targetLaneLabel ?? null : null;
  return {
    fallbackLaneId: content.laneId,
    targetLaneId: content.targetLaneId ?? null,
    laneName: (laneId) => {
      if (pickedLabel && laneId === content.targetLaneId) return pickedLabel;
      if (laneId === content.laneId) return content.laneLabel;
      return null;
    },
  };
}

/** Display name of the lane an action runs in. */
export function externalSessionTargetLaneName(
  session: ExternalSessionSummary,
  laneId: string | null,
  options: ExternalSessionTargetOptions,
): string {
  if (!laneId) return "this lane";
  return options.laneName?.(laneId)
    ?? (laneId === externalSessionHomeLaneId(session) ? session.home?.laneName ?? null : null)
    ?? laneId;
}

/**
 * Lane label for a row: the home lane's name, "Removed lane", or the last
 * folders of a path outside every lane. Older hosts send no `home`; the
 * folder is all there is then.
 */
export function externalSessionLaneLabel(session: ExternalSessionSummary): string {
  const home = session.home;
  if (home?.kind === "lane") return home.laneName?.trim() || "Lane";
  if (home?.kind === "removed-lane") return "Removed lane";
  if (home?.kind === "outside") return shortenCwd(session.cwd, { maxSegments: 2 }) || "Other folder";
  return shortenCwd(session.cwd, { maxSegments: 4 }) || "Unknown folder";
}

/** Human size for `sizeBytes`, or null when the host did not send one. */
export function formatExternalSessionSize(bytes: number | null | undefined): string | null {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/**
 * The lane after `currentLaneId` in `laneIds`, wrapping. Used by the lane
 * picker key; returns null when there is nowhere to move.
 */
export function nextExternalSessionTargetLane(
  laneIds: readonly string[],
  currentLaneId: string | null,
  delta = 1,
): string | null {
  if (!laneIds.length) return null;
  const index = currentLaneId ? laneIds.indexOf(currentLaneId) : -1;
  if (index < 0) return laneIds[delta >= 0 ? 0 : laneIds.length - 1] ?? null;
  return laneIds[(index + delta + laneIds.length) % laneIds.length] ?? null;
}

export type ExternalSessionProviderFilter = "all" | ExternalSessionProvider;

export const EXTERNAL_SESSION_PROVIDER_FILTERS: readonly ExternalSessionProviderFilter[] = [
  "all",
  ...EXTERNAL_SESSION_PROVIDERS,
];

const PROVIDER_LABELS = EXTERNAL_SESSION_PROVIDER_LABELS;

export function externalSessionProviderLabel(provider: ExternalSessionProvider | "all"): string {
  return provider === "all" ? "All" : PROVIDER_LABELS[provider] ?? provider;
}

/** Collapses provider text to one line so a TUI row can print it without wrapping. */
function collapseLine(value: string | null | undefined): string | null {
  const collapsed = value?.replace(/\s+/gu, " ").trim();
  return collapsed ? collapsed : null;
}

/**
 * Row heading, mirroring the desktop browser's `sessionHeading`: a provider-persisted
 * title when there is one, otherwise the opening prompt, otherwise the raw id. Most
 * Claude CLI transcripts carry no title, so without the prompt fallback the row would
 * name itself with a uuid.
 */
export function externalSessionRowTitle(session: ExternalSessionSummary): string {
  return collapseLine(session.title) ?? collapseLine(session.preview) ?? session.id;
}

/**
 * The two anchors the selected row prints: what the thread started as, and where it left
 * off. Either can be absent — an older host sends no `messages` at all, and neither
 * anchor may repeat text the row is already showing. The TUI gives each anchor a single
 * truncated line, so a duplicate reads as a rendering bug rather than as emphasis.
 */
export function externalSessionAnchors(session: ExternalSessionSummary): {
  started: string | null;
  latest: string | null;
} {
  const heading = externalSessionRowTitle(session);
  const started = collapseLine(session.preview);
  const messages = session.messages ?? [];
  const latest = collapseLine(messages[messages.length - 1]?.text);
  return {
    started: started && started !== heading ? started : null,
    latest: latest && latest !== heading && latest !== started ? latest : null,
  };
}

export function normalizeExternalSessionListResult(result: unknown): ExternalSessionSummary[] {
  if (Array.isArray(result)) return result as ExternalSessionSummary[];
  if (!result || typeof result !== "object") return [];
  const sessions = (result as { sessions?: unknown }).sessions;
  return Array.isArray(sessions) ? sessions as ExternalSessionSummary[] : [];
}

export function visibleExternalSessions(
  sessions: readonly ExternalSessionSummary[],
  providerFilter: ExternalSessionProviderFilter,
  query: string,
): ExternalSessionSummary[] {
  const needle = query.trim().toLowerCase();
  return sessions
    .filter((session) => providerFilter === "all" || session.provider === providerFilter)
    .filter((session) => {
      if (!needle) return true;
      return [
        session.title,
        session.preview,
        session.cwd,
        session.home?.laneName,
        session.id,
        // Search the whole thread sample, not just the title: the words you remember
        // from a conversation are usually in the conversation, and provider titles are
        // frequently absent entirely. Matches the desktop browser's corpus.
        ...(session.messages ?? []).map((message) => message.text),
      ]
        .filter((value): value is string => typeof value === "string" && value.length > 0)
        .some((value) => value.toLowerCase().includes(needle));
    })
    .sort((a, b) => {
      const bTime = b.updatedAt ?? b.createdAt ?? 0;
      const aTime = a.updatedAt ?? a.createdAt ?? 0;
      if (bTime !== aTime) return bTime - aTime;
      return (a.title ?? a.id).localeCompare(b.title ?? b.id);
    });
}

export function nextExternalSessionProviderFilter(
  current: ExternalSessionProviderFilter,
  delta = 1,
): ExternalSessionProviderFilter {
  const index = Math.max(0, EXTERNAL_SESSION_PROVIDER_FILTERS.indexOf(current));
  return EXTERNAL_SESSION_PROVIDER_FILTERS[
    (index + delta + EXTERNAL_SESSION_PROVIDER_FILTERS.length) % EXTERNAL_SESSION_PROVIDER_FILTERS.length
  ] ?? "all";
}

export function clampExternalSessionBrowserContent(content: BrowserContent): BrowserContent {
  const visible = visibleExternalSessions(content.sessions, content.providerFilter, content.query);
  const selectedIndex = visible.length
    ? Math.min(Math.max(0, content.selectedIndex), visible.length - 1)
    : 0;
  const selected = visible[selectedIndex] ?? null;
  const actions = selected
    ? externalSessionBrowserActions(selected, externalSessionBrowserTargetOptions(content))
    : [];
  const actionIndex = actions.length
    ? Math.min(Math.max(0, content.actionIndex), actions.length - 1)
    : 0;
  return selectedIndex === content.selectedIndex && actionIndex === content.actionIndex
    ? content
    : { ...content, selectedIndex, actionIndex };
}

export function externalSessionActionKey(
  session: Pick<ExternalSessionSummary, "provider" | "id">,
  action: Pick<ExternalSessionBrowserAction, "key">,
): string {
  return `${session.provider}:${session.id}:${action.key}`;
}
