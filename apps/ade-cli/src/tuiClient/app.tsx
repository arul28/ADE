import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveTrustedWindowsTool } from "../lib/trustedWindowsTools";
import { Box, Text, useApp, useInput, type Key as InkKey } from "ink";
import {
  getModelById,
  modelSupportsFastMode,
  resolveModelDescriptor,
  resolveProviderGroupForModel,
} from "../../../desktop/src/shared/modelRegistry";
import { resolveStableLaneBaseBranch } from "../../../desktop/src/shared/laneBaseResolution";
import { LAUNCH_PROFILE_TITLE, LAUNCH_PROFILE_TOOL_TYPE, resolveClaudeCliModelForLaunch } from "../../../desktop/src/shared/cliLaunch";
import { getAgentSkillRootCandidates } from "../../../desktop/src/shared/agentSkillRoots";
import {
  activeTurnInterruptContinues,
  supportsActiveTurnDispatchMode,
  unsupportedActiveTurnDispatchModeMessage,
} from "../../../desktop/src/shared/types/chat";
import { providerDisplayLabel } from "../../../desktop/src/shared/pendingInputLabels";
import {
  composerFileSearchQuery,
  composerTriggerForSelection,
  composerTriggerHasConfirmedPrefix,
  composerTriggerSpansWholeDraft,
  detectComposerTrigger,
  findConfirmedComposerTokens,
  isComposerTriggerDismissed,
  replaceComposerTriggerSpan,
  type ComposerTokenRange,
  type ComposerTriggerDismissal,
} from "../../../desktop/src/shared/composerTriggers";
import { isChatMentionTokenBody, scoreChatMentionCandidate } from "../../../desktop/src/shared/chatMentions";
import { findSmartLinks } from "../../../desktop/src/shared/smartLinks";
import type {
  AgentChatClaudePlugin,
  AgentChatTurnRecoveryAction,
  AgentChatReloadClaudePluginsResult,
  AgentChatEventEnvelope,
  AgentChatFileRef,
  AgentChatModelCatalog,
  AgentChatModelCatalogModel,
  AgentChatModelCatalogRefreshProvider,
  AgentChatModelInfo,
  AgentChatScheduledWorkState,
  AgentChatSession,
  AgentChatSessionSummary,
  AgentChatSlashCommand,
  AgentChatStopMode,
  ClaudeActiveGoal,
  CodexThreadGoal,
} from "../../../desktop/src/shared/types/chat";
import {
  isStoredQuestionAnswered,
  ownQuestionValue,
} from "../../../desktop/src/shared/pendingInputAnswers";
import type { AiSettingsStatus, OpenCodeRuntimeSnapshot } from "../../../desktop/src/shared/types/config";
import type { DiffLineStats, GitConflictState } from "../../../desktop/src/shared/types/git";
import type {
  ArchiveAndReclaimLaneResult,
  LaneDeleteRisk,
  LaneLinearIssue,
  LaneReclaimRisk,
  LaneSummary,
  RestoreLaneResult,
} from "../../../desktop/src/shared/types/lanes";
import type { FeedbackPreparedDraft, FeedbackSubmission } from "../../../desktop/src/shared/types/feedback";
import type { ProjectSecretsListResult, ProjectSecretValueResult } from "../../../desktop/src/shared/types/projectSecrets";
import type { SearchQueryResult, SearchResultItem } from "../../../desktop/src/shared/types/search";
import type { ChatTerminalPreviewResult, ChatTerminalSession, UsageSnapshot } from "../../../desktop/src/shared/types";
import {
  hasPluginActionComposerRequest,
  hasPluginActionOpenUrlRequest,
  readPluginActionComposerEdit,
  readPluginActionNavigation,
  readPluginActionOpenUrl,
} from "../../../desktop/src/shared/plugins/sdk";
import { builtinSurfaceDrawn } from "../../../desktop/src/shared/plugins/builtinSurfaces";
import type { PluginSurfaceContext } from "../../../desktop/src/shared/plugins/context";
import {
  pluginPromptAnswerArgs,
  pluginPromptHint,
  pluginPromptOutcome,
  pluginPromptPlaceholder,
  pluginPromptResolveChoice,
  pluginPromptTitle,
  pluginPromptTooLongNotice,
  pluginPromptUnknownChoiceNotice,
  type PluginPromptRequest,
} from "./pluginPrompt";
import { rollupPrChecks } from "../../../desktop/src/shared/prChecksRollup";
import type { GitHubPrStackMembership, PrChecksStatus } from "../../../desktop/src/shared/types/prs";
import {
  approveToolUse,
  archiveChatSession,
  buildPtyContinuationLaunchFields,
  cancelSteerMessage,
  createChatSession,
  deleteChatSession,
  discoverProjectSlashCommands,
  dispatchSteerMessage,
  deriveClaudeGoalFromEvents,
  editSteerMessage,
  enrichChatSessionsWithLifecycle,
  enrichTerminalSessionsWithLifecycle,
  getAvailableModels,
  getAiSettingsStatus,
  getChatHistory,
  getChatHistoryPage,
  getLaneSummary,
  getMainTranscript,
  getContextUsage,
  getModelCatalog,
  getModelPickerFavorites,
  getModelPickerRecents,
  pushModelPickerRecent,
  toggleModelPickerFavorite,
  getOpenCodeRuntimeDiagnostics,
  watchCursorCloudMirror,
  getCursorCloudFleet,
  getSlashCommands,
  getScheduledWorkState,
  getStoredApiKeyProviders,
  getSubagentTranscript,
  clearSessionWokeMarker,
  interruptChat,
  defaultPluginPanelId,
  invokePluginAction,
  killDroidWorker,
  latestGoal,
  latestTokenStats,
  listGitBranches,
  listLaneDiffStats,
  listPlugins,
  listClaudePlugins,
  loadPluginTuiContributions,
  readPluginCollection,
  readPluginPanel,
  resolvePluginByName,
  listClaudeOutputStyles,
  listChatSessions,
  listTerminalSessions,
  listLanes,
  listPrsByLane,
  listSessionSummaries,
  listSubagents,
  messageChatSession,
  mergeLaneStatusSnapshots,
  navigateDesktop,
  newestSession,
  normalizeChatTerminalSession,
  previewTerminal,
  renameChat,
  recoverTurn,
  restoreCancelledQueue,
  resolveUnprocessedMessage,
  requestSessionAttention,
  resumeTerminalSession,
  resizeTerminal,
  reloadClaudePlugins,
  respondToInput,
  runDefaultLaneSetup,
  saveRuntimeTempAttachment,
  sendChatMessage,
  sendToTerminalSession,
  setChatSpawnKind,
  signalTerminal,
  setClaudeOutputStyle,
  setSessionStatusNote,
  setSessionSettleOverride,
  settleSession,
  snoozeSession,
  wakeSession,
  startCliTerminalSession,
  type CliTerminalProvider,
  steerChatMessage,
  tagChat,
  unarchiveChatSession,
  unsettleSession,
  updateChatModel,
  writeTerminal,
  type TuiChatSessionSummary,
  type TokenStats,
} from "./adeApi";
import { aggregateChatBlocks, derivePendingSteers, type AggregatedBlock } from "./aggregate";
import { deriveChatInfoSnapshot, mergeSubagentSnapshots, snapshotFromRuntimeSubagent } from "./chatInfo";
import { BUILTIN_COMMANDS, paletteCommands, parseCommand, slashCommandUnavailableSurface } from "./commands";
import {
  parseWorkSearchQuery,
  scoreWorkSearchTerms,
} from "../../../desktop/src/shared/workSearch";
import {
  resolveSessionTarget,
  resolveSnoozeChoice,
  resolveSnoozeChoices,
  resolveSnoozeFreeText,
  clearWokeMarkerOnVisit as clearSessionWokeMarkerOnVisit,
  sessionLifecycleCommandFor,
  sessionLifecycleMarker,
  type SessionLifecycleCommand,
} from "./sessionLifecycle";
import type { SnoozeDurationKey } from "../../../desktop/src/renderer/lib/sessionSnooze";
import { buildHelpIndex, buildHelpRows, flattenHelpRows, pushRecent } from "./helpIndex";
import { hasFirstUserMessage, isPlanMode } from "./planMode";
import { connectToAde, INTERACTIVE_PROJECT_REGISTRATION } from "./connection";
// Imported from the service manager rather than re-exported through
// ./connection: several suites mock ./connection with a partial factory, and a
// startup screen must not depend on an export those mocks have to remember.
import { RuntimeServiceStillStartingError } from "../serviceManager/common";
import { captureTuiProductAnalytics, deriveTuiAnalyticsScreen } from "./productAnalytics";
import { WorkSessionsPane } from "./components/WorkSessionsPane";
import {
  computeWorkListLayout,
  workListHitRects,
  workListMouseHitForLayout,
  type WorkListHitRegion,
  type WorkListLayout,
} from "./workListLayout";
import {
  buildWorkListModel,
  foreignRowsFromAttention,
  resolveWorkListSelection,
  stepWorkListSelection,
  workListRowIndex,
  workListSelectionCopyText,
  type WorkListForeignSession,
  type WorkListModel,
  type WorkListRow,
  type WorkListSessionRow,
  type WorkListShelfKind,
} from "./workListModel";
import {
  LOCAL_MACHINE_KEY,
  buildMachinePickerRows,
  coerceProjectRecords,
  createAdeCodeConnectionPool,
  loadMachinePickerSources,
  pickProjectRecord,
  rankProjectsForPicker,
  type MachineQuery,
} from "./connectionPool";
import {
  buildNewLaneSubmission,
  cycleNewLaneColor,
  cycleNewLaneStart,
  filterNewLaneBranchMatches,
  newLaneFormFieldRowOffsets,
  newLaneFormFields,
  newLaneStartForClickRow,
  newLaneTypeaheadField,
  normalizeNewLaneBranchSource,
  normalizeNewLaneStart,
  toggleNewLaneBranchSource,
} from "./newLaneForm";
import {
  ChatView,
  workFileDiffKey,
  chatScrollMaxOffsetFromSelectableRows,
  hasConversationContent,
  renderChatSelectableRows,
  renderChatSelectableRowTextsFromRows,
  renderChatVisibleSelectionRowsFromRows,
  selectedTextFromChatRows,
  type ChatVisibleSelectionRow,
  type ChatTextSelection,
} from "./components/ChatView";
import { TerminalPane, clampTerminalPaneCols } from "./components/TerminalPane";
import {
  type TerminalScrollBySessionId,
  clampTerminalScrollOffset,
  jumpTerminalToBottom,
  noteTerminalNewRows,
  readTerminalScroll,
  scrollTerminalBy,
  terminalPageStep,
} from "./components/TerminalScrollState";
import { Header } from "./components/Header";
import { chatInfoPreambleLines, chatInfoSelectionOffset, computeLaneChatCounts, DETAILS_BODY_MAX_LINES, LANE_DETAIL_ACTIONS, LANE_DETAIL_PR_ACTION_INDEX, laneDetailsInteractionLayout, resolveChatInfoRosterViewState, rightPaneScrollableRowCount, RightPane } from "./components/RightPane";
import { collectModelPickerEntries } from "./components/ModelPicker/modelPickerLayout";
import { modelWizardGeometry } from "./components/ModelPicker/modelWizardGeometry";
import {
  advanceModelWizard,
  backModelWizard,
  buildModelWizardView,
  cycleModelWizardSetting,
  initialModelWizardSelection,
  moveModelWizardIndex,
  normalizeModelWizardSelection,
  type ModelWizardInput,
  type ModelWizardSelection,
} from "./modelWizard";
import {
  CODEX_PRESETS,
  CLAUDE_PERMISSION_OPTIONS,
  DROID_PERMISSION_OPTIONS,
  OPENCODE_PERMISSION_OPTIONS,
  applyProviderPermissionMode,
  buildSetupRows,
  cliProviderForModelStateProvider,
  codexApprovalSandboxLabel,
  codexPresetPatch,
  cursorModeIdsForState,
  cursorModelAvailableForInterface,
  cursorSourceForInterfaceMode,
  defaultSetupSelectionIndex,
  droidPermissionToLegacy,
  fallbackModelStatePatch,
  initialModelState,
  modeAccentColor,
  modeDescription,
  modelCatalogRefreshCacheKey,
  modelMemoryFromState,
  modelReasoningEfforts,
  modelStatePatchForModel,
  modelStatePatchFromMemory,
  permissionSummary,
  providerModelsCacheKey,
  reasoningEffortDisplayLabel,
  reconcileCursorModelStateForInterface,
  registryModelsForProvider,
  seedModelStateFromMemory,
  resolveCodexPreset,
  resolveCursorCliModelForLaunch,
  runtimeProviderForUiProvider,
} from "./modelState";
import {
  TUI_PROVIDER_OPTIONS,
  TUI_PROVIDERS,
  normalizeCatalogProvider,
  normalizeProvider,
  providerLabel,
} from "./providerMetadata";
import { SlashPalette, slashPaletteReservedRows } from "./components/SlashPalette";
import { MentionPalette, MENTION_PALETTE_ROWS } from "./components/MentionPalette";
import { CommandPalette, COMMAND_PALETTE_ROWS, type CommandPaletteItem } from "./components/CommandPalette";
import { ApprovalPrompt } from "./components/ApprovalPrompt";
import { ModelStatus } from "./components/ModelStatus";
import { ExternalSessionPreview } from "./components/ExternalSessionPreview";
import { FooterControls } from "./components/FooterControls";
import { MultiChatGrid } from "./components/MultiChatGrid";
import { AddChatModeBanner } from "./components/AddChatMode";
import { theme } from "./theme";
import { resolveTuiChatRefreshTarget } from "./project";
import {
  RIGHT_CHAT_CLOSED_TOGGLE_ID,
  closedCliRightPaneRow,
  deriveClosedCliSessions,
  deriveOpenWorkSessions,
  isTerminalSessionResumable,
  sortSessionsByRecentActivity,
  terminalSessionProvider,
  terminalSessionToChatSummary,
  type WorkChatAction,
} from "./closedCliSessions";
import { sortLanesForStackGraph } from "./laneTree";
import {
  formatLaneLabel,
  formatSessionLabel,
  latestExpandableFailureId,
  renderObject,
  summarizeDiffChanges,
} from "./format";
import { startTuiHeartbeat, type TuiHeartbeat } from "./heartbeat";
import { clipboardScratchDir, isImageFilePath, latestOpenableImageTarget, readClipboardImageAttachment, readImageDimensions } from "./imageTargets";
import { appendReservedTuiEvent, dedupeTuiEvents, reserveTuiEventDedupKey, syncTuiEventDedupKeys } from "./eventDedup";
import { advanceOlderHistoryCursor, captureTuiHistoryArrivalWatermark, mergeDetachedTuiHistoryTail, mergeHydratedTuiHistory, prependOlderTuiHistory, resolveSnapshotHistoryCursor, shouldRequestOlderTuiHistory, splitSnapshotForDisplay, takeNewestChunk, TUI_LOADED_EVENT_CAP, TUI_SNAPSHOT_DISPLAY_CAP, type OlderHistoryStatus } from "./olderHistory";
import { coalesceTextDeltaEnvelopes } from "./assistantTextIdentity";
import {
  EMPTY_BRACKETED_PASTE_STATE,
  consumeBracketedPasteInput,
  formatTerminalControlForwardedInput,
  stripBracketedPasteMarkers,
  type BracketedPasteState,
} from "./bracketedPaste";
import {
  codeUnitIndexForDisplayCell,
  displayCellForCodeUnitIndex,
  displayClusters,
  splitByDisplayCells,
  terminalDisplayWidth,
} from "./displayWidth";
import {
  flushAdeCodeStateWrites,
  loadAdeCodeState,
  saveAdeCodeModelMemory,
  saveAdeCodeProjectState,
  scopedAdeCodeModelMemory,
  scopedAdeCodeState,
  type AdeCodeModelMemory,
} from "./state";
import {
  clampExternalSessionBrowserContent,
  externalSessionActionKey,
  externalSessionBrowserActions,
  externalSessionProviderLabel,
  isImportAffordance,
  nextExternalSessionProviderFilter,
  normalizeExternalSessionListResult,
  visibleExternalSessions,
  type ImportAffordance,
} from "./externalSessionBrowser";
import { SpinTickProvider } from "./spinTick";
import { ACTIVE_SESSION_PLACEHOLDER, buildLinearToolRequest } from "./linearCommands";
import { buildIssueToolRequest, executeIssueToolRequest } from "./issueCommands";
import {
  formatLinearIssueComments,
  derivePrMergeReadiness,
  formatCursorCloudFleetRows,
  formatLinearStatus,
  formatPrChecks,
  formatPrComments,
  formatPrMergeState,
  formatPrReview,
  formatPrSummary,
  formatSystemDetails,
  CURSOR_CLOUD_PANE_NOTE,
} from "./rightPaneFormatters";
import { cursorCloudRenameBlockedReason } from "./cursorCloudChatRename";
import {
  buildFeedbackDraftInput,
  buildFeedbackEnvironment,
  feedbackFormFields,
  feedbackSubmissionNotice,
  type FeedbackFormValues,
} from "./feedback";
import {
  cycleFeedbackType,
  feedbackFormCanSubmit,
  feedbackFormToFormValues,
  type FeedbackFormState,
  type FeedbackType,
} from "./feedbackForm";
import {
  buildPendingInputAnswers,
  cancelPendingQuestionDigitSelection,
  convertPendingQuestionDigitSelectionToText,
  createPendingQuestionSelectionState,
  ensurePendingQuestionSelectionState,
  latestPendingApproval,
  movePendingQuestionFocus,
  movePendingQuestionOption,
  optionsForPendingQuestion,
  pendingQuestionAnswerGuidance,
  pendingQuestionAnsweredCount,
  pendingQuestionSelectionValue,
  selectPendingQuestionDigit,
  selectPendingQuestionOptionIndex,
  setPendingQuestionOptionIndex,
  type PendingQuestionSelectionState,
} from "./pendingInput";
import { claudeHomePath, defaultKeybindingsPath, dispatchKeybinding, mergePluginKeybindings, openKeybindingsFile, parsePluginKeybindingAction, readClaudeKeybindingsFile, type ClaudeKeybinding, type KeybindingDispatchState, type PluginKeybindingPlugin, type TuiResolvedKeybindingAction } from "./keybindings";
import { buildDeeplinkForRow, buildWebClientUrlForRow, type DeeplinkRow } from "./deeplinkRow";
import { copyToClipboard } from "../lib/clipboard";
import {
  accountSessionLabel,
  accountSessionStateFromResult,
  acknowledgeActivityItem,
  activityItemDeepLink,
  buildActivityPaneModel,
  loadActivitySnapshot,
} from "./activityPane";
import type { AttentionSnapshot } from "../../../desktop/src/shared/types/attention";
import { deriveProjectId } from "../services/projects/projectRegistry";
import {
  bindingKey,
  buildPluginPaneModel,
  cyclePluginFieldValue,
  distinctBindings,
  movePluginPaneSelection,
  pluginFieldRawValue,
  pluginFieldUsesComposer,
  pluginFormValueKey,
  pluginInteractiveKey,
  pluginPaneBindingRows,
  pluginPaneClearSelection,
  pluginPaneSelectionPayload,
  pluginPaneSelectionReset,
  pluginPaneStateChange,
  pluginPaneStateCycle,
  pluginPaneStatePayload,
  pluginPaneStateReset,
  pluginPaneShowMore,
  pluginPaneToggleGroup,
  pluginPaneToggleRow,
  PLUGIN_PANE_TOO_NARROW,
  type PluginPaneCollectionMap,
  type PluginPaneInput,
} from "./pluginPane";
import {
  buildPluginActionsPane,
  pluginRowBadgeStrip,
  tuiLaneContext,
  tuiSessionContext,
  EMPTY_PLUGIN_TUI_CONTRIBUTIONS,
  type PluginRowActionEntry,
  type PluginRowBadgeStrip,
  type PluginTuiContributions,
} from "./pluginSockets";
import {
  deletePromptSmartLinkBackward,
  deletePromptSmartLinkForward,
  formatPromptSmartLinkStrip,
} from "./promptSmartLinks";
import {
  clearComposerDraft,
  createComposerDraftStore,
  deleteImageTokenBackward,
  deleteImageTokenForward,
  expandImageTokensForSend,
  findImageTokens,
  formatImageToken,
  imageTokenAtCursor,
  insertImageToken,
  readComposerDraft,
  sessionHasDraft,
  referencedAttachmentPaths,
  retainReferencedAttachments,
  saveComposerDraft,
  uniqueImageTokenLabel,
  type ComposerDraftAttachment,
} from "./composerDrafts";
import {
  buildSubagentPaneRows,
  buildSubagentTranscriptEvents,
  SUBAGENT_PANE_ROSTER_CAPACITY,
  subagentIndexForPaneLine,
  subagentPaneContentFromRightPane,
  subagentTranscriptMessagesToEvents,
  type SubagentPaneDisclosureSection,
  type SubagentPaneRow,
  type SubagentPaneTarget,
  type SubagentPaneViewState,
} from "./subagentPane";
import { readClaudeStatusLineConfig, runClaudeStatusLineCommand } from "./statusline";
import {
  createHitTestRegistry,
  HitTestProvider,
  type HitTarget,
} from "./hitTestRegistry";
import {
  asTileCount,
  canRenderMultiChatGrid,
  computeTileRects,
  focusedSessionIdForMultiView,
  type MultiViewState,
  type MultiViewTile,
} from "./multiChatLayout";
import type {
  AdeCodeConnection,
  AdeCodeProvider,
  AdeCodeInterfaceMode,
  AdeCodeModelState,
  LocalNotice,
  LaneSetupStatus,
  MentionSuggestion,
  PendingApproval,
  ProviderReadinessRow,
  ProjectLaunchContext,
  FeedbackContextMeta,
  RightPaneContent,
  SetupPaneRow,
  SetupPaneRowKind,
  SubagentSnapshot,
  RuntimeMode,
} from "./types";
import type {
  ExternalSessionImportResult,
  ExternalSessionSummary,
} from "../../../desktop/src/shared/types/externalSessions";

export { isTerminalSessionResumable } from "./closedCliSessions";

const PURPLE = theme.color.accent;
const EMPTY_CHAT_EVENTS: AgentChatEventEnvelope[] = [];
const EMPTY_SUBAGENT_SNAPSHOTS: SubagentSnapshot[] = [];
const EMPTY_TERMINAL_CHUNKS: string[] = [];
const MODEL_CATALOG_CLIENT_REFRESH_TTL_MS = 5 * 60_000;
const MODEL_CATALOG_LOCAL_CLIENT_REFRESH_TTL_MS = 30_000;
type PaneFocus = "drawer" | "chat" | "details" | "addMode";
type AddModeState = { cursorLaneId: string; cursorChatId: string | null };
export type FooterControl = "drawer" | "details" | "agents";

/**
 * What the sessions pane currently has under its cursor. Replaces the drawer's
 * `"lanes" | "chats"` MODE: the pane no longer has modes, so "am I looking at a
 * lane or a chat" is now a property of the selected row, not of the pane.
 */
export type WorkSelectionKind = "session" | "lane" | "new-chat" | "shelf" | null;

/**
 * Per-lane PR rollup, kept for the chat-info pane's PR block. It used to live in
 * the lane drawer, which rendered it as a pill; the sessions pane that replaced
 * the drawer is session-first and shows lane PRs through `/prs` and lane details
 * instead, so app.tsx is now the only owner.
 */
export type LanePrSummary = {
  number: number;
  state: "open" | "closed" | "merged";
  checksPassed: number;
  checksTotal: number;
  /** ADE-135 canonical rollup; `passed === total` is not proof of a pass. */
  checksStatus?: PrChecksStatus;
  stack?: GitHubPrStackMembership | null;
};

// Streaming chat events are coalesced into a single React render per frame
// (~40fps) instead of one render per token. Lifecycle edges (turn start/stop,
// done, user messages, subagent/error) force an immediate flush so the spinner,
// interrupt flags, and right pane stay responsive.
// Token deltas are batched into one render per interval. A slightly longer window
// lets more same-message deltas coalesce per flush (see coalesceTextDeltaEnvelopes)
// — fewer, larger renders means far less per-token transcript re-wrap/flicker,
// while staying well within smooth-streaming range for text.
const CHAT_EVENT_FLUSH_MS = 48;
export const BACKGROUND_REFRESH_DEBOUNCE_MS = 200;
const PTY_ATTACHED_FLUSH_MS = 16;
const PTY_PREVIEW_FLUSH_MS = 32;
const TERMINAL_PREVIEW_POLL_MS = 1_000;

function isChatInfoAutoOpenEvent(eventType: string): boolean {
  return (
    eventType === "subagent_started"
    || eventType === "subagent.started"
    || eventType === "todo_update"
    || eventType === "scheduled_work_update"
  );
}

export function shouldAutoOpenChatInfoForEvent(args: {
  eventType: string;
  isActiveSessionEvent: boolean;
  activePane: string;
  userDismissedRightPane: boolean;
}): boolean {
  return (
    isChatInfoAutoOpenEvent(args.eventType)
    && args.isActiveSessionEvent
    && args.activePane !== "drawer"
    && !args.userDismissedRightPane
  );
}

export function isChatFlushEdge(eventType: string): boolean {
  // Only the event types that drive an immediate side-effect below (spinner /
  // interrupt / right-pane) force a synchronous flush. Notably NOT the broad
  // "subagent" prefix — subagent_progress is high-frequency and would defeat
  // coalescing; only subagent_started opens the right pane.
  return (
    eventType === "status"
    || eventType === "done"
    || eventType === "user_message"
    || eventType === "error"
    || isChatInfoAutoOpenEvent(eventType)
  );
}

export function footerControlsForAvailability(agentsAvailable: boolean): FooterControl[] {
  return agentsAvailable ? ["agents", "drawer", "details"] : ["drawer", "details"];
}

export type InlineRowCellName = "provider" | "model" | "fast" | "reasoning" | "permission" | "subagents";

// Single source of truth for the footer's inline cells. A cell only appears (and
// is focusable by keyboard/mouse) when it applies — so fast mode and reasoning
// are reachable exactly when supported, and neither is a dead focus stop.
export function inlineRowCellOrder(opts: {
  providerLocked: boolean;
  fastSupported: boolean;
  reasoningSupported: boolean;
  subagentsVisible: boolean;
}): InlineRowCellName[] {
  const cells: InlineRowCellName[] = [];
  if (!opts.providerLocked) cells.push("provider");
  cells.push("model");
  if (opts.fastSupported) cells.push("fast");
  if (opts.reasoningSupported) cells.push("reasoning");
  cells.push("permission");
  if (opts.subagentsVisible) cells.push("subagents");
  return cells;
}

// Turn a git conflict into a right-pane detail body + a one-line notice. Used by
// /pull and /reparent so a rebase/merge conflict is surfaced instead of being
// silently reported as success.
export function formatGitConflictReport(state: GitConflictState): { title: string; body: string; summary: string } {
  const label = state.kind === "rebase" ? "Rebase" : "Merge";
  const count = state.conflictedFiles.length;
  const plural = count === 1 ? "" : "s";
  const fileList = count
    ? state.conflictedFiles.map((file) => `  • ${file}`).join("\n")
    : "  (git did not report specific files)";
  const resolveActions = [
    state.canContinue ? "/pull --continue to finish" : null,
    state.canAbort ? "/pull --abort to back out" : null,
  ].filter((value): value is string => Boolean(value));
  const actionsLine = resolveActions.length
    ? `Resolve the conflicts, then run ${resolveActions.join(", or ")}.`
    : "Resolve the conflicts in your editor to continue.";
  return {
    title: `${label} conflict`,
    body: [`${count} file${plural} need resolution:`, fileList, "", actionsLine].join("\n"),
    summary: `${label} conflict — ${count} file${plural} need resolution. ${actionsLine}`,
  };
}

// One-line summary of what deleting a lane would lose, shown in the delete form
// so the confirmation isn't blind (mirrors the desktop's delete-risk surface).
export function formatLaneDeleteRisk(risk: LaneDeleteRisk): string {
  const parts: string[] = [];
  if (risk.dirty) parts.push("uncommitted changes");
  if (risk.hasUnpushedCommits) {
    parts.push(`${risk.unpushedCommitCount} unpushed commit${risk.unpushedCommitCount === 1 ? "" : "s"}`);
  }
  if (risk.activeChatCount > 0) {
    parts.push(`${risk.activeChatCount} chat session${risk.activeChatCount === 1 ? "" : "s"}`);
  }
  if (risk.activePtyCount > 0) parts.push(`${risk.activePtyCount} terminal${risk.activePtyCount === 1 ? "" : "s"}`);
  if (risk.remoteBranchExists) parts.push("remote branch exists");
  return parts.length ? `⚠ ${parts.join(" · ")}` : "Clean — no unpushed work or running sessions.";
}

function formatStorageBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / (1024 ** unitIndex);
  const precision = value >= 10 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

export function formatLaneReclaimPreview(risk: LaneReclaimRisk): string {
  const hardBlocked = risk.blockedReasons.some((reason) => reason.disposition === "blocked");
  const dirtyWarning = risk.blockedReasons.some((reason) => reason.code === "dirty_worktree");
  const reasons = risk.blockedReasons.length
    ? [
        "",
        hardBlocked ? "Why ADE cannot reclaim this lane:" : "Review before continuing:",
        ...risk.blockedReasons.map((reason) => `  • ${reason.message}`),
      ]
    : ["", "Safety check: Ready to reclaim."];
  const nextCommand = hardBlocked
    ? "Nothing has been removed."
    : [
        "Nothing has been removed.",
        `Run /lane archive-and-reclaim ${risk.laneId} RECLAIM${dirtyWarning ? " force-dirty" : ""} to continue.`,
      ].join("\n");
  return [
    `Estimated space: ${formatStorageBytes(risk.reclaimableBytes)}`,
    `  Worktree: ${formatStorageBytes(risk.worktreeBytes)}`,
    `  Generated data: ${formatStorageBytes(risk.generatedBytes)}`,
    "",
    "Removes: ADE's managed local worktree and generated data.",
    "Keeps: the lane, branch, chats, and metadata.",
    "Restore later with /lane unarchive <lane-id|name>.",
    ...reasons,
    "",
    nextCommand,
  ].join("\n");
}

// Three different features want Esc while the chat composer has focus, so the
// order between them is a product decision rather than an accident of where the
// branches happen to sit in the key handler. Resolved in one pure place so the
// precedence is testable and stays explicit:
//   1. the @/slash palette — it floats over the composer and advertises
//      "Esc close", so the visible affordance wins;
//   2. an active chat mouse selection;
//   3. vim insert -> normal.
// Each is one Esc: with the palette open and vim on, the first Esc only closes
// the palette and a second Esc then switches vim to normal.
export type ChatEscapeAction =
  | "dismiss-composer-trigger"
  | "clear-chat-selection"
  | "vim-normal"
  | null;

export function resolveChatEscapeAction(args: {
  pane: string;
  textInputActive: boolean;
  modified: boolean;
  composerTriggerOpen: boolean;
  chatSelectionActive: boolean;
  vimModeEnabled: boolean;
}): ChatEscapeAction {
  if (args.pane === "chat" && args.composerTriggerOpen) return "dismiss-composer-trigger";
  if (args.chatSelectionActive) return "clear-chat-selection";
  if (args.pane === "chat" && args.textInputActive && args.vimModeEnabled && !args.modified) {
    return "vim-normal";
  }
  return null;
}

export type ModelPickerEscapeAction =
  | { kind: "clear-search"; pane: Extract<RightPaneContent, { kind: "model-picker" }> }
  | { kind: "return-new-chat" }
  | { kind: "close" };

export function resolveModelPickerEscape(
  picker: Extract<RightPaneContent, { kind: "model-picker" }>,
): ModelPickerEscapeAction {
  if (picker.query.length > 0 || picker.searchMode) {
    return {
      kind: "clear-search",
      pane: { ...picker, query: "", searchMode: false, focusedIndex: 0 },
    };
  }
  if (picker.surface === "new-chat") return { kind: "return-new-chat" };
  return { kind: "close" };
}

// RightPane wraps the model picker in a single-line border (1) + a "MODEL" title
// row (1) and paddingX (1), so ModelPickerPane's first painted cell sits 2 rows
// below / 2 cols right of the pane's outer top-left and its usable width is 4
// narrower. The click hit-test MUST feed modelPickerGeometry this CONTENT origin
// (not the outer box) or every rect drifts and hover/clicks land on the wrong
// row. Exported as a pure helper so the offset is unit-tested and stays in
// lockstep with RightPane's chrome.
export const MODEL_PICKER_PANE_CHROME_ROWS = 2; // top border + "MODEL" title row
export const MODEL_PICKER_PANE_CHROME_COLS = 2; // left border + paddingX
export function modelPickerPaneContentOrigin(args: {
  paneTop: number;
  paneLeft: number;
  paneWidth: number;
}): { paneTop: number; paneLeft: number; paneWidth: number } {
  return {
    paneTop: args.paneTop + MODEL_PICKER_PANE_CHROME_ROWS,
    paneLeft: args.paneLeft + MODEL_PICKER_PANE_CHROME_COLS,
    paneWidth: Math.max(8, args.paneWidth - MODEL_PICKER_PANE_CHROME_COLS * 2),
  };
}

export function modelPickerProviderSwitchBlocked(args: {
  providerLocked: boolean;
  surface: "chat" | "new-chat";
  currentProvider: AdeCodeProvider;
  nextProvider: AdeCodeProvider;
}): boolean {
  return args.surface === "chat"
    && args.providerLocked
    && args.currentProvider !== args.nextProvider;
}

export function nextModelPickerProviderTabKey(args: {
  providerTabs: ReadonlyArray<{ key: string }>;
  providerTabIndex: number;
  delta: -1 | 1;
}): string | null {
  if (args.providerTabs.length <= 1) return null;
  const nextIndex = (args.providerTabIndex + args.delta + args.providerTabs.length) % args.providerTabs.length;
  return args.providerTabs[nextIndex]?.key ?? null;
}

export function mergeNewChatModelPickerContext(
  prev: Extract<RightPaneContent, { kind: "model-picker" }>,
  next: Extract<RightPaneContent, { kind: "model-picker" }>,
): Extract<RightPaneContent, { kind: "model-picker" }> {
  return {
    ...prev,
    laneId: next.laneId,
    laneLabel: next.laneLabel,
    settingsRows: next.settingsRows,
  };
}

export function planSessionStatePrune(args: {
  previous: Set<string>;
  current: Set<string>;
  connectionLost: boolean;
}): { nextSeen: Set<string>; removed: string[] } | null {
  if (args.current.size === 0 && (args.connectionLost || args.previous.size === 0)) {
    return null;
  }
  return {
    nextSeen: args.current,
    removed: [...args.previous].filter((sessionId) => !args.current.has(sessionId)),
  };
}

// Diff successive terminal id sets to find buffers/scroll state for closed
// terminals. This is a pure diff; the caller is responsible for not invoking it
// on a transient empty listing (a failed listTerminalSessions() catches to []),
// which would otherwise look like "every terminal closed" and mass-prune live
// buffers.
export function planTerminalBufferPrune(
  previous: Set<string>,
  current: Set<string>,
): { nextSeen: Set<string>; removed: string[] } {
  return {
    nextSeen: current,
    removed: [...previous].filter((terminalId) => !current.has(terminalId)),
  };
}

// Drop the given keys from a record, returning the same reference when nothing
// is removed so dependent effects/state setters don't trigger needless renders.
function pruneRecordKeys<T>(record: Record<string, T>, removed: string[]): Record<string, T> {
  if (!removed.some((key) => key in record)) return record;
  const next = { ...record };
  for (const key of removed) delete next[key];
  return next;
}

type ChatSessionActivity = Pick<AgentChatSessionSummary, "status" | "awaitingInput" | "idleSinceAt">;
type TerminalSessionActivity = Pick<ChatTerminalSession, "status" | "runtimeState" | "pid">;

export function isChatSessionAnimating(session: ChatSessionActivity): boolean {
  return session.status === "active" && !session.awaitingInput && !session.idleSinceAt;
}

function isProcessLikelyAlive(pid: number | null | undefined): boolean {
  if (!Number.isInteger(pid) || (pid ?? 0) <= 0) return false;
  try {
    process.kill(pid!, 0);
    return true;
  } catch (error) {
    return typeof error === "object"
      && error !== null
      && "code" in error
      && (error as { code?: unknown }).code === "EPERM";
  }
}

export function isTerminalSessionWorking(session: TerminalSessionActivity): boolean {
  return session.status === "running" && session.runtimeState === "running" && isProcessLikelyAlive(session.pid);
}

export function isTerminalSessionFastPollActive(session: TerminalSessionActivity): boolean {
  return session.status === "running"
    && (session.runtimeState === "running" || session.runtimeState === "waiting-input")
    && isProcessLikelyAlive(session.pid);
}

export function shouldBufferPtyDataForSession(args: {
  sessionId: string;
  activeSessionId: string | null;
  multiView: { tiles: ReadonlyArray<{ sessionId: string }> } | null;
  gridViewActive: boolean;
}): boolean {
  if (args.sessionId === args.activeSessionId) return true;
  return args.gridViewActive
    && Boolean(args.multiView?.tiles.some((tile) => tile.sessionId === args.sessionId));
}

export function gridTabNavigationTarget(args: {
  drawerOpen: boolean;
  rightOpen: boolean;
  tileCount: number;
}): "panes" | "tiles" {
  if (args.drawerOpen || args.rightOpen) return "panes";
  return args.tileCount > 1 ? "tiles" : "panes";
}

function terminalPreviewFrameKey(preview: ChatTerminalPreviewResult | null): string {
  if (!preview) return "null";
  const snapshot = preview.snapshot ?? null;
  const snapshotBody = snapshot
    ? snapshot.serialized || JSON.stringify(snapshot.visibleRows)
    : "";
  return [
    preview.terminalId,
    preview.source,
    preview.session.status,
    preview.session.runtimeState,
    preview.session.title,
    preview.session.resumeCommand ?? "",
    snapshot?.cols ?? "",
    snapshot?.rows ?? "",
    snapshot?.bufferType ?? "",
    snapshot?.baseY ?? "",
    snapshot?.viewportY ?? "",
    snapshot?.cursorX ?? "",
    snapshot?.cursorY ?? "",
    snapshotBody,
    preview.transcript ?? "",
  ].join("\u001f");
}

export function sameTerminalPreviewFrame(
  previous: ChatTerminalPreviewResult | null,
  next: ChatTerminalPreviewResult | null,
): boolean {
  return terminalPreviewFrameKey(previous) === terminalPreviewFrameKey(next);
}

// Scope tag captured when a notice fires. A live chat uses its session id; a
// new-chat draft uses its per-draft key so feedback can't leak across drafts;
// anything else is null (global) and falls back to whatever chat is active.
export function noticeScopeId(args: {
  activeSessionId: string | null;
  draftChatActive: boolean;
  draftScopeKey: string | null;
}): string | null {
  if (args.activeSessionId) return args.activeSessionId;
  if (args.draftChatActive) return args.draftScopeKey;
  return null;
}

// Which notices render for the current view. A new-chat draft shows only the
// notices fired in that exact draft — global/lane feedback and prior drafts'
// notices must not persist into a fresh chat. Every other view keeps the legacy
// "this chat, or global fallback" rule.
export function selectVisibleNotices(args: {
  notices: LocalNotice[];
  hasSelectedAgentSnapshot: boolean;
  draftChatActive: boolean;
  draftScopeKey: string | null;
  activeSessionId: string | null;
}): LocalNotice[] {
  if (args.hasSelectedAgentSnapshot) return [];
  if (args.draftChatActive) {
    return args.notices.filter((notice) => notice.sessionId === args.draftScopeKey);
  }
  return args.notices.filter(
    (notice) => !notice.sessionId || notice.sessionId === args.activeSessionId,
  );
}

const URL_IN_TEXT_RE = /\bhttps?:\/\/[^\s<>"')\]]+/gi;
const MARKDOWN_LINK_IN_TEXT_RE = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/i;

export function firstUrlInText(value: string): { url: string; index: number; width: number } | null {
  const markdownMatch = MARKDOWN_LINK_IN_TEXT_RE.exec(value);
  const markdownCandidate = markdownMatch?.[1] && markdownMatch[2]
    ? {
      url: markdownMatch[2].replace(/[.,;:!?]+$/u, ""),
      index: markdownMatch.index,
      width: markdownMatch[1].length,
    }
    : null;
  URL_IN_TEXT_RE.lastIndex = 0;
  const match = URL_IN_TEXT_RE.exec(value);
  const rawCandidate = match?.[0]
    ? {
      url: match[0].replace(/[.,;:!?]+$/u, ""),
      index: match.index,
      width: match[0].replace(/[.,;:!?]+$/u, "").length,
    }
    : null;
  if (markdownCandidate && rawCandidate) {
    return markdownCandidate.index <= rawCandidate.index ? markdownCandidate : rawCandidate;
  }
  return markdownCandidate ?? rawCandidate;
}

function paletteMatchScore(item: CommandPaletteItem, query: string): number | null {
  const terms = parseWorkSearchQuery(query).terms;
  return scoreWorkSearchTerms(terms, [item.label, item.detail]);
}

// Collapse a multi-line search snippet into a single trimmed detail line and cap
// it so it fits the palette's right-side detail column without wrapping.
function searchSnippetToDetail(snippet: string): string {
  const oneLine = snippet.replace(/\s+/g, " ").trim();
  return oneLine.length > 60 ? `${oneLine.slice(0, 59)}…` : oneLine;
}

// Rebuild the framework-free FeedbackFormState (feedbackForm.ts) from the
// FeedbackContextMeta carried on the feedback form content. Keeps validation +
// serialization (feedbackFormCanSubmit / feedbackFormToFormValues) in lock-step
// with what the right pane renders.
function feedbackStateFromMeta(meta: FeedbackContextMeta): FeedbackFormState {
  const rawType = (meta.type ?? "bug") as FeedbackType;
  const type: FeedbackType = rawType === "bug" || rawType === "idea" || rawType === "praise" ? rawType : "bug";
  return {
    type,
    text: meta.body ?? "",
    showContext: meta.showContext !== false,
    context: {
      provider: meta.provider ?? null,
      model: meta.model ?? null,
      lane: meta.lane ?? null,
      lastError: meta.lastError ?? null,
    },
  };
}

function openExternalUrl(url: string, notice: (message: string, tone?: LocalNotice["tone"]) => void): boolean {
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) return false;
  const bridge = (globalThis as { window?: { ade?: { app?: { openExternal?: (url: string) => unknown } } } }).window;
  const opener = bridge?.ade?.app?.openExternal;
  if (typeof opener === "function") {
    try {
      opener(trimmed);
      notice("Opening link in browser…", "info");
      return true;
    } catch {
      // Fall through to the platform opener.
    }
  }
  const platformOpener = resolvePlatformUrlOpener();
  if (!platformOpener) return false;
  spawn(platformOpener.command, [...platformOpener.args, trimmed], { stdio: "ignore", detached: true }).unref();
  notice("Opening link in browser…", "info");
  return true;
}

// Windows has no `open`/`xdg-open`. Hand the URL to the native protocol handler
// as a single argv value: OAuth and deeplink URLs routinely contain `&` and `%`,
// which `cmd /c start` would split or expand even with shell:false.
function resolvePlatformUrlOpener(): { command: string; args: string[] } | null {
  if (process.platform === "darwin") return { command: "open", args: [] };
  if (process.platform === "win32") {
    return { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler"] };
  }
  if (process.platform === "linux") return { command: "xdg-open", args: [] };
  return null;
}

async function openActivityDeepLink(
  url: string,
  notice: (message: string, tone?: LocalNotice["tone"]) => void,
): Promise<boolean> {
  const trimmed = url.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  if (
    parsed.protocol !== "ade:"
    || (parsed.hostname !== "session" && parsed.hostname !== "pr")
  ) return false;
  const bridge = (globalThis as {
    window?: { ade?: { app?: { openExternal?: (value: string) => unknown } } };
  }).window;
  const opener = bridge?.ade?.app?.openExternal;
  if (typeof opener === "function") {
    try {
      await Promise.resolve(opener(trimmed));
      notice("Opening exact destination in ADE…", "info");
      return true;
    } catch {
      return false;
    }
  }
  const platformOpener = resolvePlatformUrlOpener();
  if (!platformOpener) return false;
  return await new Promise<boolean>((resolve) => {
    const child = spawn(platformOpener.command, [...platformOpener.args, trimmed], {
      stdio: "ignore",
      detached: true,
    });
    child.once("error", () => resolve(false));
    child.once("spawn", () => {
      child.unref();
      notice("Opening exact destination in ADE…", "info");
      resolve(true);
    });
  });
}

export function shouldToggleLatestFailedLineOnBlankEnter(args: {
  pane: PaneFocus;
  prompt: string;
  latestFailedLineId: string | null;
  pendingApproval: PendingApproval | null;
  rightPaneKind: RightPaneContent["kind"];
  slashRowCount: number;
  activeTerminalSession: ChatTerminalSession | null | undefined;
}): boolean {
  return args.pane === "chat"
    && !args.prompt.trim()
    && Boolean(args.latestFailedLineId)
    && !args.pendingApproval
    && args.rightPaneKind !== "form"
    && args.slashRowCount === 0
    && !isTerminalSessionResumable(args.activeTerminalSession);
}

function openChatRightPaneRow(session: AgentChatSessionSummary, activeSessionId: string | null): string {
  // Lifecycle rides as trailing TEXT ("z wakes in 3h", "* needs approval",
  // "done"), never as color: the /chats list has to read the same in a
  // monochrome terminal.
  const lifecycle = session as TuiChatSessionSummary;
  const marker = sessionLifecycleMarker(
    { ...lifecycle, isActive: session.status === "active" },
    { note: lifecycle.statusNote ?? null },
  );
  const suffix = marker ? ` · ${marker.text}` : "";
  return `${session.sessionId === activeSessionId ? "●" : "○"} ${session.title ?? session.sessionId} · ${session.provider}${suffix}`;
}

export function chatSessionToOptimisticSummary(
  session: AgentChatSession,
  title?: string | null,
): AgentChatSessionSummary {
  return {
    sessionId: session.id,
    laneId: session.laneId,
    provider: session.provider,
    model: session.model,
    ...(session.modelId ? { modelId: session.modelId } : {}),
    ...(session.sessionProfile ? { sessionProfile: session.sessionProfile } : {}),
    title: title?.trim() || "New chat",
    ...(session.reasoningEffort ? { reasoningEffort: session.reasoningEffort } : {}),
    ...(session.fastMode !== undefined ? { fastMode: session.fastMode } : {}),
    ...(session.executionMode ? { executionMode: session.executionMode } : {}),
    ...(session.permissionMode ? { permissionMode: session.permissionMode } : {}),
    ...(session.interactionMode ? { interactionMode: session.interactionMode } : {}),
    ...(session.claudePermissionMode ? { claudePermissionMode: session.claudePermissionMode } : {}),
    ...(session.claudeOutputStyle ? { claudeOutputStyle: session.claudeOutputStyle } : {}),
    ...(session.codexApprovalPolicy ? { codexApprovalPolicy: session.codexApprovalPolicy } : {}),
    ...(session.codexSandbox ? { codexSandbox: session.codexSandbox } : {}),
    ...(session.codexConfigSource ? { codexConfigSource: session.codexConfigSource } : {}),
    ...(session.opencodePermissionMode ? { opencodePermissionMode: session.opencodePermissionMode } : {}),
    ...(session.droidPermissionMode ? { droidPermissionMode: session.droidPermissionMode } : {}),
    ...(session.cursorModeSnapshot ? { cursorModeSnapshot: session.cursorModeSnapshot } : {}),
    ...(session.cursorModeId !== undefined ? { cursorModeId: session.cursorModeId } : {}),
    ...(session.cursorConfigValues ? { cursorConfigValues: session.cursorConfigValues } : {}),
    ...(session.cursorCloudAgentId ? { cursorCloudAgentId: session.cursorCloudAgentId } : {}),
    ...(session.cursorRuntime ? { cursorRuntime: session.cursorRuntime } : {}),
    ...(session.cursorPromotedTurnId ? { cursorPromotedTurnId: session.cursorPromotedTurnId } : {}),
    ...(session.runtimeRef ? { runtimeRef: session.runtimeRef } : {}),
    ...(session.runtimeLabel ? { runtimeLabel: session.runtimeLabel } : {}),
    ...(session.identityKey ? { identityKey: session.identityKey } : {}),
    ...(session.surface ? { surface: session.surface } : {}),
    ...(session.automationId ? { automationId: session.automationId } : {}),
    ...(session.automationRunId ? { automationRunId: session.automationRunId } : {}),
    ...(session.capabilityMode ? { capabilityMode: session.capabilityMode } : {}),
    ...(session.completion ? { completion: session.completion } : {}),
    ...(session.codexGoal ? { codexGoal: session.codexGoal } : {}),
    ...(session.claudeGoal ? { claudeGoal: session.claudeGoal } : {}),
    ...(session.codexTokenUsage ? { codexTokenUsage: session.codexTokenUsage } : {}),
    status: session.status,
    ...(session.idleSinceAt !== undefined ? { idleSinceAt: session.idleSinceAt } : {}),
    startedAt: session.createdAt,
    endedAt: null,
    ...(session.archivedAt ? { archivedAt: session.archivedAt } : {}),
    lastActivityAt: session.lastActivityAt,
    lastOutputPreview: null,
    summary: null,
    nextWakeAt: null,
    ...(session.threadId ? { threadId: session.threadId } : {}),
    ...(session.requestedCwd !== undefined ? { requestedCwd: session.requestedCwd } : {}),
    ...(session.orchestrationRunId ? { orchestrationRunId: session.orchestrationRunId } : {}),
    ...(session.orchestrationRole ? { orchestrationRole: session.orchestrationRole } : {}),
    ...(session.orchestrationParentSessionId ? { orchestrationParentSessionId: session.orchestrationParentSessionId } : {}),
    ...(session.spawnKind ? { spawnKind: session.spawnKind } : {}),
    ...(session.orchestrationTag ? { orchestrationTag: session.orchestrationTag } : {}),
    ...(session.orchestrationStepId ? { orchestrationStepId: session.orchestrationStepId } : {}),
    ...(session.orchestrationBundlePath ? { orchestrationBundlePath: session.orchestrationBundlePath } : {}),
  };
}

export function mergeOptimisticChatSessions(
  sessions: AgentChatSessionSummary[],
  optimisticSessions: Map<string, AgentChatSessionSummary>,
): AgentChatSessionSummary[] {
  if (optimisticSessions.size === 0) return sessions;
  const seen = new Set(sessions.map((session) => session.sessionId));
  for (const sessionId of seen) {
    optimisticSessions.delete(sessionId);
  }
  const pending = [...optimisticSessions.values()]
    .sort((left, right) => {
      const rightMs = Date.parse(right.lastActivityAt ?? right.startedAt);
      const leftMs = Date.parse(left.lastActivityAt ?? left.startedAt);
      return (Number.isFinite(rightMs) ? rightMs : 0) - (Number.isFinite(leftMs) ? leftMs : 0);
    });
  return pending.length ? [...pending, ...sessions] : sessions;
}

// Terminal-session analogue of mergeOptimisticChatSessions. A freshly-created
// Claude CLI terminal (or a just-resumed one) is not always returned by the very
// next `terminal.list` poll, so without this its session id is absent from the
// merged session list when `resolveTuiChatRefreshTarget` runs — and the resolver
// falls back to the newest existing chat, yanking focus onto a different session.
// Keyed by terminalId; self-cleans an entry once the real list reports it.
export function mergeOptimisticTerminalSessions(
  sessions: ChatTerminalSession[],
  optimistic: Map<string, ChatTerminalSession>,
): ChatTerminalSession[] {
  if (optimistic.size === 0) return sessions;
  for (const session of sessions) optimistic.delete(session.terminalId);
  const pending = [...optimistic.values()];
  return pending.length ? [...pending, ...sessions] : sessions;
}

const DESKTOP_COMMAND_ROUTES: Record<string, string> = {
  "/app-control": "/app-control",
  "/browser": "/browser",
  "/computer": "/proof",
  "/computer-use": "/proof",
  "/ios": "/ios-sim",
  "/ios-sim": "/ios-sim",
  "/pencil": "/pencil",
  "/proof": "/proof",
};

type AdeCodeAppProps = {
  project: ProjectLaunchContext;
  forceEmbedded?: boolean;
  requireSocket?: boolean;
  socketPath?: string | null;
  preferServiceRepair?: boolean;
  remote?: boolean;
};

type RefreshStateOptions = {
  hydrateHistory?: boolean;
  includeLaneStatus?: boolean;
};

export const LANE_STATUS_REFRESH_MS = 30_000;

export function shouldHydrateRefreshHistory(args: {
  hydrateHistory?: boolean;
  currentSessionId: string | null;
  loadedSessionId: string | null;
  nextSessionId: string;
}): boolean {
  return args.hydrateHistory !== false
    || args.currentSessionId !== args.nextSessionId
    || args.loadedSessionId !== args.nextSessionId;
}

function claudeModelCommandKey(state: AdeCodeModelState, terminalId: string | null | undefined): string {
  return JSON.stringify([
    terminalId ?? null,
    state.modelId ?? null,
    state.model,
    state.reasoningEffort?.trim() || null,
  ]);
}

function modelCatalogClientRefreshTtlMs(provider?: AgentChatModelCatalogRefreshProvider): number {
  return provider === "lmstudio" || provider === "ollama"
    ? MODEL_CATALOG_LOCAL_CLIENT_REFRESH_TTL_MS
    : MODEL_CATALOG_CLIENT_REFRESH_TTL_MS;
}

function noticeId(): string {
  return `${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function routeRowLabel(entry: unknown): string {
  const record = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
  const trimmedString = (key: string): string | null => {
    const value = record[key];
    return typeof value === "string" && value.trim() ? value.trim() : null;
  };
  const shortSha = trimmedString("shortSha");
  const subject = trimmedString("subject");
  if (shortSha && subject) return `${shortSha} · ${subject}`;
  const identifier = trimmedString("identifier");
  const title = trimmedString("title");
  if (identifier && title) return `${identifier} · ${title}`;
  const label =
    title
    ?? trimmedString("name")
    ?? trimmedString("branchRef")
    ?? trimmedString("id")
    ?? shortSha;
  return String(label ?? JSON.stringify(entry)).slice(0, 90);
}

function routeRows(value: unknown): string[] {
  if (Array.isArray(value)) return value.slice(0, 16).map((entry) => routeRowLabel(entry).slice(0, 90));
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const list = Object.values(record).find(Array.isArray);
  return Array.isArray(list) ? routeRows(list) : renderObject(value, 12).split(/\r?\n/);
}

function compactNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function formatTokenSummary(stats: ReturnType<typeof latestTokenStats>): string | null {
  if (stats.contextState === "compacting") return "compacting context…";
  if (stats.contextState === "recalculating") return "recalculating context…";
  if (stats.contextState === "unknown") return "context usage unavailable";
  // Compact last-turn breakdown: `+2.3k/1.1k (450✶)` — input / output (cached marker).
  const parts: string[] = [];
  if (stats.inputTokens != null || stats.outputTokens != null) {
    const left = stats.inputTokens != null ? `+${compactNumber(stats.inputTokens)}` : "+0";
    const right = stats.outputTokens != null ? compactNumber(stats.outputTokens) : "0";
    parts.push(`${left}/${right}`);
  }
  const cacheParts: string[] = [];
  if (stats.cacheReadTokens != null && stats.cacheReadTokens > 0) {
    cacheParts.push(`${compactNumber(stats.cacheReadTokens)}✶`);
  }
  if (stats.cacheCreationTokens != null && stats.cacheCreationTokens > 0) {
    cacheParts.push(`${compactNumber(stats.cacheCreationTokens)}✎`);
  }
  if (cacheParts.length) parts.push(`(${cacheParts.join(" ")})`);
  if (stats.costUsd != null) parts.push(`$${stats.costUsd.toFixed(2)}`);
  return parts.length ? parts.join(" ") : null;
}

function chatInterruptNotice(result: Awaited<ReturnType<typeof interruptChat>>): string {
  if (result.mode === "stop_only") {
    return "Stopped. Queued messages are preserved.";
  }
  if (result.cancelledQueuedCount > 0 && result.recoveryId) {
    const noun = result.cancelledQueuedCount === 1 ? "message" : "messages";
    return `Stopped and cleared ${result.cancelledQueuedCount} queued ${noun}. Undo: /restore-queue ${result.recoveryId}`;
  }
  return "Stopped.";
}

export function formatGoalBannerLine(goal: CodexThreadGoal | ClaudeActiveGoal | null): string | null {
  if (goal && "condition" in goal) {
    const condition = goal.condition.trim();
    if (!condition) return null;
    return `◎ goal: ${condition}${goal.iterations > 0 ? ` · iter ${goal.iterations}` : ""}`;
  }
  if (!goal?.objective) return null;
  const objective = goal.objective.trim();
  if (!objective) return null;
  const right: string[] = [];
  const used = goal.tokensUsed ?? null;
  if (used != null) {
    right.push(`${compactNumber(used)} tokens`);
  }
  if (typeof goal.timeUsedSeconds === "number" && goal.timeUsedSeconds > 0) {
    const seconds = Math.round(goal.timeUsedSeconds);
    const mins = Math.floor(seconds / 60);
    right.push(mins > 0 ? `${mins}m ${seconds % 60}s` : `${seconds}s`);
  }
  const visibleStatus = goal.status === "budget_limited" ? "active" : goal.status;
  if (visibleStatus) right.push(visibleStatus.replace(/_/g, " "));
  return right.length ? `◎ ${objective}   ${right.join(" · ")}` : `◎ ${objective}`;
}

import { subagentActivitySummaryFromEvents, subagentSnapshotsFromEvents } from "../../../desktop/src/shared/chatSubagents";
export { subagentSnapshotsFromEvents };

const LANE_WORKTREE_AVAILABILITY_CACHE_TTL_MS = 2_000;
const laneWorktreeAvailabilityCache = new Map<string, { checkedAt: number; mtimeMs: number; available: boolean }>();

function cacheLaneWorktreeAvailability(root: string, stat: fs.Stats, checkedAt: number, available: boolean): boolean {
  laneWorktreeAvailabilityCache.set(root, { checkedAt, mtimeMs: stat.mtimeMs, available });
  return available;
}

function normalizeWorktreePath(root: string): string {
  const resolved = path.resolve(root);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

export function isLaneWorktreeAvailable(
  lane: LaneSummary | null | undefined,
  options: { remote?: boolean } = {},
): boolean {
  const root = lane?.worktreePath?.trim();
  if (!root) return false;
  if (typeof lane?.worktreeAvailable === "boolean") {
    return lane.worktreeAvailable;
  }
  if (options.remote) return true;
  const resolvedRoot = normalizeWorktreePath(root);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolvedRoot);
    if (!stat.isDirectory()) return false;
  } catch {
    return false;
  }
  const cached = laneWorktreeAvailabilityCache.get(resolvedRoot);
  const now = Date.now();
  if (cached && cached.mtimeMs === stat.mtimeMs && now - cached.checkedAt < LANE_WORKTREE_AVAILABILITY_CACHE_TTL_MS) {
    return cached.available;
  }
  const markerExists = fs.existsSync(path.join(resolvedRoot, ".git"));
  if (!markerExists) {
    return cacheLaneWorktreeAvailability(resolvedRoot, stat, now, false);
  }
  const probe = spawnSync("git", ["rev-parse", "--path-format=absolute", "--show-toplevel"], {
    cwd: resolvedRoot,
    encoding: "utf8",
    timeout: 8_000,
  });
  let available: boolean;
  if (probe.status === 0) {
    const topLevel = probe.stdout.trim();
    available = topLevel ? normalizeWorktreePath(topLevel) === resolvedRoot : true;
  } else {
    available = false;
  }
  return cacheLaneWorktreeAvailability(resolvedRoot, stat, now, available);
}

function laneWorktreeUnavailableMessage(lane: LaneSummary | null | undefined): string | null {
  if (!lane) return "No active lane is available.";
  if (isLaneWorktreeAvailable(lane)) return null;
  const pathLabel = lane.worktreePath?.trim() || "unknown path";
  return `Lane "${lane.name}" is missing its worktree at ${pathLabel}. Restore or recreate the lane before starting a chat.`;
}

function collectDescendantLaneIds(rootId: string, lanes: LaneSummary[]): Set<string> {
  const childrenByParent = new Map<string, LaneSummary[]>();
  for (const lane of lanes) {
    if (!lane.parentLaneId) continue;
    const children = childrenByParent.get(lane.parentLaneId) ?? [];
    children.push(lane);
    childrenByParent.set(lane.parentLaneId, children);
  }
  const descendants = new Set<string>();
  const stack = [...(childrenByParent.get(rootId) ?? [])];
  while (stack.length) {
    const lane = stack.pop();
    if (!lane || descendants.has(lane.id)) continue;
    descendants.add(lane.id);
    stack.push(...(childrenByParent.get(lane.id) ?? []));
  }
  return descendants;
}

function reparentTargetsForLane(lane: LaneSummary, lanes: LaneSummary[]): LaneSummary[] {
  const descendants = collectDescendantLaneIds(lane.id, lanes);
  return lanes
    .filter((candidate) => !candidate.archivedAt && candidate.id !== lane.id && !descendants.has(candidate.id))
    .sort((left, right) => {
      const leftPrimary = left.laneType === "primary" ? 0 : 1;
      const rightPrimary = right.laneType === "primary" ? 0 : 1;
      if (leftPrimary !== rightPrimary) return leftPrimary - rightPrimary;
      return left.name.localeCompare(right.name);
    });
}

function prBranchNameFromRef(ref: string | null | undefined): string {
  let value = (ref ?? "").trim();
  value = value.replace(/^refs\/heads\//, "");
  value = value.replace(/^refs\/remotes\//, "");
  value = value.replace(/^origin\//, "");
  return value;
}

export function defaultPrTitleForLane(sourceLane: LaneSummary | null | undefined, lanes: LaneSummary[]): string {
  const sourceName = sourceLane?.name?.trim() || "Source lane";
  const parentLane = sourceLane?.parentLaneId
    ? lanes.find((lane) => lane.id === sourceLane.parentLaneId) ?? null
    : null;
  const targetBranch = resolveStableLaneBaseBranch({
    lane: sourceLane,
    parent: parentLane,
    primaryBranchRef: "main",
  });
  const targetLane = targetBranch
    ? lanes.find((lane) => lane.id !== sourceLane?.id && prBranchNameFromRef(lane.branchRef) === targetBranch)
    : null;
  const targetName = targetLane?.name?.trim() || targetBranch || "target";
  return `${sourceName} -> ${targetName}`;
}

/**
 * Seed title for the `/pr open` form, mirroring the desktop inline PR creator.
 *
 * The chat's own title describes the work; the lane -> target derivation never
 * reads as a shippable PR title, so it is only the fallback. "New chat" is the
 * placeholder a session carries until its background rename lands, so it never
 * wins.
 */
export function defaultPrTitleForChat(args: {
  sessionTitle?: string | null;
  sourceLane: LaneSummary | null | undefined;
  lanes: LaneSummary[];
}): string {
  const trimmed = args.sessionTitle?.trim() ?? "";
  if (trimmed && trimmed !== "New chat") return trimmed;
  return defaultPrTitleForLane(args.sourceLane, args.lanes);
}

function resolveLaneReference(lanes: LaneSummary[], reference: string): LaneSummary | null {
  const normalized = reference.trim().toLowerCase();
  if (!normalized) return null;
  const exact = lanes.find((lane) => (
    lane.id.toLowerCase() === normalized || lane.name.toLowerCase() === normalized
  ));
  if (exact) return exact;
  // Only accept partial-name matches when they resolve uniquely. The previous
  // implementation picked the first `includes()` hit, which could silently
  // pick the wrong lane (and target the wrong rebase) for `/reparent`.
  const partialMatches = lanes.filter((lane) => lane.name.toLowerCase().includes(normalized));
  return partialMatches.length === 1 ? partialMatches[0] ?? null : null;
}

function seedLaneDetails(
  lane: LaneSummary,
  worktreeAvailable = isLaneWorktreeAvailable(lane),
  chats: Extract<RightPaneContent, { kind: "lane-details" }>["chats"] = {
    active: 0,
    needsYou: 0,
    settled: 0,
    closed: 0,
    failed: 0,
  },
): Extract<RightPaneContent, { kind: "lane-details" }> {
  return {
    kind: "lane-details",
    lane,
    git: { staged: 0, unstaged: 0, total: 0, ahead: 0, behind: 0, remote: null, additions: 0, deletions: 0 },
    files: [],
    pr: null,
    chats,
    showFiles: false,
    selectedActionIndex: 0,
    worktreeAvailable,
  };
}

function normalizeLaneLinearIssue(value: unknown): LaneLinearIssue | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.identifier !== "string" || typeof record.title !== "string") {
    return null;
  }
  return record as LaneLinearIssue;
}

function exactLinearIssueSearchMatch(input: string, result: unknown): LaneLinearIssue | null {
  const normalized = input.trim().toLowerCase();
  const candidates = Array.isArray(result)
    ? result
    : result && typeof result === "object" && Array.isArray((result as { issues?: unknown[] }).issues)
      ? (result as { issues: unknown[] }).issues
      : [];
  const issues = candidates
    .map(normalizeLaneLinearIssue)
    .filter((issue): issue is LaneLinearIssue => issue !== null);
  return issues.find((issue) => (
    issue.id.toLowerCase() === normalized
    || issue.identifier.toLowerCase() === normalized
  )) ?? null;
}

async function resolveLinearIssueForNewLane(
  conn: AdeCodeConnection,
  input: string,
): Promise<LaneLinearIssue | null> {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const result = await conn.action("cto", "searchLinearIssues", { query: trimmed, first: 5 });
  return exactLinearIssueSearchMatch(trimmed, result);
}

function authErrorTextFromEvent(event: AgentChatEventEnvelope["event"]): string | null {
  const record = event as Record<string, unknown>;
  if (event.type === "error") {
    return typeof record.message === "string"
      ? record.message
      : typeof record.error === "string"
        ? record.error
        : null;
  }
  if (event.type === "system_notice" || event.type === "status") {
    return typeof record.message === "string" ? record.message : null;
  }
  return null;
}

export function latestAuthFailedPrompt(events: readonly AgentChatEventEnvelope[]): string | null {
  let lastUserIndex = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.event.type === "user_message") {
      lastUserIndex = index;
      break;
    }
  }
  if (lastUserIndex < 0) return null;
  const userEvent = events[lastUserIndex]!.event as Extract<AgentChatEventEnvelope["event"], { type: "user_message" }>;
  const prompt = (userEvent.displayText ?? userEvent.text ?? "").trim();
  if (!prompt) return null;
  const tail = events.slice(lastUserIndex + 1);
  const authFailure = tail.some((envelope) => {
    const text = authErrorTextFromEvent(envelope.event);
    if (!text) return false;
    return /\b(auth|authentication|login|log in|api key|unauthorized|401|not authenticated|expired|invalid key)\b/i.test(text);
  });
  return authFailure ? prompt : null;
}

function deriveDrawerPreviewChatInfo(
  session: AgentChatSessionSummary,
  previewEvents: AgentChatEventEnvelope[],
  lane: { name: string; icon?: string | null; color?: string | null } | null,
): Extract<RightPaneContent, { kind: "chat-info" }>["info"] {
  const snapshots = subagentSnapshotsFromEvents(previewEvents);
  const fallbackContext = session.modelId ? getModelById(session.modelId)?.contextWindow ?? null : null;
  const stats = latestTokenStats(previewEvents, fallbackContext);
  return deriveChatInfoSnapshot({
    events: previewEvents,
    activeSession: session,
    provider: normalizeProvider(session.provider),
    modelLabel: session.model ?? normalizeProvider(session.provider),
    laneLabel: lane?.name ?? null,
    laneIcon: lane?.icon ?? null,
    laneColor: lane?.color ?? null,
    snapshots,
    tokenStats: stats,
    goal: latestGoal(previewEvents),
    streaming: session.status === "active",
    inspectedSubagentId: null,
  });
}

type DrawerNavTarget =
  | { kind: "lane"; lane: LaneSummary }
  | { kind: "chat"; info: Extract<RightPaneContent, { kind: "chat-info" }>["info"] }
  | { kind: "new-chat"; laneId: string; laneLabel: string; rows: SetupPaneRow[] };

type ContextDefaultArgs = {
  draftChatActive: boolean;
  activeSession: AgentChatSessionSummary | null;
  activeLane: LaneSummary | null;
  liveAgentCount: number;
  /**
   * The lane the sessions pane is pointing at, or null when it is pointing at a
   * chat. Already gated by the caller, so this is the whole lane-details rule.
   */
  highlightedDrawerLane: LaneSummary | null;
  drawerNav: DrawerNavTarget | null;
  chatInfo: Extract<RightPaneContent, { kind: "chat-info" }>["info"];
  subagentSnapshots: SubagentSnapshot[];
  provider: AdeCodeProvider;
  newChatSetup: { laneId: string; laneLabel: string; rows: SetupPaneRow[] } | null;
  unavailableLaneIds: ReadonlySet<string>;
};

export function resolveContextDefault(args: ContextDefaultArgs): RightPaneContent {
  const nav = args.drawerNav;
  if (nav) {
    switch (nav.kind) {
      case "lane":
        return seedLaneDetails(nav.lane, !args.unavailableLaneIds.has(nav.lane.id));
      case "new-chat":
        // Starting a new chat NEVER auto-opens a model pane: the model that will
        // be used is shown as a compact line under the composer, and /model
        // opens the wizard on demand.
        return { kind: "empty" };
      case "chat":
        return { kind: "chat-info", info: nav.info };
    }
  }
  if (
    args.draftChatActive
    && args.newChatSetup
    && !args.unavailableLaneIds.has(args.newChatSetup.laneId)
  ) {
    // Same rule as the pane's new-chat row: the draft surface stays clear.
    return { kind: "empty" };
  }
  if (args.highlightedDrawerLane) {
    return seedLaneDetails(args.highlightedDrawerLane, !args.unavailableLaneIds.has(args.highlightedDrawerLane.id));
  }
  if (args.activeSession) {
    return {
      kind: "chat-info",
      info: args.chatInfo,
    };
  }
  if (args.activeLane) {
    return seedLaneDetails(args.activeLane, !args.unavailableLaneIds.has(args.activeLane.id));
  }
  return { kind: "empty" };
}

/**
 * Setup surfaces shown while a draft "new chat" is being configured (today the
 * model-picker opened on the "new-chat" surface — both the new-chat form rows
 * and the model picker live on that one pane kind). The first-send draft
 * commit replaces exactly these with the live chat-info pane; anything else on
 * the right pane was deliberately opened by the user and is never hijacked.
 */
export function isNewChatSetupPane(pane: RightPaneContent): boolean {
  return (pane.kind === "model-picker" || pane.kind === "model-wizard") && pane.surface === "new-chat";
}

function formatOutputStyles(styles: Awaited<ReturnType<typeof listClaudeOutputStyles>>, activeStyle?: string | null): string {
  if (!styles.length) return "No Claude output styles were found.";
  // A session carries no output style until a settings file names one — ADE no
  // longer substitutes a value into the SDK options. For the *listing* only, an
  // unset selection still reads as Claude's own "Default", which is what the
  // desktop's `/output-style` handler shows. Display, never written back.
  const activeKey = (activeStyle?.trim() || "Default").toLowerCase();
  return [
    "Claude output styles:",
    "",
    ...styles.map((style) => {
      const marker = style.name.trim().toLowerCase() === activeKey ? "*" : "-";
      const description = style.description ? ` - ${style.description}` : "";
      return `${marker} ${style.name} (${style.source})${description}`;
    }),
  ].join("\n");
}

function formatClaudePlugins(plugins: AgentChatClaudePlugin[]): string {
  if (!plugins.length) return "No local Claude plugins were discovered for this chat.";
  return [
    "Claude plugins:",
    "",
    ...plugins.map((plugin) => {
      const suffix = [plugin.version, plugin.description].filter(Boolean).join(" - ");
      return `- ${plugin.name}${suffix ? ` (${suffix})` : ""}\n  ${plugin.path}`;
    }),
  ].join("\n");
}

function formatPluginReload(result: AgentChatReloadClaudePluginsResult): string {
  return [
    `Reloaded ${result.plugins.length} plugin${result.plugins.length === 1 ? "" : "s"} with ${result.errorCount} error${result.errorCount === 1 ? "" : "s"}.`,
    result.commands.length ? `${result.commands.length} command${result.commands.length === 1 ? "" : "s"}` : null,
    result.agents.length ? `${result.agents.length} agent${result.agents.length === 1 ? "" : "s"}` : null,
    "",
    ...result.plugins.map((plugin) => `- ${plugin.name}\n  ${plugin.path}`),
  ].filter((line): line is string => line != null).join("\n");
}

function titleFromMarkdown(filePath: string, fallback: string): string {
  try {
    const text = fs.readFileSync(filePath, "utf8");
    const heading = text.split(/\r?\n/).find((line) => line.startsWith("# "));
    return heading?.replace(/^#\s+/, "").trim() || fallback;
  } catch {
    return fallback;
  }
}

function listAgentMarkdownEntries(workspaceRoot: string, kind: "agents" | "skills"): string {
  const roots = kind === "agents"
    ? [
        { label: "project", dir: path.join(workspaceRoot, ".claude", "agents") },
        { label: "user", dir: claudeHomePath("agents") },
      ]
    : getAgentSkillRootCandidates({ cwd: workspaceRoot, includeDeepSourceFallbacks: true })
        .map((dir) => ({ label: "skill root", dir }));
  const rows: string[] = [];
  for (const root of roots) {
    if (!fs.existsSync(root.dir)) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const filePath = entry.isDirectory()
        ? path.join(root.dir, entry.name, "SKILL.md")
        : path.join(root.dir, entry.name);
      if (!filePath.endsWith(".md") || !fs.existsSync(filePath)) continue;
      const name = entry.isDirectory() ? entry.name : entry.name.replace(/\.md$/i, "");
      const title = titleFromMarkdown(filePath, name);
      rows.push(`- ${title} (${root.label})\n  ${filePath}`);
    }
  }
  if (!rows.length) {
    return kind === "skills"
      ? "No agent skills were found in project, user, or bundled ADE skill roots."
      : "No Claude agents were found in project or user config.";
  }
  return [kind === "skills" ? "Agent skills:" : "Claude agents:", "", ...rows].join("\n");
}

function ensureClaudeInitFiles(workspaceRoot: string): string {
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const agentsPath = path.join(workspaceRoot, "AGENTS.md");
  const claudePath = path.join(workspaceRoot, "CLAUDE.md");
  const rows: string[] = [];
  if (!fs.existsSync(agentsPath)) {
    fs.writeFileSync(
      agentsPath,
      [
        "# Project instructions",
        "",
        "Add coding-agent instructions for this project here. ADE, Claude Code, and other agent runtimes can use this file as the canonical project guide.",
        "",
      ].join("\n"),
      "utf8",
    );
    rows.push(`created ${agentsPath}`);
  } else {
    rows.push(`kept existing ${agentsPath}`);
  }
  if (!fs.existsSync(claudePath)) {
    fs.writeFileSync(claudePath, "@include AGENTS.md\n", "utf8");
    rows.push(`created ${claudePath}`);
  } else {
    rows.push(`kept existing ${claudePath}`);
  }
  return ["Initialized Claude-compatible project files:", "", ...rows].join("\n");
}

function readClaudeVimMode(workspaceRoot: string): boolean {
  const candidates = [
    claudeHomePath("settings.json"),
    path.join(workspaceRoot, ".claude", "settings.json"),
    path.join(workspaceRoot, ".claude", "settings.local.json"),
  ];
  let enabled = false;
  for (const filePath of candidates) {
    if (!fs.existsSync(filePath)) continue;
    try {
      const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const vimMode = (value as { vimMode?: unknown }).vimMode;
      if (typeof vimMode === "boolean") enabled = vimMode;
    } catch {
      // Invalid Claude settings are reported by /doctor; keep input usable.
    }
  }
  return enabled;
}

function commandAvailable(command: string): boolean {
  const result = spawnSync(process.platform === "win32" ? "where" : "command", process.platform === "win32" ? [command] : ["-v", command], {
    shell: process.platform !== "win32",
    stdio: "ignore",
  });
  return result.status === 0;
}

function readClipboardText(): string | null {
  const candidates = process.platform === "darwin"
    ? [["pbpaste"]]
    : process.platform === "win32"
      ? [[resolveTrustedWindowsTool("powershell"), "-NoProfile", "-Command", "Get-Clipboard"]]
      : [["wl-paste", "--no-newline"], ["xclip", "-selection", "clipboard", "-o"]];
  for (const [command, ...args] of candidates) {
    if (process.platform !== "win32" && !commandAvailable(command)) continue;
    const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 1024 * 1024 });
    if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  }
  return null;
}

function writeClipboardText(text: string): boolean {
  const candidates = process.platform === "darwin"
    ? [["pbcopy"]]
    : process.platform === "win32"
      ? [["clip"]]
      : [["wl-copy"], ["xclip", "-selection", "clipboard"]];
  for (const [command, ...args] of candidates) {
    if (!commandAvailable(command)) continue;
    const result = spawnSync(command, args, {
      input: text,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    if (result.status === 0) return true;
  }
  return false;
}

function editPromptInExternalEditor(initialText: string): string | null {
  // `vi` does not exist on Windows; notepad is the only editor guaranteed present.
  const editor = process.env.VISUAL || process.env.EDITOR
    || (process.platform === "win32" ? "notepad" : "vi");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-code-prompt-"));
  const filePath = path.join(dir, "prompt.md");
  try {
    fs.writeFileSync(filePath, initialText, "utf8");
    // shell:true does not quote argv on Windows, and tmpdir() sits under
    // C:\Users\<name>\... which may contain a space. Quote the path ourselves.
    const editorArg = process.platform === "win32" ? `"${filePath}"` : filePath;
    const result = spawnSync(editor, [editorArg], {
      stdio: "inherit",
      shell: true,
      env: process.env,
    });
    if (result.error || (typeof result.status === "number" && result.status !== 0)) {
      return null;
    }
    return fs.readFileSync(filePath, "utf8").replace(/\r?\n$/, "");
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort temp cleanup.
    }
  }
}

function formatClaudeStatusLineConfig(workspaceRoot: string): string {
  return readClaudeStatusLineConfig(workspaceRoot).diagnostics;
}

function formatDoctorReport(args: {
  workspaceRoot: string;
  activeProvider?: string | null;
  pluginCount: number | null;
}): string {
  const keybindings = readClaudeKeybindingsFile({ create: false });
  const statusLine = formatClaudeStatusLineConfig(args.workspaceRoot);
  return [
    "ADE Code doctor:",
    "",
    `provider: ${args.activeProvider ?? "none"}`,
    `keybindings: ${keybindings.warnings.length ? `${keybindings.warnings.length} warning${keybindings.warnings.length === 1 ? "" : "s"}` : "ok"}`,
    args.pluginCount == null ? "plugins: not checked" : `plugins: ${args.pluginCount}`,
    "",
    statusLine,
  ].join("\n");
}

type ConnectionStatusProvider = Extract<AdeCodeProvider, "claude" | "codex" | "cursor" | "droid">;

function providerConnectionDetail(status: AiSettingsStatus | null, provider: ConnectionStatusProvider): ProviderReadinessRow {
  const connection = status?.providerConnections?.[provider];
  const modelCount = status?.models?.[provider]?.length ?? 0;
  if (connection?.runtimeAvailable) {
    return {
      provider,
      label: providerLabel(provider),
      status: "ready",
      detail: connection.path ? `ready at ${connection.path}` : "runtime and auth ready",
      modelCount,
    };
  }
  if (connection?.runtimeDetected || connection?.authAvailable) {
    return {
      provider,
      label: providerLabel(provider),
      status: "unknown",
      detail: connection.blocker ?? "detected but not fully ready",
      modelCount,
    };
  }
  return {
    provider,
    label: providerLabel(provider),
    status: "unavailable",
    detail: connection?.blocker ?? "not detected",
    modelCount,
  };
}

/**
 * `opencodeBinarySource` is a wire enum, not copy. It gained `tools-cache` when
 * the platform binaries moved out of the app bundle into the shared machine
 * tools cache, and that value reads as jargon in a readiness row. The others
 * are already close enough to English to pass through unchanged.
 */
const OPENCODE_SOURCE_LABELS: Record<string, string> = { "tools-cache": "ADE-managed" };

function buildProviderReadinessRows(
  status: AiSettingsStatus | null,
  storedApiKeyProviders: string[],
  openCodeDiagnostics: OpenCodeRuntimeSnapshot | null,
): ProviderReadinessRow[] {
  const rows: ProviderReadinessRow[] = [
    providerConnectionDetail(status, "codex"),
    providerConnectionDetail(status, "claude"),
    providerConnectionDetail(status, "cursor"),
    providerConnectionDetail(status, "droid"),
  ];
  const opencodeProviders = status?.opencodeProviders ?? [];
  const opencodeModelCount = opencodeProviders.reduce((sum, provider) => sum + provider.modelCount, 0);
  rows.push({
    provider: "opencode",
    label: "OpenCode",
    status: status?.opencodeBinaryInstalled ? "ready" : "unavailable",
    detail: status?.opencodeInventoryError
      ?? (status?.opencodeBinaryInstalled
        ? `${status.opencodeBinarySource ? OPENCODE_SOURCE_LABELS[status.opencodeBinarySource] ?? status.opencodeBinarySource : "installed"} · ${openCodeDiagnostics?.sharedCount ?? 0} shared runtime`
        : "binary missing"),
    modelCount: opencodeModelCount,
  });
  if (storedApiKeyProviders.includes("cursor")) {
    const cursor = rows.find((row) => row.provider === "cursor");
    if (cursor && cursor.status !== "ready") {
      cursor.detail = `${cursor.detail} · Cursor key stored`;
    }
  }
  return rows;
}

function desktopRouteForCommand(commandName: string | null | undefined): string | null {
  if (!commandName) return null;
  return DESKTOP_COMMAND_ROUTES[commandName] ?? null;
}

function splitFirstArg(input: string): { first: string; rest: string } {
  const trimmed = input.trim();
  const match = trimmed.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  return {
    first: match?.[1] ?? "",
    rest: match?.[2]?.trim() ?? "",
  };
}

const TURN_RECOVERY_ACTION_ALIASES: Readonly<Record<string, AgentChatTurnRecoveryAction>> = {
  wait: "wait",
  nudge: "nudge",
  steer: "nudge",
  retry: "retry_same_runtime",
  retry_same_runtime: "retry_same_runtime",
  interrupt_retry_same_thread: "retry_same_runtime",
  resume: "restart_resume",
  restart_resume: "restart_resume",
  restart_resume_thread: "restart_resume",
};

export function resolveTuiRecoveryRequest(args: {
  input: string;
  sessionId: string;
  events: readonly AgentChatEventEnvelope[];
}): {
  action: AgentChatTurnRecoveryAction;
  turnId: string;
  sessionId: string;
  provider: string | null;
} | null {
  const parsed = splitFirstArg(args.input);
  const action = TURN_RECOVERY_ACTION_ALIASES[parsed.first.trim().toLowerCase().replace(/-/g, "_")];
  if (!action) return null;
  const explicitTurnId = splitFirstArg(parsed.rest).first;
  if (explicitTurnId) {
    const matchingEnvelope = [...args.events].reverse().find((envelope) =>
      (envelope.event.type === "turn_health" || envelope.event.type === "codex_turn_stalled")
      && envelope.event.turnId === explicitTurnId
    );
    const sourceSessionId = matchingEnvelope
      && (
        matchingEnvelope.event.type === "turn_health"
        || matchingEnvelope.event.type === "codex_turn_stalled"
      )
      ? matchingEnvelope.event.sourceSessionId?.trim()
      : "";
    const targetSessionId = sourceSessionId
      || matchingEnvelope?.sessionId
      || args.sessionId;
    const provider = matchingEnvelope?.event.type === "turn_health"
      ? matchingEnvelope.event.provider
      : matchingEnvelope?.event.type === "codex_turn_stalled"
        ? "codex"
        : null;
    return {
      action,
      turnId: explicitTurnId,
      sessionId: targetSessionId,
      provider,
    };
  }
  for (let index = args.events.length - 1; index >= 0; index -= 1) {
    const envelope = args.events[index];
    if (
      envelope?.event.type !== "turn_health"
      && envelope?.event.type !== "codex_turn_stalled"
    ) continue;
    return {
      action,
      turnId: envelope.event.turnId,
      sessionId: envelope.event.type === "codex_turn_stalled"
        ? envelope.event.sourceSessionId?.trim() || envelope.sessionId
        : envelope.event.sourceSessionId?.trim() || envelope.sessionId,
      provider: envelope.event.type === "turn_health"
        ? envelope.event.provider
        : "codex",
    };
  }
  return null;
}

export function resolveTuiUnprocessedMessageRequest(args: {
  input: string;
  sessionId: string | null;
}): { steerId: string; sessionId: string } | null {
  const steer = splitFirstArg(args.input);
  if (!steer.first) return null;
  const session = splitFirstArg(steer.rest);
  if (session.rest) return null;
  const targetSessionId = session.first || args.sessionId?.trim() || "";
  if (!targetSessionId) return null;
  return { steerId: steer.first, sessionId: targetSessionId };
}

export function resolveTuiUnprocessedMessageDraft(args: {
  steerId: string;
  events: readonly AgentChatEventEnvelope[];
}): string | null {
  for (let index = args.events.length - 1; index >= 0; index -= 1) {
    const event = args.events[index]?.event;
    if (
      event?.type === "user_message_resolution"
      && event.steerId === args.steerId
    ) {
      return null;
    }
    if (
      event?.type !== "user_message"
      || event.steerId !== args.steerId
      || event.deliveryState !== "unprocessed"
    ) {
      continue;
    }
    const text = event.displayText?.trim() || event.text.trim();
    return text || null;
  }
  return null;
}

export function resolveTuiRecoveryTargetProvider(args: {
  targetSessionId: string;
  visibleSessionId: string;
  visibleProvider: AgentChatSessionSummary["provider"] | null | undefined;
  sessions: ReadonlyArray<Pick<AgentChatSessionSummary, "sessionId" | "provider">>;
}): AgentChatSessionSummary["provider"] | null {
  const targetSession = args.sessions.find((session) => session.sessionId === args.targetSessionId);
  if (targetSession) return targetSession.provider;
  // An orchestration child may not have reached the TUI's session inventory yet.
  // The forwarded health event remains authoritative for that case.
  return args.targetSessionId === args.visibleSessionId ? args.visibleProvider ?? null : null;
}

type ParsedAdeActionPayload =
  | { args: Record<string, unknown> }
  | { argsList: unknown[] }
  | { arg: unknown };

function parseAdeActionPayload(input: string): ParsedAdeActionPayload {
  const trimmed = input.trim();
  if (!trimmed) return { args: {} };
  const parsed = JSON.parse(trimmed) as unknown;
  if (Array.isArray(parsed)) {
    return { argsList: parsed };
  }
  if (parsed && typeof parsed === "object") {
    return { args: parsed as Record<string, unknown> };
  }
  return { arg: parsed };
}

function parseLinearIssueListArgs(input: string): Record<string, unknown> {
  const projectSlugs: string[] = [];
  const stateTypes: string[] = [];
  let limit: number | undefined;
  const tokens = input.match(/"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|(\S+)/g)?.map((token) => (
    token.startsWith("\"") && token.endsWith("\"")
      ? token.slice(1, -1).replace(/\\"/g, "\"")
      : token.startsWith("'") && token.endsWith("'")
        ? token.slice(1, -1)
        : token
  )) ?? [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    const next = tokens[index + 1];
    if ((token === "--project" || token === "--project-slug" || token === "--projects") && next) {
      projectSlugs.push(...next.split(",").map((entry) => entry.trim()).filter(Boolean));
      index += 1;
    } else if ((token === "--state" || token === "--states" || token === "--state-type") && next) {
      stateTypes.push(...next.split(",").map((entry) => entry.trim()).filter(Boolean));
      index += 1;
    } else if (token === "--limit" && next && Number.isFinite(Number(next))) {
      limit = Math.max(1, Math.min(100, Math.floor(Number(next))));
      index += 1;
    } else if (!token.startsWith("--")) {
      projectSlugs.push(token);
    }
  }
  return {
    projectSlugs,
    stateTypes,
    ...(limit ? { limit } : {}),
  };
}

function printableInput(input: string): string {
  return input.replace(/[\u0000-\u001f\u007f]/g, "");
}

function printablePromptInput(input: string): string {
  return stripBracketedPasteMarkers(input)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "");
}

export function deletePreviousPromptWord(value: string): string {
  return value.slice(0, previousPromptWordBoundary(value));
}

export function previousPromptWordBoundary(value: string, cursor = value.length): number {
  let index = clampPromptCursor(value, cursor);
  while (index > 0 && /\s/.test(value[index - 1] ?? "")) index -= 1;
  while (index > 0 && !/\s/.test(value[index - 1] ?? "")) index -= 1;
  return index;
}

export function nextPromptWordBoundary(value: string, cursor = 0): number {
  let index = clampPromptCursor(value, cursor);
  while (index < value.length && /\s/.test(value[index] ?? "")) index += 1;
  while (index < value.length && !/\s/.test(value[index] ?? "")) index += 1;
  return index;
}

function previousPromptCharacterBoundary(value: string, cursor: number): number {
  const safeCursor = clampPromptCursor(value, cursor);
  if (safeCursor <= 0) return 0;
  const previous = [...value.slice(0, safeCursor)].at(-1);
  return Math.max(0, safeCursor - (previous?.length ?? 1));
}

function nextPromptCharacterBoundary(value: string, cursor: number): number {
  const safeCursor = clampPromptCursor(value, cursor);
  if (safeCursor >= value.length) return value.length;
  const next = [...value.slice(safeCursor)].at(0);
  return Math.min(value.length, safeCursor + (next?.length ?? 1));
}

export function deletePreviousPromptLine(value: string): string {
  return value.slice(0, previousPromptLineBoundary(value));
}

export function previousPromptLineBoundary(value: string, cursor = value.length): number {
  const safeCursor = clampPromptCursor(value, cursor);
  if (safeCursor <= 0) return 0;
  if (value[safeCursor - 1] === "\n" || value[safeCursor - 1] === "\r") return safeCursor - 1;
  const index = value.lastIndexOf("\n", safeCursor - 1);
  return index === -1 ? 0 : index + 1;
}

function modifierDeletesPromptWord(modifier: number): boolean {
  if (!Number.isInteger(modifier) || modifier < 2) return false;
  const mask = modifier - 1;
  const alt = 2;
  const ctrl = 4;
  const superKey = 8;
  const hyper = 16;
  const meta = 32;
  return (mask & (alt | ctrl | superKey | hyper | meta)) !== 0;
}

function isModifiedPromptBackspaceSequence(input: string): boolean {
  const kittyBackspace = input.match(/^\x1b\[(?:8|127);(\d+)u$/);
  if (kittyBackspace) return modifierDeletesPromptWord(Number(kittyBackspace[1]));

  const modifiedDelete = input.match(/^\x1b\[3;(\d+)~$/);
  if (modifiedDelete) return modifierDeletesPromptWord(Number(modifiedDelete[1]));

  const modifyOtherKeysBackspace = input.match(/^\x1b\[27;(\d+);(?:8|127)~$/);
  if (modifyOtherKeysBackspace) return modifierDeletesPromptWord(Number(modifyOtherKeysBackspace[1]));

  return false;
}

export function isPromptWordBackspace(input: string, key: { ctrl?: boolean; meta?: boolean; backspace?: boolean; delete?: boolean }): boolean {
  if (isCtrlInput(input, key, "w")) return true;
  if (input === "\x1b\u007f" || input === "\x1b\b") return true;
  if (isModifiedPromptBackspaceSequence(input)) return true;
  if (key.ctrl && (key.backspace || key.delete)) return true;
  if (key.meta && (key.backspace || key.delete)) return true;
  if (key.meta && (input === "\u007f" || input === "\b" || input === "\x1b\u007f" || input === "\x1b\b")) return true;
  if (key.ctrl && (input === "\u007f" || input === "\b" || input === "h")) return true;
  return false;
}

export function isPromptLineBackspace(input: string, key: { ctrl?: boolean; meta?: boolean; backspace?: boolean; delete?: boolean }): boolean {
  return isCtrlInput(input, key, "u");
}

type PromptEditResult = { value: string; cursor: number };

export function insertPromptText(value: string, cursor: number, text: string): PromptEditResult {
  const safeCursor = clampPromptCursor(value, cursor);
  const nextValue = `${value.slice(0, safeCursor)}${text}${value.slice(safeCursor)}`;
  return { value: nextValue, cursor: safeCursor + text.length };
}

export function deletePromptBackward(
  value: string,
  cursor: number,
  mode: "char" | "word" | "line" = "char",
): PromptEditResult {
  const safeCursor = clampPromptCursor(value, cursor);
  if (safeCursor <= 0) return { value, cursor: safeCursor };
  if (mode !== "line") {
    // An image chip is one thing on screen, so it is one thing to delete —
    // same rule the URL chips follow.
    const imageDeletion = deleteImageTokenBackward(value, safeCursor);
    if (imageDeletion) return imageDeletion;
    const linkDeletion = deletePromptSmartLinkBackward(value, safeCursor);
    if (linkDeletion) return linkDeletion;
  }
  let start: number;
  if (mode === "word") start = previousPromptWordBoundary(value, safeCursor);
  else if (mode === "line") start = previousPromptLineBoundary(value, safeCursor);
  else start = previousPromptCharacterBoundary(value, safeCursor);
  const safeStart = Math.max(0, Math.min(start, safeCursor));
  return {
    value: `${value.slice(0, safeStart)}${value.slice(safeCursor)}`,
    cursor: safeStart,
  };
}

export function deletePromptForward(value: string, cursor: number): PromptEditResult {
  const safeCursor = clampPromptCursor(value, cursor);
  if (safeCursor >= value.length) return { value, cursor: safeCursor };
  const imageDeletion = deleteImageTokenForward(value, safeCursor);
  if (imageDeletion) return imageDeletion;
  const linkDeletion = deletePromptSmartLinkForward(value, safeCursor);
  if (linkDeletion) return linkDeletion;
  const end = nextPromptCharacterBoundary(value, safeCursor);
  return {
    value: `${value.slice(0, safeCursor)}${value.slice(end)}`,
    cursor: safeCursor,
  };
}

export function deletePromptForKey(
  value: string,
  cursor: number,
  key: { backspace?: boolean; delete?: boolean },
): PromptEditResult {
  return key.delete && !key.backspace
    ? deletePromptForward(value, cursor)
    : deletePromptBackward(value, cursor);
}

// Apply a possibly-coalesced input chunk to the prompt, character by character.
// Ink emits multiple fast keystrokes as ONE chunk and only recognizes a *lone*
// DEL/BS byte as backspace — so a burst like "x\x7f" (type then delete) arrives
// as plain text with no backspace flag, and naive insertion would drop the
// Like printableInput but keeps tabs (0x09) and newlines (0x0a), normalizing
// CR/LF to "\n", so a pasted multi-line / tabbed block survives verbatim in the
// feedback body editor. Strips the remaining C0 controls and DEL.
function printableMultilineInput(input: string): string {
  return input
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

// delete. Here we walk the chunk: printable runs are inserted, embedded
// DEL/BS bytes delete backward, all in order. Fixes intermittent "backspace
// does nothing" when typing quickly.
export function applyCoalescedPromptInput(value: string, cursor: number, input: string, preserveMultiline = false): PromptEditResult {
  let result: PromptEditResult = { value, cursor: clampPromptCursor(value, cursor) };
  let buffer = "";
  const flush = () => {
    const printable = preserveMultiline ? printableMultilineInput(buffer) : printableInput(buffer);
    buffer = "";
    if (printable) result = insertPromptText(result.value, result.cursor, printable);
  };
  for (const ch of input) {
    if (ch === "\u007f" || ch === "\b") {
      flush();
      result = deletePromptBackward(result.value, result.cursor, "char");
    } else {
      buffer += ch;
    }
  }
  flush();
  return result;
}

function inputBeforeLineBreak(input: string): string | null {
  const index = input.search(/[\r\n]/);
  return index === -1 ? null : input.slice(0, index);
}

const PROMPT_MAX_ROWS = 5;

/**
 * Cells the prompt box consumes around a wrapped row, subtracted from the pane
 * width to get the wrap budget.
 *
 * The box is `width={promptPaneWidth}` with `borderStyle="round"` (2) and
 * `paddingX={1}` (2), leaving `promptPaneWidth - 4` usable cells. Each row then
 * spends 2 more on the `"› "` / `"  "` gutter, and up to 1 more on the inverse
 * cursor cell — which has no character under it when the caret sits at the end
 * of a line that a literal "\n" terminated, so a space is painted instead.
 *
 * Getting this wrong is not cosmetic: a row that overruns the box makes Ink
 * re-wrap it with `wrap-ansi`'s `hard: true`, which splits the row mid-word
 * onto an extra terminal line. That reads as a duplicated newline plus letters
 * of one word scattered across two lines.
 */
export const PROMPT_ROW_CHROME_CELLS = 7;

/** Cells a trailing prompt-row hint (`^V paste image`, `^B open image`) needs. */
const PROMPT_ROW_HINT_CELLS = 16;

/**
 * Wrap budget for one prompt row. Never lets a row plus its chrome exceed the
 * box's inner width, so Ink never re-wraps a row we already wrapped.
 */
export function promptWrapWidth(promptPaneWidth: number): number {
  return Math.max(1, Math.floor(promptPaneWidth) - PROMPT_ROW_CHROME_CELLS);
}

/**
 * Whether a trailing hint still fits beside a row. Rendering it unconditionally
 * pushes the row past the box and triggers the same mid-word re-wrap the
 * chrome budget exists to prevent.
 */
export function promptRowHintFits(rowText: string, promptPaneWidth: number): boolean {
  const used = PROMPT_ROW_CHROME_CELLS + terminalDisplayWidth(rowText);
  return used + PROMPT_ROW_HINT_CELLS <= Math.floor(promptPaneWidth);
}

type PromptVisualRow = {
  text: string;
  start: number;
  end: number;
};

type PromptDisplayRow = PromptVisualRow & {
  cursorColumn: number | null;
};

type BackgroundLaunchStatus = {
  id: number;
  laneId: string;
  laneName: string;
  prompt: string;
  status: "running" | "failed";
  error?: string;
};

export function clampPromptCursor(value: string, cursor: number | null | undefined): number {
  if (!Number.isFinite(cursor ?? Number.NaN)) return value.length;
  return Math.max(0, Math.min(value.length, Math.floor(cursor ?? value.length)));
}

function buildPromptVisualRows(value: string, width: number): PromptVisualRow[] {
  const safeWidth = Math.max(1, Math.floor(width));
  const rows: PromptVisualRow[] = [];
  let start = 0;
  let text = "";
  let textWidth = 0;
  // Code-unit offset just past the last space/tab on the row being built: the
  // point we rewind to so wrapping breaks between words instead of through the
  // middle of one. Reset at every row boundary.
  let breakOffset: number | null = null;
  for (const cluster of displayClusters(value)) {
    if (cluster.text === "\n") {
      rows.push({ text, start, end: cluster.start });
      start = cluster.end;
      text = "";
      textWidth = 0;
      breakOffset = null;
      continue;
    }
    if (text && textWidth + cluster.width > safeWidth) {
      const isSpaceCluster = cluster.text === " " || cluster.text === "\t";
      if (breakOffset != null && breakOffset > start && !isSpaceCluster) {
        // Carry the partial word down to the next row. It fit alongside the
        // row prefix, so it is never wider than the row on its own.
        const carry = value.slice(breakOffset, cluster.start);
        rows.push({ text: value.slice(start, breakOffset), start, end: breakOffset });
        start = breakOffset;
        text = carry;
        textWidth = terminalDisplayWidth(carry);
      } else {
        // No break opportunity (or the overflow is the space itself): hard
        // break, which is also the only option for a word wider than the row.
        rows.push({ text, start, end: cluster.start });
        start = cluster.start;
        text = "";
        textWidth = 0;
      }
      breakOffset = null;
    }
    text += cluster.text;
    textWidth += cluster.width;
    if (cluster.text === " " || cluster.text === "\t") breakOffset = cluster.end;
  }
  if (text.length > 0) rows.push({ text, start, end: value.length });
  if (!rows.length || (start === value.length && text.length === 0)) {
    rows.push({ text: "", start: value.length, end: value.length });
  }
  return rows;
}

function promptVisualRowIndexForCursor(rows: readonly PromptVisualRow[], cursor: number): number {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row && cursor >= row.start && cursor <= row.end) return index;
  }
  return Math.max(0, rows.length - 1);
}

export function promptDisplayRowsWithCursor(
  value: string,
  width: number,
  cursor = value.length,
  maxRows = PROMPT_MAX_ROWS,
): { rows: PromptDisplayRow[]; cursorRow: number; cursorColumn: number } {
  const safeCursor = clampPromptCursor(value, cursor);
  const safeWidth = Math.max(1, Math.floor(width));
  const allRows = buildPromptVisualRows(value, safeWidth);
  const lastRow = allRows[allRows.length - 1];
  if (
    value.length > 0
    && lastRow
    && lastRow.end === value.length
    && terminalDisplayWidth(lastRow.text) >= safeWidth
  ) {
    allRows.push({ text: "", start: value.length, end: value.length });
  }
  const cursorRowIndex = promptVisualRowIndexForCursor(allRows, safeCursor);
  const visibleCount = Math.max(1, maxRows);
  const maxStart = Math.max(0, allRows.length - visibleCount);
  const start = Math.min(maxStart, Math.max(0, cursorRowIndex - visibleCount + 1));
  const visibleRows = allRows.slice(start, start + visibleCount);
  const visibleCursorRow = Math.max(0, cursorRowIndex - start);
  const cursorRow = visibleRows[visibleCursorRow] ?? visibleRows[visibleRows.length - 1] ?? { text: "", start: safeCursor, end: safeCursor };
  const cursorColumn = displayCellForCodeUnitIndex(cursorRow.text, safeCursor - cursorRow.start);
  return {
    rows: visibleRows.map((row, index) => ({
      ...row,
      cursorColumn: index === visibleCursorRow ? cursorColumn : null,
    })),
    cursorRow: visibleCursorRow,
    cursorColumn,
  };
}

export function promptDisplayRows(value: string, width: number, maxRows = PROMPT_MAX_ROWS): string[] {
  return promptDisplayRowsWithCursor(value, width, value.length, maxRows).rows.map((row) => row.text);
}

export function movePromptCursorVertical(value: string, width: number, cursor: number, delta: -1 | 1): number {
  const rows = buildPromptVisualRows(value, width);
  const safeCursor = clampPromptCursor(value, cursor);
  const rowIndex = promptVisualRowIndexForCursor(rows, safeCursor);
  const row = rows[rowIndex];
  if (!row) return safeCursor;
  const target = rows[rowIndex + delta];
  if (!target) return safeCursor;
  const column = displayCellForCodeUnitIndex(row.text, safeCursor - row.start);
  const targetOffset = codeUnitIndexForDisplayCell(target.text, column);
  return Math.max(target.start, Math.min(target.end, target.start + targetOffset));
}

export function isPromptCursorOnFirstVisualRow(value: string, width: number, cursor: number): boolean {
  const rows = buildPromptVisualRows(value, width);
  return promptVisualRowIndexForCursor(rows, clampPromptCursor(value, cursor)) <= 0;
}

export function isPromptCursorOnLastVisualRow(value: string, width: number, cursor: number): boolean {
  const rows = buildPromptVisualRows(value, width);
  return promptVisualRowIndexForCursor(rows, clampPromptCursor(value, cursor)) >= rows.length - 1;
}

// Agent CLIs ship as npm shims on Windows (`claude.cmd`, `codex.cmd`, ...).
// Node cannot spawn those by bare name (ENOENT) nor by `.cmd` path without a
// shell (EINVAL, CVE-2024-27980), so resolve through `where` and route batch
// shims through cmd.exe with quoted argv — `shell: true` does not quote for us.
function resolveWindowsSpawnTarget(
  command: string,
  args: string[],
): { command: string; args: string[]; shell: boolean } {
  if (process.platform !== "win32") return { command, args, shell: false };
  const lookup = spawnSync("where", [command], { encoding: "utf8", windowsHide: true });
  const resolved = lookup.status === 0
    ? (lookup.stdout ?? "").split(/\r?\n/).map((line) => line.trim()).find(Boolean)
    : undefined;
  if (!resolved) {
    // Preserve the bare name so callers keep seeing ENOENT and can fall through
    // to the next candidate command.
    return { command, args, shell: false };
  }
  if (!/\.(cmd|bat)$/i.test(resolved)) return { command: resolved, args, shell: false };
  return {
    command: `"${resolved}"`,
    args: args.map((arg) => (/[\s&|<>^"]/.test(arg) ? `"${arg}"` : arg)),
    shell: true,
  };
}

function runInteractiveTerminalCommand(command: string, args: string[], cwd: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin as NodeJS.ReadStream & { isRaw?: boolean; setRawMode?: (mode: boolean) => void };
    const wasRaw = Boolean(stdin.isRaw);
    if (typeof stdin.setRawMode === "function") {
      stdin.setRawMode(false);
    }
    process.stdout.write("\n");
    const target = resolveWindowsSpawnTarget(command, args);
    const child = spawn(target.command, target.args, {
      cwd,
      stdio: "inherit",
      env: process.env,
      shell: target.shell,
    });
    const restore = () => {
      if (typeof stdin.setRawMode === "function") {
        stdin.setRawMode(wasRaw);
      }
    };
    child.once("error", (error) => {
      restore();
      reject(error);
    });
    child.once("close", (code) => {
      restore();
      process.stdout.write("\n");
      resolve(code);
    });
  });
}

type ProviderLoginCommand = { command: string; args: string[]; label: string };

function loginCommandsForProvider(provider: AdeCodeProvider): ProviderLoginCommand[] {
  if (provider === "claude") return [{ command: "claude", args: ["auth", "login"], label: "claude auth login" }];
  if (provider === "codex") return [{ command: "codex", args: ["login"], label: "codex login" }];
  if (provider === "opencode") return [{ command: "opencode", args: ["auth", "login"], label: "opencode auth login" }];
  if (provider === "pi") return [{ command: "pi", args: [], label: "pi (then /login)" }];
  // 0.22.3 removed `qwen auth`. Sign-in is the OpenAI-compatible key path.
  if (provider === "qwen") return [{ command: "qwen", args: ["--auth-type=openai"], label: "qwen --auth-type=openai" }];
  if (provider === "kimi") return [{ command: "kimi", args: ["login"], label: "kimi login" }];
  if (provider === "grok") return [{ command: "grok", args: ["login"], label: "grok login" }];
  if (provider === "copilot") return [{ command: "copilot", args: ["login"], label: "copilot login" }];
  return [];
}

function loginUnavailableHint(provider: AdeCodeProvider): string {
  if (provider === "cursor") {
    return "ADE Cursor chat uses @cursor/sdk, which requires a Cursor API key. Open Settings > AI Providers, use ADE's encrypted key store, or set CURSOR_API_KEY before launching ADE.";
  }
  if (provider === "droid") {
    return "ADE Droid chat uses the Factory Droid SDK. Set FACTORY_API_KEY before launching ADE, or run `droid` and use its interactive `/login`.";
  }
  return "No terminal login command is known for this provider.";
}

/**
 * Split a visual prompt row's text into plain and confirmed-token segments so
 * the renderer can style `@file` / `/command` chips. `rowStart` is the prompt
 * code-unit offset of `text[0]`; token ranges are in prompt coordinates.
 */
type PromptRenderTokenKind = "plain" | "file" | "command" | "mention" | "link" | "image";

type PromptRenderTokenRange =
  | ComposerTokenRange
  | { kind: "link" | "image"; start: number; end: number };

function segmentPromptLineText(
  text: string,
  rowStart: number,
  tokens: PromptRenderTokenRange[],
): Array<{ text: string; kind: PromptRenderTokenKind }> {
  if (!tokens.length || !text) return text ? [{ text, kind: "plain" }] : [];
  const segments: Array<{ text: string; kind: PromptRenderTokenKind }> = [];
  let pos = 0;
  for (const token of tokens) {
    const start = Math.max(0, token.start - rowStart);
    const end = Math.min(text.length, token.end - rowStart);
    if (end <= pos || start >= text.length) continue;
    if (start > pos) segments.push({ text: text.slice(pos, start), kind: "plain" });
    segments.push({ text: text.slice(Math.max(pos, start), end), kind: token.kind });
    pos = end;
  }
  if (pos < text.length) segments.push({ text: text.slice(pos), kind: "plain" });
  return segments;
}

export const MENTION_REMOTE_DEBOUNCE_MS = 160;
/** Rows the mention palette renders at most. */
export const MENTION_MAX_ROWS = 10;
/** File rows requested from quick-open, and reserved when browsing on a bare `@`. */
export const MENTION_FILE_ROWS = 5;
const STARTUP_RECONNECT_DELAY_MS = 3_000;

function matchesMentionTarget(target: string, query: string): boolean {
  return target.includes(query) || query.startsWith(`${target} `);
}

/**
 * Rank @ rows by the same match tiers desktop uses so a better lane/chat is
 * not stuck behind a vaguely matching file (or the reverse). Source order is
 * only the tie-break. Unscored rows (commits/PRs the scorer cannot see) stay
 * last rather than disappearing.
 */
export function rankMentionSuggestions(
  suggestions: MentionSuggestion[],
  query: string,
): MentionSuggestion[] {
  if (!query.trim()) return suggestions;

  return suggestions
    .map((suggestion, index) => {
      const match = scoreChatMentionCandidate(
        { title: suggestion.label, subtitle: suggestion.detail },
        query,
      ) ?? { score: 50, titlePrefixLength: 0 };
      return { suggestion, index, score: match.score, titlePrefixLength: match.titlePrefixLength };
    })
    .sort((left, right) => (
      left.score - right.score
      || right.titlePrefixLength - left.titlePrefixLength
      || left.index - right.index
    ))
    .map(({ suggestion }) => suggestion);
}

type MentionRemoteCacheEntry = {
  filesByQuery: Map<string, Array<{ path: string }>>;
  commits: Array<Record<string, unknown>> | null;
  prs: Array<Record<string, unknown>> | null;
};

function mentionRemoteCacheEntry(cache: Map<string, MentionRemoteCacheEntry>, laneId: string): MentionRemoteCacheEntry {
  let entry = cache.get(laneId);
  if (!entry) {
    entry = { filesByQuery: new Map(), commits: null, prs: null };
    cache.set(laneId, entry);
  }
  return entry;
}

function useTerminalDimensions(): [number, number] {
  const read = (): [number, number] => [
    process.stdout.columns ?? 120,
    process.stdout.rows ?? 40,
  ];
  const [dimensions, setDimensions] = useState<[number, number]>(read);
  useEffect(() => {
    const handleResize = () => setDimensions(read());
    process.stdout.on("resize", handleResize);
    return () => {
      process.stdout.off("resize", handleResize);
    };
  }, []);
  return dimensions;
}

export function stableInkViewportRows(terminalRows: number): number {
  // Ink 5 falls back to clearing the entire terminal when rendered output is
  // at least the terminal height. Keep a spare row so prompt edits stay on the
  // cheaper erase/repaint path instead of flashing the whole alternate screen.
  return Math.max(1, Math.floor(terminalRows) - 1);
}

function useTerminalAlternateScroll(): void {
  useEffect(() => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) return;
    process.stdout.write(terminalAlternateScrollEnableSequence());
    return () => {
      process.stdout.write(terminalAlternateScrollDisableSequence());
    };
  }, []);
}

function useTerminalAlternateScreen(): void {
  useEffect(() => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) return;
    process.stdout.write(terminalAlternateScreenEnableSequence());
    return () => {
      process.stdout.write(terminalAlternateScreenDisableSequence());
    };
  }, []);
}

function useTerminalBracketedPaste(): void {
  useEffect(() => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) return;
    process.stdout.write(terminalBracketedPasteEnableSequence());
    return () => {
      process.stdout.write(terminalBracketedPasteDisableSequence());
    };
  }, []);
}

type TerminalMouseInput = {
  kind: "wheel" | "click" | "drag" | "release" | "move" | "other";
  x: number | null;
  y: number | null;
  direction?: "up" | "down" | "left" | "right";
  shift?: boolean;
  alt?: boolean;
  ctrl?: boolean;
};

export type ChatSelectionState = ChatTextSelection & { active: boolean };
export type ChatSelectionPoint = { row: number; column: number };
type ChatSelectionEdgeDirection = "older" | "newer";

const CTRL_C_EXIT_ARM_MS = 1500;
const CHAT_SELECTION_EDGE_SCROLL_MS = 90;

function withMouseModifiers(input: Omit<TerminalMouseInput, "shift" | "alt" | "ctrl">, code: number): TerminalMouseInput {
  return {
    ...input,
    ...(code & 4 ? { shift: true } : {}),
    ...(code & 8 ? { alt: true } : {}),
    ...(code & 16 ? { ctrl: true } : {}),
  };
}

function decodeMouseButton(code: number, x: number | null, y: number | null, pressed: boolean): TerminalMouseInput {
  if (!pressed) {
    return withMouseModifiers({ kind: "release", x, y }, code);
  }
  if (code & 64) {
    const wheelButton = code & 3;
    if (wheelButton === 0) return withMouseModifiers({ kind: "wheel", direction: "up", x, y }, code);
    if (wheelButton === 1) return withMouseModifiers({ kind: "wheel", direction: "down", x, y }, code);
    if (wheelButton === 2) return withMouseModifiers({ kind: "wheel", direction: "left", x, y }, code);
    return withMouseModifiers({ kind: "wheel", direction: "right", x, y }, code);
  }
  if ((code & 32) && (code & 3) === 3) return withMouseModifiers({ kind: "move", x, y }, code);
  if ((code & 32) && (code & 3) === 0) return withMouseModifiers({ kind: "drag", x, y }, code);
  if ((code & 3) === 0) return withMouseModifiers({ kind: "click", x, y }, code);
  return withMouseModifiers({ kind: "other", x, y }, code);
}

export function parseTerminalMouseInput(input: string): TerminalMouseInput | null {
  const events = parseTerminalMouseInputs(input);
  return events.find((event) => event.kind !== "move") ?? events[0] ?? null;
}

function parseTerminalMouseInputs(input: string): TerminalMouseInput[] {
  const events: Array<{ index: number; event: TerminalMouseInput }> = [];
  const sgr = /\x1b*\[<(\d+);(\d+);(\d+)([mM])/g;
  let match: RegExpExecArray | null;
  while ((match = sgr.exec(input)) !== null) {
    events.push({
      index: match.index,
      event: decodeMouseButton(
        Number(match[1]),
        Number(match[2]),
        Number(match[3]),
        match[4] === "M",
      ),
    });
  }
  const rxvt = /\x1b*\[(\d+);(\d+);(\d+)M/g;
  while ((match = rxvt.exec(input)) !== null) {
    events.push({
      index: match.index,
      event: decodeMouseButton(
        Number(match[1]),
        Number(match[2]),
        Number(match[3]),
        true,
      ),
    });
  }
  const x10 = /\x1b*\[M([\s\S])([\s\S])([\s\S])/g;
  while ((match = x10.exec(input)) !== null) {
    events.push({
      index: match.index,
      event: decodeMouseButton(
        match[1]!.charCodeAt(0) - 32,
        match[2]!.charCodeAt(0) - 32,
        match[3]!.charCodeAt(0) - 32,
        true,
      ),
    });
  }
  return events.sort((left, right) => left.index - right.index).map(({ event }) => event);
}

// Sessions-pane hit-testing lives in ./workListLayout
// (workListMouseHitForLayout) so the row math is shared with the renderer.

type LaneDeleteScope = "worktree" | "local_branch" | "remote_branch";
const LANE_DELETE_SCOPES: LaneDeleteScope[] = ["worktree", "local_branch", "remote_branch"];

function normalizeLaneDeleteScope(value: string | null | undefined): LaneDeleteScope {
  return value === "local_branch" || value === "remote_branch" ? value : "worktree";
}

export function cycleLaneDeleteScope(value: string | null | undefined, delta: number): LaneDeleteScope {
  const current = normalizeLaneDeleteScope(value);
  const index = LANE_DELETE_SCOPES.indexOf(current);
  const next = (index + delta + LANE_DELETE_SCOPES.length) % LANE_DELETE_SCOPES.length;
  return LANE_DELETE_SCOPES[next] ?? "worktree";
}

export function isTwoStepConfirmCommand(command: string): boolean {
  return command === "chat-delete" || command === "lane-delete";
}

export function formFieldUsesPromptInput(command: string, fieldName: string): boolean {
  if (command === "chat-delete") return false;
  if (command === "lane-delete" && (fieldName === "scope" || fieldName === "force")) return false;
  if (
    command === "new-lane"
    && (fieldName === "start" || fieldName === "color" || fieldName === "branchSource" || fieldName === "create")
  ) return false;
  return true;
}

export function clampChatScrollOffsetRows(value: number, maxOffset: number): number {
  const safeMax = Number.isFinite(maxOffset) ? Math.max(0, Math.floor(maxOffset)) : 0;
  if (Number.isNaN(value)) return 0;
  if (!Number.isFinite(value)) return value > 0 ? safeMax : 0;
  return Math.max(0, Math.min(Math.floor(value), safeMax));
}

export function isChatTextSelectionRange(selection: ChatTextSelection | null | undefined): selection is ChatTextSelection {
  if (!selection) return false;
  return selection.startRow !== selection.endRow || selection.startColumn !== selection.endColumn;
}

export function isCtrlCCopyPlatform(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32";
}

export function isChatCopyShortcut(
  input: string,
  key: { ctrl?: boolean; meta?: boolean; c?: boolean },
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (key.meta && ((typeof input === "string" && input.toLowerCase() === "c") || input === "\x03" || key.c)) {
    return true;
  }
  return isCtrlCCopyPlatform(platform) && isCtrlInput(input, key, "c");
}

export function chatSelectionPointFromVisibleRows(
  rows: ChatVisibleSelectionRow[],
  visibleRow: number,
  column: number,
  clampToSelectable: boolean,
): ChatSelectionPoint | null {
  if (!rows.length) return null;
  const safeVisibleRow = Math.max(0, Math.min(Math.floor(visibleRow), rows.length - 1));
  const safeColumn = Math.max(0, Math.floor(column));
  const exact = rows[safeVisibleRow];
  if (exact && exact.sourceRow != null) {
    return { row: exact.sourceRow, column: safeColumn };
  }
  if (!clampToSelectable) return null;
  for (let distance = 1; distance < rows.length; distance += 1) {
    const before = rows[safeVisibleRow - distance];
    if (before?.sourceRow != null) return { row: before.sourceRow, column: safeColumn };
    const after = rows[safeVisibleRow + distance];
    if (after?.sourceRow != null) return { row: after.sourceRow, column: safeColumn };
  }
  return null;
}

export function moveChatSelectionFocusByRows(
  selection: ChatSelectionState,
  rowDelta: number,
  rowCount: number,
  column: number,
): ChatSelectionState {
  const maxRow = Math.max(0, rowCount - 1);
  return {
    ...selection,
    endRow: Math.max(0, Math.min(maxRow, selection.endRow + rowDelta)),
    endColumn: Math.max(0, Math.floor(column)),
  };
}

export function chatSelectionFromAnchor(
  anchor: ChatSelectionPoint,
  point: ChatSelectionPoint,
  active: boolean,
): ChatSelectionState {
  return {
    startRow: anchor.row,
    startColumn: anchor.column,
    endRow: point.row,
    endColumn: point.column,
    active,
  };
}

export function chatSelectionEdgeDirectionForMouseY({
  y,
  topRow,
  rowBudget,
  scrollOffsetRows,
  maxScrollOffsetRows,
}: {
  y: number | null;
  topRow: number;
  rowBudget: number;
  scrollOffsetRows: number;
  maxScrollOffsetRows: number;
}): ChatSelectionEdgeDirection | null {
  if (y == null) return null;
  const bottomRow = topRow + Math.max(1, rowBudget) - 1;
  if (y < topRow && scrollOffsetRows < maxScrollOffsetRows) return "older";
  if (y > bottomRow && scrollOffsetRows > 0) return "newer";
  return null;
}

export function terminalMouseTrackingEnableSequence(): string {
  const hover = process.env.ADE_CODE_HOVER?.trim().toLowerCase();
  const hoverOff = hover === "0" || hover === "off" || hover === "false";
  // Default on: SGR 1003 motion so hit-test hover highlighting actually
  // receives events. ADE_CODE_HOVER=0 restores the press/drag-only baseline
  // for terminals that flood input on motion.
  return hoverOff
    ? "\x1b[?1000h\x1b[?1002h\x1b[?1006h"
    : "\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h";
}

export function terminalMouseTrackingDisableSequence(): string {
  return "\x1b[?1015l\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l";
}

export function terminalAlternateScrollEnableSequence(): string {
  return "\x1b[?1007h";
}

export function terminalAlternateScrollDisableSequence(): string {
  return "\x1b[?1007l";
}

export function terminalAlternateScreenEnableSequence(): string {
  return "\x1b[?1049h";
}

export function terminalAlternateScreenDisableSequence(): string {
  return "\x1b[?1049l";
}

export function terminalBracketedPasteEnableSequence(): string {
  return "\x1b[?2004h";
}

export function terminalBracketedPasteDisableSequence(): string {
  return "\x1b[?2004l";
}

export function terminalInteractiveRestoreSequence(): string {
  return `${terminalMouseTrackingDisableSequence()}${terminalAlternateScrollDisableSequence()}${terminalBracketedPasteDisableSequence()}${terminalAlternateScreenDisableSequence()}`;
}

function disableTerminalMouseTracking(): void {
  process.stdout.write(terminalMouseTrackingDisableSequence());
}

function restoreTerminalInteractiveModes(): void {
  if (!process.stdout.isTTY) return;
  process.stdout.write(terminalInteractiveRestoreSequence());
}

let terminalRestoreHookRefCount = 0;

function registerTerminalProcessRestore(): () => void {
  if (!process.stdout.isTTY) return () => {};
  terminalRestoreHookRefCount += 1;
  if (terminalRestoreHookRefCount === 1) {
    process.on("exit", restoreTerminalInteractiveModes);
  }
  return () => {
    terminalRestoreHookRefCount = Math.max(0, terminalRestoreHookRefCount - 1);
    if (terminalRestoreHookRefCount === 0) {
      process.removeListener("exit", restoreTerminalInteractiveModes);
    }
  };
}

function enableTerminalMouseTracking(): void {
  // Button press/release + drag in SGR 1006, plus all-motion (1003) so hover
  // highlighting on hit-test targets actually receives events. Move events
  // only update hover and return; they do not start or extend a selection.
  process.stdout.write(terminalMouseTrackingEnableSequence());
}

function useTerminalMouseTracking(): void {
  useEffect(() => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) return;
    disableTerminalMouseTracking();
    enableTerminalMouseTracking();
    return () => {
      disableTerminalMouseTracking();
    };
  }, []);
}

function useTerminalProcessRestore(): void {
  useEffect(() => registerTerminalProcessRestore(), []);
}

const DRAWER_PANE_MIN_WIDTH = 32;
const DRAWER_PANE_MAX_WIDTH = 48;
const MIN_CENTER_PANE_WIDTH = 24;
// Breathing room between wrapped chat text and the right pane's left border so
// prose doesn't butt right up against the divider when the pane is open.
const CHAT_RIGHT_GUTTER = 2;
const MIN_RIGHT_PANE_WIDTH = 30;
const RIGHT_PANE_MAX_WIDTH = 42;
const MODEL_PICKER_RIGHT_PANE_MAX_WIDTH = 64;
const CLAUDE_TERMINAL_HIDDEN_INPUT_ROWS = 3;
export const CLAUDE_TERMINAL_SUBMIT_CONFIRM_DELAY_MS = 1200;
const CLAUDE_TERMINAL_SUBMIT_REFRESH_DELAY_MS = 150;

function finiteFloor(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.floor(value) : fallback;
}

function safeCenterWidth(centerWidth: number): number {
  return Math.max(MIN_CENTER_PANE_WIDTH, finiteFloor(centerWidth, MIN_CENTER_PANE_WIDTH));
}

export function resolveChatWrapWidth(centerWidth: number, _drawerOpen: boolean, rightPaneWidth: number): number {
  const safe = safeCenterWidth(centerWidth);
  // Reserve a small gutter only when the right pane is open; never underflow the
  // minimum center width.
  const gutter = rightPaneWidth > 0 ? CHAT_RIGHT_GUTTER : 0;
  return Math.max(MIN_CENTER_PANE_WIDTH, safe - gutter);
}

export function resolveTerminalPaneWidth(centerWidth: number): number {
  return safeCenterWidth(centerWidth);
}

export function resolveDrawerPaneWidth(columns: number, drawerOpen: boolean): number {
  if (!drawerOpen) return 0;
  const safeColumns = finiteFloor(columns, DRAWER_PANE_MIN_WIDTH);
  let responsive = DRAWER_PANE_MIN_WIDTH;
  if (safeColumns >= 180) {
    responsive = Math.floor(safeColumns * 0.19);
  } else if (safeColumns >= 132) {
    responsive = Math.floor(safeColumns * 0.24);
  }
  return Math.max(DRAWER_PANE_MIN_WIDTH, Math.min(DRAWER_PANE_MAX_WIDTH, responsive));
}

export function promptHitLine(args: {
  y: number | null;
  rows: number;
  promptRowCount: number;
  extraPromptRows?: number;
  modelStatusRows?: number;
  footerRows?: number;
}): boolean {
  if (args.y == null) return false;
  const rows = finiteFloor(args.rows, 0);
  if (rows <= 0) return false;
  const promptRows = Math.max(1, finiteFloor(args.promptRowCount, 1));
  const extraPromptRows = Math.max(0, finiteFloor(args.extraPromptRows ?? 0, 0));
  const modelStatusRows = Math.max(0, finiteFloor(args.modelStatusRows ?? 0, 0));
  const footerRows = Math.max(1, finiteFloor(args.footerRows ?? 1, 1));
  const promptBoxRows = promptRows + extraPromptRows + 2;
  const firstPromptLine = rows - footerRows - modelStatusRows - promptBoxRows + 1;
  return args.y >= firstPromptLine - 1 && args.y <= firstPromptLine + promptBoxRows - 1;
}

export function encodeTerminalPromptSubmit(value: string): string {
  const normalized = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (normalized.includes("\n")) return `\x1b[200~${normalized}\x1b[201~\r`;
  return `${normalized}\r`;
}

export function encodeTerminalPromptSubmitConfirm(): string {
  return "\r";
}

export function isCtrlInput(input: string, key: { ctrl?: boolean; meta?: boolean }, letter: string): boolean {
  const normalized = letter.toLowerCase();
  if (normalized.length !== 1) return false;
  if (key.ctrl === true && key.meta !== true && input.toLowerCase() === normalized) return true;
  const code = normalized.charCodeAt(0) - 96;
  return code >= 1 && code <= 26 && input === String.fromCharCode(code);
}

export function isTerminalControlToggle(input: string, key: { ctrl?: boolean; meta?: boolean }): boolean {
  return isCtrlInput(input, key, "t");
}

// Mirrors ptyService.isCliPlaceholderTitle for Claude: a session still showing a
// generic default title is awaiting the background auto-naming job (when enabled).
const CLAUDE_PLACEHOLDER_TITLES = new Set(["claude", "claude cli", "claude session", "claude code"]);
export function isClaudePlaceholderTitle(title: string | null | undefined): boolean {
  const normalized = String(title ?? "").trim().toLowerCase();
  return normalized.length === 0 || CLAUDE_PLACEHOLDER_TITLES.has(normalized);
}

export function splitTerminalControlInput(raw: string): { detach: boolean; forwarded: string } {
  const forwarded = raw.replace(/[\x14\x1d]/g, "");
  return {
    detach: forwarded.length !== raw.length,
    forwarded: formatTerminalControlForwardedInput(forwarded),
  };
}

export function terminalControlInputAction(
  input: string,
  key: { ctrl?: boolean; meta?: boolean },
): "detach" | "ignore" {
  return input === "\x1d" || isTerminalControlToggle(input, key) ? "detach" : "ignore";
}

function claudeTerminalRowsForPane(rows: number): number {
  const safeRows = finiteFloor(rows, 4);
  return Math.max(
    4,
    Math.min(120, safeRows + CLAUDE_TERMINAL_HIDDEN_INPUT_ROWS),
  );
}

export function promptTextForTerminal(text: string, attachments: AgentChatFileRef[]): string {
  const attachmentPaths = attachments.map((attachment) => attachment.path).filter(Boolean);
  if (!attachmentPaths.length) return text;
  const attachmentBlock = ["Attached files:", ...attachmentPaths.map((filePath) => `- ${filePath}`)].join("\n");
  return text ? `${text}\n\n${attachmentBlock}` : attachmentBlock;
}

export function clipboardImageCacheRootForRuntime(args: {
  remoteLaunch: boolean;
  activeLaneWorktreePath?: string | null;
  workspaceRoot: string;
  tmpDir?: string;
}): string {
  return args.remoteLaunch ? (args.tmpDir ?? os.tmpdir()) : (args.activeLaneWorktreePath ?? args.workspaceRoot);
}

export function isClipboardScratchTemp(filePath: string, cacheRoot: string): boolean {
  return filePath.startsWith(`${clipboardScratchDir(cacheRoot)}${path.sep}`);
}

export async function uploadClipboardImageAttachmentToRuntime(
  connection: AdeCodeConnection,
  localPath: string,
): Promise<{ path: string }> {
  const data = await fs.promises.readFile(localPath);
  return await saveRuntimeTempAttachment(connection, {
    data: data.toString("base64"),
    filename: path.basename(localPath),
  });
}

export function resolvePromptChatSubmitTarget(args: {
  draftChatActive: boolean;
  focusedSessionId: string | null;
  activeSessionId: string | null;
}): string | null {
  if (args.focusedSessionId) return args.focusedSessionId;
  return args.draftChatActive ? null : args.activeSessionId;
}

export function shouldHandlePendingQuestionKey(args: {
  pane: PaneFocus;
  hasPendingQuestion: boolean;
  prompt: string;
  ctrl: boolean;
  meta: boolean;
}): boolean {
  return args.pane === "chat" && args.hasPendingQuestion && !args.prompt.trim() && !args.ctrl && !args.meta;
}

function signalTerminalWithCliSync(args: {
  projectRoot: string;
  socketPath?: string | null;
  terminalId: string;
  signal: "SIGTERM" | "SIGKILL";
}): boolean {
  const entrypoint = process.argv[1];
  if (!entrypoint || !fs.existsSync(entrypoint)) return false;
  const env = { ...process.env };
  const socketPath = args.socketPath?.trim() || process.env.ADE_RUNTIME_SOCKET_PATH?.trim() || null;
  if (socketPath) {
    env.ADE_RUNTIME_SOCKET_PATH = socketPath;
    env.ADE_RPC_SOCKET_PATH = socketPath;
  }
  const result = spawnSync(process.execPath, [
    entrypoint,
    "--project-root",
    args.projectRoot,
    "--socket",
    "terminal",
    "signal",
    "--terminal",
    args.terminalId,
    "--signal",
    args.signal,
    "--json",
  ], {
    env,
    stdio: "ignore",
    timeout: 1_000,
  });
  return !result.error && result.status === 0;
}

function modelInfoFromDescriptor(modelRef: string): AgentChatModelInfo | null {
  const descriptor = resolveModelDescriptor(modelRef);
  if (!descriptor) return null;
  return {
    id: descriptor.id,
    modelId: descriptor.id,
    displayName: descriptor.displayName,
    isDefault: false,
    reasoningEfforts: descriptor.reasoningTiers?.map((effort) => ({ effort, description: effort })),
    defaultReasoningEffort: descriptor.defaultReasoningEffort ?? null,
    ...(descriptor.serviceTiers?.length ? { serviceTiers: descriptor.serviceTiers } : {}),
    ...(descriptor.cursorAvailability ? { cursorAvailability: descriptor.cursorAvailability } : {}),
    ...(descriptor.cursorCliVariants?.length ? { cursorCliVariants: descriptor.cursorCliVariants } : {}),
  };
}

function findModelForArg(provider: AdeCodeProvider, currentModels: AgentChatModelInfo[], value: string): AgentChatModelInfo | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = trimmed.toLowerCase();
  const descriptorModel = modelInfoFromDescriptor(trimmed);
  const pool = [
    ...currentModels,
    ...registryModelsForProvider(provider),
    ...(descriptorModel ? [descriptorModel] : []),
  ];
  return pool.find((entry) => (
    entry.id.toLowerCase() === normalized
    || (entry.modelId ?? "").toLowerCase() === normalized
    || entry.displayName.toLowerCase() === normalized
  )) ?? descriptorModel ?? null;
}

function modelStatePatchForArg(
  provider: AdeCodeProvider,
  currentModels: AgentChatModelInfo[],
  value: string,
): Pick<AdeCodeModelState, "provider" | "model" | "modelId" | "displayName"> {
  const model = findModelForArg(provider, currentModels, value);
  if (model) return modelStatePatchForModel(provider, model);
  return {
    provider,
    model: value,
    modelId: value,
    displayName: value,
  };
}

function resolveRightPaneWidth(columns: number, rightOpen: boolean, drawerOpen: boolean, maxWidth = RIGHT_PANE_MAX_WIDTH): number {
  if (!rightOpen) return 0;
  const drawerWidth = resolveDrawerPaneWidth(columns, drawerOpen);
  const maxRightWidth = columns - drawerWidth - MIN_CENTER_PANE_WIDTH;
  if (maxRightWidth < MIN_RIGHT_PANE_WIDTH) return 0;
  const widthFraction = maxWidth > RIGHT_PANE_MAX_WIDTH ? 0.56 : 0.24;
  return Math.max(
    MIN_RIGHT_PANE_WIDTH,
    Math.min(maxWidth, Math.floor(columns * widthFraction), maxRightWidth),
  );
}

function resolveCenterPaneWidth(columns: number, drawerOpen: boolean, rightPaneWidth: number): number {
  return Math.max(
    MIN_CENTER_PANE_WIDTH,
    columns - resolveDrawerPaneWidth(columns, drawerOpen) - rightPaneWidth,
  );
}

export function AdeCodeApp({ project, forceEmbedded, requireSocket, socketPath, preferServiceRepair, remote }: AdeCodeAppProps) {
  const remoteLaunch = remote === true || project.remote === true;
  const { exit } = useApp();
  const [columns, terminalRows] = useTerminalDimensions();
  const rows = stableInkViewportRows(terminalRows);
  useTerminalAlternateScreen();
  useTerminalAlternateScroll();
  useTerminalBracketedPaste();
  useTerminalMouseTracking();
  useTerminalProcessRestore();
  const [connection, setConnection] = useState<AdeCodeConnection | null>(null);
  const [mode, setMode] = useState<RuntimeMode | "connecting">("connecting");
  const [accountLabel, setAccountLabel] = useState("account loading…");
  const [connectionRetrySeq, setConnectionRetrySeq] = useState(0);
  const connectionPoolRef = useRef(createAdeCodeConnectionPool());
  const [activeMachineKey, setActiveMachineKey] = useState(LOCAL_MACHINE_KEY);
  const [activeRemoteLabel, setActiveRemoteLabel] = useState<string | null>(
    remoteLaunch ? project.remoteLabel ?? "remote" : null,
  );
  const [activeProjectRoot, setActiveProjectRoot] = useState(project.projectRoot);
  const machinePickerQueryByIdRef = useRef(new Map<string, MachineQuery>());
  const projectPickerRootByIdRef = useRef(new Map<string, string>());
  const openProjectPickerRef = useRef<(options?: { notice?: boolean }) => Promise<void>>(async () => {});
  const projectPickerAutoOpenedRef = useRef(false);
  const hopInFlightRef = useRef(false);
  // True after an attached socket drops unexpectedly, until we re-attach. Drives
  // the reconnect probe below and a one-shot "reconnecting…" notice.
  const [connectionLost, setConnectionLost] = useState(false);
  const [lanes, setLanes] = useState<LaneSummary[]>([]);
  const lanesRef = useRef<LaneSummary[]>([]);
  const [prByLaneId, setPrByLaneId] = useState<Record<string, LanePrSummary>>({});
  const [diffByLaneId, setDiffByLaneId] = useState<Record<string, DiffLineStats>>({});
  const [sessions, setSessions] = useState<AgentChatSessionSummary[]>([]);
  const [terminalSessions, setTerminalSessions] = useState<ChatTerminalSession[]>([]);
  const [terminalScheduledWorkById, setTerminalScheduledWorkById] = useState<Record<string, AgentChatScheduledWorkState>>({});
  const [terminalPreview, setTerminalPreview] = useState<ChatTerminalPreviewResult | null>(null);
  // Per-terminal seed snapshots for grid tiles (the single-view pane uses
  // `terminalPreview`). Live updates after the seed arrive via terminalLiveChunks,
  // which the global pty subscription already buffers per session id.
  const [terminalPreviewById, setTerminalPreviewById] = useState<Record<string, ChatTerminalPreviewResult>>({});
  const [attachedTerminalId, setAttachedTerminalId] = useState<string | null>(null);
  const [terminalLiveChunks, setTerminalLiveChunks] = useState<Record<string, string[]>>({});
  // Scrollback position + "↓ N new" counter per Claude PTY session.
  const [terminalScrollBySessionId, setTerminalScrollBySessionId] = useState<TerminalScrollBySessionId>({});
  // Pending pty_data chunks buffered off-React; flushed at a bounded frame rate
  // so Claude Code terminal output doesn't force a full Ink repaint per byte.
  // The chunks still append monotonically, preserving TerminalPane's incremental
  // write cursor (no per-chunk slice(-500) that would freeze xterm replay).
  const pendingPtyChunksRef = useRef<Map<string, string[]>>(new Map());
  const ptyFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ptyFlushDelayRef = useRef<number | null>(null);
  // Owns the feedback success auto-close timer so it can be cleared on
  // unmount / re-open and never fire against a different right pane.
  const feedbackCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  // Latest visible text + max scrollback rows reported by the live TerminalPane,
  // so keyboard scroll can clamp and copy can grab the visible region.
  const terminalViewportMetricsRef = useRef<{ maxScrollable: number; visibleText: string }>({
    maxScrollable: 0,
    visibleText: "",
  });
  const handleTerminalViewportMetrics = useCallback((metrics: { maxScrollable: number; visibleText: string }) => {
    terminalViewportMetricsRef.current = metrics;
  }, []);
  const [activeLaneId, setActiveLaneId] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(project.sessionHint);
  const [events, setEvents] = useState<AgentChatEventEnvelope[]>([]);
  const [notices, setNotices] = useState<LocalNotice[]>([]);
  const [slashCommands, setSlashCommands] = useState<AgentChatSlashCommand[]>([]);
  const [keybindings, setKeybindings] = useState(() => readClaudeKeybindingsFile({ create: false }).bindings);
  /**
   * Installed plugins, kept only for what they DECLARE — their keybindings and
   * the install time that decides who wins a contested chord. Refreshed on the
   * plugin-contributions poll, because an install is the one event that can
   * change either.
   */
  const [pluginKeybindingRoster, setPluginKeybindingRoster] = useState<PluginKeybindingPlugin[]>([]);
  const [models, setModels] = useState<AgentChatModelInfo[]>([]);
  const [initialAdeCodeState] = useState(() => (
    remoteLaunch
      ? { lastChatByLane: {}, lastLaneId: null, draftKind: "chat" as AdeCodeInterfaceMode }
      : scopedAdeCodeState(loadAdeCodeState(), project.projectRoot)
  ));
  // A new chat in this project defaults to the model + settings the project last
  // used (state.ts, project-scoped like lastChatByLane). Remote launches always
  // start from the registry default — the memory is per local project root.
  const [initialModelMemory] = useState<AdeCodeModelMemory | null>(() => (
    remoteLaunch ? null : scopedAdeCodeModelMemory(loadAdeCodeState(), project.projectRoot)
  ));
  const [modelState, setModelState] = useState<AdeCodeModelState>(
    () => seedModelStateFromMemory(initialModelState(initialAdeCodeState.draftKind), initialModelMemory),
  );
  // ── Project-scoped model memory ───────────────────────────────────────────
  // Written on every successful chat start and on every /model commit; read
  // above to seed a new chat, and per-provider on wizard step 4.
  const rememberModelChoice = useCallback((state: AdeCodeModelState) => {
    saveAdeCodeModelMemory(project.projectRoot, modelMemoryFromState(state));
  }, [project.projectRoot]);
  const [modeChangeNotice, setModeChangeNotice] = useState<{ summary: string; key: string } | null>(null);
  const lastPermissionSummaryRef = useRef<string | null>(null);
  const modeNoticeTimerRef = useRef<NodeJS.Timeout | null>(null);
  // Only user-initiated mode changes (Shift+Tab, /plan, inline-row edit, picker)
  // fire the banner. Session-load background syncs do not.
  const userInitiatedModeChangeRef = useRef<boolean>(false);
  const [draftChatActive, setDraftChatActive] = useState(false);
  // Render-time mirror of draftScopeKeyRef so the notice filter recomputes when
  // a new draft is entered. null whenever no new-chat draft is active.
  const [draftScopeKey, setDraftScopeKey] = useState<string | null>(null);
  const [aiStatus, setAiStatus] = useState<AiSettingsStatus | null>(null);
  const [aiStatusCheckedAt, setAiStatusCheckedAt] = useState<string | null>(null);
  const [storedApiKeyProviders, setStoredApiKeyProviders] = useState<string[]>([]);
  const [openCodeDiagnostics, setOpenCodeDiagnostics] = useState<OpenCodeRuntimeSnapshot | null>(null);
  const [rightPane, setRightPane] = useState<RightPaneContent>({ kind: "empty" });
  const [laneSetupStatusByLaneId, setLaneSetupStatusByLaneId] = useState<Record<string, LaneSetupStatus>>({});
  // Measured (1-based) content origin of the model picker, reported by
  // ModelPickerPane via Ink/Yoga so the click hit-test maps to where rows
  // actually paint — robust to window size, no hardcoded offset. Null until the
  // first measurement; the hit-test falls back to geometry math meanwhile.
  const [pickerMeasuredOrigin, setPickerMeasuredOrigin] = useState<{ x: number; y: number; width: number } | null>(null);
  const handlePickerMeasureOrigin = useCallback((origin: { x: number; y: number; width: number }) => {
    setPickerMeasuredOrigin((prev) =>
      prev && prev.x === origin.x && prev.y === origin.y && prev.width === origin.width ? prev : origin,
    );
  }, []);
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [formFieldIndex, setFormFieldIndex] = useState(0);
  const [rightSelectionIndex, setRightSelectionIndex] = useState(0);
  // Armed confirm for a plugin action that declared `confirm`. Holds the
  // *identity* of the interactive the user has pressed Enter on once, so the
  // second press runs it — the same two-step the form-discard Esc uses. Not the
  // selection index: the pane repolls every ten seconds, and an index armed
  // against "Delete lane" would fire whatever the refresh moved into that slot.
  const pluginConfirmArmedRef = useRef<string | null>(null);
  // Plugin socket contributions for the two surfaces the drawer lists. Empty on
  // a host without plugin support and on a machine with none installed, which
  // is the same drawer either way: core rows and nothing added to them.
  const [pluginContributions, setPluginContributions] = useState<PluginTuiContributions>(
    EMPTY_PLUGIN_TUI_CONTRIBUTIONS,
  );
  // What the open `/plugin-actions` pane's rows resolve to. Held beside the pane
  // rather than inside it because a list pane carries strings and ids only, and
  // an action needs the plugin, the verb and the subject it was raised for.
  const pluginRowActionsRef = useRef<{
    entriesByKey: Map<string, PluginRowActionEntry>;
    /** The focused row, for `row-menu-item` entries. */
    context: PluginSurfaceContext;
    /**
     * The surface itself, for `toolbar-action` entries — which are SELECTED
     * with a surface-only subject and so must be INVOKED with one. The desktop
     * hands a toolbar action `{kind:"surface"}` unless a detail pane supplies an
     * entity, and a plugin handler cannot be written against both.
     */
    surfaceContext: PluginSurfaceContext;
  } | null>(null);
  /**
   * The one question a plugin action asked, while it is on screen.
   *
   * Held in state AND a ref for the usual reason in this file: the composer
   * draws from state, and the key handler — which runs outside React's render
   * — has to read the live value rather than the one its closure captured.
   *
   * `restore` is the composer text the question borrowed. Panes in this client
   * never own a text input, so the prompt line is where the answer is typed;
   * putting the draft back afterwards is what keeps a keyboard chord fired
   * mid-sentence from eating what the reader was writing.
   *
   * `follow` is the call site's own handling of the result — navigate, openUrl,
   * composer, refresh — so the re-invocation lands exactly where the first
   * invocation would have, and a row press, a panel button and a chord cannot
   * drift into three behaviours.
   */
  const [pluginPrompt, setPluginPrompt] = useState<{
    request: PluginPromptRequest;
    restore: string;
    follow: (result: unknown) => void | Promise<void>;
  } | null>(null);
  const pluginPromptRef = useRef<typeof pluginPrompt>(null);
  const [subagentPaneViewStateBySessionId, setSubagentPaneViewStateBySessionId] = useState<Record<string, SubagentPaneViewState>>({});
  const subagentPaneViewState = activeSessionId ? (subagentPaneViewStateBySessionId[activeSessionId] ?? {}) : {};
  const updateSubagentPaneViewState = useCallback((update: (current: SubagentPaneViewState) => SubagentPaneViewState) => {
    if (!activeSessionId) return;
    setSubagentPaneViewStateBySessionId((current) => ({
      ...current,
      [activeSessionId]: update(current[activeSessionId] ?? {}),
    }));
  }, [activeSessionId]);
  const activateSubagentPaneTarget = useCallback((target: SubagentPaneTarget, resumeOffset: number) => {
    if (target.type === "snapshot") {
      setRightSelectionIndex(target.index + resumeOffset);
      return;
    }
    if (target.type === "toggle-section") {
      updateSubagentPaneViewState((current) => ({
        ...current,
        collapsed: { ...current.collapsed, [target.section]: current.collapsed?.[target.section] !== true },
      }));
      return;
    }
    if (target.type === "toggle-earlier") {
      updateSubagentPaneViewState((current) => ({
        ...current,
        earlierExpanded: {
          ...current.earlierExpanded,
          [target.section]: !(current.earlierExpanded?.[target.section] ?? true),
        },
      }));
      return;
    }
    if (target.type === "show-all") {
      updateSubagentPaneViewState((current) => ({
        ...current,
        showAll: { ...current.showAll, [target.section]: true },
      }));
      return;
    }
    updateSubagentPaneViewState((current) => ({
      ...current,
      cleared: { ...current.cleared, [target.section]: [] },
    }));
  }, [updateSubagentPaneViewState]);
  const [rightChatsClosedExpanded, setRightChatsClosedExpanded] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(false);
  const rightOpenRef = useRef(false);
  rightOpenRef.current = rightOpen;
  const [activePane, setActivePane] = useState<PaneFocus>("chat");
  const [prompt, setPrompt] = useState("");
  const [promptCursor, setPromptCursor] = useState(0);
  const [backgroundLaunchStatus, setBackgroundLaunchStatus] = useState<BackgroundLaunchStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * The last connect failed only because a supervised brain had not answered
   * yet. Nothing is broken and nothing needs repairing, so the startup screen
   * says so and keeps waiting instead of showing a red failure.
   */
  const [startupServiceStarting, setStartupServiceStarting] = useState(false);
  const [contextPercent, setContextPercent] = useState<number | null>(null);
  const [tokenSummary, setTokenSummary] = useState<string | null>(null);
  const [statusLineStats, setStatusLineStats] = useState<TokenStats | null>(null);
  const [statusLineText, setStatusLineText] = useState<string | null>(null);
  const [currentGoal, setCurrentGoal] = useState<CodexThreadGoal | null>(null);
  const [vimModeEnabled, setVimModeEnabled] = useState(() => readClaudeVimMode(project.workspaceRoot));
  const [vimMode, setVimMode] = useState<"insert" | "normal">("insert");
  const [hideVimModeIndicator, setHideVimModeIndicator] = useState(false);
  const [streamingBySessionId, setStreamingBySessionId] = useState<Record<string, boolean>>({});
  const [interruptedBySessionId, setInterruptedBySessionId] = useState<Record<string, boolean>>({});
  const [eventsBySessionId, setEventsBySessionId] = useState<Record<string, AgentChatEventEnvelope[]>>({});
  const [multiView, setMultiView] = useState<MultiViewState | null>(null);
  // "Grid exists" (multiView) is decoupled from "grid is showing" (gridViewActive).
  // Creating/opening a non-grid chat hides the grid without destroying it, so it
  // stays resumable; navigating back to one of its tiles re-shows it.
  const [gridViewActive, setGridViewActive] = useState(false);
  const [scrollBySessionId, setScrollBySessionId] = useState<Record<string, number>>({});
  const [selectionBySessionId, setSelectionBySessionId] = useState<Record<string, ChatTextSelection | null>>({});
  const [promptHistoryBySessionId, setPromptHistoryBySessionId] = useState<Record<string, string[]>>({});
  const [addMode, setAddMode] = useState<AddModeState | null>(null);
  const [multiViewNotice, setMultiViewNotice] = useState<string | null>(null);
  const [hoveredHitId, setHoveredHitId] = useState<string | null>(null);
  const [interrupted, setInterrupted] = useState(false);
  const [chatMouseSelection, setChatMouseSelection] = useState<ChatSelectionState | null>(null);
  const [clearedAt, setClearedAt] = useState<string | null>(null);
  const [expandedLineIds, setExpandedLineIds] = useState<Set<string>>(() => new Set());
  const [chatScrollOffsetRows, setChatScrollOffsetRows] = useState(0);
  const [drawerScrollOffsetRows, setDrawerScrollOffsetRows] = useState(0);
  const [rightPaneScrollOffsetRows, setRightPaneScrollOffsetRows] = useState(0);
  const [inspectedSubagentId, setInspectedSubagentId] = useState<string | null>(null);
  // Real daemon-backed child transcript for the inspected subagent (Codex/OpenCode);
  // keyed by subagent id so a stale fetch never bleeds into a different agent. Null
  // ⇒ fall back to the locally-reconstructed transcript.
  const [realSubagentTranscript, setRealSubagentTranscript] = useState<{ id: string; status: SubagentSnapshot["status"]; envelopes: AgentChatEventEnvelope[] } | null>(null);
  const [realMainTranscript, setRealMainTranscript] = useState<{ sessionId: string; envelopes: AgentChatEventEnvelope[] } | null>(null);
  const unavailableSubagentTranscriptKeysRef = useRef<Set<string>>(new Set());
  const [mentionSuggestions, setMentionSuggestions] = useState<MentionSuggestion[]>([]);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [selectedMentions, setSelectedMentions] = useState<MentionSuggestion[]>([]);
  const [attachmentFocusIndex, setAttachmentFocusIndex] = useState<number | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [commandPaletteQuery, setCommandPaletteQuery] = useState("");
  const [commandPaletteIndex, setCommandPaletteIndex] = useState(0);
  // Universal-search results merged BELOW the local command/lane/chat matches.
  // A monotonically-increasing generation guards against a slow response
  // overwriting a newer one (or one from an already-closed palette).
  const [paletteSearchResults, setPaletteSearchResults] = useState<SearchResultItem[]>([]);
  const paletteSearchGenerationRef = useRef(0);
  // /help command reference: live filter, focused row, and a small in-memory
  // recents list (most-recent-first) that floats lately-run commands to the top.
  const [helpFilterQuery, setHelpFilterQuery] = useState("");
  const [helpSelectedIndex, setHelpSelectedIndex] = useState(0);
  const [helpRecents, setHelpRecents] = useState<string[]>([]);
  const helpRecentsRef = useRef<string[]>([]);
  helpRecentsRef.current = helpRecents;
  const rightChatsQueryRef = useRef("");
  // Session the open "Snooze session" duration palette will act on. Held in a
  // ref rather than on the pane so the existing list-activation signature
  // (selectedId + action kind) stays unchanged — the selected row is a duration
  // key, not a session id.
  const pendingSnoozeSessionIdRef = useRef<string | null>(null);
  // Latest session rows, readable from callbacks defined above the memo that
  // builds them. Only used for lifecycle lookups on selection.
  const displaySessionsRef = useRef<AgentChatSessionSummary[]>([]);
  // Indexed (grouped, keybind-enriched) command reference. Rebuilt only when the
  // user's Claude keybinding registry changes, so keybind chips reflect config.
  /**
   * The user's bindings with plugin-declared defaults folded in underneath.
   *
   * The precedence and the plugin-vs-plugin arbitration are the shared matrix's
   * (`desktop/src/shared/plugins/keybindings.ts`), not this file's, so a chord
   * ADE Code refuses is refused in the desktop app for the same stated reason.
   * Refusals are logged once each rather than dropped: a shortcut that silently
   * does nothing is exactly what the matrix exists to prevent.
   */
  const mergedKeybindings = useMemo(
    () => mergePluginKeybindings(pluginKeybindingRoster, keybindings),
    [keybindings, pluginKeybindingRoster],
  );

  /**
   * The plugin roster as the shared built-in-surface gate wants it.
   *
   * The same rows the keybinding matrix reads, narrowed to the two fields the
   * gate needs. An empty roster — before the first poll, on a host with no
   * plugin support, after a failed read — is the "cannot know" case, and the
   * gate resolves it per surface: a superseded surface such as Cursor Cloud
   * stays available, so the terminal is unchanged on a machine that has no
   * plugins at all.
   */
  const pluginInstallRecords = useMemo(
    () => pluginKeybindingRoster.map((plugin) => ({
      pluginId: plugin.pluginId,
      enabled: plugin.enabled,
    })),
    [pluginKeybindingRoster],
  );
  const pluginKeybindingRowsRef = useRef<ClaudeKeybinding[]>([]);
  pluginKeybindingRowsRef.current = mergedKeybindings.pluginBindings;
  const loggedKeybindingRefusalsRef = useRef<Set<string>>(new Set());
  const helpIndexGroups = useMemo(
    () => buildHelpIndex(BUILTIN_COMMANDS, keybindings, mergedKeybindings.pluginBindings),
    [keybindings, mergedKeybindings.pluginBindings],
  );
  // The sessions pane is SESSION-FIRST: there is no lanes-vs-chats mode to
  // switch between any more. Its whole navigable state is one selected row key
  // over one flat row list (`workListModel`), plus which quiet shelves are open.
  const [workSelectedKey, setWorkSelectedKey] = useState<string | null>(null);
  // Shared attention snapshot: the /activity pane already fetches it, and the
  // sessions pane reads the same copy for its cross-machine rows. Deliberately
  // ONE cache and no second poll loop — `refreshState` tops it up on the
  // cadence the app already runs.
  const [attentionSnapshot, setAttentionSnapshot] = useState<AttentionSnapshot | null>(null);
  const [workExpandedShelves, setWorkExpandedShelves] = useState<Set<WorkListShelfKind>>(() => new Set());
  const [drawerPreviewSessionId, setDrawerPreviewSessionId] = useState<string | null>(null);
  const [drawerPreviewEvents, setDrawerPreviewEvents] = useState<AgentChatEventEnvelope[]>([]);
  const [drawerLaneId, setDrawerLaneId] = useState<string | null>(null);
  const [selectedDrawerLaneId, setSelectedDrawerLaneId] = useState<string | null>(null);
  const [selectedDrawerChatId, setSelectedDrawerChatId] = useState<string | null>(null);
  const [selectedWorkChatAction, setSelectedWorkChatAction] = useState<WorkChatAction | null>(null);
  const [, setFormDiscardArmedState] = useState(false);
  const [formConfirmArmed, setFormConfirmArmedState] = useState(false);
  const [footerControl, setFooterControl] = useState<FooterControl | null>(null);
  const [inlineRowFocus, setInlineRowFocus] = useState<{ cell: InlineRowCellName | null }>({ cell: null });
  const inlineRowFocused = inlineRowFocus.cell !== null;
  // Cross-surface model picker favorites/recents — authoritative copy lives in ade-cli.
	  const [modelPickerFavorites, setModelPickerFavorites] = useState<string[]>([]);
	  const [modelPickerRecents, setModelPickerRecents] = useState<string[]>([]);
	  const [modelCatalog, setModelCatalog] = useState<AgentChatModelCatalog | null>(null);
	  const [modelCatalogRefreshingProvider, setModelCatalogRefreshingProvider] = useState<AgentChatModelCatalogRefreshProvider | null>(null);

  const connectionRef = useRef<AdeCodeConnection | null>(null);
  const analyticsAppOpenedRef = useRef(false);
  const lastAnalyticsScreenRef = useRef<string | null>(null);
  const connectionLostRef = useRef(false);
  const activeLaneIdRef = useRef<string | null>(null);
  const activeSessionIdRef = useRef<string | null>(project.sessionHint);
  const initialSessionHintRef = useRef<string | null>(project.sessionHint);
  const multiViewRef = useRef<MultiViewState | null>(null);
  const gridViewActiveRef = useRef(false);
  // Show/hide the grid without destroying it. Sets the ref synchronously so the
  // input/submit paths read the new value immediately (before the re-render).
  // Declared early because navigation handlers above the grid helpers use it.
  const setGridView = useCallback((active: boolean) => {
    gridViewActiveRef.current = active;
    setGridViewActive(active);
  }, []);
  const addModeRef = useRef<AddModeState | null>(null);
  const streamingBySessionIdRef = useRef<Record<string, boolean>>({});
  const interruptedBySessionIdRef = useRef<Record<string, boolean>>({});
  const eventsBySessionIdRef = useRef<Record<string, AgentChatEventEnvelope[]>>({});
  const promptHistoryBySessionIdRef = useRef<Record<string, string[]>>({});
  const dragAddSessionRef = useRef<MultiViewTile | null>(null);
  const hitTestRegistryRef = useRef(createHitTestRegistry());
  const hoveredTargetRef = useRef<HitTarget | null>(null);
  const appHitTargetIdsRef = useRef<string[]>([]);
  // Chat link click-targets are registered in their own effect (keyed on the
  // visible rows) so they track scrolling/streaming without rebuilding the
  // whole app hit-target set on every coalesced flush.
  const chatLinkTargetIdsRef = useRef<string[]>([]);
  const previousDimensionsRef = useRef<[number, number]>([columns, rows]);
  // Per-session composer drafts (text + caret + image attachments), stashed on
  // the way out of a chat and restored on the way back in. Process-local by
  // design — see composerDrafts.ts.
  const composerDraftsRef = useRef(createComposerDraftStore());
  const promptImageAttachmentsRef = useRef<ComposerDraftAttachment[]>([]);
  const draftChatActiveRef = useRef(false);
  // Each new-chat draft gets a fresh notice scope key so transient feedback
  // ("Model set to…", "Press Esc again…") fired in one draft can't persist into
  // the next. A monotonic counter keys each draft; the ref mirrors the state so
  // addNotice can tag notices synchronously inside callbacks.
  const draftScopeSeqRef = useRef(0);
  const draftScopeKeyRef = useRef<string | null>(null);
  const formDiscardArmedRef = useRef(false);
  const formConfirmArmedRef = useRef(false);
  const activePaneRef = useRef<PaneFocus>("chat");
  const keybindingDispatchStateRef = useRef<KeybindingDispatchState>({ prefix: null, prefixAt: 0 });
  const footerControlRef = useRef<FooterControl | null>(null);
  const paneBeforeDetailsRef = useRef<PaneFocus>("chat");
  const chatDraftRef = useRef("");
  const setFormDiscardArmed = useCallback((next: boolean) => {
    formDiscardArmedRef.current = next;
    setFormDiscardArmedState(next);
  }, []);
  const setFormConfirmArmed = useCallback((next: boolean) => {
    formConfirmArmedRef.current = next;
    setFormConfirmArmedState(next);
  }, []);
  const promptRef = useRef("");
  const promptCursorRef = useRef(0);
  const bracketedPasteStateRef = useRef<BracketedPasteState>(EMPTY_BRACKETED_PASTE_STATE);
  const submitRightFormInFlightRef = useRef(false);
  const backgroundLaunchSeqRef = useRef(0);
  const previousPromptValueRef = useRef("");
  const promptHistoryRef = useRef<string[]>([]);
  const promptHistoryIndexRef = useRef<number | null>(null);
  const promptHistoryDraftRef = useRef("");
  const promptHistoryIndexBySessionIdRef = useRef<Record<string, number | null>>({});
  const promptHistoryDraftBySessionIdRef = useRef<Record<string, string>>({});
  const rightPaneKindRef = useRef<RightPaneContent["kind"]>("empty");
  // Full right-pane mirror so async draft-commit paths (first send) can check
  // the CURRENT pane without stale-closure state (see showChatInfoAfterDraftCommit).
  const rightPaneRef = useRef<RightPaneContent>({ kind: "empty" });
  const externalSessionListGenerationRef = useRef(0);
  // Claim imports synchronously, before React has mirrored importingKey into
  // rightPaneRef. This prevents a rapid double-Enter from creating two copies.
  const externalSessionImportInFlightRef = useRef(false);
  const lastLocalSendAtRef = useRef<number>(0);
  const eventsRef = useRef<AgentChatEventEnvelope[]>([]);
  const eventCountRef = useRef<number>(0);
  const eventDedupKeysRef = useRef<Set<string>>(new Set());
  const eventDedupKeyOrderRef = useRef<string[]>([]);
  // Streaming-event coalescing: buffer incoming envelopes and flush them in one
  // batched render on a short timer (see flushPendingChatEvents / scheduleChatFlush).
  const pendingChatEnvelopesRef = useRef<AgentChatEventEnvelope[]>([]);
  const chatFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const backgroundRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const backgroundRefreshInFlightRef = useRef(false);
  const backgroundRefreshPendingAfterInFlightRef = useRef(false);
  const refreshGenerationRef = useRef(0);
  const chatScrollOffsetRowsRef = useRef(0);
  const chatScrollMaxOffsetRef = useRef(0);
  const lastSeenAtBottomEventCountRef = useRef(0);
  const newChatPreviewLaneIdRef = useRef<string | null>(null);
  const heartbeatRef = useRef<TuiHeartbeat | null>(null);
  const connectionRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mentionRemoteCacheRef = useRef<Map<string, MentionRemoteCacheEntry>>(new Map());
  const draftSeededFromHistoryRef = useRef(false);
  const initialNewChatPreviewRef = useRef(true);
  const attachProbeInFlightRef = useRef(false);
  const lastChatByLaneRef = useRef<Map<string, string>>(new Map(Object.entries(initialAdeCodeState.lastChatByLane)));
  const lastLaneIdRef = useRef<string | null>(initialAdeCodeState.lastLaneId);
  const draftKindRef = useRef<AdeCodeInterfaceMode>(initialAdeCodeState.draftKind);
  const lastChatByLaneWriteTimerRef = useRef<NodeJS.Timeout | null>(null);
  const pendingNewChatTitleRef = useRef<string | null>(null);
  const lastUserOpenedPaneRef = useRef<RightPaneContent["kind"] | null>(null);
  // Sessions for which the chat-info pane has already auto-opened on its first
  // subagent (once per session, mirroring desktop's subagent auto-open).
  const subagentAutoOpenedSessionsRef = useRef<Set<string>>(new Set());
  const userDismissedRightPaneRef = useRef(false);
  const activeSessionRef = useRef<AgentChatSessionSummary | null>(null);
  const sessionsRef = useRef<AgentChatSessionSummary[]>([]);
  const optimisticChatSessionsRef = useRef<Map<string, AgentChatSessionSummary>>(new Map());
  const optimisticTerminalSessionsRef = useRef<Map<string, ChatTerminalSession>>(new Map());
  const activeTerminalSessionRef = useRef<ChatTerminalSession | null>(null);
  const terminalSessionsRef = useRef<ChatTerminalSession[]>([]);
  const attachedTerminalIdRef = useRef<string | null>(null);
  // When Ctrl+T control is entered from a grid tile, remember the tile's session id
  // so exiting control (Ctrl+T / Ctrl+]) drops back into the grid focused on it.
  const controlReturnToGridRef = useRef<string | null>(null);
  // Show the auto-naming directive once per process when the first Claude CLI
  // session is created, so the "naming…" loading hint has context.
  const claudeAutoNamingHintShownRef = useRef(false);
  const claudeTerminalSubmitQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const lastModelPickerClaudeSentKeyRef = useRef<string | null>(null);
  const exitRequestedRef = useRef(false);
  const modelStateRef = useRef<AdeCodeModelState>(
    seedModelStateFromMemory(initialModelState(initialAdeCodeState.draftKind), initialModelMemory),
  );
  const chatMouseSelectionRef = useRef<ChatSelectionState | null>(null);
  const chatSelectionAnchorRef = useRef<ChatSelectionPoint | null>(null);
  const selectableChatRowCountRef = useRef(0);
  const selectableChatRowTextBuilderRef = useRef<() => string[]>(() => []);
  const drawerPreviewGenerationRef = useRef(0);
  const drawerOpenRef = useRef(true);
  const drawerLaneIdRef = useRef<string | null>(null);
  const selectedDrawerChatIdRef = useRef<string | null>(null);
  const selectedWorkChatActionRef = useRef<WorkChatAction | null>(null);
  const clearedAtRef = useRef<string | null>(null);
  const chatSelectionEdgeScrollTimerRef = useRef<NodeJS.Timeout | null>(null);
  const chatSelectionEdgeScrollRef = useRef<{ direction: ChatSelectionEdgeDirection; column: number } | null>(null);
  const ctrlCExitArmedUntilRef = useRef(0);
  const ctrlCExitTimerRef = useRef<NodeJS.Timeout | null>(null);
  const loadedSessionIdRef = useRef<string | null>(null);
  // Scroll-back pagination cursor, per session. Seeded from the hydration
  // snapshot's tailStartOffset; advanced one transcript page at a time as the
  // user scrolls to the top of the loaded transcript. `loading` +
  // `lastRequestedBeforeOffset` guard a single in-flight fetch per session and
  // prevent refetching the same cursor position.
  const olderHistoryCursorBySessionIdRef = useRef<Record<string, {
    beforeOffset: number;
    hasMore: boolean;
    loading: boolean;
    lastRequestedBeforeOffset: number | null;
  }>>({});
  // Snapshot remainder, per session: the hydration snapshot's deduped events
  // OLDER than the displayed window. Drained locally (newest chunk first) on
  // scroll-back BEFORE the byte cursor is touched — tailStartOffset is only
  // contiguous with the FULL snapshot tail, not with the displayed 500-event
  // window, so paging the network cursor with this buffer unread would leave
  // a silent gap in the transcript.
  const olderSnapshotBufferBySessionIdRef = useRef<Record<string, AgentChatEventEnvelope[]>>({});
  // Render mirror of the cursor for the "↑ loading earlier…" indicator.
  const [olderHistoryStatusBySessionId, setOlderHistoryStatusBySessionId] = useState<Record<string, OlderHistoryStatus>>({});
  const detachedHistorySessionIdsRef = useRef(new Set<string>());
  const detachedLiveEventsBySessionIdRef = useRef<Record<string, AgentChatEventEnvelope[]>>({});
  const returningHistoryToLatestSessionIdsRef = useRef(new Set<string>());
	  const providerModelsCacheRef = useRef<Map<string, AgentChatModelInfo[]>>(new Map());
	  const modelCatalogRef = useRef<AgentChatModelCatalog | null>(null);
		  const modelCatalogProviderRefreshedAtRef = useRef<Map<string, number>>(new Map());
	  const modelCatalogRefreshSequenceRef = useRef(0);
  const pendingModelCommitTimerRef = useRef<NodeJS.Timeout | null>(null);
  const pendingModelCommitStateRef = useRef<AdeCodeModelState | null>(null);

  useEffect(() => {
    multiViewRef.current = multiView;
  }, [multiView]);

  useEffect(() => {
    if (!connection) {
      setAccountLabel("account loading…");
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const raw = await connection.request<unknown>("account.call", { action: "status", args: {} });
        if (cancelled) return;
        const envelope = raw && typeof raw === "object" && !Array.isArray(raw)
          ? raw as Record<string, unknown>
          : {};
        const result = envelope.result && typeof envelope.result === "object" && !Array.isArray(envelope.result)
          ? envelope.result as Record<string, unknown>
          : envelope;
        if (result.signedIn !== true) {
          // Signed out, expired, and "couldn't read it" all report
          // signedIn: false and need different words — pointing at `ade login`
          // over a merely unreadable session is how a valid one gets replaced.
          setAccountLabel(
            accountSessionLabel(accountSessionStateFromResult(result))
              ?? "account signed out · ade login",
          );
          return;
        }
        const identity = [result.email, result.name, result.userId]
          .find((value): value is string => typeof value === "string" && value.trim().length > 0);
        setAccountLabel(`account ${identity?.trim() ?? "signed in"}`);
      } catch {
        if (!cancelled) setAccountLabel("account unavailable");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connection]);

  useEffect(() => {
    addModeRef.current = addMode;
  }, [addMode]);


  useEffect(() => {
    streamingBySessionIdRef.current = streamingBySessionId;
  }, [streamingBySessionId]);

  useEffect(() => {
    interruptedBySessionIdRef.current = interruptedBySessionId;
  }, [interruptedBySessionId]);

  useEffect(() => {
    eventsBySessionIdRef.current = eventsBySessionId;
  }, [eventsBySessionId]);

  useEffect(() => {
    eventsRef.current = events;
  }, [events]);

  useEffect(() => {
    promptHistoryBySessionIdRef.current = promptHistoryBySessionId;
  }, [promptHistoryBySessionId]);

  const setSessionStreaming = useCallback((sessionId: string | null | undefined, value: boolean) => {
    if (!sessionId) {
      if (!value) setStreamingBySessionId({});
      return;
    }
    setStreamingBySessionId((prev) => {
      if ((prev[sessionId] ?? false) === value) return prev;
      return { ...prev, [sessionId]: value };
    });
  }, []);

  const setStreaming = useCallback((value: boolean) => {
    setSessionStreaming(activeSessionIdRef.current, value);
  }, [setSessionStreaming]);

  const setSessionInterrupted = useCallback((sessionId: string | null | undefined, value: boolean) => {
    if (!sessionId) {
      if (!value) setInterruptedBySessionId({});
      return;
    }
    setInterruptedBySessionId((prev) => {
      if ((prev[sessionId] ?? false) === value) return prev;
      return { ...prev, [sessionId]: value };
    });
  }, []);

  const streaming = activeSessionId ? !!streamingBySessionId[activeSessionId] : false;

  const saveCurrentAdeCodeState = useCallback(() => {
    if (remoteLaunch) return;
    const lastChatByLane: Record<string, string> = {};
    for (const [laneId, sessionId] of lastChatByLaneRef.current) {
      lastChatByLane[laneId] = sessionId;
    }
    saveAdeCodeProjectState(project.projectRoot, {
      lastChatByLane,
      lastLaneId: lastLaneIdRef.current,
      draftKind: draftKindRef.current,
    });
  }, [project.projectRoot, remoteLaunch]);

  const flushPendingAdeCodeState = useCallback(async () => {
    if (lastChatByLaneWriteTimerRef.current) {
      clearTimeout(lastChatByLaneWriteTimerRef.current);
      lastChatByLaneWriteTimerRef.current = null;
      saveCurrentAdeCodeState();
    }
    await flushAdeCodeStateWrites();
  }, [saveCurrentAdeCodeState]);

  const persistAdeCodeState = useCallback(() => {
    if (remoteLaunch) return;
    if (lastChatByLaneWriteTimerRef.current) {
      clearTimeout(lastChatByLaneWriteTimerRef.current);
    }
    lastChatByLaneWriteTimerRef.current = setTimeout(() => {
      lastChatByLaneWriteTimerRef.current = null;
      saveCurrentAdeCodeState();
    }, 500);
  }, [remoteLaunch, saveCurrentAdeCodeState]);

  const persistExplicitDraftKind = useCallback((draftKind: AdeCodeInterfaceMode) => {
    draftKindRef.current = draftKind;
    persistAdeCodeState();
  }, [persistAdeCodeState]);

  const setChatScrollOffset = useCallback((value: number | ((previous: number) => number)) => {
    const multiSessionId = (gridViewActiveRef.current ? focusedSessionIdForMultiView(multiViewRef.current) : null);
    if (multiSessionId) {
      setScrollBySessionId((prev) => {
        const previous = prev[multiSessionId] ?? 0;
        const raw = typeof value === "function" ? value(previous) : value;
        return { ...prev, [multiSessionId]: clampChatScrollOffsetRows(raw, chatScrollMaxOffsetRef.current) };
      });
      return;
    }
    setChatScrollOffsetRows((previous) => {
      const raw = typeof value === "function" ? value(previous) : value;
      const next = clampChatScrollOffsetRows(raw, chatScrollMaxOffsetRef.current);
      chatScrollOffsetRowsRef.current = next;
      return next;
    });
  }, []);

  /**
   * Seed (or reset) the scroll-back cursor for a freshly hydrated session.
   * A positive cursor means the snapshot's tail began mid-transcript and older
   * history can be paged in; null/undefined/0 means nothing to page. Callers
   * pass the cursor already resolved by `resolveSnapshotHistoryCursor`, which
   * honours the host's authoritative `hasOlderHistory` signal.
   */
  const seedOlderHistoryCursor = useCallback((sessionId: string, tailStartOffset: number | null | undefined) => {
    detachedHistorySessionIdsRef.current.delete(sessionId);
    delete detachedLiveEventsBySessionIdRef.current[sessionId];
    const pageable = tailStartOffset != null && tailStartOffset > 0;
    if (pageable) {
      olderHistoryCursorBySessionIdRef.current[sessionId] = {
        beforeOffset: tailStartOffset,
        hasMore: true,
        loading: false,
        lastRequestedBeforeOffset: null,
      };
    } else {
      delete olderHistoryCursorBySessionIdRef.current[sessionId];
    }
    setOlderHistoryStatusBySessionId((prev) => {
      if (pageable) return { ...prev, [sessionId]: "available" };
      if (!(sessionId in prev)) return prev;
      const { [sessionId]: _dropped, ...rest } = prev;
      return rest;
    });
  }, []);

  const clearOlderHistoryCursor = useCallback((sessionId: string | null) => {
    if (!sessionId) return;
    delete olderHistoryCursorBySessionIdRef.current[sessionId];
    delete olderSnapshotBufferBySessionIdRef.current[sessionId];
    detachedHistorySessionIdsRef.current.delete(sessionId);
    delete detachedLiveEventsBySessionIdRef.current[sessionId];
    setOlderHistoryStatusBySessionId((prev) => {
      if (!(sessionId in prev)) return prev;
      const { [sessionId]: _dropped, ...rest } = prev;
      return rest;
    });
  }, []);

  const captureHydratedEventsWatermark = useCallback((sessionId: string) => (
    captureTuiHistoryArrivalWatermark([
      ...(eventsBySessionIdRef.current[sessionId] ?? []),
      ...pendingChatEnvelopesRef.current.filter((envelope) => envelope.sessionId === sessionId),
    ])
  ), []);

  const mergeHydratedEventsWithLive = useCallback((
    sessionId: string,
    displayEvents: AgentChatEventEnvelope[],
    arrivalWatermark: ReadonlySet<string>,
  ) => {
    const existing = eventsBySessionIdRef.current[sessionId] ?? [];
    const pending = pendingChatEnvelopesRef.current.filter((envelope) => envelope.sessionId === sessionId);
    if (detachedHistorySessionIdsRef.current.has(sessionId)) {
      // The cached resident window now represents the OLDEST loaded slice.
      // Never append it after a fresh tail snapshot or it can displace the
      // latest events. Only live events buffered while detached continue it.
      return mergeDetachedTuiHistoryTail(
        displayEvents,
        [...(detachedLiveEventsBySessionIdRef.current[sessionId] ?? []), ...pending],
      );
    }
    if (existing.length === 0 && pending.length === 0) return displayEvents;
    return mergeHydratedTuiHistory(displayEvents, existing, pending, arrivalWatermark);
  }, []);

  const commitActiveSessionEvents = useCallback((
    sessionId: string,
    nextEvents: AgentChatEventEnvelope[],
    eventCount = nextEvents.length,
  ) => {
    eventDedupKeyOrderRef.current = syncTuiEventDedupKeys(eventDedupKeysRef.current, nextEvents);
    eventCountRef.current = eventCount;
    eventsRef.current = nextEvents;
    setEvents(nextEvents);
    setEventsBySessionId((prev) => ({ ...prev, [sessionId]: nextEvents }));
  }, []);

  const clearTranscriptPreview = useCallback(() => {
    clearOlderHistoryCursor(activeSessionIdRef.current);
    eventDedupKeysRef.current.clear();
    eventDedupKeyOrderRef.current = [];
    eventCountRef.current = 0;
    eventsRef.current = [];
    setEvents([]);
    setClearedAt(null);
    setCurrentGoal(null);
    setContextPercent(null);
    setTokenSummary(null);
    setStatusLineStats(null);
    setStreaming(false);
    setSessionInterrupted(activeSessionIdRef.current, false);
    setInterrupted(false);
  }, [clearOlderHistoryCursor, setSessionInterrupted, setStreaming]);

  const selectActiveLaneId = useCallback((laneId: string | null) => {
    if (activeLaneIdRef.current !== laneId) {
      setChatScrollOffset(0);
      chatSelectionAnchorRef.current = null;
      chatMouseSelectionRef.current = null;
      setChatMouseSelection(null);
    }
    activeLaneIdRef.current = laneId;
    setActiveLaneId(laneId);
    if (laneId && lastLaneIdRef.current !== laneId) {
      lastLaneIdRef.current = laneId;
      persistAdeCodeState();
    }
  }, [persistAdeCodeState, setChatScrollOffset]);

  /**
   * Drop a row's "woke" marker once the user has actually looked at it.
   *
   * Fire-and-forget by design: a failed clear must never block or delay opening
   * the session, and it must never print — stray stdout would corrupt the Ink
   * frame, so unlike desktop's console.error this swallows (iOS does the same
   * with `try?`). The next refresh simply leaves the marker up.
   */
  const clearWokeMarkerOnVisit = useCallback((sessionId: string | null): void => {
    const conn = connectionRef.current;
    if (!conn) return;
    // The persisted-vs-derived guard and the fire-and-forget live in
    // sessionLifecycle.ts so they are testable without rendering the app.
    clearSessionWokeMarkerOnVisit({
      sessionId,
      sessions: displaySessionsRef.current as TuiChatSessionSummary[],
      clear: (id) => clearSessionWokeMarker(conn, id),
    });
  }, []);

  const selectActiveSessionId = useCallback((sessionId: string | null) => {
    if (activeSessionIdRef.current !== sessionId) {
      // Stash the outgoing chat's draft and load the incoming one. Doing it
      // here — the single funnel every "put a session on screen" path goes
      // through — is what keeps a half-written prompt (and any image token in
      // it) tied to the chat it was written for, instead of following the user
      // into the next chat.
      // Prefer the live prompt over the stashed copy: some composer paths
      // (mention insertion) update the prompt without writing chatDraftRef,
      // and the draft we stash must be what is actually on screen.
      const outgoingText = activePaneRef.current === "chat"
        ? (promptRef.current || chatDraftRef.current)
        : chatDraftRef.current;
      saveComposerDraft(composerDraftsRef.current, activeSessionIdRef.current, {
        text: outgoingText,
        cursor: promptCursorRef.current,
        attachments: promptImageAttachmentsRef.current,
      });
      const incoming = readComposerDraft(composerDraftsRef.current, sessionId);
      promptImageAttachmentsRef.current = incoming.attachments;
      chatDraftRef.current = incoming.text;
      // Inlined rather than calling setPromptValue: that callback is declared
      // further down this component, so naming it in the dependency array here
      // would be a temporal-dead-zone ReferenceError during render.
      if (activePaneRef.current === "chat") {
        const restoredCursor = clampPromptCursor(incoming.text, incoming.cursor);
        promptRef.current = incoming.text;
        promptCursorRef.current = restoredCursor;
        setPromptCursor(restoredCursor);
        setAttachmentFocusIndex(null);
        setPrompt(incoming.text);
      }
      setChatScrollOffset(0);
      setCurrentGoal(null);
      lastUserOpenedPaneRef.current = null;
      chatSelectionAnchorRef.current = null;
      chatMouseSelectionRef.current = null;
      setChatMouseSelection(null);
      // Opening the row IS the acknowledgement — the "woke" marker only exists
      // to explain an unexpected return, so it goes as soon as it is seen
      // (desktop TerminalsPage.handleSelectSession / iOS openSession parity).
      // Every path that puts a session on screen funnels through here, and the
      // persisted-wokeAt guard keeps it to rows that have something to clear.
      clearWokeMarkerOnVisit(sessionId);
    }
    if (!sessionId) {
      activeTerminalSessionRef.current = null;
      clearTranscriptPreview();
      setAttachedTerminalId(null);
    }
    if (sessionId) {
      newChatPreviewLaneIdRef.current = null;
      draftChatActiveRef.current = false;
      setDraftChatActive(false);
      setSelectedWorkChatAction(null);
      const laneId = activeLaneIdRef.current;
      if (laneId && lastChatByLaneRef.current.get(laneId) !== sessionId) {
        lastChatByLaneRef.current.set(laneId, sessionId);
        persistAdeCodeState();
      }
    }
    activeSessionIdRef.current = sessionId;
    setActiveSessionId(sessionId);
  }, [clearTranscriptPreview, clearWokeMarkerOnVisit, persistAdeCodeState, setChatScrollOffset]);

  const setDraftChatMode = useCallback((active: boolean) => {
    setChatScrollOffset(0);
    // Mint a fresh scope key on every draft entry (each call is a deliberate
    // new-chat action) and drop it on exit, so notices tagged to a previous
    // draft never render in a new one.
    if (active) {
      draftScopeSeqRef.current += 1;
      const key = `draft:${draftScopeSeqRef.current}`;
      draftScopeKeyRef.current = key;
      setDraftScopeKey(key);
    } else {
      draftScopeKeyRef.current = null;
      setDraftScopeKey(null);
    }
    draftChatActiveRef.current = active;
    setDraftChatActive(active);
  }, [setChatScrollOffset]);

  const setPaneFocus = useCallback((pane: PaneFocus) => {
    activePaneRef.current = pane;
    setActivePane(pane);
  }, []);

  useEffect(() => {
    const previous = previousDimensionsRef.current;
    previousDimensionsRef.current = [columns, rows];
    if (addModeRef.current && (previous[0] !== columns || previous[1] !== rows)) {
      setAddMode(null);
      setPaneFocus("chat");
    }
  }, [columns, rows, setPaneFocus]);

  const selectFooterControl = useCallback((control: FooterControl | null) => {
    footerControlRef.current = control;
    setFooterControl(control);
  }, []);

  useEffect(() => {
    clearedAtRef.current = clearedAt;
    drawerOpenRef.current = drawerOpen;
    drawerLaneIdRef.current = drawerLaneId;
    selectedDrawerChatIdRef.current = selectedDrawerChatId;
    selectedWorkChatActionRef.current = selectedWorkChatAction;
  }, [
    clearedAt,
    drawerLaneId,
    drawerOpen,
    selectedWorkChatAction,
    selectedDrawerChatId,
  ]);

  useEffect(() => {
    promptRef.current = prompt;
    previousPromptValueRef.current = prompt;
    const safeCursor = clampPromptCursor(prompt, promptCursorRef.current);
    if (safeCursor !== promptCursorRef.current) {
      promptCursorRef.current = safeCursor;
      setPromptCursor(safeCursor);
    }
  }, [prompt]);

  const setPromptValue = useCallback((value: string, cursor: number = value.length) => {
    const safeCursor = clampPromptCursor(value, cursor);
    promptRef.current = value;
    promptCursorRef.current = safeCursor;
    setPromptCursor(safeCursor);
    setAttachmentFocusIndex(null);
    setPrompt(value);
  }, []);

  useEffect(() => {
    chatMouseSelectionRef.current = chatMouseSelection;
    const focusedSessionId = (gridViewActiveRef.current ? focusedSessionIdForMultiView(multiViewRef.current) : null);
    if (focusedSessionId) {
      setSelectionBySessionId((prev) => ({ ...prev, [focusedSessionId]: chatMouseSelection }));
    }
  }, [chatMouseSelection]);

  useEffect(() => {
    const summary = permissionSummary(modelState);
    const previous = lastPermissionSummaryRef.current;
    lastPermissionSummaryRef.current = summary;
    if (previous == null || previous === summary) return;
    if (!userInitiatedModeChangeRef.current) return;
    userInitiatedModeChangeRef.current = false;
    const key = `${Date.now()}:${summary}`;
    setModeChangeNotice({ summary, key });
    if (modeNoticeTimerRef.current) clearTimeout(modeNoticeTimerRef.current);
    modeNoticeTimerRef.current = setTimeout(() => {
      setModeChangeNotice((prev) => (prev?.key === key ? null : prev));
      modeNoticeTimerRef.current = null;
    }, 3000);
  }, [modelState]);

  const updateChatMouseSelection = useCallback((selection: ChatSelectionState | null) => {
    chatMouseSelectionRef.current = selection;
    setChatMouseSelection(selection);
  }, []);

  const stopChatSelectionEdgeScroll = useCallback(() => {
    chatSelectionEdgeScrollRef.current = null;
    if (chatSelectionEdgeScrollTimerRef.current) {
      clearInterval(chatSelectionEdgeScrollTimerRef.current);
      chatSelectionEdgeScrollTimerRef.current = null;
    }
  }, []);

  const stepChatSelectionEdgeScroll = useCallback(() => {
    const edge = chatSelectionEdgeScrollRef.current;
    const selection = chatMouseSelectionRef.current;
    if (!edge || !selection?.active) {
      stopChatSelectionEdgeScroll();
      return;
    }
    const rowCount = selectableChatRowCountRef.current;
    if (!rowCount) {
      stopChatSelectionEdgeScroll();
      return;
    }
    if (
      (edge.direction === "older" && selection.endRow <= 0 && chatScrollOffsetRowsRef.current >= chatScrollMaxOffsetRef.current)
      || (edge.direction === "newer" && selection.endRow >= rowCount - 1 && chatScrollOffsetRowsRef.current <= 0)
    ) {
      stopChatSelectionEdgeScroll();
      return;
    }
    const rowDelta = edge.direction === "older" ? -1 : 1;
    updateChatMouseSelection(moveChatSelectionFocusByRows(selection, rowDelta, rowCount, edge.column));
    setChatScrollOffset((offset) => offset + (edge.direction === "older" ? 1 : -1));
  }, [setChatScrollOffset, stopChatSelectionEdgeScroll, updateChatMouseSelection]);

  const startChatSelectionEdgeScroll = useCallback((direction: ChatSelectionEdgeDirection, column: number) => {
    chatSelectionEdgeScrollRef.current = { direction, column };
    if (chatSelectionEdgeScrollTimerRef.current) return;
    stepChatSelectionEdgeScroll();
    chatSelectionEdgeScrollTimerRef.current = setInterval(stepChatSelectionEdgeScroll, CHAT_SELECTION_EDGE_SCROLL_MS);
  }, [stepChatSelectionEdgeScroll]);

  useEffect(() => () => {
    stopChatSelectionEdgeScroll();
    if (ctrlCExitTimerRef.current) clearTimeout(ctrlCExitTimerRef.current);
  }, [stopChatSelectionEdgeScroll]);

  const stashActiveInput = useCallback(() => {
    const pane = activePaneRef.current;
    if (pane === "chat") {
      chatDraftRef.current = promptRef.current;
      return;
    }
    if (pane === "details" && rightPane.kind === "form") {
      const field = rightPane.fields[formFieldIndex] ?? rightPane.fields[0];
      if (field && formFieldUsesPromptInput(rightPane.command, field.name)) {
        setFormValues((prev) => ({ ...prev, [field.name]: promptRef.current }));
      }
    }
  }, [formFieldIndex, rightPane]);

  const focusChat = useCallback(() => {
    stashActiveInput();
    setFormDiscardArmed(false);
    selectFooterControl(null);
    setPromptValue(chatDraftRef.current);
    setPaneFocus("chat");
  }, [selectFooterControl, setPaneFocus, setPromptValue, stashActiveInput]);

  const focusDrawer = useCallback(() => {
    stashActiveInput();
    setFormDiscardArmed(false);
    selectFooterControl(null);
    setPromptValue("");
    setDrawerOpen(true);
    setPaneFocus("drawer");
  }, [selectFooterControl, setPaneFocus, setPromptValue, stashActiveInput]);

  const focusDrawerOnly = useCallback(() => {
    stashActiveInput();
    setFormDiscardArmed(false);
    selectFooterControl(null);
    setPromptValue("");
    setPaneFocus("drawer");
  }, [selectFooterControl, setPaneFocus, setPromptValue, stashActiveInput]);

  const focusDetails = useCallback(() => {
    const previousPane = activePaneRef.current;
    stashActiveInput();
    selectFooterControl(null);
    if (previousPane !== "details") {
      paneBeforeDetailsRef.current = previousPane;
    }
    setFormDiscardArmed(false);
    userDismissedRightPaneRef.current = false;
    setRightOpen(true);
    if (rightPane.kind === "form") {
      const field = rightPane.fields[formFieldIndex] ?? rightPane.fields[0];
      setPromptValue(field && formFieldUsesPromptInput(rightPane.command, field.name)
        ? formValues[field.name] ?? field.initialValue ?? ""
        : "");
    } else {
      setPromptValue("");
    }
    setPaneFocus("details");
  }, [formFieldIndex, formValues, rightPane, selectFooterControl, setPaneFocus, setPromptValue, stashActiveInput]);

  const focusDetailsOnly = useCallback(() => {
    const previousPane = activePaneRef.current;
    stashActiveInput();
    selectFooterControl(null);
    if (previousPane !== "details") {
      paneBeforeDetailsRef.current = previousPane;
    }
    setFormDiscardArmed(false);
    if (rightPane.kind === "form") {
      const field = rightPane.fields[formFieldIndex] ?? rightPane.fields[0];
      setPromptValue(field && formFieldUsesPromptInput(rightPane.command, field.name)
        ? formValues[field.name] ?? field.initialValue ?? ""
        : "");
    } else {
      setPromptValue("");
    }
    setPaneFocus("details");
  }, [formFieldIndex, formValues, rightPane, selectFooterControl, setPaneFocus, setPromptValue, stashActiveInput]);

  const clearChatPromptDraft = useCallback(() => {
    setPromptValue("");
    chatDraftRef.current = "";
    promptImageAttachmentsRef.current = [];
    clearComposerDraft(composerDraftsRef.current, activeSessionIdRef.current);
  }, [setPromptValue]);

  const toggleDrawerPane = useCallback(() => {
    selectFooterControl(null);
    if (drawerOpen) {
      setDrawerOpen(false);
      focusChat();
      return;
    }
    focusDrawer();
  }, [drawerOpen, focusChat, focusDrawer, selectFooterControl]);

  const toggleDetailsPane = useCallback(() => {
    selectFooterControl(null);
    if (rightOpen) {
      userDismissedRightPaneRef.current = true;
      if (rightPane.kind === "form") {
        setFormDiscardArmed(false);
        setFormValues({});
        setFormFieldIndex(0);
        setPrompt("");
        setRightPane({ kind: "empty" });
      }
      setRightOpen(false);
      lastUserOpenedPaneRef.current = null;
      focusChat();
      return;
    }
    focusDetails();
  }, [focusChat, focusDetails, rightOpen, rightPane.kind, selectFooterControl]);

  const cyclePaneFocus = useCallback((direction: 1 | -1 = 1) => {
    const order: PaneFocus[] = [
      ...(drawerOpen ? (["drawer"] as PaneFocus[]) : []),
      "chat",
      ...(rightOpen ? (["details"] as PaneFocus[]) : []),
    ];
    const currentIndex = order.indexOf(activePaneRef.current);
    const startIndex = currentIndex >= 0 ? currentIndex : direction > 0 ? -1 : 0;
    const nextPane = order[(startIndex + direction + order.length) % order.length] ?? "chat";
    if (nextPane === "drawer") {
      focusDrawerOnly();
    } else if (nextPane === "details") {
      focusDetailsOnly();
    } else {
      focusChat();
    }
  }, [drawerOpen, focusChat, focusDetailsOnly, focusDrawerOnly, rightOpen]);

  const focusAfterDetails = useCallback(() => {
    if (paneBeforeDetailsRef.current === "drawer" && drawerOpen) {
      focusDrawerOnly();
      return;
    }
    focusChat();
  }, [drawerOpen, focusChat, focusDrawerOnly]);

  const projectName = path.basename(activeProjectRoot);
  const activeLane = useMemo(
    () => lanes.find((lane) => lane.id === activeLaneId) ?? null,
    [activeLaneId, lanes],
  );
  const unavailableLaneIds = useMemo(() => {
    const ids = new Set<string>();
    for (const lane of lanes) {
      if (!isLaneWorktreeAvailable(lane, { remote: remoteLaunch })) ids.add(lane.id);
    }
    return ids;
  }, [lanes, remoteLaunch]);
  const drawerLane = useMemo(
    () => lanes.find((lane) => lane.id === drawerLaneId) ?? null,
    [drawerLaneId, lanes],
  );
  const activeSession = useMemo(
    () => sessions.find((session) => session.sessionId === activeSessionId) ?? null,
    [activeSessionId, sessions],
  );
  useEffect(() => {
    const sessionId = activeSession?.sessionId;
    const agentId = activeSession?.cursorCloudAgentId?.trim();
    // Also for a plugin-owned chat: the same signal drives `chat.opened` /
    // `chat.closed` into the plugin that runs the conversation, which is how it
    // knows to poll fast while somebody is reading and stop when nobody is.
    const pluginOwned = Boolean(activeSession?.runtimeRef?.pluginId);
    if (!connection || !sessionId || (!agentId && !pluginOwned)) return;
    void watchCursorCloudMirror(connection, sessionId, true).catch(() => undefined);
    return () => {
      void watchCursorCloudMirror(connection, sessionId, false).catch(() => undefined);
    };
  }, [
    activeSession?.cursorCloudAgentId,
    activeSession?.runtimeRef?.pluginId,
    activeSession?.sessionId,
    connection,
  ]);
  const activeTerminalSession = useMemo(
    () => terminalSessions.find((session) => session.terminalId === activeSessionId) ?? null,
    [activeSessionId, terminalSessions],
  );
  useEffect(() => {
    if (!connection || !activeTerminalSession) return;
    let cancelled = false;
    void getScheduledWorkState(connection, activeTerminalSession.terminalId)
      .then((state) => {
        if (cancelled) return;
        setTerminalScheduledWorkById((current) => ({
          ...current,
          [activeTerminalSession.terminalId]: state,
        }));
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [activeTerminalSession, connection]);
  // Chat-shaped view of the active session that ALSO covers Claude terminal
  // sessions (which never appear in `sessions`). Drives chat-info availability
  // and the context resolver so terminal chats get the same chat-info default
  // pane as SDK chats instead of falling back to lane-details.
  const activeDisplaySession = useMemo(
    () => activeSession ?? (activeTerminalSession
      ? terminalSessionToChatSummary(
          activeTerminalSession,
          terminalScheduledWorkById[activeTerminalSession.terminalId],
        )
      : null),
    [activeSession, activeTerminalSession, terminalScheduledWorkById],
  );
  const activeTerminalProvider = terminalSessionProvider(activeTerminalSession);
  const displaySessions = useMemo(
    () => sortSessionsByRecentActivity([
      ...sessions.filter((session) => !session.archivedAt),
      ...terminalSessions.map((session) =>
        terminalSessionToChatSummary(session, terminalScheduledWorkById[session.terminalId])),
    ]),
    [sessions, terminalScheduledWorkById, terminalSessions],
  );
  displaySessionsRef.current = displaySessions;
  // Contributed badges per drawer row, selected once here rather than per row:
  // the drawer redraws on every stream frame and a row must never fetch or
  // re-derive. Rows no plugin contributes to are absent from the map, so a
  // machine with nothing installed builds two empty objects and stops.
  const pluginLaneBadges = useMemo(() => {
    const byLaneId: Record<string, PluginRowBadgeStrip> = {};
    if (pluginContributions.lanes.identities.size === 0) return byLaneId;
    for (const lane of lanes) {
      const strip = pluginRowBadgeStrip(pluginContributions.lanes, tuiLaneContext(lane));
      if (strip.cells.length > 0) byLaneId[lane.id] = strip;
    }
    return byLaneId;
  }, [lanes, pluginContributions.lanes]);
  const pluginChatBadges = useMemo(() => {
    const bySessionId: Record<string, PluginRowBadgeStrip> = {};
    if (pluginContributions.work.identities.size === 0) return bySessionId;
    for (const session of displaySessions) {
      const strip = pluginRowBadgeStrip(pluginContributions.work, tuiSessionContext(session));
      if (strip.cells.length > 0) bySessionId[session.sessionId] = strip;
    }
    return bySessionId;
  }, [displaySessions, pluginContributions.work]);
  const closedCliSessions = useMemo(
    () => deriveClosedCliSessions(terminalSessions, terminalScheduledWorkById),
    [terminalScheduledWorkById, terminalSessions],
  );
  const openDrawerSessions = useMemo(
    () => deriveOpenWorkSessions(displaySessions, closedCliSessions),
    [closedCliSessions, displaySessions],
  );
  const sessionBySessionId = useMemo(() => {
    const out: Record<string, AgentChatSessionSummary> = {};
    for (const session of displaySessions) out[session.sessionId] = session;
    return out;
  }, [displaySessions]);
  // Keyed by terminalId; lets the grid tell a terminal tile from a chat tile and
  // render a live TerminalPane for it.
  const terminalSessionById = useMemo(() => {
    const out: Record<string, ChatTerminalSession> = {};
    for (const terminal of terminalSessions) out[terminal.terminalId] = terminal;
    return out;
  }, [terminalSessions]);
  // Both agent chats and Claude CLI terminal sessions can be tiled in the grid.
  // Terminal tiles render a live TerminalPane instead of a ChatView transcript.
  const tileableSessionIds = useMemo(() => {
    const ids = new Set(sessions.filter((session) => !session.archivedAt).map((session) => session.sessionId));
    for (const terminal of terminalSessions) ids.add(terminal.terminalId);
    return ids;
  }, [sessions, terminalSessions]);
  const tileableDisplaySessions = useMemo(
    () => displaySessions.filter((session) => tileableSessionIds.has(session.sessionId)),
    [displaySessions, tileableSessionIds],
  );
  const lanesById = useMemo(() => {
    const out: Record<string, LaneSummary> = {};
    for (const lane of lanes) out[lane.id] = lane;
    return out;
  }, [lanes]);
  useEffect(() => {
    if (!activeSessionId) return;
    if (loadedSessionIdRef.current !== activeSessionId) return;
    setEventsBySessionId((prev) => {
      if (prev[activeSessionId] === events) return prev;
      return { ...prev, [activeSessionId]: events };
    });
  }, [activeSessionId, events]);
  // Ctrl+T raw control works for any running tracked provider CLI (Claude,
  // Codex, Cursor, Droid, OpenCode) — activeTerminalProvider is non-null for
  // every terminal the TUI surfaces.
  const terminalControlAvailable = Boolean(
    activeTerminalSession
      && activeTerminalSession.status === "running"
      && activeTerminalProvider,
  );
  const terminalControlActive = terminalControlAvailable
    && attachedTerminalId === activeTerminalSession?.terminalId;
  // Provider-neutral label for the terminal control chrome (footer "^t <label>",
  // "<LABEL> CONTROL", pane status). Falls back to Claude for legacy sessions.
  const terminalControlLabel = providerLabel(activeTerminalProvider ?? "claude");
  const activeCommandProvider = activeTerminalProvider ?? activeSession?.provider ?? modelState.provider;
  // Once a chat has any sent user message, the provider is locked — swapping
  // mid-thread breaks runtime continuity. Derived from events; persists across reloads.
  const providerLocked = useMemo(() => Boolean(activeSession) && hasFirstUserMessage(events), [activeSession, events]);
  const providerLockedRef = useRef<boolean>(false);
  useEffect(() => {
    providerLockedRef.current = providerLocked;
  }, [providerLocked]);
  // Whether the active model supports fast mode / reasoning effort — drives which
  // footer cells exist and are focusable (refs let the input handler read current
  // values without stale closures).
  const footerFastSupported = useMemo(() => {
    const descriptor = modelState.modelId ? getModelById(modelState.modelId) : undefined;
    const activeModel = models.find((entry) => entry.id === modelState.modelId || entry.modelId === modelState.modelId);
    return Boolean(activeModel?.serviceTiers?.some((tier) => tier.trim().toLowerCase() === "fast"))
      || modelSupportsFastMode(descriptor);
  }, [models, modelState.modelId]);
  const footerReasoningSupported = useMemo(
    () => modelReasoningEfforts(modelState, models).length > 0,
    [modelState, models],
  );
  const footerReasoningLabel = reasoningEffortDisplayLabel(modelState.reasoningEffort, modelState);
  const footerFastSupportedRef = useRef(false);
  const footerReasoningSupportedRef = useRef(false);
  useEffect(() => {
    footerFastSupportedRef.current = footerFastSupported;
    footerReasoningSupportedRef.current = footerReasoningSupported;
  }, [footerFastSupported, footerReasoningSupported]);
  const latestFailedLineId = useMemo(() => latestExpandableFailureId(events), [events]);
  // Chat info is available for any active chat — including Claude terminal
  // sessions (resume row / status); subagent rows fill in when the provider
  // emits agent lifecycle events.
  const subagentPaneCommandAvailable = Boolean(activeDisplaySession && !draftChatActive);
  const subagentActivity = useMemo(() => subagentActivitySummaryFromEvents(events), [events]);
  const chatInfoPaneVisible = rightOpen && rightPane.kind === "chat-info";
  const shouldAutoOpenSubagentPane = Boolean(
    activeSessionId
      && subagentPaneCommandAvailable
      && subagentActivity.totalCount > 0
      && !subagentAutoOpenedSessionsRef.current.has(activeSessionId)
      && !userDismissedRightPaneRef.current
      && !rightOpen,
  );
  const shouldDeriveFullChatInfo = chatInfoPaneVisible || inspectedSubagentId != null || shouldAutoOpenSubagentPane;
  const [runtimeSubagentSnapshots, setRuntimeSubagentSnapshots] = useState<SubagentSnapshot[]>([]);
  useEffect(() => {
    if (!chatInfoPaneVisible || !activeSessionId || !connection) {
      setRuntimeSubagentSnapshots([]);
      return;
    }
    let cancelled = false;
    void listSubagents(connection, { sessionId: activeSessionId })
      .then((rows) => {
        if (!cancelled) setRuntimeSubagentSnapshots(rows.map(snapshotFromRuntimeSubagent));
      })
      .catch(() => {
        if (!cancelled) setRuntimeSubagentSnapshots([]);
      });
    return () => {
      cancelled = true;
    };
  }, [activeSessionId, chatInfoPaneVisible, connection, events.length]);
  const subagentSnapshots = useMemo(
    () => {
      const fromEvents = shouldDeriveFullChatInfo ? subagentSnapshotsFromEvents(events) : EMPTY_SUBAGENT_SNAPSHOTS;
      return mergeSubagentSnapshots(fromEvents, runtimeSubagentSnapshots);
    },
    [events, runtimeSubagentSnapshots, shouldDeriveFullChatInfo],
  );
  const chatInfoRosterViewState = resolveChatInfoRosterViewState(subagentPaneViewState);
  const chatInfoEvents = shouldDeriveFullChatInfo ? events : EMPTY_CHAT_EVENTS;
  const liveAgentCount = shouldDeriveFullChatInfo
    ? subagentSnapshots.filter((snap) => snap.status === "running").length
    : subagentActivity.runningCount;
  const chatInfo = useMemo(() => {
    const chatLaneId = activeDisplaySession?.laneId ?? activeLaneId;
    const sessionLane = (chatLaneId ? lanes.find((lane) => lane.id === chatLaneId) : null) ?? activeLane;
    return deriveChatInfoSnapshot({
      events: chatInfoEvents,
      activeSession: activeDisplaySession,
      provider: modelState.provider,
      modelLabel: modelState.displayName || modelState.model || modelState.provider,
      laneLabel: sessionLane?.name ?? null,
      laneIcon: sessionLane?.icon ?? null,
      laneColor: sessionLane?.color ?? null,
      title: activeDisplaySession?.title ?? null,
      snapshots: subagentSnapshots,
      tokenStats: statusLineStats,
      goal: currentGoal,
      streaming,
      inspectedSubagentId,
      pr: (chatLaneId ? prByLaneId?.[chatLaneId] : null) ?? null,
      resumableTerminal: isTerminalSessionResumable(activeTerminalSession),
    });
  }, [
    activeDisplaySession,
    activeLane,
    activeLaneId,
    activeTerminalSession,
    chatInfoEvents,
    currentGoal,
    inspectedSubagentId,
    lanes,
    modelState.displayName,
    modelState.model,
    modelState.provider,
    prByLaneId,
    statusLineStats,
    streaming,
    subagentSnapshots,
  ]);
  const buildChatInfoSnapshot = useCallback(() => {
    const chatLaneId = activeDisplaySession?.laneId ?? activeLaneId;
    const sessionLane = (chatLaneId ? lanes.find((lane) => lane.id === chatLaneId) : null) ?? activeLane;
    const snapshots = shouldDeriveFullChatInfo
      ? subagentSnapshots
      : mergeSubagentSnapshots(subagentSnapshotsFromEvents(events), runtimeSubagentSnapshots);
    return deriveChatInfoSnapshot({
      events,
      activeSession: activeDisplaySession,
      provider: modelState.provider,
      modelLabel: modelState.displayName || modelState.model || modelState.provider,
      laneLabel: sessionLane?.name ?? null,
      laneIcon: sessionLane?.icon ?? null,
      laneColor: sessionLane?.color ?? null,
      title: activeDisplaySession?.title ?? null,
      snapshots,
      tokenStats: statusLineStats,
      goal: currentGoal,
      streaming,
      inspectedSubagentId,
      pr: (chatLaneId ? prByLaneId?.[chatLaneId] : null) ?? null,
      resumableTerminal: isTerminalSessionResumable(activeTerminalSession),
    });
  }, [
    activeDisplaySession,
    activeLane,
    activeLaneId,
    activeTerminalSession,
    currentGoal,
    events,
    inspectedSubagentId,
    lanes,
    modelState.displayName,
    modelState.model,
    modelState.provider,
    prByLaneId,
    runtimeSubagentSnapshots,
    shouldDeriveFullChatInfo,
    statusLineStats,
    streaming,
    subagentSnapshots,
  ]);
  const chatInfoRef = useRef(chatInfo);
  const buildChatInfoSnapshotRef = useRef(buildChatInfoSnapshot);
  useEffect(() => {
    chatInfoRef.current = chatInfo;
  }, [chatInfo]);
  useEffect(() => {
    buildChatInfoSnapshotRef.current = buildChatInfoSnapshot;
  }, [buildChatInfoSnapshot]);
  const subagentsButtonVisibleRef = useRef<boolean>(false);
  useEffect(() => {
    subagentsButtonVisibleRef.current = subagentPaneCommandAvailable;
  }, [subagentPaneCommandAvailable]);
  const footerControls = useMemo<FooterControl[]>(
    () => footerControlsForAvailability(subagentPaneCommandAvailable),
    [subagentPaneCommandAvailable],
  );
  const cycleFooterControl = useCallback((direction: 1 | -1) => {
    const controls: FooterControl[] = footerControls.length ? footerControls : ["drawer", "details"];
    const current = footerControlRef.current;
    const currentIndex = current ? controls.indexOf(current) : -1;
    const startIndex = currentIndex >= 0 ? currentIndex : direction > 0 ? -1 : 0;
    const nextIndex = (startIndex + direction + controls.length) % controls.length;
    selectFooterControl(controls[nextIndex] ?? "drawer");
  }, [footerControls, selectFooterControl]);
  useEffect(() => {
    if (footerControl === "agents" && !subagentPaneCommandAvailable) {
      selectFooterControl(null);
    }
  }, [footerControl, selectFooterControl, subagentPaneCommandAvailable]);
	  useEffect(() => {
	    if (rightPaneKindRef.current !== rightPane.kind) {
	      if (rightPane.kind === "chat-info") {
	        setRightSelectionIndex(0);
	      }
	      setRightPaneScrollOffsetRows(0);
	      rightPaneKindRef.current = rightPane.kind;
	    }
	  }, [rightPane.kind]);
  useEffect(() => {
    rightPaneRef.current = rightPane;
  }, [rightPane]);
  useEffect(() => {
    const content = subagentPaneContentFromRightPane(rightPane);
    if (!content) return;
    // Chat-info exposes (snapshot count + 1) selectable rows: main row at 0,
    // subagents at 1..N — plus one extra leading row when the resume row is
    // visible (0 = resume, 1 = main, …). Clamp prior selection back into range
    // when the roster shrinks (e.g., a subagent finishes and is reaped).
    const resumeOffset = rightPane.kind === "chat-info" ? chatInfoSelectionOffset(rightPane.info) : 0;
    const rowCount = buildSubagentPaneRows(content, chatInfoRosterViewState).filter((row) => row.kind === "snapshot").length + resumeOffset;
    setRightSelectionIndex((index) => Math.max(0, Math.min(Number.isFinite(index) ? Math.floor(index) : 0, rowCount)));
  }, [chatInfoRosterViewState, rightPane]);
  useEffect(() => {
    if (!inspectedSubagentId) return;
    if (rightPane.kind !== "chat-info" || !rightOpen || !subagentSnapshots.some((snap) => snap.id === inspectedSubagentId)) {
      setInspectedSubagentId(null);
    }
  }, [inspectedSubagentId, rightOpen, rightPane.kind, subagentSnapshots]);
  useEffect(() => {
    setInspectedSubagentId(null);
    setRealMainTranscript(null);
  }, [activeSessionId]);
  const openSubagentsPane = useCallback((): boolean => {
    if (!subagentPaneCommandAvailable) return false;
    const previousPane = activePaneRef.current;
    stashActiveInput();
    selectFooterControl(null);
    if (previousPane !== "details") {
      paneBeforeDetailsRef.current = previousPane;
    }
    setFormDiscardArmed(false);
    setPrompt("");
    setInlineRowFocus({ cell: null });
    setRightPane({
      kind: "chat-info",
      info: buildChatInfoSnapshot(),
    });
    setRightSelectionIndex(0);
    setRightOpen(true);
    setPaneFocus("details");
    lastUserOpenedPaneRef.current = "chat-info";
    return true;
  }, [
    buildChatInfoSnapshot,
    selectFooterControl,
    setPaneFocus,
    stashActiveInput,
    subagentPaneCommandAvailable,
  ]);
  const toggleSubagentsPane = useCallback((): boolean => {
    if (!subagentPaneCommandAvailable) return true;
    selectFooterControl(null);
    if (rightOpen && rightPane.kind === "chat-info") {
      setRightOpen(false);
      lastUserOpenedPaneRef.current = null;
      setInspectedSubagentId(null);
      focusChat();
      return true;
    }
    openSubagentsPane();
    return true;
  }, [
    focusChat,
    openSubagentsPane,
    rightOpen,
    rightPane.kind,
    selectFooterControl,
    subagentPaneCommandAvailable,
  ]);
  // Auto-open the chat-info pane the first time a subagent appears for a session
  // (once per session), mirroring the desktop subagent auto-open. Scheduled
  // work and task snapshots also use the immediate event path below, keeping
  // this derivation cheap while preserving the same "new info appeared" feel.
  // Unlike a manual open, this does NOT steal focus from the composer — the
  // pane simply appears alongside the chat. Respects an explicit user dismissal
  // and never stomps a different pane the user opened.
  useEffect(() => {
    const sessionId = activeSessionId;
    if (!sessionId || !subagentPaneCommandAvailable) return;
    if (subagentActivity.totalCount === 0) return;
    if (subagentAutoOpenedSessionsRef.current.has(sessionId)) return;
    if (userDismissedRightPaneRef.current) return;
    // chat-info already visible → agents are already shown; consume the flag.
    if (rightOpen && rightPane.kind === "chat-info") {
      subagentAutoOpenedSessionsRef.current.add(sessionId);
      return;
    }
    // A different pane is intentionally open → don't stomp it; retry when it
    // next changes (this effect re-runs on rightPane.kind / rightOpen).
    if (rightOpen) return;
    setRightPane({ kind: "chat-info", info: buildChatInfoSnapshot() });
    setRightSelectionIndex(0);
    setRightOpen(true);
    subagentAutoOpenedSessionsRef.current.add(sessionId);
  }, [activeSessionId, buildChatInfoSnapshot, rightOpen, rightPane.kind, subagentActivity.totalCount, subagentPaneCommandAvailable]);
  const promptHistory = useMemo(() => events
    .map((envelope) => envelope.event)
    .filter((event): event is Extract<AgentChatEventEnvelope["event"], { type: "user_message" }> => event.type === "user_message")
    .map((event) => (event.displayText || event.text || "").trim())
    .filter(Boolean)
    .slice(-200), [events]);
  useEffect(() => {
    promptHistoryRef.current = promptHistory;
    promptHistoryIndexRef.current = null;
    if (activeSessionId) {
      setPromptHistoryBySessionId((prev) => ({ ...prev, [activeSessionId]: promptHistory.slice(-100) }));
    }
  }, [activeSessionId, promptHistory]);
  useEffect(() => {
    setVimModeEnabled(readClaudeVimMode(project.workspaceRoot));
    setVimMode("insert");
  }, [project.workspaceRoot]);
  const currentClaudeGoal = useMemo(
    () => deriveClaudeGoalFromEvents(events, activeSession?.claudeGoal),
    [activeSession?.claudeGoal, events],
  );
  const goalBannerText = useMemo(
    () => formatGoalBannerLine(activeSession?.provider === "claude" ? currentClaudeGoal : currentGoal),
    [activeSession?.provider, currentClaudeGoal, currentGoal],
  );
  const statusLineRows = statusLineText ? Math.min(3, statusLineText.split(/\r?\n/).filter(Boolean).length || 1) : 0;
  const statusRows = statusLineRows;
  const modelStatusOverlayRows = statusRows
    + (draftChatActive || (vimModeEnabled && !hideVimModeIndicator) || modelState.fastMode ? 1 : 0);
  const backgroundLaunchRows = backgroundLaunchStatus ? 1 : 0;
  const backgroundLaunchStatusText = backgroundLaunchStatus
    ? backgroundLaunchStatus.status === "running"
      ? `launching in ${backgroundLaunchStatus.laneName}…`
      : `launch failed in ${backgroundLaunchStatus.laneName}: ${backgroundLaunchStatus.error ?? "restore draft"}`
    : null;
  const goalBannerRows = goalBannerText ? 1 : 0;
  const addModeRows = addMode ? 1 : 0;
  const rightPaneMaxWidth = rightPane.kind === "model-picker" || rightPane.kind === "model-wizard" || rightPane.kind === "external-session-browser"
    ? MODEL_PICKER_RIGHT_PANE_MAX_WIDTH
    : RIGHT_PANE_MAX_WIDTH;
  const rightPaneWidth = resolveRightPaneWidth(columns, rightOpen, drawerOpen, rightPaneMaxWidth);
  // What the right pane WOULD get if it opened right now. `rightPaneWidth` is 0
  // while the pane is closed, so a command that is about to open it has to ask
  // this instead — otherwise every first open looks like a too-narrow terminal.
  const prospectiveRightPaneWidth = resolveRightPaneWidth(columns, true, drawerOpen, rightPaneMaxWidth);
  const centerWidth = resolveCenterPaneWidth(columns, drawerOpen, rightPaneWidth);
  const promptPaneWidth = Math.max(MIN_CENTER_PANE_WIDTH, finiteFloor(centerWidth, MIN_CENTER_PANE_WIDTH));
  // Confirmed chip tokens in the prompt: mentions that were actually inserted
  // from the picker and /commands matching the known catalog. Rendered as
  // colored tokens in the prompt rows below.
  const promptSmartLinks = useMemo(() => findSmartLinks(prompt), [prompt]);
  const promptTokenRanges = useMemo<PromptRenderTokenRange[]>(() => {
    if (!prompt) return [];
    const mentionTexts = new Set(selectedMentions.map((mention) => mention.insertText));
    const commandNames = new Set([
      ...BUILTIN_COMMANDS.map((command) => command.name.replace(/^\//, "").toLowerCase()),
      ...slashCommands.map((command) => command.name.replace(/^\//, "").toLowerCase()),
    ]);
    return [
      ...findConfirmedComposerTokens(prompt, {
        isFile: (body) => mentionTexts.has(`@${body}`),
        isCommand: (body) => commandNames.has(body.toLowerCase()),
      }),
      ...promptSmartLinks.map(({ start, end }) => ({ kind: "link" as const, start, end })),
      // Inline image tokens are self-delimiting, so they paint straight from
      // the draft text without consulting the attachment registry.
      ...findImageTokens(prompt).map(({ start, end }) => ({ kind: "image" as const, start, end })),
    ].sort((left, right) => left.start - right.start);
  }, [prompt, promptSmartLinks, selectedMentions, slashCommands]);
  // Drives the "^B open image" composer hint: only offer the key when it has
  // something to act on.
  const promptCursorOnImageToken = useMemo(
    () => imageTokenAtCursor(prompt, promptCursor) !== null,
    [prompt, promptCursor],
  );
  const promptDisplay = promptDisplayRowsWithCursor(prompt, promptWrapWidth(promptPaneWidth), promptCursor, PROMPT_MAX_ROWS);
  const promptRows = promptDisplay.rows;
  const smartLinkRows = promptSmartLinks.length > 0 ? 1 : 0;
  // Header is the ADE wordmark row plus its bottom rule (2), then optional banners.
  const headerChromeRows = 2 + goalBannerRows + addModeRows;
  const sessionsPaneHeight = Math.max(8, rows - headerChromeRows);
  const chatRowBudget = Math.max(4, sessionsPaneHeight - 7 - (promptRows.length - 1) - smartLinkRows - statusRows - backgroundLaunchRows);
  const chatWrapWidth = resolveChatWrapWidth(centerWidth, drawerOpen, rightPaneWidth);
  const terminalPaneWidth = resolveTerminalPaneWidth(centerWidth);
  const orderedDrawerLanes = useMemo(
    () => sortLanesForStackGraph(lanes),
    [lanes],
  );
  const diffLaneIdsKey = useMemo(
    () => lanes.filter((lane) => !lane.archivedAt).map((lane) => lane.id).sort().join("\n"),
    [lanes],
  );
  // Chats holding an unsent composer draft, for the pane's ✎ indicator. Drafts
  // are stashed on chat switch and mutate as you type, so the identity of the
  // open chat and the current prompt are what make this recompute — no timer.
  const workDraftSessionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const session of displaySessions) {
      if (sessionHasDraft(composerDraftsRef.current, session.sessionId)) ids.add(session.sessionId);
    }
    if (activeSessionId && prompt.length > 0) ids.add(activeSessionId);
    return ids;
  }, [activeSessionId, displaySessions, prompt]);
  const projectCanonicalId = useMemo(
    () => (project.projectRoot ? deriveProjectId(project.projectRoot) : null),
    [project.projectRoot],
  );
  const localSessionIds = useMemo(
    () => new Set(displaySessions.map((session) => session.sessionId)),
    [displaySessions],
  );
  // Cross-machine rows, first pass: the attention snapshot the /activity pane
  // already fetches, narrowed to this project and to machines that are not this
  // one. A live per-machine RPC fan-out (desktop `crossMachineLanes`) arrives
  // with transparent connect; until then the snapshot's `online` flag is the
  // only reachability signal, and it is enough to dim a group honestly.
  const workForeignSessions = useMemo<WorkListForeignSession[]>(() => {
    if (!attentionSnapshot) return [];
    return foreignRowsFromAttention({
      items: attentionSnapshot.items,
      projectCanonicalId: projectCanonicalId,
      projectRootPath: project.projectRoot,
      localSessionIds,
    });
  }, [attentionSnapshot, localSessionIds, project.projectRoot, projectCanonicalId]);
  // The one model behind the sessions pane. Add-mode reuses it as a picker over
  // the grid-tileable chats, so the picker and the pane can never disagree
  // about what a row is or where it sits.
  const workListModel = useMemo<WorkListModel>(() => buildWorkListModel({
    lanes,
    sessions: (addMode ? tileableDisplaySessions : openDrawerSessions) as TuiChatSessionSummary[],
    foreign: addMode ? [] : workForeignSessions,
    activeSessionId,
    draftSessionIds: workDraftSessionIds,
    expandedShelves: workExpandedShelves,
    unavailableLaneIds,
    hideNewChat: true,
  }), [
    activeSessionId,
    addMode,
    lanes,
    openDrawerSessions,
    tileableDisplaySessions,
    unavailableLaneIds,
    workDraftSessionIds,
    workExpandedShelves,
    workForeignSessions,
  ]);
  // In add-mode the pane is a chooser and the cursor lives on addMode state; in
  // normal use it is the pane's own selected key.
  const workSelectedRowKey = addMode
    ? (addMode.cursorChatId ? `session:${addMode.cursorChatId}` : null)
    : workSelectedKey;
  const workSelectedIndex = workListRowIndex(workListModel.rows, workSelectedRowKey);
  const workSelectedRow: WorkListRow | null = workSelectedIndex >= 0
    ? workListModel.rows[workSelectedIndex]!
    : null;
  const workSelectionKind: WorkSelectionKind = !drawerOpen
    ? null
    : workSelectedRow?.kind === "lane-header"
      ? "lane"
      : workSelectedRow?.kind ?? null;
  // Single source of truth for the pane's row geometry, shared with the mouse
  // handler below so hit-testing cannot drift from what is on screen.
  const workListLayoutValue = useMemo<WorkListLayout>(() => computeWorkListLayout({
    panelHeight: sessionsPaneHeight,
    rows: workListModel.rows,
    scrollOffsetRows: drawerScrollOffsetRows,
    selectedIndex: workSelectedIndex,
    headerRows: addMode ? 2 : 1,
  }), [addMode, drawerScrollOffsetRows, sessionsPaneHeight, workListModel.rows, workSelectedIndex]);
  useEffect(() => {
    if (!connection) return;
    const screen = deriveTuiAnalyticsScreen({
      activePane,
      workSelectionKind,
      rightPaneKind: rightPane.kind,
      gridViewActive,
      addModeActive: addMode !== null,
      terminalControlActive: attachedTerminalId !== null,
    });
    if (lastAnalyticsScreenRef.current === screen) return;
    lastAnalyticsScreenRef.current = screen;
    void captureTuiProductAnalytics(connection, {
      event: "ade_screen_viewed",
      properties: {
        screen,
        source: "ade_code",
      },
      dedupeKey: `tui_screen:${screen}`,
      minimumIntervalMs: 2_000,
    }).catch(() => undefined);
  }, [activePane, addMode, attachedTerminalId, connection, gridViewActive, rightPane.kind, workSelectionKind]);

  const workListLayoutRef = useRef(workListLayoutValue);
  const workListModelRef = useRef(workListModel);
  const workSelectedKeyRef = useRef(workSelectedRowKey);
  useEffect(() => {
    workListLayoutRef.current = workListLayoutValue;
    workListModelRef.current = workListModel;
    workSelectedKeyRef.current = workSelectedRowKey;
  }, [workListLayoutValue, workListModel, workSelectedRowKey]);
  const applyDrawerChatSelection = useCallback((
    selection: { session: AgentChatSessionSummary | null; action: WorkChatAction | null },
  ) => {
    const clearLoadedTranscript = (): void => {
      clearOlderHistoryCursor(activeSessionIdRef.current);
      loadedSessionIdRef.current = null;
      eventCountRef.current = 0;
      setEvents([]);
      setStreaming(false);
      setInterrupted(false);
      setSessionInterrupted(activeSessionIdRef.current, false);
      setCurrentGoal(null);
      setContextPercent(null);
      setTokenSummary(null);
      setStatusLineStats(null);
    };

    if (selection.action === "new-chat") {
      const laneId = drawerLaneIdRef.current ?? activeLaneIdRef.current;
      newChatPreviewLaneIdRef.current = laneId;
      draftChatActiveRef.current = true;
      setDraftChatMode(true);
      setGridView(false);
      selectActiveSessionId(null);
      clearLoadedTranscript();
      return;
    }
    if (selection.action === "closed-toggle") {
      return;
    }

    if (!selection.session) {
      draftChatActiveRef.current = false;
      setDraftChatMode(false);
      setGridView(false);
      selectActiveSessionId(null);
      clearLoadedTranscript();
      return;
    }

    const session = selection.session;
    // If the selected chat is one of the (possibly hidden) grid's tiles, re-enter
    // the grid focused on it; otherwise show it as a normal single chat and leave
    // the grid resumable in the background.
    const gridTileIndex = multiViewRef.current?.tiles.findIndex((tile) => tile.sessionId === session.sessionId) ?? -1;
    if (gridTileIndex >= 0) {
      draftChatActiveRef.current = false;
      setDraftChatMode(false);
      setMultiView((prev) => (prev ? { ...prev, focusedIndex: gridTileIndex } : prev));
      setGridView(true);
      return;
    }
    setGridView(false);
    newChatPreviewLaneIdRef.current = null;
    draftChatActiveRef.current = false;
    setDraftChatMode(false);
    if (session.laneId !== activeLaneIdRef.current) {
      selectActiveLaneId(session.laneId);
    }
    const sessionId = session.sessionId;
    if (activeSessionIdRef.current !== sessionId) {
      selectActiveSessionId(sessionId);
    }
    if (loadedSessionIdRef.current === sessionId) return;
    const cachedEvents = eventsBySessionIdRef.current[sessionId] ?? [];
    if (cachedEvents.length > 0) {
      // Paint the last resident window synchronously. Revalidation below may
      // replace it, but a chat revisit never flashes an empty transcript.
      commitActiveSessionEvents(sessionId, cachedEvents);
      // The cached window remains a valid paging base if background
      // revalidation is temporarily unavailable.
      loadedSessionIdRef.current = sessionId;
    } else {
      clearLoadedTranscript();
    }

    const conn = connectionRef.current;
    if (!conn) return;

    const generation = drawerPreviewGenerationRef.current + 1;
    drawerPreviewGenerationRef.current = generation;
    const historyArrivalWatermark = captureHydratedEventsWatermark(sessionId);
    void (async () => {
      try {
        const history = await getChatHistory(conn, sessionId);
        if (generation !== drawerPreviewGenerationRef.current) return;
        if (activeSessionIdRef.current !== sessionId) return;
        if (selectedDrawerChatIdRef.current !== sessionId) return;

        if (history.unavailable === true) {
          setOlderHistoryStatusBySessionId((prev) => (
            olderHistoryCursorBySessionIdRef.current[sessionId]
              ? { ...prev, [sessionId]: "error" }
              : prev
          ));
          return;
        }
        if (history.sessionFound === false) {
          clearOlderHistoryCursor(sessionId);
          loadedSessionIdRef.current = sessionId;
          eventCountRef.current = 0;
          setEvents([]);
          setCurrentGoal(null);
          setContextPercent(null);
          setTokenSummary(null);
          setStatusLineStats(null);
          setSessionStreaming(sessionId, false);
          setSessionInterrupted(sessionId, false);
          setStreaming(false);
          setInterrupted(false);
          return;
        }

        const clearedAtValue = clearedAtRef.current;
        const visibleHistory = clearedAtValue
          ? history.events.filter((event) => event.timestamp > clearedAtValue)
          : history.events;
        // Dedupe the FULL snapshot (no display cap), then split: the newest
        // 500 are displayed as before; the older remainder is buffered so
        // scroll-back drains it locally before the byte cursor — keeping the
        // displayed-oldest ← buffer ← tailStartOffset seams contiguous.
        const dedupedHistory = dedupeTuiEvents(visibleHistory, Math.max(1, visibleHistory.length));
        const { display, buffer: olderBuffer } = splitSnapshotForDisplay(dedupedHistory);
        const historyEvents = mergeHydratedEventsWithLive(
          sessionId,
          display,
          historyArrivalWatermark,
        );
        loadedSessionIdRef.current = sessionId;
        commitActiveSessionEvents(sessionId, historyEvents, history.events.length);
        // A locally cleared transcript view must not page older history back in.
        if (!clearedAtValue && olderBuffer.length > 0) {
          olderSnapshotBufferBySessionIdRef.current[sessionId] = olderBuffer;
        } else {
          delete olderSnapshotBufferBySessionIdRef.current[sessionId];
        }
        seedOlderHistoryCursor(sessionId, clearedAtValue ? null : resolveSnapshotHistoryCursor(history));
        setCurrentGoal(latestGoal(history.events));
        const fallbackContext = session.modelId ? getModelById(session.modelId)?.contextWindow ?? null : null;
        const stats = latestTokenStats(history.events, fallbackContext);
        setContextPercent(stats.percent);
        setTokenSummary(formatTokenSummary(stats));
        setStatusLineStats(stats);
        setSessionStreaming(sessionId, session.status === "active");
        if (session.status === "active") {
          setSessionInterrupted(sessionId, false);
          setInterrupted(false);
        }
      } catch {
        if (generation !== drawerPreviewGenerationRef.current) return;
        if (activeSessionIdRef.current !== sessionId) return;
        if (selectedDrawerChatIdRef.current !== sessionId) return;
        // Best-effort preview hydration leaves prior content visible, but the
        // cached cursor must remain explicitly retryable.
        setOlderHistoryStatusBySessionId((prev) => (
          olderHistoryCursorBySessionIdRef.current[sessionId]
            ? { ...prev, [sessionId]: "error" }
            : prev
        ));
      }
    })();
  }, [captureHydratedEventsWatermark, clearOlderHistoryCursor, commitActiveSessionEvents, mergeHydratedEventsWithLive, seedOlderHistoryCursor, selectActiveLaneId, selectActiveSessionId, setDraftChatMode, setGridView, setSessionInterrupted, setSessionStreaming, setStreaming]);
  const toggleWorkShelf = useCallback((shelf: WorkListShelfKind) => {
    setWorkExpandedShelves((prev) => {
      const next = new Set(prev);
      if (next.has(shelf)) next.delete(shelf);
      else next.add(shelf);
      return next;
    });
  }, []);
  /**
   * Open a foreign row by hopping this TUI onto that machine's paired runtime.
   * Assigned after refreshState exists; the ref keeps selectWorkRow stable.
   */
  const hopToForeignRowRef = useRef<(row: WorkListSessionRow) => void>(() => {});
  const openRemoteSession = useCallback((row: WorkListSessionRow) => {
    hopToForeignRowRef.current(row);
  }, []);
  /**
   * Move the pane's cursor onto a row. Landing on a chat OPENS it (the drawer
   * behaved the same way: browsing is previewing), which is why selection and
   * activation share this one path — a click and an arrow key cannot diverge.
   */
  const selectWorkRow = useCallback((row: WorkListRow | null) => {
    if (!row) return;
    setWorkSelectedKey(row.key);
    switch (row.kind) {
      case "session": {
        if (row.machine) {
          openRemoteSession(row);
          return;
        }
        const session = displaySessionsRef.current.find(
          (entry) => entry.sessionId === row.sessionId,
        ) ?? null;
        if (row.laneId) {
          setDrawerLaneId(row.laneId);
          setSelectedDrawerLaneId(row.laneId);
        }
        setSelectedWorkChatAction(null);
        setSelectedDrawerChatId(row.sessionId);
        applyDrawerChatSelection({ session, action: null });
        return;
      }
      case "new-chat": {
        setDrawerLaneId(row.laneId);
        setSelectedDrawerLaneId(row.laneId);
        selectActiveLaneId(row.laneId);
        setSelectedDrawerChatId(null);
        setSelectedWorkChatAction("new-chat");
        applyDrawerChatSelection({ session: null, action: "new-chat" });
        return;
      }
      case "lane-header": {
        // Lane rows only move the highlight; opening lane details is Enter's
        // job, so arrowing past a lane header never swaps the right pane.
        if (row.laneId) setSelectedDrawerLaneId(row.laneId);
        return;
      }
      case "shelf":
        return;
      default: {
        const _exhaustive: never = row;
        return _exhaustive;
      }
    }
  }, [applyDrawerChatSelection, openRemoteSession, selectActiveLaneId]);
  const liveComposerTrigger = useMemo(() => {
    if (activePane !== "chat") return null;
    const trigger = detectComposerTrigger(prompt, promptCursor);
    if (!trigger) return null;
    const confirmedFile = (body: string) => selectedMentions.some(
      (mention) => mention.kind === "file" && mention.insertText === `@${body}`,
    );
    const confirmedMention = (body: string) => isChatMentionTokenBody(body)
      || selectedMentions.some(
        (mention) => mention.kind !== "file" && mention.insertText === `@${body}`,
      );
    return composerTriggerHasConfirmedPrefix(prompt, trigger, {
      isFile: confirmedFile,
      isMention: confirmedMention,
    }) ? null : trigger;
  }, [activePane, prompt, promptCursor, selectedMentions]);
  // Esc closes the @/slash palette, and it must stay closed while the user
  // keeps typing that same token — suggestion search only narrows, so the
  // menu the user just dismissed would otherwise reopen on the next keystroke.
  // Backspacing out of the dismissed query, editing it into a different one,
  // or starting a fresh trigger elsewhere all reopen normally.
  const [dismissedComposerTrigger, setDismissedComposerTrigger] = useState<ComposerTriggerDismissal | null>(null);
  const activeComposerTrigger = useMemo(() => (
    liveComposerTrigger && isComposerTriggerDismissed(liveComposerTrigger, dismissedComposerTrigger)
      ? null
      : liveComposerTrigger
  ), [dismissedComposerTrigger, liveComposerTrigger]);
  useEffect(() => {
    if (!dismissedComposerTrigger) return;
    if (liveComposerTrigger && isComposerTriggerDismissed(liveComposerTrigger, dismissedComposerTrigger)) return;
    setDismissedComposerTrigger(null);
  }, [dismissedComposerTrigger, liveComposerTrigger]);
  const activeMentionRange = useMemo(() => (
    activeComposerTrigger?.type === "at"
      ? { start: activeComposerTrigger.start, query: activeComposerTrigger.query }
      : null
  ), [activeComposerTrigger]);
  const slashComposerTrigger = activeComposerTrigger?.type === "slash" ? activeComposerTrigger : null;
  const slashRows = useMemo(() => (
    slashComposerTrigger
      ? paletteCommands(`/${slashComposerTrigger.query}`, slashCommands, { provider: activeCommandProvider, installedPlugins: pluginInstallRecords })
      : []
  ), [activeCommandProvider, slashComposerTrigger, slashCommands]);
  // Mid-sentence slash triggers complete into the draft on Enter instead of
  // submitting/running, mirroring the desktop command menu.
  const slashTriggerMidSentence = slashComposerTrigger != null
    && !composerTriggerSpansWholeDraft(prompt, slashComposerTrigger);
  const commandPaletteItems = useMemo<CommandPaletteItem[]>(() => {
    if (!commandPaletteOpen) return [];
    const commandItems = paletteCommands("", slashCommands, { provider: activeCommandProvider, installedPlugins: pluginInstallRecords }).map((command) => ({
      key: `command:${command.name}`,
      kind: "command" as const,
      label: command.argumentHint ? `${command.name} ${command.argumentHint}` : command.name,
      detail: command.description,
    }));
    const laneItems = lanes.map((lane) => ({
      key: `lane:${lane.id}`,
      kind: "lane" as const,
      label: lane.name,
      detail: lane.branchRef ?? lane.id,
    }));
    const chatItems = displaySessions.map((session) => ({
      key: `chat:${session.sessionId}`,
      kind: "chat" as const,
      label: session.title ?? session.sessionId,
      detail: `${lanes.find((lane) => lane.id === session.laneId)?.name ?? session.laneId} · ${session.provider}`,
    }));
    const localItems = [...commandItems, ...laneItems, ...chatItems]
      .map((item) => ({ item, score: paletteMatchScore(item, commandPaletteQuery) }))
      .filter((entry): entry is { item: CommandPaletteItem; score: number } => entry.score != null)
      .sort((a, b) => a.score - b.score || a.item.label.localeCompare(b.item.label))
      .map((entry) => entry.item)
      .slice(0, 80);
    // Sessions already surfaced by the local (title/lane) match — a search hit on
    // the same session's content would otherwise list it twice.
    const localSessionIds = new Set(
      localItems
        .filter((item) => item.key.startsWith("chat:"))
        .map((item) => item.key.slice("chat:".length)),
    );
    // Universal-search hits ride BELOW the local matches. They are already
    // server-ranked and query-scoped, so we keep their order and only dedupe
    // against what's shown locally (by owning session).
    const searchItems: CommandPaletteItem[] = [];
    const seenSearchSessionIds = new Set<string>();
    for (const result of paletteSearchResults) {
      const sessionId = result.sessionId;
      if (!sessionId || localSessionIds.has(sessionId) || seenSearchSessionIds.has(sessionId)) continue;
      seenSearchSessionIds.add(sessionId);
      searchItems.push({
        key: `search-${result.kind}:${sessionId}`,
        kind: "chat",
        label: result.title || sessionId,
        detail: searchSnippetToDetail(result.snippet),
      });
    }
    return [...localItems, ...searchItems];
  }, [activeCommandProvider, commandPaletteOpen, commandPaletteQuery, displaySessions, lanes, paletteSearchResults, slashCommands]);
  useEffect(() => {
    if (!commandPaletteOpen) return;
    setCommandPaletteIndex((index) => Math.max(0, Math.min(index, Math.max(0, commandPaletteItems.length - 1))));
  }, [commandPaletteItems.length, commandPaletteOpen]);
  // Universal search: on ≥2-char queries, debounce ~200ms and ask the runtime's
  // `search.query` action for chat/terminal hits to merge below the local
  // matches. Every run bumps a generation so a slow response can't clobber a
  // newer query (or one issued after the palette closed); closing the palette or
  // shrinking the query below 2 chars cancels the pending merge and clears hits.
  useEffect(() => {
    const trimmed = commandPaletteQuery.trim();
    if (!commandPaletteOpen || trimmed.length < 2) {
      paletteSearchGenerationRef.current += 1;
      setPaletteSearchResults((prev) => (prev.length ? [] : prev));
      return;
    }
    const generation = ++paletteSearchGenerationRef.current;
    const isCurrent = () => paletteSearchGenerationRef.current === generation;
    const timer = setTimeout(() => {
      const conn = connectionRef.current;
      if (!conn) return;
      void conn
        .action<SearchQueryResult>("search", "query", {
          query: trimmed,
          kinds: ["chat", "terminal"],
          limit: 15,
        })
        .then((result) => {
          // Ignore stale responses and older runtimes returning a malformed shape.
          if (!isCurrent() || !result || !Array.isArray(result.results)) return;
          setPaletteSearchResults(result.results);
        })
        // Older runtime without the `search` domain: degrade to local-only.
        .catch(() => {
          if (isCurrent()) setPaletteSearchResults((prev) => (prev.length ? [] : prev));
        });
    }, 200);
    return () => clearTimeout(timer);
  }, [commandPaletteOpen, commandPaletteQuery]);
  const pendingApproval = useMemo(() => latestPendingApproval(events), [events]);
  const [pendingQuestionState, setPendingQuestionState] = useState<PendingQuestionSelectionState | null>(null);
  const pendingQuestionStateRef = useRef<PendingQuestionSelectionState | null>(null);
  useEffect(() => {
    setPendingQuestionState((previous) => ensurePendingQuestionSelectionState(pendingApproval, previous));
  }, [pendingApproval]);
  useEffect(() => {
    pendingQuestionStateRef.current = pendingQuestionState;
  }, [pendingQuestionState]);
  const pendingSteers = useMemo(() => derivePendingSteers(events), [events]);
  const activeFormField = rightPane.kind === "form"
    ? rightPane.fields[formFieldIndex] ?? rightPane.fields[0] ?? null
    : null;
  const selectedAgentSnapshot = useMemo(() => {
    if (!rightOpen || rightPane.kind !== "chat-info" || !inspectedSubagentId) return null;
    return subagentSnapshots.find((snapshot) => snapshot.id === inspectedSubagentId) ?? null;
  }, [inspectedSubagentId, rightOpen, rightPane.kind, subagentSnapshots]);
  const displayEvents = useMemo(() => {
    const mainTranscript = realMainTranscript;
    if (mainTranscript && mainTranscript.sessionId === activeSession?.sessionId) {
      return mainTranscript.envelopes;
    }
    if (!selectedAgentSnapshot) return events;
    // Prefer the real daemon-backed child transcript when we've fetched it for
    // THIS subagent (Codex/OpenCode); otherwise reconstruct locally from the
    // parent event stream (also the path for Cursor/Droid, which have none).
    if (realSubagentTranscript && realSubagentTranscript.id === selectedAgentSnapshot.id) {
      return realSubagentTranscript.envelopes;
    }
    return buildSubagentTranscriptEvents({ events, activeSession, snapshot: selectedAgentSnapshot });
  }, [activeSession, events, realMainTranscript, realSubagentTranscript, selectedAgentSnapshot]);
  const displayPendingSteers = useMemo(
    () => displayEvents === events ? pendingSteers : derivePendingSteers(displayEvents),
    [displayEvents, events, pendingSteers],
  );
  const addTranscriptProbeNotice = useCallback((text: string) => {
    setNotices((prev) => [
      ...prev.slice(-10),
      { id: noticeId(), timestamp: new Date().toISOString(), text, tone: "info", sessionId: activeSessionIdRef.current },
    ]);
  }, []);
  const inspectSubagentWithTranscriptProbe = useCallback((snapshot: SubagentSnapshot | null) => {
    setRealMainTranscript(null);
    if (!snapshot) {
      setInspectedSubagentId(null);
      setChatScrollOffset(0);
      return;
    }
    const conn = connectionRef.current;
    const sessionId = activeSessionIdRef.current;
    if (!conn || !sessionId || !chatInfo.capability.canViewFullTranscript) {
      setInspectedSubagentId(snapshot.id);
      setChatScrollOffset(0);
      return;
    }
    const probeKey = `${snapshot.id}:${snapshot.status}`;
    void getSubagentTranscript(conn, {
      sessionId,
      agentId: snapshot.id,
      laneId: activeLaneIdRef.current,
    })
      .then((messages) => {
        const envelopes = messages && messages.length > 0
          ? subagentTranscriptMessagesToEvents({ messages, snapshot, sessionId })
          : [];
        if (envelopes.length > 0) {
          unavailableSubagentTranscriptKeysRef.current.delete(probeKey);
          setRealSubagentTranscript({ id: snapshot.id, status: snapshot.status, envelopes });
        } else {
          unavailableSubagentTranscriptKeysRef.current.add(probeKey);
          setRealSubagentTranscript((prev) => prev?.id === snapshot.id ? null : prev);
          addTranscriptProbeNotice("Subagent transcript unavailable; showing local reconstruction.");
        }
        setInspectedSubagentId(snapshot.id);
        setChatScrollOffset(0);
      })
      .catch((err) => {
        unavailableSubagentTranscriptKeysRef.current.add(probeKey);
        setRealSubagentTranscript((prev) => prev?.id === snapshot.id ? null : prev);
        addTranscriptProbeNotice(`Subagent transcript unavailable; showing local reconstruction. ${err instanceof Error ? err.message : String(err)}`);
        setInspectedSubagentId(snapshot.id);
        setChatScrollOffset(0);
      });
  }, [addTranscriptProbeNotice, chatInfo.capability.canViewFullTranscript, setChatScrollOffset]);
  const inspectMainTranscript = useCallback(() => {
    const conn = connectionRef.current;
    const sessionId = activeSessionIdRef.current;
    const chatSession = activeSessionRef.current;
    if (
      !conn
      || !sessionId
      || chatInfoRef.current.provider !== "claude"
      || chatSession?.sessionId !== sessionId
      || chatSession.provider !== "claude"
    ) {
      setRealMainTranscript(null);
      setInspectedSubagentId(null);
      setChatScrollOffset(0);
      return;
    }
    void getMainTranscript(conn, { sessionId })
      .then((messages) => {
        const snapshot: SubagentSnapshot = {
          id: "main",
          name: "Full session transcript (SDK)",
          kind: "subagent",
          status: "completed",
          summary: "Provider-fidelity view; ADE-only events are not shown.",
        };
        const envelopes = messages && messages.length > 0
          ? subagentTranscriptMessagesToEvents({ messages, snapshot, sessionId })
          : [];
        if (!envelopes.length) {
          addTranscriptProbeNotice("Full session transcript unavailable.");
          setRealMainTranscript(null);
          return;
        }
        setInspectedSubagentId(null);
        setRealSubagentTranscript(null);
        setRealMainTranscript({ sessionId, envelopes });
        setChatScrollOffset(0);
      })
      .catch((err) => {
        addTranscriptProbeNotice(`Full session transcript unavailable. ${err instanceof Error ? err.message : String(err)}`);
        setRealMainTranscript(null);
      });
  }, [addTranscriptProbeNotice, setChatScrollOffset]);
  // Fetch the real child transcript for the inspected subagent when the runtime
  // can produce one (Codex app-server threads / OpenCode child sessions). Falls
  // back silently to local reconstruction on null/empty/error.
  useEffect(() => {
    const snapshot = selectedAgentSnapshot;
    if (!snapshot) {
      if (realSubagentTranscript) setRealSubagentTranscript(null);
      return;
    }
    const conn = connectionRef.current;
    const sessionId = activeSessionId;
    if (!conn || !sessionId || !chatInfo.capability.canViewFullTranscript) return;
    const probeKey = `${snapshot.id}:${snapshot.status}`;
    if (unavailableSubagentTranscriptKeysRef.current.has(probeKey)) return;
    // Re-fetch when the subagent's status changes (e.g. running → completed) so a
    // transcript first fetched mid-run is refreshed once the agent finishes,
    // rather than caching a partial transcript forever.
    if (realSubagentTranscript?.id === snapshot.id && realSubagentTranscript.status === snapshot.status) return;
    let cancelled = false;
    void getSubagentTranscript(conn, {
      sessionId,
      agentId: snapshot.id,
      laneId: activeLane?.id ?? null,
    })
      .then((messages) => {
        if (cancelled) return;
        const envelopes = messages && messages.length > 0
          ? subagentTranscriptMessagesToEvents({ messages, snapshot, sessionId })
          : [];
        if (envelopes.length === 0) {
          unavailableSubagentTranscriptKeysRef.current.add(probeKey);
          addTranscriptProbeNotice("Subagent transcript unavailable; showing local reconstruction.");
          return;
        }
        unavailableSubagentTranscriptKeysRef.current.delete(probeKey);
        setRealSubagentTranscript({
          id: snapshot.id,
          status: snapshot.status,
          envelopes,
        });
      })
      .catch(() => {
        unavailableSubagentTranscriptKeysRef.current.add(probeKey);
        addTranscriptProbeNotice("Subagent transcript unavailable; showing local reconstruction.");
      });
    return () => { cancelled = true; };
  }, [activeLane?.id, activeSessionId, addTranscriptProbeNotice, chatInfo.capability.canViewFullTranscript, realSubagentTranscript, selectedAgentSnapshot]);
  // Notices are a single global list, but each one is tagged with the scope it
  // fired in (a chat session, a specific new-chat draft, or null/global). A
  // new-chat draft shows only the notices fired in that exact draft so global
  // and prior-draft feedback ("Model set to…", "Created lane…") can't persist
  // into a fresh chat; every other view keeps the "this chat, or global
  // fallback" rule so cross-chat feedback can't bleed into the wrong transcript.
  const displayNotices = useMemo(
    () => selectVisibleNotices({
      notices,
      hasSelectedAgentSnapshot: Boolean(selectedAgentSnapshot),
      draftChatActive,
      draftScopeKey,
      activeSessionId,
    }),
    [notices, selectedAgentSnapshot, draftChatActive, draftScopeKey, activeSessionId],
  );
  // Aggregate the transcript exactly once per render and thread the result into
  // every consumer (scroll math, selection rows, selectable text, and ChatView
  // itself). Previously each of those re-walked the full event list, so a single
  // token caused ~4 full-transcript passes.
  const displayBlocks = useMemo(
    () => aggregateChatBlocks({
      events: displayEvents,
      notices: displayNotices,
      activeSession,
      expandedLineIds,
      pendingSteers: displayPendingSteers,
    }),
    [activeSession, displayEvents, displayNotices, displayPendingSteers, expandedLineIds],
  );
  const displayBlocksRef = useRef<AggregatedBlock[]>([]);
  useEffect(() => {
    displayBlocksRef.current = displayBlocks;
  }, [displayBlocks]);
  const displayStreaming = selectedAgentSnapshot ? selectedAgentSnapshot.status === "running" : streaming;
  const displayInterrupted = selectedAgentSnapshot ? false : interrupted && !displayStreaming;
  useEffect(() => {
    chatSelectionAnchorRef.current = null;
    stopChatSelectionEdgeScroll();
    updateChatMouseSelection(null);
  }, [selectedAgentSnapshot?.id, stopChatSelectionEdgeScroll, updateChatMouseSelection]);
  const spinTickActive = displayStreaming
    || (multiView?.tiles.some((tile) => streamingBySessionId[tile.sessionId]) ?? false)
    || mode === "connecting"
    || liveAgentCount > 0;
  const showChatWorkingIndicator = modelState.provider !== "claude" && activeSession?.provider !== "claude";
  const selectableChatRows = useMemo(() => renderChatSelectableRows({
    blocks: displayBlocks,
    expandedLineIds,
    width: chatWrapWidth,
    streaming: displayStreaming,
    interrupted: displayInterrupted,
    showWorkingIndicator: showChatWorkingIndicator,
  }), [chatWrapWidth, displayBlocks, displayInterrupted, displayStreaming, expandedLineIds, showChatWorkingIndicator]);
  const chatScrollMaxOffset = useMemo(() => {
    if (!hasConversationContent(displayBlocks) && !displayStreaming && !displayInterrupted) return 0;
    return chatScrollMaxOffsetFromSelectableRows({
      rows: selectableChatRows,
      maxRows: chatRowBudget,
    });
  }, [chatRowBudget, displayBlocks, displayInterrupted, displayStreaming, selectableChatRows]);
  chatScrollMaxOffsetRef.current = chatScrollMaxOffset;
  const effectiveChatScrollOffsetRows = clampChatScrollOffsetRows(chatScrollOffsetRows, chatScrollMaxOffset);
  chatScrollOffsetRowsRef.current = effectiveChatScrollOffsetRows;
  // Track the event-count snapshot at the moment the user was last anchored to
  // the bottom of the transcript. When they scroll up and new messages arrive,
  // the delta becomes the "↓ N new messages" pill count.
  if (effectiveChatScrollOffsetRows === 0) {
    lastSeenAtBottomEventCountRef.current = displayEvents.length;
  }
  const unseenMessageCount = effectiveChatScrollOffsetRows > 0
    ? Math.max(0, displayEvents.length - lastSeenAtBottomEventCountRef.current)
    : 0;
  const visibleChatSelectionRows = useMemo(() => renderChatVisibleSelectionRowsFromRows({
    rows: selectableChatRows,
    maxRows: chatRowBudget,
    scrollOffsetRows: effectiveChatScrollOffsetRows,
    unseenMessageCount,
  }), [
    chatRowBudget,
    effectiveChatScrollOffsetRows,
    selectableChatRows,
    unseenMessageCount,
  ]);
  selectableChatRowCountRef.current = selectableChatRows.length;
  selectableChatRowTextBuilderRef.current = () => renderChatSelectableRowTextsFromRows(selectableChatRows);
  const providerReadinessRows = useMemo(
    () => buildProviderReadinessRows(aiStatus, storedApiKeyProviders, openCodeDiagnostics),
    [aiStatus, openCodeDiagnostics, storedApiKeyProviders],
  );
  // Importing an external CLI session is NOT a new-chat setting — it is its own
  // command (`/import`). The new-chat rows carry model/interface/permission only.
  const newChatSetupRows = useMemo(
    () => buildSetupRows({
      modelState,
      models,
      includeRefresh: false,
      includeApply: true,
      outputStyle: "default",
      outputStyleEditable: false,
      // Draft: the interface is the user's editable Chat/CLI choice.
      interfaceMode: modelState.interfaceMode,
      interfaceEditable: true,
    }),
    [modelState, models],
  );
  // Once a session exists the interface is fixed by its type (a CLI terminal is
  // active ⇒ CLI; an SDK chat ⇒ Chat). With no committed session yet (/model on a
  // bare lane), it stays the editable draft pick.
  const modelSetupInterfaceMode: AdeCodeInterfaceMode = activeTerminalSession
    ? "cli"
    : activeSession?.sessionId
      ? "chat"
      : modelState.interfaceMode;
  const modelSetupInterfaceEditable = !activeSession?.sessionId && !activeTerminalSession;
  const modelSetupRows = useMemo(
    () => buildSetupRows({
      modelState,
      models,
      includeRefresh: true,
      includeApply: true,
      outputStyle: activeSession?.claudeOutputStyle ?? "default",
      outputStyleEditable: Boolean(activeSession?.sessionId && activeSession.provider === "claude"),
      interfaceMode: modelSetupInterfaceMode,
      interfaceEditable: modelSetupInterfaceEditable,
    }),
    [activeSession?.claudeOutputStyle, activeSession?.provider, activeSession?.sessionId, modelSetupInterfaceEditable, modelSetupInterfaceMode, modelState, models],
  );
  const modelPickerRows = useMemo(() => {
    if (!providerLocked) return modelSetupRows;
    return modelSetupRows.map((row) => row.kind === "provider"
      ? {
          ...row,
          disabled: true,
          cyclable: false,
          detail: "locked for this chat · /new chat to switch provider",
        }
      : row);
  }, [modelSetupRows, providerLocked]);

  // ── /model wizard ─────────────────────────────────────────────────────────
  // One pool (the same helper the legacy picker layout derives its entries
  // from) feeds every wizard step, so provider/family/model lists can never
  // disagree about which models exist. The view is rebuilt on every render of
  // the wizard pane, so the render, the keyboard handler, and the click
  // hit-test all read identical rows.
  const modelWizardEntries = useMemo(
    () => collectModelPickerEntries({
      models,
      catalog: modelCatalog,
      favorites: modelPickerFavorites,
      activeReasoningEffort: modelState.reasoningEffort,
      aiStatus,
      interfaceMode: modelState.interfaceMode,
    }),
    [aiStatus, modelCatalog, modelPickerFavorites, modelState.interfaceMode, modelState.reasoningEffort, models],
  );
  const modelWizardSettingsRows = rightPane.kind === "model-wizard" && rightPane.surface === "new-chat"
    ? newChatSetupRows
    : modelPickerRows;
  const modelWizardInput = useMemo<ModelWizardInput | null>(() => {
    if (rightPane.kind !== "model-wizard") return null;
    return {
      selection: {
        step: rightPane.step,
        provider: rightPane.provider,
        familyKey: rightPane.familyKey,
        index: rightPane.index,
      },
      entries: modelWizardEntries,
      recents: modelPickerRecents,
      settingsRows: modelWizardSettingsRows,
      activeModelId: modelState.modelId,
    };
  }, [modelPickerRecents, modelState.modelId, modelWizardEntries, modelWizardSettingsRows, rightPane]);
  const modelWizardView = useMemo(
    () => (modelWizardInput ? buildModelWizardView(modelWizardInput) : null),
    [modelWizardInput],
  );

  // Row highlighted in the /import browser — previewed in the CENTER pane so the
  // transcript is readable before Enter commits the import.
  const externalSessionPreviewTarget = useMemo(() => {
    if (rightPane.kind !== "external-session-browser") return null;
    const visible = visibleExternalSessions(rightPane.sessions, rightPane.providerFilter, rightPane.query);
    if (!visible.length) return null;
    return visible[Math.min(Math.max(0, rightPane.selectedIndex), visible.length - 1)] ?? null;
  }, [rightPane]);

  useEffect(() => {
    activeLaneIdRef.current = activeLaneId;
  }, [activeLaneId]);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    activeSessionRef.current = activeSession;
  }, [activeSession]);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    activeTerminalSessionRef.current = activeTerminalSession;
  }, [activeTerminalSession]);

  useEffect(() => {
    eventCountRef.current = events.length;
    if (!activeSessionId || activeTerminalSession) return;
    const fallbackContext = activeSession?.modelId
      ? getModelById(activeSession.modelId)?.contextWindow ?? null
      : null;
    const stats = latestTokenStats(events, fallbackContext);
    setCurrentGoal(latestGoal(events));
    setContextPercent(stats.percent);
    setTokenSummary(formatTokenSummary(stats));
    setStatusLineStats(stats);
  }, [activeSession?.modelId, activeSessionId, activeTerminalSession, events]);

  useEffect(() => {
    terminalSessionsRef.current = terminalSessions;
  }, [terminalSessions]);

  useEffect(() => {
    if (!activeTerminalSession) setTerminalPreview(null);
  }, [activeTerminalSession]);

  useEffect(() => {
    attachedTerminalIdRef.current = attachedTerminalId;
  }, [attachedTerminalId]);

  // Mirror terminal scroll state into a ref so the pty subscription (bound only
  // on reconnect) can read "is this session scrolled up?" without re-binding.
  const terminalScrollBySessionIdRef = useRef<TerminalScrollBySessionId>(terminalScrollBySessionId);
  useEffect(() => {
    terminalScrollBySessionIdRef.current = terminalScrollBySessionId;
  }, [terminalScrollBySessionId]);

  useEffect(() => {
    if (!connection || !activeTerminalSession) return;
    // In grid view the per-tile resize effect owns terminal sizing; running the
    // single-view (full-pane) resize too would thrash the PTY between sizes.
    if (gridViewActive) return;
    const cols = clampTerminalPaneCols(terminalControlActive ? terminalPaneWidth - 2 : terminalPaneWidth);
    const terminalRows = terminalControlActive
      ? Math.max(4, chatRowBudget - 1)
      : claudeTerminalRowsForPane(chatRowBudget);
    let cancelled = false;
    void resizeTerminal(connection, activeTerminalSession.terminalId, cols, terminalRows)
      .then(() => previewTerminal(connection, activeTerminalSession.terminalId))
      .then((preview) => {
        if (!cancelled && activeSessionIdRef.current === activeTerminalSession.terminalId) {
          setTerminalPreview((previous) => sameTerminalPreviewFrame(previous, preview) ? previous : preview);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [activeTerminalSession, chatRowBudget, terminalControlActive, connection, gridViewActive, terminalPaneWidth]);

  useEffect(() => {
    if (!connection || !activeTerminalSession) return;
    if (terminalControlActive) return;
    // Single-view preview poll only; grid tiles follow live pty chunks instead.
    if (gridViewActive) return;
    let cancelled = false;
    const refreshPreview = () => {
      void previewTerminal(connection, activeTerminalSession.terminalId)
        .then((preview) => {
          if (!cancelled && activeSessionIdRef.current === activeTerminalSession.terminalId) {
            setTerminalPreview((previous) => sameTerminalPreviewFrame(previous, preview) ? previous : preview);
          }
        })
        .catch(() => {
          if (!cancelled && activeSessionIdRef.current === activeTerminalSession.terminalId) {
            setTerminalPreview((previous) => previous === null ? previous : null);
          }
        });
    };
    refreshPreview();
    const timer = setInterval(refreshPreview, TERMINAL_PREVIEW_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [activeTerminalSession, chatRowBudget, terminalControlActive, connection, gridViewActive, terminalPaneWidth]);

  useEffect(() => {
    modelStateRef.current = modelState;
  }, [modelState]);

  useEffect(() => {
    chatScrollMaxOffsetRef.current = chatScrollMaxOffset;
    setChatScrollOffsetRows((previous) => {
      const next = clampChatScrollOffsetRows(previous, chatScrollMaxOffset);
      chatScrollOffsetRowsRef.current = next;
      return next;
    });
  }, [chatScrollMaxOffset]);

  /**
   * Page one block of OLDER transcript history into the active single-chat
   * view. Stable deps (refs only); guarded to one in-flight fetch per session
   * and never refetches the same cursor offset. Pages can legitimately be
   * empty while the cursor still advances (oversized-line skip), so we follow
   * the cursor a bounded number of times until events arrive or it ends.
   */
  const loadOlderHistoryForActiveSession = useCallback(async () => {
    const sessionId = activeSessionIdRef.current;
    const conn = connectionRef.current;
    if (!sessionId || !conn) return;
    // Only page into a transcript we actually hydrated (and that the user
    // hasn't locally cleared — paging would just resurrect pre-clear events).
    if (loadedSessionIdRef.current !== sessionId) return;
    if (clearedAtRef.current) return;
    // Phase 1 — drain the snapshot remainder locally. The displayed window is
    // the newest 500 snapshot events; everything older from the SAME snapshot
    // sits in this buffer, so prepending its newest chunk is contiguous by
    // construction. Synchronous (no network), so no loading state is shown.
    const buffered = olderSnapshotBufferBySessionIdRef.current[sessionId];
    if (buffered && buffered.length > 0) {
      const { chunk, rest } = takeNewestChunk(buffered);
      if (rest.length > 0) olderSnapshotBufferBySessionIdRef.current[sessionId] = rest;
      else delete olderSnapshotBufferBySessionIdRef.current[sessionId];
      setEvents((prev) => {
        const next = prependOlderTuiHistory(prev, chunk);
        if (next === prev) return prev;
        if (prev.length + chunk.length > TUI_LOADED_EVENT_CAP) {
          detachedHistorySessionIdsRef.current.add(sessionId);
        }
        eventDedupKeyOrderRef.current = syncTuiEventDedupKeys(eventDedupKeysRef.current, next);
        eventCountRef.current = next.length;
        lastSeenAtBottomEventCountRef.current += next.length - prev.length;
        return next;
      });
      return;
    }
    // Phase 2 — buffer drained: page older transcript bytes over the wire.
    // tailStartOffset marks where the FULL snapshot tail began, so with the
    // buffer empty the byte cursor continues exactly where the buffer ended.
    const cursor = olderHistoryCursorBySessionIdRef.current[sessionId];
    if (!cursor || !cursor.hasMore || cursor.loading) return;
    cursor.loading = true;
    setOlderHistoryStatusBySessionId((prev) => ({ ...prev, [sessionId]: "loading" }));
    try {
      for (let attempt = 0; attempt < 6 && cursor.hasMore; attempt += 1) {
        const beforeOffset = cursor.beforeOffset;
        if (cursor.lastRequestedBeforeOffset === beforeOffset) break;
        cursor.lastRequestedBeforeOffset = beforeOffset;
        let page: Awaited<ReturnType<typeof getChatHistoryPage>> | null = null;
        let pageError: unknown = null;
        for (let retry = 0; retry < 3; retry += 1) {
          if (retry > 0) {
            await new Promise((resolve) => setTimeout(resolve, retry === 1 ? 250 : 750));
          }
          try {
            const candidate = await getChatHistoryPage(conn, sessionId, beforeOffset);
            if (candidate.unavailable === true) {
              throw new Error("Chat history is temporarily unavailable.");
            }
            page = candidate;
            break;
          } catch (error) {
            pageError = error;
          }
        }
        if (!page) throw pageError ?? new Error("Couldn’t load earlier messages.");
        // Returning to Latest or rehydrating the session replaces the cursor
        // object. Never let an older in-flight page mutate that fresh window.
        if (olderHistoryCursorBySessionIdRef.current[sessionId] !== cursor) return;
        const advanced = advanceOlderHistoryCursor(
          { beforeOffset, hasMore: cursor.hasMore },
          page,
        );
        cursor.beforeOffset = advanced.beforeOffset;
        cursor.hasMore = advanced.hasMore;
        if (page.events.length === 0) continue;
        if (activeSessionIdRef.current === sessionId && loadedSessionIdRef.current === sessionId) {
          setEvents((prev) => {
            const next = prependOlderTuiHistory(prev, page.events);
            if (next === prev) return prev;
            if (prev.length + page.events.length > TUI_LOADED_EVENT_CAP) {
              detachedHistorySessionIdsRef.current.add(sessionId);
            }
            // Prepending rows above a bottom-anchored viewport keeps the
            // visible rows in place (offset counts up from the newest row),
            // but the dedup-key order and the "new messages since bottom"
            // baseline are positional and must absorb the prepended block.
            eventDedupKeyOrderRef.current = syncTuiEventDedupKeys(eventDedupKeysRef.current, next);
            eventCountRef.current = next.length;
            lastSeenAtBottomEventCountRef.current += next.length - prev.length;
            return next;
          });
          // The active-session events effect mirrors `events` into
          // eventsBySessionId, so no manual mirror is needed here.
        } else {
          // Session switched away mid-fetch: still fold the page into the
          // per-session cache when one exists so the work isn't wasted.
          setEventsBySessionId((prev) => {
            const existing = prev[sessionId];
            if (!existing) return prev;
            const next = prependOlderTuiHistory(existing, page.events);
            return next === existing ? prev : { ...prev, [sessionId]: next };
          });
        }
        break;
      }
    } catch {
      // Transient fetch failure — re-arm the same offset so the next scroll
      // trigger can retry.
      cursor.lastRequestedBeforeOffset = null;
      setOlderHistoryStatusBySessionId((prev) => ({ ...prev, [sessionId]: "error" }));
    } finally {
      cursor.loading = false;
      setOlderHistoryStatusBySessionId((prev) => {
        // The cursor may have been cleared (/clear, session reset) or re-seeded
        // (re-hydration) while this fetch was in flight — don't resurrect a
        // stale status entry for it.
        if (olderHistoryCursorBySessionIdRef.current[sessionId] !== cursor) return prev;
        if (prev[sessionId] === "error") return prev;
        return { ...prev, [sessionId]: cursor.hasMore ? "available" : "exhausted" };
      });
    }
  }, []);

  const returnActiveHistoryToLatest = useCallback(async () => {
    const sessionId = activeSessionIdRef.current;
    const conn = connectionRef.current;
    if (!sessionId || !conn || !detachedHistorySessionIdsRef.current.has(sessionId)) return;
    if (returningHistoryToLatestSessionIdsRef.current.has(sessionId)) return;
    returningHistoryToLatestSessionIdsRef.current.add(sessionId);
    try {
      const history = await getChatHistory(conn, sessionId);
      // The user may switch chats, or a normal hydration may restore this
      // session, while the tail request is in flight. Never overwrite that
      // newer active view with this stale response.
      if (
        activeSessionIdRef.current !== sessionId
        || !detachedHistorySessionIdsRef.current.has(sessionId)
      ) return;
      if (history.unavailable === true || history.sessionFound === false) return;
      const bufferedLive = detachedLiveEventsBySessionIdRef.current[sessionId] ?? [];
      const deduped = mergeDetachedTuiHistoryTail(history.events, bufferedLive);
      const { display, buffer } = splitSnapshotForDisplay(deduped);
      commitActiveSessionEvents(sessionId, display, history.events.length);
      if (buffer.length > 0) olderSnapshotBufferBySessionIdRef.current[sessionId] = buffer;
      else delete olderSnapshotBufferBySessionIdRef.current[sessionId];
      seedOlderHistoryCursor(sessionId, resolveSnapshotHistoryCursor(history));
      detachedHistorySessionIdsRef.current.delete(sessionId);
      delete detachedLiveEventsBySessionIdRef.current[sessionId];
      setChatScrollOffsetRows(0);
      chatScrollOffsetRowsRef.current = 0;
    } catch {
      setOlderHistoryStatusBySessionId((prev) => ({ ...prev, [sessionId]: "error" }));
    } finally {
      returningHistoryToLatestSessionIdsRef.current.delete(sessionId);
    }
  }, [commitActiveSessionEvents, seedOlderHistoryCursor]);

  // Infinite scroll-back trigger: the user is at (or within ~3 rows of) the
  // top of the loaded transcript in the ACTIVE single-chat view. Wheel and
  // keyboard scrolling both feed effectiveChatScrollOffsetRows, so this effect
  // is the single trigger point.
  useEffect(() => {
    if (!activeSessionId || gridViewActive || activeTerminalSession || selectedAgentSnapshot) return;
    // Local snapshot buffer first, then the byte cursor — sessions with a
    // >500-event snapshot are drainable even when the transcript was never
    // file-truncated (no byte cursor at all).
    const buffered = olderSnapshotBufferBySessionIdRef.current[activeSessionId]?.length ?? 0;
    const cursor = olderHistoryCursorBySessionIdRef.current[activeSessionId];
    if (!shouldRequestOlderTuiHistory({
      scrollMaxOffset: chatScrollMaxOffset,
      scrollOffset: effectiveChatScrollOffsetRows,
      bufferedEventCount: buffered,
      cursor: cursor ?? null,
      status: olderHistoryStatusBySessionId[activeSessionId] ?? null,
    })) return;
    void loadOlderHistoryForActiveSession();
  }, [
    activeSessionId,
    activeTerminalSession,
    chatScrollMaxOffset,
    effectiveChatScrollOffsetRows,
    gridViewActive,
    loadOlderHistoryForActiveSession,
    olderHistoryStatusBySessionId,
    selectedAgentSnapshot,
  ]);

  // Context-aware default for the right pane. Runs whenever one of the inputs
  // changes — but leaves the pane alone while a slash command (sticky) or any
  // other non-default content is showing. The sticky marker is cleared on chat
  // switch (in selectActiveSessionId) and on explicit close (Esc / pane:close).
  // Lane details auto-open only when the cursor is on a lane header. A
  // session, shelf, or still-hydrating selection must not borrow the active
  // lane — that was the Primary ↔ Chat Info strobe on first paint, and the
  // reason clicking snoozed/settled swapped the right pane.
  const highlightedDrawerLane = useMemo(() => {
    if (workSelectionKind !== "lane") return null;
    const id = selectedDrawerLaneId ?? drawerLaneId ?? activeLaneId;
    if (!id) return null;
    return lanes.find((lane) => lane.id === id) ?? null;
  }, [activeLaneId, drawerLaneId, lanes, selectedDrawerLaneId, workSelectionKind]);

  const drawerPreviewSession = useMemo(() => {
    if (workSelectionKind !== "session" || !selectedDrawerChatId) return null;
    return displaySessions.find((session) => session.sessionId === selectedDrawerChatId) ?? null;
  }, [displaySessions, selectedDrawerChatId, workSelectionKind]);

  const drawerPreviewChatInfo = useMemo(() => {
    if (!drawerPreviewSession) return null;
    let previewEvents: AgentChatEventEnvelope[] = [];
    if (drawerPreviewSession.sessionId === activeSessionId) {
      previewEvents = events;
    } else if (eventsBySessionId[drawerPreviewSession.sessionId]) {
      previewEvents = eventsBySessionId[drawerPreviewSession.sessionId] ?? [];
    } else if (drawerPreviewSessionId === drawerPreviewSession.sessionId) {
      previewEvents = drawerPreviewEvents;
    }
    const lane = lanes.find((entry) => entry.id === drawerPreviewSession.laneId) ?? drawerLane ?? null;
    return deriveDrawerPreviewChatInfo(
      drawerPreviewSession,
      previewEvents,
      lane,
    );
  }, [
    activeSessionId,
    drawerLane?.name,
    drawerPreviewEvents,
    drawerPreviewSession,
    drawerPreviewSessionId,
    events,
    eventsBySessionId,
    lanes,
  ]);

  const drawerNavTarget = useMemo((): DrawerNavTarget | null => {
    if (!drawerOpen) return null;
    if (workSelectionKind === "lane") {
      const lane = highlightedDrawerLane ?? drawerLane ?? activeLane;
      return lane ? { kind: "lane", lane } : null;
    }
    if (workSelectionKind === "new-chat" || selectedWorkChatAction === "new-chat") {
      const laneId = drawerLaneId ?? activeLaneId;
      const lane = lanes.find((entry) => entry.id === laneId) ?? drawerLane ?? activeLane;
      if (!laneId || !lane || unavailableLaneIds.has(laneId)) return null;
      return {
        kind: "new-chat",
        laneId,
        laneLabel: lane.name,
        rows: newChatSetupRows,
      };
    }
    if (drawerPreviewSession && drawerPreviewChatInfo) {
      return { kind: "chat", info: drawerPreviewChatInfo };
    }
    return null;
  }, [
    activeLane,
    drawerLane,
    drawerLaneId,
    drawerOpen,
    drawerPreviewChatInfo,
    drawerPreviewSession,
    highlightedDrawerLane,
    lanes,
    newChatSetupRows,
    workSelectionKind,
    selectedWorkChatAction,
    unavailableLaneIds,
    activeLaneId,
  ]);

  useEffect(() => {
    if (rightPane.kind !== "chat-info") return;
    if (drawerOpen && drawerPreviewSession && drawerPreviewChatInfo) return;
    setRightPane({ kind: "chat-info", info: chatInfo });
  }, [chatInfo, drawerOpen, drawerPreviewChatInfo, drawerPreviewSession, rightPane.kind]);

  useEffect(() => {
    if (!drawerOpen || activePane !== "drawer" || workSelectionKind !== "session") {
      setDrawerPreviewSessionId(null);
      setDrawerPreviewEvents([]);
      return;
    }
    if (selectedWorkChatAction !== null || !selectedDrawerChatId) {
      setDrawerPreviewSessionId(null);
      setDrawerPreviewEvents([]);
      return;
    }
    if (selectedDrawerChatId === activeSessionId) {
      setDrawerPreviewSessionId(selectedDrawerChatId);
      setDrawerPreviewEvents([]);
      return;
    }
    let cancelled = false;
    const sessionId = selectedDrawerChatId;
    const loadPreview = async () => {
      const conn = connectionRef.current;
      if (!conn) return;
      try {
        const history = await getChatHistory(conn, sessionId);
        if (cancelled || selectedDrawerChatId !== sessionId) return;
        setDrawerPreviewSessionId(sessionId);
        setDrawerPreviewEvents(history.sessionFound === false ? [] : history.events);
      } catch {
        if (!cancelled) {
          setDrawerPreviewSessionId(sessionId);
          setDrawerPreviewEvents([]);
        }
      }
    };
    void loadPreview();
    const session = displaySessions.find((entry) => entry.sessionId === sessionId);
    const poll = session?.status === "active"
      ? setInterval(() => {
          void loadPreview();
        }, 2_000)
      : null;
    return () => {
      cancelled = true;
      if (poll) clearInterval(poll);
    };
  }, [
    activePane,
    activeSessionId,
    displaySessions,
    drawerOpen,
    selectedWorkChatAction,
    selectedDrawerChatId,
    workSelectionKind,
  ]);

  useEffect(() => {
    // If the user explicitly opened a pane via a slash command, leave it alone.
    if (lastUserOpenedPaneRef.current !== null) return;
    // A closed pane must stay closed: rewriting its contents every poll is what
    // made the right column strobe on first load.
    if (!rightOpen) return;
    // Form panes (rename, new-lane, pr-open) are user-driven; never overwrite.
    if (rightPane.kind === "form") return;
    if (rightPane.kind === "model-picker") return;
    if (rightPane.kind === "model-wizard") return;
    if (rightPane.kind === "external-session-browser") return;
    if (pendingQuestionStateRef.current) return;
    const next = resolveContextDefault({
      draftChatActive: draftChatActiveRef.current,
      // Includes Claude terminal sessions so their context default is the
      // chat-info pane (resume row + status), not lane-details.
      activeSession: activeDisplaySession,
      activeLane,
      liveAgentCount,
      highlightedDrawerLane,
      drawerNav: drawerNavTarget,
      chatInfo,
      subagentSnapshots,
      provider: (activeDisplaySession?.provider ?? modelState.provider) as AdeCodeProvider,
      unavailableLaneIds,
      newChatSetup: (drawerLaneId ?? activeLaneId)
        ? {
            laneId: drawerLaneId ?? activeLaneId!,
            laneLabel: drawerLane?.name ?? activeLane?.name ?? drawerLaneId ?? activeLaneId!,
            rows: newChatSetupRows,
          }
        : null,
    });
    setRightPane((prev) => {
      if (prev.kind === "chat-info" && next.kind === "chat-info") {
        return prev;
      }
      // Do not bounce Chat Info to Primary lane-details while the active
      // session is still hydrating. Opening lane details is Enter, a
      // singleton identity click, or `/lane details` — not this effect.
      if (prev.kind === "chat-info" && next.kind === "lane-details") {
        return prev;
      }
      if (prev.kind === "model-picker" && prev.surface === "new-chat" && next.kind === "model-picker" && next.surface === "new-chat") {
        return mergeNewChatModelPickerContext(prev, next);
      }
      // Avoid stomping on lane-details that has been hydrated with git data;
      // only refresh when the lane reference itself changed.
      if (
        prev.kind === "lane-details"
        && next.kind === "lane-details"
        && prev.lane.id === next.lane.id
        && prev.worktreeAvailable === next.worktreeAvailable
      ) {
        return prev;
      }
      if (prev.kind === next.kind && next.kind === "empty") return prev;
      return next;
    });
  }, [
    activeDisplaySession,
    activeLane,
    activeLaneId,
    chatInfo,
    draftChatActive,
    drawerLane,
    drawerLaneId,
    drawerNavTarget,
    highlightedDrawerLane,
    liveAgentCount,
    modelState.provider,
    newChatSetupRows,
    rightOpen,
    rightPane.kind,
    selectedWorkChatAction,
    subagentSnapshots,
    unavailableLaneIds,
  ]);

  useEffect(() => {
    if (rightPane.kind === "model-wizard" && rightPane.surface === "new-chat") {
      // The wizard's rows are re-derived live (modelWizardSettingsRows); only
      // the lane it will commit into has to be kept current here.
      setRightPane((prev) => {
        if (prev.kind !== "model-wizard" || prev.surface !== "new-chat") return prev;
        const laneId = drawerNavTarget?.kind === "new-chat" ? drawerNavTarget.laneId : activeLaneId ?? prev.laneId;
        const laneLabel = drawerNavTarget?.kind === "new-chat"
          ? drawerNavTarget.laneLabel
          : activeLane?.name ?? prev.laneLabel;
        return prev.laneId === laneId && prev.laneLabel === laneLabel
          ? prev
          : { ...prev, laneId, laneLabel };
      });
    } else if (rightPane.kind === "lane-details") {
      setRightPane((prev) => prev.kind === "lane-details"
        ? {
            ...prev,
            chats: computeLaneChatCounts(displaySessions, prev.lane.id),
          }
        : prev);
    }
  }, [activeLane?.name, activeLaneId, displaySessions, drawerNavTarget, rightPane.kind]);

  useEffect(() => {
    const { config } = readClaudeStatusLineConfig(project.workspaceRoot);
    if (!config) {
      setStatusLineText(null);
      setHideVimModeIndicator(false);
      return;
    }
    setHideVimModeIndicator(config.hideVimModeIndicator);
    let cancelled = false;
    const refresh = async () => {
      const totalInputTokens = statusLineStats?.inputTokens ?? null;
      const totalOutputTokens = statusLineStats?.outputTokens ?? null;
      const cacheCreationTokens = statusLineStats?.cacheCreationTokens ?? null;
      const cacheReadTokens = statusLineStats?.cacheReadTokens ?? null;
      const contextWindowSize = statusLineStats?.contextWindow ?? null;
      const contextUsed = totalInputTokens != null || totalOutputTokens != null
        ? (totalInputTokens ?? 0) + (totalOutputTokens ?? 0)
        : null;
      const contextUsedPercentage = contextPercent ?? (
        contextUsed != null && contextWindowSize != null && contextWindowSize > 0
          ? Math.round((contextUsed / contextWindowSize) * 100)
          : null
      );
      const rateLimitWindow = statusLineStats?.rateLimit
        ? {
            used_percentage: statusLineStats.rateLimit.usedPercentage,
            resets_at: statusLineStats.rateLimit.resetsAt,
          }
        : null;
      const result = await runClaudeStatusLineCommand(config, {
        cwd: project.workspaceRoot,
        workspaceRoot: project.workspaceRoot,
        projectRoot: project.projectRoot,
        model: {
          id: modelState.modelId,
          displayName: modelState.displayName,
          display_name: modelState.displayName,
          provider: modelState.provider,
          fastMode: modelState.fastMode,
          supportsEffort: modelReasoningEfforts(modelState, models).length > 0,
        },
        workspace: {
          current_dir: project.workspaceRoot,
          project_dir: project.projectRoot,
          added_dirs: [],
          git_worktree: activeLane?.branchRef ?? null,
          gitBranch: activeLane?.branchRef ?? null,
        },
        session: {
          id: activeSession?.sessionId ?? activeSessionId,
          title: activeSession?.title ?? null,
        },
        session_id: activeSession?.sessionId ?? activeSessionId,
        session_name: activeSession?.title ?? null,
        lane: activeLane?.name ?? activeLaneId,
        permission_mode: modelState.provider === "claude"
          ? modelState.claudePermissionMode
          : modelState.permissionMode,
        context: {
          percent: contextUsedPercentage,
          tokenSummary,
        },
        context_window: {
          used: contextUsed,
          total: contextWindowSize,
          percentage: contextUsedPercentage,
          used_percentage: contextUsedPercentage,
          remaining_percentage: contextUsedPercentage == null ? null : Math.max(0, 100 - contextUsedPercentage),
          total_input_tokens: totalInputTokens,
          total_output_tokens: totalOutputTokens,
          context_window_size: contextWindowSize,
          current_usage: {
            input_tokens: totalInputTokens,
            output_tokens: totalOutputTokens,
            cache_creation_input_tokens: cacheCreationTokens,
            cache_read_input_tokens: cacheReadTokens,
          },
        },
        rate_limits: rateLimitWindow
          ? {
              reset_at: rateLimitWindow.resets_at ? new Date(rateLimitWindow.resets_at * 1000).toISOString() : null,
              remaining: rateLimitWindow.used_percentage == null ? null : Math.max(0, 100 - rateLimitWindow.used_percentage),
              five_hour: rateLimitWindow,
              seven_day: rateLimitWindow,
            }
          : { five_hour: null, seven_day: null, reset_at: null, remaining: null },
        cost: {
          total_cost_usd: statusLineStats?.costUsd ?? null,
          total_duration_ms: null,
          total_api_duration_ms: null,
          total_lines_added: null,
          total_lines_removed: null,
        },
        output_style: {
          name: activeSession?.claudeOutputStyle ?? null,
        },
        effort: {
          level: activeSession?.reasoningEffort ?? modelState.reasoningEffort ?? null,
        },
        thinking: {
          enabled: Boolean(activeSession?.reasoningEffort ?? modelState.reasoningEffort),
        },
        vim: {
          mode: vimModeEnabled ? (vimMode === "normal" ? "NORMAL" : "INSERT") : "INSERT",
        },
        transcript_path: null,
        version: "ade-code",
      });
      if (cancelled) return;
      const padding = " ".repeat(config.padding);
      setStatusLineText(result.ok && result.text
        ? result.text.split(/\r?\n/).map((line) => `${padding}${line}`).join("\n")
        : null);
    };
    // Trailing debounce: this effect re-fires on every 'events' change (its deps
    // include freshly-allocated statusLineStats/contextPercent/tokenSummary), so
    // during streaming an unguarded refresh would fork a status-line shell many
    // times/sec. Coalesce the burst; steady-state behaviour is unchanged.
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefresh = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        void refresh();
      }, 300);
    };
    scheduleRefresh();
    const timer = config.refreshIntervalSeconds == null
      ? null
      : setInterval(() => {
          void refresh();
        }, config.refreshIntervalSeconds * 1000);
    return () => {
      cancelled = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      if (timer) clearInterval(timer);
    };
  }, [activeLane?.branchRef, activeLane?.name, activeLaneId, activeSession?.claudeOutputStyle, activeSession?.reasoningEffort, activeSession?.sessionId, activeSession?.title, activeSessionId, contextPercent, modelState, models, project.projectRoot, project.workspaceRoot, statusLineStats, tokenSummary, vimMode, vimModeEnabled]);

  const rightPaneLaneId = rightPane.kind === "lane-details" ? rightPane.lane.id : null;

  useEffect(() => {
    if (!rightOpen) return;
    if (rightPane.kind !== "empty" && rightPane.kind !== "lane-details") return;
    const lane = rightPane.kind === "lane-details"
      ? lanes.find((candidate) => candidate.id === rightPane.lane.id) ?? rightPane.lane
      : highlightedDrawerLane ?? activeLane;
    if (!lane) return;

    let cancelled = false;
    const laneId = lane.id;

    const refresh = async () => {
      const conn = connectionRef.current;
      if (!conn) return;
      try {
        const [syncRes, changesRes, prsRes] = await Promise.all([
          conn.action<{ ahead?: number; behind?: number; upstreamRef?: string | null }>("git", "getSyncStatus", { laneId }).catch(() => null),
          conn.actionList<{ staged: { path: string; kind: string }[]; unstaged: { path: string; kind: string }[] }>("diff", "getChanges", [laneId]).catch(() => null),
          conn.action<Array<Record<string, unknown>>>("pr", "listAll", { laneId }).catch(() => [] as Array<Record<string, unknown>>),
        ]);
        if (cancelled) return;

        const ahead = typeof syncRes?.ahead === "number" ? syncRes.ahead : 0;
        const behind = typeof syncRes?.behind === "number" ? syncRes.behind : 0;
        const remote = typeof syncRes?.upstreamRef === "string" ? syncRes.upstreamRef : null;

        const staged = changesRes?.staged ?? [];
        const unstaged = changesRes?.unstaged ?? [];
        const fileMap = new Map<string, { path: string; status: "M" | "A" | "D" | "?"; staged: boolean }>();
        const toStatus = (kind: string): "M" | "A" | "D" | "?" => {
          if (kind === "added" || kind === "untracked") return kind === "untracked" ? "?" : "A";
          if (kind === "deleted") return "D";
          if (kind === "modified" || kind === "renamed") return "M";
          return "?";
        };
        for (const file of staged) {
          fileMap.set(file.path, { path: file.path, status: toStatus(file.kind), staged: true });
        }
        for (const file of unstaged) {
          if (!fileMap.has(file.path)) {
            fileMap.set(file.path, { path: file.path, status: toStatus(file.kind), staged: false });
          }
        }
        const files = [...fileMap.values()];
        const laneDiffStats = diffByLaneId[laneId];

        const activePr = prsRes[0] ?? null;
        let pr: {
          number: number;
          state: "open" | "closed" | "merged";
          url: string;
          checksPassed: number;
          checksTotal: number;
          checksPending: number;
          checksStatus?: PrChecksStatus;
          checksFailed: number;
        } | null = null;
        if (activePr) {
          const number = typeof activePr.githubPrNumber === "number"
            ? activePr.githubPrNumber
            : typeof activePr.number === "number"
              ? activePr.number
              : null;
          const url = typeof activePr.githubUrl === "string"
            ? activePr.githubUrl
            : typeof activePr.url === "string"
              ? activePr.url
              : "";
          const rawState = typeof activePr.state === "string" ? activePr.state : "open";
          const state: "open" | "closed" | "merged" =
            rawState === "merged" ? "merged" : rawState === "closed" ? "closed" : "open";
          const prId = typeof activePr.id === "string" ? activePr.id : typeof activePr.prId === "string" ? activePr.prId : "";
          let checksPassed = 0;
          let checksTotal = 0;
          let checksPending = 0;
          let checksFailed = 0;
          let checksStatus: PrChecksStatus = "none";
          if (prId) {
            const checks = await conn.actionList<Array<{ status?: string; conclusion?: string | null; appSlug?: string | null }>>("pr", "getChecks", [prId]).catch(() => null);
            if (!cancelled && Array.isArray(checks)) {
              // ADE-135: this hand-rolled the tally the rest of the branch
              // centralised, and it was producer-blind — three third-party
              // successes rendered `3/3` in the green theme colour, which is
              // the ticket's exact lie on the TUI.
              const rollup = rollupPrChecks(
                checks.map((check) => ({
                  status: check.status ?? "",
                  conclusion: check.conclusion ?? null,
                  appSlug: check.appSlug ?? null,
                })),
              );
              checksTotal = rollup.counts.total;
              checksPassed = rollup.counts.passing;
              checksFailed = rollup.counts.failing;
              checksPending = rollup.counts.pending;
              checksStatus = rollup.status;
            }
          }
          if (number != null && url) {
            pr = { number, state, url, checksPassed, checksTotal, checksPending, checksFailed, checksStatus };
          }
        }

        if (cancelled) return;
        const chatCounts = computeLaneChatCounts(displaySessions, laneId);
        const setup = laneSetupStatusByLaneId[laneId] ?? null;
        setRightPane((prev) => {
          if (cancelled) return prev;
          if (prev.kind !== "lane-details" && prev.kind !== "empty") return prev;
          if (prev.kind === "lane-details" && prev.lane.id !== laneId) return prev;
          const previousIndex = prev.kind === "lane-details" ? prev.selectedActionIndex : 0;
          const previousShowFiles = prev.kind === "lane-details" ? prev.showFiles : false;
          const previousSetup = prev.kind === "lane-details" ? prev.setup ?? null : null;
          const maxIndex = LANE_DETAIL_ACTIONS.length - 1 + (pr ? 1 : 0);
          return {
            kind: "lane-details",
            lane,
            git: {
              staged: staged.length,
              unstaged: unstaged.length,
              total: laneDiffStats?.files ?? files.length,
              ahead,
              behind,
              remote,
              additions: laneDiffStats?.additions ?? 0,
              deletions: laneDiffStats?.deletions ?? 0,
            },
            files,
            setup: setup ?? previousSetup,
            pr,
            chats: chatCounts,
            showFiles: previousShowFiles,
            selectedActionIndex: Math.max(0, Math.min(previousIndex, maxIndex)),
            worktreeAvailable: !unavailableLaneIds.has(lane.id),
          };
        });
      } catch {
        // best-effort — leave the existing pane content alone on transient errors
      }
    };

    void refresh();
    const interval = setInterval(() => {
      void refresh();
    }, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [activeLane, diffByLaneId, displaySessions, highlightedDrawerLane, laneSetupStatusByLaneId, lanes, rightOpen, rightPane.kind, rightPaneLaneId, unavailableLaneIds]);

  useEffect(() => {
    if (!drawerLaneId || !lanes.some((lane) => lane.id === drawerLaneId)) {
      setDrawerLaneId(activeLaneId);
    }
  }, [activeLaneId, drawerLaneId, lanes]);

  useEffect(() => {
    if (selectedDrawerLaneId && lanes.some((lane) => lane.id === selectedDrawerLaneId)) return;
    setSelectedDrawerLaneId(drawerLaneId ?? activeLaneId ?? lanes[0]?.id ?? null);
  }, [activeLaneId, drawerLaneId, lanes, selectedDrawerLaneId]);

  // Keep the pane's cursor on a row that still exists. One key over one flat row
  // list, so unlike the drawer's three-way reconcile it cannot land on a row the
  // pane never rendered.
  useEffect(() => {
    if (addMode) return;
    const next = resolveWorkListSelection({
      rows: workListModel.rows,
      selectedKey: workSelectedKey,
      activeSessionId,
      draftLaneId: draftChatActive ? drawerLaneId ?? activeLaneId : null,
    });
    if (!next) return;
    setWorkSelectedKey(next.selectedKey);
    const row = workListModel.rows.find((entry) => entry.key === next.selectedKey) ?? null;
    if (row?.kind === "session") {
      setSelectedDrawerChatId(row.sessionId);
      setSelectedWorkChatAction(null);
      if (row.laneId) {
        setDrawerLaneId(row.laneId);
        setSelectedDrawerLaneId(row.laneId);
      }
    } else if (row?.kind === "lane-header" && row.laneId) {
      setSelectedDrawerLaneId(row.laneId);
    }
  }, [activeLaneId, activeSessionId, addMode, draftChatActive, drawerLaneId, workListModel.rows, workSelectedKey]);

  useEffect(() => {
    setSlashIndex(0);
  }, [prompt]);

  const addNotice = useCallback((text: string, tone: LocalNotice["tone"] = "info") => {
    const sessionId = noticeScopeId({
      activeSessionId: activeSessionIdRef.current,
      draftChatActive: draftChatActiveRef.current,
      draftScopeKey: draftScopeKeyRef.current,
    });
    setNotices((prev) => [
      ...prev.slice(-10),
      { id: noticeId(), timestamp: new Date().toISOString(), text, tone, sessionId },
    ]);
  }, []);
  const openLaneDetailsPane = useCallback((lane: LaneSummary) => {
    selectActiveLaneId(lane.id);
    setDrawerLaneId(lane.id);
    setSelectedDrawerLaneId(lane.id);
    setRightPane(seedLaneDetails(lane, !laneWorktreeUnavailableMessage(lane)));
    setRightOpen(true);
    lastUserOpenedPaneRef.current = "lane-details";
    const unavailableMessage = laneWorktreeUnavailableMessage(lane);
    if (unavailableMessage) addNotice(unavailableMessage, "error");
  }, [addNotice, selectActiveLaneId]);

  /**
   * Say why a plugin's shortcut is not bound — once, in the matrix's own words.
   *
   * A notice rather than a console line because this is an Ink app: stdout is
   * the render surface, so `console.warn` would corrupt the frame. The message
   * is never composed here; the shared matrix wrote it so that the desktop and
   * this client explain the same refusal identically.
   */
  useEffect(() => {
    for (const refusal of mergedKeybindings.refusals) {
      const id = `${refusal.pluginId}::${refusal.action}::${refusal.binding}::${refusal.reason}`;
      if (loggedKeybindingRefusalsRef.current.has(id)) continue;
      loggedKeybindingRefusalsRef.current.add(id);
      addNotice(refusal.message, "info");
    }
  }, [addNotice, mergedKeybindings]);

  const runLaneSetupAfterCreate = useCallback((conn: AdeCodeConnection, lane: LaneSummary, options: { templateId?: string | null } = {}) => {
    const templateId = options.templateId?.trim() || null;
    const running: LaneSetupStatus = {
      status: "running",
      label: templateId ? `applying setup template ${templateId}` : "setting up lane environment",
      templateId,
    };
    setLaneSetupStatusByLaneId((prev) => ({ ...prev, [lane.id]: running }));
    setRightPane((prev) => prev.kind === "lane-details" && prev.lane.id === lane.id
      ? { ...prev, setup: running }
      : prev);
    void runDefaultLaneSetup(conn, lane.id, { templateId })
      .then(({ progress, templateId: appliedTemplateId }) => {
        if (progress.overallStatus !== "failed") {
          const completed: LaneSetupStatus = {
            status: "completed",
            label: appliedTemplateId ? `setup template ${appliedTemplateId} applied` : "lane environment ready",
            templateId: appliedTemplateId,
          };
          setLaneSetupStatusByLaneId((prev) => ({ ...prev, [lane.id]: completed }));
          setRightPane((prev) => prev.kind === "lane-details" && prev.lane.id === lane.id
            ? { ...prev, setup: completed }
            : prev);
          return;
        }
        const failedStep = progress.steps.find((step) => step.status === "failed");
        // An init the host cancelled because the lane is being archived or
        // deleted also ends `failed`, but with every remaining step `skipped`
        // and no failed step at all. `skipped` carries a reason, not a fault —
        // reporting the user's own teardown as a red failure (with "press r to
        // retry" for a lane that is going away) is wrong. Desktop and iOS make
        // the same distinction by muting a skipped step's message.
        const cancelledStep = failedStep
          ? undefined
          : progress.steps.find((step) => step.status === "skipped" && (step.error?.trim().length ?? 0) > 0);
        if (cancelledStep) {
          const reason = cancelledStep.error?.trim() || "Setup was cancelled";
          const cancelled: LaneSetupStatus = {
            status: "cancelled",
            label: "lane setup cancelled",
            detail: reason,
            templateId: appliedTemplateId,
            retryable: false,
          };
          setLaneSetupStatusByLaneId((prev) => ({ ...prev, [lane.id]: cancelled }));
          setRightPane((prev) => prev.kind === "lane-details" && prev.lane.id === lane.id
            ? { ...prev, setup: cancelled }
            : prev);
          addNotice(`Lane setup for ${lane.name} stopped: ${reason}`, "info");
          return;
        }
        const detail = failedStep?.error?.trim()
          || (failedStep ? `${failedStep.label} failed` : "Environment setup failed");
        const failed: LaneSetupStatus = {
          status: "failed",
          label: failedStep?.label ? `${failedStep.label} failed` : "lane setup failed",
          detail: `${detail} · press r to retry`,
          templateId: appliedTemplateId,
          retryable: true,
        };
        setLaneSetupStatusByLaneId((prev) => ({ ...prev, [lane.id]: failed }));
        setRightPane((prev) => prev.kind === "lane-details" && prev.lane.id === lane.id
          ? { ...prev, setup: failed }
          : prev);
        addNotice(`Lane setup failed for ${lane.name}: ${detail}`, "error");
      })
      .catch((err) => {
        const detail = err instanceof Error ? err.message : String(err);
        const failed: LaneSetupStatus = {
          status: "failed",
          label: "lane setup failed",
          detail: `${detail} · press r to retry`,
          templateId,
          retryable: true,
        };
        setLaneSetupStatusByLaneId((prev) => ({ ...prev, [lane.id]: failed }));
        setRightPane((prev) => prev.kind === "lane-details" && prev.lane.id === lane.id
          ? { ...prev, setup: failed }
          : prev);
        addNotice(`Lane setup failed for ${lane.name}: ${detail}`, "error");
      });
  }, [addNotice]);

  const activateLaneWithLastChat = useCallback((lane: LaneSummary, options: { notify?: boolean } = {}) => {
    const laneSessions = openDrawerSessions.filter((entry) => entry.laneId === lane.id);
    const lastSessionId = lastChatByLaneRef.current.get(lane.id);
    const session =
      laneSessions.find((entry) => entry.sessionId === lastSessionId)
      ?? newestSession(laneSessions);
    const action: WorkChatAction | null = session ? null : "new-chat";
    selectActiveLaneId(lane.id);
    setDrawerLaneId(lane.id);
    setSelectedDrawerLaneId(lane.id);
    setSelectedDrawerChatId(session?.sessionId ?? null);
    setSelectedWorkChatAction(action);
    setWorkSelectedKey(session ? `session:${session.sessionId}` : `new-chat:${lane.id}`);
    applyDrawerChatSelection({ session: session ?? null, action });
    if (options.notify) addNotice(`Switched to lane ${lane.name}.`, "success");
  }, [addNotice, applyDrawerChatSelection, openDrawerSessions, selectActiveLaneId]);

  const cycleActiveLane = useCallback((direction: 1 | -1) => {
    if (!orderedDrawerLanes.length) return;
    const currentLaneId = activeLaneIdRef.current;
    const currentIndex = currentLaneId ? orderedDrawerLanes.findIndex((lane) => lane.id === currentLaneId) : -1;
    const startIndex = currentIndex >= 0 ? currentIndex : direction > 0 ? -1 : 0;
    const lane = orderedDrawerLanes[(startIndex + direction + orderedDrawerLanes.length) % orderedDrawerLanes.length];
    if (!lane) return;
    activateLaneWithLastChat(lane, { notify: true });
  }, [activateLaneWithLastChat, orderedDrawerLanes]);

  const flashMultiViewNotice = useCallback((text: string) => {
    setMultiViewNotice(text);
    setTimeout(() => {
      setMultiViewNotice((current) => current === text ? null : current);
    }, 1000);
  }, []);

  const recordPromptHistoryForSession = useCallback((sessionId: string | null | undefined, text: string) => {
    const trimmed = text.trim();
    if (!sessionId || !trimmed) return;
    promptHistoryIndexBySessionIdRef.current[sessionId] = null;
    setPromptHistoryBySessionId((prev) => ({
      ...prev,
      [sessionId]: [...(prev[sessionId] ?? []).filter((entry) => entry !== trimmed), trimmed].slice(-100),
    }));
  }, []);

  const hydrateTileHistory = useCallback(async (sessionId: string) => {
    const conn = connectionRef.current;
    if (!conn || activeTerminalSessionRef.current?.terminalId === sessionId) return;
    const history = await getChatHistory(conn, sessionId);
    if (history.sessionFound === false) return;
    const nextEvents = dedupeTuiEvents(clearedAt
      ? history.events.filter((event) => event.timestamp > clearedAt)
      : history.events);
    setEventsBySessionId((prev) => ({ ...prev, [sessionId]: nextEvents }));
    const historyPrompts = history.events
      .map((envelope) => envelope.event)
      .filter((event): event is Extract<AgentChatEventEnvelope["event"], { type: "user_message" }> => event.type === "user_message")
      .map((event) => (event.displayText || event.text || "").trim())
      .filter(Boolean)
      .slice(-100);
    if (historyPrompts.length) {
      setPromptHistoryBySessionId((prev) => ({ ...prev, [sessionId]: historyPrompts }));
    }
  }, [clearedAt]);

  const isTerminalTileSessionId = useCallback((sessionId: string | null | undefined) => {
    if (!sessionId) return false;
    return terminalSessionsRef.current.some((terminal) => terminal.terminalId === sessionId);
  }, []);

  // Seed a terminal tile's preview snapshot once when it joins the grid. Live
  // output then flows through the per-session terminalLiveChunks buffer.
  const hydrateTerminalTilePreview = useCallback(async (terminalId: string) => {
    const conn = connectionRef.current;
    if (!conn) return;
    try {
      const preview = await previewTerminal(conn, terminalId);
      setTerminalPreviewById((prev) => {
        if (sameTerminalPreviewFrame(prev[terminalId] ?? null, preview)) return prev;
        return { ...prev, [terminalId]: preview };
      });
    } catch {
      // Non-fatal: the tile renders from live chunks / fallback until the next poll.
    }
  }, []);

  // For a freshly-added tile, fetch chat history or terminal preview as fitting.
  const hydrateTileTarget = useCallback((sessionId: string) => {
    if (isTerminalTileSessionId(sessionId)) {
      void hydrateTerminalTilePreview(sessionId);
      return;
    }
    void hydrateTileHistory(sessionId).catch((err) => addNotice(err instanceof Error ? err.message : String(err), "error"));
  }, [addNotice, hydrateTerminalTilePreview, hydrateTileHistory, isTerminalTileSessionId]);

  const focusMultiViewTile = useCallback((index: number) => {
    setMultiView((prev) => {
      if (!prev) return prev;
      const focusedIndex = Math.max(0, Math.min(index, prev.tiles.length - 1));
      return focusedIndex === prev.focusedIndex ? prev : { ...prev, focusedIndex };
    });
    setGridView(true);
    setPaneFocus("chat");
  }, [setGridView, setPaneFocus]);

  const removeMultiViewTile = useCallback((index: number) => {
    const prev = multiViewRef.current;
    if (!prev) return;
    const removed = prev.tiles[index] ?? null;
    const tiles = prev.tiles.filter((_, tileIndex) => tileIndex !== index);
    const survivor = tiles.length < 2 ? tiles[0] ?? null : null;
    setMultiView(tiles.length < 2 ? null : { tiles, focusedIndex: Math.min(prev.focusedIndex, tiles.length - 1) });
    if (removed) {
      // Drop the closed tile's per-session view state so re-adding the chat
      // later starts from a fresh (bottom-anchored) viewport.
      setScrollBySessionId(({ [removed.sessionId]: _droppedScroll, ...rest }) => rest);
      setSelectionBySessionId(({ [removed.sessionId]: _droppedSelection, ...rest }) => rest);
    }
    if (survivor) {
      // Grid collapsed to one chat → leave grid view into that single chat.
      setGridView(false);
      selectActiveLaneId(survivor.laneId);
      selectActiveSessionId(survivor.sessionId);
    }
    setPaneFocus("chat");
  }, [selectActiveLaneId, selectActiveSessionId, setGridView, setPaneFocus]);

  // Prune grid tiles + per-session view caches when a chat session disappears
  // from the runtime (archived or deleted). Diffing successive session lists —
  // instead of treating the list as ground truth — keeps two failure modes
  // safe: a transient empty list during reconnect prunes nothing, and a brand
  // new session that has streamed events but hasn't hit the list yet is never
  // touched.
  const prunedSessionIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const current = new Set(sessions.map((session) => session.sessionId));
    const previous = prunedSessionIdsRef.current;
    const prunePlan = planSessionStatePrune({
      previous,
      current,
      connectionLost: connectionLostRef.current,
    });
    if (!prunePlan) return;
    prunedSessionIdsRef.current = prunePlan.nextSeen;
    const { removed } = prunePlan;
    if (!removed.length) return;
    const removedSet = new Set(removed);
    const grid = multiViewRef.current;
    if (grid && grid.tiles.some((tile) => removedSet.has(tile.sessionId))) {
      const tiles = grid.tiles.filter((tile) => !removedSet.has(tile.sessionId));
      const survivor = tiles.length < 2 ? tiles[0] ?? null : null;
      setMultiView(tiles.length < 2 ? null : { tiles, focusedIndex: Math.min(grid.focusedIndex, tiles.length - 1) });
      if (tiles.length < 2) setGridView(false);
      if (survivor) {
        selectActiveLaneId(survivor.laneId);
        selectActiveSessionId(survivor.sessionId);
      }
    }
    const prune = <T,>(record: Record<string, T>): Record<string, T> => {
      if (!removed.some((sessionId) => sessionId in record)) return record;
      const next = { ...record };
      for (const sessionId of removed) delete next[sessionId];
      return next;
    };
    setScrollBySessionId(prune);
    setSelectionBySessionId(prune);
    setStreamingBySessionId(prune);
    setInterruptedBySessionId(prune);
    setEventsBySessionId(prune);
  }, [selectActiveLaneId, selectActiveSessionId, sessions, setGridView]);

  // Sibling prune for Claude PTY buffers: terminalLiveChunks (capped per buffer
  // but never deleted) and terminalScrollBySessionId would otherwise leak up to
  // MAX_RETAINED_CHUNKS per closed terminal for the process lifetime. Keyed on
  // terminalSessions (by terminalId) rather than chat sessionId.
  const prunedTerminalIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const current = new Set(terminalSessions.map((terminal) => terminal.terminalId));
    // listTerminalSessions() failures surface as an empty list (the call site
    // catches to []), which is indistinguishable from "all terminals closed".
    // Never mass-prune on an empty set — keep the prior seen-set and wait for a
    // non-empty listing to authoritatively diff closed terminals. Worst case a
    // genuinely-final terminal's buffers linger until the next terminal opens.
    if (current.size === 0) return;
    const { nextSeen, removed } = planTerminalBufferPrune(prunedTerminalIdsRef.current, current);
    prunedTerminalIdsRef.current = nextSeen;
    if (!removed.length) return;
    // Drop every terminal-id-keyed buffer for the closed terminals. pendingPty
    // chunks must go too, else a flush after this effect would recreate a
    // just-pruned terminalLiveChunks entry.
    for (const terminalId of removed) pendingPtyChunksRef.current.delete(terminalId);
    setTerminalPreviewById((prev) => pruneRecordKeys(prev, removed));
    setTerminalLiveChunks((prev) => pruneRecordKeys(prev, removed));
    setTerminalScrollBySessionId((prev) => pruneRecordKeys(prev, removed));
  }, [terminalSessions]);

  const isTileableChatSessionId = useCallback((sessionId: string | null | undefined) => {
    if (!sessionId) return false;
    return sessionsRef.current.some((session) => session.sessionId === sessionId)
      || terminalSessionsRef.current.some((terminal) => terminal.terminalId === sessionId);
  }, []);

  const addTileToGrid = useCallback((sessionId: string, laneId: string) => {
    if (!sessionId || !laneId) return;
    if (!isTileableChatSessionId(sessionId)) {
      flashMultiViewNotice("That session can't be split right now");
      addNotice("Only active agent chats and Claude CLI sessions can be added to split view.", "info");
      setPaneFocus("addMode");
      return;
    }
    const prev = multiViewRef.current;
    if (prev) {
      const tiles = prev.tiles.filter((tile) => isTileableChatSessionId(tile.sessionId));
      const focusedIndex = Math.max(0, Math.min(prev.focusedIndex, Math.max(0, tiles.length - 1)));
      const existingIndex = tiles.findIndex((tile) => tile.sessionId === sessionId);
      if (existingIndex >= 0) {
        setMultiView({ tiles, focusedIndex: existingIndex });
        setGridView(true);
        setAddMode(null);
        setPaneFocus("chat");
        return;
      }
      if (tiles.length >= 6) {
        flashMultiViewNotice("Multi-view full (max 6)");
        setGridView(true);
        setAddMode(null);
        setPaneFocus("chat");
        return;
      }
      if (!tiles.length) {
        setMultiView(null);
        setGridView(false);
        selectActiveLaneId(laneId);
        selectActiveSessionId(sessionId);
      } else {
        setMultiView({
          tiles: [...tiles, { sessionId, laneId }],
          focusedIndex: Math.max(focusedIndex, tiles.length),
        });
        setGridView(true);
      }
    } else {
      const currentSessionId = activeSessionIdRef.current;
      const currentLaneId = activeLaneIdRef.current;
      if (!currentSessionId || !currentLaneId || !isTileableChatSessionId(currentSessionId)) {
        setGridView(false);
        selectActiveLaneId(laneId);
        selectActiveSessionId(sessionId);
      } else if (currentSessionId !== sessionId) {
        setMultiView({
          tiles: [
            { sessionId: currentSessionId, laneId: currentLaneId },
            { sessionId, laneId },
          ],
          focusedIndex: 1,
        });
        setGridView(true);
      }
    }
    hydrateTileTarget(sessionId);
    const currentSessionId = activeSessionIdRef.current;
    if (
      currentSessionId
      && currentSessionId !== sessionId
      && isTileableChatSessionId(currentSessionId)
      && !isTerminalTileSessionId(currentSessionId)
      && !eventsBySessionIdRef.current[currentSessionId]
    ) {
      void hydrateTileHistory(currentSessionId).catch(() => undefined);
    }
    setAddMode(null);
    setPaneFocus("chat");
  }, [addNotice, flashMultiViewNotice, hydrateTileHistory, hydrateTileTarget, isTerminalTileSessionId, isTileableChatSessionId, selectActiveLaneId, selectActiveSessionId, setGridView, setPaneFocus]);

  const startAddMode = useCallback(() => {
    const firstLane = orderedDrawerLanes[0] ?? null;
    const laneId = activeLaneIdRef.current ?? drawerLaneIdRef.current ?? firstLane?.id ?? null;
    if (!laneId) {
      addNotice("No lanes are available to add chats from.", "error");
      return;
    }
    const laneSessions = tileableDisplaySessions.filter((session) => session.laneId === laneId);
    const cursorChatId = activeSessionIdRef.current && laneSessions.some((session) => session.sessionId === activeSessionIdRef.current)
      ? activeSessionIdRef.current
      : laneSessions[0]?.sessionId ?? null;
    setAddMode({ cursorLaneId: laneId, cursorChatId });
    setDrawerOpen(true);
    setDrawerLaneId(laneId);
    setPaneFocus("addMode");
  }, [addNotice, orderedDrawerLanes, setPaneFocus, tileableDisplaySessions]);

  const cancelAddMode = useCallback(() => {
    setAddMode(null);
    focusChat();
  }, [focusChat]);

  const moveAddModeCursor = useCallback((direction: "up" | "down" | "left" | "right") => {
    setAddMode((prev) => {
      if (!prev) return prev;
      const laneIndex = Math.max(0, orderedDrawerLanes.findIndex((lane) => lane.id === prev.cursorLaneId));
      if (direction === "left" || direction === "right") {
        const delta = direction === "right" ? 1 : -1;
        const nextLane = orderedDrawerLanes[(laneIndex + delta + orderedDrawerLanes.length) % orderedDrawerLanes.length];
        if (!nextLane) return prev;
        const nextSessions = tileableDisplaySessions.filter((session) => session.laneId === nextLane.id);
        return { cursorLaneId: nextLane.id, cursorChatId: nextSessions[0]?.sessionId ?? null };
      }
      const laneSessions = tileableDisplaySessions.filter((session) => session.laneId === prev.cursorLaneId);
      if (!laneSessions.length) return prev;
      const currentIndex = Math.max(0, laneSessions.findIndex((session) => session.sessionId === prev.cursorChatId));
      const delta = direction === "down" ? 1 : -1;
      const nextSession = laneSessions[(currentIndex + delta + laneSessions.length) % laneSessions.length];
      return { ...prev, cursorChatId: nextSession?.sessionId ?? null };
    });
  }, [orderedDrawerLanes, tileableDisplaySessions]);

  const confirmAddMode = useCallback(() => {
    const current = addModeRef.current;
    if (!current?.cursorChatId) {
      addNotice("This lane has no chat to add.", "info");
      return;
    }
    addTileToGrid(current.cursorChatId, current.cursorLaneId);
  }, [addNotice, addTileToGrid]);

  // The grid toggle (Ctrl+G / footer button). Behavior depends on context:
  //  - in the grid          -> open the "add chat" picker
  //  - on a chat that's a tile of a resumable grid -> re-enter that grid
  //  - on a non-grid chat with a resumable grid    -> add this chat to the grid
  //    (errors if full)
  //  - no grid yet          -> open the add-mode picker to build one
  const toggleGridView = useCallback(() => {
    if (gridViewActiveRef.current) {
      startAddMode();
      return;
    }
    const grid = multiViewRef.current;
    if (grid) {
      const sessionId = activeSessionIdRef.current;
      const tileIndex = sessionId ? grid.tiles.findIndex((tile) => tile.sessionId === sessionId) : -1;
      if (tileIndex >= 0) {
        setMultiView({ ...grid, focusedIndex: tileIndex });
        setGridView(true);
        setPaneFocus("chat");
        return;
      }
      const laneId = activeLaneIdRef.current;
      if (sessionId && laneId && isTileableChatSessionId(sessionId)) {
        addTileToGrid(sessionId, laneId);
        return;
      }
      // Current view isn't a tileable chat (draft/terminal) — just resume the grid.
      setGridView(true);
      setPaneFocus("chat");
      return;
    }
    startAddMode();
  }, [addTileToGrid, isTileableChatSessionId, setGridView, setPaneFocus, startAddMode]);

  useEffect(() => {
    // Only the *shown* grid drives the active lane/session. A dormant (hidden but
    // resumable) grid must not hijack the single chat the user is viewing.
    if (!multiView || !gridViewActive) return;
    const tile = multiView.tiles[multiView.focusedIndex] ?? multiView.tiles[0] ?? null;
    if (!tile) return;
    if (tile.laneId !== activeLaneIdRef.current) {
      selectActiveLaneId(tile.laneId);
      setDrawerLaneId(tile.laneId);
      setSelectedDrawerLaneId(tile.laneId);
    }
    if (tile.sessionId !== activeSessionIdRef.current) {
      selectActiveSessionId(tile.sessionId);
      setSelectedDrawerChatId(tile.sessionId);
      setSelectedWorkChatAction(null);
    }
    if (!eventsBySessionIdRef.current[tile.sessionId]) {
      void hydrateTileHistory(tile.sessionId).catch(() => undefined);
    }
  }, [gridViewActive, hydrateTileHistory, multiView, selectActiveLaneId, selectActiveSessionId]);

  useEffect(() => {
    if (!connection || !attachedTerminalId) return;
    const handleRawInput = (chunk: Buffer | string) => {
      const raw = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      if (!raw) return;
      const terminalControlInput = splitTerminalControlInput(raw);
      if (terminalControlInput.detach) {
        setAttachedTerminalId(null);
        if (terminalControlInput.forwarded) {
          void writeTerminal(connection, attachedTerminalId, terminalControlInput.forwarded).catch((err) => {
            addNotice(err instanceof Error ? err.message : String(err), "error");
          });
        }
        return;
      }
      void writeTerminal(connection, attachedTerminalId, terminalControlInput.forwarded).catch((err) => {
        addNotice(err instanceof Error ? err.message : String(err), "error");
      });
    };
    process.stdin.on("data", handleRawInput);
    return () => {
      process.stdin.off("data", handleRawInput);
    };
  }, [addNotice, attachedTerminalId, connection]);

  const reloadKeybindings = useCallback((announce = false) => {
    const diagnostics = readClaudeKeybindingsFile({ create: false });
    setKeybindings(diagnostics.bindings);
    if (announce) {
      addNotice(
        diagnostics.warnings.length
          ? `Keybindings reloaded with ${diagnostics.warnings.length} warning${diagnostics.warnings.length === 1 ? "" : "s"}.`
          : "Keybindings reloaded.",
        diagnostics.warnings.length ? "error" : "success",
      );
    }
  }, [addNotice]);

  useEffect(() => {
    const filePath = defaultKeybindingsPath();
    const dir = path.dirname(filePath);
    let timer: NodeJS.Timeout | null = null;
    let watcher: fs.FSWatcher | null = null;
    try {
      fs.mkdirSync(dir, { recursive: true });
      watcher = fs.watch(dir, (_event, filename) => {
        if (filename && filename.toString() !== path.basename(filePath)) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          reloadKeybindings(true);
        }, 150);
      });
    } catch {
      return undefined;
    }
    return () => {
      if (timer) clearTimeout(timer);
      watcher?.close();
    };
  }, [reloadKeybindings]);

  const refreshAiSetupStatus = useCallback(async (options: { force?: boolean } = {}) => {
    const conn = connectionRef.current;
    if (!conn) return;
    const [status, storedProviders, diagnostics] = await Promise.all([
      getAiSettingsStatus(conn, {
        force: options.force === true,
        refreshOpenCodeInventory: true,
      }),
      getStoredApiKeyProviders(conn).catch(() => []),
      getOpenCodeRuntimeDiagnostics(conn).catch(() => null),
    ]);
    setAiStatus(status);
    setStoredApiKeyProviders(storedProviders.map((provider) => provider.trim().toLowerCase()).filter(Boolean));
    setOpenCodeDiagnostics(diagnostics);
    setAiStatusCheckedAt(new Date().toISOString());
  }, []);

	  const loadProviderModels = useCallback(async (provider: AdeCodeProvider, options: { applyDefault?: boolean; force?: boolean; interfaceMode?: AdeCodeInterfaceMode } = {}) => {
    const conn = connectionRef.current;
    const interfaceMode = options.interfaceMode ?? modelStateRef.current.interfaceMode;
    const cacheKey = providerModelsCacheKey(provider, interfaceMode);
    const cached = providerModelsCacheRef.current.get(cacheKey);
    let nextModels = cached ?? registryModelsForProvider(provider);
    if (options.force === true || !cached) {
      try {
        nextModels = conn ? await getAvailableModels(conn, provider, { interfaceMode }) : registryModelsForProvider(provider);
        providerModelsCacheRef.current.set(cacheKey, nextModels);
	      } catch (error) {
	        nextModels = cached ?? registryModelsForProvider(provider);
	        if (provider === "pi") {
	          addNotice(
	            `Pi model discovery failed; showing cached models. ${error instanceof Error ? error.message : "Check the Pi installation and profile."}`,
	            "error",
	          );
	        }
	      }
    }
    setModels(nextModels);
    if (options.applyDefault !== false) {
      const model = nextModels.find((entry) => entry.isDefault) ?? nextModels[0] ?? null;
      setModelState((prev) => {
        const patch = model ? modelStatePatchForModel(provider, model) : fallbackModelStatePatch(provider);
        return {
          ...prev,
          ...patch,
        };
      });
    }
	    return nextModels;
	  }, [addNotice]);

	  const refreshModelCatalog = useCallback(async (options: { refreshProvider?: AgentChatModelCatalogRefreshProvider } = {}) => {
	    const conn = connectionRef.current;
	    if (!conn) return modelCatalogRef.current;
	    const refreshProvider = options.refreshProvider;
	    if (!refreshProvider && modelCatalogRef.current) {
	      setModelCatalog(modelCatalogRef.current);
	      return modelCatalogRef.current;
	    }

	    const cursorSource = refreshProvider === "cursor"
	      ? cursorSourceForInterfaceMode(modelStateRef.current.interfaceMode)
	      : undefined;
	    const refreshCacheKey = refreshProvider
	      ? modelCatalogRefreshCacheKey(refreshProvider, cursorSource)
	      : null;
    if (refreshProvider && modelCatalogRef.current) {
	      const refreshedAt = refreshCacheKey ? modelCatalogProviderRefreshedAtRef.current.get(refreshCacheKey) : undefined;
	      if (refreshedAt && Date.now() - refreshedAt <= modelCatalogClientRefreshTtlMs(refreshProvider)) {
	        setModelCatalog(modelCatalogRef.current);
	        return modelCatalogRef.current;
	      }
	    }

	    const refreshSequence = refreshProvider ? ++modelCatalogRefreshSequenceRef.current : null;
	    const clearRefreshingProvider = () => {
	      if (refreshSequence !== null && modelCatalogRefreshSequenceRef.current === refreshSequence) {
	        setModelCatalogRefreshingProvider(null);
	      }
	    };
	    if (refreshProvider) setModelCatalogRefreshingProvider(refreshProvider);

	    try {
	      const catalog = await getModelCatalog(conn, {
	        mode: refreshProvider ? "refresh-stale" : "cached",
	        ...(refreshProvider ? { refreshProvider } : {}),
	        ...(cursorSource ? { cursorSource } : {}),
	      });
      modelCatalogRef.current = catalog;
	      setModelCatalog(catalog);
      if (refreshCacheKey && catalog.stale !== true) {
	        modelCatalogProviderRefreshedAtRef.current.set(refreshCacheKey, Date.now());
	      }
      if (refreshProvider && catalog.stale === true) {
        void getModelCatalog(conn, {
          mode: "force",
          refreshProvider,
          ...(cursorSource ? { cursorSource } : {}),
        }).then((freshCatalog) => {
          if (connectionRef.current !== conn) return;
          modelCatalogRef.current = freshCatalog;
          if (refreshCacheKey) modelCatalogProviderRefreshedAtRef.current.set(refreshCacheKey, Date.now());
          setModelCatalog(freshCatalog);
        }).catch((error) => {
          addNotice(
            `${providerLabel(refreshProvider)} model refresh failed; showing cached models. ${error instanceof Error ? error.message : "Try refreshing again."}`,
            "error",
          );
        }).finally(clearRefreshingProvider);
      } else {
        clearRefreshingProvider();
      }
      return catalog;
    } catch (error) {
      clearRefreshingProvider();
      if (refreshProvider) {
        addNotice(
          `${providerLabel(refreshProvider)} model refresh failed; showing cached models. ${error instanceof Error ? error.message : "Try refreshing again."}`,
          "error",
        );
      }
      return modelCatalogRef.current;
    }
	  }, [addNotice]);

  const openForm = useCallback((content: Extract<RightPaneContent, { kind: "form" }>) => {
    // Cancel any pending feedback-success auto-close so a stale timer can't fire
    // against this freshly opened pane.
    if (feedbackCloseTimerRef.current) {
      clearTimeout(feedbackCloseTimerRef.current);
      feedbackCloseTimerRef.current = null;
    }
    const previousPane = activePaneRef.current;
    stashActiveInput();
    if (previousPane !== "details") {
      paneBeforeDetailsRef.current = previousPane;
    }
    const nextValues = Object.fromEntries(content.fields.map((field) => [field.name, field.initialValue ?? ""]));
    const firstField = content.fields[0] ?? null;
    setFormValues(nextValues);
    setFormFieldIndex(0);
    setFormDiscardArmed(false);
    setFormConfirmArmed(false);
    setPrompt(firstField && formFieldUsesPromptInput(content.command, firstField.name)
      ? firstField.initialValue ?? ""
      : "");
    setRightPane(content);
    setRightOpen(true);
    // Forms are explicit user actions; mark sticky so the context default
    // resolver doesn't overwrite them.
    lastUserOpenedPaneRef.current = "form";
    setPaneFocus("details");
  }, [setFormConfirmArmed, setPaneFocus, stashActiveInput]);

  const openNewLaneForm = useCallback(() => {
    const activeLaneName = lanes.find((lane) => lane.id === activeLaneIdRef.current)?.name ?? null;
    openForm({
      kind: "form",
      title: "New lane",
      command: "new-lane",
      fields: newLaneFormFields("primary", { activeLaneName }),
    });
    // Fetch branch names once for the typeahead (async — the form opens
    // immediately and the matches appear when the result lands). Stashed on
    // the form content so RightPane stays a pure renderer.
    const conn = connectionRef.current;
    const laneId = activeLaneIdRef.current;
    if (conn && laneId) {
      void listGitBranches(conn, laneId)
        .then((branches) => {
          const mapped = branches.map((branch) => ({ name: branch.name, remote: branch.isRemote }));
          setRightPane((previous) => previous.kind === "form" && previous.command === "new-lane"
            ? { ...previous, branches: mapped }
            : previous);
        })
        .catch(() => {});
    }
  }, [lanes, openForm]);

  const openMoveUnstagedForm = useCallback(() => {
    const laneId = activeLaneIdRef.current;
    const lane = lanes.find((entry) => entry.id === laneId) ?? activeLane;
    if (!laneId || !lane) {
      setRightPane({ kind: "details", title: "Move unstaged", body: "No active lane is selected." });
      focusDetails();
      return;
    }
    openForm({
      kind: "form",
      title: "Move unstaged → new lane",
      command: "new-lane-from-unstaged",
      laneId,
      description: `Carries unstaged + untracked changes from ${lane.name} into a new child lane.`,
      fields: [
        { name: "name", label: "Name", required: true, placeholder: "rescue-work" },
      ],
    });
  }, [activeLane, focusDetails, lanes, openForm]);

  const openLaneDeleteForm = useCallback((laneIdArg?: string) => {
    const laneId = laneIdArg ?? activeLaneIdRef.current;
    const lane = lanes.find((entry) => entry.id === laneId) ?? activeLane;
    if (!laneId || !lane) {
      setRightPane({ kind: "details", title: "Delete lane", body: "No active lane is selected." });
      focusDetails();
      return;
    }
    if (lane.laneType === "primary") {
      setRightPane({ kind: "details", title: "Delete lane", body: "Primary lane cannot be deleted." });
      focusDetails();
      return;
    }
    // Fetch the delete-risk first so the confirmation shows what would be lost
    // (unpushed commits, dirty tree, running sessions) rather than a blind prompt.
    void (async () => {
      let description: string | undefined;
      const conn = connectionRef.current;
      if (conn) {
        try {
          const risk = await conn.action<LaneDeleteRisk>("lane", "getDeleteRisk", { laneId });
          description = formatLaneDeleteRisk(risk);
        } catch {
          // Risk is advisory; fall back to the plain form if it can't be fetched.
        }
      }
      openForm({
        kind: "form",
        title: "Delete lane",
        command: "lane-delete",
        laneId,
        description,
        laneDelete: {
          laneId,
          laneName: lane.name,
          branchRef: lane.branchRef,
          dirty: lane.status?.dirty === true,
        },
        fields: [
          { name: "scope", label: "Scope", initialValue: "worktree" },
          { name: "remoteName", label: "Remote name", placeholder: "origin", initialValue: "origin" },
          { name: "force", label: "Force delete", initialValue: "no" },
        ],
      });
    })();
  }, [activeLane, focusDetails, lanes, openForm]);

  const openLaneRenameForm = useCallback((laneIdArg?: string) => {
    const laneId = laneIdArg ?? activeLaneIdRef.current;
    const lane = lanes.find((entry) => entry.id === laneId) ?? activeLane;
    if (!laneId || !lane) {
      setRightPane({ kind: "details", title: "Rename lane", body: "No lane is selected." });
      focusDetails();
      return;
    }
    if (lane.laneType === "primary") {
      setRightPane({ kind: "details", title: "Rename lane", body: "The primary lane can't be renamed." });
      focusDetails();
      return;
    }
    openForm({
      kind: "form",
      title: "Rename lane",
      command: "lane-rename",
      laneId,
      fields: [{ name: "name", label: "Lane name", required: true, initialValue: lane.name }],
    });
  }, [activeLane, focusDetails, lanes, openForm]);

  const openChatDeleteForm = useCallback((sessionIdArg?: string) => {
    const targetId = sessionIdArg ?? activeSessionIdRef.current;
    const session = sessions.find((entry) => entry.sessionId === targetId) ?? activeSession;
    if (!targetId || !session || session.sessionId !== targetId) {
      setRightPane({ kind: "details", title: "Delete chat", body: "No runtime-backed chat is selected." });
      focusDetails();
      return;
    }
    const title = session.title ?? session.goal ?? session.sessionId;
    openForm({
      kind: "form",
      title: "Delete chat",
      command: "chat-delete",
      sessionId: targetId,
      chatDelete: { sessionId: targetId, title },
      description: "Removes this chat and its transcript.",
      fields: [],
    });
  }, [activeSession, focusDetails, openForm, sessions]);

  const openChatRenameForm = useCallback((sessionIdArg?: string) => {
    const targetId = sessionIdArg ?? activeSessionIdRef.current;
    const session = sessions.find((entry) => entry.sessionId === targetId) ?? activeSession;
    if (!targetId || !session || session.sessionId !== targetId) {
      setRightPane({ kind: "details", title: "Rename chat", body: "No runtime-backed chat is selected." });
      focusDetails();
      return;
    }
    const blocked = cursorCloudRenameBlockedReason(session);
    if (blocked) {
      addNotice(blocked, "error");
      return;
    }
    openForm({
      kind: "form",
      title: "Rename chat",
      command: "rename",
      sessionId: targetId,
      fields: [
        { name: "title", label: "Title", required: true, initialValue: session.title ?? "" },
      ],
    });
  }, [activeSession, addNotice, focusDetails, openForm, sessions]);

  const openFeedbackForm = useCallback(() => {
    // Seed the multiline feedback form's serializable state (feedbackForm.ts)
    // onto content.feedback: context = active provider/model + lane + last error,
    // with the context footer toggled ON by default so reports are actionable.
    const lastError = [...notices].reverse().find((entry) => entry.tone === "error")?.text ?? null;
    openForm({
      kind: "form",
      title: "Feedback",
      command: "feedback",
      fields: feedbackFormFields(buildFeedbackEnvironment(project, activeLane ?? null)),
      feedback: {
        provider: modelState.provider ?? null,
        model: modelState.modelId ?? null,
        lane: activeLane?.name ?? null,
        lastError,
        type: "bug",
        showContext: true,
        body: "",
      },
    });
  }, [activeLane, modelState.modelId, modelState.provider, notices, openForm, project]);

  const openNewChatSetup = useCallback((title?: string | null) => {
    const laneId = activeLaneIdRef.current;
    const lane = lanes.find((entry) => entry.id === laneId) ?? activeLane;
    if (!laneId || !lane) {
      setRightPane({ kind: "details", title: "New chat", body: "No active lane is available." });
      focusDetails();
      return;
    }
    const unavailableMessage = laneWorktreeUnavailableMessage(lane);
    if (unavailableMessage) {
      setDraftChatMode(false);
      selectActiveSessionId(null);
      setSelectedDrawerChatId(null);
      setSelectedWorkChatAction(null);
      setRightPane(seedLaneDetails(lane, false));
      setRightOpen(true);
      addNotice(unavailableMessage, "error");
      return;
    }
    const trimmedTitle = title?.trim() || null;
    pendingNewChatTitleRef.current = trimmedTitle;
    newChatPreviewLaneIdRef.current = laneId;
    draftSeededFromHistoryRef.current = true;
    const previousPane = activePaneRef.current;
    stashActiveInput();
    if (previousPane !== "details") {
      paneBeforeDetailsRef.current = previousPane;
    }
    setDraftChatMode(true);
    // Creating a new chat leaves the grid (shown as a single draft chat) but
    // keeps the grid resumable — navigating back to a tile re-enters it.
    setGridView(false);
    selectActiveSessionId(null);
    setAttachedTerminalId(null);
    // New-chat-setup is part of the context default; let the resolver drive it.
    lastUserOpenedPaneRef.current = null;
    eventDedupKeysRef.current.clear();
    eventDedupKeyOrderRef.current = [];
    eventCountRef.current = 0;
    setEvents([]);
    setClearedAt(null);
    chatDraftRef.current = "";
    setPrompt("");
    setRightSelectionIndex(defaultSetupSelectionIndex(newChatSetupRows));
    setFormDiscardArmed(false);
    // The new-chat page opens on the composer, NOT on a model pane. The model
    // that will be used is summarised on the line under the prompt box; /model
    // opens the wizard when the user actually wants to change it.
    setRightPane({ kind: "empty" });
    setRightOpen(false);
    focusChat();
    void refreshAiSetupStatus().catch(() => undefined);
    void loadProviderModels(modelState.provider, { applyDefault: false }).catch(() => undefined);
    // Warm the catalog anyway so /model opens instantly with real provider rows.
    void refreshModelCatalog().catch(() => undefined);
  }, [activeLane, addNotice, focusChat, focusDetails, lanes, loadProviderModels, modelState.provider, newChatSetupRows, refreshAiSetupStatus, refreshModelCatalog, selectActiveSessionId, setDraftChatMode, setGridView, stashActiveInput]);

  // Hydrate favorites/recents from the ade-cli RPC once the connection is up.
  useEffect(() => {
    const conn = connectionRef.current;
    if (!conn) return;
    // Warm the model catalog on connect so every picker entry point (including
    // the new-chat picker) has provider rails + models ready, even on a fresh
    // runtime where nothing else has loaded the catalog yet.
    void refreshModelCatalog().catch(() => undefined);
    let cancelled = false;
    void (async () => {
      try {
        const [favorites, recents] = await Promise.all([
          getModelPickerFavorites(conn).catch(() => [] as string[]),
          getModelPickerRecents(conn).catch(() => [] as string[]),
        ]);
        if (cancelled) return;
        setModelPickerFavorites(favorites);
        setModelPickerRecents(recents);
      } catch {
        // Best-effort hydration — picker still functions with empty state.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [socketPath]);

  // Load the model catalog whenever the picker opens without one. This is the
  // reliable trigger: it fires for EVERY entry path (new-chat draft via
  // resolveContextDefault, /model, drawer) once the connection is live — unlike
  // the connect-time warm above, which can run before the socket is ready. Until
  // the catalog lands, the picker falls back to the single active-provider list
  // (which looked like "only the codex group" in the rail).
  useEffect(() => {
    if (rightPane.kind !== "model-wizard") return;
    if (modelCatalogRef.current) return;
    void refreshModelCatalog().catch(() => undefined);
  }, [rightPane.kind, refreshModelCatalog]);

  /**
   * `/model` — opens the TRANSIENT wizard. It replaces the old rail + graph +
   * search picker: four single-list steps (provider → family → model →
   * settings), Enter advances, Esc walks back, and committing the last step
   * closes the pane. Opening from a live chat retargets that chat through the
   * normal continuation path; opening from the new-chat page edits the draft.
   */
  const openModelWizard = useCallback(
    (options: { surface?: "chat" | "new-chat"; startAtSettings?: boolean; forceRefresh?: boolean } = {}) => {
      void refreshModelCatalog();
      const surface = options.surface ?? (activeSessionIdRef.current ? "chat" : "new-chat");
      const provider = modelState.provider;
      const selection = initialModelWizardSelection({
        entries: modelWizardEntries,
        provider,
        activeModelId: modelState.modelId,
        ...(options.startAtSettings ? { startAtSettings: true } : {}),
      });
      setRightPane({
        kind: "model-wizard",
        surface,
        step: selection.step,
        provider: selection.provider,
        familyKey: selection.familyKey,
        index: selection.index,
        ...(surface === "new-chat"
          ? {
              laneId: activeLaneIdRef.current,
              laneLabel: lanes.find((entry) => entry.id === activeLaneIdRef.current)?.name ?? activeLane?.name ?? null,
            }
          : {}),
      });
      setRightOpen(true);
      setPaneFocus("details");
      lastUserOpenedPaneRef.current = "model-wizard";
      void refreshAiSetupStatus({ force: options.forceRefresh === true }).catch(() => undefined);
      void loadProviderModels(provider, { applyDefault: false }).catch(() => undefined);
    },
    [
      activeLane?.name,
      lanes,
      loadProviderModels,
      modelPickerRows,
      modelState.modelId,
      modelState.provider,
      modelWizardEntries,
      newChatSetupRows,
      refreshAiSetupStatus,
      refreshModelCatalog,
      setPaneFocus,
    ],
  );

  const closeModelWizard = useCallback(() => {
    setRightOpen(false);
    setRightPane({ kind: "empty" });
    lastUserOpenedPaneRef.current = null;
    focusChat();
  }, [focusChat]);

  const toggleModelPickerFavoriteId = useCallback(
    (modelId: string) => {
      if (!modelId) return;
      // Optimistic toggle so the UI updates instantly.
      setModelPickerFavorites((prev) =>
        prev.includes(modelId) ? prev.filter((entry) => entry !== modelId) : [...prev, modelId],
      );
      const conn = connectionRef.current;
      if (!conn) return;
      void toggleModelPickerFavorite(conn, modelId)
        .then((result) => {
          if (Array.isArray(result.favorites)) setModelPickerFavorites(result.favorites);
        })
        .catch(() => undefined);
    },
    [],
  );

  useEffect(() => {
    const range = activeMentionRange;
    const conn = connectionRef.current;
    const laneId = activeLaneId;
    if (!range) {
      setMentionSuggestions([]);
      setMentionIndex(0);
      return;
    }
    let cancelled = false;
    const query = range.query.trim().toLowerCase();
    const fileQuery = composerFileSearchQuery(range.query).toLowerCase();
    const matchesMentionQuery = (suggestion: MentionSuggestion): boolean => {
      if (!query) return true;
      const label = suggestion.label.toLowerCase();
      return (
        matchesMentionTarget(label, query)
        || suggestion.insertText.toLowerCase().includes(query)
        || Boolean(suggestion.detail?.toLowerCase().includes(query))
      );
    };
    const localSuggestions = (): MentionSuggestion[] => [
      ...lanes.map((lane) => ({
        kind: "lane" as const,
        label: lane.name,
        insertText: `@lane:${lane.id}`,
        detail: lane.branchRef ?? lane.id,
      })),
      ...displaySessions.slice(0, 30).map((session) => ({
        kind: "chat" as const,
        label: session.title ?? session.sessionId,
        insertText: `@chat:${session.sessionId}`,
        detail: session.laneId,
      })),
    ].filter(matchesMentionQuery);
    const attachedSuggestions = (): MentionSuggestion[] => selectedMentions
      .filter((suggestion) => suggestion.attachment && suggestion.filePath)
      .filter(matchesMentionQuery);

    const publishSuggestions = (remote: MentionSuggestion[] = []) => {
      if (cancelled) return;
      const local = localSuggestions();
      // On a bare `@` every lane and chat matches, so without a reservation the
      // row cap would drop the whole browse list of files. Typed queries keep
      // all local candidates long enough for prefix ranking to choose the most
      // specific target before the row cap is applied.
      const fileRows = query ? 0 : Math.min(remote.filter((s) => s.kind === "file").length, MENTION_FILE_ROWS);
      const localBudget = Math.max(0, MENTION_MAX_ROWS - fileRows);
      const localCandidates = query ? local : local.slice(0, localBudget);
      const next = rankMentionSuggestions(
        [...localCandidates, ...remote, ...attachedSuggestions()],
        query,
      ).slice(0, MENTION_MAX_ROWS);
      setMentionSuggestions(next);
      setMentionIndex((index) => Math.min(index, Math.max(0, next.length - 1)));
    };
    publishSuggestions();

    const loadRemoteSuggestions = async () => {
      const remote: MentionSuggestion[] = [];
      if (conn && laneId) {
        const cache = mentionRemoteCacheEntry(mentionRemoteCacheRef.current, laneId);
        // An empty query is a valid request: it browses the workspace
        // (shallowest paths first) instead of returning nothing, matching the
        // desktop composer's `@` behavior. The cache keys on the query string,
        // so "" caches like any typed query.
        const filesPromise = cache.filesByQuery.get(fileQuery)
          ? Promise.resolve(cache.filesByQuery.get(fileQuery)!)
          : Promise.resolve(conn.action<Array<{ path: string }>>("file", "quickOpen", {
            workspaceId: laneId,
            query: fileQuery,
            limit: MENTION_FILE_ROWS,
            allowComposerPrefixFallback: true,
          }))
            .then((files) => {
              const safeFiles = Array.isArray(files) ? files : [];
              cache.filesByQuery.set(fileQuery, safeFiles);
              return safeFiles;
            })
            .catch(() => []);
        const commitsPromise = cache.commits
          ? Promise.resolve(cache.commits)
          : Promise.resolve(conn.action<Array<Record<string, unknown>>>("git", "listRecentCommits", {
            laneId,
            limit: 8,
          }))
            .then((commits) => {
              const safeCommits = Array.isArray(commits) ? commits : [];
              cache.commits = safeCommits;
              return safeCommits;
            })
            .catch(() => []);
        const prsPromise = cache.prs
          ? Promise.resolve(cache.prs)
          : Promise.resolve(conn.action<Array<Record<string, unknown>>>("pr", "listAll", { laneId }))
            .then((prs) => {
              const safePrs = Array.isArray(prs) ? prs : [];
              cache.prs = safePrs;
              return safePrs;
            })
            .catch(() => []);
        const [files, commits, prs] = await Promise.all([filesPromise, commitsPromise, prsPromise]);
        remote.push(...files.map((file) => ({
          kind: "file" as const,
          label: file.path,
          insertText: `@file:${file.path}`,
          detail: "file",
          filePath: file.path,
        })));
        remote.push(...commits
          .filter((commit) => {
            const subject = String(commit.subject ?? commit.message ?? "");
            const sha = String(commit.shortSha ?? commit.sha ?? "");
            return !query || matchesMentionTarget(subject.toLowerCase(), query) || sha.toLowerCase().includes(query);
          })
          .slice(0, 5)
          .map((commit) => {
            const sha = String(commit.shortSha ?? commit.sha ?? "commit");
            return {
              kind: "commit" as const,
              label: String(commit.subject ?? commit.message ?? sha),
              insertText: `@commit:${sha}`,
              detail: sha,
            };
          }));
        remote.push(...prs
          .filter((pr) => {
            const title = String(pr.title ?? "");
            const number = String(pr.number ?? pr.prNumber ?? "");
            const loweredTitle = title.toLowerCase();
            return !query || matchesMentionTarget(loweredTitle, query) || number.includes(query);
          })
          .slice(0, 5)
          .map((pr) => {
            const id = String(pr.id ?? pr.prId ?? pr.number ?? "pr");
            return {
              kind: "pr" as const,
              label: String(pr.title ?? `PR ${id}`),
              insertText: `@pr:${id}`,
              detail: pr.number != null ? `#${String(pr.number)}` : id,
            };
          }));
      }
      publishSuggestions(remote);
    };
    const timer = setTimeout(() => {
      void loadRemoteSuggestions();
    }, MENTION_REMOTE_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [activeLaneId, activeMentionRange, connection, displaySessions, lanes, selectedMentions]);

  const refreshState = useCallback(async (options: RefreshStateOptions = {}) => {
    const conn = connectionRef.current;
    if (!conn) return;
    const generation = refreshGenerationRef.current + 1;
    refreshGenerationRef.current = generation;
    const isCurrentRefresh = () =>
      refreshGenerationRef.current === generation && connectionRef.current === conn;
    const includeLaneStatus = options.includeLaneStatus !== false;
    const activeLaneStatusPromise = includeLaneStatus || !activeLaneIdRef.current
      ? Promise.resolve(null)
      : getLaneSummary(conn, activeLaneIdRef.current).catch(() => null);
    const [listedLanes, activeLaneStatus, listedSessions, listedTerminalSessions, sessionSummaries] = await Promise.all([
      listLanes(conn, { includeStatus: includeLaneStatus }),
      activeLaneStatusPromise,
      listChatSessions(conn),
      listTerminalSessions(conn).catch(() => []),
      listSessionSummaries(conn).catch(() => []),
    ]);
    const nextLanes = includeLaneStatus
      ? listedLanes
      : mergeLaneStatusSnapshots(listedLanes, lanesRef.current, activeLaneStatus);
    const nextSessions = mergeOptimisticChatSessions(
      enrichChatSessionsWithLifecycle(listedSessions, sessionSummaries),
      optimisticChatSessionsRef.current,
    );
    const enrichedTerminalSessions = enrichTerminalSessionsWithLifecycle(
      listedTerminalSessions,
      sessionSummaries,
    );
    const nextTerminalSessions = mergeOptimisticTerminalSessions(enrichedTerminalSessions, optimisticTerminalSessionsRef.current);
    // Cross-machine rows ride the refresh the app already runs — no second poll
    // loop — and only while the pane that shows them is open.
    if (drawerOpenRef.current) {
      void loadActivitySnapshot(conn, { hostName: project.remoteLabel })
        .then((snapshot) => {
          if (isCurrentRefresh()) setAttentionSnapshot(snapshot);
        })
        .catch(() => undefined);
    }
    const nextDisplaySessions = sortSessionsByRecentActivity([
      ...nextSessions,
      ...nextTerminalSessions.map((session) => terminalSessionToChatSummary(session)),
    ]);
    const draftMode = draftChatActiveRef.current;
    const target = resolveTuiChatRefreshTarget({
      lanes: nextLanes,
      sessions: nextDisplaySessions,
      context: project,
      lastLaneId: lastLaneIdRef.current,
      activeLaneId: activeLaneIdRef.current,
      activeSessionId: activeSessionIdRef.current,
      draftChatActive: draftMode,
      initialNewChatPreview: initialNewChatPreviewRef.current,
      newChatPreviewLaneId: newChatPreviewLaneIdRef.current,
      selectedWorkChatAction,
      drawerLaneId,
      drawerBrowsingChatId: drawerOpenRef.current
        ? selectedDrawerChatIdRef.current
        : null,
      drawerBrowsingNewChat: drawerOpenRef.current
        && selectedWorkChatActionRef.current === "new-chat",
    });
    const nextLane = target.lane;
    const nextLaneId = target.laneId;
    const nextSession = target.session;
    const nextSessionId = nextSession?.sessionId ?? null;
    const nextTerminalSession = nextSessionId
      ? nextTerminalSessions.find((session) => session.terminalId === nextSessionId) ?? null
      : null;
    const seedSession = target.seedSession;
    const launchToNewChatPreview = target.launchToNewChatPreview;
    const previewMode = target.previewMode;
    if (previewMode) {
      newChatPreviewLaneIdRef.current = nextLaneId;
    }
    let nextEvents: AgentChatEventEnvelope[] | null = null;
    let selectedSessionFound = true;
    if (nextSessionId && !nextTerminalSession) {
      const shouldHydrateHistory = shouldHydrateRefreshHistory({
        hydrateHistory: options.hydrateHistory,
        currentSessionId: activeSessionIdRef.current,
        loadedSessionId: loadedSessionIdRef.current,
        nextSessionId,
      });
      if (shouldHydrateHistory) {
        const historyArrivalWatermark = captureHydratedEventsWatermark(nextSessionId);
        const history = await getChatHistory(conn, nextSessionId);
        if (!isCurrentRefresh()) return;
        if (history.unavailable === true) {
          nextEvents = eventsBySessionIdRef.current[nextSessionId] ?? eventsRef.current;
          loadedSessionIdRef.current = null;
        } else if (history.sessionFound === false) {
          selectedSessionFound = false;
          clearOlderHistoryCursor(nextSessionId);
          setCurrentGoal(null);
          setContextPercent(null);
          setTokenSummary(null);
          setStatusLineStats(null);
          // The replacement view should not carry stale interrupted state from
          // a previously-selected chat that we've now lost track of.
          setInterrupted(false);
          eventCountRef.current = 0;
          loadedSessionIdRef.current = null;
          nextEvents = [];
        } else {
          setCurrentGoal(latestGoal(history.events));
          const visibleHistory = clearedAt
            ? history.events.filter((event) => event.timestamp > clearedAt)
            : history.events;
          // Dedupe the FULL snapshot (no display cap), then split: the newest
          // 500 are displayed as before; the older remainder is buffered so
          // scroll-back drains it locally before the byte cursor — keeping the
          // displayed-oldest ← buffer ← tailStartOffset seams contiguous.
          const dedupedHistory = dedupeTuiEvents(visibleHistory, Math.max(1, visibleHistory.length));
          const { display, buffer: olderBuffer } = splitSnapshotForDisplay(dedupedHistory);
          nextEvents = mergeHydratedEventsWithLive(
            nextSessionId,
            display,
            historyArrivalWatermark,
          );
          const activeModelId = nextSession?.modelId ?? null;
          const fallbackContext = activeModelId ? getModelById(activeModelId)?.contextWindow ?? null : null;
          const stats = latestTokenStats(history.events, fallbackContext);
          setContextPercent(stats.percent);
          setTokenSummary(formatTokenSummary(stats));
          setStatusLineStats(stats);
          eventCountRef.current = history.events.length;
          loadedSessionIdRef.current = nextSessionId;
          // A locally cleared transcript view must not page older history back in.
          if (!clearedAt && olderBuffer.length > 0) {
            olderSnapshotBufferBySessionIdRef.current[nextSessionId] = olderBuffer;
          } else {
            delete olderSnapshotBufferBySessionIdRef.current[nextSessionId];
          }
          seedOlderHistoryCursor(nextSessionId, clearedAt ? null : resolveSnapshotHistoryCursor(history));
        }
      }
      setSessionStreaming(nextSessionId, selectedSessionFound && nextSession?.status === "active");
      if (selectedSessionFound && nextSession?.status === "active") {
        setSessionInterrupted(nextSessionId, false);
        setInterrupted(false);
      }
    } else {
      setContextPercent(null);
      setTokenSummary(null);
      setStatusLineStats(null);
      setCurrentGoal(null);
      setSessionStreaming(nextSessionId, false);
      setSessionInterrupted(nextSessionId, false);
      setStreaming(false);
      setInterrupted(false);
      eventCountRef.current = 0;
      loadedSessionIdRef.current = null;
      nextEvents = [];
    }
    const configSession = nextTerminalSession ? null : nextSession ?? (!draftSeededFromHistoryRef.current ? seedSession : null);
    const nextProvider = terminalSessionProvider(nextTerminalSession) ?? configSession?.provider ?? modelState.provider ?? "codex";
    const commandSessionId = nextTerminalSession ? null : nextSessionId ?? configSession?.sessionId ?? null;
    const commandArgs = commandSessionId
      ? { sessionId: commandSessionId }
      : nextLaneId
        ? { laneId: nextLaneId, provider: nextProvider }
        : null;
    const remoteCommands = commandArgs ? await getSlashCommands(conn, commandArgs).catch(() => []) : [];
    if (!isCurrentRefresh()) return;
    const projectCommands = discoverProjectSlashCommands(nextLane?.worktreePath || project.workspaceRoot);
    const nextCommands = remoteCommands.length ? remoteCommands : projectCommands;
    const provider = normalizeProvider(nextProvider);
    const cachedModels = providerModelsCacheRef.current.get(providerModelsCacheKey(provider, modelStateRef.current.interfaceMode));
    const nextModels = cachedModels ?? registryModelsForProvider(provider);
    if (!cachedModels) {
      void loadProviderModels(provider, { applyDefault: false }).catch(() => undefined);
    }
    const activeModel = nextModels.find((model) => model.modelId === configSession?.modelId || model.id === configSession?.modelId)
      ?? nextModels.find((model) => model.isDefault)
      ?? null;
    lanesRef.current = nextLanes;
    setLanes(nextLanes);
    sessionsRef.current = nextSessions;
    setSessions(nextSessions);
    terminalSessionsRef.current = nextTerminalSessions;
    setTerminalSessions(nextTerminalSessions);
    const attachedId = attachedTerminalIdRef.current;
    if (attachedId && !nextTerminalSessions.some((session) => session.terminalId === attachedId)) {
      setAttachedTerminalId(null);
    }
    selectActiveLaneId(nextLaneId);
    selectActiveSessionId(nextSessionId);
    if (nextEvents !== null) {
      if (nextSessionId) {
        commitActiveSessionEvents(nextSessionId, nextEvents, eventCountRef.current || nextEvents.length);
      } else {
        eventDedupKeysRef.current.clear();
        eventDedupKeyOrderRef.current = [];
        eventCountRef.current = 0;
        eventsRef.current = [];
        setEvents(nextEvents);
      }
    }
    setSlashCommands(nextCommands);
    setModels(nextModels);
    if (launchToNewChatPreview) {
      initialNewChatPreviewRef.current = false;
      newChatPreviewLaneIdRef.current = nextLaneId;
      // Start as a true draft new chat so the center always shows the splash and
      // NO existing chat is resolved/hydrated. Draft mode cascades through the
      // pane-selection + preview effects (they keep "new-chat", skip the
      // history preview), so opening the pane below can't activate a chat.
      setDraftChatMode(true);
      setDrawerLaneId(nextLaneId);
      setSelectedDrawerLaneId(nextLaneId);
      setSelectedDrawerChatId(null);
      setSelectedWorkChatAction(nextLaneId ? "new-chat" : null);
      setWorkSelectedKey(nextLaneId ? `new-chat:${nextLaneId}` : null);
      // Open BOTH side panes so `ade code` launches with the full layout.
      setDrawerOpen(true);
      setRightOpen(true);
    }
    if (nextTerminalSession && nextSessionId) {
      void previewTerminal(conn, nextSessionId)
        .then((preview) => {
          if (activeSessionIdRef.current === nextSessionId) {
            setTerminalPreview((previous) => sameTerminalPreviewFrame(previous, preview) ? previous : preview);
          }
        })
        .catch(() => {
          if (activeSessionIdRef.current === nextSessionId) {
            setTerminalPreview((previous) => previous === null ? previous : null);
          }
        });
    } else {
      setTerminalPreview(null);
    }
    if (nextTerminalSession) {
      const current = modelStateRef.current;
      const terminalProvider = terminalSessionProvider(nextTerminalSession) ?? "claude";
      if (current.provider !== terminalProvider) {
        setModelState((prev) => {
          const next = {
            ...prev,
            ...fallbackModelStatePatch(terminalProvider),
            permissionMode: nextTerminalSession.resumeMetadata?.launch?.permissionMode ?? prev.permissionMode,
            claudePermissionMode: nextTerminalSession.resumeMetadata?.launch?.claudePermissionMode ?? prev.claudePermissionMode,
          };
          modelStateRef.current = next;
          return next;
        });
      }
    } else if (configSession && (!draftMode || !draftSeededFromHistoryRef.current)) {
      // Skip overwriting model state when a local model commit is pending —
      // the server hasn't seen the new pick yet, so configSession still has
      // the old model and would flash the label back to the previous value.
      if (!pendingModelCommitStateRef.current) {
        setModelState((prev) => ({
          ...prev,
          provider,
          model: configSession.model ?? activeModel?.id ?? prev.model,
          modelId: configSession.modelId ?? activeModel?.modelId ?? activeModel?.id ?? prev.modelId,
          displayName: activeModel?.displayName ?? configSession.model ?? prev.displayName,
          reasoningEffort: configSession.reasoningEffort ?? prev.reasoningEffort,
          fastMode: configSession.fastMode === true,
          permissionMode: configSession.permissionMode ?? prev.permissionMode,
          interactionMode: configSession.interactionMode ?? prev.interactionMode,
          claudePermissionMode: configSession.claudePermissionMode ?? prev.claudePermissionMode,
          codexApprovalPolicy: configSession.codexApprovalPolicy ?? prev.codexApprovalPolicy,
          codexSandbox: configSession.codexSandbox ?? prev.codexSandbox,
          codexConfigSource: configSession.codexConfigSource ?? prev.codexConfigSource,
          opencodePermissionMode: configSession.opencodePermissionMode ?? prev.opencodePermissionMode,
          droidPermissionMode: configSession.droidPermissionMode ?? prev.droidPermissionMode,
          cursorModeId: configSession.cursorModeId ?? configSession.cursorModeSnapshot?.currentModeId ?? prev.cursorModeId,
          cursorAvailableModeIds: configSession.cursorModeSnapshot?.availableModeIds ?? prev.cursorAvailableModeIds,
          cursorConfigValues: configSession.cursorConfigValues ?? prev.cursorConfigValues,
        }));
      }
      if (draftMode) draftSeededFromHistoryRef.current = true;
    }
  }, [captureHydratedEventsWatermark, clearedAt, clearOlderHistoryCursor, commitActiveSessionEvents, drawerLaneId, loadProviderModels, mergeHydratedEventsWithLive, modelState.provider, project, seedOlderHistoryCursor, selectActiveLaneId, selectActiveSessionId, selectedWorkChatAction, setDraftChatMode, setSessionInterrupted, setSessionStreaming, setStreaming]);

  const renameLane = useCallback(async (laneIdArg: string | null, name: string) => {
    const conn = connectionRef.current;
    const targetId = laneIdArg ?? activeLaneIdRef.current;
    if (!conn || !targetId) {
      addNotice("No lane is selected.", "error");
      return;
    }
    const trimmed = name.trim();
    if (!trimmed) {
      addNotice("Lane name can't be empty.", "error");
      return;
    }
    try {
      await conn.action("lane", "rename", { laneId: targetId, name: trimmed });
      addNotice(`Renamed lane to "${trimmed}".`, "success");
      await refreshState();
    } catch (err) {
      addNotice(err instanceof Error ? err.message : String(err), "error");
    }
  }, [addNotice, refreshState]);

  const archiveLane = useCallback(async (laneIdArg?: string) => {
    const conn = connectionRef.current;
    const targetId = laneIdArg ?? activeLaneIdRef.current;
    const lane = lanes.find((entry) => entry.id === targetId) ?? null;
    if (!conn || !targetId || !lane) {
      addNotice("No lane is selected.", "error");
      return;
    }
    if (lane.laneType === "primary") {
      addNotice("The primary lane can't be archived.", "error");
      return;
    }
    try {
      await conn.action("lane", "archive", { laneId: targetId });
      addNotice(`Archived lane ${lane.name}. Local files remain.`, "success");
      // If we archived the lane we were on, fall back to another live lane.
      if (activeLaneIdRef.current === targetId) {
        const fallback = lanes.find((entry) => entry.id !== targetId && !entry.archivedAt) ?? null;
        selectActiveLaneId(fallback?.id ?? null);
      }
      await refreshState();
    } catch (err) {
      addNotice(err instanceof Error ? err.message : String(err), "error");
    }
  }, [addNotice, lanes, refreshState, selectActiveLaneId]);

  const unarchiveLane = useCallback(async (query: string) => {
    const conn = connectionRef.current;
    if (!conn) return;
    const term = query.trim();
    if (!term) {
      addNotice("Usage: /lane unarchive <lane-id|name>", "error");
      return;
    }
    try {
      const archived = (await listLanes(conn, { includeArchived: true })).filter((entry) => entry.archivedAt);
      const lower = term.toLowerCase();
      const match = archived.find((entry) => entry.id === term)
        ?? archived.find((entry) => entry.name.toLowerCase() === lower)
        ?? archived.find((entry) => entry.name.toLowerCase().includes(lower));
      if (!match) {
        addNotice(`No archived lane matched "${term}".`, "error");
        return;
      }
      const result = await conn.action<RestoreLaneResult>("lane", "unarchive", { laneId: match.id });
      const restoredFiles = result.worktreeRecreated ? " ADE recreated its local worktree." : "";
      const setupWarning = result.setupWarning ? ` Setup needs attention: ${result.setupWarning}` : "";
      addNotice(`Restored lane ${match.name}.${restoredFiles}${setupWarning}`, result.setupWarning ? "error" : "success");
      await refreshState();
      selectActiveLaneId(match.id);
    } catch (err) {
      addNotice(err instanceof Error ? err.message : String(err), "error");
    }
  }, [addNotice, refreshState, selectActiveLaneId]);

  const selectFallbackChatAfterRemoval = useCallback((removedSession: AgentChatSessionSummary) => {
    const fallback = displaySessions.find((entry) => (
      entry.laneId === removedSession.laneId
      && entry.sessionId !== removedSession.sessionId
      && !entry.archivedAt
    )) ?? null;
    setSelectedDrawerChatId(fallback?.sessionId ?? null);
    setSelectedWorkChatAction(fallback ? null : "new-chat");
    applyDrawerChatSelection({ session: fallback, action: fallback ? null : "new-chat" });
  }, [applyDrawerChatSelection, displaySessions]);

  const archiveChat = useCallback(async (sessionIdArg?: string) => {
    const conn = connectionRef.current;
    const targetId = sessionIdArg ?? activeSessionIdRef.current;
    const session = sessions.find((entry) => entry.sessionId === targetId) ?? null;
    if (!conn || !targetId || !session) {
      addNotice("No runtime-backed chat is selected.", "error");
      return;
    }
    try {
      await archiveChatSession(conn, targetId);
      if (activeSessionIdRef.current === targetId) {
        selectFallbackChatAfterRemoval(session);
      }
      addNotice(`Archived chat ${session.title ?? session.sessionId}.`, "success");
      await refreshState();
    } catch (err) {
      addNotice(err instanceof Error ? err.message : String(err), "error");
    }
  }, [addNotice, refreshState, selectFallbackChatAfterRemoval, sessions]);

  const unarchiveChat = useCallback(async (query: string) => {
    const conn = connectionRef.current;
    if (!conn) return;
    const term = query.trim();
    if (!term) {
      addNotice("Usage: /chat unarchive <chat-id|title>", "error");
      return;
    }
    try {
      const archived = (await listChatSessions(conn, null, { includeArchived: true })).filter((entry) => entry.archivedAt);
      const lower = term.toLowerCase();
      const match = archived.find((entry) => entry.sessionId === term)
        ?? archived.find((entry) => (entry.title ?? "").toLowerCase() === lower)
        ?? archived.find((entry) => (entry.title ?? "").toLowerCase().includes(lower) || entry.sessionId.toLowerCase().includes(lower));
      if (!match) {
        addNotice(`No archived chat matched "${term}".`, "error");
        return;
      }
      await unarchiveChatSession(conn, match.sessionId);
      addNotice(`Unarchived chat ${match.title ?? match.sessionId}.`, "success");
      await refreshState();
      selectActiveLaneId(match.laneId);
      setDrawerLaneId(match.laneId);
      setSelectedDrawerLaneId(match.laneId);
      setSelectedDrawerChatId(match.sessionId);
      setSelectedWorkChatAction(null);
      applyDrawerChatSelection({ session: match, action: null });
    } catch (err) {
      addNotice(err instanceof Error ? err.message : String(err), "error");
    }
  }, [addNotice, applyDrawerChatSelection, refreshState, selectActiveLaneId]);

  const commitModelStateToSession = useCallback(async (nextState: AdeCodeModelState) => {
    const conn = connectionRef.current;
    const sessionId = activeSessionIdRef.current;
    if (!conn || !sessionId || draftChatActiveRef.current) return;
    if (activeTerminalSessionRef.current) return;
    const normalized = { ...nextState, ...applyProviderPermissionMode(nextState) };
    await updateChatModel({
      connection: conn,
      sessionId,
      modelId: normalized.modelId,
      reasoningEffort: normalized.reasoningEffort,
      fastMode: normalized.fastMode,
      permissionMode: normalized.permissionMode,
      interactionMode: normalized.provider === "claude" ? normalized.interactionMode : undefined,
      claudePermissionMode: normalized.provider === "claude" ? normalized.claudePermissionMode : undefined,
      codexApprovalPolicy: normalized.provider === "codex" ? normalized.codexApprovalPolicy : undefined,
      codexSandbox: normalized.provider === "codex" ? normalized.codexSandbox : undefined,
      codexConfigSource: normalized.provider === "codex" ? normalized.codexConfigSource : undefined,
      opencodePermissionMode: runtimeProviderForUiProvider(normalized.provider) === "opencode" ? normalized.opencodePermissionMode : undefined,
      droidPermissionMode: normalized.provider === "droid" ? normalized.droidPermissionMode : undefined,
      cursorModeId: normalized.provider === "cursor" ? normalized.cursorModeId : undefined,
      cursorConfigValues: normalized.provider === "cursor" ? normalized.cursorConfigValues : undefined,
    });
    await refreshState();
  }, [refreshState]);

  const scheduleModelStateCommit = useCallback((nextState: AdeCodeModelState) => {
    pendingModelCommitStateRef.current = nextState;
    if (pendingModelCommitTimerRef.current) {
      clearTimeout(pendingModelCommitTimerRef.current);
    }
    pendingModelCommitTimerRef.current = setTimeout(() => {
      pendingModelCommitTimerRef.current = null;
      const pending = pendingModelCommitStateRef.current;
      pendingModelCommitStateRef.current = null;
      if (!pending) return;
      void commitModelStateToSession(pending).catch((err) => {
        addNotice(err instanceof Error ? err.message : String(err), "error");
      });
    }, 200);
  }, [addNotice, commitModelStateToSession]);

  const resolveActiveTerminalForExit = useCallback((): ChatTerminalSession | null => {
    const activeId = activeSessionIdRef.current;
    const current = activeTerminalSessionRef.current;
    if (current && (current.status === "running" || current.terminalId === activeId)) {
      return current;
    }
    const fromList = activeId
      ? terminalSessionsRef.current.find((session) => session.terminalId === activeId) ?? null
      : null;
    if (fromList && (fromList.status === "running" || fromList.terminalId === activeId)) {
      return fromList;
    }
    const activeLane = activeLaneIdRef.current;
    return terminalSessionsRef.current.find((session) => (
      session.status === "running"
      && terminalSessionProvider(session) != null
      && (!activeLane || session.laneId === activeLane)
    )) ?? null;
  }, []);

  const signalActiveTerminalForExitSync = useCallback(() => {
    const terminal = resolveActiveTerminalForExit();
    if (!terminal) return;
    const conn = connectionRef.current;
    const socket = conn?.socketPath ?? socketPath ?? null;
    signalTerminalWithCliSync({
      projectRoot: project.projectRoot,
      socketPath: socket,
      terminalId: terminal.terminalId,
      signal: "SIGTERM",
    });
    signalTerminalWithCliSync({
      projectRoot: project.projectRoot,
      socketPath: socket,
      terminalId: terminal.terminalId,
      signal: "SIGKILL",
    });
  }, [project.projectRoot, resolveActiveTerminalForExit, socketPath]);

  const signalActiveTerminalForExit = useCallback(async () => {
    const conn = connectionRef.current;
    const terminal = resolveActiveTerminalForExit();
    if (!conn || !terminal) return;
    await signalTerminal(conn, terminal.terminalId, "SIGTERM").catch(() => undefined);
    await delay(350);
    await signalTerminal(conn, terminal.terminalId, "SIGKILL").catch(() => undefined);
  }, [resolveActiveTerminalForExit]);

  const retryStartupConnection = useCallback(() => {
    if (connectionRetryTimerRef.current) {
      clearTimeout(connectionRetryTimerRef.current);
      connectionRetryTimerRef.current = null;
    }
    setError(null);
    setStartupServiceStarting(false);
    setMode("connecting");
    setConnectionRetrySeq((seq) => seq + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (connectionRetryTimerRef.current) {
      clearTimeout(connectionRetryTimerRef.current);
      connectionRetryTimerRef.current = null;
    }
    setMode("connecting");
    setError(null);
    setStartupServiceStarting(false);
    void (async () => {
      try {
        const conn = await connectToAde({ project, forceEmbedded, requireSocket, socketPath, preferServiceRepair, remote: remoteLaunch, projectRegistration: INTERACTIVE_PROJECT_REGISTRATION });
        if (cancelled) {
          await conn.close();
          return;
        }
        heartbeatRef.current = remoteLaunch
          ? null
          : startTuiHeartbeat(project.projectRoot, {
            beforeSignalExit: async () => {
              restoreTerminalInteractiveModes();
              signalActiveTerminalForExitSync();
              await Promise.allSettled([
                flushPendingAdeCodeState(),
                signalActiveTerminalForExit(),
                conn.action("analytics", "flush"),
              ]);
            },
          });
        connectionRef.current = conn;
        connectionPoolRef.current.setLocal({
          connection: conn,
          projectRoot: project.projectRoot,
        });
        setActiveMachineKey(LOCAL_MACHINE_KEY);
        setActiveRemoteLabel(remoteLaunch ? project.remoteLabel ?? "remote" : null);
        setActiveProjectRoot(conn.projectRoot || project.projectRoot);
        setConnection(conn);
        setMode(conn.mode);
        if (!analyticsAppOpenedRef.current) {
          analyticsAppOpenedRef.current = true;
          void captureTuiProductAnalytics(conn, {
            event: "ade_app_opened",
            properties: {
              entry_point: remoteLaunch ? "remote" : "local",
              mode: conn.mode,
              source: "ade_code",
            },
            dedupeKey: "tui_app_opened",
            minimumIntervalMs: 5 * 60_000,
          }).catch(() => undefined);
        }
        draftSeededFromHistoryRef.current = false;
        newChatPreviewLaneIdRef.current = null;
        setDraftChatMode(false);
        selectActiveSessionId(initialSessionHintRef.current);
        eventDedupKeysRef.current.clear();
        eventDedupKeyOrderRef.current = [];
        eventCountRef.current = 0;
        setEvents([]);
        await refreshState();
        if (
          !cancelled
          && !project.skipProjectPicker
          && !project.sessionHint
          && !projectPickerAutoOpenedRef.current
        ) {
          projectPickerAutoOpenedRef.current = true;
          await openProjectPickerRef.current({ notice: true });
        }
      } catch (err) {
        if (cancelled) return;
        heartbeatRef.current?.stop();
        heartbeatRef.current = null;
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        setStartupServiceStarting(err instanceof RuntimeServiceStillStartingError);
        setMode("connecting");
        connectionRetryTimerRef.current = setTimeout(() => {
          connectionRetryTimerRef.current = null;
          setConnectionRetrySeq((seq) => seq + 1);
        }, STARTUP_RECONNECT_DELAY_MS);
        connectionRetryTimerRef.current.unref?.();
      }
    })();
    return () => {
      cancelled = true;
      if (connectionRetryTimerRef.current) {
        clearTimeout(connectionRetryTimerRef.current);
        connectionRetryTimerRef.current = null;
      }
      heartbeatRef.current?.stop();
      heartbeatRef.current = null;
      void flushPendingAdeCodeState().catch(() => {});
      if (pendingModelCommitTimerRef.current) {
        clearTimeout(pendingModelCommitTimerRef.current);
        pendingModelCommitTimerRef.current = null;
      }
      if (feedbackCloseTimerRef.current) {
        clearTimeout(feedbackCloseTimerRef.current);
        feedbackCloseTimerRef.current = null;
      }
      pendingModelCommitStateRef.current = null;
      connectionRef.current = null;
      void connectionPoolRef.current.closeAll().catch(() => {});
    };
  }, [connectionRetrySeq, flushPendingAdeCodeState, forceEmbedded, preferServiceRepair, project, remoteLaunch, requireSocket, signalActiveTerminalForExit, signalActiveTerminalForExitSync, socketPath]);

  // Stable handle to the latest refreshState so the chat-event subscription can
  // call it without listing refreshState as a dependency (its identity churns on
  // drawer/lane/model changes, which would needlessly re-bind the subscription).
  const refreshStateRef = useRef(refreshState);
  useEffect(() => {
    refreshStateRef.current = refreshState;
  }, [refreshState]);

  const adoptPooledConnection = useCallback(async (
    entry: { machineKey: string; label: string; connection: AdeCodeConnection; projectRoot: string; remoteLabel: string | null },
    sessionId?: string | null,
  ) => {
    connectionRef.current = entry.connection;
    setConnection(entry.connection);
    setMode(entry.connection.mode);
    setActiveMachineKey(entry.machineKey);
    setActiveRemoteLabel(entry.remoteLabel);
    setActiveProjectRoot(entry.projectRoot);
    connectionLostRef.current = false;
    setConnectionLost(false);
    if (sessionId) selectActiveSessionId(sessionId);
    await refreshStateRef.current();
  }, [selectActiveSessionId]);

  const hopToLocal = useCallback(async (sessionId?: string | null) => {
    const local = connectionPoolRef.current.local();
    if (!local) {
      addNotice("This machine's ADE connection is gone. Retry from the connecting screen.", "error");
      return;
    }
    await adoptPooledConnection(local, sessionId);
    addNotice("Back on this machine.", "success");
  }, [addNotice, adoptPooledConnection]);

  const hopToMachine = useCallback(async (
    query: MachineQuery,
    options: {
      sessionId?: string | null;
      projectCanonicalId?: string | null;
      projectRootPath?: string | null;
      projectQuery?: string | null;
    } = {},
  ) => {
    if (query.machineKey === LOCAL_MACHINE_KEY) {
      await hopToLocal(options.sessionId);
      return;
    }
    if (hopInFlightRef.current) {
      addNotice("Already connecting to another machine.", "info");
      return;
    }
    const pooled = connectionPoolRef.current.get(query.machineKey);
    if (pooled) {
      await adoptPooledConnection(pooled, options.sessionId);
      addNotice(`Opened ${pooled.label}.`, "success");
      return;
    }
    hopInFlightRef.current = true;
    const name = query.name?.trim() || query.machineKey;
    addNotice(`Connecting to ${name}…`, "info");
    try {
      const entry = await connectionPoolRef.current.connectRemote({
        query,
        projectCanonicalId: options.projectCanonicalId,
        projectRootPath: options.projectRootPath,
        projectQuery: options.projectQuery,
        accountProjectRoots: [project.projectRoot],
      });
      await adoptPooledConnection(entry, options.sessionId);
      addNotice(`Connected to ${entry.label} via paired runtime.`, "success");
    } catch (error) {
      addNotice(error instanceof Error ? error.message : String(error), "error");
    } finally {
      hopInFlightRef.current = false;
    }
  }, [addNotice, adoptPooledConnection, hopToLocal, project.projectRoot]);

  hopToForeignRowRef.current = (row) => {
    if (!row.machine) return;
    if (row.machine.online === false) {
      addNotice(`${row.machine.name} is offline.`, "error");
      return;
    }
    void hopToMachine({
      machineKey: row.machine.machineKey,
      accountMachineKey: row.machine.accountMachineKey,
      deviceId: row.machine.deviceId,
      name: row.machine.name,
    }, {
      sessionId: row.sessionId,
      projectCanonicalId: row.projectCanonicalId,
      projectRootPath: row.projectRootPath,
    });
  };

  const switchProjectOnCurrentMachine = useCallback(async (rootPath: string) => {
    const conn = connectionRef.current;
    if (!conn?.socketPath) {
      addNotice("No ADE socket is available to switch projects.", "error");
      return;
    }
    addNotice("Switching project…", "info");
    try {
      const next = await connectToAde({
        project: {
          launchCwd: rootPath,
          projectRoot: rootPath,
          workspaceRoot: rootPath,
          laneHint: null,
          sessionHint: null,
          remote: activeMachineKey !== LOCAL_MACHINE_KEY || remoteLaunch,
          remoteLabel: activeRemoteLabel,
        },
        socketPath: conn.socketPath,
        requireSocket: true,
        remote: activeMachineKey !== LOCAL_MACHINE_KEY || remoteLaunch,
        projectRegistration: INTERACTIVE_PROJECT_REGISTRATION,
      });
      const previous = conn;
      if (activeMachineKey === LOCAL_MACHINE_KEY) {
        connectionPoolRef.current.setLocal({ connection: next, projectRoot: rootPath });
      }
      connectionRef.current = next;
      setConnection(next);
      setMode(next.mode);
      setActiveProjectRoot(rootPath);
      if (previous !== next) await previous.close().catch(() => undefined);
      await refreshStateRef.current();
      addNotice(`Opened ${path.basename(rootPath)}.`, "success");
    } catch (error) {
      addNotice(error instanceof Error ? error.message : String(error), "error");
    }
  }, [activeMachineKey, activeRemoteLabel, addNotice, remoteLaunch]);

  const openProjectPicker = useCallback(async (options?: { notice?: boolean; query?: string }) => {
    const conn = connectionRef.current;
    if (!conn) {
      if (!options?.notice) {
        setRightPane({
          kind: "details",
          title: "Projects",
          body: "ADE is still connecting. Retry when the runtime is ready.",
        });
        setRightOpen(true);
        setPaneFocus("details");
      }
      return;
    }
    try {
      const raw = await conn.request("projects.list", {});
      const ranked = rankProjectsForPicker(coerceProjectRecords(raw), activeProjectRoot);
      const query = options?.query?.trim() ?? "";
      const filtered = query
        ? ranked.filter((entry) => `${entry.displayName} ${entry.rootPath} ${entry.projectId}`.toLowerCase().includes(query.toLowerCase()))
        : ranked;
      const picked = query ? pickProjectRecord(filtered, { name: query, rootPath: query, projectId: query }) : null;
      if (picked && query) {
        await switchProjectOnCurrentMachine(picked.rootPath);
        return;
      }
      // Startup: nothing to choose, so don't flash the right pane.
      if (options?.notice && !query && ranked.length <= 1) return;
      projectPickerRootByIdRef.current = new Map(filtered.map((entry) => [entry.projectId, entry.rootPath]));
      setRightSelectionIndex(Math.max(0, filtered.findIndex((entry) => entry.rootPath === activeProjectRoot)));
      setRightPane({
        kind: "list",
        title: "Projects",
        rows: filtered.map((entry) => (
          `${entry.rootPath === activeProjectRoot ? "● " : "  "}${entry.displayName}  ${entry.rootPath}`
        )),
        emptyText: "No projects registered on this machine.",
        action: { kind: "switch-project", ids: filtered.map((entry) => entry.projectId) },
      });
      setRightOpen(true);
      setPaneFocus("details");
      if (options?.notice) {
        addNotice("Pick a project to open. The current one is at the top.", "info");
      }
    } catch (error) {
      if (options?.notice) return;
      setRightPane({
        kind: "details",
        title: "Projects",
        body: error instanceof Error ? error.message : String(error),
      });
      setRightOpen(true);
      setPaneFocus("details");
    }
  }, [activeProjectRoot, addNotice, setPaneFocus, switchProjectOnCurrentMachine]);
  openProjectPickerRef.current = openProjectPicker;

  const runBackgroundRefresh = useCallback(() => {
    if (backgroundRefreshInFlightRef.current) {
      backgroundRefreshPendingAfterInFlightRef.current = true;
      return;
    }
    backgroundRefreshInFlightRef.current = true;
    void refreshStateRef.current({ hydrateHistory: false })
      .catch(() => undefined)
      .finally(() => {
        backgroundRefreshInFlightRef.current = false;
        if (!backgroundRefreshPendingAfterInFlightRef.current) return;
        backgroundRefreshPendingAfterInFlightRef.current = false;
        if (backgroundRefreshTimerRef.current) clearTimeout(backgroundRefreshTimerRef.current);
        backgroundRefreshTimerRef.current = setTimeout(() => {
          backgroundRefreshTimerRef.current = null;
          runBackgroundRefresh();
        }, BACKGROUND_REFRESH_DEBOUNCE_MS);
        backgroundRefreshTimerRef.current.unref?.();
      });
  }, []);

  const scheduleBackgroundRefresh = useCallback(() => {
    if (backgroundRefreshTimerRef.current) {
      clearTimeout(backgroundRefreshTimerRef.current);
    }
    backgroundRefreshTimerRef.current = setTimeout(() => {
      backgroundRefreshTimerRef.current = null;
      runBackgroundRefresh();
    }, BACKGROUND_REFRESH_DEBOUNCE_MS);
    backgroundRefreshTimerRef.current.unref?.();
  }, [runBackgroundRefresh]);

  useEffect(() => () => {
    if (backgroundRefreshTimerRef.current) {
      clearTimeout(backgroundRefreshTimerRef.current);
      backgroundRefreshTimerRef.current = null;
    }
  }, []);

  const flushPendingChatEvents = useCallback(() => {
    if (chatFlushTimerRef.current) {
      clearTimeout(chatFlushTimerRef.current);
      chatFlushTimerRef.current = null;
    }
    const buffered = pendingChatEnvelopesRef.current;
    if (buffered.length === 0) return;
    pendingChatEnvelopesRef.current = [];
    // Re-apply the clearedAt guard at flush time: if the transcript was cleared
    // after these envelopes were buffered (e.g. /clear armed the timer), drop the
    // stale ones so they don't re-materialize in the cleared transcript.
    const clearedAtValue = clearedAtRef.current;
    const filtered = clearedAtValue
      ? buffered.filter((envelope) => envelope.timestamp > clearedAtValue)
      : buffered;
    if (filtered.length === 0) return;
    // Coalesce the burst of streamed text deltas into per-message envelopes BEFORE
    // they hit React state. This is the single biggest flood reducer: a turn that
    // streams thousands of tokens otherwise grows `events` by one entry per token,
    // forcing the transcript to re-aggregate + re-wrap on every flush. Applied
    // once here so the per-session map and the active-session buffer stay in sync.
    const pending = coalesceTextDeltaEnvelopes(filtered);

    // (1) Per-session transcript map — append all buffered envelopes for each
    // affected session in a single deduped update. Previously this ran one O(n)
    // dedupe per token; now it runs once per flush per session.
    setEventsBySessionId((prev) => {
      const grouped = new Map<string, AgentChatEventEnvelope[]>();
      for (const envelope of pending) {
        const arr = grouped.get(envelope.sessionId);
        if (arr) arr.push(envelope);
        else grouped.set(envelope.sessionId, [envelope]);
      }
      const next = { ...prev };
      for (const [sessionId, envelopes] of grouped) {
        if (detachedHistorySessionIdsRef.current.has(sessionId)) {
          detachedLiveEventsBySessionIdRef.current[sessionId] = [
            ...(detachedLiveEventsBySessionIdRef.current[sessionId] ?? []),
            ...envelopes,
          ].slice(-TUI_SNAPSHOT_DISPLAY_CAP);
          continue;
        }
        const existing = prev[sessionId] ?? [];
        // Keep the live-append window at least as large as what's already
        // loaded: scroll-back paging can grow a session past the default 500,
        // and the default cap would otherwise drop that older history on the
        // next streamed token.
        next[sessionId] = dedupeTuiEvents([...existing, ...envelopes], Math.max(500, existing.length));
      }
      return next;
    });

    // (2) Active-session transcript — incremental reserve/append, batched into a
    // single setState so a burst of tokens triggers one React render, not N.
    const activeId = activeSessionIdRef.current;
    if (activeId && !detachedHistorySessionIdsRef.current.has(activeId)) {
      const reserved: Array<{ envelope: AgentChatEventEnvelope; key: string }> = [];
      for (const envelope of pending) {
        if (envelope.sessionId !== activeId) continue;
        const key = reserveTuiEventDedupKey(envelope, eventDedupKeysRef.current);
        if (key !== null) reserved.push({ envelope, key });
      }
      if (reserved.length > 0) {
        let nextEvents = eventsRef.current;
        let nextOrder = eventDedupKeyOrderRef.current;
        // Same rationale as the per-session map above: never let live appends
        // trim below the paged-in scroll-back window.
        const appendLimit = Math.max(500, nextEvents.length);
        for (const { envelope, key } of reserved) {
          const appended = appendReservedTuiEvent(nextEvents, envelope, eventDedupKeysRef.current, nextOrder, key, appendLimit);
          nextEvents = appended.events;
          nextOrder = appended.eventKeys;
        }
        eventDedupKeyOrderRef.current = nextOrder;
        eventCountRef.current = nextEvents.length;
        eventsRef.current = nextEvents;
        setEvents(nextEvents);
      }
    }
    // Note: stable deps ([]) — uses only refs + stable setters. This keeps the
    // onChatEvent subscription from re-binding (and discarding the buffer) every
    // time refreshState's identity churns.
  }, []);

  const scheduleChatFlush = useCallback(() => {
    if (chatFlushTimerRef.current) return;
    chatFlushTimerRef.current = setTimeout(() => {
      chatFlushTimerRef.current = null;
      flushPendingChatEvents();
    }, CHAT_EVENT_FLUSH_MS);
  }, [flushPendingChatEvents]);

  useEffect(() => {
    if (!connection) return;
    const unsubscribe = connection.onChatEvent((envelope) => {
      const currentMultiView = multiViewRef.current;
      const openSessionIds = new Set(
        currentMultiView
          ? currentMultiView.tiles.map((tile) => tile.sessionId)
          : [activeSessionIdRef.current].filter((value): value is string => Boolean(value)),
      );
      const drawerBrowsingChatId = drawerOpenRef.current
        && selectedWorkChatActionRef.current == null
        ? selectedDrawerChatIdRef.current
        : null;
      if (drawerBrowsingChatId) openSessionIds.add(drawerBrowsingChatId);
      if (!openSessionIds.has(envelope.sessionId)) {
        // Event for a session we're not displaying — refresh summaries (cheap,
        // dedup-guarded). Only the open-session token stream below is coalesced.
        scheduleBackgroundRefresh();
        return;
      }
      const clearedAtNow = clearedAtRef.current;
      if (clearedAtNow && envelope.timestamp <= clearedAtNow) return;
      const event = envelope.event as Record<string, unknown>;
      const isActiveSessionEvent = envelope.sessionId === activeSessionIdRef.current;

      // Buffer the envelope; the transcript state is applied on the next flush.
      // High-frequency token deltas coalesce on the timer; lifecycle edges flush
      // immediately so the transcript is consistent with the side-effects below.
      pendingChatEnvelopesRef.current.push(envelope);
      const eventType = typeof event.type === "string" ? event.type : "";
      if (isChatFlushEdge(eventType)) flushPendingChatEvents();
      else scheduleChatFlush();

      // Lifecycle side-effects stay immediate (low-frequency): they drive the
      // streaming spinner, interrupt flags, and the right pane.
      if (event.type === "status" && event.turnStatus === "started") {
        setSessionStreaming(envelope.sessionId, true);
        setSessionInterrupted(envelope.sessionId, false);
        if (isActiveSessionEvent) setInterrupted(false);
        if (isActiveSessionEvent && activePaneRef.current !== "drawer") {
          setRightPane((prev) => {
            if (prev.kind === "chat-info") return { kind: "chat-info", info: buildChatInfoSnapshotRef.current() };
            return prev;
          });
        }
      }
      if (event.type === "status" && event.turnStatus === "interrupted") {
        setSessionStreaming(envelope.sessionId, false);
        setSessionInterrupted(envelope.sessionId, true);
        if (isActiveSessionEvent) setInterrupted(true);
      }
      if (event.type === "done") {
        setSessionStreaming(envelope.sessionId, false);
        setSessionInterrupted(envelope.sessionId, event.status === "interrupted");
        if (isActiveSessionEvent) setInterrupted(event.status === "interrupted");
      }
      if (event.type === "status" && (event.turnStatus === "completed" || event.turnStatus === "failed")) {
        setSessionStreaming(envelope.sessionId, false);
        setSessionInterrupted(envelope.sessionId, false);
        if (isActiveSessionEvent) setInterrupted(false);
      }
      if (shouldAutoOpenChatInfoForEvent({
        eventType,
        isActiveSessionEvent,
        activePane: activePaneRef.current,
        userDismissedRightPane: userDismissedRightPaneRef.current,
      })) {
        // Auto-open chat info only when the user is in the chat surface.
        // Drawer navigation keeps lane details in the right pane.
        setRightPane((prev) => {
          if (prev.kind === "chat-info") {
            if (!rightOpenRef.current) {
              rightOpenRef.current = true;
              setRightOpen(true);
            }
            subagentAutoOpenedSessionsRef.current.add(envelope.sessionId);
            return { kind: "chat-info", info: buildChatInfoSnapshotRef.current() };
          }
          if (prev.kind !== "empty" && prev.kind !== "lane-details") return prev;
          setRightOpen(true);
          rightOpenRef.current = true;
          subagentAutoOpenedSessionsRef.current.add(envelope.sessionId);
          return {
            kind: "chat-info",
            info: buildChatInfoSnapshotRef.current(),
          };
        });
      }
      // A backend self-heal/splice-repair rewrote persisted envelope history for
      // the active chat (session_meta_updated · historyInvalidated). Our in-memory
      // event buffer is now stale relative to the repaired turns and stays that
      // way until a reconnect/gap, so refetch history — mirroring desktop
      // AgentChatPane's loadHistory(force) on the same signal.
      if (
        envelope.event.type === "session_meta_updated"
        && envelope.event.historyInvalidated === true
        && isActiveSessionEvent
      ) {
        void refreshStateRef.current({ hydrateHistory: true }).catch(() => undefined);
      }
      // A cross-client mode change (iOS/desktop re-moding the session the TUI is
      // viewing) arrives as a transient session_meta_updated carrying the new
      // permission/interaction fields. The composer footer reads modelState, not
      // the summary, so re-seed it directly for the active chat — mirroring the
      // desktop AgentChatPane handler. Apply via raw setModelState (NOT
      // applyModelState) so we don't schedule a commit and echo back to the
      // server. Skip while a local commit is pending: the user's own pick wins
      // and the server will echo it back momentarily.
      if (
        envelope.event.type === "session_meta_updated"
        && isActiveSessionEvent
        && !pendingModelCommitStateRef.current
      ) {
        const meta = envelope.event;
        setModelState((prev) => {
          const next: AdeCodeModelState = {
            ...prev,
            ...(meta.permissionMode !== undefined ? { permissionMode: meta.permissionMode } : {}),
            ...(meta.interactionMode !== undefined ? { interactionMode: meta.interactionMode ?? prev.interactionMode } : {}),
            ...(meta.claudePermissionMode !== undefined ? { claudePermissionMode: meta.claudePermissionMode } : {}),
            ...(meta.codexApprovalPolicy !== undefined ? { codexApprovalPolicy: meta.codexApprovalPolicy } : {}),
            ...(meta.codexSandbox !== undefined ? { codexSandbox: meta.codexSandbox } : {}),
            ...(meta.codexConfigSource !== undefined ? { codexConfigSource: meta.codexConfigSource } : {}),
            ...(meta.opencodePermissionMode !== undefined ? { opencodePermissionMode: meta.opencodePermissionMode } : {}),
            ...(meta.droidPermissionMode !== undefined ? { droidPermissionMode: meta.droidPermissionMode } : {}),
            ...("cursorModeId" in meta || meta.cursorModeSnapshot !== undefined
              ? {
                  // An explicit cursorModeId (present in the event) is
                  // authoritative — including a `null` clear, which must reach
                  // the composer rather than `??`-falling-back to a stale
                  // mode/snapshot. Only when the key is absent do we derive the
                  // current mode from a snapshot; a partial event carrying
                  // neither leaves the mode unchanged.
                  cursorModeId: "cursorModeId" in meta
                    ? (meta.cursorModeId ?? null)
                    : (meta.cursorModeSnapshot?.currentModeId ?? prev.cursorModeId),
                  cursorAvailableModeIds: meta.cursorModeSnapshot?.availableModeIds ?? prev.cursorAvailableModeIds,
                }
              : {}),
            // An explicit cursorConfigValues in the event is authoritative (the
            // host recomputes the snapshot only on mode changes, so config-only
            // edits arrive here). Absent = no change; an explicit null clears.
            ...(meta.cursorConfigValues !== undefined
              ? { cursorConfigValues: meta.cursorConfigValues ?? {} }
              : {}),
          };
          modelStateRef.current = next;
          return next;
        });
      }
    });
    return () => {
      unsubscribe();
      // Flush whatever is buffered so a reconnect doesn't strand token deltas.
      // flushPendingChatEvents() already clears chatFlushTimerRef and resets
      // pendingChatEnvelopesRef after draining, mirroring the PTY cleanup.
      flushPendingChatEvents();
    };
    // Re-bind only when the connection itself changes (reconnect). clearedAt and
    // refreshState are read via refs so their churn doesn't drop the buffer.
	  }, [connection, flushPendingChatEvents, scheduleBackgroundRefresh, scheduleChatFlush, setSessionInterrupted, setSessionStreaming]);

  const handleRuntimeEventGap = useCallback(() => {
    void refreshState({ hydrateHistory: true }).catch((err) => {
      setError(err instanceof Error ? err.message : String(err));
    });
  }, [refreshState]);

	  useEffect(() => {
    if (!connection) return;
    let disposed = false;
    let unsubscribe: (() => void) | null = null;

    // Cap on retained chunks. We append monotonically (so TerminalPane's
    // chunkIndexRef keeps advancing — the desync fix) and only trim well past
    // 500 so trims are rare; on a trim TerminalPane resets + replays the tail.
    const MAX_RETAINED_CHUNKS = 4_000;
    const TRIM_TO_CHUNKS = 2_000;

    const flushPendingPty = () => {
      ptyFlushTimerRef.current = null;
      ptyFlushDelayRef.current = null;
      const pending = pendingPtyChunksRef.current;
      if (pending.size === 0) return;
      const drained = new Map(pending);
      pending.clear();
      // Bump "↓ N new" for sessions the user has scrolled away from.
      const scrollMap = terminalScrollBySessionIdRef.current;
      let scrollPatch: TerminalScrollBySessionId | null = null;
      for (const [sid, chunks] of drained) {
        const current = readTerminalScroll(scrollMap, sid);
        if (current.scrollOffset > 0) {
          const arrivedRows = chunks.reduce(
            (sum, chunk) => sum + Math.max(0, (chunk.match(/\n/g)?.length ?? 0)),
            0,
          );
          // Anchor scrolled-up content to its absolute buffer line: advance
          // scrollOffset by arrivedRows (clamped) so the viewed window does not
          // drift down as viewportY grows. The next onViewportMetrics report
          // re-clamps on commit.
          const maxScrollable =
            terminalViewportMetricsRef.current?.maxScrollable ??
            Number.POSITIVE_INFINITY;
          const next = noteTerminalNewRows(current, arrivedRows, maxScrollable);
          if (next !== current) {
            scrollPatch = { ...(scrollPatch ?? scrollMap), [sid]: next };
          }
        }
      }
      if (scrollPatch) setTerminalScrollBySessionId(scrollPatch);
      setTerminalLiveChunks((prev) => {
        const next: Record<string, string[]> = { ...prev };
        for (const [sid, chunks] of drained) {
          if (chunks.length === 0) continue;
          let merged = [...(next[sid] ?? []), ...chunks];
          if (merged.length > MAX_RETAINED_CHUNKS) merged = merged.slice(-TRIM_TO_CHUNKS);
          next[sid] = merged;
        }
        return next;
      });
    };

    const scheduleFlush = (delayMs: number) => {
      // Timer only while chunks are pending → idle cost zero. If direct Claude
      // control asks for the lower-latency path while a preview flush is queued,
      // reschedule sooner so typed characters don't wait behind passive output.
      if (ptyFlushTimerRef.current) {
        if ((ptyFlushDelayRef.current ?? Number.POSITIVE_INFINITY) <= delayMs) return;
        clearTimeout(ptyFlushTimerRef.current);
      }
      ptyFlushDelayRef.current = delayMs;
      ptyFlushTimerRef.current = setTimeout(flushPendingPty, delayMs);
    };

    void connection.subscribeRuntimeEvents({
      category: "pty",
      cursor: 0,
      limit: 50,
      replay: false,
      onGap: handleRuntimeEventGap,
    }, (event) => {
      const payload = event.payload as { type?: unknown; event?: unknown };
      const terminalEvent = payload.event as { sessionId?: unknown; data?: unknown } | undefined;
      const sessionId = typeof terminalEvent?.sessionId === "string" ? terminalEvent.sessionId : null;
      if (!sessionId) return;
      if (payload.type === "pty_data" && typeof terminalEvent?.data === "string") {
        if (!shouldBufferPtyDataForSession({
          sessionId,
          activeSessionId: activeSessionIdRef.current,
          multiView: multiViewRef.current,
          gridViewActive: gridViewActiveRef.current,
        })) {
          return;
        }
        const buf = pendingPtyChunksRef.current.get(sessionId);
        if (buf) buf.push(terminalEvent.data);
        else pendingPtyChunksRef.current.set(sessionId, [terminalEvent.data]);
        const flushDelay = sessionId === attachedTerminalIdRef.current
          ? PTY_ATTACHED_FLUSH_MS
          : PTY_PREVIEW_FLUSH_MS;
        scheduleFlush(flushDelay);
        return;
      }
      if (payload.type === "pty_exit") {
        void refreshState({ hydrateHistory: false }).catch(() => undefined);
      }
    }).then((stop) => {
      if (disposed) {
        stop();
        return;
      }
      unsubscribe = stop;
    }).catch(() => {});
    return () => {
      disposed = true;
      unsubscribe?.();
      if (ptyFlushTimerRef.current) {
        clearTimeout(ptyFlushTimerRef.current);
        ptyFlushTimerRef.current = null;
        ptyFlushDelayRef.current = null;
      }
      // Flush whatever is buffered so a reconnect doesn't strand chunks.
      flushPendingPty();
    };
  }, [connection, handleRuntimeEventGap, refreshState]);

  useEffect(() => {
    if (!connection || !activeSessionId) {
      loadedSessionIdRef.current = activeSessionId;
      return;
    }
    if (loadedSessionIdRef.current === activeSessionId) return;
    void refreshState({ hydrateHistory: true }).catch((err) => {
      setError(err instanceof Error ? err.message : String(err));
    });
  }, [activeSessionId, connection, refreshState]);

  const chatRefreshPollActive = streaming
    || (activeSession != null && isChatSessionAnimating(activeSession))
    || (activeTerminalSession != null && isTerminalSessionFastPollActive(activeTerminalSession));

  useEffect(() => {
    if (!connection) return;
    const intervalMs = chatRefreshPollActive ? 1_000 : 15_000;
    const timer = setInterval(() => {
      void refreshState({ hydrateHistory: false, includeLaneStatus: false }).catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      });
    }, intervalMs);
    return () => clearInterval(timer);
  }, [chatRefreshPollActive, connection, refreshState]);

  useEffect(() => {
    if (!connection) return;
    const timer = setInterval(() => {
      void refreshState({ hydrateHistory: false, includeLaneStatus: true }).catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      });
    }, LANE_STATUS_REFRESH_MS);
    return () => clearInterval(timer);
  }, [connection, refreshState]);

  useEffect(() => {
    if (!connection) {
      setDiffByLaneId({});
      return;
    }
    const laneIds = diffLaneIdsKey.split("\n").filter(Boolean);
    if (laneIds.length === 0) {
      setDiffByLaneId({});
      return;
    }

    let cancelled = false;
    const refreshDiffStats = async () => {
      try {
        const next = await listLaneDiffStats(connection, laneIds);
        if (!cancelled) setDiffByLaneId(next);
      } catch {
        // Diff stats can be expensive and transiently fail while lanes are moving.
        // Keep the previous cache rather than flickering the drawer.
      }
    };
    void refreshDiffStats();
    // The drawer shows every lane's +adds/−dels inline now, so refresh briskly
    // while an agent is actively editing (it's a single batched RPC for all
    // lanes) and fall back to a calm cadence when idle.
    const intervalMs = chatRefreshPollActive ? 2_000 : 10_000;
    const timer = setInterval(() => {
      void refreshDiffStats();
    }, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [chatRefreshPollActive, connection, diffLaneIdsKey]);

  /**
   * Plugin socket contributions for the drawer, on a calm poll.
   *
   * Same precedent as the plugin PANEL pane: the daemon's plugin deltas are a
   * sync-side protocol this client does not speak, so a poll is how it stays
   * current. Slower than the diff and PR polls on purpose — a badge changing
   * within half a minute is fine, and the read is three RPCs plus a manifest per
   * newly-seen plugin version. A machine with nothing enabled costs exactly one
   * `plugin.list` and stops there.
   */
  useEffect(() => {
    if (!connection) {
      setPluginContributions(EMPTY_PLUGIN_TUI_CONTRIBUTIONS);
      setPluginKeybindingRoster([]);
      return;
    }
    let cancelled = false;
    const refreshPluginContributions = async () => {
      try {
        // The roster rides this poll because keybindings change on exactly the
        // events it already watches for: an install, an uninstall, an enable.
        // Only what the matrix reads is kept — declarations and install time —
        // so this holds no plugin state that could go stale in another way.
        const roster = await listPlugins(connection, { includeDisabled: true });
        if (!cancelled) {
          setPluginKeybindingRoster(roster.state === "ok"
            ? roster.plugins.map((plugin) => ({
              pluginId: plugin.pluginId,
              displayName: plugin.displayName,
              enabled: plugin.enabled,
              ...(plugin.installedAt ? { installedAt: plugin.installedAt } : {}),
              ...(plugin.keybindings ? { keybindings: plugin.keybindings } : {}),
            }))
            : []);
        }
        const next = await loadPluginTuiContributions(connection);
        if (!cancelled) setPluginContributions(next);
      } catch {
        // Contributions are decoration on rows that render perfectly well
        // without them. Keep the previous set rather than blanking the drawer
        // over one failed read.
      }
    };
    void refreshPluginContributions();
    const timer = setInterval(() => {
      void refreshPluginContributions();
    }, 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [connection]);

  useEffect(() => {
    if (!connection) {
      setPrByLaneId({});
      return;
    }
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;
    const refreshPrsByLane = async () => {
      try {
        // ADE-135: `PrLaneSummary` now carries the service's canonical
        // `checksStatus`, so consumers gate on that instead of inferring a pass
        // from `checksPassed === checksTotal`.
        // An earlier revision joined a second unscoped `pr listAll` call for the
        // same field: redundant, an extra whole-history serialization on a 30s
        // refresh, and strictly less correct — projection-backed and detached
        // lanes are absent from `pull_requests`, so their status came back
        // undefined and fell through to exactly the producer-blind green this
        // ticket exists to remove.
        const prs = await listPrsByLane(connection);
        if (cancelled) return;
        const next: Record<string, LanePrSummary> = {};
        for (const pr of prs) {
          next[pr.laneId] = {
            number: pr.number,
            state: pr.state,
            checksPassed: pr.checksPassed,
            checksTotal: pr.checksTotal,
            checksStatus: pr.checksStatus,
            stack: pr.stack ?? null,
          };
        }
        setPrByLaneId(next);
      } catch {
        // PR checks are rate-limit sensitive; keep the previous cache on transient failures.
      }
    };
    void refreshPrsByLane();
    const timer = setInterval(() => {
      void refreshPrsByLane();
    }, 30_000);
    void connection.subscribeRuntimeEvents({
      category: "runtime",
      cursor: 0,
      limit: 50,
      replay: false,
      onGap: handleRuntimeEventGap,
    }, (event) => {
      const type = typeof event.payload.type === "string" ? event.payload.type : "";
      if (type === "lane_lifecycle_event") {
        const laneEvent = event.payload.event as { type?: unknown } | undefined;
        if (laneEvent?.type === "lane-branch-updated") {
          void refreshState({ hydrateHistory: false }).catch(() => undefined);
        }
        return;
      }
      if (type !== "prs-updated" && type !== "pr-notification") return;
      void refreshPrsByLane();
      void refreshState({ hydrateHistory: false }).catch(() => undefined);
    }).then((stop) => {
      if (cancelled) {
        stop();
        return;
      }
      unsubscribe = stop;
    }).catch(() => {});
    return () => {
      cancelled = true;
      clearInterval(timer);
      unsubscribe?.();
    };
  }, [connection, handleRuntimeEventGap, refreshState]);

  // Detect an attached socket dropping mid-session. Without this the UI freezes
  // on a stale snapshot (and a spinner that never resolves) with no retry.
  useEffect(() => {
    if (!connection?.onConnectionClose) return;
    return connection.onConnectionClose(() => {
      if (connectionLostRef.current) return;
      connectionLostRef.current = true;
      setConnectionLost(true);
      // Clear streaming across all sessions so the spinner doesn't hang and the
      // reconnect probe below isn't gated on a turn that can never complete.
      setStreamingBySessionId({});
      addNotice("Connection to the ADE runtime dropped — reconnecting…", "error");
    });
  }, [addNotice, connection]);

  useEffect(() => {
    if (!connection || forceEmbedded) return;
    // Reconnect when running embedded (try to upgrade to the shared daemon) OR
    // when an attached socket dropped (connectionLost). A healthy attached
    // connection needs no probe.
    if (mode === "attached" && !connectionLost) return;
    const timer = setInterval(() => {
      if ((streaming && !connectionLostRef.current) || attachProbeInFlightRef.current) return;
      attachProbeInFlightRef.current = true;
      void (async () => {
        let attached: AdeCodeConnection | null = null;
        try {
          attached = await connectToAde({
            project,
            forceEmbedded: false,
            requireSocket: true,
            socketPath,
            preferServiceRepair,
            remote: remoteLaunch,
            projectRegistration: INTERACTIVE_PROJECT_REGISTRATION,
          });
          if (attached.mode !== "attached") {
            await attached.close().catch(() => {});
            return;
          }
          const previous = connectionRef.current;
          connectionRef.current = attached;
          connectionPoolRef.current.setLocal({
            connection: attached,
            projectRoot: project.projectRoot,
          });
          for (const entry of connectionPoolRef.current.list()) {
            if (entry.machineKey !== LOCAL_MACHINE_KEY) {
              void connectionPoolRef.current.close(entry.machineKey);
            }
          }
          setActiveMachineKey(LOCAL_MACHINE_KEY);
          setActiveRemoteLabel(remoteLaunch ? project.remoteLabel ?? "remote" : null);
          setActiveProjectRoot(attached.projectRoot || project.projectRoot);
          setConnection(attached);
          setMode(attached.mode);
          if (connectionLostRef.current) {
            connectionLostRef.current = false;
            setConnectionLost(false);
            addNotice("Reconnected to the ADE runtime.", "success");
          }
          await previous?.close().catch(() => {});
          await refreshState();
        } catch {
          await attached?.close().catch(() => {});
        } finally {
          attachProbeInFlightRef.current = false;
        }
      })();
    }, 3_000);
    return () => clearInterval(timer);
  }, [addNotice, connection, connectionLost, forceEmbedded, mode, preferServiceRepair, project, refreshState, remoteLaunch, socketPath, streaming]);

  // First-send draft commit → Chat Info. While a draft new chat is being set
  // up, the right pane shows the new-chat setup surface (model-picker, surface
  // "new-chat"). Once the first send turns the draft into a real session, swap
  // that setup pane for the live Chat Info view — the same content
  // openSubagentsPane builds (the chat-info refresh effect keeps it live, so
  // this is never a stale snapshot). Gated to the setup pane kinds so a pane
  // the user deliberately opened mid-draft (a form, /diff, /help, …) — or a
  // pane they explicitly dismissed — is never hijacked. Marking the pane as
  // user-opened ("chat-info", exactly like ^a/openSubagentsPane) keeps the
  // context resolver from transiently stomping it back to lane-details while
  // the freshly created session (terminal sessions especially) is still in
  // flight to refreshState.
  const showChatInfoAfterDraftCommit = useCallback(() => {
    if (!isNewChatSetupPane(rightPaneRef.current)) return;
    setRightPane({ kind: "chat-info", info: buildChatInfoSnapshotRef.current() });
    setRightSelectionIndex(0);
    setRightOpen(true);
    lastUserOpenedPaneRef.current = "chat-info";
  }, []);

  const ensureActiveSession = useCallback(async (): Promise<string | null> => {
    const conn = connectionRef.current;
    const laneId = activeLaneIdRef.current;
    if (!conn || !laneId) return null;
    const currentSessionId = activeSessionIdRef.current;
    if (currentSessionId) {
      if (sessions.some((entry) => entry.sessionId === currentSessionId)) return currentSessionId;
      selectActiveSessionId(null);
      setAttachedTerminalId(null);
    }
    const lane = lanes.find((entry) => entry.id === laneId) ?? null;
    const unavailableMessage = laneWorktreeUnavailableMessage(lane);
    if (unavailableMessage) {
      if (lane) {
        setRightPane(seedLaneDetails(lane, false));
        setRightOpen(true);
      }
      setDraftChatMode(false);
      addNotice(unavailableMessage, "error");
      return null;
    }
    const normalized = { ...modelState, ...applyProviderPermissionMode(modelState) };
    const runtimeProvider = runtimeProviderForUiProvider(normalized.provider);
    if (runtimeProvider === "cursor") {
      const cursorModel = models.find((entry) => (
        entry.id === normalized.modelId
          || entry.modelId === normalized.modelId
          || entry.id === normalized.model
          || entry.modelId === normalized.model
      )) ?? modelInfoFromDescriptor(normalized.modelId ?? normalized.model);
      if (!cursorModel || !cursorModelAvailableForInterface(cursorModel, normalized.interfaceMode)) {
        addNotice(
          normalized.interfaceMode === "cli"
            ? "This Cursor model is available for chat only. Choose a Cursor CLI model."
            : "This Cursor model is available for CLI only. Switch Interface to CLI or choose a chat model.",
          "error",
        );
        return null;
      }
    }
    const requestedTitle = pendingNewChatTitleRef.current;
    const created = await createChatSession({
      connection: conn,
      laneId,
      title: requestedTitle,
      provider: runtimeProvider,
      modelId: normalized.modelId,
      reasoningEffort: normalized.reasoningEffort,
      fastMode: normalized.fastMode,
      permissionMode: normalized.permissionMode,
      interactionMode: normalized.interactionMode,
      claudePermissionMode: normalized.claudePermissionMode,
      codexApprovalPolicy: normalized.codexApprovalPolicy,
      codexSandbox: normalized.codexSandbox,
      codexConfigSource: normalized.codexConfigSource,
      opencodePermissionMode: normalized.opencodePermissionMode,
      droidPermissionMode: normalized.droidPermissionMode,
      cursorModeId: normalized.cursorModeId,
      cursorConfigValues: normalized.cursorConfigValues,
    });
    pendingNewChatTitleRef.current = null;
    // This project's next new chat defaults to exactly what just launched.
    rememberModelChoice(normalized);
    const optimisticSummary = chatSessionToOptimisticSummary(created, requestedTitle);
    optimisticChatSessionsRef.current.set(created.id, optimisticSummary);
    setSessions((current) => mergeOptimisticChatSessions(current, optimisticChatSessionsRef.current));
    setDraftChatMode(false);
    selectActiveSessionId(created.id);
    showChatInfoAfterDraftCommit();
    await refreshState();
    return created.id;
  }, [addNotice, lanes, modelState, refreshState, rememberModelChoice, selectActiveSessionId, sessions, setDraftChatMode, showChatInfoAfterDraftCommit]);

  const resolvePendingApproval = useCallback(async (
    approval: PendingApproval,
    decision: "accept" | "decline" | "cancel" | "accept_for_session",
    responseText?: string | null,
  ) => {
    const conn = connectionRef.current;
    const sessionId = activeSessionIdRef.current;
    if (!conn || !sessionId) return;
    await approveToolUse({
      connection: conn,
      sessionId,
      itemId: approval.itemId,
      decision,
      responseText,
    });
    addNotice(decision === "accept" || decision === "accept_for_session" ? "Approved request." : "Declined request.", "info");
    await refreshState();
  }, [addNotice, refreshState]);

  const answerPendingInput = useCallback(async (approval: PendingApproval, text: string) => {
    const conn = connectionRef.current;
    const sessionId = activeSessionIdRef.current;
    if (!conn || !sessionId) return;
    const trimmed = text.trim();
    const lowered = trimmed.toLowerCase();
    if (lowered === "deny" || lowered === "decline" || lowered === "cancel") {
      await respondToInput({
        connection: conn,
        sessionId,
        itemId: approval.itemId,
        decision: lowered === "cancel" ? "cancel" : "decline",
      });
      addNotice("Declined request.", "info");
      await refreshState();
      return;
    }
    const builtAnswers = buildPendingInputAnswers(
      approval.request,
      trimmed,
      pendingQuestionStateRef.current?.itemId === approval.itemId ? pendingQuestionStateRef.current : null,
    );
    if (!builtAnswers || pendingQuestionAnsweredCount(approval.request, builtAnswers) === 0) {
      const firstQuestion = approval.request?.questions[0];
      addNotice(
        pendingQuestionAnswerGuidance(approval.request, firstQuestion, 0),
        "info",
      );
      return;
    }
    await respondToInput({
      connection: conn,
      sessionId,
      itemId: approval.itemId,
      decision: "accept",
      // Pass the live selection state so a typed note rides alongside whatever
      // the user had already marked instead of replacing it.
      answers: builtAnswers,
      responseText: trimmed,
    });
    addNotice("Answered request.", "success");
    await refreshState();
  }, [addNotice, refreshState]);

  const submitSelectedPendingQuestion = useCallback(async (
    approval: PendingApproval,
    typedAnswer?: string,
  ): Promise<boolean> => {
    const request = approval.request;
    const questions = request?.questions ?? [];
    if (!request || questions.length === 0) return false;
    const baseState =
      pendingQuestionStateRef.current?.itemId === approval.itemId
        ? pendingQuestionStateRef.current
        : createPendingQuestionSelectionState(approval);
    if (!baseState) return false;
    const activeQuestion = questions[baseState.activeQuestionIndex] ?? questions[0] ?? null;
    if (!activeQuestion) return false;
    // The typed text is folded into the selection rather than replacing it:
    // `1` or an option label still picks, and anything else rides along as the
    // note, selection first. Letting the note replace the pick was the TUI half
    // of the divergence `shared/pendingInputAnswers` now settles.
    const typed = typedAnswer?.trim() ?? "";
    // Enter with nothing typed IS the confirmation of the highlighted row, so
    // that path still sends the highlight even though the highlight alone is
    // not a pick (see `touchedQuestionIds`). Enter with text goes through the
    // shared contract, where an untouched cursor contributes nothing.
    const activeAnswer: string | string[] | null = typed.length
      ? ownQuestionValue(
          buildPendingInputAnswers(request, typed, baseState, baseState.activeQuestionIndex),
          activeQuestion.id,
        ) ?? null
      : pendingQuestionSelectionValue(request, baseState);
    if (activeAnswer == null || (typeof activeAnswer === "string" && activeAnswer.length === 0)) {
      addNotice(
        pendingQuestionAnswerGuidance(request, activeQuestion, baseState.activeQuestionIndex),
        "info",
      );
      return true;
    }
    const answers = Object.fromEntries([
      ...Object.entries(baseState.answers),
      [activeQuestion.id, activeAnswer],
    ]) as Record<string, string | string[]>;
    const answeredCount = pendingQuestionAnsweredCount(request, answers);
    if (answeredCount >= questions.length) {
      const conn = connectionRef.current;
      const sessionId = activeSessionIdRef.current;
      if (!conn || !sessionId) return false;
      await respondToInput({
        connection: conn,
        sessionId,
        itemId: approval.itemId,
        decision: "accept",
        answers,
        responseText: questions.map((question) => {
          const answer = ownQuestionValue(answers, question.id);
          return `${question.header?.trim() || question.id}: ${Array.isArray(answer) ? answer.join(", ") : answer ?? ""}`;
        }).join("\n"),
      });
      // Clear the synchronous ref alongside React state so a fast second
      // Enter/click can't reuse the now-submitted answers before the next render.
      pendingQuestionStateRef.current = null;
      setPendingQuestionState(null);
      addNotice("Answered request.", "success");
      await refreshState();
      return true;
    }
    const nextUnansweredIndex = questions.findIndex((question) => !isStoredQuestionAnswered(
      question,
      ownQuestionValue(answers, question.id),
    ));
    const nextState = {
      ...baseState,
      answers,
      activeQuestionIndex: nextUnansweredIndex >= 0 ? nextUnansweredIndex : baseState.activeQuestionIndex,
    };
    pendingQuestionStateRef.current = nextState;
    setPendingQuestionState(nextState);
    return true;
  }, [addNotice, refreshState]);

  const refreshTerminalPreview = useCallback(async (
    conn: AdeCodeConnection,
    terminalId: string,
  ): Promise<ChatTerminalPreviewResult | null> => {
    try {
      const preview = await previewTerminal(conn, terminalId);
      if (activeSessionIdRef.current === terminalId) {
        setTerminalPreview((previous) => sameTerminalPreviewFrame(previous, preview) ? previous : preview);
      }
      return preview;
    } catch {
      if (activeSessionIdRef.current === terminalId) {
        setTerminalPreview((previous) => previous === null ? previous : null);
      }
      return null;
    }
  }, []);

  const applyLocalModelArg = useCallback((value: string, providerOverride?: AdeCodeProvider) => {
    const provider = providerOverride ?? modelStateRef.current.provider;
    const availableModels = providerModelsCacheRef.current.get(
      providerModelsCacheKey(provider, modelStateRef.current.interfaceMode),
    ) ?? models;
    const patch = modelStatePatchForArg(provider, availableModels, value);
    const next = { ...modelStateRef.current, ...patch };
    modelStateRef.current = next;
    setModelState(next);
    return next;
  }, [models]);

  // Make a just-created / just-resumed Claude terminal immediately visible to the
  // session list and to refreshState's target resolver, so selecting it sticks
  // instead of getting clobbered back to the newest existing chat while the
  // runtime's `terminal.list` catches up. Mirrors the optimistic-chat path.
  const registerOptimisticTerminalSession = useCallback((args: {
    sessionId: string;
    laneId: string;
    title?: string | null;
    session?: ChatTerminalSession | null;
    /** Provider of the tracked CLI, so the optimistic fallback row derives correctly. */
    provider?: CliTerminalProvider;
  }) => {
    const lane = lanesById[args.laneId] ?? null;
    const provider = args.provider ?? "claude";
    const optimistic: ChatTerminalSession = args.session
      ? { ...args.session, terminalId: args.sessionId }
      : {
        terminalId: args.sessionId,
        ptyId: null,
        chatSessionId: null,
        laneId: args.laneId,
        laneName: lane?.name ?? args.laneId,
        title: args.title?.trim() || LAUNCH_PROFILE_TITLE[provider],
        // Drives terminalSessionProvider until terminal.list backfills the row.
        toolType: LAUNCH_PROFILE_TOOL_TYPE[provider],
        goal: null,
        status: "running",
        runtimeState: "running",
        active: true,
        startedAt: new Date().toISOString(),
        endedAt: null,
        exitCode: null,
        pid: null,
        resumeCommand: null,
        resumeMetadata: null,
        lastOutputPreview: null,
        summary: null,
      };
    optimisticTerminalSessionsRef.current.set(optimistic.terminalId, optimistic);
    setTerminalSessions((current) => mergeOptimisticTerminalSessions(current, optimisticTerminalSessionsRef.current));
  }, [lanesById]);

  const loadExternalSessionsForLane = useCallback(async (laneId: string) => {
    const conn = connectionRef.current;
    const generation = externalSessionListGenerationRef.current + 1;
    externalSessionListGenerationRef.current = generation;
    setRightPane((prev) => prev.kind === "external-session-browser" && prev.laneId === laneId
      ? {
          ...prev,
          loading: true,
          error: null,
          importError: null,
        }
      : prev);
    if (!conn) {
      setRightPane((prev) => prev.kind === "external-session-browser" && prev.laneId === laneId
        ? {
            ...prev,
            loading: false,
            error: "Runtime unavailable.",
          }
        : prev);
      return;
    }
    try {
      const result = await conn.action<unknown>("external-sessions", "list", {
        scope: "project",
        laneId,
      });
      const sessions = normalizeExternalSessionListResult(result);
      if (externalSessionListGenerationRef.current !== generation) return;
      setRightPane((prev) => {
        if (prev.kind !== "external-session-browser" || prev.laneId !== laneId) return prev;
        return clampExternalSessionBrowserContent({
          ...prev,
          sessions,
          loading: false,
          error: null,
          importError: null,
          loadedAt: Date.now(),
        });
      });
    } catch (err) {
      if (externalSessionListGenerationRef.current !== generation) return;
      const message = err instanceof Error ? err.message : String(err);
      setRightPane((prev) => prev.kind === "external-session-browser" && prev.laneId === laneId
        ? {
            ...prev,
            loading: false,
            error: message,
          }
        : prev);
    }
  }, []);

  /**
   * `/import` — the single home for pulling an external CLI session into ADE.
   * Only meaningful while a NEW chat is being started (the import lands as that
   * chat), so the caller gates on the draft; here we only need the lane.
   */
  const openExternalSessionBrowser = useCallback(() => {
    const currentPane = rightPaneRef.current;
    const paneLaneId = (currentPane.kind === "model-picker" || currentPane.kind === "model-wizard")
      && currentPane.surface === "new-chat"
      ? currentPane.laneId ?? null
      : null;
    const laneId = paneLaneId ?? drawerLaneIdRef.current ?? activeLaneIdRef.current;
    const lane = laneId ? lanesById[laneId] ?? null : null;
    if (!laneId || !lane) {
      addNotice("Select a lane first — imports need a lane folder.", "info");
      return;
    }
    if (unavailableLaneIds.has(laneId)) {
      addNotice("That lane folder is unavailable.", "error");
      return;
    }
    setRightPane({
      kind: "external-session-browser",
      laneId,
      laneLabel: lane.name,
      providerFilter: "all",
      query: "",
      sessions: [],
      loading: true,
      error: null,
      importError: null,
      importingKey: null,
      selectedIndex: 0,
      actionIndex: 0,
      loadedAt: null,
    });
    setRightPaneScrollOffsetRows(0);
    setRightOpen(true);
    setPaneFocus("details");
    lastUserOpenedPaneRef.current = "external-session-browser";
    userDismissedRightPaneRef.current = false;
    void loadExternalSessionsForLane(laneId);
  }, [addNotice, lanesById, loadExternalSessionsForLane, setPaneFocus, unavailableLaneIds]);

  const showWorkSession = useCallback((laneId: string, sessionId: string) => {
    pendingNewChatTitleRef.current = null;
    setDraftChatMode(false);
    setGridView(false);
    setAttachedTerminalId(null);
    setSelectedDrawerLaneId(laneId);
    setDrawerLaneId(laneId);
    setSelectedWorkChatAction(null);
    selectActiveLaneId(laneId);
    setSelectedDrawerChatId(sessionId);
    setWorkSelectedKey(`session:${sessionId}`);
    selectActiveSessionId(sessionId);
    lastUserOpenedPaneRef.current = null;
    userDismissedRightPaneRef.current = false;
    setRightOpen(true);
    setRightPane({ kind: "empty" });
    focusChat();
  }, [focusChat, selectActiveLaneId, selectActiveSessionId, setDraftChatMode, setGridView]);

  const adoptImportedExternalSession = useCallback(async (
    summary: ExternalSessionSummary,
    result: ExternalSessionImportResult,
  ) => {
    const laneId = result.laneId;

    if (result.kind === "cli") {
      registerOptimisticTerminalSession({
        sessionId: result.sessionId,
        laneId,
        title: summary.title?.trim() || summary.preview?.trim() || null,
        session: normalizeChatTerminalSession(result.session ?? null),
        provider: summary.provider as CliTerminalProvider,
      });
      showWorkSession(laneId, result.sessionId);
      addNotice(`Imported ${externalSessionProviderLabel(summary.provider)} CLI session.`, "success");
    } else {
      optimisticChatSessionsRef.current.set(result.chatSessionId, result.chatSummary);
      setSessions((current) => mergeOptimisticChatSessions(current, optimisticChatSessionsRef.current));
      showWorkSession(laneId, result.chatSessionId);
      addNotice(`Imported ${externalSessionProviderLabel(summary.provider)} as ADE chat.`, "success");
    }

    await refreshState();
  }, [
    addNotice,
    refreshState,
    registerOptimisticTerminalSession,
    showWorkSession,
  ]);

  const openExistingExternalSession = useCallback(async (
    summary: ExternalSessionSummary,
    laneId: string,
  ) => {
    const ref = summary.importedSessionRef;
    if (!summary.alreadyImported || !ref?.sessionId) {
      setRightPane((prev) => prev.kind === "external-session-browser"
        ? { ...prev, importError: "This session does not have a valid ADE import reference." }
        : prev);
      return;
    }
    try {
      await refreshState();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setRightPane((prev) => prev.kind === "external-session-browser"
        ? { ...prev, importError: `Unable to refresh ADE sessions: ${message}` }
        : prev);
      return;
    }
    const existing = ref.kind === "chat"
      ? sessionsRef.current.find((session) => session.sessionId === ref.sessionId)
      : terminalSessionsRef.current.find((session) => session.terminalId === ref.sessionId);
    if (!existing) {
      setRightPane((prev) => prev.kind === "external-session-browser"
        ? { ...prev, importError: "The linked ADE session no longer exists. Refresh the list to clear this stale reference." }
        : prev);
      return;
    }
    showWorkSession(existing.laneId || laneId, ref.sessionId);
  }, [refreshState, showWorkSession]);

  const importExternalSessionFromBrowser = useCallback(async (
    summary: ExternalSessionSummary,
    affordance: ImportAffordance,
  ) => {
    if (externalSessionImportInFlightRef.current) return;
    const pane = rightPaneRef.current;
    if (pane.kind !== "external-session-browser") return;
    if (!affordance.enabled) {
      const message = affordance.disabledReason ?? "This action is not available for that session.";
      setRightPane((prev) => prev.kind === "external-session-browser"
        ? { ...prev, importError: message }
        : prev);
      return;
    }
    const conn = connectionRef.current;
    if (!conn) {
      setRightPane((prev) => prev.kind === "external-session-browser"
        ? { ...prev, importError: "Runtime unavailable." }
        : prev);
      return;
    }
    const importingKey = externalSessionActionKey(summary, affordance);
    externalSessionImportInFlightRef.current = true;
    setRightPane((prev) => prev.kind === "external-session-browser"
      ? { ...prev, importError: null, importingKey }
      : prev);
    try {
      const result = await conn.action<ExternalSessionImportResult>("external-sessions", "import", {
        provider: summary.provider,
        sessionId: summary.id,
        laneId: pane.laneId,
        target: affordance.target,
        mode: affordance.mode,
      });
      externalSessionListGenerationRef.current += 1;
      await adoptImportedExternalSession(summary, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setRightPane((prev) => prev.kind === "external-session-browser"
        ? {
            ...prev,
            importError: message,
            importingKey: prev.importingKey === importingKey ? null : prev.importingKey,
          }
        : prev);
    } finally {
      externalSessionImportInFlightRef.current = false;
    }
  }, [adoptImportedExternalSession]);

  const submitClaudePromptToTerminal = useCallback(async (terminal: ChatTerminalSession, text: string) => {
    const conn = connectionRef.current;
    const trimmed = text.trim();
    if (!conn || !trimmed) return false;
    const run = async (): Promise<boolean> => {
      lastLocalSendAtRef.current = Date.now();
      const cols = clampTerminalPaneCols(terminalPaneWidth);
      const terminalRows = claudeTerminalRowsForPane(chatRowBudget);
      if (terminal.status === "running") {
        if (terminalSessionProvider(terminal) === "claude") {
          await writeTerminal(conn, terminal.terminalId, encodeTerminalPromptSubmit(text));
          // Claude Code occasionally leaves a programmatic `text + Enter` sitting
          // in its prompt editor. New/resumed launches already send a delayed
          // confirm Enter; do the same for live embedded sessions so submitting
          // from ADE behaves like manually focusing Claude with Ctrl+T and
          // pressing Enter.
          await delay(CLAUDE_TERMINAL_SUBMIT_CONFIRM_DELAY_MS);
          await writeTerminal(conn, terminal.terminalId, encodeTerminalPromptSubmitConfirm());
          await delay(CLAUDE_TERMINAL_SUBMIT_REFRESH_DELAY_MS);
          await refreshTerminalPreview(conn, terminal.terminalId);
          return true;
        }
        // Other providers: ptyService.sendToSession owns provider-specific live
        // input delivery + submit timing (Codex/Cursor paste delays, Cursor
        // input-ready wait), so no Claude-style double-enter here.
        await sendToTerminalSession({
          connection: conn,
          sessionId: terminal.terminalId,
          text,
          cols,
          rows: terminalRows,
          ...buildPtyContinuationLaunchFields(terminal.resumeMetadata?.launch),
        });
        await refreshTerminalPreview(conn, terminal.terminalId);
        return true;
      }
      const created = await sendToTerminalSession({
        connection: conn,
        sessionId: terminal.terminalId,
        text,
        cols,
        rows: terminalRows,
        ...buildPtyContinuationLaunchFields(terminal.resumeMetadata?.launch),
      });
      pendingNewChatTitleRef.current = null;
      setDraftChatMode(false);
      activeTerminalSessionRef.current = normalizeChatTerminalSession(created.session);
      registerOptimisticTerminalSession({
        sessionId: created.sessionId,
        laneId: terminal.laneId,
        title: terminal.title,
        session: normalizeChatTerminalSession(created.session),
      });
      selectActiveSessionId(created.sessionId);
      showChatInfoAfterDraftCommit();
      await refreshState();
      return true;
    };
    const queued = claudeTerminalSubmitQueueRef.current
      .catch(() => undefined)
      .then(run);
    claudeTerminalSubmitQueueRef.current = queued;
    return await queued;
  }, [addNotice, chatRowBudget, refreshState, refreshTerminalPreview, registerOptimisticTerminalSession, selectActiveSessionId, setDraftChatMode, showChatInfoAfterDraftCommit, terminalPaneWidth]);

  const resumeClosedTerminalSession = useCallback(async (terminal: ChatTerminalSession): Promise<boolean> => {
    const conn = connectionRef.current;
    if (!conn || !isTerminalSessionResumable(terminal)) return false;
    lastLocalSendAtRef.current = Date.now();
    const cols = clampTerminalPaneCols(terminalPaneWidth);
    const terminalRows = claudeTerminalRowsForPane(chatRowBudget);
    const resumed = await resumeTerminalSession({
      connection: conn,
      sessionId: terminal.terminalId,
      cols,
      rows: terminalRows,
      ...buildPtyContinuationLaunchFields(terminal.resumeMetadata?.launch),
    });
    pendingNewChatTitleRef.current = null;
    setDraftChatMode(false);
    activeTerminalSessionRef.current = normalizeChatTerminalSession(resumed.session);
    registerOptimisticTerminalSession({
      sessionId: resumed.sessionId,
      laneId: terminal.laneId,
      title: terminal.title,
      session: normalizeChatTerminalSession(resumed.session),
    });
    selectActiveSessionId(resumed.sessionId);
    showChatInfoAfterDraftCommit();
    await refreshState();
    return true;
  }, [chatRowBudget, refreshState, registerOptimisticTerminalSession, selectActiveSessionId, setDraftChatMode, showChatInfoAfterDraftCommit, terminalPaneWidth]);

  const startCliTerminalForPrompt = useCallback(async (text: string): Promise<string | null> => {
    const conn = connectionRef.current;
    const laneId = activeLaneIdRef.current;
    if (!conn || !laneId) return null;
    const provider = cliProviderForModelStateProvider(modelStateRef.current.provider);
    if (!provider) {
      addNotice(`${providerLabel(modelStateRef.current.provider)} has no CLI session — switch the interface to Chat.`, "error");
      return null;
    }
    const lane = lanes.find((entry) => entry.id === laneId) ?? null;
    const unavailableMessage = laneWorktreeUnavailableMessage(lane);
    if (unavailableMessage) {
      if (lane) {
        setRightPane(seedLaneDetails(lane, false));
        setRightOpen(true);
      }
      setDraftChatMode(false);
      addNotice(unavailableMessage, "error");
      return null;
    }
    const normalized = { ...modelStateRef.current, ...applyProviderPermissionMode(modelStateRef.current) };
    const launchModel = provider === "cursor"
      ? resolveCursorCliModelForLaunch(
          normalized,
          providerModelsCacheRef.current.get(providerModelsCacheKey("cursor", "cli")) ?? models,
        )
      : normalized.modelId ?? normalized.model;
    const cols = clampTerminalPaneCols(terminalPaneWidth);
    const terminalRows = claudeTerminalRowsForPane(chatRowBudget);
    const activeProviderChat = activeSessionRef.current?.provider === provider ? activeSessionRef.current : null;
    const title = pendingNewChatTitleRef.current
      ?? activeProviderChat?.title
      ?? LAUNCH_PROFILE_TITLE[provider];
    const created = await startCliTerminalSession({
      connection: conn,
      provider,
      laneId,
      title,
      model: launchModel,
      reasoningEffort: normalized.reasoningEffort,
      fastMode: normalized.fastMode,
      permissionMode: normalized.permissionMode,
      initialInput: text.trim() ? text : null,
      cols,
      rows: terminalRows,
    });
    pendingNewChatTitleRef.current = null;
    setDraftChatMode(false);
    if (created.session) activeTerminalSessionRef.current = created.session;
    registerOptimisticTerminalSession({
      sessionId: created.sessionId,
      laneId,
      title,
      session: created.session,
      provider,
    });
    if (provider === "claude" && !claudeAutoNamingHintShownRef.current) {
      claudeAutoNamingHintShownRef.current = true;
      addNotice("Claude sessions auto-name in the background when enabled — toggle in ADE desktop → Settings → AI Features.", "info");
    }
    selectActiveSessionId(created.sessionId);
    showChatInfoAfterDraftCommit();
    await refreshState();
    return created.sessionId;
  }, [addNotice, chatRowBudget, lanes, models, refreshState, registerOptimisticTerminalSession, selectActiveSessionId, setDraftChatMode, showChatInfoAfterDraftCommit, terminalPaneWidth]);

  const sendClaudeModelCommandToTerminal = useCallback(async (modelRef?: string | null): Promise<boolean> => {
    const terminal = activeTerminalSessionRef.current;
    if (!terminal || modelStateRef.current.provider !== "claude") return false;
    const resolved = resolveClaudeCliModelForLaunch(modelRef ?? modelStateRef.current.modelId ?? modelStateRef.current.model);
    const reasoningEffort = modelStateRef.current.reasoningEffort?.trim() || null;
    if (!resolved && !reasoningEffort) {
      addNotice("No Claude model is selected.", "error");
      return false;
    }
    let sent = false;
    if (resolved) {
      sent = await submitClaudePromptToTerminal(terminal, `/model ${resolved}`) || sent;
    }
    if (reasoningEffort) {
      sent = await submitClaudePromptToTerminal(terminal, `/effort ${reasoningEffort}`) || sent;
    }
    if (sent) {
      const details = [resolved, reasoningEffort ? `effort ${reasoningEffort}` : null].filter(Boolean).join(" · ");
      addNotice(`Claude Code model settings sent: ${details}.`, "success");
    }
    return sent;
  }, [addNotice, submitClaudePromptToTerminal]);

  const requestAppExit = useCallback(() => {
    if (exitRequestedRef.current) return;
    exitRequestedRef.current = true;
    restoreTerminalInteractiveModes();
    signalActiveTerminalForExitSync();
    void signalActiveTerminalForExit()
      .finally(() => exit());
  }, [exit, signalActiveTerminalForExit, signalActiveTerminalForExitSync]);

  const requestCtrlCExit = useCallback(() => {
    const now = Date.now();
    if (now <= ctrlCExitArmedUntilRef.current) {
      ctrlCExitArmedUntilRef.current = 0;
      if (ctrlCExitTimerRef.current) {
        clearTimeout(ctrlCExitTimerRef.current);
        ctrlCExitTimerRef.current = null;
      }
      requestAppExit();
      return;
    }
    ctrlCExitArmedUntilRef.current = now + CTRL_C_EXIT_ARM_MS;
    if (ctrlCExitTimerRef.current) clearTimeout(ctrlCExitTimerRef.current);
    ctrlCExitTimerRef.current = setTimeout(() => {
      ctrlCExitArmedUntilRef.current = 0;
      ctrlCExitTimerRef.current = null;
    }, CTRL_C_EXIT_ARM_MS);
    addNotice("Press Ctrl+C again to exit ADE Code.", "info");
  }, [addNotice, requestAppExit]);

  const copyChatSelection = useCallback((selection?: ChatTextSelection | null): boolean => {
    const resolvedSelection = selection ?? chatMouseSelectionRef.current;
    if (!isChatTextSelectionRange(resolvedSelection)) {
      const drawerCopyText = workListSelectionCopyText(
        workListModelRef.current.rows,
        workSelectedKeyRef.current,
      );
      if (!drawerCopyText) {
        addNotice("No chat text selected.", "info");
        return false;
      }
      if (!writeClipboardText(drawerCopyText)) {
        addNotice("Could not find a clipboard command for this terminal.", "error");
        return true;
      }
      addNotice("Copied selected chat text.", "success");
      return true;
    }
    const text = selectedTextFromChatRows(selectableChatRowTextBuilderRef.current(), resolvedSelection);
    if (text.length === 0) {
      addNotice("No chat text selected.", "info");
      return false;
    }
    if (!writeClipboardText(text)) {
      addNotice("Could not find a clipboard command for this terminal.", "error");
      return true;
    }
    addNotice("Copied selected chat text.", "success");
    return true;
  }, [addNotice]);

  const copyProjectSecret = useCallback(async (name: string): Promise<void> => {
    const conn = connectionRef.current;
    if (!conn) {
      addNotice("ADE runtime is still connecting.", "error");
      return;
    }
    const secret = await conn.action<ProjectSecretValueResult>("project_secret", "get", { name });
    if (!writeClipboardText(secret.value)) {
      addNotice("Could not find a clipboard command for this terminal.", "error");
      return;
    }
    addNotice(`Copied ${secret.name}`, "success");
  }, [addNotice]);

  const openSecretsPane = useCallback(async (): Promise<void> => {
    const conn = connectionRef.current;
    if (!conn) {
      setRightPane({
        kind: "details",
        title: "Secrets",
        body: "ADE runtime is still connecting. Try again when the connection is ready.",
      });
      return;
    }
    setRightPane({ kind: "list", title: "Secrets", rows: [], emptyText: "Loading secrets…" });
    const result = await conn.action<ProjectSecretsListResult>("project_secret", "list", {});
    const secrets = [...(result.secrets ?? [])].sort((left, right) => left.name.localeCompare(right.name));
    setRightSelectionIndex(0);
    setRightPane({
      kind: "list",
      title: "Secrets",
      rows: secrets.map((secret) => `${secret.name} · •••• · ${secret.valueLength} chars`),
      emptyText: "No secrets saved.",
      action: { kind: "copy-secret", ids: secrets.map((secret) => secret.name) },
    });
  }, []);

  const openChatsListPane = useCallback((rawQuery: string, closedExpanded = rightChatsClosedExpanded): void => {
    const laneId = activeLaneIdRef.current;
    const query = rawQuery.trim().toLowerCase();
    rightChatsQueryRef.current = rawQuery;
    if (!laneId) {
      setRightPane({ kind: "details", title: "Chats", body: "No active lane is selected." });
      return;
    }
    const matchesQuery = (session: AgentChatSessionSummary): boolean => !query
      || session.sessionId.toLowerCase().includes(query)
      || (session.title ?? "").toLowerCase().includes(query)
      || (session.goal ?? "").toLowerCase().includes(query)
      || session.provider.toLowerCase().includes(query);
    const openMatches = openDrawerSessions
      .filter((session) => session.laneId === laneId)
      .filter(matchesQuery);
    const closedMatches = closedCliSessions
      .filter((session) => session.laneId === laneId)
      .filter(matchesQuery);
    const rows = openMatches.map((session) => openChatRightPaneRow(session, activeSessionIdRef.current));
    const ids = openMatches.map((session) => session.sessionId);
    if (closedMatches.length > 0) {
      rows.push(`${closedExpanded ? "▾" : "▸"} closed (${closedMatches.length})`);
      ids.push(RIGHT_CHAT_CLOSED_TOGGLE_ID);
      if (closedExpanded) {
        rows.push(...closedMatches.map((session) => closedCliRightPaneRow(session, activeSessionIdRef.current)));
        ids.push(...closedMatches.map((session) => session.sessionId));
      }
    }
    const activeId = activeSessionIdRef.current;
    const activeIndex = activeId ? ids.indexOf(activeId) : -1;
    const selectedIndex = activeIndex >= 0 ? activeIndex : 0;
    setRightSelectionIndex(selectedIndex);
    setRightPane({
      kind: "list",
      title: query ? `Chats · ${rawQuery.trim()}` : "Chats",
      rows,
      emptyText: query ? "No chats matched this filter." : "No chats in this lane.",
      action: { kind: "chat-list", ids },
    });
  }, [closedCliSessions, openDrawerSessions, rightChatsClosedExpanded]);

  /**
   * Send the snooze. The deadline is already resolved by the caller — this only
   * writes it and refreshes. No timer is armed: expiry is derived everywhere by
   * comparing `snoozedUntil` to now.
   */
  const applySessionSnooze = useCallback(async (
    sessionId: string,
    untilIso: string,
    confirmation: string,
  ): Promise<void> => {
    const conn = connectionRef.current;
    if (!conn) {
      addNotice("ADE runtime is still connecting. Try again when the connection is ready.", "error");
      return;
    }
    try {
      await snoozeSession(conn, sessionId, untilIso);
      addNotice(confirmation, "success");
      await refreshState();
    } catch (err) {
      addNotice(err instanceof Error ? err.message : String(err), "error");
    }
  }, [addNotice, refreshState]);

  /**
   * Duration entry for `/session snooze` with no duration given. Uses the same
   * right-pane list + arrow/enter selection every other TUI chooser uses
   * (`/switch`, `/secrets`, `/chats`), with the shared presets in the shared
   * order; free text stays available by typing the duration on the command line
   * instead.
   *
   * Resolved on every open, never hoisted: the shared resolver suppresses
   * time-of-day presets that have gone stale, and a long-lived `ade code`
   * session must see that decision made against NOW, not against launch time.
   */
  const openSnoozeDurationPalette = useCallback((sessionId: string, sessionLabel: string): void => {
    pendingSnoozeSessionIdRef.current = sessionId;
    setRightSelectionIndex(0);
    const choices = resolveSnoozeChoices();
    setRightPane({
      kind: "list",
      title: `Snooze · ${sessionLabel}`,
      rows: [
        ...choices.map((choice) => `${choice.label} · ${choice.whenLabel}`),
        "",
        "Free text: /session snooze [id] 45m · 1.5h · 2d",
      ],
      action: { kind: "snooze-duration", ids: [...choices.map((choice) => choice.key), "", ""] },
    });
  }, []);

  const toggleRightChatsClosedGroup = useCallback(() => {
    const next = !rightChatsClosedExpanded;
    setRightChatsClosedExpanded(next);
    openChatsListPane(rightChatsQueryRef.current, next);
  }, [openChatsListPane, rightChatsClosedExpanded]);

  const pluginPaneContent = useCallback((
    state: PluginPaneInput,
    extra: { error?: string | null } = {},
  ): Extract<RightPaneContent, { kind: "plugin-panel" }> => {
    const model = buildPluginPaneModel(state);
    return {
      kind: "plugin-panel",
      // The model reconciles the reader's `segmented` selections against the
      // controls the schema actually declares, so the inputs take its answer
      // back: one place decides what the panel state is, and the next rebuild
      // starts from that rather than from a value the schema has since dropped.
      state: {
        ...state,
        state: model.state,
        stateSignature: model.stateSignature,
        // The selection is reconciled by the same rule and taken back the same
        // way, so a tick and a filter cannot end up disagreeing about which
        // rebuild they belong to. `openGroups` rides along because it is the
        // model that resolved each group's `defaultOpen` into an answer.
        selection: model.selection,
        selectionSignature: model.selectionSignature,
        openGroups: model.openGroups,
      },
      model,
      ...extra,
    };
  }, []);

  /**
   * Change the open panel's inputs and redraw. Model and inputs are rebuilt
   * together through this one path, which is why they cannot drift.
   */
  const updatePluginPaneState = useCallback((
    mutate: (state: PluginPaneInput) => PluginPaneInput,
  ) => {
    setRightPane((current) => (
      current.kind === "plugin-panel"
        ? pluginPaneContent(mutate(current.state), { error: null })
        : current
    ));
  }, [pluginPaneContent]);

  /**
   * Fetch a panel and the collections it binds, then draw it.
   *
   * Polls on the activity pane's 10s cadence rather than subscribing: the
   * daemon's plugin deltas are a Wave C sync-side protocol, and a poll on an
   * open pane is the precedent this client already uses for live data. Any
   * form values the user has typed survive a refresh, so a poll landing
   * mid-edit cannot wipe the field they are in.
   */
  const loadPluginPane = useCallback(async (
    target: {
      pluginId: string;
      displayName: string;
      panelId: string;
      context?: Record<string, unknown> | null;
    },
    options: { announce?: boolean; open?: boolean } = {},
  ): Promise<void> => {
    const conn = connectionRef.current;
    if (!conn) return;
    const context = target.context ?? null;
    const fetched = await readPluginPanel(conn, target.pluginId, target.panelId);
    const collections: PluginPaneCollectionMap = new Map();
    if (fetched.state === "ok") {
      // Sequential on purpose: a panel binds a handful of collections at most
      // and they share one socket, so a burst of parallel reads buys nothing
      // and makes a slow plugin harder to read in the logs.
      for (const binding of distinctBindings(fetched.record.schema)) {
        collections.set(
          bindingKey(binding),
          await pluginPaneBindingRows(
            binding,
            context,
            () => readPluginCollection(conn, target.pluginId, binding),
          ),
        );
      }
    }
    setRightPane((current) => {
      const samePanel = current.kind === "plugin-panel"
        && current.state.pluginId === target.pluginId
        && current.state.panelId === target.panelId;
      return pluginPaneContent({
        pluginId: target.pluginId,
        displayName: target.displayName,
        panelId: target.panelId,
        fetch: fetched,
        collections,
        context,
        values: samePanel ? current.state.values : {},
        // A filter the reader set survives the 10s poll: the plugin republishes
        // the whole panel whenever its rows change, and a selection that reset
        // every ten seconds would be unusable. A different panel starts fresh.
        ...(samePanel && current.state.state !== undefined ? { state: current.state.state } : {}),
        ...(samePanel && current.state.stateSignature !== undefined
          ? { stateSignature: current.state.stateSignature }
          : {}),
        // And the ticks, for the same reason: a plugin republishing its rows
        // every ten seconds would otherwise empty a batch the reader is still
        // assembling. Folded sections survive the poll too — a section that
        // re-opened itself every ten seconds is a section nobody can close.
        ...(samePanel && current.state.selection !== undefined
          ? { selection: current.state.selection }
          : {}),
        ...(samePanel && current.state.selectionSignature !== undefined
          ? { selectionSignature: current.state.selectionSignature }
          : {}),
        ...(samePanel && current.state.openGroups !== undefined
          ? { openGroups: current.state.openGroups }
          : {}),
        // And the pages. A reader who walked a list down to 1000 rows must not
        // be put back on the first hundred every ten seconds.
        ...(samePanel && current.state.listPages !== undefined
          ? { listPages: current.state.listPages }
          : {}),
        editing: samePanel ? current.state.editing ?? null : null,
        width: prospectiveRightPaneWidth,
      });
    });
    // Only an explicit open raises the pane. A poll that reopened a pane the
    // user had closed would fight them every ten seconds.
    if (options.open) setRightOpen(true);
    if (options.announce) addNotice(`${target.displayName} refreshed.`, "info");
  }, [addNotice, pluginPaneContent, prospectiveRightPaneWidth]);

  /**
   * The `{openUrl}` verb, in a terminal.
   *
   * The TUI hands the URL to the same external opener a PR link uses, which has
   * a Windows path. When there is no opener — a bare Linux box, a remote shell —
   * the URL is printed instead, because a link the reader can copy is the honest
   * degradation and a button that silently did nothing is not.
   *
   * `https:` only. The refusal is a notice rather than silence, for the same
   * reason a malformed composer edit is.
   */
  const applyPluginOpenUrl = useCallback((result: unknown, label: string): void => {
    if (!hasPluginActionOpenUrlRequest(result)) return;
    const request = readPluginActionOpenUrl(result);
    if (!request) {
      addNotice(`${label} sent a link that is not an https URL.`, "info");
      return;
    }
    if (!openExternalUrl(request.url, addNotice)) addNotice(request.url, "info");
  }, [addNotice]);

  /**
   * The `{prompt}` verb: ask the one question, then run the action again.
   *
   * Returns true when the question is now on screen, which is the caller's
   * signal to stop — the action has not finished, so its other verbs (a
   * navigate, an openUrl) belong to the result of the re-invocation rather than
   * to the request for an answer. Everything else about the round trip is the
   * caller's own `follow`, so the second half lands where the first would have.
   */
  const askPluginPrompt = useCallback((options: {
    result: unknown;
    pluginId: string;
    displayName: string;
    actionId: string;
    args: Record<string, unknown>;
    label: string;
    follow: (result: unknown) => void | Promise<void>;
  }): boolean => {
    const outcome = pluginPromptOutcome(options);
    if (outcome.kind === "none") return false;
    // ONE HOP. A re-invocation's own question is dropped rather than re-asked,
    // so a plugin cannot build a wizard — or a loop — out of this verb. Said
    // out loud, because a plugin author whose second question never appears has
    // nothing else to read.
    if (outcome.kind === "ignored") {
      addNotice(`${options.label} asked a second question. Only the first one is shown.`, "info");
      return false;
    }
    if (outcome.kind === "unreadable") {
      addNotice(`${options.label} asked a question this client could not read.`, "info");
      return false;
    }
    stashActiveInput();
    const session = { request: outcome.request, restore: promptRef.current, follow: options.follow };
    pluginPromptRef.current = session;
    setPluginPrompt(session);
    setPromptValue("");
    return true;
  }, [addNotice, setPromptValue, stashActiveInput]);

  /** Esc: the question closes and NOTHING is invoked. */
  const cancelPluginPrompt = useCallback((): void => {
    const session = pluginPromptRef.current;
    if (!session) return;
    pluginPromptRef.current = null;
    setPluginPrompt(null);
    setPromptValue(session.restore);
    addNotice(`${session.request.label} · question dismissed.`, "info");
  }, [addNotice, setPromptValue]);

  /**
   * Enter: re-invoke the SAME action with the same arguments plus the answer.
   *
   * An over-ceiling answer is refused rather than cut down — the field stays
   * open with the reader's words still in it, because a note saved in half is
   * worse than one they were asked to shorten.
   */
  const submitPluginPrompt = useCallback(async (): Promise<void> => {
    const session = pluginPromptRef.current;
    if (!session) return;
    const resolved = pluginPromptResolveChoice(session.request, promptRef.current);
    if (resolved === null) {
      addNotice(pluginPromptUnknownChoiceNotice(session.request), "error");
      return;
    }
    const args = pluginPromptAnswerArgs(session.request, resolved);
    if (!args) {
      addNotice(pluginPromptTooLongNotice(session.request), "error");
      return;
    }
    const conn = connectionRef.current;
    if (!conn) {
      addNotice("ADE runtime is still connecting.", "error");
      return;
    }
    pluginPromptRef.current = null;
    setPluginPrompt(null);
    setPromptValue(session.restore);
    const { request, follow } = session;
    try {
      const result = await invokePluginAction(conn, request.pluginId, request.actionId, args);
      addNotice(`${request.label} ran.`, "success");
      // Through the same gate as the first invocation, deliberately: `args` now
      // carries the answer, so a second `{prompt}` comes back `ignored` here
      // rather than being dropped by a rule written twice.
      if (askPluginPrompt({
        result,
        pluginId: request.pluginId,
        displayName: request.displayName,
        actionId: request.actionId,
        args,
        label: request.label,
        follow,
      })) return;
      await follow(result);
    } catch (error) {
      addNotice(error instanceof Error ? error.message : String(error), "error");
    }
  }, [addNotice, askPluginPrompt, setPromptValue]);

  const refreshPluginPane = useCallback(async (options: { announce?: boolean; runDeclared?: boolean } = {}): Promise<void> => {
    const current = rightPaneRef.current;
    if (current.kind !== "plugin-panel") return;
    // A panel whose manifest declared a refresh action gets it dispatched
    // BEFORE the refetch, so `r` means "go and get new data" rather than "read
    // the same rows again". Only the explicit key press does this: the 10s poll
    // must stay a read, or a plugin polling an API would be driven by a timer
    // nobody asked for.
    const declared = options.runDeclared ? current.model.refreshAction : null;
    const conn = connectionRef.current;
    if (declared && conn) {
      try {
        const statePayload = pluginPaneStatePayload(current.model.state);
        const args: Record<string, unknown> = {
          ...(current.state.context ? { context: current.state.context } : {}),
          // The filter the reader is looking at, so a declared refresh can fetch
          // the filtered set rather than everything and let the client throw
          // most of it away.
          ...(statePayload ? { state: statePayload } : {}),
        };
        const result = await invokePluginAction(conn, current.state.pluginId, declared, args);
        const follow = (value: unknown): void => applyPluginOpenUrl(value, current.state.displayName);
        // A declared refresh may ask before it fetches ("which sprint?"). The
        // panel still reloads below either way — the question is about what the
        // NEXT refresh returns, not about whether this pane may redraw.
        if (!askPluginPrompt({
          result,
          pluginId: current.state.pluginId,
          displayName: current.state.displayName,
          actionId: declared,
          args,
          label: current.state.displayName,
          follow,
        })) follow(result);
      } catch (error) {
        addNotice(error instanceof Error ? error.message : String(error), "error");
      }
    }
    await loadPluginPane({
      pluginId: current.state.pluginId,
      displayName: current.state.displayName,
      panelId: current.state.panelId,
      context: current.state.context ?? null,
    }, options);
  }, [addNotice, applyPluginOpenUrl, askPluginPrompt, loadPluginPane]);

  useEffect(() => {
    if (rightPane.kind !== "plugin-panel" || !rightOpen || !connection) return;
    const timer = setInterval(() => {
      void refreshPluginPane();
    }, 10_000);
    timer.unref?.();
    return () => clearInterval(timer);
  }, [connection, refreshPluginPane, rightOpen, rightPane.kind]);

  // A refresh that dropped the armed action disarms it: the sentence the user
  // was asked to confirm described a row that is no longer in the panel. An
  // action that merely moved keeps its arm, because it is still the same action.
  useEffect(() => {
    if (pluginConfirmArmedRef.current === null) return;
    const stillThere = rightPane.kind === "plugin-panel"
      && rightPane.model.interactives.some(
        (entry) => pluginInteractiveKey(rightPane.model, entry) === pluginConfirmArmedRef.current,
      );
    if (!stillThere) pluginConfirmArmedRef.current = null;
  }, [rightPane]);

  /**
   * Open a plugin by the name the user typed, or list the installed plugins
   * when they typed nothing (or something ambiguous). The picker is a plain
   * list pane, so it inherits the arrow/Enter behaviour every other list has.
   */
  const openPluginPane = useCallback(async (query: string): Promise<void> => {
    const conn = connectionRef.current;
    if (!conn) return;
    if (prospectiveRightPaneWidth === 0) {
      // The right pane collapses below ~86 columns. Saying so beats opening a
      // pane the layout will not draw.
      addNotice(PLUGIN_PANE_TOO_NARROW, "info");
      return;
    }
    const roster = await listPlugins(conn);
    if (roster.state === "unsupported") {
      setRightPane({
        kind: "details",
        title: "Plugins",
        body: "This ADE host has no plugin support yet. Update it to install and view plugins.",
      });
      return;
    }
    if (roster.state === "error") {
      setRightPane({ kind: "details", title: "Plugins", body: roster.message });
      return;
    }
    const enabled = roster.plugins.filter((plugin) => plugin.enabled);
    const match = query.trim() ? resolvePluginByName(enabled, query) : null;
    if (match) {
      setRightSelectionIndex(0);
      await loadPluginPane({
        pluginId: match.pluginId,
        displayName: match.displayName,
        panelId: defaultPluginPanelId(match),
      }, { open: true });
      return;
    }
    if (query.trim() && enabled.length > 0) {
      addNotice(`No installed plugin matches "${query.trim()}".`, "info");
    }
    setRightSelectionIndex(0);
    setRightPane({
      kind: "list",
      title: "Plugins",
      rows: enabled.map((plugin) => {
        const status = plugin.status === "running" ? "" : ` · ${plugin.status}`;
        return `${plugin.displayName} · ${plugin.version}${status}`;
      }),
      emptyText: roster.plugins.length > 0
        ? "Every installed plugin is disabled. Enable one with ade plugin enable."
        : "No plugins installed. Add one with ade plugin install.",
      action: { kind: "plugin-view", ids: enabled.map((plugin) => plugin.pluginId) },
    });
  }, [addNotice, loadPluginPane, prospectiveRightPaneWidth]);

  /**
   * Apply a composer edit an action asked for, or say why it was ignored.
   *
   * A pointer client can write into a composer that is merely on screen; this
   * one cannot. The prompt line is shared — a plugin panel field borrows it, a
   * form borrows it, the drawer takes focus away from it — so writing into it
   * from a background pane would overwrite whatever the user is actually typing
   * in. The rule is therefore the narrow one: apply when the chat composer holds
   * focus, and otherwise say the edit was dropped rather than silently doing
   * nothing to a button the user just pressed.
   */
  const applyPluginComposerEdit = useCallback((result: unknown, label: string): void => {
    if (!hasPluginActionComposerRequest(result)) return;
    const edit = readPluginActionComposerEdit(result);
    if (!edit) {
      addNotice(`${label} sent a composer edit this client could not read.`, "info");
      return;
    }
    if (activePaneRef.current !== "chat") {
      addNotice(`${label} wanted to write into the composer. Focus the chat and run it again.`, "info");
      return;
    }
    if (edit.mode === "replace") {
      setPromptValue(edit.text);
      return;
    }
    const draft = promptRef.current;
    const caret = clampPromptCursor(draft, promptCursorRef.current);
    setPromptValue(`${draft.slice(0, caret)}${edit.text}${draft.slice(caret)}`, caret + edit.text.length);
  }, [addNotice, setPromptValue]);


  /**
   * Run a contributed row/toolbar action and follow whatever it answers with.
   *
   * The same three outcomes the panel pane already handles, so a plugin's action
   * behaves identically whether it was pressed on a row or inside a panel: a
   * `navigate` opens that plugin's panel in this pane, a `composer` verb reaches
   * the prompt line, and anything else is just a result the user is told ran.
   */
  const runPluginRowAction = useCallback(async (key: string): Promise<void> => {
    const pane = pluginRowActionsRef.current;
    const entry = pane?.entriesByKey.get(key);
    if (!pane || !entry) return;
    const conn = connectionRef.current;
    if (!conn) {
      addNotice("ADE runtime is still connecting.", "error");
      return;
    }
    const args: Record<string, unknown> = {
      context: entry.socket === "toolbar-action" ? pane.surfaceContext : pane.context,
    };
    const follow = async (result: unknown): Promise<void> => {
      applyPluginOpenUrl(result, entry.label);
      const navigation = readPluginActionNavigation(result);
      if (navigation) {
        setRightSelectionIndex(0);
        await loadPluginPane({
          pluginId: entry.pluginId,
          displayName: entry.pluginName,
          panelId: navigation.panelId,
          context: navigation.context ?? null,
        }, { open: true });
        return;
      }
      applyPluginComposerEdit(result, entry.label);
    };
    try {
      const result = await invokePluginAction(conn, entry.pluginId, entry.actionId, args);
      addNotice(`${entry.label} ran.`, "success");
      if (askPluginPrompt({
        result,
        pluginId: entry.pluginId,
        displayName: entry.pluginName,
        actionId: entry.actionId,
        args,
        label: entry.label,
        follow,
      })) return;
      await follow(result);
    } catch (error) {
      addNotice(error instanceof Error ? error.message : String(error), "error");
    }
  }, [addNotice, applyPluginComposerEdit, applyPluginOpenUrl, askPluginPrompt, loadPluginPane]);

  /**
   * The TUI's row menu: what plugins contribute for the focused lane or chat,
   * plus the surface's own contributed actions.
   *
   * `argument` picks the subject explicitly (`lane` / `chat`); with none, the
   * focused work-list row decides, because that is the row the user is looking
   * at. Both subjects are reachable either way so the command works from the
   * chat pane too, where nothing in the work list has focus.
   */
  const openPluginActionsPane = useCallback((argument: string): void => {
    const requested = argument.trim().toLowerCase();
    // The work list is session-first: a `session:`/`foreign:` row key means the
    // user is looking at a chat, and anything else (a lane header, a shelf) is
    // a lane. With nothing focused at all the lane branch below still answers.
    const chatRowFocused = Boolean(
      workSelectedKey?.startsWith("session:") || workSelectedKey?.startsWith("foreign:"),
    );
    const wantsChat = requested === "chat" || requested === "chats" || requested === "session"
      || (requested === "" && chatRowFocused);
    const laneId = selectedDrawerLaneId ?? drawerLaneId ?? activeLaneId;
    const lane = laneId ? lanes.find((entry) => entry.id === laneId) ?? null : null;
    const sessionId = selectedDrawerChatId ?? activeSessionId;
    const session = sessionId
      ? displaySessions.find((entry) => entry.sessionId === sessionId) ?? null
      : null;

    const target = wantsChat && session
      ? {
        surface: "work" as const,
        set: pluginContributions.work,
        context: tuiSessionContext(session) as PluginSurfaceContext,
        entityLabel: formatSessionLabel(session),
        surfaceLabel: "Work",
      }
      : lane
        ? {
          surface: "lanes" as const,
          set: pluginContributions.lanes,
          context: tuiLaneContext(lane) as PluginSurfaceContext,
          entityLabel: formatLaneLabel(lane),
          surfaceLabel: "Lanes",
        }
        : null;

    if (!target) {
      addNotice(
        wantsChat ? "No chat is focused to run a plugin action on." : "No lane is focused to run a plugin action on.",
        "info",
      );
      return;
    }

    const built = buildPluginActionsPane({
      set: target.set,
      surface: target.surface,
      context: target.context,
      entityLabel: target.entityLabel,
      surfaceLabel: target.surfaceLabel,
      // The pane's OWN row budget, not the pane's width: a list row is clipped
      // to `paneWidth - 4` and carries a two-column selection prefix, so
      // formatting against anything wider hands the clipper the tail of the
      // plugin's name to eat.
      width: Math.max(20, prospectiveRightPaneWidth - 6),
    });
    pluginRowActionsRef.current = {
      entriesByKey: built.entriesByKey,
      context: target.context,
      surfaceContext: { kind: "surface", surface: target.surface },
    };
    // Land on the first row that actually runs something: row 0 is a heading,
    // and opening onto it makes Enter look broken.
    setRightSelectionIndex(Math.max(0, built.ids.findIndex((id) => id !== "")));
    setRightPane({
      kind: "list",
      title: "Plugin actions",
      rows: built.rows,
      emptyText: built.emptyText,
      action: { kind: "plugin-row-action", ids: built.ids },
    });
  }, [
    activeLaneId,
    activeSessionId,
    addNotice,
    displaySessions,
    drawerLaneId,
    lanes,
    pluginContributions,
    prospectiveRightPaneWidth,
    selectedDrawerChatId,
    selectedDrawerLaneId,
    workSelectedKey,
  ]);

  /**
   * Run whatever the selected row is: a button or list press invokes the
   * plugin, a typed field takes over the composer, a select or toggle changes
   * in place, and a submit sends the form's values as the action's args.
   */
  const activatePluginInteractive = useCallback(async (
    index: number,
    /**
     * A typed field that the composer just committed, and the value it
     * committed. Present only on that path: without it a typed field takes the
     * composer over instead of dispatching, which is what pressing its row
     * means. The value is passed rather than read back because the pane state
     * write that carries it has not re-rendered yet.
     */
    options?: { commitValue?: string },
  ): Promise<void> => {
    const current = rightPaneRef.current;
    if (current.kind !== "plugin-panel") return;
    const interactive = current.model.interactives[index];
    if (!interactive) return;
    const conn = connectionRef.current;
    /**
     * The form's values including the edit being applied right now.
     *
     * A committed field dispatches in the same tick as its own local write, and
     * `current.state.values` is the snapshot from BEFORE that write — so an
     * apply-on-change form read from it would send the plugin the value the
     * reader just replaced. Null for every other kind of press, which reads the
     * pane state as usual.
     */
    let committedFieldValues: Record<string, string> | null = null;

    // A `group`'s disclosure. Client-local and nothing else: no dispatch, no
    // panel state, no socket. Folding a section is a statement about this
    // terminal, not about which rows the panel is showing.
    if (interactive.kind === "group") {
      const openGroups = pluginPaneToggleGroup(current.model, interactive.groupKey);
      updatePluginPaneState((state) => ({ ...state, openGroups }));
      return;
    }

    // A list's "Show more". Client-local like the disclosure above it: it draws
    // one more page of rows the pane already fetched, and invokes nothing.
    if (interactive.kind === "listPage") {
      const listPages = pluginPaneShowMore(current.model, interactive.listKey, interactive.total);
      if (listPages !== current.model.listPages) {
        updatePluginPaneState((state) => ({ ...state, listPages }));
      }
      return;
    }

    // A tick box. Local and immediate, like a `segmented` option — the verbs
    // live on the bar, and ticking a row must never invoke a plugin.
    if (interactive.kind === "selection") {
      const selection = pluginPaneToggleRow(current.model, interactive.stateKey, interactive.rowKey);
      updatePluginPaneState((state) => ({ ...state, selection }));
      return;
    }

    // The bar's own Clear: one gesture out of a batch the reader ticked by
    // mistake. It carries no action, so there is nothing to dispatch.
    if (interactive.kind === "bulk" && !interactive.action) {
      const selection = pluginPaneClearSelection(current.model, interactive.stateKey);
      updatePluginPaneState((state) => ({ ...state, selection }));
      return;
    }

    if (interactive.kind === "field") {
      const field = interactive.field;
      const valueKey = pluginFormValueKey(interactive.formKey, field.id);
      let committed = options?.commitValue ?? null;
      if (committed === null) {
        if (pluginFieldUsesComposer(field.kind)) {
          // Hand the field to the shared composer: panes in this client never own
          // a text input, so typed values always come through the prompt line.
          const raw = pluginFieldRawValue(field, interactive.formKey, current.state.values);
          stashActiveInput();
          setPromptValue(raw);
          updatePluginPaneState((state) => ({ ...state, editing: index }));
          return;
        }
        const raw = pluginFieldRawValue(field, interactive.formKey, current.state.values);
        committed = cyclePluginFieldValue(field, raw, 1);
        updatePluginPaneState((state) => ({
          ...state,
          values: { ...state.values, [valueKey]: committed as string },
        }));
      }
      // A form declaring `applyOnChange` has no submit row to press: the edit IS
      // the press, and it sends the same full values map a submit would have.
      // The local write already happened — here, or in the caller that supplied
      // `commitValue` — so a failing plugin cannot leave the control showing the
      // old value.
      if (!interactive.applyOnChange) return;
      committedFieldValues = { ...current.state.values, [valueKey]: committed };
    }

    if (interactive.kind === "search") {
      let committed = options?.commitValue ?? null;
      if (committed === null) {
        stashActiveInput();
        setPromptValue(current.model.state[interactive.stateKey] ?? "");
        updatePluginPaneState((state) => ({ ...state, editing: index }));
        return;
      }
      const values = pluginPaneStateChange(current.model, interactive.stateKey, committed);
      updatePluginPaneState((state) => ({ ...state, state: values, editing: null }));
      if (!interactive.onChange) return;
    }

    // A `segmented` option. The write is local and immediate — that is the whole
    // point of the control — so it happens before anything can fail, and a panel
    // with no `onChange` never touches the socket at all.
    if (interactive.kind === "state") {
      const values = pluginPaneStateChange(current.model, interactive.stateKey, interactive.value);
      updatePluginPaneState((state) => ({ ...state, state: values }));
      if (!interactive.onChange) return;
    }

    if (!conn) {
      addNotice("ADE runtime is still connecting.", "error");
      return;
    }

    const action = interactive.kind === "state" || interactive.kind === "search"
      ? interactive.onChange
      : interactive.kind === "field" ? interactive.applyOnChange : interactive.action;
    if (!action) return;
    // A field row has no label of its own; the field's is what the notice and
    // the prompt anchor should say.
    const label = interactive.kind === "field" ? interactive.field.label : interactive.label;
    const armKey = pluginInteractiveKey(current.model, interactive);
    if (action.confirm && pluginConfirmArmedRef.current !== armKey) {
      pluginConfirmArmedRef.current = armKey;
      addNotice(`${action.confirm} Press enter again to confirm.`, "info");
      return;
    }
    pluginConfirmArmedRef.current = null;

    const args: Record<string, unknown> = { ...(action.args ?? {}) };
    // An `onChange` is told which option was picked, named by the control's own
    // state key — the plugin reads back exactly the key it wrote in the schema.
    if (interactive.kind === "state") args[interactive.stateKey] = interactive.value;
    if (interactive.kind === "search") {
      args[interactive.stateKey] = options?.commitValue
        ?? current.model.state[interactive.stateKey]
        ?? "";
    }
    // The panel's own context rides along as `context`, the same field a socket's
    // surface context uses, so a button pressed on a context-carrying panel
    // reaches the plugin knowing what it was looking at.
    if (current.state.context) args.context = current.state.context;
    // A submit and an apply-on-change send the same thing: the whole form, so a
    // plugin reads one shape whichever way the values reached it.
    if (interactive.kind === "submit" || interactive.kind === "field") {
      const values = committedFieldValues ?? current.state.values;
      for (const field of interactive.fields) {
        const raw = pluginFieldRawValue(field, interactive.formKey, values);
        if (field.kind === "toggle") args[field.id] = raw === "true";
        else if (field.kind === "number") {
          const parsed = Number(raw);
          if (raw !== "" && Number.isFinite(parsed)) args[field.id] = parsed;
        } else if (raw !== "") args[field.id] = raw;
      }
    }

    // The reader's filter selections, last so a schema cannot name an argument
    // that would quietly replace them. A "Refresh" that did not know them would
    // refetch a whole fleet for a reader looking at four rows of it.
    const statePayload = pluginPaneStatePayload(
      interactive.kind === "state"
        ? pluginPaneStateChange(current.model, interactive.stateKey, interactive.value)
        : interactive.kind === "search"
          ? pluginPaneStateChange(
            current.model,
            interactive.stateKey,
            options?.commitValue ?? current.model.state[interactive.stateKey] ?? "",
          )
          : current.model.state,
    );
    if (statePayload) args.state = statePayload;
    // The batch, LAST of all — after the schema's own args, after the context
    // and after the state payload — so a schema cannot name an argument that
    // would quietly replace the rows the reader ticked. It is the only array in
    // an args object that is otherwise flat scalars, and every key in it is one
    // the plugin itself wrote.
    if (interactive.kind === "bulk") {
      args.selection = pluginPaneSelectionPayload(current.model, interactive.stateKey);
    }

    updatePluginPaneState((state) => ({ ...state, editing: null }));
    const follow = async (result: unknown): Promise<void> => {
      applyPluginOpenUrl(result, label);
      // A plugin may put the reader back on a filter that still has rows: after
      // archiving everything "Active" was showing, an empty list is a puzzle and
      // "All" is an answer. Queued before the refetch below, so the reload reads
      // the reset selections rather than the ones they replaced.
      const reset = pluginPaneStateReset(current.model, result);
      if (reset) updatePluginPaneState((state) => ({ ...state, state: reset }));
      // One verb, both maps. A plugin answering a bulk action with
      // `{resetState}` has almost always just acted on every ticked row, and
      // leaving them ticked would offer to do it again to rows that have moved
      // on.
      const resetSelection = pluginPaneSelectionReset(current.model, result);
      if (resetSelection) updatePluginPaneState((state) => ({ ...state, selection: resetSelection }));
      // An action may ask to be followed to another panel of its own plugin.
      // Reload rather than refresh: the destination is a different panel, and
      // it arrives with the context the action handed us.
      const navigation = readPluginActionNavigation(result);
      if (navigation) {
        setRightSelectionIndex(0);
        await loadPluginPane({
          pluginId: current.state.pluginId,
          displayName: current.state.displayName,
          panelId: navigation.panelId,
          context: navigation.context ?? null,
        }, { open: true });
        return;
      }
      await refreshPluginPane();
    };
    try {
      const result = await invokePluginAction(conn, current.state.pluginId, action.action, args);
      addNotice(`${label} ran.`, "success");
      // The question comes first and stops here: the button has not finished,
      // so a refetch now would redraw the panel around an action still waiting
      // on the reader.
      if (askPluginPrompt({
        result,
        pluginId: current.state.pluginId,
        displayName: current.state.displayName,
        actionId: action.action,
        args,
        label,
        follow,
      })) return;
      await follow(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setRightPane((pane) => (pane.kind === "plugin-panel" ? { ...pane, error: message } : pane));
      addNotice(message, "error");
    }
  }, [addNotice, applyPluginOpenUrl, askPluginPrompt, loadPluginPane, refreshPluginPane, setPromptValue, stashActiveInput, updatePluginPaneState]);

  const activateRightPaneListItem = useCallback((selectedId: string, actionKind: NonNullable<Extract<RightPaneContent, { kind: "list" }>["action"]>["kind"]) => {
    if (actionKind === "copy-secret") {
      void copyProjectSecret(selectedId).catch((err) => addNotice(err instanceof Error ? err.message : String(err), "error"));
      return;
    }
    if (actionKind === "snooze-duration") {
      // The trailing free-text hint row carries an empty id; ignore it.
      if (!selectedId) return;
      const sessionId = pendingSnoozeSessionIdRef.current;
      if (!sessionId) return;
      const resolved = resolveSnoozeChoice(selectedId as SnoozeDurationKey);
      if (!resolved.ok) {
        addNotice(resolved.message, "error");
        return;
      }
      pendingSnoozeSessionIdRef.current = null;
      setRightPane({ kind: "empty" });
      void applySessionSnooze(sessionId, resolved.untilIso, resolved.confirmation);
      return;
    }
    if (actionKind === "plugin-row-action") {
      // Heading and spacer rows carry an empty id and are not activatable.
      if (!selectedId) return;
      void runPluginRowAction(selectedId);
      return;
    }
    if (actionKind === "plugin-view") {
      if (!selectedId) return;
      // The picker row carries the plugin id; the panel it opens is resolved
      // from the roster again so the pane never renders a stale panel id.
      void openPluginPane(selectedId).catch((err) => addNotice(err instanceof Error ? err.message : String(err), "error"));
      return;
    }
    if (actionKind === "switch-machine") {
      const query = machinePickerQueryByIdRef.current.get(selectedId);
      if (!query) return;
      setRightPane({ kind: "empty" });
      void hopToMachine(query);
      return;
    }
    if (actionKind === "switch-project") {
      const rootPath = projectPickerRootByIdRef.current.get(selectedId);
      if (!rootPath) return;
      setRightPane({ kind: "empty" });
      if (rootPath === activeProjectRoot) {
        addNotice(`Already in ${path.basename(rootPath)}.`, "info");
        focusChat();
        return;
      }
      void switchProjectOnCurrentMachine(rootPath);
      return;
    }
    if (actionKind === "switch-lane") {
      const lane = lanes.find((entry) => entry.id === selectedId);
      if (!lane) return;
      activateLaneWithLastChat(lane, { notify: true });
      return;
    }
    if (actionKind === "chat-list" && selectedId === RIGHT_CHAT_CLOSED_TOGGLE_ID) {
      toggleRightChatsClosedGroup();
      return;
    }
    const session = displaySessions.find((entry) => entry.sessionId === selectedId);
    if (!session) return;
    selectActiveLaneId(session.laneId);
    setDrawerLaneId(session.laneId);
    setSelectedDrawerLaneId(session.laneId);
    setSelectedWorkChatAction(null);
    setSelectedDrawerChatId(session.sessionId);
    const terminal = actionKind === "chat-list"
      ? terminalSessions.find((entry) => entry.terminalId === session.sessionId && entry.status !== "running") ?? null
      : null;
    if (terminal) {
      if (!isTerminalSessionResumable(terminal)) {
        addNotice("This CLI session cannot be resumed.", "info");
        return;
      }
      void resumeClosedTerminalSession(terminal)
        .then((resumed) => {
          if (resumed) addNotice("Resuming CLI session…", "info");
        })
        .catch((err) => addNotice(err instanceof Error ? err.message : String(err), "error"));
      return;
    }
    selectActiveSessionId(session.sessionId);
    addNotice(`Switched to chat ${session.title ?? session.sessionId}.`, "success");
  }, [
    activateLaneWithLastChat,
    activeProjectRoot,
    addNotice,
    applySessionSnooze,
    copyProjectSecret,
    displaySessions,
    focusChat,
    hopToMachine,
    lanes,
    openPluginPane,
    runPluginRowAction,
    resumeClosedTerminalSession,
    selectActiveLaneId,
    selectActiveSessionId,
    switchProjectOnCurrentMachine,
    terminalSessions,
    toggleRightChatsClosedGroup,
  ]);

  const activateActivityItem = useCallback(async (index: number): Promise<void> => {
    const pane = rightPaneRef.current;
    if (pane.kind !== "activity") return;
    const item = pane.model.items[index];
    if (!item) return;
    const deepLink = activityItemDeepLink(item);
    if (!await openActivityDeepLink(deepLink, addNotice)) {
      addNotice("ADE could not open this destination on the current platform. The item remains unreviewed.", "error");
      return;
    }

    // Opening the destination is the acknowledgement boundary. Never mark an
    // item seen before the OS accepts its exact ADE deeplink.
    const seenAt = new Date().toISOString();
    const updatedSnapshot = {
      ...pane.model.snapshot,
      items: pane.model.snapshot.items.map((entry) =>
        entry.id === item.id ? { ...entry, seenAt } : entry),
    };
    setRightPane({
      kind: "activity",
      model: buildActivityPaneModel(updatedSnapshot),
    });
    const conn = connectionRef.current;
    if (!conn) return;
    try {
      await acknowledgeActivityItem(
        conn,
        item,
        pane.model.snapshot.scope,
        pane.model.snapshot.accountOwnerId ?? null,
      );
    } catch {
      addNotice("The destination opened, but ADE could not sync the seen state. Retry Activity to reconcile it.", "error");
    }
  }, [addNotice]);

  const sendOrSteerChatMessage = useCallback(async (
    sessionId: string,
    text: string,
    attachments: AgentChatFileRef[] = [],
  ) => {
    const conn = connectionRef.current;
    if (!conn) return;
    const steerActiveTurn = async (): Promise<void> => {
      const result = await steerChatMessage(conn, sessionId, text, attachments);
      // A full steer queue drops the message server-side. Surface it the same way
      // the primary messageSession path does — throw so submitPrompt restores the
      // typed text and shows an error — instead of falsely implying it was sent.
      // Every queue-bearing runtime can hit this (Claude, Cursor, Droid,
      // OpenCode), so the message names the session's own agent.
      if (result.reason === "queue_full") {
        const agentLabel = providerDisplayLabel(
          sessions.find((session) => session.sessionId === sessionId)?.provider,
          "agent",
        );
        throw new Error(`The ${agentLabel} steer queue is full; the message was not queued.`);
      }
      if (result.queued) {
        addNotice("Staged message — sends after the current turn.", "info");
      }
    };
    const legacySendOrSteer = async (): Promise<void> => {
      const activeTurnVisible = (
        (streamingBySessionIdRef.current[sessionId] === true)
        || sessions.some((session) => session.sessionId === sessionId && session.status === "active")
      );
      if (activeTurnVisible) {
        try {
          await steerActiveTurn();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!/No active turn to steer/i.test(message)) throw error;
          try {
            await sendChatMessage(conn, sessionId, text, attachments);
          } catch (sendError) {
            const sendMessage = sendError instanceof Error ? sendError.message : String(sendError);
            if (!/turn is already active|already active/i.test(sendMessage)) throw sendError;
            await steerActiveTurn();
          }
        }
        return;
      }
      try {
        await sendChatMessage(conn, sessionId, text, attachments);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/turn is already active|already active/i.test(message)) {
          await steerActiveTurn();
          return;
        }
        throw error;
      }
    };
    setSessionStreaming(sessionId, true);
    try {
      const result = await messageChatSession(conn, sessionId, text, "auto", attachments);
      if (result.delivery === "queued") {
        addNotice("Staged message — sends after the current turn.", "info");
      }
      recordPromptHistoryForSession(sessionId, text);
      await refreshState();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/messageSession is not available|unknown action|unknown ADE action|not found/i.test(message)) {
        await legacySendOrSteer();
        recordPromptHistoryForSession(sessionId, text);
        await refreshState();
        return;
      }
      throw error;
    }
  }, [addNotice, recordPromptHistoryForSession, refreshState, sessions, setSessionStreaming]);

  // Build the help RightPaneContent for the given filter/selection/recents and
  // push it into the right pane. Centralised so /help open + every keystroke in
  // the pane recompute the grouped+ranked rows the same way.
  const renderHelpPane = useCallback(
    (query: string, selectedIndex: number, recents: string[]) => {
      const groupedRows = buildHelpRows(helpIndexGroups, query, recents);
      const total = flattenHelpRows(groupedRows).length;
      const clamped = total === 0 ? 0 : Math.max(0, Math.min(selectedIndex, total - 1));
      setRightPane({
        kind: "help",
        title: "Help",
        filterQuery: query,
        selectedIndex: clamped,
        groupedRows,
      });
    },
    [helpIndexGroups],
  );

  const openHelpPane = useCallback(() => {
    setHelpFilterQuery("");
    setHelpSelectedIndex(0);
    renderHelpPane("", 0, helpRecentsRef.current);
    setRightOpen(true);
    setPaneFocus("details");
  }, [renderHelpPane, setPaneFocus]);

  const refreshActivityPane = useCallback(async (options: { announce?: boolean } = {}) => {
    const conn = connectionRef.current;
    if (!conn) {
      setRightPane({
        kind: "details",
        title: "Activity",
        body: "ADE is still connecting. Retry when the runtime is ready.",
      });
      return;
    }
    const snapshot = await loadActivitySnapshot(conn, {
      hostName: project.remoteLabel,
    });
    setAttentionSnapshot(snapshot);
    const model = buildActivityPaneModel(snapshot);
    setRightSelectionIndex((index) => Math.max(0, Math.min(index, Math.max(0, model.items.length - 1))));
    setRightPane({ kind: "activity", model });
    setRightOpen(true);
    if (options.announce) {
      addNotice(
        snapshot.scope === "machine"
          ? "Activity refreshed from this connected machine."
          : "Account Activity refreshed.",
        snapshot.availability?.state === "ready" ? "success" : "info",
      );
    }
  }, [addNotice, project.remoteLabel]);

  useEffect(() => {
    if (rightPane.kind !== "activity" || !connection) return;
    const timer = setInterval(() => {
      void refreshActivityPane();
    }, 10_000);
    timer.unref?.();
    return () => clearInterval(timer);
  }, [connection, refreshActivityPane, rightPane.kind]);

  const runRightCommand = useCallback(async (name: string, args: string) => {
    const conn = connectionRef.current;
    const laneId = activeLaneIdRef.current;
    const sessionId = activeSessionIdRef.current;
    focusDetails();
    // Slash-opened panes are sticky: mark before dispatching so the
    // context-default effect won't overwrite. Cleared on chat switch or
    // explicit close (Esc / pane:close). Commands like /new chat and
    // /new lane re-enter their own flows below which clear this marker.
    lastUserOpenedPaneRef.current = "details";

    if (name === "/lane details") {
      const reference = args.trim();
      const selectedLaneId = workSelectedRow?.kind === "lane-header" || workSelectedRow?.kind === "session"
        ? workSelectedRow.laneId
        : null;
      const lane = reference
        ? resolveLaneReference(lanes, reference)
        : (selectedLaneId ? lanes.find((entry) => entry.id === selectedLaneId) ?? null : null) ?? activeLane;
      if (!lane) {
        setRightPane({
          kind: "details",
          title: "Lane details",
          body: reference
            ? `No lane matched "${reference}". Use an exact lane name or id.`
            : "No active lane is selected.",
        });
        return;
      }
      openLaneDetailsPane(lane);
      return;
    }

    if (name === "/report-issue") {
      // Deliberately above the `!conn` gate: the report reads local files only,
      // so it still answers while the runtime is unreachable — the state a bug
      // report is most worth filing from.
      // `--send` too: the CLI spelling is the one half these users already know,
      // including alongside other flags they may carry over (`--open --send`).
      const wantsSend = args
        .trim()
        .toLowerCase()
        .split(/\s+/)
        .some((argument) => /^--?send$/.test(argument) || argument === "send");
      try {
        const { buildTuiDiagnosticReport, sendTuiDiagnosticReport } = await import("./reportIssue");
        const built = buildTuiDiagnosticReport({ projectRoot: project.projectRoot });
        // Shown before anything is sent, so the file path and the issue URL are
        // in hand no matter how the upload goes.
        setRightPane({ kind: "details", title: "Report issue", body: built.body });
        if (!wantsSend) return;
        addNotice("Sending the report to ADE…", "info");
        const sent = await sendTuiDiagnosticReport(built);
        setRightPane({ kind: "details", title: "Report issue", body: sent.body });
        addNotice(sent.notice, sent.result.ok ? "success" : "error");
      } catch (error) {
        setRightPane({
          kind: "details",
          title: "Report issue",
          body: [
            "The report could not be built.",
            "",
            error instanceof Error ? error.message : String(error),
            "",
            "Run ade report-issue --open in any terminal instead.",
          ].join("\n"),
        });
      }
      return;
    }

    if (!conn) {
      if (name === "/help") {
        renderHelpPane("", 0, helpRecentsRef.current);
        return;
      }
      if (name === "/status") {
        setRightPane({
          kind: "status",
          rows: [
            ["project", project.projectRoot],
            ["workspace", project.workspaceRoot],
            ["lane", activeLane?.name ?? laneId ?? "none"],
            ["chat", activeSession?.title ?? activeSession?.sessionId ?? "none"],
            ["ADE", mode],
          ],
        });
        return;
      }
      if (name === "/activity") {
        setRightPane({
          kind: "details",
          title: "Activity",
          body: "ADE is still connecting. Retry when the runtime is ready.",
        });
        return;
      }
      if (name === "/plugin-view" || name === "/plugin-actions") {
        setRightPane({
          kind: "details",
          title: "Plugins",
          body: "Plugins run on the machine ADE is connected to. Retry when the runtime is ready.",
        });
        return;
      }
      if (name === "/machines" || name === "/project") {
        setRightPane({
          kind: "details",
          title: name === "/machines" ? "Machines" : "Projects",
          body: "ADE is still connecting. Retry when the runtime is ready.",
        });
        return;
      }
      if (name === "/feedback") {
        openFeedbackForm();
        return;
      }
      if (name === "/model") {
        openModelWizard();
        return;
      }
      if (name === "/import") {
        // Import needs the runtime to enumerate provider transcripts.
        addNotice("Import needs the ADE runtime — retry once it is connected.", "info");
        return;
      }
      if (name === "/secrets") {
        await openSecretsPane();
        return;
      }
      if (name === "/effort") {
        openModelWizard({ startAtSettings: true });
        return;
      }
      if (name === "/info") {
        if (!subagentPaneCommandAvailable) {
          setRightPane({
            kind: "details",
            title: "Chat info",
            body: "No active chat is selected. Start or open a chat to inspect plan, goal, and agents.",
          });
          return;
        }
        openSubagentsPane();
        return;
      }
      if (name === "/system") {
        setRightPane({
          kind: "details",
          title: "System",
          body: formatSystemDetails({ project, pid: process.pid, mode }),
        });
        return;
      }
      setRightPane({
        kind: "details",
        title: name.replace(/^\//, "") || "ADE",
        body: "ADE runtime is still connecting. Try again when the connection is ready.",
      });
      return;
    }

    if (name === "/help") {
      renderHelpPane("", 0, helpRecentsRef.current);
      return;
    }
    if (name === "/activity") {
      setRightSelectionIndex(0);
      await refreshActivityPane();
      return;
    }
    if (name === "/plugin-view") {
      await openPluginPane(args);
      return;
    }
    if (name === "/plugin-actions") {
      openPluginActionsPane(args);
      return;
    }
    if (name === "/machines") {
      setRightPane({
        kind: "details",
        title: "Machines",
        body: "Loading paired machines…",
      });
      setRightOpen(true);
      try {
        const sources = await loadMachinePickerSources([project.projectRoot]);
        const rows = buildMachinePickerRows({
          localLabel: "this machine",
          localProjectRoot: activeProjectRoot,
          pooled: connectionPoolRef.current.list(),
          targets: sources.targets,
          accountMachines: sources.accountMachines,
          activeMachineKey,
        });
        const query = args.trim();
        const filtered = query
          ? rows.filter((row) => `${row.label} ${row.detail} ${row.id}`.toLowerCase().includes(query.toLowerCase()))
          : rows;
        machinePickerQueryByIdRef.current = new Map(filtered.map((row) => [row.id, row.query]));
        setRightSelectionIndex(Math.max(0, filtered.findIndex((row) => row.id === activeMachineKey)));
        setRightPane({
          kind: "list",
          title: "Machines",
          rows: filtered.map((row) => `${row.label}  ${row.detail}`),
          emptyText: "No other machines. Sign in and pair one from desktop, then retry.",
          action: { kind: "switch-machine", ids: filtered.map((row) => row.id) },
        });
      } catch (error) {
        setRightPane({
          kind: "details",
          title: "Machines",
          body: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    if (name === "/cloud") {
      // A hidden palette row is not access control: `/cloud` can still be typed
      // in full, restored from history, or arrive from a keybinding. The gate is
      // checked here as well, and it names the plugin so the refusal reads as a
      // move rather than a breakage.
      if (slashCommandUnavailableSurface(name, pluginInstallRecords)) {
        setRightPane({
          kind: "details",
          title: "Cloud agents",
          body: "The Cursor Cloud plugin owns this surface on this machine. Open it from the plugin instead.",
        });
        setRightOpen(true);
        return;
      }
      setRightPane({
        kind: "list",
        title: "Cloud agents",
        rows: [],
        emptyText: "Loading Cursor Cloud agents…",
      });
      setRightOpen(true);
      try {
        const fleet = await getCursorCloudFleet(conn);
        setRightPane({
          kind: "list",
          title: fleet.items.length ? `Cloud agents · ${fleet.items.length}` : "Cloud agents",
          rows: formatCursorCloudFleetRows(fleet.items),
          emptyText: "No Cursor Cloud agents for this project.",
          footnote: CURSOR_CLOUD_PANE_NOTE,
        });
      } catch (error) {
        setRightPane({
          kind: "details",
          title: "Cloud agents",
          body: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    if (name === "/project") {
      await openProjectPicker({ query: args.trim() });
      return;
    }
    if (name === "/keybindings") {
      const shouldOpen = args.trim().toLowerCase() === "open";
      const keybindings = readClaudeKeybindingsFile({ create: shouldOpen });
      setKeybindings(keybindings.bindings);
      if (shouldOpen) {
        try {
          openKeybindingsFile(keybindings.filePath);
          addNotice("Opening Claude keybindings config.", "info");
        } catch (error) {
          addNotice(error instanceof Error ? error.message : String(error), "error");
        }
      }
      const body = shouldOpen
        ? keybindings.body
        : `${keybindings.body}\n\nRun /keybindings open to create or open this file.`;
      setRightPane({ kind: "details", title: "Keybindings", body });
      return;
    }
    if (name === "/statusline") {
      setRightPane({ kind: "details", title: "Status line", body: formatClaudeStatusLineConfig(project.workspaceRoot) });
      return;
    }
    if (name === "/doctor") {
      let pluginCount: number | null = null;
      if (sessionId && activeSession?.provider === "claude") {
        try {
          pluginCount = (await listClaudePlugins(conn, sessionId)).length;
        } catch {
          pluginCount = null;
        }
      }
      setRightPane({
        kind: "details",
        title: "Doctor",
        body: formatDoctorReport({
          workspaceRoot: project.workspaceRoot,
          activeProvider: activeSession?.provider ?? modelState.provider,
          pluginCount,
        }),
      });
      return;
    }
    if (name === "/status") {
      setRightPane({
        kind: "status",
        rows: [
          ["project", project.projectRoot],
          ["workspace", project.workspaceRoot],
          ["lane", activeLane?.name ?? laneId ?? "none"],
          ["chat", activeSession?.title ?? activeSession?.sessionId ?? "none"],
          ["ADE", "ready"],
        ],
      });
      return;
    }
    if (name === "/context") {
      if (!sessionId) {
        setRightPane({ kind: "context-usage", title: "Context", usage: null, error: "No active chat is selected." });
        return;
      }
      // The runtime only computes context usage for Claude sessions today; give a
      // clean message for other providers rather than surfacing a raw exception.
      if (activeCommandProvider !== "claude") {
        setRightPane({ kind: "context-usage", title: "Context", usage: null, error: "Context usage is currently only available for Claude sessions." });
        return;
      }
      setRightPane({ kind: "context-usage", title: "Context", usage: null });
      try {
        const usage = await getContextUsage(conn, sessionId);
        setRightPane({ kind: "context-usage", title: "Context", usage });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setRightPane({
          kind: "context-usage",
          title: "Context",
          usage: null,
          error: `Context usage is not available for this ${activeSession?.provider ?? "chat"} session.\n\n${message}`,
        });
      }
      return;
    }
    if (name === "/usage") {
      // Session tokens/cost come straight off the local event stream — always
      // available even when the daemon snapshot carries no quota window. Mirror
      // the token-summary effect's fallback-context resolution.
      const usageFallbackContext = activeSession?.modelId
        ? getModelById(activeSession.modelId)?.contextWindow ?? null
        : null;
      const stats = sessionId ? latestTokenStats(events, usageFallbackContext) : null;
      const sessionBlock = stats
        ? { input: stats.inputTokens, output: stats.outputTokens, cost: stats.costUsd }
        : null;
      setRightPane({ kind: "usage", title: "Usage", loading: true, session: sessionBlock });
      try {
        const snapshot = await conn.action<UsageSnapshot>("usage", "getUsageSnapshot", {});
        const providerStatuses = (["claude", "codex", "cursor"] as const).flatMap((provider) => {
          const status = snapshot.providerStatus?.[provider];
          if (!status) return [];
          return [{
            id: provider,
            label: providerLabel(provider),
            state: status.state,
            source: status.source,
            updatedAt: status.updatedAt ?? status.lastSuccessAt,
            message: status.message,
          }];
        });
        const quotaWindows = snapshot.windows.map((window, index) => {
          const provider = providerLabel(window.provider);
          const label = window.windowType === "five_hour"
            ? "5-hour"
            : window.windowType.replaceAll("_", " ");
          return {
            id: `${window.provider}:${window.windowType}:${index}`,
            label: `${provider} ${label}`,
            percent: window.percentUsed,
            resetAt: Math.floor(Date.parse(window.resetsAt) / 1000),
          };
        });
        setRightPane({ kind: "usage", title: "Usage", providerStatuses, quotaWindows, session: sessionBlock, spendControlReached: snapshot.spendControlReached === true });
      } catch (error) {
        setRightPane({
          kind: "usage",
          title: "Usage",
          session: sessionBlock,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    if (name === "/agents") {
      if (activeCommandProvider !== "claude") {
        setRightPane({ kind: "details", title: "Agents", body: "/agents is only available for Claude chats." });
        return;
      }
      setRightPane({ kind: "details", title: "Agents", body: listAgentMarkdownEntries(project.workspaceRoot, "agents") });
      return;
    }
    if (name === "/skills") {
      setRightPane({ kind: "details", title: "Skills", body: listAgentMarkdownEntries(project.workspaceRoot, "skills") });
      return;
    }
    if (name === "/secrets") {
      await openSecretsPane();
      return;
    }
    if (name === "/init") {
      try {
        const body = ensureClaudeInitFiles(project.workspaceRoot);
        setRightPane({ kind: "details", title: "Init", body });
        addNotice("Initialized Claude-compatible project files.", "success");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setRightPane({ kind: "details", title: "Init", body: message });
        addNotice(message, "error");
      }
      return;
    }
    if (name === "/output-style") {
      if (!sessionId) {
        setRightPane({ kind: "details", title: "Output style", body: "No active chat is selected." });
        return;
      }
      if (activeSession?.provider !== "claude") {
        setRightPane({ kind: "details", title: "Output style", body: "/output-style is only available for Claude chats." });
        return;
      }
      if (!args.trim()) {
        const styles = await listClaudeOutputStyles(conn, sessionId);
        setRightPane({ kind: "details", title: "Output style", body: formatOutputStyles(styles, activeSession?.claudeOutputStyle) });
        return;
      }
      const updated = await setClaudeOutputStyle(conn, sessionId, args.trim());
      addNotice(`Claude output style set to ${updated.claudeOutputStyle ?? args.trim()}.`, "success");
      await refreshState();
      return;
    }
    if (name === "/plugin") {
      if (!sessionId) {
        setRightPane({ kind: "details", title: "Plugins", body: "No active chat is selected." });
        return;
      }
      if (activeSession?.provider !== "claude") {
        setRightPane({ kind: "details", title: "Plugins", body: "/plugin is only available for Claude chats." });
        return;
      }
      if (args.trim().toLowerCase() === "reload") {
        const result = await reloadClaudePlugins(conn, sessionId);
        setRightPane({ kind: "details", title: "Plugins", body: formatPluginReload(result) });
        return;
      }
      if (args.trim()) {
        const command = `/plugin ${args.trim()}`;
        setRightPane({ kind: "details", title: "Plugins", body: `Running ${command} in the active Claude session.` });
        lastLocalSendAtRef.current = Date.now();
        await sendOrSteerChatMessage(sessionId, command);
        return;
      }
      const plugins = await listClaudePlugins(conn, sessionId);
      setRightPane({ kind: "details", title: "Plugins", body: formatClaudePlugins(plugins) });
      return;
    }
    if (name === "/new chat" || name === "/new") {
      if (!laneId) {
        setRightPane({ kind: "details", title: "New chat", body: "No active lane is available." });
        return;
      }
      openNewChatSetup(args);
      return;
    }
    if (name === "/steer") {
      // Which dispatch commands this pane advertises comes off the canonical
      // per-provider table (desktop shared/types/chat.ts), the same source the
      // /steer commands and the desktop staged strip read — Claude offers both,
      // Cursor only the interrupt, everything else stages until the turn ends.
      const steerProvider = activeSession?.provider;
      const dispatchHint = [
        supportsActiveTurnDispatchMode(steerProvider, "inline") ? "/steer send" : null,
        supportsActiveTurnDispatchMode(steerProvider, "interrupt") ? "/steer interrupt" : null,
      ].filter((entry): entry is string => entry != null);
      const hintLine = pendingSteers.length
        ? dispatchHint.length
          ? `${dispatchHint.join(" · ")} · /steer edit · /steer cancel`
          : "Sends when the current turn finishes · /steer edit · /steer cancel"
        : null;
      const body = pendingSteers.length
        ? [
            pendingSteers.map((steer, index) => `${index + 1}. ${steer.text}`).join("\n"),
            ...(hintLine ? ["", hintLine] : []),
          ].join("\n")
        : "No staged steer messages are waiting.";
      setRightPane({ kind: "details", title: "Staged messages", body });
      return;
    }
    if (name === "/new lane") {
      if (!args) {
        openNewLaneForm();
        return;
      }
      const created = await conn.action<LaneSummary>("lane", "create", { name: args });
      selectActiveLaneId(created.id);
      selectActiveSessionId(null);
      setDrawerLaneId(created.id);
      setSelectedDrawerLaneId(created.id);
      setSelectedDrawerChatId(null);
      setSelectedWorkChatAction(null);
      setWorkSelectedKey(`lane:${created.id}`);
      setRightPane({ kind: "details", title: "New lane", body: renderObject(created, 20) });
      await refreshState();
      setDrawerLaneId(created.id);
      setSelectedDrawerLaneId(created.id);
      runLaneSetupAfterCreate(conn, created);
      return;
    }
    if (name === "/rename" || name === "/chat rename") {
      if (!sessionId) {
        setRightPane({ kind: "details", title: "Rename chat", body: "No active chat is selected." });
        return;
      }
      const renameTarget = sessions.find((entry) => entry.sessionId === sessionId) ?? activeSession;
      const blocked = cursorCloudRenameBlockedReason(renameTarget);
      if (blocked) {
        addNotice(blocked, "error");
        return;
      }
      if (!args) {
        openChatRenameForm(sessionId);
        return;
      }
      await renameChat(conn, sessionId, args);
      addNotice(`Renamed chat to "${args}".`, "success");
      await refreshState();
      return;
    }
    if (name === "/chat archive") {
      await archiveChat();
      return;
    }
    if (name === "/chat unarchive") {
      await unarchiveChat(args);
      return;
    }
    if (name === "/chat archived") {
      const archived = (await listChatSessions(conn, null, { includeArchived: true }))
        .filter((session) => session.archivedAt);
      const query = args.trim().toLowerCase();
      const rows = archived
        .filter((session) => !query
          || session.sessionId.toLowerCase().includes(query)
          || (session.title ?? "").toLowerCase().includes(query)
          || (lanes.find((lane) => lane.id === session.laneId)?.name ?? session.laneId).toLowerCase().includes(query))
        .map((session) => {
          const laneName = lanes.find((lane) => lane.id === session.laneId)?.name ?? session.laneId;
          return `${session.title ?? session.sessionId} · ${laneName} · archived ${session.archivedAt ?? ""}`;
        });
      setRightPane({
        kind: "details",
        title: "Archived chats",
        body: rows.length ? rows.join("\n") : "No archived chats matched.",
      });
      return;
    }
    if (name === "/chat delete") {
      openChatDeleteForm();
      return;
    }
    if (name === "/tag") {
      if (!sessionId) {
        setRightPane({ kind: "details", title: "Tag chat", body: "No active chat is selected." });
        return;
      }
      if (activeSession?.provider !== "claude") {
        setRightPane({ kind: "details", title: "Tag chat", body: "/tag is only available for Claude chats." });
        return;
      }
      if (!args) {
        setRightPane({ kind: "details", title: "Tag chat", body: "Usage: /tag <tag|clear>" });
        return;
      }
      const normalizedTag = ["clear", "none", "null", "remove"].includes(args.trim().toLowerCase())
        ? null
        : args.trim();
      await tagChat(conn, sessionId, normalizedTag);
      addNotice(normalizedTag ? `Tagged chat "${normalizedTag}".` : "Cleared chat tag.", "success");
      await refreshState();
      return;
    }
    if (name === "/diff") {
      if (!laneId) {
        setRightPane({ kind: "details", title: "Diff", body: "No active lane is selected." });
        return;
      }
      const diff = await conn.actionList("diff", "getChanges", [laneId]);
      setRightPane({ kind: "diff", title: "Diff", files: summarizeDiffChanges(diff) });
      return;
    }
    if (name === "/log") {
      if (!laneId) {
        setRightPane({ kind: "details", title: "Recent commits", body: "No active lane is selected." });
        return;
      }
      const log = await conn.action("git", "listRecentCommits", { laneId, limit: 12 });
      setRightPane({ kind: "list", title: "Recent commits", rows: routeRows(log), emptyText: "No commits." });
      return;
    }
    if (name === "/reparent") {
      const showReparentDetails = (body: string): void => {
        setRightPane({ kind: "details", title: "Reparent lane", body });
      };
      if (!laneId) {
        showReparentDetails("No active lane is selected.");
        return;
      }
      const lane = lanes.find((entry) => entry.id === laneId) ?? null;
      if (!lane) {
        showReparentDetails(`Lane ${laneId} is not loaded.`);
        return;
      }
      if (lane.laneType === "primary") {
        showReparentDetails("Primary lane cannot be reparented.");
        return;
      }
      const targets = reparentTargetsForLane(lane, lanes);
      const parsed = splitFirstArg(args);
      if (!parsed.first) {
        const rows = targets.map((target) => {
          const current = target.id === (lane.parentLaneId ?? "") ? "current" : target.laneType;
          return `${target.id.padEnd(18)} ${target.name} · ${target.branchRef} · ${current}`;
        });
        showReparentDetails([
          "Usage: /reparent <parent-lane-id|parent-name> [stack-base-ref]",
          "",
          "Moves the active lane under another parent and runs git rebase. The optional stack-base-ref overrides the parent branch, for example origin/main.",
          "",
          rows.length ? rows.join("\n") : "No valid parent lanes are available.",
        ].join("\n"));
        return;
      }
      const parent = resolveLaneReference(targets, parsed.first);
      if (!parent) {
        showReparentDetails(`No valid parent lane matched "${parsed.first}". Run /reparent to list targets.`);
        return;
      }
      const stackBaseBranchRef = parsed.rest.trim();
      const result = await conn.action("lane", "reparent", {
        laneId,
        newParentLaneId: parent.id,
        ...(stackBaseBranchRef ? { stackBaseBranchRef } : {}),
      });
      // Reparent rebases the lane onto its new parent, which can stop on
      // conflicts. Surface them instead of reporting an unconditional success.
      const reparentConflict = await conn
        .action<GitConflictState>("git", "getConflictState", { laneId })
        .catch(() => null);
      if (reparentConflict?.inProgress && reparentConflict.kind) {
        const report = formatGitConflictReport(reparentConflict);
        setRightPane({ kind: "details", title: report.title, body: report.body });
        setRightOpen(true);
        addNotice(report.summary, "error");
        await refreshState();
        return;
      }
      showReparentDetails(renderObject(result, 20));
      addNotice(
        `Reparented ${lane.name} under ${parent.name}${stackBaseBranchRef ? ` using ${stackBaseBranchRef}` : ""}.`,
        "success",
      );
      await refreshState();
      return;
    }
    if (name === "/lane rename") {
      if (args.trim()) {
        await renameLane(laneId, args);
        return;
      }
      openLaneRenameForm();
      return;
    }
    if (name === "/lane archive") {
      await archiveLane();
      return;
    }
    if (name === "/lane reclaim-preview" || name === "/lane archive-and-reclaim") {
      const allLanes = await listLanes(conn, { includeArchived: true });
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const confirmed = name === "/lane archive-and-reclaim" && tokens.includes("RECLAIM");
      const forceDirty = tokens.includes("force-dirty") || tokens.includes("--force-dirty");
      const reference = tokens
        .filter((token) => token !== "RECLAIM" && token !== "force-dirty" && token !== "--force-dirty")
        .join(" ");
      const target = reference
        ? resolveLaneReference(allLanes, reference)
        : allLanes.find((entry) => entry.id === laneId) ?? null;
      if (!target) {
        setRightPane({
          kind: "details",
          title: "Archive & Reclaim",
          body: reference
            ? `No lane matched "${reference}". Use an exact lane name or id.`
            : "No active lane is selected.",
        });
        return;
      }
      const risk = await conn.action<LaneReclaimRisk>("lane", "getReclaimRisk", { laneId: target.id });
      const preview = formatLaneReclaimPreview(risk);
      const hardBlocked = risk.blockedReasons.some((reason) => reason.disposition === "blocked");
      const dirtyNeedsConfirmation = risk.dirty && !forceDirty;
      if (!confirmed || hardBlocked || dirtyNeedsConfirmation) {
        setRightPane({ kind: "details", title: `Archive & Reclaim · ${target.name}`, body: preview });
        if (hardBlocked) {
          addNotice("ADE cannot reclaim this lane. Review the reason in the details pane.", "error");
        } else if (dirtyNeedsConfirmation && confirmed) {
          addNotice("This lane has uncommitted files. Add force-dirty only if those file changes may be lost.", "error");
        }
        return;
      }
      const result = await conn.action<ArchiveAndReclaimLaneResult>("lane", "archiveAndReclaim", {
        laneId: target.id,
        confirmation: "RECLAIM",
        forceDirty,
      });
      const warningLines = result.warnings.length
        ? ["", "Needs attention:", ...result.warnings.map((warning) => `  • ${warning}`)]
        : [];
      setRightPane({
        kind: "details",
        title: `Archive & Reclaim · ${target.name}`,
        body: [
          `Reclaimed ${formatStorageBytes(result.reclaimedBytes)}.`,
          "The lane, branch, chats, and metadata were kept.",
          `Restore it with /lane unarchive ${target.id}.`,
          ...warningLines,
        ].join("\n"),
      });
      addNotice(
        `Archived ${target.name} and reclaimed ${formatStorageBytes(result.reclaimedBytes)}.`,
        result.warnings.length ? "error" : "success",
      );
      if (activeLaneIdRef.current === target.id) {
        const fallback = allLanes.find((entry) => entry.id !== target.id && !entry.archivedAt) ?? null;
        selectActiveLaneId(fallback?.id ?? null);
      }
      await refreshState();
      return;
    }
    if (name === "/lane unarchive") {
      await unarchiveLane(args);
      return;
    }
    if (name === "/lane archived") {
      if (!conn) return;
      try {
        const archived = (await listLanes(conn, { includeArchived: true })).filter((entry) => entry.archivedAt);
        if (!archived.length) {
          setRightPane({ kind: "details", title: "Archived lanes", body: "No archived lanes." });
        } else {
          setRightPane({
            kind: "list",
            title: `Archived lanes (${archived.length}) · /lane unarchive <name>`,
            rows: archived.map((entry) => `${entry.name}${entry.branchRef ? `  ·  ${entry.branchRef}` : ""}`),
            emptyText: "No archived lanes.",
          });
        }
        setRightOpen(true);
        focusDetails();
      } catch (err) {
        addNotice(err instanceof Error ? err.message : String(err), "error");
      }
      return;
    }
    if (name === "/lane delete") {
      openLaneDeleteForm();
      return;
    }
    if (name.startsWith("/pr")) {
      if (!laneId) {
        setRightPane({ kind: "details", title: name.slice(1) || "PR", body: "No active lane is selected." });
        return;
      }
      const prs = await conn.action<Array<Record<string, unknown>>>("pr", "listAll", laneId ? { laneId } : {});
      const activePr = prs[0] ?? null;
      const prId = activePr ? String(activePr.id ?? activePr.prId ?? "") : "";
      if (name === "/pr") {
        const ahead = activeLane?.status?.ahead ?? 0;
        if (!activePr) {
          setRightPane({
            kind: "details",
            title: "PR",
            // "linked" is gone on purpose: nothing about a PR requires a lane
            // mapping any more, and this pane is simply reporting that *this*
            // lane has no PR of its own yet.
            body: `This lane has no pull request yet.\n${ahead > 0 ? `${ahead} commit${ahead === 1 ? "" : "s"} ahead of base.\n` : ""}Run /pr open to create a pull request.`,
          });
          return;
        }
        // Combined detail view (desktop ChatPrPane parity): summary + live
        // merge-readiness + checks in one pane, with the deeper sub-commands
        // hinted at the end.
        const [checks, status] = prId
          ? await Promise.all([
              conn.actionList("pr", "getChecks", [prId]).catch((err) => ({ error: err instanceof Error ? err.message : String(err) })),
              conn.actionList("pr", "getStatus", [prId]).catch(() => null),
            ])
          : [null, null];
        const sections = [
          formatPrSummary(activePr),
          ...(status ? ["", formatPrMergeState(status)] : []),
          ...(checks ? ["", formatPrChecks(checks)] : []),
          "",
          "More: /pr checks · /pr review · /pr comments · /pr land · /pr close",
        ];
        setRightPane({ kind: "details", title: "PR", body: sections.join("\n") });
        return;
      }
      if (name === "/pr open") {
        if (activePr) {
          await navigateDesktop(conn, {
            source: "ade-code",
            target: {
              kind: "pr",
              prId,
              laneId,
              prNumber: typeof activePr.number === "number" ? activePr.number : null,
            },
          });
          setRightPane({ kind: "details", title: "PR open", body: formatPrSummary(activePr) });
          return;
        }
        if (!args) {
          const defaultTitle = defaultPrTitleForChat({
            sessionTitle: activeSession?.title ?? null,
            sourceLane: activeLane,
            lanes,
          });
          openForm({
            kind: "form",
            title: "Open PR",
            command: "pr-open",
            fields: [
              { name: "title", label: "Title", required: true, placeholder: defaultTitle, initialValue: defaultTitle },
              { name: "body", label: "Body", placeholder: "Optional" },
            ],
          });
          return;
        }
        const created = await conn.action("pr", "createFromLane", {
          laneId,
          title: args,
          body: "",
          draft: false,
        });
        setRightPane({ kind: "details", title: "PR open", body: formatPrSummary(created) });
        return;
      }
      if (!prId) {
        // The /pr commands act on the active lane's PR, so this is about the
        // lane, not about permission: any other PR is reachable from
        // `ade prs <subcommand> <pr>` with no lane involved at all.
        setRightPane({
          kind: "details",
          title: name.slice(1),
          body: "This lane has no pull request yet.\nRun /pr open to create one, or use  ade prs <subcommand> <pr>  for any other PR in the repo.",
        });
        return;
      }
      if (name === "/pr checks") {
        const checks = await conn.actionList("pr", "getChecks", [prId]).catch((err) => ({ error: err instanceof Error ? err.message : String(err) }));
        setRightPane({ kind: "details", title: "PR checks", body: formatPrChecks(checks) });
        return;
      }
      if (name === "/pr comments") {
        const comments = await conn.tool("pr_get_review_comments", { prId }).catch((err) => ({ error: err instanceof Error ? err.message : String(err) }));
        setRightPane({ kind: "details", title: "PR comments", body: formatPrComments(comments) });
        return;
      }
      const prRef = typeof activePr?.number === "number" ? `PR #${activePr.number}` : "the PR";
      if (name === "/pr land") {
        // Tokens: an optional leading `confirm`, a merge method, and optional
        // `bypass`/`admin` and `delete-remote-branch` tokens (order-independent
        // after `confirm`). e.g.
        //   /pr land squash
        //   /pr land confirm squash bypass delete-remote-branch
        const parts = args.trim().split(/\s+/).filter(Boolean);
        const tokens = parts.map((token) => token.toLowerCase());
        const confirmed = tokens[0] === "confirm";
        const rest = confirmed ? tokens.slice(1) : tokens;
        const methodArg = rest.find((token) => ["merge", "squash", "rebase"].includes(token));
        const method = (methodArg ?? "squash") as "merge" | "squash" | "rebase";
        const bypassRules = rest.some((token) => ["bypass", "admin", "--admin"].includes(token));
        // Opt-in, off by default: merging does not delete anyone's branch unless
        // they ask for it.
        // Same one spelling the CLI takes: `--delete-branch` means the LOCAL
        // branch elsewhere in ADE, so it is not accepted here.
        const deleteRemoteBranch = rest.some((token) =>
          ["delete-remote-branch", "--delete-remote-branch"].includes(token),
        );

        // Pull the authoritative merge state so the confirm step shows the same
        // blockers the desktop merge box does (and explains why bypass is needed).
        const status = await conn.actionList("pr", "getStatus", [prId]).catch(() => null);
        const readiness = status ? derivePrMergeReadiness(status) : null;
        if (!confirmed) {
          // Merging is irreversible and runs post-merge cleanup, so require an
          // explicit confirm step rather than landing on the first keystroke.
          const blockerLines = readiness && readiness.blockers.length
            ? ["", `Merge state: ${readiness.headline}`, ...readiness.blockers.map((b) => `  ✗ ${b}`)]
            : readiness
              ? ["", `Merge state: ${readiness.headline}`]
              : [];
          const bypassHint = readiness?.blockers.length
            ? readiness.canBypass
              ? `Add  bypass  to override branch protection:  /pr land confirm ${method} bypass`
              : "These must clear before the merge succeeds (you cannot bypass branch protection)."
            : null;
          setRightPane({
            kind: "details",
            title: "Land PR",
            body: [
              `About to merge ${prRef} using the "${method}" method.`,
              ...blockerLines,
              "",
              "This merges on GitHub and rebases child lanes. It cannot be undone.",
              deleteRemoteBranch
                ? "The head branch is deleted on the remote after the merge."
                : "The remote branch is kept. Add  delete-remote-branch  to remove it after the merge.",
              "",
              `Run  /pr land confirm ${method}${bypassRules ? " bypass" : ""}${deleteRemoteBranch ? " delete-remote-branch" : ""}  to proceed.`,
              "Choose a method:  /pr land confirm merge | squash | rebase",
              ...(bypassHint ? [bypassHint] : []),
            ].join("\n"),
          });
          return;
        }
        try {
          const landed = await conn.action("pr", "land", {
            prId,
            method,
            ...(bypassRules ? { bypassRules: true } : {}),
            ...(deleteRemoteBranch ? { deleteRemoteBranch: true } : {}),
          });
          addNotice(
            `Merged ${prRef} (${method}${bypassRules ? ", bypass" : ""}${deleteRemoteBranch ? ", branch deleted" : ""}).`,
            "success",
          );
          setRightPane({ kind: "details", title: "PR landed", body: renderObject(landed, 24) });
          await refreshState();
        } catch (err) {
          addNotice(err instanceof Error ? err.message : String(err), "error");
        }
        return;
      }
      if (name === "/pr close" || name === "/pr reopen") {
        const closing = name === "/pr close";
        if (closing) {
          // Closing is undoable (`/pr reopen`) but it is still a state change
          // other people see, so it takes the same explicit confirm step
          // `/pr land` does. Reopening restores the prior state, so it does not.
          const confirmed = args.trim().toLowerCase() === "confirm";
          if (!confirmed) {
            const headBranch = typeof activePr?.headBranch === "string" ? activePr.headBranch : null;
            setRightPane({
              kind: "details",
              title: "Close PR",
              body: [
                `About to close ${prRef} on GitHub.`,
                "",
                headBranch
                  ? `The branch  ${headBranch}  is kept, and /pr reopen reopens the PR.`
                  : "The branch is kept, and /pr reopen reopens the PR.",
                "",
                "Run  /pr close confirm  to proceed.",
              ].join("\n"),
            });
            return;
          }
        }
        try {
          await conn.action("pr", closing ? "closePr" : "reopenPr", { prId });
          addNotice(closing ? `Closed ${prRef}.` : `Reopened ${prRef}.`, "success");
          await refreshState();
        } catch (err) {
          addNotice(err instanceof Error ? err.message : String(err), "error");
        }
        return;
      }
      if (name === "/pr update-branch") {
        // Sync the PR branch with its base. `merge` uses GitHub's update-branch
        // API and needs nothing local; `rebase` reuses ADE's local rebase + push
        // and therefore needs a local checkout of the head branch. Mirrors the
        // desktop merge box's "Update branch" control, stale-head guard included.
        const strategyArg = args.trim().toLowerCase();
        const strategy = (strategyArg === "rebase" ? "rebase" : "merge") as "merge" | "rebase";
        // Pass the current head as the expected SHA so an update is rejected if
        // the head advanced since we last looked (matches LandPrArgs.expectedHeadSha).
        const status = await conn.actionList<Record<string, unknown>>("pr", "getStatus", [prId]).catch(() => null);
        const statusRecord = status && typeof status === "object" ? status : {};
        const expectedHeadSha =
          typeof statusRecord.headSha === "string" && statusRecord.headSha.trim()
            ? statusRecord.headSha.trim()
            : undefined;
        try {
          const result = await conn.action("pr", "updateBranch", {
            prId,
            strategy,
            ...(expectedHeadSha ? { expectedHeadSha } : {}),
          });
          const record = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
          if (record.success === true) {
            addNotice(`Updated ${prRef} branch (${strategy}).`, "success");
          } else if (record.hasConflicts === true) {
            addNotice(
              `Updating ${prRef} (${strategy}) hit conflicts — resolve them in a local checkout of the branch, then retry.`,
              "error",
            );
          } else {
            const reason = typeof record.error === "string" && record.error.trim() ? record.error.trim() : "unknown error";
            addNotice(`Could not update ${prRef} branch: ${reason}`, "error");
          }
          setRightPane({ kind: "details", title: "PR update-branch", body: renderObject(result, 24) });
          await refreshState();
        } catch (err) {
          addNotice(err instanceof Error ? err.message : String(err), "error");
        }
        return;
      }
      if (name === "/pr comment") {
        if (!args.trim()) {
          setRightPane({ kind: "details", title: "PR comment", body: "Usage: /pr comment <text>" });
          return;
        }
        try {
          await conn.action("pr", "addComment", { prId, body: args.trim() });
          addNotice(`Commented on ${prRef}.`, "success");
        } catch (err) {
          addNotice(err instanceof Error ? err.message : String(err), "error");
        }
        return;
      }
      if (name === "/pr approve" || name === "/pr request-changes") {
        const event = name === "/pr approve" ? "APPROVE" : "REQUEST_CHANGES";
        const body = args.trim();
        if (event === "REQUEST_CHANGES" && !body) {
          setRightPane({ kind: "details", title: "PR review", body: "Usage: /pr request-changes <text>" });
          return;
        }
        try {
          await conn.action("pr", "submitReview", { prId, event, ...(body ? { body } : {}) });
          addNotice(event === "APPROVE" ? `Approved ${prRef}.` : `Requested changes on ${prRef}.`, "success");
          await refreshState();
        } catch (err) {
          addNotice(err instanceof Error ? err.message : String(err), "error");
        }
        return;
      }
      const review = await Promise.all([
        conn.actionList("pr", "getReviews", [prId]).catch((err) => ({ error: err instanceof Error ? err.message : String(err) })),
        conn.actionList("pr", "getReviewThreads", [prId]).catch((err) => ({ error: err instanceof Error ? err.message : String(err) })),
        conn.actionList("pr", "getComments", [prId]).catch((err) => ({ error: err instanceof Error ? err.message : String(err) })),
      ]).then(([reviews, threads, comments]) => ({ reviews, threads, comments }));
      setRightPane({ kind: "details", title: "PR review", body: formatPrReview(review) });
      return;
    }
    if (name === "/linear" || name.startsWith("/linear ")) {
      // A hidden palette row is not access control: `/linear list` can still be
      // typed in full, restored from history, or arrive from a keybinding. The
      // gate is checked here as well, and it names the plugin so the refusal
      // reads as a move rather than a breakage. One check covers the whole
      // `/linear*` chain below, including the catch-all group.
      if (slashCommandUnavailableSurface(name, pluginInstallRecords)) {
        setRightPane({
          kind: "details",
          title: "Linear",
          body: "The Linear plugin owns this surface on this machine. Open it from the plugin instead.",
        });
        setRightOpen(true);
        return;
      }
    }
    if (name === "/linear list") {
      const linear = await conn.action("linear_issue_tracker", "listIssues", parseLinearIssueListArgs(args || "--limit 20"));
      setRightPane({ kind: "list", title: "Linear", rows: routeRows(linear), emptyText: "No Linear issues." });
      return;
    }
    if (name === "/linear status") {
      const status = await conn.action("linear_issue_tracker", "getStatus", {});
      setRightPane({ kind: "details", title: "Linear status", body: formatLinearStatus(status) });
      return;
    }
    if (name === "/linear pull") {
      if (!args) {
        setRightPane({ kind: "details", title: "Linear pull", body: "Usage: /linear pull <issue-id>" });
        return;
      }
      const issue = await conn.actionList("linear_issue_tracker", "fetchIssueById", [args]);
      if (!issue) {
        setRightPane({ kind: "details", title: "Linear pull", body: `Linear issue ${args} was not found.` });
        return;
      }
      const targetSessionId = (gridViewActiveRef.current ? focusedSessionIdForMultiView(multiViewRef.current) : null) ?? await ensureActiveSession();
      const issueContext = `Linear issue context:\n${renderObject(issue, 28)}`;
      if (targetSessionId) {
        await sendOrSteerChatMessage(targetSessionId, issueContext);
      }
      setRightPane({ kind: "details", title: "Linear pull", body: issueContext });
      return;
    }
    if (name === "/linear comment") {
      const parsed = splitFirstArg(args);
      if (!parsed.first || !parsed.rest) {
        setRightPane({ kind: "details", title: "Linear comment", body: "Usage: /linear comment <issue-id> <text>" });
        return;
      }
      const result = await conn.actionList("linear_issue_tracker", "createComment", [parsed.first, parsed.rest]);
      setRightPane({ kind: "details", title: "Linear comment", body: renderObject(result, 12) });
      addNotice(`Commented on ${parsed.first}.`, "success");
      return;
    }
    if (name === "/linear comments") {
      const issueId = args?.trim();
      if (!issueId) {
        setRightPane({ kind: "details", title: "Linear comments", body: "Usage: /linear comments <issue-id>" });
        return;
      }
      const comments = await conn.tool("getLinearIssueComments", { issueId });
      setRightPane({ kind: "details", title: `Linear comments · ${issueId}`, body: formatLinearIssueComments(comments) });
      return;
    }
    if (name === "/linear assign") {
      const parsed = splitFirstArg(args);
      if (!parsed.first || !parsed.rest) {
        setRightPane({ kind: "details", title: "Linear assign", body: "Usage: /linear assign <issue-id> <user-id|none>" });
        return;
      }
      const normalizedAssignee = parsed.rest.toLowerCase();
      const assigneeId = normalizedAssignee === "none" || normalizedAssignee === "null" || normalizedAssignee === "unassigned"
        ? null
        : parsed.rest;
      await conn.actionList("linear_issue_tracker", "updateIssueAssignee", [parsed.first, assigneeId]);
      setRightPane({
        kind: "details",
        title: "Linear assign",
        body: assigneeId ? `Assigned ${parsed.first} to ${assigneeId}.` : `Cleared assignee for ${parsed.first}.`,
      });
      addNotice(`Updated ${parsed.first}.`, "success");
      return;
    }
    if (name === "/linear" || name.startsWith("/linear ")) {
      const linearInput = `${name.slice("/linear".length)} ${args}`.trim();
      const request = buildLinearToolRequest(linearInput);
      if (request.kind === "usage") {
        setRightPane({ kind: "details", title: request.title, body: request.body });
        return;
      }
      setRightPane({ kind: "details", title: request.title, body: "Loading Linear data..." });
      if (request.kind === "action") {
        // Session-scoped attach/detach/list default to the active chat session:
        // the ACTIVE_SESSION_PLACEHOLDER sentinel on chatSessionId is substituted
        // with the live id.
        const actionArgs = { ...request.args };
        if (actionArgs.chatSessionId === ACTIVE_SESSION_PLACEHOLDER) {
          if (!sessionId) {
            setRightPane({ kind: "details", title: request.title, body: "No active chat session. Pass --session <id>." });
            return;
          }
          actionArgs.chatSessionId = sessionId;
        }
        const result = await conn.action(request.domain, request.action, actionArgs);
        setRightPane({ kind: "details", title: request.title, body: renderObject(result, 24) });
        return;
      }
      if (request.kind === "actionList") {
        const argsList = request.argsList.map((entry) =>
          entry === ACTIVE_SESSION_PLACEHOLDER ? sessionId : entry,
        );
        if (argsList.some((entry) => entry == null)) {
          setRightPane({ kind: "details", title: request.title, body: "No active chat session. Pass --session <id>." });
          return;
        }
        const result = await conn.actionList(request.domain, request.action, argsList);
        setRightPane({ kind: "details", title: request.title, body: renderObject(result, 24) });
        return;
      }
      const result = await conn.tool(request.toolName, request.args);
      setRightPane({ kind: "details", title: request.title, body: renderObject(result, 24) });
      return;
    }
    if (name === "/issue" || name.startsWith("/issue ")) {
      const issueInput = `${name.slice("/issue".length)} ${args}`.trim();
      // `/issue` has two issue sources and only one of them is a plugin
      // surface, which is why the row carries no `builtin` of its own: gating
      // the command wholesale would take core GitHub attach down with an
      // uninstalled Linear plugin. Only the Linear half steps aside, the same
      // split the desktop composer makes (AgentChatComposer.tsx). Attach is the
      // half that reaches ADE's compiled Linear integration; list and detach
      // read and write the lane's own issue links, which the plugin does not
      // own and which a user still needs on an already-attached issue.
      if (buildIssueToolRequest(issueInput).kind === "linearAttach"
        && !builtinSurfaceDrawn("linear", pluginInstallRecords)) {
        setRightPane({
          kind: "details",
          title: "Issue attach",
          body: "The Linear plugin owns Linear issues on this machine. Attach it from the plugin instead. GitHub issues still attach here.",
        });
        setRightOpen(true);
        return;
      }
      await executeIssueToolRequest(issueInput, {
        sessionId: sessionId ?? null,
        conn,
        setDetails: (title, body) => setRightPane({ kind: "details", title, body }),
        notifySuccess: (message) => addNotice(message, "success"),
        render: renderObject,
      });
      return;
    }
    if (name === "/feedback") {
      openFeedbackForm();
      return;
    }
    if (name === "/chats") {
      setRightChatsClosedExpanded(false);
      openChatsListPane(args, false);
      return;
    }
    if (name === "/switch") {
      const query = args.trim().toLowerCase();
      if (!query) {
        const selectedIndex = Math.max(0, lanes.findIndex((lane) => lane.id === laneId));
        setRightSelectionIndex(selectedIndex);
        setRightPane({
          kind: "list",
          title: "Switch",
          rows: lanes.map((lane) => `${lane.id === laneId ? "●" : "○"} ${lane.name}`),
          emptyText: "No lanes.",
          action: { kind: "switch-lane", ids: lanes.map((lane) => lane.id) },
        });
        return;
      }
      const exactLane = lanes.find((entry) => entry.id.toLowerCase() === query || entry.name.toLowerCase() === query) ?? null;
      const exactChat = displaySessions.find((entry) => (
        entry.sessionId.toLowerCase() === query
        || (entry.title ?? "").toLowerCase() === query
      )) ?? null;
      const lane = exactLane ?? lanes.find((entry) => entry.id.toLowerCase().includes(query) || entry.name.toLowerCase().includes(query)) ?? null;
      const chat = exactChat ?? displaySessions.find((entry) => (
        entry.sessionId.toLowerCase().includes(query)
        || (entry.title ?? "").toLowerCase().includes(query)
      )) ?? null;
      if (exactLane || (lane && !exactChat)) {
        activateLaneWithLastChat(exactLane ?? lane!, { notify: true });
      } else if (chat) {
        selectActiveLaneId(chat.laneId);
        setDrawerLaneId(chat.laneId);
        setSelectedDrawerLaneId(chat.laneId);
        setSelectedWorkChatAction(null);
        setSelectedDrawerChatId(chat.sessionId);
        applyDrawerChatSelection({ session: chat, action: null });
        addNotice(`Switched to chat ${chat.title ?? chat.sessionId}.`, "success");
      } else {
        setRightPane({ kind: "details", title: "Switch", body: `No lane or chat matched "${args}".` });
      }
      return;
    }
    if (
      name === "/run-next"
      || name === "/edit-message"
      || name === "/dismiss-message"
    ) {
      if (activeTerminalSessionRef.current) {
        setRightPane({
          kind: "details",
          title: "Unprocessed message",
          body: "Message recovery is available for Work chats, not CLI terminals.",
        });
        return;
      }
      const request = resolveTuiUnprocessedMessageRequest({
        input: args,
        sessionId,
      });
      if (!request) {
        setRightPane({
          kind: "details",
          title: "Unprocessed message",
          body: `Usage: ${name} <steer-id> [session-id]`,
        });
        return;
      }
      if (name === "/edit-message") {
        const targetEvents = eventsBySessionIdRef.current[request.sessionId]
          ?? (request.sessionId === sessionId ? eventsRef.current : []);
        const restoredText = resolveTuiUnprocessedMessageDraft({
          steerId: request.steerId,
          events: targetEvents,
        });
        if (!restoredText) {
          const message = "That unresolved message is not available in the loaded chat transcript.";
          setRightPane({ kind: "details", title: "Unprocessed message", body: message });
          addNotice(message, "error");
          return;
        }
        chatDraftRef.current = restoredText;
        focusChat();
        addNotice("Restored unprocessed message to the composer.", "success");
        return;
      }
      const action = name === "/run-next" ? "run_next" : "dismiss";
      try {
        const result = await resolveUnprocessedMessage(conn, { ...request, action });
        const label = action === "run_next"
          ? result.status === "already_completed"
            ? "Message was already started as the next turn"
            : "Started message as the next turn"
          : result.status === "already_completed"
            ? "Message was already dismissed"
            : "Dismissed unprocessed message";
        setRightPane({
          kind: "details",
          title: "Unprocessed message",
          body: `${label}\nMessage ${result.steerId}`,
        });
        addNotice(label, "success");
        await refreshState();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setRightPane({ kind: "details", title: "Unprocessed message", body: message });
        addNotice(message, "error");
      }
      return;
    }
    if (name === "/recover") {
      if (!sessionId || activeTerminalSessionRef.current) {
        setRightPane({
          kind: "details",
          title: "Turn recovery",
          body: "Recovery is available for an active Work chat, not a CLI terminal.",
        });
        return;
      }
      const request = resolveTuiRecoveryRequest({
        input: args,
        sessionId,
        events: eventsRef.current,
      });
      if (!request) {
        setRightPane({
          kind: "details",
          title: "Turn recovery",
          body: [
            "Usage: /recover <wait|nudge|retry|resume> [turn-id]",
            "",
            "resume restarts the provider runtime and resumes the turn.",
            "retry keeps the current provider runtime and retries the same turn.",
            "The turn id is optional when this chat has a recent stalled-turn notice.",
          ].join("\n"),
        });
        return;
      }
      const targetProvider = request.provider ?? resolveTuiRecoveryTargetProvider({
        targetSessionId: request.sessionId,
        visibleSessionId: sessionId,
        visibleProvider: activeSession?.provider,
        sessions,
      });
      try {
        const result = await recoverTurn(conn, {
          sessionId: request.sessionId,
          turnId: request.turnId,
          action: request.action,
        }, {
          allowLegacyCodexFallback: targetProvider === "codex",
        });
        const label = request.action === "wait"
          ? "Keeping the current turn open"
          : request.action === "nudge"
            ? "Status nudge sent"
            : request.action === "retry_same_runtime"
              ? "Retrying on the same provider runtime"
              : "Provider runtime restarted; turn resumed";
        setRightPane({
          kind: "details",
          title: "Turn recovery",
          body: `${label} · ${result.status}\nTurn ${result.turnId}`,
        });
        addNotice(label, "success");
        await refreshState();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setRightPane({ kind: "details", title: "Turn recovery", body: message });
        addNotice(message, "error");
      }
      return;
    }
    if (name === "/model") {
      openModelWizard();
      return;
    }
    if (name === "/effort") {
      openModelWizard({ startAtSettings: true });
      return;
    }
    if (name === "/import") {
      // Single home for external-session import. Outside a new chat it explains
      // itself instead of silently doing nothing.
      if (!draftChatActiveRef.current) {
        addNotice("Import only applies when starting a new chat — run /new chat first, then /import.", "info");
        return;
      }
      openExternalSessionBrowser();
      return;
    }
    if (name === "/info") {
      if (!subagentPaneCommandAvailable) {
        setRightPane({
          kind: "details",
          title: "Chat info",
          body: "No active chat is selected. Start or open a chat to inspect plan, goal, and agents.",
        });
        return;
      }
      openSubagentsPane();
      return;
    }
    if (
      name === "/chat ask"
      || name === "/chat note"
      || name === "/chat settle"
      || name === "/chat unsettle"
    ) {
      const targetSessionId = activeSessionIdRef.current;
      if (!targetSessionId) {
        setRightPane({
          kind: "details",
          title: "Session lifecycle",
          body: "No active chat or CLI session is selected.",
        });
        return;
      }
      const value = args.trim();
      try {
        if (name === "/chat ask") {
          if (!value) {
            setRightPane({
              kind: "details",
              title: "Chat ask",
              body: "Usage: /chat ask <blocking question>",
            });
            return;
          }
          await requestSessionAttention(conn, targetSessionId, value);
          addNotice("Escalated the blocking question.", "success");
        } else if (name === "/chat note") {
          await setSessionStatusNote(conn, targetSessionId, value);
          addNotice(value ? "Updated the session status line." : "Cleared the session status line.", "success");
        } else if (name === "/chat settle") {
          const targetSession = displaySessions.find((session) => session.sessionId === targetSessionId);
          const dismissPendingInput = Boolean(
            targetSession?.awaitingInput
              || (targetSession as TuiChatSessionSummary | undefined)?.attentionRequestedAt,
          );
          await settleSession(conn, targetSessionId, value || undefined, { dismissPendingInput });
          addNotice(
            dismissPendingInput
              ? "Dismissed the pending input and settled the session."
              : "Marked the session settled.",
            "success",
          );
        } else {
          await unsettleSession(conn, targetSessionId);
          addNotice("Removed the session's settled state.", "success");
        }
        await refreshState();
      } catch (err) {
        addNotice(err instanceof Error ? err.message : String(err), "error");
      }
      return;
    }
    if (name === "/session") {
      setRightPane({
        kind: "details",
        title: "Session lifecycle",
        body: [
          "Usage: /session <verb> [session-id] …  (omit the id to target the active session)",
          "",
          "  /session snooze [id] [30m|1h|4h|1d]  hide the row until a deadline",
          "  /session wake [id]                   bring a snoozed row back now",
          "  /session settle [id] [outcome]       file the row as done",
          "  /session unsettle [id]               undo a settle",
          "  /session keep-active [id]            pin the row active against a later settle",
          "  /session demote [id]                 take over a subagent so reports stop",
          "  /session promote [id]                restore a peer as a subagent",
          "",
          "Run /session snooze with no duration to pick one from the list.",
        ].join("\n"),
      });
      return;
    }
    // `/session <verb> [<session-id>] …` — the same lifecycle verbs as
    // `ade session`, with per-session targeting. Omitting the id targets the
    // active session, matching `/chat settle`.
    const lifecycleVerb: SessionLifecycleCommand | null = sessionLifecycleCommandFor(name);
    if (lifecycleVerb) {
      const target = resolveSessionTarget({
        input: args,
        activeSessionId: activeSessionIdRef.current,
        knownSessionIds: displaySessions.map((session) => session.sessionId),
        // wake/unsettle/keep-active take no other argument, so a leading token
        // that names no session is a typo rather than a passthrough.
        strictLeadingToken: lifecycleVerb !== "snooze" && lifecycleVerb !== "settle",
      });
      if (!target.ok) {
        setRightPane({ kind: "details", title: "Session lifecycle", body: target.message });
        return;
      }
      const targetSession = displaySessions.find((session) => session.sessionId === target.sessionId);
      const targetLabel = targetSession?.title?.trim() || target.sessionId;
      const scope = target.explicit ? ` · ${targetLabel}` : "";
      try {
        if (lifecycleVerb === "snooze") {
          if (!target.rest) {
            openSnoozeDurationPalette(target.sessionId, targetLabel);
            return;
          }
          const resolved = resolveSnoozeFreeText(target.rest);
          if (!resolved.ok) {
            setRightPane({ kind: "details", title: "Session snooze", body: resolved.message });
            return;
          }
          await applySessionSnooze(target.sessionId, resolved.untilIso, `${resolved.confirmation}${scope}`);
          return;
        }
        if (lifecycleVerb === "wake") {
          await wakeSession(conn, target.sessionId, "manual");
          addNotice(`Woke the session.${scope}`, "success");
        } else if (lifecycleVerb === "settle") {
          const dismissPendingInput = Boolean(
            targetSession?.awaitingInput
              || (targetSession as TuiChatSessionSummary | undefined)?.attentionRequestedAt,
          );
          await settleSession(conn, target.sessionId, target.rest || undefined, { dismissPendingInput });
          addNotice(
            `${dismissPendingInput
              ? "Dismissed the pending input and settled the session."
              : "Marked the session settled."}${scope}`,
            "success",
          );
        } else if (lifecycleVerb === "unsettle") {
          await unsettleSession(conn, target.sessionId);
          addNotice(`Removed the session's settled state.${scope}`, "success");
        } else if (lifecycleVerb === "demote") {
          await setChatSpawnKind(conn, target.sessionId, "peer");
          addNotice(`Took over the chat. Reports to the parent stop.${scope}`, "success");
        } else if (lifecycleVerb === "promote") {
          await setChatSpawnKind(conn, target.sessionId, "subagent");
          addNotice(`Restored the chat as a subagent. Reports resume.${scope}`, "success");
        } else if (lifecycleVerb === "keep-active") {
          // keep-active: the tri-state override's "active" pin. It suppresses
          // the settled tier for a row even if something later writes
          // settled_at (e.g. the PR-merge policy), so the user can hold a row
          // in the active list. Nothing DERIVES a settle — a clean process
          // exit is "ended", never "settled" (see sessionCanonicalState.ts).
          await setSessionSettleOverride(conn, target.sessionId, "active");
          addNotice(`Pinned the session active.${scope}`, "success");
        } else {
          const _exhaustive: never = lifecycleVerb;
          return _exhaustive;
        }
        await refreshState();
      } catch (err) {
        addNotice(err instanceof Error ? err.message : String(err), "error");
      }
      return;
    }
    if (name === "/system") {
      setRightPane({
        kind: "details",
        title: "System",
        body: formatSystemDetails({ project, pid: process.pid, mode: "ready" }),
      });
      return;
    }
    if (name === "/ade") {
      const parsed = splitFirstArg(args);
      const possibleBuiltin = parsed.first.startsWith("/") ? parsed.first : `/${parsed.first}`;
      const alias = possibleBuiltin !== "/ade"
        ? parseCommand(`${possibleBuiltin}${parsed.rest ? ` ${parsed.rest}` : ""}`, [])
        : null;
      if (alias?.spec?.placement === "right") {
        await runRightCommand(alias.name, alias.args);
        return;
      }
      if (alias?.spec?.placement === "inline") {
        setRightPane({
          kind: "details",
          title: "ADE command",
          body: `/${parsed.first.replace(/^\//, "")} is an inline TUI command. Run it before creating a runtime chat, or use the keyboard shortcut when available.`,
        });
        return;
      }
      const [domain, action] = parsed.first.split(".", 2);
      if (!domain || !action) {
        setRightPane({
          kind: "details",
          title: "ADE action",
          body: "Usage: /ade <domain.action|status|diff|model|help> [json-object|json-array|json-scalar]",
        });
        return;
      }
      const result = await conn.tool("run_ade_action", {
        domain,
        action,
        ...parseAdeActionPayload(parsed.rest),
      });
      const body = result && typeof result === "object" && "result" in result
        ? (result as { result?: unknown }).result
        : result;
      setRightPane({ kind: "details", title: `ADE ${domain}.${action}`, body: renderObject(body, 24) });
    }
  }, [activateLaneWithLastChat, activeCommandProvider, activeLane, activeMachineKey, activeProjectRoot, activeSession?.provider, activeSession?.sessionId, activeSession?.title, addNotice, applyDrawerChatSelection, applySessionSnooze, archiveChat, archiveLane, displaySessions, ensureActiveSession, focusChat, focusDetails, hopToMachine, lanes, mode, modelState.modelId, modelState.provider, modelState.reasoningEffort, models, openChatDeleteForm, openChatRenameForm, openChatsListPane, openExternalSessionBrowser, openFeedbackForm, openForm, openLaneDeleteForm, openLaneDetailsPane, openLaneRenameForm, openModelWizard, openNewChatSetup, openNewLaneForm, openPluginActionsPane, openPluginPane, openProjectPicker, openSecretsPane, openSnoozeDurationPalette, openSubagentsPane, pendingSteers, project, refreshState, renameLane, runLaneSetupAfterCreate, selectActiveLaneId, selectActiveSessionId, sendOrSteerChatMessage, sessions, setChatScrollOffset, subagentPaneCommandAvailable, switchProjectOnCurrentMachine, unarchiveChat, unarchiveLane, workSelectedRow]);

  const runInlineCommand = useCallback(async (name: string, args: string) => {
    if (name === "/quit") {
      requestAppExit();
      return;
    }
    if (name === "/clear") {
      setClearedAt(new Date().toISOString());
      clearOlderHistoryCursor(activeSessionIdRef.current);
      eventDedupKeysRef.current.clear();
      eventDedupKeyOrderRef.current = [];
      eventCountRef.current = 0;
      setEvents([]);
      setChatScrollOffset(0);
      addNotice("Local transcript view cleared. The durable chat remains in ADE.", "info");
      return;
    }
    const conn = connectionRef.current;
    if (!conn) return;
    const laneId = activeLaneIdRef.current;
    const sessionId = activeSessionIdRef.current;
    if (name === "/login") {
      const requestedProvider = args.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
      if (requestedProvider && !TUI_PROVIDERS.has(requestedProvider as AdeCodeProvider)) {
        addNotice(`Unknown provider "${requestedProvider}". Try one of: ${TUI_PROVIDER_OPTIONS.map((entry) => entry.value).join(", ")}.`, "error");
        return;
      }
      const provider = requestedProvider
        ? requestedProvider as AdeCodeProvider
        : normalizeProvider(activeSession?.provider ?? modelState.provider);
      const loginCommands = loginCommandsForProvider(provider);
      if (!loginCommands.length) {
        addNotice(`/login is not available for ${providerLabel(provider)}. ${loginUnavailableHint(provider)}`, "error");
        return;
      }
      let selectedLogin: ProviderLoginCommand | null = null;
      let code: number | null = null;
      let ranLogin = false;
      for (const login of loginCommands) {
        selectedLogin = login;
        addNotice(`Starting \`${login.label}\` in this terminal.`, "info");
        try {
          code = await runInteractiveTerminalCommand(login.command, login.args, project.projectRoot);
          ranLogin = true;
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            continue;
          }
          throw error;
        }
      }
      if (!selectedLogin || !ranLogin) {
        addNotice(`Could not find a ${providerLabel(provider)} login command on PATH.`, "error");
        return;
      }
      if (code === 0) {
        addNotice(`${providerLabel(provider)} auth completed. Refreshing provider status.`, "success");
        await refreshAiSetupStatus({ force: true });
        await loadProviderModels(provider, { applyDefault: false });
        const activeProvider = normalizeProvider(activeSessionRef.current?.provider ?? modelStateRef.current.provider);
        if (provider === activeProvider) {
          const failedPrompt = latestAuthFailedPrompt(eventsRef.current);
          if (failedPrompt) {
            setPrompt(failedPrompt);
            promptRef.current = failedPrompt;
            promptCursorRef.current = failedPrompt.length;
            chatDraftRef.current = failedPrompt;
            addNotice("logged in — press Enter to resend", "info");
            focusChat();
          }
        }
      } else {
        addNotice(`${providerLabel(provider)} login exited with code ${code ?? "unknown"}.`, "error");
      }
      return;
    }
    if (name === "/reconnect") {
      // The one way back from an account-side machine removal, mirroring
      // `ade machines reconnect` and the desktop Account page's button. The
      // brain re-registers as a deliberate pairing and lifts the push gate, so
      // Activity resumes without restarting ADE Code.
      addNotice("Reconnecting this computer to your ADE account…", "info");
      let raw: unknown;
      try {
        raw = await conn.request<unknown>("account.call", {
          action: "repairMachinePairing",
          args: {},
        });
      } catch (error) {
        addNotice(error instanceof Error ? error.message : String(error), "error");
        return;
      }
      const envelope = raw && typeof raw === "object" && !Array.isArray(raw)
        ? raw as Record<string, unknown>
        : {};
      const result = envelope.result && typeof envelope.result === "object" && !Array.isArray(envelope.result)
        ? envelope.result as Record<string, unknown>
        : envelope;
      if (result.repaired === true) {
        addNotice("This computer is reconnected to your ADE account.", "success");
        await refreshActivityPane();
        return;
      }
      // The directory refuses a re-pair without proof of a freshly completed
      // interactive sign-in, and only its own device flow can produce that
      // proof. ADE Code cannot host that flow, so point at the command that
      // carries it rather than dead-ending on the refusal.
      const reason = typeof result.reason === "string" && result.reason.trim()
        ? result.reason.trim()
        : "This computer is still disconnected from your ADE account.";
      addNotice(`${reason} Run \`ade machines reconnect\` in a terminal to finish.`, "error");
      return;
    }
    if (name === "/commit") {
      if (!laneId) {
        addNotice("No active lane is selected.", "error");
        return;
      }
      if (!args) {
        addNotice("Usage: /commit <message>", "error");
        return;
      }
      const result = await conn.action("git", "commit", { laneId, message: args });
      addNotice(`Commit complete: ${renderObject(result, 4).replace(/\n/g, " ")}`, "success");
      return;
    }
    if (name === "/push") {
      if (!laneId) {
        addNotice("No active lane is selected.", "error");
        return;
      }
      const result = await conn.action("git", "push", { laneId });
      addNotice(`Push complete: ${renderObject(result, 4).replace(/\n/g, " ")}`, "success");
      return;
    }
    if (name === "/pull") {
      if (!laneId) {
        addNotice("No active lane is selected.", "error");
        return;
      }
      const tokens = args.split(/\s+/).filter(Boolean);

      // Resolve an in-progress conflict from a previous pull/reparent.
      if (tokens.includes("--continue") || tokens.includes("--abort")) {
        const wantContinue = tokens.includes("--continue");
        const state = await conn.action<GitConflictState>("git", "getConflictState", { laneId });
        if (!state?.inProgress || !state.kind) {
          addNotice("No merge or rebase conflict is in progress for this lane.", "info");
          return;
        }
        if (wantContinue) {
          if (state.conflictedFiles.length > 0) {
            const report = formatGitConflictReport(state);
            setRightPane({ kind: "details", title: report.title, body: report.body });
            setRightOpen(true);
            addNotice(`Still ${state.conflictedFiles.length} unresolved file(s). Resolve them, then /pull --continue.`, "error");
            return;
          }
          await conn.action("git", state.kind === "rebase" ? "rebaseContinue" : "mergeContinue", { laneId });
          addNotice(`${state.kind === "rebase" ? "Rebase" : "Merge"} continued.`, "success");
        } else {
          await conn.action("git", state.kind === "rebase" ? "rebaseAbort" : "mergeAbort", { laneId });
          addNotice(`${state.kind === "rebase" ? "Rebase" : "Merge"} aborted.`, "success");
        }
        await refreshState();
        return;
      }

      const modeFlags = tokens.filter((token) => token === "--ff-only" || token === "--rebase" || token === "--merge");
      if (modeFlags.length > 1) {
        addNotice("Choose only one pull mode: --ff-only, --rebase, or --merge.", "error");
        return;
      }
      const flagMode = modeFlags[0]?.slice(2);
      const explicitModeIdx = tokens.indexOf("--mode");
      const explicitMode = explicitModeIdx === -1 ? undefined : tokens[explicitModeIdx + 1];
      if (explicitMode && flagMode) {
        addNotice("Choose pull mode with either --mode or a mode flag, not both.", "error");
        return;
      }
      const rawMode = flagMode ?? explicitMode;
      const mode = rawMode === "ff_only" ? "ff-only" : rawMode;
      if (mode && mode !== "ff-only" && mode !== "rebase" && mode !== "merge") {
        addNotice("Pull mode must be ff-only, rebase, or merge.", "error");
        return;
      }
      const result = await conn.action("git", "pull", { laneId, ...(mode ? { mode } : {}) });
      // Pull/rebase reports success even when it stops on conflicts (the working
      // tree is left mid-merge). Check before claiming success.
      const conflict = await conn
        .action<GitConflictState>("git", "getConflictState", { laneId })
        .catch(() => null);
      if (conflict?.inProgress && conflict.kind) {
        const report = formatGitConflictReport(conflict);
        setRightPane({ kind: "details", title: report.title, body: report.body });
        setRightOpen(true);
        addNotice(report.summary, "error");
        return;
      }
      addNotice(`Pull complete: ${renderObject(result, 4).replace(/\n/g, " ")}`, "success");
      return;
    }
    if (name === "/undo") {
      if (!laneId) {
        addNotice("No active lane is selected.", "error");
        return;
      }
      const result = await conn.action("git", "undoLastHeadChange", { laneId });
      addNotice(`Undo complete: ${renderObject(result, 4).replace(/\n/g, " ")}`, "success");
      return;
    }
    if (name === "/redo") {
      if (!laneId) {
        addNotice("No active lane is selected.", "error");
        return;
      }
      const result = await conn.action("git", "redoLastHeadChange", { laneId });
      addNotice(`Redo complete: ${renderObject(result, 4).replace(/\n/g, " ")}`, "success");
      return;
    }
    if (name === "/stage all") {
      if (!laneId) {
        addNotice("No active lane is selected.", "error");
        return;
      }
      const result = await conn.action("git", "stageAll", { laneId });
      addNotice(`Stage all complete: ${renderObject(result, 4).replace(/\n/g, " ")}`, "success");
      return;
    }
    if (name === "/stop") {
      if (!sessionId) {
        addNotice("No active chat is selected.", "error");
        return;
      }
      const normalizedMode = args.trim().toLowerCase();
      let mode: AgentChatStopMode;
      if (!normalizedMode || normalizedMode === "clear-queue" || normalizedMode === "--clear-queue") {
        mode = "stop_and_clear";
      } else if (
        normalizedMode === "keep-queue"
        || normalizedMode === "--keep-queue"
        || normalizedMode === "stop-only"
        || normalizedMode === "--stop-only"
      ) {
        mode = "stop_only";
      } else {
        addNotice("Usage: /stop [keep-queue|clear-queue]", "error");
        return;
      }
      setStreaming(false);
      setInterrupted(true);
      const result = await interruptChat(conn, sessionId, mode);
      addNotice(chatInterruptNotice(result), "info");
      return;
    }
    if (name === "/restore-queue") {
      if (!sessionId) {
        addNotice("No active chat is selected.", "error");
        return;
      }
      const recoveryId = args.trim();
      if (!recoveryId) {
        addNotice("Usage: /restore-queue <recovery-id>", "error");
        return;
      }
      const result = await restoreCancelledQueue(conn, sessionId, recoveryId);
      if (!result.restored) {
        addNotice("That queue recovery is no longer available.", "error");
        return;
      }
      addNotice(`Restored ${result.restoredCount} queued message${result.restoredCount === 1 ? "" : "s"}.`, "success");
      await refreshState();
      return;
    }
    if (name.startsWith("/steer")) {
      if (!sessionId) {
        addNotice("No active chat is selected.", "error");
        return;
      }
      const latestSteer = pendingSteers[pendingSteers.length - 1] ?? null;
      if (!latestSteer) {
        addNotice("No staged steer message is waiting.", "info");
        return;
      }
      if (name === "/steer cancel") {
        await cancelSteerMessage(conn, sessionId, latestSteer.steerId);
        addNotice("Removed staged steer message.", "success");
        await refreshState();
        return;
      }
      if (name === "/steer edit") {
        if (!args.trim()) {
          addNotice("Usage: /steer edit <text>", "error");
          return;
        }
        await editSteerMessage(conn, sessionId, latestSteer.steerId, args.trim());
        addNotice("Updated staged steer message.", "success");
        await refreshState();
        return;
      }
      if (name === "/steer send" || name === "/steer interrupt") {
        // Which modes each provider honors lives in one table (desktop
        // shared/types/chat.ts); this branch only maps commands onto it.
        const provider = activeSession?.provider;
        const mode = name === "/steer send" ? "inline" : "interrupt";
        if (!supportsActiveTurnDispatchMode(provider, mode)) {
          addNotice(unsupportedActiveTurnDispatchModeMessage(provider, mode), "error");
          return;
        }
        const agentLabel = providerDisplayLabel(provider, "the agent");
        // Cursor's interrupt cancels the run and resends on the same thread, so
        // it continues rather than starting something new — same wording the
        // desktop composer and iOS use, off the same shared fact.
        const interruptContinues = activeTurnInterruptContinues(provider);
        await dispatchSteerMessage(conn, sessionId, latestSteer.steerId, mode);
        addNotice(
          mode === "inline"
            ? `Sent staged message into the active ${agentLabel} turn.`
            : interruptContinues
              ? `Interrupting ${agentLabel} and continuing with the staged message.`
              : `Interrupting ${agentLabel} to run the staged message.`,
          "info",
        );
        await refreshState();
        return;
      }
    }
    if (name === "/open") {
      const target = sessionId
        ? { kind: "chat" as const, sessionId, laneId }
        : laneId
          ? { kind: "lane" as const, laneId }
          : { kind: "work" as const };
      const result = await navigateDesktop(conn, { source: "ade-code", target });
      if (result.ok) {
        addNotice("Opened ADE desktop at this context.", "success");
        return;
      }
      if (process.platform === "darwin") {
        spawn("open", [
          "-a",
          "ADE",
          "--env",
          `ADE_PROJECT_ROOT=${project.projectRoot}`,
          project.projectRoot,
        ], { stdio: "ignore", detached: true }).unref();
        addNotice(result.message ?? "Desktop route unavailable; launched ADE.", "info");
        for (let attempt = 0; attempt < 8; attempt += 1) {
          await delay(750);
          const attached = await connectToAde({ project, forceEmbedded: false, socketPath, preferServiceRepair, remote: remoteLaunch, projectRegistration: INTERACTIVE_PROJECT_REGISTRATION }).catch(() => null);
          if (!attached || attached.mode !== "attached") {
            await attached?.close().catch(() => {});
            continue;
          }
          const retry = await navigateDesktop(attached, { source: "ade-code", target }).catch(() => null);
          if (!retry?.ok) {
            await attached.close().catch(() => {});
            continue;
          }
          const previous = connectionRef.current;
          connectionRef.current = attached;
          setConnection(attached);
          setMode(attached.mode);
          await previous?.close().catch(() => {});
          addNotice("Opened ADE desktop at this context.", "success");
          await refreshState();
          return;
        }
      } else {
        addNotice(result.message ?? "Desktop route unavailable from this runtime.", "error");
      }
    }
  }, [activeSession?.provider, addNotice, applyLocalModelArg, applySessionSnooze, clearOlderHistoryCursor, displaySessions, loadProviderModels, modelState.provider, openSnoozeDurationPalette, pendingSteers, preferServiceRepair, project, refreshAiSetupStatus, refreshActivityPane, refreshState, remoteLaunch, requestAppExit, scheduleModelStateCommit, sendClaudeModelCommandToTerminal, setChatScrollOffset, socketPath]);

  const submitRightForm = useCallback(async (
    form: Extract<RightPaneContent, { kind: "form" }>,
    values: Record<string, string>,
  ) => {
    const conn = connectionRef.current;
    const laneId = activeLaneIdRef.current;
    const sessionId = activeSessionIdRef.current;
    if (!conn) return;
    if (submitRightFormInFlightRef.current) return;
    submitRightFormInFlightRef.current = true;

    try {
    const requireField = (name: string, label: string): string | null => {
      const value = values[name]?.trim() ?? "";
      if (value) return value;
      addNotice(`${label} is required.`, "error");
      return null;
    };

    if (form.command === "new-lane") {
      const name = requireField("name", "Name");
      if (!name) return;
      const linearIssueInput = values.linearIssue?.trim() ?? "";
      if (normalizeNewLaneStart(values.start) === "import" && linearIssueInput) {
        addNotice("Linear issue attachment is not supported when importing an existing branch.", "error");
        return;
      }
      const linearIssue = linearIssueInput
        ? await resolveLinearIssueForNewLane(conn, linearIssueInput).catch((err) => {
            addNotice(`Linear issue lookup failed: ${err instanceof Error ? err.message : String(err)}`, "error");
            return undefined;
          })
        : null;
      if (linearIssue === undefined) return;
      if (linearIssueInput && !linearIssue) {
        addNotice(`No Linear issue matched "${linearIssueInput}".`, "error");
        return;
      }
      const submission = buildNewLaneSubmission({ values, lanes, activeLaneId, linearIssue });
      if (submission.kind === "error") {
        addNotice(submission.message, "error");
        return;
      }
      const created = submission.kind === "createChild"
        ? await conn.action<LaneSummary>("lane", "createChild", submission.payload)
        : submission.kind === "importBranch"
          ? await conn.action<LaneSummary>("lane", "importBranch", submission.payload)
          : await conn.action<LaneSummary>("lane", "create", submission.payload);
      // Desktop-parity color picker: lane create payloads don't carry a color,
      // so apply the chosen swatch via lane.updateAppearance after creation.
      // Best-effort — the lane exists either way, so skip silently on failure.
      if (submission.color) {
        try {
          await conn.action("lane", "updateAppearance", { laneId: created.id, color: submission.color });
        } catch {
          // Lane created fine; the color just falls back to auto.
        }
      }
      selectActiveLaneId(created.id);
      selectActiveSessionId(null);
      setDrawerLaneId(created.id);
      setSelectedDrawerLaneId(created.id);
      setSelectedDrawerChatId(null);
      setSelectedWorkChatAction(null);
      setWorkSelectedKey(`lane:${created.id}`);
      // Land on the new lane's details pane (same view as highlighting a lane
      // in the sessions pane) instead of closing the right pane to empty.
      setRightPane(seedLaneDetails(
        submission.color ? { ...created, color: submission.color } : created,
      ));
      setRightOpen(true);
      lastUserOpenedPaneRef.current = null;
      focusAfterDetails();
      addNotice(`Created lane ${created.name}.`, "success");
      runLaneSetupAfterCreate(conn, created, { templateId: submission.templateId });
      await refreshState();
      setDrawerLaneId(created.id);
      setSelectedDrawerLaneId(created.id);
      return;
    }

    if (form.command === "new-lane-from-unstaged") {
      const sourceLaneId = form.laneId ?? activeLaneIdRef.current;
      if (!sourceLaneId) {
        addNotice("No active lane to rescue from.", "error");
        return;
      }
      const name = requireField("name", "Name");
      if (!name) return;
      try {
        const created = await conn.action<LaneSummary>("lane", "createFromUnstaged", {
          sourceLaneId,
          name,
        });
        selectActiveLaneId(created.id);
        selectActiveSessionId(null);
        setDrawerLaneId(created.id);
        setSelectedDrawerLaneId(created.id);
        setSelectedDrawerChatId(null);
        setSelectedWorkChatAction(null);
        setWorkSelectedKey(`lane:${created.id}`);
        setRightOpen(false);
        setRightPane({ kind: "empty" });
        lastUserOpenedPaneRef.current = null;
        focusAfterDetails();
        addNotice(`Moved unstaged work to ${created.name}.`, "success");
        await refreshState();
      } catch (err) {
        addNotice(err instanceof Error ? err.message : String(err), "error");
      }
      return;
    }

    if (form.command === "rename") {
      const targetSessionId = form.sessionId ?? sessionId;
      if (!targetSessionId) return;
      const title = requireField("title", "Title");
      if (!title) return;
      const renameTarget = sessions.find((entry) => entry.sessionId === targetSessionId) ?? activeSession;
      const blocked = cursorCloudRenameBlockedReason(renameTarget);
      if (blocked) {
        addNotice(blocked, "error");
        return;
      }
      await renameChat(conn, targetSessionId, title);
      setRightOpen(false);
      setRightPane({ kind: "empty" });
      lastUserOpenedPaneRef.current = null;
      focusAfterDetails();
      addNotice(`Renamed chat to "${title}".`, "success");
      await refreshState();
      return;
    }

    if (form.command === "lane-rename") {
      const name = requireField("name", "Lane name");
      if (!name) return;
      await renameLane(form.laneId ?? activeLaneIdRef.current, name);
      setRightOpen(false);
      setRightPane({ kind: "empty" });
      lastUserOpenedPaneRef.current = null;
      focusAfterDetails();
      return;
    }

    if (form.command === "pr-open") {
      if (!laneId) return;
      const title = requireField("title", "Title");
      if (!title) return;
      const body = values.body?.trim() ?? "";
      const created = await conn.action("pr", "createFromLane", {
        laneId,
        title,
        body,
        draft: false,
      });
      setRightPane({ kind: "details", title: "PR open", body: renderObject(created, 24) });
      addNotice("Created PR.", "success");
      await refreshState();
    }

    if (form.command === "lane-delete") {
      const targetLaneId = form.laneDelete?.laneId ?? form.laneId ?? laneId;
      if (!targetLaneId) return;
      const lane = lanes.find((entry) => entry.id === targetLaneId) ?? null;
      if (!lane) {
        addNotice("Selected lane is no longer loaded.", "error");
        return;
      }
      if (lane.laneType === "primary") {
        addNotice("Primary lane cannot be deleted.", "error");
        return;
      }
      const scope = normalizeLaneDeleteScope(values.scope);
      const deleteArgs: Record<string, unknown> = {
        laneId: targetLaneId,
        deleteBranch: scope !== "worktree",
        force: values.force === "yes",
      };
      if (scope === "remote_branch") {
        deleteArgs.deleteRemoteBranch = true;
        deleteArgs.remoteName = values.remoteName?.trim() || "origin";
      }
      setRightPane({
        kind: "details",
        title: "Delete lane",
        body: `Deleting ${lane.name}...\nScope: ${scope.replace("_", " ")}\nForce: ${deleteArgs.force ? "yes" : "no"}`,
      });
      await conn.action("lane", "delete", deleteArgs);
      setFormDiscardArmed(false);
      setFormValues({});
      setFormFieldIndex(0);
      setPrompt("");
      setRightOpen(false);
      setRightPane({ kind: "empty" });
      lastUserOpenedPaneRef.current = null;
      const fallbackLane = lanes.find((entry) => entry.id !== targetLaneId && !entry.archivedAt) ?? null;
      selectActiveLaneId(fallbackLane?.id ?? null);
      selectActiveSessionId(null);
      setDrawerLaneId(fallbackLane?.id ?? null);
      setSelectedDrawerLaneId(fallbackLane?.id ?? null);
      setSelectedDrawerChatId(null);
      focusAfterDetails();
      addNotice(`Deleted lane ${lane.name}.`, "success");
      await refreshState();
      return;
    }

    if (form.command === "chat-delete") {
      const targetSessionId = form.chatDelete?.sessionId ?? form.sessionId ?? sessionId;
      if (!targetSessionId) return;
      const session = sessions.find((entry) => entry.sessionId === targetSessionId) ?? null;
      if (!session) {
        addNotice("Selected chat is no longer loaded.", "error");
        return;
      }
      const expected = form.chatDelete?.title ?? session.title ?? session.goal ?? session.sessionId;
      setRightPane({ kind: "details", title: "Delete chat", body: `Deleting ${expected}...` });
      await deleteChatSession(conn, targetSessionId);
      setFormDiscardArmed(false);
      setFormValues({});
      setFormFieldIndex(0);
      setPrompt("");
      if (activeSessionIdRef.current === targetSessionId) {
        selectFallbackChatAfterRemoval(session);
      }
      setRightOpen(false);
      setRightPane({ kind: "empty" });
      lastUserOpenedPaneRef.current = null;
      focusAfterDetails();
      addNotice(`Deleted chat ${expected}.`, "success");
      await refreshState();
      return;
    }

    if (form.command === "feedback") {
      // Prefer the multiline feedback state carried on content.feedback (seeded
      // by openFeedbackForm, edited in the right-pane input guard). Falls back to
      // the legacy single-line formValues path when no meta is present.
      let feedbackValues: FeedbackFormValues;
      if (form.feedback) {
        const state: FeedbackFormState = feedbackStateFromMeta(form.feedback);
        if (!feedbackFormCanSubmit(state)) {
          addNotice("Add some feedback before sending.", "error");
          return;
        }
        feedbackValues = feedbackFormToFormValues(state);
      } else {
        const summary = requireField("summary", "Summary");
        if (!summary) return;
        feedbackValues = { ...values, summary } as FeedbackFormValues;
      }
      const draftInput = buildFeedbackDraftInput(feedbackValues);
      setRightPane({ kind: "details", title: "Feedback", body: "Posting feedback to GitHub..." });
      try {
        const draft = await conn.action<FeedbackPreparedDraft>("feedback", "prepareDraft", {
          draftInput,
          modelId: null,
          reasoningEffort: null,
        });
        const submission = await conn.action<FeedbackSubmission>("feedback", "submitPreparedDraft", {
          draft,
          title: draft.title,
          body: draft.body,
          labels: draft.labels,
        });
        const notice = feedbackSubmissionNotice(submission);
        if (notice.tone === "success" && form.feedback) {
          // Flash the sanctioned green ✓ (rendered by FeedbackFormPane via the
          // shared spin tick), then auto-close. A single one-shot timer is fine —
          // the motion itself is gated on useShimmerTick, not a bare setInterval.
          setRightPane({
            kind: "form",
            title: "Feedback",
            command: "feedback",
            fields: form.fields,
            feedback: { ...form.feedback, feedback: "submitted" },
          });
          addNotice(notice.text, notice.tone);
          if (feedbackCloseTimerRef.current) {
            clearTimeout(feedbackCloseTimerRef.current);
          }
          feedbackCloseTimerRef.current = setTimeout(() => {
            feedbackCloseTimerRef.current = null;
            setRightPane((prev) => {
              // Only close if the submitted feedback form is still showing; a
              // different pane may have been opened while the timer was pending.
              if (
                prev.kind === "form" &&
                prev.command === "feedback" &&
                prev.feedback?.feedback === "submitted"
              ) {
                setFormDiscardArmed(false);
                setFormValues({});
                setFormFieldIndex(0);
                setPrompt("");
                setRightOpen(false);
                lastUserOpenedPaneRef.current = null;
                focusAfterDetails();
                return { kind: "empty" };
              }
              return prev;
            });
          }, 900);
          return;
        }
        setFormDiscardArmed(false);
        setFormValues({});
        setFormFieldIndex(0);
        setPrompt("");
        setRightOpen(false);
        setRightPane({ kind: "empty" });
        lastUserOpenedPaneRef.current = null;
        focusAfterDetails();
        addNotice(notice.text, notice.tone);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setFormDiscardArmed(false);
        setFormValues({});
        setFormFieldIndex(0);
        setPrompt("");
        setRightOpen(false);
        setRightPane({ kind: "empty" });
        lastUserOpenedPaneRef.current = null;
        focusAfterDetails();
        addNotice(`Feedback failed: ${message}`, "error");
      }
    }
    } finally {
      submitRightFormInFlightRef.current = false;
    }
  }, [activeLaneId, addNotice, focusAfterDetails, lanes, refreshState, renameLane, runLaneSetupAfterCreate, selectActiveLaneId, selectActiveSessionId, selectFallbackChatAfterRemoval, sessions]);

  /**
   * Hand a path/URL to the OS viewer. Best-effort by contract: every failure
   * mode becomes a notice, never a throw — this runs inside React event
   * handlers where an exception would tear down the Ink render.
   */
  const openImageTarget = useCallback((openTarget: string) => {
    try {
      const child = process.platform === "darwin"
        ? spawn("open", [openTarget], { stdio: "ignore", detached: true })
        : process.platform === "win32"
          ? spawn("rundll32.exe", ["url.dll,FileProtocolHandler", openTarget], { stdio: "ignore", detached: true })
          : spawn("xdg-open", [openTarget], { stdio: "ignore", detached: true });
      child.once("error", (err) => {
        addNotice(err instanceof Error ? err.message : String(err), "error");
      });
      child.once("spawn", () => {
        addNotice(`Opening ${path.basename(openTarget)}…`, "info");
      });
      child.unref();
    } catch (err) {
      addNotice(err instanceof Error ? err.message : String(err), "error");
    }
  }, [addNotice]);

  const openLatestImage = useCallback(() => {
    const target = latestOpenableImageTarget(events);
    if (!target) {
      addNotice("No image to open in the recent history.", "info");
      return;
    }
    openImageTarget(target);
  }, [addNotice, events, openImageTarget]);

  /**
   * Open the image whose inline token the caret is sitting on. Returns false
   * when the caret is not on a token so the caller can fall through to its
   * other meaning for the key.
   */
  const openImageTokenAtCursor = useCallback((): boolean => {
    const token = imageTokenAtCursor(promptRef.current, promptCursorRef.current);
    if (!token) return false;
    const attachment = promptImageAttachmentsRef.current.find((entry) => entry.label === token.label);
    if (!attachment) {
      addNotice(`No file is attached to ${formatImageToken(token.label)} any more.`, "info");
      return true;
    }
    openImageTarget(attachment.path);
    return true;
  }, [addNotice, openImageTarget]);

  // Slash commands typed while a turn is streaming or rate-limited used to slip
  // past the dispatcher and get queued/sent as plain text. interceptLocalSlashCommand
  // routes any recognized inline/right slash before any send path runs.
  const interceptLocalSlashCommand = useCallback(async (text: string): Promise<boolean> => {
    if (!text.startsWith("/")) return false;
    const parsed = parseCommand(text, slashCommands);
    if (!parsed?.spec) return false;
    if (parsed.spec.providers?.length && !parsed.spec.providers.includes(activeCommandProvider)) {
      clearChatPromptDraft();
      if (parsed.spec.placement === "right") {
        await runRightCommand(parsed.name, parsed.args);
        return true;
      }
      addNotice(`${parsed.name} is only available for ${parsed.spec.providers.join(", ")} chats.`, "error");
      return true;
    }
    if (parsed.spec.placement === "inline") {
      clearChatPromptDraft();
      await runInlineCommand(parsed.name, parsed.args);
      return true;
    }
    if (parsed.spec.placement === "right") {
      clearChatPromptDraft();
      await runRightCommand(parsed.name, parsed.args);
      return true;
    }
    return false;
  }, [activeCommandProvider, addNotice, clearChatPromptDraft, runInlineCommand, runRightCommand, slashCommands]);

  const openCommandPalette = useCallback(() => {
    setCommandPaletteOpen(true);
    setCommandPaletteQuery("");
    setCommandPaletteIndex(0);
    selectFooterControl(null);
    setInlineRowFocus({ cell: null });
    const conn = connectionRef.current;
    if (conn) {
      void captureTuiProductAnalytics(conn, {
        event: "ade_feature_used",
        properties: {
          feature: "command_palette",
          action: "open",
          source: "ade_code",
        },
        dedupeKey: "tui_feature:command_palette:open",
        minimumIntervalMs: 5_000,
      }).catch(() => undefined);
    }
  }, [selectFooterControl]);

  const runCommandPaletteItem = useCallback(async (item: CommandPaletteItem | null | undefined) => {
    if (!item) return;
    setCommandPaletteOpen(false);
    setCommandPaletteQuery("");
    setCommandPaletteIndex(0);
    if (item.kind === "command") {
      const commandName = item.key.startsWith("command:") ? item.key.slice("command:".length) : item.label.split(/\s+/)[0] ?? "";
      const parsed = parseCommand(commandName, slashCommands);
      if (parsed?.spec?.placement === "right") {
        await runRightCommand(parsed.name, "");
      } else if (parsed?.spec?.placement === "inline") {
        if (parsed.spec.argumentHint) {
          const draft = `${parsed.name} `;
          setPrompt(draft);
          promptRef.current = draft;
          chatDraftRef.current = draft;
          focusChat();
        } else {
          await runInlineCommand(parsed.name, "");
        }
      } else if (parsed?.spec?.placement === "chat") {
        const draft = `${parsed.name} `;
        setPrompt(draft);
        promptRef.current = draft;
        chatDraftRef.current = draft;
        focusChat();
      } else if (parsed?.name) {
        const draft = `${parsed.name} `;
        setPrompt(draft);
        promptRef.current = draft;
        chatDraftRef.current = draft;
        focusChat();
      }
      return;
    }
    if (item.kind === "lane") {
      const laneId = item.key.slice("lane:".length);
      const lane = lanes.find((entry) => entry.id === laneId) ?? null;
      if (lane) activateLaneWithLastChat(lane, { notify: true });
      return;
    }
    // Local chat items key on `chat:<id>`; universal-search hits (rendered with
    // the same "chat" kind) key on `search-<kind>:<id>` and may point at a
    // session that isn't in `displaySessions` (e.g. archived, or another lane not
    // yet listed). Resolve either against the local list first, then fall back to
    // a fresh listing so the jump still lands.
    const isSearchItem = item.key.startsWith("search-");
    const sessionId = isSearchItem
      ? item.key.slice(item.key.indexOf(":") + 1)
      : item.key.slice("chat:".length);
    if (!sessionId) return;
    let session = displaySessions.find((entry) => entry.sessionId === sessionId) ?? null;
    if (!session && isSearchItem) {
      const conn = connectionRef.current;
      if (conn) {
        const [freshChatSessions, freshTerminalSessions] = await Promise.all([
          listChatSessions(conn, null, { includeArchived: true }).catch(() => [] as AgentChatSessionSummary[]),
          listTerminalSessions(conn).catch(() => [] as ChatTerminalSession[]),
        ]);
        session =
          freshChatSessions.find((entry) => entry.sessionId === sessionId)
          ?? (freshTerminalSessions
            .map((terminal) => terminalSessionToChatSummary(terminal))
            .find((entry) => entry.sessionId === sessionId) ?? null);
      }
    }
    if (session) {
      selectActiveLaneId(session.laneId);
      setDrawerLaneId(session.laneId);
      setSelectedDrawerLaneId(session.laneId);
      setSelectedWorkChatAction(null);
      setSelectedDrawerChatId(session.sessionId);
      applyDrawerChatSelection({ session, action: null });
      addNotice(`Switched to chat ${session.title ?? session.sessionId}.`, "success");
    } else if (isSearchItem) {
      addNotice("That chat is no longer available.", "info");
    }
  }, [activateLaneWithLastChat, addNotice, applyDrawerChatSelection, displaySessions, focusChat, lanes, runInlineCommand, runRightCommand, selectActiveLaneId, slashCommands]);

  const submitPrompt = useCallback(async (value: string) => {
    // A plugin's question borrows this line, so a submit that reaches here by
    // any route belongs to the question and never to the chat. The key chain
    // already intercepts Enter; this is the backstop that keeps an answer from
    // being sent to a model.
    if (pluginPromptRef.current) {
      await submitPluginPrompt();
      return;
    }
    const text = value.trim();
    const submittedValue = value;
    const draftImageAttachments = promptImageAttachmentsRef.current;
    const promptAttachments: AgentChatFileRef[] = [
      ...selectedMentions
        .filter((mention) => (
          mention.kind === "file"
          && mention.filePath
          && (mention.attachment || (mention.insertText.length > 0 && text.includes(mention.insertText)))
        ))
        .map((mention) => ({
          type: isImageFilePath(mention.filePath!) ? ("image" as const) : ("file" as const),
          path: mention.filePath!,
        })),
      // Inline image tokens ride the SAME structured envelope as @file
      // attachments, so providers that consume AgentChatFileRef[] are
      // unaffected by the switch from detached chips to tokens.
      ...referencedAttachmentPaths(text, draftImageAttachments)
        .map((filePath) => ({ type: "image" as const, path: filePath })),
    ];
    // ...and the outgoing *text* names the file too, because the chip glyph is
    // meaningless to a model. This is in addition to the envelope, never
    // instead of it.
    const outgoingText = expandImageTokensForSend(text, draftImageAttachments);
    const activeTerminalForBlankResume = activeTerminalSessionRef.current;
    // A plugin field owning the composer behaves like a form field: an empty
    // submission clears it rather than being swallowed, and a value starting
    // with "/" is text, not a command.
    const pluginFieldIndex = rightPane.kind === "plugin-panel" ? rightPane.state.editing ?? null : null;
    const emptyPromptSubmission = !text
      && rightPane.kind !== "form"
      && pluginFieldIndex === null
      && !promptAttachments.length;
    const blankResumeRequest = emptyPromptSubmission
      && !pendingApproval
      && isTerminalSessionResumable(activeTerminalForBlankResume);
    if (emptyPromptSubmission && !blankResumeRequest) return;
    // Intercept ADE-owned slash commands before the connection gate so /model and
    // /plan work pre-chat (splash screen) where connectionRef.current is null.
    try {
      if (text.startsWith("/") && rightPane.kind !== "form" && pluginFieldIndex === null && !pendingApproval) {
        if (await interceptLocalSlashCommand(text)) {
          clearChatPromptDraft();
          return;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      addNotice(message, "error");
      return;
    }
    const conn = connectionRef.current;
    if (!conn) return;
    try {
      setInterrupted(false);
      setPrompt("");
      promptRef.current = "";
      setChatScrollOffset(0);
      if (activePaneRef.current === "chat") {
        chatDraftRef.current = "";
      }
      // The draft (tokens and all) is gone from the composer, so its image
      // registry and stashed copy go with it.
      promptImageAttachmentsRef.current = [];
      clearComposerDraft(composerDraftsRef.current, activeSessionIdRef.current);
      setError(null);
      if (blankResumeRequest && activeTerminalForBlankResume) {
        await resumeClosedTerminalSession(activeTerminalForBlankResume);
        return;
      }
      if (pendingApproval?.mode === "approval") {
        const lowered = text.toLowerCase();
        if (pendingApproval.highStakes) {
          if (lowered === "approve" || lowered === "deny") {
            await resolvePendingApproval(pendingApproval, lowered === "approve" ? "accept" : "decline");
            return;
          }
          addNotice("Type approve or deny to resolve the high-stakes request.", "error");
          return;
        }
        if (lowered === "approve" || lowered === "a" || lowered === "deny" || lowered === "d") {
          await resolvePendingApproval(pendingApproval, lowered === "approve" || lowered === "a" ? "accept" : "decline");
          return;
        }
        addNotice("Press a to approve or d to deny this request.", "error");
        return;
      }
      if (pendingApproval?.mode === "question") {
        const lowered = value.trim().toLowerCase();
        const isDecline = lowered === "deny" || lowered === "decline" || lowered === "cancel";
        // Multi-question requests accumulate answers across questions in the
        // selection state, so a typed answer must merge into that state (keeping
        // earlier option/free-text answers and advancing) rather than rebuilding
        // the whole payload. Single-question + decline keep the original path.
        if (!isDecline && (pendingApproval.request?.questions?.length ?? 0) > 1) {
          await submitSelectedPendingQuestion(pendingApproval, value);
          return;
        }
        await answerPendingInput(pendingApproval, value);
        return;
      }
      if (rightPane.kind === "plugin-panel" && pluginFieldIndex !== null) {
        const interactive = rightPane.model.interactives[pluginFieldIndex];
        if (interactive?.kind === "field") {
          const valueKey = pluginFormValueKey(interactive.formKey, interactive.field.id);
          updatePluginPaneState((state) => ({
            ...state,
            values: { ...state.values, [valueKey]: submittedValue },
            editing: null,
          }));
          setPromptValue("");
          // A typed field commits on Enter, which is where an apply-on-change
          // form applies it — never per keystroke, so a plugin is not invoked
          // once per letter. `activatePluginInteractive` reads the value back
          // out of pane state, which the write above has already updated.
          if (interactive.applyOnChange) {
            void activatePluginInteractive(pluginFieldIndex, { commitValue: submittedValue });
          }
          // Land on the next thing to do — usually the next field, then submit.
          setRightSelectionIndex(movePluginPaneSelection(rightPane.model, pluginFieldIndex, 1));
          return;
        }
        if (interactive?.kind === "search") {
          updatePluginPaneState((state) => ({ ...state, editing: null }));
          setPromptValue("");
          void activatePluginInteractive(pluginFieldIndex, { commitValue: submittedValue });
          return;
        }
      }
      if (rightPane.kind === "form" && !text.startsWith("/")) {
        const field = activeFormField;
        const values = field && formFieldUsesPromptInput(rightPane.command, field.name)
          ? { ...formValues, [field.name]: value }
          : formValues;
        setFormValues(values);
        await submitRightForm(rightPane, values);
        return;
      }
      const parsed = parseCommand(text, slashCommands);
      if (parsed?.spec?.providers?.length && !parsed.spec.providers.includes(activeCommandProvider)) {
        addNotice(`${parsed.name} is only available for ${parsed.spec.providers.join(", ")} chats.`, "error");
        return;
      }
      if (text.startsWith("/") && parsed && !parsed.spec && !parsed.userCommand && slashRows.length) {
        const selected = slashRows[slashIndex] ?? slashRows[0];
        if (selected) {
          const selectedCommand = parseCommand(selected.name, slashCommands);
          if (selectedCommand?.spec?.placement === "inline") {
            await runInlineCommand(selectedCommand.name, selectedCommand.args);
            return;
          }
          if (selectedCommand?.spec?.placement === "right") {
            await runRightCommand(selectedCommand.name, selectedCommand.args);
            return;
          }
          const activeTerminal = activeTerminalSessionRef.current;
          if (activeTerminal) {
            await submitClaudePromptToTerminal(activeTerminal, selected.name);
            return;
          }
          const sessionId = (gridViewActiveRef.current ? focusedSessionIdForMultiView(multiViewRef.current) : null) ?? await ensureActiveSession();
          if (sessionId) {
            await sendOrSteerChatMessage(sessionId, selected.name);
          }
          return;
        }
      }
      if (parsed?.spec?.placement === "inline") {
        await runInlineCommand(parsed.name, parsed.args);
        return;
      }
      if (parsed?.spec?.placement === "right") {
        await runRightCommand(parsed.name, parsed.args);
        return;
      }
      const desktopRoute = desktopRouteForCommand(parsed?.name);
      if (desktopRoute) {
        const result = await navigateDesktop(conn, {
          source: "ade-code",
          target: { kind: "route", route: desktopRoute },
        });
        if (result.ok) {
          addNotice(`Opened ADE desktop for ${parsed?.name}.`, "success");
          return;
        }
        await runInlineCommand("/open", "");
        addNotice(`${parsed?.name} is a desktop-only surface; opened ADE desktop.`, "info");
        return;
      }
      const terminalPrompt = promptTextForTerminal(outgoingText, promptAttachments);
      // In grid view the focused tile is the sole submit target. If it's a Claude
      // terminal tile, route the prompt there; otherwise fall through to the chat
      // path with that tile's session id. We never spawn a NEW terminal from a grid
      // submit — that would replace the focused tile out from under the user.
      const focusedSessionId = (gridViewActiveRef.current ? focusedSessionIdForMultiView(multiViewRef.current) : null);
      const activeTerminal = gridViewActiveRef.current
        ? (focusedSessionId
          ? terminalSessionsRef.current.find((entry) => entry.terminalId === focusedSessionId) ?? null
          : null)
        : activeTerminalSessionRef.current;
      if (activeTerminal) {
        if (await submitClaudePromptToTerminal(activeTerminal, terminalPrompt)) {
          setSelectedMentions((prev) => prev.filter((mention) => !mention.attachment));
        }
        return;
      }
      const activeChatSessionId = resolvePromptChatSubmitTarget({
        draftChatActive: draftChatActiveRef.current,
        focusedSessionId,
        activeSessionId: activeSessionRef.current?.sessionId ?? null,
      });
      if (activeChatSessionId) {
        lastLocalSendAtRef.current = Date.now();
        await sendOrSteerChatMessage(activeChatSessionId, outgoingText || "Use the attached image.", promptAttachments);
        setSelectedMentions((prev) => prev.filter((mention) => !mention.attachment));
        return;
      }
      // Interface=CLI draft (any provider): create a tracked CLI terminal. Chat
      // interface falls through to createChatSession (below) for all providers,
      // including Claude. Grid view never spawns a new terminal from a submit.
      if (!gridViewActiveRef.current && modelStateRef.current.interfaceMode === "cli") {
        const terminalId = await startCliTerminalForPrompt(terminalPrompt || " ");
        if (terminalId) {
          setSelectedMentions((prev) => prev.filter((mention) => !mention.attachment));
        }
        return;
      }
      const sessionId = focusedSessionId ?? await ensureActiveSession();
      if (!sessionId) {
        addNotice("No active lane is available for chat.", "error");
        return;
      }
      lastLocalSendAtRef.current = Date.now();
      await sendOrSteerChatMessage(sessionId, outgoingText || "Use the attached image.", promptAttachments);
      setSelectedMentions((prev) => prev.filter((mention) => !mention.attachment));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStreaming(false);
      if (submittedValue.trim() || promptAttachments.length) {
        setPrompt(submittedValue);
        promptRef.current = submittedValue;
        // The prompt is back, so its image tokens must resolve again.
        promptImageAttachmentsRef.current = retainReferencedAttachments(submittedValue, draftImageAttachments);
        if (activePaneRef.current === "chat") chatDraftRef.current = submittedValue;
      }
      addNotice(message, "error");
    }
  }, [activeCommandProvider, activeFormField, addNotice, answerPendingInput, clearChatPromptDraft, ensureActiveSession, formValues, interceptLocalSlashCommand, pendingApproval, resolvePendingApproval, resumeClosedTerminalSession, rightPane, runInlineCommand, runRightCommand, selectedMentions, sendOrSteerChatMessage, setChatScrollOffset, setPromptValue, slashCommands, slashIndex, slashRows, startCliTerminalForPrompt, submitClaudePromptToTerminal, submitPluginPrompt, submitRightForm, submitSelectedPendingQuestion, updatePluginPaneState]);

  const launchPromptInBackground = useCallback(async (value: string) => {
    const text = value.trim();
    const submittedValue = value;
    const draftImageAttachments = promptImageAttachmentsRef.current;
    const promptAttachments: AgentChatFileRef[] = [
      ...selectedMentions
        .filter((mention) => (
          mention.kind === "file"
          && mention.filePath
          && (mention.attachment || (mention.insertText.length > 0 && text.includes(mention.insertText)))
        ))
        .map((mention) => ({
          type: isImageFilePath(mention.filePath!) ? ("image" as const) : ("file" as const),
          path: mention.filePath!,
        })),
      ...referencedAttachmentPaths(text, draftImageAttachments)
        .map((filePath) => ({ type: "image" as const, path: filePath })),
    ];
    const outgoingText = expandImageTokensForSend(text, draftImageAttachments);
    if (!text && !promptAttachments.length) return;
    const conn = connectionRef.current;
    const laneId = activeLaneIdRef.current;
    if (!conn || !laneId) {
      addNotice("No active lane is available for background chat.", "error");
      return;
    }
    if (!draftChatActiveRef.current || activeSessionIdRef.current) {
      addNotice("Background launch is only available from New Chat.", "info");
      return;
    }
    const lane = lanes.find((entry) => entry.id === laneId) ?? null;
    const unavailableMessage = laneWorktreeUnavailableMessage(lane);
    if (unavailableMessage) {
      if (lane) {
        setRightPane(seedLaneDetails(lane, false));
        setRightOpen(true);
      }
      addNotice(unavailableMessage, "error");
      return;
    }
    const launchId = backgroundLaunchSeqRef.current + 1;
    backgroundLaunchSeqRef.current = launchId;
    setBackgroundLaunchStatus({
      id: launchId,
      laneId,
      laneName: lane?.name ?? "lane",
      prompt: submittedValue,
      status: "running",
    });
    let launched = false;
    try {
      setInterrupted(false);
      setPrompt("");
      promptRef.current = "";
      chatDraftRef.current = "";
      setChatScrollOffset(0);
      setError(null);
      const normalized = { ...modelStateRef.current, ...applyProviderPermissionMode(modelStateRef.current) };
      const runtimeProvider = runtimeProviderForUiProvider(normalized.provider);
      // Interface=CLI (with a provider that has a CLI) launches a tracked
      // terminal; everything else — including Claude Chat — creates an SDK chat.
      const cliProvider = normalized.interfaceMode === "cli"
        ? cliProviderForModelStateProvider(normalized.provider)
        : null;
      if (cliProvider) {
        const launchModel = cliProvider === "cursor"
          ? resolveCursorCliModelForLaunch(
              normalized,
              providerModelsCacheRef.current.get(providerModelsCacheKey("cursor", "cli")) ?? models,
            )
          : normalized.modelId ?? normalized.model;
        const cols = clampTerminalPaneCols(terminalPaneWidth);
        const terminalRows = claudeTerminalRowsForPane(chatRowBudget);
        const terminalPrompt = promptTextForTerminal(outgoingText, promptAttachments);
        const cliTitle = pendingNewChatTitleRef.current ?? LAUNCH_PROFILE_TITLE[cliProvider];
        const createdTerminal = await startCliTerminalSession({
          connection: conn,
          provider: cliProvider,
          laneId,
          title: cliTitle,
          model: launchModel,
          reasoningEffort: normalized.reasoningEffort,
          fastMode: normalized.fastMode,
          permissionMode: normalized.permissionMode,
          initialInput: terminalPrompt.trim() ? terminalPrompt : null,
          cols,
          rows: terminalRows,
        });
        registerOptimisticTerminalSession({
          sessionId: createdTerminal.sessionId,
          laneId,
          title: cliTitle,
          session: createdTerminal.session,
          provider: cliProvider,
        });
        if (cliProvider === "claude" && !claudeAutoNamingHintShownRef.current) {
          claudeAutoNamingHintShownRef.current = true;
          addNotice("Claude sessions auto-name in the background when enabled — toggle in ADE desktop → Settings → AI Features.", "info");
        }
        launched = true;
      } else {
        if (runtimeProvider === "cursor") {
          const cursorModel = models.find((entry) => (
            entry.id === normalized.modelId
              || entry.modelId === normalized.modelId
              || entry.id === normalized.model
              || entry.modelId === normalized.model
          )) ?? modelInfoFromDescriptor(normalized.modelId ?? normalized.model);
          if (!cursorModel || !cursorModelAvailableForInterface(cursorModel, normalized.interfaceMode)) {
            throw new Error(
              normalized.interfaceMode === "cli"
                ? "This Cursor model is available for chat only. Choose a Cursor CLI model."
                : "This Cursor model is available for CLI only. Switch Interface to CLI or choose a chat model.",
            );
          }
        }
        const requestedTitle = pendingNewChatTitleRef.current;
        const created = await createChatSession({
          connection: conn,
          laneId,
          title: requestedTitle,
          provider: runtimeProvider,
          modelId: normalized.modelId,
          reasoningEffort: normalized.reasoningEffort,
          fastMode: normalized.fastMode,
          permissionMode: normalized.permissionMode,
          interactionMode: normalized.interactionMode,
          claudePermissionMode: normalized.claudePermissionMode,
          codexApprovalPolicy: normalized.codexApprovalPolicy,
          codexSandbox: normalized.codexSandbox,
          codexConfigSource: normalized.codexConfigSource,
          opencodePermissionMode: normalized.opencodePermissionMode,
          droidPermissionMode: normalized.droidPermissionMode,
          cursorModeId: normalized.cursorModeId,
          cursorConfigValues: normalized.cursorConfigValues,
        });
        const optimisticSummary = chatSessionToOptimisticSummary(created, requestedTitle);
        optimisticChatSessionsRef.current.set(created.id, optimisticSummary);
        setSessions((current) => mergeOptimisticChatSessions(current, optimisticChatSessionsRef.current));
        lastLocalSendAtRef.current = Date.now();
        await sendChatMessage(conn, created.id, outgoingText || "Use the attached image.", promptAttachments);
        launched = true;
      }
      pendingNewChatTitleRef.current = null;
      if (launched) rememberModelChoice(normalized);
      setSelectedMentions((prev) => prev.filter((mention) => !mention.attachment));
      promptImageAttachmentsRef.current = [];
      clearComposerDraft(composerDraftsRef.current, activeSessionIdRef.current);
      await refreshState().catch((refreshError) => {
        addNotice(`Launched chat, but refresh failed: ${refreshError instanceof Error ? refreshError.message : String(refreshError)}`, "error");
      });
      setDraftChatMode(true);
      addNotice(`Launched chat in ${lane?.name ?? "lane"}.`, "success");
      setBackgroundLaunchStatus((prev) => prev?.id === launchId ? null : prev);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setPrompt(submittedValue);
      promptRef.current = submittedValue;
      promptCursorRef.current = submittedValue.length;
      chatDraftRef.current = submittedValue;
      promptImageAttachmentsRef.current = retainReferencedAttachments(submittedValue, draftImageAttachments);
      setDraftChatMode(true);
      setBackgroundLaunchStatus((prev) => prev?.id === launchId
        ? { ...prev, status: "failed", error: message }
        : prev);
      setError(message);
      addNotice(launched ? `Launched chat, but follow-up failed: ${message}` : message, "error");
    }
  }, [addNotice, chatRowBudget, lanes, models, refreshState, registerOptimisticTerminalSession, selectedMentions, setChatScrollOffset, setDraftChatMode, terminalPaneWidth]);

  const insertMention = useCallback((suggestion: MentionSuggestion) => {
    const detectedTrigger = detectComposerTrigger(prompt, promptCursorRef.current);
    if (detectedTrigger?.type !== "at") return;
    const trigger = composerTriggerForSelection(
      detectedTrigger,
      suggestion.kind === "file" ? suggestion.filePath ?? suggestion.label : suggestion.label,
      suggestion.kind === "file" ? "file" : "mention",
    );
    const next = replaceComposerTriggerSpan(prompt, trigger, `${suggestion.insertText} `);
    setPromptValue(next.text, next.caret);
    setSelectedMentions((prev) => {
      if (prev.some((entry) => entry.insertText === suggestion.insertText)) return prev;
      return [...prev, suggestion].slice(-12);
    });
    setMentionSuggestions([]);
    setMentionIndex(0);
  }, [prompt, setPromptValue]);

  const insertSlashCommandRow = useCallback((selected: { name: string; argumentHint?: string }) => {
    const trigger = detectComposerTrigger(prompt, promptCursorRef.current);
    if (trigger?.type !== "slash" || composerTriggerSpansWholeDraft(prompt, trigger)) {
      // Lone leading command keeps the legacy fill-the-prompt behavior.
      setPromptValue(`${selected.name}${selected.argumentHint ? " " : ""}`);
      return;
    }
    const next = replaceComposerTriggerSpan(prompt, trigger, `${selected.name} `);
    setPromptValue(next.text, next.caret);
  }, [prompt, setPromptValue]);

  const insertSlashCommand = useCallback(() => {
    const selected = slashRows[slashIndex] ?? slashRows[0];
    if (!selected) return;
    insertSlashCommandRow(selected);
  }, [insertSlashCommandRow, slashIndex, slashRows]);

  const applyModelState = useCallback((updater: (prev: AdeCodeModelState) => AdeCodeModelState) => {
    setModelState((prev) => {
      const next = updater(prev);
      scheduleModelStateCommit(next);
      return next;
    });
  }, [scheduleModelStateCommit]);

  // Commit a model picked in the right-pane ModelPicker into the current chat
  // model state and push it onto the cross-surface recents list. Defined here
  // (after applyModelState) so the closure captures a live binding.
	  const commitModelPickerSelection = useCallback(
	    (modelId: string) => {
	      let catalogModel: AgentChatModelCatalogModel | null = null;
	      let catalogProvider: AdeCodeProvider | null = null;
	      for (const group of modelCatalogRef.current?.groups ?? modelCatalog?.groups ?? []) {
	        for (const provider of group.providers) {
	          for (const subsection of provider.subsections) {
	            const found = subsection.models.find((entry) => entry.id === modelId || entry.modelId === modelId);
		            if (found) {
		              catalogModel = found;
		              catalogProvider = normalizeCatalogProvider(group.key);
		              break;
		            }
	          }
	          if (catalogModel) break;
	        }
	        if (catalogModel) break;
	      }
	      const target = models.find((entry) => (entry.modelId ?? entry.id) === modelId)
	        ?? (catalogModel?.isAvailable === true ? catalogModel as AgentChatModelInfo : null)
          ?? modelInfoFromDescriptor(modelId);
	      if (!target) {
	        addNotice(`Model ${modelId} is not available right now.`, "error");
	        return;
	      }
      const descriptor = getModelById(modelId);
      const provider: AdeCodeProvider = descriptor
        ? normalizeProvider(resolveProviderGroupForModel(descriptor))
        : catalogProvider ?? modelStateRef.current.provider;
      if (modelPickerProviderSwitchBlocked({
        providerLocked: providerLockedRef.current,
        surface: rightPane.kind === "model-picker" || rightPane.kind === "model-wizard"
          ? rightPane.surface
          : "chat",
        currentProvider: modelStateRef.current.provider,
        nextProvider: provider,
      })) {
        addNotice("Provider is locked for this chat. /new chat to switch.", "info");
        return;
	      }
	      const previousModelState = modelStateRef.current;
	      if (provider === "cursor" && !cursorModelAvailableForInterface(target, previousModelState.interfaceMode)) {
	        addNotice(
	          previousModelState.interfaceMode === "cli"
	            ? "This Cursor model is available for chat only. Choose a Cursor CLI model."
	            : "This Cursor model is available for CLI only. Switch Interface to CLI or choose a chat model.",
	          "error",
	        );
	        return;
	      }
      const nextModelState: AdeCodeModelState = {
        ...previousModelState,
        ...modelStatePatchForModel(provider, target),
      };
      modelStateRef.current = nextModelState;
      setModelState(nextModelState);
      scheduleModelStateCommit(nextModelState);
      if (activeTerminalSessionRef.current && provider === "claude") {
        const terminalId = activeTerminalSessionRef.current.terminalId;
        const commandKey = claudeModelCommandKey(nextModelState, terminalId);
        lastModelPickerClaudeSentKeyRef.current = commandKey;
        void sendClaudeModelCommandToTerminal(nextModelState.modelId ?? nextModelState.model)
          .then((sent) => {
            if (!sent && lastModelPickerClaudeSentKeyRef.current === commandKey) {
              lastModelPickerClaudeSentKeyRef.current = null;
            }
          })
          .catch((err) => {
            if (lastModelPickerClaudeSentKeyRef.current === commandKey) {
              lastModelPickerClaudeSentKeyRef.current = null;
            }
            addNotice(err instanceof Error ? err.message : String(err), "error");
          });
      }
      setModelPickerRecents((prev) => {
        const filtered = prev.filter((entry) => entry !== modelId);
        return [modelId, ...filtered].slice(0, 10);
      });
      const conn = connectionRef.current;
      if (conn) {
        void pushModelPickerRecent(conn, modelId)
          .then((recents) => setModelPickerRecents(recents))
          .catch(() => undefined);
      }
      setRightPane((prev) => {
        if (prev.kind !== "model-picker") return prev;
        // "pick → settings → Confirm" for BOTH surfaces: selecting a model drops
        // focus DOWN into the settings (reasoning first) and keeps the picker
        // open. Confirm (the apply row) is the only thing that closes the pane
        // and pushes the model to a running session — selection never closes it.
        // focusedIndex is preserved so the just-picked row stays highlighted; ↑
        // out of the settings re-homes onto the active model (see key handler).
        const firstSetting = (prev.settingsRows ?? []).find(
          (row) => row.kind !== "provider" && row.kind !== "model",
        )?.kind ?? "apply";
        return {
          ...prev,
          selection: { kind: "provider", provider },
          footerFocus: firstSetting,
        };
      });
      setRightOpen(true);
      setPaneFocus("details");
      addNotice(`Model set to ${target.displayName}.`, "success");
    },
	    [addNotice, models, modelCatalog, rightPane, scheduleModelStateCommit, sendClaudeModelCommandToTerminal, setPaneFocus],
	  );

  const selectProvider = useCallback((provider: AdeCodeProvider) => {
    if (providerLockedRef.current) {
      addNotice("Provider is locked for this chat. /new chat to switch.", "info");
      return;
    }
    const immediateModels = providerModelsCacheRef.current.get(
      providerModelsCacheKey(provider, modelStateRef.current.interfaceMode),
    ) ?? registryModelsForProvider(provider);
    setModels(immediateModels);
    const model = immediateModels.find((entry) => entry.isDefault) ?? immediateModels[0] ?? null;
    applyModelState((prev) => {
      const patch = model ? modelStatePatchForModel(provider, model) : fallbackModelStatePatch(provider);
      return {
        ...prev,
        ...patch,
      };
    });
    void loadProviderModels(provider, { applyDefault: false }).catch(() => undefined);
  }, [addNotice, applyModelState, loadProviderModels]);

  const cycleProvider = useCallback((delta: number) => {
    if (providerLockedRef.current) {
      addNotice("Provider is locked for this chat. /new chat to switch.", "info");
      return;
    }
    const index = Math.max(0, TUI_PROVIDER_OPTIONS.findIndex((entry) => entry.value === modelState.provider));
    const next = TUI_PROVIDER_OPTIONS[(index + delta + TUI_PROVIDER_OPTIONS.length) % TUI_PROVIDER_OPTIONS.length]?.value ?? "codex";
    selectProvider(next);
  }, [addNotice, modelState.provider, selectProvider]);

  const cycleModel = useCallback((delta: number) => {
    const candidates = models.length
      ? models
      : registryModelsForProvider(modelState.provider);
    if (!candidates.length) return;
    const index = Math.max(0, candidates.findIndex((entry) => entry.id === modelState.modelId || entry.modelId === modelState.modelId));
    const nextModel = candidates[(index + delta + candidates.length) % candidates.length] ?? candidates[0]!;
    applyModelState((prev) => ({
      ...prev,
      ...modelStatePatchForModel(modelState.provider, nextModel),
    }));
  }, [applyModelState, modelState.modelId, modelState.provider, models]);

  const cycleReasoning = useCallback((delta: number) => {
    const efforts = modelReasoningEfforts(modelState, models);
    if (!efforts.length) return;
    const index = Math.max(0, efforts.findIndex((effort) => effort === modelState.reasoningEffort));
    const nextEffort = efforts[(index + delta + efforts.length) % efforts.length] ?? efforts[0]!;
    applyModelState((prev) => ({ ...prev, reasoningEffort: nextEffort }));
  }, [applyModelState, modelState, models]);

  const cyclePermission = useCallback((delta: number) => {
    userInitiatedModeChangeRef.current = true;
    if (modelState.provider === "codex") {
      const current = resolveCodexPreset(modelState);
      // A "custom" approval×sandbox combo isn't in CODEX_PRESETS (findIndex → -1).
      // The old `Math.max(0, -1)` collapsed it to index 0, so cycling out of a
      // custom combo always jumped to "default" and silently discarded it.
      // Step deterministically into the preset list instead: forward → first,
      // backward → last.
      const found = CODEX_PRESETS.findIndex((entry) => entry === current);
      const next = found === -1
        ? (delta >= 0 ? CODEX_PRESETS[0] : CODEX_PRESETS[CODEX_PRESETS.length - 1])
        : CODEX_PRESETS[(found + delta + CODEX_PRESETS.length) % CODEX_PRESETS.length];
      applyModelState((prev) => ({ ...prev, ...codexPresetPatch(next ?? "default") }));
      return;
    }
    if (modelState.provider === "claude") {
      const current = modelState.interactionMode === "plan" ? "plan" : modelState.claudePermissionMode;
      const index = Math.max(0, CLAUDE_PERMISSION_OPTIONS.findIndex((entry) => entry === current));
      const next = CLAUDE_PERMISSION_OPTIONS[(index + delta + CLAUDE_PERMISSION_OPTIONS.length) % CLAUDE_PERMISSION_OPTIONS.length] ?? "default";
      applyModelState((prev) => ({
        ...prev,
        interactionMode: next === "plan" ? "plan" : "default",
        claudePermissionMode: next,
        permissionMode: next === "plan"
          ? "plan"
          : next === "auto"
            ? "auto"
            : next === "acceptEdits"
              ? "edit"
              : next === "bypassPermissions"
                ? "full-auto"
                : "default",
      }));
      return;
    }
    if (runtimeProviderForUiProvider(modelState.provider) === "opencode") {
      const index = Math.max(0, OPENCODE_PERMISSION_OPTIONS.findIndex((entry) => entry === modelState.opencodePermissionMode));
      const next = OPENCODE_PERMISSION_OPTIONS[(index + delta + OPENCODE_PERMISSION_OPTIONS.length) % OPENCODE_PERMISSION_OPTIONS.length] ?? "edit";
      applyModelState((prev) => ({ ...prev, opencodePermissionMode: next, permissionMode: next }));
      return;
    }
    if (modelState.provider === "droid") {
      const index = Math.max(0, DROID_PERMISSION_OPTIONS.findIndex((entry) => entry === modelState.droidPermissionMode));
      const next = DROID_PERMISSION_OPTIONS[(index + delta + DROID_PERMISSION_OPTIONS.length) % DROID_PERMISSION_OPTIONS.length] ?? "auto-low";
      applyModelState((prev) => ({ ...prev, droidPermissionMode: next, permissionMode: droidPermissionToLegacy(next) }));
      return;
    }
    const modeIds = cursorModeIdsForState(modelState);
    const index = Math.max(0, modeIds.findIndex((entry) => entry === modelState.cursorModeId));
    const next = modeIds[(index + delta + modeIds.length) % modeIds.length] ?? "agent";
    applyModelState((prev) => ({
      ...prev,
      cursorModeId: next,
      permissionMode: next === "plan"
        ? "plan"
        : next === "ask"
          ? "edit"
          : next === "full-auto"
            ? "full-auto"
            : "default",
    }));
  }, [applyModelState, modelState]);

  const handleSetupRow = useCallback((row: SetupPaneRow, direction = 1) => {
    const conn = connectionRef.current;
    if (row.disabled) return;
    if (row.kind === "provider") {
      cycleProvider(direction);
      return;
    }
    if (row.kind === "interface") {
      // Only two values, so any cycle direction toggles Chat ↔ CLI. Editable
      // rows only (disabled rows return above); a committed session's interface
      // is fixed by its type.
      const nextInterface = modelStateRef.current.interfaceMode === "cli" ? "chat" : "cli";
      persistExplicitDraftKind(nextInterface);
      applyModelState((prev) => reconcileCursorModelStateForInterface(prev, nextInterface));
      if (modelStateRef.current.provider === "cursor") {
        void loadProviderModels("cursor", {
          applyDefault: false,
          force: true,
          interfaceMode: nextInterface,
        }).then(() => {
          const current = modelStateRef.current;
          if (current.provider !== "cursor" || current.interfaceMode !== nextInterface) return;
          applyModelState((prev) => reconcileCursorModelStateForInterface(prev, nextInterface));
        }).catch(() => undefined);
      }
      return;
    }
    if (row.kind === "model") {
      cycleModel(direction);
      return;
    }
    if (row.kind === "reasoning") {
      cycleReasoning(direction);
      return;
    }
    if (row.kind === "permission") {
      cyclePermission(direction);
      return;
    }
    if (row.kind === "codex-fast") {
      applyModelState((prev) => ({ ...prev, fastMode: !prev.fastMode }));
      return;
    }
    if (row.kind === "output-style") {
      const sessionId = activeSessionIdRef.current;
      if (!conn || !sessionId) return;
      void (async () => {
        const styles = await listClaudeOutputStyles(conn, sessionId);
        const names = styles.map((style) => style.name).filter(Boolean);
        if (!names.length) {
          addNotice("No Claude output styles were found.", "info");
          return;
        }
        const current = activeSessionRef.current?.claudeOutputStyle ?? row.value ?? "default";
        const index = Math.max(0, names.findIndex((name) => name.toLowerCase() === current.toLowerCase()));
        const next = names[(index + direction + names.length) % names.length] ?? names[0]!;
        await setClaudeOutputStyle(conn, sessionId, next);
        addNotice(`Claude output style set to ${next}.`, "success");
        await refreshState();
      })().catch((err) => addNotice(err instanceof Error ? err.message : String(err), "error"));
      return;
    }
    if (row.kind === "refresh-status") {
      void refreshAiSetupStatus({ force: true })
        .then(() => addNotice("AI provider status refreshed.", "success"))
        .catch((err) => addNotice(err instanceof Error ? err.message : String(err), "error"));
      return;
    }
    if (row.kind === "apply") {
      if (activeTerminalSessionRef.current && modelStateRef.current.provider === "claude") {
        const commandKey = claudeModelCommandKey(modelStateRef.current, activeTerminalSessionRef.current.terminalId);
        if (lastModelPickerClaudeSentKeyRef.current !== commandKey) {
          lastModelPickerClaudeSentKeyRef.current = commandKey;
          void sendClaudeModelCommandToTerminal()
            .then((sent) => {
              if (!sent && lastModelPickerClaudeSentKeyRef.current === commandKey) {
                lastModelPickerClaudeSentKeyRef.current = null;
              }
            })
            .catch((err) => {
              if (lastModelPickerClaudeSentKeyRef.current === commandKey) {
                lastModelPickerClaudeSentKeyRef.current = null;
              }
              addNotice(err instanceof Error ? err.message : String(err), "error");
            });
        }
      }
      setRightOpen(false);
      setRightPane({ kind: "empty" });
      lastUserOpenedPaneRef.current = null;
      focusChat();
    }
	  }, [addNotice, applyModelState, cycleModel, cyclePermission, cycleProvider, cycleReasoning, focusChat, loadProviderModels, models, persistExplicitDraftKind, refreshAiSetupStatus, refreshState, sendClaudeModelCommandToTerminal]);

  const recallPromptHistory = useCallback((direction: "previous" | "next"): boolean => {
    const focusedSessionId = (gridViewActiveRef.current ? focusedSessionIdForMultiView(multiViewRef.current) : null);
    const history = focusedSessionId
      ? promptHistoryBySessionIdRef.current[focusedSessionId] ?? []
      : promptHistoryRef.current;
    if (!history.length) {
      if (direction === "previous") {
        addNotice("No prompt history in this chat yet.", "info");
      }
      return true;
    }
    if (activePaneRef.current !== "chat") {
      focusChat();
    }
    let index = focusedSessionId
      ? promptHistoryIndexBySessionIdRef.current[focusedSessionId] ?? null
      : promptHistoryIndexRef.current;
    if (index == null) {
      if (focusedSessionId) {
        promptHistoryDraftBySessionIdRef.current[focusedSessionId] = promptRef.current || chatDraftRef.current;
      } else {
        promptHistoryDraftRef.current = promptRef.current || chatDraftRef.current;
      }
      index = history.length;
    }
    const nextIndex = direction === "previous"
      ? Math.max(0, index - 1)
      : Math.min(history.length, index + 1);
    if (focusedSessionId) {
      promptHistoryIndexBySessionIdRef.current[focusedSessionId] = nextIndex >= history.length ? null : nextIndex;
    } else {
      promptHistoryIndexRef.current = nextIndex >= history.length ? null : nextIndex;
    }
    const draft = focusedSessionId
      ? promptHistoryDraftBySessionIdRef.current[focusedSessionId] ?? ""
      : promptHistoryDraftRef.current;
    const nextPrompt = nextIndex >= history.length ? draft : history[nextIndex] ?? "";
    chatDraftRef.current = nextPrompt;
    setPromptValue(nextPrompt);
    if (vimModeEnabled) setVimMode("insert");
    return true;
  }, [addNotice, focusChat, setPromptValue, vimModeEnabled]);

  const openHistorySearch = useCallback(() => {
    const query = (promptRef.current || chatDraftRef.current).trim().toLowerCase();
    const rows = [...promptHistoryRef.current]
      .reverse()
      .filter((entry) => !query || entry.toLowerCase().includes(query))
      .slice(0, 20)
      .map((entry) => {
        const compact = entry.replace(/\s+/g, " ");
        return compact.length > 34 ? `${compact.slice(0, 33)}…` : compact;
      });
    setRightPane({
      kind: "list",
      title: "History search",
      rows,
      emptyText: query ? `No prompt history matched "${query}".` : "No prompt history in this chat yet.",
    });
    setRightOpen(true);
    setPaneFocus("details");
  }, [setPaneFocus]);

  /**
   * Put a materialized image into the draft as an inline `⟦image:png⟧`
   * token at the caret.
   *
   * The token — not a detached chip hanging off the composer — is the image.
   * That is what makes it belong to this chat's draft (so it can't leak into
   * another chat), removable with a single Backspace, and visible in the text
   * the user is composing.
   */
  const addImageMention = useCallback((filePath: string): void => {
    const existing = promptImageAttachmentsRef.current;
    const alreadyAttached = existing.find((entry) => entry.path === filePath);
    if (alreadyAttached && promptRef.current.includes(alreadyAttached.label)) {
      addNotice("That image is already in the prompt.", "info");
      return;
    }
    const label = uniqueImageTokenLabel(
      existing.map((entry) => entry.label),
      path.basename(filePath),
    );
    const next = insertImageToken(promptRef.current, promptCursorRef.current, label);
    promptImageAttachmentsRef.current = [...existing, { label, path: filePath }].slice(-12);
    chatDraftRef.current = next.value;
    setPromptValue(next.value, next.cursor);
    addNotice("Attached clipboard image.", "success");
  }, [addNotice, setPromptValue]);

  const attachClipboardImage = useCallback((): boolean => {
    // The clipboard always lives on the machine running the TUI. When the
    // runtime is remote, `project.workspaceRoot` points at a path on the other
    // machine — writing there locally fails (and would be unreadable by the
    // agent anyway), so materialize into a local scratch dir and upload the
    // bytes to the runtime, mirroring the desktop composer. For a local runtime
    // write into the active lane's worktree so the file lands in the checkout
    // the chat actually belongs to.
    const cacheRoot = clipboardImageCacheRootForRuntime({
      remoteLaunch,
      activeLaneWorktreePath: activeLane?.worktreePath,
      workspaceRoot: project.workspaceRoot,
    });
    let attachment: AgentChatFileRef | null = null;
    try {
      attachment = readClipboardImageAttachment(cacheRoot);
    } catch (err) {
      addNotice(`Could not read the clipboard image: ${err instanceof Error ? err.message : String(err)}`, "error");
      return true;
    }
    if (!attachment) {
      const clipboardHint = process.platform === "win32"
        ? "On Windows, copy an image or image file path; ADE Code reads the system clipboard through PowerShell."
        : process.platform === "darwin"
          ? "On macOS, copy an image or image file path; ADE Code checks pngpaste and pbpaste."
          : "Copy an image or image file path; ADE Code checks wl-paste and xclip when available.";
      addNotice(`No clipboard image was found. ${clipboardHint}`, "error");
      return true;
    }
    if (activePaneRef.current !== "chat") {
      focusChat();
    }

    if (!remoteLaunch) {
      addImageMention(attachment.path);
      return true;
    }

    const localPath = attachment.path;
    // Only the temp files ADE materialized under the scratch dir are ours to
    // delete. The clipboard may instead reference a pre-existing user file
    // (copied image file / file path) — upload its bytes, but never delete it.
    const isScratchTemp = isClipboardScratchTemp(localPath, cacheRoot);
    const cleanupScratchTemp = (): void => {
      if (isScratchTemp) void fs.promises.rm(localPath, { force: true }).catch(() => {});
    };

    const conn = connectionRef.current;
    if (!conn) {
      addNotice("Not connected to the remote runtime — can't attach the image yet.", "error");
      cleanupScratchTemp();
      return true;
    }

    // The upload is async, so the attachment chip only appears after the
    // round-trip. Give immediate feedback, and capture the chat this paste
    // belongs to: if the user switches chats mid-upload, attaching the mention
    // to whatever chat is now focused would drop the image into the wrong
    // context — so only attach when still on the same session.
    const targetSessionId = activeSessionIdRef.current;
    addNotice("Uploading clipboard image to the remote runtime…", "info");
    void (async () => {
      try {
        const { path: remotePath } = await uploadClipboardImageAttachmentToRuntime(conn, localPath);
        if (activeSessionIdRef.current !== targetSessionId) {
          addNotice("Clipboard image uploaded, but you switched chats — not attaching it here.", "info");
          return;
        }
        addImageMention(remotePath);
      } catch (err) {
        addNotice(`Could not upload the clipboard image to the remote runtime: ${err instanceof Error ? err.message : String(err)}`, "error");
      } finally {
        cleanupScratchTemp();
      }
    })();
    return true;
  }, [activeLane?.worktreePath, addImageMention, addNotice, focusChat, project.workspaceRoot, remoteLaunch]);

  // Resolve the deeplink target for the row/pane currently focused in the
  // lanes-picker, PR-picker or plugin-panel contexts. Returns `null` when the
  // focus is on something the deeplink scheme does not cover (chat preview,
  // slash-prompt pane, etc.) — keep this conservative so we never copy a
  // misleading URL.
  const resolveFocusedDeeplinkRow = useCallback((): DeeplinkRow | null => {
    const pane = activePaneRef.current;

    // An open plugin panel is addressable: the pane knows the plugin and the
    // panel, which is the whole `plugin` target.
    if (pane === "details" && rightPane.kind === "plugin-panel") {
      return {
        kind: "plugin",
        pluginId: rightPane.state.pluginId,
        panelId: rightPane.state.panelId,
        ...(rightPane.state.context ? { context: rightPane.state.context } : {}),
      };
    }

    // PR-picker context: the lane-details right pane is showing and the focus
    // ring is on its PR row. We prefer this over the lane row when both are
    // available so Ctrl+Y on a highlighted PR copies the PR deeplink.
    if (
      pane === "details"
      && rightPane.kind === "lane-details"
      && rightPane.pr
      && rightPane.selectedActionIndex === LANE_DETAIL_PR_ACTION_INDEX
    ) {
      const prNumber = rightPane.pr.number;
      const url = rightPane.pr.url;
      return { kind: "pr", pr: { url, prNumber } };
    }

    // Lanes-picker context: the drawer is open on lanes (or chats — fall back
    // to the lane that owns the focused chat) and a row is highlighted.
    if (pane === "drawer" && drawerOpen) {
      const lane = highlightedDrawerLane ?? drawerLane ?? activeLane;
      if (lane) return { kind: "lane", lane: { id: lane.id } };
    }

    // Lane-details pane with focus on a non-PR action row: still useful to
    // copy the lane deeplink so the user can hand it off to a teammate.
    if (pane === "details" && rightPane.kind === "lane-details") {
      return { kind: "lane", lane: { id: rightPane.lane.id } };
    }
    return null;
  }, [activeLane, drawerLane, drawerOpen, highlightedDrawerLane, rightPane]);

  /**
   * Run a plugin action a keyboard shortcut fired.
   *
   * The three outcomes are `runPluginRowAction`'s, deliberately: a chord and a
   * row press are the same invocation wearing different affordances, so a
   * `navigate` opens that plugin's panel, a `composer` verb reaches the prompt
   * line, and anything else is a result the user is told ran. A second set of
   * rules here would mean a plugin behaves differently depending on how it was
   * reached, which is the drift the shared dispatch contract exists to prevent.
   */
  const runPluginKeybindingAction = useCallback(async (pluginId: string, actionId: string): Promise<void> => {
    const conn = connectionRef.current;
    if (!conn) {
      addNotice("ADE runtime is still connecting.", "error");
      return;
    }
    const row = pluginKeybindingRowsRef.current
      .find((entry) => entry.rawAction === `plugin:${pluginId}:${actionId}`);
    const label = row?.label ?? actionId;
    const who = row?.pluginName ?? pluginId;
    const follow = async (result: unknown): Promise<void> => {
      applyPluginOpenUrl(result, label);
      const navigation = readPluginActionNavigation(result);
      if (navigation) {
        setRightSelectionIndex(0);
        await loadPluginPane({
          pluginId,
          displayName: who,
          panelId: navigation.panelId,
          context: navigation.context ?? null,
        }, { open: true });
        return;
      }
      applyPluginComposerEdit(result, label);
    };
    try {
      const result = await invokePluginAction(conn, pluginId, actionId, {});
      addNotice(`${who} · ${label} ran.`, "success");
      if (askPluginPrompt({
        result,
        pluginId,
        displayName: who,
        actionId,
        args: {},
        label,
        follow,
      })) return;
      await follow(result);
    } catch (error) {
      addNotice(error instanceof Error ? error.message : String(error), "error");
    }
  }, [addNotice, applyPluginComposerEdit, applyPluginOpenUrl, askPluginPrompt, loadPluginPane]);

  const runKeybindingAction = useCallback((action: TuiResolvedKeybindingAction): boolean => {
    // The parameterized plugin escape, checked before the closed union: a
    // plugin's verbs are not knowable at build time, so `plugin:<id>:<action>`
    // is the one action shape this chain reads apart rather than compares.
    const pluginTarget = parsePluginKeybindingAction(action);
    if (pluginTarget) {
      void runPluginKeybindingAction(pluginTarget.pluginId, pluginTarget.actionId);
      return true;
    }
    const reportUnavailable = (label = action): true => {
      addNotice(`${label} is recognized, but there is no active ADE Code control for it right now.`, "info");
      return true;
    };
    if (action === "app:interrupt") {
      const conn = connectionRef.current;
      const sessionId = activeSessionIdRef.current;
      const activeTurnVisible = streaming || activeSessionRef.current?.status === "active";
      if (activeTurnVisible && conn && sessionId) {
        setStreaming(false);
        setInterrupted(true);
        void interruptChat(conn, sessionId)
          .then((result) => addNotice(chatInterruptNotice(result), "info"))
          .catch((err) => addNotice(err instanceof Error ? err.message : String(err), "error"));
      } else {
        addNotice("No active response to interrupt.", "info");
      }
      return true;
    }
    if (action === "app:help") {
      renderHelpPane("", 0, helpRecentsRef.current);
      focusDetails();
      return true;
    }
    if (action === "app:redraw") {
      void refreshState().catch((err) => addNotice(err instanceof Error ? err.message : String(err), "error"));
      return true;
    }
    if (action === "app:clear" || action === "chat:clearScreen") {
      setClearedAt(new Date().toISOString());
      clearOlderHistoryCursor(activeSessionIdRef.current);
      eventDedupKeysRef.current.clear();
      eventDedupKeyOrderRef.current = [];
      eventCountRef.current = 0;
      setEvents([]);
      setChatScrollOffset(0);
      addNotice("Cleared local transcript view.", "success");
      return true;
    }
    if (action === "app:toggleTodos" || action === "app:toggleTranscript") {
      toggleDetailsPane();
      return true;
    }
    if (action === "app:quit" || action === "app:exit") {
      requestAppExit();
      return true;
    }
    if (action === "chat:submit") {
      void submitPrompt(prompt);
      return true;
    }
    if (action === "chat:launchBackground") {
      void launchPromptInBackground(prompt);
      return true;
    }
    if (action === "chat:cancel" || action === "chat:clearInput") {
      handlePromptChange("");
      return true;
    }
    if (action === "chat:killAgents") {
      return reportUnavailable("chat:killAgents");
    }
    if (action === "chat:cycleMode" || action === "confirm:cycleMode") {
      cyclePermission(1);
      return true;
    }
    if (action === "chat:modelPicker") {
      openModelWizard();
      return true;
    }
    if (action === "chat:fastMode") {
      const activeModel = models.find((entry) => entry.id === modelState.modelId || entry.modelId === modelState.modelId);
      const descriptor = modelState.modelId ? getModelById(modelState.modelId) : undefined;
      const fastSupported =
        Boolean(activeModel?.serviceTiers?.some((tier) => tier.trim().toLowerCase() === "fast"))
        || modelSupportsFastMode(descriptor);
      if (fastSupported) {
        applyModelState((prev) => ({ ...prev, fastMode: !prev.fastMode }));
      } else if (modelState.provider === "claude") {
        void submitPrompt("/fast");
      } else {
        addNotice("Fast mode is not available for the active provider.", "info");
      }
      return true;
    }
    if (action === "chat:thinkingToggle" || action === "modelPicker:increaseEffort") {
      cycleReasoning(1);
      return true;
    }
    if (action === "modelPicker:decreaseEffort") {
      cycleReasoning(-1);
      return true;
    }
    if (action === "chat:new-line" || action === "chat:newline") {
      // Insert at the caret, not at the end of the draft, and move the caret
      // past it — appending blind put the break in the wrong place whenever the
      // user had arrowed back into the text, and left the caret behind it.
      const next = insertPromptText(promptRef.current, promptCursorRef.current, "\n");
      setFormDiscardArmed(false);
      if (activePaneRef.current === "chat") chatDraftRef.current = next.value;
      setPromptValue(next.value, next.cursor);
      return true;
    }
    if (action === "chat:paste-image" || action === "chat:imagePaste") {
      return attachClipboardImage();
    }
    if (action === "chat:open-image" || action === "chat:openImage") {
      if (openImageTokenAtCursor()) return true;
      openLatestImage();
      return true;
    }
    if (action === "chat:open-editor" || action === "chat:externalEditor") {
      const edited = editPromptInExternalEditor(prompt);
      if (edited == null) {
        addNotice("External editor exited without updating the prompt.", "error");
        return true;
      }
      handlePromptChange(edited);
      focusChat();
      addNotice("Loaded prompt from external editor.", "success");
      return true;
    }
    if (action === "chat:undo") {
      return reportUnavailable("chat:undo");
    }
    if (action === "chat:stash") {
      const current = prompt.trim();
      if (current) {
        promptHistoryRef.current = [...promptHistoryRef.current, current].slice(-100);
        handlePromptChange("");
        addNotice("Stashed prompt in local history.", "success");
      }
      return true;
    }
    if (action === "history:previous" || action === "history:next") {
      return recallPromptHistory(action === "history:previous" ? "previous" : "next");
    }
    if (action === "history:search" || action === "historySearch:next") {
      openHistorySearch();
      return true;
    }
    if (action === "historySearch:accept" || action === "historySearch:cancel" || action === "historySearch:execute") {
      focusChat();
      return true;
    }
    if (action === "pane:toggle") {
      toggleDetailsPane();
      return true;
    }
    if (action === "pane:agents") {
      toggleSubagentsPane();
      return true;
    }
    if (action === "pane:close") {
      if (rightOpen) {
        userDismissedRightPaneRef.current = true;
        setRightOpen(false);
        // Explicit close clears the slash-command sticky marker so the next
        // open recomputes to the context default.
        lastUserOpenedPaneRef.current = null;
        setRightPane((prev) => prev.kind === "form" ? { kind: "empty" } : prev);
        focusAfterDetails();
      } else if (drawerOpen) {
        setDrawerOpen(false);
        focusChat();
      }
      return true;
    }
    if (
      action === "autocomplete:accept"
      || action === "confirm:yes"
      || action === "messageSelector:select"
      || action === "select:accept"
      || action === "footer:openSelected"
      || action === "diff:viewDetails"
    ) {
      return reportUnavailable();
    }
    if (
      action === "autocomplete:dismiss"
      || action === "confirm:no"
      || action === "select:cancel"
      || action === "help:dismiss"
      || action === "transcript:exit"
      || action === "diff:dismiss"
      || action === "attachments:exit"
      || action === "footer:clearSelection"
      || action === "settings:close"
    ) {
      if (rightOpen) {
        setRightOpen(false);
        lastUserOpenedPaneRef.current = null;
      }
      if (drawerOpen) setDrawerOpen(false);
      selectFooterControl(null);
      focusChat();
      return true;
    }
    if (action === "tabs:next" || action === "footer:next") {
      cyclePaneFocus(1);
      return true;
    }
    if (action === "tabs:previous" || action === "footer:previous") {
      cyclePaneFocus(-1);
      return true;
    }
    if (action === "footer:up" || action === "footer:down") {
      if (action === "footer:up") {
        selectFooterControl(null);
        focusChat();
      } else {
        selectFooterControl(footerControls[0] ?? "drawer");
      }
      return true;
    }
    if (
      action === "autocomplete:previous"
      || action === "confirm:previous"
      || action === "messageSelector:up"
      || action === "select:previous"
      || action === "attachments:previous"
      || action === "diff:previousFile"
    ) {
      setChatScrollOffset((offset) => offset + 1);
      return true;
    }
    if (
      action === "autocomplete:next"
      || action === "confirm:next"
      || action === "messageSelector:down"
      || action === "select:next"
      || action === "attachments:next"
      || action === "diff:nextFile"
    ) {
      setChatScrollOffset((offset) => offset - 1);
      return true;
    }
    if (action === "confirm:nextField" || action === "confirm:previousField" || action === "confirm:toggle" || action === "confirm:toggleExplanation" || action === "permission:toggleDebug") {
      return reportUnavailable();
    }
    if (action === "transcript:toggleShowAll") {
      toggleDetailsPane();
      return true;
    }
    if (action === "task:background" || action === "theme:toggleSyntaxHighlighting") {
      return reportUnavailable();
    }
    if (action === "attachments:remove") {
      return reportUnavailable();
    }
    if (action === "messageSelector:top") {
      setChatScrollOffset(Number.MAX_SAFE_INTEGER);
      return true;
    }
    if (action === "messageSelector:bottom") {
      setChatScrollOffset(0);
      return true;
    }
    if (action === "diff:previousSource" || action === "diff:nextSource" || action === "diff:back") {
      return reportUnavailable();
    }
    if (action === "plugin:toggle" || action === "plugin:install" || action === "plugin:favorite" || action === "settings:search" || action === "settings:retry" || action === "doctor:fix" || action === "voice:pushToTalk") {
      return reportUnavailable();
    }
    if (action === "scroll:up" || action === "scroll:lineUp") {
      setChatScrollOffset((offset) => offset + 1);
      return true;
    }
    if (action === "scroll:down" || action === "scroll:lineDown") {
      setChatScrollOffset((offset) => offset - 1);
      return true;
    }
    if (action === "scroll:pageUp" || action === "scroll:halfPageUp") {
      setChatScrollOffset((offset) => offset + Math.max(1, chatRowBudget - 2));
      return true;
    }
    if (action === "scroll:pageDown" || action === "scroll:halfPageDown") {
      setChatScrollOffset((offset) => offset - Math.max(1, chatRowBudget - 2));
      return true;
    }
    if (action === "scroll:fullPageUp") {
      setChatScrollOffset((offset) => offset + Math.max(1, chatRowBudget));
      return true;
    }
    if (action === "scroll:fullPageDown") {
      setChatScrollOffset((offset) => offset - Math.max(1, chatRowBudget));
      return true;
    }
    if (action === "scroll:top") {
      setChatScrollOffset(Number.MAX_SAFE_INTEGER);
      return true;
    }
    if (action === "scroll:bottom") {
      setChatScrollOffset(0);
      return true;
    }
    if (action === "selection:copy") {
      copyChatSelection();
      return true;
    }
    if (action === "app:copyAdeDeeplink") {
      const row = resolveFocusedDeeplinkRow();
      if (!row) {
        addNotice("No lane, PR or plugin panel is focused to copy a deeplink for.", "info");
        return true;
      }
      const url = buildDeeplinkForRow(row);
      if (!url) {
        // A panel whose ids the grammar will not carry still has the plugin's
        // own word on where this content lives, in the schema's fallback. Only
        // for a plugin row: an unlinkable PR row must not copy whatever panel
        // happens to be open in the right pane.
        const pluginPane = rightPaneRef.current;
        const link = row.kind === "plugin" && pluginPane.kind === "plugin-panel"
          ? pluginPane.model.fallback?.deeplink
          : null;
        if (link) {
          if (copyToClipboard(link)) addNotice("Plugin panel link copied", "success");
          else addNotice(`Plugin panel link: ${link}`, "info");
          return true;
        }
        addNotice("Cannot build an ADE deeplink for the focused row.", "error");
        return true;
      }
      if (copyToClipboard(url)) {
        addNotice("ADE deeplink copied", "success");
      } else {
        addNotice(`ADE deeplink: ${url}`, "info");
      }
      return true;
    }
    if (action === "app:copyAdeWebLink") {
      const row = resolveFocusedDeeplinkRow();
      if (!row) {
        addNotice("No lane, PR or plugin panel is focused to copy a web link for.", "info");
        return true;
      }
      const url = buildWebClientUrlForRow(row);
      if (!url) {
        // The hosted client mounts plugin panels now, so a plugin row failing
        // here means its ids did not survive the shared manifest grammar — the
        // same reason any other row fails, and the same generic answer.
        addNotice("Cannot build an ADE web link for the focused row.", "error");
        return true;
      }
      if (copyToClipboard(url)) {
        addNotice("ADE web link copied", "success");
      } else {
        addNotice(`ADE web link: ${url}`, "info");
      }
      return true;
    }
    if (action === "app:openCommandPalette") {
      openCommandPalette();
      return true;
    }
    if (action.startsWith("selection:")) {
      return reportUnavailable();
    }
    return reportUnavailable();
  }, [addNotice, applyModelState, attachClipboardImage, chatRowBudget, clearOlderHistoryCursor, copyChatSelection, cycleFooterControl, cyclePaneFocus, cyclePermission, cycleReasoning, drawerOpen, focusAfterDetails, focusChat, focusDetails, footerControls, launchPromptInBackground, modelState.provider, openCommandPalette, openHistorySearch, openModelWizard, prompt, recallPromptHistory, refreshState, openImageTokenAtCursor, openLatestImage, requestAppExit, resolveFocusedDeeplinkRow, rightOpen, runPluginKeybindingAction, selectFooterControl, setChatScrollOffset, setPromptValue, submitPrompt, toggleDetailsPane, toggleSubagentsPane]);

  const chatPointFromMouse = useCallback((
    x: number | null,
    y: number | null,
    clampToChat: boolean,
  ): ChatSelectionPoint | null => {
    if (x == null || y == null) return null;
    const drawerWidth = resolveDrawerPaneWidth(columns, drawerOpen);
    const textStartColumn = drawerWidth + 2;
    const textEndColumn = textStartColumn + Math.max(1, chatWrapWidth) - 1;
    const topRow = 3 + goalBannerRows + addModeRows;
    const bottomRow = topRow + Math.max(1, chatRowBudget) - 1;
    if (!clampToChat && (x < textStartColumn || x > textEndColumn || y < topRow || y > bottomRow)) {
      return null;
    }
    const visibleRow = Math.max(0, Math.min(y - topRow, Math.max(0, chatRowBudget - 1)));
    const column = Math.max(0, Math.min(x - textStartColumn, Math.max(0, chatWrapWidth - 1)));
    return chatSelectionPointFromVisibleRows(visibleChatSelectionRows, visibleRow, column, clampToChat);
  }, [addModeRows, chatRowBudget, chatWrapWidth, drawerOpen, goalBannerRows, visibleChatSelectionRows]);

  // Map a transcript click to a collapsible work-group header id (tool calls /
  // file changes), if the click landed on one. Mirrors chatPointFromMouse's
  // viewport math but returns the row's expandableId instead of a text point so
  // a plain click can toggle the group's collapse state.
  const chatRowTargetFromMouse = useCallback((
    x: number | null,
    y: number | null,
  ): { expandableId: string | null; actionId: string | null } | null => {
    if (x == null || y == null) return null;
    const drawerWidth = resolveDrawerPaneWidth(columns, drawerOpen);
    const textStartColumn = drawerWidth + 2;
    const textEndColumn = textStartColumn + Math.max(1, chatWrapWidth) - 1;
    const topRow = 3 + goalBannerRows + addModeRows;
    const bottomRow = topRow + Math.max(1, chatRowBudget) - 1;
    if (x < textStartColumn || x > textEndColumn || y < topRow || y > bottomRow) return null;
    const visibleRow = Math.max(0, Math.min(y - topRow, Math.max(0, chatRowBudget - 1)));
    const row = visibleChatSelectionRows[visibleRow];
    if (!row) return null;
    return {
      expandableId: row.expandableId ?? null,
      actionId: row.actionId ?? null,
    };
  }, [addModeRows, chatRowBudget, chatWrapWidth, columns, drawerOpen, goalBannerRows, visibleChatSelectionRows]);

  const openFileChangeDiffAction = useCallback((actionId: string): boolean => {
    for (const block of displayBlocksRef.current) {
      if (block.kind !== "files-changed-group") continue;
      const selected = block.entries.find((entry) => workFileDiffKey(block.id, entry.itemId) === actionId);
      if (!selected) continue;
      const files = block.entries.map((entry) => ({
        path: entry.path,
        additions: entry.additions,
        deletions: entry.deletions,
        body: entry.diff,
      }));
      const title = block.entries.length === 1 ? selected.path : "This turn";
      setRightPane({ kind: "diff", title, files });
      setRightOpen(true);
      lastUserOpenedPaneRef.current = "diff";
      focusDetailsOnly();
      return true;
    }
    return false;
  }, [focusDetailsOnly]);

  const toggleExpandedLineId = useCallback((lineId: string) => {
    setExpandedLineIds((prev) => {
      const next = new Set(prev);
      if (next.has(lineId)) next.delete(lineId);
      else next.add(lineId);
      return next;
    });
  }, []);

  const chatSelectionEdgeFromMouseY = useCallback((y: number | null): ChatSelectionEdgeDirection | null => {
    const topRow = 3 + goalBannerRows + addModeRows;
    return chatSelectionEdgeDirectionForMouseY({
      y,
      topRow,
      rowBudget: chatRowBudget,
      scrollOffsetRows: chatScrollOffsetRowsRef.current,
      maxScrollOffsetRows: chatScrollMaxOffsetRef.current,
    });
  }, [addModeRows, chatRowBudget, goalBannerRows]);


  /**
   * Enter (or a click) on a sessions-pane row. Shelf clicks only toggle the
   * drawer — they must not steal the work-list cursor, or the right pane
   * falls back to lane details. Singleton identity clicks open lane details
   * the same way a lane-header row does.
   */
  const activateWorkRow = useCallback((row: WorkListRow, region: WorkListHitRegion = "body") => {
    if (row.kind === "shelf") {
      toggleWorkShelf(row.shelf);
      return;
    }
    if (
      row.kind === "session"
      && region === "lane-identity"
      && row.showLaneIdentity
      && row.laneId
    ) {
      const lane = lanesRef.current.find((entry) => entry.id === row.laneId) ?? null;
      if (lane) {
        setWorkSelectedKey(row.key);
        setSelectedDrawerChatId(row.sessionId);
        setSelectedWorkChatAction(null);
        openLaneDetailsPane(lane);
        return;
      }
    }
    selectWorkRow(row);
    switch (row.kind) {
      case "session": {
        if (row.machine) return; // `selectWorkRow` already showed the connect notice.
        const closedTerminal = terminalSessionsRef.current.find(
          (terminal) => terminal.terminalId === row.sessionId && terminal.status !== "running",
        ) ?? null;
        if (closedTerminal) {
          if (!isTerminalSessionResumable(closedTerminal)) {
            addNotice("This CLI session cannot be resumed.", "info");
            return;
          }
          void resumeClosedTerminalSession(closedTerminal)
            .then((resumed) => {
              if (resumed) addNotice("Resuming CLI session…", "info");
            })
            .catch((err) => addNotice(err instanceof Error ? err.message : String(err), "error"));
          return;
        }
        focusChat();
        setRightPane({ kind: "chat-info", info: buildChatInfoSnapshotRef.current() });
        setRightOpen(true);
        lastUserOpenedPaneRef.current = "chat-info";
        return;
      }
      case "lane-header": {
        const lane = row.laneId ? lanesRef.current.find((entry) => entry.id === row.laneId) ?? null : null;
        if (!lane) return;
        openLaneDetailsPane(lane);
        return;
      }
      case "new-chat":
        openNewChatSetup();
        return;
      default: {
        const _exhaustive: never = row;
        return _exhaustive;
      }
    }
  }, [
    addNotice,
    focusChat,
    openLaneDetailsPane,
    openNewChatSetup,
    resumeClosedTerminalSession,
    selectWorkRow,
    toggleWorkShelf,
  ]);

  /**
   * The sessions pane's whole keyboard surface, in ONE place. The drawer needed
   * six branches in the global key chain (two arrow branches × two modes, Tab,
   * Enter, and two hotkey branches); the pane needs one, because there is one
   * flat row list and one cursor.
   *
   * Returns true when it consumed the key.
   */
  const handleWorkPaneKey = useCallback((input: string, key: InkKey): boolean => {
    const rows = workListModelRef.current.rows;
    const selectedKey = workSelectedKeyRef.current;
    const selectedRow = rows[workListRowIndex(rows, selectedKey)] ?? null;
    if (key.upArrow || key.downArrow) {
      const nextKey = stepWorkListSelection(rows, selectedKey, key.upArrow ? -1 : 1);
      const nextRow = rows[workListRowIndex(rows, nextKey)] ?? null;
      if (nextRow) selectWorkRow(nextRow);
      return true;
    }
    if (key.return) {
      if (selectedRow) activateWorkRow(selectedRow);
      return true;
    }
    // Row hotkeys: r=rename, a=archive, x=delete. Modified keystrokes belong to
    // the global chain (e.g. Ctrl+R history search).
    if (!key.ctrl && !key.meta && /^[raxRAX]$/.test(input)) {
      const hotkey = input.toLowerCase();
      if (selectedRow?.kind === "session" && !selectedRow.machine) {
        if (!sessionsRef.current.some((session) => session.sessionId === selectedRow.sessionId)) return false;
        if (hotkey === "r") openChatRenameForm(selectedRow.sessionId);
        else if (hotkey === "a") void archiveChat(selectedRow.sessionId);
        else openChatDeleteForm(selectedRow.sessionId);
        return true;
      }
      if (selectedRow?.kind === "lane-header" && selectedRow.laneId) {
        const lane = lanesRef.current.find((entry) => entry.id === selectedRow.laneId) ?? null;
        if (!lane || lane.laneType === "primary") return false;
        if (hotkey === "r") openLaneRenameForm(lane.id);
        else if (hotkey === "a") void archiveLane(lane.id);
        else openLaneDeleteForm(lane.id);
        return true;
      }
    }
    return false;
  }, [
    activateWorkRow,
    archiveChat,
    archiveLane,
    openChatDeleteForm,
    openChatRenameForm,
    openLaneDeleteForm,
    openLaneRenameForm,
    selectWorkRow,
  ]);

  useInput((input, key) => {
    if (!connectionRef.current && error) {
      if (isCtrlInput(input, key, "c")) {
        requestAppExit();
        return;
      }
      if (!key.ctrl && !key.meta && (input === "r" || input === "R")) {
        retryStartupConnection();
        return;
      }
      return;
    }
    if (attachedTerminalIdRef.current) {
      if (terminalControlInputAction(input, key) === "detach") {
        setAttachedTerminalId(null);
        // If we popped out of the grid to take control, drop back into it.
        const returnSessionId = controlReturnToGridRef.current;
        controlReturnToGridRef.current = null;
        if (returnSessionId && multiViewRef.current) {
          const idx = multiViewRef.current.tiles.findIndex((tile) => tile.sessionId === returnSessionId);
          if (idx >= 0) focusMultiViewTile(idx);
        }
      }
      return;
    }
    if (isTerminalControlToggle(input, key)) {
      // Grid view: Ctrl+T pops the focused provider CLI terminal tile out to
      // single view and enters control; exiting control returns to the grid.
      if (gridViewActiveRef.current) {
        const focusedId = focusedSessionIdForMultiView(multiViewRef.current);
        const tile = focusedId
          ? multiViewRef.current?.tiles.find((entry) => entry.sessionId === focusedId) ?? null
          : null;
        const terminal = focusedId
          ? terminalSessionsRef.current.find((entry) => entry.terminalId === focusedId) ?? null
          : null;
        if (tile && terminal && terminal.status === "running" && terminalSessionProvider(terminal)) {
          controlReturnToGridRef.current = focusedId;
          setGridView(false);
          selectActiveLaneId(tile.laneId);
          selectActiveSessionId(focusedId);
          focusChat();
          setAttachedTerminalId(focusedId);
        }
        return;
      }
      const terminal = activeTerminalSession ?? activeTerminalSessionRef.current;
      if (
        terminal?.terminalId === activeSessionIdRef.current
        && terminal.status === "running"
        && terminalSessionProvider(terminal)
      ) {
        focusChat();
        setAttachedTerminalId(terminal.terminalId);
      }
      return;
    }
    // Claude live PTY pane (not attached, single view): keyboard scrollback over
    // the headless xterm buffer + copy of the visible region. PageUp/PageDown,
    // Home/End and Shift+Up/Down (when not editing the prompt) drive scrollback;
    // Ctrl/Cmd+C copies the visible window via the shared writeClipboardText.
    {
      const terminalForScroll = (activeTerminalSession ?? activeTerminalSessionRef.current);
      const terminalPaneVisible = Boolean(terminalForScroll) && !multiViewRef.current;
      if (terminalPaneVisible && terminalForScroll) {
        const sid = terminalForScroll.terminalId;
        const metrics = terminalViewportMetricsRef.current;
        const step = terminalPageStep(Math.max(1, chatRowBudget));
        const isHome = input === "\x1b[H" || input === "\x1b[1~";
        const isEnd = input === "\x1b[F" || input === "\x1b[4~";
        const promptHasText = promptRef.current.trim().length > 0;
        const wantsScrollUp = key.pageUp || (key.shift && key.upArrow && !promptHasText);
        const wantsScrollDown = key.pageDown || (key.shift && key.downArrow && !promptHasText);
        if (wantsScrollUp || wantsScrollDown || isHome || isEnd) {
          setTerminalScrollBySessionId((prev) => {
            const current = readTerminalScroll(prev, sid);
            let next = current;
            if (isEnd) next = jumpTerminalToBottom(current);
            else if (isHome) {
              next = {
                scrollOffset: clampTerminalScrollOffset(metrics.maxScrollable, metrics.maxScrollable),
                pendingNewCount: 0,
              };
            } else if (wantsScrollUp) next = scrollTerminalBy(current, step, metrics.maxScrollable);
            else if (wantsScrollDown) next = scrollTerminalBy(current, -step, metrics.maxScrollable);
            if (next === current) return prev;
            return { ...prev, [sid]: next };
          });
          return;
        }
        if (isCtrlInput(input, key, "c") && metrics.visibleText.trim().length > 0) {
          if (writeClipboardText(metrics.visibleText)) {
            addNotice("Copied terminal output", "success");
          } else {
            addNotice("Clipboard unavailable", "error");
          }
          return;
        }
      }
    }
    const mouse = parseTerminalMouseInput(input);
    if (mouse) {
      const activeSelection = chatMouseSelectionRef.current;
      const rightWidth = resolveRightPaneWidth(columns, rightOpen, drawerOpen);
      const drawerWidth = resolveDrawerPaneWidth(columns, drawerOpen);
      const rightStart = columns - rightWidth + 1;
      const mainPaneTopRow = 3 + goalBannerRows + addModeRows;
      const drawerBottomRow = mainPaneTopRow + Math.max(1, sessionsPaneHeight) - 1;
      const drawerLocalY = mouse.y == null ? null : mouse.y - mainPaneTopRow + 1;
      const inDrawerPane = mouse.x != null
        && mouse.y != null
        && drawerOpen
        && mouse.x <= drawerWidth
        && mouse.y >= mainPaneTopRow
        && mouse.y <= drawerBottomRow;
      if (mouse.kind === "move" && mouse.x != null && mouse.y != null) {
        const target = hitTestRegistryRef.current.hoverTest(mouse.x, mouse.y);
        if (target?.id !== hoveredTargetRef.current?.id) {
          hoveredTargetRef.current?.onHover?.(false);
          target?.onHover?.(true);
          hoveredTargetRef.current = target;
          setHoveredHitId(target?.id ?? null);
        }
        return;
      }
      if (mouse.kind === "click" && mouse.x != null && mouse.y != null) {
        const target = hitTestRegistryRef.current.hitTest(mouse.x, mouse.y);
        if (target?.onClick) {
          stopChatSelectionEdgeScroll();
          chatSelectionAnchorRef.current = null;
          if (activeSelection) updateChatMouseSelection(null);
          target.onClick(mouse);
          return;
        }
      }
      if (mouse.kind === "drag" && inDrawerPane) {
        // Drag a session card onto the center pane to add it to the grid. Only
        // local rows can be dragged: a foreign row has no live session here.
        const hit = workListMouseHitForLayout({ y: drawerLocalY, layout: workListLayoutValue });
        const dragRow = hit ? workListModel.rows[hit.index] : null;
        if (dragRow?.kind === "session" && !dragRow.machine && dragRow.laneId) {
          dragAddSessionRef.current = { sessionId: dragRow.sessionId, laneId: dragRow.laneId };
          return;
        }
      }
      if (mouse.kind === "release" && dragAddSessionRef.current) {
        const dragged = dragAddSessionRef.current;
        dragAddSessionRef.current = null;
        const centerStart = drawerWidth + 1;
        const centerEnd = columns - rightWidth;
        if (mouse.x != null && mouse.x >= centerStart && mouse.x <= centerEnd) {
          addTileToGrid(dragged.sessionId, dragged.laneId);
          return;
        }
      }
      if (mouse.kind === "click") {
        if (promptHitLine({
          y: mouse.y,
          rows,
          promptRowCount: promptRows.length,
          extraPromptRows: smartLinkRows,
          modelStatusRows: modelStatusOverlayRows,
          footerRows: 1,
        }) && (mouse.x == null || (mouse.x > drawerWidth && mouse.x < rightStart))) {
          stopChatSelectionEdgeScroll();
          chatSelectionAnchorRef.current = null;
          if (activeSelection) updateChatMouseSelection(null);
          focusChat();
          return;
        }
        if (inDrawerPane) {
          stopChatSelectionEdgeScroll();
          chatSelectionAnchorRef.current = null;
          if (activeSelection) updateChatMouseSelection(null);
          focusDrawerOnly();
          // Click uses the same row activation as Enter, except a singleton
          // card's first line is the lane identity (lane details) rather than
          // Chat Info.
          const hit = workListMouseHitForLayout({ y: drawerLocalY, layout: workListLayoutValue });
          const clicked = hit ? workListModel.rows[hit.index] ?? null : null;
          if (clicked) activateWorkRow(clicked, hit?.region ?? "body");
          return;
        }
        if (mouse.x != null && mouse.y != null && rightOpen && rightWidth > 0 && mouse.x >= rightStart) {
          stopChatSelectionEdgeScroll();
          chatSelectionAnchorRef.current = null;
          if (activeSelection) updateChatMouseSelection(null);
          setRightOpen(true);
          focusDetailsOnly();
          if (rightPane.kind === "chat-info") {
            // The resume row (when visible) sits ABOVE the roster, shifting it
            // down — compensate in the pane-top offset (same mechanism as the
            // goal-banner / add-mode header lines) and map roster indices back
            // into the shifted selection space.
            const resumeOffset = chatInfoSelectionOffset(rightPane.info);
            const subagentPaneTop = 2 + goalBannerRows + addModeRows + 1 + chatInfoPreambleLines(rightPane.info) - 4;
            const subagentContent = subagentPaneContentFromRightPane(rightPane);
            const target = subagentContent
              ? subagentIndexForPaneLine(subagentContent, mouse.y - subagentPaneTop, rightSelectionIndex - resumeOffset, chatInfoRosterViewState, SUBAGENT_PANE_ROSTER_CAPACITY)
              : null;
            if (target) activateSubagentPaneTarget(target, resumeOffset);
          }
          return;
        }
        // A plain click on a collapsible work-group header (▸ Tool calls (N) /
        // ▸ Files changed (N)) toggles it open/closed instead of starting a text
        // selection. Shift-click still extends a selection across the header.
        if (!mouse.shift) {
          const chatRowTarget = chatRowTargetFromMouse(mouse.x, mouse.y);
          if (chatRowTarget?.actionId && openFileChangeDiffAction(chatRowTarget.actionId)) {
            stopChatSelectionEdgeScroll();
            chatSelectionAnchorRef.current = null;
            if (activeSelection) updateChatMouseSelection(null);
            return;
          }
          if (chatRowTarget?.expandableId) {
            stopChatSelectionEdgeScroll();
            chatSelectionAnchorRef.current = null;
            if (activeSelection) updateChatMouseSelection(null);
            focusChat();
            toggleExpandedLineId(chatRowTarget.expandableId);
            return;
          }
        }
        stopChatSelectionEdgeScroll();
        const point = chatPointFromMouse(mouse.x, mouse.y, false);
        if (point) {
          focusChat();
          const shiftAnchor = chatSelectionAnchorRef.current
            ?? (activeSelection ? { row: activeSelection.startRow, column: activeSelection.startColumn } : null);
          if (mouse.shift && shiftAnchor) {
            updateChatMouseSelection(chatSelectionFromAnchor(shiftAnchor, point, true));
          } else {
            chatSelectionAnchorRef.current = point;
            updateChatMouseSelection({
              startRow: point.row,
              startColumn: point.column,
              endRow: point.row,
              endColumn: point.column,
              active: true,
            });
          }
          return;
        }
        chatSelectionAnchorRef.current = null;
        if (activeSelection) updateChatMouseSelection(null);
      }
      if (mouse.kind === "drag" && activeSelection?.active) {
        const point = chatPointFromMouse(mouse.x, mouse.y, true);
        const edge = chatSelectionEdgeFromMouseY(mouse.y);
        if (edge) startChatSelectionEdgeScroll(edge, point?.column ?? activeSelection.endColumn);
        else stopChatSelectionEdgeScroll();
        if (point) {
          updateChatMouseSelection({
            ...activeSelection,
            endRow: point.row,
            endColumn: point.column,
            active: true,
          });
        }
        return;
      }
      if (mouse.kind === "release" && activeSelection?.active) {
        stopChatSelectionEdgeScroll();
        const point = chatPointFromMouse(mouse.x, mouse.y, true);
        const next = point
          ? {
              ...activeSelection,
              endRow: point.row,
              endColumn: point.column,
              active: false,
            }
          : { ...activeSelection, active: false };
        const collapsed = next.startRow === next.endRow && next.startColumn === next.endColumn;
        chatSelectionAnchorRef.current = { row: next.startRow, column: next.startColumn };
        updateChatMouseSelection(collapsed ? null : next);
        return;
      }

	      const centerStart = drawerWidth + 1;
	      const centerEnd = columns - rightWidth;
	      const inCenterPane = mouse.x == null || (mouse.x >= centerStart && mouse.x <= centerEnd);
	      const inRightPane = mouse.x != null && rightOpen && rightWidth > 0 && mouse.x >= rightStart;
	      const inTranscriptRows = mouse.y == null || mouse.y > 2;
	      if (mouse.kind === "wheel" && inDrawerPane) {
	        // Scroll by ROWS of the flat list; the layout clamps the window, so
	        // the ceiling only has to stop the offset running past the last row.
	        const maxOffset = Math.max(0, workListModel.rows.length - 1);
	        const delta = mouse.direction === "down" ? 3 : mouse.direction === "up" ? -3 : 0;
	        if (delta !== 0) {
	          setDrawerScrollOffsetRows((offset) => Math.max(0, Math.min(maxOffset, offset + delta)));
	        }
	      } else if (mouse.kind === "wheel" && inRightPane) {
	        const maxOffset = Math.max(0, rightPaneScrollableRowCount(rightPane) - DETAILS_BODY_MAX_LINES);
	        const delta = mouse.direction === "down" ? 3 : mouse.direction === "up" ? -3 : 0;
	        if (delta !== 0) {
	          setRightPaneScrollOffsetRows((offset) => Math.max(0, Math.min(maxOffset, offset + delta)));
	        }
	      } else if (mouse.kind === "wheel" && inCenterPane && inTranscriptRows) {
	        const delta = mouse.direction === "up" ? 3 : mouse.direction === "down" ? -3 : 0;
        if (delta !== 0) {
          // In a grid, scroll the tile under the cursor rather than only the
          // focused one. ChatView clamps the upper bound per-tile, so a lower
          // bound is enough here.
          const grid = multiViewRef.current;
          const TILE_PREFIX = "multi-chat:tile:";
          let scrolledTile = false;
          if (grid && mouse.x != null && mouse.y != null) {
            const hit = hitTestRegistryRef.current.hitTest(mouse.x, mouse.y);
            const sessionId = hit?.id.startsWith(TILE_PREFIX) ? hit.id.slice(TILE_PREFIX.length) : null;
            if (sessionId && sessionId !== focusedSessionIdForMultiView(grid)) {
              setScrollBySessionId((prev) => ({
                ...prev,
                [sessionId]: Math.max(0, (prev[sessionId] ?? 0) + delta),
              }));
              scrolledTile = true;
            }
          }
          if (!scrolledTile) setChatScrollOffset((offset) => offset + delta);
        }
      } else if (
        mouse.kind === "click"
        && rightWidth > 0
        && rightPane.kind === "chat-info"
        && mouse.x != null
        && mouse.y != null
      ) {
        if (mouse.x >= rightStart) {
          // Resume row shifts the roster down — see the chat-info hover
          // handler above for the offset rationale.
          const resumeOffset = chatInfoSelectionOffset(rightPane.info);
          const subagentPaneTop = 2 + goalBannerRows + addModeRows + 1 + chatInfoPreambleLines(rightPane.info) - 4;
          const subagentContent = subagentPaneContentFromRightPane(rightPane);
          const target = subagentContent
            ? subagentIndexForPaneLine(subagentContent, mouse.y - subagentPaneTop, rightSelectionIndex - resumeOffset, chatInfoRosterViewState, SUBAGENT_PANE_ROSTER_CAPACITY)
            : null;
          if (target) activateSubagentPaneTarget(target, resumeOffset);
          setRightOpen(true);
          setPaneFocus("details");
        }
      }
      return;
    }

    const pane = activePaneRef.current;
    const detailsFormActive = pane === "details" && rightOpen && rightPane.kind === "form";
    const detailsFormField = detailsFormActive && rightPane.kind === "form"
      ? (rightPane.fields[formFieldIndex] ?? rightPane.fields[0] ?? null)
      : null;
    const detailsFormPromptActive = Boolean(
      detailsFormField && formFieldUsesPromptInput(rightPane.kind === "form" ? rightPane.command : "", detailsFormField.name),
    );
    // A plugin field that has taken the composer types like a form field.
    const pluginComposerFieldActive = pane === "details"
      && rightOpen
      && rightPane.kind === "plugin-panel"
      && rightPane.state.editing != null;
    const footerActive = footerControlRef.current != null;
    const textInputActive = (pane === "chat" && !footerActive)
      || detailsFormPromptActive
      || pluginComposerFieldActive;
    const pendingQuestionApproval = pendingApproval?.mode === "question" ? pendingApproval : null;
    const pendingQuestionKeyActive = shouldHandlePendingQuestionKey({
      pane,
      hasPendingQuestion: pendingQuestionApproval !== null,
      prompt,
      ctrl: key.ctrl === true,
      meta: key.meta === true,
    });

    // A plugin action's `{prompt}` owns the keyboard while its question is on
    // screen. Handled here — above every pane branch — because the question is
    // asked from whichever pane fired the action, and the pane's own Enter,
    // Esc and letter hotkeys would otherwise take the keystrokes meant for the
    // field. Enter re-invokes the action with the answer, Esc invokes nothing,
    // and Ctrl/Meta chords still fall through to the global chain so Ctrl+C is
    // never trapped behind a plugin's question.
    if (pluginPromptRef.current) {
      const pasted = consumeBracketedPasteInput(bracketedPasteStateRef.current, input);
      bracketedPasteStateRef.current = pasted.state;
      if (pasted.consumed) {
        // One field, one line: a pasted break becomes a space rather than a
        // newline the field has nowhere to draw.
        const text = printableMultilineInput(pasted.text).replace(/\r?\n/g, " ");
        if (text) {
          const next = insertPromptText(prompt, promptCursorRef.current, text);
          handlePromptChange(next.value, next.cursor);
        }
        return;
      }
      if (key.escape) {
        cancelPluginPrompt();
        return;
      }
      if (key.return) {
        void submitPluginPrompt();
        return;
      }
      if (key.leftArrow) {
        movePromptCursor(-1);
        return;
      }
      if (key.rightArrow) {
        movePromptCursor(1);
        return;
      }
      // A one-line field has no line above or below to reach, and letting ↑/↓
      // through would move a selection in a pane the reader cannot see acting.
      if (key.upArrow || key.downArrow) return;
      if (key.backspace || key.delete) {
        const next = deletePromptForKey(prompt, promptCursorRef.current, key);
        handlePromptChange(next.value, next.cursor);
        return;
      }
      if (!key.ctrl && !key.meta && input) {
        const cursor = promptCursorRef.current;
        const next = applyCoalescedPromptInput(prompt, cursor, input);
        if (next.value !== prompt || next.cursor !== cursor) handlePromptChange(next.value, next.cursor);
        return;
      }
    }

    if (textInputActive) {
      const pasted = consumeBracketedPasteInput(bracketedPasteStateRef.current, input);
      bracketedPasteStateRef.current = pasted.state;
      if (pasted.consumed) {
        const text = printableMultilineInput(pasted.text);
        if (text) {
          const next = insertPromptText(prompt, promptCursorRef.current, text);
          handlePromptChange(next.value, next.cursor);
        }
        return;
      }
    }

    // Searchable /help command reference: filter type-ahead + ↑↓ navigation + ↵
    // run. Handled before the command palette so the help pane owns keystrokes
    // while it is the active right pane. esc / Ctrl+K close it.
    if (rightPane.kind === "help" && !isCtrlInput(input, key, "c")) {
      const helpGroups = buildHelpRows(helpIndexGroups, helpFilterQuery, helpRecentsRef.current);
      const helpFlatRows = flattenHelpRows(helpGroups);
      const helpTotal = helpFlatRows.length;
      if (key.escape || isCtrlInput(input, key, "k")) {
        setHelpFilterQuery("");
        setHelpSelectedIndex(0);
        setRightPane({ kind: "empty" });
        focusChat();
        return;
      }
      if (key.upArrow || (key.tab && key.shift)) {
        const next = helpTotal === 0 ? 0 : (helpSelectedIndex - 1 + helpTotal) % helpTotal;
        setHelpSelectedIndex(next);
        renderHelpPane(helpFilterQuery, next, helpRecentsRef.current);
        return;
      }
      if (key.downArrow || key.tab) {
        const next = helpTotal === 0 ? 0 : (helpSelectedIndex + 1) % helpTotal;
        setHelpSelectedIndex(next);
        renderHelpPane(helpFilterQuery, next, helpRecentsRef.current);
        return;
      }
      if (key.return) {
        const picked = helpFlatRows[helpSelectedIndex];
        if (picked) {
          const nextRecents = pushRecent(helpRecentsRef.current, picked.name);
          setHelpRecents(nextRecents);
          setHelpFilterQuery("");
          setHelpSelectedIndex(0);
          const parsed = parseCommand(picked.name, slashCommands);
          const placement = parsed?.spec?.placement;
          // A help row's name may carry its argument: the Plugins group lists
          // one row per contributed chord, each named `/plugin-view <pluginId>`.
          // Running the bare command instead dropped the id, and `/plugin-view`
          // with no argument lists the installed plugins to pick from — so the
          // row that named a plugin answered with a menu.
          const pickedArgs = parsed?.args ?? "";
          if (placement === "right") {
            void runRightCommand(parsed!.name, pickedArgs)
              .catch((err) => addNotice(err instanceof Error ? err.message : String(err), "error"));
          } else if (placement === "inline") {
            setRightPane({ kind: "empty" });
            void runInlineCommand(parsed!.name, pickedArgs)
              .catch((err) => addNotice(err instanceof Error ? err.message : String(err), "error"));
          } else {
            // chat / unknown placement: seed the prompt so the user can complete it.
            const draft = `${(parsed?.name ?? picked.name)} `;
            setRightPane({ kind: "empty" });
            setPrompt(draft);
            promptRef.current = draft;
            chatDraftRef.current = draft;
            focusChat();
          }
        }
        return;
      }
      if (isPromptLineBackspace(input, key) || key.backspace || key.delete) {
        const nextQuery = isPromptLineBackspace(input, key) ? "" : helpFilterQuery.slice(0, -1);
        setHelpFilterQuery(nextQuery);
        setHelpSelectedIndex(0);
        renderHelpPane(nextQuery, 0, helpRecentsRef.current);
        return;
      }
      if (!key.ctrl && !key.meta) {
        const suffix = printableInput(input);
        if (suffix) {
          const nextQuery = helpFilterQuery + suffix;
          setHelpFilterQuery(nextQuery);
          setHelpSelectedIndex(0);
          renderHelpPane(nextQuery, 0, helpRecentsRef.current);
        }
        return;
      }
      return;
    }

    if (commandPaletteOpen && !isCtrlInput(input, key, "c")) {
      // Ctrl/Cmd+K toggles the palette shut (mirrors Esc) so the same chord
      // opens and closes it — no need to reach for Escape.
      if (key.escape || isCtrlInput(input, key, "k")) {
        setCommandPaletteOpen(false);
        setCommandPaletteQuery("");
        setCommandPaletteIndex(0);
        return;
      }
      if (key.upArrow || (key.tab && key.shift)) {
        setCommandPaletteIndex((index) => (commandPaletteItems.length ? (index - 1 + commandPaletteItems.length) % commandPaletteItems.length : 0));
        return;
      }
      if (key.downArrow || key.tab) {
        setCommandPaletteIndex((index) => (commandPaletteItems.length ? (index + 1) % commandPaletteItems.length : 0));
        return;
      }
      if (key.return) {
        void runCommandPaletteItem(commandPaletteItems[commandPaletteIndex] ?? commandPaletteItems[0])
          .catch((err) => addNotice(err instanceof Error ? err.message : String(err), "error"));
        return;
      }
      if (isPromptLineBackspace(input, key)) {
        setCommandPaletteQuery("");
        setCommandPaletteIndex(0);
        return;
      }
      if (key.backspace || key.delete) {
        setCommandPaletteQuery((query) => query.slice(0, -1));
        setCommandPaletteIndex(0);
        return;
      }
      if (!key.ctrl && !key.meta) {
        const suffix = printableInput(input);
        if (suffix) {
          setCommandPaletteQuery((query) => `${query}${suffix}`);
          setCommandPaletteIndex(0);
        }
        return;
      }
      return;
    }

    if (isCtrlInput(input, key, "k")) {
      // Ctrl+K opens the command palette (it toggles shut via the
      // command-palette branch above when the palette is already open). The
      // searchable /help reference stays reachable via the `/help` slash command
      // and the "help" entry inside the command palette.
      openCommandPalette();
      return;
    }

    if (pane === "addMode" || addModeRef.current) {
      if (key.escape) {
        cancelAddMode();
        return;
      }
      if (key.return) {
        confirmAddMode();
        return;
      }
      if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) {
        if (key.upArrow) moveAddModeCursor("up");
        else if (key.downArrow) moveAddModeCursor("down");
        else if (key.leftArrow) moveAddModeCursor("left");
        else moveAddModeCursor("right");
        return;
      }
      if (isCtrlInput(input, key, "g")) {
        cancelAddMode();
        return;
      }
      return;
    }

    if (pane === "chat" && gridViewActiveRef.current && multiViewRef.current && isCtrlInput(input, key, "w")) {
      removeMultiViewTile(multiViewRef.current.focusedIndex);
      return;
    }

    if (pane === "chat" && gridViewActiveRef.current && multiViewRef.current && key.tab) {
      // With side panes visible, Tab treats the grid as the center pane so
      // keyboard users can reach lanes/details even when terminal mouse clicks
      // are unreliable. When the grid is the only pane, Tab stays local to tiles.
      if (gridTabNavigationTarget({
        drawerOpen,
        rightOpen,
        tileCount: multiViewRef.current.tiles.length,
      }) === "panes") {
        cyclePaneFocus(key.shift ? -1 : 1);
        return;
      }
      const direction = key.shift ? -1 : 1;
      setMultiView((prev) => {
        if (!prev) return prev;
        const count = Math.max(1, prev.tiles.length);
        return { ...prev, focusedIndex: (prev.focusedIndex + direction + count) % count };
      });
      return;
    }

    // Inline model row is click-only (or /model). Arrow keys never enter it
    // from the composer — up/down there cycle prompt history instead.
    if (inlineRowFocused) {
      const cell = inlineRowFocus.cell;
      if (key.upArrow) {
        setInlineRowFocus({ cell: null });
        return;
      }
      if (key.downArrow) {
        if (cell === "provider") cycleProvider(1);
        else if (cell === "model") cycleModel(1);
        else if (cell === "fast") applyModelState((prev) => ({ ...prev, fastMode: !prev.fastMode }));
        else if (cell === "reasoning") cycleReasoning(1);
        else if (cell === "permission") cyclePermission(1);
        else if (cell === "subagents") openSubagentsPane();
        return;
      }
      if (key.leftArrow || key.rightArrow) {
        const order = inlineRowCellOrder({
          providerLocked: providerLockedRef.current,
          fastSupported: footerFastSupportedRef.current,
          reasoningSupported: footerReasoningSupportedRef.current,
          subagentsVisible: subagentsButtonVisibleRef.current,
        });
        const idx = cell ? order.indexOf(cell) : 0;
        const delta = key.rightArrow ? 1 : -1;
        const safeIdx = idx < 0 ? 0 : idx;
        const nextCell = order[(safeIdx + delta + order.length) % order.length] ?? order[0] ?? "model";
        setInlineRowFocus({ cell: nextCell });
        return;
      }
      if (key.return) {
        if (cell === "subagents") {
          openSubagentsPane();
          return;
        }
        if (cell === "model" && activeTerminalSessionRef.current && modelStateRef.current.provider === "claude") {
          void sendClaudeModelCommandToTerminal()
            .catch((err) => addNotice(err instanceof Error ? err.message : String(err), "error"));
        }
        return;
      }
      if (key.escape) {
        setInlineRowFocus({ cell: null });
        return;
      }
      return;
    }

    if ((textInputActive || footerActive) && prompt.length > 0 && isPromptLineBackspace(input, key)) {
      if (footerActive) selectFooterControl(null);
      const next = deletePromptBackward(prompt, promptCursorRef.current, "line");
      handlePromptChange(next.value, next.cursor);
      return;
    }
    if ((textInputActive || footerActive) && prompt.length > 0 && isPromptWordBackspace(input, key)) {
      if (footerActive) selectFooterControl(null);
      const next = deletePromptBackward(prompt, promptCursorRef.current, "word");
      handlePromptChange(next.value, next.cursor);
      return;
    }
    if (textInputActive && key.return && key.shift) {
      const next = insertPromptText(prompt, promptCursorRef.current, "\n");
      handlePromptChange(next.value, next.cursor);
      return;
    }

    if (pane === "chat" && attachmentFocusIndex != null) {
      if (key.leftArrow) {
        setAttachmentFocusIndex((current) => {
          if (current == null || !attachedImageChips.length) return null;
          return (current - 1 + attachedImageChips.length) % attachedImageChips.length;
        });
        return;
      }
      if (key.rightArrow) {
        setAttachmentFocusIndex((current) => {
          if (current == null || !attachedImageChips.length) return null;
          return (current + 1) % attachedImageChips.length;
        });
        return;
      }
      if (key.backspace || key.delete) {
        removeAttachmentAtIndex(attachmentFocusIndex);
        return;
      }
      if (key.upArrow || key.downArrow || key.escape || key.return) {
        setAttachmentFocusIndex(null);
        return;
      }
    }

    if (pane === "chat" && textInputActive && !key.ctrl && !key.meta && !pendingQuestionKeyActive) {
      if (key.leftArrow) {
        movePromptCursor(-1);
        return;
      }
      if (key.rightArrow) {
        movePromptCursor(1);
        return;
      }
      // When the slash-command suggester or @-mention list is open, ↑/↓ belong
      // exclusively to that palette (handled just below) — don't let cursor /
      // history movement swallow them. Keyed off the live rows (not a leading
      // "/") so mid-sentence triggers get palette navigation too.
      const slashOrMentionOpen = slashRows.length > 0 || activeMentionRange != null;
      if (key.upArrow && !slashOrMentionOpen) {
        movePromptCursorVerticalAndMaybeAttach(-1);
        return;
      }
      if (key.downArrow && !slashOrMentionOpen) {
        movePromptCursorVerticalAndMaybeAttach(1);
        return;
      }
    }

    if (pane === "chat" && textInputActive && (key.ctrl || key.meta)) {
      // Option/Alt+Left/Right move by word. macOS sends these either as
      // meta+arrow, or — with Option-as-Meta — as the emacs escape sequences
      // ESC-b / ESC-f, which Ink surfaces as meta + input "b"/"f". Without this
      // second case they fell through to the text-insert path and literally
      // typed "b"/"f" instead of moving the cursor.
      const optWordLeft = key.meta && !key.ctrl && input.toLowerCase() === "b";
      const optWordRight = key.meta && !key.ctrl && input.toLowerCase() === "f";
      if (key.leftArrow || optWordLeft) {
        movePromptCursor(-1, "word");
        return;
      }
      if (key.rightArrow || optWordRight) {
        movePromptCursor(1, "word");
        return;
      }
    }

    if (pane === "chat") {
      const pageUp = Boolean((key as { pageUp?: boolean }).pageUp);
      const pageDown = Boolean((key as { pageDown?: boolean }).pageDown);
      const home = Boolean((key as { home?: boolean }).home);
      const end = Boolean((key as { end?: boolean }).end);
      const paletteOpen = activeMentionRange != null || slashRows.length > 0;
      const pageRows = Math.max(1, chatRowBudget - 2);
      const halfPageUp = isCtrlInput(input, key, "u");
      const halfPageDown = isCtrlInput(input, key, "d");
      if (pageUp || halfPageUp) {
        setChatScrollOffset((offset) => offset + (halfPageUp ? Math.max(1, Math.floor(pageRows / 2)) : pageRows));
        return;
      }
      if (pageDown || halfPageDown) {
        setChatScrollOffset((offset) => offset - (halfPageDown ? Math.max(1, Math.floor(pageRows / 2)) : pageRows));
        return;
      }
      if (home) {
        setChatScrollOffset(Number.MAX_SAFE_INTEGER);
        return;
      }
      if (end) {
        if (
          activeSessionId
          && detachedHistorySessionIdsRef.current.has(activeSessionId)
        ) {
          void returnActiveHistoryToLatest();
          return;
        }
        setChatScrollOffset(0);
        return;
      }
      if (
        !paletteOpen
        && isCtrlInput(input, key, "r")
        && promptRef.current.length === 0
        && activeSessionId
        && olderHistoryStatusBySessionId[activeSessionId] === "error"
      ) {
        setOlderHistoryStatusBySessionId((prev) => ({ ...prev, [activeSessionId]: "available" }));
        void loadOlderHistoryForActiveSession();
        return;
      }
      if (activeMentionRange && mentionSuggestions.length) {
        if (key.upArrow) {
          setMentionIndex((index) => (index <= 0 ? mentionSuggestions.length - 1 : index - 1));
          return;
        }
        if (key.downArrow) {
          setMentionIndex((index) => (index + 1) % mentionSuggestions.length);
          return;
        }
        if (key.tab) {
          insertMention(mentionSuggestions[mentionIndex] ?? mentionSuggestions[0]!);
          return;
        }
      }
      if (slashRows.length) {
        if (key.upArrow) {
          setSlashIndex((index) => (index <= 0 ? slashRows.length - 1 : index - 1));
          return;
        }
        if (key.downArrow) {
          setSlashIndex((index) => (index + 1) % slashRows.length);
          return;
        }
        if (key.tab || (key.return && slashTriggerMidSentence)) {
          insertSlashCommand();
          return;
        }
      }
      if (!paletteOpen && (key.upArrow || key.downArrow) && !pendingQuestionKeyActive) {
        setChatScrollOffset((offset) => offset + (key.upArrow ? 1 : -1));
        return;
      }
    }
    // ── /model wizard ────────────────────────────────────────────────────────
    // ONE branch owns every wizard key. It deliberately handles only the keys
    // the wizard defines (esc / ↑↓ / ←→ / ↵) and falls through for everything
    // else, so Ctrl+C, pane cycling, and the configurable keybinding layer keep
    // working exactly as they do over any other right-pane kind.
    if (pane === "details" && rightOpen && rightPane.kind === "model-wizard" && modelWizardInput && modelWizardView) {
      const wizard = rightPane;
      const applyWizardSelection = (selection: ModelWizardSelection) => {
        setRightPane({
          ...wizard,
          step: selection.step,
          provider: selection.provider,
          familyKey: selection.familyKey,
          index: selection.index,
        });
      };
      const cycleWizardSettingRow = (settingKind: SetupPaneRowKind, direction: 1 | -1) => {
        const row = modelWizardInput.settingsRows.find((entry) => entry.kind === settingKind);
        if (row) handleSetupRow(row, direction);
      };
      if (key.escape) {
        const back = backModelWizard(modelWizardInput);
        if (back.kind === "close") closeModelWizard();
        else applyWizardSelection(back.selection);
        return;
      }
      if (key.upArrow || key.downArrow) {
        const index = moveModelWizardIndex(modelWizardView, key.upArrow ? -1 : 1);
        if (index !== wizard.index) setRightPane({ ...wizard, index });
        return;
      }
      if (key.leftArrow || key.rightArrow) {
        const cycle = cycleModelWizardSetting(modelWizardInput, key.leftArrow ? -1 : 1);
        if (cycle) cycleWizardSettingRow(cycle.settingKind, cycle.direction);
        return;
      }
      // Favorites stay first-class without rebuilding the old rail: `f` toggles
      // the focused model through the same modelPicker.* RPC store the desktop
      // picker uses, and step 1's recent shortcuts mark favorites.
      if (input === "f" && !key.ctrl && !key.meta && modelWizardView.step === "model") {
        const focused = modelWizardView.options[modelWizardView.index];
        if (focused?.modelId) toggleModelPickerFavoriteId(focused.modelId);
        return;
      }
      if (key.return) {
        const advance = advanceModelWizard(modelWizardInput);
        switch (advance.kind) {
          case "step":
            applyWizardSelection(advance.selection);
            return;
          case "select-provider": {
            if (modelPickerProviderSwitchBlocked({
              providerLocked: providerLockedRef.current,
              surface: wizard.surface,
              currentProvider: modelStateRef.current.provider,
              nextProvider: advance.provider,
            })) {
              addNotice("Provider is locked for this chat. /new chat to switch.", "info");
              return;
            }
            selectProvider(advance.provider);
            applyWizardSelection(advance.selection);
            return;
          }
          case "select-model":
            commitModelPickerSelection(advance.modelId);
            applyWizardSelection(advance.selection);
            return;
          case "sign-in":
            void runInlineCommand("/login", advance.provider);
            return;
          case "cycle-setting":
            cycleWizardSettingRow(advance.settingKind, advance.direction);
            return;
          case "commit":
            rememberModelChoice(modelStateRef.current);
            closeModelWizard();
            return;
          default:
            return;
        }
      }
    }
    if (pane === "details" && rightOpen && rightPane.kind === "external-session-browser") {
      const browser = rightPane;
      const visible = visibleExternalSessions(browser.sessions, browser.providerFilter, browser.query);
      const selectedIndex = visible.length
        ? Math.min(Math.max(0, browser.selectedIndex), visible.length - 1)
        : 0;
      const selectedSession = visible[selectedIndex] ?? null;
      const actions = selectedSession ? externalSessionBrowserActions(selectedSession) : [];
      const actionIndex = actions.length
        ? Math.min(Math.max(0, browser.actionIndex), actions.length - 1)
        : 0;

      if (key.escape) {
        setRightPane({ kind: "empty" });
        setRightOpen(false);
        lastUserOpenedPaneRef.current = null;
        userDismissedRightPaneRef.current = true;
        focusAfterDetails();
        return;
      }
      if (key.upArrow) {
        setRightPane((prev) => prev.kind === "external-session-browser"
          ? clampExternalSessionBrowserContent({
              ...prev,
              selectedIndex: Math.max(0, selectedIndex - 1),
              actionIndex: 0,
              importError: null,
            })
          : prev);
        return;
      }
      if (key.downArrow) {
        setRightPane((prev) => prev.kind === "external-session-browser"
          ? clampExternalSessionBrowserContent({
              ...prev,
              selectedIndex: visible.length ? Math.min(visible.length - 1, selectedIndex + 1) : 0,
              actionIndex: 0,
              importError: null,
            })
          : prev);
        return;
      }
      if (key.leftArrow || key.rightArrow) {
        const delta = key.leftArrow ? -1 : 1;
        setRightPane((prev) => prev.kind === "external-session-browser"
          ? clampExternalSessionBrowserContent({
              ...prev,
              actionIndex: actions.length ? (actionIndex + delta + actions.length) % actions.length : 0,
              importError: null,
            })
          : prev);
        return;
      }
      if (key.return) {
        if (!selectedSession) return;
        const action = actions[actionIndex] ?? actions.find((entry) => entry.enabled) ?? actions[0];
        if (!action) {
          setRightPane((prev) => prev.kind === "external-session-browser"
            ? { ...prev, importError: "No import action available for that session." }
            : prev);
          return;
        }
        if (!isImportAffordance(action)) {
          void openExistingExternalSession(selectedSession, browser.laneId);
        } else {
          void importExternalSessionFromBrowser(selectedSession, action);
        }
        return;
      }
      if (input === "O" && !key.ctrl && !key.meta && !browser.query) {
        if (selectedSession?.alreadyImported && selectedSession.importedSessionRef) {
          void openExistingExternalSession(selectedSession, browser.laneId);
        } else {
          setRightPane((prev) => prev.kind === "external-session-browser"
            ? { ...prev, importError: "That provider session has not been imported into ADE yet." }
            : prev);
        }
        return;
      }
      if (input === "R" && !key.ctrl && !key.meta && !browser.query) {
        void loadExternalSessionsForLane(browser.laneId);
        return;
      }
      if (input === "P" && !key.ctrl && !key.meta && !browser.query) {
        setRightPane((prev) => prev.kind === "external-session-browser"
          ? clampExternalSessionBrowserContent({
              ...prev,
              providerFilter: nextExternalSessionProviderFilter(prev.providerFilter),
              selectedIndex: 0,
              actionIndex: 0,
              importError: null,
            })
          : prev);
        return;
      }
      if (isPromptLineBackspace(input, key)) {
        setRightPane((prev) => prev.kind === "external-session-browser"
          ? clampExternalSessionBrowserContent({
              ...prev,
              query: "",
              selectedIndex: 0,
              actionIndex: 0,
              importError: null,
            })
          : prev);
        return;
      }
      if (key.backspace || key.delete) {
        setRightPane((prev) => prev.kind === "external-session-browser"
          ? clampExternalSessionBrowserContent({
              ...prev,
              query: prev.query.slice(0, -1),
              selectedIndex: 0,
              actionIndex: 0,
              importError: null,
            })
          : prev);
        return;
      }
      if (!key.ctrl && !key.meta && !key.return) {
        const suffix = printableInput(input);
        if (suffix) {
          setRightPane((prev) => prev.kind === "external-session-browser"
            ? clampExternalSessionBrowserContent({
                ...prev,
                query: `${prev.query}${suffix}`,
                selectedIndex: 0,
                actionIndex: 0,
                importError: null,
              })
            : prev);
        }
        return;
      }
      return;
    }
    const keybindingContext = pane === "details"
      ? rightPane.kind === "help" ? "Help" : "Select"
      : pane === "drawer" ? "Tabs" : "Chat";
    // The merged set, not the raw file: plugin-declared defaults sit underneath
    // the user's own bindings and lose every chord the user has claimed.
    const keybindingAction = dispatchKeybinding(mergedKeybindings.bindings, keybindingContext, input, key, keybindingDispatchStateRef.current);
    if (keybindingAction === null) {
      return;
    }
    if (keybindingAction !== undefined && runKeybindingAction(keybindingAction)) {
      return;
    }
    if (pane === "chat" && textInputActive && key.return && key.meta && !key.ctrl && !key.shift) {
      void launchPromptInBackground(prompt);
      return;
    }
    const currentFormValues = (): Record<string, string> => {
      if (rightPane.kind !== "form") return formValues;
      const currentField = rightPane.fields[formFieldIndex] ?? rightPane.fields[0];
      if (!currentField || !formFieldUsesPromptInput(rightPane.command, currentField.name)) return formValues;
      return { ...formValues, [currentField.name]: prompt };
    };
    const formHasChanges = (values: Record<string, string>): boolean => {
      if (rightPane.kind !== "form") return false;
      return rightPane.fields.some((field) => (values[field.name] ?? "") !== (field.initialValue ?? ""));
    };
    const discardChatDraft = (): void => {
      setFormDiscardArmed(false);
      newChatPreviewLaneIdRef.current = null;
      draftChatActiveRef.current = false;
      setDraftChatMode(false);
      setSelectedWorkChatAction(null);
      clearChatPromptDraft();
      setRightPane((prev) => prev.kind === "model-picker" && prev.surface === "new-chat" ? { kind: "empty" } : prev);
      setRightOpen(false);
      lastUserOpenedPaneRef.current = null;
      userDismissedRightPaneRef.current = true;
    };
    const confirmOrDiscardChatDraft = (): boolean => {
      if (!draftChatActiveRef.current || activeSessionIdRef.current) return false;
      if (!formDiscardArmedRef.current) {
        setFormDiscardArmed(true);
        addNotice("Press Esc again to discard this chat draft.", "info");
        return true;
      }
      discardChatDraft();
      return true;
    };

    // New-lane form branch typeahead: ↹ completes the top match into the
    // active branch/base-branch field. Must run before the global
    // tab-cycles-pane-focus handler below; tab is swallowed on typeahead
    // fields either way so focus doesn't jump mid-typing.
    if (
      key.tab && !key.shift
      && pane === "details" && rightOpen
      && rightPane.kind === "form" && rightPane.command === "new-lane"
    ) {
      const fields = rightPane.fields;
      const field = fields[formFieldIndex] ?? fields[0] ?? null;
      const typeaheadName = newLaneTypeaheadField(fields);
      if (field && typeaheadName && field.name === typeaheadName) {
        const values = currentFormValues();
        const top = filterNewLaneBranchMatches({
          branches: rightPane.branches,
          query: values[field.name] ?? "",
          remote: field.name === "baseBranch" ? true : normalizeNewLaneBranchSource(values.branchSource) === "remote",
          limit: 1,
        })[0];
        if (top) {
          setFormValues({ ...values, [field.name]: top });
          setPrompt(top);
        }
        return;
      }
    }

    if (key.tab && key.shift) {
      cyclePermission(1);
      return;
    }

    if (key.tab && !key.shift) {
      cyclePaneFocus();
      return;
    }

    if (isCtrlInput(input, key, "o")) {
      toggleDrawerPane();
      return;
    }

    if (isCtrlInput(input, key, "l") && pane === "chat") {
      setClearedAt(new Date().toISOString());
      clearOlderHistoryCursor(activeSessionIdRef.current);
      eventDedupKeysRef.current.clear();
      eventDedupKeyOrderRef.current = [];
      eventCountRef.current = 0;
      setEvents([]);
      setChatScrollOffset(0);
      addNotice("Viewport cleared. Durable chat history is unchanged.", "info");
      return;
    }

    if (isCtrlInput(input, key, "p")) {
      toggleDetailsPane();
      return;
    }

    if (isCtrlInput(input, key, "a")) {
      toggleSubagentsPane();
      return;
    }

    // Ctrl+Y: copy the canonical ade:// deeplink for the focused lane or PR.
    // Scoped to the lanes drawer ("Tabs") and the lane-details/select pane
    // ("Select") so it doesn't shadow other contexts. Users can additionally
    // bind this to any chord via "app:copyAdeDeeplink" in keybindings.json.
    if (
      key.ctrl
      && input === "y"
      && (keybindingContext === "Tabs" || keybindingContext === "Select")
    ) {
      if (runKeybindingAction("app:copyAdeDeeplink")) return;
    }

    if (
      !textInputActive
      && !footerActive
      && !key.ctrl
      && !key.meta
      && (input === "[" || input === "]")
      // The model picker consumes [ ] for provider tabs (and as search text), so
      // don't hijack them for lane cycling while it's focused.
      && rightPane.kind !== "model-picker"
    ) {
      cycleActiveLane(input === "]" ? 1 : -1);
      return;
    }

    if (footerActive) {
      if (key.leftArrow || key.rightArrow) {
        cycleFooterControl(key.rightArrow ? 1 : -1);
        return;
      }
      if (key.upArrow) {
        selectFooterControl(null);
        focusChat();
        return;
      }
      if (key.escape) {
        selectFooterControl(null);
        return;
      }
      if (key.return) {
        if (footerControlRef.current === "drawer") {
          toggleDrawerPane();
        } else if (footerControlRef.current === "agents") {
          toggleSubagentsPane();
        } else {
          toggleDetailsPane();
        }
        return;
      }
      if (key.backspace || key.delete) {
        selectFooterControl(null);
        const next = deletePromptForKey(prompt, promptCursorRef.current, key);
        handlePromptChange(next.value, next.cursor);
        return;
      }
      if (!key.ctrl && input) {
        const suffix = printableInput(input);
        if (suffix) {
          selectFooterControl(null);
          const next = insertPromptText(prompt, promptCursorRef.current, suffix);
          handlePromptChange(next.value, next.cursor);
        }
        return;
      }
    }

    if (pane === "chat" && textInputActive && isCtrlInput(input, key, "r")) {
      recallPromptHistory("previous");
      return;
    }

    if (pane === "chat" && textInputActive && isCtrlInput(input, key, "v")) {
      attachClipboardImage();
      return;
    }

    if (pane === "chat" && isCtrlInput(input, key, "g")) {
      toggleGridView();
      return;
    }

    if (pendingQuestionKeyActive) {
      if (!pendingQuestionApproval) return;
	      const updateQuestionState = (
	        updater: (state: PendingQuestionSelectionState) => PendingQuestionSelectionState,
	      ): boolean => {
        const current = ensurePendingQuestionSelectionState(pendingQuestionApproval, pendingQuestionStateRef.current);
        if (!current) return false;
        const next = updater(current);
        pendingQuestionStateRef.current = next;
	        setPendingQuestionState(next);
	        return true;
	      };
	      if (key.escape || key.backspace || key.delete) {
	        let cancelled = false;
	        updateQuestionState((state) => {
	          const result = cancelPendingQuestionDigitSelection(state);
	          cancelled = result.cancelled;
	          return result.state;
	        });
	        if (cancelled) return;
	      }
	      if (key.upArrow || key.downArrow) {
        updateQuestionState((state) => {
          const question = pendingQuestionApproval.request?.questions[state.activeQuestionIndex];
          const options = optionsForPendingQuestion(pendingQuestionApproval.request, question, state.activeQuestionIndex);
          return options.length
            ? movePendingQuestionOption(pendingQuestionApproval.request, state, key.upArrow ? -1 : 1)
            : movePendingQuestionFocus(pendingQuestionApproval.request, state, key.upArrow ? -1 : 1);
        });
        return;
      }
      if (key.leftArrow || key.rightArrow) {
        updateQuestionState((state) => movePendingQuestionFocus(pendingQuestionApproval.request, state, key.leftArrow ? -1 : 1));
        return;
      }
      const printableSuffix = !key.ctrl && !key.meta && !key.return ? printableInput(input) : "";
      if (/^[1-9]$/.test(input)) {
        let selected = false;
        updateQuestionState((state) => {
          const result = selectPendingQuestionDigit(pendingQuestionApproval.request, state, input);
          selected = result.selected;
          return result.state;
        });
        if (selected) return;
      }
      if (printableSuffix) {
        let convertedText: string | null = null;
        updateQuestionState((state) => {
          const result = convertPendingQuestionDigitSelectionToText(
            pendingQuestionApproval.request,
            state,
            printableSuffix,
          );
          if (!result) return state;
          convertedText = result.text;
          return result.state;
        });
        if (convertedText != null) {
          const next = insertPromptText(promptRef.current, promptCursorRef.current, convertedText);
          handlePromptChange(next.value, next.cursor);
          return;
        }
      }
      if (key.return) {
        void submitSelectedPendingQuestion(pendingQuestionApproval)
          .catch((err) => addNotice(err instanceof Error ? err.message : String(err), "error"));
        return;
      }
    }

    if (
      pane === "chat"
      && textInputActive
      && !key.ctrl
      && !key.meta
      && prompt.length === 0
      && !activeMentionRange
      && !slashRows.length
      && (key.upArrow || key.downArrow)
    ) {
      recallPromptHistory(key.upArrow ? "previous" : "next");
      return;
    }

    // Single arbitration point for the three composer-adjacent Esc consumers —
    // see resolveChatEscapeAction for the precedence and why. Keeping it ahead
    // of both the vim block and the generic Esc chain is what makes the
    // palette's advertised "Esc close" actually reachable with vim mode on.
    if (key.escape) {
      const chatEscapeAction = resolveChatEscapeAction({
        pane,
        textInputActive,
        modified: Boolean(key.ctrl || key.meta),
        composerTriggerOpen: Boolean(activeComposerTrigger),
        chatSelectionActive: Boolean(chatMouseSelectionRef.current),
        vimModeEnabled,
      });
      if (chatEscapeAction === "dismiss-composer-trigger" && activeComposerTrigger) {
        // Recording the dismissal is what makes the palette stay closed as the
        // user finishes typing the token instead of reopening on the very next
        // keystroke.
        setDismissedComposerTrigger({
          type: activeComposerTrigger.type,
          start: activeComposerTrigger.start,
          query: activeComposerTrigger.query,
        });
        return;
      }
      if (chatEscapeAction === "clear-chat-selection") {
        stopChatSelectionEdgeScroll();
        chatSelectionAnchorRef.current = null;
        updateChatMouseSelection(null);
        return;
      }
      if (chatEscapeAction === "vim-normal") {
        setVimMode("normal");
        return;
      }
    }

    if (pane === "chat" && textInputActive && vimModeEnabled && !key.ctrl && !key.meta) {
      if (vimMode === "normal") {
        if (input === "i" || input === "a") {
          setVimMode("insert");
          return;
        }
        if (input === ":" || input === "/") {
          handlePromptChange("/");
          setVimMode("insert");
          return;
        }
        if (input === "k" || key.upArrow) {
          recallPromptHistory("previous");
          return;
        }
        if (input === "j" || key.downArrow) {
          recallPromptHistory("next");
          return;
        }
        if (key.return) {
          void submitPrompt(prompt);
          return;
        }
        return;
      }
    }

    if (key.escape) {
      // First Esc unwinds a subagent transcript back to the main chat; the
      // right pane stays focused on the main agent's info, so a second Esc
      // would close the pane normally.
      if (realMainTranscript) {
        setRealMainTranscript(null);
        setChatScrollOffset(0);
        return;
      }
      if (
        pane === "details"
        && rightOpen
        && rightPane.kind === "chat-info"
        && inspectedSubagentId
      ) {
        setInspectedSubagentId(null);
        setChatScrollOffset(0);
        return;
      }
      // A plugin panel unwinds its own state before it closes: first the field
      // that borrowed the composer, then the panel back to the plugin picker,
      // and only then does the generic close below take the pane down.
      if (pane === "details" && rightOpen && rightPane.kind === "plugin-panel") {
        if (rightPane.state.editing !== null && rightPane.state.editing !== undefined) {
          updatePluginPaneState((state) => ({ ...state, editing: null }));
          setPromptValue("");
          return;
        }
        pluginConfirmArmedRef.current = null;
        void openPluginPane("").catch((err) =>
          addNotice(err instanceof Error ? err.message : String(err), "error"),
        );
        return;
      }
      if (pane === "details" && rightOpen) {
        if (rightPane.kind === "form") {
          const values = currentFormValues();
          if (formHasChanges(values) && !formDiscardArmedRef.current) {
            setFormValues(values);
            setFormDiscardArmed(true);
            addNotice("Press Esc again to discard this form.", "info");
            return;
          }
          setFormDiscardArmed(false);
          setFormValues({});
          setFormFieldIndex(0);
          setPrompt("");
          setRightPane({ kind: "empty" });
        }
        setRightOpen(false);
        lastUserOpenedPaneRef.current = null;
        userDismissedRightPaneRef.current = true;
        focusAfterDetails();
        return;
      }
      if (pane === "chat" && confirmOrDiscardChatDraft()) {
        return;
      }
      if (pane === "drawer") {
        // Esc on the sessions pane returns to the chat. It no longer has an
        // intermediate mode to back out of first, which is exactly why the
        // second Esc used to be needed.
        focusChat();
        return;
      }
      const conn = connectionRef.current;
      const sessionId = activeSessionIdRef.current;
      const activeTurnVisible = streaming || activeSession?.status === "active";
      if (pane === "chat" && activeTurnVisible && conn && sessionId) {
        setStreaming(false);
        setInterrupted(true);
        void interruptChat(conn, sessionId)
          .then((result) => addNotice(chatInterruptNotice(result), "info"))
          .catch((err) => addNotice(err instanceof Error ? err.message : String(err), "error"));
        return;
      }
      setPrompt("");
      return;
    }

    if (isCtrlInput(input, key, "c")) {
      const conn = connectionRef.current;
      const sessionId = activeSessionIdRef.current;
      const activeTurnVisible = streaming || activeSession?.status === "active";
      if (activeTurnVisible && conn && sessionId) {
        setStreaming(false);
        setInterrupted(true);
        void interruptChat(conn, sessionId)
          .then((result) => addNotice(chatInterruptNotice(result), "info"))
          .catch((err) => addNotice(err instanceof Error ? err.message : String(err), "error"));
        return;
      }
      if (isChatCopyShortcut(input, key) && isChatTextSelectionRange(chatMouseSelectionRef.current)) {
        copyChatSelection();
        return;
      }
      requestCtrlCExit();
      return;
    }

    if (isChatCopyShortcut(input, key) && isChatTextSelectionRange(chatMouseSelectionRef.current)) {
      copyChatSelection();
      return;
    }

    if (pendingApproval?.mode === "approval" && !pendingApproval.highStakes && ["a", "d", "y", "n"].includes(input)) {
      void resolvePendingApproval(pendingApproval, input === "a" || input === "y" ? "accept" : "decline")
        .catch((err) => addNotice(err instanceof Error ? err.message : String(err), "error"));
      return;
    }
    if (pane === "details" && rightOpen && rightPane.kind === "form" && rightPane.command === "lane-delete") {
      const fields = rightPane.fields;
      const field = fields[formFieldIndex] ?? fields[0] ?? null;
      const nextValues = currentFormValues();
      if (field?.name === "scope") {
        if (key.leftArrow || key.rightArrow) {
          const nextScope = cycleLaneDeleteScope(nextValues.scope, key.leftArrow ? -1 : 1);
          const values = { ...nextValues, scope: nextScope };
          setFormValues(values);
          setFormConfirmArmed(false);
          setPrompt("");
          return;
        }
        const scopeByKey: Record<string, LaneDeleteScope> = {
          "1": "worktree",
          "2": "local_branch",
          "3": "remote_branch",
        };
        if (scopeByKey[input]) {
          const nextScope = scopeByKey[input];
          const values = { ...nextValues, scope: nextScope };
          setFormValues(values);
          setFormConfirmArmed(false);
          setPrompt("");
          return;
        }
        if (printableInput(input) && !key.ctrl && !key.meta && !key.return) return;
      }
      if (field?.name === "force") {
        if (key.leftArrow || key.rightArrow || input === " " || input === "f") {
          const nextForce = nextValues.force === "yes" ? "no" : "yes";
          const values = { ...nextValues, force: nextForce };
          setFormValues(values);
          setFormConfirmArmed(false);
          setPrompt("");
          return;
        }
        if (printableInput(input) && !key.ctrl && !key.meta && !key.return) return;
      }
    }

    if (pane === "details" && rightOpen && rightPane.kind === "form" && rightPane.command === "new-lane") {
      const fields = rightPane.fields;
      const field = fields[formFieldIndex] ?? fields[0] ?? null;
      const nextValues = currentFormValues();
      if (field?.name === "start") {
        // 1-3 follow the vertical option order (primary / branch / child).
        const startByKey: Record<string, string> = { "1": "primary", "2": "import", "3": "child" };
        const cycled = key.leftArrow || key.rightArrow
          ? cycleNewLaneStart(nextValues.start, key.leftArrow ? -1 : 1)
          : startByKey[input];
        if (cycled && cycled !== normalizeNewLaneStart(nextValues.start)) {
          const activeLaneName = lanes.find((entry) => entry.id === activeLaneIdRef.current)?.name ?? null;
          setFormValues({ ...nextValues, start: cycled });
          // Rebuild the visible fields for the chosen mode (desktop dialog
          // parity: each "Start from" mode shows its own inputs). The start
          // row keeps the same index across modes so focus stays put.
          setRightPane((previous) => previous.kind === "form" && previous.command === "new-lane"
            ? { ...previous, fields: newLaneFormFields(normalizeNewLaneStart(cycled), { activeLaneName }) }
            : previous);
          setPrompt("");
          return;
        }
        if (cycled) {
          setPrompt("");
          return;
        }
        if (printableInput(input) && !key.ctrl && !key.meta && !key.return) return;
      }
      if (field?.name === "color") {
        if (key.leftArrow || key.rightArrow) {
          setFormValues({ ...nextValues, color: cycleNewLaneColor(nextValues.color, key.leftArrow ? -1 : 1) });
          setPrompt("");
          return;
        }
        if (printableInput(input) && !key.ctrl && !key.meta && !key.return) return;
      }
      if (field?.name === "branchSource") {
        if (key.leftArrow || key.rightArrow || input === " ") {
          setFormValues({ ...nextValues, branchSource: toggleNewLaneBranchSource(nextValues.branchSource) });
          setPrompt("");
          return;
        }
        if (printableInput(input) && !key.ctrl && !key.meta && !key.return) return;
      }
      if (field?.name === "create") {
        // ↵ falls through to the generic form submit below; everything else
        // is inert on the button row.
        if (printableInput(input) && !key.ctrl && !key.meta && !key.return) return;
        if (key.leftArrow || key.rightArrow) return;
      }
    }

    // Feedback form: dedicated multiline editing handled ABOVE the generic form
    // key handlers so the body gets a real text cursor (the shared prompt-input
    // primitive) while type/context/validation/serialization go through
    // feedbackForm.ts. Left/right cycle the type; Ctrl+T toggles the context
    // footer; Ctrl+S submits; Enter inserts a newline; pasted blocks keep their
    // embedded newlines and tabs verbatim (preserveMultiline).
    if (pane === "details" && rightOpen && rightPane.kind === "form" && rightPane.command === "feedback") {
      const form = rightPane;
      const meta = form.feedback ?? {};
      // While the success check is showing, swallow keys (auto-close handles exit).
      if (meta.feedback === "submitted") return;
      const updateFeedback = (patch: Partial<FeedbackContextMeta>) => {
        setRightPane({ ...form, feedback: { ...meta, ...patch } });
        setFormDiscardArmed(false);
      };
      if (key.escape) {
        if (formDiscardArmedRef.current) {
          setFormDiscardArmed(false);
          setFormValues({});
          setFormFieldIndex(0);
          setRightPane({ kind: "empty" });
          setRightOpen(false);
          focusAfterDetails();
          return;
        }
        setFormDiscardArmed(true);
        return;
      }
      if (isCtrlInput(input, key, "s")) {
        const state = feedbackStateFromMeta(meta);
        if (!feedbackFormCanSubmit(state)) {
          addNotice("Add some feedback before sending.", "error");
          return;
        }
        void submitRightForm(form, currentFormValues())
          .catch((err) => addNotice(err instanceof Error ? err.message : String(err), "error"));
        return;
      }
      if (isCtrlInput(input, key, "t")) {
        updateFeedback({ showContext: meta.showContext === false });
        return;
      }
      if (key.leftArrow || key.rightArrow) {
        const nextType = cycleFeedbackType(feedbackStateFromMeta(meta).type, key.leftArrow ? -1 : 1);
        updateFeedback({ type: nextType });
        return;
      }
      if (key.return) {
        updateFeedback({ body: `${meta.body ?? ""}\n` });
        return;
      }
      const currentBody = meta.body ?? "";
      // preserveMultiline keeps embedded newlines and tabs from a pasted block so
      // the body stays verbatim (a real Enter keypress is handled above).
      const edit = applyCoalescedPromptInput(currentBody, currentBody.length, input, true);
      if (edit.value !== currentBody) {
        updateFeedback({ body: edit.value });
        return;
      }
      if (key.backspace || key.delete) {
        if (currentBody.length > 0) updateFeedback({ body: currentBody.slice(0, -1) });
        return;
      }
      return;
    }

    if (pane === "details" && rightOpen && rightPane.kind === "form" && (key.upArrow || key.downArrow || key.return)) {
      const fields = rightPane.fields;
      const nextValues = currentFormValues();
      if (key.return) {
        if (prompt.trim().startsWith("/")) {
          void submitPrompt(prompt);
        } else if (isTwoStepConfirmCommand(rightPane.command) && !formConfirmArmedRef.current) {
          setFormConfirmArmed(true);
        } else {
          setFormDiscardArmed(false);
          setFormConfirmArmed(false);
          void submitRightForm(rightPane, nextValues)
            .catch((err) => addNotice(err instanceof Error ? err.message : String(err), "error"));
        }
        return;
      }
      setFormConfirmArmed(false);
      const delta = key.upArrow ? -1 : 1;
      const nextIndex = fields.length ? (formFieldIndex + delta + fields.length) % fields.length : 0;
      setFormValues(nextValues);
      setFormFieldIndex(nextIndex);
      setPrompt(
        fields[nextIndex] && formFieldUsesPromptInput(rightPane.command, fields[nextIndex]!.name)
          ? nextValues[fields[nextIndex]!.name] ?? ""
          : "",
      );
      return;
    }

    const killWorkerKey = key.ctrl && !key.meta && input.toLowerCase() === "k";
    const chatInfoDisclosureKey = !key.ctrl && !key.meta && !key.shift
      ? input.toLowerCase()
      : "";
    if (
      pane === "details"
      && rightOpen
      && rightPane.kind === "chat-info"
      && (key.upArrow || key.downArrow || key.return || killWorkerKey || ["c", "e", "a", "x"].includes(chatInfoDisclosureKey))
    ) {
      const subagentContent = subagentPaneContentFromRightPane(rightPane);
      if (!subagentContent) return;
      const paneRows = buildSubagentPaneRows(subagentContent, chatInfoRosterViewState);
      const snapshotRows = paneRows
        .filter((row): row is Extract<SubagentPaneRow, { kind: "snapshot" }> => row.kind === "snapshot");
      // Selection: 0 = main row; 1..N = subagent rows — shifted down by one
      // when the resume row is visible (0 = resume, 1 = main, …).
      const resumeOffset = chatInfoSelectionOffset(rightPane.info);
      const selectableCount = snapshotRows.length + 1 + resumeOffset;
      const resumeRowSelected = resumeOffset === 1 && rightSelectionIndex === 0;
      const selectedRow = rightSelectionIndex > resumeOffset ? snapshotRows[rightSelectionIndex - 1 - resumeOffset] : null;
      const selectedSnapshot: SubagentSnapshot | null = selectedRow ? selectedRow.snapshot : null;
      const focusedSection: SubagentPaneDisclosureSection = selectedRow?.section
        ?? (paneRows.find((row): row is Extract<SubagentPaneRow, { kind: "section-header" }> => row.kind === "section-header")?.section ?? "subagents");
      const focusedHeader = paneRows.find((row): row is Extract<SubagentPaneRow, { kind: "section-header" }> => (
        row.kind === "section-header" && row.section === focusedSection
      ));
      if (chatInfoDisclosureKey === "c") {
        if (focusedHeader?.collapsible) {
          activateSubagentPaneTarget({ type: "toggle-section", section: focusedSection }, resumeOffset);
          if (!focusedHeader.collapsed) setRightSelectionIndex(resumeOffset);
        }
        return;
      }
      if (chatInfoDisclosureKey === "e") {
        if (focusedHeader && (focusedHeader.earlierCount > 0 || focusedHeader.clearedCount > 0)) {
          activateSubagentPaneTarget({ type: "toggle-earlier", section: focusedSection }, resumeOffset);
        }
        return;
      }
      if (chatInfoDisclosureKey === "a") {
        if (paneRows.some((row) => row.kind === "show-all" && row.section === focusedSection)) {
          activateSubagentPaneTarget({ type: "show-all", section: focusedSection }, resumeOffset);
        }
        return;
      }
      if (chatInfoDisclosureKey === "x") {
        if (!(chatInfoRosterViewState.earlierExpanded?.[focusedSection] ?? true)) return;
        const clearIds = paneRows
          .filter((row): row is Extract<SubagentPaneRow, { kind: "snapshot" }> => (
            row.kind === "snapshot" && row.section === focusedSection && row.group === "earlier"
          ))
          .map((row) => row.snapshot.id);
        if (clearIds.length) {
          updateSubagentPaneViewState((current) => ({
            ...current,
            cleared: {
              ...current.cleared,
              [focusedSection]: [...new Set([...(current.cleared?.[focusedSection] ?? []), ...clearIds])],
            },
          }));
          setRightSelectionIndex(resumeOffset);
        }
        return;
      }
      // ^k — stop the selected Droid AGI worker. The Droid worker subagent id IS
      // its workerSessionId (see droidSdkEventMapper.mission_worker_started).
      if (killWorkerKey) {
        const conn = connectionRef.current;
        const sessionId = activeSessionId;
        if (
          conn
          && sessionId
          && chatInfoRef.current.provider === "droid"
          && selectedSnapshot
          && selectedSnapshot.kind === "subagent"
          && selectedSnapshot.status === "running"
        ) {
          const workerSessionId = selectedSnapshot.id;
          void killDroidWorker(conn, { sessionId, workerSessionId })
            .then(() => addNotice(`Stopping worker ${workerSessionId.slice(-6)}…`, "info"))
            .catch((err) => addNotice(`Failed to stop worker: ${err instanceof Error ? err.message : String(err)}`, "error"));
        }
        return;
      }
      if (key.upArrow || key.downArrow) {
        const delta = key.upArrow ? -1 : 1;
        setRightSelectionIndex((index) => (index + delta + selectableCount) % selectableCount);
        return;
      }
      if (key.return) {
        // Resume row (closed-but-resumable Claude terminal): same primitive
        // the desktop/mobile crashed-CLI resume buttons use (pty.resumeSession).
        // On success the pane simply stays on chat-info for the resumed
        // session (resumableTerminal flips false, the row disappears).
        if (resumeRowSelected) {
          const terminal = activeTerminalSessionRef.current;
          if (terminal) {
            void resumeClosedTerminalSession(terminal)
              .then((resumed) => {
                if (resumed) addNotice("Resuming Claude session…", "info");
              })
              .catch((err) => addNotice(err instanceof Error ? err.message : String(err), "error"));
          }
          return;
        }
        // Capability gate: only runtimes with a real child transcript
        // (Codex/OpenCode) take over the main chat. Cursor/Droid keep the row
        // selected with its inline detail shown. Claude's main row opens the
        // alternate provider-fidelity transcript; other main rows return home.
        if (selectedSnapshot && !chatInfoRef.current.capability.canViewFullTranscript) {
          return;
        }
        if (
          !selectedSnapshot
          && rightSelectionIndex === resumeOffset
          && chatInfoRef.current.provider === "claude"
          && chatInfoRef.current.capability.canViewFullTranscript
        ) {
          inspectMainTranscript();
          return;
        }
        inspectSubagentWithTranscriptProbe(selectedSnapshot);
        return;
      }
      return;
    }


    if (pane === "details" && rightOpen && rightPane.kind === "lane-details") {
      const laneDetails = rightPane;
      const worktreeMissing = laneDetails.worktreeAvailable === false;
      const maxIndex = worktreeMissing ? 0 : LANE_DETAIL_ACTIONS.length - 1 + (laneDetails.pr ? 1 : 0);
      if (key.upArrow) {
        setRightPane((prev) => prev.kind === "lane-details"
          ? { ...prev, selectedActionIndex: Math.max(0, prev.selectedActionIndex - 1) }
          : prev);
        return;
      }
      if (key.downArrow) {
        setRightPane((prev) => prev.kind === "lane-details"
          ? { ...prev, selectedActionIndex: Math.min(maxIndex, prev.selectedActionIndex + 1) }
          : prev);
        return;
      }
      if (input === "t" && !key.ctrl && !key.meta) {
        setRightPane((prev) => prev.kind === "lane-details" ? { ...prev, showFiles: !prev.showFiles } : prev);
        return;
      }
      if (
        input === "r"
        && !key.ctrl
        && !key.meta
        && laneDetails.setup?.status === "failed"
        && laneDetails.setup.retryable
      ) {
        const conn = connectionRef.current;
        if (!conn) {
          addNotice("Cannot retry setup while ADE is disconnected.", "error");
          return;
        }
        runLaneSetupAfterCreate(conn, laneDetails.lane, { templateId: laneDetails.setup.templateId ?? null });
        return;
      }
      if (key.return) {
        if (worktreeMissing) {
          addNotice(laneWorktreeUnavailableMessage(laneDetails.lane) ?? "Lane worktree is unavailable.", "error");
          return;
        }
        const index = laneDetails.selectedActionIndex;
        if (index < LANE_DETAIL_ACTIONS.length) {
          const action = LANE_DETAIL_ACTIONS[index];
          if (action) {
            if (action.intent === "rescue-unstaged") {
              openMoveUnstagedForm();
              return;
            }
            const text = action.slashCommand === "/commit" ? `${action.slashCommand} ` : action.slashCommand;
            setPrompt(text);
            promptRef.current = text;
            chatDraftRef.current = text;
            focusChat();
          }
          return;
        }
        if (laneDetails.pr) {
          const url = laneDetails.pr.url;
          if (url && openExternalUrl(url, addNotice)) {
            return;
          }
          setPrompt("/pr open");
          promptRef.current = "/pr open";
          void submitPrompt("/pr open");
          return;
        }
        return;
      }
    }

    if (pane === "details" && rightOpen && rightPane.kind === "activity") {
      const itemCount = rightPane.model.items.length;
      if (key.upArrow) {
        setRightSelectionIndex((index) => (index <= 0 ? Math.max(0, itemCount - 1) : index - 1));
        return;
      }
      if (key.downArrow) {
        setRightSelectionIndex((index) => (itemCount > 0 ? (index + 1) % itemCount : 0));
        return;
      }
      if ((key as { home?: boolean }).home) {
        setRightSelectionIndex(0);
        return;
      }
      if ((key as { end?: boolean }).end) {
        setRightSelectionIndex(Math.max(0, itemCount - 1));
        return;
      }
      if (key.return && itemCount > 0) {
        void activateActivityItem(rightSelectionIndex);
        return;
      }
      if (input.toLowerCase() === "r" && !key.ctrl && !key.meta) {
        void refreshActivityPane({ announce: true });
        return;
      }
    }

    if (pane === "details" && rightOpen && rightPane.kind === "plugin-panel") {
      const editingIndex = rightPane.state.editing ?? null;
      const interactives = rightPane.model.interactives;
      // While a field owns the composer, arrows and letters belong to the text
      // being typed; only Enter (commit, handled by submitPrompt) and Esc
      // (cancel, handled by the Esc ladder) reach the pane.
      if (editingIndex === null) {
        if (key.upArrow || key.downArrow) {
          pluginConfirmArmedRef.current = null;
          setRightSelectionIndex((index) => movePluginPaneSelection(rightPane.model, index, key.upArrow ? -1 : 1));
          return;
        }
        if (key.leftArrow || key.rightArrow) {
          const selected = interactives[rightSelectionIndex];
          // A `segmented` control cycles under ←/→ as well as answering a direct
          // press on one of its options, which is how a `select` field already
          // behaves — one gesture for "the next one", one for "that one".
          if (selected?.kind === "state") {
            const values = pluginPaneStateCycle(rightPane.model, selected.stateKey, key.leftArrow ? -1 : 1);
            updatePluginPaneState((state) => ({ ...state, state: values }));
            return;
          }
          if (selected?.kind === "field" && !pluginFieldUsesComposer(selected.field.kind)) {
            const raw = pluginFieldRawValue(selected.field, selected.formKey, rightPane.state.values);
            const next = cyclePluginFieldValue(selected.field, raw, key.leftArrow ? -1 : 1);
            updatePluginPaneState((state) => ({
              ...state,
              values: { ...state.values, [pluginFormValueKey(selected.formKey, selected.field.id)]: next },
            }));
            // ←/→ finishes the value the same way a direct press does, so an
            // apply-on-change form applies it here too rather than only on the
            // gesture the reader happened not to use.
            if (selected.applyOnChange) {
              void activatePluginInteractive(rightSelectionIndex, { commitValue: next });
            }
            return;
          }
        }
        if (key.return && interactives.length > 0) {
          void activatePluginInteractive(rightSelectionIndex);
          return;
        }
        if (input.toLowerCase() === "r" && !key.ctrl && !key.meta) {
          void refreshPluginPane({ announce: true, runDeclared: true });
          return;
        }
      }
    }

    if (pane === "details" && rightOpen && rightPane.kind === "list" && rightPane.action && key.upArrow) {
      const max = rightPane.rows.length;
      setRightSelectionIndex((index) => (index <= 0 ? Math.max(0, max - 1) : index - 1));
      return;
    }
    if (pane === "details" && rightOpen && rightPane.kind === "list" && rightPane.action && key.downArrow) {
      const max = rightPane.rows.length;
      setRightSelectionIndex((index) => (max > 0 ? (index + 1) % max : 0));
      return;
    }
    if (
      pane === "details"
      && rightOpen
      && rightPane.kind === "list"
      && rightPane.action?.kind === "copy-secret"
      && input.toLowerCase() === "c"
      && !key.ctrl
      && !key.meta
    ) {
      const selectedId = rightPane.action.ids[rightSelectionIndex] ?? rightPane.action.ids[0] ?? null;
      if (selectedId) activateRightPaneListItem(selectedId, rightPane.action.kind);
      return;
    }
    if (pane === "details" && rightOpen && rightPane.kind === "list" && rightPane.action && key.return) {
      const selectedId = rightPane.action.ids[rightSelectionIndex] ?? rightPane.action.ids[0] ?? null;
      if (!selectedId) return;
      activateRightPaneListItem(selectedId, rightPane.action.kind);
      return;
    }

    const pageUp = Boolean((key as { pageUp?: boolean }).pageUp);
    const pageDown = Boolean((key as { pageDown?: boolean }).pageDown);
    const home = Boolean((key as { home?: boolean }).home);
    const end = Boolean((key as { end?: boolean }).end);
    if (pane === "chat" && !activeMentionRange && !slashRows.length) {
      const pageRows = Math.max(1, chatRowBudget - 2);
      const halfPageUp = isCtrlInput(input, key, "u");
      const halfPageDown = isCtrlInput(input, key, "d");
      if (pageUp || halfPageUp) {
        setChatScrollOffset((offset) => offset + (halfPageUp ? Math.max(1, Math.floor(pageRows / 2)) : pageRows));
        return;
      }
      if (pageDown || halfPageDown) {
        setChatScrollOffset((offset) => offset - (halfPageDown ? Math.max(1, Math.floor(pageRows / 2)) : pageRows));
        return;
      }
      if (home) {
        setChatScrollOffset((offset) => Math.max(offset, 100_000));
        return;
      }
      if (end) {
        setChatScrollOffset(0);
        return;
      }
      if (!prompt.trim() && key.upArrow) {
        recallPromptHistory("previous");
        return;
      }
      if (!prompt.trim() && key.downArrow) {
        recallPromptHistory("next");
        return;
      }
    }

    if (pane === "chat" && key.upArrow && activeMentionRange && mentionSuggestions.length) {
      setMentionIndex((index) => (index <= 0 ? mentionSuggestions.length - 1 : index - 1));
      return;
    }
    if (pane === "chat" && key.downArrow && activeMentionRange && mentionSuggestions.length) {
      setMentionIndex((index) => (index + 1) % mentionSuggestions.length);
      return;
    }
    if (pane === "chat" && key.tab && activeMentionRange && mentionSuggestions.length) {
      insertMention(mentionSuggestions[mentionIndex] ?? mentionSuggestions[0]!);
      return;
    }
    if (pane === "chat" && key.upArrow && slashRows.length) {
      setSlashIndex((index) => (index <= 0 ? slashRows.length - 1 : index - 1));
      return;
    }
    if (pane === "chat" && key.downArrow && slashRows.length) {
      setSlashIndex((index) => (index + 1) % slashRows.length);
      return;
    }
    if (pane === "chat" && (key.tab || (key.return && slashTriggerMidSentence)) && slashRows.length) {
      insertSlashCommand();
      return;
    }

    // The sessions pane owns its whole keyboard surface (arrows, Enter, row
    // hotkeys) behind ONE branch — see `handleWorkPaneKey`.
    if (pane === "drawer" && drawerOpen && handleWorkPaneKey(input, key)) {
      return;
    }

    if (pane === "drawer" && drawerOpen && !key.ctrl && !key.meta && input) {
      const suffix = printableInput(input);
      if (suffix) {
        const draft = `${chatDraftRef.current}${suffix}`;
        focusChat();
        chatDraftRef.current = draft;
        setPromptValue(draft);
      }
      return;
    }

    const expandableLineId = latestFailedLineId;
    if (
      key.return
      && expandableLineId
      && shouldToggleLatestFailedLineOnBlankEnter({
        pane,
        prompt,
        latestFailedLineId: expandableLineId,
        pendingApproval,
        rightPaneKind: rightPane.kind,
        slashRowCount: slashRows.length,
        activeTerminalSession: activeTerminalSessionRef.current,
      })
    ) {
      setExpandedLineIds((prev) => {
        const next = new Set(prev);
        if (next.has(expandableLineId)) next.delete(expandableLineId);
        else next.add(expandableLineId);
        return next;
      });
      return;
    }
    // Ctrl+B opens the image the caret is sitting on. Ctrl+H (the older
    // "open the last image" binding) can't carry this: with a non-empty
    // prompt it is already word-backspace, and a token only exists when the
    // prompt is non-empty.
    if (textInputActive && !key.meta && isCtrlInput(input, key, "b")) {
      if (!openImageTokenAtCursor()) {
        addNotice("Put the cursor on an ⟦image:png⟧ chip to open it.", "info");
      }
      return;
    }
    if (
      pane === "chat"
      && !prompt.trim()
      && !pendingApproval
      && rightPane.kind !== "form"
      && !slashRows.length
      && key.ctrl
      && !key.meta
      && input === "h"
    ) {
      openLatestImage();
      return;
    }
    const linePrefix = inputBeforeLineBreak(input);
    if (textInputActive && linePrefix != null && !key.return) {
      const suffix = printablePromptInput(input);
      if (suffix) {
        const next = insertPromptText(prompt, promptCursorRef.current, suffix);
        handlePromptChange(next.value, next.cursor);
      }
      return;
    }
    if (textInputActive && key.return) {
      void submitPrompt(prompt);
      return;
    }
    if (textInputActive && (key.backspace || key.delete)) {
      const next = deletePromptForKey(prompt, promptCursorRef.current, key);
      handlePromptChange(next.value, next.cursor);
      return;
    }
    if (textInputActive && !key.ctrl && input) {
      // Segment the chunk so a coalesced "type + backspace" burst (which Ink
      // hands us as one chunk with no backspace flag) applies its deletes
      // instead of dropping them. Pure-printable input inserts as before.
      const cursor = promptCursorRef.current;
      const next = applyCoalescedPromptInput(prompt, cursor, input);
      if (next.value !== prompt || next.cursor !== cursor) {
        handlePromptChange(next.value, next.cursor);
      }
    }
  });

  const handlePromptChange = useCallback((value: string, cursor: number = value.length) => {
    setFormDiscardArmed(false);
    setFormConfirmArmed(false);
    if (activePaneRef.current === "chat" && value === "?") {
      renderHelpPane("", 0, helpRecentsRef.current);
      focusDetails();
      setPromptValue("");
      return;
    }
    if (activePaneRef.current === "chat") {
      chatDraftRef.current = value;
    }
    if (
      activePaneRef.current === "details"
      && rightPane.kind === "form"
      && activeFormField
      && formFieldUsesPromptInput(rightPane.command, activeFormField.name)
    ) {
      setFormValues((prev) => ({ ...prev, [activeFormField.name]: value }));
    }
    setPromptValue(value, cursor);
  }, [activeFormField, focusDetails, rightPane, setFormConfirmArmed, setPromptValue]);

  const attachedImageChips = useMemo(() => {
    return selectedMentions
      .filter((mention) => (
        mention.kind === "file"
        && mention.filePath
        && isImageFilePath(mention.filePath)
        && (mention.attachment || prompt.includes(mention.insertText))
      ))
      .map((mention) => {
        const dimensions = mention.filePath ? readImageDimensions(mention.filePath) : null;
        return {
          key: mention.filePath ?? mention.insertText,
          label: mention.label,
          dimensions: dimensions ? `${dimensions.width}x${dimensions.height}` : null,
          filePath: mention.filePath ?? null,
        };
      });
  }, [prompt, selectedMentions]);

  const removeAttachmentAtIndex = useCallback((index: number) => {
    const filePath = attachedImageChips[index]?.filePath;
    if (!filePath) return;
    setSelectedMentions((prev) => prev.filter((mention) => mention.filePath !== filePath));
    setAttachmentFocusIndex((current) => {
      if (current == null) return null;
      const remaining = attachedImageChips.length - 1;
      if (remaining <= 0) return null;
      return Math.min(current, remaining - 1);
    });
  }, [attachedImageChips]);

  const movePromptCursor = useCallback((delta: -1 | 1, mode: "char" | "word" = "char") => {
    const current = promptCursorRef.current;
    const next = mode === "word"
      ? (delta < 0 ? previousPromptWordBoundary(prompt, current) : nextPromptWordBoundary(prompt, current))
      : (delta < 0 ? previousPromptCharacterBoundary(prompt, current) : nextPromptCharacterBoundary(prompt, current));
    promptCursorRef.current = next;
    setPromptCursor(next);
    setAttachmentFocusIndex(null);
  }, [prompt]);

  const movePromptCursorVerticalAndMaybeAttach = useCallback((delta: -1 | 1) => {
    const width = promptWrapWidth(promptPaneWidth);
    const current = promptCursorRef.current;
    if (delta < 0 && isPromptCursorOnFirstVisualRow(prompt, width, current) && attachedImageChips.length) {
      setAttachmentFocusIndex(0);
      return;
    }
    if (delta < 0 && isPromptCursorOnFirstVisualRow(prompt, width, current)) {
      recallPromptHistory("previous");
      return;
    }
    if (delta > 0 && isPromptCursorOnLastVisualRow(prompt, width, current)) {
      setAttachmentFocusIndex(null);
      recallPromptHistory("next");
      return;
    }
    const next = movePromptCursorVertical(prompt, width, current, delta);
    promptCursorRef.current = next;
    setPromptCursor(next);
    setAttachmentFocusIndex(null);
  }, [attachedImageChips.length, prompt, promptPaneWidth, recallPromptHistory]);

  const rightPaneVisible = rightPaneWidth > 0;
  const laneName = activeLane?.name ?? "main";
  // When the cursor is in the inline model row, the prompt box loses its
  // focused outline so the user can see the row took over.
  const promptFocused = !inlineRowFocused
    && attachmentFocusIndex == null
    // A plugin's question owns the field from whichever pane raised it, so the
    // caret has to be drawn there too — otherwise the reader is typing into a
    // line that looks inert.
    && (pluginPrompt != null
      || (activePane === "chat" && footerControl == null)
      || (activePane === "details" && rightPane.kind === "form"));
  const drawerFooterSelected = footerControl === "drawer";
  const detailsFooterSelected = footerControl === "details";
  const agentsFooterSelected = footerControl === "agents";
  const rightPaneShowsAgents = rightPaneVisible && rightPane.kind === "chat-info";
  const showCommandPalette = commandPaletteOpen;
  const showMentionPalette = activeMentionRange != null;
  const showSlashPalette = slashComposerTrigger != null;
  const errorRows = error ? (!connection ? 2 : 1) : 0;
  const paletteBottomRows = 5
    + (promptRows.length - 1)
    + smartLinkRows
    + modelStatusOverlayRows
    + backgroundLaunchRows
    + (attachedImageChips.length ? 1 : 0)
    + errorRows;
  // Slash palette grows with available terminal height (clamped) so it's bigger
  // on large screens. Reserve exactly what it will render so it lines up.
  const slashPaletteHeightBudget = Math.max(8, Math.min(17, rows - paletteBottomRows - 4));
  const paletteOverlayRows = showCommandPalette
    ? COMMAND_PALETTE_ROWS
    : showMentionPalette
      ? MENTION_PALETTE_ROWS
      : slashPaletteReservedRows(slashPaletteHeightBudget);
  const paletteOverlayTop = Math.max(1, rows - paletteBottomRows - paletteOverlayRows);
  const drawerPaneWidth = resolveDrawerPaneWidth(columns, drawerOpen);
  const paletteOverlayLeft = drawerPaneWidth;
  const paletteOverlayWidth = Math.max(MIN_CENTER_PANE_WIDTH, centerWidth);
  const commandPaletteVisibleRows = Math.max(1, COMMAND_PALETTE_ROWS - 3);
  const commandPaletteWindowStart = (() => {
    const total = commandPaletteItems.length;
    if (total <= commandPaletteVisibleRows) return 0;
    const safeIndex = Math.max(0, Math.min(commandPaletteIndex, total - 1));
    const half = Math.floor(commandPaletteVisibleRows / 2);
    let start = Math.max(0, safeIndex - half);
    if (start + commandPaletteVisibleRows > total) {
      start = Math.max(0, total - commandPaletteVisibleRows);
    }
    return start;
  })();
  useEffect(() => {
    const registry = hitTestRegistryRef.current;
    for (const id of appHitTargetIdsRef.current) registry.unregister(id);
    const targets: HitTarget[] = [];
    const addTarget = (target: HitTarget) => {
      targets.push(target);
      registry.register(target);
    };

    const promptRowsCount = Math.max(1, promptRows.length);
    const promptBoxRows = promptRowsCount + smartLinkRows + 2;
    const firstPromptLine = rows - 1 - modelStatusOverlayRows - promptBoxRows + 1;
    addTarget({
      id: "header:context",
      rect: { x: 1, y: 1, w: columns, h: 1 },
      onClick: () => {
        setDrawerOpen(true);
        focusDrawerOnly();
      },
      zIndex: 1,
    });
    addTarget({
      id: "prompt:focus",
      rect: { x: 1, y: Math.max(1, firstPromptLine - 1), w: promptPaneWidth, h: promptBoxRows + 1 },
      onClick: () => focusChat(),
      zIndex: 1,
    });
    addTarget({
      id: "footer:model-row",
      rect: { x: 1, y: rows, w: Math.max(10, Math.floor(columns * 0.55)), h: 1 },
      onClick: () => {
        selectFooterControl(null);
        openModelWizard();
      },
      zIndex: 2,
    });
    const addFooterInlineTarget = (
      id: string,
      x: number,
      width: number,
      onClick: () => void,
    ) => {
      addTarget({
        id,
        rect: { x: Math.max(1, x), y: rows, w: Math.max(1, width), h: 1 },
        onClick,
        zIndex: 5,
      });
    };
    const footerCellWidth = (value: string, cell: NonNullable<typeof inlineRowFocus.cell>) =>
      value.length + (inlineRowFocused && inlineRowFocus.cell === cell ? 2 : 0);
    let footerX = 2 + (inlineRowFocused ? 2 : 0);
    const providerBrand = modelState.provider ? theme.provider(modelState.provider) : null;
    if (providerBrand) {
      const value = `${providerBrand.glyph} ${providerBrand.label}`;
      const width = footerCellWidth(value, "provider");
      addFooterInlineTarget("footer:inline:provider", footerX, width, () => {
        selectFooterControl(null);
        setPaneFocus("chat");
        setInlineRowFocus({ cell: providerLockedRef.current ? "model" : "provider" });
        if (!providerLockedRef.current) cycleProvider(1);
      });
      footerX += width;
    }
    if (modelState.displayName) {
      footerX += 2;
      const width = footerCellWidth(modelState.displayName, "model");
      addFooterInlineTarget("footer:inline:model", footerX, width, () => {
        selectFooterControl(null);
        setPaneFocus("chat");
        setInlineRowFocus({ cell: "model" });
        openModelWizard();
      });
      footerX += width;
    }
    if (footerFastSupported) {
      footerX += 2;
      const width = footerCellWidth("fast", "fast");
      addFooterInlineTarget("footer:inline:fast", footerX, width, () => {
        selectFooterControl(null);
        setPaneFocus("chat");
        setInlineRowFocus({ cell: "fast" });
        applyModelState((prev) => ({ ...prev, fastMode: !prev.fastMode }));
      });
      footerX += width;
    }
    if (footerReasoningSupported && footerReasoningLabel) {
      footerX += 2;
      const width = footerCellWidth(footerReasoningLabel, "reasoning");
      addFooterInlineTarget("footer:inline:reasoning", footerX, width, () => {
        selectFooterControl(null);
        setPaneFocus("chat");
        setInlineRowFocus({ cell: "reasoning" });
        cycleReasoning(1);
      });
      footerX += width;
    }
    const permissionLabel = permissionSummary(modelState);
    if (permissionLabel) {
      footerX += 2;
      const width = footerCellWidth(permissionLabel, "permission");
      addFooterInlineTarget("footer:inline:permission", footerX, width, () => {
        selectFooterControl(null);
        setPaneFocus("chat");
        setInlineRowFocus({ cell: "permission" });
        cyclePermission(1);
      });
      footerX += width;
    }
    if (subagentPaneCommandAvailable) {
      footerX += 2;
      const subagentValue = liveAgentCount > 0 ? `⊚ chat info · ${liveAgentCount}` : "⊚ chat info";
      const width = footerCellWidth(subagentValue, "subagents");
      addFooterInlineTarget("footer:inline:subagents", footerX, width, () => {
        selectFooterControl(null);
        setInlineRowFocus({ cell: "subagents" });
        openSubagentsPane();
      });
    }

    const rightFooterItems: Array<{ id: string; label: string; onClick: () => void }> = [];
    if (pendingApproval?.mode === "approval" && !pendingApproval.highStakes) {
      rightFooterItems.push(
        {
          id: "footer:approval-accept",
          label: "a approve",
          onClick: () => {
            void resolvePendingApproval(pendingApproval, "accept")
              .catch((err) => addNotice(err instanceof Error ? err.message : String(err), "error"));
          },
        },
        {
          id: "footer:approval-decline",
          label: "d deny",
          onClick: () => {
            void resolvePendingApproval(pendingApproval, "decline")
              .catch((err) => addNotice(err instanceof Error ? err.message : String(err), "error"));
          },
        },
      );
    } else if (inlineRowFocused) {
      rightFooterItems.push(
        { id: "footer:inline-exit", label: "up prompt", onClick: () => setInlineRowFocus({ cell: null }) },
        {
          id: "footer:inline-cycle",
          label: "down cycle",
          onClick: () => {
            const cell = inlineRowFocus.cell;
            if (cell === "provider") cycleProvider(1);
            else if (cell === "model") cycleModel(1);
            else if (cell === "fast") applyModelState((prev) => ({ ...prev, fastMode: !prev.fastMode }));
            else if (cell === "reasoning") cycleReasoning(1);
            else if (cell === "permission") cyclePermission(1);
            else if (cell === "subagents") openSubagentsPane();
          },
        },
      );
    } else {
      rightFooterItems.push(
        { id: "footer:lanes-exact", label: "^o work", onClick: () => toggleDrawerPane() },
        { id: "footer:pane-exact", label: "^p pane", onClick: () => toggleDetailsPane() },
      );
      if (!subagentPaneCommandAvailable) {
        rightFooterItems.push({ id: "footer:chat-info-exact", label: "^a chat info", onClick: () => toggleSubagentsPane() });
      }
      rightFooterItems.push({
        id: "footer:split",
        label: gridViewActive ? "^g add chat" : multiView ? "^g grid" : "^g split",
        onClick: () => toggleGridView(),
      });
      if (multiView) {
        const tabTarget = gridTabNavigationTarget({
          drawerOpen,
          rightOpen,
          tileCount: multiView.tiles.length,
        });
        rightFooterItems.push(
          {
            id: "footer:tile-next",
            label: tabTarget === "tiles" ? "tab tile" : "tab pane",
            onClick: () => {
              if (tabTarget === "panes") {
                cyclePaneFocus(1);
                return;
              }
              setMultiView((prev) => prev
                ? { ...prev, focusedIndex: (prev.focusedIndex + 1) % Math.max(1, prev.tiles.length) }
                : prev);
            },
          },
          {
            id: "footer:tile-close",
            label: "^w close tile",
            onClick: () => removeMultiViewTile(multiView.focusedIndex),
          },
        );
      }
      rightFooterItems.push(
        {
          id: "footer:commands",
          label: "/ cmds",
          onClick: () => {
            focusChat();
            handlePromptChange("/");
          },
        },
        {
          id: "footer:help",
          label: "? help",
          onClick: () => {
            void runRightCommand("/help", "")
              .catch((err) => addNotice(err instanceof Error ? err.message : String(err), "error"));
          },
        },
      );
      if (terminalControlAvailable) {
        rightFooterItems.push({
          id: "footer:terminal-control",
          label: `^t ${terminalControlLabel}`,
          onClick: () => {
            const terminal = activeTerminalSessionRef.current;
            if (
              terminal?.terminalId === activeSessionIdRef.current
              && terminal.status === "running"
              && terminalSessionProvider(terminal)
            ) {
              focusChat();
              setAttachedTerminalId(terminal.terminalId);
            }
          },
        });
      }
    }
    const rightFooterWidth = rightFooterItems.reduce((total, item, index) => total + item.label.length + (index > 0 ? 2 : 0), 0);
    let rightFooterX = Math.max(1, columns - rightFooterWidth + 1);
    rightFooterItems.forEach((item, index) => {
      if (index > 0) rightFooterX += 2;
      addTarget({
        id: item.id,
        rect: { x: rightFooterX, y: rows, w: item.label.length, h: 1 },
        onClick: item.onClick,
        zIndex: 5,
      });
      rightFooterX += item.label.length;
    });
    addTarget({
      id: "footer:lanes",
      rect: { x: Math.max(1, columns - 38), y: rows, w: 10, h: 1 },
      onClick: () => toggleDrawerPane(),
      zIndex: 3,
    });
    addTarget({
      id: "footer:pane",
      rect: { x: Math.max(1, columns - 26), y: rows, w: 9, h: 1 },
      onClick: () => toggleDetailsPane(),
      zIndex: 3,
    });
    addTarget({
      id: "footer:chat-info",
      rect: { x: Math.max(1, columns - 15), y: rows, w: 14, h: 1 },
      onClick: () => toggleSubagentsPane(),
      zIndex: 3,
    });

    if (drawerOpen && drawerPaneWidth > 0) {
      // Rects come from the same layout the pane rendered. Singleton cards
      // split the first line so a lane-name click opens lane details.
      const rects = workListHitRects({
        layout: workListLayoutValue,
        paneTopRow: 3 + goalBannerRows + addModeRows,
        paneLeft: 1,
        paneWidth: drawerPaneWidth,
      });
      for (const entry of rects) {
        const row = workListModel.rows[entry.index];
        if (!row) continue;
        addTarget({
          id: entry.region === "lane-identity"
            ? `work:${entry.key}:lane-identity`
            : `work:${entry.key}`,
          rect: entry.rect,
          onClick: () => {
            if (addModeRef.current) {
              // Picker mode: a lane header moves the cursor, a chat is added.
              if (row.kind === "session" && !row.machine && row.laneId) {
                addTileToGrid(row.sessionId, row.laneId);
              } else if (row.kind === "lane-header" && row.laneId) {
                const laneSessions = tileableDisplaySessions.filter((session) => session.laneId === row.laneId);
                setAddMode({ cursorLaneId: row.laneId, cursorChatId: laneSessions[0]?.sessionId ?? null });
                setDrawerLaneId(row.laneId);
              }
              return;
            }
            focusDrawerOnly();
            activateWorkRow(row, entry.region);
          },
          onDragStart: row.kind === "session" && !row.machine && row.laneId
            ? () => {
                dragAddSessionRef.current = { sessionId: row.sessionId, laneId: row.laneId! };
              }
            : undefined,
          zIndex: 2,
        });
      }
    }

    if (showCommandPalette) {
      commandPaletteItems
        .slice(commandPaletteWindowStart, commandPaletteWindowStart + commandPaletteVisibleRows)
        .forEach((item, visibleIndex) => {
          const index = commandPaletteWindowStart + visibleIndex;
          addTarget({
            id: `command-palette:${index}`,
            rect: { x: paletteOverlayLeft + 1, y: paletteOverlayTop + visibleIndex + 1, w: paletteOverlayWidth, h: 1 },
            onClick: () => {
              setCommandPaletteIndex(index);
              void runCommandPaletteItem(item)
                .catch((err) => addNotice(err instanceof Error ? err.message : String(err), "error"));
            },
            onHover: (hovered) => { if (hovered) setCommandPaletteIndex(index); },
            zIndex: 22,
          });
        });
    } else if (showMentionPalette) {
      mentionSuggestions.forEach((suggestion, index) => {
        addTarget({
          id: `mention:${index}`,
          rect: { x: paletteOverlayLeft + 1, y: paletteOverlayTop + index + 1, w: paletteOverlayWidth, h: 1 },
          onClick: () => insertMention(suggestion),
          onHover: (hovered) => { if (hovered) setMentionIndex(index); },
          zIndex: 20,
        });
      });
    } else if (showSlashPalette) {
      slashRows.forEach((row, index) => {
        addTarget({
          id: `slash:${row.name}:${index}`,
          rect: { x: paletteOverlayLeft + 1, y: paletteOverlayTop + index + 1, w: paletteOverlayWidth, h: 1 },
          onClick: () => {
            setSlashIndex(index);
            insertSlashCommandRow(row);
          },
          onHover: (hovered) => { if (hovered) setSlashIndex(index); },
          zIndex: 20,
        });
      });
    }

    if (pendingApproval?.mode === "approval" && !pendingApproval.highStakes) {
      const approvalY = Math.max(1, 2 + goalBannerRows + addModeRows + chatRowBudget - 2);
      const centerStart = drawerPaneWidth + 1;
      addTarget({
        id: "approval:accept",
        rect: { x: centerStart + 1, y: approvalY, w: Math.max(8, Math.floor(centerWidth / 2) - 2), h: 2 },
        onClick: () => {
          void resolvePendingApproval(pendingApproval, "accept")
            .catch((err) => addNotice(err instanceof Error ? err.message : String(err), "error"));
        },
        zIndex: 8,
      });
      addTarget({
        id: "approval:decline",
        rect: { x: centerStart + Math.max(8, Math.floor(centerWidth / 2)), y: approvalY, w: Math.max(8, Math.floor(centerWidth / 2) - 2), h: 2 },
        onClick: () => {
          void resolvePendingApproval(pendingApproval, "decline")
            .catch((err) => addNotice(err instanceof Error ? err.message : String(err), "error"));
        },
        zIndex: 8,
      });
    } else if (pendingApproval?.mode === "question") {
      const questions = pendingApproval.request?.questions ?? [];
      const centerStart = drawerPaneWidth + 1;
      const optionStartY = Math.max(1, 4 + goalBannerRows + addModeRows + chatRowBudget - 2);
      let optionRow = optionStartY;
      questions.forEach((question, questionIndex) => {
        optionRow += questionIndex === 0 ? 0 : 2;
        const options = optionsForPendingQuestion(pendingApproval.request, question, questionIndex);
        options.forEach((option, index) => {
          addTarget({
            id: `approval:question-option:${questionIndex}:${option.value}:${index}`,
            rect: { x: centerStart + 1, y: optionRow + index, w: Math.max(12, centerWidth - 2), h: 1 },
            onClick: () => {
              const current = ensurePendingQuestionSelectionState(pendingApproval, pendingQuestionStateRef.current);
              if (!current) return;
              const next = selectPendingQuestionOptionIndex(
                pendingApproval.request,
                { ...current, activeQuestionIndex: questionIndex },
                index,
              );
              pendingQuestionStateRef.current = next;
              setPendingQuestionState(next);
            },
            zIndex: 8,
          });
        });
        optionRow += Math.max(1, options.length);
      });
    }

    if (rightPaneVisible && rightPaneWidth > 0) {
      const rightStartColumn = columns - rightPaneWidth + 1;
      const rightBodyTop = 2 + goalBannerRows + addModeRows;
      if (rightPane.kind === "model-wizard" && modelWizardInput && modelWizardView) {
        // Every wizard row is clickable. Rects come from modelWizardGeometry —
        // the same windowing ModelWizardPane renders with — anchored on the
        // pane's MEASURED content origin when Ink reported one.
        const wizard = rightPane;
        const wizardInput = modelWizardInput;
        const measured = pickerMeasuredOrigin;
        const measuredOk = Boolean(
          measured
          && measured.y >= 1 && measured.y <= rows
          && measured.x >= 1 && measured.x <= columns
          && measured.width >= 8,
        );
        const paneOrigin = measuredOk && measured
          ? { paneLeft: measured.x, paneTop: measured.y, paneWidth: measured.width }
          : modelPickerPaneContentOrigin({
              paneTop: rightBodyTop,
              paneLeft: rightStartColumn,
              paneWidth: rightPaneWidth,
            });
        const geometry = modelWizardGeometry({
          paneLeft: paneOrigin.paneLeft,
          paneTop: paneOrigin.paneTop,
          paneWidth: paneOrigin.paneWidth,
          view: modelWizardView,
        });
        geometry.options.forEach(({ id, index, rect }) => {
          addTarget({
            id,
            rect,
            onClick: () => {
              // Click = move the cursor there, then Enter — one code path with
              // the keyboard so a click can never activate a different row than
              // the one the arrow keys would have.
              setRightPane({ ...wizard, index });
              const advance = advanceModelWizard({ ...wizardInput, selection: { ...wizardInput.selection, index } });
              switch (advance.kind) {
                case "step":
                  setRightPane({
                    ...wizard,
                    step: advance.selection.step,
                    provider: advance.selection.provider,
                    familyKey: advance.selection.familyKey,
                    index: advance.selection.index,
                  });
                  return;
                case "select-provider": {
                  if (modelPickerProviderSwitchBlocked({
                    providerLocked: providerLockedRef.current,
                    surface: wizard.surface,
                    currentProvider: modelStateRef.current.provider,
                    nextProvider: advance.provider,
                  })) {
                    addNotice("Provider is locked for this chat. /new chat to switch.", "info");
                    return;
                  }
                  selectProvider(advance.provider);
                  setRightPane({
                    ...wizard,
                    step: advance.selection.step,
                    provider: advance.selection.provider,
                    familyKey: advance.selection.familyKey,
                    index: advance.selection.index,
                  });
                  return;
                }
                case "select-model":
                  commitModelPickerSelection(advance.modelId);
                  setRightPane({
                    ...wizard,
                    step: advance.selection.step,
                    provider: advance.selection.provider,
                    familyKey: advance.selection.familyKey,
                    index: advance.selection.index,
                  });
                  return;
                case "sign-in":
                  void runInlineCommand("/login", advance.provider);
                  return;
                case "cycle-setting": {
                  const row = wizardInput.settingsRows.find((entry) => entry.kind === advance.settingKind);
                  if (row) handleSetupRow(row, advance.direction);
                  return;
                }
                case "commit":
                  rememberModelChoice(modelStateRef.current);
                  closeModelWizard();
                  return;
                default:
                  return;
              }
            },
            zIndex: 5,
          });
        });
      } else if (rightPane.kind === "chat-info") {
        const subagentContent = subagentPaneContentFromRightPane(rightPane);
        const resumeOffset = chatInfoSelectionOffset(rightPane.info);
        const subagentPaneTop = 2 + goalBannerRows + addModeRows + 1 + chatInfoPreambleLines(rightPane.info) - 4;
        if (resumeOffset) {
          // Dedicated hit-target for the resume row (it renders as the first
          // body line, directly below the pane title) — chat-info roster rows
          // are line-mapped, so this row gets its own explicit target like the
          // form buttons do. Click selects + activates.
          addTarget({
            id: "right:chat-info:resume",
            rect: { x: rightStartColumn, y: rightBodyTop, w: rightPaneWidth, h: 1 },
            onClick: () => {
              setRightSelectionIndex(0);
              setRightOpen(true);
              setPaneFocus("details");
              const terminal = activeTerminalSessionRef.current;
              if (terminal) {
                void resumeClosedTerminalSession(terminal)
                  .then((resumed) => {
                    if (resumed) addNotice("Resuming Claude session…", "info");
                  })
                  .catch((err) => addNotice(err instanceof Error ? err.message : String(err), "error"));
              }
            },
            zIndex: 4,
          });
        }
        if (subagentContent) {
          for (let y = rightBodyTop; y <= Math.max(rightBodyTop, rows - 2); y += 1) {
            const target = subagentIndexForPaneLine(subagentContent, y - subagentPaneTop, rightSelectionIndex - resumeOffset, chatInfoRosterViewState, SUBAGENT_PANE_ROSTER_CAPACITY);
            if (!target) continue;
            const targetKey = target.type === "snapshot" ? `${target.type}:${target.index}` : `${target.type}:${target.section}`;
            addTarget({
              id: `right:chat-info:${targetKey}:${y}`,
              rect: { x: rightStartColumn, y, w: rightPaneWidth, h: 1 },
              onClick: () => {
                activateSubagentPaneTarget(target, resumeOffset);
                setRightOpen(true);
                setPaneFocus("details");
              },
              zIndex: 3,
            });
          }
        }
      } else if (rightPane.kind === "lane-details") {
        const layout = laneDetailsInteractionLayout(rightPane);
        LANE_DETAIL_ACTIONS.forEach((_, index) => {
          const rowOffset = layout.actionRows[index];
          if (rowOffset == null) return;
          const y = rightBodyTop + rowOffset;
          addTarget({
            id: `right:lane-action:${index}`,
            rect: { x: rightStartColumn, y, w: rightPaneWidth, h: 1 },
            onClick: () => {
              setRightPane((prev) => prev.kind === "lane-details" ? { ...prev, selectedActionIndex: index } : prev);
              if (rightPane.worktreeAvailable === false) {
                addNotice(laneWorktreeUnavailableMessage(rightPane.lane) ?? "Lane worktree is unavailable.", "error");
                return;
              }
              const action = LANE_DETAIL_ACTIONS[index];
              if (!action) return;
              if (action.intent === "rescue-unstaged") {
                openMoveUnstagedForm();
                return;
              }
              const text = action.slashCommand === "/commit" ? `${action.slashCommand} ` : action.slashCommand;
              setPrompt(text);
              promptRef.current = text;
              chatDraftRef.current = text;
              focusChat();
            },
            zIndex: 3,
          });
        });
        if (rightPane.pr && layout.prRow) {
          addTarget({
            id: "right:lane-pr",
            rect: { x: rightStartColumn, y: rightBodyTop + layout.prRow.start, w: rightPaneWidth, h: layout.prRow.height },
            onClick: () => {
              setRightPane((prev) => prev.kind === "lane-details" ? { ...prev, selectedActionIndex: LANE_DETAIL_PR_ACTION_INDEX } : prev);
              setPrompt("/pr open");
              promptRef.current = "/pr open";
              void submitPrompt("/pr open");
            },
            zIndex: 3,
          });
        }
      } else if (rightPane.kind === "form" && rightPane.command === "feedback") {
        // Feedback pane hit-rects (left-click only): the Type row cycles
        // bug/idea/praise; the send row submits. Rows mirror FeedbackFormPane
        // (Type, blank, Body label + body lines, context block, footer w/ [send]).
        const fb = rightPane.feedback ?? {};
        const bodyLines = Math.max(1, fb.body && fb.body.length ? fb.body.split("\n").length : 1);
        const contextRows = fb.showContext === false ? 1 : 4;
        addTarget({
          id: "right:feedback:type",
          rect: { x: rightStartColumn, y: rightBodyTop, w: rightPaneWidth, h: 1 },
          onClick: () => {
            const meta = rightPane.feedback ?? {};
            const nextType = cycleFeedbackType(feedbackStateFromMeta(meta).type, 1);
            setRightPane({ ...rightPane, feedback: { ...meta, type: nextType } });
            setFormDiscardArmed(false);
            focusDetails();
          },
          zIndex: 3,
        });
        const sendY = rightBodyTop + 2 + bodyLines + 1 + contextRows + 1;
        addTarget({
          id: "right:feedback:send",
          rect: { x: rightStartColumn, y: sendY, w: rightPaneWidth, h: 1 },
          onClick: () => {
            const state = feedbackStateFromMeta(rightPane.feedback ?? {});
            if (!feedbackFormCanSubmit(state)) {
              addNotice("Add some feedback before sending.", "error");
              return;
            }
            void submitRightForm(rightPane, formValues)
              .catch((err) => addNotice(err instanceof Error ? err.message : String(err), "error"));
          },
          zIndex: 3,
        });
      } else if (rightPane.kind === "form") {
        const newLaneOffsets = rightPane.command === "new-lane" ? newLaneFormFieldRowOffsets(rightPane.fields) : null;
        rightPane.fields.forEach((field, index) => {
          const y = rightPane.command === "lane-delete"
            ? rightBodyTop + ([7, 11, 14][index] ?? (3 + index))
            : newLaneOffsets
              ? rightBodyTop + 3 + (newLaneOffsets[index] ?? (3 * index + 1))
              : rightBodyTop + 3 + index;
          // New-lane geometry: the start block spans label + 3 option rows;
          // the create button is a single row; other blocks are label + value.
          const h = rightPane.command === "new-lane"
            ? field.name === "start" ? 4 : field.name === "create" ? 1 : 2
            : rightPane.command === "lane-delete" ? 2 : 1;
          addTarget({
            id: `right:form:${field.name}`,
            rect: {
              x: rightStartColumn,
              y,
              w: rightPaneWidth,
              h,
            },
            onClick: (ev) => {
              setFormFieldIndex(index);
              setFormDiscardArmed(false);
              setFormConfirmArmed(false);
              if (rightPane.command === "lane-delete" && field.name === "scope") {
                const relX = Math.max(0, (ev.x ?? rightStartColumn) - rightStartColumn);
                const scope: LaneDeleteScope = relX < 14 ? "worktree" : relX < 22 ? "local_branch" : "remote_branch";
                setFormValues((prev) => ({ ...prev, scope }));
                setPrompt("");
                return;
              }
              if (rightPane.command === "lane-delete" && field.name === "force") {
                setFormValues((prev) => ({ ...prev, force: prev.force === "yes" ? "no" : "yes" }));
                setPrompt("");
                return;
              }
              if (rightPane.command === "new-lane" && field.name === "start") {
                const relY = Math.max(0, (ev.y ?? y) - y);
                const nextStart = newLaneStartForClickRow(relY);
                if (!nextStart) {
                  setPrompt("");
                  return;
                }
                const activeLaneName = lanes.find((entry) => entry.id === activeLaneIdRef.current)?.name ?? null;
                setFormValues((prev) => ({ ...prev, start: nextStart }));
                setRightPane((previous) => previous.kind === "form" && previous.command === "new-lane"
                  ? { ...previous, fields: newLaneFormFields(nextStart, { activeLaneName }) }
                  : previous);
                setPrompt("");
                return;
              }
              if (rightPane.command === "new-lane" && field.name === "color") {
                setFormValues((prev) => ({ ...prev, color: cycleNewLaneColor(prev.color, 1) }));
                setPrompt("");
                return;
              }
              if (rightPane.command === "new-lane" && field.name === "branchSource") {
                setFormValues((prev) => ({ ...prev, branchSource: toggleNewLaneBranchSource(prev.branchSource) }));
                setPrompt("");
                return;
              }
              if (rightPane.command === "new-lane" && field.name === "create") {
                setPrompt("");
                void submitRightForm(rightPane, formValues)
                  .catch((err) => addNotice(err instanceof Error ? err.message : String(err), "error"));
                return;
              }
              if (field && formFieldUsesPromptInput(rightPane.command, field.name)) {
                setPrompt(formValues[field.name] ?? field.initialValue ?? "");
              } else {
                setPrompt("");
              }
            },
            zIndex: 3,
          });
        });
      } else if (rightPane.kind === "list" && rightPane.action) {
        // Clamp to match RightPane's list rendering so click targets align with
        // the visible rows even after a stale offset.
        const listStart = Math.max(0, Math.min(rightPaneScrollOffsetRows, Math.max(0, rightPane.rows.length - DETAILS_BODY_MAX_LINES)));
        rightPane.rows
          .slice(listStart, listStart + DETAILS_BODY_MAX_LINES)
          .forEach((_, visibleIndex) => {
          const index = listStart + visibleIndex;
          addTarget({
            id: `right:list:${index}`,
            rect: { x: rightStartColumn, y: rightBodyTop + 2 + visibleIndex, w: rightPaneWidth, h: 1 },
            onClick: () => {
              setRightSelectionIndex(index);
              const selectedId = rightPane.action?.ids[index] ?? null;
              if (!selectedId || !rightPane.action) return;
              activateRightPaneListItem(selectedId, rightPane.action.kind);
            },
            zIndex: 3,
          });
        });
      }
    }

    appHitTargetIdsRef.current = targets.map((target) => target.id);
    return () => {
      for (const id of targets.map((target) => target.id)) registry.unregister(id);
    };
  }, [
    addMode,
    addModeRows,
    addNotice,
    addTileToGrid,
    answerPendingInput,
    activateRightPaneListItem,
    activateLaneWithLastChat,
    applyDrawerChatSelection,
    centerWidth,
    chatRowBudget,
    columns,
    commitModelPickerSelection,
    commandPaletteItems,
    commandPaletteVisibleRows,
    commandPaletteWindowStart,
    cycleModel,
    cyclePaneFocus,
    cyclePermission,
    cycleProvider,
    cycleReasoning,
    displaySessions,
    drawerOpen,
    drawerPaneWidth,
    focusChat,
    focusDrawerOnly,
    formValues,
    goalBannerRows,
    handlePromptChange,
    handleSetupRow,
    inlineRowFocus.cell,
    inlineRowFocused,
    insertMention,
    insertSlashCommandRow,
    lanes,
    liveAgentCount,
    mentionSuggestions,
    modelState,
    modelCatalog,
    modelWizardInput,
    modelWizardView,
    pickerMeasuredOrigin,
    modelPickerFavorites,
    modelPickerRecents,
    modelStatusOverlayRows,
    models,
    multiView,
    openModelWizard,
    closeModelWizard,
    rememberModelChoice,
    runInlineCommand,
    selectProvider,
    openMoveUnstagedForm,
    openNewLaneForm,
    openNewChatSetup,
    openSubagentsPane,
    paletteOverlayLeft,
    paletteOverlayTop,
    paletteOverlayWidth,
    pendingApproval,
    promptPaneWidth,
    promptRows.length,
    removeMultiViewTile,
    resumeClosedTerminalSession,
    rightPane,
    rightOpen,
    rightPaneScrollOffsetRows,
    rightPaneVisible,
    rightPaneWidth,
    resolvePendingApproval,
    rows,
    runKeybindingAction,
    runCommandPaletteItem,
    runRightCommand,
    selectActiveLaneId,
    selectActiveSessionId,
    selectFooterControl,
    rightSelectionIndex,
    refreshModelCatalog,
    setFormDiscardArmed,
    setPaneFocus,
    showMentionPalette,
    showCommandPalette,
    showSlashPalette,
    slashRows,
    smartLinkRows,
    startAddMode,
    subagentPaneCommandAvailable,
    terminalControlAvailable,
    terminalControlLabel,
    submitSelectedPendingQuestion,
    submitPrompt,
    tileableDisplaySessions,
    toggleDetailsPane,
    toggleDrawerPane,
    toggleModelPickerFavoriteId,
    toggleSubagentsPane,
  ]);

  // Chat link click-targets, isolated so they re-register as the transcript
  // scrolls/streams (keyed on the visible rows) without rebuilding the entire
  // app hit-target set on every coalesced flush.
  useEffect(() => {
    const registry = hitTestRegistryRef.current;
    for (const id of chatLinkTargetIdsRef.current) registry.unregister(id);
    const ids: string[] = [];
    const chatTopRow = 3 + goalBannerRows + addModeRows;
    const chatStartColumn = drawerPaneWidth + 3;
    visibleChatSelectionRows.forEach((row, index) => {
      if (row.sourceRow == null) return;
      const match = firstUrlInText(row.text);
      if (!match) return;
      const y = chatTopRow + index;
      if (y < chatTopRow || y > chatTopRow + chatRowBudget) return;
      const id = `chat:link:${index}:${match.url}`;
      ids.push(id);
      registry.register({
        id,
        rect: { x: chatStartColumn + match.index, y, w: Math.max(1, match.width), h: 1 },
        onClick: () => {
          if (!openExternalUrl(match.url, addNotice)) {
            addNotice(`Couldn't open ${match.url}.`, "error");
          }
        },
        zIndex: 6,
      });
    });
    chatLinkTargetIdsRef.current = ids;
    return () => {
      for (const id of ids) registry.unregister(id);
    };
  }, [addModeRows, addNotice, chatRowBudget, drawerPaneWidth, goalBannerRows, visibleChatSelectionRows]);

  // The multi-chat grid draws its own bottom border, so it must span the REAL
  // height of the center flex row — chatRowBudget is 2 rows short of it. The
  // fixed chrome around the center area is header (2) + prompt box
  // (promptRows + 2 borders) + footer (1) + ModelStatus (statusRows [+1 when
  // the vim/next-chat extras line shows]), i.e. rows - 5 - promptRows -
  // statusRows in the common case, while chatRowBudget = rows - 7 - promptRows
  // - statusRows (minus banner rows, which both share). The drawer has no
  // explicit height and stretches to the full row, which is why its border
  // reached 2 rows below the grid. Also subtract the transient rows that
  // shrink the center area but are NOT in chatRowBudget, so the grid never
  // overflows and pushes the prompt off-screen.
  const gridRowBudget = Math.max(
    4,
    chatRowBudget
      + 2
      - (draftChatActive || (vimModeEnabled && !hideVimModeIndicator) ? 1 : 0)
      - errorRows
      - (attachedImageChips.length ? 1 : 0)
      - (modeChangeNotice ? 3 : 0),
  );

  // Grid view: size each tiled Claude terminal's PTY to its tile so output reflows
  // to fit (matches the single-view resize). Single-tile fallback (the grid is too
  // small to split) is left to the single-view resize effect.
  useEffect(() => {
    const conn = connection;
    if (!conn || !gridViewActive || !multiView) return;
    const tiles = multiView.tiles.slice(0, 6);
    if (!canRenderMultiChatGrid(tiles.length, chatWrapWidth, gridRowBudget)) return;
    const rects = computeTileRects(asTileCount(tiles.length), chatWrapWidth, gridRowBudget);
    tiles.forEach((tile, index) => {
      if (!terminalSessionsRef.current.some((entry) => entry.terminalId === tile.sessionId)) return;
      const rect = rects[index] ?? rects[0];
      if (!rect) return;
      const cols = clampTerminalPaneCols(Math.max(1, rect.w - 2));
      const rows = claudeTerminalRowsForPane(Math.max(1, rect.h - 3));
      void resizeTerminal(conn, tile.sessionId, cols, rows).catch(() => undefined);
    });
  }, [connection, gridViewActive, multiView, chatWrapWidth, gridRowBudget]);

  // Whether the grid's focused tile is a running provider CLI terminal — drives
  // the footer "^t control (single)" hint so the unavailable-in-grid control is
  // clear (Ctrl+T control needs single view).
  const gridFocusedTileIsTerminal = useMemo(() => {
    if (!gridViewActive || !multiView) return false;
    const focusedId = multiView.tiles[multiView.focusedIndex]?.sessionId ?? null;
    const terminal = focusedId ? terminalSessionById[focusedId] ?? null : null;
    return Boolean(terminal && terminal.status === "running" && terminalSessionProvider(terminal));
  }, [gridViewActive, multiView, terminalSessionById]);

  // Footer mini-map: show tile state when multi-view is open, or just the
  // transient notice when we have something to flash but no grid yet.
  const footerMultiViewMap = useMemo(() => {
    if (multiView) {
      return { count: multiView.tiles.length, focusedIndex: multiView.focusedIndex, notice: multiViewNotice };
    }
    if (multiViewNotice) {
      return { count: 1, focusedIndex: 0, notice: multiViewNotice };
    }
    return null;
  }, [multiView, multiViewNotice]);
  const rightPaneModelPickerInputs = useMemo(() => ({
    models,
    catalog: modelCatalog,
    favorites: modelPickerFavorites,
    recents: modelPickerRecents,
    activeModelId: modelState.modelId,
    activeReasoningEffort: footerReasoningLabel,
    aiStatus,
    interfaceMode: modelState.interfaceMode,
    refreshingProvider: modelCatalogRefreshingProvider,
  }), [
    aiStatus,
    modelCatalog,
    modelCatalogRefreshingProvider,
    modelPickerFavorites,
    modelPickerRecents,
    modelState.interfaceMode,
    modelState.modelId,
    footerReasoningLabel,
    models,
  ]);
  const activeTerminalScroll = readTerminalScroll(terminalScrollBySessionId, activeTerminalSession?.terminalId);
  const activeTerminalLiveChunks = activeTerminalSession
    ? terminalLiveChunks[activeTerminalSession.terminalId] ?? EMPTY_TERMINAL_CHUNKS
    : EMPTY_TERMINAL_CHUNKS;

  if (error && !connection) {
    const remoteLabel = project.remoteLabel?.trim() || "the remote computer";
    // A supervised brain that has not answered yet is not a failure. Mirror the
    // desktop's `brain_starting` recovery copy: say what is happening, promise
    // it opens on its own, and offer nothing to repair.
    if (startupServiceStarting) {
      return (
        <Box flexDirection="column">
          <Text color={theme.color.warning}>ADE's background service is starting</Text>
          <Text>
            This can take a minute the first time or right after an update.
            ADE Code opens as soon as it is ready — there is nothing to do.
          </Text>
          <Text color={theme.color.mutedFg} dimColor>
            Waiting automatically · r retry now · Ctrl+C quit
          </Text>
        </Box>
      );
    }
    return (
      <Box flexDirection="column">
        <Text color="red">
          {remoteLaunch
            ? `ADE Code could not reach ${remoteLabel}`
            : "ADE Code failed to start"}
        </Text>
        <Text>{error}</Text>
        {remoteLaunch ? (
          <Text color={theme.color.mutedFg} dimColor>
            The remote computer may be restarting; every retry re-evaluates its saved connection paths.
          </Text>
        ) : null}
        <Text color={theme.color.mutedFg} dimColor>
          Retrying automatically · r retry now · Ctrl+C quit
        </Text>
        <Text color={theme.color.mutedFg} dimColor>
          Run ade report-issue --open --send in another terminal to send a report to ADE and post it. Personal information is removed.
        </Text>
      </Box>
    );
  }

  return (
    <SpinTickProvider active={spinTickActive}>
      <HitTestProvider registry={hitTestRegistryRef.current} hoveredId={hoveredHitId}>
      <Box flexDirection="column" height={rows}>
        <Header
          projectName={projectName}
          lane={activeLane}
          chatTitle={draftChatActive ? "New chat" : activeTerminalSession?.title ?? activeSession?.title ?? activeSession?.goal ?? activeSession?.summary ?? null}
          remoteLabel={activeRemoteLabel}
          accountLabel={accountLabel}
        />
        {goalBannerText ? (
          <Box paddingX={1} flexShrink={0}>
            <Text color={theme.color.warning} wrap="truncate-end">{goalBannerText}</Text>
            {streaming ? <Text color={theme.color.mutedFg} dimColor>{" · streaming"}</Text> : null}
          </Box>
        ) : null}
        {addMode ? <AddChatModeBanner /> : null}
        <Box flexDirection="row" flexGrow={1} minHeight={8}>
          {drawerOpen ? (
            <WorkSessionsPane
              model={workListModel}
              layout={workListLayoutValue}
              selectedKey={workSelectedRowKey}
              panelHeight={sessionsPaneHeight}
              width={drawerPaneWidth}
              focused={activePane === "drawer" || activePane === "addMode"}
              pickerMode={Boolean(addMode)}
              loading={mode === "connecting" || lanes.length === 0}
              scrollOffsetRows={drawerScrollOffsetRows}
              pluginLaneBadges={pluginLaneBadges}
              pluginChatBadges={pluginChatBadges}
            />
          ) : null}
          <Box width={centerWidth} height={sessionsPaneHeight} flexDirection="column" flexGrow={1}>
            <Box flexGrow={1} flexShrink={1} minHeight={0} flexDirection="column" overflow="hidden">
            {pendingApproval?.highStakes ? (
              <ApprovalPrompt approval={pendingApproval} modal questionState={pendingQuestionState} draft={prompt} />
            ) : (gridViewActive && multiView) ? (
              <MultiChatGrid
                tiles={multiView.tiles}
                focusedIndex={multiView.focusedIndex}
                width={chatWrapWidth}
                height={gridRowBudget}
                baseX={drawerPaneWidth + 1}
                baseY={3 + goalBannerRows + addModeRows}
                projectName={projectName}
                provider={modelState.provider}
                modelDisplay={modelState.displayName}
                lanesById={lanesById}
                sessionBySessionId={sessionBySessionId}
                eventsBySessionId={eventsBySessionId}
                notices={notices}
                streamingBySessionId={streamingBySessionId}
                interruptedBySessionId={interruptedBySessionId}
                scrollBySessionId={scrollBySessionId}
                selectionBySessionId={selectionBySessionId}
                expandedLineIds={expandedLineIds}
                terminalSessionById={terminalSessionById}
                terminalPreviewById={terminalPreviewById}
                terminalLiveChunksById={terminalLiveChunks}
                terminalScrollBySessionId={terminalScrollBySessionId}
                attachedTerminalId={attachedTerminalId}
                onFocusTile={focusMultiViewTile}
                onRemoveTile={removeMultiViewTile}
              />
            ) : externalSessionPreviewTarget ? (
              // /import: the highlighted row previews here before Enter commits.
              <ExternalSessionPreview
                session={externalSessionPreviewTarget}
                width={chatWrapWidth}
                maxRows={chatRowBudget}
              />
            ) : activeTerminalSession ? (
              <TerminalPane
                title={activeTerminalSession.title}
                terminalId={activeTerminalSession.terminalId}
                cliLabel={terminalControlLabel}
                claudeChrome={activeTerminalProvider === "claude"}
                preview={terminalPreview}
                liveChunks={activeTerminalLiveChunks}
                attached={attachedTerminalId === activeTerminalSession.terminalId}
                width={terminalPaneWidth}
                height={chatRowBudget}
                namingHint={activeTerminalProvider === "claude"
                  && activeTerminalSession.status === "running"
                  && isClaudePlaceholderTitle(activeTerminalSession.title)}
                hiddenBottomRows={CLAUDE_TERMINAL_HIDDEN_INPUT_ROWS}
                scrollOffset={activeTerminalScroll.scrollOffset}
                pendingNewCount={activeTerminalScroll.pendingNewCount}
                onViewportMetrics={handleTerminalViewportMetrics}
              />
            ) : (
              <>
                <ChatView
                  events={displayEvents}
                  notices={displayNotices}
                  blocks={displayBlocks}
                  activeSession={activeSession}
                  projectName={projectName}
                  laneName={laneName}
                  lane={activeLane}
                  provider={modelState.provider}
                  modelDisplay={modelState.displayName}
                  streaming={displayStreaming}
                  interrupted={displayInterrupted}
                  worktreeAvailable={!activeLane || !unavailableLaneIds.has(activeLane.id)}
                  expandedLineIds={expandedLineIds}
                  maxRows={chatRowBudget}
                  scrollOffsetRows={effectiveChatScrollOffsetRows}
                  unseenMessageCount={unseenMessageCount}
                  olderHistory={!selectedAgentSnapshot && activeSessionId
                    ? olderHistoryStatusBySessionId[activeSessionId] ?? null
                    : null}
                  selection={chatMouseSelection}
                  width={chatWrapWidth}
                />
                <ApprovalPrompt approval={pendingApproval} questionState={pendingQuestionState} width={centerWidth} draft={prompt} />
              </>
            )}
            </Box>
        {error ? (
          <Box paddingX={1} flexShrink={0} flexDirection="column">
            <Text color="red">{error}</Text>
            {!connection ? <Text color={theme.color.mutedFg} dimColor>{"r retry now · Ctrl+C quit"}</Text> : null}
          </Box>
        ) : null}
        {attachedImageChips.length ? (
          <Box paddingX={1} flexShrink={0} flexDirection="row" flexWrap="wrap">
            {attachedImageChips.map((chip, index) => {
              const selected = attachmentFocusIndex === index;
              return (
              <Box key={chip.key} marginRight={1}>
                <Text color={selected ? theme.color.violet : theme.color.accent}>{selected ? "▣ " : "▢ "}</Text>
                <Text inverse={selected}>{chip.label}</Text>
                {chip.dimensions ? <Text color={theme.color.mutedFg} dimColor={!selected}>{` ${chip.dimensions}`}</Text> : null}
              </Box>
              );
            })}
            {attachmentFocusIndex != null ? <Text color={theme.color.mutedFg} dimColor>{" backspace/delete removes"}</Text> : null}
          </Box>
        ) : null}
        {modeChangeNotice ? (
          <Box paddingX={1} borderStyle="single" borderColor={modeAccentColor(modeChangeNotice.summary)} flexShrink={0}>
            <Text color={modeAccentColor(modeChangeNotice.summary)} bold>{modeChangeNotice.summary} mode</Text>
            <Text color={theme.color.t3}>{` · ${modeDescription(modeChangeNotice.summary)}`}</Text>
          </Box>
        ) : null}
        {backgroundLaunchStatusText ? (
          <Box paddingX={1} flexShrink={0}>
            <Text
              color={backgroundLaunchStatus?.status === "failed" ? theme.color.error : theme.color.accent}
              wrap="truncate-end"
            >
              {backgroundLaunchStatusText}
            </Text>
          </Box>
        ) : null}
        <Box
          borderStyle="round"
          borderColor={isPlanMode(modelState) ? theme.color.planMode : (promptFocused ? PURPLE : theme.color.border)}
          paddingX={1}
          flexShrink={0}
          flexDirection="column"
          width={promptPaneWidth}
        >
          {promptSmartLinks.length > 0 ? (
            <Text color={PURPLE} bold wrap="truncate-end">
              {formatPromptSmartLinkStrip(promptSmartLinks)}
            </Text>
          ) : null}
          {/* A plugin action's question, drawn as the field's own label rather
              than as a screen of its own: the reader stays where they pressed
              the button, and the words are the plugin's. */}
          {pluginPrompt ? (
            <Text wrap="truncate-end">
              <Text color={PURPLE} bold>{pluginPromptTitle(pluginPrompt.request)}</Text>
              <Text color={theme.color.mutedFg} dimColor>{`  ${pluginPromptHint(pluginPrompt.request)}`}</Text>
            </Text>
          ) : null}
          {promptRows.map((line, index) => {
            const cursorColumn = promptFocused ? line.cursorColumn : null;
            const hasCursor = cursorColumn != null;
            const cursorParts = hasCursor ? splitByDisplayCells(line.text, cursorColumn, cursorColumn + 1) : null;
            const beforeCursor = cursorParts?.before ?? line.text;
            const cursorText = cursorParts ? (cursorParts.selected || " ") : "";
            const afterCursor = cursorParts?.after ?? "";
            const renderSegments = (text: string, rowStart: number, keyPrefix: string) =>
              segmentPromptLineText(text, rowStart, promptTokenRanges).map((segment, segmentIndex) => (
                <Text
                  key={`${keyPrefix}${segmentIndex}`}
                  color={segment.kind === "plain"
                    ? undefined
                    : segment.kind === "image"
                      ? theme.color.done
                      : segment.kind === "command" || segment.kind === "link"
                        ? PURPLE
                        : "cyan"}
                  bold={segment.kind !== "plain"}
                >
                  {segment.text}
                </Text>
              ));
            return (
              <Box key={`${index}:${line.text}:${line.start}:${line.end}`} flexDirection="row">
                <Text color={PURPLE}>{index === 0 ? "› " : "  "}</Text>
                {hasCursor ? (
                  <>
                    {renderSegments(beforeCursor, line.start, "b")}
                    <Text inverse>{cursorText}</Text>
                    {renderSegments(afterCursor, line.start + beforeCursor.length + cursorText.length, "a")}
                  </>
                ) : (
                  renderSegments(line.text, line.start, "t")
                )}
                {/* The plugin's placeholder replaces the client's own hint
                    while its question is open: an empty field belongs to the
                    question, and "^V paste image" is not an answer to it. */}
                {index === 0 && !prompt && pluginPrompt
                  ? <Text color={theme.color.mutedFg} dimColor>{pluginPromptPlaceholder(pluginPrompt.request)}</Text>
                  : index === 0 && !prompt
                    ? <Text color={theme.color.mutedFg} dimColor>{"  ^V paste image"}</Text>
                    : null}
                {index === 0 && promptCursorOnImageToken && promptRowHintFits(line.text, promptPaneWidth)
                  ? <Text color={theme.color.mutedFg} dimColor>{"  ^B open image"}</Text>
                  : null}
              </Box>
            );
          })}
        </Box>
        <ModelStatus
          draftChatActive={draftChatActive}
          provider={modelState.provider}
          modelDisplay={modelState.displayName}
          reasoningEffort={footerReasoningLabel}
          permissionLabel={permissionSummary(modelState)}
          interfaceMode={modelState.interfaceMode}
          fastMode={footerFastSupported && modelState.fastMode}
          statusLineText={statusLineText}
          vimMode={vimModeEnabled && !hideVimModeIndicator ? vimMode : null}
        />
        <FooterControls
          provider={modelState.provider}
          modelDisplay={modelState.displayName}
          reasoningEffort={footerReasoningLabel}
          permissionLabel={permissionSummary(modelState)}
          permissionDetail={modelState.provider === "codex" ? codexApprovalSandboxLabel(modelState) : null}
          contextPercent={contextPercent}
          tokenSummary={tokenSummary}
          approvalActive={pendingApproval?.mode === "approval" && !pendingApproval.highStakes}
          liveAgentCount={liveAgentCount}
          fastMode={modelState.fastMode}
          fastSupported={footerFastSupported}
          inlineRowFocused={inlineRowFocused}
          inlineRowCell={inlineRowFocus.cell}
          providerLocked={providerLocked}
          subagentsButtonVisible={subagentPaneCommandAvailable}
          planMode={isPlanMode(modelState)}
          terminalControlAvailable={terminalControlAvailable}
          terminalControlActive={terminalControlActive}
          terminalControlLabel={terminalControlLabel}
          gridTerminalControlHint={gridFocusedTileIsTerminal}
          multiViewActive={Boolean(multiView)}
          multiViewMap={footerMultiViewMap}
          workPaneFocused={drawerOpen && (activePane === "drawer" || activePane === "addMode")}
        />
          </Box>
          {rightPaneVisible ? (
            <RightPane
              content={rightPane}
              formValues={formValues}
              formConfirmArmed={formConfirmArmed}
              activeFormField={formFieldIndex}
              selectedIndex={rightSelectionIndex}
              focused={activePane === "details"}
              activeProvider={activeCommandProvider as AdeCodeProvider}
              width={rightPaneWidth}
              height={sessionsPaneHeight}
              scrollOffsetRows={rightPaneScrollOffsetRows}
              subagentPaneViewState={chatInfoRosterViewState}
              pluginEditingValue={rightPane.kind === "plugin-panel" && rightPane.state.editing != null ? prompt : null}
              modelPickerInputs={rightPaneModelPickerInputs}
              modelWizardView={modelWizardView}
              onModelPickerMeasureOrigin={handlePickerMeasureOrigin}
            />
          ) : null}
        </Box>
        {showCommandPalette ? (
          <Box position="absolute" marginTop={paletteOverlayTop} marginLeft={paletteOverlayLeft}>
            <CommandPalette
              query={commandPaletteQuery}
              items={commandPaletteItems}
              selectedIndex={commandPaletteIndex}
              width={paletteOverlayWidth}
            />
          </Box>
        ) : null}
        {!showCommandPalette && showMentionPalette ? (
          <Box position="absolute" marginTop={paletteOverlayTop} marginLeft={paletteOverlayLeft}>
            <MentionPalette
              suggestions={mentionSuggestions}
              selectedIndex={mentionIndex}
              query={activeMentionRange?.query ?? ""}
              width={paletteOverlayWidth}
            />
          </Box>
        ) : null}
        {!showCommandPalette && !showMentionPalette && showSlashPalette ? (
          <Box position="absolute" marginTop={paletteOverlayTop} marginLeft={paletteOverlayLeft}>
            <SlashPalette
              query={slashComposerTrigger ? `/${slashComposerTrigger.query}` : prompt}
              userCommands={slashCommands}
              selectedIndex={slashIndex}
              provider={activeCommandProvider}
              width={paletteOverlayWidth}
              maxRows={slashPaletteHeightBudget}
              installedPlugins={pluginInstallRecords}
            />
          </Box>
        ) : null}
      </Box>
      </HitTestProvider>
    </SpinTickProvider>
  );
}
