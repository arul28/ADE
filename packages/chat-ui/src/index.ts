/**
 * `@ade-dev/chat-ui` — embeddable React chat components over `@ade-dev/sdk`.
 *
 * Every component is importable on its own; `<AdeChat>` is one opinionated
 * assembly of them, not a required entry point.
 */

export { AdeChat, type AdeChatProps, type AdeChatSendResult } from "./AdeChat";

export { Composer, mergeAttachments, type ComposerProps } from "./composer/Composer";
export { QueueStrip, type QueueStripProps } from "./composer/QueueStrip";
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
  DEFAULT_APPROVAL_WAITING_LABEL,
  type TranscriptProps,
} from "./transcript/Transcript";
export { ToolChip, type ToolChipAction, type ToolChipProps } from "./transcript/ToolChip";
export { PendingInputCard, type PendingInputCardProps, type PendingInputRespond } from "./transcript/PendingInputCard";
export {
  ApprovalCard,
  approvalRequestFromRow,
  readApprovalCommand,
  readApprovalPaths,
  NO_APPROVE_NOTICE,
  UNANSWERABLE_NOTICE,
  type ApprovalCardProps,
  type ApprovalLabels,
  type ApprovalRespond,
  type ApprovalUiOptions,
} from "./transcript/ApprovalCard";
export {
  buildTranscriptRows,
  collapseTranscriptEvents,
  groupTranscriptRows,
  mergeStreamingText,
  shouldMergeTextRows,
  formatStructuredValue,
  eventHasPayload,
  resolveToolName,
  TranscriptRowBuilder,
  type ApprovalRow,
  type ApprovalRowState,
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
export {
  AdeLink,
  AdeLinkHandlerProvider,
  type AdeLinkClickHandler,
  type AdeLinkClickInfo,
  type AdeLinkSource,
} from "./transcript/links";

export { ModelPicker, type ModelPickerProps } from "./models/ModelPicker";
export {
  ProviderCard,
  ProviderCards,
  resolveStateCopy,
  truncateBinaryPath,
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
export { parseToolIdentity, type ToolIdentity } from "./activity/toolIdentity";

export {
  adaptSdkClient,
  attachmentKind,
  inferAttachmentType,
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
  type SdkProviderStatusRecord,
} from "./adapters/sdkClient";

export {
  AdeChatProvider,
  useAdeChatClient,
  useAdeChatContext,
  useAdeProviders,
  useAdeThread,
  DEFAULT_HISTORY_PAGE_SIZE,
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
export { AdeChatStyles, type AdeChatStylesProps } from "./theme/AdeChatStyles";
export { adeChatCss, injectAdeChatStyles, type InjectAdeChatStylesOptions } from "./theme/styles";
export { UsageLimitNotice, type UsageLimitNoticeProps } from "./UsageLimitNotice";
export { AccountList, type AccountListProps } from "./accounts/AccountList";
export { AccountSwitcher, type AccountSwitcherProps } from "./accounts/AccountSwitcher";
export { ApiKeyForm, type ApiKeyFormProps } from "./accounts/ApiKeyForm";
export { SignInCard, type SignInCardProps } from "./accounts/SignInCard";
export { UsageMeter, type UsageMeterProps } from "./accounts/UsageMeter";

export type {
  AdeChatClient,
  AdeChatClientEventMap,
  AdeThread,
  AgentChatEvent,
  AgentChatEventEnvelope,
  AgentChatResourceLink,
  AccountInfo,
  AccountManagement,
  AccountUsage,
  AccountUsageWindow,
  ApiCredentialInfo,
  ApprovalDecision,
  ApprovalKind,
  ApprovalRequest,
  ChatAttachment,
  CredentialManagement,
  ChatEventMcpSource,
  HistoryPageOptions,
  ModelDescriptor,
  ProviderId,
  ProviderCapabilities,
  ProviderStatus,
  QueuedMessage,
  PendingInputOption,
  PendingInputDecision,
  PendingInputResponse,
  PendingInputQuestion,
  SignInHandle,
  SignInUpdate,
  SlashCommand,
  SendInput,
  ThreadHistoryPage,
  ThreadModelSelection,
  ThreadOpenOptions,
  ThreadStatus,
  ThreadUpdatePatch,
  ThreadUpdateReply,
  ThreadUsage,
  ToolCallStatus,
  ThreadQueue,
  UsageLimitEvent,
  UsageLimitStatus,
  Unsubscribe,
} from "./sdkTypes";
