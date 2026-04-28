import SwiftUI

struct LaneAttachSheet: View {
  @Environment(\.dismiss) private var dismiss
  @EnvironmentObject private var syncService: SyncService

  let onComplete: @MainActor (String) async -> Void
  var wrapsInNavigationStack: Bool = true

  @State private var name = ""
  @State private var attachedPath = ""
  @State private var description = ""
  @State private var busy = false
  @State private var errorMessage: String?

  var body: some View {
    Group {
      if wrapsInNavigationStack {
        NavigationStack { content }
      } else {
        content
      }
    }
  }

  @ViewBuilder
  private var content: some View {
      ScrollView {
        VStack(spacing: 18) {
          GlassSection(title: "Attach worktree", subtitle: "Register an existing worktree as a lane.") {
            VStack(alignment: .leading, spacing: 12) {
              LaneTextField("Lane name", text: $name)
              LaneTextField("Worktree path", text: $attachedPath)
                .font(.system(.subheadline, design: .monospaced))
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
              LaneTextField("Description", text: $description)
            }
          }

          if let errorMessage {
            HStack(alignment: .top, spacing: 10) {
              Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(ADEColor.danger)
              Text(errorMessage)
                .font(.caption)
                .foregroundStyle(ADEColor.danger)
                .fixedSize(horizontal: false, vertical: true)
              Spacer(minLength: 0)
            }
            .adeGlassCard(cornerRadius: 12, padding: 12)
          }
        }
        .padding(16)
      }
      .adeScreenBackground()
      .adeNavigationGlass()
      .navigationTitle("Attach worktree")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }
            .disabled(busy)
        }
        ToolbarItem(placement: .confirmationAction) {
          Button("Attach") {
            Task { await submit() }
          }
          .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || attachedPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || busy)
        }
      }
  }

  @MainActor
  private func submit() async {
    do {
      busy = true
      errorMessage = nil
      let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
      let trimmedPath = attachedPath.trimmingCharacters(in: .whitespacesAndNewlines)
      let trimmedDescription = description.trimmingCharacters(in: .whitespacesAndNewlines)
      let lane = try await syncService.attachLane(name: trimmedName, attachedPath: trimmedPath, description: trimmedDescription)
      await onComplete(lane.id)
      dismiss()
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
    busy = false
  }
}
