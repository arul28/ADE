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
    model: "claude-sonnet-4-6",
    modelId: "claude-sonnet-4-6",
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
        model: "claude-sonnet-4-6",
        modelId: "anthropic/claude-sonnet-4-6"
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
      model: "claude-sonnet-4-6",
      modelId: "claude-sonnet-4-6",
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
    summary: String? = nil
  ) -> TerminalSessionSummary {
    TerminalSessionSummary(
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

#Preview("Work chat") {
  NavigationStack {
    WorkChatSessionView(
      session: WorkChatSessionRenderContext(WorkPreviewData.terminalSession),
      chatSummaryContext: WorkChatSummaryRenderContext(WorkPreviewData.chatSummary),
      transcript: WorkPreviewData.transcript,
      transcriptRenderSignature: workChatEnvelopeListRenderSignature(WorkPreviewData.transcript),
      fallbackEntries: [],
      fallbackEntriesRenderSignature: workFallbackEntriesRenderSignature([]),
      artifacts: [WorkPreviewData.artifact],
      artifactsRenderSignature: workArtifactSummariesRenderSignature([WorkPreviewData.artifact]),
      optimisticPendingSteers: [],
      optimisticPendingSteersRenderSignature: workPendingSteersRenderSignature([]),
      localEchoMessages: [],
      localEchoMessagesRenderSignature: workLocalEchoMessagesRenderSignature([]),
      expandedToolCardIdsSnapshot: ["cmd-1"],
      expandedToolCardIdsRenderSignature: workExpandedToolCardIdsRenderSignature(["cmd-1"]),
      artifactContentRenderSignature: workLoadedArtifactContentRenderSignature([:]),
      artifactDrawerPresentedSnapshot: false,
      sendingSnapshot: false,
      errorMessageSnapshot: nil,
      expandedToolCardIds: Binding<Set<String>>.constant(["cmd-1"]),
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
      transitionNamespace: nil,
      onOpenLane: {},
      onSend: { _ in true },
      onInterrupt: {},
      onApproveRequest: { _, _, _ in },
      onRespondToQuestion: { _, _, _, _ in },
      onSubmitQuestionAnswers: { _, _, _ in },
      onDeclineQuestion: { _ in },
      onRespondToPermission: { _, _ in },
      onRetryLoad: {},
      onOpenFile: { _ in },
      onOpenPr: { _ in },
      onLoadArtifact: { _ in },
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
      subagentSnapshotsRenderSignature: workSubagentSnapshotsRenderSignature([])
    )
  }
  .environmentObject(WorkPreviewData.syncService)
  .environmentObject(WorkPreviewData.dictationController)
}

#Preview("New chat") {
  NavigationStack {
    WorkNewChatScreen(
      lanes: [WorkPreviewData.lane],
      preferredLaneId: WorkPreviewData.lane.id,
      onStarted: { _, _ in },
      onCliStarted: { _ in },
      onRefreshLanes: {}
    )
    .environmentObject(WorkPreviewData.syncService)
    .environmentObject(WorkPreviewData.dictationController)
  }
}

#Preview("Model picker") {
  WorkModelPickerSheet(
    currentModelId: WorkPreviewData.chatSummary.model,
    currentProvider: WorkPreviewData.chatSummary.provider,
    currentReasoningEffort: WorkPreviewData.chatSummary.reasoningEffort ?? "",
    isBusy: false,
    onSelect: { _, _, _ in }
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
      orderedLanes: WorkPreviewData.rootLanes
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
            liveCount: presentation.globalLiveSessionCount,
            needsInputCount: presentation.globalNeedsInputCount,
            isLive: true,
            onClear: clearFilters,
            onNewChat: {},
            onAddLane: {}
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
          ADERootTopBar(title: "Work") {
            if presentation.globalLiveSessionCount > 0 {
              WorkLiveCountPill(
                liveCount: presentation.globalLiveSessionCount,
                attentionCount: presentation.globalNeedsInputCount,
                onTap: {
                  guard let targetId = presentation.firstGlobalLiveSessionId else { return }
                  withAnimation(.snappy) {
                    proxy.scrollTo(targetId, anchor: .top)
                  }
                }
              )
            }
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
#endif
