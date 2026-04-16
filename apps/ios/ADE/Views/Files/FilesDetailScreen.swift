import SwiftUI
import UIKit

struct FilesDetailScreen: View {
  @EnvironmentObject var syncService: SyncService
  @Environment(\.dismiss) var dismiss

  let workspace: FilesWorkspace
  let relativePath: String
  let focusLine: Int?
  let isFilesLive: Bool
  let needsRepairing: Bool
  let transitionNamespace: Namespace.ID?
  let navigateToDirectory: (String) -> Void

  @State var blob: SyncFileBlob?
  @State var draftText = ""
  @State var errorMessage: String?
  @State var metadata: FilesFileMetadata?
  @State var gitState = FilesGitState.empty
  @State var mode: FilesEditorMode = .preview
  @State var diffMode: FilesDiffMode = .unstaged
  @State var diff: FileDiff?
  @State var diffErrorMessage: String?
  @State var saveTrigger = 0
  @State var isMetadataExpanded = true
  @State var pendingDestructiveConfirmation: FilesDestructiveConfirmation?
  @State var pendingNavigationTarget: EditorNavigationTarget?

  enum EditorNavigationTarget {
    case dismiss
    case directory(String)
  }

  var language: FilesLanguage {
    FilesLanguage.detect(languageId: blob?.languageId, filePath: relativePath)
  }

  var isImagePreviewable: Bool {
    let lowercased = relativePath.lowercased()
    return ["png", "jpg", "jpeg", "gif", "webp", "heic", "bmp", "tiff"].contains((lowercased as NSString).pathExtension)
  }

  var imageData: Data? {
    guard let blob else { return nil }
    if blob.encoding.lowercased() == "base64" {
      return Data(base64Encoded: blob.content)
    }
    return Data(blob.content.utf8)
  }

  var imageCacheKey: String {
    "files-preview::\(workspace.id)::\(relativePath)"
  }

  var canEdit: Bool {
    isFilesLive && !workspace.readOnlyOnMobile && blob?.isBinary == false
  }

  var isDirty: Bool {
    guard let blob, !blob.isBinary else { return false }
    return draftText != blob.content
  }

  var editorModes: [FilesEditorMode] {
    guard blob?.isBinary == false else { return [.preview] }
    if workspace.laneId != nil {
      return workspace.readOnlyOnMobile ? [.preview, .diff] : [.preview, .edit, .diff]
    }
    return workspace.readOnlyOnMobile ? [.preview] : [.preview, .edit]
  }

  var body: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 14) {
        FilesBreadcrumbBar(
          relativePath: relativePath,
          includeCurrentFile: true,
          onSelectDirectory: { path in
            attemptNavigation(.directory(path))
          }
        )

        if !isFilesLive {
          disconnectedNotice
        }

        if let errorMessage {
          ADENoticeCard(
            title: "File load failed",
            message: errorMessage,
            icon: "exclamationmark.triangle.fill",
            tint: ADEColor.danger,
            actionTitle: "Retry",
            action: { Task { await load() } }
          )
        }

        if blob == nil && errorMessage == nil {
          ADECardSkeleton(rows: 4)
        }

        if let blob {
          filesHeader(blob: blob)

          DisclosureGroup(isExpanded: $isMetadataExpanded) {
            VStack(alignment: .leading, spacing: 10) {
              FilesMetadataRow(label: "Path", value: relativePath)
              FilesMetadataRow(label: "Size", value: metadata?.sizeText ?? formattedFileSize(blob.size))
              FilesMetadataRow(label: "Language", value: metadata?.languageLabel ?? language.displayName)
              FilesMetadataRow(label: "Last commit", value: metadata?.lastCommitTitle ?? "No commit information available")
              if let lastCommitDateText = metadata?.lastCommitDateText {
                FilesMetadataRow(label: "Last change", value: lastCommitDateText)
              }
            }
            .padding(.top, 10)
          } label: {
            Text("Metadata")
              .font(.headline)
              .foregroundStyle(ADEColor.textPrimary)
          }
          .adeGlassCard(cornerRadius: 18)

          if blob.isBinary {
            binaryPreview(blob: blob)
          } else {
            codeSurface(blob: blob)
          }
        }
      }
      .padding(16)
    }
    .adeScreenBackground()
    .adeNavigationGlass()
    .navigationTitle(lastPathComponent(relativePath))
    .navigationBarBackButtonHidden(true)
    .toolbar {
      ToolbarItem(placement: .topBarLeading) {
        Button {
          attemptNavigation(.dismiss)
        } label: {
          Image(systemName: "chevron.left")
        }
        .accessibilityLabel("Back")
      }

      ToolbarItemGroup(placement: .topBarTrailing) {
        if isDirty {
          ADEStatusPill(text: "UNSAVED", tint: ADEColor.warning)
        }

        if canEdit {
          Button("Save") {
            Task { await save() }
          }
          .disabled(!isDirty)
        }
      }
    }
    .sensoryFeedback(.success, trigger: saveTrigger)
    .adeNavigationZoomTransition(id: transitionNamespace == nil ? nil : "files-container-\(relativePath)", in: transitionNamespace)
    .task {
      await load()
    }
    .task(id: syncService.localStateRevision) {
      await load(refreshDiff: mode == .diff)
    }
    .task(id: mode) {
      if mode == .diff {
        await loadDiff()
      }
    }
    .task(id: diffMode) {
      if mode == .diff {
        await loadDiff()
      }
    }
    .alert(item: $pendingDestructiveConfirmation) { confirmation in
      Alert(
        title: Text(confirmation.title),
        message: Text(confirmation.message),
        primaryButton: .destructive(Text(confirmation.confirmLabel)) {
          switch confirmation.kind {
          case .discardUnsaved:
            performNavigationTarget()
          case .discard(let path):
            guard let laneId = workspace.laneId else { return }
            Task {
              do {
                try await syncService.discardFile(laneId: laneId, path: path)
                await load(refreshDiff: true)
              } catch {
                errorMessage = error.localizedDescription
              }
            }
          }
        },
        secondaryButton: .cancel()
      )
    }
  }

  @ViewBuilder
  private func filesHeader(blob: SyncFileBlob) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .top, spacing: 12) {
        Image(systemName: fileIcon(for: relativePath))
          .font(.title3.weight(.semibold))
          .foregroundStyle(fileTint(for: relativePath))
          .frame(width: 42, height: 42)
          .background(ADEColor.surfaceBackground, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
          .glassEffect(in: .rect(cornerRadius: 12))
          .adeMatchedGeometry(id: transitionNamespace == nil ? nil : "files-icon-\(relativePath)", in: transitionNamespace)

        VStack(alignment: .leading, spacing: 6) {
          Text(lastPathComponent(relativePath))
            .font(.headline)
            .foregroundStyle(ADEColor.textPrimary)
            .adeMatchedGeometry(id: transitionNamespace == nil ? nil : "files-title-\(relativePath)", in: transitionNamespace)
          Text(parentDirectory(of: relativePath).isEmpty ? "Workspace root" : parentDirectory(of: relativePath))
            .font(.caption.monospaced())
            .foregroundStyle(ADEColor.textSecondary)
        }

        Spacer(minLength: 0)
      }

      ScrollView(.horizontal, showsIndicators: false) {
        ADEGlassGroup(spacing: 8) {
          ADEStatusPill(text: language.displayName.uppercased(), tint: ADEColor.accent)
          if workspace.readOnlyOnMobile {
            ADEStatusPill(text: "READ ONLY", tint: ADEColor.warning)
          } else if !isFilesLive {
            ADEStatusPill(text: "DISCONNECTED", tint: ADEColor.warning)
          }
          if !workspace.readOnlyOnMobile,
             gitState.isUnstaged(relativePath) || gitState.isStaged(relativePath) {
            FilesGitActionGroup(
              path: relativePath,
              gitState: gitState,
              stage: { Task { await stageCurrentFile() } },
              unstage: { Task { await unstageCurrentFile() } },
              discard: { pendingDestructiveConfirmation = FilesDestructiveConfirmation(kind: .discard(path: relativePath)) }
            )
          }
        }
      }
    }
    .adeGlassCard(cornerRadius: 18)
  }

  @ViewBuilder
  private func binaryPreview(blob: SyncFileBlob) -> some View {
    if isImagePreviewable, let data = imageData, let image = UIImage(data: data) {
      VStack(alignment: .leading, spacing: 10) {
        Text("Preview")
          .font(.headline)
          .foregroundStyle(ADEColor.textPrimary)
        ZoomableImageView(image: image)
          .frame(minHeight: 280)
      }
      .adeGlassCard(cornerRadius: 18)
    } else if isImagePreviewable {
      ADENoticeCard(
        title: "Image preview unavailable",
        message: "The current host only exposed file metadata for this image. Reconnect and reopen after the host sends binary bytes for previews.",
        icon: "photo",
        tint: ADEColor.warning,
        actionTitle: nil,
        action: nil
      )
    } else {
      ADEEmptyStateView(
        symbol: "doc.fill",
        title: "Binary file",
        message: "This file cannot be displayed inline on iPhone yet."
      )
    }
  }

  @ViewBuilder
  private func codeSurface(blob: SyncFileBlob) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      Picker("Mode", selection: $mode) {
        ForEach(editorModes) { editorMode in
          Text(editorMode.title).tag(editorMode)
        }
      }
      .pickerStyle(.segmented)

      switch mode {
      case .preview:
        SyntaxHighlightedCodeView(
          text: draftText,
          language: language,
          focusLine: focusLine
        )
      case .edit:
        VStack(alignment: .leading, spacing: 10) {
          if workspace.readOnlyOnMobile {
            Text("This workspace is intentionally read-only on iPhone.")
              .font(.caption)
              .foregroundStyle(ADEColor.textSecondary)
          } else if !isFilesLive {
            Text("Reconnect to a live host before editing or saving file contents.")
              .font(.caption)
              .foregroundStyle(ADEColor.textSecondary)
          }

          TextEditor(text: $draftText)
            .font(.system(.body, design: .monospaced))
            .frame(minHeight: 320)
            .disabled(!canEdit)
            .adeInsetField(cornerRadius: 16, padding: 12)
        }
      case .diff:
        VStack(alignment: .leading, spacing: 10) {
          if workspace.laneId == nil {
            Text("Diff mode requires a lane-backed workspace.")
              .font(.caption)
              .foregroundStyle(ADEColor.textSecondary)
          } else {
            Picker("Diff", selection: $diffMode) {
              ForEach(FilesDiffMode.allCases) { item in
                Text(item.title).tag(item)
              }
            }
            .pickerStyle(.segmented)

            if let diffErrorMessage {
              ADENoticeCard(
                title: "Diff unavailable",
                message: diffErrorMessage,
                icon: "exclamationmark.triangle.fill",
                tint: ADEColor.danger,
                actionTitle: "Retry",
                action: { Task { await loadDiff() } }
              )
            } else if let diff, diff.isBinary == true {
              ADEEmptyStateView(
                symbol: "doc.badge.gearshape",
                title: "Binary diff",
                message: "This file changed, but the host reported a binary diff that cannot be rendered inline."
              )
            } else if let diff {
              FilesInlineDiffView(
                lines: buildInlineDiffLines(original: diff.original.text, modified: diff.modified.text),
                language: FilesLanguage.detect(languageId: diff.language, filePath: relativePath)
              )
            } else {
              ADECardSkeleton(rows: 4)
            }
          }
        }
      }
    }
    .adeGlassCard(cornerRadius: 18)
  }
}
