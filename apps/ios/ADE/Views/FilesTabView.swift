import SwiftUI
import UIKit

struct FilesTabView: View {
  @EnvironmentObject private var syncService: SyncService
  @State private var workspaces: [FilesWorkspace] = []
  @State private var selectedWorkspaceId: String?
  @State private var searchQuery = ""
  @State private var quickOpenResults: [FilesQuickOpenItem] = []
  @State private var errorMessage: String?

  var body: some View {
    NavigationStack {
      List {
        if let errorMessage {
          Section {
            Text(errorMessage)
              .foregroundStyle(.red)
          }
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
            .onSubmit {
              Task {
                await runQuickOpen()
              }
            }

          ForEach(quickOpenResults) { item in
            NavigationLink(item.path) {
              FileEditorView(workspaceId: selectedWorkspaceId ?? "", relativePath: item.path)
            }
          }
        }

        if let workspaceId = selectedWorkspaceId {
          Section("Tree") {
            NavigationLink("Browse root") {
              FileTreeDirectoryView(workspaceId: workspaceId, parentPath: "")
            }
          }
        }
      }
      .navigationTitle("Files")
      .refreshable {
        await reload()
      }
      .task {
        await reload()
      }
      .task(id: syncService.localStateRevision) {
        await reload()
      }
    }
  }

  @MainActor
  private func reload() async {
    do {
      workspaces = try await syncService.listWorkspaces()
      selectedWorkspaceId = selectedWorkspaceId ?? workspaces.first?.id
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  private func runQuickOpen() async {
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
}

private struct FileTreeDirectoryView: View {
  @EnvironmentObject private var syncService: SyncService
  let workspaceId: String
  let parentPath: String

  @State private var nodes: [FileTreeNode] = []
  @State private var errorMessage: String?

  var body: some View {
    List {
      if let errorMessage {
        Text(errorMessage).foregroundStyle(.red)
      }
      ForEach(nodes) { node in
        if node.type == "directory" {
          NavigationLink(node.name) {
            FileTreeDirectoryView(workspaceId: workspaceId, parentPath: node.path)
          }
        } else {
          NavigationLink(node.name) {
            FileEditorView(workspaceId: workspaceId, relativePath: node.path)
          }
        }
      }
    }
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

  @State private var blob: SyncFileBlob?
  @State private var draftText = ""
  @State private var searchResults: [FilesSearchTextMatch] = []
  @State private var searchQuery = ""
  @State private var errorMessage: String?

  var body: some View {
    List {
      if let errorMessage {
        Text(errorMessage).foregroundStyle(.red)
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
            TextEditor(text: $draftText)
              .font(.system(.body, design: .monospaced))
              .frame(minHeight: 260)
            Button("Save changes") {
              Task {
                await save()
              }
            }
            .buttonStyle(.borderedProminent)
          }
        }
      }

      Section("Search in workspace") {
        TextField("Search text", text: $searchQuery)
          .onSubmit {
            Task {
              await searchWorkspace()
            }
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
    do {
      try await syncService.writeText(workspaceId: workspaceId, path: relativePath, text: draftText)
      await load()
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  private func searchWorkspace() async {
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
