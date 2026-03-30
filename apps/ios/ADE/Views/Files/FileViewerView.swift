import SwiftUI
import UIKit

// MARK: - File Editor View

struct FileEditorView: View {
  @EnvironmentObject private var syncService: SyncService
  @Environment(\.dismiss) private var dismiss
  @State private var viewModel = FileViewerViewModel()
  @State private var observedLocalStateRevision: Int?

  let workspace: FilesWorkspace
  let relativePath: String
  let focusLine: Int?
  let isFilesLive: Bool
  let needsRepairing: Bool
  let transitionNamespace: Namespace.ID?
  let navigateToDirectory: (String) -> Void

  private var language: FilesLanguage {
    viewModel.language(for: relativePath)
  }

  private var canEdit: Bool {
    viewModel.canEdit(isFilesLive: isFilesLive, workspace: workspace)
  }

  var body: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 14) {
        FilesBreadcrumbBar(
          relativePath: relativePath,
          includeCurrentFile: true,
          onSelectDirectory: { path in
            viewModel.attemptNavigation(.directory(path)) { target in
              performNavigation(target)
            }
          }
        )

        if let blob = viewModel.blob {
          FilesViewerHeaderCard(
            workspace: workspace,
            relativePath: relativePath,
            blob: blob,
            gitState: viewModel.gitState,
            mode: viewModel.effectiveMode(workspace: workspace),
            availableModes: viewModel.editorModes(workspace: workspace),
            isFilesLive: isFilesLive,
            canEdit: canEdit,
            isDirty: viewModel.isDirty,
            onSelectMode: { selectedMode in
              if viewModel.editorModes(workspace: workspace).contains(selectedMode) {
                viewModel.mode = selectedMode
              }
            },
            onSave: {
              Task { _ = await viewModel.save(syncService: syncService, workspace: workspace, relativePath: relativePath, isFilesLive: isFilesLive) }
            },
            onShowInfo: {
              viewModel.showInfoSheet = true
            },
            stageCurrent: workspace.laneId == nil ? nil : {
              Task {
                await viewModel.stageCurrentFile(
                  laneId: workspace.laneId ?? "",
                  syncService: syncService,
                  workspace: workspace,
                  relativePath: relativePath,
                  isFilesLive: isFilesLive
                )
              }
            },
            unstageCurrent: workspace.laneId == nil ? nil : {
              Task {
                await viewModel.unstageCurrentFile(
                  laneId: workspace.laneId ?? "",
                  syncService: syncService,
                  workspace: workspace,
                  relativePath: relativePath,
                  isFilesLive: isFilesLive
                )
              }
            },
            discardCurrent: workspace.laneId == nil ? nil : {
              viewModel.pendingDestructiveConfirmation = FilesDestructiveConfirmation(kind: .discard(path: relativePath))
            }
          )

          FilesFindReplaceBar(
            findQuery: Binding(
              get: { viewModel.findQuery },
              set: { viewModel.updateSearchQuery($0) }
            ),
            replaceQuery: Binding(
              get: { viewModel.replaceQuery },
              set: { viewModel.replaceQuery = $0 }
            ),
            matchSummary: viewModel.searchSummaryText,
            canReplace: canEdit,
            onPreviousMatch: { viewModel.selectPreviousSearchMatch() },
            onNextMatch: { viewModel.selectNextSearchMatch() },
            onReplaceCurrent: { viewModel.replaceCurrentMatch() },
            onReplaceAll: { viewModel.replaceAllMatches() }
          )

          if !isFilesLive {
            disconnectedNotice
          }

          if let errorMessage = viewModel.errorMessage {
            ADENoticeCard(
              title: "File load failed",
              message: errorMessage,
              icon: "exclamationmark.triangle.fill",
              tint: ADEColor.danger,
              actionTitle: "Retry",
              action: { Task { await viewModel.load(syncService: syncService, workspace: workspace, relativePath: relativePath, isFilesLive: isFilesLive) } }
            )
          }

          if blob.isBinary {
            FilesBinaryPreviewView(
              relativePath: relativePath,
              blob: blob,
              imageData: viewModel.imageData(for: relativePath)
            )
          } else {
            contentSurface(blob: blob)
          }
        }

        if viewModel.blob == nil && viewModel.errorMessage == nil {
          ADECardSkeleton(rows: 4)
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
          viewModel.attemptNavigation(.dismiss) { target in
            performNavigation(target)
          }
        } label: {
          Image(systemName: "chevron.left")
        }
        .accessibilityLabel("Back")
      }

      ToolbarItem(placement: .topBarTrailing) {
        Button { Task { await viewModel.load(syncService: syncService, workspace: workspace, relativePath: relativePath, isFilesLive: isFilesLive) } } label: {
          Image(systemName: "arrow.clockwise")
        }
        .accessibilityLabel("Refresh file")
        .disabled(syncService.activeHostProfile == nil && workspace.laneId == nil)
      }

      ToolbarItem(placement: .topBarTrailing) {
        Button {
          viewModel.showInfoSheet = true
        } label: {
          Image(systemName: "info.circle")
        }
        .accessibilityLabel("File info")
        .disabled(viewModel.blob == nil)
      }
    }
    .sensoryFeedback(.success, trigger: viewModel.saveTrigger)
    .adeNavigationZoomTransition(id: transitionNamespace == nil ? nil : "files-container-\(relativePath)", in: transitionNamespace)
    .task {
      await viewModel.load(syncService: syncService, workspace: workspace, relativePath: relativePath, isFilesLive: isFilesLive)
    }
    .task(id: syncService.localStateRevision) {
      let revision = syncService.localStateRevision
      defer { observedLocalStateRevision = revision }
      guard let previousRevision = observedLocalStateRevision, previousRevision != revision else {
        return
      }
      await viewModel.load(syncService: syncService, workspace: workspace, relativePath: relativePath, isFilesLive: isFilesLive, refreshDiff: viewModel.mode == .diff)
    }
    .task(id: viewModel.mode) {
      if viewModel.mode == .diff {
        await viewModel.loadDiff(syncService: syncService, workspace: workspace, relativePath: relativePath, isFilesLive: isFilesLive)
      }
    }
    .task(id: viewModel.diffMode) {
      if viewModel.mode == .diff {
        await viewModel.loadDiff(syncService: syncService, workspace: workspace, relativePath: relativePath, isFilesLive: isFilesLive)
      }
    }
    .confirmationDialog(
      "Unsaved changes",
      isPresented: $viewModel.showUnsavedChangesConfirmation,
      titleVisibility: .visible
    ) {
      Button("Save") {
        Task {
          let saved = await viewModel.save(
            syncService: syncService,
            workspace: workspace,
            relativePath: relativePath,
            isFilesLive: isFilesLive
          )
          if saved {
            viewModel.performPendingNavigation { target in
              performNavigation(target)
            }
          }
        }
      }

      Button("Discard Changes", role: .destructive) {
        viewModel.performPendingNavigation { target in
          performNavigation(target)
        }
      }

      Button("Cancel", role: .cancel) {
        viewModel.cancelPendingNavigation()
      }
    } message: {
      Text("Save, discard, or cancel before leaving this file.")
    }
    .alert(item: $viewModel.pendingDestructiveConfirmation) { confirmation in
      Alert(
        title: Text(confirmation.title),
        message: Text(confirmation.message),
        primaryButton: .destructive(Text(confirmation.confirmLabel)) {
          switch confirmation.kind {
          case .discard(let path):
            guard let laneId = workspace.laneId else { return }
            Task {
              do {
                try await syncService.discardFile(laneId: laneId, path: path)
                await viewModel.load(syncService: syncService, workspace: workspace, relativePath: relativePath, isFilesLive: isFilesLive, refreshDiff: true)
              } catch {
                viewModel.errorMessage = error.localizedDescription
              }
            }
          case .discardUnsaved:
            viewModel.performPendingNavigation { target in
              performNavigation(target)
            }
          case .delete:
            break
          }
        },
        secondaryButton: .cancel()
      )
    }
    .sheet(isPresented: $viewModel.showInfoSheet) {
      if let blob = viewModel.blob {
        FilesFileInfoSheetView(
          workspace: workspace,
          relativePath: relativePath,
          blob: blob,
          metadata: viewModel.metadata,
          language: language
        )
      }
    }
  }

  private func performNavigation(_ target: EditorNavigationTarget) {
    switch target {
    case .dismiss:
      dismiss()
    case .directory(let path):
      navigateToDirectory(path)
    }
  }

  @ViewBuilder
  private func contentSurface(blob: SyncFileBlob) -> some View {
    switch viewModel.effectiveMode(workspace: workspace) {
    case .preview:
      SyntaxHighlightedCodeView(
        text: viewModel.draftText,
        language: language,
        focusLine: focusLine
      )
    case .edit:
      VStack(alignment: .leading, spacing: 10) {
        if workspace.isReadOnlyByDefault {
          ADENoticeCard(
            title: "Read only",
            message: "This workspace is edit-protected on the host.",
            icon: "lock.fill",
            tint: ADEColor.warning,
            actionTitle: nil,
            action: nil
          )
        } else if !isFilesLive {
          Text("Reconnect to a live host before editing or saving file contents.")
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
        }

        FilesCodeEditorView(
          text: Binding(
            get: { viewModel.draftText },
            set: { viewModel.updateDraftText($0) }
          ),
          selection: Binding(
            get: { viewModel.editorSelection },
            set: { viewModel.updateEditorSelection($0) }
          ),
          isEditable: canEdit,
          onSelectionChange: { newSelection in
            viewModel.updateEditorSelection(newSelection)
          }
        )
        .frame(minHeight: 320)
      }
    case .diff:
      VStack(alignment: .leading, spacing: 10) {
        if workspace.laneId == nil {
          Text("Diff mode requires a lane-backed workspace.")
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
        } else {
          FilesDiffModeControl(
            selection: viewModel.diffMode,
            onSelectMode: { viewModel.diffMode = $0 }
          )

          if let diffErrorMessage = viewModel.diffErrorMessage {
            ADENoticeCard(
              title: "Diff unavailable",
              message: diffErrorMessage,
              icon: "exclamationmark.triangle.fill",
              tint: ADEColor.danger,
              actionTitle: "Retry",
              action: { Task { await viewModel.loadDiff(syncService: syncService, workspace: workspace, relativePath: relativePath, isFilesLive: isFilesLive) } }
            )
          } else if let diff = viewModel.diff, diff.isBinary == true {
            ADEEmptyStateView(
              symbol: "doc.badge.gearshape",
              title: "Binary diff",
              message: "This file changed, but the host reported a binary diff that cannot be rendered inline."
            )
          } else if let diff = viewModel.diff {
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

  private var disconnectedNotice: ADENoticeCard {
    ADENoticeCard(
      title: "Read only while disconnected",
      message: needsRepairing
        ? "Pair again before trusting file state or saving edits."
        : "The last-loaded file content stays visible, but editing and file operations are disabled until the host reconnects.",
      icon: "icloud.slash",
      tint: ADEColor.warning,
      actionTitle: syncService.activeHostProfile == nil ? "Pair again" : "Reconnect",
      action: {
        if syncService.activeHostProfile == nil {
          syncService.settingsPresented = true
        } else {
          Task {
            await syncService.reconnectIfPossible()
          }
        }
      }
    )
  }
}
