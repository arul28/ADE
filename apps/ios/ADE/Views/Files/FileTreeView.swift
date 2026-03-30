import SwiftUI
import UIKit

// MARK: - Directory Screen (Drill-down)

struct FilesDirectoryScreen: View {
  @EnvironmentObject private var syncService: SyncService

  let workspace: FilesWorkspace
  let parentPath: String
  @Binding var showHidden: Bool
  let isLive: Bool
  let needsRepairing: Bool
  let openDirectory: (String) -> Void
  let openFile: (String, Int?) -> Void
  let transitionNamespace: Namespace.ID?
  let selectedFilePath: String?

  var body: some View {
    List {
      FilesBreadcrumbBar(
        relativePath: parentPath,
        includeCurrentFile: false,
        onSelectDirectory: { path in
          openDirectory(path)
        }
      )
      .filesListRow()

      FilesDirectoryContentsView(
        workspace: workspace,
        parentPath: parentPath,
        showHidden: showHidden,
        isLive: isLive,
        needsRepairing: needsRepairing,
        showDisconnectedNotice: true,
        openDirectory: openDirectory,
        openFile: openFile,
        transitionNamespace: transitionNamespace,
        selectedFilePath: selectedFilePath
      )
      .environmentObject(syncService)
    }
    .listStyle(.plain)
    .scrollContentBackground(.hidden)
    .adeScreenBackground()
    .adeNavigationGlass()
    .navigationTitle(parentPath.isEmpty ? "Root" : lastPathComponent(parentPath))
    .refreshable {
      try? await syncService.refreshLaneSnapshots()
    }
  }
}

// MARK: - Directory Contents

struct FilesDirectoryContentsView: View {
  @EnvironmentObject private var syncService: SyncService
  @AppStorage("ade.files.showHidden") private var showHiddenSetting = false
  @State private var viewModel = FileTreeViewModel()

  let workspace: FilesWorkspace
  let parentPath: String
  let showHidden: Bool
  let isLive: Bool
  let needsRepairing: Bool
  let showDisconnectedNotice: Bool
  let openDirectory: (String) -> Void
  let openFile: (String, Int?) -> Void
  let transitionNamespace: Namespace.ID?
  let selectedFilePath: String?

  private var canMutateFiles: Bool {
    viewModel.canMutateFiles(isLive: isLive, workspace: workspace)
  }

  private var canUseGitActions: Bool {
    viewModel.canUseGitActions(isLive: isLive, workspace: workspace)
  }

  private var visibleRows: [FilesTreeRowItem] {
    viewModel.visibleRows(showHidden: showHidden)
  }

  var body: some View {
    Group {
      if showDisconnectedNotice && !isLive {
        disconnectedNotice.filesListRow()
      }

      if let errorMessage = viewModel.actionErrorMessage {
        ADENoticeCard(
          title: "File action failed",
          message: errorMessage,
          icon: "exclamationmark.triangle.fill",
          tint: ADEColor.danger,
          actionTitle: nil,
          action: nil
        )
        .filesListRow()
      }

      if let errorMessage = viewModel.errorMessage {
        ADENoticeCard(
          title: "Directory load failed",
          message: errorMessage,
          icon: "exclamationmark.triangle.fill",
          tint: ADEColor.danger,
          actionTitle: "Retry",
          action: { Task { await viewModel.reload(syncService: syncService, workspace: workspace, parentPath: parentPath, showHidden: showHidden, isLive: isLive) } }
        )
        .filesListRow()
      }

      if viewModel.isLoading && viewModel.nodes.isEmpty {
        ForEach(0..<4, id: \.self) { _ in
          ADECardSkeleton(rows: 2)
            .filesListRow()
        }
      } else if visibleRows.isEmpty {
        ADEEmptyStateView(
          symbol: parentPath.isEmpty ? "folder" : "folder.badge.minus",
          title: parentPath.isEmpty ? "Workspace is empty" : "Folder is empty",
          message: isLive ? "This directory does not have any files to preview on iPhone yet." : "Reconnect to load files from the host."
        )
        .filesListRow()
      } else {
        ForEach(visibleRows) { row in
          rowView(for: row)
            .filesListRow()
        }
      }
    }
    .toolbar {
      ToolbarItemGroup(placement: .topBarTrailing) {
        Menu {
          if canMutateFiles {
            Button {
              viewModel.presentPrompt(.createFile, basePath: parentPath, node: nil)
            } label: {
              Label("New file", systemImage: "doc.badge.plus")
            }

            Button {
              viewModel.presentPrompt(.createFolder, basePath: parentPath, node: nil)
            } label: {
              Label("New folder", systemImage: "folder.badge.plus")
            }
          }

          Toggle(isOn: $showHiddenSetting) {
            Label(showHiddenSetting ? "Hide hidden files" : "Show hidden files", systemImage: showHiddenSetting ? "eye.slash" : "eye")
          }

          if !parentPath.isEmpty {
            Button {
              Task {
                try? await syncService.refreshLaneSnapshots()
              }
            } label: {
              Label("Refresh", systemImage: "arrow.clockwise")
            }
          }
        } label: {
          Image(systemName: "ellipsis.circle")
        }
        .accessibilityLabel("Files actions")
      }
    }
    .task(id: DirectoryReloadKey(workspaceId: workspace.id, parentPath: parentPath, includeHidden: showHidden, live: isLive, revision: syncService.localStateRevision)) {
      await viewModel.reload(syncService: syncService, workspace: workspace, parentPath: parentPath, showHidden: showHidden, isLive: isLive)
    }
    .sheet(item: $viewModel.prompt) { prompt in
      NavigationStack {
        Form {
          Section {
            Text(prompt.message)
              .foregroundStyle(ADEColor.textSecondary)
          }

          Section(prompt.title) {
            TextField(prompt.placeholder, text: $viewModel.promptValue)
              .textInputAutocapitalization(.never)
              .autocorrectionDisabled()
              .accessibilityLabel(prompt.title)
          }

          if let actionErrorMessage = viewModel.actionErrorMessage {
            Section {
              Text(actionErrorMessage)
                .foregroundStyle(ADEColor.danger)
            }
          }
        }
        .navigationTitle(prompt.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) {
            Button("Cancel") {
              viewModel.prompt = nil
            }
          }

          ToolbarItem(placement: .confirmationAction) {
            Button(prompt.confirmLabel) {
              Task {
                await viewModel.confirmPrompt(
                  syncService: syncService,
                  workspace: workspace,
                  parentPath: parentPath,
                  showHidden: showHidden,
                  isLive: isLive,
                  openFile: openFile
                )
              }
            }
          }
        }
      }
    }
    .alert(item: $viewModel.destructiveConfirmation) { confirmation in
      Alert(
        title: Text(confirmation.title),
        message: Text(confirmation.message),
        primaryButton: .destructive(Text(confirmation.confirmLabel)) {
          Task {
            await viewModel.confirmDestructiveAction(confirmation, syncService: syncService, workspace: workspace, parentPath: parentPath, showHidden: showHidden, isLive: isLive)
          }
        },
        secondaryButton: .cancel()
      )
    }
  }

  @ViewBuilder
  private func rowView(for row: FilesTreeRowItem) -> some View {
    if case .node(let node) = row.kind {
      if node.type == "directory" {
        FilesTreeDirectoryRow(
          node: node,
          depth: row.depth,
          isExpanded: viewModel.expandedPaths.contains(node.path),
          canExpand: node.hasChildren ?? true,
          isLoadingChildren: viewModel.loadingPaths.contains(node.path),
          transitionNamespace: transitionNamespace,
          isSelectedTransitionSource: selectedFilePath == node.path,
          openDirectory: { openDirectory(node.path) },
          toggleExpansion: {
            Task {
              await viewModel.toggleExpansion(
                node: node,
                syncService: syncService,
                workspace: workspace,
                showHidden: showHidden,
                isLive: isLive
              )
            }
          }
        )
        .contextMenu { contextMenu(for: node) }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
          if canMutateFiles {
            Button("Rename") {
              viewModel.presentPrompt(.rename, basePath: parentDirectory(of: node.path), node: node)
            }
            .tint(ADEColor.accent)

            Button("Delete", role: .destructive) {
              viewModel.destructiveConfirmation = FilesDestructiveConfirmation(kind: .delete(node: node))
            }
          }
        }
      } else {
        Button {
          openFile(node.path, nil)
        } label: {
          FilesTreeFileRow(
            node: node,
            depth: row.depth,
            transitionNamespace: transitionNamespace,
            isSelectedTransitionSource: selectedFilePath == node.path
          )
        }
        .buttonStyle(.plain)
        .contextMenu { contextMenu(for: node) }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
          if canMutateFiles {
            Button("Rename") {
              viewModel.presentPrompt(.rename, basePath: parentDirectory(of: node.path), node: node)
            }
            .tint(ADEColor.accent)

            Button("Delete", role: .destructive) {
              viewModel.destructiveConfirmation = FilesDestructiveConfirmation(kind: .delete(node: node))
            }
          }
        }
      }
    } else if case .loading = row.kind {
      FilesTreeLoadingRow(depth: row.depth)
    }
  }

  @ViewBuilder
  private func contextMenu(for node: FileTreeNode) -> some View {
    Button("Open") {
      viewModel.open(node, openDirectory: openDirectory, openFile: openFile)
    }

    Button("Copy Path") {
      UIPasteboard.general.string = viewModel.absolutePath(for: node.path, workspace: workspace)
    }

    Button("Copy Relative Path") {
      UIPasteboard.general.string = node.path
    }

    if node.type == "directory" && canMutateFiles {
      Button("New File") {
        viewModel.presentPrompt(.createFile, basePath: node.path, node: nil)
      }

      Button("New Folder") {
        viewModel.presentPrompt(.createFolder, basePath: node.path, node: nil)
      }
    }

    Button("Rename") {
      viewModel.presentPrompt(.rename, basePath: parentDirectory(of: node.path), node: node)
    }
    .disabled(!canMutateFiles)

    Button("Delete", role: .destructive) {
      viewModel.destructiveConfirmation = FilesDestructiveConfirmation(kind: .delete(node: node))
    }
    .disabled(!canMutateFiles)

    if node.type == "file", let laneId = workspace.laneId {
      Button("Stage") {
        Task { await viewModel.stage(node.path, laneId: laneId, syncService: syncService, workspace: workspace, parentPath: parentPath, showHidden: showHidden, isLive: isLive) }
      }
      .disabled(!canUseGitActions || !viewModel.gitState.isUnstaged(node.path))

      Button("Unstage") {
        Task { await viewModel.unstage(node.path, laneId: laneId, syncService: syncService, workspace: workspace, parentPath: parentPath, showHidden: showHidden, isLive: isLive) }
      }
      .disabled(!canUseGitActions || !viewModel.gitState.isStaged(node.path))

      Button("Discard Changes", role: .destructive) {
        viewModel.destructiveConfirmation = FilesDestructiveConfirmation(kind: .discard(path: node.path))
      }
      .disabled(!canUseGitActions || !viewModel.gitState.isUnstaged(node.path))
    }
  }

  private var disconnectedNotice: ADENoticeCard {
    ADENoticeCard(
      title: viewModel.nodes.isEmpty ? "Reconnect to load this folder" : "Showing cached directory",
      message: needsRepairing
        ? "The previous host trust was cleared. Pair again before trusting or editing file state."
        : "Edits and refresh are disabled until the host reconnects.",
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

// MARK: - Tree Node Rows

struct FilesTreeDirectoryRow: View {
  let node: FileTreeNode
  let depth: Int
  let isExpanded: Bool
  let canExpand: Bool
  let isLoadingChildren: Bool
  let transitionNamespace: Namespace.ID?
  let isSelectedTransitionSource: Bool
  let openDirectory: () -> Void
  let toggleExpansion: () -> Void

  var body: some View {
    HStack(spacing: 12) {
      if canExpand {
        Button(action: toggleExpansion) {
          Group {
            if isLoadingChildren {
              ProgressView()
                .controlSize(.small)
                .frame(width: 20, height: 20)
            } else {
              Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(ADEColor.textMuted)
                .frame(width: 20)
            }
          }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(isExpanded ? "Collapse folder \(node.name)" : "Expand folder \(node.name)")
      } else {
        Color.clear
          .frame(width: 20, height: 20)
      }

      Button(action: openDirectory) {
        HStack(spacing: 12) {
          Image(systemName: "folder.fill")
            .font(.headline)
            .foregroundStyle(ADEColor.accent)
            .frame(width: 22)
            .adeMatchedGeometry(id: isSelectedTransitionSource ? "files-icon-\(node.path)" : nil, in: transitionNamespace)

          VStack(alignment: .leading, spacing: 4) {
            Text(node.name)
              .font(.subheadline.weight(.semibold))
              .foregroundStyle(ADEColor.textPrimary)
              .lineLimit(1)
              .adeMatchedGeometry(id: isSelectedTransitionSource ? "files-title-\(node.path)" : nil, in: transitionNamespace)
            Text(node.path.isEmpty ? "Folder" : node.path)
              .font(.caption.monospaced())
              .foregroundStyle(ADEColor.textSecondary)
              .lineLimit(1)
          }
        }
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Open folder \(node.name)")

      Spacer(minLength: 8)

      if let changeStatus = node.changeStatus {
        ADEStatusPill(text: changeStatus.uppercased(), tint: changeStatusTint(changeStatus))
      }

      Image(systemName: "chevron.right")
        .font(.caption.weight(.semibold))
        .foregroundStyle(ADEColor.textMuted)
    }
    .padding(.leading, CGFloat(depth) * 18)
    .frame(maxWidth: .infinity, alignment: .leading)
    .adeListCard(cornerRadius: 16)
  }
}

struct FilesTreeFileRow: View {
  let node: FileTreeNode
  let depth: Int
  let transitionNamespace: Namespace.ID?
  let isSelectedTransitionSource: Bool

  var body: some View {
    HStack(spacing: 12) {
      Image(systemName: fileIcon(for: node.name))
        .font(.headline)
        .foregroundStyle(fileTint(for: node.name))
        .frame(width: 22)
        .adeMatchedGeometry(id: isSelectedTransitionSource ? "files-icon-\(node.path)" : nil, in: transitionNamespace)

      VStack(alignment: .leading, spacing: 4) {
        Text(node.name)
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
          .adeMatchedGeometry(id: isSelectedTransitionSource ? "files-title-\(node.path)" : nil, in: transitionNamespace)
        Text(node.path.isEmpty ? "File" : node.path)
          .font(.caption.monospaced())
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(1)
      }

      Spacer(minLength: 8)

      if let size = node.size {
        Text(formattedFileSize(size))
          .font(.caption2.monospaced())
          .foregroundStyle(ADEColor.textMuted)
      }

      if isBinaryFilePath(node.path) {
        ADEStatusPill(text: "BIN", tint: ADEColor.warning)
      }

      if let changeStatus = node.changeStatus {
        ADEStatusPill(text: changeStatus.uppercased(), tint: changeStatusTint(changeStatus))
      }

      Image(systemName: "chevron.right")
        .font(.caption.weight(.semibold))
        .foregroundStyle(ADEColor.textMuted)
    }
    .padding(.leading, CGFloat(depth) * 18)
    .frame(maxWidth: .infinity, alignment: .leading)
    .adeListCard(cornerRadius: 16)
    .adeMatchedTransitionSource(id: isSelectedTransitionSource ? "files-container-\(node.path)" : nil, in: transitionNamespace)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(accessibilityLabel)
  }

  private var accessibilityLabel: String {
    var parts: [String] = [node.name, "file"]
    if let changeStatus = node.changeStatus {
      parts.append(changeStatusDescription(changeStatus))
    }
    if isBinaryFilePath(node.path) {
      parts.append("binary")
    }
    return parts.joined(separator: ", ")
  }
}

struct FilesTreeLoadingRow: View {
  let depth: Int

  var body: some View {
    HStack(spacing: 12) {
      Color.clear
        .frame(width: 20, height: 20)
      ProgressView()
        .controlSize(.small)
      Text("Loading folder contents")
        .font(.subheadline)
        .foregroundStyle(ADEColor.textSecondary)
      Spacer()
    }
    .padding(.leading, CGFloat(depth) * 18)
    .frame(maxWidth: .infinity, alignment: .leading)
    .adeListCard(cornerRadius: 16)
    .accessibilityLabel("Loading folder contents")
  }
}

// MARK: - Breadcrumb Bar

struct FilesBreadcrumbBar: View {
  let relativePath: String
  let includeCurrentFile: Bool
  let onSelectDirectory: (String) -> Void

  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 8) {
        Button("root") {
          onSelectDirectory("")
        }
        .buttonStyle(.glass)
        .accessibilityLabel("Open root folder")

        ForEach(breadcrumbs, id: \.path) { breadcrumb in
          Image(systemName: "chevron.right")
            .font(.caption2.weight(.semibold))
            .foregroundStyle(ADEColor.textMuted)

          if breadcrumb.isDirectory {
            Button(breadcrumb.label) {
              onSelectDirectory(breadcrumb.path)
            }
            .buttonStyle(.glass)
            .accessibilityLabel("Open folder \(breadcrumb.label)")
          } else {
            Text(breadcrumb.label)
              .font(.caption.weight(.semibold))
              .foregroundStyle(ADEColor.textPrimary)
              .padding(.horizontal, 10)
              .padding(.vertical, 7)
              .background(ADEColor.surfaceBackground, in: Capsule())
              .glassEffect()
              .accessibilityLabel("\(breadcrumb.label), current file")
          }
        }
      }
      .padding(4)
    }
    .adeGlassCard(cornerRadius: 18, padding: 12)
  }

  private var breadcrumbs: [FilesBreadcrumbItem] {
    filesBreadcrumbItems(relativePath: relativePath, includeCurrentFile: includeCurrentFile)
  }
}
