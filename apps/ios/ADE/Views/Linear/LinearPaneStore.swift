import SwiftUI

/// A group of issues sharing a workflow state, for the grouped-by-state list.
struct LinearIssueGroup: Identifiable {
  let id: String
  let title: String
  let stateType: String
  let issues: [NormalizedLinearIssue]
}

struct LinearIssueFallbackSearch: Equatable {
  let query: String
  let assignedToMe: Bool
}

func linearIssueFallbackSearch(identifier: String) -> LinearIssueFallbackSearch {
  LinearIssueFallbackSearch(query: identifier, assignedToMe: false)
}

@MainActor
protocol LinearPaneSyncing: AnyObject {
  var linearConnectionStatus: LinearConnectionStatus? { get }
  func attachedLinearIssueIds() -> Set<String>
  func fetchLinearQuickView() async throws -> LinearQuickView
  func fetchLinearIssuePickerData() async throws -> LinearIssuePickerData
  func searchLinearIssues(_ args: LinearIssueSearchArgs) async throws -> LinearIssueSearchResult
}

extension SyncService: LinearPaneSyncing {}

/// Backing store for the global Linear pane: holds the filter selection, drives
/// the `cto.searchLinearIssues` / picker / quick-view reads, and exposes issues
/// grouped by workflow state. Active-project scoped (mirrors desktop).
@MainActor
final class LinearPaneStore: ObservableObject {
  enum StatePreset: String, CaseIterable, Identifiable {
    case all, active, backlog
    var id: String { rawValue }
    var title: String {
      switch self {
      case .all: return "All"
      case .active: return "Active"
      case .backlog: return "Backlog"
      }
    }
    /// State categories sent to the host; nil = no state filter.
    var stateTypes: [String]? {
      switch self {
      case .all: return nil
      case .active: return ["backlog", "unstarted", "started"]
      case .backlog: return ["backlog"]
      }
    }
  }

  static let defaultAssignedToMe = false

  enum Phase { case idle, loading, loaded, failed }

  // Filters
  @Published var query = ""
  @Published var assignedToMe = LinearPaneStore.defaultAssignedToMe
  @Published var statePreset: StatePreset = .all
  @Published var projectId: String?
  @Published var priority: Int?

  // Data
  @Published private(set) var issues: [NormalizedLinearIssue] = []
  @Published private(set) var pickerData: LinearIssuePickerData?
  @Published private(set) var quickView: LinearQuickView?
  @Published private(set) var attachedIssueIds: Set<String> = []
  @Published private(set) var phase: Phase = .idle
  @Published private(set) var loadingMore = false
  @Published private(set) var hasNextPage = false
  @Published private(set) var errorMessage: String?

  private let pageSize = 100
  private var endCursor: String?
  private var searchGeneration = 0
  private var reloadTask: Task<Void, Never>?
  private let sync: any LinearPaneSyncing

  init(sync: any LinearPaneSyncing) {
    self.sync = sync
  }

  var viewerId: String? { quickView?.viewer?.id ?? quickView?.connection.viewerId }

  var workspaceTitle: String {
    quickView?.organization?.name
      ?? sync.linearConnectionStatus?.organizationName
      ?? "Linear"
  }

  var viewerLabel: String? {
    quickView?.viewer?.displayName ?? quickView?.connection.viewerName
  }

  /// Issues grouped by workflow state, ordered active-work-first, each group's
  /// issues left in the host's (updated-desc) order.
  var groupedIssues: [LinearIssueGroup] { linearGroupIssues(issues) }

  var projects: [LinearCatalogProject] { pickerData?.projects ?? [] }

  func projectName(for id: String?) -> String? {
    guard let id else { return nil }
    return projects.first { $0.id == id }?.name
  }

  // MARK: Loads

  /// First load when the pane opens: catalog + quick view, the attached-issue
  /// set, then every page matching the current filters.
  func start() async {
    refreshAttachedIssueIds()
    await withTaskGroup(of: Void.self) { group in
      group.addTask { await self.loadCatalog() }
      group.addTask { await self.loadQuickView() }
    }
    await reload()
  }

  func refreshAttachedIssueIds() {
    attachedIssueIds = sync.attachedLinearIssueIds()
  }

  /// Resolves a single issue by its identifier (e.g. `ENG-123`) for the deep-link
  /// jump-to-issue flow. Prefers an exact identifier match over the first result.
  func fetchIssue(identifier: String) async -> NormalizedLinearIssue? {
    var args = LinearIssueSearchArgs()
    args.query = identifier
    args.first = 10
    guard let result = try? await sync.searchLinearIssues(args) else { return nil }
    return result.issues.first { $0.identifier.caseInsensitiveCompare(identifier) == .orderedSame }
      ?? result.issues.first
  }

  private func loadCatalog() async {
    pickerData = try? await sync.fetchLinearIssuePickerData()
  }

  private func loadQuickView() async {
    quickView = try? await sync.fetchLinearQuickView()
  }

  /// Debounced reload for live filter/search changes.
  func scheduleReload() {
    reloadTask?.cancel()
    reloadTask = Task { [weak self] in
      try? await Task.sleep(nanoseconds: 250_000_000)
      if Task.isCancelled { return }
      await self?.reload()
    }
  }

  func reload() async {
    searchGeneration += 1
    let generation = searchGeneration
    endCursor = nil
    phase = .loading
    errorMessage = nil
    do {
      let result = try await loadAllPages(after: nil)
      guard generation == searchGeneration else { return }
      issues = result.issues
      endCursor = result.pageInfo.endCursor
      hasNextPage = result.pageInfo.hasNextPage
      phase = .loaded
    } catch is CancellationError {
      return
    } catch {
      guard generation == searchGeneration else { return }
      issues = []
      errorMessage = SyncUserFacingError.message(for: error)
      phase = .failed
    }
  }

  func loadMore() async {
    guard hasNextPage, !loadingMore, let cursor = endCursor else { return }
    loadingMore = true
    let generation = searchGeneration
    do {
      let result = try await loadAllPages(after: cursor)
      if generation == searchGeneration {
        issues = linearMergeIssuePages(issues, result.issues)
        endCursor = result.pageInfo.endCursor
        hasNextPage = result.pageInfo.hasNextPage
      }
    } catch is CancellationError {
      // A newer reload superseded this paging request.
    } catch {
      // Keep what we have; the row-level "Load more" affordance can retry.
    }
    loadingMore = false
  }

  func showFallbackSearch(identifier: String) {
    let fallback = linearIssueFallbackSearch(identifier: identifier)
    query = fallback.query
    assignedToMe = fallback.assignedToMe
    scheduleReload()
  }

  private func currentArgs(after: String?) -> LinearIssueSearchArgs {
    var args = LinearIssueSearchArgs()
    let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
    if !trimmed.isEmpty { args.query = trimmed }
    if assignedToMe, let viewerId, !viewerId.isEmpty { args.assigneeId = viewerId }
    args.stateTypes = statePreset.stateTypes
    args.projectId = projectId
    args.priority = priority
    args.first = pageSize
    args.after = after
    return args
  }

  private func loadAllPages(after initialCursor: String?) async throws -> LinearIssueSearchResult {
    var loaded: [NormalizedLinearIssue] = []
    var cursor = initialCursor
    var pageInfo = LinearIssueSearchResultPageInfo(hasNextPage: true, endCursor: cursor)
    var seenCursors = Set<String>()

    while pageInfo.hasNextPage {
      try Task.checkCancellation()
      if let cursor {
        guard seenCursors.insert(cursor).inserted else {
          pageInfo = LinearIssueSearchResultPageInfo(hasNextPage: false, endCursor: cursor)
          break
        }
      }
      let result = try await sync.searchLinearIssues(currentArgs(after: cursor))
      loaded = linearMergeIssuePages(loaded, result.issues)
      pageInfo = result.pageInfo
      guard pageInfo.hasNextPage else {
        break
      }
      guard let nextCursor = pageInfo.endCursor else {
        pageInfo = LinearIssueSearchResultPageInfo(hasNextPage: false, endCursor: nil)
        break
      }
      cursor = nextCursor
    }

    return LinearIssueSearchResult(issues: loaded, pageInfo: pageInfo)
  }

}

/// Rank for ordering workflow-state groups: active work first, closed last.
func linearStateRank(_ stateType: String) -> Int {
  switch linearNormalizedStateType(stateType) {
  case "started": return 0
  case "unstarted": return 1
  case "backlog": return 2
  case "triage": return 3
  case "completed": return 4
  case "canceled": return 5
  default: return 6
  }
}

/// Groups issues by workflow state (keyed by stateId, falling back to name/type),
/// preserving each group's incoming order, then orders groups active-work-first.
/// Pure — unit-tested directly.
func linearGroupIssues(_ issues: [NormalizedLinearIssue]) -> [LinearIssueGroup] {
  var order: [String] = []
  var buckets: [String: [NormalizedLinearIssue]] = [:]
  var titles: [String: String] = [:]
  var types: [String: String] = [:]
  for issue in issues {
    let key = issue.stateId ?? issue.stateName ?? issue.stateType ?? "unknown"
    if buckets[key] == nil {
      order.append(key)
      titles[key] = issue.stateName ?? issue.stateType?.capitalized ?? "Other"
      types[key] = issue.stateType ?? "unstarted"
    }
    buckets[key, default: []].append(issue)
  }
  return order
    .map { key in
      LinearIssueGroup(id: key, title: titles[key] ?? "Other", stateType: types[key] ?? "unstarted", issues: buckets[key] ?? [])
    }
    .sorted { lhs, rhs in
      let l = linearStateRank(lhs.stateType)
      let r = linearStateRank(rhs.stateType)
      if l != r { return l < r }
      return (order.firstIndex(of: lhs.id) ?? 0) < (order.firstIndex(of: rhs.id) ?? 0)
    }
}

func linearMergeIssuePages(_ current: [NormalizedLinearIssue], _ next: [NormalizedLinearIssue]) -> [NormalizedLinearIssue] {
  var seen = Set<String>()
  var merged: [NormalizedLinearIssue] = []
  merged.reserveCapacity(current.count + next.count)
  for issue in current + next {
    guard seen.insert(issue.id).inserted else { continue }
    merged.append(issue)
  }
  return merged
}

func linearGroupCollapsedByDefault(stateType: String) -> Bool {
  linearNormalizedStateType(stateType) == "completed"
}
