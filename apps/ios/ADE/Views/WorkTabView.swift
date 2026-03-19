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

  var body: some View {
    NavigationStack {
      List {
        if let notice = statusNotice {
          notice
            .listRowBackground(Color.clear)
        }

        if let errorMessage, workStatus.phase == .ready {
          ADENoticeCard(
            title: "Work view error",
            message: errorMessage,
            icon: "exclamationmark.triangle.fill",
            tint: ADEPalette.danger,
            actionTitle: "Retry",
            action: { Task { await reload(refreshRemote: true) } }
          )
          .listRowBackground(Color.clear)
        }

        if sessions.contains(where: { $0.status == "running" }) {
          Section("Activity") {
            ForEach(sessions.filter { $0.status == "running" }) { session in
              HStack {
                Image(systemName: "waveform.path.ecg")
                  .foregroundStyle(ADEPalette.warning)
                VStack(alignment: .leading) {
                  Text(session.title)
                  Text("\(session.laneName) · \(session.toolType ?? "session")")
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(ADEPalette.textSecondary)
                }
              }
            }
          }
        }

        if !sessions.isEmpty {
          Section("Sessions") {
            ForEach(sessions) { session in
              NavigationLink {
                TerminalSessionView(session: session)
              } label: {
                VStack(alignment: .leading, spacing: 4) {
                  HStack {
                    Text(session.title)
                      .font(.headline)
                    Spacer()
                    ADEStatusPill(
                      text: session.status.uppercased(),
                      tint: session.status == "running" ? ADEPalette.success : ADEPalette.textSecondary
                    )
                  }
                  Text(session.laneName)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(ADEPalette.textSecondary)
                  if let preview = session.lastOutputPreview {
                    Text(preview)
                      .font(.caption.monospaced())
                      .foregroundStyle(ADEPalette.textMuted)
                      .lineLimit(1)
                  }
                }
              }
            }
          }
        }
      }
      .scrollContentBackground(.hidden)
      .background(ADEPalette.pageBackground.ignoresSafeArea())
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
        tint: ADEPalette.warning,
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
        tint: ADEPalette.accent,
        actionTitle: nil,
        action: nil
      )
    case .failed:
      return ADENoticeCard(
        title: "Session hydration failed",
        message: workStatus.lastError ?? "The host session list did not hydrate cleanly.",
        icon: "exclamationmark.triangle.fill",
        tint: ADEPalette.danger,
        actionTitle: "Retry",
        action: { Task { await reload(refreshRemote: true) } }
      )
    case .ready:
      guard sessions.isEmpty else { return nil }
      return ADENoticeCard(
        title: "No work sessions yet",
        message: "Quick runs and tracked host sessions will appear here when the host has session history to show.",
        icon: "terminal",
        tint: ADEPalette.textSecondary,
        actionTitle: nil,
        action: nil
      )
    }
  }
}

private struct TerminalSessionView: View {
  @EnvironmentObject private var syncService: SyncService
  let session: TerminalSessionSummary

  var body: some View {
    ScrollView {
      Text(syncService.terminalBuffers[session.id] ?? session.lastOutputPreview ?? "No output yet.")
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
        .font(.system(.footnote, design: .monospaced))
    }
    .background(ADEPalette.pageBackground.ignoresSafeArea())
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
      Form {
        Picker("Lane", selection: $selectedLaneId) {
          ForEach(lanes) { lane in
            Text(lane.name).tag(lane.id)
          }
        }
        TextField("Title", text: $title)
        TextField("Command", text: $command)
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
      }
      .scrollContentBackground(.hidden)
      .background(ADEPalette.pageBackground.ignoresSafeArea())
      .navigationTitle("Quick run")
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }
        }
        ToolbarItem(placement: .confirmationAction) {
          Button("Run") {
            onRun(selectedLaneId.isEmpty ? (lanes.first?.id ?? "") : selectedLaneId, title, command)
          }
          .disabled(command.isEmpty || (selectedLaneId.isEmpty && lanes.isEmpty))
        }
      }
      .onAppear {
        selectedLaneId = selectedLaneId.isEmpty ? (lanes.first?.id ?? "") : selectedLaneId
      }
    }
  }
}
