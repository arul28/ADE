import SwiftUI
import UIKit
import AVKit

enum WorkSessionNavigationChrome {
  case pushedDetail
  case embedded
}

extension WorkSessionNavigationChrome: Equatable {}

let workSessionEdgeSwipeActivationWidth: CGFloat = 36
let workSessionEdgeSwipeMinimumTranslation: CGFloat = 88
let workSessionEdgeSwipePredictedTranslation: CGFloat = 140

func workSessionShouldDismissForEdgeSwipe(
  startX: CGFloat,
  containerWidth: CGFloat,
  layoutDirection: LayoutDirection,
  translation: CGSize,
  predictedEndTranslation: CGSize
) -> Bool {
  let isRTL = layoutDirection == .rightToLeft
  let leadingEdgeDistance = isRTL ? max(0, containerWidth - startX) : startX
  let horizontalTranslation = isRTL ? -translation.width : translation.width
  let predictedHorizontalTranslation = isRTL ? -predictedEndTranslation.width : predictedEndTranslation.width

  guard leadingEdgeDistance <= workSessionEdgeSwipeActivationWidth else { return false }
  guard horizontalTranslation > 0 else { return false }
  guard abs(translation.height) <= max(48, horizontalTranslation * 0.75) else { return false }
  return horizontalTranslation >= workSessionEdgeSwipeMinimumTranslation
    || predictedHorizontalTranslation >= workSessionEdgeSwipePredictedTranslation
}

func workChatCanSendMessages(
  isLive: Bool,
  hostReachable: Bool,
  chatSendQueueable: Bool
) -> Bool {
  isLive && (hostReachable || chatSendQueueable)
}

func workChatSendWillQueueMessage(
  isLive: Bool,
  hostReachable: Bool,
  chatSendQueueable: Bool
) -> Bool {
  isLive && !hostReachable && chatSendQueueable
}

/// Recovery is the host's capability and nothing else's: a recovery card
/// carries its own source session id, so no view-level state may hide an
/// action the paired host supports.
func workChatCodexRecoveryAvailable(hostSupportsRecovery: Bool) -> Bool {
  hostSupportsRecovery
}

func workChatShouldSteerActiveTurn(
  session: TerminalSessionSummary?,
  summary: AgentChatSessionSummary?
) -> Bool {
  normalizedWorkChatSessionStatus(session: session, summary: summary) == "active"
}

func workChatIsManualCompactCommand(_ text: String) -> Bool {
  let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
  let lowered = trimmed.lowercased()
  if lowered == "/compact" { return true }
  guard lowered.hasPrefix("/compact") else { return false }
  let rest = trimmed.dropFirst("/compact".count)
  return rest.first?.isWhitespace == true
}

func workChatBlocksManualCompactSend(
  text: String,
  shouldSteer: Bool,
  turnHintActive: Bool
) -> Bool {
  workChatIsManualCompactCommand(text) && (shouldSteer || turnHintActive)
}

/// Which atomic dispatch modes an already-staged message can be promoted into
/// on this session. Read off `WorkActiveSendCapability` — the hand mirror of
/// the desktop's `ACTIVE_TURN_DISPATCH_MODES` — rather than restated here, so
/// the staged strip and the composer's split send button can never disagree.
/// Claude and Cursor can both fold a staged row into the live turn or interrupt
/// with it. A Cursor **Cloud** session withholds `.inline` — `Run.steer` refuses
/// every call there — so the staged strip matches the composer's split send
/// button. Everything else has nothing to promote into and keeps the plain
/// staged row.
func workChatManualSteerDispatchModes(
  session: TerminalSessionSummary?,
  summary: AgentChatSessionSummary?
) -> [WorkActiveSendMode] {
  let provider = summary?.provider ?? workChatProviderFamilyFromToolType(session?.toolType)
  guard let provider else { return [] }
  let runsInCloud = workChatCursorSessionRunsInCloud(
    provider: provider,
    cursorRuntime: summary?.cursorRuntime ?? session?.cursorRuntime,
    cursorCloudAgentId: summary?.cursorCloudAgentId ?? session?.cursorCloudAgentId
  )
  return WorkActiveSendCapability.forProvider(provider)
    .withholdingInlineIfNeeded(runsInCloud: runsInCloud, provider: provider)
    .atomicDispatchModes
}

/// iOS half of desktop `cursorSessionRunsInCloud`.
///
/// `cursorRuntime` wins when the host sent it, including `"local"` over a
/// leftover cloud agent id. Absent runtime plus a non-empty agent id is still
/// cloud, because sessions promoted before that field existed carry only the id.
func workChatCursorSessionRunsInCloud(
  provider: String?,
  cursorRuntime: String? = nil,
  cursorCloudAgentId: String?
) -> Bool {
  guard providerFamilyKey(provider ?? "") == "cursor" else { return false }
  if let runtime = cursorRuntime { return runtime == "cloud" }
  return cursorCloudAgentId?.isEmpty == false
}

/// The `dispatchMode` that rides `chat.steer` itself, so a busy host dispatches
/// the message in the same round-trip instead of staging it and waiting for a
/// second `chat.dispatchSteer` call. This is the desktop contract, and the
/// strings are the desktop's exactly — the host rejects anything else.
///
/// Nil means "stage it", which covers the queue mode, a provider with no
/// mid-turn channel, and a host too old to promote at all. Resolving it once,
/// up front, is what keeps the "turn was already active" resend from quietly
/// downgrading a Send-now tap into a staged message.
func workChatAtomicSteerDispatchMode(
  deliveryMode: WorkActiveSendMode,
  dispatchModes: [WorkActiveSendMode]
) -> String? {
  guard deliveryMode != .queue, dispatchModes.contains(deliveryMode) else { return nil }
  return deliveryMode.rawValue
}

func latestActiveTurnId(from transcript: [WorkChatEnvelope]) -> String? {
  for envelope in sortedWorkChatEnvelopes(transcript).reversed() {
    switch envelope.event {
    case .assistantText(_, let turnId, _),
         .activity(_, _, let turnId),
         .userMessage(_, _, let turnId, _, _, _):
      if let turnId, !turnId.isEmpty { return turnId }
    case .status(_, _, let turnId):
      if let turnId, !turnId.isEmpty { return turnId }
    default:
      continue
    }
  }
  return nil
}

func transcriptContainsResolvedSteer(_ transcript: [WorkChatEnvelope], steer: WorkPendingSteerModel) -> Bool {
  let steerId = steer.id
  let normalizedSteerText = normalizedQueuedSteerText(steer.text)
  for envelope in sortedWorkChatEnvelopes(transcript).reversed() {
    switch envelope.event {
    case .userMessage(_, _, _, let candidate, let deliveryState, _):
      guard candidate == steerId else { continue }
      return deliveryState != "queued"
    case .systemNotice(_, let message, _, _, let candidate):
      guard candidate == steerId else { continue }
      return workSystemNoticeResolvesQueuedSteer(message)
    default:
      continue
    }
  }
  guard !normalizedSteerText.isEmpty else { return false }
  for envelope in sortedWorkChatEnvelopes(transcript).reversed() {
    guard case .userMessage(let text, _, _, let candidate, let deliveryState, _) = envelope.event,
          normalizedQueuedSteerText(text) == normalizedSteerText
    else { continue }
    return candidate != steerId || deliveryState != "queued"
  }
  return false
}

func workChatTranscriptPreferenceStatus(
  sessionStatus: String,
  liveTurnActiveHint: Bool?
) -> String {
  if liveTurnActiveHint == false && sessionStatus == "active" {
    return "idle"
  }
  return sessionStatus
}

func workChatErrorIndicatesActiveTurn(_ error: Error) -> Bool {
  let message = (error as NSError).localizedDescription.lowercased()
  return message.contains("turn already active")
    || message.contains("turn is already active")
    || message.contains("already active")
}

/// True when the host refused the requested `dispatchMode` outright.
///
/// A paired host older than this client advertises `chat.dispatchSteer` but
/// still rejects Cursor's `"inline"`, because the accepted modes come from its
/// own copy of `ACTIVE_TURN_DISPATCH_MODES`. The capability gate cannot see
/// that — it only knows whether the ACTION exists — so the send throws before
/// anything is queued and the two-step fallback, which only runs on a queued
/// reply, never gets a chance. Retrying once without the mode stages the
/// message instead of losing it.
func workChatErrorIndicatesUnsupportedDispatchMode(_ error: Error) -> Bool {
  let message = (error as NSError).localizedDescription.lowercased()
  return message.contains("active-turn dispatch mode")
}

/// True when a rejected `dispatchMode` should be retried as a staged send.
///
/// The CTO surface does not offer queue, so omitting the mode would auto-route
/// to interrupt — a cancel the user did not pick. Fail that send instead.
func workChatShouldStageAfterUnsupportedDispatchMode(liveRedirectOnly: Bool) -> Bool {
  !liveRedirectOnly
}

/// Whether a mounted chat destination owns a lane pull request at all.
///
/// The CTO chat (and any other caller passing `showsLaneActions: false`) reuses
/// this destination with a *synthetic* lane id, so resolving that lane would
/// hand back the project's primary-lane PR and render it as this chat's badge.
/// `showsLaneActions` only hides the header menu's PR items, so the lookup and
/// the composer badge read this policy instead.
struct WorkChatLanePrPolicy {
  var showsLaneActions: Bool

  /// Gate for every lane→PR lookup. False means no network or IPC work runs and
  /// the badge state stays empty.
  var resolvesLanePr: Bool { showsLaneActions }

  /// Gate for the PR badge handed to `WorkChatSessionView` above the composer.
  var rendersPrBadge: Bool { resolvesLanePr }
}

struct WorkSessionDestinationView: View {
  @EnvironmentObject var syncService: SyncService
  /// Observed so a mute toggled anywhere (Work-list row menu, settings) flows
  /// into `headerMenuModel` and re-renders the equatable-gated header menu.
  @ObservedObject private var pushNotificationService = PushNotificationService.shared
  @Environment(\.dismiss) var dismiss
  @Environment(\.scenePhase) private var scenePhase

  let sessionId: String
  let initialOpeningPrompt: String?
  var initialOpeningPromptDispatchHandled = false
  var initialOpeningDeliveryState: String? = nil
  var initialOpeningAttachments: [AgentChatFileRef] = []
  let initialSession: TerminalSessionSummary?
  let initialChatSummary: AgentChatSessionSummary?
  let transitionNamespace: Namespace.ID?
  let isLive: Bool
  let navigationChrome: WorkSessionNavigationChrome
  var showsLaneActions = true
  var navigationTitleOverride: String?
  /// Lanes forwarded to the chat composer for `@`-mention autocomplete.
  var lanes: [LaneSummary] = []
  /// Lanes are immutable for this mounted destination. Compute the render
  /// signature once instead of hashing every lane on each streaming update.
  let lanesRenderSignature: Int
  /// Set when this chat is opened from the hub as a cross-project "quick look":
  /// the session lives in a project OTHER than the phone's active one and
  /// streams read-only without a project switch. Nil for the ordinary
  /// same-project path. When set, transcript/streaming/sends route to that
  /// project (via the sync scope registered on appear) and active-project-only
  /// affordances (local DB row observation, lane presence, PR badges, proof
  /// artifacts) are gated off — the existing full-detail path is untouched.
  var crossProjectContext: WorkChatCrossProjectContext?
  /// Machine-scoped, projectless conversation. Uses the same transcript and
  /// composer as Work while routing every chat operation through
  /// `personalChats.*` and hiding project-only chrome.
  var personalChat = false
  /// CTO uses the Work transcript pipeline with a single-line voice/send
  /// composer. Model, reasoning, fast mode, and identity live in CTO settings.
  var compactComposer = false
  /// CTO again: that session may never queue a message, because the host turns
  /// a queued delivery on it into a live redirect. Kept separate from
  /// `showsLaneActions` and `compactComposer` so none of the three drifts into
  /// standing for the others.
  var liveRedirectOnlySends = false

  @MainActor
  init(
    sessionId: String,
    initialOpeningPrompt: String?,
    initialOpeningPromptDispatchHandled: Bool = false,
    initialOpeningDeliveryState: String? = nil,
    initialOpeningAttachments: [AgentChatFileRef] = [],
    initialSession: TerminalSessionSummary?,
    initialChatSummary: AgentChatSessionSummary?,
    transitionNamespace: Namespace.ID?,
    isLive: Bool,
    navigationChrome: WorkSessionNavigationChrome,
    showsLaneActions: Bool = true,
    navigationTitleOverride: String? = nil,
    lanes: [LaneSummary] = [],
    crossProjectContext: WorkChatCrossProjectContext? = nil,
    personalChat: Bool = false,
    compactComposer: Bool = false,
    liveRedirectOnlySends: Bool = false
  ) {
    self.sessionId = sessionId
    self.initialOpeningPrompt = initialOpeningPrompt
    self.initialOpeningPromptDispatchHandled = initialOpeningPromptDispatchHandled
    self.initialOpeningDeliveryState = initialOpeningDeliveryState
    self.initialOpeningAttachments = initialOpeningAttachments
    self.initialSession = initialSession
    self.initialChatSummary = initialChatSummary
    self.transitionNamespace = transitionNamespace
    self.isLive = isLive
    self.navigationChrome = navigationChrome
    self.showsLaneActions = showsLaneActions
    self.navigationTitleOverride = navigationTitleOverride
    self.lanes = lanes
    self.lanesRenderSignature = workLaneListRenderSignature(lanes)
    self.crossProjectContext = crossProjectContext
    self.personalChat = personalChat
    self.compactComposer = compactComposer
    self.liveRedirectOnlySends = liveRedirectOnlySends

    _session = State(initialValue: initialSession)
    _chatSummary = State(initialValue: initialChatSummary)
    _lastKnownChatSummary = State(initialValue: initialChatSummary)
    // The thread engine for this chat, synchronously: a warm chat's frame is
    // already there for the first render, a cold one starts its disk load now.
    // The scope is registered first so the key matches the one SyncService
    // routes this chat's frames to. Both calls are idempotent, so a re-init of
    // this struct costs a dictionary lookup.
    if let sync = SyncService.shared {
      workRegisterChatCommandScope(
        sync,
        sessionId: sessionId,
        personalChat: personalChat,
        crossProjectContext: crossProjectContext
      )
      if let key = sync.chatThreadKey(for: sessionId) {
        ChatThreadSignposts.beginOpen(sessionId: sessionId)
        _threadKey = State(initialValue: key)
        _threadModel = State(initialValue: sync.chatThreadRegistry.model(for: key))
      }
    }
  }

  /// Whether this view is a cross-project "quick look" (see `crossProjectContext`).
  /// Becomes false once the background Hub activate commits, so Send/approve
  /// and history paging switch to the active-project path without remounting.
  var isCrossProject: Bool {
    hubChatIsForeignProject(
      context: crossProjectContext,
      ownerIsActive: crossProjectContext.map {
        syncService.isActiveProject(id: $0.projectId, rootPath: $0.projectRootPath)
      } ?? false
    )
  }
  var isRemoteOnlyChat: Bool { isCrossProject || personalChat }
  /// Single gate for lane→PR work in this destination. See `WorkChatLanePrPolicy`.
  var resolvesLanePr: Bool {
    WorkChatLanePrPolicy(showsLaneActions: showsLaneActions).resolvesLanePr
  }

  @State var session: TerminalSessionSummary?
  @State var chatSummary: AgentChatSessionSummary?
  // Last non-nil summary this mounted instance ever observed. The composer's
  // model-picker + permission-mode row is gated on `summary.isAvailable`, so a
  // momentary nil summary would blank those controls mid-session. This latch
  // (plus the sync cache) backstops the coalesce in `composerChatSummary` so
  // once the controls have rendered they never disappear while the view stays
  // mounted.
  @State var lastKnownChatSummary: AgentChatSessionSummary?
  /// This chat's thread engine face (see `ChatThreadModel`). Every transcript
  /// the destination reads — echo reconciliation, steer reconciliation, the
  /// subagent roster — comes from its frame. Nil only without a SyncService.
  @State var threadModel: ChatThreadModel?
  @State var threadKey: ChatThreadKey?
  /// Whether this mounted view holds an attach on `threadKey` (keeps the
  /// engine from being evicted while it is on screen).
  @State var threadAttached = false
  @State var threadSubscriptionOpened = false
  /// Count + last id of the transcript the subagent / schedule snapshots were
  /// last derived from. Streaming text deltas do not change it, so the roster
  /// scan runs per new envelope rather than per token.
  @State var chatInfoTranscriptShape = ""
  @State var artifacts: [ComputerUseArtifactSummary] = []
  @State var localEchoMessages: [WorkLocalEchoMessage] = []
  /// Post-send reconciliation runs behind the composer rather than in front of
  /// it, so `sending` can drop the moment the host accepts the message. Chained
  /// rather than fire-and-forget: two quick sends must not interleave two
  /// transcript loads.
  @State var postSendRefreshTask: Task<Void, Never>?
  @State private var hubActivationRebindTask: Task<Void, Never>?
  @State private var chatDestinationVisible = false
  @State var optimisticPendingSteers: [WorkPendingSteerModel] = []
  @State var subagentSnapshots: [WorkSubagentSnapshot] = []
  @State var subagentSnapshotsRenderSignature = 0
  @State var remoteSubagentSnapshots: [WorkSubagentSnapshot] = []
  @State var scheduledWorkSnapshots: [WorkScheduledWorkSnapshot] = []
  @State var scheduledWorkSnapshotsRenderSignature = 0
  @State var chatInfoPresented = false
  @State var expandedSubagentDetailIds: Set<String> = []
  @State var remoteSubagentRefreshInFlight = false
  /// Central expansion state for every collapsible transcript card. Lives
  /// here, above the list, so it survives `LazyVStack` recycling and can be
  /// swept in one move when a turn ends.
  @State var cardExpansion = WorkCardExpansionState()
  @State var artifactContent: [String: WorkLoadedArtifactContent] = [:]
  @State var artifactContentRenderSignature = 0
  @State var artifactContentLoadsInFlight = Set<String>()
  @State var artifactRefreshInFlight = false
  @State var artifactRefreshError: String?
  @State var fullscreenImage: WorkFullscreenImage?
  @State var artifactDrawerPresented = false
  @State var sending = false
  @State var errorMessage: String?
  @State var openingDeliveryWarning: String?
  @State var announcedLaneId: String?
  /// Lane→PR resolved asynchronously for the header overflow menu's "Open PR"
  /// item. Nil until resolved (or when the lane has no cached PR), which keeps
  /// that menu item disabled with a "No PR yet" hint.
  @State var laneOpenPr: PullRequestListItem?
  @State var lanePrSummary: PrSummary?
  @State var lanePrTag: LanePrTag?
  /// Every pull request this chat is linked to, primary first. A chat is not
  /// capped at one PR — the lane may own several, and a PR opened on another
  /// lane can be linked to this session explicitly.
  @State var laneChatPrs: [PullRequestListItem] = []
  /// The user's pick from the switcher. Nil means "show what the resolver
  /// chose", which is the primary row.
  @State var selectedChatPrId: String?
  /// Lane the last completed PR resolve ran for; lets same-lane re-resolves
  /// keep showing the current PR instead of clearing it first.
  @State var lastResolvedPrLaneId: String?
  @State var prCreateCapabilities: PrCreateCapabilities?
  @State var createPrPresented = false
  @State var createPrAfterDetailsDismiss = false
  @State var prDetailsPresented = false
  @State var prDetailsSnapshot: PullRequestSnapshot?
  @State var prDetailsRefreshing = false
  @State var prDetailsError: String?
  /// Generation of the newest PR-details refresh. `refreshChatPrDetails(force:)`
  /// deliberately bypasses the `prDetailsRefreshing` guard, so two refreshes can
  /// overlap when the user switches PRs quickly; every refresh-state write is
  /// gated on still owning this token, which keeps a slower earlier request from
  /// publishing its error or clearing the spinner for the one still in flight.
  /// The refresh hands the same token to `resolveLaneOpenPr`, so a superseded
  /// request cannot republish its older PR list or clear the newer pick either.
  @State var prDetailsRequestToken = 0
  @State var prLinkCopied = false
  @State var sessionActionRenamePresented = false
  @State var sessionActionRenameText = ""
  @State var sessionIdCopied = false
  @State var sessionDeepLinkCopied = false
  @State var lastSessionRowRefreshAt = Date.distantPast
  @State var lastArtifactRefreshAt = Date.distantPast
  @State var initialLoadCompleted = false
  @State var openingLoadInFlight = false
  @State var handledOpeningPromptKey: String?
  @State var stagedOpeningPromptKey: String?
  @State var composerDraftRestore: WorkChatComposerDraftRestore?

  var initialOpeningPromptNeedsManualRetry: Bool {
    initialOpeningPromptDispatchHandled
      && initialOpeningDeliveryState == "failed"
      && !trimmedInitialOpeningPrompt.isEmpty
  }

  /// The engine's folded transcript. Read-only here: the destination never
  /// builds or merges a transcript of its own.
  var transcript: [WorkChatEnvelope] {
    threadModel?.frame?.transcript ?? []
  }

  @MainActor
  func setArtifacts(_ next: [ComputerUseArtifactSummary]) {
    artifacts = next
  }

  @MainActor
  func refreshArtifactContentRenderSignature() {
    artifactContentRenderSignature = workLoadedArtifactContentRenderSignature(artifactContent)
  }

  @MainActor
  func setArtifactContent(_ content: WorkLoadedArtifactContent, for artifactId: String) {
    artifactContent[artifactId] = content
    refreshArtifactContentRenderSignature()
  }

  @MainActor
  func removeArtifactContent(for artifactId: String) {
    artifactContent.removeValue(forKey: artifactId)
    refreshArtifactContentRenderSignature()
  }

  var sessionDestinationNavigationTitle: String {
    if let navigationTitleOverride {
      return navigationTitleOverride
    }
    return chatSummary?.title ?? session?.title ?? "Session"
  }

  /// The machine name under the header title: the host this phone is
  /// connected to. The project is deliberately not repeated here.
  var sessionDestinationNavigationSubtitle: String? {
    workChatHeaderSubtitle(
      machineName: syncService.hostName ?? syncService.activeHostProfile?.hostName
    )
  }

  /// Summary the composer's model/permission controls render from. Every other
  /// status read coalesces `chatSummary ?? initialChatSummary`, but the composer
  /// context was the lone consumer reading bare `chatSummary` — so a
  /// push/deeplink rebuild (new `.id`, @State reset) that re-seeds from a nil
  /// `initialChatSummary` (the open session can be evicted from the summary
  /// cache by a partial Work-list refresh) blanked the controls. Coalesce
  /// through the seed, the in-view latch, and finally the durable sync cache so
  /// the controls survive both the rebuild and any transient nil.
  var composerChatSummary: AgentChatSessionSummary? {
    chatSummary
      ?? initialChatSummary
      ?? lastKnownChatSummary
      ?? syncService.chatSummaryCache[sessionId]
  }

  var cursorCloudMirrorWatchKey: String {
    let agentId = composerChatSummary?.cursorCloudAgentId?
      .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let active = scenePhase == .active ? "active" : "inactive"
    return "\(sessionId)|\(agentId)|\(active)"
  }

  var subagentProvider: String? {
    chatSummary?.provider ?? workChatProviderFamilyFromToolType((session ?? initialSession)?.toolType)
  }

  var subagentCapability: WorkSubagentCapability {
    workResolveSubagentCapability(provider: subagentProvider)
  }



  var hostReachable: Bool {
    syncService.connectionState == .connected
  }

  /// Live polling/load gates require BOTH the parent's "session is live" flag
  /// AND a reachable host. Using `hostReachable` alone enables chat actions
  /// for sessions the parent considers ended/archived.
  var isLiveAndReachable: Bool {
    isLive && hostReachable
  }

  var canComposeChatMessages: Bool {
    session != nil || initialSession != nil
  }

  var canSendChatMessages: Bool {
    let sendSupported = personalChat
      ? syncService.supportsRemoteAction("personalChats.send")
      : syncService.supportsChatRemoteAction("chat.send", sessionId: sessionId)
    guard sendSupported else { return false }
    return workChatCanSendMessages(
      isLive: isLive,
      hostReachable: hostReachable,
      chatSendQueueable: personalChat
        ? syncService.isRemoteActionQueueable("personalChats.send")
        : syncService.isChatRemoteActionQueueable("chat.send", sessionId: sessionId)
    )
  }

  var sendWillQueueChatMessage: Bool {
    workChatSendWillQueueMessage(
      isLive: isLive,
      hostReachable: hostReachable,
      chatSendQueueable: personalChat
        ? syncService.isRemoteActionQueueable("personalChats.send")
        : syncService.isChatRemoteActionQueueable("chat.send", sessionId: sessionId)
    )
  }

  /// Deliberately row-authoritative (does NOT consult `liveTurnActiveHint`):
  /// a stale-true hint must never route a fresh message into the steer queue
  /// of an idle session, where it could sit undispatched. During the window
  /// where the hint is true but the row hasn't flipped yet, `sendMessage`'s
  /// "turn already active" error fallback retries the send as a steer.
  var shouldSteerActiveTurn: Bool {
    hostReachable && workChatShouldSteerActiveTurn(session: session, summary: chatSummary)
  }

  /// Live host-side "turn is running" hint (chat_subscribe ack + status/done
  /// events), tracked by the thread engine. Fresher than the synced session
  /// row, which arrives via the slower changeset pump.
  var liveTurnActiveHint: Bool? {
    threadModel?.frame?.hostTurnActiveHint
  }

  /// Host-gated as well as provider-gated. A brain that predates
  /// `chat.dispatchSteer` can neither promote a staged row nor honor an atomic
  /// `dispatchMode`, so the staged strip's buttons and the send path have to
  /// read the same empty list — otherwise the send path would ask for a mode
  /// the strip is hiding the recovery for.
  var manualSteerDispatchModes: [WorkActiveSendMode] {
    guard syncService.supportsChatRemoteAction("chat.dispatchSteer", sessionId: sessionId) else {
      return []
    }
    return workChatManualSteerDispatchModes(session: session, summary: composerChatSummary ?? chatSummary)
  }

  /// Lane id the header menu acts on. Resolved against the loaded lane list so
  /// the PR lookup and lane navigation share one canonical id; empty when no
  /// session is available yet (menu is then hidden).
  var headerMenuLaneId: String {
    guard let session = session ?? initialSession else { return "" }
    return resolvedWorkNavigationLaneId(for: session, lanes: lanes)
  }

  var headerMenuPrLookupKey: String {
    let laneId = headerMenuLaneId.trimmingCharacters(in: .whitespacesAndNewlines)
    let githubKey = syncService.laneGithubPrItems
      .map { "\($0.id):\($0.state):\($0.isDraft):\($0.updatedAt):\($0.linkedPrId ?? "")" }
      .joined(separator: "|")
    return "\(laneId)|\(syncService.prsProjectionRevision)|\(githubKey)"
  }

  /// Trailing nav-bar overflow menu for chat sessions: proof drawer plus lane
  /// shortcuts when the session is lane-backed.
  @ViewBuilder
  var sessionHeaderTrailingControls: some View {
    if let session, isChatSession(session) {
      HStack(spacing: 8) {
        WorkChatHeaderMenu(
          model: headerMenuModel(session),
          onShowChatInfo: { Task { await prepareChatInfoPresentation() } },
          onShowProof: { artifactDrawerPresented = true },
          onViewPrDetails: { presentChatPrDetails() },
          onOpenPrsTab: { openLaneOpenPr() },
          onOpenGitHub: { openLanePrOnGitHub() },
          onCopyPrLink: { copyLanePrLink() },
          onOpenPrCreation: { openPrCreationInPrsTab() },
          onOpenLane: { openSessionLane() },
          onRename: { presentSessionRename() },
          onDelete: { Task { await deleteCurrentChatSession() } },
          onCopySessionId: { copyCurrentSessionId() },
          onCopySessionDeepLink: { copyCurrentSessionDeepLink() },
          onTogglePinned: { Task { await toggleCurrentSessionPinned() } },
          onAttachIssue: {
            ADEHaptics.light()
            syncService.linearPaneAttachSessionId = session.id
            syncService.linearPanePresented = true
          }
        )
        .equatable()
      }
    } else {
      EmptyView()
    }
  }

  private func headerMenuModel(_ session: TerminalSessionSummary) -> WorkChatHeaderMenuModel {
    WorkChatHeaderMenuModel(
      // Chat Info now owns subagents + background + schedule, so its badge count
      // is the sum across all three sections (mirrors desktop's chat-info pane).
      chatInfoCount: workChatInfoItemCount(
        subagents: subagentSnapshots,
        scheduledWork: scheduledWorkSnapshots
      ),
      artifactCount: artifacts.count,
      showsLaneActions: showsLaneActions && !personalChat,
      prTag: lanePrTag,
      prGitHubUrlAvailable: !lanePrGitHubUrlString.isEmpty,
      prLinkCopied: prLinkCopied,
      laneAvailable: !headerMenuLaneId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
      createPrBlockedReason: createPullRequestBlockedReason,
      sessionPinned: session.pinned,
      sessionIdCopied: sessionIdCopied,
      sessionDeepLinkCopied: sessionDeepLinkCopied,
      sessionId: session.id,
      sessionMuted: pushNotificationService.prefs.mutedSessionIds.contains(session.id),
      showsProof: !personalChat,
      showsPinAction: !personalChat,
      showsSessionLink: !personalChat,
      canAttachIssue: syncService.canInvokeRemoteAction("lane.attachLinearIssueToSession"),
      showsRename: !CursorCloudNaming.ownsName(
        composerChatSummary?.cursorCloudAgentId ?? session.cursorCloudAgentId
      )
    )
  }

  /// Follows the switcher: "Open on GitHub" must open the PR on screen, not the
  /// one the resolver happened to pick first.
  var lanePrGitHubUrlString: String {
    (chatDisplayPrTag?.githubUrl ?? chatDisplayPr?.githubUrl ?? "")
      .trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private var headerMenuLaneColor: Color? {
    let laneId = headerMenuLaneId.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !laneId.isEmpty,
          let lane = lanes.first(where: { $0.id == laneId })
    else { return nil }
    return LaneColorPalette.color(forHex: lane.color)
  }

  private var canCreatePullRequestForHeaderLane: Bool {
    guard hostReachable else { return false }
    let laneId = headerMenuLaneId.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !laneId.isEmpty else { return false }
    if let eligibility = prCreateCapabilities?.lanes.first(where: { $0.laneId == laneId }) {
      return eligibility.canCreate
    }
    if let capabilities = prCreateCapabilities {
      return capabilities.canCreateAny
    }
    return !lanes.isEmpty
  }

  private var createPullRequestBlockedReason: String? {
    let laneId = headerMenuLaneId.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !laneId.isEmpty else { return nil }
    let reason = prCreateCapabilities?
      .lanes
      .first(where: { $0.laneId == laneId })?
      .blockedReason?
      .trimmingCharacters(in: .whitespacesAndNewlines)
    guard let reason, !reason.isEmpty else { return nil }
    return reason
  }

  @ViewBuilder
  private var chatCreatePrWizardSheet: some View {
    let laneId = headerMenuLaneId.trimmingCharacters(in: .whitespacesAndNewlines)
    CreatePrWizardView(
      lanes: lanes,
      createCapabilities: prCreateCapabilities,
      initialLaneId: laneId.isEmpty ? nil : laneId,
      singleModeOnly: true,
      onCreateSingle: handleChatCreateSinglePr,
      onCreateIntegration: { _ in false }
    )
    .environmentObject(syncService)
    .presentationDetents([.large])
    .presentationDragIndicator(.visible)
    .presentationContentInteraction(.scrolls)
  }

  var sessionDestinationZoomTransitionId: String? {
    transitionNamespace == nil ? nil : "work-container-\(sessionId)"
  }

  /// Terminal sessions render `TerminalSessionScreen`, which brings its own
  /// slim full-bleed top bar — the shared pushed-detail chrome would stack a
  /// second header on top of it.
  private var isFullScreenTerminalSession: Bool {
    guard let current = session ?? initialSession else { return false }
    return !isChatSession(current)
  }

  private var scheduledWorkCancelAction: (@MainActor (WorkScheduledWorkSnapshot) async -> Void)? {
    guard syncService.canInvokeChatRemoteAction("chat.cancelScheduledWork", sessionId: sessionId) else {
      return nil
    }
    return { item in
      do {
        let result = try await syncService.cancelScheduledWork(sessionId: sessionId, scheduleId: item.id)
        applyScheduledWorkCancellationResult(result)
        await refreshChatSummaryFromHost()
        refreshScheduledWorkSnapshots()
      } catch {
        errorMessage = error.localizedDescription
      }
    }
  }

  private var scheduledWorkPauseAction: (@MainActor (Bool) async -> Void)? {
    guard syncService.canInvokeChatRemoteAction("chat.setScheduledWorkPaused", sessionId: sessionId) else {
      return nil
    }
    return { paused in
      await setScheduledWorkPausedOptimistically(paused)
    }
  }

  private var stopTaskAction: (@MainActor (String) async -> Void)? {
    guard syncService.canInvokeChatRemoteAction("chat.stopTask", sessionId: sessionId) else {
      return nil
    }
    return { taskId in
      await stopChatTask(taskId: taskId)
    }
  }

  @MainActor
  private func setScheduledWorkPausedOptimistically(_ paused: Bool) async {
    let previousSummary = composerChatSummary
    if var optimisticSummary = previousSummary {
      optimisticSummary.scheduledWorkPaused = paused
      chatSummary = optimisticSummary
      lastKnownChatSummary = optimisticSummary
    }

    do {
      let result = try await syncService.setScheduledWorkPaused(sessionId: sessionId, paused: paused)
      if var confirmedSummary = composerChatSummary {
        confirmedSummary.scheduledWorkPaused = result.paused
        confirmedSummary.nextWakeAt = result.nextWakeAt
        chatSummary = confirmedSummary
        lastKnownChatSummary = confirmedSummary
      }
      await refreshChatSummaryFromHost()
      refreshScheduledWorkSnapshots()
    } catch {
      if let previousSummary {
        chatSummary = previousSummary
        lastKnownChatSummary = previousSummary
      }
      errorMessage = error.localizedDescription
    }
  }

  var body: some View {
    sessionDestinationRoot
      .workSessionNavigationChrome(
        mode: isFullScreenTerminalSession ? .embedded : navigationChrome,
        title: sessionDestinationNavigationTitle,
        subtitle: sessionDestinationNavigationSubtitle,
        trailingControls: { sessionHeaderTrailingControls }
      )
      .adeNavigationZoomTransition(id: sessionDestinationZoomTransitionId, in: transitionNamespace)
      .adeAnalyticsScreen(.workSession)
      .sheet(item: $fullscreenImage) { image in
        WorkFullscreenImageView(image: image)
      }
      .sheet(isPresented: $chatInfoPresented) {
        WorkChatInfoDetailsSheet(
          sessionId: sessionId,
          subagentSnapshots: subagentSnapshots,
          scheduledWorkSnapshots: scheduledWorkSnapshots,
          scheduledWorkPaused: composerChatSummary?.scheduledWorkPaused == true,
          nextWakeAt: composerChatSummary?.nextWakeAt,
          provider: subagentProvider,
          expandedTaskIds: $expandedSubagentDetailIds,
          sessionModel: composerChatSummary?.model,
          onSelect: handleSubagentSelection,
          onCancelScheduledWork: scheduledWorkCancelAction,
          onSetScheduledWorkPaused: scheduledWorkPauseAction,
          onStopTask: stopTaskAction
        )
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .task {
          await refreshRemoteSubagentSnapshots()
        }
      }
      .sheet(isPresented: $createPrPresented) {
        chatCreatePrWizardSheet
      }
      .sheet(isPresented: $prDetailsPresented, onDismiss: {
        if createPrAfterDetailsDismiss {
          createPrAfterDetailsDismiss = false
          createPrPresented = true
        }
      }) {
        WorkChatPrDetailsSheet(
          tag: chatDisplayPrTag,
          pr: chatDisplayPr,
          summary: chatDisplayPrSummary,
          snapshot: prDetailsSnapshot,
          laneColor: headerMenuLaneColor,
          canCreate: canCreatePullRequestForHeaderLane,
          createBlockedReason: createPullRequestBlockedReason,
          isRefreshing: prDetailsRefreshing,
          errorMessage: prDetailsError,
          onRefresh: {
            Task { await refreshChatPrDetails(force: true) }
          },
          onCreate: {
            presentCreateLanePr()
          },
          onOpenPrsTab: {
            // The DISPLAYED PR decides, not the lane's resolved one: a PR this
            // chat linked from another lane shows in the switcher while
            // `lanePrTag` stays nil, and branching on the lane tag sent the
            // user to the creation flow instead of to the PR they picked.
            if chatDisplayPrTag == nil {
              openPrCreationInPrsTab()
            } else {
              openLaneOpenPr()
            }
          },
          onOpenGitHub: openLanePrOnGitHub,
          linkedPrs: laneChatPrs,
          selectedPrId: chatDisplayPr?.id,
          onSelectPr: { selectChatPr($0) }
        )
        .presentationDetents([.height(500), .large])
        .presentationDragIndicator(.visible)
        .presentationContentInteraction(.scrolls)
      }
      .alert("Rename session", isPresented: $sessionActionRenamePresented) {
        TextField("Title", text: $sessionActionRenameText)
        Button("Cancel", role: .cancel) {
          sessionActionRenameText = ""
        }
        Button("Save") {
          let title = sessionActionRenameText
          Task { await submitCurrentSessionRename(title) }
        }
      } message: {
        Text("Give this session a clearer title for search, pinning, and activity tracking.")
      }
      .onAppear {
        chatDestinationVisible = true
        // Install remote routing synchronously with presentation so the first
        // user interaction cannot race the async load task and accidentally
        // fall back to the active project.
        registerChatCommandScope()
        attachThreadModel()
        syncThreadOverlays()
        // Same run-loop turn as the attach: the subscribe (with the engine's
        // durable resume point when the host has one) goes out before the
        // summary/artifact loads below.
        openThreadSubscriptionIfNeeded()
      }
      .onChange(of: isCrossProject) { wasForeign, isForeign in
        switch hubChatActivationScopeTransition(wasForeign: wasForeign, isForeign: isForeign) {
        case .rebindToActive:
          hubActivationRebindTask?.cancel()
          // Drop foreign routing on this turn so Send/approve cannot keep
          // targeting a project that is now the active one.
          syncService.clearCrossProjectChatScope(sessionId: sessionId)
          hubActivationRebindTask = Task { await rebindChatAfterHubActivation() }
        case .restoreForeign:
          hubActivationRebindTask?.cancel()
          if let announcedLaneId {
            syncService.releaseLaneOpen(laneId: announcedLaneId)
            self.announcedLaneId = nil
          }
          // Register before any await. A send can land in the same turn as the
          // rollback; without this, chatCommandScopeBySession is empty and the
          // message routes to the restored active project instead of the owner.
          registerChatCommandScope()
          hubActivationRebindTask = Task { await restoreForeignChatScopeAfterActivationRollback() }
        case .none:
          break
        }
      }
      .task {
        // Cross-project "quick look": register the foreign scope BEFORE load()
        // so every summary/send routes to that project without switching the
        // phone's active project.
        registerChatCommandScope()
        if session == nil {
          session = initialSession
        }
        if chatSummary == nil {
          chatSummary = initialChatSummary
        }
        if lastKnownChatSummary == nil {
          lastKnownChatSummary = initialChatSummary
        }
        if initialOpeningPromptNeedsManualRetry, let initialOpeningPrompt {
          composerDraftRestore = WorkChatComposerDraftRestore(text: initialOpeningPrompt)
          openingDeliveryWarning = SyncRequestTimeout.chatSendMessage
        }
        stageInitialOpeningPromptEchoIfNeeded()
        await load()
        initialLoadCompleted = true
        await sendInitialOpeningPromptIfNeeded()
        refreshChatInfoSnapshots()
        // Remote subagent probing hits the host; skip the eager pass for a
        // cross-project quick look (the drawer still loads it on demand).
        if !isRemoteOnlyChat {
          await refreshRemoteSubagentSnapshots()
        }
      }
      .onChange(of: threadModel?.frame?.revision) { _, _ in
        handleThreadFrameApplied()
      }
      .onChange(of: threadOverlayInputs) { _, _ in
        syncThreadOverlays()
      }
      .onChange(of: workChatTranscriptPreferenceStatus(
        sessionStatus: normalizedWorkChatSessionStatus(session: session, summary: chatSummary),
        liveTurnActiveHint: liveTurnActiveHint
      )) { previous, current in
        // On the active -> non-active transition, force a canonical refresh so
        // any staged steers the host delivered at turn end stop lingering when
        // their graduation events never reached the phone. Keyed on the effective
        // status (which downgrades a stale-active row to idle via the fresher
        // liveTurnActiveHint) so the belt still fires when the row lags.
        guard previous == "active", current != "active" else { return }
        Task { await reconcileOptimisticSteersAfterTurnEnd() }
      }
      .task(id: sessionRowObservationKey) {
        // A cross-project quick look has no local DB row for this session (only
        // the active project is mirrored) — status comes from the streamed
        // chat summary / turn hint instead.
        guard !isRemoteOnlyChat else { return }
        // Session rows arrive through CRDT-backed local DB updates, not chat
        // event streams. Observe work projection changes without also poking
        // proof refresh state on every normal chat revision.
        try? await Task.sleep(nanoseconds: 320_000_000)
        guard !Task.isCancelled else { return }
        // The session row is the status source for the stop button and the
        // poll-loop gate. Without this re-read, a turn started on desktop
        // while this view is open in an idle state never updates the local
        // @State row — the chat streams output but renders as frozen
        // (pollIfNeeded bails on non-active status and nothing else
        // observes the DB).
        guard shouldRefreshSessionRowFromLocalStore() else { return }
        await refreshSessionRowFromLocalStore()
      }
      .task(id: artifactObservationKey) {
        // Proof artifacts are served from the active project's projection; a
        // cross-project quick look has no access to the foreign project's proof
        // drawer, so leave it empty rather than querying the wrong project.
        guard !isRemoteOnlyChat else { return }
        // Proof rows arrive through their own projection. Keep this separate
        // from work row refreshes so live chat deltas don't churn artifact
        // loading state.
        try? await Task.sleep(nanoseconds: 320_000_000)
        guard !Task.isCancelled else { return }
        await refreshArtifacts(force: false)
      }
      .task(id: session?.laneId ?? initialSession?.laneId ?? "") {
        await syncLanePresence()
      }
      .task(id: headerMenuPrLookupKey) {
        // PR + lane presence lookups read the active project's caches; skip
        // them for a cross-project quick look (the header hides lane/PR actions).
        guard !isRemoteOnlyChat else { return }
        // A chat with no lane PR of its own (CTO) never resolves one — the
        // create-PR capabilities probe backs the same hidden header items.
        guard resolvesLanePr else { return }
        await resolveLaneOpenPr(for: headerMenuLaneId)
        await loadPrCreateCapabilitiesIfNeeded()
      }
      .task(id: pollingKey) {
        await pollIfNeeded()
      }
      .task(id: cursorCloudMirrorWatchKey) {
        let watchId = sessionId
        let agentId = composerChatSummary?.cursorCloudAgentId?
          .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard scenePhase == .active, !agentId.isEmpty else { return }
        await syncService.watchCursorCloudMirror(sessionId: watchId, watching: true)
        await withTaskCancellationHandler {
          while !Task.isCancelled {
            do {
              try await Task.sleep(nanoseconds: 3_600_000_000_000)
            } catch {
              break
            }
          }
        } onCancel: {
          Task {
            await syncService.watchCursorCloudMirror(sessionId: watchId, watching: false)
          }
        }
      }
      .onChange(of: chatSummary) { _, newValue in
        // Latch the last non-nil summary so the composer's model/permission
        // controls survive a transient nil while this view stays mounted.
        if let newValue {
          lastKnownChatSummary = newValue
        }
        refreshScheduledWorkSnapshots()
      }
      .onChange(of: chatInfoPresented) { _, presented in
        handleChatInfoPresentationChange(presented)
      }
      .onDisappear {
        chatDestinationVisible = false
        detachThreadModel()
        // The next appearance re-retains the stream (cancelling the delayed
        // unsubscribe scheduled below) and resumes it if it closed.
        threadSubscriptionOpened = false
        ChatThreadSignposts.cancelOpen(sessionId: sessionId)
        hubActivationRebindTask?.cancel()
        hubActivationRebindTask = nil
        if let announcedLaneId {
          syncService.releaseLaneOpen(laneId: announcedLaneId)
          self.announcedLaneId = nil
        }
        cleanupLoadedArtifactContent()
        postSendRefreshTask?.cancel()
        postSendRefreshTask = nil
        let wasCrossProject = isCrossProject
        let wasPersonalChat = personalChat
        if wasCrossProject || wasPersonalChat {
          Task { @MainActor in
            try? await syncService.unsubscribeFromChatEvents(sessionId: sessionId)
            // Preserve routing through the unsubscribe payload, then drop it
            // so a later ordinary project chat with the same id cannot inherit
            // the foreign/runtime scope.
            if wasCrossProject {
              syncService.clearCrossProjectChatScope(sessionId: sessionId)
            } else {
              syncService.clearPersonalChatScope(sessionId: sessionId)
            }
          }
        } else if let currentSession = session ?? initialSession,
                  isChatSession(currentSession) {
          syncService.scheduleChatEventUnsubscribe(sessionId: sessionId)
        }
      }
  }

  /// Foreign Hub open → owning project committed. The switch tears the socket
  /// and clears chat subscriptions; clearing the scope map alone would leave
  /// this session unsubscribed. Rebind onto the active-project stream.
  @MainActor
  func rebindChatAfterHubActivation() async {
    guard hubChatShouldContinueActivationRebind(
      destinationVisible: chatDestinationVisible,
      taskCancelled: Task.isCancelled
    ) else { return }
    syncService.clearCrossProjectChatScope(sessionId: sessionId)
    guard hubChatShouldContinueActivationRebind(
      destinationVisible: chatDestinationVisible,
      taskCancelled: Task.isCancelled
    ) else { return }
    guard let currentSession = session ?? initialSession, isChatSession(currentSession) else {
      return
    }
    syncService.retainChatEventSubscription(sessionId: sessionId)
    guard hubChatShouldContinueActivationRebind(
      destinationVisible: chatDestinationVisible,
      taskCancelled: Task.isCancelled
    ) else {
      syncService.scheduleChatEventUnsubscribe(sessionId: sessionId)
      return
    }
    // The scope changed, so the engine key did too: attach the active-project
    // engine before its snapshot arrives.
    rebindThreadModelIfNeeded()
    _ = try? await syncService.subscribeToChatEvents(sessionId: sessionId, requestSnapshot: true)
    guard hubChatShouldContinueActivationRebind(
      destinationVisible: chatDestinationVisible,
      taskCancelled: Task.isCancelled
    ) else {
      syncService.scheduleChatEventUnsubscribe(sessionId: sessionId)
      return
    }
    await syncLanePresence()
  }

  /// Activation committed, then `switchToDesktopProject` restored the previous
  /// project. Foreign scope was cleared on the way in; put it back so send and
  /// transcript stay on the chat's owner.
  @MainActor
  func restoreForeignChatScopeAfterActivationRollback() async {
    guard hubChatShouldContinueActivationRebind(
      destinationVisible: chatDestinationVisible,
      taskCancelled: Task.isCancelled
    ) else { return }
    if let announcedLaneId {
      syncService.releaseLaneOpen(laneId: announcedLaneId)
      self.announcedLaneId = nil
    }
    registerChatCommandScope()
    guard hubChatShouldContinueActivationRebind(
      destinationVisible: chatDestinationVisible,
      taskCancelled: Task.isCancelled
    ) else { return }
    guard let currentSession = session ?? initialSession, isChatSession(currentSession) else {
      return
    }
    syncService.retainChatEventSubscription(sessionId: sessionId)
    guard hubChatShouldContinueActivationRebind(
      destinationVisible: chatDestinationVisible,
      taskCancelled: Task.isCancelled
    ) else {
      syncService.scheduleChatEventUnsubscribe(sessionId: sessionId)
      return
    }
    rebindThreadModelIfNeeded()
    _ = try? await syncService.subscribeToChatEvents(sessionId: sessionId, requestSnapshot: true)
    guard hubChatShouldContinueActivationRebind(
      destinationVisible: chatDestinationVisible,
      taskCancelled: Task.isCancelled
    ) else {
      syncService.scheduleChatEventUnsubscribe(sessionId: sessionId)
      return
    }
  }

  func registerChatCommandScope() {
    workRegisterChatCommandScope(
      syncService,
      sessionId: sessionId,
      personalChat: personalChat,
      crossProjectContext: crossProjectContext
    )
  }

  @ViewBuilder
  var sessionDestinationRoot: some View {
    if let session {
      if isChatSession(session) {
        chatSessionDestinationRoot(for: session)
      } else {
        TerminalSessionScreen(session: session)
          .environmentObject(syncService)
      }
    } else {
      if initialLoadCompleted {
        ADEEmptyStateView(
          symbol: "bubble.left.and.bubble.right",
          title: "Session unavailable",
          message: "This session is no longer cached on the phone. Reconnect and refresh Work to restore it."
        )
        .adeScreenBackground()
      } else {
        WorkChatOpeningSessionPlaceholder()
          .accessibilityLabel("Opening session")
      }
    }
  }

  @ViewBuilder
  private func chatSessionDestinationRoot(for session: TerminalSessionSummary) -> some View {
    if let threadModel {
      // Keyed on the engine too: a Hub activation moves the chat to another
      // scope's engine, and the transcript view's scroll state belongs to one.
      makeWorkChatSessionView(for: session, thread: threadModel)
        .id("main-\(session.id)-\(threadModel.key.description)")
    } else {
      WorkChatOpeningSessionPlaceholder()
        .accessibilityLabel("Opening session")
    }
  }

  private func makeWorkChatSessionView(
    for session: TerminalSessionSummary,
    thread: ChatThreadModel
  ) -> WorkChatSessionView {
    let artifactsForView: [ComputerUseArtifactSummary] = artifacts
    let sessionStatus = normalizedWorkChatSessionStatus(session: session, summary: chatSummary)
    let shouldSteer = hostReachable && sessionStatus == "active"
    let prPolicy = WorkChatLanePrPolicy(showsLaneActions: showsLaneActions)
    let chatPrBadge: WorkChatPrBadgeModel? = prPolicy.rendersPrBadge
      ? workChatPrBadgeModel(
          tag: chatDisplayPrTag,
          pr: chatDisplayPr,
          summary: chatDisplayPrSummary,
          linkedCount: laneChatPrs.count
        )
      : nil
    let openPrDetails: (() -> Void)? = prPolicy.rendersPrBadge ? { presentChatPrDetails() } : nil
    let inputLockMessage: String? = nil
    let openLaneAction: (() -> Void)? = showsLaneActions ? { openSessionLane() } : nil
    // Wired per mode, not per provider, so a provider that gains or loses a
    // mode needs no change here. Matches the desktop pane, which gates each
    // handler on the same table.
    // Also host-gated: a brain that predates `chat.dispatchSteer` cannot
    // promote a staged row at all, so the buttons would only ever produce an
    // error toast. `manualSteerDispatchModes` carries the same gate.
    let activeSendModesAvailable = syncService.supportsChatRemoteAction(
      "chat.dispatchSteer",
      sessionId: session.id
    )
    let manualDispatchModes = manualSteerDispatchModes
    let dispatchSteerInlineAction: (@MainActor (String) async -> Void)?
    if manualDispatchModes.contains(.inline) {
      dispatchSteerInlineAction = { steerId in await dispatchSteerInline(steerId) }
    } else {
      dispatchSteerInlineAction = nil
    }
    let dispatchSteerInterruptAction: (@MainActor (String) async -> Void)?
    if manualDispatchModes.contains(.interrupt) {
      dispatchSteerInterruptAction = { steerId in await dispatchSteerInterrupt(steerId) }
    } else {
      dispatchSteerInterruptAction = nil
    }
    let resolvedSessionStatus: String? = sessionStatus
    let loadOlderTranscriptAction: (@MainActor () async -> WorkChatOlderHistoryLoadResult)?
    if isCrossProject && !syncService.supportsSubscribedChatHistory(sessionId: sessionId) {
      // Older hosts have no scoped transcript-page envelope. Do not fall back
      // to a foreign project command, which would activate its runtime just to
      // read history; the next host upgrade makes the same cached view pageable.
      loadOlderTranscriptAction = nil
    } else {
      loadOlderTranscriptAction = { await thread.loadOlder() }
    }
    let supportsRecovery = syncService.supportsChatRemoteAction(
      "chat.recoverTurn",
      sessionId: session.id
    ) || syncService.supportsChatRemoteAction(
      "chat.recoverCodexTurn",
      sessionId: session.id
    )
    let supportsUnprocessedResolution = syncService.supportsChatRemoteAction(
      "chat.resolveUnprocessedMessage",
      sessionId: session.id
    )
    let queueAwareStopAvailable = syncService.supportsChatRemoteAction(
      "chat.interruptWithQueueMode",
      sessionId: session.id
    )
    // Host-gated, not permission-gated: a brain that predates
    // `chat.resumeUsageLimitNow` cannot run it at all, so the sheet hides the
    // button rather than offering one that could only ever produce an error.
    // A viewer device or a dropped connection keeps the button — the tap
    // routes through `requireInvokableRemoteAction` and says which of the two
    // it was.
    let resumeUsageLimitNowAction: (@MainActor () async -> Void)?
    if syncService.supportsChatRemoteAction(
      "chat.resumeUsageLimitNow",
      sessionId: session.id
    ) {
      resumeUsageLimitNowAction = { await resumeUsageLimitNow() }
    } else {
      resumeUsageLimitNowAction = nil
    }
    let continueUsageLimitOnAlternateAction: (@MainActor () async -> Void)?
    if syncService.supportsChatRemoteAction(
      "chat.continueUsageLimitOnAlternate",
      sessionId: session.id
    ) {
      continueUsageLimitOnAlternateAction = { await continueUsageLimitOnAlternate() }
    } else {
      continueUsageLimitOnAlternateAction = nil
    }
    let canWriteSpawnKind = syncService.supportsSpawnKindUpdate
    let restoreCancelledQueueAction: (@MainActor (String) async -> Void)?
    if syncService.supportsChatRemoteAction(
      "chat.restoreCancelledQueue",
      sessionId: session.id
    ) {
      restoreCancelledQueueAction = { recoveryId in
        await restoreCancelledQueue(recoveryId: recoveryId)
      }
    } else {
      restoreCancelledQueueAction = nil
    }
    return WorkChatSessionView(
      session: WorkChatSessionRenderContext(session),
      chatSummaryContext: WorkChatSummaryRenderContext(
        composerChatSummary,
        parentTitle: composerChatSummary?.orchestrationParentSessionId.flatMap { parentId in
          syncService.chatSummaryCache[parentId]?.title
        }
      ),
      thread: thread,
      artifacts: artifactsForView,
      cardExpansionSnapshot: cardExpansion,
      cardExpansionRenderSignature: workCardExpansionRenderSignature(cardExpansion),
      artifactContentRenderSignature: artifactContentRenderSignature,
      artifactDrawerPresentedSnapshot: artifactDrawerPresented,
      sendingSnapshot: sending,
      errorMessageSnapshot: errorMessage ?? openingDeliveryWarning,
      cardExpansion: $cardExpansion,
      artifactContent: $artifactContent,
      fullscreenImage: $fullscreenImage,
      artifactDrawerPresented: $artifactDrawerPresented,
      artifactRefreshInFlight: artifactRefreshInFlight,
      artifactRefreshError: artifactRefreshError,
      sending: $sending,
      errorMessage: $errorMessage,
      isLive: isLiveAndReachable,
      hostUnreachable: syncService.connectionState.isHostUnreachable,
      suppressDomainHydrationNotices: syncService.shouldSuppressDomainHydrationNotices,
      canComposeMessages: canComposeChatMessages,
      canSendMessages: canSendChatMessages,
      sendWillQueue: sendWillQueueChatMessage || shouldSteer,
      sendWillQueueIsReconnect: sendWillQueueChatMessage,
      activeSendModesAvailable: activeSendModesAvailable,
      queueAwareStopAvailable: queueAwareStopAvailable,
      transportHealth: syncService.connectionHealth.transport,
      composerDraftRestore: composerDraftRestore,
      inputLockMessage: inputLockMessage,
      transitionNamespace: transitionNamespace,
      onOpenLane: openLaneAction,
      onSend: { text, attachments, mode in
        await sendMessage(text, attachments: attachments, deliveryMode: mode)
      },
      onInterrupt: interruptSession,
      onRestoreCancelledQueue: restoreCancelledQueueAction,
      onSetUsageLimitAutoContinue: setUsageLimitAutoContinue,
      onResumeUsageLimitNow: resumeUsageLimitNowAction,
      onContinueUsageLimitOnAlternate: continueUsageLimitOnAlternateAction,
      onStopSubagentTask: stopTaskAction,
      onApproveRequest: approveRequest,
      onRespondToQuestion: respondToQuestion,
      onSubmitQuestionAnswers: submitQuestionAnswers,
      onDeclineQuestion: declineQuestion,
      onDismissQuestion: dismissPendingQuestion,
      onRespondToPermission: respondToPermission,
      onRetryLoad: load,
      onOpenFile: openFileReference,
      onOpenPr: openPullRequestReference,
      onLoadArtifact: loadArtifactContent,
      onRefreshArtifacts: {
        await refreshArtifacts(force: true)
      },
      onCancelSteer: cancelSteer,
      onEditSteer: editSteer,
      onDispatchSteerInline: dispatchSteerInlineAction,
      onDispatchSteerInterrupt: dispatchSteerInterruptAction,
      onSelectModel: selectModel,
      onSelectRuntimeMode: selectRuntimeMode,
      onSelectEffort: selectReasoningEffort,
      onSelectCodexFastMode: selectCodexFastMode,
      // Memberwise-init argument order follows property declaration order in
      // WorkChatSessionView, where onOpenParentSession sits after the model
      // controls.
      onOpenParentSession: { openParentSession() },
      resolvedSessionStatus: resolvedSessionStatus,
      lanes: lanes,
      lanesRenderSignature: lanesRenderSignature,
      onLoadOlderTranscript: loadOlderTranscriptAction,
      subagentSnapshots: subagentSnapshots,
      subagentSnapshotsRenderSignature: subagentSnapshotsRenderSignature,
      scheduledWorkSnapshots: scheduledWorkSnapshots,
      scheduledWorkSnapshotsRenderSignature: scheduledWorkSnapshotsRenderSignature,
      // One chip, one destination: subagents, background work and schedules
      // all live in the Chat Info sheet. Timeline-row selection stays scoped
      // to the parent chat, so nested transcript state cannot accidentally
      // fetch from itself.
      onOpenChatInfo: { Task { await prepareChatInfoPresentation() } },
      onForkChatInLane: {
        let modelId = (composerChatSummary?.modelId ?? composerChatSummary?.model ?? "")
          .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !modelId.isEmpty else {
          errorMessage = "Choose a model before forking this chat."
          return
        }
        do {
          try await syncService.handoffChatSession(
            sourceSessionId: session.id,
            targetModelId: modelId,
            mode: "fork",
            handoffNote: "Continuing after Claude session limit"
          )
        } catch {
          errorMessage = error.localizedDescription
        }
      },
      prBadge: chatPrBadge,
      onOpenPrDetails: openPrDetails,
      compactComposer: compactComposer,
      liveRedirectOnlySends: liveRedirectOnlySends,
      isPersonalChat: personalChat,
      attachmentsAvailable: personalChat
        ? syncService.supportsViewerRemoteAction("personalChats.saveTempAttachment")
        : syncService.supportsViewerRemoteAction("chat.saveTempAttachment"),
      personalModelCatalogAvailable: !personalChat
        || syncService.canInvokeRemoteAction("personalChats.modelCatalog"),
      personalSessionUpdatesAvailable: !personalChat
        || syncService.canInvokeRemoteAction("personalChats.updateSession"),
      onRecoverCodexTurn: workChatCodexRecoveryAvailable(hostSupportsRecovery: supportsRecovery)
        ? recoverCodexTurn
        : nil,
      onRunUnprocessedMessage: supportsUnprocessedResolution
        ? runUnprocessedMessage
        : nil,
      onEditUnprocessedMessage: editUnprocessedMessage,
      onDismissUnprocessedMessage: supportsUnprocessedResolution
        ? dismissUnprocessedMessage
        : nil,
      transcriptLoadState: transcriptLoadState,
      onRetryTranscript: {
        thread.retry()
      },
      onTakeOverSubagent: canWriteSpawnKind ? takeOverSubagent : nil,
      onKeepReportingSubagent: canWriteSpawnKind ? keepReportingSubagent : nil
    )
  }

  /// Extracted from the `.onChange` modifier: the destination's modifier chain
  /// is long enough that an inline closure body pushes the type checker past
  /// its budget for the whole expression.
  @MainActor
  private func handleChatInfoPresentationChange(_ presented: Bool) {
    guard presented else { return }
    Task { await refreshRemoteSubagentSnapshots() }
  }

  var pollingKey: String {
    let status = normalizedWorkChatSessionStatus(session: session, summary: chatSummary)
    // liveTurnActiveHint participates so a desktop-started turn (session row
    // still idle locally) restarts the poll task the moment the hint flips on.
    return "\(session?.id ?? sessionId)-\(status)-\(isLiveAndReachable)-\(liveTurnActiveHint.map(String.init) ?? "nil")"
  }

  /// What the empty timeline may claim. The engine says `.loading` only while
  /// it has neither disk rows nor a host snapshot; with the host unreachable
  /// that wait would never end, so it becomes the idle "reconnect" state.
  var transcriptLoadState: WorkChatTranscriptLoadState {
    workChatTranscriptLoadState(frame: threadModel?.frame, isLiveAndReachable: isLiveAndReachable)
  }

  var artifactObservationKey: String {
    "\(sessionId)-proof:\(syncService.proofArtifactsProjectionRevision)"
  }

  var sessionRowObservationKey: String {
    "\(sessionId)-work:\(syncService.workProjectionRevision)"
  }

  var trimmedInitialOpeningPrompt: String {
    initialOpeningPrompt?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  }

  @MainActor
  func syncLanePresence() async {
    // Lane presence is an active-project concern; a cross-project quick look
    // must not announce itself into a foreign project's lane presence.
    guard !isRemoteOnlyChat else { return }
    guard showsLaneActions else { return }
    guard let laneId = session?.laneId ?? initialSession?.laneId else { return }
    guard announcedLaneId != laneId else { return }
    if let announcedLaneId {
      syncService.releaseLaneOpen(laneId: announcedLaneId)
    }
    announcedLaneId = laneId
    syncService.announceLaneOpen(laneId: laneId)
  }

  /// Session row, chat summary and proof artifacts. None of it gates the
  /// transcript: rows come from the thread engine, which was attached and
  /// subscribed before this runs. The summary and artifact loads run side by
  /// side instead of in series.
  @MainActor
  func load() async {
    guard !openingLoadInFlight else { return }
    openingLoadInFlight = true
    defer { openingLoadInFlight = false }

    async let summaryLoad: Void = refreshChatSummaryFromHost()
    async let artifactLoad: Void = refreshOpeningArtifacts()
    do {
      // Deep links and programmatic navigation do not always carry the Work
      // list's ephemeral roster projection. Seed from the active-project
      // roster before hitting the slower project replica so the destination
      // can render and subscribe as soon as the machine roster announces it.
      if !isRemoteOnlyChat, session == nil {
        session = syncService.activeProjectRosterSession(sessionId: sessionId)
        openThreadSubscriptionIfNeeded()
      }
      if !isRemoteOnlyChat, let fetchedSession = try await syncService.fetchSession(id: sessionId) {
        session = fetchedSession
      } else if !isRemoteOnlyChat, session == nil, initialSession == nil, isLive, hostReachable {
        // A chat opened straight from the hub — e.g. just created into a
        // project activated in place — may not have its local session row yet
        // (created on the host, still in flight over the changeset stream).
        // Hydrate it from the host instead of flashing "Session unavailable".
        if let hydrated = await syncService.ensureSessionRowHydrated(sessionId: sessionId) {
          session = hydrated
        }
      }
      lastSessionRowRefreshAt = Date()
      openThreadSubscriptionIfNeeded()
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
    _ = await (summaryLoad, artifactLoad)
  }

  /// Proof artifacts are active-project-scoped; skip for a cross-project
  /// quick look (the drawer stays empty rather than querying the wrong project).
  @MainActor
  private func refreshOpeningArtifacts() async {
    guard !isRemoteOnlyChat, !syncService.prefersReducedSyncLoad else { return }
    await refreshArtifacts(force: true)
  }

  /// Fold a cache-side mode patch (applied by SyncService when a
  /// `session_meta_updated` event arrives from another client) into the live
  /// `chatSummary` so the composer's model/permission pill reflects the change
  /// without a refetch. Runs on the chat-event revision bump the meta event
  /// already triggers. `mergeModeFields` mirrors the cache's cursor fields
  /// wholesale (the cache is authoritative), so an explicit `cursorModeId` /
  /// `cursorConfigValues` clear folded into the cache reaches the live composer
  /// here; the assignment is gated on a real change to avoid needless
  /// re-renders. When `chatSummary` is nil the composer already reads the
  /// patched cache via `composerChatSummary`, so nothing to do here.
  @MainActor
  func reconcileChatSummaryModeFromCacheIfNeeded() {
    guard var current = chatSummary,
          let cached = syncService.chatSummaryCache[sessionId],
          cached.sessionId == current.sessionId
    else { return }
    current.mergeModeFields(from: cached)
    // The host renames Claude chats shortly after the first turn; that title
    // rides a `session_meta_updated` event that SyncService folds into the
    // cached summary. Mirror it onto the live summary here so the nav title
    // updates without a refetch. Only overwrite from a non-empty cached title so
    // a partial refresh that dropped the title can't blank the live one.
    if let cachedTitle = cached.title?.trimmingCharacters(in: .whitespacesAndNewlines),
       !cachedTitle.isEmpty,
       current.title != cached.title {
      current.title = cached.title
    }
    if current != chatSummary {
      chatSummary = current
    }
  }

  @MainActor
  func refreshChatSummaryFromHost() async {
    if chatSummary == nil, let cached = syncService.chatSummaryCache[sessionId] {
      chatSummary = cached
    }

    // Cross-project quick look reads come from the chat_subscribe snapshot +
    // live tail, which the brain serves WITHOUT booting the foreign project.
    // The scoped chat.getSummary command routes through the project scope
    // registry and would spin up that project's runtime just to look.
    guard !isCrossProject else { return }

    if syncService.supportsChatRemoteAction("chat.getSummary", sessionId: sessionId),
       let fetchedSummary = try? await syncService.fetchChatSummary(sessionId: sessionId) {
      if chatSummary != fetchedSummary {
        chatSummary = fetchedSummary
      }
      syncService.cacheChatSummary(fetchedSummary)
      return
    }

    guard !personalChat,
          let laneId = (session ?? initialSession)?.laneId,
          !laneId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
          syncService.supportsRemoteAction("chat.listSessions"),
          let summaries = try? await syncService.listChatSessions(laneId: laneId),
          let fallbackSummary = summaries.first(where: { $0.sessionId == sessionId })
    else { return }

    if chatSummary != fallbackSummary {
      chatSummary = fallbackSummary
    }
    syncService.cacheChatSummary(fallbackSummary)
  }

  /// Re-read this session's row from the phone's local replicated DB. Cheap
  /// (no network) — keeps the @State row current with changeset-synced status
  /// transitions (idle → running → exited) while the view is open.
  @MainActor
  func sessionRowRefreshMinimumInterval() -> TimeInterval {
    let status = normalizedWorkChatSessionStatus(session: session ?? initialSession, summary: chatSummary ?? initialChatSummary)
    if liveTurnActiveHint == true || status == "active" || status == "awaiting-input" {
      return 0.75
    }
    return syncService.prefersReducedSyncLoad ? 8.0 : 4.0
  }

  @MainActor
  func shouldRefreshSessionRowFromLocalStore(now: Date = Date()) -> Bool {
    now.timeIntervalSince(lastSessionRowRefreshAt) >= sessionRowRefreshMinimumInterval()
  }

  @MainActor
  func refreshSessionRowFromLocalStore() async {
    lastSessionRowRefreshAt = Date()
    guard let refreshed = try? await syncService.fetchSession(id: sessionId) else { return }
    if refreshed != session {
      session = refreshed
    }
  }

  /// After a chat action: summary, session row and proof artifacts. The
  /// transcript is not refetched — whatever the action changed arrives on the
  /// live stream into the thread engine.
  @MainActor
  func refreshChatStateAfterAction(forceRemote: Bool = true) async {
    if forceRemote, !syncService.prefersReducedSyncLoad {
      await refreshArtifacts(force: true)
    }
    await refreshChatSummaryFromHost()
    if !isRemoteOnlyChat, let refreshedSession = try? await syncService.fetchSession(id: sessionId) {
      session = refreshedSession
    }
  }

  @MainActor
  func cleanupLoadedArtifactContent() {
    artifactContent.values.forEach { workRemoveLoadedArtifactTempFile($0) }
    artifactContent.removeAll()
    refreshArtifactContentRenderSignature()
    artifactContentLoadsInFlight.removeAll()
  }

  @MainActor
  func refreshArtifacts(force: Bool) async {
    // Proof artifacts live in the active project's projection; a cross-project
    // quick look has no access to the foreign project's proof drawer.
    guard !isRemoteOnlyChat else { return }
    guard let currentSession = session ?? initialSession,
          isChatSession(currentSession)
    else { return }

    let now = Date()
    let minimumRefreshInterval = syncService.prefersReducedSyncLoad ? 15.0 : 0.8
    guard force || now.timeIntervalSince(lastArtifactRefreshAt) >= minimumRefreshInterval else { return }
    guard !artifactRefreshInFlight else { return }

    artifactRefreshInFlight = true
    lastArtifactRefreshAt = now
    defer { artifactRefreshInFlight = false }

    do {
      let previousURIs = Dictionary(uniqueKeysWithValues: artifacts.map { ($0.id, $0.uri) })
      let refreshed = try await syncService.fetchComputerUseArtifacts(ownerKind: "chat_session", ownerId: sessionId)
      let validArtifactIds = Set(refreshed.map(\.id))

      for (artifactId, content) in artifactContent where !validArtifactIds.contains(artifactId) {
        workRemoveLoadedArtifactTempFile(content)
      }
      artifactContent = artifactContent.filter { validArtifactIds.contains($0.key) }
      refreshArtifactContentRenderSignature()
      artifactContentLoadsInFlight = Set(artifactContentLoadsInFlight.filter { validArtifactIds.contains($0) })

      for artifact in refreshed where previousURIs[artifact.id] != nil && previousURIs[artifact.id] != artifact.uri {
        workRemoveLoadedArtifactTempFile(artifactContent[artifact.id])
        removeArtifactContent(for: artifact.id)
      }

      if artifacts != refreshed {
        setArtifacts(refreshed)
      }
      artifactRefreshError = nil
    } catch {
      artifactRefreshError = error.localizedDescription
    }
  }

  @MainActor
  func sendInitialOpeningPromptIfNeeded() async {
    let prompt = trimmedInitialOpeningPrompt
    guard !prompt.isEmpty else { return }
    guard !sending else { return }
    let promptKey = "\(sessionId)|\(prompt)"
    guard handledOpeningPromptKey != promptKey else { return }
    if initialOpeningPromptDispatchHandled {
      handledOpeningPromptKey = promptKey
      return
    }
    if transcript.contains(where: { envelope in
      if case .userMessage(let text, _, _, _, _, _) = envelope.event {
        return text.trimmingCharacters(in: .whitespacesAndNewlines) == prompt
      }
      return false
    }) {
      handledOpeningPromptKey = promptKey
      return
    }
    copySubmittedWorkPromptToPasteboard(prompt)
    handledOpeningPromptKey = promptKey

    let echo: WorkLocalEchoMessage
    if let existingEcho = localEchoMessages.first(where: {
      $0.text.trimmingCharacters(in: .whitespacesAndNewlines) == prompt
    }) {
      echo = existingEcho
    } else {
      let useSteer = shouldSteerActiveTurn
      let nextEcho = WorkLocalEchoMessage(
        text: prompt,
        timestamp: workDateFormatter.string(from: Date()),
        deliveryState: (sendWillQueueChatMessage || useSteer) ? "queued" : "sending"
      )
      localEchoMessages.append(nextEcho)
      syncThreadOverlays()
      echo = nextEcho
    }
    let useSteer = shouldSteerActiveTurn
    updateLocalEchoDeliveryState(echoId: echo.id, deliveryState: (sendWillQueueChatMessage || useSteer) ? "queued" : "sending")
    do {
      let delivery: SyncChatMessageDelivery
      // No `dispatchMode` on either steer: a launch prompt has no composer
      // behind it, so there is no chosen active-turn mode to carry. Landing on
      // an already-busy session stages it, which is the conservative reading of
      // "run this next" and matches what the desktop launcher does.
      if useSteer {
        delivery = try await syncService.steerChatSession(sessionId: sessionId, text: prompt)
      } else {
        do {
          delivery = try await syncService.sendChatMessage(sessionId: sessionId, text: prompt)
        } catch where workChatErrorIndicatesActiveTurn(error) {
          updateLocalEchoDeliveryState(echoId: echo.id, deliveryState: "queued")
          delivery = try await syncService.steerChatSession(sessionId: sessionId, text: prompt)
        }
      }
      switch delivery {
      case .queued(let steerId):
        updateLocalEchoDeliveryState(echoId: echo.id, deliveryState: "queued")
        if let steerId {
          upsertOptimisticPendingSteer(id: steerId, text: prompt, timestamp: echo.timestamp)
        }
      case .sent:
        updateLocalEchoDeliveryState(echoId: echo.id, deliveryState: nil)
        await refreshChatStateAfterAction(forceRemote: true)
        reconcileLocalEchoMessages()
      case .dropped:
        // Opening prompt steered into a full queue; the host dropped it. Remove
        // the optimistic echo and surface the queue-full notice instead of
        // leaving it as if delivered.
        ADEHaptics.error()
        localEchoMessages.removeAll { $0.id == echo.id }
        errorMessage = "Message not sent — the queue is full. Wait for the current turn to finish, then resend."
        return
      }
      errorMessage = nil
    } catch {
      ADEHaptics.error()
      localEchoMessages.removeAll { $0.id == echo.id }
      composerDraftRestore = WorkChatComposerDraftRestore(text: prompt)
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  func stageInitialOpeningPromptEchoIfNeeded() {
    let prompt = trimmedInitialOpeningPrompt
    guard !prompt.isEmpty else { return }
    let promptKey = "\(sessionId)|\(prompt)"
    guard stagedOpeningPromptKey != promptKey else { return }
    stagedOpeningPromptKey = promptKey
    let useSteer = shouldSteerActiveTurn
    let deliveryState = initialOpeningPromptDispatchHandled
      ? initialOpeningDeliveryState
      : ((sendWillQueueChatMessage || useSteer) ? "queued" : "sending")
    localEchoMessages.append(WorkLocalEchoMessage(
      text: prompt,
      timestamp: workDateFormatter.string(from: Date()),
      deliveryState: deliveryState,
      attachments: initialOpeningAttachments.isEmpty ? nil : initialOpeningAttachments
    ))
    syncThreadOverlays()
  }

  @MainActor
  func upsertOptimisticPendingSteer(
    id: String,
    text: String,
    timestamp: String,
    attachments: [AgentChatFileRef]? = nil
  ) {
    let turnId = latestActiveTurnId(from: transcript)
    let model = WorkPendingSteerModel(id: id, text: text, attachments: attachments, turnId: turnId, timestamp: timestamp)
    if let index = optimisticPendingSteers.firstIndex(where: { $0.id == id }) {
      optimisticPendingSteers[index] = model
    } else {
      optimisticPendingSteers.append(model)
    }
    syncThreadOverlays()
  }

  @MainActor
  func reconcileOptimisticPendingSteers(with transcript: [WorkChatEnvelope]) {
    guard !optimisticPendingSteers.isEmpty else { return }
    // The engine already folded the canonical pending queue for this frame.
    let pendingIds = Set(
      (threadModel?.frame?.snapshot.pendingSteers ?? derivePendingWorkSteers(from: transcript)).map(\.id)
    )
    optimisticPendingSteers.removeAll { steer in
      transcriptContainsResolvedSteer(transcript, steer: steer) || pendingIds.contains(steer.id)
    }
  }

  /// Belt for the case where the host flushed queued steers at turn end
  /// (`deliverNextQueuedSteer`) but the graduation events never reached the
  /// phone, leaving optimistic steers stuck as "Sends after turn" forever.
  /// After an authoritative refresh from a reachable host, any optimistic steer
  /// the host no longer lists as pending has been delivered (or cancelled) — the
  /// steer id is the host-assigned id, so absence is definitive. We never drop
  /// while the host is unreachable or the refresh came back empty.
  ///
  /// The authoritative refresh is a fresh host snapshot into the engine: once
  /// a host-origin frame newer than the request lands, any optimistic steer the
  /// host no longer lists as pending has been delivered or cancelled.
  @MainActor
  func reconcileOptimisticSteersAfterTurnEnd() async {
    guard !optimisticPendingSteers.isEmpty, isLiveAndReachable, let threadModel else { return }
    let requestedAfterRevision = threadModel.frame?.revision ?? 0
    threadModel.retry()
    for _ in 0..<40 {
      try? await Task.sleep(nanoseconds: 200_000_000)
      guard !Task.isCancelled else { return }
      if let frame = threadModel.frame,
         frame.revision > requestedAfterRevision,
         frame.cacheOrigin == .host || frame.cacheOrigin == .mixed {
        break
      }
    }
    guard isLiveAndReachable, !transcript.isEmpty else { return }
    let canonicalPendingIds = Set(derivePendingWorkSteers(from: transcript).map(\.id))
    optimisticPendingSteers.removeAll { !canonicalPendingIds.contains($0.id) }
  }

  @MainActor
  func reconcileLocalEchoMessages() {
    let next = workLocalEchoesRetiredByTranscript(localEchoMessages, transcript: transcript)
    guard next.count != localEchoMessages.count else { return }
    localEchoMessages = next
  }

  @MainActor
  func refreshChatInfoSnapshots() {
    chatInfoTranscriptShape = workChatInfoTranscriptShape(transcript)
    refreshSubagentSnapshots()
    refreshScheduledWorkSnapshots()
  }

  @MainActor
  func refreshSubagentSnapshots() {
    let local = buildWorkSubagentSnapshots(from: transcript)
    let next = mergeWorkSubagentSnapshots(local: local, remote: remoteSubagentSnapshots)
    if next != subagentSnapshots {
      subagentSnapshots = next
      subagentSnapshotsRenderSignature = workSubagentSnapshotsRenderSignature(next)
    }
  }

  @MainActor
  func refreshScheduledWorkSnapshots() {
    let managedWork = chatSummary?.scheduledWork
      ?? lastKnownChatSummary?.scheduledWork
      ?? initialChatSummary?.scheduledWork
    let next = mergeManagedWorkScheduledWorkSnapshots(
      local: buildWorkScheduledWorkSnapshots(from: transcript),
      managedWork: managedWork
    )
    if next != scheduledWorkSnapshots {
      scheduledWorkSnapshots = next
      scheduledWorkSnapshotsRenderSignature = workScheduledWorkSnapshotsRenderSignature(next)
    }
  }

  @MainActor
  func applyScheduledWorkCancellationResult(_ result: AgentChatCancelScheduledWorkResult) {
    guard var summary = chatSummary ?? lastKnownChatSummary ?? initialChatSummary else { return }
    var managedWork = summary.scheduledWork ?? []
    if let index = managedWork.firstIndex(where: { $0.id == result.schedule.id }) {
      managedWork[index] = result.schedule
    } else {
      managedWork.append(result.schedule)
    }
    summary.scheduledWork = managedWork
    chatSummary = summary
    lastKnownChatSummary = summary
    refreshScheduledWorkSnapshots()
  }

  @MainActor
  func refreshRemoteSubagentSnapshots() async {
    guard subagentCapability.canList,
          !remoteSubagentRefreshInFlight
    else { return }
    remoteSubagentRefreshInFlight = true
    defer { remoteSubagentRefreshInFlight = false }
    do {
      let remote = try await syncService.fetchSubagents(sessionId: sessionId)
      let snapshots = remote.map(workSubagentSnapshot(from:))
      if snapshots != remoteSubagentSnapshots {
        remoteSubagentSnapshots = snapshots
        refreshSubagentSnapshots()
      }
    } catch {
      // Drawer hydration is opportunistic; the local transcript-derived roster
      // stays usable when an older desktop build lacks chat.listSubagents.
    }
  }

  /// Present the unified Chat Info sheet (subagents, background, schedule),
  /// derived from the engine's current transcript plus the host's roster.
  @MainActor
  func prepareChatInfoPresentation() async {
    refreshChatInfoSnapshots()
    chatInfoPresented = true
    await refreshRemoteSubagentSnapshots()
  }



  /// Tapping an in-thread subagent expands its card, and nothing more.
  ///
  /// A subagent that runs INSIDE a main thread (a Claude/Codex native Task) is
  /// not a chat: it has no composer, no lane and no life of its own, and its
  /// transcript is the parent's work seen from one level down. Opening it on a
  /// phone replaced the thread the user was reading with a read-only copy they
  /// had to back out of, while the card beside it already carried the label,
  /// model, status, latest summary and final result — everything a phone can
  /// act on. So the card is all there is now, and the drill-in and its
  /// per-second transcript polling are gone.
  ///
  /// This is only about in-thread subagents. A `--type subagent` chat and a
  /// child lane are full chats with their own rows, and open exactly as they
  /// always have.
  @MainActor
  func handleSubagentSelection(_ snapshot: WorkSubagentSnapshot) async {
    toggleExpandedSubagentDetail(snapshot.taskId)
  }

  @MainActor
  func toggleExpandedSubagentDetail(_ taskId: String) {
    if expandedSubagentDetailIds.contains(taskId) {
      expandedSubagentDetailIds.remove(taskId)
    } else {
      expandedSubagentDetailIds.insert(taskId)
    }
  }

  @MainActor
  func updateLocalEchoDeliveryState(echoId: String, deliveryState: String?) {
    guard let index = localEchoMessages.firstIndex(where: { $0.id == echoId }) else { return }
    localEchoMessages[index].deliveryState = deliveryState
  }

  @MainActor
  func updateLocalEchoAttachments(echoId: String, attachments: [AgentChatFileRef]?) {
    guard let index = localEchoMessages.firstIndex(where: { $0.id == echoId }) else { return }
    guard localEchoMessages[index].attachments != attachments else { return }
    localEchoMessages[index].attachments = attachments
  }

  @MainActor
  func pollIfNeeded() async {
    guard isLiveAndReachable,
          let session,
          isChatSession(session)
    else { return }
    // liveTurnActiveHint keeps the loop eligible when a desktop-started turn
    // is streaming but the synced session row hasn't flipped to running yet —
    // the row catches up via refreshSessionRowFromLocalStore / the loop's own
    // summary refresh below.
    let initialStatus = normalizedWorkChatSessionStatus(session: session, summary: chatSummary)
    guard liveTurnActiveHint != false,
          initialStatus == "active" || initialStatus == "awaiting-input" || liveTurnActiveHint == true
    else { return }
    while !Task.isCancelled, isLiveAndReachable,
      {
        guard self.liveTurnActiveHint != false else { return false }
        let status = normalizedWorkChatSessionStatus(session: self.session, summary: self.chatSummary)
        return status == "active" || status == "awaiting-input" || self.liveTurnActiveHint == true
      }() {
      // Transcript updates stream into the thread engine on their own; this
      // loop only keeps the summary, the session row and proof current.
      let now = Date()
      let sessionRefreshInterval = syncService.prefersReducedSyncLoad ? 10.0 : 5.0
      if now.timeIntervalSince(lastSessionRowRefreshAt) >= sessionRefreshInterval {
        lastSessionRowRefreshAt = now
        await refreshChatSummaryFromHost()
        if let refreshedSession = try? await syncService.fetchSession(id: sessionId) {
          self.session = refreshedSession
        }
      }
      let artifactRefreshInterval = syncService.prefersReducedSyncLoad ? 30.0 : 12.0
      if now.timeIntervalSince(lastArtifactRefreshAt) >= artifactRefreshInterval {
        await refreshArtifacts(force: false)
      }
      try? await Task.sleep(nanoseconds: syncService.prefersReducedSyncLoad ? 3_000_000_000 : 1_700_000_000)
    }
  }
}

/// Register the chat-command routing a destination needs before anything
/// reads or sends for it. Idempotent; shared by `init` (so the engine key is
/// right for the first render) and `onAppear`.
@MainActor
func workRegisterChatCommandScope(
  _ syncService: SyncService,
  sessionId: String,
  personalChat: Bool,
  crossProjectContext: WorkChatCrossProjectContext?
) {
  if personalChat {
    syncService.setPersonalChatScope(sessionId: sessionId)
    return
  }
  guard let crossProjectContext,
        hubChatIsForeignProject(
          context: crossProjectContext,
          ownerIsActive: syncService.isActiveProject(
            id: crossProjectContext.projectId,
            rootPath: crossProjectContext.projectRootPath
          )
        )
  else { return }
  syncService.setCrossProjectChatScope(
    sessionId: sessionId,
    projectId: crossProjectContext.projectId,
    projectRootPath: crossProjectContext.projectRootPath
  )
}

/// What the empty timeline may claim for a thread frame (edge case 21). The
/// engine reports `.loading` only while it has neither disk rows nor a host
/// snapshot; offline, that wait cannot end, so it becomes the idle "reconnect"
/// state. A frame with cached rows is `.idle` and shows them, offline or not.
func workChatTranscriptLoadState(
  frame: ChatThreadFrame?,
  isLiveAndReachable: Bool
) -> WorkChatTranscriptLoadState {
  guard let frame else {
    return isLiveAndReachable ? .loading : .idle
  }
  if frame.sessionDeleted {
    return .failed("This chat was deleted on the machine.")
  }
  if case .loading = frame.loadState, !isLiveAndReachable {
    return .idle
  }
  return frame.loadState
}

/// Envelope count + newest id: changes when an envelope is added, not when a
/// streaming delta grows the last one. Gates the Chat Info roster scans.
func workChatInfoTranscriptShape(_ transcript: [WorkChatEnvelope]) -> String {
  "\(transcript.count)|\(transcript.last.map(workChatEnvelopeMergeKey) ?? "")"
}

/// Everything the destination feeds the thread engine as overlays. Equatable
/// so a single `onChange` pushes a new value only when one of them moved.
struct WorkChatThreadOverlayInputs: Equatable {
  var localEchoMessages: [WorkLocalEchoMessage]
  var optimisticPendingSteers: [WorkPendingSteerModel]
  var artifacts: [ComputerUseArtifactSummary]
  var cardExpansionSignature: Int
  var summary: ChatThreadSummaryContext
  var sessionStatus: String
}

extension WorkSessionDestinationView {
  var threadOverlayInputs: WorkChatThreadOverlayInputs {
    let summary = composerChatSummary
    let currentSession = session ?? initialSession
    let summaryPendingId = summary?.pendingInputItemId?
      .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let usageLimitResume = summary.flatMap { workUsageLimitResumeModel(for: $0) }
    return WorkChatThreadOverlayInputs(
      localEchoMessages: localEchoMessages,
      optimisticPendingSteers: optimisticPendingSteers,
      // Proof artifacts render in the thread; a quick look has none.
      artifacts: artifacts,
      cardExpansionSignature: workCardExpansionRenderSignature(cardExpansion),
      summary: ChatThreadSummaryContext(
        provider: summary?.provider ?? "",
        providerFallback: workChatProviderFamilyFromToolType(currentSession?.toolType),
        model: summary?.model ?? "",
        modelId: summary?.modelId,
        usageLimitTurnId: usageLimitResume?.turnId,
        hasUsageLimitResume: usageLimitResume != nil,
        pendingInputItemId: summaryPendingId.isEmpty ? currentSession?.pendingInputItemId : summaryPendingId,
        claudeGoal: summary?.claudeGoal,
        orchestrationParentSessionId: summary?.orchestrationParentSessionId,
        rowEndedAtCandidates: [
          summary?.idleSinceAt,
          summary?.endedAt,
          currentSession?.chatIdleSinceAt,
          currentSession?.endedAt,
        ].compactMap { $0 },
        isLive: isLiveAndReachable
      ),
      sessionStatus: normalizedWorkChatSessionStatus(session: currentSession, summary: chatSummary)
    )
  }

  /// Push the destination-owned overlays into the engine. Synchronous up to
  /// the engine hop: a send handler calls it right after appending its echo,
  /// before any `await`, so the bubble is in the next frame.
  @MainActor
  func syncThreadOverlays() {
    guard let threadModel else { return }
    let inputs = threadOverlayInputs
    threadModel.updateOverlays { overlays in
      overlays.localEchoMessages = inputs.localEchoMessages
      overlays.optimisticPendingSteers = inputs.optimisticPendingSteers
      overlays.artifacts = inputs.artifacts
      overlays.cardExpansionSignature = inputs.cardExpansionSignature
      overlays.summary = inputs.summary
      overlays.sessionStatus = inputs.sessionStatus
    }
  }

  /// Hold this chat's engine while the view is on screen.
  @MainActor
  func attachThreadModel() {
    guard !threadAttached, let key = syncService.chatThreadKey(for: sessionId) else { return }
    let model = syncService.chatThreadRegistry.attach(key)
    threadAttached = true
    if threadKey != key || threadModel !== model {
      threadKey = key
      threadModel = model
    }
  }

  @MainActor
  func detachThreadModel() {
    guard threadAttached, let threadKey else { return }
    threadAttached = false
    syncService.chatThreadRegistry.detach(threadKey)
  }

  /// The chat's routing scope changed (Hub activation or its rollback): move
  /// the attach to the engine SyncService now routes this chat's frames to.
  @MainActor
  func rebindThreadModelIfNeeded() {
    guard let key = syncService.chatThreadKey(for: sessionId), key != threadKey else { return }
    detachThreadModel()
    threadKey = key
    threadModel = syncService.chatThreadRegistry.model(for: key)
    attachThreadModel()
    syncThreadOverlays()
  }

  /// Open the chat's live stream once per appearance, in the same run-loop
  /// turn as the engine attach.
  ///
  /// - Warm engine on a `chatLogV2` host: resume from the engine's durable
  ///   sequence (the subscribe payload carries it); nothing is re-sent when the
  ///   stream never closed.
  /// - Anything else: a full snapshot. Cached rows are already on screen from
  ///   disk; the snapshot is authoritative for its range and extends them.
  @MainActor
  func openThreadSubscriptionIfNeeded() {
    guard !threadSubscriptionOpened,
          let currentSession = session ?? initialSession,
          isChatSession(currentSession)
    else { return }
    threadSubscriptionOpened = true
    let engineWarm = threadKey.flatMap { syncService.chatThreadRegistry.resumePoint(for: $0) } != nil
    let streamLive = syncService.chatSubscriptionIsLive(sessionId: sessionId)
    let requestSnapshot = !engineWarm || (!syncService.supportsChatLogV2 && !streamLive)
    syncService.subscribeToChatEventsNow(sessionId: sessionId, requestSnapshot: requestSnapshot)
  }

  /// Per-frame bookkeeping that needs the transcript: echo and steer
  /// reconciliation (cheap, and guarded on having any), the summary-mode
  /// patch from `session_meta_updated`, and the Chat Info roster (only when an
  /// envelope was added).
  @MainActor
  func handleThreadFrameApplied() {
    reconcileChatSummaryModeFromCacheIfNeeded()
    let transcript = self.transcript
    if !optimisticPendingSteers.isEmpty {
      reconcileOptimisticPendingSteers(with: transcript)
    }
    if !localEchoMessages.isEmpty {
      reconcileLocalEchoMessages()
    }
    if workChatInfoTranscriptShape(transcript) != chatInfoTranscriptShape {
      refreshChatInfoSnapshots()
    }
  }
}

extension WorkSessionDestinationView: Equatable {
  static func == (lhs: WorkSessionDestinationView, rhs: WorkSessionDestinationView) -> Bool {
    lhs.sessionId == rhs.sessionId
      && lhs.initialOpeningPrompt == rhs.initialOpeningPrompt
      && lhs.initialOpeningPromptDispatchHandled == rhs.initialOpeningPromptDispatchHandled
      && lhs.initialOpeningDeliveryState == rhs.initialOpeningDeliveryState
      && lhs.initialOpeningAttachments == rhs.initialOpeningAttachments
      && lhs.initialSession == rhs.initialSession
      && lhs.initialChatSummary == rhs.initialChatSummary
      && (lhs.transitionNamespace == nil) == (rhs.transitionNamespace == nil)
      && lhs.isLive == rhs.isLive
      && lhs.navigationChrome == rhs.navigationChrome
      && lhs.showsLaneActions == rhs.showsLaneActions
      // `compactComposer` is passed down to the composer like the other two
      // surface flags, so leaving it out let the render gate swallow a change
      // to it.
      && lhs.compactComposer == rhs.compactComposer
      && lhs.navigationTitleOverride == rhs.navigationTitleOverride
      && lhs.lanesRenderSignature == rhs.lanesRenderSignature
      && lhs.crossProjectContext == rhs.crossProjectContext
      && lhs.personalChat == rhs.personalChat
      && lhs.liveRedirectOnlySends == rhs.liveRedirectOnlySends
  }
}

private struct WorkSessionNavigationChromeModifier<TrailingControls: View>: ViewModifier {
  @Environment(\.dismiss) private var dismiss
  @Environment(\.layoutDirection) private var layoutDirection
  @State private var contentWidth: CGFloat = 0

  let mode: WorkSessionNavigationChrome
  let title: String
  let subtitle: String?
  let trailingControls: () -> TrailingControls

  @ViewBuilder
  func body(content: Content) -> some View {
    switch mode {
    case .pushedDetail:
      content
        .background {
          GeometryReader { geometry in
            Color.clear
              .preference(key: WorkSessionNavigationChromeWidthPreferenceKey.self, value: geometry.size.width)
          }
        }
        .onPreferenceChange(WorkSessionNavigationChromeWidthPreferenceKey.self) { width in
          contentWidth = width
        }
        // Keep the edge gesture pass-through: vertical scrolls and row gestures
        // still reach the chat, while the helper only dismisses true edge swipes.
        .simultaneousGesture(edgeSwipeDismissGesture(containerWidth: contentWidth))
        // Floats over the thread rather than sitting on an opaque bar: the
        // transcript extends under this inset (it ignores the top safe area and
        // reads the inset back as its own content inset), so the prose scrolls
        // behind the glass controls.
        .safeAreaInset(edge: .top, spacing: 0) {
          WorkChatGlassHeader(
            title: title,
            subtitle: subtitle,
            onBack: { dismiss() },
            trailingControls: trailingControls
          )
        }
        .navigationTitle("")
        .toolbar(.hidden, for: .tabBar)
        .toolbar(.hidden, for: .navigationBar)
        .adeRootTabBarHidden()
    case .embedded:
      content
    }
  }

  private func edgeSwipeDismissGesture(containerWidth: CGFloat) -> some Gesture {
    DragGesture(minimumDistance: 16, coordinateSpace: .local)
      .onEnded { value in
        guard containerWidth > 0 else { return }
        guard workSessionShouldDismissForEdgeSwipe(
          startX: value.startLocation.x,
          containerWidth: containerWidth,
          layoutDirection: layoutDirection,
          translation: value.translation,
          predictedEndTranslation: value.predictedEndTranslation
        ) else { return }
        dismiss()
      }
  }
}

private struct WorkSessionNavigationChromeWidthPreferenceKey: PreferenceKey {
  static var defaultValue: CGFloat = 0

  static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
    value = nextValue()
  }
}

extension View {
  func workSessionNavigationChrome<TrailingControls: View>(
    mode: WorkSessionNavigationChrome,
    title: String,
    subtitle: String? = nil,
    @ViewBuilder trailingControls: @escaping () -> TrailingControls
  ) -> some View {
    modifier(
      WorkSessionNavigationChromeModifier(
        mode: mode,
        title: title,
        subtitle: subtitle,
        trailingControls: trailingControls
      )
    )
  }
}

/// The header's secondary line: the machine name, or nothing when unknown.
func workChatHeaderSubtitle(machineName: String?) -> String? {
  guard let machine = machineName?.trimmingCharacters(in: .whitespacesAndNewlines),
        !machine.isEmpty else { return nil }
  return machine
}

/// The chat thread's header: an independent round glass back button, the
/// title (one line) over the machine name in a glass capsule that takes the
/// width between the back button and the trailing actions. No bar and no
/// scrim behind it — the thread runs edge to edge, up under the status bar,
/// and only the controls themselves are glass.
struct WorkChatGlassHeader<TrailingControls: View>: View {
  let title: String
  let subtitle: String?
  let onBack: () -> Void
  let trailingControls: () -> TrailingControls

  var body: some View {
    HStack(alignment: .center, spacing: 8) {
      Button(action: onBack) {
        WorkChatGlassCircleLabel(systemName: "chevron.left", glyphSize: 18)
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Back")
      .accessibilityIdentifier("Work.Chat.Header.Back")

      titleCapsule
        .layoutPriority(1)

      trailingControls()
    }
    .padding(.horizontal, 12)
    .padding(.top, 2)
    .padding(.bottom, 6)
  }

  private var trimmedSubtitle: String? {
    guard let subtitle = subtitle?.trimmingCharacters(in: .whitespacesAndNewlines),
          !subtitle.isEmpty else { return nil }
    return subtitle
  }

  private var titleCapsule: some View {
    VStack(alignment: .leading, spacing: 0) {
      Text(title)
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(1)
        .truncationMode(.tail)
      if let trimmedSubtitle {
        Text(trimmedSubtitle)
          .font(.caption2.weight(.medium))
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(1)
          .truncationMode(.middle)
      }
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 4)
    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
    .workChatGlass(in: Capsule(style: .continuous))
    .accessibilityElement(children: .combine)
    .accessibilityAddTraits(.isHeader)
  }
}
