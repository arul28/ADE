import {
  externalSessionImportAffordances as importAffordancesFor,
  shortenExternalSessionCwd as shortenCwd,
  type ImportAffordance,
} from "../../../desktop/src/shared/externalSessionAffordances";
import type {
  ExternalSessionProvider,
  ExternalSessionSummary,
} from "../../../desktop/src/shared/types/externalSessions";
import type { RightPaneContent } from "./types";

export { importAffordancesFor, shortenCwd };
export type { ImportAffordance };

export type ExternalSessionBrowserAction = ImportAffordance | {
  kind: "open-existing";
  label: string;
  description: string;
  hero: true;
  enabled: true;
  importedSessionRef: { kind: "chat" | "cli"; sessionId: string };
};

export function isImportAffordance(
  action: ExternalSessionBrowserAction,
): action is ImportAffordance {
  return action.kind !== "open-existing";
}

export function externalSessionBrowserActions(
  session: ExternalSessionSummary,
): ExternalSessionBrowserAction[] {
  const ref = session.importedSessionRef;
  const validRef = session.alreadyImported
    && ref
    && (ref.kind === "chat" || ref.kind === "cli")
    && ref.sessionId.trim().length > 0
      ? { kind: ref.kind, sessionId: ref.sessionId.trim() }
      : null;
  const imports = importAffordancesFor(session);
  if (!validRef) return imports;
  return [
    {
      kind: "open-existing",
      label: "Open existing ADE session",
      description: "Opens the ADE session already linked to this provider session.",
      hero: true,
      enabled: true,
      importedSessionRef: validRef,
    },
    ...imports.filter((action) => action.mode === "fork"),
  ];
}

export const EXTERNAL_SESSION_PROVIDER_FILTERS = [
  "all",
  "claude",
  "codex",
  "cursor",
  "droid",
  "opencode",
] as const;

export type ExternalSessionProviderFilter = (typeof EXTERNAL_SESSION_PROVIDER_FILTERS)[number];

const PROVIDER_LABELS: Record<ExternalSessionProvider, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  droid: "Droid",
  opencode: "OpenCode",
};

export function externalSessionProviderLabel(provider: ExternalSessionProvider | "all"): string {
  return provider === "all" ? "All" : PROVIDER_LABELS[provider] ?? provider;
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
        session.id,
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

export function clampExternalSessionBrowserContent(
  content: Extract<RightPaneContent, { kind: "external-session-browser" }>,
): Extract<RightPaneContent, { kind: "external-session-browser" }> {
  const visible = visibleExternalSessions(content.sessions, content.providerFilter, content.query);
  const selectedIndex = visible.length
    ? Math.min(Math.max(0, content.selectedIndex), visible.length - 1)
    : 0;
  const selected = visible[selectedIndex] ?? null;
  const actions = selected ? externalSessionBrowserActions(selected) : [];
  const actionIndex = actions.length
    ? Math.min(Math.max(0, content.actionIndex), actions.length - 1)
    : 0;
  return selectedIndex === content.selectedIndex && actionIndex === content.actionIndex
    ? content
    : { ...content, selectedIndex, actionIndex };
}

export function externalSessionActionKey(
  session: ExternalSessionSummary,
  affordance: Pick<ExternalSessionBrowserAction, "kind">,
): string {
  return `${session.provider}:${session.id}:${affordance.kind}`;
}
