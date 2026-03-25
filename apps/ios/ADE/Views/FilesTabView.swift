import SwiftUI
import UIKit

private enum FilesRoute: Hashable {
  case editor(workspaceId: String, relativePath: String, readOnly: Bool)
}

struct FilesTabView: View {
  @EnvironmentObject private var syncService: SyncService
  @State private var workspaces: [FilesWorkspace] = []
  @State private var selectedWorkspaceId: String?
  @State private var searchQuery = ""
  @State private var quickOpenResults: [FilesQuickOpenItem] = []
  @State private var errorMessage: String?
  @State private var navigationPath = NavigationPath()

  private var filesStatus: SyncDomainStatus {
    syncService.status(for: .files)
  }

  private var selectedWorkspace: FilesWorkspace? {
    workspaces.first(where: { $0.id == selectedWorkspaceId }) ?? workspaces.first
  }

  private var canUseLiveFileActions: Bool {
    filesStatus.phase == .ready && (syncService.connectionState == .connected || syncService.connectionState == .syncing)
  }

  private var needsRepairing: Bool {
    syncService.activeHostProfile == nil && !workspaces.isEmpty
  }

  private var isLoadingSkeleton: Bool {
    filesStatus.phase == .hydrating || filesStatus.phase == .syncingInitialData
  }

  var body: some View {
    NavigationStack(path: $navigationPath) {
      List {
        if let notice = statusNotice {
          notice
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
        }

        if isLoadingSkeleton {
          ForEach(0..<2, id: \.self) { _ in
            ADECardSkeleton(rows: 3)
              .listRowBackground(Color.clear)
              .listRowSeparator(.hidden)
          }
        }

        if let errorMessage, filesStatus.phase == .ready {
          ADENoticeCard(
            title: "Files view error",
            message: errorMessage,
            icon: "exclamationmark.triangle.fill",
            tint: ADEColor.danger,
            actionTitle: "Retry",
            action: { Task { await reload(refreshRemote: true) } }
          )
          .listRowBackground(Color.clear)
          .listRowSeparator(.hidden)
        }

        if filesStatus.phase == .ready && workspaces.isEmpty {
          ADEEmptyStateView(
            symbol: "folder.badge.questionmark",
            title: "No workspaces available",
            message: "This host does not currently expose any lane-backed workspaces to browse from iPhone."
          ) {
            if syncService.activeHostProfile == nil {
              Button("Open Settings") {
                syncService.settingsPresented = true
              }
              .buttonStyle(.glassProminent)
              .tint(ADEColor.accent)
            }
          }
          .listRowBackground(Color.clear)
          .listRowSeparator(.hidden)
        }

        if !workspaces.isEmpty {
          Section("Workspace") {
            VStack(alignment: .leading, spacing: 10) {
              Picker("Workspace", selection: Binding(
                get: { selectedWorkspaceId ?? workspaces.first?.id ?? "" },
                set: { selectedWorkspaceId = $0 }
              )) {
                ForEach(workspaces) { workspace in
                  Text(workspace.name).tag(workspace.id)
                }
              }
              .pickerStyle(.menu)

              if let workspace = selectedWorkspace {
                Label(workspace.isReadOnlyByDefault ? "Read-only workspace" : "Live workspace", systemImage: workspace.isReadOnlyByDefault ? "lock" : "folder")
                  .font(.caption)
                  .foregroundStyle(ADEColor.textSecondary)
              }
            }
            .adeGlassCard(cornerRadius: 18)
            .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
          }
        }

        Section("Quick open") {
          VStack(alignment: .leading, spacing: 10) {
            TextField("Search files", text: $searchQuery)
              .textInputAutocapitalization(.never)
              .autocorrectionDisabled()
              .disabled(!canUseLiveFileActions)
              .adeInsetField()
              .onSubmit {
                Task {
                  await runQuickOpen()
                }
              }

            if !canUseLiveFileActions {
              Text(needsRepairing
                ? "Workspace names are cached locally, but the saved host trust was cleared. Pair again before searching or opening files."
                : "Quick open needs a live, hydrated host connection.")
                .font(.caption)
                .foregroundStyle(ADEColor.textSecondary)
            } else if searchQuery.isEmpty {
              Text("Type a filename or path to search the connected workspaces.")
                .font(.caption)
                .foregroundStyle(ADEColor.textSecondary)
            } else if quickOpenResults.isEmpty {
              Text("No matching files found.")
                .font(.caption)
                .foregroundStyle(ADEColor.textSecondary)
            }
          }
          .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
          .listRowBackground(Color.clear)
          .listRowSeparator(.hidden)

          if canUseLiveFileActions {
            ForEach(quickOpenResults) { item in
              NavigationLink {
                FileEditorView(
                  workspaceId: selectedWorkspaceId ?? "",
                  relativePath: item.path,
                  isReadOnlyByDefault: selectedWorkspace?.isReadOnlyByDefault ?? true
                )
              } label: {
                FilesResultRow(path: item.path)
              }
              .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                Button("Copy path") {
                  UIPasteboard.general.string = item.path
                }
                .tint(ADEColor.accent)
              }
              .listRowBackground(Color.clear)
              .listRowSeparator(.hidden)
            }
          }
        }

        if let workspace = selectedWorkspace {
          Section("Tree") {
            if canUseLiveFileActions {
              NavigationLink {
                FileTreeDirectoryView(
                  workspaceId: workspace.id,
                  parentPath: "",
                  isReadOnlyByDefault: workspace.isReadOnlyByDefault
                )
              } label: {
                HStack(spacing: 10) {
                  Image(systemName: "folder.fill")
                    .foregroundStyle(ADEColor.accent)
                  VStack(alignment: .leading, spacing: 4) {
                    Text("Browse root")
                      .font(.headline)
                      .foregroundStyle(ADEColor.textPrimary)
                    Text(workspace.name)
                      .font(.caption)
                      .foregroundStyle(ADEColor.textSecondary)
                  }
                  Spacer()
                  Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(ADEColor.textMuted)
                }
                .adeGlassCard(cornerRadius: 18)
              }
              .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
              .listRowBackground(Color.clear)
              .listRowSeparator(.hidden)
            } else {
              ADEEmptyStateView(
                symbol: "icloud.slash",
                title: needsRepairing ? "Pair again to browse files" : "Reconnect to browse files",
                message: needsRepairing
                  ? "Pair again before browsing the cached workspace on the host."
                  : "Reconnect to browse the live workspace tree."
              )
              .listRowBackground(Color.clear)
              .listRowSeparator(.hidden)
            }
          }
        }
      }
      .listStyle(.plain)
      .scrollContentBackground(.hidden)
      .adeScreenBackground()
      .adeNavigationGlass()
      .navigationTitle("Files")
      .navigationDestination(for: FilesRoute.self) { route in
        switch route {
        case .editor(let workspaceId, let relativePath, let readOnly):
          FileEditorView(
            workspaceId: workspaceId,
            relativePath: relativePath,
            isReadOnlyByDefault: readOnly
          )
        }
      }
      .refreshable {
        await reload(refreshRemote: true)
      }
      .sensoryFeedback(.selection, trigger: selectedWorkspaceId)
      .sensoryFeedback(.success, trigger: quickOpenResults.count)
      .task {
        await reload()
      }
      .task(id: syncService.localStateRevision) {
        await reload()
      }
      .task(id: syncService.requestedFilesNavigation?.id) {
        await handleRequestedNavigation()
      }
    }
  }

  @MainActor
  private func reload(refreshRemote: Bool = false) async {
    do {
      if refreshRemote {
        try? await syncService.refreshLaneSnapshots()
      }
      workspaces = try await syncService.listWorkspaces()
      selectedWorkspaceId = selectedWorkspaceId.flatMap { candidate in
        workspaces.contains(where: { $0.id == candidate }) ? candidate : nil
      } ?? workspaces.first?.id
      if !canUseLiveFileActions {
        quickOpenResults = []
      }
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  private func runQuickOpen() async {
    guard canUseLiveFileActions else {
      quickOpenResults = []
      return
    }
    guard let workspaceId = selectedWorkspaceId, !searchQuery.isEmpty else {
      quickOpenResults = []
      return
    }
    do {
      quickOpenResults = try await syncService.quickOpen(workspaceId: workspaceId, query: searchQuery)
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  private func handleRequestedNavigation() async {
    guard let request = syncService.requestedFilesNavigation else { return }
    if workspaces.isEmpty {
      await reload()
    }
    guard let workspace = workspaces.first(where: { $0.id == request.workspaceId }) else {
      syncService.requestedFilesNavigation = nil
      return
    }
    selectedWorkspaceId = workspace.id
    if let relativePath = request.relativePath, !relativePath.isEmpty {
      navigationPath.append(
        FilesRoute.editor(
          workspaceId: workspace.id,
          relativePath: relativePath,
          readOnly: workspace.isReadOnlyByDefault
        )
      )
    }
    syncService.requestedFilesNavigation = nil
  }

  private var statusNotice: ADENoticeCard? {
    switch filesStatus.phase {
    case .disconnected:
      return ADENoticeCard(
        title: workspaces.isEmpty ? "Host disconnected" : "Showing cached workspaces",
        message: workspaces.isEmpty
          ? (syncService.activeHostProfile == nil
              ? "Pair with a host to hydrate the lane-backed workspace list before browsing files."
              : "Reconnect to hydrate the lane-backed workspace list before browsing files.")
          : (needsRepairing
              ? "Workspace names are cached locally, but the previous host trust was cleared. Pair again before trusting file state or write access."
              : "Workspace metadata is cached locally. Reconnect before trusting file state from the host."),
        icon: "folder.badge.questionmark",
        tint: ADEColor.warning,
        actionTitle: syncService.activeHostProfile == nil ? (needsRepairing ? "Pair again" : "Pair with host") : "Reconnect",
        action: {
          if syncService.activeHostProfile == nil {
            syncService.settingsPresented = true
          } else {
            Task {
              await syncService.reconnectIfPossible()
              await reload(refreshRemote: true)
            }
          }
        }
      )
    case .hydrating:
      return ADENoticeCard(
        title: "Hydrating workspaces",
        message: "Files uses the lane graph for workspace roots. Waiting for the latest lane hydration from the host.",
        icon: "arrow.trianglehead.2.clockwise.rotate.90",
        tint: ADEColor.accent,
        actionTitle: nil,
        action: nil
      )
    case .syncingInitialData:
      return ADENoticeCard(
        title: "Syncing initial data",
        message: "Waiting for the host to finish syncing project and lane metadata before Files hydrates.",
        icon: "arrow.trianglehead.2.clockwise.rotate.90",
        tint: ADEColor.warning,
        actionTitle: nil,
        action: nil
      )
    case .failed:
      return ADENoticeCard(
        title: "Workspace hydration failed",
        message: filesStatus.lastError ?? "The lane graph did not hydrate, so Files cannot trust its workspace model yet.",
        icon: "exclamationmark.triangle.fill",
        tint: ADEColor.danger,
        actionTitle: "Retry",
        action: { Task { await reload(refreshRemote: true) } }
      )
    case .ready:
      return nil
    }
  }
}

private struct FileTreeDirectoryView: View {
  @EnvironmentObject private var syncService: SyncService
  let workspaceId: String
  let parentPath: String
  let isReadOnlyByDefault: Bool

  @State private var nodes: [FileTreeNode] = []
  @State private var errorMessage: String?
  @State private var isLoading = true

  var body: some View {
    List {
      if let errorMessage {
        ADENoticeCard(
          title: "Directory load failed",
          message: errorMessage,
          icon: "exclamationmark.triangle.fill",
          tint: ADEColor.danger,
          actionTitle: "Retry",
          action: { Task { await reload() } }
        )
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
      }

      if isLoading {
        ForEach(0..<4, id: \.self) { _ in
          ADECardSkeleton(rows: 2)
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
        }
      } else if nodes.isEmpty {
        ADEEmptyStateView(
          symbol: "folder",
          title: "Folder is empty",
          message: "This directory does not have any files to preview on iPhone yet."
        )
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
      }

      ForEach(nodes) { node in
        if node.type == "directory" {
          NavigationLink {
            FileTreeDirectoryView(workspaceId: workspaceId, parentPath: node.path, isReadOnlyByDefault: isReadOnlyByDefault)
          } label: {
            FileNodeRow(
              icon: "folder.fill",
              title: node.name,
              subtitle: node.path.isEmpty ? "Folder" : node.path,
              trailingText: nil,
              tint: ADEColor.accent
            )
          }
          .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button("Copy name") {
              UIPasteboard.general.string = node.name
            }
            .tint(ADEColor.accent)
          }
          .listRowBackground(Color.clear)
          .listRowSeparator(.hidden)
        } else {
          NavigationLink {
            FileEditorView(workspaceId: workspaceId, relativePath: node.path, isReadOnlyByDefault: isReadOnlyByDefault)
          } label: {
            HStack(spacing: 12) {
              FileNodeRow(
                icon: fileIcon(for: node.name),
                title: node.name,
                subtitle: node.path,
                trailingText: node.size.map(formattedFileSize),
                tint: ADEColor.textPrimary
              )
              if let changeStatus = node.changeStatus {
                ADEStatusPill(
                  text: changeStatus.prefix(1).uppercased(),
                  tint: changeStatus == "modified" ? ADEColor.warning : ADEColor.textSecondary
                )
              }
            }
          }
          .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button("Copy name") {
              UIPasteboard.general.string = node.name
            }
            .tint(ADEColor.accent)
          }
          .listRowBackground(Color.clear)
          .listRowSeparator(.hidden)
        }
      }
    }
    .listStyle(.plain)
    .scrollContentBackground(.hidden)
    .adeScreenBackground()
    .adeNavigationGlass()
    .navigationTitle(parentPath.isEmpty ? "Root" : parentPath)
    .refreshable {
      await reload()
    }
    .task {
      await reload()
    }
  }

  @MainActor
  private func reload() async {
    do {
      isLoading = true
      nodes = try await syncService.listTree(workspaceId: workspaceId, parentPath: parentPath)
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
    isLoading = false
  }
}

private struct FileEditorView: View {
  @EnvironmentObject private var syncService: SyncService
  let workspaceId: String
  let relativePath: String
  let isReadOnlyByDefault: Bool

  @State private var blob: SyncFileBlob?
  @State private var draftText = ""
  @State private var searchResults: [FilesSearchTextMatch] = []
  @State private var searchQuery = ""
  @State private var errorMessage: String?
  @State private var saveTrigger = 0

  private var isFilesLive: Bool {
    let status = syncService.status(for: .files)
    return status.phase == .ready && (syncService.connectionState == .connected || syncService.connectionState == .syncing)
  }

  var body: some View {
    List {
      if let errorMessage {
        ADENoticeCard(
          title: "File load failed",
          message: errorMessage,
          icon: "exclamationmark.triangle.fill",
          tint: ADEColor.danger,
          actionTitle: "Retry",
          action: { Task { await load() } }
        )
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
      }

      if blob == nil && errorMessage == nil {
        ADECardSkeleton(rows: 4)
          .listRowBackground(Color.clear)
          .listRowSeparator(.hidden)
      }

      if let blob {
        Section("Metadata") {
          VStack(alignment: .leading, spacing: 8) {
            Text(blob.path)
              .font(.footnote.monospaced())
              .foregroundStyle(ADEColor.textPrimary)
            Text("Size: \(blob.size) bytes")
              .font(.caption)
              .foregroundStyle(ADEColor.textSecondary)
          }
          .adeGlassCard(cornerRadius: 18)
          .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
          .listRowBackground(Color.clear)
          .listRowSeparator(.hidden)
        }

        if blob.isBinary, let data = Data(base64Encoded: blob.content), let image = UIImage(data: data) {
          Section("Preview") {
            Image(uiImage: image)
              .resizable()
              .scaledToFit()
              .adeGlassCard(cornerRadius: 18)
              .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
              .listRowBackground(Color.clear)
              .listRowSeparator(.hidden)
          }
        } else {
          Section("Editor") {
            VStack(alignment: .leading, spacing: 10) {
              if isReadOnlyByDefault {
                Text("This workspace is edit-protected on the host. The phone keeps it read-only so Files does not imply unsupported parity.")
                  .font(.caption)
                  .foregroundStyle(ADEColor.textSecondary)
              } else if !isFilesLive {
                Text("Reconnect to a live host before editing or saving file contents.")
                  .font(.caption)
                  .foregroundStyle(ADEColor.textSecondary)
              }

              TextEditor(text: $draftText)
                .font(.system(.body, design: .monospaced))
                .frame(minHeight: 260)
                .disabled(isReadOnlyByDefault || !isFilesLive)
                .adeInsetField(cornerRadius: 16, padding: 12)

              if !isReadOnlyByDefault {
                Button("Save changes") {
                  Task {
                    await save()
                  }
                }
                .buttonStyle(.glassProminent)
                .tint(ADEColor.accent)
                .disabled(!isFilesLive)
              }
            }
            .adeGlassCard(cornerRadius: 18)
            .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
          }
        }
      }

      Section("Search in workspace") {
        VStack(alignment: .leading, spacing: 10) {
          TextField("Search text", text: $searchQuery)
            .disabled(!isFilesLive)
            .adeInsetField()
            .onSubmit {
              Task {
                await searchWorkspace()
              }
            }
          if !isFilesLive {
            Text("Reconnect before running a live text search against the host workspace.")
              .font(.caption)
              .foregroundStyle(ADEColor.textSecondary)
          }
        }
        .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)

        ForEach(searchResults) { result in
          VStack(alignment: .leading, spacing: 4) {
            Text(result.path)
              .font(.caption.monospaced())
              .foregroundStyle(ADEColor.textPrimary)
            Text(result.preview)
              .font(.caption)
              .foregroundStyle(ADEColor.textSecondary)
          }
          .adeGlassCard(cornerRadius: 16, padding: 14)
          .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
          .listRowBackground(Color.clear)
          .listRowSeparator(.hidden)
        }
      }
    }
    .listStyle(.plain)
    .scrollContentBackground(.hidden)
    .adeScreenBackground()
    .adeNavigationGlass()
    .navigationTitle(relativePath)
    .sensoryFeedback(.success, trigger: saveTrigger)
    .task {
      await load()
    }
  }

  @MainActor
  private func load() async {
    do {
      let loaded = try await syncService.readFile(workspaceId: workspaceId, path: relativePath)
      blob = loaded
      if !loaded.isBinary {
        draftText = loaded.content
      }
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  private func save() async {
    guard !isReadOnlyByDefault, isFilesLive else { return }
    do {
      try await syncService.writeText(workspaceId: workspaceId, path: relativePath, text: draftText)
      saveTrigger += 1
      await load()
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  private func searchWorkspace() async {
    guard isFilesLive else {
      searchResults = []
      return
    }
    guard !searchQuery.isEmpty else {
      searchResults = []
      return
    }
    do {
      searchResults = try await syncService.searchText(workspaceId: workspaceId, query: searchQuery)
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
  }
}

private struct FilesResultRow: View {
  let path: String

  var body: some View {
    HStack(spacing: 10) {
      Image(systemName: fileIcon(for: path))
        .foregroundStyle(ADEColor.accent)
      VStack(alignment: .leading, spacing: 3) {
        Text((path as NSString).lastPathComponent)
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
        Text(path)
          .font(.caption.monospaced())
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(1)
      }
      Spacer()
      Image(systemName: "chevron.right")
        .font(.caption.weight(.semibold))
        .foregroundStyle(ADEColor.textMuted)
    }
    .adeGlassCard(cornerRadius: 16, padding: 14)
  }
}

private struct FileNodeRow: View {
  let icon: String
  let title: String
  let subtitle: String
  let trailingText: String?
  let tint: Color

  var body: some View {
    HStack(spacing: 10) {
      Image(systemName: icon)
        .foregroundStyle(tint)
      VStack(alignment: .leading, spacing: 3) {
        Text(title)
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
        Text(subtitle)
          .font(.caption.monospaced())
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(1)
      }
      Spacer()
      if let trailingText {
        Text(trailingText)
          .font(.caption2.monospaced())
          .foregroundStyle(ADEColor.textMuted)
      }
    }
    .adeGlassCard(cornerRadius: 16, padding: 14)
  }
}

// MARK: - File Helpers

func fileIcon(for name: String) -> String {
  let ext = (name as NSString).pathExtension.lowercased()
  switch ext {
  case "swift", "ts", "tsx", "js", "jsx", "py", "rb", "go", "rs", "c", "cpp", "h", "m", "java", "kt":
    return "chevron.left.forwardslash.chevron.right"
  case "json", "yaml", "yml", "toml", "xml", "plist":
    return "doc.badge.gearshape"
  case "md", "txt", "rtf":
    return "doc.text"
  case "png", "jpg", "jpeg", "gif", "svg", "webp", "heic":
    return "photo"
  case "pdf":
    return "doc.richtext"
  case "zip", "tar", "gz", "bz2":
    return "doc.zipper"
  default:
    return "doc"
  }
}

func formattedFileSize(_ bytes: Int) -> String {
  if bytes < 1024 { return "\(bytes) B" }
  if bytes < 1024 * 1024 { return "\(bytes / 1024) KB" }
  return String(format: "%.1f MB", Double(bytes) / 1048576.0)
}
