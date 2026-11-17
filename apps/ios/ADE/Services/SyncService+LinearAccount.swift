import Foundation

// The Linear pane with no computer to ask: the account server reads Linear
// with the project's own Linear connection (`POST
// /cloud/integrations/linear/query`, fixed reads only) and the phone turns
// Linear's answers into the shapes the pane already draws. The phone never
// holds a Linear token. Writes (state, comments, launches) still go to a
// computer. GitHub issues stay direct (`GitHubIssuesPaneStore`).
//
// The server allows 30 Linear and Jira requests a minute per account, so a
// pane load reads at most two issue pages here, and the quick view and the
// picker share one read of the teams and projects.

/// A Linear read the account server refused, with its sentence
/// (`linear_needs_renewal`, `linear_renewing`, `linear_not_connected`, …).
struct AccountLinearError: LocalizedError {
  let code: String?
  let message: String
  var errorDescription: String? { message }
}

@MainActor
final class AccountLinearCache {
  static let shared = AccountLinearCache()
  private static let ttl: TimeInterval = 60

  private var answers: [String: (at: Date, data: [String: Any])] = [:]
  private var inFlight: [String: Task<[String: Any], Error>] = [:]

  func reset() {
    answers = [:]
    for task in inFlight.values { task.cancel() }
    inFlight = [:]
  }

  /// One shared answer per origin and op for a minute (`identity`, `teams`, `projects`).
  func shared(_ op: String, origin: String, read: @escaping () async throws -> [String: Any]) async throws -> [String: Any] {
    let key = "\(origin)\n\(op)"
    if let cached = answers[key], Date().timeIntervalSince(cached.at) < Self.ttl { return cached.data }
    if let task = inFlight[key] { return try await task.value }
    let task = Task { try await read() }
    inFlight[key] = task
    defer { inFlight[key] = nil }
    let data = try await task.value
    answers[key] = (Date(), data)
    return data
  }
}

extension SyncService {
  /// The Linear pane reads through the account: no computer answers for the
  /// open project, and the project has a GitHub repository the account knows.
  var linearReadsThroughAccount: Bool {
    guard AccountService.shared.isSignedIn, cloudProjectOrigin != nil else { return false }
    return activeProjectId == nil || connectionState != .connected || !projectHostIsLive
  }

  /// Issue pages per pane load: fewer through the account (its request budget).
  var linearMaxPagesPerLoad: Int { linearReadsThroughAccount ? 2 : 10 }

  /// One Linear read through the account server, with its refusal as a sentence.
  func accountLinear(_ op: String, vars: [String: Any] = [:]) async throws -> [String: Any] {
    guard let origin = cloudProjectOrigin else {
      throw AccountLinearError(code: nil, message: "This project has no GitHub repository, so Linear needs ADE on a computer.")
    }
    guard let client = await cloudServerClient() else {
      throw AccountLinearError(code: nil, message: "Sign in to ADE to see Linear issues here.")
    }
    do {
      return try await client.linearQuery(origin: origin, op: op, vars: vars).data
    } catch CloudServerClient.Failure.refused(let code, let message) {
      throw AccountLinearError(code: code, message: message)
    } catch CloudServerClient.Failure.noAccess {
      throw AccountLinearError(code: "not_found", message: "Linear shows here when ADE on a computer is online.")
    } catch {
      throw AccountLinearError(code: nil, message: cloudServerFailureMessage(error))
    }
  }

  private func accountLinearShared(_ op: String) async throws -> [String: Any] {
    let origin = cloudProjectOrigin ?? ""
    return try await AccountLinearCache.shared.shared(op, origin: origin) { [weak self] in
      guard let self else { throw CancellationError() }
      return try await self.accountLinear(op)
    }
  }

  // MARK: Connection

  /// The connection as the account server sees it: `identity` answers when
  /// the project's Linear connection works.
  func accountLinearConnectionStatus() async -> LinearConnectionStatus {
    do {
      let data = try await accountLinearShared("identity")
      let viewer = data["viewer"] as? [String: Any]
      let organization = data["organization"] as? [String: Any]
      var status = LinearConnectionStatus(connected: true)
      status.viewerId = viewer?["id"] as? String
      status.viewerName = (viewer?["displayName"] as? String) ?? (viewer?["name"] as? String)
      status.organizationId = organization?["id"] as? String
      status.organizationName = organization?["name"] as? String
      status.organizationUrlKey = organization?["urlKey"] as? String
      status.organizationLogoUrl = organization?["logoUrl"] as? String
      return status
    } catch let error as AccountLinearError {
      // A sign-in that needs renewal is still this project's Linear: the
      // pane opens and says the server's sentence.
      let renewing = error.code == "linear_needs_renewal" || error.code == "linear_renewing"
      var status = LinearConnectionStatus(connected: renewing)
      status.message = error.message
      return status
    } catch {
      var status = LinearConnectionStatus(connected: false)
      status.message = error.localizedDescription
      return status
    }
  }

  // MARK: Quick view and picker

  func accountLinearQuickView() async throws -> LinearQuickView {
    async let identity = accountLinearShared("identity")
    async let teams = accountLinearShared("teams")
    async let projects = accountLinearShared("projects")
    let (identityData, teamsData, projectsData) = try await (identity, teams, projects)
    let viewer = identityData["viewer"] as? [String: Any]
    let organization = identityData["organization"] as? [String: Any]
    let teamNodes = linearNodes(teamsData["teams"])
    let projectNodes = linearNodes(projectsData["projects"])
    var object: [String: Any] = [
      "connection": [
        "connected": true,
        "viewerId": viewer?["id"] ?? NSNull(),
        "viewerName": viewer?["displayName"] ?? viewer?["name"] ?? NSNull(),
        "organizationId": organization?["id"] ?? NSNull(),
        "organizationName": organization?["name"] ?? NSNull(),
        "organizationUrlKey": organization?["urlKey"] ?? NSNull(),
      ],
      "projects": projectNodes.compactMap(linearQuickViewProjectObject),
      "teams": teamNodes.compactMap { team -> [String: Any]? in
        guard let id = team["id"] as? String, let key = team["key"] as? String, let name = team["name"] as? String else { return nil }
        return ["id": id, "key": key, "name": name, "displayName": team["displayName"] as? String ?? name, "color": team["color"] ?? NSNull(), "issueCount": team["issueCount"] ?? NSNull(), "private": team["private"] ?? NSNull()]
      },
      "assignedIssues": [],
      "recentIssues": [],
      "fetchedAt": ISO8601DateFormatter().string(from: Date()),
    ]
    if let organization, let id = organization["id"] as? String, let name = organization["name"] as? String {
      object["organization"] = ["id": id, "name": name, "urlKey": organization["urlKey"] ?? NSNull(), "logoUrl": organization["logoUrl"] ?? NSNull()]
    }
    if let viewer, let id = viewer["id"] as? String {
      let name = viewer["name"] as? String ?? ""
      object["viewer"] = ["id": id, "name": name, "displayName": viewer["displayName"] as? String ?? name, "email": viewer["email"] ?? NSNull(), "avatarUrl": viewer["avatarUrl"] ?? NSNull()]
    }
    return try linearDecode(LinearQuickView.self, object)
  }

  func accountLinearPickerData() async throws -> LinearIssuePickerData {
    async let teams = accountLinearShared("teams")
    async let projects = accountLinearShared("projects")
    let (teamsData, projectsData) = try await (teams, projects)
    var states: [[String: Any]] = []
    for team in linearNodes(teamsData["teams"]) {
      for state in linearNodes(team["states"]) {
        guard let id = state["id"] as? String, let name = state["name"] as? String else { continue }
        states.append(["id": id, "name": name, "type": state["type"] ?? NSNull(), "teamId": team["id"] ?? NSNull(), "teamKey": team["key"] ?? NSNull()])
      }
    }
    let projectObjects = linearNodes(projectsData["projects"]).compactMap { project -> [String: Any]? in
      guard let id = project["id"] as? String, let name = project["name"] as? String else { return nil }
      return ["id": id, "name": name, "slug": project["slugId"] ?? NSNull(), "url": project["url"] ?? NSNull(), "icon": project["icon"] ?? NSNull(), "color": project["color"] ?? NSNull()]
    }
    return try linearDecode(LinearIssuePickerData.self, ["projects": projectObjects, "users": [], "states": states])
  }

  // MARK: Issues

  func accountLinearSearch(_ args: LinearIssueSearchArgs) async throws -> LinearIssueSearchResult {
    var vars: [String: Any] = ["first": min(args.first ?? 50, 50)]
    if let after = args.after { vars["after"] = after }
    if args.includeArchived == true { vars["includeArchived"] = true }
    let filter = linearIssueFilter(args)
    if !filter.isEmpty { vars["filter"] = filter }
    let op: String
    let key: String
    if let term = args.query.flatMap({ nonEmptyTrimmed($0) }) {
      op = "searchIssues"
      key = "searchIssues"
      vars["term"] = term
    } else {
      op = "issues"
      key = "issues"
    }
    let data = try await accountLinear(op, vars: vars)
    let connection = data[key] as? [String: Any]
    let pageInfo = connection?["pageInfo"] as? [String: Any]
    let issues = linearNodes(connection).compactMap(linearIssueObject)
    return try linearDecode(LinearIssueSearchResult.self, [
      "issues": issues,
      "pageInfo": ["hasNextPage": pageInfo?["hasNextPage"] as? Bool ?? false, "endCursor": pageInfo?["endCursor"] ?? NSNull()],
    ])
  }

  func accountLinearComments(issueId: String) async throws -> [LinearIssueComment] {
    let data = try await accountLinear("comments", vars: ["issueId": issueId])
    let nodes = linearNodes((data["issue"] as? [String: Any])?["comments"])
    let comments = nodes.compactMap { node -> [String: Any]? in
      guard let id = node["id"] as? String else { return nil }
      let user = node["user"] as? [String: Any]
      return [
        "id": id, "body": node["body"] as? String ?? "", "createdAt": node["createdAt"] as? String ?? "",
        "userName": user?["name"] ?? NSNull(), "userDisplayName": user?["displayName"] ?? NSNull(),
      ]
    }
    return try linearDecode([LinearIssueComment].self, comments)
  }
}

// MARK: - Mapping (pure)

/// The `nodes` of a Linear connection object.
func linearNodes(_ value: Any?) -> [[String: Any]] {
  ((value as? [String: Any])?["nodes"] as? [Any] ?? []).compactMap { $0 as? [String: Any] }
}

private func linearDecode<T: Decodable>(_ type: T.Type, _ object: Any) throws -> T {
  let data = try JSONSerialization.data(withJSONObject: object)
  return try JSONDecoder().decode(type, from: data)
}

/// Linear's `IssueFilter` for the pane's filters.
func linearIssueFilter(_ args: LinearIssueSearchArgs) -> [String: Any] {
  var filter: [String: Any] = [:]
  if let projectId = args.projectId { filter["project"] = ["id": ["eq": projectId]] }
  if let teamKey = args.teamKey { filter["team"] = ["key": ["eq": teamKey]] }
  if let types = args.stateTypes, !types.isEmpty { filter["state"] = ["type": ["in": types]] }
  if let assigneeId = args.assigneeId { filter["assignee"] = ["id": ["eq": assigneeId]] }
  if let priority = args.priority { filter["priority"] = ["eq": priority] }
  return filter
}

private func linearRefObject(_ value: Any?) -> [String: Any]? {
  guard let issue = value as? [String: Any], let id = issue["id"] as? String,
        let identifier = issue["identifier"] as? String else { return nil }
  let state = issue["state"] as? [String: Any]
  return [
    "id": id, "identifier": identifier, "title": issue["title"] as? String ?? identifier,
    "stateId": state?["id"] ?? NSNull(), "stateName": state?["name"] ?? NSNull(), "stateType": state?["type"] ?? NSNull(),
  ]
}

/// One issue node as the pane's `NormalizedLinearIssue` object.
func linearIssueObject(_ node: [String: Any]) -> [String: Any]? {
  guard let id = node["id"] as? String, let identifier = node["identifier"] as? String else { return nil }
  let project = node["project"] as? [String: Any]
  let team = node["team"] as? [String: Any]
  let state = node["state"] as? [String: Any]
  let assignee = node["assignee"] as? [String: Any]
  let creator = node["creator"] as? [String: Any]
  let priority = (node["priority"] as? NSNumber)?.intValue
  var object: [String: Any] = [
    "id": id,
    "identifier": identifier,
    "title": node["title"] as? String ?? identifier,
    "labels": linearNodes(node["labels"]).compactMap { $0["name"] as? String },
    "childIssues": linearNodes(node["children"]).compactMap(linearRefObject),
  ]
  func put(_ key: String, _ value: Any?) {
    if let value, !(value is NSNull) { object[key] = value }
  }
  put("description", node["description"])
  put("url", node["url"])
  put("branchName", node["branchName"])
  put("priority", priority)
  put("priorityLabel", linearPriorityLabel(priority))
  put("dueDate", node["dueDate"])
  put("estimate", node["estimate"])
  put("archivedAt", node["archivedAt"])
  put("completedAt", node["completedAt"])
  put("canceledAt", node["canceledAt"])
  put("startedAt", node["startedAt"])
  put("createdAt", node["createdAt"])
  put("updatedAt", node["updatedAt"])
  put("projectId", project?["id"])
  put("projectName", project?["name"])
  put("projectSlug", project?["slug"])
  put("teamId", team?["id"])
  put("teamKey", team?["key"])
  put("teamName", team?["name"])
  put("stateId", state?["id"])
  put("stateName", state?["name"])
  put("stateType", state?["type"])
  put("assigneeId", assignee?["id"])
  put("assigneeName", (assignee?["displayName"] as? String) ?? (assignee?["name"] as? String))
  put("creatorId", creator?["id"])
  put("creatorName", (creator?["displayName"] as? String) ?? (creator?["name"] as? String))
  put("parentIssue", linearRefObject(node["parent"]))
  // `inverseRelations` of type `blocks`: the issues that block this one.
  let blockedBy = linearNodes(node["inverseRelations"])
    .filter { ($0["type"] as? String) == "blocks" }
    .compactMap { linearRefObject($0["issue"]) }
  if !blockedBy.isEmpty {
    object["blockedByIssues"] = blockedBy
    object["blockerIssueIds"] = blockedBy.compactMap { $0["id"] }
    object["hasOpenBlockers"] = blockedBy.contains { ($0["stateType"] as? String).map { $0 != "completed" && $0 != "canceled" } ?? true }
  }
  let relations = linearNodes(node["relations"])
  let blocking = relations.filter { ($0["type"] as? String) == "blocks" }.compactMap { linearRefObject($0["relatedIssue"]) }
  let related = relations.filter { ($0["type"] as? String) == "related" }.compactMap { linearRefObject($0["relatedIssue"]) }
  if !blocking.isEmpty { object["blockingIssues"] = blocking }
  if !related.isEmpty { object["relatedIssues"] = related }
  return object
}

private func linearQuickViewProjectObject(_ node: [String: Any]) -> [String: Any]? {
  guard let id = node["id"] as? String, let name = node["name"] as? String else { return nil }
  let teams = linearNodes(node["teams"])
  let status = node["status"] as? [String: Any]
  let lead = node["lead"] as? [String: Any]
  var object: [String: Any] = [
    "id": id, "name": name, "slug": node["slugId"] as? String ?? id,
    "teamName": teams.first?["name"] as? String ?? "",
    "teamKeys": teams.compactMap { $0["key"] as? String },
  ]
  func put(_ key: String, _ value: Any?) {
    if let value, !(value is NSNull) { object[key] = value }
  }
  put("teamKey", teams.first?["key"])
  put("url", node["url"])
  put("color", node["color"])
  put("icon", node["icon"])
  put("description", node["description"])
  put("statusName", status?["name"])
  put("statusType", status?["type"])
  put("health", node["health"])
  put("progress", node["progress"])
  put("scope", node["scope"])
  put("priority", node["priority"])
  put("priorityLabel", node["priorityLabel"])
  put("startDate", node["startDate"])
  put("targetDate", node["targetDate"])
  put("leadName", (lead?["displayName"] as? String) ?? (lead?["name"] as? String))
  return object
}
