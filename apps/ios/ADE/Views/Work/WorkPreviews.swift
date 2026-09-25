#if DEBUG
import SwiftUI

@MainActor
private enum WorkPreviewData {
  // The lane mirrors the local .ade database in this worktree. This checkout
  // does not currently have saved chat sessions, so the chat transcript below
  // is representative data attached to that real lane.
  static let timestamp = iso(minutesAgo: 13)
  static let threeHoursAgo = iso(minutesAgo: 180)
  static let twoDaysAgo = iso(minutesAgo: 60 * 48)
  static let syncService = SyncService()
  static let dictationController = DictationController()

  static let lane = LaneSummary(
    id: "558f15ec-b705-4f7c-9db5-c8a930343f4f",
    name: "Primary",
    description: "Main repository workspace",
    laneType: "primary",
    baseRef: "main",
    branchRef: "ade/mobile-droid-attempt-bbdcd095",
    worktreePath: "/Users/admin/Projects/ADE/.ade/worktrees/mobile-droid-attempt-bbdcd095",
    attachedRootPath: nil,
    parentLaneId: nil,
    childCount: 0,
    stackDepth: 0,
    parentStatus: nil,
    isEditProtected: false,
    status: LaneStatus(dirty: true, ahead: 1, behind: 0, remoteBehind: 0, rebaseInProgress: false),
    color: "blue",
    icon: .bolt,
    tags: ["mobile", "work"],
    folder: nil,
    createdAt: timestamp,
    archivedAt: nil,
    devicesOpen: [
      DeviceMarker(deviceId: "desktop", displayName: "Mac", platform: "desktop"),
      DeviceMarker(deviceId: "ios", displayName: "iPhone", platform: "ios"),
    ]
  )

  static let chatSummary = AgentChatSessionSummary(
    sessionId: "preview-chat-session",
    laneId: lane.id,
    provider: "claude",
    model: "claude-sonnet-5",
    modelId: "anthropic/claude-sonnet-5",
    sessionProfile: nil,
    title: "Fix iOS Work tab lag",
    goal: "Make the Work tab responsive on iPhone",
    reasoningEffort: nil,
    codexFastMode: nil,
    fastMode: nil,
    executionMode: nil,
    permissionMode: "edit",
    interactionMode: "default",
    claudePermissionMode: "default",
    codexApprovalPolicy: nil,
    codexSandbox: nil,
    codexConfigSource: nil,
    opencodePermissionMode: nil,
    droidPermissionMode: nil,
    cursorModeSnapshot: nil,
    cursorModeId: nil,
    cursorConfigValues: nil,
    identityKey: nil,
    surface: "mobile",
    automationId: nil,
    automationRunId: nil,
    capabilityMode: nil,
    computerUse: nil,
    completion: nil,
    status: "active",
    idleSinceAt: nil,
    startedAt: timestamp,
    endedAt: nil,
    lastActivityAt: timestamp,
    lastOutputPreview: "Tracing TabView eager work, chat transcript churn, and keyboard focus latency.",
    summary: "Investigating mobile Work tab performance.",
    awaitingInput: false,
    threadId: nil,
    requestedCwd: lane.worktreePath
  )

  static let terminalSession = TerminalSessionSummary(
    id: chatSummary.sessionId,
    laneId: lane.id,
    laneName: lane.name,
    ptyId: nil,
    tracked: true,
    pinned: true,
    manuallyNamed: true,
    goal: chatSummary.goal,
    toolType: "claude-chat",
    title: chatSummary.title ?? "Work chat",
    status: "running",
    startedAt: timestamp,
    endedAt: nil,
    exitCode: nil,
    transcriptPath: ".ade/transcripts/chat/preview-chat-session.jsonl",
    headShaStart: "abc1234",
    headShaEnd: nil,
    lastOutputPreview: chatSummary.lastOutputPreview,
    summary: chatSummary.summary,
    runtimeState: "active",
    resumeCommand: nil,
    resumeMetadata: nil,
    chatIdleSinceAt: nil
  )

  static let iosSimLane = LaneSummary(
    id: "lane-ios-sim-editor",
    name: "ios sim editor",
    description: "Simulator and preview workflow lane",
    laneType: "worktree",
    baseRef: "main",
    branchRef: "ios-sim-editor-b0e2801b",
    worktreePath: "/Users/admin/Projects/ADE/.ade/worktrees/ios-sim-editor-b0e2801b",
    attachedRootPath: nil,
    parentLaneId: lane.id,
    childCount: 0,
    stackDepth: 1,
    parentStatus: lane.status,
    isEditProtected: false,
    status: LaneStatus(dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false),
    color: "purple",
    icon: .bolt,
    tags: ["ios", "preview"],
    folder: nil,
    createdAt: twoDaysAgo,
    archivedAt: nil,
    devicesOpen: [
      DeviceMarker(deviceId: "ios", displayName: "iPhone", platform: "ios")
    ]
  )

  static let rootLanes = [lane, iosSimLane]

  static let bumpBuildSummary = chatSummaryFixture(
    sessionId: "preview-bump-build",
    lane: lane,
    title: "Bump mobile build and publish iOS TestFlight",
    goal: "Create a fresh mobile build, upload it, and distribute it to beta testers.",
    status: "active",
    startedAt: timestamp,
    lastActivityAt: timestamp,
    preview: "Archiving ADE and waiting for App Store Connect processing."
  )

  static let automationSummary = chatSummaryFixture(
    sessionId: "preview-automation-github",
    lane: lane,
    title: "Automations GitHub Issue Workflow",
    goal: "Repair the GitHub issue automation flow.",
    status: "ended",
    startedAt: twoDaysAgo,
    endedAt: twoDaysAgo,
    lastActivityAt: twoDaysAgo,
    preview: "Session closed: Failed to authenticate. API Error: 401 {...",
    summary: "Session closed: Failed to authenticate. API Error: 401 {..."
  )

  static let rootSessions: [TerminalSessionSummary] = [
    sessionFixture(
      id: bumpBuildSummary.sessionId,
      lane: lane,
      title: bumpBuildSummary.title ?? "Bump mobile build and publish iOS TestFlight",
      toolType: "claude-chat",
      status: "running",
      runtimeState: "active",
      startedAt: timestamp,
      preview: bumpBuildSummary.lastOutputPreview,
      summary: bumpBuildSummary.summary
    ),
    sessionFixture(
      id: "preview-shell-session",
      lane: lane,
      title: "ADE shell session",
      toolType: "shell",
      status: "ended",
      runtimeState: "exited",
      startedAt: threeHoursAgo,
      endedAt: threeHoursAgo,
      preview: "The user is asking me to rewrite a terminal session summary.",
      summary: "The user is asking me to rewrite a terminal session summary."
    ),
    sessionFixture(
      id: automationSummary.sessionId,
      lane: lane,
      title: automationSummary.title ?? "Automations GitHub Issue Workflow",
      toolType: "claude-chat",
      status: "ended",
      runtimeState: "exited",
      startedAt: twoDaysAgo,
      endedAt: twoDaysAgo,
      preview: automationSummary.lastOutputPreview,
      summary: automationSummary.summary
    ),
    sessionFixture(id: "preview-ios-sim-1", lane: iosSimLane, title: "iOS sim editor", startedAt: timestamp),
    sessionFixture(id: "preview-ios-sim-2", lane: iosSimLane, title: "Simulator inspector polish", startedAt: threeHoursAgo),
    sessionFixture(id: "preview-ios-sim-3", lane: iosSimLane, title: "Preview target wiring", startedAt: twoDaysAgo),
    sessionFixture(id: "preview-ios-sim-4", lane: iosSimLane, title: "Files tab navigation", startedAt: twoDaysAgo),
    sessionFixture(id: "preview-ios-sim-5", lane: iosSimLane, title: "GitHub logo asset", startedAt: twoDaysAgo),
    sessionFixture(id: "preview-ios-sim-6", lane: iosSimLane, title: "Socket controls", startedAt: twoDaysAgo),
    sessionFixture(
      id: "preview-snoozed-session",
      lane: lane,
      title: "Rename the lane picker",
      status: "running",
      runtimeState: "active",
      startedAt: threeHoursAgo,
      preview: "Deferred until tomorrow morning.",
      snoozedUntil: "2099-01-01T00:00:00.000Z"
    ),
  ]

  /// A live PR whose checks are still running, on `iosSimLane`'s branch: the
  /// second half of the Waiting chip, and the reason those rows read as blocked
  /// on CI rather than as working.
  static let rootPullRequests: [PullRequestListItem] = [
    PullRequestListItem(
      id: "preview-pr-1",
      laneId: iosSimLane.id,
      laneName: iosSimLane.name,
      projectId: "preview-project",
      repoOwner: "arul",
      repoName: "ade",
      githubPrNumber: 1240,
      githubUrl: "https://github.com/arul/ade/pull/1240",
      title: "iOS sim editor polish",
      state: "open",
      baseBranch: iosSimLane.baseRef,
      headBranch: iosSimLane.branchRef,
      checksStatus: "pending",
      reviewStatus: "none",
      additions: 128,
      deletions: 24,
      lastSyncedAt: nil,
      createdAt: twoDaysAgo,
      updatedAt: timestamp,
      adeKind: "single",
      linkedGroupId: nil,
      linkedGroupType: nil,
      linkedGroupName: nil,
      linkedGroupPosition: nil,
      linkedGroupCount: 0,
      workflowDisplayState: nil,
      cleanupState: nil
    )
  ]

  static let rootChatSummaries: [String: AgentChatSessionSummary] = [
    bumpBuildSummary.sessionId: bumpBuildSummary,
    automationSummary.sessionId: automationSummary,
  ]

  static let transcript: [WorkChatEnvelope] = [
    envelope(
      sequence: 1,
      event: .userMessage(
        text: "The iOS Work tab is lagging when I switch tabs and focus the chat input.",
        attachments: nil,
        turnId: "turn-1",
        steerId: nil,
        deliveryState: "delivered",
        processed: true
      )
    ),
    envelope(
      sequence: 2,
      event: .reasoning(
        text: "The root TabView is mounting every tab and several inactive tabs are doing reload work on local database revisions.",
        turnId: "turn-1",
        itemId: "reasoning-1",
        summaryIndex: nil
      )
    ),
    envelope(
      sequence: 3,
      event: .command(
        command: "rg -n \"TabView|localStateRevision\" apps/ios/ADE/Views",
        cwd: lane.worktreePath,
        output: "ContentView.swift:24: TabView(selection: $selectedTab)\nWorkRootScreen.swift:361: .task(id: localStateRevision)",
        status: .completed,
        itemId: "cmd-1",
        exitCode: 0,
        durationMs: 842,
        turnId: "turn-1"
      )
    ),
    envelope(
      sequence: 4,
      event: .fileChange(
        path: "apps/ios/ADE/App/ContentView.swift",
        diff: "+ WorkTabView(isActive: selectedTab == .work)",
        kind: "modified",
        status: .completed,
        itemId: "file-1",
        turnId: "turn-1"
      )
    ),
    envelope(
      sequence: 5,
      event: .assistantText(
        text: "I'm gating inactive tab reloads and removing input-path animation so the keyboard can appear without waiting on unrelated work.",
        turnId: "turn-1",
        itemId: "msg-1"
      )
    ),
    envelope(
      sequence: 6,
      event: .done(
        status: "completed",
        summary: "Performance pass applied.",
        usage: WorkUsageSummary(
          turnCount: 1,
          inputTokens: 18420,
          outputTokens: 3120,
          cacheReadTokens: 9200,
          cacheCreationTokens: 430,
          costUsd: 0.0842
        ),
        turnId: "turn-1",
        model: "claude-sonnet-5",
        modelId: "anthropic/claude-sonnet-5"
      )
    ),
  ]

  static let artifact = ComputerUseArtifactSummary(
    id: "artifact-preview",
    artifactKind: "screenshot",
    backendStyle: "local",
    backendName: "ios-preview",
    sourceToolName: "simulator",
    originalType: "image",
    title: "Work tab screenshot",
    description: "Preview artifact row using local ADE-like data.",
    uri: "ade://artifact/artifact-preview",
    storageKind: "inline",
    mimeType: "image/png",
    metadataJson: nil,
    createdAt: timestamp,
    ownerKind: "chat_session",
    ownerId: chatSummary.sessionId,
    relation: "evidence",
    reviewState: nil,
    workflowState: nil,
    reviewNote: nil
  )

  static func envelope(sequence: Int, event: WorkChatEvent) -> WorkChatEnvelope {
    WorkChatEnvelope(sessionId: chatSummary.sessionId, timestamp: timestamp, sequence: sequence, event: event)
  }

  static func iso(minutesAgo: Int) -> String {
    let date = Date().addingTimeInterval(TimeInterval(-minutesAgo * 60))
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: date)
  }

  static func chatSummaryFixture(
    sessionId: String,
    lane: LaneSummary,
    title: String,
    goal: String,
    status: String,
    startedAt: String,
    endedAt: String? = nil,
    lastActivityAt: String,
    preview: String,
    summary: String? = nil
  ) -> AgentChatSessionSummary {
    AgentChatSessionSummary(
      sessionId: sessionId,
      laneId: lane.id,
      provider: "claude",
      model: "claude-sonnet-5",
      modelId: "anthropic/claude-sonnet-5",
      sessionProfile: nil,
      title: title,
      goal: goal,
      reasoningEffort: nil,
      codexFastMode: nil,
      fastMode: nil,
      executionMode: nil,
      permissionMode: "edit",
      interactionMode: "default",
      claudePermissionMode: "default",
      codexApprovalPolicy: nil,
      codexSandbox: nil,
      codexConfigSource: nil,
      opencodePermissionMode: nil,
      droidPermissionMode: nil,
      cursorModeSnapshot: nil,
      cursorModeId: nil,
      cursorConfigValues: nil,
      identityKey: nil,
      surface: "mobile",
      automationId: nil,
      automationRunId: nil,
      capabilityMode: nil,
      computerUse: nil,
      completion: nil,
      status: status,
      idleSinceAt: nil,
      startedAt: startedAt,
      endedAt: endedAt,
      lastActivityAt: lastActivityAt,
      lastOutputPreview: preview,
      summary: summary ?? preview,
      awaitingInput: false,
      threadId: nil,
      requestedCwd: lane.worktreePath
    )
  }

  static func sessionFixture(
    id: String,
    lane: LaneSummary,
    title: String,
    toolType: String = "claude-chat",
    status: String = "ended",
    runtimeState: String = "exited",
    startedAt: String,
    endedAt: String? = nil,
    preview: String? = nil,
    summary: String? = nil,
    /// Set to park the row in the Waiting chip / Snoozed shelf. Applied after
    /// construction because the snooze columns are a later overlay on the model
    /// and the memberwise init would have to be spelled out in full to reach
    /// them from here.
    snoozedUntil: String? = nil
  ) -> TerminalSessionSummary {
    var session = TerminalSessionSummary(
      id: id,
      laneId: lane.id,
      laneName: lane.name,
      ptyId: nil,
      tracked: true,
      pinned: false,
      manuallyNamed: true,
      goal: summary,
      toolType: toolType,
      title: title,
      status: status,
      startedAt: startedAt,
      endedAt: endedAt,
      exitCode: status == "ended" ? 0 : nil,
      transcriptPath: ".ade/transcripts/chat/\(id).jsonl",
      headShaStart: "abc1234",
      headShaEnd: nil,
      lastOutputPreview: preview,
      summary: summary,
      runtimeState: runtimeState,
      resumeCommand: nil,
      resumeMetadata: nil,
      chatIdleSinceAt: status == "ended" ? endedAt : nil
    )
    session.snoozedUntil = snoozedUntil
    session.snoozedAt = snoozedUntil == nil ? nil : startedAt
    return session
  }
}

#Preview("Work tab root") {
  WorkRootPreviewHarness()
    .preferredColorScheme(.dark)
}

#Preview("Work tab root - light") {
  WorkRootPreviewHarness()
    .preferredColorScheme(.light)
}

#Preview("Work session list") {
  WorkPreviewSessionListScreen()
}

/// The fixture chat every chat preview renders. `laneTools`, when given, fills
/// the badge row's lane tool chips instead of polling a brain.
@MainActor
func workPreviewChatSessionView(laneTools: WorkLaneToolsPreview? = nil) -> WorkChatSessionView {
  WorkChatSessionView(
    session: WorkChatSessionRenderContext(WorkPreviewData.terminalSession),
    chatSummaryContext: WorkChatSummaryRenderContext(WorkPreviewData.chatSummary),
    thread: workPreviewThreadModel(
      sessionId: WorkPreviewData.terminalSession.id,
      transcript: WorkPreviewData.transcript,
      artifacts: [WorkPreviewData.artifact],
      provider: WorkPreviewData.chatSummary.provider
    ),
    artifacts: [WorkPreviewData.artifact],
    cardExpansionSnapshot: WorkCardExpansionState(expandedIds: ["cmd-1"]),
    cardExpansionRenderSignature: workCardExpansionRenderSignature(
      WorkCardExpansionState(expandedIds: ["cmd-1"])
    ),
    artifactContentRenderSignature: workLoadedArtifactContentRenderSignature([:]),
    artifactDrawerPresentedSnapshot: false,
    sendingSnapshot: false,
    errorMessageSnapshot: nil,
    cardExpansion: .constant(WorkCardExpansionState(expandedIds: ["cmd-1"])),
    artifactContent: .constant([:]),
    fullscreenImage: Binding<WorkFullscreenImage?>.constant(nil),
    artifactDrawerPresented: .constant(false),
    artifactRefreshInFlight: false,
    artifactRefreshError: nil,
    sending: .constant(false),
    errorMessage: .constant(nil),
    isLive: true,
    hostUnreachable: false,
    canComposeMessages: true,
    canSendMessages: true,
    sendWillQueue: false,
    sendWillQueueIsReconnect: false,
    activeSendModesAvailable: true,
    queueAwareStopAvailable: true,
    transportHealth: .connected,
    composerDraftRestore: nil,
    transitionNamespace: nil,
    onOpenLane: {},
    onSend: { _, _, _ in true },
    onInterrupt: { _ in },
    onRestoreCancelledQueue: nil,
    onApproveRequest: { _, _, _ in },
    onRespondToQuestion: { _, _, _, _ in },
    onSubmitQuestionAnswers: { _, _, _ in },
    onDeclineQuestion: { _ in },
    onRespondToPermission: { _, _ in },
    onRetryLoad: {},
    onOpenFile: { _ in },
    onOpenPr: { _ in },
    onLoadArtifact: { _, _ in },
    onRefreshArtifacts: {},
    onCancelSteer: { _ in },
    onEditSteer: { _, _ in },
    onDispatchSteerInline: nil,
    onDispatchSteerInterrupt: nil,
    onSelectModel: { _ in },
    onSelectRuntimeMode: { _ in true },
    onSelectEffort: { _ in },
    onSelectCodexFastMode: { _ in true },
    resolvedSessionStatus: normalizedWorkChatSessionStatus(
      session: WorkPreviewData.terminalSession,
      summary: WorkPreviewData.chatSummary
    ),
    lanesRenderSignature: workLaneListRenderSignature([]),
    subagentSnapshotsRenderSignature: workSubagentSnapshotsRenderSignature([]),
    scheduledWorkSnapshotsRenderSignature: workScheduledWorkSnapshotsRenderSignature([]),
    previewLaneTools: laneTools
  )
}

#Preview("Work chat") {
  NavigationStack {
    workPreviewChatSessionView()
  }
  .environmentObject(WorkPreviewData.syncService)
  .environmentObject(WorkPreviewData.dictationController)
}

/// A thread model holding one frame folded from a fixed transcript, for
/// previews that have no host to stream from.
@MainActor
func workPreviewThreadModel(
  sessionId: String,
  transcript: [WorkChatEnvelope],
  artifacts: [ComputerUseArtifactSummary],
  provider: String
) -> ChatThreadModel {
  let key = ChatThreadKey(machineKey: "preview", sessionId: sessionId, scope: .project("preview"))
  let model = ChatThreadModel(key: key, engine: ChatThreadEngine(key: key, store: nil), registry: nil)
  let snapshot = buildWorkChatTimelineSnapshot(
    transcript: transcript,
    fallbackEntries: [],
    artifacts: artifacts,
    localEchoMessages: [],
    usageLimitTurnId: nil
  )
  let toolActivity = workTurnToolActivityIndex(from: snapshot.timeline)
  let presentation = makeWorkTimelinePresentation(
    timeline: workPresentedTimelineEntries(snapshot.timeline, provider: provider, toolActivity: toolActivity),
    visibleCount: workTimelinePageSize,
    assistantPreviewCache: WorkAssistantPreviewCache(),
    streamingAssistantMessageId: nil,
    toolActivity: toolActivity
  )
  let pending = snapshot.pendingInputQueue.resolved(hostPendingInputItemId: nil)
  model.receive(ChatThreadFrame(
    revision: 1,
    snapshot: snapshot,
    presentation: presentation,
    turnToolActivity: toolActivity,
    rowRevisions: Dictionary(
      presentation.renderEntries.map { ($0.id, workChatTranscriptRowRevision($0)) },
      uniquingKeysWith: { first, _ in first }
    ),
    changedRowIds: [],
    canonicalPendingInputs: pending,
    pendingInputs: pending,
    pendingSteers: snapshot.pendingSteers,
    isStreamingTurn: false,
    streamingAssistantMessageId: nil,
    activityPresentation: nil,
    claudeGoal: nil,
    latestReasoningCardId: nil,
    isReasoningLive: false,
    transcriptIndicatesActiveTurn: snapshot.transcriptIndicatesActiveTurn,
    hostTurnActiveHint: nil,
    hasOlderHistory: false,
    olderHistoryState: .exhausted,
    loadState: .idle,
    cacheOrigin: .host,
    sessionDeleted: false,
    visibleTimelineCount: workTimelinePageSize,
    prependedTimelineCount: 0,
    didResetHistory: false,
    isUrgent: true,
    resumePoint: nil,
    cardExpansionSignature: 0,
    viewportWidth: 0,
    transcript: transcript
  ))
  return model
}

/// A deliberately oversized AskUserQuestion payload: four paged questions, long
/// prompts, and eight options each. This is the shape that used to push the
/// composer off the bottom of the screen — the card must stay inside
/// `maxCardHeight` with Send/Decline visible, scrolling the options internally.
private func workPreviewOversizedQuestion() -> WorkPendingQuestionModel {
  func options(_ prefix: String) -> [WorkPendingQuestionOption] {
    (1...8).map { index in
      WorkPendingQuestionOption(
        label: "\(prefix) option \(index)",
        value: "\(prefix.lowercased())-\(index)",
        description: "A per-option description long enough to wrap onto a second line on a phone-width card.",
        recommended: index == 2,
        preview: index == 3 ? "┌────────────┐\n│  wireframe │\n└────────────┘" : nil,
        previewFormat: index == 3 ? "html" : nil
      )
    }
  }
  return WorkPendingQuestionModel(
    id: "preview-question-oversized",
    questions: [
      WorkPendingQuestion(
        questionId: "approach",
        question: "Which approach should the refactor take, given that the existing service already owns retry and backoff and we do not want to duplicate that logic in the new call path?",
        options: options("Approach"),
        allowsFreeform: true,
        header: "Approach",
        defaultAssumption: "Extend the existing service rather than adding a parallel one.",
        impact: "Changes the public surface of the sync layer.",
        multiSelect: false
      ),
      WorkPendingQuestion(
        questionId: "scope",
        question: "Which surfaces should ship in the first pass?",
        options: options("Scope"),
        allowsFreeform: true,
        header: "Scope",
        multiSelect: true
      ),
      WorkPendingQuestion(
        questionId: "rollout",
        question: "How should this roll out?",
        options: options("Rollout"),
        allowsFreeform: false,
        header: "Rollout"
      ),
      WorkPendingQuestion(
        questionId: "notes",
        question: "Anything else worth capturing before I start?",
        options: [],
        allowsFreeform: true,
        header: "Notes"
      )
    ],
    title: "Plan round 1",
    body: "Four questions before I start on the plan.",
    source: "claude"
  )
}

#Preview("Question card - oversized, phone budget") {
  // 720pt ≈ an iPhone chat surface with no keyboard; the card is capped at the
  // same fraction `pendingInputMaxHeight` uses so the preview matches the app.
  VStack {
    Spacer()
    WorkStructuredQuestionCard(
      question: workPreviewOversizedQuestion(),
      busy: false,
      onSelectOption: { _, _ in true },
      onSubmitAll: { _, _ in true },
      onDecline: { true },
      fallbackProvider: "claude",
      maxCardHeight: workPendingInputMaxHeight(chatSurfaceHeight: 720)
    )
    .padding(16)
  }
  .frame(maxWidth: .infinity, maxHeight: .infinity)
  .background(ADEColor.pageBackground)
  .preferredColorScheme(.dark)
}

#Preview("Question card - oversized, keyboard up") {
  // ~340pt of surface left once the keyboard is showing. Send must still be
  // on screen; the option list absorbs the loss.
  VStack {
    Spacer()
    WorkStructuredQuestionCard(
      question: workPreviewOversizedQuestion(),
      busy: false,
      onSelectOption: { _, _ in true },
      onSubmitAll: { _, _ in true },
      onDecline: { true },
      fallbackProvider: "claude",
      maxCardHeight: workPendingInputMaxHeight(chatSurfaceHeight: 340)
    )
    .padding(16)
  }
  .frame(maxWidth: .infinity, maxHeight: .infinity)
  .background(ADEColor.pageBackground)
  .preferredColorScheme(.dark)
}

#Preview("Question card - short, natural height") {
  // Regression guard for the other direction: a two-option question must not
  // grow to fill the budget or gain a scroll indicator.
  VStack {
    Spacer()
    WorkStructuredQuestionCard(
      question: WorkPendingQuestionModel(
        id: "preview-question-short",
        questions: [
          WorkPendingQuestion(
            questionId: "confirm",
            question: "Rebase onto main before opening the PR?",
            options: [
              WorkPendingQuestionOption(label: "Rebase", value: "rebase", description: nil, recommended: true),
              WorkPendingQuestionOption(label: "Leave it", value: "skip", description: nil)
            ],
            allowsFreeform: false
          )
        ],
        source: "claude"
      ),
      busy: false,
      onSelectOption: { _, _ in true },
      onSubmitAll: { _, _ in true },
      onDecline: { true },
      fallbackProvider: "claude",
      maxCardHeight: workPendingInputMaxHeight(chatSurfaceHeight: 720)
    )
    .padding(16)
  }
  .frame(maxWidth: .infinity, maxHeight: .infinity)
  .background(ADEColor.pageBackground)
  .preferredColorScheme(.dark)
}

#Preview("New chat") {
  NavigationStack {
    WorkNewChatScreen(
      lanes: [WorkPreviewData.lane],
      preferredLaneId: WorkPreviewData.lane.id,
      activeProjectId: nil,
      activeProjectRootPath: nil,
      onStarted: { _, _, _, _, _ in },
      onCliStarted: { _ in },
      onRefreshLanes: {}
    )
    .environmentObject(WorkPreviewData.syncService)
    .environmentObject(WorkPreviewData.dictationController)
  }
}

#Preview("Lane picker sheet") {
  WorkLanePickerMenuPreviewHost()
    .preferredColorScheme(.dark)
}

private struct WorkLanePickerMenuPreviewHost: View {
  @State private var searchQuery = ""

  var body: some View {
    WorkLanePickerMenu(
      lanes: [WorkPreviewData.lane],
      allLanesEmpty: false,
      selectedLaneId: WorkPreviewData.lane.id,
      showsAutoCreateOption: true,
      searchQuery: $searchQuery,
      onSelect: { _ in }
    )
  }
}

#Preview("Model picker") {
  WorkModelPickerSheet(
    currentModelId: WorkPreviewData.chatSummary.model,
    currentProvider: WorkPreviewData.chatSummary.provider,
    currentReasoningEffort: WorkPreviewData.chatSummary.reasoningEffort ?? "",
    currentCodexFastMode: WorkPreviewData.chatSummary.effectiveFastMode,
    isBusy: false,
    onSelect: { _, _, _, _ in }
  )
  .environmentObject(WorkPreviewData.syncService)
}

#Preview("Session settings") {
  WorkSessionSettingsSheet(
    sessionId: WorkPreviewData.chatSummary.sessionId,
    laneName: WorkPreviewData.lane.name,
    summary: WorkPreviewData.chatSummary,
    onSaved: {}
  )
  .environmentObject(WorkPreviewData.syncService)
}

private struct WorkPreviewSessionListScreen: View {
  @State private var selectedSessionId: String?

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 16) {
          VStack(alignment: .leading, spacing: 6) {
            Text("Work")
              .font(.largeTitle.weight(.bold))
              .foregroundStyle(ADEColor.textPrimary)
            Text("Primary lane - ade/mobile-droid-attempt-bbdcd095")
              .font(.subheadline)
              .foregroundStyle(ADEColor.textSecondary)
          }

          WorkSessionListRow(
            session: WorkPreviewData.terminalSession,
            lane: WorkPreviewData.lane,
            chatSummary: WorkPreviewData.chatSummary,
            isArchived: false,
            transitionNamespace: nil,
            selectedSessionId: $selectedSessionId,
            isSelecting: false,
            isChecked: false,
            onLongPressSelect: { _ in },
            onToggleSelect: { _ in },
            onOpen: { selectedSessionId = $0.id },
            onPin: { _ in },
            onRename: { _ in },
            onStopRuntime: { _ in },
            onDelete: { _ in },
            onCopyId: { _ in },
            onCopyDeepLink: { _ in },
            onGoToLane: { _ in }
          )
        }
        .padding(20)
      }
      .background(ADEColor.pageBackground)
    }
  }
}

private struct WorkRootPreviewHarness: View {
  @State private var searchText = ""
  @State private var selectedLaneId = "all"
  @State private var selectedStatus: WorkSessionStatusFilter = .all
  @State private var organization: WorkSessionOrganization = .byLane
  @State private var filterOpen = false
  @State private var selectedSessionId: String?
  @State private var collapsedSectionIds: Set<String> = ["lane:\(WorkPreviewData.iosSimLane.id)"]

  private var presentation: WorkRootSessionPresentation {
    buildWorkRootSessionPresentation(
      sessions: WorkPreviewData.rootSessions,
      optimisticSessions: [:],
      chatSummaries: WorkPreviewData.rootChatSummaries,
      archivedSessionIds: [],
      selectedStatus: selectedStatus,
      selectedLaneId: selectedLaneId,
      searchText: searchText,
      organization: organization,
      orderedLanes: WorkPreviewData.rootLanes,
      pullRequests: WorkPreviewData.rootPullRequests
    )
  }

  var body: some View {
    NavigationStack {
      ScrollViewReader { proxy in
        List {
          WorkFiltersSection(
            searchText: $searchText,
            selectedLaneId: $selectedLaneId,
            selectedStatus: $selectedStatus,
            organization: $organization,
            filterOpen: $filterOpen,
            lanes: WorkPreviewData.rootLanes,
            onClear: clearFilters
          )
          .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 8, trailing: 16))
          .listRowBackground(Color.clear)
          .listRowSeparator(.hidden)

          ForEach(presentation.sessionGroups) { group in
            WorkSidebarSectionHeader(
              group: group,
              collapsed: collapsedSectionIds.contains(group.id),
              onToggle: { toggleCollapsed(group.id) }
            )
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
            .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 2, trailing: 16))

            if !collapsedSectionIds.contains(group.id) {
              ForEach(group.sessions) { session in
                WorkSessionListRow(
                  session: session,
                  lane: WorkPreviewData.rootLanes.first(where: { $0.id == session.laneId }),
                  chatSummary: WorkPreviewData.rootChatSummaries[session.id],
                  isArchived: false,
                  transitionNamespace: nil,
                  selectedSessionId: $selectedSessionId,
                  isSelecting: false,
                  isChecked: false,
                  onLongPressSelect: { _ in },
                  onToggleSelect: { _ in },
                  onOpen: { selectedSessionId = $0.id },
                  onPin: { _ in },
                  onRename: { _ in },
                  onStopRuntime: { _ in },
                  onDelete: { _ in },
                  onCopyId: { _ in },
                  onCopyDeepLink: { _ in },
                  onGoToLane: { _ in }
                )
                .id(session.id)
                .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
              }
            }
          }
        }
        .listStyle(.plain)
        .listSectionSpacing(.compact)
        .scrollContentBackground(.hidden)
        .contentMargins(.bottom, 72, for: .scrollContent)
        .adeScreenBackground()
        .adeNavigationGlass()
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .navigationBar)
        .safeAreaInset(edge: .top, spacing: 0) {
          // No count pill: the attention rollup is the bell, once, and nowhere
          // else. See the note where `WorkLiveCountPill` used to be defined.
          ADERootTopBar(title: "Work") {
            EmptyView()
          }
        }
      }
    }
    .environmentObject(WorkPreviewData.syncService)
  }

  private func clearFilters() {
    searchText = ""
    selectedLaneId = "all"
    selectedStatus = .all
  }

  private func toggleCollapsed(_ id: String) {
    if collapsedSectionIds.contains(id) {
      collapsedSectionIds.remove(id)
    } else {
      collapsedSectionIds.insert(id)
    }
  }
}

// MARK: - Proof + Tools fixtures

/// Fixture data for the Proof sheet, its full-screen viewer, and the Work Tools
/// sheet. Everything here is synthesised in-process: no sync socket, no brain,
/// no network, no files on disk. That is what makes these screens renderable in
/// an Xcode preview and on a bare simulator (see `ADEPreviewScreenHost`).
@MainActor
enum WorkProofPreviewData {
  static let laneId = WorkPreviewData.lane.id

  /// A plausible captured page, drawn rather than bundled so the fixture adds
  /// no binary assets to the app.
  static func pageImage(
    host: String,
    heading: String,
    accent: UIColor,
    dark: Bool = false
  ) -> UIImage {
    let size = CGSize(width: 1_180, height: 820)
    let renderer = UIGraphicsImageRenderer(size: size)
    return renderer.image { context in
      let cg = context.cgContext
      let page = dark ? UIColor(white: 0.09, alpha: 1) : UIColor.white
      page.setFill()
      cg.fill(CGRect(origin: .zero, size: size))

      // Browser chrome.
      let chromeHeight: CGFloat = 92
      (dark ? UIColor(white: 0.16, alpha: 1) : UIColor(white: 0.94, alpha: 1)).setFill()
      cg.fill(CGRect(x: 0, y: 0, width: size.width, height: chromeHeight))
      for (index, dotColor) in [UIColor.systemRed, .systemOrange, .systemGreen].enumerated() {
        dotColor.setFill()
        cg.fillEllipse(in: CGRect(x: 26 + CGFloat(index) * 26, y: 34, width: 16, height: 16))
      }
      let field = CGRect(x: 120, y: 26, width: size.width - 176, height: 40)
      (dark ? UIColor(white: 0.24, alpha: 1) : UIColor.white).setFill()
      UIBezierPath(roundedRect: field, cornerRadius: 12).fill()
      draw(
        host,
        at: CGPoint(x: field.minX + 16, y: field.minY + 10),
        font: .systemFont(ofSize: 19, weight: .regular),
        color: dark ? UIColor(white: 0.75, alpha: 1) : UIColor(white: 0.35, alpha: 1)
      )

      // Page body: a heading, a rule, and a couple of content blocks.
      draw(
        heading,
        at: CGPoint(x: 64, y: chromeHeight + 60),
        font: .systemFont(ofSize: 46, weight: .bold),
        color: dark ? .white : UIColor(white: 0.1, alpha: 1)
      )
      accent.setFill()
      UIBezierPath(
        roundedRect: CGRect(x: 64, y: chromeHeight + 132, width: 150, height: 8),
        cornerRadius: 4
      ).fill()

      let line = dark ? UIColor(white: 0.22, alpha: 1) : UIColor(white: 0.9, alpha: 1)
      for row in 0..<5 {
        line.setFill()
        let width = [820.0, 700.0, 780.0, 540.0, 660.0][row]
        UIBezierPath(
          roundedRect: CGRect(x: 64, y: chromeHeight + 190 + CGFloat(row) * 34, width: width, height: 14),
          cornerRadius: 7
        ).fill()
      }

      accent.withAlphaComponent(0.16).setFill()
      UIBezierPath(
        roundedRect: CGRect(x: 64, y: chromeHeight + 400, width: size.width - 128, height: 220),
        cornerRadius: 20
      ).fill()
      accent.setFill()
      UIBezierPath(
        roundedRect: CGRect(x: 96, y: chromeHeight + 440, width: 232, height: 52),
        cornerRadius: 14
      ).fill()
      draw(
        "Continue",
        at: CGPoint(x: 148, y: chromeHeight + 454),
        font: .systemFont(ofSize: 21, weight: .semibold),
        color: .white
      )
    }
  }

  private static func draw(_ text: String, at point: CGPoint, font: UIFont, color: UIColor) {
    (text as NSString).draw(
      at: point,
      withAttributes: [.font: font, .foregroundColor: color]
    )
  }

  static func artifact(
    id: String,
    kind: String,
    title: String,
    minutesAgo: Int,
    mimeType: String
  ) -> ComputerUseArtifactSummary {
    ComputerUseArtifactSummary(
      id: id,
      artifactKind: kind,
      backendStyle: "local",
      backendName: "ade-browser",
      sourceToolName: "browser",
      originalType: kind == "video_recording" ? "video" : "image",
      title: title,
      description: nil,
      uri: "ade://artifact/\(id)",
      storageKind: "file",
      mimeType: mimeType,
      metadataJson: nil,
      laneId: laneId,
      createdAt: WorkPreviewData.iso(minutesAgo: minutesAgo),
      ownerKind: "chat_session",
      ownerId: WorkPreviewData.chatSummary.sessionId,
      relation: "evidence",
      reviewState: nil,
      workflowState: nil,
      reviewNote: nil
    )
  }

  /// Oldest first — the host appends, and the sheet reverses for display.
  static let artifacts: [ComputerUseArtifactSummary] = [
    artifact(
      id: "proof-6",
      kind: "screenshot",
      title: "Browser tool · example.com",
      minutesAgo: 61 * 24 * 3,
      mimeType: "image/png"
    ),
    artifact(
      id: "proof-5",
      kind: "screenshot",
      title: "Checkout total updates after promo code",
      minutesAgo: 260,
      mimeType: "image/png"
    ),
    artifact(
      id: "proof-4",
      kind: "video_recording",
      title: "Sign-in flow · docs.example.com",
      minutesAgo: 47,
      mimeType: "video/mp4"
    ),
    artifact(
      id: "proof-3",
      kind: "screenshot",
      title: "Browser tool · settings.example.com",
      minutesAgo: 18,
      mimeType: "image/png"
    ),
    artifact(
      id: "proof-2",
      kind: "screenshot",
      title: "Empty state after clearing every filter",
      minutesAgo: 4,
      mimeType: "image/png"
    ),
    artifact(
      id: "proof-1",
      kind: "screenshot",
      title: "Browser tool · app.example.com",
      minutesAgo: 0,
      mimeType: "image/png"
    ),
  ]

  static let content: [String: WorkLoadedArtifactContent] = [
    "proof-1": .image(
      pageImage(host: "app.example.com/dashboard", heading: "Dashboard", accent: .systemIndigo)
    ),
    "proof-2": .image(
      pageImage(host: "app.example.com/inbox?q=", heading: "Nothing here yet", accent: .systemTeal)
    ),
    "proof-3": .image(
      pageImage(host: "settings.example.com/profile", heading: "Profile", accent: .systemPink, dark: true)
    ),
    // A capture whose bytes never arrived. The row falls back to the warning
    // glyph and the viewer prints the reason instead of a blank page.
    "proof-4": .video(URL(fileURLWithPath: "/tmp/ade-preview-recording.mp4")),
    "proof-5": .error("Couldn't load this artifact."),
    "proof-6": .image(
      pageImage(host: "example.com", heading: "Example Domain", accent: .systemBlue)
    ),
  ]

  static let toolsFrame = pageImage(
    host: "app.example.com/dashboard",
    heading: "Dashboard",
    accent: .systemIndigo
  )

  static let toolsState = WorkToolsLaneState(
    laneId: laneId,
    activeTool: "browser",
    openTools: ["terminal", "browser", "git"],
    browser: WorkToolsBrowserState(
      tabs: [
        WorkToolsBrowserTab(
          id: "tab-1",
          title: "Dashboard · Example",
          url: "https://app.example.com/dashboard",
          ownerChatSessionId: nil,
          recording: false,
          active: true,
          handoffReason: nil
        ),
        WorkToolsBrowserTab(
          id: "tab-2",
          title: "Sign in to Example",
          url: "https://accounts.example.com/sign-in?redirect=/dashboard",
          ownerChatSessionId: WorkPreviewData.chatSummary.sessionId,
          recording: true,
          active: false,
          handoffReason: nil
        ),
        WorkToolsBrowserTab(
          id: "tab-3",
          title: "Settings",
          url: "https://settings.example.com/profile",
          ownerChatSessionId: nil,
          recording: false,
          active: false,
          handoffReason: nil
        ),
      ],
      latestObservation: WorkToolsObservation(
        path: "/preview/observation.png",
        caption: "app.example.com/dashboard"
      )
    ),
    browserUnavailable: nil,
    agentBrowserPresence: [
      WorkToolsAgentBrowserPresence(
        chatSessionId: WorkPreviewData.chatSummary.sessionId,
        tabId: "tab-2"
      )
    ],
    appControl: nil
  )

  /// The badge row's lane tool chips: the lane's simulator is up, the desktop
  /// browser has two tabs (one driven by an agent), and App Control is attached.
  static let toolChipsState = WorkToolsLaneState(
    laneId: laneId,
    activeTool: "ios",
    browser: WorkToolsBrowserState(tabs: Array(toolsState.browser?.tabs.prefix(2) ?? [])),
    agentBrowserPresence: toolsState.agentBrowserPresence,
    appControl: WorkToolsAppControlState(appName: "Ghost", status: "attached", driver: "cdp")
  )

  static let toolChipsAppleStatus = AppleDeviceStatus(
    laneId: laneId,
    device: AppleDeviceStatusDevice(
      udid: "preview-udid",
      name: "iPhone 16 Pro",
      family: "iphone",
      runtime: "iOS 26.0",
      state: "Booted"
    ),
    stream: AppleDeviceStatusStream(running: true),
    laneDevice: AppleDeviceStatusLaneDevice(udid: "preview-udid")
  )
}

/// A fixture screen selectable from the command line, so a screenshot of a
/// design change needs a simulator and nothing else:
///
///     xcrun simctl launch <udid> com.ade.ios -adePreviewScreen proof
///
/// DEBUG-only on both sides — the launch argument is ignored by a release
/// build because `ADEApp` never reads it there.
enum ADEPreviewScreen: String, CaseIterable {
  case proofList = "proof"
  case proofEmpty = "proof-empty"
  case proofViewer = "proof-viewer"
  case tools = "tools"
  /// The real chat with the lane tool chips (simulator, browser, App Control)
  /// in its floating badge row.
  case toolChips = "tool-chips"
  /// Scroll benchmark over a real transcript file. See `WorkChatScrollBench.swift`.
  case chatScroll = "chat-scroll"
  case queuedSteerDetail = "queued-steer"
  /// The real Work root with one offline machine seeded into the activity model,
  /// to screenshot that the list does NOT banner it. See
  /// `WorkConnectivityBannerPreviewHost`.
  case connectivityBanner = "connectivity-banner"
  /// The real Work tab list seeded with lanes, subagents, CLI rows and PR
  /// badges. See `WorkListPreviewHost`.
  case workList = "work-list"
  /// The New Chat page with fixture lanes and Claude/Codex limits. See
  /// `WorkNewChatPreviewHost` in `WorkNewChatScreen.swift`.
  case newChat = "new-chat"
  /// The Hub's glass composer over a scrolling list; `-adePreviewFocusComposer`
  /// opens it. See `HubComposerPreviewHost` in `WorkNewChatScreen.swift`.
  case hubComposer = "hub-composer"
  /// The Chat Info sheet built from a real transcript file
  /// (`-adeBenchTranscript <path>`). See `WorkChatInfoPreviewHost`.
  case chatInfo = "chat-info"

  /// `-adePreviewScreen <value>`. Matches the shape `simctl launch` and the
  /// Xcode scheme editor both use for launch arguments.
  static var requested: ADEPreviewScreen? {
    let arguments = ProcessInfo.processInfo.arguments
    guard let flagIndex = arguments.firstIndex(of: "-adePreviewScreen"),
          arguments.index(after: flagIndex) < arguments.endIndex else {
      return nil
    }
    return ADEPreviewScreen(rawValue: arguments[arguments.index(after: flagIndex)])
  }
}

/// Hosts one fixture screen full-bleed so it can be screenshotted on a
/// simulator with no brain, no pairing, and no network. Selected by a launch
/// argument in `ADEApp`; DEBUG-only, so it cannot exist in a release build.
struct ADEPreviewScreenHost: View {
  let screen: ADEPreviewScreen

  @State private var content = WorkProofPreviewData.content

  var body: some View {
    switch screen {
    case .proofList:
      WorkProofSheet(
        artifacts: WorkProofPreviewData.artifacts,
        artifactContent: $content,
        isRefreshing: false,
        refreshError: nil,
        onRefresh: {},
        onLoadArtifact: { _, _ in }
      )
    case .proofEmpty:
      WorkProofSheet(
        artifacts: [],
        artifactContent: .constant([:]),
        isRefreshing: false,
        refreshError: nil,
        onRefresh: {},
        onLoadArtifact: { _, _ in }
      )
    case .proofViewer:
      WorkProofViewer(
        artifacts: WorkProofPreviewData.artifacts.reversed(),
        artifactContent: WorkProofPreviewData.content,
        initialArtifactId: "proof-1",
        onLoadArtifact: { _, _ in }
      )
    case .chatScroll:
      WorkChatScrollBenchScreen(options: .fromLaunchArguments())
    case .chatInfo:
      WorkChatInfoPreviewHost()
    case .tools:
      WorkToolsSheet(
        laneId: WorkProofPreviewData.laneId,
        tool: .browser,
        previewState: WorkProofPreviewData.toolsState,
        previewFrame: WorkProofPreviewData.toolsFrame
      )
    case .toolChips:
      NavigationStack {
        workPreviewChatSessionView(
          laneTools: WorkLaneToolsPreview(
            state: WorkProofPreviewData.toolChipsState,
            appleStatus: WorkProofPreviewData.toolChipsAppleStatus
          )
        )
      }
    case .queuedSteerDetail:
      // Presented as a real sheet rather than rendered full-bleed, so the
      // detents and drag indicator the sheet declares are the ones in the
      // screenshot.
      WorkQueuedSteerPreviewHost()
    case .connectivityBanner:
      WorkConnectivityBannerPreviewHost()
    case .workList:
      WorkListPreviewHost()
    case .newChat:
      WorkNewChatPreviewHost()
    case .hubComposer:
      HubComposerPreviewHost()
    }
  }
}

/// Backdrop that opens `WorkQueuedSteerDetailSheet` on appear, so the fixture
/// screenshot shows the sheet as the phone presents it.
private struct WorkQueuedSteerPreviewHost: View {
  @State private var presented = false

  var body: some View {
    ADEColor.surfaceBackground
      .ignoresSafeArea()
      .onAppear { presented = true }
      .sheet(isPresented: $presented) {
        WorkQueuedSteerDetailSheet(
          steer: WorkQueuedSteerPreviewData.steer,
          capability: WorkQueuedSteerPreviewData.capability,
          turnActive: true,
          isLive: true,
          busy: false,
          onDispatchInline: {},
          onDispatchInterrupt: {},
          onBeginEdit: {},
          onCancel: {}
        )
        // The sheet offers [.medium, .large]; the fixture pins the large
        // detent so one screenshot shows every delivery option.
        .presentationDetents([.large])
      }
  }
}

@MainActor
private enum WorkQueuedSteerPreviewData {
  static let steer = WorkPendingSteerModel(
    id: "preview-steer-1",
    text: """
    Before you touch the transcript merge, re-read how the host writes a steered \
    message twice — `deliveryState: "queued"` when it is staged and non-queued \
    once the provider consumes it. Both rows reach the phone, so the prune has to \
    run before the idle filter, not after it.

    Then add the regression test for a still-pending steer: it has no graduating \
    row and must survive both prunes untouched.
    """,
    attachments: [
      AgentChatFileRef(path: "apps/ios/ADE/Views/Work/WorkErrorAndMessageHelpers.swift", type: "file"),
      AgentChatFileRef(path: "docs/features/chat/README.md", type: "file"),
    ],
    turnId: "preview-turn-1",
    timestamp: WorkPreviewData.timestamp
  )

  static let capability = workChatActiveSendCapability(
    provider: "claude",
    liveRedirectOnly: false
  )
}

#Preview("Proof sheet") {
  ADEPreviewScreenHost(screen: .proofList)
    .environmentObject(WorkPreviewData.syncService)
    .preferredColorScheme(.dark)
}

#Preview("Proof sheet - empty") {
  ADEPreviewScreenHost(screen: .proofEmpty)
    .environmentObject(WorkPreviewData.syncService)
    .preferredColorScheme(.dark)
}

#Preview("Proof viewer") {
  ADEPreviewScreenHost(screen: .proofViewer)
    .environmentObject(WorkPreviewData.syncService)
    .preferredColorScheme(.dark)
}

#Preview("Queued steer detail") {
  ADEPreviewScreenHost(screen: .queuedSteerDetail)
    .environmentObject(WorkPreviewData.syncService)
    .preferredColorScheme(.dark)
}

#Preview("Work tools sheet") {
  ADEPreviewScreenHost(screen: .tools)
    .environmentObject(WorkPreviewData.syncService)
    .preferredColorScheme(.dark)
}

#Preview("Work chat - lane tool chips") {
  ADEPreviewScreenHost(screen: .toolChips)
    .environmentObject(WorkPreviewData.syncService)
    .preferredColorScheme(.dark)
}

/// Fixture-only render of the real Work tab root with one offline machine in the
/// activity model. It exists so a simulator screenshot can show that the Work
/// list does NOT banner that machine — presence is surfaced per-row in the
/// Activity drawer, not as a list-level banner — without needing a second Mac to
/// actually go offline. Reached with `-adePreviewScreen connectivity-banner`.
///
/// It deliberately mounts `WorkRootScreen` — not a hand-built lookalike — so the
/// screenshot exercises the real list, the real filter row, and the real
/// placement of anything that sits above the lane groups.
struct WorkConnectivityBannerPreviewHost: View {
  @EnvironmentObject private var syncService: SyncService
  @StateObject private var drawer = ActivityDrawerModel()
  @State private var seeded = false

  var body: some View {
    WorkRootScreen(isTabActive: true)
      .environmentObject(drawer)
      .onAppear(perform: seed)
  }

  private func seed() {
    guard !seeded else { return }
    seeded = true

    let projectId = "ade-connectivity-preview"
    syncService.setActiveProjectForTesting(projectId: projectId, rootPath: nil)

    let now = Date()
    let offline = AccountAttentionMachine(
      machineKey: "studio-preview",
      name: "Arul’s Mac Studio",
      online: false,
      lastSeenAt: now.addingTimeInterval(-4 * 24 * 60 * 60)
    )
    let item = AccountAttentionItem(
      id: "preview-offline",
      revision: 1,
      fingerprint: "preview-offline:1",
      kind: .agent,
      eventKind: .agentRunning,
      phase: .running,
      activityTier: nil,
      machine: offline,
      project: AccountAttentionProject(projectId: projectId, name: "ADE"),
      title: "Offline preview session",
      preview: "Working",
      privacyPreview: "Agent working",
      destination: .session(sessionId: "preview-offline", itemId: nil, eventId: nil),
      occurredAt: now,
      updatedAt: now,
      seenAt: nil,
      dismissedAt: nil,
      expiresAt: nil
    )
    drawer.rebuild(from: AccountAttentionSnapshot(
      revision: 1,
      generatedAt: now,
      machines: nil,
      items: [item],
      tombstones: nil,
      itemsTruncated: false
    ))
  }
}

#Preview("Connectivity banner") {
  ADEPreviewScreenHost(screen: .connectivityBanner)
    .environmentObject(WorkPreviewData.syncService)
    .environmentObject(WorkPreviewData.dictationController)
    .preferredColorScheme(.light)
}
// MARK: - Work list fixture (`-adePreviewScreen work-list`)

/// DEBUG-only rows for the Work list, installed by `WorkRootScreen` in place of
/// the replicated database (see `installPreviewFixtureIfActive`). A simulator
/// has no machine to replicate from, so without this the list is empty.
@MainActor
final class WorkRootPreviewFixture {
  static var active: WorkRootPreviewFixture?

  let sessions: [TerminalSessionSummary]
  let lanes: [LaneSummary]
  let pullRequests: [PullRequestListItem]
  let chatSummaries: [String: AgentChatSessionSummary]
  /// Shows the list as attached to a live machine, so the header's create
  /// affordance renders enabled.
  let forcesLive = true
  /// `-adeWorkFixturePushChatAfter <s>`: opens the first chat after a delay,
  /// to measure the list while it is hidden behind a thread.
  var pushChatSessionId: String?
  var pushChatAfter: TimeInterval?

  init(
    sessions: [TerminalSessionSummary],
    lanes: [LaneSummary],
    pullRequests: [PullRequestListItem],
    chatSummaries: [String: AgentChatSessionSummary]
  ) {
    self.sessions = sessions
    self.lanes = lanes
    self.pullRequests = pullRequests
    self.chatSummaries = chatSummaries
  }
}

/// Mounts the real `WorkRootScreen` over `WorkListPreviewData`. Launch flags:
///
///     -adeWorkFixtureBurst <hz>          fake SyncService publishes (objectWillChange)
///     -adeWorkFixturePushChatAfter <s>   push the first chat after <s> seconds
///     -adeWorkFixtureUnread 0            no unread Activity item (badge off)
struct WorkListPreviewHost: View {
  @EnvironmentObject private var syncService: SyncService
  @StateObject private var drawer = ActivityDrawerModel()
  @State private var seeded = false
  @State private var burstTimer: Timer?

  var body: some View {
    Group {
      if seeded {
        WorkRootScreen(isTabActive: true)
      } else {
        Color.clear
      }
    }
    .environmentObject(drawer)
    .onAppear(perform: seed)
  }

  private func seed() {
    guard !seeded else { return }
    let defaults = UserDefaults.standard
    syncService.setActiveProjectForTesting(projectId: WorkListPreviewData.projectId, rootPath: nil)
    let fixture = WorkListPreviewData.fixture()
    let pushAfter = defaults.double(forKey: "adeWorkFixturePushChatAfter")
    if pushAfter > 0 {
      fixture.pushChatSessionId = WorkListPreviewData.parentChatId
      fixture.pushChatAfter = pushAfter
    }
    WorkRootPreviewFixture.active = fixture
    if defaults.object(forKey: "adeWorkFixtureUnread") as? String != "0" {
      seedUnreadActivity()
    }
    seeded = true
    let hz = defaults.double(forKey: "adeWorkFixtureBurst")
    if hz > 0 {
      let service = syncService
      burstTimer = Timer.scheduledTimer(withTimeInterval: 1 / hz, repeats: true) { _ in
        MainActor.assumeIsolated { service.objectWillChange.send() }
      }
    }
  }

  private func seedUnreadActivity() {
    let now = Date()
    let machine = AccountAttentionMachine(
      machineKey: "preview-mac",
      name: "Arul’s MacBook Pro",
      online: true,
      lastSeenAt: now
    )
    let item = AccountAttentionItem(
      id: "preview-needs-you",
      revision: 1,
      fingerprint: "preview-needs-you:1",
      kind: .agent,
      eventKind: .agentNeedsYou,
      phase: .needsYou,
      activityTier: nil,
      machine: machine,
      project: AccountAttentionProject(projectId: WorkListPreviewData.projectId, name: "ADE"),
      title: "Approve the migration plan",
      preview: "Waiting for your answer",
      privacyPreview: "Agent needs you",
      destination: .session(sessionId: WorkListPreviewData.needsYouChatId, itemId: nil, eventId: nil),
      occurredAt: now,
      updatedAt: now,
      seenAt: nil,
      dismissedAt: nil,
      expiresAt: nil
    )
    drawer.rebuild(from: AccountAttentionSnapshot(
      revision: 1,
      generatedAt: now,
      machines: nil,
      items: [item],
      tombstones: nil,
      itemsTruncated: false
    ))
  }
}

@MainActor
enum WorkListPreviewData {
  static let projectId = "ade-work-list-preview"
  static let parentChatId = "wl-parent-chat"
  static let needsYouChatId = "wl-needs-you"

  private static func iso(_ minutesAgo: Int) -> String { WorkPreviewData.iso(minutesAgo: minutesAgo) }

  private static func lane(
    id: String,
    name: String,
    type: String = "worktree",
    branch: String,
    color: String?,
    icon: LaneIcon? = nil,
    dirty: Bool = false,
    ahead: Int = 0
  ) -> LaneSummary {
    LaneSummary(
      id: id,
      name: name,
      description: nil,
      laneType: type,
      baseRef: "main",
      branchRef: branch,
      worktreePath: "/Users/admin/Projects/ADE/.ade/worktrees/\(branch)",
      attachedRootPath: nil,
      parentLaneId: nil,
      childCount: 0,
      stackDepth: 0,
      parentStatus: nil,
      isEditProtected: false,
      status: LaneStatus(dirty: dirty, ahead: ahead, behind: 0, remoteBehind: 0, rebaseInProgress: false),
      color: color,
      icon: icon,
      tags: [],
      folder: nil,
      createdAt: iso(60 * 24 * 3),
      archivedAt: nil,
      devicesOpen: nil
    )
  }

  static let primary = lane(id: "wl-lane-primary", name: "Primary", type: "primary", branch: "main", color: "#60a5fa", icon: .star, dirty: true, ahead: 2)
  static let hub = lane(id: "wl-lane-hub", name: "mobile work hub", branch: "ade/mobile-work-hub", color: "#a78bfa")
  static let perf = lane(id: "wl-lane-perf", name: "sync perf", branch: "ade/sync-perf", color: "#34d399", icon: .bolt)
  static let sim = lane(id: "wl-lane-sim", name: "ios sim editor", branch: "ade/ios-sim-editor", color: "#fb923c")

  private struct Row {
    var id: String
    var lane: LaneSummary
    var title: String
    var provider: String = "claude"
    var model: String = "claude-opus-5"
    /// "running" | "needs-you" | "done" | "cli-running" | "cli-done"
    var state: String
    var minutesAgo: Int
    var preview: String
    var parentId: String? = nil
  }

  private static let rows: [Row] = [
    Row(id: needsYouChatId, lane: primary, title: "Approve the migration plan", state: "needs-you", minutesAgo: 2,
        preview: "Should I drop the legacy lane_events table or keep it read-only?"),
    Row(id: "wl-primary-running", lane: primary, title: "Bump mobile build and publish TestFlight", provider: "codex", model: "gpt-6",
        state: "running", minutesAgo: 1, preview: "Archiving ADE and waiting for App Store Connect processing."),
    Row(id: "wl-primary-cli", lane: primary, title: "npm run test:desktop", state: "cli-done", minutesAgo: 95,
        preview: "Test Files  412 passed (412) · Duration 3m 41s"),
    Row(id: parentChatId, lane: hub, title: "Condense the Work header into one row", state: "running", minutesAgo: 1,
        preview: "Moving Linear, Cursor Cloud and Settings into the overflow menu."),
    Row(id: "wl-sub-1", lane: hub, title: "Find the desktop Cursor logo", state: "done", minutesAgo: 6,
        preview: "Desktop uses the lobehub Cursor mono glyph.", parentId: parentChatId),
    Row(id: "wl-sub-2", lane: hub, title: "Audit Work list observation", provider: "codex", model: "gpt-6", state: "running", minutesAgo: 1,
        preview: "WorkRootScreen reads 14 SyncService values in body.", parentId: parentChatId),
    Row(id: "wl-sub-3", lane: hub, title: "Screenshot light and dark headers", state: "needs-you", minutesAgo: 3,
        preview: "Which simulator should I boot?", parentId: parentChatId),
    Row(id: "wl-hub-cli", lane: hub, title: "codex", provider: "codex", model: "gpt-6", state: "cli-running", minutesAgo: 4,
        preview: "Running xcodebuild test-without-building…"),
    Row(id: "wl-perf-chat", lane: perf, title: "Coalesce roster publishes", state: "done", minutesAgo: 40,
        preview: "Roster deltas now batch at 60 ms; p95 publish 16 ms."),
    Row(id: "wl-sim-1", lane: sim, title: "Simulator inspector polish", provider: "cursor", model: "composer-2", state: "running", minutesAgo: 8,
        preview: "Tightening the element outline hit test."),
    Row(id: "wl-sim-2", lane: sim, title: "Preview target wiring", state: "done", minutesAgo: 180,
        preview: "Preview targets now resolve per lane."),
  ]

  static func fixture() -> WorkRootPreviewFixture {
    var sessions: [TerminalSessionSummary] = []
    var summaries: [String: AgentChatSessionSummary] = [:]
    for row in rows {
      let isCli = row.state.hasPrefix("cli")
      let running = row.state == "running" || row.state == "cli-running"
      let needsYou = row.state == "needs-you"
      let at = iso(row.minutesAgo)
      var session = WorkPreviewData.sessionFixture(
        id: row.id,
        lane: row.lane,
        title: row.title,
        toolType: isCli ? row.provider : "\(row.provider)-chat",
        status: running || needsYou ? "running" : "ended",
        runtimeState: needsYou ? "waiting-input" : (running ? "active" : "exited"),
        startedAt: at,
        endedAt: running || needsYou ? nil : at,
        preview: row.preview,
        summary: row.preview
      )
      session.lastActivityAt = at
      if let parentId = row.parentId {
        session.spawnKind = .subagent
        session.orchestrationParentSessionId = parentId
      }
      sessions.append(session)
      guard !isCli else { continue }
      var summary = WorkPreviewData.chatSummaryFixture(
        sessionId: row.id,
        lane: row.lane,
        title: row.title,
        goal: row.title,
        status: running || needsYou ? "active" : "ended",
        startedAt: at,
        endedAt: running || needsYou ? nil : at,
        lastActivityAt: at,
        preview: row.preview
      )
      summary.provider = row.provider
      summary.model = row.model
      summary.awaitingInput = needsYou
      if let parentId = row.parentId {
        summary.spawnKind = .subagent
        summary.orchestrationParentSessionId = parentId
      }
      summaries[row.id] = summary
    }
    return WorkRootPreviewFixture(
      sessions: sessions,
      lanes: [primary, hub, perf, sim],
      pullRequests: [
        pullRequest(id: "wl-pr-hub", lane: hub, number: 1304, title: "Work tab header in one row", state: "open", checks: "success"),
        pullRequest(id: "wl-pr-perf", lane: perf, number: 1298, title: "Coalesce roster publishes", state: "merged", checks: "success"),
        pullRequest(id: "wl-pr-sim", lane: sim, number: 1240, title: "iOS sim editor polish", state: "open", checks: "pending"),
      ],
      chatSummaries: summaries
    )
  }

  private static func pullRequest(
    id: String,
    lane: LaneSummary,
    number: Int,
    title: String,
    state: String,
    checks: String
  ) -> PullRequestListItem {
    PullRequestListItem(
      id: id,
      laneId: lane.id,
      laneName: lane.name,
      projectId: projectId,
      repoOwner: "arul",
      repoName: "ade",
      githubPrNumber: number,
      githubUrl: "https://github.com/arul/ade/pull/\(number)",
      title: title,
      state: state,
      baseBranch: lane.baseRef,
      headBranch: lane.branchRef,
      checksStatus: checks,
      reviewStatus: "none",
      additions: 212,
      deletions: 64,
      lastSyncedAt: nil,
      createdAt: iso(60 * 24),
      updatedAt: iso(10),
      adeKind: "single",
      linkedGroupId: nil,
      linkedGroupType: nil,
      linkedGroupName: nil,
      linkedGroupPosition: nil,
      linkedGroupCount: 0,
      workflowDisplayState: nil,
      cleanupState: nil
    )
  }
}

/// Chat Info over a real transcript, derived with the app's own builders, so a
/// simulator screenshot shows the sheet as a real chat fills it.
struct WorkChatInfoPreviewHost: View {
  @State private var expanded: Set<String> = []

  private struct Derived {
    var sessionId = "preview"
    var subagents: [WorkSubagentSnapshot] = []
    var scheduled: [WorkScheduledWorkSnapshot] = []
    var taskList: WorkChatTaskListSnapshot?
    var sources: WorkChatSourceList?
  }

  private static let derived: Derived = {
    let options = WorkChatScrollBenchOptions.fromLaunchArguments()
    guard let path = options.transcriptPath else { return Derived() }
    let events = WorkChatScrollBenchLoader.load(path: path, limit: options.limit)
    var filter = WorkSubagentTranscriptFilter()
    let admitted = filter.admit(events.map(\.envelope)) ?? []
    let transcript = admitted.map(makeWorkChatEnvelope(from:)).sorted(by: workChatEnvelopeOrderedBefore)
    return Derived(
      sessionId: transcript.first?.sessionId ?? "preview",
      subagents: buildWorkSubagentSnapshots(from: transcript),
      scheduled: buildWorkScheduledWorkSnapshots(from: transcript),
      taskList: buildWorkChatTaskListSnapshot(from: transcript),
      sources: buildWorkChatSourceList(from: transcript)
    )
  }()

  var body: some View {
    let data = Self.derived
    WorkChatInfoDetailsSheet(
      sessionId: data.sessionId,
      subagentSnapshots: data.subagents,
      scheduledWorkSnapshots: data.scheduled,
      scheduledWorkPaused: false,
      nextWakeAt: nil,
      provider: "claude",
      expandedTaskIds: $expanded,
      sessionModel: "claude-opus-5",
      sourceRefs: data.sources?.refs ?? [],
      omittedSourceRefCount: data.sources?.omittedCount ?? 0,
      taskList: data.taskList,
      onSelect: { _ in },
      onCancelScheduledWork: { _ in },
      onSetScheduledWorkPaused: { _ in },
      onStopTask: { _ in }
    )
  }
}
#endif
