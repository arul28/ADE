import SwiftUI

// MARK: - Session transcript view

struct LaneSessionTranscriptView: View {
  @EnvironmentObject private var syncService: SyncService
  let session: TerminalSessionSummary

  var terminalDisplay: WorkTerminalDisplay {
    workTerminalDisplay(raw: syncService.terminalBuffers[session.id], fallback: session.lastOutputPreview)
  }

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
          if terminalDisplay.truncated {
            Text("Showing recent output. Older terminal output is hidden on iPhone so this view stays responsive.")
              .font(.caption)
              .foregroundStyle(ADEColor.textSecondary)
          }

          Text(terminalDisplay.text)
            .frame(maxWidth: .infinity, alignment: .leading)
            .font(.system(.caption, design: .monospaced))
            .foregroundStyle(ADEColor.textSecondary)
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
