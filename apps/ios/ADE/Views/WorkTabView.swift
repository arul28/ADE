import SwiftUI

struct WorkTabView: View {
  @EnvironmentObject private var syncService: SyncService
  @State private var sessions: [TerminalSessionSummary] = []
  @State private var lanes: [LaneSummary] = []
  @State private var errorMessage: String?
  @State private var quickRunPresented = false

  var body: some View {
    NavigationStack {
      List {
        if let errorMessage {
          Text(errorMessage).foregroundStyle(.red)
        }

        Section("Activity") {
          ForEach(sessions.filter { $0.status == "running" }) { session in
            HStack {
              Image(systemName: "waveform.path.ecg")
                .foregroundStyle(.orange)
              VStack(alignment: .leading) {
                Text(session.title)
                Text("\(session.laneName) · \(session.toolType ?? "session")")
                  .font(.caption)
                  .foregroundStyle(.secondary)
              }
            }
          }
        }

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
                  Text(session.status)
                    .font(.caption)
                    .foregroundStyle(session.status == "running" ? .green : .secondary)
                }
                Text(session.laneName)
                  .font(.caption)
                  .foregroundStyle(.secondary)
                if let preview = session.lastOutputPreview {
                  Text(preview)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                }
              }
            }
          }
        }
      }
      .navigationTitle("Work")
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button {
            quickRunPresented = true
          } label: {
            Image(systemName: "play.fill")
          }
        }
      }
      .task {
        await reload()
      }
      .task(id: syncService.localStateRevision) {
        await reload()
      }
      .refreshable {
        await reload()
      }
      .sheet(isPresented: $quickRunPresented) {
        QuickRunView(lanes: lanes) { laneId, title, command in
          Task {
            try? await syncService.runQuickCommand(laneId: laneId, title: title, startupCommand: command)
            quickRunPresented = false
            await reload()
          }
        }
      }
    }
  }

  @MainActor
  private func reload() async {
    do {
      async let sessionsTask = syncService.fetchSessions()
      async let lanesTask = syncService.fetchLanes()
      sessions = try await sessionsTask
      lanes = try await lanesTask
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
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
