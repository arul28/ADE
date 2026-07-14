import SwiftUI
import UIKit

/// Content matches for one file, grouped VS Code-style so a file with many
/// hits collapses to a single header row with a count.
struct FilesSearchContentGroup: Identifiable, Equatable {
  var id: String { path }
  let path: String
  let matches: [FilesSearchTextMatch]
}

/// Unified file search, presented as a dedicated page from the Files tab.
///
/// Mirrors the desktop `SearchOverlay`: a single query searches file *names*
/// (quick open) and file *contents* (text search) at once. Name matches surface
/// first under "Files"; content hits are grouped by file with line previews.
/// Tapping a name opens the file; tapping a content line opens it at that line.
struct FilesSearchScreen: View {
  let workspace: FilesWorkspace
  let isLive: Bool
  let needsRepairing: Bool
  let onOpenFile: (_ path: String, _ focusLine: Int?) -> Void

  @EnvironmentObject private var syncService: SyncService
  @Environment(\.dismiss) private var dismiss
  @FocusState private var searchFieldFocused: Bool

  @State private var query = ""
  @State private var fileResults: [FilesQuickOpenItem] = []
  @State private var contentGroups: [FilesSearchContentGroup] = []
  @State private var collapsedGroups: Set<String> = []
  @State private var isSearching = false
  @State private var errorMessage: String?

  private var trimmedQuery: String {
    query.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private var searchKey: FilesSearchKey {
    FilesSearchKey(workspaceId: workspace.id, query: trimmedQuery, isLive: isLive)
  }

  private var totalMatches: Int {
    contentGroups.reduce(0) { $0 + $1.matches.count }
  }

  private var hasResults: Bool {
    !fileResults.isEmpty || !contentGroups.isEmpty
  }

  var body: some View {
    NavigationStack {
      Group {
        if !isLive || trimmedQuery.isEmpty {
          centered(promptState)
        } else if hasResults {
          resultsList
        } else if isSearching {
          centered(searchingState)
        } else if let errorMessage {
          centered(
            ADEEmptyStateView(
              symbol: "exclamationmark.triangle.fill",
              title: "Search failed",
              message: errorMessage
            )
          )
        } else {
          centered(
            ADEEmptyStateView(
              symbol: "doc.text.magnifyingglass",
              title: "No matches",
              message: "Nothing in \(workspace.name) matched “\(trimmedQuery)”."
            )
          )
        }
      }
      .adeScreenBackground()
      .navigationTitle("Search files")
      .adeAnalyticsScreen(.fileSearch)
      .navigationBarTitleDisplayMode(.inline)
      .adeNavigationGlass()
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button("Done") { dismiss() }
            .fontWeight(.semibold)
        }
      }
      .searchable(
        text: $query,
        placement: .navigationBarDrawer(displayMode: .always),
        prompt: "Search by name or content"
      )
      .searchFocused($searchFieldFocused)
      .autocorrectionDisabled()
      .textInputAutocapitalization(.never)
      .submitLabel(.search)
    }
    .task(id: searchKey) {
      await runSearch()
    }
    .task {
      // Raise the keyboard on the search field once the page settles in.
      try? await Task.sleep(nanoseconds: 280_000_000)
      guard !Task.isCancelled else { return }
      searchFieldFocused = true
    }
  }

  // MARK: - Results

  private var resultsList: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 10) {
        summaryRow

        if !fileResults.isEmpty {
          sectionHeader("Files")
          ForEach(fileResults) { item in
            Button {
              open(path: item.path, line: nil)
            } label: {
              FilesResultRow(
                workspaceId: workspace.id,
                path: item.path,
                transitionNamespace: nil,
                isSelectedTransitionSource: false
              )
            }
            .buttonStyle(.plain)
            .contextMenu {
              Button("Copy Full Path") {
                UIPasteboard.general.string = filesFullPath(rootPath: workspace.rootPath, relativePath: item.path)
              }
              Button("Copy Relative Path") {
                UIPasteboard.general.string = item.path
              }
            }
          }
        }

        if !contentGroups.isEmpty {
          sectionHeader("In files")
            .padding(.top, fileResults.isEmpty ? 0 : 6)
          ForEach(contentGroups) { group in
            FilesSearchContentGroupView(
              group: group,
              workspaceRootPath: workspace.rootPath,
              isCollapsed: collapsedGroups.contains(group.path),
              onToggle: { toggleGroup(group.path) },
              onOpenLine: { line in open(path: group.path, line: line) }
            )
          }
        }
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 12)
    }
    .scrollDismissesKeyboard(.interactively)
    .scrollBounceBehavior(.basedOnSize)
  }

  private var summaryRow: some View {
    HStack(spacing: 6) {
      Text(pluralized(fileResults.count, "file", "files"))
      Text("·")
      Text(pluralized(totalMatches, "match", "matches"))
      if isSearching {
        ProgressView()
          .controlSize(.mini)
          .padding(.leading, 2)
      }
      Spacer(minLength: 0)
    }
    .font(.caption.weight(.medium).monospacedDigit())
    .foregroundStyle(ADEColor.textMuted)
    .padding(.horizontal, 4)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(fileResults.count) files, \(totalMatches) matches")
  }

  private func sectionHeader(_ text: String) -> some View {
    Text(text.uppercased())
      .font(.caption2.weight(.bold))
      .tracking(0.6)
      .foregroundStyle(ADEColor.textMuted)
      .padding(.horizontal, 4)
      .frame(maxWidth: .infinity, alignment: .leading)
  }

  // MARK: - Empty / loading states

  private var promptState: some View {
    ADEEmptyStateView(
      symbol: isLive ? "magnifyingglass" : "wifi.slash",
      title: isLive ? "Search this workspace" : "Search unavailable",
      message: filesSearchEmptyMessage(isLive: isLive, needsRepairing: needsRepairing)
    )
  }

  private var searchingState: some View {
    VStack(spacing: 12) {
      ProgressView()
        .controlSize(.large)
        .tint(ADEColor.accent)
      Text("Searching \(workspace.name)…")
        .font(.subheadline)
        .foregroundStyle(ADEColor.textSecondary)
    }
  }

  private func pluralized(_ count: Int, _ singular: String, _ plural: String) -> String {
    "\(count) \(count == 1 ? singular : plural)"
  }

  private func centered<Content: View>(_ content: Content) -> some View {
    VStack {
      Spacer(minLength: 0)
      content
      Spacer(minLength: 0)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .padding(.horizontal, 16)
  }

  // MARK: - Actions

  private func toggleGroup(_ path: String) {
    if collapsedGroups.contains(path) {
      collapsedGroups.remove(path)
    } else {
      collapsedGroups.insert(path)
    }
  }

  private func open(path: String, line: Int?) {
    searchFieldFocused = false
    onOpenFile(path, line)
    dismiss()
  }

  @MainActor
  private func runSearch() async {
    guard isLive else {
      resetResults()
      return
    }
    let q = trimmedQuery
    guard !q.isEmpty else {
      resetResults()
      return
    }

    isSearching = true
    // Debounce keystrokes so each one doesn't fire a round-trip — matches the
    // desktop overlay's 140ms settle before searching.
    try? await Task.sleep(nanoseconds: 140_000_000)
    guard !Task.isCancelled, trimmedQuery == q, isLive else { return }

    do {
      async let files = syncService.quickOpen(
        workspaceId: workspace.id, query: q, limit: 30, includeIgnored: true
      )
      async let matches = syncService.searchText(
        workspaceId: workspace.id, query: q, limit: 300, includeIgnored: true
      )
      let (fileItems, contentMatches) = try await (files, matches)
      guard !Task.isCancelled, trimmedQuery == q, isLive else { return }
      fileResults = fileItems
      contentGroups = groupMatches(contentMatches)
      // Collapse state annotates the previous result set; start each fresh
      // result set fully expanded so stale collapses don't bleed across queries.
      if !collapsedGroups.isEmpty { collapsedGroups = [] }
      errorMessage = nil
      isSearching = false
    } catch {
      guard !Task.isCancelled, trimmedQuery == q else { return }
      fileResults = []
      contentGroups = []
      errorMessage = error.localizedDescription
      isSearching = false
    }
  }

  private func resetResults() {
    if !fileResults.isEmpty { fileResults = [] }
    if !contentGroups.isEmpty { contentGroups = [] }
    if !collapsedGroups.isEmpty { collapsedGroups = [] }
    if isSearching { isSearching = false }
    if errorMessage != nil { errorMessage = nil }
  }

  private func groupMatches(_ matches: [FilesSearchTextMatch]) -> [FilesSearchContentGroup] {
    var order: [String] = []
    var byPath: [String: [FilesSearchTextMatch]] = [:]
    for match in matches {
      if byPath[match.path] == nil {
        order.append(match.path)
      }
      byPath[match.path, default: []].append(match)
    }
    return order.map { FilesSearchContentGroup(path: $0, matches: byPath[$0] ?? []) }
  }
}

/// A collapsible file group of content matches, each row a line number + preview.
private struct FilesSearchContentGroupView: View {
  let group: FilesSearchContentGroup
  let workspaceRootPath: String
  let isCollapsed: Bool
  let onToggle: () -> Void
  let onOpenLine: (Int) -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Button(action: onToggle) {
        HStack(spacing: 10) {
          Image(systemName: isCollapsed ? "chevron.right" : "chevron.down")
            .font(.caption2.weight(.bold))
            .foregroundStyle(ADEColor.textMuted)
            .frame(width: 12)

          Image(systemName: fileIcon(for: group.path))
            .font(.subheadline)
            .foregroundStyle(fileTint(for: group.path))

          VStack(alignment: .leading, spacing: 2) {
            Text(lastPathComponent(group.path))
              .font(.subheadline.weight(.semibold))
              .foregroundStyle(ADEColor.textPrimary)
              .lineLimit(1)
              .truncationMode(.tail)
            Text(group.path)
              .font(.caption2.monospaced())
              .foregroundStyle(ADEColor.textSecondary)
              .lineLimit(1)
              .truncationMode(.middle)
          }

          Spacer(minLength: 8)

          Text("\(group.matches.count)")
            .font(.caption2.weight(.bold).monospacedDigit())
            .foregroundStyle(ADEColor.textSecondary)
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background(ADEColor.recessedBackground, in: Capsule())
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .contextMenu {
        Button("Copy Full Path") {
          UIPasteboard.general.string = filesFullPath(rootPath: workspaceRootPath, relativePath: group.path)
        }
        Button("Copy Relative Path") {
          UIPasteboard.general.string = group.path
        }
      }
      .accessibilityLabel("\(lastPathComponent(group.path)), \(group.matches.count) matches")
      .accessibilityHint(isCollapsed ? "Expands matches" : "Collapses matches")

      if !isCollapsed {
        VStack(spacing: 0) {
          ForEach(group.matches) { match in
            Button {
              onOpenLine(match.line)
            } label: {
              HStack(alignment: .top, spacing: 10) {
                Text("\(match.line)")
                  .font(.caption2.monospacedDigit())
                  .foregroundStyle(ADEColor.textMuted)
                  .frame(minWidth: 30, alignment: .trailing)
                Text(match.preview.trimmingCharacters(in: .whitespaces))
                  .font(.caption.monospaced())
                  .foregroundStyle(ADEColor.textPrimary)
                  .lineLimit(2)
                  .truncationMode(.tail)
                  .frame(maxWidth: .infinity, alignment: .leading)
              }
              .padding(.horizontal, 12)
              .padding(.vertical, 7)
              .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Line \(match.line), \(match.preview.trimmingCharacters(in: .whitespaces))")
          }
        }
        .padding(.bottom, 6)
      }
    }
    .adeGlassCard(cornerRadius: 16, padding: 0)
  }
}
