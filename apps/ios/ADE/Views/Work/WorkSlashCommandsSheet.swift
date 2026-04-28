import SwiftUI

/// Minimal `/` slash-command picker. Desktop has a full registry; iOS v1 shows a small curated
/// list per provider so users can start a new chat with a recognizable opener. Tapping a row
/// returns `/command` to the composer via `onInsert`.
struct WorkSlashCommandsSheet: View {
  let provider: String
  let onInsert: (String) -> Void

  @Environment(\.dismiss) private var dismiss

  private struct Command: Identifiable {
    let id: String
    let title: String
    let description: String
  }

  private var commands: [Command] {
    switch provider.lowercased() {
    case "claude":
      return [
        Command(id: "/clear", title: "/clear", description: "Drop prior context and start fresh."),
        Command(id: "/compact", title: "/compact", description: "Summarize the transcript so far."),
        Command(id: "/plan", title: "/plan", description: "Ask the assistant to draft a plan."),
        Command(id: "/review", title: "/review", description: "Review the current diff."),
        Command(id: "/memory", title: "/memory", description: "Open Claude's memory surface."),
      ]
    case "codex":
      return [
        Command(id: "/explain", title: "/explain", description: "Explain a file or change."),
        Command(id: "/refactor", title: "/refactor", description: "Propose a refactor."),
        Command(id: "/tests", title: "/tests", description: "Write or run tests."),
        Command(id: "/review", title: "/review", description: "Review code or a diff."),
      ]
    case "opencode":
      return [
        Command(id: "/plan", title: "/plan", description: "Ask the model for a plan before acting."),
        Command(id: "/explain", title: "/explain", description: "Explain a file or change."),
        Command(id: "/review", title: "/review", description: "Review the current diff."),
      ]
    default:
      return [
        Command(id: "/help", title: "/help", description: "Show available commands."),
        Command(id: "/explain", title: "/explain", description: "Explain a file or change."),
      ]
    }
  }

  var body: some View {
    NavigationStack {
      List {
        Section("Commands") {
          ForEach(commands) { command in
            Button {
              onInsert(command.id)
            } label: {
              VStack(alignment: .leading, spacing: 3) {
                Text(command.title)
                  .font(.footnote.weight(.semibold).monospaced())
                  .foregroundStyle(ADEColor.textPrimary)
                Text(command.description)
                  .font(.caption)
                  .foregroundStyle(ADEColor.textSecondary)
              }
            }
            .buttonStyle(.plain)
          }
        }
      }
      .navigationTitle("Slash command")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          Button("Cancel") { dismiss() }
        }
      }
    }
    .presentationDetents([.medium, .large])
  }
}
