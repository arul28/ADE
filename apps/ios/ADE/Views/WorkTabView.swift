import SwiftUI
import UIKit
import AVKit

private let workDateFormatter = ISO8601DateFormatter()

private enum WorkSessionStatusFilter: String, CaseIterable, Identifiable {
  case all
  case running
  case ended
  case archived

  var id: String { rawValue }

  var title: String {
    switch self {
    case .all: return "All"
    case .running: return "Running"
    case .ended: return "Ended"
    case .archived: return "Archived"
    }
  }
}

private struct WorkSessionRoute: Hashable {
  let sessionId: String
}

private struct WorkDraftChatSession {
  let summary: AgentChatSessionSummary
  let initialMessage: String?
}

struct WorkTabView: View {
  @EnvironmentObject private var syncService: SyncService

  @State private var sessions: [TerminalSessionSummary] = []
  @State private var chatSummaries: [String: AgentChatSessionSummary] = [:]
  @State private var lanes: [LaneSummary] = []
  @State private var transcriptCache: [String: [WorkChatEnvelope]] = [:]
  @State private var errorMessage: String?
  @State private var path = NavigationPath()
  @State private var searchText = ""
  @State private var selectedLaneId = "all"
  @State private var selectedStatus: WorkSessionStatusFilter = .all
  @State private var newChatPresented = false
  @State private var renameTarget: TerminalSessionSummary?
  @State private var renameText = ""
  @State private var endTarget: TerminalSessionSummary?
  @State private var optimisticSessions: [String: TerminalSessionSummary] = [:]
  @AppStorage("ade.work.archivedSessionIds") private var archivedSessionIdsStorage = ""

  private var workStatus: SyncDomainStatus {
    syncService.status(for: .work)
  }

  private var isLive: Bool {
    workStatus.phase == .ready && (syncService.connectionState == .connected || syncService.connectionState == .syncing)
  }

  private var needsRepairing: Bool {
    syncService.activeHostProfile == nil && !displaySessions.isEmpty
  }

  private var isLoadingSkeleton: Bool {
    workStatus.phase == .hydrating || workStatus.phase == .syncingInitialData
  }

  private var archivedSessionIds: Set<String> {
    Set(archivedSessionIdsStorage.split(separator: "\n").map(String.init))
  }

  private var mergedSessions: [TerminalSessionSummary] {
    let draftValues = optimisticSessions.values.filter { draft in
      !sessions.contains(where: { $0.id == draft.id })
    }
    return (sessions + draftValues).sorted { lhs, rhs in
      if lhs.pinned != rhs.pinned {
        return lhs.pinned && !rhs.pinned
      }
      return lhs.startedAt > rhs.startedAt
    }
  }

  private var displaySessions: [TerminalSessionSummary] {
    mergedSessions.filter { session in
      let isArchived = archivedSessionIds.contains(session.id)
      if selectedStatus != .all {
        switch selectedStatus {
        case .running:
          guard !isArchived && session.status == "running" else { return false }
        case .ended:
          guard !isArchived && session.status != "running" else { return false }
        case .archived:
          guard isArchived else { return false }
        case .all:
          break
        }
      }
      if selectedLaneId != "all" && session.laneId != selectedLaneId {
        return false
      }
      let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
      guard !query.isEmpty else { return true }
      let haystack = [
        session.title,
        session.goal ?? "",
        session.laneName,
        session.toolType ?? "",
        session.lastOutputPreview ?? "",
        session.summary ?? "",
        chatSummaries[session.id]?.model ?? "",
        chatSummaries[session.id]?.provider ?? "",
      ].joined(separator: " ").lowercased()
      return haystack.contains(query)
    }
  }

  private var pinnedSessions: [TerminalSessionSummary] {
    displaySessions.filter { $0.pinned && !archivedSessionIds.contains($0.id) }
  }

  private var unpinnedSessions: [TerminalSessionSummary] {
    displaySessions.filter { !$0.pinned && !archivedSessionIds.contains($0.id) }
  }

  private var archivedSessions: [TerminalSessionSummary] {
    displaySessions.filter { archivedSessionIds.contains($0.id) }
  }

  private var runningChatSessions: [TerminalSessionSummary] {
    mergedSessions.filter { isChatSession($0) && $0.status == "running" && !archivedSessionIds.contains($0.id) }
  }

  private var activityFeed: [WorkAgentActivity] {
    runningChatSessions.flatMap { session in
      let transcript = transcriptCache[session.id] ?? parseWorkChatTranscript(syncService.terminalBuffers[session.id] ?? "")
      return deriveWorkAgentActivities(
        from: transcript,
        session: WorkAgentActivityContext(
          sessionId: session.id,
          title: session.title,
          laneName: session.laneName,
          status: session.status,
          startedAt: session.startedAt
        )
      )
    }
    .sorted { lhs, rhs in
      if lhs.startedAt == rhs.startedAt {
        return lhs.agentName < rhs.agentName
      }
      return lhs.startedAt > rhs.startedAt
    }
  }

  var body: some View {
    NavigationStack(path: $path) {
      List {
        if let notice = statusNotice {
          notice
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
        }

        if isLoadingSkeleton {
          ForEach(0..<3, id: \.self) { _ in
            ADECardSkeleton(rows: 3)
              .listRowBackground(Color.clear)
              .listRowSeparator(.hidden)
          }
        } else {
          WorkFiltersSection(
            searchText: $searchText,
            selectedLaneId: $selectedLaneId,
            selectedStatus: $selectedStatus,
            lanes: lanes,
            runningCount: runningChatSessions.count
          )
          .listRowBackground(Color.clear)
          .listRowSeparator(.hidden)

          if !runningChatSessions.isEmpty {
            WorkRunningBanner(count: runningChatSessions.count)
              .listRowBackground(Color.clear)
              .listRowSeparator(.hidden)
          }

          if !activityFeed.isEmpty {
            Section("Activity") {
              ForEach(activityFeed) { activity in
                WorkActivityRow(activity: activity)
                  .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
                  .listRowBackground(Color.clear)
                  .listRowSeparator(.hidden)
              }
            }
          }

          if let errorMessage, workStatus.phase == .ready {
            ADENoticeCard(
              title: "Work view error",
              message: errorMessage,
              icon: "exclamationmark.triangle.fill",
              tint: ADEColor.danger,
              actionTitle: "Retry",
              action: { Task { await reload(refreshRemote: true) } }
            )
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
          }

          if displaySessions.isEmpty {
            ADEEmptyStateView(
              symbol: isLive ? "bubble.left.and.bubble.right" : "terminal",
              title: selectedStatus == .archived ? "No archived sessions" : "No work sessions yet",
              message: isLive
                ? "Start a new Claude or Codex chat, then filter by lane or status as activity comes in."
                : "Cached sessions stay visible here. Reconnect to create chats or refresh live agent work."
            ) {
              Button("New chat") {
                newChatPresented = true
              }
              .buttonStyle(.glassProminent)
              .tint(ADEColor.accent)
              .disabled(!isLive || lanes.isEmpty)
            }
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
          } else {
            if !pinnedSessions.isEmpty {
              WorkSessionSection(
                title: "Pinned",
                sessions: pinnedSessions,
                chatSummaries: chatSummaries,
                archivedSessionIds: archivedSessionIds,
                path: $path,
                onArchive: toggleArchive,
                onPin: togglePin,
                onRename: beginRename,
                onEnd: { session in endTarget = session },
                onResume: resumeSession,
                onCopyId: copySessionId,
                onGoToLane: goToLane
              )
            }

            if !unpinnedSessions.isEmpty {
              WorkSessionSection(
                title: selectedStatus == .running ? "Running" : selectedStatus == .ended ? "Ended" : "Sessions",
                sessions: unpinnedSessions,
                chatSummaries: chatSummaries,
                archivedSessionIds: archivedSessionIds,
                path: $path,
                onArchive: toggleArchive,
                onPin: togglePin,
                onRename: beginRename,
                onEnd: { session in endTarget = session },
                onResume: resumeSession,
                onCopyId: copySessionId,
                onGoToLane: goToLane
              )
            }

            if !archivedSessions.isEmpty && selectedStatus != .running && selectedStatus != .ended {
              WorkSessionSection(
                title: "Archived",
                sessions: archivedSessions,
                chatSummaries: chatSummaries,
                archivedSessionIds: archivedSessionIds,
                path: $path,
                onArchive: toggleArchive,
                onPin: togglePin,
                onRename: beginRename,
                onEnd: { session in endTarget = session },
                onResume: resumeSession,
                onCopyId: copySessionId,
                onGoToLane: goToLane
              )
            }
          }
        }
      }
      .listStyle(.plain)
      .scrollContentBackground(.hidden)
      .adeScreenBackground()
      .adeNavigationGlass()
      .navigationTitle("Work")
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button {
            newChatPresented = true
          } label: {
            Image(systemName: "plus.bubble.fill")
          }
          .disabled(!isLive || lanes.isEmpty)
        }
      }
      .refreshable {
        await reload(refreshRemote: true)
      }
      .task {
        await reload(refreshRemote: isLive)
      }
      .task(id: syncService.localStateRevision) {
        await reload()
      }
      .task(id: pollingKey) {
        await pollRunningChats()
      }
      .navigationDestination(for: WorkSessionRoute.self) { route in
        WorkSessionDestinationView(
          sessionId: route.sessionId,
          initialSession: mergedSessions.first(where: { $0.id == route.sessionId }),
          initialChatSummary: chatSummaries[route.sessionId],
          initialTranscript: transcriptCache[route.sessionId],
          isLive: isLive,
          disconnectedNotice: !isLive
        )
        .environmentObject(syncService)
      }
      .sheet(isPresented: $newChatPresented) {
        WorkNewChatSheet(lanes: lanes) { draft in
          optimisticSessions[draft.summary.sessionId] = makeOptimisticSession(for: draft.summary)
          chatSummaries[draft.summary.sessionId] = draft.summary
          newChatPresented = false
          await reload(refreshRemote: true)
          if let initialMessage = draft.initialMessage?.trimmingCharacters(in: .whitespacesAndNewlines), !initialMessage.isEmpty {
            try? await syncService.sendChatMessage(sessionId: draft.summary.sessionId, text: initialMessage)
          }
          path.append(WorkSessionRoute(sessionId: draft.summary.sessionId))
        }
        .environmentObject(syncService)
      }
      .alert("Rename session", isPresented: renamePresentedBinding) {
        TextField("Title", text: $renameText)
        Button("Cancel", role: .cancel) {
          renameTarget = nil
        }
        Button("Save") {
          Task { await submitRename() }
        }
      } message: {
        Text("Give this session a clearer title for search, pinning, and activity tracking.")
      }
      .alert("End session?", isPresented: endPresentedBinding, presenting: endTarget) { session in
        Button("Cancel", role: .cancel) {
          endTarget = nil
        }
        Button(isChatSession(session) ? "End chat" : "Close", role: .destructive) {
          Task { await endSession(session) }
        }
      } message: { session in
        Text(isChatSession(session)
          ? "ADE will ask the host to stop this chat and keep the transcript available for review."
          : "ADE will stop streaming new terminal output for this session.")
      }
    }
  }

  private var renamePresentedBinding: Binding<Bool> {
    Binding(
      get: { renameTarget != nil },
      set: { presented in
        if !presented {
          renameTarget = nil
          renameText = ""
        }
      }
    )
  }

  private var endPresentedBinding: Binding<Bool> {
    Binding(
      get: { endTarget != nil },
      set: { presented in
        if !presented {
          endTarget = nil
        }
      }
    )
  }

  private var pollingKey: String {
    let ids = runningChatSessions.map(\.id).joined(separator: ",")
    return "\(isLive)-\(ids)-\(syncService.localStateRevision)"
  }

  @MainActor
  private func reload(refreshRemote: Bool = false) async {
    do {
      if refreshRemote {
        try? await syncService.refreshWorkSessions()
      }
      async let sessionsTask = syncService.fetchSessions()
      async let lanesTask = syncService.fetchLanes()
      let loadedSessions = try await sessionsTask
      let loadedLanes = try await lanesTask
      sessions = loadedSessions
      lanes = loadedLanes.filter { $0.archivedAt == nil }
      for session in loadedSessions where optimisticSessions[session.id] != nil {
        optimisticSessions[session.id] = nil
      }
      if isLive {
        await refreshChatSummaries(for: loadedLanes)
      }
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  private func refreshChatSummaries(for lanes: [LaneSummary]) async {
    var updated = chatSummaries
    await withTaskGroup(of: (String, AgentChatSessionSummary)?.self) { group in
      for lane in lanes where lane.archivedAt == nil {
        group.addTask {
          do {
            let summaries = try await syncService.listChatSessions(laneId: lane.id)
            return summaries.map { ($0.sessionId, $0) }.first
          } catch {
            return nil
          }
        }
      }
      for await result in group {
        guard let result else { continue }
        updated[result.0] = result.1
      }
    }

    for lane in lanes where lane.archivedAt == nil {
      if let summaries = try? await syncService.listChatSessions(laneId: lane.id) {
        for summary in summaries {
          updated[summary.sessionId] = summary
        }
      }
    }

    chatSummaries = updated
  }

  @MainActor
  private func pollRunningChats() async {
    guard isLive else { return }
    let running = runningChatSessions
    guard !running.isEmpty else { return }

    while !Task.isCancelled && isLive && !runningChatSessions.isEmpty {
      for session in runningChatSessions {
        try? await syncService.subscribeTerminal(sessionId: session.id)
        transcriptCache[session.id] = parseWorkChatTranscript(syncService.terminalBuffers[session.id] ?? "")
      }
      try? await Task.sleep(nanoseconds: 900_000_000)
    }
  }

  private func toggleArchive(_ session: TerminalSessionSummary) {
    var archived = archivedSessionIds
    if archived.contains(session.id) {
      archived.remove(session.id)
    } else {
      archived.insert(session.id)
    }
    archivedSessionIdsStorage = archived.sorted().joined(separator: "\n")
  }

  private func togglePin(_ session: TerminalSessionSummary) {
    Task {
      try? await syncService.setSessionPinned(sessionId: session.id, pinned: !session.pinned)
      await reload()
    }
  }

  private func beginRename(_ session: TerminalSessionSummary) {
    renameTarget = session
    renameText = session.title
  }

  @MainActor
  private func submitRename() async {
    guard let renameTarget else { return }
    do {
      try await syncService.renameSession(sessionId: renameTarget.id, title: renameText)
      self.renameTarget = nil
      renameText = ""
      await reload()
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  private func copySessionId(_ session: TerminalSessionSummary) {
    UIPasteboard.general.string = session.id
  }

  private func goToLane(_ session: TerminalSessionSummary) {
    syncService.requestedLaneNavigation = LaneNavigationRequest(laneId: session.laneId)
  }

  private func resumeSession(_ session: TerminalSessionSummary) {
    if archivedSessionIds.contains(session.id) {
      toggleArchive(session)
    }
    path.append(WorkSessionRoute(sessionId: session.id))
  }

  @MainActor
  private func endSession(_ session: TerminalSessionSummary) async {
    defer { endTarget = nil }
    do {
      try await syncService.closeWorkSession(sessionId: session.id)
      await reload(refreshRemote: true)
      if let refreshed = mergedSessions.first(where: { $0.id == session.id }), refreshed.status == session.status, isChatSession(session) {
        errorMessage = "This host keeps chat runtimes alive until the turn finishes. Reconnect and try again if the status does not update."
      }
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  private func makeOptimisticSession(for summary: AgentChatSessionSummary) -> TerminalSessionSummary {
    let lane = lanes.first(where: { $0.id == summary.laneId })
    return TerminalSessionSummary(
      id: summary.sessionId,
      laneId: summary.laneId,
      laneName: lane?.name ?? summary.laneId,
      ptyId: nil,
      tracked: true,
      pinned: false,
      goal: summary.goal,
      toolType: toolTypeForProvider(summary.provider),
      title: summary.title ?? defaultWorkChatTitle(provider: summary.provider),
      status: summary.endedAt == nil ? "running" : "completed",
      startedAt: summary.startedAt,
      endedAt: summary.endedAt,
      exitCode: nil,
      transcriptPath: "",
      headShaStart: nil,
      headShaEnd: nil,
      lastOutputPreview: summary.lastOutputPreview,
      summary: summary.summary,
      runtimeState: summary.endedAt == nil ? "running" : "idle",
      resumeCommand: nil
    )
  }

  private var statusNotice: ADENoticeCard? {
    switch workStatus.phase {
    case .disconnected:
      return ADENoticeCard(
        title: displaySessions.isEmpty ? "Host disconnected" : "Showing cached sessions",
        message: displaySessions.isEmpty
          ? (syncService.activeHostProfile == nil
              ? "Pair with a host to create chats, stream tool activity, and fetch proof artifacts."
              : "Reconnect to create chats, stream transcripts, and refresh agent activity.")
          : (needsRepairing
              ? "Cached work is still visible, but the previous host trust was cleared. Pair again before trusting active session state."
              : "Cached sessions stay readable. Reconnect to stream new output, fetch artifacts, and create chats."),
        icon: "terminal",
        tint: ADEColor.warning,
        actionTitle: syncService.activeHostProfile == nil ? (needsRepairing ? "Pair again" : "Pair with host") : "Reconnect",
        action: {
          if syncService.activeHostProfile == nil {
            syncService.settingsPresented = true
          } else {
            Task {
              await syncService.reconnectIfPossible()
              await reload(refreshRemote: true)
            }
          }
        }
      )
    case .hydrating:
      return ADENoticeCard(
        title: "Hydrating work sessions",
        message: "Pulling host sessions, chat metadata, and proof artifacts so Work matches the desktop history.",
        icon: "arrow.trianglehead.2.clockwise.rotate.90",
        tint: ADEColor.accent,
        actionTitle: nil,
        action: nil
      )
    case .syncingInitialData:
      return ADENoticeCard(
        title: "Syncing initial data",
        message: "Waiting for the host to finish syncing core project data before Work hydrates session state.",
        icon: "arrow.trianglehead.2.clockwise.rotate.90",
        tint: ADEColor.warning,
        actionTitle: nil,
        action: nil
      )
    case .failed:
      return ADENoticeCard(
        title: "Work hydration failed",
        message: workStatus.lastError ?? "The host session list did not hydrate cleanly.",
        icon: "exclamationmark.triangle.fill",
        tint: ADEColor.danger,
        actionTitle: "Retry",
        action: { Task { await reload(refreshRemote: true) } }
      )
    case .ready:
      return nil
    }
  }
}

private struct WorkFiltersSection: View {
  @Binding var searchText: String
  @Binding var selectedLaneId: String
  @Binding var selectedStatus: WorkSessionStatusFilter
  let lanes: [LaneSummary]
  let runningCount: Int

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 10) {
        Image(systemName: "magnifyingglass")
          .foregroundStyle(ADEColor.textSecondary)
        TextField("Search sessions", text: $searchText)
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
      }
      .adeInsetField(cornerRadius: 14, padding: 12)

      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 8) {
          ForEach(WorkSessionStatusFilter.allCases) { status in
            Button {
              selectedStatus = status
            } label: {
              HStack(spacing: 6) {
                Text(status.title)
                if status == .running && runningCount > 0 {
                  Text("\(runningCount)")
                    .font(.caption2.weight(.semibold))
                }
              }
              .font(.caption.weight(.semibold))
              .foregroundStyle(selectedStatus == status ? ADEColor.accent : ADEColor.textSecondary)
              .padding(.horizontal, 12)
              .padding(.vertical, 8)
              .background(
                Capsule(style: .continuous)
                  .fill(selectedStatus == status ? ADEColor.accent.opacity(0.12) : ADEColor.surfaceBackground.opacity(0.6))
              )
            }
            .buttonStyle(.plain)
          }
        }
      }

      Picker("Lane", selection: $selectedLaneId) {
        Text("All lanes").tag("all")
        ForEach(lanes) { lane in
          Text(lane.name).tag(lane.id)
        }
      }
      .pickerStyle(.menu)
      .adeInsetField(cornerRadius: 14, padding: 10)
    }
    .adeGlassCard(cornerRadius: 18, padding: 14)
  }
}

private struct WorkRunningBanner: View {
  let count: Int

  var body: some View {
    HStack(spacing: 10) {
      Circle()
        .fill(ADEColor.success)
        .frame(width: 10, height: 10)
        .symbolEffect(.pulse, isActive: true)
      VStack(alignment: .leading, spacing: 2) {
        Text(count == 1 ? "1 agent is running" : "\(count) agents are running")
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
        Text("The Work tab badge stays visible until every active chat turn finishes.")
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
      }
      Spacer()
    }
    .adeGlassCard(cornerRadius: 18, padding: 14)
  }
}

private struct WorkSessionSection: View {
  let title: String
  let sessions: [TerminalSessionSummary]
  let chatSummaries: [String: AgentChatSessionSummary]
  let archivedSessionIds: Set<String>
  @Binding var path: NavigationPath
  let onArchive: (TerminalSessionSummary) -> Void
  let onPin: (TerminalSessionSummary) -> Void
  let onRename: (TerminalSessionSummary) -> Void
  let onEnd: (TerminalSessionSummary) -> Void
  let onResume: (TerminalSessionSummary) -> Void
  let onCopyId: (TerminalSessionSummary) -> Void
  let onGoToLane: (TerminalSessionSummary) -> Void

  var body: some View {
    Section(title) {
      ForEach(sessions) { session in
        NavigationLink(value: WorkSessionRoute(sessionId: session.id)) {
          WorkSessionRow(session: session, chatSummary: chatSummaries[session.id], isArchived: archivedSessionIds.contains(session.id))
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
          Button(archivedSessionIds.contains(session.id) ? "Restore" : "Archive") {
            onArchive(session)
          }
          .tint(ADEColor.warning)

          Button(session.pinned ? "Unpin" : "Pin") {
            onPin(session)
          }
          .tint(ADEColor.accent)
        }
        .contextMenu {
          Button("Rename") {
            onRename(session)
          }
          Button(session.pinned ? "Unpin" : "Pin") {
            onPin(session)
          }
          Button(archivedSessionIds.contains(session.id) ? "Restore from archive" : "Archive") {
            onArchive(session)
          }
          if session.status == "running" {
            Button(isChatSession(session) ? "End chat" : "Close session", role: .destructive) {
              onEnd(session)
            }
          } else {
            Button("Resume") {
              onResume(session)
            }
          }
          Button("Copy session ID") {
            onCopyId(session)
          }
          Button("Go to lane") {
            onGoToLane(session)
          }
        }
        .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
      }
    }
  }
}

private struct WorkSessionRow: View {
  let session: TerminalSessionSummary
  let chatSummary: AgentChatSessionSummary?
  let isArchived: Bool

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      Image(systemName: sessionSymbol(session, provider: chatSummary?.provider))
        .font(.system(size: 18, weight: .semibold))
        .foregroundStyle(rowTint)
        .frame(width: 28, height: 28)
        .background(rowTint.opacity(0.14), in: RoundedRectangle(cornerRadius: 10, style: .continuous))

      VStack(alignment: .leading, spacing: 8) {
        HStack(alignment: .top, spacing: 8) {
          VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
              Text(chatSummary?.title ?? session.title)
                .font(.headline)
                .foregroundStyle(ADEColor.textPrimary)
                .lineLimit(1)
              if session.pinned {
                Image(systemName: "pin.fill")
                  .font(.caption2)
                  .foregroundStyle(ADEColor.accent)
              }
            }

            HStack(spacing: 8) {
              WorkTag(text: session.laneName, icon: "arrow.triangle.branch", tint: ADEColor.textSecondary)
              if let chatSummary {
                WorkTag(text: providerLabel(chatSummary.provider), icon: providerIcon(chatSummary.provider), tint: rowTint)
                WorkTag(text: chatSummary.model, icon: "cpu", tint: ADEColor.textSecondary)
              } else if let toolType = session.toolType {
                WorkTag(text: toolType.replacingOccurrences(of: "-", with: " "), icon: "terminal", tint: ADEColor.textSecondary)
              }
            }
          }

          Spacer(minLength: 8)

          VStack(alignment: .trailing, spacing: 6) {
            ADEStatusPill(
              text: isArchived ? "ARCHIVED" : sessionStatusLabel(session),
              tint: isArchived ? ADEColor.warning : rowTint
            )
            Text(formattedSessionDuration(startedAt: session.startedAt, endedAt: session.endedAt))
              .font(.caption2.monospacedDigit())
              .foregroundStyle(ADEColor.textMuted)
          }
        }

        if let preview = chatSummary?.summary ?? chatSummary?.lastOutputPreview ?? session.summary ?? session.lastOutputPreview,
           !preview.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
          Text(preview)
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
            .lineLimit(2)
        }
      }
    }
    .adeGlassCard(cornerRadius: 18, padding: 14)
  }

  private var rowTint: Color {
    if isArchived { return ADEColor.warning }
    return session.status == "running" ? ADEColor.success : ADEColor.textSecondary
  }
}

private struct WorkActivityRow: View {
  let activity: WorkAgentActivity
  @State private var pulse = false

  var body: some View {
    HStack(spacing: 12) {
      Circle()
        .fill(ADEColor.success)
        .frame(width: 10, height: 10)
        .scaleEffect(pulse ? 1.25 : 0.95)
        .animation(.smooth(duration: 1.0).repeatForever(autoreverses: true), value: pulse)
        .onAppear { pulse = true }
      VStack(alignment: .leading, spacing: 4) {
        Text(activity.agentName)
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
        Text("\(activity.laneName) · \(activity.toolName ?? "Waiting")")
          .font(.caption.monospaced())
          .foregroundStyle(ADEColor.textSecondary)
        if let detail = activity.detail, !detail.isEmpty {
          Text(detail)
            .font(.caption)
            .foregroundStyle(ADEColor.textMuted)
            .lineLimit(1)
        }
      }
      Spacer()
      Text(formattedSessionDuration(startedAt: activity.startedAt, endedAt: nil))
        .font(.caption2.monospacedDigit())
        .foregroundStyle(ADEColor.textMuted)
    }
    .adeGlassCard(cornerRadius: 18, padding: 14)
  }
}

private struct WorkTag: View {
  let text: String
  let icon: String
  let tint: Color

  var body: some View {
    Label(text, systemImage: icon)
      .font(.caption2.weight(.medium))
      .foregroundStyle(tint)
      .padding(.horizontal, 8)
      .padding(.vertical, 5)
      .background(tint.opacity(0.10), in: Capsule(style: .continuous))
  }
}

private struct WorkNewChatSheet: View {
  @Environment(\.dismiss) private var dismiss
  @EnvironmentObject private var syncService: SyncService

  let lanes: [LaneSummary]
  let onCreated: @MainActor (WorkDraftChatSession) async -> Void

  @State private var provider = "claude"
  @State private var models: [AgentChatModelInfo] = []
  @State private var selectedModelId = ""
  @State private var selectedLaneId = ""
  @State private var initialMessage = ""
  @State private var busy = false
  @State private var errorMessage: String?

  var body: some View {
    NavigationStack {
      List {
        Section("Provider") {
          Picker("Provider", selection: $provider) {
            Text("Claude").tag("claude")
            Text("Codex").tag("codex")
          }
          .pickerStyle(.segmented)
          .listRowBackground(Color.clear)
        }

        Section("Model") {
          if models.isEmpty {
            ProgressView()
              .frame(maxWidth: .infinity, alignment: .leading)
          } else {
            Picker("Model", selection: $selectedModelId) {
              ForEach(models) { model in
                Text(model.displayName).tag(model.id)
              }
            }
            .pickerStyle(.menu)
            if let selected = models.first(where: { $0.id == selectedModelId }),
               let description = selected.description,
               !description.isEmpty {
              Text(description)
                .font(.caption)
                .foregroundStyle(ADEColor.textSecondary)
            }
          }
        }

        Section("Lane") {
          if lanes.isEmpty {
            ADEEmptyStateView(
              symbol: "arrow.triangle.branch",
              title: "No lanes available",
              message: "Create or sync a lane before starting a new chat session."
            )
            .listRowBackground(Color.clear)
          } else {
            ForEach(lanes) { lane in
              Button {
                selectedLaneId = lane.id
              } label: {
                HStack(spacing: 12) {
                  Circle()
                    .fill(lane.status.dirty ? ADEColor.warning : ADEColor.success)
                    .frame(width: 10, height: 10)
                  VStack(alignment: .leading, spacing: 4) {
                    Text(lane.name)
                      .font(.subheadline.weight(.semibold))
                      .foregroundStyle(ADEColor.textPrimary)
                    Text(lane.branchRef)
                      .font(.caption.monospaced())
                      .foregroundStyle(ADEColor.textSecondary)
                  }
                  Spacer()
                  if selectedLaneId == lane.id {
                    Image(systemName: "checkmark.circle.fill")
                      .foregroundStyle(ADEColor.accent)
                  }
                }
              }
              .buttonStyle(.plain)
              .listRowBackground(Color.clear)
            }
          }
        }

        Section("Optional first message") {
          TextField("Tell the agent what to do", text: $initialMessage, axis: .vertical)
            .textInputAutocapitalization(.sentences)
            .autocorrectionDisabled()
        }

        if let errorMessage {
          Section {
            Text(errorMessage)
              .font(.caption)
              .foregroundStyle(ADEColor.danger)
          }
        }
      }
      .listStyle(.insetGrouped)
      .scrollContentBackground(.hidden)
      .adeScreenBackground()
      .adeNavigationGlass()
      .navigationTitle("New chat")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }
            .disabled(busy)
        }
        ToolbarItem(placement: .confirmationAction) {
          Button("Start") {
            Task { await submit() }
          }
          .disabled(busy || selectedLaneId.isEmpty || selectedModelId.isEmpty)
        }
      }
      .task(id: provider) {
        await loadModels()
      }
      .onAppear {
        if selectedLaneId.isEmpty {
          selectedLaneId = lanes.first?.id ?? ""
        }
      }
    }
  }

  @MainActor
  private func loadModels() async {
    do {
      models = try await syncService.listChatModels(provider: provider)
      selectedModelId = models.first(where: \.isDefault)?.id ?? models.first?.id ?? ""
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
      models = []
      selectedModelId = ""
    }
  }

  @MainActor
  private func submit() async {
    do {
      busy = true
      let summary = try await syncService.createChatSession(laneId: selectedLaneId, provider: provider, model: selectedModelId)
      await onCreated(WorkDraftChatSession(summary: summary, initialMessage: initialMessage))
      dismiss()
    } catch {
      errorMessage = error.localizedDescription
    }
    busy = false
  }
}

private struct WorkSessionDestinationView: View {
  @EnvironmentObject private var syncService: SyncService

  let sessionId: String
  let initialSession: TerminalSessionSummary?
  let initialChatSummary: AgentChatSessionSummary?
  let initialTranscript: [WorkChatEnvelope]?
  let isLive: Bool
  let disconnectedNotice: Bool

  @State private var session: TerminalSessionSummary?
  @State private var chatSummary: AgentChatSessionSummary?
  @State private var transcript: [WorkChatEnvelope] = []
  @State private var fallbackEntries: [AgentChatTranscriptEntry] = []
  @State private var artifacts: [ComputerUseArtifactSummary] = []
  @State private var localEchoMessages: [WorkLocalEchoMessage] = []
  @State private var expandedToolCardIds = Set<String>()
  @State private var artifactContent: [String: WorkLoadedArtifactContent] = [:]
  @State private var fullscreenImage: WorkFullscreenImage?
  @State private var composer = ""
  @State private var sending = false
  @State private var errorMessage: String?

  var body: some View {
    Group {
      if let session {
        if isChatSession(session) {
          WorkChatSessionView(
            session: session,
            chatSummary: chatSummary,
            transcript: transcript,
            fallbackEntries: fallbackEntries,
            artifacts: artifacts,
            localEchoMessages: localEchoMessages,
            expandedToolCardIds: $expandedToolCardIds,
            artifactContent: $artifactContent,
            fullscreenImage: $fullscreenImage,
            composer: $composer,
            sending: $sending,
            errorMessage: $errorMessage,
            isLive: isLive,
            disconnectedNotice: disconnectedNotice,
            onSend: sendMessage,
            onLoadArtifact: loadArtifactContent
          )
        } else {
          WorkTerminalSessionView(session: session, disconnectedNotice: disconnectedNotice)
            .environmentObject(syncService)
        }
      } else {
        ADEEmptyStateView(
          symbol: "bubble.left.and.bubble.right",
          title: "Session unavailable",
          message: "This session is no longer cached on the phone. Reconnect and refresh Work to restore it."
        )
        .adeScreenBackground()
      }
    }
    .navigationTitle(chatSummary?.title ?? session?.title ?? "Session")
    .navigationBarTitleDisplayMode(.inline)
    .sheet(item: $fullscreenImage) { image in
      WorkFullscreenImageView(image: image)
    }
    .task {
      session = initialSession
      chatSummary = initialChatSummary
      transcript = initialTranscript ?? []
      await load()
    }
    .task(id: pollingKey) {
      await pollIfNeeded()
    }
  }

  private var pollingKey: String {
    "\(session?.id ?? sessionId)-\(session?.status ?? "unknown")-\(isLive)"
  }

  @MainActor
  private func load() async {
    do {
      if let fetchedSession = try await syncService.fetchSessions().first(where: { $0.id == sessionId }) {
        session = fetchedSession
      }
      if let fetchedSummary = try? await syncService.fetchChatSummary(sessionId: sessionId) {
        chatSummary = fetchedSummary
      }
      artifacts = (try? await syncService.fetchComputerUseArtifacts(ownerKind: "chat_session", ownerId: sessionId)) ?? []
      await loadTranscript(forceRemote: isLive)
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  private func loadTranscript(forceRemote: Bool) async {
    if forceRemote {
      try? await syncService.subscribeTerminal(sessionId: sessionId)
    }

    let raw = syncService.terminalBuffers[sessionId] ?? ""
    let parsed = parseWorkChatTranscript(raw)
    if !parsed.isEmpty {
      transcript = parsed
      fallbackEntries = []
    } else if let response = try? await syncService.fetchChatTranscriptResponse(sessionId: sessionId) {
      fallbackEntries = response.entries
      transcript = makeWorkChatTranscript(from: response.entries, sessionId: sessionId)
    }

    localEchoMessages.removeAll { echo in
      transcript.contains(where: { envelope in
        if case .userMessage(let text, _) = envelope.event {
          return text.trimmingCharacters(in: .whitespacesAndNewlines) == echo.text.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return false
      })
    }
  }

  @MainActor
  private func pollIfNeeded() async {
    guard isLive, let session, isChatSession(session), session.status == "running" else { return }
    while !Task.isCancelled, isLive, (self.session?.status == "running") {
      await loadTranscript(forceRemote: true)
      if let refreshedSummary = try? await syncService.fetchChatSummary(sessionId: sessionId) {
        chatSummary = refreshedSummary
      }
      if let refreshedSession = try? await syncService.fetchSessions().first(where: { $0.id == sessionId }) {
        self.session = refreshedSession
      }
      try? await Task.sleep(nanoseconds: 850_000_000)
    }
  }

  @MainActor
  private func sendMessage() async {
    let text = composer.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return }

    localEchoMessages.append(WorkLocalEchoMessage(text: text, timestamp: workDateFormatter.string(from: Date())))
    composer = ""
    sending = true
    do {
      try await syncService.sendChatMessage(sessionId: sessionId, text: text)
      await loadTranscript(forceRemote: true)
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
    sending = false
  }

  @MainActor
  private func loadArtifactContent(_ artifact: ComputerUseArtifactSummary) async {
    guard artifactContent[artifact.id] == nil else { return }

    if let directURL = URL(string: artifact.uri), directURL.scheme?.hasPrefix("http") == true {
      artifactContent[artifact.id] = .remoteURL(directURL)
      return
    }

    do {
      let blob = try await syncService.readArtifact(artifactId: artifact.id, uri: artifact.uri)
      let data: Data
      if blob.isBinary {
        data = Data(base64Encoded: blob.content) ?? Data()
      } else {
        data = blob.content.data(using: .utf8) ?? Data()
      }

      if artifact.artifactKind == "video_recording" || (artifact.mimeType?.contains("video") == true) {
        let url = FileManager.default.temporaryDirectory
          .appendingPathComponent("ade-work-artifact-\(artifact.id)")
          .appendingPathExtension(fileExtension(for: artifact.mimeType, fallback: "mp4"))
        try data.write(to: url, options: .atomic)
        artifactContent[artifact.id] = .video(url)
      } else if let image = UIImage(data: data) {
        artifactContent[artifact.id] = .image(image)
      } else {
        artifactContent[artifact.id] = .text(blob.content)
      }
    } catch {
      artifactContent[artifact.id] = .error(error.localizedDescription)
    }
  }
}

private struct WorkChatSessionView: View {
  let session: TerminalSessionSummary
  let chatSummary: AgentChatSessionSummary?
  let transcript: [WorkChatEnvelope]
  let fallbackEntries: [AgentChatTranscriptEntry]
  let artifacts: [ComputerUseArtifactSummary]
  let localEchoMessages: [WorkLocalEchoMessage]
  @Binding var expandedToolCardIds: Set<String>
  @Binding var artifactContent: [String: WorkLoadedArtifactContent]
  @Binding var fullscreenImage: WorkFullscreenImage?
  @Binding var composer: String
  @Binding var sending: Bool
  @Binding var errorMessage: String?
  let isLive: Bool
  let disconnectedNotice: Bool
  let onSend: @MainActor () async -> Void
  let onLoadArtifact: @MainActor (ComputerUseArtifactSummary) async -> Void

  private var toolCards: [WorkToolCardModel] {
    buildWorkToolCards(from: transcript)
  }

  private var timeline: [WorkTimelineEntry] {
    buildWorkTimeline(
      transcript: transcript,
      fallbackEntries: fallbackEntries,
      toolCards: toolCards,
      artifacts: artifacts,
      localEchoMessages: localEchoMessages
    )
  }

  var body: some View {
    ScrollViewReader { proxy in
      ScrollView {
        VStack(alignment: .leading, spacing: 14) {
          WorkSessionHeader(session: session, chatSummary: chatSummary)

          if disconnectedNotice {
            ADENoticeCard(
              title: "Connection lost",
              message: "Cached messages stay visible, but sending, streaming, and artifact refresh are paused until the host reconnects.",
              icon: "wifi.slash",
              tint: ADEColor.warning,
              actionTitle: nil,
              action: nil
            )
          }

          if let errorMessage {
            ADENoticeCard(
              title: "Chat error",
              message: errorMessage,
              icon: "exclamationmark.triangle.fill",
              tint: ADEColor.danger,
              actionTitle: nil,
              action: nil
            )
          }

          if timeline.isEmpty {
            ADEEmptyStateView(
              symbol: "bubble.left.and.bubble.right",
              title: "No chat messages yet",
              message: isLive ? "Send a message to start streaming the transcript." : "Reconnect to load the latest chat history from the host."
            )
          } else {
            ForEach(timeline) { entry in
              switch entry.payload {
              case .message(let message):
                WorkChatMessageBubble(message: message)
              case .toolCard(let toolCard):
                WorkToolCardView(
                  toolCard: toolCard,
                  isExpanded: expandedToolCardIds.contains(toolCard.id),
                  onToggle: { toggleToolCard(toolCard.id) }
                )
              case .artifact(let artifact):
                WorkArtifactView(
                  artifact: artifact,
                  content: artifactContent[artifact.id],
                  onAppear: { Task { await onLoadArtifact(artifact) } },
                  onOpenImage: { image in
                    fullscreenImage = WorkFullscreenImage(title: artifact.title, image: image)
                  }
                )
              }
            }
          }

          if session.status == "running" && isLive {
            HStack(spacing: 10) {
              ProgressView()
                .controlSize(.small)
              Text("Streaming new output…")
                .font(.caption)
                .foregroundStyle(ADEColor.textSecondary)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(ADEColor.surfaceBackground.opacity(0.55), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
          }

          Color.clear
            .frame(height: 1)
            .id("chat-end")
        }
        .padding(16)
      }
      .scrollIndicators(.hidden)
      .adeScreenBackground()
      .adeNavigationGlass()
      .safeAreaInset(edge: .bottom) {
        VStack(spacing: 10) {
          HStack(alignment: .bottom, spacing: 10) {
            TextField("Send a message", text: $composer, axis: .vertical)
              .textFieldStyle(.plain)
              .lineLimit(1...6)
              .adeInsetField(cornerRadius: 14, padding: 12)
              .disabled(!isLive || sending)

            Button {
              Task {
                await onSend()
                withAnimation(.snappy) {
                  proxy.scrollTo("chat-end", anchor: .bottom)
                }
              }
            } label: {
              Image(systemName: sending ? "ellipsis.circle" : "paperplane.fill")
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(ADEColor.accent)
                .frame(width: 44, height: 44)
                .background(ADEColor.accent.opacity(0.12), in: Circle())
            }
            .disabled(!isLive || sending || composer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
          }

          if !isLive {
            Text("Reconnect to send or resume this chat.")
              .font(.caption2)
              .foregroundStyle(ADEColor.textMuted)
              .frame(maxWidth: .infinity, alignment: .leading)
          }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(ADEColor.surfaceBackground.opacity(0.08))
        .glassEffect()
      }
      .onChange(of: timeline.count) { _, _ in
        withAnimation(.snappy) {
          proxy.scrollTo("chat-end", anchor: .bottom)
        }
      }
    }
  }

  private func toggleToolCard(_ id: String) {
    if expandedToolCardIds.contains(id) {
      expandedToolCardIds.remove(id)
    } else {
      expandedToolCardIds.insert(id)
    }
  }
}

private struct WorkSessionHeader: View {
  let session: TerminalSessionSummary
  let chatSummary: AgentChatSessionSummary?

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .top, spacing: 12) {
        Image(systemName: providerIcon(chatSummary?.provider ?? ""))
          .font(.system(size: 20, weight: .semibold))
          .foregroundStyle(providerTint(chatSummary?.provider))
          .frame(width: 34, height: 34)
          .background(providerTint(chatSummary?.provider).opacity(0.12), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        VStack(alignment: .leading, spacing: 6) {
          Text(chatSummary?.title ?? session.title)
            .font(.headline)
            .foregroundStyle(ADEColor.textPrimary)
          HStack(spacing: 8) {
            WorkTag(text: sessionStatusLabel(session), icon: session.status == "running" ? "waveform.path.ecg" : "clock", tint: session.status == "running" ? ADEColor.success : ADEColor.textSecondary)
            if let chatSummary {
              WorkTag(text: providerLabel(chatSummary.provider), icon: providerIcon(chatSummary.provider), tint: providerTint(chatSummary.provider))
              WorkTag(text: chatSummary.model, icon: "cpu", tint: ADEColor.textSecondary)
            }
            WorkTag(text: session.laneName, icon: "arrow.triangle.branch", tint: ADEColor.textSecondary)
          }
        }
        Spacer()
      }

      HStack(spacing: 12) {
        metric(title: "Started", value: relativeTimestamp(session.startedAt))
        metric(title: "Duration", value: formattedSessionDuration(startedAt: session.startedAt, endedAt: session.endedAt))
        if let preview = chatSummary?.summary ?? session.summary, !preview.isEmpty {
          metric(title: "Summary", value: preview)
        }
      }
    }
    .adeGlassCard(cornerRadius: 18, padding: 14)
  }

  private func metric(title: String, value: String) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(title)
        .font(.caption2.weight(.semibold))
        .foregroundStyle(ADEColor.textMuted)
      Text(value)
        .font(.caption)
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(2)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

private struct WorkChatMessageBubble: View {
  let message: WorkChatMessage

  var body: some View {
    HStack {
      if message.role == "assistant" {
        bubbleContent
        Spacer(minLength: 32)
      } else {
        Spacer(minLength: 32)
        bubbleContent
      }
    }
  }

  private var bubbleContent: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 8) {
        Image(systemName: message.role == "assistant" ? "sparkles" : "person.fill")
          .font(.caption.weight(.semibold))
          .foregroundStyle(message.role == "assistant" ? ADEColor.accent : ADEColor.warning)
        Text(message.role == "assistant" ? "Assistant" : "You")
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.textSecondary)
        Spacer(minLength: 8)
        Text(relativeTimestamp(message.timestamp))
          .font(.caption2)
          .foregroundStyle(ADEColor.textMuted)
      }

      WorkMarkdownRenderer(markdown: message.markdown)
    }
    .padding(14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(
      RoundedRectangle(cornerRadius: 18, style: .continuous)
        .fill(message.role == "assistant" ? ADEColor.accent.opacity(0.08) : ADEColor.surfaceBackground.opacity(0.7))
    )
    .contextMenu {
      Button("Copy") {
        UIPasteboard.general.string = message.markdown
      }
    }
  }
}

private struct WorkToolCardView: View {
  let toolCard: WorkToolCardModel
  let isExpanded: Bool
  let onToggle: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Button(action: onToggle) {
        HStack(spacing: 10) {
          Image(systemName: "hammer.fill")
            .foregroundStyle(statusTint)
          VStack(alignment: .leading, spacing: 4) {
            Text(toolDisplayName(toolCard.toolName))
              .font(.subheadline.weight(.semibold))
              .foregroundStyle(ADEColor.textPrimary)
            HStack(spacing: 8) {
              WorkTag(text: toolCard.status.rawValue.capitalized, icon: statusIcon, tint: statusTint)
              Text(formattedSessionDuration(startedAt: toolCard.startedAt, endedAt: toolCard.completedAt))
                .font(.caption2.monospacedDigit())
                .foregroundStyle(ADEColor.textMuted)
            }
          }
          Spacer()
          Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
            .font(.caption.weight(.semibold))
            .foregroundStyle(ADEColor.textMuted)
        }
      }
      .buttonStyle(.plain)

      if isExpanded {
        VStack(alignment: .leading, spacing: 10) {
          if let argsText = toolCard.argsText, !argsText.isEmpty {
            WorkStructuredOutputBlock(title: "Arguments", text: argsText)
          }
          if let resultText = toolCard.resultText, !resultText.isEmpty {
            WorkStructuredOutputBlock(title: "Result", text: resultText)
          }
        }
      }
    }
    .padding(14)
    .background(ADEColor.surfaceBackground.opacity(0.7), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
  }

  private var statusTint: Color {
    switch toolCard.status {
    case .running: return ADEColor.warning
    case .completed: return ADEColor.success
    case .failed: return ADEColor.danger
    }
  }

  private var statusIcon: String {
    switch toolCard.status {
    case .running: return "ellipsis.circle"
    case .completed: return "checkmark.circle.fill"
    case .failed: return "xmark.circle.fill"
    }
  }
}

private struct WorkStructuredOutputBlock: View {
  let title: String
  let text: String

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(title)
        .font(.caption2.weight(.semibold))
        .foregroundStyle(ADEColor.textMuted)
      ScrollView {
        Text(text)
          .frame(maxWidth: .infinity, alignment: .leading)
          .font(.system(.caption, design: .monospaced))
          .foregroundStyle(ADEColor.textPrimary)
          .textSelection(.enabled)
      }
      .frame(maxHeight: 180)
      .padding(10)
      .background(ADEColor.recessedBackground.opacity(0.9), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
  }
}

private struct WorkArtifactView: View {
  let artifact: ComputerUseArtifactSummary
  let content: WorkLoadedArtifactContent?
  let onAppear: () -> Void
  let onOpenImage: (UIImage) -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 10) {
        Image(systemName: artifact.artifactKind == "video_recording" ? "video.fill" : "photo.fill")
          .foregroundStyle(ADEColor.accent)
        VStack(alignment: .leading, spacing: 3) {
          Text(artifact.title)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
          Text(artifact.artifactKind.replacingOccurrences(of: "_", with: " ").capitalized)
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
        }
        Spacer()
        Text(relativeTimestamp(artifact.createdAt))
          .font(.caption2)
          .foregroundStyle(ADEColor.textMuted)
      }

      Group {
        switch content {
        case .image(let image):
          Button {
            onOpenImage(image)
          } label: {
            Image(uiImage: image)
              .resizable()
              .scaledToFill()
              .frame(maxWidth: .infinity)
              .frame(height: 180)
              .clipped()
              .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
          }
          .buttonStyle(.plain)
        case .video(let url):
          VideoPlayer(player: AVPlayer(url: url))
            .frame(height: 220)
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        case .remoteURL(let url):
          if artifact.artifactKind == "video_recording" {
            VideoPlayer(player: AVPlayer(url: url))
              .frame(height: 220)
              .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
          } else {
            AsyncImage(url: url) { image in
              image
                .resizable()
                .scaledToFill()
            } placeholder: {
              ProgressView()
            }
            .frame(height: 180)
            .frame(maxWidth: .infinity)
            .clipped()
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
          }
        case .text(let text):
          WorkStructuredOutputBlock(title: "Artifact", text: text)
        case .error(let message):
          Text(message)
            .font(.caption)
            .foregroundStyle(ADEColor.danger)
        case .none:
          HStack(spacing: 10) {
            ProgressView()
            Text("Loading artifact preview…")
              .font(.caption)
              .foregroundStyle(ADEColor.textSecondary)
          }
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(12)
          .background(ADEColor.surfaceBackground.opacity(0.55), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
      }
    }
    .padding(14)
    .background(ADEColor.surfaceBackground.opacity(0.7), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    .task {
      onAppear()
    }
  }
}

private struct WorkTerminalSessionView: View {
  @EnvironmentObject private var syncService: SyncService
  let session: TerminalSessionSummary
  let disconnectedNotice: Bool

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 14) {
        WorkSessionHeader(session: session, chatSummary: nil)

        if disconnectedNotice {
          ADENoticeCard(
            title: "Showing cached terminal output",
            message: "Reconnect to resume live ANSI rendering for this session.",
            icon: "wifi.slash",
            tint: ADEColor.warning,
            actionTitle: nil,
            action: nil
          )
        }

        Text(ansiAttributedString(syncService.terminalBuffers[session.id] ?? session.lastOutputPreview ?? "No output yet."))
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(14)
          .background(ADEColor.surfaceBackground.opacity(0.7), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
          .textSelection(.enabled)
      }
      .padding(16)
    }
    .adeScreenBackground()
    .adeNavigationGlass()
    .task {
      try? await syncService.subscribeTerminal(sessionId: session.id)
    }
  }
}

private struct WorkFullscreenImageView: View {
  @Environment(\.dismiss) private var dismiss
  let image: WorkFullscreenImage

  @State private var scale: CGFloat = 1
  @State private var lastScale: CGFloat = 1

  var body: some View {
    NavigationStack {
      ScrollView([.horizontal, .vertical]) {
        Image(uiImage: image.image)
          .resizable()
          .scaledToFit()
          .scaleEffect(scale)
          .frame(maxWidth: .infinity, maxHeight: .infinity)
          .padding(24)
          .gesture(
            MagnifyGesture()
              .onChanged { value in
                scale = max(1, min(6, lastScale * value.magnification))
              }
              .onEnded { _ in
                lastScale = scale
              }
          )
      }
      .background(Color.black.ignoresSafeArea())
      .navigationTitle(image.title)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Done") { dismiss() }
        }
      }
    }
  }
}

private struct WorkInlineMarkdownText: View {
  let text: String

  var body: some View {
    Text(markdownAttributedString(text))
      .foregroundStyle(ADEColor.textPrimary)
      .tint(ADEColor.accent)
      .frame(maxWidth: .infinity, alignment: .leading)
  }
}

private struct WorkMarkdownRenderer: View {
  let markdown: String

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      ForEach(parseMarkdownBlocks(markdown)) { block in
        switch block.kind {
        case .paragraph(let text):
          WorkInlineMarkdownText(text: text)
        case .heading(let level, let text):
          WorkInlineMarkdownText(text: text)
            .font(headingFont(level: level))
        case .unorderedList(let items):
          VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
              HStack(alignment: .top, spacing: 8) {
                Text("•")
                  .foregroundStyle(ADEColor.accent)
                WorkInlineMarkdownText(text: item)
              }
            }
          }
        case .orderedList(let items):
          VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(items.enumerated()), id: \.offset) { index, item in
              HStack(alignment: .top, spacing: 8) {
                Text("\(index + 1).")
                  .foregroundStyle(ADEColor.accent)
                WorkInlineMarkdownText(text: item)
              }
            }
          }
        case .blockquote(let lines):
          HStack(alignment: .top, spacing: 10) {
            Rectangle()
              .fill(ADEColor.accent.opacity(0.55))
              .frame(width: 3)
            VStack(alignment: .leading, spacing: 4) {
              ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                WorkInlineMarkdownText(text: line)
              }
            }
          }
          .padding(10)
          .background(ADEColor.surfaceBackground.opacity(0.45), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        case .table(let headers, let rows):
          WorkMarkdownTable(headers: headers, rows: rows)
        case .code(let language, let code):
          WorkCodeBlockView(language: language, code: code)
        case .rule:
          Divider()
        }
      }
    }
  }

  private func headingFont(level: Int) -> Font {
    switch level {
    case 1: return .title3.weight(.bold)
    case 2: return .headline.weight(.bold)
    default: return .subheadline.weight(.bold)
    }
  }
}

private struct WorkMarkdownTable: View {
  let headers: [String]
  let rows: [[String]]

  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      VStack(spacing: 0) {
        HStack(spacing: 0) {
          ForEach(headers.indices, id: \.self) { index in
            WorkInlineMarkdownText(text: headers[index])
              .font(.caption.weight(.semibold))
              .padding(10)
              .frame(minWidth: 120, alignment: .leading)
              .background(ADEColor.surfaceBackground.opacity(0.7))
          }
        }
        ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
          Divider()
          HStack(spacing: 0) {
            ForEach(row.indices, id: \.self) { index in
              WorkInlineMarkdownText(text: row[index])
                .font(.caption)
                .padding(10)
                .frame(minWidth: 120, alignment: .leading)
            }
          }
        }
      }
      .background(ADEColor.surfaceBackground.opacity(0.45), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
  }
}

private struct WorkCodeBlockView: View {
  let language: String?
  let code: String

  private var detectedLanguage: FilesLanguage {
    FilesLanguage.detect(languageId: language, filePath: "snippet.\(language ?? "txt")")
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 8) {
        Text((language?.isEmpty == false ? language : detectedLanguage.displayName).map { $0.uppercased() } ?? detectedLanguage.displayName.uppercased())
          .font(.caption2.weight(.semibold))
          .foregroundStyle(ADEColor.textMuted)
        Spacer()
        Button("Copy") {
          UIPasteboard.general.string = code
        }
        .font(.caption2.weight(.semibold))
      }
      ScrollView(.horizontal, showsIndicators: false) {
        Text(SyntaxHighlighter.highlightedAttributedString(code, as: detectedLanguage))
          .frame(maxWidth: .infinity, alignment: .leading)
          .textSelection(.enabled)
      }
      .padding(12)
      .background(ADEColor.recessedBackground.opacity(0.9), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
    .padding(12)
    .background(ADEColor.surfaceBackground.opacity(0.65), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
  }
}

struct WorkAgentActivityContext: Equatable {
  let sessionId: String
  let title: String
  let laneName: String
  let status: String
  let startedAt: String
}

struct WorkAgentActivity: Identifiable, Equatable {
  var id: String { "\(sessionId):\(taskId ?? "session")" }
  let sessionId: String
  let taskId: String?
  let agentName: String
  let toolName: String?
  let laneName: String
  let startedAt: String
  let detail: String?
}

enum WorkToolCardStatus: String, Equatable {
  case running
  case completed
  case failed
}

struct WorkToolCardModel: Identifiable, Equatable {
  let id: String
  let toolName: String
  let status: WorkToolCardStatus
  let startedAt: String
  let completedAt: String?
  let argsText: String?
  let resultText: String?
}

struct WorkChatMessage: Identifiable, Equatable {
  let id: String
  let role: String
  var markdown: String
  let timestamp: String
  let turnId: String?
  let itemId: String?
}

struct WorkLocalEchoMessage: Identifiable, Equatable {
  let id = UUID().uuidString
  let text: String
  let timestamp: String
}

enum WorkTimelinePayload {
  case message(WorkChatMessage)
  case toolCard(WorkToolCardModel)
  case artifact(ComputerUseArtifactSummary)
}

struct WorkTimelineEntry: Identifiable {
  let id: String
  let timestamp: String
  let rank: Int
  let payload: WorkTimelinePayload
}

enum WorkANSIColor: Equatable {
  case red
  case green
  case yellow
  case blue
  case magenta
  case cyan
  case white
  case black
}

struct ANSISegment: Equatable {
  let text: String
  let foreground: WorkANSIColor?
  let bold: Bool
}

struct WorkFullscreenImage: Identifiable {
  let id = UUID().uuidString
  let title: String
  let image: UIImage
}

enum WorkLoadedArtifactContent {
  case image(UIImage)
  case video(URL)
  case remoteURL(URL)
  case text(String)
  case error(String)
}

struct WorkChatEnvelope: Identifiable, Equatable {
  var id: String { "\(sessionId):\(sequence ?? -1):\(timestamp):\(event.typeKey)" }
  let sessionId: String
  let timestamp: String
  let sequence: Int?
  let event: WorkChatEvent
}

enum WorkChatEvent: Equatable {
  case userMessage(text: String, turnId: String?)
  case assistantText(text: String, turnId: String?, itemId: String?)
  case toolCall(tool: String, argsText: String, itemId: String, parentItemId: String?, turnId: String?)
  case toolResult(tool: String, resultText: String, itemId: String, parentItemId: String?, turnId: String?, status: WorkToolCardStatus)
  case activity(kind: String, detail: String?, turnId: String?)
  case subagentStarted(taskId: String, description: String, background: Bool, turnId: String?)
  case subagentProgress(taskId: String, description: String?, summary: String, toolName: String?, turnId: String?)
  case subagentResult(taskId: String, status: String, summary: String, turnId: String?)
  case status(turnStatus: String, message: String?, turnId: String?)
  case reasoning(text: String, turnId: String?)
  case completionReport(summary: String, status: String, turnId: String?)
  case command(command: String, output: String, status: WorkToolCardStatus, itemId: String, turnId: String?)
  case fileChange(path: String, diff: String, kind: String, status: WorkToolCardStatus, itemId: String, turnId: String?)
  case unknown(type: String)

  var typeKey: String {
    switch self {
    case .userMessage: return "user_message"
    case .assistantText: return "text"
    case .toolCall: return "tool_call"
    case .toolResult: return "tool_result"
    case .activity: return "activity"
    case .subagentStarted: return "subagent_started"
    case .subagentProgress: return "subagent_progress"
    case .subagentResult: return "subagent_result"
    case .status: return "status"
    case .reasoning: return "reasoning"
    case .completionReport: return "completion_report"
    case .command: return "command"
    case .fileChange: return "file_change"
    case .unknown(let type): return type
    }
  }
}

func parseWorkChatTranscript(_ raw: String) -> [WorkChatEnvelope] {
  extractLooseJSONObjects(from: raw)
    .compactMap { chunk -> WorkChatEnvelope? in
      let normalizedChunk = sanitizeLooseJSONControlCharacters(in: chunk)
      guard let data = normalizedChunk.data(using: .utf8),
            let envelope = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
            let sessionId = envelope["sessionId"] as? String,
            let timestamp = envelope["timestamp"] as? String,
            let eventDict = envelope["event"] as? [String: Any],
            let type = eventDict["type"] as? String
      else {
        return nil
      }

      let sequence = envelope["sequence"] as? Int
      let turnId = eventDict["turnId"] as? String
      let itemId = eventDict["itemId"] as? String
      let parentItemId = eventDict["parentItemId"] as? String
      let event: WorkChatEvent

      switch type {
      case "user_message":
        event = .userMessage(text: stringValue(eventDict["text"]), turnId: turnId)
      case "text":
        event = .assistantText(text: stringValue(eventDict["text"]), turnId: turnId, itemId: itemId)
      case "tool_call":
        event = .toolCall(
          tool: stringValue(eventDict["tool"]),
          argsText: prettyPrintedJSONString(eventDict["args"]),
          itemId: itemId ?? UUID().uuidString,
          parentItemId: parentItemId,
          turnId: turnId
        )
      case "tool_result":
        event = .toolResult(
          tool: stringValue(eventDict["tool"]),
          resultText: prettyPrintedJSONString(eventDict["result"]),
          itemId: itemId ?? UUID().uuidString,
          parentItemId: parentItemId,
          turnId: turnId,
          status: toolStatus(from: stringValue(eventDict["status"]))
        )
      case "activity":
        event = .activity(kind: stringValue(eventDict["activity"]), detail: optionalString(eventDict["detail"]), turnId: turnId)
      case "subagent_started":
        event = .subagentStarted(
          taskId: stringValue(eventDict["taskId"]),
          description: stringValue(eventDict["description"]),
          background: (eventDict["background"] as? Bool) ?? false,
          turnId: turnId
        )
      case "subagent_progress":
        event = .subagentProgress(
          taskId: stringValue(eventDict["taskId"]),
          description: optionalString(eventDict["description"]),
          summary: stringValue(eventDict["summary"]),
          toolName: optionalString(eventDict["lastToolName"]),
          turnId: turnId
        )
      case "subagent_result":
        event = .subagentResult(
          taskId: stringValue(eventDict["taskId"]),
          status: stringValue(eventDict["status"]),
          summary: stringValue(eventDict["summary"]),
          turnId: turnId
        )
      case "status":
        event = .status(turnStatus: stringValue(eventDict["turnStatus"]), message: optionalString(eventDict["message"]), turnId: turnId)
      case "reasoning":
        event = .reasoning(text: stringValue(eventDict["text"]), turnId: turnId)
      case "completion_report":
        let report = eventDict["report"] as? [String: Any] ?? [:]
        event = .completionReport(summary: stringValue(report["summary"]), status: stringValue(report["status"]), turnId: turnId)
      case "command":
        event = .command(
          command: stringValue(eventDict["command"]),
          output: stringValue(eventDict["output"]),
          status: toolStatus(from: stringValue(eventDict["status"])),
          itemId: itemId ?? UUID().uuidString,
          turnId: turnId
        )
      case "file_change":
        event = .fileChange(
          path: stringValue(eventDict["path"]),
          diff: stringValue(eventDict["diff"]),
          kind: stringValue(eventDict["kind"]),
          status: toolStatus(from: stringValue(eventDict["status"])),
          itemId: itemId ?? UUID().uuidString,
          turnId: turnId
        )
      default:
        event = .unknown(type: type)
      }

      return WorkChatEnvelope(sessionId: sessionId, timestamp: timestamp, sequence: sequence, event: event)
    }
    .sorted { lhs, rhs in
      if lhs.timestamp == rhs.timestamp {
        return (lhs.sequence ?? 0) < (rhs.sequence ?? 0)
      }
      return lhs.timestamp < rhs.timestamp
    }
}

private func extractLooseJSONObjects(from raw: String) -> [String] {
  var objects: [String] = []
  var buffer = ""
  var depth = 0
  var insideString = false
  var escaping = false

  for character in raw {
    if depth == 0 {
      guard character == "{" else { continue }
      depth = 1
      buffer = "{" 
      insideString = false
      escaping = false
      continue
    }

    buffer.append(character)

    if insideString {
      if escaping {
        escaping = false
      } else if character == "\\" {
        escaping = true
      } else if character == "\"" {
        insideString = false
      }
      continue
    }

    if character == "\"" {
      insideString = true
    } else if character == "{" {
      depth += 1
    } else if character == "}" {
      depth -= 1
      if depth == 0 {
        objects.append(buffer)
        buffer = ""
      }
    }
  }

  return objects
}

private func sanitizeLooseJSONControlCharacters(in raw: String) -> String {
  var sanitized = ""
  var insideString = false
  var escaping = false

  for character in raw {
    if insideString {
      if escaping {
        sanitized.append(character)
        escaping = false
        continue
      }

      switch character {
      case "\\":
        sanitized.append(character)
        escaping = true
      case "\"":
        sanitized.append(character)
        insideString = false
      case "\n":
        sanitized.append("\\n")
      case "\r":
        sanitized.append("\\r")
      case "\t":
        sanitized.append("\\t")
      default:
        sanitized.append(character)
      }
      continue
    }

    sanitized.append(character)
    if character == "\"" {
      insideString = true
    }
  }

  return sanitized
}

func buildWorkToolCards(from transcript: [WorkChatEnvelope]) -> [WorkToolCardModel] {
  var cards: [String: WorkToolCardModel] = [:]
  var orderedIds: [String] = []

  for envelope in transcript {
    switch envelope.event {
    case .toolCall(let tool, let argsText, let itemId, _, _):
      if cards[itemId] == nil {
        orderedIds.append(itemId)
      }
      cards[itemId] = WorkToolCardModel(
        id: itemId,
        toolName: tool,
        status: .running,
        startedAt: envelope.timestamp,
        completedAt: nil,
        argsText: argsText,
        resultText: cards[itemId]?.resultText
      )
    case .toolResult(let tool, let resultText, let itemId, _, _, let status):
      let existing = cards[itemId]
      if existing == nil {
        orderedIds.append(itemId)
      }
      cards[itemId] = WorkToolCardModel(
        id: itemId,
        toolName: existing?.toolName ?? tool,
        status: status,
        startedAt: existing?.startedAt ?? envelope.timestamp,
        completedAt: envelope.timestamp,
        argsText: existing?.argsText,
        resultText: resultText
      )
    default:
      continue
    }
  }

  return orderedIds.compactMap { cards[$0] }
}

func deriveWorkAgentActivities(from transcript: [WorkChatEnvelope], session: WorkAgentActivityContext) -> [WorkAgentActivity] {
  var activeSubagents: [String: WorkAgentActivity] = [:]
  let toolCards = buildWorkToolCards(from: transcript)
  let runningTool = toolCards.last(where: { $0.status == .running })

  for envelope in transcript {
    switch envelope.event {
    case .subagentStarted(let taskId, let description, _, _):
      activeSubagents[taskId] = WorkAgentActivity(
        sessionId: session.sessionId,
        taskId: taskId,
        agentName: description.isEmpty ? session.title : description,
        toolName: nil,
        laneName: session.laneName,
        startedAt: envelope.timestamp,
        detail: nil
      )
    case .subagentProgress(let taskId, let description, let summary, let toolName, _):
      let existing = activeSubagents[taskId]
      activeSubagents[taskId] = WorkAgentActivity(
        sessionId: session.sessionId,
        taskId: taskId,
        agentName: description ?? existing?.agentName ?? session.title,
        toolName: toolName ?? existing?.toolName,
        laneName: session.laneName,
        startedAt: existing?.startedAt ?? envelope.timestamp,
        detail: summary
      )
    case .subagentResult(let taskId, _, _, _):
      activeSubagents.removeValue(forKey: taskId)
    default:
      continue
    }
  }

  let subagents = activeSubagents.values.sorted { $0.startedAt > $1.startedAt }
  if !subagents.isEmpty {
    return subagents
  }

  guard session.status == "running" else { return [] }
  let latestActivityDetail = transcript.reversed().compactMap { envelope -> String? in
    switch envelope.event {
    case .activity(_, let detail, _): return detail
    case .reasoning(let text, _): return text
    case .status(_, let message, _): return message
    default: return nil
    }
  }.first

  return [WorkAgentActivity(
    sessionId: session.sessionId,
    taskId: nil,
    agentName: session.title,
    toolName: runningTool?.toolName,
    laneName: session.laneName,
    startedAt: runningTool?.startedAt ?? session.startedAt,
    detail: latestActivityDetail
  )]
}

func parseANSISegments(_ input: String) -> [ANSISegment] {
  var segments: [ANSISegment] = []
  var buffer = ""
  var foreground: WorkANSIColor?
  var bold = false
  var index = input.startIndex

  func flush() {
    guard !buffer.isEmpty else { return }
    segments.append(ANSISegment(text: buffer, foreground: foreground, bold: bold))
    buffer = ""
  }

  while index < input.endIndex {
    let character = input[index]
    if character == "\u{001B}" {
      let next = input.index(after: index)
      guard next < input.endIndex, input[next] == "[" else {
        buffer.append(character)
        index = input.index(after: index)
        continue
      }
      guard let commandIndex = input[next...].firstIndex(of: "m") else {
        break
      }
      flush()
      let codeString = String(input[input.index(after: next)..<commandIndex])
      let codes = codeString.split(separator: ";").compactMap { Int($0) }
      if codes.isEmpty {
        foreground = nil
        bold = false
      }
      for code in codes {
        switch code {
        case 0:
          foreground = nil
          bold = false
        case 1:
          bold = true
        case 30, 90:
          foreground = .black
        case 31, 91:
          foreground = .red
        case 32, 92:
          foreground = .green
        case 33, 93:
          foreground = .yellow
        case 34, 94:
          foreground = .blue
        case 35, 95:
          foreground = .magenta
        case 36, 96:
          foreground = .cyan
        case 37, 97:
          foreground = .white
        case 39:
          foreground = nil
        case 22:
          bold = false
        default:
          continue
        }
      }
      index = input.index(after: commandIndex)
      continue
    }
    buffer.append(character)
    index = input.index(after: index)
  }

  flush()
  return segments
}

private enum WorkMarkdownBlockKind {
  case paragraph(String)
  case heading(Int, String)
  case unorderedList([String])
  case orderedList([String])
  case blockquote([String])
  case table(headers: [String], rows: [[String]])
  case code(language: String?, code: String)
  case rule
}

private struct WorkMarkdownBlock: Identifiable {
  let id = UUID().uuidString
  let kind: WorkMarkdownBlockKind
}

private func parseMarkdownBlocks(_ markdown: String) -> [WorkMarkdownBlock] {
  let lines = markdown.replacingOccurrences(of: "\r\n", with: "\n").split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
  var index = 0
  var blocks: [WorkMarkdownBlock] = []

  func appendParagraph(_ lines: [String]) {
    let text = lines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    if !text.isEmpty {
      blocks.append(WorkMarkdownBlock(kind: .paragraph(text)))
    }
  }

  while index < lines.count {
    let line = lines[index]
    let trimmed = line.trimmingCharacters(in: .whitespaces)

    if trimmed.isEmpty {
      index += 1
      continue
    }

    if trimmed.hasPrefix("```") {
      let language = String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespacesAndNewlines)
      index += 1
      var codeLines: [String] = []
      while index < lines.count, !lines[index].trimmingCharacters(in: .whitespaces).hasPrefix("```") {
        codeLines.append(lines[index])
        index += 1
      }
      if index < lines.count { index += 1 }
      blocks.append(WorkMarkdownBlock(kind: .code(language: language.isEmpty ? nil : language, code: codeLines.joined(separator: "\n"))))
      continue
    }

    if let heading = trimmed.firstIndex(where: { $0 != "#" }), heading > trimmed.startIndex, trimmed[..<heading].allSatisfy({ $0 == "#" }) {
      let level = trimmed[..<heading].count
      let text = trimmed[heading...].trimmingCharacters(in: .whitespaces)
      blocks.append(WorkMarkdownBlock(kind: .heading(level, text)))
      index += 1
      continue
    }

    if ["---", "***", "___"].contains(trimmed) {
      blocks.append(WorkMarkdownBlock(kind: .rule))
      index += 1
      continue
    }

    if trimmed.hasPrefix(">") {
      var quoteLines: [String] = []
      while index < lines.count {
        let value = lines[index].trimmingCharacters(in: .whitespaces)
        guard value.hasPrefix(">") else { break }
        quoteLines.append(String(value.dropFirst()).trimmingCharacters(in: .whitespaces))
        index += 1
      }
      blocks.append(WorkMarkdownBlock(kind: .blockquote(quoteLines)))
      continue
    }

    if isMarkdownTableHeader(lines: lines, index: index) {
      let headers = splitMarkdownTableRow(lines[index])
      index += 2
      var rows: [[String]] = []
      while index < lines.count, lines[index].contains("|") {
        rows.append(splitMarkdownTableRow(lines[index]))
        index += 1
      }
      blocks.append(WorkMarkdownBlock(kind: .table(headers: headers, rows: rows)))
      continue
    }

    if let unordered = parseList(startingAt: index, in: lines, ordered: false) {
      blocks.append(WorkMarkdownBlock(kind: .unorderedList(unordered.items)))
      index = unordered.nextIndex
      continue
    }

    if let ordered = parseList(startingAt: index, in: lines, ordered: true) {
      blocks.append(WorkMarkdownBlock(kind: .orderedList(ordered.items)))
      index = ordered.nextIndex
      continue
    }

    var paragraphLines: [String] = []
    while index < lines.count {
      let value = lines[index].trimmingCharacters(in: .whitespaces)
      if value.isEmpty || value.hasPrefix("```") || value.hasPrefix(">") || isMarkdownTableHeader(lines: lines, index: index) || parseList(startingAt: index, in: lines, ordered: false) != nil || parseList(startingAt: index, in: lines, ordered: true) != nil || ["---", "***", "___"].contains(value) {
        break
      }
      if value.hasPrefix("#") { break }
      paragraphLines.append(lines[index])
      index += 1
    }
    appendParagraph(paragraphLines)
  }

  return blocks
}

private func parseList(startingAt index: Int, in lines: [String], ordered: Bool) -> (items: [String], nextIndex: Int)? {
  guard index < lines.count else { return nil }
  let pattern = ordered ? #"^\d+\.\s+"# : #"^[-*+]\s+"#
  guard let regex = try? NSRegularExpression(pattern: pattern) else { return nil }
  var cursor = index
  var items: [String] = []
  while cursor < lines.count {
    let line = lines[cursor].trimmingCharacters(in: .whitespaces)
    let range = NSRange(location: 0, length: (line as NSString).length)
    guard let match = regex.firstMatch(in: line, options: [], range: range) else { break }
    let item = (line as NSString).substring(from: match.range.length)
    items.append(item)
    cursor += 1
  }
  return items.isEmpty ? nil : (items, cursor)
}

private func isMarkdownTableHeader(lines: [String], index: Int) -> Bool {
  guard index + 1 < lines.count else { return false }
  let header = lines[index]
  let separator = lines[index + 1].trimmingCharacters(in: .whitespaces)
  return header.contains("|") && separator.contains("|") && separator.replacingOccurrences(of: "|", with: "").allSatisfy { $0 == "-" || $0 == ":" || $0 == " " }
}

private func splitMarkdownTableRow(_ row: String) -> [String] {
  row
    .split(separator: "|", omittingEmptySubsequences: false)
    .map { $0.trimmingCharacters(in: .whitespaces) }
    .filter { !$0.isEmpty }
}

private func markdownAttributedString(_ text: String) -> AttributedString {
  if let attributed = try? AttributedString(markdown: text) {
    return attributed
  }
  return AttributedString(text)
}

private func buildWorkTimeline(
  transcript: [WorkChatEnvelope],
  fallbackEntries: [AgentChatTranscriptEntry],
  toolCards: [WorkToolCardModel],
  artifacts: [ComputerUseArtifactSummary],
  localEchoMessages: [WorkLocalEchoMessage]
) -> [WorkTimelineEntry] {
  let messages = transcript.isEmpty && !fallbackEntries.isEmpty
    ? fallbackEntries.map {
        WorkChatMessage(
          id: "fallback-\($0.id)",
          role: $0.role,
          markdown: $0.text,
          timestamp: $0.timestamp,
          turnId: $0.turnId,
          itemId: nil
        )
      }
    : buildWorkChatMessages(from: transcript)

  var entries: [WorkTimelineEntry] = messages.enumerated().map { index, message in
    WorkTimelineEntry(id: "message-\(message.id)", timestamp: message.timestamp, rank: index, payload: .message(message))
  }

  entries.append(contentsOf: toolCards.enumerated().map { index, card in
    WorkTimelineEntry(id: "tool-\(card.id)", timestamp: card.startedAt, rank: 1_000 + index, payload: .toolCard(card))
  })

  entries.append(contentsOf: artifacts.enumerated().map { index, artifact in
    WorkTimelineEntry(id: "artifact-\(artifact.id)", timestamp: artifact.createdAt, rank: 2_000 + index, payload: .artifact(artifact))
  })

  entries.append(contentsOf: localEchoMessages.enumerated().map { index, echo in
    let message = WorkChatMessage(id: echo.id, role: "user", markdown: echo.text, timestamp: echo.timestamp, turnId: nil, itemId: nil)
    return WorkTimelineEntry(id: "echo-\(echo.id)", timestamp: echo.timestamp, rank: 3_000 + index, payload: .message(message))
  })

  return entries.sorted { lhs, rhs in
    if lhs.timestamp == rhs.timestamp {
      return lhs.rank < rhs.rank
    }
    return lhs.timestamp < rhs.timestamp
  }
}

private func buildWorkChatMessages(from transcript: [WorkChatEnvelope]) -> [WorkChatMessage] {
  var messages: [WorkChatMessage] = []

  for envelope in transcript {
    switch envelope.event {
    case .userMessage(let text, let turnId):
      if let lastIndex = messages.indices.last,
         messages[lastIndex].role == "user",
         messages[lastIndex].turnId == turnId,
         messages[lastIndex].timestamp == envelope.timestamp {
        messages[lastIndex].markdown += text
      } else {
        messages.append(WorkChatMessage(id: envelope.id, role: "user", markdown: text, timestamp: envelope.timestamp, turnId: turnId, itemId: nil))
      }
    case .assistantText(let text, let turnId, let itemId):
      if let lastIndex = messages.indices.last,
         messages[lastIndex].role == "assistant",
         messages[lastIndex].turnId == turnId,
         messages[lastIndex].itemId == itemId {
        messages[lastIndex].markdown += text
      } else {
        messages.append(WorkChatMessage(id: envelope.id, role: "assistant", markdown: text, timestamp: envelope.timestamp, turnId: turnId, itemId: itemId))
      }
    default:
      continue
    }
  }

  return messages
}

private func makeWorkChatTranscript(from entries: [AgentChatTranscriptEntry], sessionId: String) -> [WorkChatEnvelope] {
  entries.map { entry in
    WorkChatEnvelope(
      sessionId: sessionId,
      timestamp: entry.timestamp,
      sequence: nil,
      event: entry.role == "assistant"
        ? .assistantText(text: entry.text, turnId: entry.turnId, itemId: nil)
        : .userMessage(text: entry.text, turnId: entry.turnId)
    )
  }
}

private func ansiAttributedString(_ text: String) -> AttributedString {
  var attributed = AttributedString("")
  for segment in parseANSISegments(text) {
    var piece = AttributedString(segment.text)
    piece.font = segment.bold ? .system(.footnote, design: .monospaced).bold() : .system(.footnote, design: .monospaced)
    piece.foregroundColor = ansiColor(segment.foreground)
    attributed.append(piece)
  }
  return attributed
}

private func ansiColor(_ color: WorkANSIColor?) -> Color {
  switch color {
  case .red: return .red
  case .green: return .green
  case .yellow: return .yellow
  case .blue: return .blue
  case .magenta: return .purple
  case .cyan: return .cyan
  case .white: return .white
  case .black: return .black
  case .none: return ADEColor.textPrimary
  }
}

private func toolStatus(from raw: String) -> WorkToolCardStatus {
  switch raw.lowercased() {
  case "failed": return .failed
  case "completed", "success", "succeeded": return .completed
  default: return .running
  }
}

private func prettyPrintedJSONString(_ value: Any?) -> String {
  guard let value else { return "" }
  if let string = value as? String {
    return string
  }
  if JSONSerialization.isValidJSONObject(value),
     let data = try? JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys]),
     let string = String(data: data, encoding: .utf8) {
    return string
  }
  return String(describing: value)
}

private func stringValue(_ value: Any?) -> String {
  if let string = value as? String {
    return string
  }
  if let number = value as? NSNumber {
    return number.stringValue
  }
  return ""
}

private func optionalString(_ value: Any?) -> String? {
  let text = stringValue(value).trimmingCharacters(in: .whitespacesAndNewlines)
  return text.isEmpty ? nil : text
}

private func isChatSession(_ session: TerminalSessionSummary) -> Bool {
  session.toolType?.contains("chat") == true
}

private func defaultWorkChatTitle(provider: String) -> String {
  provider.lowercased().contains("codex") ? "Codex chat" : "Claude chat"
}

private func toolTypeForProvider(_ provider: String) -> String {
  provider.lowercased().contains("codex") ? "codex-chat" : "claude-chat"
}

private func providerLabel(_ provider: String) -> String {
  switch provider.lowercased() {
  case "codex": return "Codex"
  case "claude": return "Claude"
  default: return provider.capitalized
  }
}

private func providerIcon(_ provider: String) -> String {
  provider.lowercased().contains("codex") ? "sparkle" : "brain.head.profile"
}

private func providerTint(_ provider: String?) -> Color {
  guard let provider else { return ADEColor.accent }
  return provider.lowercased().contains("codex") ? .blue : ADEColor.accent
}

private func sessionSymbol(_ session: TerminalSessionSummary, provider: String?) -> String {
  if isChatSession(session) {
    return providerIcon(provider ?? session.toolType ?? "")
  }
  return "terminal.fill"
}

private func sessionStatusLabel(_ session: TerminalSessionSummary) -> String {
  session.status == "running" ? "RUNNING" : "ENDED"
}

private func workParsedDate(_ value: String?) -> Date? {
  guard let value, !value.isEmpty else { return nil }
  return workDateFormatter.date(from: value)
}

private func formattedSessionDuration(startedAt: String, endedAt: String?) -> String {
  guard let start = workParsedDate(startedAt) else { return "—" }
  let end = workParsedDate(endedAt) ?? Date()
  let interval = max(0, Int(end.timeIntervalSince(start)))
  let hours = interval / 3600
  let minutes = (interval % 3600) / 60
  let seconds = interval % 60
  if hours > 0 {
    return String(format: "%dh %02dm", hours, minutes)
  }
  if minutes > 0 {
    return String(format: "%dm %02ds", minutes, seconds)
  }
  return "\(seconds)s"
}

private func relativeTimestamp(_ value: String) -> String {
  guard let date = workParsedDate(value) else { return value }
  return RelativeDateTimeFormatter().localizedString(for: date, relativeTo: Date())
}

private func toolDisplayName(_ tool: String) -> String {
  let trimmed = tool.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !trimmed.isEmpty else { return "Tool" }
  if trimmed.hasPrefix("functions.") {
    return String(trimmed.split(separator: ".").last ?? Substring(trimmed))
  }
  if trimmed.hasPrefix("mcp__") {
    return trimmed.replacingOccurrences(of: "mcp__", with: "").replacingOccurrences(of: "__", with: " · ")
  }
  return trimmed
}

private func fileExtension(for mimeType: String?, fallback: String) -> String {
  guard let mimeType else { return fallback }
  if mimeType.contains("png") { return "png" }
  if mimeType.contains("jpeg") || mimeType.contains("jpg") { return "jpg" }
  if mimeType.contains("gif") { return "gif" }
  if mimeType.contains("webp") { return "webp" }
  if mimeType.contains("mov") { return "mov" }
  if mimeType.contains("mp4") { return "mp4" }
  return fallback
}

private extension Font {
  func bold() -> Font {
    self.weight(.bold)
  }
}
