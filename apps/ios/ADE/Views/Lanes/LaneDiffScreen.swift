import SwiftUI

struct LaneDiffScreen: View {
  @Environment(\.dismiss) private var dismiss
  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  private var syncService: SyncService { syncPublishes.service }

  let request: LaneDiffRequest
  /// The Duo's git column: the diff replaces the git list in place, with a
  /// back button of its own, instead of opening as a sheet.
  var inline = false
  /// A diff already in hand (fixture screens); skips the read.
  var initialDiff: FileDiff? = nil
  var onClose: (() -> Void)? = nil

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
    if inline {
      VStack(spacing: 0) {
        inlineHeader
        diffContent
      }
      .adeScreenBackground()
      .task { await loadReportingErrors() }
    } else {
      NavigationStack {
        diffContent
          .adeScreenBackground()
          .adeNavigationGlass()
          .navigationTitle(request.title)
          .navigationBarTitleDisplayMode(.inline)
          .toolbar {
            ToolbarItem(placement: .cancellationAction) {
              Button("Done") { dismiss() }
            }
            ToolbarItem(placement: .confirmationAction) {
              saveButton
            }
            ToolbarItem(placement: .topBarTrailing) {
              if request.path != nil {
                Button("Files") { openInFiles() }
              }
            }
          }
          .task { await loadReportingErrors() }
      }
    }
  }

  /// Back to the git list, the file, and Save / Files, at the column's top.
  private var inlineHeader: some View {
    HStack(spacing: 10) {
      Button {
        onClose?()
      } label: {
        Label("Changes", systemImage: "chevron.left")
          .font(.subheadline.weight(.semibold))
      }
      .buttonStyle(.borderless)
      Spacer(minLength: 8)
      saveButton
        .buttonStyle(.borderless)
      if request.path != nil {
        Button("Files", systemImage: "folder") { openInFiles() }
          .labelStyle(.iconOnly)
          .buttonStyle(.borderless)
      }
    }
    .padding(.horizontal, 16)
    .frame(height: 44)
  }

  @ViewBuilder
  private var saveButton: some View {
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

  private func openInFiles() {
    guard let path = request.path else { return }
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
        if !inline { dismiss() }
      } catch {
        ADEHaptics.error()
        errorMessage = error.localizedDescription
      }
    }
  }

  @MainActor
  private func loadReportingErrors() async {
    if let initialDiff {
      diff = initialDiff
      editedText = initialDiff.modified.text
      return
    }
    do {
      try await load()
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
  }

  private var diffContent: some View {
      // The file, the side picker, then the text taking the rest of the
      // column (a scroll view around the header split the height in two and
      // left a band of empty space above a short diff).
      VStack(spacing: 0) {
          VStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
              Text(request.title)
                .font(.system(size: 14.5, weight: .semibold))
                .foregroundStyle(ADEColor.textPrimary)
              if let path = request.path {
                Text(path)
                  .font(.adeMono(11.5))
                  .foregroundStyle(ADEColor.textSecondary)
              }
              if let compareRef = request.compareRef, !compareRef.isEmpty {
                LaneInfoRow(label: "Base", value: compareRef, isMonospaced: true)
              }
              if let compareTo = request.compareTo, !compareTo.isEmpty {
                LaneInfoRow(label: "Against", value: compareTo, isMonospaced: true)
              }
            }
            .adeKitCard(padding: 12)

            if let errorMessage {
              ADESettingsNotice(message: errorMessage, tone: .crit)
            }

            if diff != nil {
              ADEKitSegmented(
                selection: $side,
                options: [(value: "original", title: "Original"), (value: "modified", title: "Modified")]
              )
            }
          }
          .padding(EdgeInsets(top: 8, leading: 16, bottom: 12, trailing: 16))

        if let diff {
          if diff.isBinary == true {
            HStack(alignment: .top, spacing: 12) {
              Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(ADEColor.warning)
              VStack(alignment: .leading, spacing: 4) {
                Text("Binary diff")
                  .font(.subheadline.weight(.semibold))
                  .foregroundStyle(ADEColor.textPrimary)
                Text("Binary content is view-only on iPhone.")
                  .font(.caption)
                  .foregroundStyle(ADEColor.textSecondary)
              }
              Spacer(minLength: 0)
            }
            .adeKitCard(padding: 14)
            .padding(.horizontal, 16)
          } else {
            VStack(alignment: .leading, spacing: 6) {
              HStack {
                ADEEyebrow(side == "original" ? "Original" : "Modified")
                Spacer()
                if request.mode == "unstaged" && side == "modified" {
                  Text(canEditDiff ? "Editable" : "Reconnect to edit")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(canEditDiff ? ADEColor.textSecondary : ADEColor.textMuted)
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
              .padding(12)
              .adeKitCard(padding: nil)
              .disabled(side == "original" || !canEditDiff)
            }
            .frame(maxHeight: .infinity, alignment: .top)
            .padding(.horizontal, 16)
            .padding(.bottom, 16)
          }
        } else if isLoading {
          Spacer()
          ProgressView()
          Spacer()
        } else {
          Spacer(minLength: 0)
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
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
