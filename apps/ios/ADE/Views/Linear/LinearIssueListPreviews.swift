import SwiftUI

#if DEBUG
// MARK: Phone Linear list fixture

/// The phone's Linear list over a fixture workspace with sub-issues (one
/// parent loaded with its children, one child whose parent is not loaded, a
/// parent with sub-issues the list did not load), PRs in every state, labels
/// with colors and an issue delegated to an agent.
struct PhoneLinearListFixture: View {
  @StateObject private var store = LinearPaneStore(sync: PhoneLinearFixtureSync())

  var body: some View {
    NavigationStack {
      LinearIssueListScreen(store: store)
        .navigationDestination(for: LinearRoute.self) { route in
          switch route {
          case let .issue(issue):
            LinearIssueDetailScreen(issue: issue, hasLane: issue.id == "p-2")
          case let .launch(issue, laneOnly):
            LinearLaunchDestination(issue: issue, laneOnly: laneOnly)
          case .connection:
            LinearConnectionScreen(store: store)
          }
        }
    }
    .tint(LinearBrand.primaryBright)
    .task { await store.start() }
  }
}

@MainActor
private final class PhoneLinearFixtureSync: LinearPaneSyncing {
  var linearConnectionStatus: LinearConnectionStatus? = LinearConnectionStatus(
    connected: true,
    viewerId: "viewer",
    viewerName: "Arul",
    organizationName: "ADE"
  )

  private static func ref(_ id: String, _ identifier: String, _ title: String, _ type: String) -> NormalizedLinearIssueChild {
    NormalizedLinearIssueChild(id: id, identifier: identifier, title: title, stateId: "s-\(type)", stateName: stateName(type), stateType: type)
  }

  private static func stateName(_ type: String) -> String {
    ["started": "In Progress", "unstarted": "Todo", "backlog": "Backlog", "completed": "Done", "canceled": "Canceled"][type] ?? "Todo"
  }

  private static func pr(_ number: Int, _ status: String, _ title: String) -> LinearIssuePullRequest {
    LinearIssuePullRequest(
      url: "https://github.com/arul28/ADE/pull/\(number)",
      number: number,
      title: title,
      status: LinearPullRequestStatus(rawValue: status) ?? .unknown,
      repo: "arul28/ADE",
      branch: "ade/fixture-\(number)"
    )
  }

  private static let colors: [String: String] = ["ios": "#5e6ad2", "bug": "#eb5757", "sync": "#4cb782", "design": "#f2994a"]

  private static func issue(
    _ id: String,
    _ number: Int,
    _ title: String,
    type: String,
    priority: Int,
    assignee: String? = nil,
    labels: [String] = [],
    parent: NormalizedLinearIssueChild? = nil,
    children: [NormalizedLinearIssueChild]? = nil,
    prs: [LinearIssuePullRequest]? = nil,
    delegate: String? = nil,
    sortOrder: Double,
    daysAgo: Double
  ) -> NormalizedLinearIssue {
    var issue = NormalizedLinearIssue(
      id: id,
      identifier: "ADE-\(number)",
      title: title,
      projectId: "p-ios",
      projectName: "iOS",
      teamId: "t-ade",
      teamKey: "ADE",
      teamName: "ADE",
      stateId: "s-\(type)",
      stateName: stateName(type),
      stateType: type,
      priority: priority,
      labels: labels,
      assigneeId: assignee == nil ? nil : "u-\(assignee!.lowercased())",
      assigneeName: assignee,
      createdAt: ISO8601DateFormatter().string(from: Date().addingTimeInterval(-86_400 * daysAgo)),
      updatedAt: ISO8601DateFormatter().string(from: Date().addingTimeInterval(-3_600 * daysAgo)),
      childIssues: children,
      parentIssue: parent
    )
    issue.number = number
    issue.pullRequests = prs
    issue.delegateId = delegate.map { "a-\($0.lowercased())" }
    issue.delegateName = delegate
    issue.sortOrder = sortOrder
    issue.subIssueSortOrder = sortOrder
    issue.labelColors = labels.map { LinearIssueLabelColor(id: "l-\($0)", name: $0, color: colors[$0]) }
    return issue
  }

  static let parent = ref("p-1", "ADE-500", "Linear list parity on the phone", "started")

  static let issues: [NormalizedLinearIssue] = [
    issue("p-1", 500, "Linear list parity on the phone", type: "started", priority: 2, assignee: "Arul", labels: ["ios", "design"],
          children: [
            ref("c-1", "ADE-501", "Group headers with counts", "completed"),
            ref("c-2", "ADE-502", "Nested sub-issues with guides", "started"),
            ref("c-3", "ADE-503", "Display menu writes back to Linear", "unstarted"),
            ref("c-9", "ADE-509", "VoiceOver labels on rings and chips", "backlog"),
          ],
          prs: [pr(2601, "open", "Phone Linear list")], sortOrder: 1, daysAgo: 2),
    issue("c-1", 501, "Group headers with counts", type: "completed", priority: 3, assignee: "Arul", labels: ["ios"], parent: parent,
          prs: [pr(2598, "merged", "Group headers")], sortOrder: 1, daysAgo: 4),
    issue("c-2", 502, "Nested sub-issues with guides", type: "started", priority: 2, assignee: "Arul", labels: ["ios"], parent: parent,
          prs: [pr(2603, "draft", "Tree guides")], delegate: "Claude", sortOrder: 2, daysAgo: 1),
    issue("c-3", 503, "Display menu writes back to Linear", type: "unstarted", priority: 3, labels: ["ios", "sync"], parent: parent,
          sortOrder: 3, daysAgo: 1),
    issue("p-2", 480, "Brain reconnect drops the CTO thread when the phone sleeps for a long time on cellular", type: "started", priority: 1,
          assignee: "Mira", labels: ["bug", "sync"],
          prs: [pr(2570, "closed", "First try"), pr(2588, "open", "Keep the thread"), pr(2590, "merged", "Retry budget")],
          sortOrder: 2, daysAgo: 6),
    issue("o-1", 611, "Sub-issue whose parent is on another page", type: "unstarted", priority: 4, assignee: "Arul",
          parent: ref("x-1", "ADE-600", "Cloud lanes epic", "started"), sortOrder: 4, daysAgo: 3),
    issue("b-1", 420, "Settings: two-column on the inner display", type: "backlog", priority: 0, labels: ["design"],
          children: [
            ref("bc-1", "ADE-421", "Left column", "completed"),
            ref("bc-2", "ADE-422", "Right column", "canceled"),
          ],
          sortOrder: 5, daysAgo: 30),
    issue("d-1", 355, "PR checks graph on phone", type: "completed", priority: 3, assignee: "Arul", labels: ["ios"],
          prs: [pr(2412, "merged", "Checks graph")], sortOrder: 6, daysAgo: 40),
  ]

  func attachedLinearIssueIds() -> Set<String> { ["p-2"] }

  func fetchLinearQuickView() async throws -> LinearQuickView {
    throw NSError(domain: "ADE", code: 17)
  }

  func fetchLinearIssuePickerData() async throws -> LinearIssuePickerData {
    LinearIssuePickerData(projects: [LinearCatalogProject(id: "p-ios", name: "iOS", color: "#5e6ad2")], users: [], states: [])
  }

  func searchLinearIssues(_ args: LinearIssueSearchArgs) async throws -> LinearIssueSearchResult {
    let term = args.query?.lowercased()
    let matched = Self.issues.filter { issue in
      (args.stateTypes == nil || args.stateTypes!.contains(issue.stateType ?? ""))
        && (term == nil || issue.title.lowercased().contains(term!) || issue.identifier.lowercased().contains(term!))
    }
    return LinearIssueSearchResult(
      issues: matched,
      pageInfo: LinearIssueSearchResultPageInfo(hasNextPage: false, endCursor: nil)
    )
  }

  /// `-linearDisplay assignee|priority|label|none|flat` picks the fixture's display.
  func fetchLinearViewPreferences(viewType: String, customViewId: String?) async throws -> LinearDisplayPreferences? {
    var preferences = LinearDisplayPreferences()
    let arguments = ProcessInfo.processInfo.arguments
    if let index = arguments.firstIndex(of: "-linearDisplay"), arguments.index(after: index) < arguments.endIndex {
      let value = arguments[arguments.index(after: index)]
      if value == "flat" {
        preferences.nesting = .none
      } else if let grouping = LinearIssueGrouping(rawValue: value) {
        preferences.grouping = grouping
      }
    }
    preferences.source = "linear-user"
    return preferences
  }

  /// Linear refuses the fixture's writes, so the "Saved in ADE only" notice shows.
  func updateLinearViewPreferences(
    viewType: String,
    customViewId: String?,
    patch: LinearDisplayPreferencesPatch
  ) async throws -> LinearViewPreferencesUpdateResult? {
    nil
  }
}
#endif
