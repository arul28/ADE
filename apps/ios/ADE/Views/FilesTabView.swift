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

  var body: some View {
    NavigationStack(path: $navigationPath) {
      List {
        if let notice = statusNotice {
          notice
            .listRowBackground(Color.clear)
        }

        if let errorMessage, filesStatus.phase == .ready {
          ADENoticeCard(
            title: "Files view error",
            message: errorMessage,
            icon: "exclamationmark.triangle.fill",
            tint: ADEPalette.danger,
            actionTitle: "Retry",
            action: { Task { await reload(refreshRemote: true) } }
          )
          .listRowBackground(Color.clear)
        }

        if !workspaces.isEmpty {
          Section("Workspace") {
            Picker("Workspace", selection: Binding(
              get: { selectedWorkspaceId ?? workspaces.first?.id ?? "" },
              set: { selectedWorkspaceId = $0 }
            )) {
              ForEach(workspaces) { workspace in
                Text(workspace.name).tag(workspace.id)
              }
            }
          }
        }

        Section("Quick open") {
          TextField("Search files", text: $searchQuery)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .disabled(!canUseLiveFileActions)
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
              .foregroundStyle(.secondary)
          } else if searchQuery.isEmpty {
            Text("Type a filename or path to search the connected workspaces.")
              .font(.caption)
              .foregroundStyle(.secondary)
          } else if quickOpenResults.isEmpty {
            Text("No matching files found.")
              .font(.caption)
              .foregroundStyle(.secondary)
          }

          if canUseLiveFileActions {
            ForEach(quickOpenResults) { item in
              NavigationLink(item.path) {
                FileEditorView(
                  workspaceId: selectedWorkspaceId ?? "",
                  relativePath: item.path,
                  isReadOnlyByDefault: selectedWorkspace?.isReadOnlyByDefault ?? true
                )
              }
            }
          }
        }

        if let workspace = selectedWorkspace {
          Section("Tree") {
            if canUseLiveFileActions {
              NavigationLink("Browse root") {
                FileTreeDirectoryView(
                  workspaceId: workspace.id,
                  parentPath: "",
                  isReadOnlyByDefault: workspace.isReadOnlyByDefault
                )
              }
            } else {
              Text(needsRepairing
                ? "Pair again before browsing the cached workspace on the host."
                : "Reconnect to browse the live workspace tree.")
                .font(.caption)
                .foregroundStyle(.secondary)
            }
          }
        }
      }
      .scrollContentBackground(.hidden)
      .background(ADEPalette.pageBackground.ignoresSafeArea())
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
        tint: ADEPalette.warning,
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
        tint: ADEPalette.accent,
        actionTitle: nil,
        action: nil
      )
    case .syncingInitialData:
      return ADENoticeCard(
        title: "Syncing initial data",
        message: "Waiting for the host to finish syncing project and lane metadata before Files hydrates.",
        icon: "arrow.trianglehead.2.clockwise.rotate.90",
        tint: ADEPalette.warning,
        actionTitle: nil,
        action: nil
      )
    case .failed:
      return ADENoticeCard(
        title: "Workspace hydration failed",
        message: filesStatus.lastError ?? "The lane graph did not hydrate, so Files cannot trust its workspace model yet.",
        icon: "exclamationmark.triangle.fill",
        tint: ADEPalette.danger,
        actionTitle: "Retry",
        action: { Task { await reload(refreshRemote: true) } }
      )
    case .ready:
      guard workspaces.isEmpty else { return nil }
      return ADENoticeCard(
        title: "No workspaces available",
        message: "This host does not currently expose any lane-backed workspaces to browse from iPhone.",
        icon: "folder.badge.questionmark",
        tint: ADEPalette.textSecondary,
        actionTitle: nil,
        action: nil
      )
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

  var body: some View {
    List {
      if let errorMessage {
        ADENoticeCard(
          title: "Directory load failed",
          message: errorMessage,
          icon: "exclamationmark.triangle.fill",
          tint: ADEPalette.danger,
          actionTitle: "Retry",
          action: { Task { await reload() } }
        )
        .listRowBackground(Color.clear)
      }
      ForEach(nodes) { node in
        if node.type == "directory" {
          NavigationLink {
            FileTreeDirectoryView(workspaceId: workspaceId, parentPath: node.path, isReadOnlyByDefault: isReadOnlyByDefault)
          } label: {
            Label(node.name, systemImage: "folder.fill")
              .foregroundStyle(ADEPalette.textPrimary)
          }
        } else {
          NavigationLink {
            FileEditorView(workspaceId: workspaceId, relativePath: node.path, isReadOnlyByDefault: isReadOnlyByDefault)
          } label: {
            HStack {
              Label(node.name, systemImage: fileIcon(for: node.name))
                .foregroundStyle(ADEPalette.textPrimary)
              Spacer()
              if let changeStatus = node.changeStatus {
                ADEStatusPill(
                  text: changeStatus.prefix(1).uppercased(),
                  tint: changeStatus == "modified" ? ADEPalette.warning : ADEPalette.textSecondary
                )
              }
              if let size = node.size {
                Text(formattedFileSize(size))
                  .font(.system(.caption2, design: .monospaced))
                  .foregroundStyle(ADEPalette.textMuted)
              }
            }
          }
        }
      }
    }
    .scrollContentBackground(.hidden)
    .background(ADEPalette.pageBackground.ignoresSafeArea())
    .navigationTitle(parentPath.isEmpty ? "Root" : parentPath)
    .task {
      await reload()
    }
    .refreshable {
      await reload()
    }
  }

  @MainActor
  private func reload() async {
    do {
      nodes = try await syncService.listTree(workspaceId: workspaceId, parentPath: parentPath)
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
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
          tint: ADEPalette.danger,
          actionTitle: "Retry",
          action: { Task { await load() } }
        )
        .listRowBackground(Color.clear)
      }

      if let blob {
        Section("Metadata") {
          Text(blob.path).font(.footnote.monospaced())
          Text("Size: \(blob.size) bytes")
            .foregroundStyle(.secondary)
        }

        if blob.isBinary, let data = Data(base64Encoded: blob.content), let image = UIImage(data: data) {
          Section("Preview") {
            Image(uiImage: image)
              .resizable()
              .scaledToFit()
          }
        } else {
          Section("Editor") {
            if isReadOnlyByDefault {
              Text("This workspace is edit-protected on the host. The phone keeps it read-only so Files does not imply unsupported parity.")
                .font(.caption)
                .foregroundStyle(.secondary)
            } else if !isFilesLive {
              Text("Reconnect to a live host before editing or saving file contents.")
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            TextEditor(text: $draftText)
              .font(.system(.body, design: .monospaced))
              .frame(minHeight: 260)
              .disabled(isReadOnlyByDefault || !isFilesLive)
            if !isReadOnlyByDefault {
              Button("Save changes") {
                Task {
                  await save()
                }
              }
              .buttonStyle(.borderedProminent)
              .disabled(!isFilesLive)
            }
          }
        }
      }

      Section("Search in workspace") {
        TextField("Search text", text: $searchQuery)
          .disabled(!isFilesLive)
          .onSubmit {
            Task {
              await searchWorkspace()
            }
          }
        if !isFilesLive {
          Text("Reconnect before running a live text search against the host workspace.")
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        ForEach(searchResults) { result in
          VStack(alignment: .leading, spacing: 4) {
            Text(result.path)
              .font(.caption.monospaced())
            Text(result.preview)
              .font(.caption)
              .foregroundStyle(.secondary)
          }
        }
      }
    }
    .scrollContentBackground(.hidden)
    .background(ADEPalette.pageBackground.ignoresSafeArea())
    .navigationTitle(relativePath)
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

// MARK: - File Helpers

private func fileIcon(for name: String) -> String {
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

private func formattedFileSize(_ bytes: Int) -> String {
  if bytes < 1024 { return "\(bytes) B" }
  if bytes < 1024 * 1024 { return "\(bytes / 1024) KB" }
  return String(format: "%.1f MB", Double(bytes) / 1048576.0)
}
