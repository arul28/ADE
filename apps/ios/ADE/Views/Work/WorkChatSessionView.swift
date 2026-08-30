import SwiftUI
import UIKit
import AVKit

let workChatScrollCoordinateSpace = "WorkChatScrollCoordinateSpace"
let workChatStickThreshold: CGFloat = 160
let workChatStickResumeThreshold: CGFloat = 48
let workChatTouchScrollDeadband: CGFloat = 2
/// How far a drag has to travel before it counts as the reader taking over from
/// the initial bottom pin.
///
/// Deliberately larger than `workChatTouchScrollDeadband`: 2pt is the right
/// sensitivity for releasing bottom-stickiness during a streaming turn (a nudge
/// upward means "stop following"), but it is well inside the finger jitter of a
/// tap on a freshly-opened chat, and cancelling the pin there is what left
/// transcripts parked at a random offset while hydration was still growing the
/// content underneath.
let workChatBottomAnchorSpacerHeight: CGFloat = 1
let workChatContentBottomGutterHeight: CGFloat = 2
let workChatSubagentActivePopupHeight: CGFloat = 34
/// The composer chip strip. Its capsules declare `minHeight: 44` for the touch
/// target, so the row that holds them has to be 44 too — pinning it to 34 was
/// what squeezed the PR chip's label into an ellipsis.
let workChatComposerChipRowHeight: CGFloat = 44
let workChatOlderHistoryTriggerDistance: CGFloat = 240
let workChatOlderHistoryRearmDistance: CGFloat = 420
let workChatOlderHistoryScrollableDistance: CGFloat = 1
/// How long the transcript's content size has to stay unchanged before the
/// opening bottom pin is considered settled.
let workChatInitialPinQuiescenceMilliseconds = 600

struct WorkChatOlderHistoryLoadResult {
  let succeeded: Bool
  let hasMoreHistory: Bool
  let addedTimelineEntries: Bool

  static let failed = WorkChatOlderHistoryLoadResult(
    succeeded: false,
    hasMoreHistory: false,
    addedTimelineEntries: false
  )

  static func loaded(hasMoreHistory: Bool, addedTimelineEntries: Bool) -> Self {
    WorkChatOlderHistoryLoadResult(
      succeeded: true,
      hasMoreHistory: hasMoreHistory,
      addedTimelineEntries: addedTimelineEntries
    )
  }
}

/// Why the chat timeline is empty. `timeline.isEmpty` alone cannot tell a
/// genuinely empty chat from one whose transcript request is still in flight
/// or was dropped, and rendering "No chat messages yet" for the latter two is
/// a false negative the user cannot distinguish from data loss.
enum WorkChatTranscriptLoadState: Equatable {
  case idle
  case loading
  case failed(String)
}

/// Copy for a failed transcript load. A transport error can arrive empty or as
/// whitespace; falling back keeps the failure state from reading like a blank
/// card, which is the exact ambiguity this state exists to remove.
func workChatTranscriptFailureMessage(_ message: String) -> String {
  let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !trimmed.isEmpty else {
    return "The machine didn’t answer the transcript request."
  }
  return trimmed
}

/// `distanceFromTop` is how far the reader has scrolled from the first row, so
/// it grows downward — the inverse of the geometry-probe `topY` this used to
/// take, which was published from a per-frame `GeometryReader` riding the
/// header row.
///
/// `hasError` scopes to the host page that failed, not to scroll-back as a
/// whole. Buffered entries are already on the phone and cost no network, so a
/// dropped history page must not strand the reader on top of history they
/// already have — that combination is what turned one timed-out page into a
/// transcript that would not scroll again.
func workChatShouldRequestOlderHistory(
  distanceFromTop: CGFloat,
  triggerArmed: Bool,
  loading: Bool,
  hasError: Bool,
  hasBufferedEntries: Bool,
  hasHostHistory: Bool
) -> Bool {
  guard distanceFromTop <= workChatOlderHistoryTriggerDistance,
        triggerArmed,
        !loading
  else { return false }
  if hasBufferedEntries { return true }
  return !hasError && hasHostHistory
}

/// Keeps pulling while the transcript is still too short to scroll.
///
/// The buffered-entry bypass matters more here than at the scroll trigger: a
/// transcript that fits the viewport cannot be scrolled, so the reader has no
/// way to re-arm anything. Letting a failed host page block the local reveal
/// there leaves buffered history unreachable by any gesture at all.
func workChatShouldContinueAutomaticOlderHistory(
  distanceFromBottom: CGFloat,
  contentFitsViewport: Bool,
  loading: Bool,
  hasError: Bool,
  hasBufferedEntries: Bool,
  hasHostHistory: Bool
) -> Bool {
  guard contentFitsViewport,
        distanceFromBottom <= workChatOlderHistoryScrollableDistance,
        !loading
  else { return false }
  if hasBufferedEntries { return true }
  return !hasError && hasHostHistory
}

/// The prepend probe is only useful while the reader is close enough to the
/// head for a history page to land. Keeping it installed on the first row for
/// the whole transcript makes every ordinary scroll participate in SwiftUI's
/// preference graph, even though there is no correction to perform.
func workChatShouldInstallPrependProbe(
  distanceFromTop: CGFloat,
  hasPrependAnchor: Bool
) -> Bool {
  hasPrependAnchor || distanceFromTop <= workChatOlderHistoryTriggerDistance
}

/// Scroll state a prepend has to preserve: which row led the list, where that
/// row sat, and where the reader was, at the instant rows were inserted above.
///
/// Deliberately *not* total content height. An assistant reply streaming into
/// the tail grows the content too, and a reader scrolled back through history is
/// exactly when that happens — restoring by total growth would add the tail's
/// growth to the correction and overshoot.
struct WorkChatPrependAnchor {
  let rowId: String
  let rowY: CGFloat
  /// The reader's offset when the prepend was armed. Not what the correction is
  /// applied to — it is how the reader's own scrolling is separated from the
  /// insertion, since the probed row moves by both.
  let offsetY: CGFloat
  /// Layout passes to wait for before giving up, so an abandoned prepend cannot
  /// leave the anchor armed to fire on an unrelated later change.
  var remainingAttempts: Int
}

/// Reference box so scroll geometry can be recorded per frame without
/// invalidating the view. `distanceFromBottom` predates the prepend anchor and
/// keeps its existing meaning.
final class WorkChatScrollMetrics {
  var distanceFromBottom: CGFloat = 0
  var distanceFromTop: CGFloat = 0
  var offsetY: CGFloat = 0
  var scrollableHeight: CGFloat = 0
  /// Position of the row currently being probed (the list's first row, or the
  /// armed row while a prepend is in flight), in the scroll coordinate space.
  var probeRowId: String?
  var probeRowY: CGFloat?
  var prependAnchor: WorkChatPrependAnchor?
}

/// The scroll geometry the transcript reacts to, rounded so sub-pixel jitter
/// doesn't wake the observer.
///
/// Everything the transcript needs about its position is derived here, from the
/// one sample the scroll view already produces. The content-top and
/// content-bottom `GeometryReader` + `PreferenceKey` probes this replaced
/// measured the same two numbers by laying out two extra views and running the
/// preference reduce/observe machinery on every frame of every scroll.
struct WorkChatScrollGeometrySample: Equatable {
  let offsetY: CGFloat
  /// Largest in-range content offset, used only to clamp a restore.
  let scrollableHeight: CGFloat
  /// Distance scrolled past the first row. 0 at the very top.
  let distanceFromTop: CGFloat
  /// Distance still to scroll to reach the last row. 0 at the very bottom.
  let distanceFromBottom: CGFloat
  let containerHeight: CGFloat

  init(_ geometry: ScrollGeometry) {
    self.offsetY = (geometry.contentOffset.y * 2).rounded() / 2
    let scrollable = geometry.contentSize.height - geometry.containerSize.height
      + geometry.contentInsets.top + geometry.contentInsets.bottom
    self.scrollableHeight = max(0, (scrollable * 2).rounded() / 2)
    // Content insets shift `contentOffset` so that resting at the top reads as
    // `-contentInsets.top`; adding it back puts both distances on the same
    // inset-free 0…scrollableHeight range.
    let position = geometry.contentOffset.y + geometry.contentInsets.top
    self.distanceFromTop = max(0, (position * 2).rounded() / 2)
    self.distanceFromBottom = max(0, self.scrollableHeight - self.distanceFromTop)
    self.containerHeight = geometry.containerSize.height
  }
}

/// The transcript's content size, sampled separately from the per-frame scroll
/// position so layout-driven work (the opening pin, the short-transcript
/// alignment) runs on content changes instead of on every scroll frame.
struct WorkChatContentSizeSample: Equatable {
  let contentHeight: CGFloat
  let scrollableHeight: CGFloat

  var contentFitsViewport: Bool { scrollableHeight <= 0.5 }

  init(_ geometry: ScrollGeometry) {
    self.contentHeight = (geometry.contentSize.height * 2).rounded() / 2
    let scrollable = geometry.contentSize.height - geometry.containerSize.height
      + geometry.contentInsets.top + geometry.contentInsets.bottom
    self.scrollableHeight = max(0, (scrollable * 2).rounded() / 2)
  }
}

/// Number of layout passes a prepend anchor stays armed for.
let workChatPrependAnchorAttempts = 12

/// What a presentation change does to the prepend anchor.
enum WorkChatPrependArmDecision: Equatable {
  case ignore
  /// A second prepend landed while the first was still being corrected.
  case extendExistingAnchorWindow
  /// The anchored row is gone; nothing left to measure against.
  case retireAnchor
  case arm(rowId: String, rowY: CGFloat)
}

/// Decides how a presentation change affects the prepend anchor.
///
/// The overlapping-prepend case is the subtle one. The armed anchor rides a row
/// that BOTH insertions pushed down, so the displacement measured on it already
/// accumulates them. Re-arming on the new first row would measure only the
/// second insertion and leave the first uncorrected — the "teleport up" that
/// back-to-back page loads produced.
func workChatPrependArmDecision(
  previousFirstId: String?,
  nextFirstId: String?,
  previousVisibleCount: Int,
  nextVisibleCount: Int,
  existingAnchorRowId: String?,
  anchorRowStillVisible: Bool,
  previousFirstRowStillVisible: Bool,
  probeRowId: String?,
  probeRowY: CGFloat?
) -> WorkChatPrependArmDecision {
  guard nextVisibleCount > previousVisibleCount,
        let previousFirstId,
        nextFirstId != previousFirstId
  else { return .ignore }

  if existingAnchorRowId != nil {
    return anchorRowStillVisible ? .extendExistingAnchorWindow : .retireAnchor
  }

  guard
    // The probe has to already be measuring the row we are about to anchor on,
    // or there is no "before" position to restore to.
    probeRowId == previousFirstId,
    let probeRowY,
    // Only a genuine prepend: the row that used to lead the list has to still
    // be in the list, just further down.
    previousFirstRowStillVisible
  else { return .ignore }

  return .arm(rowId: previousFirstId, rowY: probeRowY)
}

/// What an armed anchor may do on this layout pass.
enum WorkChatPrependCorrection: Equatable {
  /// The reader owns the offset. Stay armed and spend no attempt.
  case wait
  /// No usable measurement yet. Spend an attempt.
  case retry
  /// Undo this much inserted height.
  case apply(CGFloat)
}

/// Turns a probe sample into a correction.
///
/// The two `retry` cases are what keeps a correction honest. A probe describing
/// some OTHER row carries no information about the anchored row, and treating a
/// mismatch as a zero row shift reduces the correction to the reader's own
/// scroll delta and applies it a second time — a teleport, not a correction.
func workChatPrependCorrection(
  anchor: WorkChatPrependAnchor,
  probed: WorkChatPrependProbeSample?,
  currentOffsetY: CGFloat,
  mayWriteScrollOffset: Bool
) -> WorkChatPrependCorrection {
  // A correction is a scroll write, so it waits for the reader to let go. The
  // anchor stays armed and spends no attempt meanwhile: the measurement below
  // isolates the insertion from the reader's own scrolling, so applying it once
  // the fling settles restores the same reading position it would have restored
  // mid-fling — without fighting the fling for the offset.
  guard mayWriteScrollOffset else { return .wait }
  guard let probed, probed.rowId == anchor.rowId else { return .retry }

  // The anchored row moves by the height inserted above it *minus* whatever the
  // reader scrolled in the meantime, because scrolling moves the row up the
  // screen too. Adding the offset change back isolates the insertion: with an
  // inserted height H and a user scroll D, the row moves H - D and the offset
  // moves D, so the sum is H either way — and a pure scroll with no prepend
  // sums to zero and correctly restores nothing.
  let insertedHeight = (probed.y - anchor.rowY) + (currentOffsetY - anchor.offsetY)
  guard insertedHeight > 0.5 else { return .retry }
  return .apply(insertedHeight)
}

/// Whether a scroll phase means the reader — not the app — owns the offset.
///
/// `.animating` is deliberately not user-driven: it is the phase our own
/// `scrollTo` animations run in, and treating it as the reader's would let one
/// programmatic scroll suppress the next one.
func workChatScrollPhaseIsUserDriven(_ phase: ScrollPhase) -> Bool {
  switch phase {
  case .tracking, .interacting, .decelerating:
    return true
  default:
    return false
  }
}

/// Whether the transcript may write the scroll offset right now.
///
/// Every programmatic scroll — bottom-follow pins, the initial pin, the prepend
/// correction — goes through this. Writing an offset while the reader's finger
/// is down or a fling is still decelerating kills the fling and lands the
/// content somewhere neither the app nor the reader chose.
func workChatMayWriteScrollOffset(dragActive: Bool, scrollPhaseUserDriven: Bool) -> Bool {
  !dragActive && !scrollPhaseUserDriven
}

/// Where the transcript's content sits inside a viewport it does not fill.
///
/// Only meaningful while the content is shorter than the viewport: past that the
/// content frame is sized by the content and the alignment is inert.
func workChatTranscriptContentAlignment(contentFitsViewport: Bool) -> Alignment {
  contentFitsViewport ? .topLeading : .bottomLeading
}

/// Position of the single probed row, published from the row itself so a
/// prepend's displacement can be measured without a geometry reader per row.
///
/// Carries the row id rather than letting the reader infer it: which row holds
/// the probe is decided during body evaluation, and the observer reading it back
/// runs later, so a recomputed id can describe a different row than the
/// measurement it is paired with.
struct WorkChatPrependProbeSample: Equatable {
  let rowId: String
  let y: CGFloat
}

struct WorkChatPrependProbePreferenceKey: PreferenceKey {
  static var defaultValue: WorkChatPrependProbeSample? { nil }

  static func reduce(value: inout WorkChatPrependProbeSample?, nextValue: () -> WorkChatPrependProbeSample?) {
    value = nextValue() ?? value
  }
}

struct WorkChatSummaryRenderContext: Equatable {
  let isAvailable: Bool
  let provider: String
  let model: String
  let modelId: String?
  let reasoningEffort: String
  let effectiveFastMode: Bool
  let runtimeMode: String
  let fastModeSupported: Bool
  let idleSinceAt: String?
  let endedAt: String?
  let lastOutputPreview: String?
  let requestedCwd: String?
  let modelLabel: String
  let contextWindowFallback: Int?
  let claudeGoal: AgentChatClaudeGoal?
  let spawnKind: AgentChatSpawnKind?
  let orchestrationParentSessionId: String?
  let subagentTakeoverPromptShownAt: String?
  let parentTitle: String?
  /// The host's own count of what is still blocking this chat. The only thing
  /// that can rescue a pending-input card the transcript swept without a
  /// `pending_input_resolved` receipt — see `WorkPendingInputQueue.resolved(_:)`.
  let pendingInputItemId: String?

  init(_ summary: AgentChatSessionSummary?, parentTitle: String? = nil) {
    guard let summary else {
      self.isAvailable = false
      self.provider = ""
      self.model = ""
      self.modelId = nil
      self.reasoningEffort = ""
      self.effectiveFastMode = false
      self.runtimeMode = ""
      self.fastModeSupported = false
      self.idleSinceAt = nil
      self.endedAt = nil
      self.lastOutputPreview = nil
      self.requestedCwd = nil
      self.modelLabel = "Model"
      self.contextWindowFallback = nil
      self.claudeGoal = nil
      self.spawnKind = nil
      self.orchestrationParentSessionId = nil
      self.subagentTakeoverPromptShownAt = nil
      self.parentTitle = nil
      self.pendingInputItemId = nil
      return
    }

    self.isAvailable = true
    self.provider = summary.provider
    self.model = summary.model
    self.modelId = summary.modelId
    self.reasoningEffort = summary.reasoningEffort ?? ""
    self.effectiveFastMode = summary.effectiveFastMode
    self.runtimeMode = workInitialRuntimeMode(summary)
    self.fastModeSupported = workChatComposerSupportsFastMode(summary)
    self.idleSinceAt = summary.idleSinceAt
    self.endedAt = summary.endedAt
    self.lastOutputPreview = summary.lastOutputPreview
    self.requestedCwd = summary.requestedCwd
    self.modelLabel = prettyWorkChatModelName(summary.model)
    self.contextWindowFallback = workContextWindowFallback(modelId: summary.modelId, model: summary.model)
    self.claudeGoal = summary.claudeGoal
    self.spawnKind = summary.spawnKind
    self.orchestrationParentSessionId = summary.orchestrationParentSessionId
    self.subagentTakeoverPromptShownAt = summary.subagentTakeoverPromptShownAt
    self.parentTitle = parentTitle
    self.pendingInputItemId = summary.pendingInputItemId
  }

  var currentModelId: String {
    modelId ?? model
  }
}

struct WorkChatSessionRenderContext: Equatable {
  let id: String
  let laneId: String
  let chatIdleSinceAt: String?
  let endedAt: String?
  let lastOutputPreview: String?
  let normalizedStatus: String
  /// Session-row fallback for the chat summary's `pendingInputItemId`, used the
  /// same way `workSessionCanonicalState` already prefers the summary and falls
  /// back to the row.
  let pendingInputItemId: String?

  init(_ session: TerminalSessionSummary) {
    self.id = session.id
    self.laneId = session.laneId
    self.chatIdleSinceAt = session.chatIdleSinceAt
    self.endedAt = session.endedAt
    self.lastOutputPreview = session.lastOutputPreview
    self.normalizedStatus = normalizedWorkChatSessionStatus(session: session, summary: nil)
    self.pendingInputItemId = session.pendingInputItemId
  }
}

private struct WorkChatSummaryTimelineKey: Equatable {
  let provider: String
  let model: String
  let modelId: String?

  init(_ context: WorkChatSummaryRenderContext) {
    self.provider = context.provider
    self.model = context.model
    self.modelId = context.modelId
  }
}

struct WorkChatSessionView: View {
  @Environment(\.accessibilityReduceMotion) var reduceMotion

  let session: WorkChatSessionRenderContext
  let chatSummaryContext: WorkChatSummaryRenderContext
  let transcript: [WorkChatEnvelope]
  let transcriptRenderSignature: Int
  let allowsIncrementalTranscriptUpdate: Bool
  @Binding var transcriptIncrementalDelta: [WorkChatEnvelope]
  let fallbackEntries: [AgentChatTranscriptEntry]
  let fallbackEntriesRenderSignature: Int
  let artifacts: [ComputerUseArtifactSummary]
  let artifactsRenderSignature: Int
  let optimisticPendingSteers: [WorkPendingSteerModel]
  let optimisticPendingSteersRenderSignature: Int
  let localEchoMessages: [WorkLocalEchoMessage]
  let localEchoMessagesRenderSignature: Int
  let cardExpansionSnapshot: WorkCardExpansionState
  let cardExpansionRenderSignature: Int
  let artifactContentRenderSignature: Int
  let artifactDrawerPresentedSnapshot: Bool
  let sendingSnapshot: Bool
  let errorMessageSnapshot: String?
  @Binding var cardExpansion: WorkCardExpansionState
  @Binding var artifactContent: [String: WorkLoadedArtifactContent]
  @Binding var fullscreenImage: WorkFullscreenImage?
  @Binding var artifactDrawerPresented: Bool
  let artifactRefreshInFlight: Bool
  let artifactRefreshError: String?
  @Binding var sending: Bool
  @Binding var errorMessage: String?
  @State var visibleTimelineCount = workTimelinePageSize
  @State var actionInFlight = false
  @State var isNearBottom = true
  @State var unreadBelowCount = 0
  @State var lastTimelineTailId: String?
  @State var scrollViewportHeight: CGFloat = 0
  @State var scrollViewportWidth: CGFloat = 0
  @State var composerLayoutHeight: CGFloat = 150
  @State var scrollMetrics = WorkChatScrollMetrics()
  /// Only ever written to restore the reader's position after a prepend. Bottom
  /// follow and the jump-to-latest pill keep using `ScrollViewProxy.scrollTo`.
  @State var scrollPosition = ScrollPosition()
  @State var timelineDragActive = false
  /// True from the moment the reader touches the transcript until the fling it
  /// launched has come to rest. The drag gesture alone ends at finger-up, which
  /// is the middle of the interaction, not the end of it.
  @State var timelineScrollPhaseUserDriven = false
  @State var bottomStickinessReleasedByUser = false
  @State var timelineSnapshot = WorkChatTimelineSnapshot.empty
  @State var timelinePresentation = WorkTimelinePresentation.empty
  @State var turnToolActivity = WorkTurnToolActivityIndex(completedByTurnId: [:], active: nil)
  @State var timelineIncrementalCache = WorkTimelineIncrementalCache()
  @State var timelineSourceKey: String?
  @State var timelineRebuildTask: Task<Void, Never>?
  @State var timelineRebuildPending = false
  @State var timelineRebuildGeneration = 0
  @State var timelineBuildScopeId = UUID().uuidString
  @State var latestPinTask: Task<Void, Never>?
  @State var latestPinGeneration = 0
  @State var assistantPreviewCache = WorkAssistantPreviewCache()
  @State var contextUsageViewModelCache = WorkContextUsageViewModelCache()
  @State var assistantLineBudgets: [String: Int] = [:]
  /// Largest budget each assistant message has already rendered under. A budget
  /// may grow but never shrink, so "Show more" cannot appear on a message the
  /// reader already read in full.
  @State var assistantBudgetFloors: [String: Int] = [:]
  /// Messages the reader expanded. They read from the top from then on, so a
  /// tap does not swap the visible slice for the other end of the message.
  @State var assistantHeadAnchorOverrides: Set<String> = []
  /// One presentation host for every box in this transcript. Boxes reach it
  /// through `\.workOutputViewer` rather than each carrying its own cover.
  @StateObject var outputViewer = WorkOutputViewerModel()
  @State var composerSettingMutationInFlight = false
  @State var composerSettingMutationGeneration = 0
  @State var pendingCodexFastMode: Bool?
  @State var scrollStateSessionId: String?
  @State var pendingInitialBottomPinSessionId: String?
  @State var initialBottomPinQuiescenceGeneration = 0
  /// Whether the whole transcript fits on screen. Flips rarely, so it is safe as
  /// `@State` even though the sample that produces it arrives per scroll frame.
  @State var transcriptContentFitsViewport = true
  @State var timelineLayoutPinToken = 0
  @State var olderHistoryLoadInFlight = false
  @State var olderHistoryLoadError: String?
  @State var olderHistoryTriggerArmed = true
  @State var olderHistoryAutomaticContinuationPending = false
  @State var olderHistoryLoadTask: Task<Void, Never>?
  /// `chat-card` declarations for this chat, rebuilt only when plugin rows
  /// change and read by value per card — a transcript row must never query.
  @State var pluginContributions = PluginContributionIndex()
  let isLive: Bool
  let hostUnreachable: Bool
  let canComposeMessages: Bool
  let canSendMessages: Bool
  let sendWillQueue: Bool
  let sendWillQueueIsReconnect: Bool
  let activeSendModesAvailable: Bool
  let queueAwareStopAvailable: Bool
  let transportHealth: SyncTransportHealth
  let composerDraftRestore: WorkChatComposerDraftRestore?
  var inputLockMessage: String? = nil
  let transitionNamespace: Namespace.ID?
  /// The sync service, as a plain reference rather than an `@EnvironmentObject`.
  ///
  /// Deliberate: this view is the transcript, and observing the service here
  /// would re-render every row on every unrelated publish. A `chat-card` panel
  /// needs the service only to build its store at `init`, and the contributions
  /// it gates on arrive through `.loadPluginContributions`, whose modifier does
  /// the observing on its own.
  var pluginSyncService: SyncService? = nil
  let onOpenLane: (() -> Void)?
  let onSend: @MainActor (String, [WorkChatInputAttachment], WorkActiveSendMode) async -> Bool
  let onInterrupt: @MainActor (AgentChatStopMode) async -> Void
  let onRestoreCancelledQueue: (@MainActor (String) async -> Void)?
  let onApproveRequest: @MainActor (String, AgentChatApprovalDecision, String?) async -> Void
  let onRespondToQuestion: @MainActor (String, String, AgentChatInputAnswerValue?, String?) async -> Void
  let onSubmitQuestionAnswers: @MainActor (String, [String: AgentChatInputAnswerValue], String?) async -> Void
  let onDeclineQuestion: @MainActor (String) async -> Void
  let onRespondToPermission: @MainActor (String, AgentChatApprovalDecision) async -> Void
  let onRetryLoad: @MainActor () async -> Void
  let onOpenFile: @MainActor (String) async -> Void
  let onOpenPr: @MainActor (Int) async -> Void
  let onLoadArtifact: @MainActor (ComputerUseArtifactSummary) async -> Void
  let onRefreshArtifacts: @MainActor () async -> Void
  let onCancelSteer: @MainActor (String) async -> Void
  let onEditSteer: @MainActor (String, String) async -> Void
  let onDispatchSteerInline: (@MainActor (String) async -> Void)?
  let onDispatchSteerInterrupt: (@MainActor (String) async -> Void)?
  let onSelectModel: @MainActor (String) async -> Void
  let onSelectRuntimeMode: @MainActor (String) async -> Bool
  let onSelectEffort: @MainActor (String) async -> Void
  let onSelectCodexFastMode: @MainActor (Bool) async -> Bool

  /// Opens the parent chat for a standalone spawned child session. The nested
  /// transcript viewer uses its own back control and leaves this unset.
  var onOpenParentSession: (() -> Void)? = nil

  var resolvedSessionStatus: String? = nil
  var lanes: [LaneSummary] = []
  var lanesRenderSignature: Int = 0
  // Host-side scroll-back: true while older transcript pages remain on the
  // host beyond what the phone has fetched; the callback pulls the next page.
  var hasOlderTranscriptHistory: Bool = false
  var onLoadOlderTranscript: (@MainActor () async -> WorkChatOlderHistoryLoadResult)? = nil
  var subagentSnapshots: [WorkSubagentSnapshot] = []
  var subagentSnapshotsRenderSignature: Int = 0
  var scheduledWorkSnapshots: [WorkScheduledWorkSnapshot] = []
  var scheduledWorkSnapshotsRenderSignature: Int = 0
  var selectedSubagentTaskId: String? = nil
  var onOpenChatInfo: (() -> Void)? = nil
  /// Tapping a subagent spawn/result timeline row opens the same detail surface
  /// the Chat Info roster row opens (full transcript takeover or expanded row).
  var onSelectSubagentRow: (@MainActor (WorkSubagentSnapshot) async -> Void)? = nil
  /// Fork the current Claude thread in this lane (session-quota card).
  var onForkChatInLane: (@MainActor () async -> Void)? = nil
  var prBadge: WorkChatPrBadgeModel? = nil
  var onOpenPrDetails: (() -> Void)? = nil
  /// Live "turn is running" signal from the sync layer (chat_subscribe ack +
  /// live status/done events). Covers the gap where the synced session row
  /// still says idle while chat events are already streaming — without it
  /// the chat renders output with no stop button or working indicator.
  var liveTurnActiveHint: Bool? = nil
  var compactComposer = false
  var isPersonalChat: Bool = false
  var attachmentsAvailable: Bool = true
  var personalModelCatalogAvailable: Bool = true
  var personalSessionUpdatesAvailable: Bool = true
  /// Present only when the paired host advertises provider-neutral
  /// `chat.recoverTurn` or the legacy Codex-specific recovery action.
  /// Keeping this optional prevents a new phone build from offering controls
  /// that an older ADE brain cannot execute.
  var onRecoverCodexTurn: (@MainActor (String, String, String) async throws -> String)? = nil
  var onRunUnprocessedMessage: (@MainActor (WorkChatMessage) async throws -> Void)? = nil
  var onEditUnprocessedMessage: (@MainActor (WorkChatMessage) async throws -> Void)? = nil
  var onDismissUnprocessedMessage: (@MainActor (WorkChatMessage) async throws -> Void)? = nil
  /// Whether the transcript this chat is showing has actually arrived. An empty
  /// timeline is the same shape for a brand-new chat, a transcript request still
  /// in flight, and a `chat_subscribe` that was dropped and will never be
  /// answered — only this tells the empty state which of the three it is.
  /// Defaults to `.idle` so callers that have not wired a real load state keep
  /// today's behaviour instead of silently claiming a chat is loading.
  var transcriptLoadState: WorkChatTranscriptLoadState = .idle
  /// Re-requests the transcript after a failed load. When nil the failure state
  /// renders without a Retry button rather than offering a dead control.
  var onRetryTranscript: (() -> Void)? = nil
  var onTakeOverSubagent: (@MainActor () async -> Void)? = nil
  var onKeepReportingSubagent: (@MainActor () async -> Void)? = nil

  @State var steerEditDrafts: [String: String] = [:]
  @State var modelPickerPresented = false
  @State var toolActivitySheet: WorkToolActivitySheetSelection?
  @State var modelUpdateInFlight = false
  /// Bumped each time a NEW blocking pending input arrives so the body can fire
  /// a single light haptic — keeps a question/plan gate from being missed.
  @State var blockingPendingHapticToken = 0
  /// Last blocking pending-input id we reacted to, so re-renders that keep the
  /// same gate open don't re-fire the haptic or re-scroll.
  @State var lastBlockingPendingInputId: String?
  /// Light haptic when a Claude session-quota card first appears.
  @State var quotaCardHapticToken = 0
  @State var lastLiveQuotaCardId: String?
  /// Item ids of pending inputs the user just answered. They are hidden from the
  /// consolidated strip immediately (optimistic removal) so it advances to the
  /// next request without waiting for the host, and reconciled back out once the
  /// item leaves the derived queue (or rolled back if the command errored). See
  /// `dispatchPendingInputAnswer` / `reconcileOptimisticallyAnsweredInputs`.
  @State var optimisticallyAnsweredInputIds: Set<String> = []
  /// Id of the pending input the user minimized, if any.
  ///
  /// Derived, not synchronized: a minimize applies to the gate the user chose to
  /// defer, so it has to expire on its own the moment a different gate becomes
  /// primary. Storing the id and computing the Bool from it makes that
  /// impossible to get wrong; a Bool reset from an observer would be one more
  /// thing that can fall out of step and leave a fresh question hidden.
  @State var collapsedPendingInputId: String?

  var sessionStatus: String {
    resolvedSessionStatus ?? session.normalizedStatus
  }

  private var chatSummaryTimelineKey: WorkChatSummaryTimelineKey {
    WorkChatSummaryTimelineKey(chatSummaryContext)
  }

  private var selectedSubagentSnapshot: WorkSubagentSnapshot? {
    guard let selectedId = selectedSubagentTaskId else { return nil }
    return subagentSnapshots.first { snapshot in
      snapshot.taskId == selectedId || snapshot.agentId == selectedId
    }
  }

  private var transcriptModelId: String {
    if let model = selectedSubagentSnapshot?.model?.trimmingCharacters(in: .whitespacesAndNewlines),
       !model.isEmpty {
      return model
    }
    return chatSummaryContext.currentModelId
  }

  private var transcriptModelLabel: String {
    if let snapshot = selectedSubagentSnapshot,
       let chip = workSubagentModelChip(
        snapshotModel: snapshot.model,
        sessionModel: chatSummaryContext.model
       ) {
      return chip
    }
    return chatSummaryContext.modelLabel
  }

  /// Terminal transcript signal from the local event window. When present, it
  /// beats stale session rows / subscribe hints that can lag a just-finished
  /// turn by a few seconds.
  var transcriptLatestTurnEnded: Bool {
    timelineSnapshot.transcriptLatestTurnEnded
  }

  /// The live turn hint can be stale if mobile misses the final `done` event.
  /// When the synced row has an idle/end timestamp newer than our transcript
  /// tail, prefer the row so the working indicator clears promptly.
  var sessionRowEndedAfterLatestTranscript: Bool {
    guard sessionStatus == "idle" || sessionStatus == "ended" else { return false }
    let rowEndedAt = [
      chatSummaryContext.idleSinceAt,
      chatSummaryContext.endedAt,
      session.chatIdleSinceAt,
      session.endedAt
    ]
    .compactMap { value in
      value?.isEmpty == false ? value : nil
    }
    .max()
    guard let rowEndedAt else { return false }
    guard let latestTranscriptAt = timelineSnapshot.latestTranscriptTimestamp else { return false }
    if rowEndedAt >= latestTranscriptAt {
      return true
    }
    guard let rowEndedDate = workParsedDate(rowEndedAt),
          let latestTranscriptDate = workParsedDate(latestTranscriptAt) else {
      return false
    }
    return rowEndedDate >= latestTranscriptDate.addingTimeInterval(-0.25)
  }

  /// Single source of truth for "the assistant is generating right now".
  /// Drives the activity indicator, the composer stop button, and the
  /// streaming-markdown fast path.
  var isStreamingTurn: Bool {
    workChatIsStreaming(
      sessionStatus: sessionStatus,
      isLive: isLive,
      transcriptIndicatesActiveTurn: timelineSnapshot.transcriptIndicatesActiveTurn,
      liveTurnActiveHint: liveTurnActiveHint,
      transcriptLatestTurnEnded: transcriptLatestTurnEnded,
      rowEndedAfterLatestTranscript: sessionRowEndedAfterLatestTranscript
    )
  }

  var shouldShowInterruptControl: Bool {
    isStreamingTurn && timelineSnapshot.transcriptHasInterruptibleActivity
  }

  /// The host's own count of what is still blocking, preferring the chat summary
  /// and falling back to the session row — the same precedence
  /// `workCanonicalSessionState` uses for the "needs you" phase.
  var hostPendingInputItemId: String? {
    let fromSummary = chatSummaryContext.pendingInputItemId?
      .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    if !fromSummary.isEmpty { return fromSummary }
    return session.pendingInputItemId
  }

  /// The one place the raw derivation is reconciled against the session summary.
  ///
  /// Recomputed on every read, so the join cannot be served stale: a summary that
  /// moves with no new transcript event still repaints the strip. Cheap because
  /// it walks the (tiny) pending queue, never the transcript — the transcript
  /// walk stays inside the cached, summary-free `WorkChatTimelineSnapshot`, which
  /// is exactly why the reconciliation cannot live there.
  ///
  /// Without this, a blocking gate whose asker outlived its turn vanishes from
  /// the strip while the host still counts it: the composer unlocks, the send is
  /// refused, and there is no card left to answer. Desktop parity:
  /// `resolvedPendingInputsBySession` in `AgentChatPane.tsx`.
  var canonicalPendingInputs: [WorkPendingInputItem] {
    timelineSnapshot.pendingInputQueue.resolved(hostPendingInputItemId: hostPendingInputItemId)
  }

  /// Canonical open pending inputs minus the ones the user just answered.
  /// `optimisticallyAnsweredInputIds` hides an item the instant a decision is
  /// dispatched so the consolidated strip advances to the next request without
  /// waiting for the host round-trip (iOS had no optimistic removal before, so
  /// the card visibly flickered). Entries are reconciled back out once the item
  /// leaves the derived queue, or rolled back if the command errored.
  var pendingInputs: [WorkPendingInputItem] {
    let canonical = canonicalPendingInputs
    guard !optimisticallyAnsweredInputIds.isEmpty else {
      return canonical
    }
    return canonical.filter {
      !optimisticallyAnsweredInputIds.contains($0.itemId)
    }
  }

  /// Number of still-open requests in the consolidated strip; drives the
  /// "Request 1 of N" header and whether "Accept all" is offered.
  var pendingInputCount: Int {
    pendingInputs.count
  }

  /// Order-sensitive fingerprint of the CANONICAL (host-derived) pending queue,
  /// ignoring optimistic hides. Changes only when the host adds/removes/reorders
  /// a request, which is exactly when `reconcileOptimisticallyAnsweredInputs`
  /// should prune resolved optimistic entries.
  var canonicalPendingInputSignature: String {
    canonicalPendingInputs.map(\.itemId).joined(separator: "\u{1F}")
  }

  var pendingSteers: [WorkPendingSteerModel] {
    mergeWorkPendingSteers(
      optimistic: optimisticPendingSteers,
      canonical: timelineSnapshot.pendingSteers
    )
  }

  var primaryPendingInput: WorkPendingInputItem? {
    pendingInputs.first
  }

  /// The strip is minimized only while the deferred gate is still the primary
  /// one. The gate stays open and the composer stays locked either way — only
  /// the card is swapped for a one-line pill.
  var pendingInputCollapsed: Bool {
    get {
      guard let collapsedPendingInputId, let primaryPendingInput else { return false }
      return collapsedPendingInputId == primaryPendingInput.id
    }
    nonmutating set {
      collapsedPendingInputId = newValue ? primaryPendingInput?.id : nil
    }
  }

  /// Total height available to the chat surface, keyboard already subtracted.
  ///
  /// The transcript and the composer inset split the surface between them, so
  /// their measured heights always sum back to it — and unlike either half on
  /// its own, the sum does NOT move when the pending-input card grows. That
  /// matters: sizing the card off `scrollViewportHeight` alone (what this used
  /// to do) was self-referential, because a taller card shrank the transcript,
  /// which shrank the budget, which... The floor is the 240 the transcript
  /// reports before its first real measurement.
  var chatSurfaceHeight: CGFloat {
    max(240, scrollViewportHeight + composerLayoutHeight)
  }

  var pendingInputMaxHeight: CGFloat {
    workPendingInputMaxHeight(chatSurfaceHeight: chatSurfaceHeight)
  }

  /// Open approval / permission gates that "Accept all" can sweep. Question,
  /// plan-approval, and model-selection kinds are never auto-answered.
  var acceptAllSweepableInputs: [WorkPendingInputItem] {
    pendingInputs.filter { item in
      switch item {
      case .approval, .permission: return true
      case .question, .planApproval, .modelSelection: return false
      }
    }
  }

  /// "Accept all" is only offered when more than one request is queued and the
  /// current (primary) request is itself an approval/permission gate — matching
  /// desktop, where accepting-all flips session auto-approve for the current
  /// item then accepts the remaining approval/permission requests.
  var canAcceptAllPendingInputs: Bool {
    guard pendingInputCount > 1, let primary = primaryPendingInput else { return false }
    switch primary {
    case .approval, .permission:
      return acceptAllSweepableInputs.count > 1
    case .question, .planApproval, .modelSelection:
      return false
    }
  }

  var hasPendingInputGate: Bool {
    workChatComposerBlocksFreeformInput(pendingInputCount: pendingInputs.count, sessionStatus: sessionStatus)
  }

  var composerPlaceholderText: String {
    workChatComposerPlaceholder(pendingInputs: pendingInputs, sessionStatus: sessionStatus)
  }

  /// Stable id of the first blocking pending input awaiting a reply, or nil when
  /// none is open. Drives the arrival haptic + elevate-into-view so a blocking
  /// question/plan gate can't be silently missed. Only fires when the session is
  /// live (an offline read-only card isn't actionable, so no haptic).
  var blockingPendingInputId: String? {
    guard isLive else { return nil }
    return primaryPendingInput?.id
  }

  var liveClaudeQuotaCardId: String? {
    guard isLive else { return nil }
    for entry in timelineSnapshot.timeline {
      if case .adeCard(let card) = entry.payload,
         card.variant == "claude_session_quota",
         !card.isTerminal {
        return card.id
      }
    }
    return nil
  }

  @MainActor
  func handleLiveQuotaCardChange(_ id: String?) {
    guard id != lastLiveQuotaCardId else { return }
    lastLiveQuotaCardId = id
    guard id != nil else { return }
    quotaCardHapticToken &+= 1
  }

  /// React to a newly-arrived blocking pending input: fire one light haptic.
  /// All pending inputs now render in the consolidated strip pinned above the
  /// composer, so none require a transcript scroll. No-ops when the same gate is
  /// already open.
  @MainActor
  func handleBlockingPendingInputChange(_ id: String?) {
    guard id != lastBlockingPendingInputId else { return }
    lastBlockingPendingInputId = id
    guard id != nil else { return }
    blockingPendingHapticToken &+= 1
  }

  @MainActor
  private func runComposerSettingMutation(
    onFailure: @MainActor @escaping () -> Void = {},
    operation: @MainActor @escaping () async -> Bool
  ) {
    let generation = composerSettingMutationGeneration + 1
    composerSettingMutationGeneration = generation
    composerSettingMutationInFlight = true

    Task { @MainActor in
      let succeeded = await operation()
      guard generation == composerSettingMutationGeneration else { return }
      composerSettingMutationInFlight = false
      if !succeeded {
        onFailure()
      }
    }
  }

  var toolCards: [WorkToolCardModel] {
    timelineSnapshot.toolCards
  }

  var eventCards: [WorkEventCardModel] {
    timelineSnapshot.eventCards
  }

  var commandCards: [WorkCommandCardModel] {
    timelineSnapshot.commandCards
  }

  var fileChangeCards: [WorkFileChangeCardModel] {
    timelineSnapshot.fileChangeCards
  }

  var timeline: [WorkTimelineEntry] {
    timelineSnapshot.timeline
  }

  var visibleTimeline: [WorkTimelineEntry] {
    timelinePresentation.visibleEntries
  }

  var visibleTimelineRenderEntries: [WorkTimelineRenderEntry] {
    timelinePresentation.renderEntries
  }

  var latestScrollTargetId: String {
    // The bottom sentinel is the same view used for scroll metrics. Pinning to a
    // markdown block or streaming row can leave the sentinel below the viewport,
    // which looks like a blank tail and keeps the Latest pill stale.
    "chat-end"
  }

  var hiddenTimelineCount: Int {
    timelinePresentation.hiddenCount
  }

  var canRequestOlderTranscriptHistory: Bool {
    hasOlderTranscriptHistory && onLoadOlderTranscript != nil
  }

  @MainActor
  func refreshTimelinePresentation(
    sourceTimeline: [WorkTimelineEntry]? = nil,
    rebuildToolActivityIndex: Bool = true
  ) {
    let timeline = sourceTimeline ?? timelineSnapshot.timeline
    if rebuildToolActivityIndex {
      turnToolActivity = workTurnToolActivityIndex(from: timeline)
    }
    let presentedTimeline = workPresentedTimelineEntries(timeline)
    var budgetFloors = assistantBudgetFloors
    var nextPresentation = makeWorkTimelinePresentation(
      timeline: presentedTimeline,
      visibleCount: visibleTimelineCount,
      chatSummary: chatSummaryContext,
      transcript: transcript,
      assistantPreviewCache: assistantPreviewCache,
      assistantLineBudgets: assistantLineBudgets,
      assistantBudgetFloors: &budgetFloors,
      assistantHeadAnchorOverrides: assistantHeadAnchorOverrides,
      streamingAssistantMessageId: streamingAssistantMessageId
    )
    let timelineDelta = nextPresentation.timelineCount - timelinePresentation.timelineCount
    let prependedHistory = (
      timelineDelta > 0
      && timelinePresentation.timelineFirstId != nil
      && timelinePresentation.timelineLastId != nil
      && timelinePresentation.timelineLastId == nextPresentation.timelineLastId
      && timelinePresentation.timelineFirstId != nextPresentation.timelineFirstId
    )
    if prependedHistory {
      visibleTimelineCount = workTimelineVisibleCountAfterHistoryPrepend(
        currentVisibleCount: visibleTimelineCount,
        prependedCount: timelineDelta
      )
      nextPresentation = makeWorkTimelinePresentation(
        timeline: presentedTimeline,
        visibleCount: visibleTimelineCount,
        chatSummary: chatSummaryContext,
        transcript: transcript,
        assistantPreviewCache: assistantPreviewCache,
        assistantLineBudgets: assistantLineBudgets,
        assistantBudgetFloors: &budgetFloors,
        assistantHeadAnchorOverrides: assistantHeadAnchorOverrides,
        streamingAssistantMessageId: streamingAssistantMessageId
      )
    }
    if budgetFloors != assistantBudgetFloors {
      assistantBudgetFloors = budgetFloors
    }
    guard nextPresentation != timelinePresentation else { return }
    armPrependAnchorIfRowsInsertedAbove(nextPresentation)
    timelinePresentation = nextPresentation
  }

  /// The row carrying the displacement probe: normally the list's first row, and
  /// the armed row while a prepend is in flight (it is no longer first once the
  /// older page lands above it).
  var prependProbeRowId: String? {
    let hasPrependAnchor = scrollMetrics.prependAnchor != nil
    guard workChatShouldInstallPrependProbe(
      distanceFromTop: scrollMetrics.distanceFromTop,
      hasPrependAnchor: hasPrependAnchor
    ) else {
      return nil
    }
    return scrollMetrics.prependAnchor?.rowId ?? timelinePresentation.visibleEntries.first?.id
  }

  /// The last real probe measurement, replayed when a correction had to wait for
  /// the reader's fling to settle (no new preference change arrives once layout
  /// is quiet).
  var lastPrependProbeSample: WorkChatPrependProbeSample? {
    guard let rowId = scrollMetrics.probeRowId, let y = scrollMetrics.probeRowY else { return nil }
    return WorkChatPrependProbeSample(rowId: rowId, y: y)
  }

  /// Where a transcript shorter than the viewport sits.
  ///
  /// The alignment only has an effect while the content is shorter than the
  /// viewport (past that the frame is content-sized), and there desktop renders
  /// the first prompt at the TOP — a one-message chat pinned to the bottom of an
  /// otherwise empty screen reads like the transcript failed to load.
  var transcriptContentAlignment: Alignment {
    workChatTranscriptContentAlignment(contentFitsViewport: transcriptContentFitsViewport)
  }

  /// Records where the reader is whenever the next presentation inserts rows
  /// above the ones already on screen — whether that came from revealing locally
  /// buffered entries or from an older page landing from the host. Without this
  /// the LazyVStack grows upward, `contentOffset` stays put, and whatever the
  /// user was reading slides down by the height of the inserted page.
  @MainActor
  private func armPrependAnchorIfRowsInsertedAbove(_ nextPresentation: WorkTimelinePresentation) {
    let previousFirstId = timelinePresentation.visibleEntries.first?.id
    let existingAnchorRowId = scrollMetrics.prependAnchor?.rowId
    switch workChatPrependArmDecision(
      previousFirstId: previousFirstId,
      nextFirstId: nextPresentation.visibleEntries.first?.id,
      previousVisibleCount: timelinePresentation.visibleEntries.count,
      nextVisibleCount: nextPresentation.visibleEntries.count,
      existingAnchorRowId: existingAnchorRowId,
      anchorRowStillVisible: existingAnchorRowId.map { rowId in
        nextPresentation.visibleEntries.contains { $0.id == rowId }
      } ?? false,
      previousFirstRowStillVisible: previousFirstId.map { rowId in
        nextPresentation.visibleEntries.contains { $0.id == rowId }
      } ?? false,
      probeRowId: scrollMetrics.probeRowId,
      probeRowY: scrollMetrics.probeRowY
    ) {
    case .ignore:
      return
    case .extendExistingAnchorWindow:
      scrollMetrics.prependAnchor?.remainingAttempts = workChatPrependAnchorAttempts
    case .retireAnchor:
      scrollMetrics.prependAnchor = nil
    case .arm(let rowId, let rowY):
      scrollMetrics.prependAnchor = WorkChatPrependAnchor(
        rowId: rowId,
        rowY: rowY,
        offsetY: scrollMetrics.offsetY,
        remainingAttempts: workChatPrependAnchorAttempts
      )
    }
  }

  /// Re-applies the reader's position once the prepended rows have laid out.
  ///
  /// The anchored row moved down by exactly the height inserted above it, and
  /// that displacement is measured on the row itself — so a reply streaming into
  /// the tail at the same time contributes nothing to the correction.
  @MainActor
  func restorePrependAnchorIfNeeded(probed: WorkChatPrependProbeSample?) {
    guard var anchor = scrollMetrics.prependAnchor else { return }

    let insertedHeight: CGFloat
    switch workChatPrependCorrection(
      anchor: anchor,
      probed: probed,
      currentOffsetY: scrollMetrics.offsetY,
      mayWriteScrollOffset: workChatMayWriteScrollOffset(
        dragActive: timelineDragActive,
        scrollPhaseUserDriven: timelineScrollPhaseUserDriven
      )
    ) {
    case .wait:
      return
    case .retry:
      anchor.remainingAttempts -= 1
      scrollMetrics.prependAnchor = anchor.remainingAttempts > 0 ? anchor : nil
      return
    case .apply(let height):
      insertedHeight = height
    }

    scrollMetrics.prependAnchor = nil
    // Bottom-follow owns the scroll position when the reader is parked at the
    // tail; a prepend there is invisible anyway.
    guard !isNearBottom else { return }

    var transaction = Transaction()
    transaction.disablesAnimations = true
    withTransaction(transaction) {
      // Applied to the live offset so a scroll during the prepend is kept;
      // only the inserted height is undone. Clamped to the scrollable range the
      // way t3code's `restore(_:in:dataSource:)` bounds its `setContentOffset`:
      // a measured height should never land out of range, but the retained
      // last-probe path can carry a stale measurement, and a bounded restore
      // fails as a slightly-wrong position instead of a blank overscroll.
      let target = min(max(0, scrollMetrics.offsetY + insertedHeight), scrollMetrics.scrollableHeight)
      scrollPosition.scrollTo(y: target)
    }
  }

  var canCompose: Bool {
    // Typing stays available so users can draft while disconnected or while
    // a turn is running, except when a blocking pending-input card is open —
    // those replies must go through the structured card the runtime is awaiting.
    canComposeMessages && !hasPendingInputGate
  }

  var canSend: Bool {
    // Existing chats accept messages while live, and can still accept them
    // during reconnects when desktop advertised chat.send as queueable. Pending
    // input is gated separately so the host receives a structured answer.
    canSendMessages && (!sending || sendWillQueue) && !hasPendingInputGate
  }

  var composerFeedback: String? {
    if let inputLockMessage {
      return inputLockMessage
    }
    if sending && !sendWillQueue {
      return "Sending message to machine..."
    }
    if sendWillQueueIsReconnect, pendingSteers.isEmpty {
      return "Machine is reconnecting. Send will queue until it is back."
    }
    if transportHealth == .connecting {
      return "Reconnecting… Your draft is safe."
    }
    if !canSendMessages {
      return "Waiting for the machine before sending."
    }
    if pendingInputs.count == 1 {
      // The single request renders in the consolidated strip directly above the
      // composer with its own actions, so it carries no guidance banner.
      return nil
    }
    if !pendingInputs.isEmpty {
      // Multiple queued requests: the strip shows "Request 1 of N" and advances
      // as each is answered, so point the user at it.
      return "Answer the waiting prompt above, or decline it before sending another message."
    }
    return nil
  }

  var jumpToLatestPillBottomPadding: CGFloat {
    16
  }

  var maxUserBubbleWidth: CGFloat? {
    guard scrollViewportWidth > 32 else { return nil }
    return (scrollViewportWidth - 32) * 0.92
  }

  @ViewBuilder
  var sessionOverviewSection: some View {
    // When live, approval_request cards (tool approval gates) render at the
    // top — structured questions, permission gates, and plan approvals get
    // their inline treatment in the timeline instead.
    //
    // When offline, we no longer stack "Reconnect to respond" banners here.
    // The top-right ADEConnectionDot already signals "Offline" and the
    // pending cards themselves stay visible in the timeline in a read-only
    // state, so duplicating the reconnect nag at the top added noise
    // without new information.
    // Tool/file-change approval gates now render as a pinned badge directly
    // above the composer (see `composerInset`), mirroring the plan-ready badge,
    // so the Accept / Decline actions are always in reach instead of scrolled
    // off the top of the transcript.

    if let parentId = chatSummaryContext.orchestrationParentSessionId?
      .trimmingCharacters(in: .whitespacesAndNewlines),
       !parentId.isEmpty,
       parentId != session.id,
       let onOpenParentSession {
      WorkSubagentLineageBreadcrumb(
        parentTitle: chatSummaryContext.parentTitle,
        onOpen: onOpenParentSession
      )
    }

    // Connection-caused failures are communicated via the top-right gear, but
    // cached/offline chat actions still need their own visible errors.
    if let errorMessageSnapshot, !hostUnreachable {
      ADENoticeCard(
        title: "Chat error",
        message: errorMessageSnapshot,
        icon: "exclamationmark.triangle.fill",
        tint: ADEColor.danger,
        actionTitle: "Retry",
        action: { Task { await onRetryLoad() } }
      )
    }
  }

  @ViewBuilder
  func timelineSection(proxy: ScrollViewProxy) -> some View {
    if hiddenTimelineCount > 0 || canRequestOlderTranscriptHistory {
      Group {
        if olderHistoryLoadInFlight {
          HStack(spacing: 8) {
            ProgressView()
              .controlSize(.small)
            Text("Loading earlier messages…")
          }
          .frame(maxWidth: .infinity, minHeight: 28)
        } else if let olderHistoryLoadError {
          Button {
            requestEarlierTimelineEntries(
              automatically: olderHistoryAutomaticContinuationPending
            )
          } label: {
            Label("Couldn’t load earlier messages · Retry", systemImage: "arrow.clockwise")
              .frame(maxWidth: .infinity, minHeight: 44)
              .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .foregroundStyle(ADEColor.accent)
          .accessibilityHint(olderHistoryLoadError)
        } else {
          Color.clear
            .frame(height: 1)
            .accessibilityHidden(true)
        }
      }
      .font(.footnote.weight(.semibold))
    }

    if timeline.isEmpty {
      transcriptEmptyStateSection
    } else {
      let streamingMessageId = streamingAssistantMessageId
      let userBubbleWidth = maxUserBubbleWidth
      let probeRowId = prependProbeRowId
      // A streaming or expanded assistant message renders as several suffixed
      // block rows, so the probed *timeline* entry has no render row with a
      // matching id. Resolve through `sourceEntryId` and pick its first block,
      // or the probe silently never installs and the anchor never arms.
      let probeRenderRowId = visibleTimelineRenderEntries
        .first { $0.sourceEntryId == probeRowId }?.id
      // Keep SwiftUI's identity pass over tiny values. Render entries carry
      // full assistant payloads, so iterating them directly makes AttributeGraph
      // copy long markdown responses just to read `id` during layout.
      let renderEntries = visibleTimelineRenderEntries
      let renderRowReferences = renderEntries.enumerated().map { index, entry in
        WorkTimelineRenderRowReference(id: entry.id, index: index)
      }
      ForEach(renderRowReferences) { reference in
        let entry = renderEntries[reference.index]
        timelineRenderEntryView(
          for: entry,
          proxy: proxy,
          streamingAssistantMessageId: streamingMessageId,
          maxUserBubbleWidth: userBubbleWidth
        )
        .background {
          // Exactly one row carries this probe. It measures how far a prepend
          // pushed the reader's content down, which total content height cannot
          // do while the tail is also streaming.
          if let probeRowId, entry.id == probeRenderRowId {
            GeometryReader { geometry in
              Color.clear.preference(
                key: WorkChatPrependProbePreferenceKey.self,
                // Published in timeline-entry id space, which is what the anchor
                // compares against.
                value: WorkChatPrependProbeSample(
                  rowId: probeRowId,
                  y: geometry.frame(in: .named(workChatScrollCoordinateSpace)).minY
                )
              )
            }
          }
        }
      }
    }
  }

  /// What an empty timeline is allowed to claim.
  ///
  /// "No chat messages yet" is an assertion about the host's state, so it may
  /// only be shown once the transcript has actually been answered. While the
  /// request is in flight — or after it failed or was dropped — the pane says
  /// so instead, because a confident empty state there is indistinguishable
  /// from data loss to the person holding the phone.
  @ViewBuilder
  var transcriptEmptyStateSection: some View {
    switch transcriptLoadState {
    case .loading:
      VStack(spacing: 14) {
        ProgressView()
          .controlSize(.large)
          .tint(ADEColor.accent)
        Text("Loading transcript…")
          .font(.subheadline)
          .foregroundStyle(ADEColor.textSecondary)
          .multilineTextAlignment(.center)
      }
      .frame(maxWidth: .infinity)
      .adeGlassCard(cornerRadius: 20, padding: 24)
      .accessibilityElement(children: .ignore)
      .accessibilityLabel("Loading transcript")
      .accessibilityAddTraits(.updatesFrequently)
      .adeInspectable("Work.Chat.Transcript.Loading")
    case .failed(let message):
      ADEEmptyStateView(
        symbol: "exclamationmark.triangle",
        title: "Couldn’t load the transcript",
        message: workChatTranscriptFailureMessage(message)
      ) {
        if let onRetryTranscript {
          Button {
            onRetryTranscript()
          } label: {
            Label("Retry", systemImage: "arrow.clockwise")
              .font(.subheadline.weight(.semibold))
              .frame(minHeight: 44)
              .padding(.horizontal, 18)
              .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .foregroundStyle(ADEColor.accent)
          .accessibilityLabel("Retry loading the transcript")
        }
      }
      .adeInspectable("Work.Chat.Transcript.LoadFailed")
    case .idle:
      ADEEmptyStateView(
        symbol: "bubble.left.and.bubble.right",
        title: selectedSubagentTaskId == nil ? "No chat messages yet" : "No subagent transcript",
        message: selectedSubagentTaskId == nil
          ? (isLive ? "Send a message to start streaming the transcript." : "Reconnect to load the latest chat history from the machine.")
          : "This subagent did not publish detailed transcript output."
      )
    }
  }

  @ViewBuilder
  var streamingStatusSection: some View {
    if isStreamingTurn {
      WorkActivityIndicator(
        transcript: transcript,
        isStreaming: true,
        toolCount: turnToolActivity.active?.count ?? 0,
        onOpenActivity: turnToolActivity.active.map { _ in
          { toolActivitySheet = .active }
        }
      )
      .id("chat-streaming-status")
      .frame(maxWidth: .infinity, minHeight: 30, alignment: .leading)
    }
  }

  /// Single desktop-shaped composer card: text field on top, chip strip and
  /// send button on the bottom, everything wrapped in one rounded container
  /// with clear contrast against the chat background.
  func composerInset(proxy: ScrollViewProxy) -> some View {
    VStack(spacing: 10) {
      // The redundant ENDED/RUNNING status pill row has been retired. Chat
      // lifecycle controls live outside the composer; this space is reserved
      // for pending input and send feedback.
      if let claudeGoal = workClaudeGoal(snapshot: chatSummaryContext.claudeGoal, transcript: transcript) {
        WorkClaudeGoalPill(goal: claudeGoal)
      }

      // One chip per destination. Subagents used to get their own capsule that
      // opened the very same sheet as Chat Info; the count now covers both.
      let chatInfoCount = workChatInfoItemCount(
        subagents: subagentSnapshots,
        scheduledWork: scheduledWorkSnapshots
      )
      let showsChatInfoBadge = inputLockMessage == nil && chatInfoCount > 0 && onOpenChatInfo != nil
      let showsPrBadge = inputLockMessage == nil && prBadge != nil && onOpenPrDetails != nil
      if showsChatInfoBadge || showsPrBadge {
        // Horizontally scrollable so a future chip can never truncate the ones
        // beside it — it just scrolls out of reach instead.
        ScrollView(.horizontal, showsIndicators: false) {
          HStack(spacing: 8) {
            if showsChatInfoBadge, let onOpenChatInfo {
              WorkChatInfoActivePopup(count: chatInfoCount, onOpen: onOpenChatInfo)
            }
            if showsPrBadge, let prBadge, let onOpenPrDetails {
              WorkChatPrActivePopup(badge: prBadge, onOpen: onOpenPrDetails)
            }
          }
          .padding(.trailing, 8)
        }
        .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
        .frame(maxWidth: .infinity, alignment: .leading)
        .frame(height: workChatComposerChipRowHeight, alignment: .leading)
      }

      if !pendingSteers.isEmpty {
        WorkQueuedSteerStrip(
          steers: pendingSteers,
          drafts: $steerEditDrafts,
          busy: actionInFlight,
          isLive: isLive,
          turnActive: sessionStatus == "active",
          onCancel: { steerId in
            await runSessionAction {
              await onCancelSteer(steerId)
              steerEditDrafts.removeValue(forKey: steerId)
            }
          },
          onSaveEdit: { steerId, text in
            await runSessionAction {
              await onEditSteer(steerId, text)
              steerEditDrafts.removeValue(forKey: steerId)
            }
          },
          onDispatchInline: onDispatchSteerInline.map { dispatch in
            { steerId in
              await runSessionAction {
                await dispatch(steerId)
                steerEditDrafts.removeValue(forKey: steerId)
                scrollToLatest(proxy, animated: true)
                unreadBelowCount = 0
              }
            }
          },
          onDispatchInterrupt: onDispatchSteerInterrupt.map { dispatch in
            { steerId in
              await runSessionAction {
                await dispatch(steerId)
                steerEditDrafts.removeValue(forKey: steerId)
                scrollToLatest(proxy, animated: true)
                unreadBelowCount = 0
              }
            }
          }
        )
      }

      if let composerFeedback {
        Text(composerFeedback)
          .font(.caption2)
          .foregroundStyle(sessionStatus == "awaiting-input" ? ADEColor.warning : ADEColor.textMuted)
          .frame(maxWidth: .infinity, alignment: .center)
          .padding(.horizontal, sessionStatus == "awaiting-input" ? 10 : 0)
          .padding(.vertical, sessionStatus == "awaiting-input" ? 7 : 0)
          .background(
            Group {
              if sessionStatus == "awaiting-input" {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                  .fill(ADEColor.warning.opacity(0.08))
              }
            }
          )
      }

      consolidatedPendingStripSection

      if let recovery = workAvailableQueueRecovery(from: transcript),
         let onRestoreCancelledQueue {
        WorkQueueRecoveryBanner(
          recovery: recovery,
          restoring: actionInFlight,
          enabled: !hostUnreachable && !actionInFlight,
          onRestore: {
            await runSessionAction {
              await onRestoreCancelledQueue(recovery.recoveryId)
            }
          }
        )
      }

      if chatSummaryContext.spawnKind == .subagent,
         let parentId = chatSummaryContext.orchestrationParentSessionId,
         !parentId.isEmpty,
         chatSummaryContext.subagentTakeoverPromptShownAt == nil,
         onTakeOverSubagent != nil || onKeepReportingSubagent != nil {
        WorkSubagentTakeoverBanner(
          parentTitle: chatSummaryContext.parentTitle,
          takeOverEnabled: onTakeOverSubagent != nil && !actionInFlight && !hostUnreachable,
          keepReportingEnabled: onKeepReportingSubagent != nil && !actionInFlight && !hostUnreachable,
          onTakeOver: {
            guard let onTakeOverSubagent else { return }
            await runSessionAction { await onTakeOverSubagent() }
          },
          onKeepReporting: {
            guard let onKeepReportingSubagent else { return }
            await runSessionAction { await onKeepReportingSubagent() }
          }
        )
      }

      WorkChatComposerCard(
        chatSummary: chatSummaryContext,
        sessionId: session.id,
        isPersonalChat: isPersonalChat,
        laneId: session.laneId,
        dictationTargetId: "work-chat:\(session.id)",
        awaitingInputGate: hasPendingInputGate,
        composerPlaceholder: composerPlaceholderText,
        canCompose: canCompose,
        canSend: canSend && !composerSettingMutationInFlight,
        attachmentsAvailable: attachmentsAvailable,
        canUploadAttachments: isLive && attachmentsAvailable,
        sending: sending && !sendWillQueue,
        settingsMutationInFlight: composerSettingMutationInFlight,
        codexFastModeOverride: pendingCodexFastMode,
        composerDraftRestore: composerDraftRestore,
        draftPersistenceKey: WorkComposerDraftStore.chatKey(sessionId: session.id),
        compact: compactComposer,
        // Show Stop while a live turn has current transcript activity. The
        // broader live hint can lag after `done`; this stricter gate keeps the
        // composer from showing Stop after the completed-turn separator appears.
        showInterrupt: shouldShowInterruptControl,
        activeSendModesAvailable: activeSendModesAvailable,
        queueAwareStopAvailable: queueAwareStopAvailable,
        interruptInFlight: actionInFlight,
        onInterrupt: { mode in
          await runSessionAction {
            await onInterrupt(mode)
          }
        },
        onOpenModelPicker: !chatSummaryContext.isAvailable
          || selectedSubagentTaskId != nil
          || (isPersonalChat && (
            !personalModelCatalogAvailable || !personalSessionUpdatesAvailable
          ))
          ? nil
          : { modelPickerPresented = true },
        onSelectRuntimeMode: !chatSummaryContext.isAvailable
          || (isPersonalChat && !personalSessionUpdatesAvailable)
          ? nil
          : { mode in
          runComposerSettingMutation {
            await onSelectRuntimeMode(mode)
          }
        },
        onSend: onSend,
        onSent: {
          scrollToLatest(proxy, animated: true)
        }
      )
    }
    .padding(.horizontal, compactComposer ? 12 : 16)
    .padding(.top, 4)
    .padding(.bottom, 0)
  }

  /// Extracted from `body` so the type-checker sees two bounded
  /// expressions instead of one ~300-line chain; the x86_64 simulator
  /// slice hit the "unable to type-check in reasonable time" ceiling
  /// on the combined expression.
  @ViewBuilder
  private func transcriptScrollView(proxy: ScrollViewProxy) -> some View {
        ScrollView {
          LazyVStack(alignment: .leading, spacing: 14) {
            sessionOverviewSection
            timelineSection(proxy: proxy)
            streamingStatusSection

            Color.clear
              .frame(height: workChatContentBottomGutterHeight + workChatBottomAnchorSpacerHeight)
              .id("chat-end")
              .transaction { transaction in
                transaction.animation = nil
              }
          }
          .padding(16)
          .frame(
            maxWidth: .infinity,
            minHeight: max(scrollViewportHeight, 0),
            alignment: transcriptContentAlignment
          )
          .modifier(
            WorkChatTranscriptEnvironmentModifier(
              provider: chatSummaryContext.provider,
              modelId: transcriptModelId,
              modelLabel: transcriptModelLabel,
              laneId: session.laneId,
              requestedCwd: chatSummaryContext.requestedCwd,
              isPersonalChat: isPersonalChat
            )
          )
        }
          .frame(maxWidth: .infinity, maxHeight: .infinity)
          .layoutPriority(1)
          .clipped()
          .scrollIndicators(.hidden)
          .scrollDismissesKeyboard(.interactively)
          // Open at the tail without waiting for a layout pass. Scoped to
          // `.initialOffset` on purpose: the `.sizeChanges` anchor would keep
          // the bottom pinned as content grows, which is exactly the total-height
          // correction the prepend machinery exists to avoid. The retry pin
          // stays as belt-and-braces for the hydration that lands afterwards.
          .defaultScrollAnchor(.bottom, for: .initialOffset)
          .scrollPosition($scrollPosition)
          .onScrollPhaseChange { _, phase in
            let userDriven = workChatScrollPhaseIsUserDriven(phase)
            guard timelineScrollPhaseUserDriven != userDriven else { return }
            timelineScrollPhaseUserDriven = userDriven
            timelineDragActive = userDriven
            if userDriven {
              // Let the native ScrollView own the whole interaction. The old
              // zero-distance simultaneous DragGesture competed with it and
              // could leave a tail-pinned chat one gesture away from moving.
              cancelPendingInitialBottomPinForUserScroll()
              releaseBottomStickinessForUserScroll(reason: "scroll-phase")
              return
            }
            // A fling that ended may have left a prepend correction waiting.
            restorePrependAnchorIfNeeded(probed: lastPrependProbeSample)
          }
          .onScrollGeometryChange(for: WorkChatScrollGeometrySample.self) { geometry in
            WorkChatScrollGeometrySample(geometry)
          } action: { _, sample in
            // Fires per scroll frame. Everything here is O(1) and writes to a
            // reference box or to state that only changes at a threshold — no
            // list scans, and nothing that invalidates the transcript per frame.
            scrollMetrics.offsetY = sample.offsetY
            scrollMetrics.distanceFromTop = sample.distanceFromTop
            scrollMetrics.scrollableHeight = sample.scrollableHeight
            guard sample.containerHeight > 1 else { return }
            updateBottomStickiness(distanceFromBottom: sample.distanceFromBottom, proxy: proxy)
            continueAutomaticOlderHistoryIfNeeded()
            requestOlderHistoryIfScrolledNearTop(distanceFromTop: sample.distanceFromTop)
          }
          // Content SIZE changes only — this observer never fires while the
          // reader is merely scrolling, which is what keeps the tail scan in
          // `resolvePendingInitialBottomPinAfterLayout` off the scroll path.
          .onScrollGeometryChange(for: WorkChatContentSizeSample.self) { geometry in
            WorkChatContentSizeSample(geometry)
          } action: { _, sample in
            if transcriptContentFitsViewport != sample.contentFitsViewport {
              transcriptContentFitsViewport = sample.contentFitsViewport
            }
            resolvePendingInitialBottomPinAfterLayout(proxy, reason: "content-size")
          }
          .coordinateSpace(name: workChatScrollCoordinateSpace)
          .background(
            GeometryReader { geometry in
              Color.clear
                .preference(
                  key: WorkChatViewportHeightPreferenceKey.self,
                  value: geometry.size.height
                )
                .preference(
                  key: WorkChatViewportWidthPreferenceKey.self,
                  value: geometry.size.width
                )
            }
          )
          .overlay(alignment: .top) {
            WorkChatNavigationBackdrop()
          }
          .overlay(alignment: .bottomTrailing) {
            if unreadBelowCount > 0 || !isNearBottom {
              WorkJumpToLatestPill(count: unreadBelowCount) {
                isNearBottom = true
                if timelineDragActive {
                  timelineDragActive = false
                }
                scrollToLatest(proxy, animated: true)
                unreadBelowCount = 0
              }
              .padding(.trailing, 16)
              .padding(.bottom, jumpToLatestPillBottomPadding)
              .transition(.move(edge: .trailing).combined(with: .opacity))
            }
          }
  }

  /// Layout half of the chat column (structure + geometry preferences).
  /// Split from `body` so the type-checker sees bounded expressions; the
  /// behavior chain (onChange/sheet/task) stays in `body`.
  @ViewBuilder
  private func chatColumn(proxy: ScrollViewProxy) -> some View {
      VStack(spacing: 0) {
        transcriptScrollView(proxy: proxy)

        composerInset(proxy: proxy)
          .fixedSize(horizontal: false, vertical: true)
          .background(alignment: .bottom) {
            WorkChatComposerBackdrop()
          }
          .background(
            GeometryReader { geometry in
              Color.clear.preference(
                key: WorkChatComposerLayoutHeightPreferenceKey.self,
                value: geometry.size.height
              )
            }
          )
      }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(workChatCanvasBackground.ignoresSafeArea())
        .adeNavigationGlass()
        .onPreferenceChange(WorkChatViewportHeightPreferenceKey.self) { height in
          guard height > 0, abs(scrollViewportHeight - height) > 1 else { return }
          scrollViewportHeight = height
        }
        .onPreferenceChange(WorkChatViewportWidthPreferenceKey.self) { width in
          guard width > 0, abs(scrollViewportWidth - width) > 1 else { return }
          scrollViewportWidth = width
        }
        .onPreferenceChange(WorkChatPrependProbePreferenceKey.self) { sample in
          // Recorded into a reference box, not @State: this fires on every
          // layout pass and must not invalidate the transcript.
          // Keep the last real measurement rather than clearing on nil. The
          // probed row can be recycled out of the LazyVStack while an older-page
          // request is in flight, and forgetting it there means the page lands
          // with no anchor to arm and pushes whatever the reader moved on to.
          if let sample {
            scrollMetrics.probeRowId = sample.rowId
            scrollMetrics.probeRowY = sample.y
          }
          restorePrependAnchorIfNeeded(probed: sample)
        }
        .onPreferenceChange(WorkChatComposerLayoutHeightPreferenceKey.self) { height in
          guard height > 0, abs(composerLayoutHeight - height) > 1 else { return }
          composerLayoutHeight = height
        }
  }

  /// Older-history scroll-back trigger, driven by the shared scroll sample.
  @MainActor
  private func requestOlderHistoryIfScrolledNearTop(distanceFromTop: CGFloat) {
    if distanceFromTop > workChatOlderHistoryRearmDistance {
      if !olderHistoryTriggerArmed {
        olderHistoryTriggerArmed = true
      }
      // Scrolling back down past the re-arm distance retires the previous
      // failure. A dropped history page is almost always a transient host
      // timeout, and latching it until someone finds the retry row means the
      // next approach to the top does nothing at all — the transcript reads as
      // frozen. Clearing it here keeps the retry gesture the same one the
      // reader already makes, and cannot spin: a fresh attempt still costs a
      // full round trip past `workChatOlderHistoryRearmDistance`.
      if olderHistoryLoadError != nil {
        olderHistoryLoadError = nil
      }
    }
    guard workChatShouldRequestOlderHistory(
      distanceFromTop: distanceFromTop,
      triggerArmed: olderHistoryTriggerArmed,
      loading: olderHistoryLoadInFlight,
      hasError: olderHistoryLoadError != nil,
      hasBufferedEntries: hiddenTimelineCount > 0,
      hasHostHistory: canRequestOlderTranscriptHistory
    ) else { return }
    olderHistoryTriggerArmed = false
    requestEarlierTimelineEntries(automatically: true)
  }

  /// Timeline/scroll change handlers, split from `body` for type-checker budget.
  private func timelineScrollHandlers<V: View>(_ content: V, proxy: ScrollViewProxy) -> some View {
    content
        .onChange(of: timeline.count) { oldCount, newCount in
          let previousTailId = lastTimelineTailId
          lastTimelineTailId = timeline.last?.id
          let delta = newCount - oldCount
          guard delta > 0 else { return }
          // Older-page prepends grow the timeline above the viewport — the
          // newest entry stays put. Don't autoscroll to the bottom or flag
          // the prepended entries as "new messages below".
          if let previousTailId, previousTailId == timeline.last?.id {
            return
          }
          if isNearBottom {
            pinToLatestAfterLayout(proxy, reason: "timeline-growth")
          } else {
            let nextCount = unreadBelowCount + delta
            if unreadBelowCount == 0 {
              withAnimation(ADEMotion.standard(reduceMotion: reduceMotion)) {
                unreadBelowCount = nextCount
              }
            } else {
              unreadBelowCount = nextCount
            }
          }
        }
        .onChange(of: timeline.last?.id) { oldTailId, newTailId in
          guard oldTailId != newTailId else { return }
          lastTimelineTailId = newTailId
          guard oldTailId != nil, newTailId != nil, isNearBottom else { return }
          pinToLatestAfterLayout(proxy, reason: "timeline-tail")
        }
        .onChange(of: workSubagentRunningCount(subagentSnapshots)) { _, _ in
          guard isNearBottom else { return }
          pinToLatestAfterLayout(proxy, reason: "subagent-active-count")
        }
        .onChange(of: timelineLayoutPinToken) { _, _ in
          if pendingInitialBottomPinSessionId == session.id {
            forcePinToLatestAfterLayout(proxy, reason: "initial-timeline-layout")
          } else {
            pinToLatestAfterLayout(proxy, reason: "timeline-layout")
          }
        }
        .onChange(of: isNearBottom) { _, nearBottom in
          guard nearBottom, unreadBelowCount > 0 else { return }
          withAnimation(ADEMotion.quick(reduceMotion: reduceMotion)) {
            unreadBelowCount = 0
          }
        }
        // The turn ending is the single collapse trigger. Dropping every
        // override here is what makes the finished turn fold to one line each,
        // and what stops a "keep this shut while it runs" tap from outliving
        // the run it was about.
        .onChange(of: isStreamingTurn) { wasStreaming, isStreaming in
          guard wasStreaming, !isStreaming else { return }
          cardExpansion.clearForTurnEnd()
        }
  }

  /// Session lifecycle + input-recovery handlers, split from `body` for type-checker budget.
  private func sessionLifecycleHandlers<V: View>(_ content: V, proxy: ScrollViewProxy) -> some View {
    content
        .onAppear {
          prepareScrollStateForCurrentSessionIfNeeded(reason: "appear")
          if transcript.isEmpty && fallbackEntries.isEmpty {
            scheduleTimelineSnapshotRebuild()
          } else {
            rebuildTimelineSnapshot()
          }
          // Seed the blocking-input tracker so an already-open gate on first
          // render doesn't re-fire the haptic, but a gate that arrives later does.
          lastBlockingPendingInputId = blockingPendingInputId
        }
        .task(id: timelineInputRecoveryKey) {
          recoverEmptyTimelineSnapshotIfNeeded()
        }
        .loadPluginContributions(.session, into: $pluginContributions)
        .onDisappear {
          olderHistoryLoadTask?.cancel()
          olderHistoryLoadTask = nil
          olderHistoryLoadInFlight = false
          olderHistoryLoadError = nil
          olderHistoryAutomaticContinuationPending = false
          olderHistoryTriggerArmed = true
          cancelScheduledTimelineSnapshotRebuild()
        }
        .onChange(of: chatSummaryTimelineKey) { _, _ in
          refreshTimelinePresentation()
        }
        .onChange(of: chatSummaryContext.effectiveFastMode) { _, newValue in
          if let pendingCodexFastMode, pendingCodexFastMode == newValue {
            self.pendingCodexFastMode = nil
          }
        }
        .onChange(of: session.id) { _, _ in
          pendingCodexFastMode = nil
          lastBlockingPendingInputId = nil
          blockingPendingHapticToken = 0
          lastLiveQuotaCardId = nil
          quotaCardHapticToken = 0
          optimisticallyAnsweredInputIds.removeAll()
          collapsedPendingInputId = nil
          assistantLineBudgets.removeAll()
          assistantBudgetFloors.removeAll()
          assistantHeadAnchorOverrides.removeAll()
          composerSettingMutationInFlight = false
          composerSettingMutationGeneration &+= 1
          resetScrollStateForCurrentSession(reason: "session-change")
          cancelScheduledTimelineSnapshotRebuild()
          timelineSnapshot = .empty
          timelinePresentation = .empty
          turnToolActivity = WorkTurnToolActivityIndex(completedByTurnId: [:], active: nil)
          toolActivitySheet = nil
          scheduleTimelineSnapshotRebuild()
        }
        .onChange(of: transcript) { _, _ in
          if timelineSnapshot.timeline.isEmpty, !transcript.isEmpty {
            cancelScheduledTimelineSnapshotRebuild()
            rebuildTimelineSnapshot()
          } else {
            scheduleTimelineSnapshotRebuild()
          }
        }
        .onChange(of: fallbackEntries) { _, _ in
          guard transcript.isEmpty else {
            return
          }
          if timelineSnapshot.timeline.isEmpty, !fallbackEntries.isEmpty {
            cancelScheduledTimelineSnapshotRebuild()
            rebuildTimelineSnapshot()
          } else {
            scheduleTimelineSnapshotRebuild()
          }
        }
        .onChange(of: artifacts) { _, _ in
          scheduleTimelineSnapshotRebuild()
        }
        .onChange(of: localEchoMessages) { _, _ in
          // The user's own message is the one timeline change that must not wait
          // out the coalescing debounce — it has to be on screen by the frame
          // after the tap.
          guard !applyLocalEchoTailImmediatelyIfPossible() else { return }
          scheduleTimelineSnapshotRebuild()
        }
        .onChange(of: blockingPendingInputId) { _, newId in
          handleBlockingPendingInputChange(newId)
        }
        .onChange(of: liveClaudeQuotaCardId) { _, newId in
          handleLiveQuotaCardChange(newId)
        }
  }

  /// Haptics and sheet presenters, split from `body` for type-checker budget.
  private func feedbackAndSheets<V: View>(_ content: V) -> some View {
    content
        .sensoryFeedback(.impact(weight: .light), trigger: blockingPendingHapticToken)
        .sensoryFeedback(.impact(weight: .light), trigger: quotaCardHapticToken)
        .environment(\.workOutputViewer, outputViewer)
        .fullScreenCover(item: $outputViewer.request) { request in
          WorkOutputViewerScreen(request: request)
        }
        .sheet(isPresented: $artifactDrawerPresented) {
          WorkArtifactDrawerSheet(
            artifacts: artifacts,
            artifactContent: $artifactContent,
            isRefreshing: artifactRefreshInFlight,
            refreshError: artifactRefreshError,
            onRefresh: onRefreshArtifacts,
            onLoadArtifact: onLoadArtifact
          )
          .presentationDetents([.medium, .large])
          .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $modelPickerPresented) {
          let currentModelId = chatSummaryContext.currentModelId
          WorkModelPickerSheet(
            currentModelId: currentModelId,
            currentProvider: chatSummaryContext.provider,
            currentReasoningEffort: chatSummaryContext.reasoningEffort,
            currentCodexFastMode: chatSummaryContext.effectiveFastMode,
            lanes: lanes,
            commandScope: isPersonalChat ? .personal : .project,
            isBusy: modelUpdateInFlight,
            onSelect: { option, pickedReasoning, _, pickedFastMode in
              Task { @MainActor in
                modelUpdateInFlight = true
                defer { modelUpdateInFlight = false }
                let wasCurrentModel = workModelIdsEquivalent(option.id, currentModelId)
                if !wasCurrentModel {
                  await onSelectModel(option.id)
                }
                guard !Task.isCancelled else { return }
                let currentReasoning = chatSummaryContext.reasoningEffort
                let nextReasoning = pickedReasoning ?? ""
                if nextReasoning != currentReasoning {
                  await onSelectEffort(nextReasoning)
                }
                guard !Task.isCancelled else { return }
                if chatSummaryContext.effectiveFastMode != pickedFastMode {
                  _ = await onSelectCodexFastMode(pickedFastMode)
                }
              }
            }
          )
        }
        .sheet(item: $toolActivitySheet) { selection in
          if let group = toolActivityGroup(for: selection) {
            WorkTurnActivitySheet(group: group)
              .presentationDetents([.medium, .large])
              .presentationDragIndicator(.visible)
          }
        }
  }

  var body: some View {
    ScrollViewReader { proxy in
      feedbackAndSheets(
        sessionLifecycleHandlers(
          timelineScrollHandlers(chatColumn(proxy: proxy), proxy: proxy),
          proxy: proxy
        )
      )
    }
  }
}

/// Lightweight identity passed to SwiftUI's `ForEach` for the transcript.
///
/// `WorkTimelineRenderEntry` intentionally carries the render payload, which
/// can include an entire assistant response and its streaming classifier. If
/// `ForEach` iterates that value type directly, SwiftUI copies the payload just
/// to read `Identifiable.id` while reconciling rows. A long chat can therefore
/// spend its layout budget copying markdown instead of drawing the viewport.
/// Keep the heavy array captured once and reconcile only these tiny references.
private struct WorkTimelineRenderRowReference: Identifiable {
  let id: String
  let index: Int
}

private extension WorkChatSessionView {
  func toolActivityGroup(for selection: WorkToolActivitySheetSelection) -> WorkToolGroupModel? {
    switch selection {
    case .active:
      return turnToolActivity.active
    case .completed(let turnId):
      return turnToolActivity.completedByTurnId[turnId]
    }
  }
}

func workLoadedArtifactContentRenderSignature(_ content: [String: WorkLoadedArtifactContent]) -> Int {
  var hasher = Hasher()
  hasher.combine(content.count)
  for key in content.keys.sorted() {
    hasher.combine(key)
    guard let value = content[key] else { continue }
    switch value {
    case .image(let image):
      hasher.combine("image")
      hasher.combine(Int(image.size.width.rounded()))
      hasher.combine(Int(image.size.height.rounded()))
      hasher.combine(Int(image.scale.rounded()))
    case .video(let url):
      hasher.combine("video")
      hasher.combine(url.absoluteString)
    case .remoteURL(let url):
      hasher.combine("remoteURL")
      hasher.combine(url.absoluteString)
    case .text(let text):
      hasher.combine("text")
      hasher.combine(text.utf8.count)
      hasher.combine(text.hashValue)
    case .error(let message):
      hasher.combine("error")
      hasher.combine(message)
    }
  }
  return hasher.finalize()
}

func workChatEnvelopeListRenderSignature(_ transcript: [WorkChatEnvelope]) -> Int {
  var hasher = Hasher()
  hasher.combine(transcript.count)
  for envelope in transcript {
    hasher.combine(workChatEnvelopeMergeKey(envelope))
    hasher.combine(envelope.sequence)
    hasher.combine(envelope.timestamp)
    if case .assistantText(let text, _, _) = envelope.event {
      hasher.combine(text.utf8.count)
      hasher.combine(text.hashValue)
    }
  }
  return hasher.finalize()
}

func workFallbackEntriesRenderSignature(_ entries: [AgentChatTranscriptEntry]) -> Int {
  var hasher = Hasher()
  hasher.combine(entries.count)
  for entry in entries {
    hasher.combine(workTranscriptEntryIdentity(entry))
  }
  return hasher.finalize()
}

func workArtifactSummariesRenderSignature(_ artifacts: [ComputerUseArtifactSummary]) -> Int {
  var hasher = Hasher()
  hasher.combine(artifacts.count)
  for artifact in artifacts {
    hasher.combine(artifact.id)
    hasher.combine(artifact.uri)
    hasher.combine(artifact.title)
    hasher.combine(artifact.reviewState)
    hasher.combine(artifact.workflowState)
  }
  return hasher.finalize()
}

func workPendingSteersRenderSignature(_ steers: [WorkPendingSteerModel]) -> Int {
  var hasher = Hasher()
  hasher.combine(steers.count)
  for steer in steers {
    hasher.combine(steer.id)
    hasher.combine(steer.text.utf8.count)
    hasher.combine(steer.text.hashValue)
    hasher.combine(steer.turnId)
    hasher.combine(steer.timestamp)
  }
  return hasher.finalize()
}

func workLocalEchoMessagesRenderSignature(_ messages: [WorkLocalEchoMessage]) -> Int {
  var hasher = Hasher()
  hasher.combine(messages.count)
  for message in messages {
    hasher.combine(message.id)
    hasher.combine(message.text.utf8.count)
    hasher.combine(message.text.hashValue)
    hasher.combine(message.timestamp)
    hasher.combine(message.deliveryState)
    hasher.combine(message.attachments?.count ?? 0)
    for attachment in message.attachments ?? [] {
      hasher.combine(attachment.path)
      hasher.combine(attachment.type)
      hasher.combine(attachment.url)
    }
  }
  return hasher.finalize()
}

func workSubagentSnapshotsRenderSignature(_ snapshots: [WorkSubagentSnapshot]) -> Int {
  var hasher = Hasher()
  hasher.combine(snapshots.count)
  for snapshot in snapshots {
    hasher.combine(snapshot.taskId)
    hasher.combine(snapshot.agentId)
    hasher.combine(snapshot.agentType)
    hasher.combine(snapshot.parentToolUseId)
    hasher.combine(snapshot.description)
    hasher.combine(snapshot.background)
    hasher.combine(snapshot.status)
    hasher.combine(snapshot.lastToolName)
    hasher.combine(snapshot.latestSummary)
    hasher.combine(snapshot.turnId)
    hasher.combine(snapshot.startedAt)
    hasher.combine(snapshot.updatedAt)
    hasher.combine(snapshot.spawnKind.map { String(describing: $0) })
  }
  return hasher.finalize()
}

func workScheduledWorkSnapshotsRenderSignature(_ snapshots: [WorkScheduledWorkSnapshot]) -> Int {
  var hasher = Hasher()
  hasher.combine(snapshots.count)
  for snapshot in snapshots {
    hasher.combine(snapshot.id)
    hasher.combine(snapshot.kind)
    hasher.combine(snapshot.status)
    hasher.combine(snapshot.origin)
    hasher.combine(snapshot.title)
    hasher.combine(snapshot.summary)
    hasher.combine(snapshot.prompt)
    hasher.combine(snapshot.reason)
    hasher.combine(snapshot.cron)
    hasher.combine(snapshot.nextRunAt)
    hasher.combine(snapshot.lastRunAt)
    hasher.combine(snapshot.recurring)
    hasher.combine(snapshot.durable)
    hasher.combine(snapshot.sourceToolUseId)
    hasher.combine(snapshot.sourceTaskId)
    hasher.combine(snapshot.turnId)
    hasher.combine(snapshot.error)
    hasher.combine(snapshot.createdAt)
    hasher.combine(snapshot.updatedAt)
  }
  return hasher.finalize()
}

func workLaneListRenderSignature(_ lanes: [LaneSummary]) -> Int {
  var hasher = Hasher()
  hasher.combine(lanes.count)
  for lane in lanes {
    hasher.combine(lane.id)
    hasher.combine(lane.name)
    hasher.combine(lane.color)
    hasher.combine(lane.icon)
    hasher.combine(lane.status.dirty)
    hasher.combine(lane.status.ahead)
    hasher.combine(lane.status.behind)
  }
  return hasher.finalize()
}

/// Hard ceiling for a pending-input card, given the height available to the
/// whole chat surface. Always leaves room for the composer plus a slice of
/// transcript — a gate that covers the entire screen reads as a modal takeover
/// and hides the Send button. Long content scrolls inside the card instead of
/// growing it.
///
/// If a card's irreducible chrome still exceeds this on a small phone with the
/// keyboard up, the overflow is absorbed by the transcript, not the composer:
/// the composer inset is `fixedSize(vertical:)` and the transcript scroll view
/// is the flexible sibling, so Send/Decline stay on screen either way. That
/// ordering is the actual guarantee — this number just keeps the common case
/// from getting there.
///
/// A free function rather than a view property so previews exercise the same
/// arithmetic the app uses; the numbers had drifted into three hand-copied
/// literals otherwise.
func workPendingInputMaxHeight(chatSurfaceHeight: CGFloat) -> CGFloat {
  // Roughly the composer card's own height in its resting single-line state.
  // Measuring it for real is not an option: `composerLayoutHeight` includes the
  // strip we are sizing, so reading it here would be circular.
  let composerReserve: CGFloat = 110
  let available = max(0, chatSurfaceHeight - composerReserve)
  return max(160, min(available * 0.82, chatSurfaceHeight * 0.62))
}

/// Budget for the inline-in-transcript question card, which is bounded by the
/// transcript viewport rather than the whole surface (the composer sits below
/// that viewport either way, so there is nothing to reserve for it). Kept beside
/// `workPendingInputMaxHeight` so the two rules' divergence is deliberate and
/// visible instead of an inline literal drifting on its own.
func workInlinePendingInputMaxHeight(transcriptViewportHeight: CGFloat) -> CGFloat {
  max(240, transcriptViewportHeight * 0.62)
}

private struct WorkChatViewportHeightPreferenceKey: PreferenceKey {
  static var defaultValue: CGFloat = 0

  static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
    let next = nextValue()
    if next > 0 { value = next }
  }
}


private struct WorkChatViewportWidthPreferenceKey: PreferenceKey {
  static var defaultValue: CGFloat = 0

  static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
    let next = nextValue()
    if next > 0 { value = next }
  }
}

private struct WorkChatComposerLayoutHeightPreferenceKey: PreferenceKey {
  static var defaultValue: CGFloat = 0

  static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
    let next = nextValue()
    if next > 0 { value = next }
  }
}

/// Flat transcript canvas. Desktop parity: a single dark #0f0f11 fill behind
/// the agent prose — no card, no gradient. Light mode keeps the app's warm
/// paper tone so the chat doesn't look out of place there.
let workChatCanvasBackground = Color(uiColor: UIColor { traits in
  traits.userInterfaceStyle == .dark
    ? UIColor(red: 0x0f / 255.0, green: 0x0f / 255.0, blue: 0x11 / 255.0, alpha: 1)
    : UIColor(red: 0xf5 / 255.0, green: 0xf3 / 255.0, blue: 0xf0 / 255.0, alpha: 1)
})

private struct WorkChatNavigationBackdrop: View {
  var body: some View {
    LinearGradient(
      colors: [
        workChatCanvasBackground,
        workChatCanvasBackground.opacity(0.96),
        workChatCanvasBackground.opacity(0)
      ],
      startPoint: .top,
      endPoint: .bottom
    )
    .frame(height: 112)
    .ignoresSafeArea(edges: .top)
    .allowsHitTesting(false)
  }
}

private struct WorkChatComposerBackdrop: View {
  var body: some View {
    LinearGradient(
      colors: [
        workChatCanvasBackground.opacity(0.98),
        workChatCanvasBackground.opacity(0.94),
        workChatCanvasBackground
      ],
      startPoint: .top,
      endPoint: .bottom
    )
    .ignoresSafeArea(edges: .bottom)
    .allowsHitTesting(false)
  }
}

struct WorkTimelinePresentation: Equatable {
  let visibleEntries: [WorkTimelineEntry]
  let renderEntries: [WorkTimelineRenderEntry]
  let timelineCount: Int
  let timelineFirstId: String?
  let timelineLastId: String?
  let hiddenCount: Int
  let signature: Int

  static let empty = WorkTimelinePresentation(
    visibleEntries: [],
    renderEntries: [],
    timelineCount: 0,
    timelineFirstId: nil,
    timelineLastId: nil,
    hiddenCount: 0,
    signature: 0
  )

  static func == (lhs: WorkTimelinePresentation, rhs: WorkTimelinePresentation) -> Bool {
    lhs.signature == rhs.signature
  }
}

private func makeWorkTimelinePresentation(
  timeline: [WorkTimelineEntry],
  visibleCount: Int,
  chatSummary: WorkChatSummaryRenderContext,
  transcript: [WorkChatEnvelope],
  assistantPreviewCache: WorkAssistantPreviewCache,
  assistantLineBudgets: [String: Int],
  assistantBudgetFloors: inout [String: Int],
  assistantHeadAnchorOverrides: Set<String>,
  streamingAssistantMessageId: String?
) -> WorkTimelinePresentation {
  let rawVisibleEntries = visibleWorkTimelineEntries(from: timeline, visibleCount: visibleCount)
  let visibleEntriesWithSeparators = injectWorkTurnSeparators(
    into: rawVisibleEntries,
    provider: chatSummary.provider,
    model: chatSummary.model,
    modelId: chatSummary.modelId,
    transcript: transcript
  )
  var resolvedLineBudgets: [String: Int] = [:]
  let visibleEntries = workTimelineEntriesWithAssistantPreviews(
    visibleEntriesWithSeparators,
    cache: assistantPreviewCache,
    assistantLineBudgets: assistantLineBudgets,
    assistantBudgetFloors: &assistantBudgetFloors,
    assistantHeadAnchorOverrides: assistantHeadAnchorOverrides,
    resolvedLineBudgets: &resolvedLineBudgets,
    tailAnchoredAssistantMessageId: workLatestAssistantMessageId(in: timeline)
  )
  let renderEntries = workTimelineRenderEntries(
    from: visibleEntries,
    streamingAssistantMessageId: streamingAssistantMessageId,
    splitAssistantMessageId: workLatestAssistantMessageId(in: timeline),
    assistantLineBudgets: assistantLineBudgets,
    resolvedAssistantLineBudgets: resolvedLineBudgets
  )
  let hiddenCount = max(timeline.count - rawVisibleEntries.count, 0)
  return WorkTimelinePresentation(
    visibleEntries: visibleEntries,
    renderEntries: renderEntries,
    timelineCount: timeline.count,
    timelineFirstId: timeline.first?.id,
    timelineLastId: timeline.last?.id,
    hiddenCount: hiddenCount,
    signature: workTimelinePresentationSignature(
      timelineCount: timeline.count,
      timelineFirstId: timeline.first?.id,
      timelineLastId: timeline.last?.id,
      visibleEntries: visibleEntries,
      renderEntries: renderEntries,
      hiddenCount: hiddenCount
    )
  )
}

func workTimelineVisibleCountAfterHistoryPrepend(
  currentVisibleCount: Int,
  prependedCount: Int
) -> Int {
  max(0, currentVisibleCount) + min(max(0, prependedCount), workTimelinePageSize)
}

private func workTimelinePresentationSignature(
  timelineCount: Int,
  timelineFirstId: String?,
  timelineLastId: String?,
  visibleEntries: [WorkTimelineEntry],
  renderEntries: [WorkTimelineRenderEntry],
  hiddenCount: Int
) -> Int {
  var hasher = Hasher()
  hasher.combine(hiddenCount)
  hasher.combine(timelineCount)
  hasher.combine(timelineFirstId)
  hasher.combine(timelineLastId)
  hasher.combine(visibleEntries.count)
  hasher.combine(visibleEntries.first?.id)
  hasher.combine(visibleEntries.last?.id)
  hasher.combine(renderEntries.count)
  for entry in renderEntries {
    hasher.combine(entry.id)
    hasher.combine(entry.sourceEntryId)
    hasher.combine(entry.timestamp)
    switch entry.payload {
    case .entry(let timelineEntry):
      hasher.combine(timelineEntry.id)
      hasher.combine(timelineEntry.timestamp)
      hasher.combine(timelineEntry.rank)
      if case .message(let message) = timelineEntry.payload {
        hasher.combine(message.id)
        hasher.combine(message.role)
        hasher.combine(message.steerId)
        hasher.combine(message.deliveryState)
        hasher.combine(message.processed)
        hasher.combine(message.unprocessedResolution?.action)
        hasher.combine(message.unprocessedResolution?.state)
        hasher.combine(message.unprocessedResolution?.resolvedAt)
        workTimelineCombineMessageTextSignature(message, into: &hasher)
        if let preview = message.assistantPreview {
          // A preview is a pure function of (message text, anchor, budget), and
          // the text is already in this hash. Its shape is enough to separate
          // two previews of the same message — no need to hash the slice, which
          // is O(message) on every refresh.
          hasher.combine(preview.isTruncated)
          hasher.combine(preview.anchor)
          hasher.combine(preview.visibleLineCount)
          hasher.combine(preview.totalLineCount)
          hasher.combine(preview.visibleCharacterCount)
          hasher.combine(preview.usesMonospacedRendering)
        }
      }
    case .assistantMarkdownBlock(let model):
      hasher.combine(model.id)
      hasher.combine(model.messageId)
      hasher.combine(model.block.id)
      // The block's own precomputed digest, not a rebuilt `kind.cacheKey`:
      // building that key allocates a full copy of the block's text, once per
      // block, on every presentation refresh.
      hasher.combine(model.block.digest)
      hasher.combine(model.isStreamingTail)
      hasher.combine(model.codeSource?.markdownIdentity)
    case .assistantMonospaced(let model):
      hasher.combine(model.id)
      hasher.combine(model.messageId)
      // Digest of the source message plus the size of the slice taken from it:
      // together these change whenever the rendered text does, without hashing
      // the (potentially very long) slice itself.
      hasher.combine(model.sourceDigest)
      hasher.combine(model.text.utf8.count)
      hasher.combine(model.accessibilityLabel)
    case .assistantControls(let model):
      hasher.combine(model.id)
      hasher.combine(model.messageId)
      hasher.combine(model.summaryText)
      hasher.combine(model.visibleLineCount)
      hasher.combine(model.totalLineCount)
      hasher.combine(model.canShowMore)
      hasher.combine(model.nextLineBudget)
      hasher.combine(model.willRemainTruncatedAfterNextStep)
    }
  }
  return hasher.finalize()
}

/// Prefers the digest the snapshot fold stamped on the message; only messages
/// built outside the fold pay to hash their text here.
private func workTimelineCombineMessageTextSignature(_ message: WorkChatMessage, into hasher: inout Hasher) {
  hasher.combine(message.markdownRevision)

  // Live assistant deltas already carry a monotonic revision and exact
  // character metadata. Do not count or hash the growing response here: this
  // helper runs as part of the presentation signature on every streaming
  // refresh. The revision is the authoritative invalidation token; the count
  // only keeps the signature useful when a caller inspects it while a message
  // is being assembled.
  if message.markdownRevision > 0 {
    hasher.combine(message.markdownCharacterCount)
    return
  }

  if let digest = message.markdownDigest {
    hasher.combine(digest)
    hasher.combine(message.markdownCharacterCount)
    hasher.combine(message.markdownLineCount)
  } else {
    hasher.combine(message.markdown.utf8.count)
    hasher.combine(message.markdown.hashValue)
  }
}

/// What a message renders under this pass: how much of it, and from which end.
struct WorkAssistantRenderBudget: Equatable {
  let lineBudget: Int
  let anchor: WorkAssistantMessagePreviewAnchor
}

/// The budget rule, as one pure decision.
///
/// The contract it enforces is that a budget never shrinks. The newest assistant
/// message renders tail-anchored under a generous budget so a finishing turn is
/// readable in place; the moment a newer message arrives it becomes head-
/// anchored, and *that* used to drop it back to the 48-line budget — so a
/// message the reader had just read in full grew a "Show more" behind their
/// back. The budget it already rendered under becomes its floor instead.
///
/// - Parameters:
///   - userLineBudget: what "Show more" has asked for, nil if untouched.
///   - floorLineBudget: the largest budget this message has already rendered under.
///   - isTail: this is the newest assistant message in the timeline.
///   - headAnchorOverride: the reader expanded this message, so it reads from
///     the top from now on even while it is still the tail.
///   - tailCanRenderFull: the whole message fits within the tail-full budgets.
func workAssistantRenderBudget(
  userLineBudget: Int?,
  floorLineBudget: Int?,
  isTail: Bool,
  headAnchorOverride: Bool,
  tailCanRenderFull: Bool
) -> WorkAssistantRenderBudget {
  var floor = max(floorLineBudget ?? 0, workAssistantMessageInitialLineBudget)
  if isTail, tailCanRenderFull {
    floor = max(floor, workAssistantMessageTailFullLineBudget)
  }
  return WorkAssistantRenderBudget(
    lineBudget: max(userLineBudget ?? 0, floor),
    anchor: (isTail && !headAnchorOverride) ? .tail : .head
  )
}

private func workTimelineEntriesWithAssistantPreviews(
  _ entries: [WorkTimelineEntry],
  cache: WorkAssistantPreviewCache,
  assistantLineBudgets: [String: Int],
  assistantBudgetFloors: inout [String: Int],
  assistantHeadAnchorOverrides: Set<String>,
  resolvedLineBudgets: inout [String: Int],
  tailAnchoredAssistantMessageId: String?
) -> [WorkTimelineEntry] {
  var visibleAssistantMessageIds = Set<String>()
  let hydratedEntries = entries.map { entry -> WorkTimelineEntry in
    guard case .message(var message) = entry.payload,
          message.role == "assistant"
    else { return entry }

    visibleAssistantMessageIds.insert(message.id)
    let isTail = message.id == tailAnchoredAssistantMessageId
    let headAnchorOverride = assistantHeadAnchorOverrides.contains(message.id)
    let baselineAnchor: WorkAssistantMessagePreviewAnchor = (isTail && !headAnchorOverride) ? .tail : .head
    let baselinePreview = cache.preview(for: message, anchor: baselineAnchor)
    let tailCanRenderFull = baselineAnchor == .tail
      && !baselinePreview.usesMonospacedRendering
      && baselinePreview.totalLineCount <= workAssistantMessageTailFullLineBudget
      && baselinePreview.totalCharacterCount <= workAssistantMessageTailFullCharacterBudget
    let budget = workAssistantRenderBudget(
      userLineBudget: assistantLineBudgets[message.id],
      floorLineBudget: assistantBudgetFloors[message.id],
      isTail: isTail,
      headAnchorOverride: headAnchorOverride,
      tailCanRenderFull: tailCanRenderFull
    )
    // Persist the floor so the flip to head-anchoring cannot take back what the
    // reader could already see.
    if budget.lineBudget > (assistantBudgetFloors[message.id] ?? 0) {
      assistantBudgetFloors[message.id] = budget.lineBudget
    }
    resolvedLineBudgets[message.id] = budget.lineBudget

    if budget.lineBudget == workAssistantMessageInitialLineBudget, budget.anchor == baselineAnchor {
      message.assistantPreview = baselinePreview
    } else {
      message.assistantPreview = cache.preview(
        for: message,
        anchor: budget.anchor,
        lineBudget: budget.lineBudget,
        characterBudget: workAssistantMessageCharacterBudget(forLineBudget: budget.lineBudget),
        classification: baselinePreview.usesMonospacedRendering
      )
    }
    return WorkTimelineEntry(
      id: entry.id,
      timestamp: entry.timestamp,
      rank: entry.rank,
      payload: .message(message)
    )
  }
  cache.prune(keeping: visibleAssistantMessageIds)
  // Floors are deliberately NOT pruned with the preview cache. A message that
  // leaves the paged window and is revealed again by scroll-back must come back
  // rendered the way the reader last saw it. The map holds one small entry per
  // assistant message seen in this session and is dropped on session change.
  return hydratedEntries
}

private func workLatestAssistantMessageId(in timeline: [WorkTimelineEntry]) -> String? {
  for entry in timeline.reversed() {
    guard case .message(let message) = entry.payload,
          message.role == "assistant"
    else { continue }
    return message.id
  }
  return nil
}

func workTimelineRenderEntries(
  from entries: [WorkTimelineEntry],
  streamingAssistantMessageId: String?,
  splitAssistantMessageId: String? = nil,
  assistantLineBudgets: [String: Int] = [:],
  /// Budget each message actually rendered under, after floors were applied.
  /// "Show more" has to step from this, not from the raw request, or the first
  /// tap on a message held at a floor would step backwards.
  resolvedAssistantLineBudgets: [String: Int] = [:]
) -> [WorkTimelineRenderEntry] {
  var rendered: [WorkTimelineRenderEntry] = []
  rendered.reserveCapacity(entries.count)

  for entry in entries {
    guard case .message(let message) = entry.payload,
          message.role == "assistant"
    else {
      rendered.append(WorkTimelineRenderEntry(
        id: entry.id,
        sourceEntryId: entry.id,
        timestamp: entry.timestamp,
        payload: .entry(entry)
      ))
      continue
    }

    let preview = message.assistantPreview ?? workInitialAssistantMessagePreview(message.markdown)
    let shouldSplitAssistantMessage = (
      message.id == streamingAssistantMessageId
      || message.id == splitAssistantMessageId
    )
    guard shouldSplitAssistantMessage else {
      rendered.append(WorkTimelineRenderEntry(
        id: entry.id,
        sourceEntryId: entry.id,
        timestamp: entry.timestamp,
        payload: .entry(entry)
      ))
      continue
    }

    let requestedLineBudget = max(
      resolvedAssistantLineBudgets[message.id] ?? 0,
      assistantLineBudgets[message.id] ?? workAssistantMessageInitialLineBudget
    )
    // One bounded step per tap, with no ceiling. A 1000-line answer is reached
    // by tapping "Show more" until it is all here; the reader is never left
    // with a truncated message and no way to see the rest.
    let nextLineBudget = requestedLineBudget + workAssistantMessageLineBudgetStep
    let accessibilityLabel = workAssistantMessageAccessibilityLabel(preview)

    // A truncated tail can start inside a fenced tree and omit the opening
    // fence. Classify the authoritative full message so markdown prose never
    // flips into the tiny whole-message monospace renderer while paginating.
    if preview.usesMonospacedRendering {
      let model = WorkAssistantMonospacedRenderModel(
        // Keep the first rendered row anchored to the source timeline entry so
        // Show More can restore it after the preview changes anchor.
        id: entry.id,
        messageId: message.id,
        turnId: message.turnId,
        itemId: message.itemId,
        text: preview.text,
        accessibilityLabel: accessibilityLabel,
        sourceDigest: "\(message.markdownDigest ?? ""):\(message.markdownRevision)",
      )
      rendered.append(WorkTimelineRenderEntry(
        id: model.id,
        sourceEntryId: entry.id,
        timestamp: entry.timestamp,
        payload: .assistantMonospaced(model)
      ))
    } else {
      let blocks = message.id == streamingAssistantMessageId
        ? parseMarkdownBlocksForStreaming(
          preview.text,
          cacheKey: "\(message.id):preview",
          appendOnly: true
        )
        : parseMarkdownBlocks(preview.text)
      rendered.reserveCapacity(rendered.count + blocks.count + (preview.isTruncated ? 1 : 0))
      let streamingTailBlockId = message.id == streamingAssistantMessageId ? blocks.last?.id : nil
      // Only a bounded slice needs resolving; a whole message already holds its
      // own blocks, and numbering them would be work for nothing.
      let codeOrdinals = preview.isTruncated
        ? workCodeBlockOrdinals(blocks, countsFromEnd: preview.anchor == .tail)
        : [:]
      for block in blocks {
        let model = WorkAssistantMarkdownBlockRenderModel(
          id: block.id == blocks.first?.id ? entry.id : "\(entry.id)-\(block.id)",
          messageId: message.id,
          turnId: message.turnId,
          itemId: message.itemId,
          block: block,
          isStreamingTail: block.id == streamingTailBlockId,
          codeSource: codeOrdinals[block.id].map { ordinal in
            WorkCodeBlockSource(
              markdown: message.markdown,
              ordinal: ordinal,
              countsFromEnd: preview.anchor == .tail,
              markdownIdentity: "\(message.markdownDigest ?? workStableDigest(message.markdown)):\(message.markdownRevision)"
            )
          }
        )
        rendered.append(WorkTimelineRenderEntry(
          id: model.id,
          sourceEntryId: entry.id,
          timestamp: entry.timestamp,
          payload: .assistantMarkdownBlock(model)
        ))
      }
    }

    if preview.isTruncated {
      let controls = WorkAssistantMessageControlsModel(
        id: "\(entry.id)-assistant-controls",
        messageId: message.id,
        summaryText: workAssistantMessagePreviewSummaryText(preview),
        visibleLineCount: preview.visibleLineCount,
        totalLineCount: preview.totalLineCount,
        // Truncated means there is more to show, and there is always a next
        // step that shows it — the control only disappears once the whole
        // message is rendered and this branch stops running.
        canShowMore: true,
        nextLineBudget: nextLineBudget,
        willRemainTruncatedAfterNextStep: workAssistantMessageWillRemainTruncated(
          preview,
          nextLineBudget: nextLineBudget
        ),
        // Only an explicit tap writes this map, so its presence *is* "the
        // reader already expanded this message once".
        hasExpandedInPlace: assistantLineBudgets[message.id] != nil
      )
      rendered.append(WorkTimelineRenderEntry(
        id: controls.id,
        sourceEntryId: entry.id,
        timestamp: entry.timestamp,
        payload: .assistantControls(controls)
      ))
    }
  }

  return rendered
}

func mergeWorkPendingSteers(
  optimistic: [WorkPendingSteerModel],
  canonical: [WorkPendingSteerModel]
) -> [WorkPendingSteerModel] {
  guard !optimistic.isEmpty else { return canonical }
  guard !canonical.isEmpty else { return optimistic }
  var seen = Set<String>()
  var result: [WorkPendingSteerModel] = []
  for steer in optimistic + canonical {
    guard seen.insert(steer.id).inserted else { continue }
    result.append(steer)
  }
  return result
}

private struct WorkChatComposerCard: View {
  let chatSummary: WorkChatSummaryRenderContext
  /// The chat this composer sends to. Carried so a contributed composer button
  /// can name it, and so an edit the button answers with reaches this draft.
  let sessionId: String
  let isPersonalChat: Bool
  let laneId: String
  let dictationTargetId: String
  let awaitingInputGate: Bool
  let composerPlaceholder: String
  let canCompose: Bool
  let canSend: Bool
  let attachmentsAvailable: Bool
  let canUploadAttachments: Bool
  let sending: Bool
  let settingsMutationInFlight: Bool
  let codexFastModeOverride: Bool?
  let composerDraftRestore: WorkChatComposerDraftRestore?
  let draftPersistenceKey: String
  let compact: Bool
  /// True while the assistant is streaming a response. Swaps the Send button
  /// Desktop parity: red bordered stop control in the composer while a turn is
  /// active (`border-red-500/25 bg-red-500/[0.08] text-red-400/80`).
  /// old full-width yellow slab that used to sit under the header.
  let showInterrupt: Bool
  let activeSendModesAvailable: Bool
  let queueAwareStopAvailable: Bool
  let interruptInFlight: Bool
  let onInterrupt: @MainActor (AgentChatStopMode) async -> Void
  let onOpenModelPicker: (() -> Void)?
  let onSelectRuntimeMode: ((String) -> Void)?
  let onSend: @MainActor (String, [WorkChatInputAttachment], WorkActiveSendMode) async -> Bool
  let onSent: () -> Void

  var body: some View {
    WorkChatComposerDraftInput(
      chatSummary: chatSummary,
      sessionId: sessionId,
      isPersonalChat: isPersonalChat,
      laneId: laneId,
      dictationTargetId: dictationTargetId,
      awaitingInputGate: awaitingInputGate,
      composerPlaceholder: composerPlaceholder,
      canCompose: canCompose,
      canSend: canSend,
      attachmentsAvailable: attachmentsAvailable,
      canUploadAttachments: canUploadAttachments,
      sending: sending,
      settingsMutationInFlight: settingsMutationInFlight,
      codexFastModeOverride: codexFastModeOverride,
      composerDraftRestore: composerDraftRestore,
      draftPersistenceKey: draftPersistenceKey,
      compact: compact,
      showInterrupt: showInterrupt,
      activeSendModesAvailable: activeSendModesAvailable,
      queueAwareStopAvailable: queueAwareStopAvailable,
      interruptInFlight: interruptInFlight,
      onInterrupt: onInterrupt,
      onOpenModelPicker: onOpenModelPicker,
      onSelectRuntimeMode: onSelectRuntimeMode,
      onSend: onSend,
      onSent: onSent
    )
    .padding(.horizontal, 12)
    .padding(.vertical, compact ? 8 : 10)
    .background(composerSurface)
  }

  private var composerSurface: some View {
    RoundedRectangle(cornerRadius: 24, style: .continuous)
      .fill(ADEColor.composerBackground)
      .overlay(
        RoundedRectangle(cornerRadius: 24, style: .continuous)
          .stroke(ADEColor.glassBorder, lineWidth: 1)
      )
  }
}

private struct WorkChatComposerDraftInput: View {
  let chatSummary: WorkChatSummaryRenderContext
  /// The chat this composer sends to. Carried so a contributed composer button
  /// can name it, and so an edit the button answers with reaches this draft.
  let sessionId: String
  let isPersonalChat: Bool
  let laneId: String
  let dictationTargetId: String
  let awaitingInputGate: Bool
  let composerPlaceholder: String
  let canCompose: Bool
  let canSend: Bool
  let attachmentsAvailable: Bool
  let canUploadAttachments: Bool
  let sending: Bool
  let settingsMutationInFlight: Bool
  let codexFastModeOverride: Bool?
  let composerDraftRestore: WorkChatComposerDraftRestore?
  /// Key this chat's unsent text is persisted under, so leaving and coming back
  /// restores it (matching desktop). Empty disables persistence.
  let draftPersistenceKey: String
  let compact: Bool
  let showInterrupt: Bool
  let activeSendModesAvailable: Bool
  let queueAwareStopAvailable: Bool
  let interruptInFlight: Bool
  let onInterrupt: @MainActor (AgentChatStopMode) async -> Void
  let onOpenModelPicker: (() -> Void)?
  let onSelectRuntimeMode: ((String) -> Void)?
  let onSend: @MainActor (String, [WorkChatInputAttachment], WorkActiveSendMode) async -> Bool
  let onSent: () -> Void

  @EnvironmentObject private var syncService: SyncService
  @StateObject private var draftState = WorkChatComposerDraftState()
  @StateObject private var suggestionController = WorkComposerSuggestionController()
  @StateObject private var dictationCoordinator = DictationInsertionCoordinator()
  @State private var isDictating = false
  /// Composer-action contributions for THIS chat, read once per plugin-row
  /// change. Keyed on the session because that is the entity a plugin publishes
  /// a composer button against.
  @State private var pluginContributions = PluginContributionIndex()
  @State private var inputAttachments: [WorkChatInputAttachment] = []
  @State private var attachmentPickerPresented = false
  @State private var stopMode: AgentChatStopMode = .stopAndClear
  @State private var stopOptionsPresented = false
  @State private var stopHapticToken = 0
  @State private var activeSendMode: WorkActiveSendMode = .inline
  @State private var sendOptionsPresented = false

  private var hasSendableDraftOrAttachment: Bool {
    draftState.hasSendableText || !workChatInputReadyAttachments(inputAttachments).isEmpty
  }

  /// One capability lookup for the whole active-turn send affordance. See
  /// `WorkActiveSendCapability` for the table it mirrors.
  private var activeSendCapability: WorkActiveSendCapability {
    WorkActiveSendCapability.forProvider(chatSummary.provider)
  }

  /// Derived rather than stored, so switching providers can never leave a mode
  /// selected that the new provider cannot honor.
  private var effectiveActiveSendMode: WorkActiveSendMode {
    activeSendCapability.modes.contains(activeSendMode)
      ? activeSendMode
      : activeSendCapability.defaultMode
  }

  /// A single mode is not a choice: queue-only providers get the plain send
  /// button, matching the desktop composer.
  private var activeSendModePickerVisible: Bool {
    activeSendModesAvailable && activeSendCapability.modes.count > 1
  }

  /// Where this chat's remembered send mode lives. Blank for the projectless
  /// "new chat" composers, which have no session to remember against.
  private var activeSendModeStorageKey: String {
    WorkActiveSendModeStore.chatKey(sessionId: sessionId)
  }

  /// Restores the remembered mode for this chat, falling back to the provider
  /// default when nothing is stored or the stored mode is one this provider
  /// cannot honor.
  private func restoreActiveSendMode() {
    let remembered = WorkActiveSendModeStore.load(activeSendModeStorageKey)
    activeSendMode = remembered.flatMap { mode in
      activeSendCapability.modes.contains(mode) ? mode : nil
    } ?? activeSendCapability.defaultMode
  }

  private var activeSendAgentLabel: String { activeSendCapability.agentLabel }

  private var activeSendInterruptContinues: Bool { activeSendCapability.interruptContinues }

  private func activeSendModeTitle(_ mode: WorkActiveSendMode) -> String {
    switch mode {
    case .queue: return "Send after turn"
    case .interrupt: return activeSendInterruptContinues ? "Interrupt & continue" : "Interrupt & send"
    case .inline: return "Send during turn"
    }
  }

  private func activeSendModeDetail(_ mode: WorkActiveSendMode) -> String {
    switch mode {
    case .queue: return "Keep this message staged until the turn finishes."
    case .interrupt: return "Stop and redirect \(activeSendAgentLabel) now."
    case .inline: return "\(activeSendAgentLabel) picks this up after the current tool step."
    }
  }

  private func activeSendModeIcon(_ mode: WorkActiveSendMode) -> String {
    switch mode {
    case .queue: return "clock"
    case .interrupt: return "bolt.fill"
    case .inline: return "arrow.turn.down.right"
    }
  }

  private var stashAvailable: Bool {
    !isPersonalChat && syncService.canInvokeRemoteAction("chat.listPromptStashes")
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if compact {
        WorkComposerSuggestionStrip(controller: suggestionController)
          .animation(.smooth(duration: 0.16), value: suggestionController.isVisible)

        WorkChatInputAttachmentTray(attachments: $inputAttachments)

        HStack(alignment: .center, spacing: 8) {
          if !isDictating {
            composerOverflowMenu

            pluginComposerActions

            WorkChatComposerTextField(
              draftState: draftState,
              controller: suggestionController,
              canCompose: canCompose,
              placeholder: composerPlaceholder,
              acceptsPastedImages: canCompose && attachmentsAvailable,
              onPasteImages: { images in
                workChatInputPasteImages(images, into: $inputAttachments)
              },
              maxLines: 1
            )
          }

          composerDictationControl

          if !isDictating {
            sendOrInterruptControls()
          }
        }
      } else {
        WorkComposerSuggestionStrip(controller: suggestionController)
          .animation(.smooth(duration: 0.16), value: suggestionController.isVisible)

        WorkChatInputAttachmentTray(attachments: $inputAttachments)

        WorkChatComposerTextField(
          draftState: draftState,
          controller: suggestionController,
          canCompose: canCompose,
          placeholder: composerPlaceholder,
          acceptsPastedImages: canCompose && attachmentsAvailable,
          onPasteImages: { images in
            workChatInputPasteImages(images, into: $inputAttachments)
          }
        )

        if showInterrupt && hasSendableDraftOrAttachment {
          Text(activeTurnSendHint)
            .font(.caption2)
            .foregroundStyle(ADEColor.textMuted)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityIdentifier("Work.Chat.Composer.StagingHint")
        }

        HStack(alignment: .center, spacing: 8) {
        if !isDictating {
          composerOverflowMenu

          WorkComposerChipStrip(
            chatSummary: chatSummary,
            settingsMutationInFlight: settingsMutationInFlight,
            codexFastModeOverride: codexFastModeOverride,
            onOpenModelPicker: onOpenModelPicker,
            onSelectRuntimeMode: onSelectRuntimeMode
          )

          DictationRawUndoChip(coordinator: dictationCoordinator, draft: $draftState.text)

          pluginComposerActions

          Spacer(minLength: 0)
        }

          composerDictationControl

          if !isDictating {
            sendOrInterruptControls()
          }
        }
      }
    }
    .onAppear {
      configureSuggestionController()
    }
    // Bind before applying a restore: `bind` only seeds an empty field, so a
    // failed-send restore that runs first would be preserved either way, but
    // binding first keeps the persisted key correct for the very first autosave.
    .task(id: draftPersistenceKey) {
      stopMode = UserDefaults.standard.string(forKey: "\(draftPersistenceKey).stopMode") == AgentChatStopMode.stopOnly.rawValue
        ? .stopOnly
        : .stopAndClear
      restoreActiveSendMode()
      sendOptionsPresented = false
      stopOptionsPresented = false
      draftState.bind(persistenceKey: draftPersistenceKey)
    }
    .task(id: composerDraftRestore?.id) {
      draftState.applyRestore(composerDraftRestore)
    }
    .loadPluginContributions(.session, into: $pluginContributions)
    // The 400ms autosave debounce can't survive a navigation pop; flush here so
    // backing out of a chat mid-sentence keeps the sentence.
    .onDisappear { draftState.flushDraft() }
    // A turn starting or ending is not a change of intent: the mode the user
    // picked survives it, and only the transient popovers close.
    .onChange(of: showInterrupt) { _, _ in
      sendOptionsPresented = false
      stopOptionsPresented = false
    }
    // A provider change is: the new runtime may have no inline channel at all,
    // so anything it cannot honor snaps back to that provider's default.
    .onChange(of: chatSummary.provider) { _, _ in
      if !activeSendCapability.modes.contains(activeSendMode) {
        activeSendMode = activeSendCapability.defaultMode
      }
      sendOptionsPresented = false
      stopOptionsPresented = false
      configureSuggestionController()
    }
    .onChange(of: laneId) { _, _ in configureSuggestionController() }
    .workChatAttachmentPicker(
      isPresented: $attachmentPickerPresented,
      attachments: $inputAttachments,
      onDismiss: {
        if canCompose { draftState.isFocused = true }
      }
    )
  }

  /// Contributed buttons in the accessory row, after the composer's own
  /// controls and before the spacer that pushes the meter to the trailing edge.
  ///
  /// Compact mode draws them too, and used not to. That layout is one text
  /// field and a mic on a single line, so it looked like the row with no space
  /// to spare — but the consequence was a plugin whose button was on screen on
  /// desktop and simply missing on the phone, for the same chat and the same
  /// install, with nothing anywhere saying why. A tighter presentation is the
  /// honest trade: one labeled action inline, the rest behind a plugins menu.
  @ViewBuilder
  private var pluginComposerActions: some View {
    PluginComposerActions(
      contributions: pluginContributions.composerActions(sessionId: sessionId),
      sessionId: sessionId,
      // Read at press time, so the plugin acts on the words on screen at that
      // moment rather than the ones that were there when the row last drew.
      draft: { draftState.text },
      onEdit: applyPluginComposerEdit,
      enabled: canCompose && !settingsMutationInFlight,
      compact: compact
    )
  }

  /// Apply what a composer action answered with.
  ///
  /// Insert appends, because this composer publishes no caret offset — which is
  /// exactly the case desktop's own contract calls "insert by appending", so
  /// the two clients agree about where the text lands rather than one of them
  /// guessing a position.
  ///
  /// Focus follows the write. A plugin that filled the draft has handed the
  /// turn back to the user, and the next thing they do is read it and press
  /// send; leaving the keyboard down would make them tap the field first.
  private func applyPluginComposerEdit(_ edit: PluginInvokeComposerEdit) {
    switch edit {
    case let .insert(text):
      draftState.text += text
    case let .replace(text):
      draftState.text = text
    }
    draftState.isFocused = true
  }

  private var composerOverflowMenu: some View {
    WorkComposerOverflowButton(
      attachmentPickerPresented: $attachmentPickerPresented,
      draft: $draftState.text,
      attachments: $inputAttachments,
      canCompose: canCompose && !settingsMutationInFlight,
      attachmentsAvailable: attachmentsAvailable,
      onDictate: { dictationCoordinator.requestStart() },
      stashAvailable: stashAvailable,
      scope: WorkPromptStashScope(chatSessionId: sessionId),
      provider: chatSummary.provider,
      modelId: chatSummary.currentModelId
    )
  }

  private var composerDictationControl: some View {
    DictationMicButton(
      draft: $draftState.text,
      coordinator: dictationCoordinator,
      targetId: dictationTargetId,
      showsIdleButton: false,
      onRecordingChange: { isDictating = $0 }
    )
    .frame(maxWidth: isDictating ? .infinity : nil)
  }

  @ViewBuilder
  private func sendOrInterruptControls() -> some View {
    if showInterrupt {
      if hasSendableDraftOrAttachment {
        stopButton()
        if activeSendModePickerVisible {
          activeTurnSendButton()
        } else {
          WorkChatComposerSendButton(
            draftState: draftState,
            attachments: $inputAttachments,
            canSend: canSend,
            canUploadAttachments: canUploadAttachments,
            sending: sending,
            accessibilityLabelText: "Stage message",
            onSend: { text, attachments in
              await onSend(text, attachments, .queue)
            },
            onSent: onSent
          )
        }
      } else {
        stopButton()
      }
    } else {
      WorkChatComposerSendButton(
        draftState: draftState,
        attachments: $inputAttachments,
        canSend: canSend,
        canUploadAttachments: canUploadAttachments,
        sending: sending,
        onSend: { text, attachments in
          await onSend(text, attachments, .queue)
        },
        onSent: onSent
      )
    }
  }

  @ViewBuilder
  private func activeTurnSendButton() -> some View {
    HStack(spacing: 0) {
      WorkChatComposerSendButton(
        draftState: draftState,
        attachments: $inputAttachments,
        canSend: canSend,
        canUploadAttachments: canUploadAttachments,
        sending: sending,
        accessibilityLabelText: activeSendModeTitle(effectiveActiveSendMode),
        systemImageName: activeSendModeIcon(effectiveActiveSendMode),
        minimumTapTargetSize: 32,
        onSend: { text, attachments in
          await onSend(text, attachments, effectiveActiveSendMode)
        },
        onSent: onSent
      )

      Button {
        sendOptionsPresented.toggle()
      } label: {
        Image(systemName: "chevron.down")
          .font(.system(size: 9, weight: .bold))
          .foregroundStyle(Color(red: 0.12, green: 0.12, blue: 0.14))
          .frame(width: 24, height: 32)
          .background(Color.white.opacity(0.9))
      }
      .buttonStyle(.plain)
      .accessibilityLabel("More send options")
      .accessibilityValue(activeSendModeTitle(effectiveActiveSendMode))
      .accessibilityHint("Choose how this message reaches the active \(activeSendAgentLabel) turn")
      .popover(isPresented: $sendOptionsPresented, arrowEdge: .bottom) {
        VStack(alignment: .leading, spacing: 0) {
          ForEach(Array(activeSendCapability.modes.enumerated()), id: \.element) { index, mode in
            if index > 0 { Divider() }
            activeSendOption(
              mode: mode,
              title: activeSendModeTitle(mode),
              detail: activeSendModeDetail(mode),
              systemImage: activeSendModeIcon(mode)
            )
          }
        }
        .frame(width: 270)
        .presentationCompactAdaptation(.popover)
      }
    }
    .clipShape(Capsule())
  }

  private var activeTurnSendHint: String {
    guard activeSendModePickerVisible else {
      return "Message will stage behind the active turn."
    }
    switch effectiveActiveSendMode {
    case .queue: return "Message will send after the active turn."
    case .interrupt: return "Message will interrupt and redirect \(activeSendAgentLabel)."
    case .inline: return "Message will reach \(activeSendAgentLabel) during the active turn."
    }
  }

  @ViewBuilder
  private func activeSendOption(mode: WorkActiveSendMode, title: String, detail: String, systemImage: String) -> some View {
    Button {
      activeSendMode = mode
      WorkActiveSendModeStore.save(mode, for: activeSendModeStorageKey)
      sendOptionsPresented = false
    } label: {
      HStack(alignment: .top, spacing: 10) {
        Image(systemName: systemImage)
          .font(.caption.weight(.semibold))
          .foregroundStyle(mode == .interrupt ? ADEColor.warning : ADEColor.accent)
          .frame(width: 16)
        VStack(alignment: .leading, spacing: 2) {
          Text(title)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
          Text(detail)
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
        }
        Spacer(minLength: 4)
        if effectiveActiveSendMode == mode {
          Image(systemName: "checkmark")
            .font(.caption.weight(.bold))
            .foregroundStyle(ADEColor.accent)
        }
      }
      .padding(12)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
  }

  private func configureSuggestionController() {
    suggestionController.provider = chatSummary.provider
    suggestionController.laneId = laneId.isEmpty ? nil : laneId
    suggestionController.syncService = syncService
  }

  @ViewBuilder
  private func stopButton() -> some View {
    if chatSummary.provider.lowercased() == "claude" && queueAwareStopAvailable {
      HStack(spacing: 0) {
        Button {
          stopHapticToken &+= 1
          Task { await onInterrupt(stopMode) }
        } label: {
          stopButtonModeIcon()
            .foregroundStyle(ADEColor.danger.opacity(0.85))
            .frame(width: 32, height: 32)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(stopMode == .stopOnly ? "Stop turn and keep queue" : "Stop turn and clear queue")
        .disabled(interruptInFlight)

        Button {
          stopOptionsPresented.toggle()
        } label: {
          Image(systemName: "chevron.down")
            .font(.system(size: 9, weight: .bold))
            .foregroundStyle(ADEColor.danger.opacity(0.72))
            .frame(width: 24, height: 32)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("More stop options")
        .accessibilityValue(stopMode == .stopOnly ? "Stop only" : "Stop and clear queue")
        .accessibilityHint("Choose whether queued Claude messages are kept or cancelled")
        .disabled(interruptInFlight)
        .popover(isPresented: $stopOptionsPresented, arrowEdge: .bottom) {
          VStack(alignment: .leading, spacing: 0) {
            stopOption(
              mode: .stopAndClear,
              title: "Stop & clear queue",
              detail: "Stop this turn and cancel staged Claude messages.",
              systemImage: "trash"
            )
            Divider()
            stopOption(
              mode: .stopOnly,
              title: "Stop only",
              detail: "Stop this turn and keep staged messages.",
              systemImage: "stop.fill"
            )
          }
          .frame(width: 260)
          .presentationCompactAdaptation(.popover)
        }
      }
      .background(
        RoundedRectangle(cornerRadius: 10, style: .continuous)
          .fill(ADEColor.danger.opacity(0.08))
      )
      .overlay {
        RoundedRectangle(cornerRadius: 10, style: .continuous)
          .stroke(ADEColor.danger.opacity(0.25), lineWidth: 1)
      }
      .sensoryFeedback(.impact(weight: .medium), trigger: stopHapticToken)
    } else {
      Button {
        stopHapticToken &+= 1
        Task { await onInterrupt(.stopAndClear) }
      } label: {
        stopButtonIcon()
        .foregroundStyle(ADEColor.danger.opacity(0.85))
        .frame(width: 28, height: 28)
        .background(
          RoundedRectangle(cornerRadius: 8, style: .continuous)
            .fill(ADEColor.danger.opacity(0.08))
        )
        .overlay(
          RoundedRectangle(cornerRadius: 8, style: .continuous)
            .stroke(ADEColor.danger.opacity(0.25), lineWidth: 1)
        )
      }
      .buttonStyle(.plain)
      .accessibilityLabel(interruptInFlight ? "Interrupting turn" : "Stop turn")
      .disabled(interruptInFlight)
      .sensoryFeedback(.impact(weight: .medium), trigger: stopHapticToken)
      .adeInspectable(
        "Work.Chat.Composer.StopButton",
        metadata: [
          "label": interruptInFlight ? "Interrupting turn" : "Stop turn",
          "role": "button"
        ]
      )
    }
  }

  @ViewBuilder
  private func stopOption(mode: AgentChatStopMode, title: String, detail: String, systemImage: String) -> some View {
    Button {
      stopMode = mode
      UserDefaults.standard.set(mode.rawValue, forKey: "\(draftPersistenceKey).stopMode")
      stopOptionsPresented = false
    } label: {
      HStack(alignment: .top, spacing: 10) {
        Image(systemName: systemImage)
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.danger)
          .frame(width: 16)
        VStack(alignment: .leading, spacing: 2) {
          Text(title)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
          Text(detail)
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
        }
        Spacer(minLength: 4)
        if stopMode == mode {
          Image(systemName: "checkmark")
            .font(.caption.weight(.bold))
            .foregroundStyle(ADEColor.accent)
        }
      }
      .padding(12)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
  }

  @ViewBuilder
  private func stopButtonIcon() -> some View {
    if interruptInFlight {
      ProgressView()
        .controlSize(.mini)
        .tint(ADEColor.danger)
    } else {
      Image(systemName: "stop.fill")
        .font(.system(size: 10, weight: .bold))
    }
  }

  @ViewBuilder
  private func stopButtonModeIcon() -> some View {
    if interruptInFlight {
      ProgressView()
        .controlSize(.mini)
        .tint(ADEColor.danger)
    } else if stopMode == .stopOnly {
      Image(systemName: "stop.fill")
        .font(.system(size: 10, weight: .bold))
    } else {
      Image(systemName: "trash")
        .font(.system(size: 11, weight: .bold))
    }
  }
}

private struct WorkSubagentTakeoverBanner: View {
  let parentTitle: String?
  let takeOverEnabled: Bool
  let keepReportingEnabled: Bool
  let onTakeOver: @MainActor () async -> Void
  let onKeepReporting: @MainActor () async -> Void

  private var line: String {
    if let named = parentTitle?.trimmingCharacters(in: .whitespacesAndNewlines), !named.isEmpty {
      return "This chat reports back to \"\(named)\". Take it over?"
    }
    return "This chat reports back to its parent. Take it over?"
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("Take over this chat?")
        .font(.caption.weight(.semibold))
        .foregroundStyle(ADEColor.textPrimary)
      Text(line)
        .font(.caption)
        .foregroundStyle(ADEColor.textSecondary)
        .fixedSize(horizontal: false, vertical: true)
      HStack(spacing: 8) {
        Button {
          Task { await onTakeOver() }
        } label: {
          Text("Take over")
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
        }
        .buttonStyle(.borderedProminent)
        .disabled(!takeOverEnabled)
        Button {
          Task { await onKeepReporting() }
        } label: {
          Text("Keep reporting")
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
        }
        .buttonStyle(.bordered)
        .disabled(!keepReportingEnabled)
        Spacer(minLength: 0)
      }
    }
    .padding(10)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(
      RoundedRectangle(cornerRadius: 12, style: .continuous)
        .fill(ADEColor.accent.opacity(0.08))
    )
    .accessibilityElement(children: .contain)
  }
}

private struct WorkSubagentLineageBreadcrumb: View {
  let parentTitle: String?
  let onOpen: () -> Void

  private var sourceLabel: String {
    let trimmed = parentTitle?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return trimmed.isEmpty ? "parent chat" : trimmed
  }

  var body: some View {
    Button(action: onOpen) {
      HStack(spacing: 8) {
        Image(systemName: "arrow.turn.up.left")
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.accent)

        VStack(alignment: .leading, spacing: 1) {
          Text("Subagent chat")
            .font(.caption2.weight(.semibold))
            .foregroundStyle(ADEColor.accent)
          Text("from \(sourceLabel)")
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
            .lineLimit(1)
            .truncationMode(.tail)
        }

        Spacer(minLength: 4)

        Image(systemName: "chevron.right")
          .font(.caption2.weight(.bold))
          .foregroundStyle(ADEColor.textMuted)
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 9)
      .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
      .background(ADEColor.cardBackground.opacity(0.62), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .stroke(ADEColor.accent.opacity(0.18), lineWidth: 1)
      )
      .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
    .buttonStyle(.plain)
    .accessibilityLabel("Open parent chat, \(sourceLabel)")
    .accessibilityHint("Returns to the chat that spawned this subagent.")
  }
}

private struct WorkQueueRecoveryBanner: View {
  let recovery: WorkQueueRecoveryModel
  let restoring: Bool
  let enabled: Bool
  let onRestore: @MainActor () async -> Void

  var body: some View {
    HStack(spacing: 10) {
      Image(systemName: "arrow.uturn.backward.circle.fill")
        .font(.body)
        .foregroundStyle(ADEColor.warning)

      Text("\(recovery.messageCount) queued message\(recovery.messageCount == 1 ? "" : "s") cancelled")
        .font(.caption)
        .foregroundStyle(ADEColor.textSecondary)
        .fixedSize(horizontal: false, vertical: true)

      Spacer(minLength: 4)

      Button {
        Task { await onRestore() }
      } label: {
        Group {
          if restoring {
            ProgressView()
              .controlSize(.small)
          } else {
            Text("Undo")
              .font(.caption.weight(.semibold))
          }
        }
        .frame(minWidth: 44, minHeight: 44)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .foregroundStyle(ADEColor.accent)
      .disabled(!enabled)
      .accessibilityLabel(
        restoring
          ? "Restoring cancelled queue"
          : (enabled ? "Undo queue cancellation" : "Queue restoration unavailable")
      )
      .accessibilityHint("Restores the cancelled messages to Claude’s queue")
    }
    .padding(.leading, 12)
    .padding(.trailing, 4)
    .background(ADEColor.warning.opacity(0.07), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    .overlay {
      RoundedRectangle(cornerRadius: 10, style: .continuous)
        .stroke(ADEColor.warning.opacity(0.18), lineWidth: 1)
    }
  }
}

struct WorkChatComposerDraftRestore: Equatable, Identifiable {
  let id: UUID
  let text: String
  let replacesExistingDraft: Bool

  init(
    text: String,
    id: UUID = UUID(),
    replacesExistingDraft: Bool = false
  ) {
    self.id = id
    self.text = text
    self.replacesExistingDraft = replacesExistingDraft
  }
}

final class WorkChatComposerDraftState: ObservableObject {
  @Published var text = "" {
    didSet {
      guard text != oldValue else { return }
      scheduleAutosave()
    }
  }
  @Published var isFocused = false
  private var appliedRestoreId: UUID?
  /// Surface this composer's draft is persisted under. Empty means "don't
  /// persist" (the key is unresolved), which is the safe default.
  private var persistenceKey = ""
  private var autosaveTask: Task<Void, Never>?

  var trimmedText: String {
    text.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  /// Point this composer at a chat's stored draft. The composer view is reused
  /// across session switches, so the outgoing chat's text is flushed under its
  /// own key before the new one is loaded — otherwise switching chats would
  /// either lose a draft or write it into the wrong conversation.
  @MainActor
  func bind(persistenceKey key: String) {
    guard persistenceKey != key else { return }
    // A blank previous key means this is the first bind of a freshly mounted
    // composer; anything else is the view being reused for a different chat.
    let isFirstBind = persistenceKey.isEmpty
    flushDraft()
    persistenceKey = key
    let stored = key.isEmpty ? "" : WorkComposerDraftStore.load(key)

    guard !isFirstBind else {
      // First mount: whatever is already in the field wins. A failed send
      // restores its text here, and that is fresher than anything on disk.
      guard trimmedText.isEmpty, !stored.isEmpty else { return }
      text = stored
      return
    }

    // Session switch: the visible text belongs to the chat we just left, and it
    // has already been flushed under that chat's key. It must NOT survive into
    // this one — leaving it would show one conversation's draft in another,
    // autosave it over the destination's own stored draft on the next
    // keystroke, and put the wrong message one tap from being sent.
    if text != stored {
      text = stored
    }
  }

  /// Write the draft now, cancelling any pending debounce. Called when the chat
  /// is torn down — the case the debounce would otherwise miss.
  @MainActor
  func flushDraft() {
    autosaveTask?.cancel()
    autosaveTask = nil
    guard !persistenceKey.isEmpty else { return }
    WorkComposerDraftStore.save(text, for: persistenceKey)
  }

  /// Keystroke debounce: each edit restarts the timer, so a burst of typing
  /// costs one write instead of one per character.
  private func scheduleAutosave() {
    guard !persistenceKey.isEmpty else { return }
    autosaveTask?.cancel()
    let key = persistenceKey
    let value = text
    autosaveTask = Task { @MainActor in
      try? await Task.sleep(for: workDraftAutosaveDebounce)
      guard !Task.isCancelled else { return }
      WorkComposerDraftStore.save(value, for: key)
    }
  }

  var hasSendableText: Bool {
    !trimmedText.isEmpty
  }

  func consumeSendableText() -> String {
    let value = trimmedText
    isFocused = false
    text = ""
    // Drop the stored copy synchronously rather than letting the 400ms debounce
    // get to it. A jetsam or force-quit inside that window would otherwise
    // restore an already-sent message into the composer, where it reads as
    // unsent and invites sending it twice. The Hub and New Chat composers clear
    // on send for the same reason.
    clearStoredDraft()
    return value
  }

  /// Cancels any pending autosave and removes the persisted draft. Not
  /// actor-annotated so `consumeSendableText()` — which runs from the send
  /// button's synchronous action — can call it directly.
  func clearStoredDraft() {
    autosaveTask?.cancel()
    autosaveTask = nil
    guard !persistenceKey.isEmpty else { return }
    WorkComposerDraftStore.clear(persistenceKey)
  }

  func restoreUnsentText(_ value: String) {
    let currentDraft = trimmedText
    if currentDraft != value {
      if currentDraft.isEmpty {
        text = value
      } else {
        text = "\(value)\n\(text)"
      }
    }
    isFocused = true
  }

  func applyRestore(_ restore: WorkChatComposerDraftRestore?) {
    guard let restore, appliedRestoreId != restore.id else { return }
    appliedRestoreId = restore.id
    if restore.replacesExistingDraft {
      text = restore.text
      isFocused = true
    } else {
      restoreUnsentText(restore.text)
    }
  }
}

private struct WorkChatComposerTextField: View {
  @ObservedObject var draftState: WorkChatComposerDraftState
  @ObservedObject var controller: WorkComposerSuggestionController
  let canCompose: Bool
  let placeholder: String
  var acceptsPastedImages = true
  var onPasteImages: (([UIImage]) -> Void)? = nil
  var maxLines = 6
  @State private var measuredHeight: CGFloat = 24

  var body: some View {
    WorkComposerTextView(
      draftState: draftState,
      controller: controller,
      canCompose: canCompose,
      placeholder: placeholder,
      measuredHeight: $measuredHeight,
      acceptsPastedImages: acceptsPastedImages,
      onPasteImages: onPasteImages,
      maxLines: maxLines
    )
    .frame(height: measuredHeight)
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

private struct WorkChatComposerSendButton: View {
  @ObservedObject var draftState: WorkChatComposerDraftState
  @Binding var attachments: [WorkChatInputAttachment]
  let canSend: Bool
  let canUploadAttachments: Bool
  let sending: Bool
  var accessibilityLabelText = "Send message"
  var systemImageName = "arrow.up"
  var minimumTapTargetSize: CGFloat = 28
  let onSend: @MainActor (String, [WorkChatInputAttachment]) async -> Bool
  let onSent: () -> Void

  private var sendEnabled: Bool {
    workChatInputCanSend(
      text: draftState.text,
      attachments: attachments,
      baseEnabled: canSend,
      canUploadAttachments: canUploadAttachments
    )
  }

  var body: some View {
    ADEComposerSendButton(
      enabled: sendEnabled,
      sending: sending,
      accessibilityLabelText: accessibilityLabelText,
      systemImageName: systemImageName,
      minimumTapTargetSize: minimumTapTargetSize
    ) {
      let originalText = draftState.consumeSendableText()
      let outgoingAttachments = workChatInputReadyAttachments(attachments)
      let text = workChatOutgoingText(originalText, attachmentCount: outgoingAttachments.count)
      let restoredAttachments = attachments
      attachments.removeAll()
      Task { @MainActor in
        let sent = await onSend(text, outgoingAttachments)
        if sent {
          onSent()
        } else {
          attachments = restoredAttachments
          draftState.restoreUnsentText(originalText)
        }
      }
    }
    .adeInspectable(
      "Work.Chat.Composer.SendButton",
      metadata: [
        "label": sending ? "Sending message" : accessibilityLabelText,
        "role": "button"
      ]
    )
  }
}
