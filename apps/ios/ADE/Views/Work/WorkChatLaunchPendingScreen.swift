import SwiftUI

// The chat before its agent starts (opening bubble, queued follow-ups, the
// setup card, a composer whose sends queue on the launch), and the gate that
// shows it on a chat route until the launch hands over to the ordinary chat
// destination for the SAME session id.

// MARK: - Pending chat screen

/// The chat before its agent starts. Same session id as the chat it becomes.
struct WorkChatLaunchPendingScreen: View {
  @EnvironmentObject private var syncService: SyncService
  @ObservedObject var store: ChatLaunchStore
  let launchId: String
  var navigationChrome: WorkSessionNavigationChrome = .pushedDetail
  /// Called after the user deleted the launch; the gate pops the screen.
  var onDeleted: () -> Void = {}

  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var draft = ""
  @State private var sending = false
  @State private var errorMessage: String?
  @State private var busyAction: WorkChatLaunchCardAction?
  @FocusState private var composerFocused: Bool

  private var entry: ChatLaunchEntry? { store.entry(launchId: launchId) }

  var body: some View {
    Group {
      if let entry {
        content(entry)
      } else {
        WorkChatOpeningSessionPlaceholder()
      }
    }
    .workSessionNavigationChrome(
      mode: navigationChrome,
      title: navigationTitle,
      trailingControls: { EmptyView() }
    )
    .task(id: launchId) {
      await refreshWhileForeign()
    }
    .onAppear { restoreFailedSends() }
    .onChange(of: store.sendFailures[launchId]) { _, _ in restoreFailedSends() }
  }

  /// Queued messages the host refused: put them back in the composer (ahead of
  /// anything typed since) with the error.
  private func restoreFailedSends() {
    guard let failure = store.takeSendFailure(launchId: launchId) else { return }
    let current = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    draft = (failure.texts + (current.isEmpty ? [] : [draft])).joined(separator: "\n\n")
    errorMessage = failure.message
    ADEHaptics.error()
  }

  private var navigationTitle: String {
    guard let snapshot = entry?.snapshot else { return "New chat" }
    let title = snapshot.title.trimmingCharacters(in: .whitespacesAndNewlines)
    if !title.isEmpty { return title }
    let name = snapshot.laneName.trimmingCharacters(in: .whitespacesAndNewlines)
    return name.isEmpty ? "New chat" : name
  }

  private func content(_ entry: ChatLaunchEntry) -> some View {
    let snapshot = entry.snapshot
    return ScrollViewReader { proxy in
      ScrollView {
        VStack(alignment: .leading, spacing: 14) {
          promptBubble(snapshot)
          ForEach(snapshot.queuedMessages) { message in
            WorkChatLaunchQueuedMessageView(message: message)
              .transition(.opacity.combined(with: .move(edge: .bottom)))
          }
          WorkChatLaunchSetupCard(
            launch: snapshot,
            actions: WorkChatLaunchCardActions(
              onDelete: { Task { await perform(.delete) } },
              onRetry: { Task { await perform(.retry) } },
              onStartNow: { Task { await perform(.startNow) } }
            ),
            busyAction: busyAction
          )
          .id("launch-card")
          if let errorMessage {
            Text(errorMessage)
              .font(.caption)
              .foregroundStyle(ADEColor.warning)
              .frame(maxWidth: .infinity, alignment: .leading)
          }
        }
        .padding(.horizontal, 16)
        .padding(.top, 12)
        .padding(.bottom, 16)
        .animation(ADEMotion.standard(reduceMotion: reduceMotion), value: snapshot.queuedMessages)
      }
      .scrollDismissesKeyboard(.interactively)
      .onChange(of: snapshot.queuedMessages.count) { _, _ in
        withAnimation(ADEMotion.standard(reduceMotion: reduceMotion)) {
          proxy.scrollTo("launch-card", anchor: .bottom)
        }
      }
    }
    .adeScreenBackground()
    .environment(\.workChatProvider, entry.resolvedProvider)
    .environment(\.workChatModelId, snapshot.modelId)
    .safeAreaInset(edge: .bottom, spacing: 0) {
      composer(snapshot)
    }
  }

  private func promptBubble(_ snapshot: ChatLaunchSnapshot) -> some View {
    WorkChatMessageBubble(
      message: WorkChatMessage(
        id: "launch-prompt-\(snapshot.launchId)",
        role: "user",
        markdown: snapshot.prompt.bubbleText,
        timestamp: snapshot.startedAt,
        turnId: nil,
        itemId: nil,
        attachments: snapshot.prompt.attachments.isEmpty ? nil : snapshot.prompt.attachments
      ),
      maxUserBubbleWidth: 320,
      onOpenFullOutput: {}
    )
  }

  // MARK: Composer

  private func composer(_ snapshot: ChatLaunchSnapshot) -> some View {
    let canType = snapshot.phase != .cancelled
    let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    return VStack(alignment: .leading, spacing: 6) {
      Text(composerHint(snapshot))
        .font(.caption2)
        .foregroundStyle(ADEColor.textMuted)
        .padding(.horizontal, 4)
      HStack(alignment: .bottom, spacing: 8) {
        TextField("Message", text: $draft, axis: .vertical)
          .lineLimit(1...6)
          .font(.body)
          .adePromptInputTraits()
          .focused($composerFocused)
          .disabled(!canType)
          .padding(.vertical, 6)
          .accessibilityLabel("Message")
          .accessibilityHint("Queued until the agent starts")
        ADEComposerSendButton(
          enabled: canType && !trimmed.isEmpty && !sending,
          sending: sending,
          accessibilityLabelText: "Queue message",
          disabledAccessibilityLabel: "Enter a message to queue"
        ) {
          Task { await sendQueuedMessage() }
        }
      }
      .padding(.horizontal, 14)
      .padding(.vertical, 8)
      .background {
        RoundedRectangle(cornerRadius: 22, style: .continuous)
          .fill(ADEColor.composerBackground)
      }
      .overlay(
        RoundedRectangle(cornerRadius: 22, style: .continuous)
          .stroke(ADEColor.glassBorder, lineWidth: 1)
      )
    }
    .padding(.horizontal, 12)
    .padding(.top, 6)
    .padding(.bottom, 8)
    .background(ADEColor.pageBackground.opacity(0.001))
  }

  private func composerHint(_ snapshot: ChatLaunchSnapshot) -> String {
    switch snapshot.phase {
    case .failed:
      return "Setup failed. Messages you send now wait for Retry or Start anyway."
    case .cancelled:
      return "This lane and chat were deleted."
    default:
      return "Messages you send now are queued and go out once the agent starts."
    }
  }

  @MainActor
  private func sendQueuedMessage() async {
    let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty, !sending else { return }
    sending = true
    errorMessage = nil
    draft = ""
    defer { sending = false }
    do {
      try await syncService.queueChatLaunchMessage(launchId: launchId, text: text)
      ADEHaptics.light()
    } catch {
      ADEHaptics.error()
      let typedSince = draft.trimmingCharacters(in: .whitespacesAndNewlines)
      draft = typedSince.isEmpty ? text : "\(text)\n\n\(draft)"
      errorMessage = "Couldn't send — \(error.localizedDescription)"
    }
  }

  // MARK: Card actions

  @MainActor
  private func perform(_ action: WorkChatLaunchCardAction) async {
    guard busyAction == nil else { return }
    busyAction = action
    errorMessage = nil
    defer { busyAction = nil }
    do {
      switch action {
      case .cancel, .delete:
        // A host refusal (the agent already started) surfaces below with the
        // host's own words; the service has re-read the launch by then.
        try await syncService.cancelChatLaunch(launchId: launchId)
        ADEHaptics.medium()
        onDeleted()
      case .retry:
        try await syncService.retryChatLaunch(launchId: launchId)
      case .startNow, .startAnyway:
        try await syncService.startChatLaunchNow(launchId: launchId)
      }
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
  }

  /// Pushed launch events reach peers of the ACTIVE project. A launch started
  /// from the Hub into another project gets a light refresh only while this
  /// screen is on screen; the active project needs none.
  @MainActor
  private func refreshWhileForeign() async {
    while !Task.isCancelled {
      guard let entry = store.entry(launchId: launchId), entry.hostAccepted else {
        try? await Task.sleep(nanoseconds: 1_000_000_000)
        continue
      }
      let scopeIsActive = syncService.isActiveProject(
        id: entry.projectId ?? "",
        rootPath: entry.projectRootPath
      ) || (entry.projectId == nil && entry.projectRootPath == nil)
      guard !scopeIsActive else { return }
      _ = try? await syncService.refreshChatLaunch(launchId: launchId)
      guard let latest = store.snapshot(launchId: launchId), isChatLaunchPending(latest) else { return }
      try? await Task.sleep(nanoseconds: 1_500_000_000)
    }
  }
}

// MARK: - Gate

/// Whether a chat route may lock onto the ordinary chat destination for good.
/// A launch decides once it is known: only after its agent started (or it
/// completed). With no launch held, the route can only be sure once this
/// connection has listed the active project's launches — a relaunch
/// mid-setup starts with an empty store, and locking then would strand the
/// chat without its setup screen, Retry, or Delete.
func workChatLaunchGateCanHandOver(launch: ChatLaunchSnapshot?, launchesHydrated: Bool) -> Bool {
  if let launch {
    return launch.agentStarted || launch.phase == .completed
  }
  return launchesHydrated
}

/// Sits on a chat route. While the launch for `sessionId` still owns the
/// chat's first moments (agent not started), it shows the pending screen; from
/// then on — or when there is no launch at all — the ordinary chat destination
/// for the same session id. Once handed over (see
/// `workChatLaunchGateCanHandOver`) it never flips back.
struct WorkChatLaunchGate<Content: View>: View {
  @EnvironmentObject private var syncService: SyncService
  @Environment(\.dismiss) private var dismiss
  let sessionId: String
  var navigationChrome: WorkSessionNavigationChrome = .pushedDetail
  @ViewBuilder let content: () -> Content

  @State private var handedOver = false
  @State private var deleted = false

  var body: some View {
    if deleted {
      ADEEmptyStateView(
        symbol: "trash",
        title: "Lane and chat deleted",
        message: "The lane, its branch and worktree, and this chat were removed."
      )
      .adeScreenBackground()
      .workSessionNavigationChrome(mode: navigationChrome, title: "Deleted", trailingControls: { EmptyView() })
    } else if !handedOver, let entry = pendingEntry {
      WorkChatLaunchPendingScreen(
        store: syncService.chatLaunchStore,
        launchId: entry.launchId,
        navigationChrome: navigationChrome,
        onDeleted: {
          deleted = true
          dismiss()
        }
      )
      .transition(.opacity)
    } else if !handedOver, let entry = syncService.chatLaunchEntry(sessionId: sessionId), entry.snapshot.phase == .cancelled {
      ADEEmptyStateView(
        symbol: "trash",
        title: "Lane and chat deleted",
        message: "This launch was cancelled, so its lane and chat were removed."
      )
      .adeScreenBackground()
      .workSessionNavigationChrome(mode: navigationChrome, title: "Deleted", trailingControls: { EmptyView() })
    } else {
      content()
        .onAppear { lockHandOverIfSettled() }
        .onChange(of: canHandOver) { _, _ in lockHandOverIfSettled() }
    }
  }

  private var canHandOver: Bool {
    workChatLaunchGateCanHandOver(
      launch: syncService.chatLaunchEntry(sessionId: sessionId)?.snapshot,
      launchesHydrated: syncService.chatLaunchStore.activeProjectHydrated
    )
  }

  private func lockHandOverIfSettled() {
    if !handedOver && canHandOver { handedOver = true }
  }

  private var pendingEntry: ChatLaunchEntry? {
    guard let entry = syncService.chatLaunchEntry(sessionId: sessionId),
          entry.snapshot.kind == .chat,
          isChatLaunchPending(entry.snapshot)
    else { return nil }
    return entry
  }
}
