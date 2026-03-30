import SwiftUI

@Observable
class FileSearchViewModel {
  var quickOpenQuery = ""
  var quickOpenResults: [FilesQuickOpenItem] = []
  var textSearchQuery = ""
  var textSearchResults: [FilesSearchTextMatch] = []
  var searchErrorMessage: String?
  var retryToken = 0
  private var quickOpenRequestToken = 0
  private var textSearchRequestToken = 0

  @MainActor
  func runQuickOpenSearch(syncService: SyncService, workspaceId: String?, canUseLiveFileActions: Bool) async {
    guard canUseLiveFileActions else {
      quickOpenResults = []
      return
    }
    guard let workspaceId else {
      quickOpenResults = []
      return
    }
    let query = quickOpenQuery.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !query.isEmpty else {
      quickOpenResults = []
      return
    }

    quickOpenRequestToken += 1
    let requestToken = quickOpenRequestToken
    do {
      try await Task.sleep(nanoseconds: 250_000_000)
    } catch {
      return
    }
    guard
      !Task.isCancelled,
      requestToken == quickOpenRequestToken,
      query == quickOpenQuery.trimmingCharacters(in: .whitespacesAndNewlines)
    else { return }

    do {
      let results = try await syncService.quickOpen(workspaceId: workspaceId, query: query)
      guard !Task.isCancelled, requestToken == quickOpenRequestToken else { return }
      quickOpenResults = results
      searchErrorMessage = nil
    } catch {
      guard !Task.isCancelled, requestToken == quickOpenRequestToken else { return }
      searchErrorMessage = error.localizedDescription
      quickOpenResults = []
    }
  }

  @MainActor
  func runTextSearch(syncService: SyncService, workspaceId: String?, canUseLiveFileActions: Bool) async {
    guard canUseLiveFileActions else {
      textSearchResults = []
      return
    }
    guard let workspaceId else {
      textSearchResults = []
      return
    }
    let query = textSearchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !query.isEmpty else {
      textSearchResults = []
      return
    }

    textSearchRequestToken += 1
    let requestToken = textSearchRequestToken
    do {
      try await Task.sleep(nanoseconds: 250_000_000)
    } catch {
      return
    }
    guard
      !Task.isCancelled,
      requestToken == textSearchRequestToken,
      query == textSearchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
    else { return }

    do {
      let results = try await syncService.searchText(workspaceId: workspaceId, query: query)
      guard !Task.isCancelled, requestToken == textSearchRequestToken else { return }
      textSearchResults = results
      searchErrorMessage = nil
    } catch {
      guard !Task.isCancelled, requestToken == textSearchRequestToken else { return }
      searchErrorMessage = error.localizedDescription
      textSearchResults = []
    }
  }

  func quickOpenEmptyMessage(canUseLiveFileActions: Bool, needsRepairing: Bool) -> String {
    if !canUseLiveFileActions {
      return needsRepairing
        ? "Pair again before searching or opening files."
        : "Quick open needs a live host connection."
    }
    if quickOpenQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      return "Type a filename or path to fuzzy-search the workspace."
    }
    return "No matching files found."
  }

  func textSearchEmptyMessage(canUseLiveFileActions: Bool, needsRepairing: Bool) -> String {
    if !canUseLiveFileActions {
      return needsRepairing
        ? "Pair again before searching workspace contents."
        : "Workspace search needs a live host connection."
    }
    if textSearchQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      return "Search across the current workspace and preview matching lines."
    }
    return "No matches found."
  }

  func clear() {
    quickOpenResults = []
    textSearchResults = []
  }
}
