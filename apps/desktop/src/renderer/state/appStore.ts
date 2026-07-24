import React, { createContext, useContext, type ReactNode } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { StateCreator } from "zustand";
import type { KeybindingsSnapshot, LaneDeleteProgress, LaneListSnapshot, LaneSummary, OpenProjectBinding, ProjectInfo, ProjectPathInspection, ProviderMode, TerminalSessionSummary } from "../../shared/types";
import { MODEL_REGISTRY, type ModelDescriptor } from "../../shared/modelRegistry";
import { parseCodedErrorMessage } from "../lib/codedError";
import { toAdeRecoveryErrorCode } from "../../shared/types/recovery";
import { isWebClientMode } from "../lib/webClientMode";
import { getAiStatusCached, invalidateAiDiscoveryCache } from "../lib/aiDiscoveryCache";
import { hasConfiguredAiProvider } from "../lib/aiProviderStatus";
import { getKeybindingsCoalesced, listLaneSnapshotsCoalesced, listLanesCoalesced } from "../lib/laneReadCache";
import { getProjectConfigCached, invalidateProjectConfigCache } from "../lib/projectConfigCache";
import type { DraftLaunchJob } from "../lib/draftLaunchJobs";
import type { HandoffLaunchJob } from "../lib/handoffLaunchJobs";

export type ThemeId = "dark" | "light";
export const THEME_IDS: ThemeId[] = ["dark", "light"];
export const DEFAULT_TERMINAL_FONT_FAMILY = [
  "ui-monospace",
  "SFMono-Regular",
  "Menlo",
  "Monaco",
  "\"Cascadia Mono\"",
  "\"JetBrains Mono\"",
  "\"Geist Mono\"",
  "monospace",
].join(", ");
export type TerminalPreferences = {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  scrollback: number;
};
export const DEFAULT_TERMINAL_PREFERENCES: TerminalPreferences = {
  fontFamily: DEFAULT_TERMINAL_FONT_FAMILY,
  // Integer so device cell metrics stay whole — a fractional 12.5 gave the
  // xterm.js WebGL renderer fractional cell widths that crowd glyphs (spaces
  // collapse) and dash box-drawing borders for TUI clients (e.g. `ade code`).
  fontSize: 13,
  lineHeight: 1.25,
  scrollback: 10_000,
};

/** Where the copy control sits on fenced code blocks in chat.
 *  - "top" / "bottom": fixed absolute corner (touch-friendly when bottom).
 *  - "auto": sticks to the top of the viewport while a long block is being scrolled. */
export type CodeBlockCopyButtonPosition = "top" | "bottom" | "auto";
export const CODE_BLOCK_COPY_POSITION_IDS: CodeBlockCopyButtonPosition[] = ["top", "bottom", "auto"];

/** Web Audio chime when an agent chat turn finishes (idle session). */
export type AgentTurnCompletionSound = "off" | "chime" | "ping" | "bell";
export const AGENT_TURN_COMPLETION_SOUND_IDS: AgentTurnCompletionSound[] = ["off", "chime", "ping", "bell"];
export const DEFAULT_AGENT_TURN_COMPLETION_SOUND_VOLUME = 0.7;

function normalizeCodeBlockCopyButtonPosition(value: unknown): CodeBlockCopyButtonPosition {
  if (value === "bottom" || value === "auto") return value;
  return "top";
}

function normalizeAgentTurnCompletionSound(value: unknown): AgentTurnCompletionSound {
  if (value === "chime" || value === "ping" || value === "bell") return value;
  return "off";
}

function normalizeAgentTurnCompletionSoundVolume(value: unknown): number {
  const next = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(next)) return DEFAULT_AGENT_TURN_COMPLETION_SOUND_VOLUME;
  return Math.max(0, Math.min(1, next));
}

/** Base chat body font size in px (timeline + composer scale from this). Default matches prior ~14px body. */
export const DEFAULT_CHAT_FONT_SIZE_PX = 14;
export const CHAT_FONT_SIZE_MIN_PX = 12;
export const CHAT_FONT_SIZE_MAX_PX = 24;

function normalizeChatFontSizePx(value: unknown): number {
  const next = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(next)) return DEFAULT_CHAT_FONT_SIZE_PX;
  return Math.max(CHAT_FONT_SIZE_MIN_PX, Math.min(CHAT_FONT_SIZE_MAX_PX, Math.round(next)));
}

function normalizeChatUserMinimapEnabled(value: unknown): boolean {
  return value !== false;
}

/** Vertical rhythm in agent chat transcript only (row gaps + bubble padding scale). */
export type ChatTranscriptDensity = "compact" | "comfortable" | "spacious";
export const CHAT_TRANSCRIPT_DENSITY_IDS: ChatTranscriptDensity[] = ["compact", "comfortable", "spacious"];

/** Monochrome (gray) chat chrome vs provider-colored accents and tint — default is colored. */
export type ChatChromeTint = "neutral" | "colored";
export const CHAT_CHROME_TINT_IDS: ChatChromeTint[] = ["neutral", "colored"];

/** @deprecated Lane-accent presets were replaced by `CHAT_CHROME_TINT_IDS` / `ChatChromeTint`. Kept exported so stale importers (e.g. HMR) do not crash. */
export const CHAT_LANE_ACCENT_EMPHASIS_IDS = ["subtle", "standard", "strong"] as const;
/** @deprecated Use `ChatChromeTint`. */
export type ChatLaneAccentEmphasis = (typeof CHAT_LANE_ACCENT_EMPHASIS_IDS)[number];

/** Shell corner rounding presets for chat surfaces. */
export type ChatShellGeometry = "soft" | "default" | "sharp";
export const CHAT_SHELL_GEOMETRY_IDS: ChatShellGeometry[] = ["soft", "default", "sharp"];

function normalizeChatTranscriptDensity(value: unknown): ChatTranscriptDensity {
  if (value === "compact" || value === "spacious") return value;
  return "comfortable";
}

function normalizeChatChromeTint(value: unknown): ChatChromeTint {
  if (value === "neutral") return "neutral";
  return "colored";
}

/** Migrate persisted lane-accent presets (removed) and legacy keys to chrome tint. */
function coercePersistedChatChromeTint(parsed: Record<string, unknown>): ChatChromeTint {
  const direct = parsed.chatChromeTint ?? parsed.chatLaneAccentEmphasis;
  if (direct === "neutral") return "neutral";
  return "colored";
}

function normalizeChatShellGeometry(value: unknown): ChatShellGeometry {
  if (value === "soft" || value === "sharp") return value;
  return "default";
}
export type TerminalAttentionIndicator = "none" | "running-active" | "running-needs-attention";
export type WorkSidebarTab = "terminal" | "git" | "files" | "ios" | "app-control" | "browser";
export type WorkDraftKind = "chat" | "cli";
/** How sessions are grouped in the Work sidebar list. */
export type WorkSessionListOrganization =
  | "all-lanes-by-status"
  | "by-lane"
  | "by-time";
/**
 * A Cursor-style grid: a set of chat/CLI sessions that share the work area in a
 * resizable split layout. `sessionIds` is the membership (drives the sidebar
 * grid badge); the actual split geometry persists separately under `layoutId`
 * via `window.ade.tilingTree`. A session belongs to at most one grid set.
 */
export type WorkGridSet = {
  id: string;
  layoutId: string;
  sessionIds: string[];
};
export type WorkProjectViewState = {
  openItemIds: string[];
  activeItemId: string | null;
  selectedItemId: string | null;
  /** Cursor-style grids. A session is in at most one set. */
  gridSets: WorkGridSet[];
  /** The grid set currently shown in the work area (derived-from/synced-with the focused session). */
  activeGridSetId: string | null;
  draftKind: WorkDraftKind;
  /**
   * Whether the new-chat composer launches an orchestrator (lead) run. This is
   * an orthogonal flag on the single unified draft — not a third `draftKind` —
   * so toggling chat↔cli↔orchestrator never splits the prompt/model/lane state.
   * CLI mode forces this off (orchestrator has no CLI form).
   */
  orchestratorEnabled: boolean;
  draftLaneId: string | null;
  laneFilter: string;
  search: string;
  /** Session list grouping mode. */
  sessionListOrganization: WorkSessionListOrganization;
  /** Lane ids collapsed in "by-lane" folder view (others expanded). */
  workCollapsedLaneIds: string[];
  /** Tab group ids collapsed in the Work tab strip. */
  workCollapsedTabGroupIds: string[];
  /** Section ids collapsed in status/time sidebar groupings (e.g. "status:running", "time:today"). */
  workCollapsedSectionIds: string[];
  /** When true, sessions sidebar is hidden for a full-width content area (persisted per project). */
  workFocusSessionsHidden: boolean;
  /** Global Work right sidebar state; content follows the active lane/session. */
  workSidebarOpen: boolean;
  workSidebarTab: WorkSidebarTab;
  workSidebarWidthPct: number;
  /** Per-lane custom tab ordering for the grouped Work tab strip. */
  laneSessionOrder: Record<string, string[]>;
  /** Session ids pinned to the front of their lane's tab group. */
  pinnedSessionIds: string[];
};
export type TerminalAttentionSnapshot = {
  runningCount: number;
  activeCount: number;
  needsAttentionCount: number;
  indicator: TerminalAttentionIndicator;
  byLaneId: Record<string, {
    runningCount: number;
    activeCount: number;
    needsAttentionCount: number;
    indicator: TerminalAttentionIndicator;
  }>;
};

const EMPTY_TERMINAL_ATTENTION: TerminalAttentionSnapshot = {
  runningCount: 0,
  activeCount: 0,
  needsAttentionCount: 0,
  indicator: "none",
  byLaneId: {}
};

const WORK_VIEW_STORAGE_KEY = "ade.workViewState.v1";
const TERMINAL_PREFERENCES_STORAGE_KEY = "ade.terminalPreferences.v1";
const USER_PREFERENCES_STORAGE_KEY = "ade.userPreferences.v1";
const LANE_CACHE_STORAGE_PREFIX = "ade.laneCache.v1:";
const LANE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function createDefaultWorkProjectViewState(): WorkProjectViewState {
  return {
    openItemIds: [],
    activeItemId: null,
    selectedItemId: null,
    gridSets: [],
    activeGridSetId: null,
    draftKind: "chat",
    orchestratorEnabled: false,
    draftLaneId: null,
    laneFilter: "all",
    search: "",
    sessionListOrganization: "by-lane",
    workCollapsedLaneIds: [],
    workCollapsedTabGroupIds: [],
    // Settled starts collapsed: the tier is present but quiet by default.
    workCollapsedSectionIds: ["status:settled"],
    workFocusSessionsHidden: false,
    workSidebarOpen: false,
    workSidebarTab: "git",
    workSidebarWidthPct: 36,
    laneSessionOrder: {},
    pinnedSessionIds: [],
  };
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function normalizeOptionalString(value: unknown): string | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized.length > 0 ? normalized : null;
}

function normalizeWorkSidebarTab(value: unknown): WorkSidebarTab {
  if (
    value === "terminal"
    || value === "files"
    || value === "ios"
    || value === "app-control"
    || value === "browser"
  ) return value;
  return "git";
}

function normalizeWorkSidebarWidthPct(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 36;
  return Math.max(26, Math.min(55, n));
}

function normalizeWorkProjectViewState(value: unknown): WorkProjectViewState {
  const candidate = value && typeof value === "object"
    ? value as Partial<WorkProjectViewState>
    : {};
  return {
    openItemIds: normalizeStringArray(candidate.openItemIds),
    activeItemId: normalizeOptionalString(candidate.activeItemId),
    selectedItemId: normalizeOptionalString(candidate.selectedItemId),
    gridSets: normalizeWorkGridSets(candidate.gridSets),
    activeGridSetId: normalizeOptionalString(candidate.activeGridSetId),
    draftKind: candidate.draftKind === "cli" ? "cli" : "chat",
    // Legacy persisted state stored orchestrator as a third draftKind
    // ("chat-orchestrator"); migrate it onto the orthogonal boolean. CLI mode
    // forces orchestrator off, so never resolve both at once.
    orchestratorEnabled:
      candidate.draftKind !== "cli"
      && (candidate.orchestratorEnabled === true
        || (candidate as { draftKind?: unknown }).draftKind === "chat-orchestrator"),
    draftLaneId: normalizeOptionalString(candidate.draftLaneId),
    laneFilter: normalizeOptionalString(candidate.laneFilter) ?? "all",
    search: typeof candidate.search === "string" ? candidate.search : "",
    sessionListOrganization:
      candidate.sessionListOrganization === "all-lanes-by-status"
      || candidate.sessionListOrganization === "by-time"
        ? candidate.sessionListOrganization
        : "by-lane",
    workCollapsedLaneIds: normalizeStringArray(candidate.workCollapsedLaneIds),
    workCollapsedTabGroupIds: normalizeStringArray(candidate.workCollapsedTabGroupIds),
    workCollapsedSectionIds: normalizeStringArray(candidate.workCollapsedSectionIds),
    workFocusSessionsHidden: candidate.workFocusSessionsHidden === true,
    workSidebarOpen: candidate.workSidebarOpen === true,
    workSidebarTab: normalizeWorkSidebarTab(candidate.workSidebarTab),
    workSidebarWidthPct: normalizeWorkSidebarWidthPct(candidate.workSidebarWidthPct),
    laneSessionOrder: normalizeLaneSessionOrder(candidate.laneSessionOrder),
    pinnedSessionIds: normalizeStringArray(candidate.pinnedSessionIds),
  };
}

/** Normalize persisted grid sets: drop empties, dedupe a session into one set. */
function normalizeWorkGridSets(value: unknown): WorkGridSet[] {
  if (!Array.isArray(value)) return [];
  const out: WorkGridSet[] = [];
  const seenSessionIds = new Set<string>();
  const seenSetIds = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as Partial<WorkGridSet>;
    const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
    const layoutId = typeof candidate.layoutId === "string" ? candidate.layoutId.trim() : "";
    if (!id || !layoutId || seenSetIds.has(id)) continue;
    const sessionIds = normalizeStringArray(candidate.sessionIds).filter((sid) => {
      if (seenSessionIds.has(sid)) return false;
      seenSessionIds.add(sid);
      return true;
    });
    // A "grid" needs at least 2 members; a 0/1-member set collapses to single view.
    if (sessionIds.length < 2) continue;
    seenSetIds.add(id);
    out.push({ id, layoutId, sessionIds });
  }
  return out;
}

function normalizeLaneSessionOrder(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, string[]> = {};
  for (const [laneId, ids] of Object.entries(value as Record<string, unknown>)) {
    const trimmedLaneId = typeof laneId === "string" ? laneId.trim() : "";
    if (!trimmedLaneId) continue;
    const list = normalizeStringArray(ids);
    if (list.length > 0) out[trimmedLaneId] = list;
  }
  return out;
}

const WORK_VIEW_STATE_VERSION = 2;

function readPersistedWorkViewState(): {
  workViewByProject: Record<string, WorkProjectViewState>;
  laneWorkViewByScope: Record<string, WorkProjectViewState>;
} {
  try {
    const raw = window.localStorage.getItem(WORK_VIEW_STORAGE_KEY);
    if (!raw) {
      return { workViewByProject: {}, laneWorkViewByScope: {} };
    }
    const parsed = JSON.parse(raw) as {
      version?: unknown;
      workViewByProject?: Record<string, unknown>;
      laneWorkViewByScope?: Record<string, unknown>;
    };
    const persistedVersion =
      typeof parsed.version === "number" && Number.isFinite(parsed.version)
        ? parsed.version
        : 1;
    const migrateSettledCollapse = persistedVersion < WORK_VIEW_STATE_VERSION;
    const workViewByProject: Record<string, WorkProjectViewState> = {};
    const laneWorkViewByScope: Record<string, WorkProjectViewState> = {};
    for (const [projectRoot, viewState] of Object.entries(parsed.workViewByProject ?? {})) {
      const key = normalizeProjectKey(projectRoot);
      if (!key) continue;
      const normalized = normalizeWorkProjectViewState(viewState);
      workViewByProject[key] = migrateSettledCollapse
        && !normalized.workCollapsedSectionIds.includes("status:settled")
        ? {
            ...normalized,
            workCollapsedSectionIds: [...normalized.workCollapsedSectionIds, "status:settled"],
          }
        : normalized;
    }
    for (const [scopeKey, viewState] of Object.entries(parsed.laneWorkViewByScope ?? {})) {
      const dividerIndex = scopeKey.indexOf("::");
      if (dividerIndex <= 0 || dividerIndex >= scopeKey.length - 2) continue;
      const projectRoot = normalizeProjectKey(scopeKey.slice(0, dividerIndex));
      const laneId = scopeKey.slice(dividerIndex + 2).trim();
      if (!projectRoot || !laneId) continue;
      const normalized = normalizeWorkProjectViewState(viewState);
      laneWorkViewByScope[`${projectRoot}::${laneId}`] = migrateSettledCollapse
        && !normalized.workCollapsedSectionIds.includes("status:settled")
        ? {
            ...normalized,
            workCollapsedSectionIds: [...normalized.workCollapsedSectionIds, "status:settled"],
          }
        : normalized;
    }
    return { workViewByProject, laneWorkViewByScope };
  } catch {
    return { workViewByProject: {}, laneWorkViewByScope: {} };
  }
}

let _debouncePersistTimer: ReturnType<typeof setTimeout> | null = null;

function persistWorkViewState(args: {
  workViewByProject: Record<string, WorkProjectViewState>;
  laneWorkViewByScope: Record<string, WorkProjectViewState>;
}): void {
  if (_debouncePersistTimer != null) {
    clearTimeout(_debouncePersistTimer);
    _debouncePersistTimer = null;
  }
  try {
    window.localStorage.setItem(
      WORK_VIEW_STORAGE_KEY,
      JSON.stringify({ version: WORK_VIEW_STATE_VERSION, ...args }),
    );
  } catch {
    // ignore
  }
}

/** Debounced persist: batches rapid setter calls into a single localStorage write. */
function debouncedPersistWorkViewState(args: {
  workViewByProject: Record<string, WorkProjectViewState>;
  laneWorkViewByScope: Record<string, WorkProjectViewState>;
}): void {
  if (_debouncePersistTimer != null) clearTimeout(_debouncePersistTimer);
  _debouncePersistTimer = setTimeout(() => {
    _debouncePersistTimer = null;
    persistWorkViewState(args);
  }, 300);
}

function normalizeProjectKey(projectRoot: string | null | undefined): string {
  return typeof projectRoot === "string" ? projectRoot.trim() : "";
}

export function projectStateKeyForBinding(
  binding: OpenProjectBinding | null | undefined,
  fallbackRoot?: string | null,
): string {
  if (binding?.kind === "remote") return normalizeProjectKey(binding.key);
  return normalizeProjectKey(binding?.rootPath ?? fallbackRoot);
}

export function selectActiveProjectStateKey(
  state: Pick<AppState, "project" | "projectBinding">,
): string | null {
  return projectStateKeyForBinding(state.projectBinding, state.project?.rootPath) || null;
}

function resolveProjectStateKey(
  state: Pick<AppState, "project" | "projectBinding">,
  projectRootOrKey: string | null | undefined,
): string {
  const requested = normalizeProjectKey(projectRootOrKey);
  if (!requested) return "";
  const binding = state.projectBinding;
  if (
    binding?.kind === "remote"
    && (requested === binding.rootPath || requested === binding.key)
  ) {
    return binding.key;
  }
  return requested;
}

/**
 * Drops keys from a session-dismiss map that aren't in the allow-list. Used on project
 * close/switch so banner-dismiss maps don't grow unbounded across a long session.
 */
function pickDismissMapForRoots(map: Record<string, true>, roots: readonly (string | null | undefined)[]): Record<string, true> {
  const allow = new Set(roots.map((r) => normalizeProjectKey(r)).filter((r) => r.length > 0));
  if (allow.size === 0) return {};
  const next: Record<string, true> = {};
  for (const key of Object.keys(map)) if (allow.has(key)) next[key] = true;
  return next;
}

function normalizeLaneWorkScopeKey(projectRoot: string | null | undefined, laneId: string | null | undefined): string {
  const projectKey = normalizeProjectKey(projectRoot);
  const normalizedLaneId = typeof laneId === "string" ? laneId.trim() : "";
  if (!projectKey || !normalizedLaneId) return "";
  return `${projectKey}::${normalizedLaneId}`;
}

function removeWorkViewStateForProject(
  projectRoot: string | null | undefined,
  workViewByProject: Record<string, WorkProjectViewState>,
  laneWorkViewByScope: Record<string, WorkProjectViewState>,
): {
  workViewByProject: Record<string, WorkProjectViewState>;
  laneWorkViewByScope: Record<string, WorkProjectViewState>;
} {
  const projectKey = normalizeProjectKey(projectRoot);
  if (!projectKey) return { workViewByProject, laneWorkViewByScope };
  const nextWorkViewByProject = { ...workViewByProject };
  delete nextWorkViewByProject[projectKey];
  const nextLaneWorkViewByScope = { ...laneWorkViewByScope };
  const laneScopePrefix = `${projectKey}::`;
  for (const key of Object.keys(nextLaneWorkViewByScope)) {
    if (key.startsWith(laneScopePrefix)) delete nextLaneWorkViewByScope[key];
  }
  return {
    workViewByProject: nextWorkViewByProject,
    laneWorkViewByScope: nextLaneWorkViewByScope,
  };
}

type WarmLaneCache = { lanes: LaneSummary[]; laneSnapshots: LaneListSnapshot[] };

function laneCacheStorageKey(projectRoot: string): string {
  return `${LANE_CACHE_STORAGE_PREFIX}${encodeURIComponent(projectRoot)}`;
}

function isLaneSummaryCandidate(value: unknown): value is LaneSummary {
  if (!value || typeof value !== "object") return false;
  const lane = value as Partial<LaneSummary>;
  return typeof lane.id === "string"
    && lane.id.trim().length > 0
    && typeof lane.name === "string"
    && lane.name.trim().length > 0;
}

function readPersistedLaneCache(projectRoot: string | null | undefined): WarmLaneCache | null {
  const projectKey = normalizeProjectKey(projectRoot);
  if (!projectKey) return null;
  try {
    const raw = window.localStorage.getItem(laneCacheStorageKey(projectKey));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { savedAt?: unknown; lanes?: unknown };
    const savedAt = typeof parsed.savedAt === "number" ? parsed.savedAt : 0;
    if (!savedAt || Date.now() - savedAt > LANE_CACHE_TTL_MS) {
      window.localStorage.removeItem(laneCacheStorageKey(projectKey));
      return null;
    }
    if (!Array.isArray(parsed.lanes)) return null;
    const lanes = parsed.lanes.filter(isLaneSummaryCandidate);
    return lanes.length > 0 ? { lanes, laneSnapshots: [] } : null;
  } catch {
    return null;
  }
}

function persistLaneCache(projectRoot: string | null | undefined, lanes: LaneSummary[]): void {
  const projectKey = normalizeProjectKey(projectRoot);
  if (!projectKey || lanes.length === 0) return;
  try {
    window.localStorage.setItem(
      laneCacheStorageKey(projectKey),
      JSON.stringify({ savedAt: Date.now(), lanes }),
    );
  } catch {
    // localStorage can be unavailable or full; the in-memory cache still works.
  }
}

function removePersistedLaneCache(projectRoot: string | null | undefined): void {
  const projectKey = normalizeProjectKey(projectRoot);
  if (!projectKey) return;
  try {
    window.localStorage.removeItem(laneCacheStorageKey(projectKey));
  } catch {
    // ignore
  }
}

type PersistedUserPreferences = {
  theme: ThemeId;
  terminalPreferences: TerminalPreferences;
  smartTooltipsEnabled: boolean;
  onboardingEnabled: boolean;
  didYouKnowEnabled: boolean;
  launchPromptClipboardEnabled: boolean;
  launchPromptClipboardNoticeEnabled: boolean;
  voiceInputEnabled: boolean;
  codeBlockCopyButtonPosition: CodeBlockCopyButtonPosition;
  agentTurnCompletionSound: AgentTurnCompletionSound;
  agentTurnCompletionSoundVolume: number;
  agentTurnCompletionSoundQuietWhenFocused: boolean;
  chatFontSizePx: number;
  chatUserMinimapEnabled: boolean;
  chatTranscriptDensity: ChatTranscriptDensity;
  chatChromeTint: ChatChromeTint;
  chatShellGeometry: ChatShellGeometry;
  /** Set true the first time the user changes the chat font size; locks the
   *  large-screen auto-size so it never overrides their choice again. */
  userOverrodeChatFontSize: boolean;
};

// ── Voice dictation (ephemeral, app-global) ────────────────────────────────
//
// These fields back the app-global voice-capture lifecycle that lives in
// `services/globalVoiceRecorder.ts`. They are deliberately EPHEMERAL — never
// persisted and never copied into per-project stores — because they describe a
// single live recording session, not a saved preference. The recorder writes
// them on the ROOT store only, so the always-mounted header indicator and the
// (project-scoped) composer pill both read the same live state.

/** Number of waveform bars the recorder keeps in its rolling level buffer. */
export const DICTATION_WAVEFORM_BARS = 9;

export type DictationPhase = "idle" | "recording" | "transcribing";

/**
 * A composer that has registered itself as the insertion target for dictated
 * text. The recorder calls `insertText(cleaned)` on `finish()` if a target is
 * registered; otherwise the transcript is only copied to the clipboard.
 */
export type ActiveDictationTarget = {
  /** Stable id for the registering composer (used for safe deregistration). */
  id: string;
  /** Insert the cleaned transcript at the composer's caret. */
  insertText: (text: string) => void;
  /** Best-effort focus of the composer's input (called before insertion). */
  focus: () => void;
};

function coerceTheme(value: unknown): ThemeId | null {
  if (value === "dark" || value === "light") return value;
  if (value === "github" || value === "bloomberg" || value === "rainbow" || value === "pats") return "dark";
  if (value === "e-paper" || value === "sky") return "light";
  return null;
}

function readUnifiedUserPreferences(): PersistedUserPreferences | null {
  try {
    const raw = window.localStorage.getItem(USER_PREFERENCES_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedUserPreferences>;
    return {
      theme: coerceTheme(parsed.theme) ?? "dark",
      terminalPreferences: normalizeTerminalPreferences(parsed.terminalPreferences),
      // The help chips / detailed tooltips / did-you-know hints are onboarding
      // aids that default OFF in the browser web client (clutter for an already
      // oriented user), and ON on desktop. An explicit toggle is still honored.
      smartTooltipsEnabled: parsed.smartTooltipsEnabled ?? !isWebClientMode(),
      onboardingEnabled: parsed.onboardingEnabled ?? !isWebClientMode(),
      didYouKnowEnabled: parsed.didYouKnowEnabled ?? !isWebClientMode(),
      launchPromptClipboardEnabled: parsed.launchPromptClipboardEnabled !== false,
      launchPromptClipboardNoticeEnabled: parsed.launchPromptClipboardNoticeEnabled !== false,
      voiceInputEnabled: parsed.voiceInputEnabled !== false,
      codeBlockCopyButtonPosition: normalizeCodeBlockCopyButtonPosition(parsed.codeBlockCopyButtonPosition),
      agentTurnCompletionSound: normalizeAgentTurnCompletionSound(parsed.agentTurnCompletionSound),
      agentTurnCompletionSoundVolume: normalizeAgentTurnCompletionSoundVolume(parsed.agentTurnCompletionSoundVolume),
      agentTurnCompletionSoundQuietWhenFocused: parsed.agentTurnCompletionSoundQuietWhenFocused !== false,
      chatFontSizePx: normalizeChatFontSizePx(parsed.chatFontSizePx),
      chatUserMinimapEnabled: normalizeChatUserMinimapEnabled(parsed.chatUserMinimapEnabled),
      chatTranscriptDensity: normalizeChatTranscriptDensity(parsed.chatTranscriptDensity),
      chatChromeTint: coercePersistedChatChromeTint(parsed as Record<string, unknown>),
      chatShellGeometry: normalizeChatShellGeometry(parsed.chatShellGeometry),
      userOverrodeChatFontSize: parsed.userOverrodeChatFontSize === true,
    };
  } catch {
    return null;
  }
}

function readLegacyUserPreferences(): PersistedUserPreferences {
  let theme: ThemeId = "dark";
  try {
    theme = coerceTheme(window.localStorage.getItem("ade.theme")) ?? "dark";
  } catch {
    // ignore
  }
  let terminalPreferences: TerminalPreferences = { ...DEFAULT_TERMINAL_PREFERENCES };
  try {
    const raw = window.localStorage.getItem(TERMINAL_PREFERENCES_STORAGE_KEY);
    if (raw) terminalPreferences = normalizeTerminalPreferences(JSON.parse(raw));
  } catch {
    // ignore
  }
  let smartTooltipsEnabled = !isWebClientMode();
  try {
    if (window.localStorage.getItem("ade.smartTooltips") === "false") smartTooltipsEnabled = false;
  } catch {
    // ignore
  }
  return {
    theme,
    terminalPreferences,
    smartTooltipsEnabled,
    onboardingEnabled: !isWebClientMode(),
    didYouKnowEnabled: !isWebClientMode(),
    launchPromptClipboardEnabled: true,
    launchPromptClipboardNoticeEnabled: true,
    voiceInputEnabled: true,
    codeBlockCopyButtonPosition: "top",
    agentTurnCompletionSound: "off",
    agentTurnCompletionSoundVolume: DEFAULT_AGENT_TURN_COMPLETION_SOUND_VOLUME,
    agentTurnCompletionSoundQuietWhenFocused: true,
    chatFontSizePx: DEFAULT_CHAT_FONT_SIZE_PX,
    chatUserMinimapEnabled: true,
    chatTranscriptDensity: "comfortable",
    chatChromeTint: "colored",
    chatShellGeometry: "default",
    userOverrodeChatFontSize: false,
  };
}

function persistUserPreferences(prefs: PersistedUserPreferences) {
  try {
    window.localStorage.setItem(USER_PREFERENCES_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // ignore
  }
}

/** Assemble the persisted-prefs payload from current store state. Keeps setters DRY as we add prefs. */
function persistUserPreferencesFrom(state: {
  theme: ThemeId;
  terminalPreferences: TerminalPreferences;
  smartTooltipsEnabled: boolean;
  onboardingEnabled: boolean;
  didYouKnowEnabled: boolean;
  launchPromptClipboardEnabled: boolean;
  launchPromptClipboardNoticeEnabled: boolean;
  voiceInputEnabled: boolean;
  codeBlockCopyButtonPosition: CodeBlockCopyButtonPosition;
  agentTurnCompletionSound: AgentTurnCompletionSound;
  agentTurnCompletionSoundVolume: number;
  agentTurnCompletionSoundQuietWhenFocused: boolean;
  chatFontSizePx: number;
  chatUserMinimapEnabled: boolean;
  chatTranscriptDensity: ChatTranscriptDensity;
  chatChromeTint: ChatChromeTint;
  chatShellGeometry: ChatShellGeometry;
  userOverrodeChatFontSize: boolean;
}) {
  persistUserPreferences({
    theme: state.theme,
    terminalPreferences: state.terminalPreferences,
    smartTooltipsEnabled: state.smartTooltipsEnabled,
    onboardingEnabled: state.onboardingEnabled,
    didYouKnowEnabled: state.didYouKnowEnabled,
    launchPromptClipboardEnabled: state.launchPromptClipboardEnabled,
    launchPromptClipboardNoticeEnabled: state.launchPromptClipboardNoticeEnabled,
    voiceInputEnabled: state.voiceInputEnabled,
    codeBlockCopyButtonPosition: state.codeBlockCopyButtonPosition,
    agentTurnCompletionSound: state.agentTurnCompletionSound,
    agentTurnCompletionSoundVolume: state.agentTurnCompletionSoundVolume,
    agentTurnCompletionSoundQuietWhenFocused: state.agentTurnCompletionSoundQuietWhenFocused,
    chatFontSizePx: state.chatFontSizePx,
    chatUserMinimapEnabled: state.chatUserMinimapEnabled,
    chatTranscriptDensity: state.chatTranscriptDensity,
    chatChromeTint: state.chatChromeTint,
    chatShellGeometry: state.chatShellGeometry,
    userOverrodeChatFontSize: state.userOverrodeChatFontSize,
  });
}

function readInitialUserPreferences(): PersistedUserPreferences {
  const unified = readUnifiedUserPreferences();
  if (unified) return unified;
  const legacy = readLegacyUserPreferences();
  persistUserPreferences(legacy);
  return legacy;
}

const initialPersistedWorkViews = readPersistedWorkViewState();
const initialUserPreferences = readInitialUserPreferences();

function clampTerminalFontSize(value: unknown): number {
  const next = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(next)) return DEFAULT_TERMINAL_PREFERENCES.fontSize;
  return Math.max(10, Math.min(18, Math.round(next * 2) / 2));
}

function clampTerminalLineHeight(value: unknown): number {
  const next = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(next)) return DEFAULT_TERMINAL_PREFERENCES.lineHeight;
  return Math.max(1, Math.min(1.6, Math.round(next * 100) / 100));
}

function clampTerminalScrollback(value: unknown): number {
  const next = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(next)) return DEFAULT_TERMINAL_PREFERENCES.scrollback;
  return Math.max(2000, Math.min(30_000, Math.round(next / 1000) * 1000));
}

function normalizeTerminalFontFamily(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_TERMINAL_PREFERENCES.fontFamily;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : DEFAULT_TERMINAL_PREFERENCES.fontFamily;
}

function normalizeTerminalPreferences(value: unknown): TerminalPreferences {
  const candidate = value && typeof value === "object"
    ? value as Partial<TerminalPreferences>
    : {};
  return {
    fontFamily: normalizeTerminalFontFamily(candidate.fontFamily),
    fontSize: clampTerminalFontSize(candidate.fontSize),
    lineHeight: clampTerminalLineHeight(candidate.lineHeight),
    scrollback: clampTerminalScrollback(candidate.scrollback),
  };
}

/** Session-scoped banner dismissals keyed by project root. Not persisted — "dismiss for this session" only. */
export type SessionDismissMap = Record<string, true>;

export type ProjectTransitionError = {
  message: string;
  code?: string;
  detail?: string;
  rootPath?: string;
};

export type AppState = {
  project: ProjectInfo | null;
  projectBinding: OpenProjectBinding | null;
  projectHydrated: boolean;
  openRemoteProjectTabs: Extract<OpenProjectBinding, { kind: "remote" }>[];
  openProjectTabRoots: string[];
  projectInfoByRoot: Record<string, ProjectInfo>;
  /** True when the user removed all projects — forces welcome screen even though backend still has a project loaded. */
  showWelcome: boolean;
  projectTransition:
    | {
        kind: "opening" | "switching" | "closing";
        rootPath: string | null;
        startedAtMs: number;
      }
    | null;
  projectTransitionError: ProjectTransitionError | null;
  /**
   * Set when an in-app open targets an EXTERNAL linked git worktree whose owning
   * repo is resolvable. Drives WorktreeOpenDialog; the open itself is deferred
   * until the user picks lane-vs-standalone. Null when no prompt is pending.
   */
  worktreeOpenPrompt: { inspection: ProjectPathInspection } | null;
  isNewTabOpen: boolean;
  personalChatsTabOpen: boolean;
  laneSnapshots: LaneListSnapshot[];
  lanes: LaneSummary[];
  lanesLoading: boolean;
  laneDeleteProgressByLaneId: Record<string, LaneDeleteProgress>;
  selectedLaneId: string | null;
  focusedSessionId: string | null;
  projectRevision: number;
  theme: ThemeId;
  terminalPreferences: TerminalPreferences;
  codeBlockCopyButtonPosition: CodeBlockCopyButtonPosition;
  agentTurnCompletionSound: AgentTurnCompletionSound;
  agentTurnCompletionSoundVolume: number;
  agentTurnCompletionSoundQuietWhenFocused: boolean;
  chatFontSizePx: number;
  chatUserMinimapEnabled: boolean;
  chatTranscriptDensity: ChatTranscriptDensity;
  chatChromeTint: ChatChromeTint;
  chatShellGeometry: ChatShellGeometry;
  providerMode: ProviderMode;
  availableModels: ModelDescriptor[];
  laneInspectorTabs: Record<string, LaneInspectorTab>;
  keybindings: KeybindingsSnapshot | null;
  terminalAttention: TerminalAttentionSnapshot;
  smartTooltipsEnabled: boolean;
  onboardingEnabled: boolean;
  didYouKnowEnabled: boolean;
  launchPromptClipboardEnabled: boolean;
  launchPromptClipboardNoticeEnabled: boolean;
  voiceInputEnabled: boolean;
  // ── Ephemeral voice-dictation session state (root store only; not persisted) ──
  dictationPhase: DictationPhase;
  dictationElapsed: number;
  dictationLevels: number[];
  activeDictationTarget: ActiveDictationTarget | null;
  workViewByProject: Record<string, WorkProjectViewState>;
  laneWorkViewByScope: Record<string, WorkProjectViewState>;
  draftLaunchJobsByScope: Record<string, DraftLaunchJob[]>;
  handoffLaunchJobsByScope: Record<string, HandoffLaunchJob[]>;
  /**
   * Per-project lane / chat selection. Switching projects stashes the current
   * selection here keyed by project root so switching BACK restores the same
   * lane and chat instead of resetting to "first lane". This is what makes
   * a project tab feel like a real workspace tab — you come back to exactly
   * what you left.
   */
  laneSelectionByProject: Record<string, { laneId: string | null; sessionId: string | null }>;
  /**
   * Per-project lane list cache. On project switch we apply the cached lanes
   * IMMEDIATELY (no loading flicker, no chat-pane unmount) and refresh in the
   * background. Without this, every switch wipes `lanes` to `[]`, which
   * unmounts the chat UI even though the agent runtime is still alive on the
   * backend — making it look like the chat closed.
   */
  laneCacheByProject: Record<string, WarmLaneCache>;
  /**
   * Per-project sessions list cache (chats, terminals, CLI runs). Same
   * stale-while-revalidate pattern as `laneCacheByProject`. Without this,
   * useWorkSessions wipes `sessions` to `[]` on every projectRoot change,
   * which blanks the work view's chat tabs and terminals for several
   * seconds until the IPC fetch returns. With this, the cached sessions
   * render instantly and the refresh runs silently in the background.
   */
  sessionsCacheByProject: Record<string, TerminalSessionSummary[]>;
  /** Session-scoped banner dismissals. Pruned when a project is closed/switched so the maps don't leak. */
  dismissedMissingAiBannerRoots: SessionDismissMap;
  dismissedGithubBannerRoots: SessionDismissMap;

  setProject: (project: ProjectInfo | null) => void;
  setOpenRemoteProjectTabs: (
    next:
      | Extract<OpenProjectBinding, { kind: "remote" }>[]
      | ((
          prev: Extract<OpenProjectBinding, { kind: "remote" }>[],
        ) => Extract<OpenProjectBinding, { kind: "remote" }>[])
  ) => void;
  evictProjectState: (projectKey: string) => void;
  setOpenProjectTabRoots: (
    next: string[] | ((prev: string[]) => string[])
  ) => void;
  rememberProjectInfo: (project: ProjectInfo) => void;
  setProjectBinding: (binding: OpenProjectBinding | null) => void;
  setProjectHydrated: (hydrated: boolean) => void;
  setShowWelcome: (show: boolean) => void;
  clearProjectTransitionError: () => void;
  setLanes: (lanes: LaneSummary[]) => void;
  setLaneDeleteProgressByLaneId: (
    next:
      | Record<string, LaneDeleteProgress>
      | ((prev: Record<string, LaneDeleteProgress>) => Record<string, LaneDeleteProgress>)
  ) => void;
  selectLane: (laneId: string | null) => void;
  setLaneInspectorTab: (laneId: string, tab: LaneInspectorTab) => void;
  clearLaneInspectorTab: (laneId: string) => void;
  focusSession: (sessionId: string | null) => void;
  setTheme: (theme: ThemeId) => void;
  setCodeBlockCopyButtonPosition: (position: CodeBlockCopyButtonPosition) => void;
  setAgentTurnCompletionSound: (sound: AgentTurnCompletionSound) => void;
  setAgentTurnCompletionSoundVolume: (volume: number) => void;
  setAgentTurnCompletionSoundQuietWhenFocused: (quiet: boolean) => void;
  userOverrodeChatFontSize: boolean;
  setChatFontSizePx: (px: number) => void;
  applyAutoSizeChatFontOnLargeScreenIfNotOverridden: () => void;
  setChatUserMinimapEnabled: (enabled: boolean) => void;
  setChatTranscriptDensity: (density: ChatTranscriptDensity) => void;
  setChatChromeTint: (tint: ChatChromeTint) => void;
  setChatShellGeometry: (geometry: ChatShellGeometry) => void;
  /** Resets only theme + chat font size (narrow restore — per product spec). */
  resetThemeAndChatFontDefaults: () => void;
  setTerminalPreferences: (
    next:
      | Partial<TerminalPreferences>
      | ((prev: TerminalPreferences) => TerminalPreferences)
  ) => void;
  setTerminalAttention: (snapshot: TerminalAttentionSnapshot) => void;
  setSmartTooltipsEnabled: (enabled: boolean) => void;
  setOnboardingEnabled: (enabled: boolean) => void;
  setDidYouKnowEnabled: (enabled: boolean) => void;
  setLaunchPromptClipboardEnabled: (enabled: boolean) => void;
  setLaunchPromptClipboardNoticeEnabled: (enabled: boolean) => void;
  setVoiceInputEnabled: (enabled: boolean) => void;
  // ── Voice-dictation session setters (ephemeral; never persisted) ──
  setDictationPhase: (phase: DictationPhase) => void;
  setDictationElapsed: (seconds: number) => void;
  setDictationLevels: (levels: number[]) => void;
  resetDictationSession: () => void;
  registerDictationTarget: (target: ActiveDictationTarget) => void;
  /** Clear the active target only if `id` matches the currently-registered one. */
  unregisterDictationTarget: (id: string) => void;
  getWorkViewState: (projectRoot: string | null | undefined) => WorkProjectViewState;
  setWorkViewState: (
    projectRoot: string | null | undefined,
    next:
      | Partial<WorkProjectViewState>
      | ((prev: WorkProjectViewState) => WorkProjectViewState)
  ) => void;
  getLaneWorkViewState: (projectRoot: string | null | undefined, laneId: string | null | undefined) => WorkProjectViewState;
  setLaneWorkViewState: (
    projectRoot: string | null | undefined,
    laneId: string | null | undefined,
    next:
      | Partial<WorkProjectViewState>
      | ((prev: WorkProjectViewState) => WorkProjectViewState)
  ) => void;
  setDraftLaunchJobs: (
    scopeKey: string | null | undefined,
    next:
      | DraftLaunchJob[]
      | ((prev: DraftLaunchJob[]) => DraftLaunchJob[])
  ) => void;
  setHandoffLaunchJobs: (
    scopeKey: string | null | undefined,
    next:
      | HandoffLaunchJob[]
      | ((prev: HandoffLaunchJob[]) => HandoffLaunchJob[])
  ) => void;
  refreshProviderMode: () => Promise<void>;
  refreshKeybindings: () => Promise<void>;
  dismissMissingAiBanner: (projectRoot: string) => void;
  dismissGithubBanner: (projectRoot: string) => void;

  openNewTab: () => void;
  cancelNewTab: () => void;
  setPersonalChatsTabOpen: (open: boolean) => void;
  closePersonalChatsTab: () => void;
  refreshProject: () => Promise<void>;
  refreshLanes: (options?: {
    includeStatus?: boolean;
    includeSnapshots?: boolean;
    includeConflictStatus?: boolean;
    includeRebaseSuggestions?: boolean;
    includeAutoRebaseStatus?: boolean;
  }) => Promise<void>;
  openRepo: () => Promise<ProjectInfo | null>;
  switchProjectToPath: (
    rootPath: string,
    opts?: { skipWorktreeGate?: boolean },
  ) => Promise<void>;
  dismissWorktreeOpenPrompt: () => void;
  switchRemoteProject: (targetId: string, projectId: string) => Promise<OpenProjectBinding>;
  closeProject: () => Promise<void>;
};

export function selectActiveProjectRoot(state: Pick<AppState, "project" | "projectBinding">): string | null {
  const root = state.projectBinding?.kind === "remote"
    ? state.projectBinding.rootPath
    : state.project?.rootPath;
  return root?.trim() || null;
}

export type LaneInspectorTab = "terminals" | "context" | "stack" | "merge";

type LaneRefreshRequest = {
  includeStatus: boolean;
  includeSnapshots: boolean;
  includeConflictStatus: boolean;
  includeRebaseSuggestions: boolean;
  includeAutoRebaseStatus: boolean;
};

function normalizeLaneRefreshRequest(options?: {
  includeStatus?: boolean;
  includeSnapshots?: boolean;
  includeConflictStatus?: boolean;
  includeRebaseSuggestions?: boolean;
  includeAutoRebaseStatus?: boolean;
}): LaneRefreshRequest {
  const includeStatus = options?.includeStatus ?? true;
  const includeSnapshots = options?.includeSnapshots ?? includeStatus;
  return {
    includeStatus,
    includeSnapshots,
    includeConflictStatus: includeSnapshots && (options?.includeConflictStatus ?? true),
    includeRebaseSuggestions: includeSnapshots && (options?.includeRebaseSuggestions ?? true),
    includeAutoRebaseStatus: includeSnapshots && (options?.includeAutoRebaseStatus ?? true),
  };
}

function mergeLaneRefreshRequests(current: LaneRefreshRequest, next: LaneRefreshRequest): LaneRefreshRequest {
  return {
    includeStatus: current.includeStatus || next.includeStatus,
    includeSnapshots: current.includeSnapshots || next.includeSnapshots,
    includeConflictStatus: current.includeConflictStatus || next.includeConflictStatus,
    includeRebaseSuggestions: current.includeRebaseSuggestions || next.includeRebaseSuggestions,
    includeAutoRebaseStatus: current.includeAutoRebaseStatus || next.includeAutoRebaseStatus,
  };
}

function withPreservedLaneStatus(
  lane: LaneSummary,
  previousLanesById: Map<string, LaneSummary>,
  previousSnapshotsById: Map<string, LaneListSnapshot>,
): LaneSummary {
  const previousLane = previousLanesById.get(lane.id) ?? previousSnapshotsById.get(lane.id)?.lane;
  return previousLane
    ? { ...lane, status: previousLane.status, parentStatus: previousLane.parentStatus }
    : lane;
}

function formatProjectTransitionError(
  kind: "opening" | "switching" | "closing",
  error: unknown,
): ProjectTransitionError {
  const parsed = parseCodedErrorMessage(error);
  const raw = parsed.message;
  if (/timed out after 30000ms/i.test(raw)) {
    if (kind === "opening") {
      return { message: "Opening this project took longer than 30 seconds, so ADE stopped waiting." };
    }
    if (kind === "switching") {
      return { message: "Switching projects took longer than 30 seconds, so ADE kept the current project active." };
    }
    return { message: "Closing the current project took longer than 30 seconds." };
  }
  const code = toAdeRecoveryErrorCode(parsed.code);
  const recoveryMessage = code === "disk_full"
    ? "Your Mac ran out of storage while ADE was saving project data. Free up space, then try again."
    : code === "brain_crash_looping" || code === "migration_incomplete" || code === "migration_unknown_state"
      ? "ADE's background service needs a repair before this project can open."
      : code && [
          "insufficient_headroom",
          "db_integrity",
          "brain_not_installed",
          "socket_stale_no_owner",
          "socket_owned_by_other",
        ].includes(code)
        ? "ADE's background service could not open this project."
        : code
          ? "ADE ran into a problem with this project."
          : null;
  const fallback = raw.length > 0 ? raw : "Project action failed.";
  return {
    message: recoveryMessage ?? fallback,
    ...(code ? { code } : {}),
    ...(recoveryMessage && raw ? { detail: raw } : {}),
    // A rootPath encoded into the coded error (open-repo dialog failures pick
    // the path in the main process, so the renderer never saw it) lets the
    // recovery screen offer Repair instead of the generic banner.
    ...(parsed.rootPath ? { rootPath: parsed.rootPath } : {}),
  };
}

const createAppState: StateCreator<AppState> = (set, get) => {
  let warmupTimer: number | null = null;
  /** Monotonic counter incremented before each lane refresh request.
   *  Slower responses whose token doesn't match the latest value are discarded. */
  let laneRefreshVersion = 0;
  let remoteProjectSwitchGeneration = 0;
  let laneRefreshInFlight: Promise<void> | null = null;
  let activeLaneRefreshProjectKey: string | null = null;
  let activeLaneRefreshRequest: LaneRefreshRequest | null = null;
  let pendingLaneRefreshRequest: LaneRefreshRequest | null = null;

  const scheduleProjectHydration = () => {
    if (warmupTimer != null) {
      window.clearTimeout(warmupTimer);
    }
    const delay = Math.max(1_200, 1_800);
    warmupTimer = window.setTimeout(() => {
      warmupTimer = null;
      void get().refreshLanes({
        includeStatus: true,
        includeConflictStatus: false,
        includeRebaseSuggestions: false,
        includeAutoRebaseStatus: false,
      }).catch((err) => {
        console.debug("Scheduled lane refresh failed:", err);
      });
      void get().refreshProviderMode();
    }, delay);
  };

  return ({
  project: null,
  projectBinding: null,
  projectHydrated: false,
  openProjectTabRoots: [],
  projectInfoByRoot: {},
  showWelcome: true,
  projectTransition: null,
  projectTransitionError: null,
  worktreeOpenPrompt: null,
  isNewTabOpen: false,
  personalChatsTabOpen: false,
  laneSnapshots: [],
  lanes: [],
  lanesLoading: false,
  laneDeleteProgressByLaneId: {},
  selectedLaneId: null,
  focusedSessionId: null,
  projectRevision: 0,
  theme: initialUserPreferences.theme,
  terminalPreferences: initialUserPreferences.terminalPreferences,
  codeBlockCopyButtonPosition: initialUserPreferences.codeBlockCopyButtonPosition,
  agentTurnCompletionSound: initialUserPreferences.agentTurnCompletionSound,
  agentTurnCompletionSoundVolume: initialUserPreferences.agentTurnCompletionSoundVolume,
  agentTurnCompletionSoundQuietWhenFocused: initialUserPreferences.agentTurnCompletionSoundQuietWhenFocused,
  chatFontSizePx: initialUserPreferences.chatFontSizePx,
  userOverrodeChatFontSize: initialUserPreferences.userOverrodeChatFontSize,
  chatUserMinimapEnabled: initialUserPreferences.chatUserMinimapEnabled,
  chatTranscriptDensity: initialUserPreferences.chatTranscriptDensity,
  chatChromeTint: initialUserPreferences.chatChromeTint,
  chatShellGeometry: initialUserPreferences.chatShellGeometry,
  providerMode: "guest",
  availableModels: [...MODEL_REGISTRY].filter((m) => !m.deprecated),
  laneInspectorTabs: {},
  keybindings: null,
  terminalAttention: EMPTY_TERMINAL_ATTENTION,
  smartTooltipsEnabled: initialUserPreferences.smartTooltipsEnabled,
  onboardingEnabled: initialUserPreferences.onboardingEnabled,
  didYouKnowEnabled: initialUserPreferences.didYouKnowEnabled,
  launchPromptClipboardEnabled: initialUserPreferences.launchPromptClipboardEnabled,
  launchPromptClipboardNoticeEnabled: initialUserPreferences.launchPromptClipboardNoticeEnabled,
  voiceInputEnabled: initialUserPreferences.voiceInputEnabled,
  dictationPhase: "idle",
  dictationElapsed: 0,
  dictationLevels: new Array(DICTATION_WAVEFORM_BARS).fill(0.05),
  activeDictationTarget: null,
  workViewByProject: initialPersistedWorkViews.workViewByProject,
  laneWorkViewByScope: initialPersistedWorkViews.laneWorkViewByScope,
  draftLaunchJobsByScope: {},
  handoffLaunchJobsByScope: {},
  laneSelectionByProject: {},
  laneCacheByProject: {},
  sessionsCacheByProject: {},
  dismissedMissingAiBannerRoots: {},
  dismissedGithubBannerRoots: {},
  openRemoteProjectTabs: [],

  setProject: (project) =>
    set((prev) => {
      const previousProjectRoot = selectActiveProjectRoot(prev);
      const nextProjectRoot = project?.rootPath ?? null;
      const matchingRemoteBinding =
        project &&
        prev.projectBinding?.kind === "remote" &&
        prev.projectBinding.rootPath === project.rootPath
          ? prev.projectBinding
          : null;
      const projectChanged = previousProjectRoot !== nextProjectRoot;
      const warmLaneCache = projectChanged && nextProjectRoot
        ? prev.laneCacheByProject[nextProjectRoot] ?? readPersistedLaneCache(nextProjectRoot)
        : null;
      const nextLaneCacheByProject = projectChanged && nextProjectRoot && warmLaneCache && !prev.laneCacheByProject[nextProjectRoot]
        ? {
            ...prev.laneCacheByProject,
            [nextProjectRoot]: warmLaneCache,
          }
        : prev.laneCacheByProject;
      const restoredSelection = projectChanged && nextProjectRoot
        ? prev.laneSelectionByProject[nextProjectRoot] ?? {
            laneId: warmLaneCache?.lanes[0]?.id ?? null,
            sessionId: null,
          }
        : null;
      return {
        project,
        projectInfoByRoot: project && !matchingRemoteBinding
          ? {
              ...prev.projectInfoByRoot,
              [project.rootPath]: project,
            }
          : prev.projectInfoByRoot,
        openProjectTabRoots: project && !matchingRemoteBinding && !prev.openProjectTabRoots.includes(project.rootPath)
          ? [...prev.openProjectTabRoots, project.rootPath]
          : prev.openProjectTabRoots,
        projectBinding: project
          ? matchingRemoteBinding ?? createLocalProjectBinding(project)
          : null,
        projectRevision:
          projectChanged ? prev.projectRevision + 1 : prev.projectRevision,
        laneDeleteProgressByLaneId:
          projectChanged ? {} : prev.laneDeleteProgressByLaneId,
        ...(projectChanged
          ? {
              laneSnapshots: warmLaneCache?.laneSnapshots ?? [],
              lanes: warmLaneCache?.lanes ?? [],
              lanesLoading: project ? !warmLaneCache : false,
              selectedLaneId: restoredSelection?.laneId ?? null,
              focusedSessionId: restoredSelection?.sessionId ?? null,
              laneInspectorTabs: {},
              terminalAttention: EMPTY_TERMINAL_ATTENTION,
              laneCacheByProject: nextLaneCacheByProject,
            }
          : {}),
      };
    }),
  setOpenRemoteProjectTabs: (next) =>
    set((prev) => ({
      openRemoteProjectTabs:
        typeof next === "function" ? next(prev.openRemoteProjectTabs) : next,
    })),
  evictProjectState: (projectKey) => {
    const key = normalizeProjectKey(projectKey);
    if (!key) return;
    removePersistedLaneCache(key);
    set((prev) => {
      const {
        workViewByProject,
        laneWorkViewByScope,
      } = removeWorkViewStateForProject(
        key,
        prev.workViewByProject,
        prev.laneWorkViewByScope,
      );
      const laneSelectionByProject = { ...prev.laneSelectionByProject };
      const laneCacheByProject = { ...prev.laneCacheByProject };
      const sessionsCacheByProject = { ...prev.sessionsCacheByProject };
      delete laneSelectionByProject[key];
      delete laneCacheByProject[key];
      delete sessionsCacheByProject[key];
      persistWorkViewState({ workViewByProject, laneWorkViewByScope });
      return {
        workViewByProject,
        laneWorkViewByScope,
        laneSelectionByProject,
        laneCacheByProject,
        sessionsCacheByProject,
      };
    });
  },
  setOpenProjectTabRoots: (next) =>
    set((prev) => ({
      openProjectTabRoots:
        typeof next === "function" ? next(prev.openProjectTabRoots) : next,
    })),
  rememberProjectInfo: (project) =>
    set((prev) => ({
      projectInfoByRoot: {
        ...prev.projectInfoByRoot,
        [project.rootPath]: project,
      },
    })),
  setProjectBinding: (projectBinding) =>
    set((prev) => {
      const shouldDropStaleRemoteRoot =
        projectBinding?.kind === "remote" &&
        !prev.projectInfoByRoot[projectBinding.rootPath];
      const openRemoteProjectTabs =
        projectBinding?.kind === "remote"
          ? prev.openRemoteProjectTabs.some((entry) => entry.key === projectBinding.key)
            ? prev.openRemoteProjectTabs.map((entry) =>
                entry.key === projectBinding.key ? projectBinding : entry,
              )
            : [...prev.openRemoteProjectTabs, projectBinding]
          : prev.openRemoteProjectTabs;
      return {
        projectBinding,
        openRemoteProjectTabs,
        openProjectTabRoots: shouldDropStaleRemoteRoot
          ? prev.openProjectTabRoots.filter(
              (rootPath) => rootPath !== projectBinding.rootPath,
            )
          : prev.openProjectTabRoots,
      };
    }),
  setProjectHydrated: (projectHydrated) => set({ projectHydrated }),
  setShowWelcome: (showWelcome) => set({ showWelcome }),
  clearProjectTransitionError: () => set({ projectTransitionError: null }),
  dismissWorktreeOpenPrompt: () => set({ worktreeOpenPrompt: null }),
  setLanes: (lanes) => set({ lanes, lanesLoading: false }),
  setLaneDeleteProgressByLaneId: (next) =>
    set((prev) => ({
      laneDeleteProgressByLaneId:
        typeof next === "function" ? next(prev.laneDeleteProgressByLaneId) : next,
    })),
  selectLane: (laneId) =>
    set((prev) => {
      const projectKey = selectActiveProjectStateKey(prev);
      if (!projectKey) return { selectedLaneId: laneId };
      const previousSelection =
        prev.laneSelectionByProject[projectKey] ?? { laneId: null, sessionId: null };
      return {
        selectedLaneId: laneId,
        laneSelectionByProject: {
          ...prev.laneSelectionByProject,
          [projectKey]: { ...previousSelection, laneId },
        },
      };
    }),
  setLaneInspectorTab: (laneId, tab) =>
    set((prev) => ({
      laneInspectorTabs: {
        ...prev.laneInspectorTabs,
        [laneId]: tab
      }
    })),
  clearLaneInspectorTab: (laneId) =>
    set((prev) => {
      const { [laneId]: _, ...rest } = prev.laneInspectorTabs;
      return { laneInspectorTabs: rest };
    }),
  focusSession: (sessionId) =>
    set((prev) => {
      const projectKey = selectActiveProjectStateKey(prev);
      if (!projectKey) return { focusedSessionId: sessionId };
      const previousSelection =
        prev.laneSelectionByProject[projectKey] ?? { laneId: null, sessionId: null };
      return {
        focusedSessionId: sessionId,
        laneSelectionByProject: {
          ...prev.laneSelectionByProject,
          [projectKey]: { ...previousSelection, sessionId },
        },
      };
    }),
  setTheme: (theme) =>
    set((prev) => {
      const next = { ...prev, theme };
      persistUserPreferencesFrom(next);
      return { theme };
    }),
  setCodeBlockCopyButtonPosition: (position) =>
    set((prev) => {
      const value = normalizeCodeBlockCopyButtonPosition(position);
      persistUserPreferencesFrom({ ...prev, codeBlockCopyButtonPosition: value });
      return { codeBlockCopyButtonPosition: value };
    }),
  setAgentTurnCompletionSound: (sound) =>
    set((prev) => {
      const value = normalizeAgentTurnCompletionSound(sound);
      persistUserPreferencesFrom({ ...prev, agentTurnCompletionSound: value });
      return { agentTurnCompletionSound: value };
    }),
  setAgentTurnCompletionSoundVolume: (volume) =>
    set((prev) => {
      const value = normalizeAgentTurnCompletionSoundVolume(volume);
      persistUserPreferencesFrom({ ...prev, agentTurnCompletionSoundVolume: value });
      return { agentTurnCompletionSoundVolume: value };
    }),
  setAgentTurnCompletionSoundQuietWhenFocused: (quiet) =>
    set((prev) => {
      persistUserPreferencesFrom({ ...prev, agentTurnCompletionSoundQuietWhenFocused: quiet });
      return { agentTurnCompletionSoundQuietWhenFocused: quiet };
    }),
  setChatFontSizePx: (px) =>
    set((prev) => {
      const value = normalizeChatFontSizePx(px);
      // Any manual change permanently locks the large-screen auto-size.
      persistUserPreferencesFrom({ ...prev, chatFontSizePx: value, userOverrodeChatFontSize: true });
      return { chatFontSizePx: value, userOverrodeChatFontSize: true };
    }),
  applyAutoSizeChatFontOnLargeScreenIfNotOverridden: () =>
    set((prev) => {
      if (prev.userOverrodeChatFontSize) return {};
      const isLargeScreen = typeof window !== "undefined"
        && typeof window.matchMedia === "function"
        && window.matchMedia("(min-width: 1600px)").matches;
      // Large screens read better at 16px; normal screens keep the 14px default.
      // This is an auto-size, so it never sets userOverrodeChatFontSize.
      const target = normalizeChatFontSizePx(isLargeScreen ? 16 : DEFAULT_CHAT_FONT_SIZE_PX);
      if (target === prev.chatFontSizePx) return {};
      persistUserPreferencesFrom({ ...prev, chatFontSizePx: target });
      return { chatFontSizePx: target };
    }),
  setChatUserMinimapEnabled: (enabled) =>
    set((prev) => {
      persistUserPreferencesFrom({ ...prev, chatUserMinimapEnabled: enabled });
      return { chatUserMinimapEnabled: enabled };
    }),
  setChatTranscriptDensity: (density) =>
    set((prev) => {
      const value = normalizeChatTranscriptDensity(density);
      persistUserPreferencesFrom({ ...prev, chatTranscriptDensity: value });
      return { chatTranscriptDensity: value };
    }),
  setChatChromeTint: (tint) =>
    set((prev) => {
      const value = normalizeChatChromeTint(tint);
      persistUserPreferencesFrom({ ...prev, chatChromeTint: value });
      return { chatChromeTint: value };
    }),
  setChatShellGeometry: (geometry) =>
    set((prev) => {
      const value = normalizeChatShellGeometry(geometry);
      persistUserPreferencesFrom({ ...prev, chatShellGeometry: value });
      return { chatShellGeometry: value };
    }),
  resetThemeAndChatFontDefaults: () =>
    set((prev) => {
      const nextTheme: ThemeId = "dark";
      const nextFont = DEFAULT_CHAT_FONT_SIZE_PX;
      persistUserPreferencesFrom({
        ...prev,
        theme: nextTheme,
        chatFontSizePx: nextFont,
        userOverrodeChatFontSize: false,
      });
      return { theme: nextTheme, chatFontSizePx: nextFont, userOverrodeChatFontSize: false };
    }),
  setTerminalPreferences: (next) =>
    set((prev) => {
      const updated = normalizeTerminalPreferences(
        typeof next === "function"
          ? next(prev.terminalPreferences)
          : { ...prev.terminalPreferences, ...next }
      );
      persistUserPreferencesFrom({ ...prev, terminalPreferences: updated });
      return { terminalPreferences: updated };
    }),
  setTerminalAttention: (terminalAttention) => set({ terminalAttention }),
  setSmartTooltipsEnabled: (enabled) =>
    set((prev) => {
      persistUserPreferencesFrom({ ...prev, smartTooltipsEnabled: enabled });
      return { smartTooltipsEnabled: enabled };
    }),
  setOnboardingEnabled: (enabled) =>
    set((prev) => {
      persistUserPreferencesFrom({ ...prev, onboardingEnabled: enabled });
      return { onboardingEnabled: enabled };
    }),
  setDidYouKnowEnabled: (enabled) =>
    set((prev) => {
      persistUserPreferencesFrom({ ...prev, didYouKnowEnabled: enabled });
      return { didYouKnowEnabled: enabled };
    }),
  setLaunchPromptClipboardEnabled: (enabled) =>
    set((prev) => {
      persistUserPreferencesFrom({ ...prev, launchPromptClipboardEnabled: enabled });
      return { launchPromptClipboardEnabled: enabled };
    }),
  setLaunchPromptClipboardNoticeEnabled: (enabled) =>
    set((prev) => {
      persistUserPreferencesFrom({ ...prev, launchPromptClipboardNoticeEnabled: enabled });
      return { launchPromptClipboardNoticeEnabled: enabled };
    }),
  setVoiceInputEnabled: (enabled) =>
    set((prev) => {
      persistUserPreferencesFrom({ ...prev, voiceInputEnabled: enabled });
      return { voiceInputEnabled: enabled };
    }),
  // Ephemeral dictation setters: NO persistUserPreferencesFrom — these describe
  // a live capture session, not a saved preference.
  setDictationPhase: (phase) => set({ dictationPhase: phase }),
  setDictationElapsed: (seconds) => set({ dictationElapsed: seconds }),
  setDictationLevels: (levels) => set({ dictationLevels: levels }),
  resetDictationSession: () =>
    set({
      dictationPhase: "idle",
      dictationElapsed: 0,
      dictationLevels: new Array(DICTATION_WAVEFORM_BARS).fill(0.05),
    }),
  registerDictationTarget: (target) => set({ activeDictationTarget: target }),
  unregisterDictationTarget: (id) =>
    set((prev) =>
      prev.activeDictationTarget?.id === id
        ? { activeDictationTarget: null }
        : prev,
    ),
  openNewTab: () => set({ isNewTabOpen: true, showWelcome: true }),
  cancelNewTab: () => {
    const hasProject = get().project != null;
    set({ isNewTabOpen: false, showWelcome: !hasProject });
  },
  setPersonalChatsTabOpen: (personalChatsTabOpen) =>
    set({ personalChatsTabOpen }),
  closePersonalChatsTab: () => set({ personalChatsTabOpen: false }),
  getWorkViewState: (projectRoot) => {
    const key = resolveProjectStateKey(get(), projectRoot);
    if (!key) return createDefaultWorkProjectViewState();
    return get().workViewByProject[key] ?? createDefaultWorkProjectViewState();
  },
  setWorkViewState: (projectRoot, next) => {
    const key = resolveProjectStateKey(get(), projectRoot);
    if (!key) return;
    set((prev) => {
      const current = prev.workViewByProject[key] ?? createDefaultWorkProjectViewState();
      const updated =
        typeof next === "function"
          ? next(current)
          : {
              ...current,
              ...next,
            };
      const nextWorkViews = {
        ...prev.workViewByProject,
        [key]: updated,
      };
      debouncedPersistWorkViewState({
        workViewByProject: nextWorkViews,
        laneWorkViewByScope: prev.laneWorkViewByScope,
      });
      return {
        workViewByProject: nextWorkViews,
      };
    });
  },
  getLaneWorkViewState: (projectRoot, laneId) => {
    const projectKey = resolveProjectStateKey(get(), projectRoot);
    const key = normalizeLaneWorkScopeKey(projectKey, laneId);
    if (!key) return createDefaultWorkProjectViewState();
    return get().laneWorkViewByScope[key] ?? createDefaultWorkProjectViewState();
  },
  setLaneWorkViewState: (projectRoot, laneId, next) => {
    const projectKey = resolveProjectStateKey(get(), projectRoot);
    const key = normalizeLaneWorkScopeKey(projectKey, laneId);
    if (!key) return;
    set((prev) => {
      const current = prev.laneWorkViewByScope[key] ?? createDefaultWorkProjectViewState();
      const updated =
        typeof next === "function"
          ? next(current)
          : {
              ...current,
              ...next,
            };
      const nextLaneWorkViews = {
        ...prev.laneWorkViewByScope,
        [key]: updated,
      };
      debouncedPersistWorkViewState({
        workViewByProject: prev.workViewByProject,
        laneWorkViewByScope: nextLaneWorkViews,
      });
      return {
        laneWorkViewByScope: nextLaneWorkViews,
      };
    });
  },
  setDraftLaunchJobs: (scopeKey, next) => {
    const key = typeof scopeKey === "string" ? scopeKey.trim() : "";
    if (!key) return;
    set((prev) => {
      const current = prev.draftLaunchJobsByScope[key] ?? [];
      const updated = typeof next === "function" ? next(current) : next;
      const nextJobs = Array.isArray(updated) ? updated : [];
      const nextByScope = { ...prev.draftLaunchJobsByScope };
      if (nextJobs.length > 0) {
        nextByScope[key] = nextJobs;
      } else {
        delete nextByScope[key];
      }
      return { draftLaunchJobsByScope: nextByScope };
    });
  },
  setHandoffLaunchJobs: (scopeKey, next) => {
    const key = typeof scopeKey === "string" ? scopeKey.trim() : "";
    if (!key) return;
    set((prev) => {
      const current = prev.handoffLaunchJobsByScope[key] ?? [];
      const updated = typeof next === "function" ? next(current) : next;
      const nextJobs = Array.isArray(updated) ? updated : [];
      const nextByScope = { ...prev.handoffLaunchJobsByScope };
      if (nextJobs.length > 0) {
        nextByScope[key] = nextJobs;
      } else {
        delete nextByScope[key];
      }
      return { handoffLaunchJobsByScope: nextByScope };
    });
  },

  refreshProject: async () => {
    const project = await window.ade.app.getProject();
    get().setProject(project);
    set({ projectHydrated: true });
  },

  refreshLanes: async (options) => {
    const request = normalizeLaneRefreshRequest(options);
    const runRefresh = async (currentRequest: LaneRefreshRequest) => {
      const requestedProjectKey = normalizeProjectKey(selectActiveProjectStateKey(get()));
      activeLaneRefreshProjectKey = requestedProjectKey;
      const token = ++laneRefreshVersion;
      const previousLanesById = new Map(get().lanes.map((lane) => [lane.id, lane] as const));
      const previousSnapshotsById = new Map(get().laneSnapshots.map((snapshot) => [snapshot.lane.id, snapshot] as const));
      const snapshotArgs = {
        includeArchived: false,
        includeStatus: currentRequest.includeStatus,
        includeConflictStatus: currentRequest.includeConflictStatus,
        includeRebaseSuggestions: currentRequest.includeRebaseSuggestions,
        includeAutoRebaseStatus: currentRequest.includeAutoRebaseStatus,
      };
      const rawLaneSnapshots = currentRequest.includeSnapshots
        ? await listLaneSnapshotsCoalesced(snapshotArgs, { projectRoot: requestedProjectKey })
        : null;
      const laneSnapshots = rawLaneSnapshots?.map((snapshot) => {
        if (currentRequest.includeStatus) return snapshot;
        const lane = withPreservedLaneStatus(snapshot.lane, previousLanesById, previousSnapshotsById);
        return lane === snapshot.lane ? snapshot : { ...snapshot, lane };
      }) ?? null;
      const rawLanes = laneSnapshots != null
        ? laneSnapshots.map((snapshot) => snapshot.lane)
        : await listLanesCoalesced({
            includeArchived: false,
            includeStatus: currentRequest.includeStatus,
          }, { projectRoot: requestedProjectKey });
      const lanes = laneSnapshots != null || currentRequest.includeStatus
        ? rawLanes
        : rawLanes.map((lane) => withPreservedLaneStatus(lane, previousLanesById, previousSnapshotsById));
      // Discard stale response: a newer refresh was issued while this one was in-flight
      if (token !== laneRefreshVersion) {
        return;
      }
      const projectKey = normalizeProjectKey(selectActiveProjectStateKey(get()));
      if (projectKey !== requestedProjectKey) {
        return;
      }
      const selected = get().selectedLaneId;
      const nextSelected = selected && lanes.some((l) => l.id === selected) ? selected : lanes[0]?.id ?? null;
      set((prev) => {
        const allowed = new Set(lanes.map((lane) => lane.id));
        const nextTabs: Record<string, LaneInspectorTab> = {};
        const nextLaneWorkViews: Record<string, WorkProjectViewState> = {};
        for (const [laneId, tab] of Object.entries(prev.laneInspectorTabs)) {
          if (allowed.has(laneId)) nextTabs[laneId] = tab as LaneInspectorTab;
        }
        for (const [scopeKey, viewState] of Object.entries(prev.laneWorkViewByScope)) {
          if (!projectKey || !scopeKey.startsWith(`${projectKey}::`)) {
            nextLaneWorkViews[scopeKey] = viewState;
            continue;
          }
          const laneId = scopeKey.slice(projectKey.length + 2);
          if (allowed.has(laneId)) {
            nextLaneWorkViews[scopeKey] = viewState;
          }
        }
        const lanesById = new Map(lanes.map((lane) => [lane.id, lane] as const));
        const nextSnapshots: LaneListSnapshot[] =
          laneSnapshots ??
          prev.laneSnapshots
            .filter((snapshot) => allowed.has(snapshot.lane.id))
            .map((snapshot) => {
              const nextLane = lanesById.get(snapshot.lane.id);
              return nextLane ? { ...snapshot, lane: nextLane } : snapshot;
            });
        persistWorkViewState({
          workViewByProject: prev.workViewByProject,
          laneWorkViewByScope: nextLaneWorkViews,
        });
        // Cache the lane list per project root so the next switch back to this
        // project can apply lanes immediately (no flicker, no chat unmount).
        const activeProjectKey = selectActiveProjectStateKey(get());
        const nextLaneCache = activeProjectKey
          ? {
              ...prev.laneCacheByProject,
              [activeProjectKey]: { lanes, laneSnapshots: nextSnapshots },
            }
          : prev.laneCacheByProject;
        persistLaneCache(activeProjectKey, lanes);
        return {
          laneSnapshots: nextSnapshots,
          lanes,
          lanesLoading: false,
          selectedLaneId: nextSelected,
          laneInspectorTabs: nextTabs,
          laneWorkViewByScope: nextLaneWorkViews,
          laneCacheByProject: nextLaneCache,
        };
      });
    };

    // Only show a loading spinner when there's nothing to display. If we
    // already have cached lanes (stale-while-revalidate after a project
    // switch), keep `lanesLoading: false` so the chat pane + lane list stay
    // visually stable while we refresh silently in the background.
    if (get().lanes.length === 0) {
      set({ lanesLoading: true });
    }

    if (laneRefreshInFlight) {
      const activeRequest = activeLaneRefreshRequest;
      const activeProjectKey = activeLaneRefreshProjectKey;
      const requestProjectKey = normalizeProjectKey(selectActiveProjectStateKey(get()));
      const activeSatisfies =
        activeRequest != null
        && activeProjectKey === requestProjectKey
        && (activeRequest.includeStatus || !request.includeStatus)
        && (activeRequest.includeSnapshots || !request.includeSnapshots)
        && (activeRequest.includeConflictStatus || !request.includeConflictStatus)
        && (activeRequest.includeRebaseSuggestions || !request.includeRebaseSuggestions)
        && (activeRequest.includeAutoRebaseStatus || !request.includeAutoRebaseStatus);
      if (!activeSatisfies) {
        pendingLaneRefreshRequest = pendingLaneRefreshRequest
          ? mergeLaneRefreshRequests(pendingLaneRefreshRequest, request)
          : request;
      }
      await laneRefreshInFlight;
      return;
    }

    laneRefreshInFlight = (async () => {
      let nextRequest: LaneRefreshRequest | null = request;
      while (nextRequest) {
        activeLaneRefreshRequest = nextRequest;
        pendingLaneRefreshRequest = null;
        await runRefresh(nextRequest);
        nextRequest = pendingLaneRefreshRequest;
      }
    })().finally(() => {
      laneRefreshInFlight = null;
      activeLaneRefreshProjectKey = null;
      activeLaneRefreshRequest = null;
      pendingLaneRefreshRequest = null;
      set({ lanesLoading: false });
    });

    await laneRefreshInFlight;
  },

  refreshProviderMode: async () => {
    const projectRoot = selectActiveProjectRoot(get());
    const [snapshot, aiStatus] = await Promise.all([
      getProjectConfigCached({ projectRoot }),
      getAiStatusCached({ projectRoot }).catch(() => null),
    ]);
    const configMode = snapshot.effective.providerMode ?? "guest";
    // Auto-elevate to subscription if any AI provider is configured
    const hasProvider = hasConfiguredAiProvider(aiStatus);
    set({ providerMode: configMode === "subscription" || hasProvider ? "subscription" : "guest" });
  },

  refreshKeybindings: async () => {
    const keybindings = await getKeybindingsCoalesced({
      projectRoot: selectActiveProjectRoot(get()),
    });
    set({ keybindings });
  },

  dismissMissingAiBanner: (projectRoot) => {
    const key = normalizeProjectKey(projectRoot);
    if (!key) return;
    set((prev) => ({
      dismissedMissingAiBannerRoots: { ...prev.dismissedMissingAiBannerRoots, [key]: true },
    }));
  },
  dismissGithubBanner: (projectRoot) => {
    const key = normalizeProjectKey(projectRoot);
    if (!key) return;
    set((prev) => ({
      dismissedGithubBannerRoots: { ...prev.dismissedGithubBannerRoots, [key]: true },
    }));
  },
  openRepo: async () => {
    // Invalidate in-flight lane refreshes before the async open so stale
    // responses from the previous project are discarded immediately. The
    // "opening" transition is shown up front (it covers the native picker, as
    // before) and cleared on any early exit below.
    ++laneRefreshVersion;
    set({
      projectTransition: {
        kind: "opening",
        rootPath: null,
        startedAtMs: Date.now(),
      },
      projectTransitionError: null,
      projectBinding: null,
    });
    try {
      // Pick the target folder first (native picker, no bind yet) so the
      // worktree gate can run before we bind — the OS "Open repository" dialog
      // must behave like the in-app open flows. chooseDirectory uses the same
      // showOpenDialog(["openDirectory"]) as the fused openRepo picker; passing
      // the matching title keeps it visually identical.
      const picked = await window.ade.project.chooseDirectory({ title: "Open repository" });
      if (!picked) {
        set({ projectTransition: null, lanesLoading: false });
        return null;
      }

      // Worktree gate (mirrors switchProjectToPath): if the picked folder is an
      // external linked worktree whose owning repo resolves, surface the
      // WorktreeOpenDialog instead of opening it as a standalone project, and
      // defer the open until the user chooses. inspectPath resolves the worktree
      // root even from a nested subfolder, and any failure falls through to a
      // normal open so the gate can never break project opening.
      if (!get().openProjectTabRoots.includes(picked)) {
        try {
          const inspection = await window.ade.project.inspectPath(picked);
          if (inspection.kind === "linked-worktree" && inspection.parent !== null) {
            set({
              projectTransition: null,
              lanesLoading: false,
              worktreeOpenPrompt: { inspection },
            });
            return null;
          }
        } catch {
          // Ignore — proceed with the normal open below.
        }
      }

      const project = await window.ade.project.openRepo({ rootPath: picked });
      if (!project) {
        set({ projectTransition: null, lanesLoading: false });
        return null;
      }
      get().setProject(project);
      set((prev) => {
        const restoredSelection =
          prev.laneSelectionByProject[project.rootPath] ?? { laneId: null, sessionId: null };
        const cachedLanes = prev.laneCacheByProject[project.rootPath];
        // personalChatsTabOpen is deliberately omitted so the machine-level Chats tab survives project transitions.
        return {
          projectHydrated: true,
          showWelcome: false,
          projectTransition: null,
          projectTransitionError: null,
          isNewTabOpen: false,
          laneSnapshots: cachedLanes?.laneSnapshots ?? [],
          lanes: cachedLanes?.lanes ?? [],
          lanesLoading: !cachedLanes,
          laneDeleteProgressByLaneId: {},
          selectedLaneId: restoredSelection.laneId,
          focusedSessionId: restoredSelection.sessionId,
          laneInspectorTabs: {},
          keybindings: null,
          terminalAttention: EMPTY_TERMINAL_ATTENTION,
          dismissedMissingAiBannerRoots: pickDismissMapForRoots(prev.dismissedMissingAiBannerRoots, [project.rootPath]),
          dismissedGithubBannerRoots: pickDismissMapForRoots(prev.dismissedGithubBannerRoots, [project.rootPath]),
        };
      });
      invalidateAiDiscoveryCache(project.rootPath);
      invalidateProjectConfigCache(project.rootPath);
      void Promise.allSettled([
        get().refreshLanes({ includeStatus: false }),
        get().refreshKeybindings()
      ]);
      scheduleProjectHydration();
      return project;
    } catch (error) {
      set({
        projectTransition: null,
        lanesLoading: false,
        projectTransitionError: formatProjectTransitionError("opening", error),
      });
      throw error;
    }
  },

  switchProjectToPath: async (
    rootPath: string,
    opts?: { skipWorktreeGate?: boolean },
  ) => {
    // Worktree gate: when opening a path that is NOT already a warm tab, inspect
    // it first. If it's an external linked worktree whose owning repo resolves,
    // surface the WorktreeOpenDialog instead of silently creating a standalone
    // project — and defer the open until the user chooses. Runs before any state
    // mutation so an early return leaves no dangling "switching" transition.
    // Warm-tab switches (rootPath already in openProjectTabRoots) bypass the gate
    // entirely. inspectPath failures fall through to the normal open — the gate
    // must never break project opening.
    if (!opts?.skipWorktreeGate && !get().openProjectTabRoots.includes(rootPath)) {
      try {
        const inspection = await window.ade.project.inspectPath(rootPath);
        if (inspection.kind === "linked-worktree" && inspection.parent !== null) {
          set({ worktreeOpenPrompt: { inspection } });
          return;
        }
      } catch {
        // Ignore — proceed with the normal open below.
      }
    }
    // Invalidate in-flight lane refreshes before the async switch so stale
    // responses from the previous project are discarded immediately.
    ++laneRefreshVersion;
    // Stash the OUTGOING project's lane/session selection so switching back
    // restores it instead of falling through to "first lane".
    const outgoingProjectKey = selectActiveProjectStateKey(get());
    const outgoingSelection = {
      laneId: get().selectedLaneId,
      sessionId: get().focusedSessionId,
    };
    const cachedProject = get().projectInfoByRoot[rootPath] ?? null;
    const isWarmTabSwitch =
      cachedProject != null && get().openProjectTabRoots.includes(rootPath);
    if (isWarmTabSwitch && cachedProject) {
      get().setProject(cachedProject);
    }
    const cachedWarmLanes =
      cachedProject != null ? get().laneCacheByProject[cachedProject.rootPath] : undefined;
    const restoredWarmSelection =
      cachedProject != null
        ? get().laneSelectionByProject[cachedProject.rootPath] ?? { laneId: null, sessionId: null }
        : { laneId: null, sessionId: null };
    set({
      projectTransition: isWarmTabSwitch
        ? null
        : {
            kind: "switching",
            rootPath,
            startedAtMs: Date.now(),
          },
      projectTransitionError: null,
      projectBinding: isWarmTabSwitch && cachedProject
        ? {
            kind: "local",
            key: `local:${cachedProject.rootPath}`,
            rootPath: cachedProject.rootPath,
            displayName: cachedProject.displayName,
          }
        : null,
      ...(isWarmTabSwitch
        ? {
            projectHydrated: true,
            showWelcome: false,
            isNewTabOpen: false,
            laneSnapshots: cachedWarmLanes?.laneSnapshots ?? [],
            lanes: cachedWarmLanes?.lanes ?? [],
            lanesLoading: !cachedWarmLanes,
            laneDeleteProgressByLaneId: {},
            selectedLaneId: restoredWarmSelection.laneId,
            focusedSessionId: restoredWarmSelection.sessionId,
            laneInspectorTabs: {},
            keybindings: null,
            terminalAttention: EMPTY_TERMINAL_ATTENTION,
          }
        : {}),
      ...(outgoingProjectKey
        ? {
            laneSelectionByProject: {
              ...get().laneSelectionByProject,
              [outgoingProjectKey]: outgoingSelection,
            },
          }
        : {}),
    });
    try {
      const project = await window.ade.project.switchToPath(rootPath);
      get().setProject(project);
      const restoredSelection =
        get().laneSelectionByProject[project.rootPath] ?? { laneId: null, sessionId: null };
      // Stale-while-revalidate: if we have cached lanes for the destination
      // project, apply them IMMEDIATELY so the chat pane and terminal stay
      // mounted across the switch (their `lockSessionId` keeps the agent
      // runtime attached). Then refreshLanes runs in the background and
      // replaces the cache when fresh data arrives.
      const cachedLanes = get().laneCacheByProject[project.rootPath];
      // Banner-dismiss pruning happens in the second `set` call below, after recents are fetched,
      // so we can retain dismissals for the active project + all recent projects in one pass.
      set(isWarmTabSwitch
        ? {
            projectTransition: null,
            projectTransitionError: null,
            projectHydrated: true,
            showWelcome: false,
            isNewTabOpen: false,
          }
        : {
            projectHydrated: true,
            showWelcome: false,
            projectTransition: null,
            projectTransitionError: null,
            isNewTabOpen: false,
            laneSnapshots: cachedLanes?.laneSnapshots ?? [],
            lanes: cachedLanes?.lanes ?? [],
            lanesLoading: !cachedLanes,
            laneDeleteProgressByLaneId: {},
            selectedLaneId: restoredSelection.laneId,
            focusedSessionId: restoredSelection.sessionId,
            laneInspectorTabs: {},
            keybindings: null,
            terminalAttention: EMPTY_TERMINAL_ATTENTION,
          });
      invalidateAiDiscoveryCache(rootPath);
      invalidateProjectConfigCache(rootPath);
      void Promise.allSettled([
        get().refreshLanes({ includeStatus: false }),
        get().refreshKeybindings()
      ]);
      scheduleProjectHydration();

      const hasProjectScopedStateToPrune =
        Object.keys(get().workViewByProject).length > 1 ||
        Object.keys(get().laneWorkViewByScope).length > 0 ||
        Object.keys(get().laneSelectionByProject).length > 1 ||
        Object.keys(get().laneCacheByProject).length > 1 ||
        Object.keys(get().sessionsCacheByProject).length > 1 ||
        Object.keys(get().dismissedMissingAiBannerRoots).length > 1 ||
        Object.keys(get().dismissedGithubBannerRoots).length > 1;
      if (!hasProjectScopedStateToPrune) return;

      window.setTimeout(() => {
        void window.ade.project.listRecent().then((recentRows) => {
          const recentRoots = new Set(recentRows.map((r: { rootPath: string }) => r.rootPath));
          const activeProjectKey = selectActiveProjectStateKey(get());
          const openProjectRoots = new Set(get().openProjectTabRoots);
          const openRemoteProjectKeys = new Set(
            get().openRemoteProjectTabs.map((binding) => binding.key),
          );
          const retainedRootSet = new Set<string>();
          for (const root of [
            activeProjectKey,
            ...recentRoots,
            ...openProjectRoots,
            ...openRemoteProjectKeys,
          ]) {
            const key = normalizeProjectKey(root);
            if (key) retainedRootSet.add(key);
          }
          const retainedRoots = Array.from(retainedRootSet);
          set((prev) => {
            const nextWorkViews: Record<string, WorkProjectViewState> = {};
            const nextLaneWorkViews: Record<string, WorkProjectViewState> = {};
            const nextLaneSelections: Record<string, { laneId: string | null; sessionId: string | null }> = {};
            const nextLaneCache: Record<string, WarmLaneCache> = {};
            const nextSessionsCache: Record<string, TerminalSessionSummary[]> = {};
            for (const [key, value] of Object.entries(prev.workViewByProject)) {
              if (retainedRootSet.has(key)) nextWorkViews[key] = value;
            }
            for (const [scopeKey, value] of Object.entries(prev.laneWorkViewByScope)) {
              const projectKey = scopeKey.split("::")[0];
              if (retainedRootSet.has(projectKey)) nextLaneWorkViews[scopeKey] = value;
            }
            for (const [key, value] of Object.entries(prev.laneSelectionByProject)) {
              if (retainedRootSet.has(key)) nextLaneSelections[key] = value;
            }
            for (const [key, value] of Object.entries(prev.laneCacheByProject)) {
              if (retainedRootSet.has(key)) nextLaneCache[key] = value;
              else removePersistedLaneCache(key);
            }
            for (const [key, value] of Object.entries(prev.sessionsCacheByProject)) {
              if (retainedRootSet.has(key)) nextSessionsCache[key] = value;
            }
            persistWorkViewState({
              workViewByProject: nextWorkViews,
              laneWorkViewByScope: nextLaneWorkViews,
            });
            return {
              workViewByProject: nextWorkViews,
              laneWorkViewByScope: nextLaneWorkViews,
              laneSelectionByProject: nextLaneSelections,
              laneCacheByProject: nextLaneCache,
              sessionsCacheByProject: nextSessionsCache,
              dismissedMissingAiBannerRoots: pickDismissMapForRoots(prev.dismissedMissingAiBannerRoots, retainedRoots),
              dismissedGithubBannerRoots: pickDismissMapForRoots(prev.dismissedGithubBannerRoots, retainedRoots),
            };
          });
        }).catch(() => {});
      }, 750);
    } catch (error) {
      const projectTransitionError = formatProjectTransitionError("switching", error);
      set({
        projectTransition: null,
        lanesLoading: false,
        projectTransitionError: projectTransitionError.code
          ? { ...projectTransitionError, rootPath }
          : projectTransitionError,
      });
      throw error;
    }
  },

  switchRemoteProject: async (targetId: string, projectId: string) => {
    const switchGeneration = ++remoteProjectSwitchGeneration;
    ++laneRefreshVersion;
    const outgoingProjectKey = selectActiveProjectStateKey(get());
    const outgoingSelection = {
      laneId: get().selectedLaneId,
      sessionId: get().focusedSessionId,
    };
    set((prev) => ({
      projectTransition: {
        kind: "switching",
        rootPath: null,
        startedAtMs: Date.now(),
      },
      projectTransitionError: null,
      ...(outgoingProjectKey
        ? {
            laneSelectionByProject: {
              ...prev.laneSelectionByProject,
              [outgoingProjectKey]: outgoingSelection,
            },
          }
        : {}),
    }));
    try {
      const binding = await window.ade.remoteRuntime.openProject(targetId, projectId);
      if (switchGeneration !== remoteProjectSwitchGeneration) {
        return binding;
      }
      if (binding.kind !== "remote") {
        throw new Error("Remote project open returned a local project binding.");
      }
      set((prev) => {
        const projectKey = normalizeProjectKey(binding.key);
        const cachedLanes =
          prev.laneCacheByProject[projectKey]
          ?? readPersistedLaneCache(projectKey);
        const restoredSelection =
          prev.laneSelectionByProject[projectKey]
          ?? {
            laneId: cachedLanes?.lanes[0]?.id ?? null,
            sessionId: null,
          };
        const laneCacheByProject =
          cachedLanes && !prev.laneCacheByProject[projectKey]
            ? {
                ...prev.laneCacheByProject,
                [projectKey]: cachedLanes,
              }
            : prev.laneCacheByProject;
        const existingBindingIndex = prev.openRemoteProjectTabs.findIndex(
          (entry) => entry.key === binding.key,
        );
        const openRemoteProjectTabs =
          existingBindingIndex === -1
            ? [...prev.openRemoteProjectTabs, binding]
            : prev.openRemoteProjectTabs.map((entry, index) =>
                index === existingBindingIndex ? binding : entry,
              );
        return {
          project: {
            rootPath: binding.rootPath,
            displayName: binding.displayName,
            baseRef: "main",
          },
          projectBinding: binding,
          projectRevision:
            outgoingProjectKey === projectKey
              ? prev.projectRevision
              : prev.projectRevision + 1,
          projectHydrated: true,
          showWelcome: false,
          projectTransition: null,
          projectTransitionError: null,
          isNewTabOpen: false,
          openRemoteProjectTabs,
          laneSnapshots: cachedLanes?.laneSnapshots ?? [],
          lanes: cachedLanes?.lanes ?? [],
          lanesLoading: !cachedLanes,
          laneDeleteProgressByLaneId: {},
          selectedLaneId: restoredSelection.laneId,
          focusedSessionId: restoredSelection.sessionId,
          laneInspectorTabs: {},
          keybindings: null,
          terminalAttention: EMPTY_TERMINAL_ATTENTION,
          laneCacheByProject,
        };
      });
      invalidateAiDiscoveryCache(binding.rootPath);
      invalidateProjectConfigCache(binding.rootPath);
      void Promise.allSettled([
        get().refreshLanes({ includeStatus: false }),
        get().refreshKeybindings()
      ]);
      scheduleProjectHydration();
      return binding;
    } catch (error) {
      if (switchGeneration === remoteProjectSwitchGeneration) {
        set({
          projectTransition: null,
          lanesLoading: false,
          projectTransitionError: formatProjectTransitionError("switching", error),
        });
      }
      throw error;
    }
  },

  closeProject: async () => {
    const closingProjectRoot = selectActiveProjectRoot(get());
    ++laneRefreshVersion;
    set({
      projectTransition: {
        kind: "closing",
        rootPath: closingProjectRoot,
        startedAtMs: Date.now(),
      },
      projectTransitionError: null,
      projectBinding: null,
    });
    try {
      await window.ade.project.closeCurrent();
      invalidateAiDiscoveryCache(closingProjectRoot);
      invalidateProjectConfigCache(closingProjectRoot);
      for (const binding of get().openRemoteProjectTabs) {
        get().evictProjectState(binding.key);
      }
      get().setProject(null);
      set({
        projectHydrated: true,
        showWelcome: true,
        projectTransition: null,
        projectTransitionError: null,
        isNewTabOpen: false,
        laneSnapshots: [],
        lanes: [],
        lanesLoading: false,
        laneDeleteProgressByLaneId: {},
        selectedLaneId: null,
        focusedSessionId: null,
        laneInspectorTabs: {},
        keybindings: null,
        terminalAttention: EMPTY_TERMINAL_ATTENTION,
        openProjectTabRoots: [],
        openRemoteProjectTabs: [],
        // No active project: drop every dismiss entry so reopening the same project later starts with a clean slate.
        dismissedMissingAiBannerRoots: {},
        dismissedGithubBannerRoots: {},
      });
    } catch (error) {
      const projectTransitionError = formatProjectTransitionError("closing", error);
      set({
        projectTransition: null,
        lanesLoading: false,
        projectTransitionError: projectTransitionError.code && closingProjectRoot
          ? { ...projectTransitionError, rootPath: closingProjectRoot }
          : projectTransitionError,
      });
      throw error;
    }
  }
  });
};

export type AppStoreApi = StoreApi<AppState>;

const rootAppStore = createStore<AppState>()(createAppState);
const AppStoreContext = createContext<AppStoreApi | null>(null);

function createLocalProjectBinding(project: ProjectInfo): OpenProjectBinding {
  return {
    kind: "local",
    key: `local:${project.rootPath}`,
    rootPath: project.rootPath,
    displayName: project.displayName,
  };
}

export function createProjectAppStore(
  project: ProjectInfo,
  projectBinding: OpenProjectBinding = createLocalProjectBinding(project),
): AppStoreApi {
  const store = createStore<AppState>()(createAppState);
  const rootState = rootAppStore.getState();
  const projectKey = projectStateKeyForBinding(projectBinding, project.rootPath);
  const cachedLanes =
    rootState.laneCacheByProject[projectKey]
    ?? readPersistedLaneCache(projectKey);
  const restoredSelection =
    rootState.laneSelectionByProject[projectKey]
    ?? {
      laneId: cachedLanes?.lanes[0]?.id ?? null,
      sessionId: null,
    };
  store.setState({
    project,
    projectBinding,
    projectHydrated: true,
    showWelcome: false,
    isNewTabOpen: false,
    personalChatsTabOpen: false,
    theme: rootState.theme,
    terminalPreferences: rootState.terminalPreferences,
    codeBlockCopyButtonPosition: rootState.codeBlockCopyButtonPosition,
    agentTurnCompletionSound: rootState.agentTurnCompletionSound,
    agentTurnCompletionSoundVolume: rootState.agentTurnCompletionSoundVolume,
    agentTurnCompletionSoundQuietWhenFocused: rootState.agentTurnCompletionSoundQuietWhenFocused,
    chatFontSizePx: rootState.chatFontSizePx,
    chatUserMinimapEnabled: rootState.chatUserMinimapEnabled,
    chatTranscriptDensity: rootState.chatTranscriptDensity,
    chatChromeTint: rootState.chatChromeTint,
    chatShellGeometry: rootState.chatShellGeometry,
    smartTooltipsEnabled: rootState.smartTooltipsEnabled,
    onboardingEnabled: rootState.onboardingEnabled,
    didYouKnowEnabled: rootState.didYouKnowEnabled,
    launchPromptClipboardEnabled: rootState.launchPromptClipboardEnabled,
    launchPromptClipboardNoticeEnabled: rootState.launchPromptClipboardNoticeEnabled,
    voiceInputEnabled: rootState.voiceInputEnabled,
    setTheme: rootState.setTheme,
    setTerminalPreferences: rootState.setTerminalPreferences,
    setCodeBlockCopyButtonPosition: rootState.setCodeBlockCopyButtonPosition,
    setAgentTurnCompletionSound: rootState.setAgentTurnCompletionSound,
    setAgentTurnCompletionSoundVolume: rootState.setAgentTurnCompletionSoundVolume,
    setAgentTurnCompletionSoundQuietWhenFocused: rootState.setAgentTurnCompletionSoundQuietWhenFocused,
    setChatFontSizePx: rootState.setChatFontSizePx,
    setChatUserMinimapEnabled: rootState.setChatUserMinimapEnabled,
    setChatTranscriptDensity: rootState.setChatTranscriptDensity,
    setChatChromeTint: rootState.setChatChromeTint,
    setChatShellGeometry: rootState.setChatShellGeometry,
    resetThemeAndChatFontDefaults: rootState.resetThemeAndChatFontDefaults,
    setSmartTooltipsEnabled: rootState.setSmartTooltipsEnabled,
    setOnboardingEnabled: rootState.setOnboardingEnabled,
    setDidYouKnowEnabled: rootState.setDidYouKnowEnabled,
    setLaunchPromptClipboardEnabled: rootState.setLaunchPromptClipboardEnabled,
    setLaunchPromptClipboardNoticeEnabled: rootState.setLaunchPromptClipboardNoticeEnabled,
    setVoiceInputEnabled: rootState.setVoiceInputEnabled,
    workViewByProject: rootState.workViewByProject,
    laneWorkViewByScope: rootState.laneWorkViewByScope,
    laneSelectionByProject: rootState.laneSelectionByProject,
    laneCacheByProject: cachedLanes && !rootState.laneCacheByProject[projectKey]
      ? {
          ...rootState.laneCacheByProject,
          [projectKey]: cachedLanes,
        }
      : rootState.laneCacheByProject,
    sessionsCacheByProject: rootState.sessionsCacheByProject,
    laneSnapshots: cachedLanes?.laneSnapshots ?? [],
    lanes: cachedLanes?.lanes ?? [],
    // The scoped surface owns its refresh lifecycle. Keep cached lanes visible,
    // but let ProjectSurface start a refresh when this surface becomes active.
    lanesLoading: false,
    selectedLaneId: restoredSelection.laneId,
    focusedSessionId: restoredSelection.sessionId,
  });
  return store;
}

export function retainProjectAppStoreState(
  store: AppStoreApi,
  binding: OpenProjectBinding,
): void {
  const projectKey = projectStateKeyForBinding(binding);
  if (!projectKey) return;
  const surfaceState = store.getState();
  rootAppStore.setState((prev) => {
    const workViewByProject = { ...prev.workViewByProject };
    if (surfaceState.workViewByProject[projectKey]) {
      workViewByProject[projectKey] = surfaceState.workViewByProject[projectKey];
    }

    const laneWorkViewByScope = { ...prev.laneWorkViewByScope };
    const laneScopePrefix = `${projectKey}::`;
    for (const key of Object.keys(laneWorkViewByScope)) {
      if (key.startsWith(laneScopePrefix)) delete laneWorkViewByScope[key];
    }
    for (const [key, value] of Object.entries(surfaceState.laneWorkViewByScope)) {
      if (key.startsWith(laneScopePrefix)) laneWorkViewByScope[key] = value;
    }

    const laneSelectionByProject = {
      ...prev.laneSelectionByProject,
      [projectKey]: {
        laneId: surfaceState.selectedLaneId,
        sessionId: surfaceState.focusedSessionId,
      },
    };
    const laneCacheByProject = {
      ...prev.laneCacheByProject,
      [projectKey]:
        surfaceState.laneCacheByProject[projectKey]
        ?? {
          lanes: surfaceState.lanes,
          laneSnapshots: surfaceState.laneSnapshots,
        },
    };
    const sessionsCacheByProject = { ...prev.sessionsCacheByProject };
    if (surfaceState.sessionsCacheByProject[projectKey]) {
      sessionsCacheByProject[projectKey] =
        surfaceState.sessionsCacheByProject[projectKey];
    }
    persistWorkViewState({ workViewByProject, laneWorkViewByScope });
    persistLaneCache(projectKey, laneCacheByProject[projectKey]?.lanes ?? []);
    return {
      workViewByProject,
      laneWorkViewByScope,
      laneSelectionByProject,
      laneCacheByProject,
      sessionsCacheByProject,
    };
  });
}

export function hydrateProjectAppStore(store: AppStoreApi, state: Partial<AppState>): void {
  store.setState(state);
}

export function useAppStoreApi(): AppStoreApi {
  return useContext(AppStoreContext) ?? rootAppStore;
}

export function AppStoreProvider({
  store,
  children,
}: {
  store: AppStoreApi;
  children: ReactNode;
}): React.ReactElement {
  return React.createElement(AppStoreContext.Provider, { value: store }, children);
}

type UseAppStore = {
  <T>(selector: (state: AppState) => T): T;
  getState: AppStoreApi["getState"];
  setState: AppStoreApi["setState"];
  subscribe: AppStoreApi["subscribe"];
};

export const useAppStore = Object.assign(
  (<T,>(selector: (state: AppState) => T): T =>
    useStore(useContext(AppStoreContext) ?? rootAppStore, selector)) as UseAppStore,
  {
    getState: rootAppStore.getState,
    setState: rootAppStore.setState,
    subscribe: rootAppStore.subscribe,
  },
);

/**
 * The single root app store. The app-global voice recorder writes the ephemeral
 * dictation slice here so the always-mounted header indicator and the
 * project-scoped composer pill share one live capture session, regardless of
 * which project-scoped store the composer's own `useAppStore` resolves to.
 */
export const rootAppStoreApi: AppStoreApi = rootAppStore;

/**
 * Reactively read from the ROOT store, bypassing any `AppStoreProvider` context.
 * Components rendered inside a project-scoped store (e.g. the chat composer) use
 * this for dictation state so they observe the same session the recorder drives.
 */
export function useRootAppStore<T>(selector: (state: AppState) => T): T {
  return useStore(rootAppStore, selector);
}
