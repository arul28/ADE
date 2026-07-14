import SwiftUI

struct PersonalChatsScreen: View {
  @EnvironmentObject private var syncService: SyncService
  @State private var searchText = ""
  @State private var loading = false
  @State private var errorMessage: String?
  @State private var newChatPresented = false
  @State private var showsArchived = false

  private var canCreateChat: Bool {
    syncService.canInvokeRemoteAction("personalChats.create")
  }

  private var visibleSessions: [AgentChatSessionSummary] {
    let needle = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    return syncService.personalChatSessions.filter { session in
      guard showsArchived || session.archivedAt == nil else { return false }
      guard !needle.isEmpty else { return true }
      return (session.title ?? "").lowercased().contains(needle)
        || (session.lastOutputPreview ?? "").lowercased().contains(needle)
        || session.provider.lowercased().contains(needle)
        || session.model.lowercased().contains(needle)
    }
  }

  var body: some View {
    ZStack {
      ADEColor.pageBackground.ignoresSafeArea()
      if loading && syncService.personalChatSessions.isEmpty {
        ProgressView("Loading chats…")
          .tint(ADEColor.accent)
          .foregroundStyle(ADEColor.textSecondary)
      } else if visibleSessions.isEmpty {
        emptyState
      } else {
        chatList
      }
    }
    .navigationTitle("Chats")
    .adeAnalyticsScreen(.personalChats)
    .navigationBarTitleDisplayMode(.large)
    .searchable(text: $searchText, prompt: "Search chats")
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        Menu {
          Toggle("Show archived", isOn: $showsArchived)
        } label: {
          Image(systemName: "ellipsis.circle")
        }
        .accessibilityLabel("Chat list options")
      }
      ToolbarItem(placement: .topBarTrailing) {
        Button {
          newChatPresented = true
        } label: {
          Image(systemName: "square.and.pencil")
            .font(.system(size: 15, weight: .semibold))
        }
        .disabled(!canCreateChat)
        .accessibilityLabel("New chat")
        .accessibilityHint(canCreateChat
          ? "Starts a conversation that is not linked to a project."
          : "Connect to a compatible ADE machine to start a chat.")
      }
    }
    .navigationDestination(isPresented: $newChatPresented) {
      PersonalChatNewScreen()
    }
    .safeAreaInset(edge: .top, spacing: 0) {
      if syncService.connectionState.isHostUnreachable {
        Label("Offline · showing saved chats", systemImage: "wifi.slash")
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.warning)
          .frame(maxWidth: .infinity)
          .padding(.vertical, 7)
          .background(ADEColor.warning.opacity(0.08))
      }
    }
    .overlay(alignment: .bottom) {
      if let errorMessage {
        ADENoticeCard(
          title: "Chats unavailable",
          message: errorMessage,
          icon: "exclamationmark.triangle.fill",
          tint: ADEColor.warning,
          actionTitle: "Retry",
          action: { Task { await refresh() } }
        )
          .padding(16)
          .transition(.move(edge: .bottom).combined(with: .opacity))
      }
    }
    .task(id: syncService.connectionState) {
      await refresh()
      while !Task.isCancelled && !syncService.connectionState.isHostUnreachable {
        try? await Task.sleep(nanoseconds: 5_000_000_000)
        guard !Task.isCancelled else { return }
        await refresh(quietly: true)
      }
    }
    .onAppear {
      Task { await refresh(quietly: !syncService.personalChatSessions.isEmpty) }
    }
  }

  private var chatList: some View {
    ScrollView {
      LazyVStack(spacing: 10) {
        ForEach(visibleSessions) { summary in
          NavigationLink {
            PersonalChatDestination(summary: summary)
          } label: {
            PersonalChatRow(summary: summary)
          }
          .buttonStyle(.plain)
          .contextMenu {
            if summary.archivedAt == nil {
              Button {
                Task { await perform(.archive, on: summary) }
              } label: {
                Label("Archive", systemImage: "archivebox")
              }
              .disabled(!canPerform(.archive))
            } else {
              Button {
                Task { await perform(.unarchive, on: summary) }
              } label: {
                Label("Unarchive", systemImage: "arrow.up.bin")
              }
              .disabled(!canPerform(.unarchive))
            }
            Button(role: .destructive) {
              Task { await perform(.delete, on: summary) }
            } label: {
              Label("Delete", systemImage: "trash")
            }
            .disabled(!canPerform(.delete))
          }
        }
      }
      .frame(maxWidth: 680)
      .frame(maxWidth: .infinity)
      .padding(.horizontal, 16)
      .padding(.vertical, 12)
    }
    .refreshable { await refresh() }
    .scrollIndicators(.hidden)
  }

  private var emptyState: some View {
    VStack(spacing: 16) {
      ZStack {
        Circle().fill(ADEColor.accent.opacity(0.12)).frame(width: 76, height: 76)
        Image(systemName: searchText.isEmpty ? "bubble.left.and.bubble.right.fill" : "magnifyingglass")
          .font(.system(size: 29, weight: .semibold))
          .foregroundStyle(ADEColor.accent)
      }
      Text(searchText.isEmpty ? "Start a conversation" : "No matching chats")
        .font(.system(.title3, design: .rounded).weight(.bold))
        .foregroundStyle(ADEColor.textPrimary)
      Text(searchText.isEmpty
        ? "Ask a question, explore an idea, or get something done without choosing a project."
        : "Try another title, model, or phrase.")
        .font(.subheadline)
        .foregroundStyle(ADEColor.textSecondary)
        .multilineTextAlignment(.center)
        .frame(maxWidth: 330)
      if searchText.isEmpty {
        Button {
          newChatPresented = true
        } label: {
          Label("Start a chat", systemImage: "plus")
            .font(.headline)
            .padding(.horizontal, 18)
            .frame(minHeight: 46)
        }
        .buttonStyle(.glassProminent)
        .tint(ADEColor.accent)
        .disabled(!canCreateChat)
        .accessibilityHint(canCreateChat
          ? "Starts a conversation that is not linked to a project."
          : "Connect to a compatible ADE machine to start a chat.")
      }
    }
    .padding(28)
  }

  @MainActor
  private func refresh(quietly: Bool = false) async {
    guard syncService.supportsPersonalChats,
          syncService.canInvokeRemoteAction("personalChats.list")
    else { return }
    if !quietly { loading = true }
    defer { loading = false }
    do {
      _ = try await syncService.refreshPersonalChats(includeArchived: true)
      errorMessage = nil
    } catch {
      guard !syncService.connectionState.isHostUnreachable else { return }
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  private func perform(
    _ action: PersonalChatLifecycleAction,
    on summary: AgentChatSessionSummary
  ) async {
    guard canPerform(action) else {
      errorMessage = "This chat action requires a live connection to a compatible ADE machine."
      return
    }
    do {
      try await syncService.performPersonalChatAction(action, sessionId: summary.sessionId)
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  private func canPerform(_ action: PersonalChatLifecycleAction) -> Bool {
    syncService.canInvokeRemoteAction("personalChats.\(action.rawValue)")
  }
}

private struct PersonalChatRow: View {
  let summary: AgentChatSessionSummary

  private var status: String {
    normalizedWorkChatSessionStatus(session: nil, summary: summary)
  }

  private var title: String {
    let value = summary.title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return value.isEmpty ? "New chat" : value
  }

  private var subtitle: String {
    let preview = summary.lastOutputPreview?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return preview.isEmpty
      ? "\(providerLabel(summary.provider)) · \(prettyWorkChatModelName(summary.model))"
      : preview
  }

  private var accessibilityStatus: String {
    switch status {
    case "active": return "Working"
    case "awaiting-input": return "Needs your input"
    case "idle": return "Ready"
    case "ended": return "Ended"
    default: return status.replacingOccurrences(of: "-", with: " ").capitalized
    }
  }

  private var accessibilityLabel: String {
    [
      title,
      accessibilityStatus,
      summary.archivedAt == nil ? nil : "Archived",
      subtitle,
      relativeTimestamp(summary.lastActivityAt),
    ]
      .compactMap { $0 }
      .joined(separator: ", ")
  }

  var body: some View {
    HStack(spacing: 13) {
      ZStack(alignment: .bottomTrailing) {
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .fill(providerTint(summary.provider).opacity(0.15))
          .frame(width: 43, height: 43)
          .overlay(
            WorkProviderBareLogo(
              provider: summary.provider,
              fallbackSymbol: providerIcon(summary.provider),
              tint: providerTint(summary.provider),
              size: 19
            )
          )
        Circle()
          .fill(workChatStatusTint(status))
          .frame(width: 9, height: 9)
          .overlay(Circle().stroke(ADEColor.cardBackground, lineWidth: 2))
      }

      VStack(alignment: .leading, spacing: 4) {
        HStack(spacing: 8) {
          Text(title)
            .font(.system(.subheadline, design: .rounded).weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(1)
          if summary.archivedAt != nil {
            Image(systemName: "archivebox.fill")
              .font(.caption2)
              .foregroundStyle(ADEColor.textMuted)
              .accessibilityLabel("Archived")
          }
          Spacer(minLength: 8)
          Text(relativeTimestamp(summary.lastActivityAt))
            .font(.caption2.monospacedDigit())
            .foregroundStyle(ADEColor.textMuted)
        }
        Text(subtitle)
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(2)
      }

      Image(systemName: "chevron.right")
        .font(.caption.bold())
        .foregroundStyle(ADEColor.textMuted)
    }
    .padding(13)
    .background(ADEColor.cardBackground.opacity(0.66), in: RoundedRectangle(cornerRadius: 15, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 15, style: .continuous)
        .stroke(status == "awaiting-input" ? ADEColor.warning.opacity(0.4) : ADEColor.border.opacity(0.7), lineWidth: 1)
    )
    .contentShape(RoundedRectangle(cornerRadius: 15, style: .continuous))
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(accessibilityLabel)
    .accessibilityHint("Opens this chat.")
  }
}

private struct PersonalChatDestination: View {
  let summary: AgentChatSessionSummary

  var body: some View {
    WorkSessionDestinationView(
      sessionId: summary.sessionId,
      initialOpeningPrompt: nil,
      initialSession: makePersonalChatSessionStub(summary),
      initialChatSummary: summary,
      initialTranscript: nil,
      transitionNamespace: nil,
      isLive: summary.archivedAt == nil,
      navigationChrome: .pushedDetail,
      forceFreshTranscriptOnOpen: true,
      showsLaneActions: false,
      navigationTitleOverride: summary.title,
      lanes: [],
      personalChat: true
    )
  }
}

func makePersonalChatSessionStub(_ summary: AgentChatSessionSummary) -> TerminalSessionSummary {
  let status = normalizedWorkChatSessionStatus(session: nil, summary: summary)
  let runtimeState: String
  switch status {
  case "active": runtimeState = "running"
  case "awaiting-input": runtimeState = "waiting-input"
  case "ended": runtimeState = "stopped"
  default: runtimeState = "idle"
  }
  let provider = providerFamilyKey(summary.provider)
  return TerminalSessionSummary(
    id: summary.sessionId,
    laneId: summary.laneId,
    laneName: "Personal chat",
    ptyId: nil,
    tracked: true,
    pinned: false,
    manuallyNamed: nil,
    goal: summary.goal,
    toolType: provider == "cursor" ? "cursor" : "\(provider)-chat",
    title: summary.title ?? "Chat",
    status: status,
    startedAt: summary.startedAt,
    endedAt: summary.endedAt,
    archivedAt: summary.archivedAt,
    exitCode: nil,
    transcriptPath: "",
    headShaStart: nil,
    headShaEnd: nil,
    lastOutputPreview: summary.lastOutputPreview,
    summary: summary.summary,
    runtimeState: runtimeState,
    resumeCommand: nil,
    resumeMetadata: nil,
    chatIdleSinceAt: summary.idleSinceAt,
    chatSessionId: summary.sessionId,
    pendingInputItemId: summary.pendingInputItemId
  )
}

struct PersonalChatNewScreen: View {
  @EnvironmentObject private var syncService: SyncService
  @State private var provider = "claude"
  @State private var modelId = "claude-sonnet-5"
  @State private var runtimeMode = "default"
  @State private var reasoningEffort = ""
  @State private var codexFastMode = false
  @State private var draft = ""
  @State private var composerHeight: CGFloat = 88
  @State private var composerFocused = true
  @State private var modelPickerPresented = false
  @State private var busy = false
  @State private var errorMessage: String?
  @State private var createdSummary: AgentChatSessionSummary?

  private var canCreateChat: Bool {
    syncService.canInvokeRemoteAction("personalChats.create")
  }

  private var canChooseModel: Bool {
    syncService.canInvokeRemoteAction("personalChats.modelCatalog")
  }

  init() {
    if let saved = WorkComposerPreferences.load() {
      _provider = State(initialValue: saved.provider)
      _modelId = State(initialValue: saved.modelId)
      _runtimeMode = State(initialValue: saved.runtimeMode)
      _reasoningEffort = State(initialValue: saved.reasoningEffort)
      _codexFastMode = State(initialValue: saved.codexFastMode)
    }
  }

  var body: some View {
    Group {
      if let createdSummary {
        PersonalChatDestination(summary: createdSummary)
      } else {
        composerScreen
      }
    }
  }

  private var composerScreen: some View {
    VStack(spacing: 0) {
      Spacer(minLength: 28)
      VStack(spacing: 12) {
        ZStack {
          Circle().fill(ADEColor.accent.opacity(0.12)).frame(width: 72, height: 72)
          Image(systemName: "sparkles")
            .font(.system(size: 28, weight: .semibold))
            .foregroundStyle(ADEColor.accent)
        }
        Text("What’s on your mind?")
          .font(.system(.title2, design: .rounded).weight(.bold))
          .foregroundStyle(ADEColor.textPrimary)
        Text("This chat isn’t linked to a project. Ask anything without choosing a repository or working directory.")
          .font(.subheadline)
          .foregroundStyle(ADEColor.textSecondary)
          .multilineTextAlignment(.center)
          .frame(maxWidth: 360)
      }
      .padding(.horizontal, 24)
      Spacer()
      if let errorMessage {
        Text(errorMessage)
          .font(.caption)
          .foregroundStyle(ADEColor.danger)
          .padding(.horizontal, 20)
          .padding(.bottom, 8)
      }
      composer
    }
    .adeScreenBackground()
    .navigationTitle("New chat")
    .navigationBarTitleDisplayMode(.inline)
    .sheet(isPresented: $modelPickerPresented) {
      WorkModelPickerSheet(
        currentModelId: modelId,
        currentProvider: provider,
        currentReasoningEffort: reasoningEffort,
        currentCodexFastMode: codexFastMode,
        cursorAvailabilityMode: .chat,
        lanes: [],
        commandScope: .personal,
        isBusy: busy,
        onSelect: { option, effort, runtimeProvider, fastMode in
          modelId = option.id
          let family = providerFamilyKey(runtimeProvider)
          provider = ["claude", "codex", "cursor", "opencode", "droid"].contains(family) ? family : "claude"
          reasoningEffort = effort ?? ""
          codexFastMode = fastMode
          runtimeMode = workDefaultRuntimeMode(provider: provider)
          WorkComposerPreferences.save(
            provider: provider,
            modelId: modelId,
            runtimeMode: runtimeMode,
            reasoningEffort: reasoningEffort,
            codexFastMode: codexFastMode
          )
        }
      )
    }
  }

  private var composer: some View {
    VStack(alignment: .leading, spacing: 12) {
      WorkPlainComposerTextView(
        text: $draft,
        isFocused: $composerFocused,
        measuredHeight: $composerHeight,
        placeholder: "Message ADE…",
        acceptsPastedImages: false,
        onPasteImages: { _ in }
      )
      .frame(minHeight: 54, idealHeight: composerHeight, maxHeight: min(180, composerHeight))

      HStack(spacing: 10) {
        Button { modelPickerPresented = true } label: {
          HStack(spacing: 7) {
            WorkProviderBareLogo(
              provider: provider,
              fallbackSymbol: providerIcon(provider),
              tint: providerTint(provider),
              size: 15
            )
            Text(workKnownModelDisplayName(modelId) ?? modelId)
              .font(.caption.weight(.semibold))
              .lineLimit(1)
            Image(systemName: "chevron.up.chevron.down").font(.system(size: 9, weight: .bold))
          }
          .foregroundStyle(ADEColor.textSecondary)
          .padding(.horizontal, 10)
          .frame(minHeight: 44)
          .background(ADEColor.surfaceBackground.opacity(0.7), in: Capsule())
        }
        .buttonStyle(.plain)
        .disabled(!canChooseModel || busy)
        .accessibilityLabel("Model, \(workKnownModelDisplayName(modelId) ?? modelId)")
        .accessibilityHint(canChooseModel
          ? "Opens the model picker."
          : "Connect to a compatible ADE machine to choose a model.")
        Spacer(minLength: 8)
        ADEComposerSendButton(
          enabled: canCreateChat && !busy && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
          sending: busy,
          accessibilityLabelText: "Start chat",
          disabledAccessibilityLabel: canCreateChat
            ? "Enter a message to start"
            : "Connect to a compatible ADE machine to start a chat"
        ) {
          Task { await create() }
        }
      }
    }
    .padding(14)
    .background(ADEColor.composerBackground, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).stroke(ADEColor.glassBorder, lineWidth: 1))
    .padding(.horizontal, 16)
    .padding(.bottom, 10)
  }

  @MainActor
  private func create() async {
    let prompt = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    guard canCreateChat, !prompt.isEmpty, !busy else { return }
    composerFocused = false
    busy = true
    errorMessage = nil
    defer { busy = false }
    let wire = workRuntimeWireFields(provider: provider, mode: runtimeMode)
    do {
      let summary = try await syncService.createPersonalChat(
        provider: provider,
        model: modelId,
        kickoffText: prompt,
        reasoningEffort: reasoningEffort.isEmpty ? nil : reasoningEffort,
        codexFastMode: workComposerSupportsFastMode(modelId: modelId, provider: provider) ? codexFastMode : nil,
        permissionMode: wire.permissionMode,
        interactionMode: wire.interactionMode,
        claudePermissionMode: wire.claudePermissionMode,
        codexApprovalPolicy: wire.codexApprovalPolicy,
        codexSandbox: wire.codexSandbox,
        codexConfigSource: wire.codexConfigSource,
        opencodePermissionMode: wire.opencodePermissionMode,
        droidPermissionMode: wire.droidPermissionMode,
        cursorModeId: wire.cursorModeId
      )
      ADEHaptics.success()
      createdSummary = summary
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
  }
}
