import OSLog
import SwiftUI

private let linearPaneLog = Logger(subsystem: "com.ade.ios", category: "linear")

/// What a group header draws in front of its title.
enum LinearGroupIcon: Hashable {
  case state(String)
  case priority(Int)
  case person(name: String?, avatarUrl: String?)
  case project(color: String?)
  case label(color: String?)
  case cycle
  case milestone
  case team
  case none
}

/// A group of issues for the list (by status, assignee, project, …), with the
/// rows to draw in display order: parents, their sub-issues nested under them,
/// and muted context rows for sub-issues the list did not load.
struct LinearIssueGroup: Identifiable {
  let id: String
  let title: String
  /// The workflow-state category for status groups; "unstarted" otherwise.
  let stateType: String
  /// Every loaded issue the group shows (parents and nested sub-issues).
  let issues: [NormalizedLinearIssue]
  var icon: LinearGroupIcon = .none
  var rows: [LinearIssueListRow] = []
  /// True for the single headerless group of "No grouping".
  var isUngrouped = false
}

/// Sub-issue progress for a parent: `done` of `total` sub-issues closed.
/// `capped` means Linear's list read stopped at its sub-issue limit, so there
/// may be more than `total`.
struct LinearSubIssueProgress: Hashable {
  let done: Int
  let total: Int
  let capped: Bool
}

/// One row of the issue list.
struct LinearIssueListRow: Identifiable {
  enum Kind {
    case issue(NormalizedLinearIssue)
    /// A sub-issue Linear lists under a loaded parent that this list did not
    /// load (filtered out or on a later page). Drawn muted, not tappable.
    case context(NormalizedLinearIssueChild)
  }

  let id: String
  let kind: Kind
  /// 0 for a top-level row, 1 for a sub-issue, 2 for its sub-issue, …
  let depth: Int
  /// For each ancestor level above the row's own (1..<depth): whether that
  /// level's vertical guide keeps going past this row.
  let guides: [Bool]
  /// Whether the row is its parent's last sub-issue (the guide ends here).
  let isLastSibling: Bool
  /// Whether sub-issue rows follow directly under this one.
  var hasChildRows = false
  let progress: LinearSubIssueProgress?
  /// A sub-issue shown without its parent above it: the parent it belongs to.
  let parentHint: NormalizedLinearIssueChild?

  var issue: NormalizedLinearIssue? {
    if case .issue(let issue) = kind { return issue }
    return nil
  }
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
  /// Issue pages one load reads at most.
  var linearMaxPagesPerLoad: Int { get }
  /// The person's Linear display settings, or nil when nobody can read them.
  func fetchLinearViewPreferences(viewType: String, customViewId: String?) async throws -> LinearDisplayPreferences?
  /// Writes a display change to Linear, or nil when nobody can write it.
  func updateLinearViewPreferences(
    viewType: String,
    customViewId: String?,
    patch: LinearDisplayPreferencesPatch
  ) async throws -> LinearViewPreferencesUpdateResult?
}

extension LinearPaneSyncing {
  var linearMaxPagesPerLoad: Int { 10 }

  func fetchLinearViewPreferences(viewType: String, customViewId: String?) async throws -> LinearDisplayPreferences? {
    nil
  }

  func updateLinearViewPreferences(
    viewType: String,
    customViewId: String?,
    patch: LinearDisplayPreferencesPatch
  ) async throws -> LinearViewPreferencesUpdateResult? {
    nil
  }
}

extension SyncService: LinearPaneSyncing {}

/// Backing store for the global Linear pane: holds the filter selection and the
/// person's Linear display settings, drives the `cto.searchLinearIssues` /
/// picker / quick-view reads, and exposes the issues grouped, ordered and
/// nested the way Linear shows them. Active-project scoped (mirrors desktop).
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
    /// State categories sent to the host; nil = no state filter. Active is
    /// Linear's: Todo and In Progress, with Backlog on its own tab.
    var stateTypes: [String]? {
      switch self {
      case .all: return nil
      case .active: return ["unstarted", "started"]
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
  @Published private(set) var issues: [NormalizedLinearIssue] = [] {
    didSet { rebuildGroups() }
  }
  @Published private(set) var pickerData: LinearIssuePickerData?
  @Published private(set) var quickView: LinearQuickView?
  @Published private(set) var attachedIssueIds: Set<String> = []
  @Published private(set) var phase: Phase = .idle
  @Published private(set) var loadingMore = false
  @Published private(set) var hasNextPage = false
  /// The last "load more" failed or brought no new issue, so the list footer
  /// waits for a tap instead of paging again on its own.
  @Published private(set) var loadMoreStalled = false
  @Published private(set) var errorMessage: String?

  // Display (Linear's own view preferences)
  @Published private(set) var displayPreferences: LinearDisplayPreferences = .linearDefault {
    didSet { rebuildGroups() }
  }
  /// Set when Linear did not store the last Display change ("Saved in ADE only").
  @Published private(set) var displaySaveNotice: String?
  /// Issues grouped, ordered and nested for the list. Rebuilt in one pass when
  /// the issues or the display settings change, never per row or per render.
  @Published private(set) var groupedIssues: [LinearIssueGroup] = []
  /// Groups Linear's display settings hide (`hiddenGroups`) that had issues.
  @Published private(set) var hiddenGroupCount = 0
  /// Loaded issues the list hides because completed issues are turned off.
  @Published private(set) var hiddenCompletedCount = 0

  private let pageSize = 100
  private let maxPagesPerRequest = 10
  private var endCursor: String?
  private var searchGeneration = 0
  private var reloadTask: Task<Void, Never>?
  private let sync: any LinearPaneSyncing
  /// The view type whose display settings `displayPreferences` holds.
  private var preferencesViewType: String?
  /// Display settings changed on this phone this session, per view type, so a
  /// change Linear refused survives switching tabs and back.
  private var sessionPreferences: [String: LinearDisplayPreferences] = [:]
  private var preferencesWriteGeneration = 0

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

  var projects: [LinearCatalogProject] { pickerData?.projects ?? [] }

  func projectName(for id: String?) -> String? {
    guard let id else { return nil }
    return projects.first { $0.id == id }?.name
  }

  /// Linear's view type for the current tab: "My issues" when only the
  /// person's issues show, else the state tab.
  var viewType: String {
    if assignedToMe { return "myIssues" }
    switch statePreset {
    case .all: return "allIssues"
    case .active: return "activeIssues"
    case .backlog: return "backlog"
    }
  }

  /// True when no search or filter narrows the list.
  var hasNoFilters: Bool {
    query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      && !assignedToMe && statePreset == .all && projectId == nil && priority == nil
  }

  // MARK: Loads

  /// First load when the pane opens: catalog + quick view, the attached-issue
  /// set, the display settings, then every page matching the current filters.
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
    loadMoreStalled = false
    phase = .loading
    errorMessage = nil
    // The display settings come first: their order decides which issues the
    // first pages bring.
    await loadDisplayPreferencesIfNeeded()
    guard generation == searchGeneration else { return }
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
        let countBefore = issues.count
        issues = linearMergeIssuePages(issues, result.issues)
        endCursor = result.pageInfo.endCursor
        hasNextPage = result.pageInfo.hasNextPage
        loadMoreStalled = issues.count <= countBefore
      }
    } catch is CancellationError {
      // A newer reload superseded this paging request.
    } catch {
      // Keep what we have; the footer shows a "Load more" button to retry.
      if generation == searchGeneration { loadMoreStalled = true }
      linearPaneLog.notice("linear load_more failed error=\(CrashReporting.redactedErrorDescription(error), privacy: .public)")
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
    args.stateTypes = linearStateTypesToRequest(statePreset.stateTypes, showCompletedIssues: displayPreferences.showCompletedIssues)
    args.projectId = projectId
    args.priority = priority
    args.first = pageSize
    args.after = after
    // Manual is sent too, so the first pages bring Linear's own order. An
    // older brain ignores these.
    args.ordering = displayPreferences.ordering.rawValue
    args.orderingDirection = displayPreferences.orderingDirection
    return args
  }

  private func loadAllPages(after initialCursor: String?) async throws -> LinearIssueSearchResult {
    var loaded: [NormalizedLinearIssue] = []
    var cursor = initialCursor
    var pageInfo = LinearIssueSearchResultPageInfo(hasNextPage: true, endCursor: cursor)
    var seenCursors = Set<String>()
    var pagesLoaded = 0

    while pageInfo.hasNextPage && pagesLoaded < min(maxPagesPerRequest, sync.linearMaxPagesPerLoad) {
      try Task.checkCancellation()
      if let cursor {
        guard seenCursors.insert(cursor).inserted else {
          pageInfo = LinearIssueSearchResultPageInfo(hasNextPage: false, endCursor: cursor)
          break
        }
      }
      let result = try await sync.searchLinearIssues(currentArgs(after: cursor))
      pagesLoaded += 1
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

  // MARK: Display settings

  /// Reads Linear's display settings when the tab's view type changed since
  /// the last read. A change made on this phone this session wins; with no
  /// answer (older brain, the account path, an error) Linear's defaults hold.
  private func loadDisplayPreferencesIfNeeded() async {
    let type = viewType
    guard preferencesViewType != type else { return }
    preferencesViewType = type
    if let session = sessionPreferences[type] {
      displayPreferences = session
      return
    }
    let fetched: LinearDisplayPreferences?
    do {
      fetched = try await sync.fetchLinearViewPreferences(viewType: type, customViewId: nil)
    } catch {
      linearPaneLog.notice("linear display_read failed; using defaults error=\(CrashReporting.redactedErrorDescription(error), privacy: .public)")
      fetched = nil
    }
    // A newer tab switch already moved on; its own read decides.
    guard preferencesViewType == type, sessionPreferences[type] == nil else { return }
    displayPreferences = fetched ?? .linearDefault
    displaySaveNotice = nil
  }

  /// Applies a Display menu change now, then writes it to Linear. When Linear
  /// does not store it, the change stays for this session with a quiet notice.
  func updateDisplay(_ patch: LinearDisplayPreferencesPatch) {
    let type = viewType
    let previousOrdering = displayPreferences.ordering
    let previousDirection = displayPreferences.orderingDirection
    let previousShowCompleted = displayPreferences.showCompletedIssues
    var next = displayPreferences
    if let grouping = patch.grouping { next.grouping = grouping }
    if let ordering = patch.ordering { next.ordering = ordering }
    if let direction = patch.orderingDirection { next.orderingDirection = direction }
    if let nesting = patch.nesting { next.nesting = nesting }
    if let showCompleted = patch.showCompletedIssues { next.showCompletedIssues = showCompleted }
    if let hiddenGroups = patch.hiddenGroups { next.hiddenGroups = hiddenGroups }
    guard next != displayPreferences else { return }
    preferencesViewType = type
    sessionPreferences[type] = next
    displayPreferences = next
    // Closed issues are left out on the server, so turning them on or off
    // reloads. Otherwise only a partial list needs the server's new order; a
    // complete one re-sorts in place.
    if next.showCompletedIssues != previousShowCompleted {
      scheduleReload()
    } else if hasNextPage, next.ordering != previousOrdering || next.orderingDirection != previousDirection {
      scheduleReload()
    }

    preferencesWriteGeneration += 1
    let generation = preferencesWriteGeneration
    Task { [weak self] in
      guard let self else { return }
      let result: LinearViewPreferencesUpdateResult?
      do {
        result = try await self.sync.updateLinearViewPreferences(viewType: type, customViewId: nil, patch: patch)
      } catch {
        linearPaneLog.notice("linear display_write failed; kept for this session error=\(CrashReporting.redactedErrorDescription(error), privacy: .public)")
        result = nil
      }
      // A later change owns the notice.
      guard generation == self.preferencesWriteGeneration else { return }
      if let result, result.savedToLinear {
        self.displaySaveNotice = nil
        // Linear's stored copy, unless the tab moved on meanwhile.
        if self.viewType == type {
          self.sessionPreferences[type] = nil
          self.displayPreferences = result.preferences
        }
      } else {
        self.displaySaveNotice = "Saved in \(Brand.name) only"
      }
    }
  }

  /// Shows every group the display settings hide (writes `hiddenGroups: []`).
  func showAllGroups() {
    updateDisplay(LinearDisplayPreferencesPatch(hiddenGroups: []))
  }

  private func rebuildGroups() {
    let built = linearBuildIssueGroups(issues, preferences: displayPreferences)
    groupedIssues = built.groups
    hiddenGroupCount = built.hiddenGroupCount
    hiddenCompletedCount = built.hiddenCompletedCount
  }
}
