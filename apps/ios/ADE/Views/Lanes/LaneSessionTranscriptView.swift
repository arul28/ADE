import SwiftUI

// MARK: - Session transcript view

struct LaneSessionTranscriptView: View {
  @EnvironmentObject private var syncService: SyncService
  let session: TerminalSessionSummary

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 14) {
        GlassSection(title: session.title) {
          HStack(spacing: 8) {
            LaneTypeBadge(text: session.status.uppercased(), tint: session.status == "running" ? ADEColor.success : ADEColor.textSecondary)
            if let goal = session.goal, !goal.isEmpty {
              Text(goal)
                .font(.caption)
                .foregroundStyle(ADEColor.textSecondary)
                .lineLimit(1)
            }
          }
        }

        GlassSection(title: "Transcript") {
          Text(syncService.terminalBuffers[session.id] ?? session.lastOutputPreview ?? "No output yet.")
            .frame(maxWidth: .infinity, alignment: .leading)
            .font(.system(.caption, design: .monospaced))
            .foregroundStyle(ADEColor.textSecondary)
            .textSelection(.enabled)
            .adeInsetField(cornerRadius: 12, padding: 12)
        }
      }
      .padding(16)
    }
    .adeScreenBackground()
    .adeNavigationGlass()
    .navigationTitle(session.title)
    .navigationBarTitleDisplayMode(.inline)
    .task {
      try? await syncService.subscribeTerminal(sessionId: session.id)
    }
  }
}
