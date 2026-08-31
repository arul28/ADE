/**
 * `@ade-dev/chat-ui` — embeddable React chat components over `@ade-dev/sdk`.
 *
 * Every component is importable on its own; `<AdeChat>` is one opinionated
 * assembly of them, not a required entry point.
 */

export { AdeChat, type AdeChatProps } from "./AdeChat";

export { Composer, type ComposerProps } from "./composer/Composer";
export {
  resolveComposerAction,
  resolveComposerState,
  resolveKeyIntent,
  blockedHint,
  type ComposerAction,
  type ComposerBlockReason,
  type ComposerState,
  type ComposerStateInput,
  type KeyIntent,
} from "./composer/composerState";

export {
  Transcript,
  ActivityIndicator,
  usePrefersReducedMotion,
  type TranscriptProps,
} from "./transcript/Transcript";
export { ToolChip, type ToolChipProps } from "./transcript/ToolChip";
export {
  buildTranscriptRows,
  collapseTranscriptEvents,
  groupTranscriptRows,
  mergeStreamingText,
  shouldMergeTextRows,
  formatStructuredValue,
  eventHasPayload,
  resolveToolName,
  type ToolChipRow,
  type TranscriptRow,
  type TranscriptRowEvent,
} from "./transcript/transcriptRows";
export {
  renderMarkdown,
  parseMarkdownBlocks,
  parseInline,
  safeHref,
} from "./transcript/markdown";

export { ModelPicker, type ModelPickerProps } from "./models/ModelPicker";
export {
  ProviderCard,
  ProviderCards,
  type ProviderCardProps,
  type ProviderCardsProps,
} from "./models/ProviderCard";
export {
  groupModelsByProvider,
  isModelSelectable,
  isProviderUsable,
  scoreModelSearch,
  type ProviderModelGroup,
  type SearchableModel,
} from "./models/modelSearch";

export {
  describeToolActivity,
  formatElapsed,
  matchLabelKey,
  phaseForToolStatus,
  resolveActivityIcon,
  resolveActivityLabel,
  DEFAULT_ELAPSED_AFTER_MS,
  DEFAULT_THINKING_LABEL,
  type ActivityLabelConfig,
  type ActivityLabelEntry,
  type ActivityLabelSource,
  type ActivityPhase,
} from "./activity/labels";

export {
  adaptSdkClient,
  modelDescriptorsFromSdk,
  providerStatusesFromSdk,
  threadStatusFromEnvelope,
  threadUsageFromEnvelope,
  type AdaptSdkClientOptions,
  type ProviderCommandHints,
  type SdkFileRef,
  type SdkLikeChatClient,
  type SdkLikeThread,
  type SdkModelCatalogEntry,
  type SdkProviderStatus,
} from "./adapters/sdkClient";

export {
  AdeChatProvider,
  useAdeChatClient,
  useAdeChatContext,
  useAdeProviders,
  useAdeThread,
  type AdeChatContextValue,
  type AdeChatProviderProps,
  type ProvidersState,
  type ThreadState,
} from "./context/AdeChatContext";

export {
  createTheme,
  defaultTheme,
  themeToCss,
  ADE_CHAT_TOKENS,
  type AdeChatTheme,
  type AdeChatToken,
  type CreateThemeInput,
} from "./theme/createTheme";
export { AdeChatStyles } from "./theme/AdeChatStyles";
export { adeChatCss, injectAdeChatStyles } from "./theme/styles";

export type {
  AdeChatClient,
  AdeThread,
  AgentChatEvent,
  AgentChatEventEnvelope,
  ChatAttachment,
  ModelDescriptor,
  ProviderId,
  ProviderStatus,
  SendInput,
  ThreadOpenOptions,
  ThreadStatus,
  ThreadUsage,
  ToolCallStatus,
  Unsubscribe,
} from "./sdkTypes";
