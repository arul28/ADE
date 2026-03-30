import SwiftUI
import UIKit

struct FilesViewerHeaderCard: View {
  let workspace: FilesWorkspace
  let relativePath: String
  let blob: SyncFileBlob
  let gitState: FilesGitState
  let mode: FilesEditorMode
  let availableModes: [FilesEditorMode]
  let isFilesLive: Bool
  let canEdit: Bool
  let isDirty: Bool
  let onSelectMode: (FilesEditorMode) -> Void
  let onSave: () -> Void
  let onShowInfo: () -> Void
  let stageCurrent: (() -> Void)?
  let unstageCurrent: (() -> Void)?
  let discardCurrent: (() -> Void)?

  private var displayName: String {
    lastPathComponent(relativePath)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack(alignment: .top, spacing: 12) {
        Image(systemName: fileIcon(for: relativePath))
          .font(.title3.weight(.semibold))
          .foregroundStyle(fileTint(for: relativePath))
          .frame(width: 42, height: 42)
          .background(ADEColor.surfaceBackground, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
          .glassEffect(in: .rect(cornerRadius: 12))
          .accessibilityHidden(true)

        VStack(alignment: .leading, spacing: 5) {
          Text(displayName)
            .font(.headline)
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(2)
            .minimumScaleFactor(0.85)
          Text(parentDirectory(of: relativePath).isEmpty ? "Workspace root" : parentDirectory(of: relativePath))
            .font(.caption.monospaced())
            .foregroundStyle(ADEColor.textSecondary)
            .textSelection(.enabled)
            .lineLimit(1)
        }

        Spacer(minLength: 0)

        Button(action: onShowInfo) {
          Image(systemName: "info.circle")
            .font(.headline)
        }
        .accessibilityLabel("File info")
      }

      FilesModeControl(
        selection: mode,
        availableModes: availableModes,
        canEdit: canEdit,
        onSelectMode: onSelectMode
      )

      ScrollView(.horizontal, showsIndicators: false) {
        ADEGlassGroup(spacing: 8) {
          ADEStatusPill(text: FilesLanguage.detect(languageId: blob.languageId, filePath: relativePath).displayName.uppercased(), tint: ADEColor.accent)
          if blob.isBinary {
            ADEStatusPill(text: "BINARY", tint: ADEColor.warning)
          }
          if workspace.isReadOnlyByDefault {
            ADEStatusPill(text: "READ ONLY", tint: ADEColor.warning)
          } else if !isFilesLive {
            ADEStatusPill(text: "DISCONNECTED", tint: ADEColor.warning)
          }
          if isDirty {
            ADEStatusPill(text: "UNSAVED", tint: ADEColor.warning)
          }
          if let laneId = workspace.laneId, gitState.isUnstaged(relativePath) || gitState.isStaged(relativePath) {
            FilesGitActionGroup(
              laneId: laneId,
              path: relativePath,
              gitState: gitState,
              stage: stageCurrent,
              unstage: unstageCurrent,
              discard: discardCurrent
            )
          }
        }
      }

      if isDirty {
        Button(action: onSave) {
          Label("Save changes", systemImage: "square.and.arrow.down")
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.glassProminent)
        .tint(ADEColor.accent)
        .accessibilityLabel("Save changes")
        .disabled(!canEdit)
      }
    }
    .adeGlassCard(cornerRadius: 18)
  }
}

struct FilesModeControl: View {
  let selection: FilesEditorMode
  let availableModes: [FilesEditorMode]
  let canEdit: Bool
  let onSelectMode: (FilesEditorMode) -> Void

  var body: some View {
    HStack(spacing: 8) {
      ForEach(availableModes) { mode in
        modeButton(for: mode, isSelected: selection == mode)
      }
    }
  }

  @ViewBuilder
  private func modeButton(for mode: FilesEditorMode, isSelected: Bool) -> some View {
    let isLocked = mode == .edit && !canEdit
    let button = Button {
      onSelectMode(mode)
    } label: {
      VStack(spacing: 2) {
        Text(mode.title)
          .font(.caption.weight(.semibold))
        if isLocked {
          Text("Locked")
            .font(.caption2)
        }
      }
      .frame(maxWidth: .infinity)
    }
    .disabled(isLocked)
    .accessibilityLabel(mode.title + (isLocked ? ", locked" : ""))

    if isSelected {
      button
        .buttonStyle(.glassProminent)
        .tint(ADEColor.accent)
    } else {
      button
        .buttonStyle(.glass)
        .tint(ADEColor.textSecondary)
    }
  }
}

struct FilesDiffModeControl: View {
  let selection: FilesDiffMode
  let onSelectMode: (FilesDiffMode) -> Void

  var body: some View {
    HStack(spacing: 8) {
      ForEach(FilesDiffMode.allCases) { mode in
        modeButton(for: mode, isSelected: selection == mode)
      }
    }
  }

  @ViewBuilder
  private func modeButton(for mode: FilesDiffMode, isSelected: Bool) -> some View {
    let button = Button {
      onSelectMode(mode)
    } label: {
      Text(mode.title)
        .font(.caption.weight(.semibold))
        .frame(maxWidth: .infinity)
    }
    .accessibilityLabel(mode.title)

    if isSelected {
      button
        .buttonStyle(.glassProminent)
        .tint(ADEColor.accent)
    } else {
      button
        .buttonStyle(.glass)
        .tint(ADEColor.textSecondary)
    }
  }
}

struct FilesFindReplaceBar: View {
  @Binding var findQuery: String
  @Binding var replaceQuery: String
  let matchSummary: String
  let canReplace: Bool
  let onPreviousMatch: () -> Void
  let onNextMatch: () -> Void
  let onReplaceCurrent: () -> Void
  let onReplaceAll: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .top, spacing: 10) {
        VStack(alignment: .leading, spacing: 6) {
          Text("Find")
            .font(.caption.weight(.semibold))
            .foregroundStyle(ADEColor.textSecondary)
          TextField("Search in file", text: $findQuery)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .textContentType(.none)
            .adeInsetField(cornerRadius: 14, padding: 12)
            .accessibilityLabel("Find in file")
        }

        VStack(alignment: .leading, spacing: 6) {
          Text("Replace")
            .font(.caption.weight(.semibold))
            .foregroundStyle(ADEColor.textSecondary)
          TextField("Replacement text", text: $replaceQuery)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .textContentType(.none)
            .adeInsetField(cornerRadius: 14, padding: 12)
            .accessibilityLabel("Replace text")
        }
      }

      HStack(spacing: 10) {
        Text(matchSummary)
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)

        Spacer(minLength: 0)

        Button("Previous", action: onPreviousMatch)
          .buttonStyle(.glass)
          .disabled(findQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
          .accessibilityLabel("Previous match")

        Button("Next", action: onNextMatch)
          .buttonStyle(.glass)
          .disabled(findQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
          .accessibilityLabel("Next match")

        Button("Replace", action: onReplaceCurrent)
          .buttonStyle(.glass)
          .disabled(!canReplace || findQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
          .accessibilityLabel("Replace current match")

        Button("All", action: onReplaceAll)
          .buttonStyle(.glass)
          .disabled(!canReplace || findQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
          .accessibilityLabel("Replace all matches")
      }
    }
    .adeGlassCard(cornerRadius: 18)
  }
}

struct FilesFileInfoSheetView: View {
  @Environment(\.dismiss) private var dismiss
  let workspace: FilesWorkspace
  let relativePath: String
  let blob: SyncFileBlob
  let metadata: FilesFileMetadata?
  let language: FilesLanguage

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 14) {
          FilesMetadataRow(label: "Path", value: relativePath.isEmpty ? workspace.rootPath : relativePath)
          FilesMetadataRow(label: "Size", value: metadata?.sizeText ?? formattedFileSize(blob.size))
          FilesMetadataRow(label: "Language", value: metadata?.languageLabel ?? language.displayName)
          FilesMetadataRow(label: "Last commit", value: metadata?.lastCommitTitle ?? "No commit information available")
          FilesMetadataRow(label: "Last change", value: metadata?.lastCommitDateText ?? "No commit information available")
          FilesMetadataRow(label: "Workspace", value: workspace.name)
          FilesMetadataRow(label: "Root path", value: workspace.rootPath)
        }
        .padding(16)
      }
      .navigationTitle("File info")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button("Done") { dismiss() }
        }
      }
    }
  }
}

struct FilesMetadataRow: View {
  let label: String
  let value: String

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(label)
        .font(.caption.weight(.semibold))
        .foregroundStyle(ADEColor.textSecondary)
      Text(value)
        .font(label == "Path" || label == "Root path" ? .caption.monospaced() : .subheadline)
        .foregroundStyle(ADEColor.textPrimary)
        .textSelection(.enabled)
    }
  }
}

struct FilesGitActionGroup: View {
  let laneId: String
  let path: String
  let gitState: FilesGitState
  let stage: (() -> Void)?
  let unstage: (() -> Void)?
  let discard: (() -> Void)?

  var body: some View {
    ADEGlassGroup(spacing: 8) {
      if gitState.isUnstaged(path), let stage {
        Button("Stage", action: stage)
          .buttonStyle(.glass)
      }
      if gitState.isStaged(path), let unstage {
        Button("Unstage", action: unstage)
          .buttonStyle(.glass)
      }
      if gitState.isUnstaged(path), let discard {
        Button("Discard", role: .destructive, action: discard)
          .buttonStyle(.glass)
      }
    }
    .accessibilityLabel("Git file actions")
  }
}
