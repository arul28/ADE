import SwiftUI

// MARK: - Attach lane sheet

struct LaneAttachSheet: View {
  @Environment(\.dismiss) private var dismiss
  @EnvironmentObject private var syncService: SyncService

  let onComplete: @MainActor (String) async -> Void

  @State private var name = ""
  @State private var attachedPath = ""
  @State private var description = ""
  @State private var busy = false
  @State private var errorMessage: String?

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(spacing: 14) {
          GlassSection(title: "Attach worktree", subtitle: "Register an existing worktree as a lane.") {
            VStack(alignment: .leading, spacing: 12) {
              LaneTextField("Lane name", text: $name)
              LaneTextField("Worktree path", text: $attachedPath)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
              LaneTextField("Description", text: $description)
            }
          }

          if let errorMessage {
            HStack(spacing: 10) {
              Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(ADEColor.danger)
              Text(errorMessage)
                .font(.caption)
                .foregroundStyle(ADEColor.danger)
              Spacer()
            }
            .padding(12)
            .background(ADEColor.danger.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
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
  }

  @MainActor
  private func submit() async {
    do {
      busy = true
      errorMessage = nil
      let lane = try await syncService.attachLane(name: name, attachedPath: attachedPath, description: description)
      await onComplete(lane.id)
      dismiss()
    } catch {
      errorMessage = error.localizedDescription
    }
    busy = false
  }
}
