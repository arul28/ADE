import SwiftUI

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
  @Published private(set) var issues: [NormalizedLinearIssue] = [] {
    didSet { rebuildGroups() }
  }
  @Published private(set) var pickerData: LinearIssuePickerData?
  @Published private(set) var quickView: LinearQuickView?
  @Published private(set) var attachedIssueIds: Set<String> = []
  @Published private(set) var phase: Phase = .idle
  @Published private(set) var loadingMore = false
  @Published private(set) var hasNextPage = false
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
    // Linear's default (manual) needs no sort; an older brain ignores these.
    if displayPreferences.ordering != .manual {
      args.ordering = displayPreferences.ordering.rawValue
      args.orderingDirection = displayPreferences.orderingDirection
    }
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
    let fetched = try? await sync.fetchLinearViewPreferences(viewType: type, customViewId: nil)
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
    var next = displayPreferences
    if let grouping = patch.grouping { next.grouping = grouping }
    if let ordering = patch.ordering { next.ordering = ordering }
    if let direction = patch.orderingDirection { next.orderingDirection = direction }
    if let nesting = patch.nesting { next.nesting = nesting }
    if let showCompleted = patch.showCompletedIssues { next.showCompletedIssues = showCompleted }
    guard next != displayPreferences else { return }
    preferencesViewType = type
    sessionPreferences[type] = next
    displayPreferences = next
    // Only a partial list needs the server's new order; a complete one
    // re-sorts in place.
    if hasNextPage, next.ordering != previousOrdering || next.orderingDirection != previousDirection {
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
        self.displaySaveNotice = "Saved in ADE only"
      }
    }
  }

  private func rebuildGroups() {
    let built = linearBuildIssueGroups(issues, preferences: displayPreferences)
    groupedIssues = built.groups
    hiddenGroupCount = built.hiddenGroupCount
    hiddenCompletedCount = built.hiddenCompletedCount
  }
}

// MARK: - Grouping, ordering and nesting (pure)

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

/// Linear's priority order: Urgent, High, Medium, Low, then No priority.
func linearPriorityRank(_ priority: Int?) -> Int {
  switch priority ?? 0 {
  case 1: return 0
  case 2: return 1
  case 3: return 2
  case 4: return 3
  default: return 4
  }
}

func linearIsClosedState(_ stateType: String?) -> Bool {
  let type = linearNormalizedStateType(stateType)
  return type == "completed" || type == "canceled"
}

/// The direction an ordering reads best in when first picked: newest first
/// for dates, soonest first for due dates, A to Z for titles.
func linearNaturalDirection(for ordering: LinearIssueOrdering) -> String {
  switch ordering {
  case .updatedAt, .createdAt, .estimate: return "desc"
  case .manual, .priority, .dueDate, .title: return "asc"
  }
}

/// Groups issues by workflow state with Linear's defaults (sub-issues nested).
/// Kept for callers that only need the status grouping.
func linearGroupIssues(_ issues: [NormalizedLinearIssue]) -> [LinearIssueGroup] {
  linearBuildIssueGroups(issues, preferences: .linearDefault).groups
}

struct LinearIssueGroupsBuild {
  let groups: [LinearIssueGroup]
  let hiddenGroupCount: Int
  let hiddenCompletedCount: Int
}

/// One pass over the loaded issues: drop closed issues when they are hidden,
/// find each issue's parent among the loaded ones (cycles in bad data break
/// into top-level rows), group the top-level issues, order each group, and
/// lay out every parent's sub-issues under it with tree guides.
func linearBuildIssueGroups(
  _ allIssues: [NormalizedLinearIssue],
  preferences: LinearDisplayPreferences
) -> LinearIssueGroupsBuild {
  let issues = preferences.showCompletedIssues
    ? allIssues
    : allIssues.filter { !linearIsClosedState($0.stateType) }
  let hiddenCompletedCount = allIssues.count - issues.count

  var indexById: [String: Int] = [:]
  for (index, issue) in issues.enumerated() where indexById[issue.id] == nil {
    indexById[issue.id] = index
  }

  // Effective parent: the parent is loaded, and following parents up from it
  // never comes back to this issue.
  func effectiveParentId(of issue: NormalizedLinearIssue) -> String? {
    guard preferences.nesting.nests,
          let parentId = issue.parentIssue?.id,
          parentId != issue.id,
          indexById[parentId] != nil else { return nil }
    var seen: Set<String> = [issue.id]
    var cursor: String? = parentId
    while let current = cursor {
      if seen.contains(current) { return nil }
      seen.insert(current)
      guard let index = indexById[current] else { break }
      cursor = issues[index].parentIssue?.id
    }
    return parentId
  }

  var childrenByParent: [String: [NormalizedLinearIssue]] = [:]
  var loadedChildIds: [String: Set<String>] = [:]
  var roots: [NormalizedLinearIssue] = []
  for (index, issue) in issues.enumerated() where indexById[issue.id] == index {
    if let parentId = effectiveParentId(of: issue) {
      childrenByParent[parentId, default: []].append(issue)
    } else {
      roots.append(issue)
    }
  }
  // Every loaded sub-issue counts toward its parent's ring, nested or not.
  for issue in allIssues {
    if let parentId = issue.parentIssue?.id, parentId != issue.id {
      loadedChildIds[parentId, default: []].insert(issue.id)
    }
  }
  var loadedStateById: [String: String?] = [:]
  for issue in allIssues { loadedStateById[issue.id] = issue.stateType }

  func progress(for issue: NormalizedLinearIssue) -> LinearSubIssueProgress? {
    let refs = issue.childIssues ?? []
    var ids = Set(refs.map(\.id))
    ids.formUnion(loadedChildIds[issue.id] ?? [])
    ids.remove(issue.id)
    guard !ids.isEmpty else { return nil }
    var refState: [String: String?] = [:]
    for ref in refs { refState[ref.id] = ref.stateType }
    let done = ids.filter { id in
      // The loaded issue is fresher than the parent's copy of it.
      let state: String?
      if let loaded = loadedStateById[id] {
        state = loaded
      } else {
        state = refState[id].flatMap { $0 }
      }
      return linearIsClosedState(state)
    }.count
    // Linear's list read returns at most 25 sub-issues per parent.
    return LinearSubIssueProgress(done: done, total: ids.count, capped: refs.count >= 25)
  }

  // Ordering inside a group (and among a parent's sub-issues).
  let ordering = preferences.ordering
  let ascending = preferences.orderingDirection.lowercased() != "desc"
  func ordered(_ list: [NormalizedLinearIssue], asSubIssues: Bool) -> [NormalizedLinearIssue] {
    let indexed = list.enumerated().map { ($0.offset, $0.element) }
    return indexed.sorted { lhs, rhs in
      let a = lhs.1, b = rhs.1
      if let result = linearCompare(a, b, ordering: ordering, ascending: ascending, asSubIssues: asSubIssues) {
        return result
      }
      return lhs.0 < rhs.0
    }.map { $0.1 }
  }

  // Group keys for a top-level issue (a label grouping puts an issue in each
  // of its labels' groups).
  struct GroupKey {
    let id: String
    let title: String
    let stateType: String
    let icon: LinearGroupIcon
    let sortRank: Int
    let isEmptyBucket: Bool
  }

  func keys(for issue: NormalizedLinearIssue) -> [GroupKey] {
    switch preferences.grouping {
    case .workflowState:
      let id = issue.stateId ?? issue.stateName ?? issue.stateType ?? "unknown"
      let type = issue.stateType ?? "unstarted"
      return [GroupKey(
        id: id,
        title: issue.stateName ?? issue.stateType?.capitalized ?? "Other",
        stateType: type,
        icon: .state(type),
        sortRank: linearStateRank(type),
        isEmptyBucket: false
      )]
    case .priority:
      let value = issue.priority ?? 0
      return [GroupKey(
        id: "priority:\(value)",
        title: linearPriorityLabel(value) ?? "No priority",
        stateType: "unstarted",
        icon: .priority(value),
        sortRank: linearPriorityRank(value),
        isEmptyBucket: false
      )]
    case .assignee:
      guard let id = issue.assigneeId, !id.isEmpty else {
        return [GroupKey(id: "assignee:none", title: "No assignee", stateType: "unstarted", icon: .person(name: nil, avatarUrl: nil), sortRank: 0, isEmptyBucket: true)]
      }
      let name = issue.assigneeName ?? "Someone"
      return [GroupKey(id: id, title: name, stateType: "unstarted", icon: .person(name: name, avatarUrl: issue.assigneeAvatarUrl), sortRank: 0, isEmptyBucket: false)]
    case .project:
      guard let id = issue.projectId, !id.isEmpty else {
        return [GroupKey(id: "project:none", title: "No project", stateType: "unstarted", icon: .project(color: nil), sortRank: 0, isEmptyBucket: true)]
      }
      return [GroupKey(id: id, title: issue.projectName ?? "Project", stateType: "unstarted", icon: .project(color: nil), sortRank: 0, isEmptyBucket: false)]
    case .cycle:
      guard let id = issue.cycleId, !id.isEmpty else {
        return [GroupKey(id: "cycle:none", title: "No cycle", stateType: "unstarted", icon: .cycle, sortRank: 0, isEmptyBucket: true)]
      }
      return [GroupKey(id: id, title: issue.cycleName ?? "Cycle", stateType: "unstarted", icon: .cycle, sortRank: 0, isEmptyBucket: false)]
    case .projectMilestone:
      guard let id = issue.projectMilestoneId, !id.isEmpty else {
        return [GroupKey(id: "milestone:none", title: "No milestone", stateType: "unstarted", icon: .milestone, sortRank: 0, isEmptyBucket: true)]
      }
      return [GroupKey(id: id, title: issue.projectMilestoneName ?? "Milestone", stateType: "unstarted", icon: .milestone, sortRank: 0, isEmptyBucket: false)]
    case .team:
      let id = issue.teamId ?? issue.teamKey ?? "team:none"
      let title = issue.teamName ?? issue.teamKey ?? "No team"
      return [GroupKey(id: id, title: title, stateType: "unstarted", icon: .team, sortRank: 0, isEmptyBucket: issue.teamId == nil && issue.teamKey == nil)]
    case .label:
      let names = (issue.labels ?? []).filter { !$0.isEmpty }
      guard !names.isEmpty else {
        return [GroupKey(id: "label:none", title: "No label", stateType: "unstarted", icon: .label(color: nil), sortRank: 0, isEmptyBucket: true)]
      }
      var seen = Set<String>()
      return names.compactMap { name in
        guard seen.insert(name).inserted else { return nil }
        let color = issue.labelColors?.first { $0.name == name }?.color
        return GroupKey(id: "label:\(name)", title: name, stateType: "unstarted", icon: .label(color: color), sortRank: 0, isEmptyBucket: false)
      }
    case .none:
      return [GroupKey(id: "all", title: "Issues", stateType: "unstarted", icon: .none, sortRank: 0, isEmptyBucket: false)]
    }
  }

  var order: [String] = []
  var keyById: [String: GroupKey] = [:]
  var rootsByGroup: [String: [NormalizedLinearIssue]] = [:]
  for root in roots {
    for key in keys(for: root) {
      if keyById[key.id] == nil {
        order.append(key.id)
        keyById[key.id] = key
      }
      rootsByGroup[key.id, default: []].append(root)
    }
  }

  let firstSeen = Dictionary(uniqueKeysWithValues: order.enumerated().map { ($0.element, $0.offset) })
  let sortedKeys = order.compactMap { keyById[$0] }.sorted { lhs, rhs in
    if lhs.isEmptyBucket != rhs.isEmptyBucket { return !lhs.isEmptyBucket }
    if lhs.sortRank != rhs.sortRank { return lhs.sortRank < rhs.sortRank }
    switch preferences.grouping {
    case .workflowState, .priority, .none:
      break
    default:
      let byTitle = lhs.title.localizedStandardCompare(rhs.title)
      if byTitle != .orderedSame { return byTitle == .orderedAscending }
    }
    return (firstSeen[lhs.id] ?? 0) < (firstSeen[rhs.id] ?? 0)
  }

  let hidden = Set(preferences.hiddenGroups)
  var hiddenGroupCount = 0
  let showContextRows = preferences.nesting == .showAll
  var groups: [LinearIssueGroup] = []
  for key in sortedKeys {
    if hidden.contains(key.id) {
      hiddenGroupCount += 1
      continue
    }
    var rows: [LinearIssueListRow] = []
    var members: [NormalizedLinearIssue] = []

    func emit(_ issue: NormalizedLinearIssue, depth: Int, guides: [Bool], isLast: Bool, visited: inout Set<String>) {
      guard visited.insert(issue.id).inserted else { return }
      let children = ordered(childrenByParent[issue.id] ?? [], asSubIssues: true)
        .filter { !visited.contains($0.id) }
      var context: [NormalizedLinearIssueChild] = []
      if showContextRows {
        var seenRefs = Set<String>()
        context = (issue.childIssues ?? []).filter { ref in
          indexById[ref.id] == nil
            && ref.id != issue.id
            && seenRefs.insert(ref.id).inserted
            && (preferences.showCompletedIssues || !linearIsClosedState(ref.stateType))
        }
      }
      let total = children.count + context.count
      // A row's parent is drawn above it only when it is nested.
      let hint: NormalizedLinearIssueChild? = depth > 0 ? nil : issue.parentIssue
      rows.append(LinearIssueListRow(
        id: "\(key.id)|\(issue.id)",
        kind: .issue(issue),
        depth: depth,
        guides: guides,
        isLastSibling: isLast,
        hasChildRows: total > 0,
        progress: progress(for: issue),
        parentHint: hint
      ))
      members.append(issue)

      let childGuides = depth == 0 ? [] : guides + [!isLast]
      for (offset, child) in children.enumerated() {
        emit(child, depth: depth + 1, guides: childGuides, isLast: offset == total - 1, visited: &visited)
      }
      for (offset, ref) in context.enumerated() {
        rows.append(LinearIssueListRow(
          id: "\(key.id)|\(issue.id)|ref|\(ref.id)",
          kind: .context(ref),
          depth: depth + 1,
          guides: childGuides,
          isLastSibling: children.count + offset == total - 1,
          progress: nil,
          parentHint: nil
        ))
      }
    }

    var visited = Set<String>()
    for root in ordered(rootsByGroup[key.id] ?? [], asSubIssues: false) {
      emit(root, depth: 0, guides: [], isLast: true, visited: &visited)
    }
    groups.append(LinearIssueGroup(
      id: key.id,
      title: key.title,
      stateType: key.stateType,
      issues: members,
      icon: key.icon,
      rows: rows,
      isUngrouped: preferences.grouping == .none
    ))
  }

  return LinearIssueGroupsBuild(groups: groups, hiddenGroupCount: hiddenGroupCount, hiddenCompletedCount: hiddenCompletedCount)
}

/// Compares two issues for an ordering. Nil means "tied" (keep the incoming
/// order). Missing values (no due date, no estimate) always sort last.
func linearCompare(
  _ a: NormalizedLinearIssue,
  _ b: NormalizedLinearIssue,
  ordering: LinearIssueOrdering,
  ascending: Bool,
  asSubIssues: Bool
) -> Bool? {
  func compareOptional<T: Comparable>(_ x: T?, _ y: T?, ascending: Bool) -> Bool? {
    switch (x, y) {
    case (nil, nil): return nil
    case (nil, _): return false
    case (_, nil): return true
    case let (x?, y?):
      if x == y { return nil }
      return ascending ? x < y : x > y
    }
  }

  switch ordering {
  case .manual:
    let x = asSubIssues ? (a.subIssueSortOrder ?? a.sortOrder) : a.sortOrder
    let y = asSubIssues ? (b.subIssueSortOrder ?? b.sortOrder) : b.sortOrder
    return compareOptional(x, y, ascending: true)
  case .priority:
    let x = linearPriorityRank(a.priority), y = linearPriorityRank(b.priority)
    if x == y { return compareOptional(a.sortOrder, b.sortOrder, ascending: true) }
    return x < y
  case .updatedAt:
    return compareOptional(issueISODate(a.updatedAt), issueISODate(b.updatedAt), ascending: ascending)
  case .createdAt:
    return compareOptional(issueISODate(a.createdAt), issueISODate(b.createdAt), ascending: ascending)
  case .dueDate:
    return compareOptional(linearDueDate(a.dueDate), linearDueDate(b.dueDate), ascending: ascending)
  case .estimate:
    return compareOptional(a.estimate, b.estimate, ascending: ascending)
  case .title:
    let result = a.title.localizedStandardCompare(b.title)
    if result == .orderedSame { return nil }
    return ascending ? result == .orderedAscending : result == .orderedDescending
  }
}

private let linearDueDateParser: DateFormatter = {
  let formatter = DateFormatter()
  formatter.locale = Locale(identifier: "en_US_POSIX")
  formatter.timeZone = TimeZone(identifier: "UTC")
  formatter.dateFormat = "yyyy-MM-dd"
  return formatter
}()

/// Linear due dates are plain days (`2026-11-30`); older rows may carry a
/// full timestamp.
func linearDueDate(_ raw: String?) -> Date? {
  guard let raw, !raw.isEmpty else { return nil }
  return linearDueDateParser.date(from: String(raw.prefix(10))) ?? issueISODate(raw)
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
  let type = linearNormalizedStateType(stateType)
  return type == "completed" || type == "canceled"
}
