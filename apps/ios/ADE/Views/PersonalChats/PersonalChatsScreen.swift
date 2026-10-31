import SwiftUI

struct PersonalChatsScreen: View {
  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  private var syncService: SyncService { syncPublishes.service }
  @EnvironmentObject private var machineFleet: MachineFleet
  /// The Duo's two-column Chats window: a row picks the chat for the detail
  /// column instead of pushing it. Nil everywhere else.
  var onSelect: ((AgentChatSessionSummary, _ machineKey: String?) -> Void)? = nil
  /// The chat the detail column shows, drawn selected in the list.
  var selectedSessionId: String? = nil
  /// Back to the Hub from the Duo's Chats window; nil when the list is
  /// pushed (the ‹ then pops it).
  var onClose: (() -> Void)? = nil
  @Environment(\.dismiss) private var dismiss
  @State private var searchText = ""
  @State private var loading = false
  @State private var errorMessage: String?
  @State private var newChatPresented = false
  @State private var showsArchived = false
  @State private var sessionsByMachine: [String: [AgentChatSessionSummary]] = [:]
  /// Fleet machines whose last list read failed, by machine key, with their names.
  @State private var failedMachineNames: [String: String] = [:]

  private var primaryMachineKey: String { syncService.focusedMachineKey ?? "primary" }
  private var rows: [PersonalChatRowEntry] {
    var result = (sessionsByMachine[primaryMachineKey] ?? syncService.personalChatSessions).map {
      PersonalChatRowEntry(summary: $0, machineKey: syncService.focusedMachineKey, machineName: syncService.focusedMachineDisplayName)
    }
    for machine in machineFleet.machines {
      result += (sessionsByMachine[machine.machineKey] ?? []).map {
        PersonalChatRowEntry(summary: $0, machineKey: machine.machineKey, machineName: machine.name)
      }
    }
    return result.sorted { lhs, rhs in
      let lhsArchived = lhs.summary.archivedAt != nil
      let rhsArchived = rhs.summary.archivedAt != nil
      if lhsArchived != rhsArchived { return !lhsArchived }
      let lhsAttention = lhs.summary.awaitingInput == true || lhs.summary.status == "awaiting-input"
      let rhsAttention = rhs.summary.awaitingInput == true || rhs.summary.status == "awaiting-input"
      if lhsAttention != rhsAttention { return lhsAttention }
      if lhs.summary.lastActivityAt != rhs.summary.lastActivityAt {
        return lhs.summary.lastActivityAt > rhs.summary.lastActivityAt
      }
      return lhs.id < rhs.id
    }
  }
  private var showsMachineBadges: Bool { Set(visibleSessions.map { $0.machineKey ?? primaryMachineKey }).count > 1 }

  private var canCreateChat: Bool {
    syncService.canInvokeRemoteAction("personalChats.create")
      || machineFleet.liveMachineKeys.contains { machineFleet.connection(for: $0)?.supportsAction("personalChats.create") == true }
  }

  private var visibleSessions: [PersonalChatRowEntry] {
    let needle = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    return rows.filter { entry in
      let session = entry.summary
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
      if loading && rows.isEmpty {
        ProgressView("Loading chats…")
          .tint(ADEColor.accent)
          .foregroundStyle(ADEColor.textSecondary)
      } else if visibleSessions.isEmpty && searchText.isEmpty && !failedMachineNames.isEmpty && errorMessage == nil {
        // A machine that did not answer is not "no chats".
        ADENoticeCard(
          title: "Chats unavailable",
          message: failedMachinesMessage,
          icon: "exclamationmark.triangle.fill",
          tint: ADEColor.warning,
          actionTitle: "Retry",
          action: { Task { await refresh() } }
        )
        .padding(16)
      } else if visibleSessions.isEmpty {
        emptyState
      } else {
        chatList
      }
    }
    // Every list column's header (Work, Lanes): ‹ ADE and the title, then
    // search with its filter inside, and New chat.
    .navigationTitle("")
    .adeAnalyticsScreen(.personalChats)
    .navigationBarTitleDisplayMode(.inline)
    .navigationBarBackButtonHidden(true)
    .toolbar {
      ToolbarItem(placement: .topBarLeading) {
        HStack(spacing: 6) {
          WorkHeaderProjectButton(iconDataUrl: nil) {
            if let onClose { onClose() } else { dismiss() }
          }
          .accessibilityLabel("Back to all projects")
          Text("Chats")
            .font(.system(size: 22, weight: .heavy, design: .rounded))
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(1)
            .fixedSize()
            .accessibilityAddTraits(.isHeader)
        }
        .padding(.horizontal, 4)
      }
      .sharedBackgroundVisibility(.hidden)
    }
    .safeAreaInset(edge: .top, spacing: 0) {
      HStack(spacing: 8) {
        LaneHeaderSearchField(
          searchText: $searchText,
          prompt: "Search chats",
          filterLabel: "Chat filters"
        ) {
          Toggle("Show archived", isOn: $showsArchived)
        } filterActive: {
          showsArchived
        }
        Button {
          newChatPresented = true
        } label: {
          Image(systemName: "square.and.pencil")
            .font(.system(size: 18, weight: .medium))
            .foregroundStyle(canCreateChat ? ADEColor.textPrimary : ADEColor.textMuted)
            .frame(width: 36, height: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!canCreateChat)
        .accessibilityLabel("New chat")
        .accessibilityHint(canCreateChat
          ? "Starts a conversation that is not linked to a project."
          : "Connect to a compatible ADE machine to start a chat.")
      }
      .padding(.horizontal, 16)
      .padding(.bottom, 6)
      .background(ADEColor.pageBackground.opacity(0.94))
    }
    .navigationDestination(isPresented: $newChatPresented) {
      PersonalChatNewScreen()
    }
    .safeAreaInset(edge: .top, spacing: 0) {
      // A small tinted capsule, not a full-width band: the band also tinted
      // the bar above it into one beige slab.
      if syncService.connectionState.isHostUnreachable {
        offlineNotice(Label("Offline · showing saved chats", systemImage: "wifi.slash"))
      } else if !failedMachineNames.isEmpty && !visibleSessions.isEmpty {
        offlineNotice(Label(failedMachinesMessage, systemImage: "exclamationmark.triangle"))
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
      await refresh(quietly: !rows.isEmpty)
      while !Task.isCancelled && !syncService.connectionState.isHostUnreachable {
        try? await Task.sleep(nanoseconds: 5_000_000_000)
        guard !Task.isCancelled else { return }
        await refresh(quietly: true)
      }
    }
  }

  private func offlineNotice(_ label: some View) -> some View {
    label
      .font(.caption.weight(.semibold))
      .foregroundStyle(ADEColor.warning)
      .lineLimit(2)
      .padding(.horizontal, 12)
      .padding(.vertical, 6)
      .background(ADEColor.warning.opacity(0.1), in: Capsule())
      .frame(maxWidth: .infinity)
      .padding(.vertical, 6)
  }

  private var chatList: some View {
    ScrollView {
      // One kit panel, hairlines between rows.
      LazyVStack(spacing: 0) {
        ForEach(Array(visibleSessions.enumerated()), id: \.element.id) { index, entry in
          let summary = entry.summary
          if index > 0 {
            Rectangle().fill(ADEKit.rule).frame(height: 0.75).padding(.leading, 70)
          }
          Group {
            if let onSelect {
              Button {
                onSelect(summary, entry.machineKey)
              } label: {
                PersonalChatRow(summary: summary, machineName: entry.machineName, showsMachine: showsMachineBadges)
              }
              // The selected row, as Work and Lanes mark theirs.
              .background {
                if summary.sessionId == selectedSessionId {
                  RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(ADEColor.accent.opacity(0.12))
                    .padding(.horizontal, 6)
                }
              }
              .accessibilityAddTraits(summary.sessionId == selectedSessionId ? .isSelected : [])
            } else {
              NavigationLink {
                PersonalChatDestination(summary: summary, machineKey: entry.machineKey)
              } label: {
                PersonalChatRow(summary: summary, machineName: entry.machineName, showsMachine: showsMachineBadges)
              }
            }
          }
          .buttonStyle(ADEKitRowButtonStyle())
          .contextMenu {
            if summary.archivedAt == nil {
              Button {
                Task { await perform(.archive, on: entry) }
              } label: {
                Label("Archive", systemImage: "archivebox")
              }
              .disabled(!canPerform(.archive, on: entry.machineKey))
            } else {
              Button {
                Task { await perform(.unarchive, on: entry) }
              } label: {
                Label("Unarchive", systemImage: "arrow.up.bin")
              }
              .disabled(!canPerform(.unarchive, on: entry.machineKey))
            }
            Button(role: .destructive) {
              Task { await perform(.delete, on: entry) }
            } label: {
              Label("Delete", systemImage: "trash")
            }
            .disabled(!canPerform(.delete, on: entry.machineKey))
          }
        }
      }
      // Flat rows under the header, like every other list column (no card
      // around the list).
      .frame(maxWidth: 680)
      .frame(maxWidth: .infinity)
      .padding(.vertical, 4)
    }
    .refreshable { await refresh() }
    .scrollIndicators(.hidden)
  }

  private var emptyState: some View {
    VStack(spacing: 16) {
      ZStack {
        Circle().fill(ADEKit.track).frame(width: 64, height: 64)
        Image(systemName: searchText.isEmpty ? "bubble.left.and.bubble.right.fill" : "magnifyingglass")
          .font(.system(size: 24, weight: .regular))
          .foregroundStyle(ADEColor.textMuted)
      }
      Text(searchText.isEmpty ? "Start a conversation" : "No matching chats")
        .font(.system(.title3, design: .rounded).weight(.bold))
        .foregroundStyle(ADEColor.textPrimary)
      Text(searchText.isEmpty
        ? "Chats here aren't tied to a project."
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
            .padding(.horizontal, 6)
        }
        .buttonStyle(ADEKitButtonStyle(prominent: true, wide: true))
        .frame(maxWidth: 240)
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
    guard syncService.supportsPersonalChats || !machineFleet.liveMachineKeys.isEmpty else { return }
    for machine in machineFleet.machines where sessionsByMachine[machine.machineKey] == nil {
      if let data = ADESharedContainer.defaults.data(forKey: Self.cacheKey(machine.machineKey)),
         let cached = try? JSONDecoder().decode([AgentChatSessionSummary].self, from: data) {
        sessionsByMachine[machine.machineKey] = cached
      }
    }
    if !quietly { loading = true }
    defer { loading = false }
    let timeout: UInt64 = 5_000_000_000
    async let focusedRefresh: Void = refreshFocused(timeoutNanoseconds: timeout)
    // A machine whose ADE has no personal chats has nothing to list; it is not a failure.
    let liveMachines = machineFleet.machines.filter {
      machineFleet.isLive($0.machineKey)
        && machineFleet.connection(for: $0.machineKey)?.supportsAction("personalChats.list") == true
    }
    await withTaskGroup(of: (String, String, [AgentChatSessionSummary]?).self) { group in
      for machine in liveMachines {
        group.addTask { @MainActor in
          // A failed read keeps the machine's cached rows; the failure is shown below.
          let summaries = try? await syncService.refreshPersonalChats(
            includeArchived: true,
            timeoutNanoseconds: timeout,
            machineKey: machine.machineKey
          )
          return (machine.machineKey, machine.name, summaries)
        }
      }
      for await (machineKey, name, summaries) in group {
        guard let summaries else {
          failedMachineNames[machineKey] = name
          continue
        }
        failedMachineNames.removeValue(forKey: machineKey)
        sessionsByMachine[machineKey] = summaries
        if let data = try? JSONEncoder().encode(summaries) {
          ADESharedContainer.defaults.set(data, forKey: Self.cacheKey(machineKey))
        }
      }
    }
    // A machine that went offline or left the fleet is no longer a failure.
    let liveKeys = Set(liveMachines.map(\.machineKey))
    failedMachineNames = failedMachineNames.filter { liveKeys.contains($0.key) }
    await focusedRefresh
  }

  @MainActor
  private func refreshFocused(timeoutNanoseconds: UInt64) async {
    guard syncService.supportsPersonalChats,
          syncService.canInvokeRemoteAction("personalChats.list") else { return }
    if sessionsByMachine[primaryMachineKey] == nil {
      sessionsByMachine[primaryMachineKey] = syncService.personalChatSessions
    }
    do {
      sessionsByMachine[primaryMachineKey] = try await syncService.refreshPersonalChats(
        includeArchived: true,
        timeoutNanoseconds: timeoutNanoseconds
      )
    } catch {
      if rows.isEmpty && !syncService.connectionState.isHostUnreachable {
        errorMessage = error.localizedDescription
      }
    }
  }

  @MainActor
  private func perform(
    _ action: PersonalChatLifecycleAction,
    on entry: PersonalChatRowEntry
  ) async {
    guard canPerform(action, on: entry.machineKey) else {
      errorMessage = "This chat action requires a live connection to a compatible ADE machine."
      return
    }
    do {
      try await syncService.performPersonalChatAction(
        action,
        sessionId: entry.summary.sessionId,
        machineKey: entry.machineKey
      )
      await refresh(quietly: true)
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  private func canPerform(_ action: PersonalChatLifecycleAction, on machineKey: String? = nil) -> Bool {
    if let machineKey, machineKey != syncService.focusedMachineKey {
      guard let connection = machineFleet.connection(for: machineKey) else { return false }
      return connection.isLive && connection.supportsAction("personalChats.\(action.rawValue)")
    }
    return syncService.canInvokeRemoteAction("personalChats.\(action.rawValue)")
  }

  private var failedMachinesMessage: String {
    "Couldn’t load chats from \(failedMachineNames.values.sorted().joined(separator: ", "))."
  }

  private static func cacheKey(_ machineKey: String) -> String {
    "ade.personalChats.fleet.cache.v1.\(Data(machineKey.utf8).base64EncodedString())"
  }
}

private struct PersonalChatRowEntry: Identifiable {
  let summary: AgentChatSessionSummary
  let machineKey: String?
  let machineName: String
  var id: String { machineKey.map { "machine:\($0)|\(summary.sessionId)" } ?? "focused|\(summary.sessionId)" }
}

private struct PersonalChatRow: View {
  let summary: AgentChatSessionSummary
  let machineName: String
  let showsMachine: Bool

  private var status: String {
    normalizedWorkChatSessionStatus(session: nil, summary: summary)
  }

  private var title: String {
    let value = summary.title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return value.isEmpty ? "New chat" : value
  }

  private var subtitle: String {
    let preview = summary.lastOutputPreview?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return preview.isEmpty ? modelContext : preview
  }

  private var modelContext: String {
    // `flatMap` on the optional-chained String resolves to Sequence.flatMap
    // (yielding [Character]), not Optional.flatMap, so the empty-string fallback
    // has to be spelled out.
    let trimmedModelId = summary.modelId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let rawModel = trimmedModelId.isEmpty ? summary.model : trimmedModelId
    let metadata = workResolvedPiModelMetadata(
      modelId: rawModel,
      profileId: summary.piProfileId,
      providerId: summary.piProviderId,
      piModelId: summary.piModelId
    )
    let modelLabel = metadata.map(workPiModelDisplayName) ?? prettyWorkChatModelName(rawModel)
    return "\(providerLabel(summary.provider)) · \(modelLabel)"
  }

  /// Model, then the machine when the list spans several.
  private var metaLine: String? {
    let parts = [subtitle == modelContext ? nil : modelContext, showsMachine ? machineName : nil].compactMap { $0 }
    return parts.isEmpty ? nil : parts.joined(separator: " · ")
  }

  private var accessibilityStatus: String {
    switch status {
    case "active": return "Working"
    // "Needs you", not "Needs your input": the shared status vocabulary
    // (ActivityPhaseVocabulary, WorkSessionCanonicalState, the push titles) says
    // those two words on every other surface, and VoiceOver hearing a third
    // phrasing for the same state is the same drift in audio.
    case "awaiting-input": return "Needs you"
    case "idle": return "Ready"
    case "ended": return "Ended"
    default: return status.replacingOccurrences(of: "-", with: " ").capitalized
    }
  }

  private var accessibilityLabel: String {
    [
      title,
      showsMachine ? machineName : nil,
      accessibilityStatus,
      summary.archivedAt == nil ? nil : "Archived",
      subtitle,
      subtitle == modelContext ? nil : modelContext,
      relativeTimestamp(summary.lastActivityAt),
    ]
      .compactMap { $0 }
      .joined(separator: ", ")
  }

  var body: some View {
    HStack(spacing: 13) {
      ZStack(alignment: .bottomTrailing) {
        RoundedRectangle(cornerRadius: 10, style: .continuous)
          .fill(ADEKit.track)
          .frame(width: 40, height: 40)
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
          .overlay(Circle().stroke(ADEKit.surface, lineWidth: 2))
      }

      VStack(alignment: .leading, spacing: 4) {
        // The title gets the row: the time never wraps, and the machine moves
        // to the quiet meta line, where a narrow column cannot squeeze both.
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          Text(title)
            .font(.system(.subheadline, design: .rounded).weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(2)
            .layoutPriority(1)
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
            .lineLimit(1)
            .fixedSize()
        }
        Text(subtitle)
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(1)
        if let metaLine {
          Text(metaLine)
            .font(.caption2.weight(.medium))
            .foregroundStyle(ADEColor.textMuted)
            .lineLimit(1)
        }
      }

      ADESettingsChevron()
    }
    .padding(.horizontal, ADEKit.inset)
    .padding(.vertical, 11)
    .contentShape(Rectangle())
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(accessibilityLabel)
    .accessibilityHint("Opens this chat.")
  }
}

private struct PersonalChatDestination: View {
  let summary: AgentChatSessionSummary
  /// The machine that owns the chat; nil for the focused machine.
  var machineKey: String? = nil

  var body: some View {
    WorkSessionDestinationView(
      sessionId: summary.sessionId,
      initialOpeningPrompt: nil,
      initialSession: makePersonalChatSessionStub(summary),
      initialChatSummary: summary,
      transitionNamespace: nil,
      isLive: summary.archivedAt == nil,
      navigationChrome: .pushedDetail,
      showsLaneActions: false,
      navigationTitleOverride: summary.title,
      lanes: [],
      personalChat: true,
      personalChatMachineKey: machineKey
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
    pinned: summary.pinned ?? false,
    manuallyNamed: nil,
    goal: summary.goal,
    toolType: toolTypeForProvider(provider),
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
  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  private var syncService: SyncService { syncPublishes.service }
  @EnvironmentObject private var machineFleet: MachineFleet
  @State private var provider = "claude"
  @State private var modelId = "claude-sonnet-5"
  @State private var runtimeMode = workDefaultRuntimeMode(provider: "claude")
  @State private var reasoningEffort = ""
  @State private var codexFastMode = false
  @State private var draft = ""
  @State private var attachments: [WorkChatInputAttachment] = []
  @State private var composerFocused = true
  @State private var modelPickerPresented = false
  @State private var selectedModelOption: WorkModelOption?
  @State private var busy = false
  @State private var errorMessage: String?
  @State private var createdSummary: AgentChatSessionSummary?
  @State private var selectedMachineKey: String?

  private var machineOptions: [WorkNewChatMachineOption] {
    let primary = WorkNewChatMachineOption(
      machineKey: nil,
      name: syncService.focusedMachineDisplayName,
      symbol: machineSymbol(machineKey: syncService.focusedMachineKey, name: syncService.focusedMachineDisplayName),
      isLive: syncService.canInvokeRemoteAction("personalChats.create")
    )
    let remote = machineFleet.machines.filter { machineFleet.isLive($0.machineKey) }.map { machine in
      WorkNewChatMachineOption(
        machineKey: machine.machineKey,
        name: machine.name,
        symbol: machineSymbol(machineKey: machine.machineKey, name: machine.name),
        isLive: machineFleet.connection(for: machine.machineKey)?.supportsAction("personalChats.create") == true
      )
    }
    return [primary] + remote.filter(\.isLive)
  }

  private var selectedMachine: WorkNewChatMachineOption {
    machineOptions.first { $0.machineKey == selectedMachineKey } ?? machineOptions[0]
  }

  private var canCreateChat: Bool {
    if let selectedMachineKey {
      guard let connection = machineFleet.connection(for: selectedMachineKey) else { return false }
      return connection.isLive && connection.supportsAction("personalChats.create")
    }
    return syncService.canInvokeRemoteAction("personalChats.create")
  }

  private var canChooseModel: Bool {
    if let selectedMachineKey {
      guard let connection = machineFleet.connection(for: selectedMachineKey) else { return false }
      return connection.isLive && connection.supportsAction("personalChats.modelCatalog")
    }
    return syncService.canInvokeRemoteAction("personalChats.modelCatalog")
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
        PersonalChatDestination(summary: createdSummary, machineKey: selectedMachineKey ?? syncService.focusedMachineKey)
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
        personalMachineKey: selectedMachineKey,
        isBusy: busy,
        onSelect: { option, pickedReasoning, runtimeProvider, pickedFastMode in
          selectedModelOption = option
          modelId = option.id
          provider = workNormalizedChatProvider(runtimeProvider)
          let nextReasoning = pickedReasoning ?? ""
          if nextReasoning != reasoningEffort { reasoningEffort = nextReasoning }
          if pickedFastMode != codexFastMode { codexFastMode = pickedFastMode }
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

  /// The app's shared glass prompt box. A personal chat has no project, so
  /// there is nothing to attach or stash; the ⋯ menu carries the model.
  private var composer: some View {
    ADEPlainGlassComposer(
      text: $draft,
      isFocused: $composerFocused,
      attachments: $attachments,
      placeholder: "Message ADE…",
      acceptsPastedImages: false,
      sendEnabled: canCreateChat && !busy && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
      sending: busy,
      sendAccessibilityLabel: "Start chat",
      disabledSendAccessibilityLabel: canCreateChat
        ? "Enter a message to start"
        : "Connect to a compatible ADE machine to start a chat",
      dictationTargetId: "personal-new-chat",
      onSend: { Task { await create() } },
      menu: { startDictation in
        Menu {
          Button { modelPickerPresented = true } label: {
            Label("Model · \(workKnownModelDisplayName(modelId) ?? modelId)", systemImage: "cpu")
          }
          .disabled(!canChooseModel || busy)
          if SpeechDictationService.isAvailable {
            Button(action: startDictation) {
              Label("Dictate", systemImage: "mic")
            }
          }
        } label: {
          Image(systemName: "ellipsis")
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(ADEColor.textSecondary)
            .frame(width: 36, height: 36)
            .contentShape(Circle())
            .frame(minWidth: 44, minHeight: 44)
        }
        .accessibilityLabel("Composer options")
      },
      controls: {
        WorkNewChatMachineDropdown(
          options: machineOptions,
          selected: selectedMachine,
          onSelect: { selectedMachineKey = $0.machineKey }
        )
        .disabled(busy)
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
            Image(systemName: "chevron.down").font(.system(size: 9, weight: .bold))
          }
          .foregroundStyle(ADEColor.textPrimary)
          .padding(.horizontal, 10)
          .frame(minHeight: workChatComposerChipRowHeight)
          .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .disabled(!canChooseModel || busy)
        .accessibilityLabel("Model, \(workKnownModelDisplayName(modelId) ?? modelId)")
        .accessibilityHint(canChooseModel
          ? "Opens the model picker."
          : "Connect to a compatible ADE machine to choose a model.")
      }
    )
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
    let piMetadata = workResolvedPiModelMetadata(
      modelId: modelId,
      profileId: selectedModelOption?.piProfileId,
      providerId: selectedModelOption?.piProviderId,
      piModelId: selectedModelOption?.piModelId
    )
    do {
      let summary = try await syncService.createPersonalChat(
        provider: provider,
        model: modelId,
        kickoffText: prompt,
        reasoningEffort: reasoningEffort.isEmpty ? nil : reasoningEffort,
        codexFastMode: codexFastMode,
        piProfileId: piMetadata?.profileId,
        piProviderId: piMetadata?.providerId,
        piModelId: piMetadata?.modelId,
        permissionMode: wire.permissionMode,
        interactionMode: wire.interactionMode,
        claudePermissionMode: wire.claudePermissionMode,
        codexApprovalPolicy: wire.codexApprovalPolicy,
        codexSandbox: wire.codexSandbox,
        codexConfigSource: wire.codexConfigSource,
        opencodePermissionMode: wire.opencodePermissionMode,
        droidPermissionMode: wire.droidPermissionMode,
        musePermissionMode: wire.musePermissionMode,
        copilotPermissionMode: wire.copilotPermissionMode,
        copilotContextTier: wire.copilotContextTier,
        copilotAutoTier: wire.copilotAutoTier,
        cursorModeId: wire.cursorModeId,
        machineKey: selectedMachineKey
      )
      ADEHaptics.success()
      syncService.setPersonalChatScope(sessionId: summary.sessionId, machineKey: selectedMachineKey)
      createdSummary = summary
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
  }
}
