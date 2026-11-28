import Foundation

// MARK: - Grouping, ordering and nesting (pure)

/// Rank for ordering workflow-state groups, the desktop list's order:
/// triage, started, unstarted, backlog, then completed and canceled.
func linearStateRank(_ stateType: String) -> Int {
  if stateType.lowercased() == "duplicate" { return 6 }
  switch linearNormalizedStateType(stateType) {
  case "triage": return 0
  case "started": return 1
  case "unstarted": return 2
  case "backlog": return 3
  case "completed": return 4
  case "canceled": return 5
  default: return 7
  }
}

/// Linear's open workflow-state categories, in the list's order.
let linearOpenStateTypes = ["triage", "started", "unstarted", "backlog"]

/// State categories to ask the brain for. With "Show completed issues" off,
/// closed categories are left out on the server, so every page holds open
/// work and later pages are never stranded behind hidden rows. The list still
/// filters closed issues as a safety net (older brains ignore the filter).
func linearStateTypesToRequest(_ stateTypes: [String]?, showCompletedIssues: Bool) -> [String]? {
  guard !showCompletedIssues else { return stateTypes }
  guard let stateTypes, !stateTypes.isEmpty else { return linearOpenStateTypes }
  let open = stateTypes.filter { !linearIsClosedState($0) }
  return open.isEmpty ? linearOpenStateTypes : open
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

/// Completed, canceled and duplicate issues are closed (the shared rule).
func linearIsClosedState(_ stateType: String?) -> Bool {
  if stateType?.lowercased() == "duplicate" { return true }
  let type = linearNormalizedStateType(stateType)
  return type == "completed" || type == "canceled"
}

/// The direction an ordering reads best in when first picked (the shared
/// convention): Urgent first for priority, newest first for dates, soonest
/// first for due dates, A to Z for titles.
func linearNaturalDirection(for ordering: LinearIssueOrdering) -> String {
  switch ordering {
  case .priority, .updatedAt, .createdAt, .estimate: return "desc"
  case .manual, .dueDate, .title: return "asc"
  }
}

struct LinearIssueGroupsBuild {
  let groups: [LinearIssueGroup]
  let hiddenGroupCount: Int
  let hiddenCompletedCount: Int
}

/// One pass over the loaded issues, the way the desktop list builds it: drop
/// closed issues when they are hidden, put every issue in its group(s), order
/// each group, then nest sub-issues under a parent in the same group. A
/// sub-issue whose parent sits in another group (or was not loaded) stays at
/// the top of its own group with a parent hint. Cycles in bad data break into
/// top-level rows.
func linearBuildIssueGroups(
  _ allIssues: [NormalizedLinearIssue],
  preferences: LinearDisplayPreferences
) -> LinearIssueGroupsBuild {
  let visible = preferences.showCompletedIssues
    ? allIssues
    : allIssues.filter { !linearIsClosedState($0.stateType) }
  let hiddenCompletedCount = allIssues.count - visible.count

  var loadedIds = Set<String>()
  var issues: [NormalizedLinearIssue] = []
  issues.reserveCapacity(visible.count)
  for issue in visible {
    if loadedIds.insert(issue.id).inserted { issues.append(issue) }
  }

  // Every loaded sub-issue counts toward its parent's ring, nested or not.
  var loadedChildIds: [String: Set<String>] = [:]
  var loadedStateById: [String: String?] = [:]
  for issue in allIssues {
    loadedStateById[issue.id] = issue.stateType
    if let parentId = issue.parentIssue?.id, parentId != issue.id {
      loadedChildIds[parentId, default: []].insert(issue.id)
    }
  }

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

  // Group keys for an issue (a label grouping puts an issue in each of its
  // labels' groups). `hideIds` are Linear's ids for the group, which is what
  // `hiddenGroups` holds: a workflow state id, a user, project, label, cycle,
  // milestone or team id, or "0".."4" for a priority. "No X" groups use ADE's
  // own keys (`assignee:none`, ...), which are their `id`.
  struct GroupKey {
    let id: String
    let hideIds: [String]
    let title: String
    let stateType: String
    let icon: LinearGroupIcon
    let sortRank: Int
    let isEmptyBucket: Bool
  }

  struct LabelEntry {
    let id: String?
    let name: String
    let color: String?
  }

  func keys(for issue: NormalizedLinearIssue) -> [GroupKey] {
    switch preferences.grouping {
    case .workflowState:
      let id = issue.stateId ?? issue.stateName ?? issue.stateType ?? "unknown"
      let type = issue.stateType ?? "unstarted"
      return [GroupKey(
        id: id,
        hideIds: issue.stateId.map { [$0] } ?? [],
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
        hideIds: [String(value)],
        title: linearPriorityLabel(value) ?? "No priority",
        stateType: "unstarted",
        icon: .priority(value),
        sortRank: linearPriorityRank(value),
        isEmptyBucket: false
      )]
    case .assignee:
      guard let id = issue.assigneeId, !id.isEmpty else {
        return [GroupKey(id: "assignee:none", hideIds: [], title: "No assignee", stateType: "unstarted", icon: .person(name: nil, avatarUrl: nil), sortRank: 0, isEmptyBucket: true)]
      }
      let name = issue.assigneeName ?? "Someone"
      return [GroupKey(id: id, hideIds: [id], title: name, stateType: "unstarted", icon: .person(name: name, avatarUrl: issue.assigneeAvatarUrl), sortRank: 0, isEmptyBucket: false)]
    case .project:
      guard let id = issue.projectId, !id.isEmpty else {
        return [GroupKey(id: "project:none", hideIds: [], title: "No project", stateType: "unstarted", icon: .project(color: nil), sortRank: 0, isEmptyBucket: true)]
      }
      return [GroupKey(id: id, hideIds: [id], title: issue.projectName ?? "Project", stateType: "unstarted", icon: .project(color: nil), sortRank: 0, isEmptyBucket: false)]
    case .cycle:
      guard let id = issue.cycleId, !id.isEmpty else {
        return [GroupKey(id: "cycle:none", hideIds: [], title: "No cycle", stateType: "unstarted", icon: .cycle, sortRank: 0, isEmptyBucket: true)]
      }
      return [GroupKey(id: id, hideIds: [id], title: issue.cycleName ?? "Cycle", stateType: "unstarted", icon: .cycle, sortRank: 0, isEmptyBucket: false)]
    case .projectMilestone:
      guard let id = issue.projectMilestoneId, !id.isEmpty else {
        return [GroupKey(id: "milestone:none", hideIds: [], title: "No milestone", stateType: "unstarted", icon: .milestone, sortRank: 0, isEmptyBucket: true)]
      }
      return [GroupKey(id: id, hideIds: [id], title: issue.projectMilestoneName ?? "Milestone", stateType: "unstarted", icon: .milestone, sortRank: 0, isEmptyBucket: false)]
    case .team:
      let id = issue.teamId ?? issue.teamKey ?? "team:none"
      let title = issue.teamName ?? issue.teamKey ?? "No team"
      return [GroupKey(
        id: id,
        hideIds: issue.teamId.map { [$0] } ?? [],
        title: title,
        stateType: "unstarted",
        icon: .team,
        sortRank: 0,
        isEmptyBucket: issue.teamId == nil && issue.teamKey == nil
      )]
    case .label:
      // Labels with ids (newer brains) first; older answers carry names only.
      var entries: [LabelEntry] = (issue.labelColors ?? []).compactMap { label in
        guard let name = label.name, !name.isEmpty else { return nil }
        return LabelEntry(id: label.id, name: name, color: label.color)
      }
      if entries.isEmpty {
        entries = (issue.labels ?? []).filter { !$0.isEmpty }.map { LabelEntry(id: nil, name: $0, color: nil) }
      }
      guard !entries.isEmpty else {
        return [GroupKey(id: "label:none", hideIds: [], title: "No label", stateType: "unstarted", icon: .label(color: nil), sortRank: 0, isEmptyBucket: true)]
      }
      var seen = Set<String>()
      return entries.compactMap { entry in
        let id = entry.id ?? "label:\(entry.name)"
        guard seen.insert(id).inserted else { return nil }
        return GroupKey(
          id: id,
          hideIds: entry.id.map { [$0] } ?? [],
          title: entry.name,
          stateType: "unstarted",
          icon: .label(color: entry.color),
          sortRank: 0,
          isEmptyBucket: false
        )
      }
    case .none:
      return [GroupKey(id: "all", hideIds: [], title: "Issues", stateType: "unstarted", icon: .none, sortRank: 0, isEmptyBucket: false)]
    }
  }

  // Group first: every issue (parent or sub-issue) lands in its own group(s).
  var order: [String] = []
  var keyById: [String: GroupKey] = [:]
  var issuesByGroup: [String: [NormalizedLinearIssue]] = [:]
  for issue in issues {
    for key in keys(for: issue) {
      if keyById[key.id] == nil {
        order.append(key.id)
        keyById[key.id] = key
      }
      issuesByGroup[key.id, default: []].append(issue)
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
    if hidden.contains(key.id) || key.hideIds.contains(where: { hidden.contains($0) }) {
      hiddenGroupCount += 1
      continue
    }
    let bucket = issuesByGroup[key.id] ?? []
    var inBucket: [String: NormalizedLinearIssue] = [:]
    for issue in bucket { inBucket[issue.id] = issue }

    // Nest under a parent only when it sits in this same group, and following
    // parents up from it (inside the group) never comes back to this issue.
    func nestedParentId(of issue: NormalizedLinearIssue) -> String? {
      guard preferences.nesting.nests,
            let parentId = issue.parentIssue?.id,
            parentId != issue.id,
            inBucket[parentId] != nil else { return nil }
      var seen: Set<String> = [issue.id]
      var cursor: String? = parentId
      while let current = cursor {
        if seen.contains(current) { return nil }
        seen.insert(current)
        guard let next = inBucket[current] else { break }
        cursor = next.parentIssue?.id
      }
      return parentId
    }

    var childrenByParent: [String: [NormalizedLinearIssue]] = [:]
    var roots: [NormalizedLinearIssue] = []
    for issue in bucket {
      if let parentId = nestedParentId(of: issue) {
        childrenByParent[parentId, default: []].append(issue)
      } else {
        roots.append(issue)
      }
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
          !loadedIds.contains(ref.id)
            && ref.id != issue.id
            && seenRefs.insert(ref.id).inserted
            && (preferences.showCompletedIssues || !linearIsClosedState(ref.stateType))
        }
      }
      let total = children.count + context.count
      // A top-level row names its parent (in another group or not loaded).
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
    for root in ordered(roots, asSubIssues: false) {
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
    // Descending (Linear's natural direction) is Urgent first, No priority last.
    let x = 4 - linearPriorityRank(a.priority), y = 4 - linearPriorityRank(b.priority)
    if x == y { return compareOptional(a.sortOrder, b.sortOrder, ascending: true) }
    return ascending ? x < y : x > y
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
