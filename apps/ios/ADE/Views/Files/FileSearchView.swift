import Observation
import SwiftUI

enum FilesSearchMode: String, CaseIterable, Identifiable {
  case filenames
  case contents

  var id: String { rawValue }

  var title: String {
    switch self {
    case .filenames: return "Names"
    case .contents: return "Content"
    }
  }
}

struct FilesWorkspaceCompactBar: View {
  let workspaces: [FilesWorkspace]
  @Binding var selectedWorkspaceId: String
  let selectedWorkspace: FilesWorkspace

  var body: some View {
    Menu {
      Picker("Workspace", selection: $selectedWorkspaceId) {
        ForEach(workspaces) { workspace in
          Text(workspace.name).tag(workspace.id)
        }
      }
    } label: {
      VStack(alignment: .leading, spacing: 10) {
        HStack(alignment: .top, spacing: 12) {
          VStack(alignment: .leading, spacing: 4) {
            Text(selectedWorkspace.name)
              .font(.headline)
              .foregroundStyle(ADEColor.textPrimary)
              .lineLimit(1)
            Text(selectedWorkspace.rootPath)
              .font(.caption.monospaced())
              .foregroundStyle(ADEColor.textSecondary)
              .lineLimit(1)
              .textSelection(.enabled)
          }

          Spacer(minLength: 0)

          Image(systemName: "chevron.up.chevron.down")
            .font(.caption.weight(.semibold))
            .foregroundStyle(ADEColor.textMuted)
        }

        ADEGlassGroup(spacing: 8) {
          ADEStatusPill(text: selectedWorkspace.kind.uppercased(), tint: ADEColor.accent)
          if selectedWorkspace.isReadOnlyByDefault {
            ADEStatusPill(text: "READ ONLY", tint: ADEColor.warning)
          }
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(14)
      .background(ADEColor.surfaceBackground.opacity(0.65), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
      .glassEffect(in: .rect(cornerRadius: 18))
    }
    .accessibilityLabel("\(selectedWorkspace.name). \(selectedWorkspace.rootPath). Switch workspace.")
  }
}

struct FilesSearchSheetView: View {
  @Environment(\.dismiss) private var dismiss
  @Bindable var searchViewModel: FileSearchViewModel

  let workspace: FilesWorkspace
  let canUseLiveFileActions: Bool
  let needsRepairing: Bool
  let openFile: (String, Int?) -> Void

  @State private var mode: FilesSearchMode = .filenames

  private var activeQueryBinding: Binding<String> {
    switch mode {
    case .filenames:
      return $searchViewModel.quickOpenQuery
    case .contents:
      return $searchViewModel.textSearchQuery
    }
  }

  private var activeResultsCount: Int {
    switch mode {
    case .filenames:
      return searchViewModel.quickOpenResults.count
    case .contents:
      return searchViewModel.textSearchResults.count
    }
  }

  private var emptyMessage: String {
    switch mode {
    case .filenames:
      return searchViewModel.quickOpenEmptyMessage(canUseLiveFileActions: canUseLiveFileActions, needsRepairing: needsRepairing)
    case .contents:
      return searchViewModel.textSearchEmptyMessage(canUseLiveFileActions: canUseLiveFileActions, needsRepairing: needsRepairing)
    }
  }

  private var searchErrorMessage: String? {
    searchViewModel.searchErrorMessage
  }

  var body: some View {
    NavigationStack {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 16) {
          searchScopeCard
          modePicker
          searchQueryCard
          if let searchErrorMessage {
            ADENoticeCard(
              title: "Search failed",
              message: searchErrorMessage,
              icon: "exclamationmark.triangle.fill",
              tint: ADEColor.danger,
              actionTitle: "Try again",
              action: {
                searchViewModel.searchErrorMessage = nil
                searchViewModel.retryToken += 1
              }
            )
          }
          searchResults
        }
        .padding(16)
      }
      .navigationTitle("Search")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button("Done") { dismiss() }
        }
      }
      .background(ADEColor.pageBackground)
    }
  }

  @ViewBuilder
  private var searchScopeCard: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .top, spacing: 12) {
        Image(systemName: "magnifyingglass")
          .font(.system(size: 15, weight: .semibold))
          .foregroundStyle(ADEColor.accent)
          .frame(width: 32, height: 32)
          .background(ADEColor.accent.opacity(0.16), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
          .glassEffect(in: .rect(cornerRadius: 12))

        VStack(alignment: .leading, spacing: 4) {
          Text(workspace.name)
            .font(.headline)
            .foregroundStyle(ADEColor.textPrimary)
          Text(workspace.rootPath)
            .font(.caption.monospaced())
            .foregroundStyle(ADEColor.textSecondary)
            .lineLimit(1)
            .textSelection(.enabled)
        }

        Spacer(minLength: 0)
      }

      HStack(spacing: 8) {
        ADEStatusPill(text: workspace.kind.uppercased(), tint: ADEColor.accent)
        if workspace.isReadOnlyByDefault {
          ADEStatusPill(text: "READ ONLY", tint: ADEColor.warning)
        } else if !canUseLiveFileActions {
          ADEStatusPill(text: "OFFLINE", tint: ADEColor.warning)
        }
      }

      Text(canUseLiveFileActions ? "Search is live against the current workspace." : offlineSearchMessage)
        .font(.caption)
        .foregroundStyle(ADEColor.textSecondary)
        .fixedSize(horizontal: false, vertical: true)
    }
    .adeGlassCard(cornerRadius: 18)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(workspace.name). \(workspace.rootPath).")
  }

  private var offlineSearchMessage: String {
    needsRepairing
      ? "Pair again before searching files or contents."
      : "Reconnect the host before searching files or contents."
  }

  private var modePicker: some View {
    Picker("Search mode", selection: $mode) {
      ForEach(FilesSearchMode.allCases) { item in
        Text(item.title).tag(item)
      }
    }
    .pickerStyle(.segmented)
    .accessibilityLabel("Search mode")
  }

  private var searchQueryCard: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text(mode == .filenames ? "Search filenames" : "Search contents")
        .font(.headline)
        .foregroundStyle(ADEColor.textPrimary)
      TextField(mode == .filenames ? "Search files" : "Search text", text: activeQueryBinding)
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .disabled(!canUseLiveFileActions)
        .adeInsetField()
      Text(emptyMessage)
        .font(.caption)
        .foregroundStyle(ADEColor.textSecondary)
        .fixedSize(horizontal: false, vertical: true)
    }
    .adeGlassCard(cornerRadius: 18)
  }

  @ViewBuilder
  private var searchResults: some View {
    if !canUseLiveFileActions {
      ADEEmptyStateView(
        symbol: "icloud.slash",
        title: "Search unavailable",
        message: offlineSearchMessage
      )
    } else if activeResultsCount == 0 {
      ADEEmptyStateView(
        symbol: mode == .filenames ? "doc.text.magnifyingglass" : "text.magnifyingglass",
        title: mode == .filenames ? "No files found" : "No matches found",
        message: emptyMessage
      )
    } else {
      LazyVStack(spacing: 10) {
        switch mode {
        case .filenames:
          ForEach(searchViewModel.quickOpenResults) { item in
            Button {
              openFile(item.path, nil)
              dismiss()
            } label: {
              FilesFilenameSearchResultRow(item: item)
            }
            .buttonStyle(.plain)
          }
        case .contents:
          ForEach(searchViewModel.textSearchResults) { item in
            Button {
              openFile(item.path, item.line)
              dismiss()
            } label: {
              FilesContentSearchResultRow(result: item)
            }
            .buttonStyle(.plain)
          }
        }
      }
    }
  }
}

struct FilesFilenameSearchResultRow: View {
  let item: FilesQuickOpenItem

  var body: some View {
    HStack(spacing: 12) {
      Image(systemName: fileIcon(for: item.path))
        .font(.headline)
        .foregroundStyle(fileTint(for: item.path))
        .frame(width: 22)

      VStack(alignment: .leading, spacing: 4) {
        Text(lastPathComponent(item.path))
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
        Text(item.path)
          .font(.caption.monospaced())
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(1)
      }

      Spacer(minLength: 0)

      Image(systemName: "chevron.right")
        .font(.caption.weight(.semibold))
        .foregroundStyle(ADEColor.textMuted)
    }
    .adeListCard(cornerRadius: 16)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(lastPathComponent(item.path)), \(item.path)")
  }
}

struct FilesContentSearchResultRow: View {
  let result: FilesSearchTextMatch

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 12) {
        Image(systemName: fileIcon(for: result.path))
          .font(.headline)
          .foregroundStyle(fileTint(for: result.path))
          .frame(width: 22)

        VStack(alignment: .leading, spacing: 4) {
          Text(lastPathComponent(result.path))
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(1)
          Text(result.path)
            .font(.caption.monospaced())
            .foregroundStyle(ADEColor.textSecondary)
            .lineLimit(1)
        }

        Spacer(minLength: 0)

        ADEStatusPill(text: "L\(result.line)", tint: ADEColor.accent)
      }

      Text(result.preview)
        .font(.caption)
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(2)
    }
    .adeListCard(cornerRadius: 16)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(lastPathComponent(result.path)), line \(result.line)")
  }
}

#Preview("Workspace bar") {
  VStack {
    FilesWorkspaceCompactBar(
      workspaces: [
        FilesWorkspace(id: "workspace-1", kind: "lane", laneId: "lane-1", name: "Mobile Files", rootPath: "/Projects/Mobile Files", isReadOnlyByDefault: false),
        FilesWorkspace(id: "workspace-2", kind: "lane", laneId: "lane-2", name: "Read Only", rootPath: "/Projects/Read Only", isReadOnlyByDefault: true),
      ],
      selectedWorkspaceId: .constant("workspace-1"),
      selectedWorkspace: FilesWorkspace(id: "workspace-1", kind: "lane", laneId: "lane-1", name: "Mobile Files", rootPath: "/Projects/Mobile Files", isReadOnlyByDefault: false)
    )
    .padding()
    Spacer()
  }
  .background(ADEColor.pageBackground)
}

#Preview("Search results") {
  VStack(spacing: 12) {
    FilesFilenameSearchResultRow(
      item: FilesQuickOpenItem(path: "Sources/App/FilesTabView.swift", score: 99)
    )
    FilesContentSearchResultRow(
      result: FilesSearchTextMatch(path: "Sources/App/FilesTabView.swift", line: 42, column: 3, preview: "let showHidden = UserDefaults.standard.bool(forKey: \"ade.files.showHidden\")")
    )
  }
  .padding()
  .background(ADEColor.pageBackground)
}
