import SwiftUI

// MARK: - Diff screen

struct LaneDiffScreen: View {
  @Environment(\.dismiss) private var dismiss
  @EnvironmentObject private var syncService: SyncService

  let request: LaneDiffRequest

  @State private var diff: FileDiff?
  @State private var editedText = ""
  @State private var errorMessage: String?
  @State private var isLoading = false
  @State private var isSaving = false
  @State private var side = "modified"

  private var canEditDiff: Bool {
    request.mode == "unstaged"
      && laneAllowsLiveActions(connectionState: syncService.connectionState, laneStatus: syncService.status(for: .lanes))
  }

  var body: some View {
    NavigationStack {
      VStack(spacing: 0) {
        ScrollView {
          VStack(spacing: 14) {
            GlassSection(title: request.title) {
              VStack(alignment: .leading, spacing: 8) {
                if let path = request.path {
                  Text(path)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(ADEColor.textSecondary)
                }
                if let compareRef = request.compareRef, !compareRef.isEmpty {
                  LaneInfoRow(label: "Base", value: compareRef, isMonospaced: true)
                }
                if let compareTo = request.compareTo, !compareTo.isEmpty {
                  LaneInfoRow(label: "Against", value: compareTo, isMonospaced: true)
                }
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

            if diff != nil {
              Picker("Side", selection: $side) {
                Text("Original").tag("original")
                Text("Modified").tag("modified")
              }
              .pickerStyle(.segmented)
            }
          }
          .padding(16)
        }

        if let diff {
          if diff.isBinary == true {
            GlassSection(title: "Binary diff") {
              Text("Binary content is view-only on iPhone.")
                .font(.subheadline)
                .foregroundStyle(ADEColor.textSecondary)
            }
            .padding(.horizontal, 16)
          } else {
            VStack(alignment: .leading, spacing: 6) {
              HStack {
                Text(side == "original" ? "Original" : "Modified")
                  .font(.caption.weight(.semibold))
                  .foregroundStyle(ADEColor.textMuted)
                Spacer()
                if request.mode == "unstaged" && side == "modified" {
                  Text(canEditDiff ? "Editable" : "Reconnect to edit")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(canEditDiff ? ADEColor.accent : ADEColor.textMuted)
                }
              }
              TextEditor(text: Binding(
                get: {
                  side == "original" ? diff.original.text : editedText
                },
                set: { newValue in
                  editedText = newValue
                }
              ))
              .font(.system(.footnote, design: .monospaced))
              .scrollContentBackground(.hidden)
              .adeInsetField(cornerRadius: 14, padding: 12)
              .disabled(side == "original" || !canEditDiff)
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 16)
          }
        } else if isLoading {
          Spacer()
          ProgressView()
            .tint(ADEColor.accent)
          Spacer()
        }
      }
      .adeScreenBackground()
      .adeNavigationGlass()
      .navigationTitle(request.title)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Done") { dismiss() }
        }
        ToolbarItem(placement: .confirmationAction) {
          if request.mode == "unstaged", let path = request.path, side == "modified", let d = diff, d.isBinary != true {
            Button {
              Task { await saveEditedFile(path: path) }
            } label: {
              if isSaving {
                ProgressView()
                  .tint(ADEColor.accent)
              } else {
                Text("Save")
              }
            }
            .disabled(isSaving || !canEditDiff)
          }
        }
        ToolbarItem(placement: .topBarTrailing) {
          if let path = request.path {
            Button("Files") {
              Task {
                do {
                  let workspaces = try await syncService.listWorkspaces()
                  guard let workspace = workspaces.first(where: { $0.laneId == request.laneId }) else {
                    ADEHaptics.error()
                    errorMessage = "Workspace not found for lane \(request.laneId)."
                    return
                  }
                  syncService.requestedFilesNavigation = FilesNavigationRequest(
                    workspaceId: workspace.id,
                    laneId: request.laneId,
                    relativePath: path
                  )
                  dismiss()
                } catch {
                  ADEHaptics.error()
                  errorMessage = error.localizedDescription
                }
              }
            }
          }
        }
      }
      .task {
        do {
          try await load()
        } catch {
          ADEHaptics.error()
          errorMessage = error.localizedDescription
        }
      }
    }
  }

  @MainActor
  private func load() async throws {
    guard let path = request.path else {
      diff = nil
      editedText = ""
      return
    }
    isLoading = true
    defer { isLoading = false }
    do {
      let loaded = try await syncService.fetchFileDiff(
        laneId: request.laneId,
        path: path,
        mode: request.mode,
        compareRef: request.compareRef,
        compareTo: request.compareTo
      )
      diff = loaded
      editedText = loaded.modified.text
    } catch {
      diff = nil
      throw error
    }
  }

  @MainActor
  private func saveEditedFile(path: String) async {
    guard let d = diff, d.isBinary != true else { return }
    isSaving = true
    defer { isSaving = false }

    do {
      try await syncService.writeLaneFileText(laneId: request.laneId, path: path, text: editedText)
      try await load()
      errorMessage = nil
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
  }
}
