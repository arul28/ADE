import SwiftUI

struct WorkTabView: View {
  @EnvironmentObject private var syncService: SyncService
  @State private var sessions: [TerminalSessionSummary] = []
  @State private var lanes: [LaneSummary] = []
  @State private var errorMessage: String?
  @State private var quickRunPresented = false

  private var workStatus: SyncDomainStatus {
    syncService.status(for: .work)
  }

  private var canRunQuickCommands: Bool {
    workStatus.phase == .ready && (syncService.connectionState == .connected || syncService.connectionState == .syncing) && !lanes.isEmpty
  }

  private var needsRepairing: Bool {
    syncService.activeHostProfile == nil && !sessions.isEmpty
  }

  private var isLoadingSkeleton: Bool {
    workStatus.phase == .hydrating || workStatus.phase == .syncingInitialData
  }

  private var runningSessions: [TerminalSessionSummary] {
    sessions.filter { $0.status == "running" }
  }

  var body: some View {
    NavigationStack {
      List {
        if let notice = statusNotice {
          notice
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
        }

        if isLoadingSkeleton {
          ForEach(0..<2, id: \.self) { _ in
            ADECardSkeleton(rows: 3)
              .listRowBackground(Color.clear)
              .listRowSeparator(.hidden)
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

        if workStatus.phase == .ready && sessions.isEmpty {
          ADEEmptyStateView(
            symbol: "terminal",
            title: "No work sessions yet",
            message: "Quick runs and tracked host sessions will appear here when the host has session history to show."
          ) {
            if canRunQuickCommands {
              Button("Start quick run") {
                quickRunPresented = true
              }
              .buttonStyle(.glassProminent)
              .tint(ADEColor.accent)
            }
          }
          .listRowBackground(Color.clear)
          .listRowSeparator(.hidden)
        }

        if !runningSessions.isEmpty {
          Section("Activity") {
            ForEach(runningSessions) { session in
              WorkActivityRow(session: session)
                .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
            }
          }
        }

        if !sessions.isEmpty {
          Section("Sessions") {
            ForEach(sessions) { session in
              NavigationLink {
                TerminalSessionView(session: session)
              } label: {
                WorkSessionRow(session: session)
              }
              .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                Button("Copy lane") {
                  UIPasteboard.general.string = session.laneName
                }
                .tint(ADEColor.accent)

                if session.status == "running" {
                  Button("Close", role: .destructive) {
                    Task {
                      try? await syncService.closeWorkSession(sessionId: session.id)
                      await reload(refreshRemote: true)
                    }
                  }
                }
              }
              .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
              .listRowBackground(Color.clear)
              .listRowSeparator(.hidden)
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
            quickRunPresented = true
          } label: {
            Image(systemName: "play.fill")
          }
          .disabled(!canRunQuickCommands)
        }
      }
      .sensoryFeedback(.success, trigger: sessions.count)
      .task {
        await reload()
      }
      .task(id: syncService.localStateRevision) {
        await reload()
      }
      .refreshable {
        await reload(refreshRemote: true)
      }
      .sheet(isPresented: $quickRunPresented) {
        QuickRunView(lanes: lanes) { laneId, title, command in
          Task {
            try? await syncService.runQuickCommand(laneId: laneId, title: title, startupCommand: command)
            try? await syncService.refreshWorkSessions()
            quickRunPresented = false
            await reload()
          }
        }
      }
    }
  }

  @MainActor
  private func reload(refreshRemote: Bool = false) async {
    do {
      if refreshRemote {
        try? await syncService.refreshWorkSessions()
      }
      async let sessionsTask = syncService.fetchSessions()
      async let lanesTask = syncService.fetchLanes()
      sessions = try await sessionsTask
      lanes = try await lanesTask
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  private var statusNotice: ADENoticeCard? {
    switch workStatus.phase {
    case .disconnected:
      return ADENoticeCard(
        title: sessions.isEmpty ? "Host disconnected" : "Showing cached sessions",
        message: sessions.isEmpty
          ? (syncService.activeHostProfile == nil
              ? "Pair with a host to hydrate host session history and active work."
              : "Reconnect to hydrate host session history and active work.")
          : (needsRepairing
              ? "Cached session history is still visible, but the previous host trust was cleared. Pair again before trusting active work state."
              : "Cached session history is available. Reconnect to refresh active host work and stream new output."),
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
        title: "Hydrating host sessions",
        message: "Pulling tracked terminal sessions from the host so Work reflects real session history.",
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
        title: "Session hydration failed",
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

private struct WorkActivityRow: View {
  let session: TerminalSessionSummary

  var body: some View {
    HStack(spacing: 12) {
      Image(systemName: "waveform.path.ecg")
        .foregroundStyle(ADEColor.warning)
        .symbolEffect(.variableColor.iterative, isActive: true)
      VStack(alignment: .leading, spacing: 3) {
        Text(session.title)
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
        Text("\(session.laneName) · \(session.toolType ?? "session")")
          .font(.system(.caption, design: .monospaced))
          .foregroundStyle(ADEColor.textSecondary)
      }
      Spacer()
      ProgressView()
        .controlSize(.mini)
    }
    .adeGlassCard(cornerRadius: 18, padding: 14)
    .accessibilityLabel("\(session.title), running on \(session.laneName)")
  }
}

private struct WorkSessionRow: View {
  let session: TerminalSessionSummary

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(alignment: .top, spacing: 8) {
        Text(session.title)
          .font(.headline)
          .foregroundStyle(ADEColor.textPrimary)
        Spacer(minLength: 8)
        ADEStatusPill(
          text: session.status.uppercased(),
          tint: session.status == "running" ? ADEColor.success : ADEColor.textSecondary
        )
      }
      Text(session.laneName)
        .font(.system(.caption, design: .monospaced))
        .foregroundStyle(ADEColor.textSecondary)
      if let preview = session.lastOutputPreview {
        Text(preview)
          .font(.caption.monospaced())
          .foregroundStyle(ADEColor.textMuted)
          .lineLimit(1)
      }
    }
    .adeGlassCard(cornerRadius: 18, padding: 14)
  }
}

private struct TerminalSessionView: View {
  @EnvironmentObject private var syncService: SyncService
  let session: TerminalSessionSummary

  var body: some View {
    ScrollView {
      Text(syncService.terminalBuffers[session.id] ?? session.lastOutputPreview ?? "No output yet.")
        .frame(maxWidth: .infinity, alignment: .leading)
        .font(.system(.footnote, design: .monospaced))
        .foregroundStyle(ADEColor.textPrimary)
        .adeGlassCard(cornerRadius: 18)
        .padding(16)
    }
    .adeScreenBackground()
    .adeNavigationGlass()
    .navigationTitle(session.title)
    .task {
      try? await syncService.subscribeTerminal(sessionId: session.id)
    }
  }
}

private struct QuickRunView: View {
  @Environment(\.dismiss) private var dismiss
  let lanes: [LaneSummary]
  let onRun: (String, String, String) -> Void

  @State private var selectedLaneId = ""
  @State private var title = "Run command"
  @State private var command = "npm test"

  var body: some View {
    NavigationStack {
      List {
        VStack(spacing: 10) {
          Picker("Lane", selection: $selectedLaneId) {
            ForEach(lanes) { lane in
              Text(lane.name).tag(lane.id)
            }
          }
          .pickerStyle(.menu)
          .adeInsetField()

          TextField("Title", text: $title)
            .adeInsetField()

          TextField("Command", text: $command)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .adeInsetField()
        }
        .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
      }
      .listStyle(.plain)
      .scrollContentBackground(.hidden)
      .adeScreenBackground()
      .adeNavigationGlass()
      .navigationTitle("Quick run")
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }
        }
        ToolbarItem(placement: .confirmationAction) {
          Button("Run") {
            onRun(selectedLaneId.isEmpty ? (lanes.first?.id ?? "") : selectedLaneId, title, command)
          }
          .buttonStyle(.glassProminent)
          .disabled(command.isEmpty || (selectedLaneId.isEmpty && lanes.isEmpty))
        }
      }
      .onAppear {
        selectedLaneId = selectedLaneId.isEmpty ? (lanes.first?.id ?? "") : selectedLaneId
      }
    }
  }
}
