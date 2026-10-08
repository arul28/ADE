import SwiftUI

// The GitHub Issues pane on the phone: this project's repository, its issues,
// one issue with its comments, and the edits the desktop viewer makes (close,
// reopen, comment). Every call is a remote command the desktop already
// serves (`github.*`, see docs/features/issues); the machine's own GitHub
// credential does the work, so the phone needs none.

/// One issue as the brain returns it (GitHub's REST shape).
struct GitHubIssueRow: Decodable, Identifiable, Hashable {
  let number: Int
  let title: String
  let body: String?
  let htmlUrl: String?
  let state: String
  let stateReason: String?
  let labels: [GitHubIssueLabelDTO]
  let assignees: [GitHubIssuePersonDTO]
  let user: GitHubIssuePersonDTO?
  let milestone: GitHubIssueMilestoneDTO?
  let comments: Int?
  let createdAt: String?
  let updatedAt: String?
  let closedAt: String?
  let isPullRequest: Bool

  var id: Int { number }
  var isOpen: Bool { state == "open" }

  enum CodingKeys: String, CodingKey {
    case number, title, body, state, labels, assignees, user, milestone, comments
    case htmlUrl = "html_url"
    case stateReason = "state_reason"
    case createdAt = "created_at"
    case updatedAt = "updated_at"
    case closedAt = "closed_at"
    case pullRequest = "pull_request"
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    number = try c.decode(Int.self, forKey: .number)
    title = (try? c.decode(String.self, forKey: .title)) ?? ""
    body = try? c.decodeIfPresent(String.self, forKey: .body)
    htmlUrl = try? c.decodeIfPresent(String.self, forKey: .htmlUrl)
    state = ((try? c.decodeIfPresent(String.self, forKey: .state)) ?? nil)?.lowercased() ?? "open"
    stateReason = try? c.decodeIfPresent(String.self, forKey: .stateReason)
    labels = (try? c.decodeIfPresent([GitHubIssueLabelDTO].self, forKey: .labels)) ?? []
    assignees = (try? c.decodeIfPresent([GitHubIssuePersonDTO].self, forKey: .assignees)) ?? []
    user = try? c.decodeIfPresent(GitHubIssuePersonDTO.self, forKey: .user)
    milestone = try? c.decodeIfPresent(GitHubIssueMilestoneDTO.self, forKey: .milestone)
    comments = try? c.decodeIfPresent(Int.self, forKey: .comments)
    createdAt = try? c.decodeIfPresent(String.self, forKey: .createdAt)
    updatedAt = try? c.decodeIfPresent(String.self, forKey: .updatedAt)
    closedAt = try? c.decodeIfPresent(String.self, forKey: .closedAt)
    isPullRequest = c.contains(.pullRequest) && !((try? c.decodeNil(forKey: .pullRequest)) ?? true)
  }
}

/// A label arrives as an object, or as a bare name.
struct GitHubIssueLabelDTO: Decodable, Hashable {
  let name: String
  let color: String?

  init(from decoder: Decoder) throws {
    if let single = try? decoder.singleValueContainer(), let name = try? single.decode(String.self) {
      self.name = name
      color = nil
      return
    }
    let c = try decoder.container(keyedBy: CodingKeys.self)
    name = (try? c.decode(String.self, forKey: .name)) ?? ""
    color = try? c.decodeIfPresent(String.self, forKey: .color)
  }

  enum CodingKeys: String, CodingKey { case name, color }
}

struct GitHubIssuePersonDTO: Decodable, Hashable {
  let login: String
  let avatarUrl: String?

  enum CodingKeys: String, CodingKey {
    case login
    case avatarUrl = "avatar_url"
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    login = (try? c.decode(String.self, forKey: .login)) ?? "someone"
    avatarUrl = try? c.decodeIfPresent(String.self, forKey: .avatarUrl)
  }
}

struct GitHubIssueMilestoneDTO: Decodable, Hashable {
  let title: String?
}

struct GitHubIssueCommentDTO: Decodable, Identifiable, Hashable {
  let id: Int
  let body: String
  let htmlUrl: String?
  let user: GitHubIssuePersonDTO?
  let createdAt: String?

  enum CodingKeys: String, CodingKey {
    case id, body, user
    case htmlUrl = "html_url"
    case createdAt = "created_at"
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(Int.self, forKey: .id)
    body = ((try? c.decodeIfPresent(String.self, forKey: .body)) ?? nil) ?? ""
    htmlUrl = try? c.decodeIfPresent(String.self, forKey: .htmlUrl)
    user = try? c.decodeIfPresent(GitHubIssuePersonDTO.self, forKey: .user)
    createdAt = try? c.decodeIfPresent(String.self, forKey: .createdAt)
  }
}

struct GitHubRepoIssueSummaryDTO: Decodable, Equatable {
  let owner: String
  let name: String
  let hasIssuesEnabled: Bool
  let openCount: Int
}

struct GitHubIssueWriteAccessDTO: Decodable, Equatable {
  /// The credential an edit would use (`app`, `gh`, `pat`, …); nil when none can write.
  let writeSource: String?
}

struct GitHubRepoRefDTO: Equatable, Hashable {
  let owner: String
  let name: String
  var label: String { "\(owner)/\(name)" }
}

enum GitHubIssueStateFilter: String, CaseIterable, Identifiable {
  case open, closed, all
  var id: String { rawValue }
  var title: String { rawValue.capitalized }
}

/// GitHub's issue colors: green open, purple completed, gray not planned.
enum GitHubIssueBrand {
  static let open = Color(red: 0x3F / 255.0, green: 0xB9 / 255.0, blue: 0x50 / 255.0)
  static let completed = Color(red: 0xAB / 255.0, green: 0x7D / 255.0, blue: 0xF8 / 255.0)
  static let notPlanned = Color(red: 0x91 / 255.0, green: 0x98 / 255.0, blue: 0xA1 / 255.0)

  static func color(state: String, reason: String?) -> Color {
    if state == "open" { return open }
    return reason == "not_planned" || reason == "duplicate" ? notPlanned : completed
  }

  static func symbol(state: String, reason: String?) -> String {
    if state == "open" { return "smallcircle.filled.circle" }
    return reason == "not_planned" || reason == "duplicate" ? "nosign" : "checkmark.circle"
  }

  static func label(state: String, reason: String?) -> String {
    if state == "open" { return "Open" }
    switch reason {
    case "not_planned": return "Closed as not planned"
    case "duplicate": return "Closed as duplicate"
    default: return "Closed"
    }
  }
}

// MARK: - Sync calls

extension SyncService {
  /// Whether the brain serves the pane at all (older brains do not).
  var supportsGitHubIssuesPane: Bool {
    supportsRemoteAction("github.listRepoIssueList") && supportsRemoteAction("github.detectRepo")
  }

  /// This project's GitHub repository, or nil when its origin is not GitHub.
  func detectGitHubIssueRepo() async throws -> GitHubRepoRefDTO? {
    let response = try await sendCommand(action: "github.detectRepo", args: [:])
    guard let record = response as? [String: Any],
          let owner = record["owner"] as? String,
          let name = record["name"] as? String,
          !owner.isEmpty, !name.isEmpty
    else { return nil }
    return GitHubRepoRefDTO(owner: owner, name: name)
  }

  func fetchGitHubRepoIssueSummary(_ repo: GitHubRepoRefDTO) async throws -> GitHubRepoIssueSummaryDTO {
    try await sendDecodableCommand(
      action: "github.getRepoIssueSummary",
      args: ["owner": repo.owner, "name": repo.name],
      as: GitHubRepoIssueSummaryDTO.self
    )
  }

  func fetchGitHubIssueList(_ repo: GitHubRepoRefDTO, state: GitHubIssueStateFilter) async throws -> [GitHubIssueRow] {
    try await sendDecodableCommand(
      action: "github.listRepoIssueList",
      args: ["owner": repo.owner, "name": repo.name, "state": state.rawValue],
      as: [GitHubIssueRow].self
    ).filter { !$0.isPullRequest }
  }

  func fetchGitHubIssue(_ repo: GitHubRepoRefDTO, number: Int) async throws -> GitHubIssueRow {
    try await sendDecodableCommand(
      action: "github.getIssue",
      args: ["owner": repo.owner, "name": repo.name, "number": number],
      as: GitHubIssueRow.self
    )
  }

  func fetchGitHubIssueComments(_ repo: GitHubRepoRefDTO, number: Int) async throws -> [GitHubIssueCommentDTO] {
    try await sendDecodableCommand(
      action: "github.listIssueComments",
      args: ["owner": repo.owner, "name": repo.name, "number": number],
      as: [GitHubIssueCommentDTO].self
    )
  }

  func fetchGitHubIssueWriteAccess(_ repo: GitHubRepoRefDTO) async throws -> GitHubIssueWriteAccessDTO {
    try await sendDecodableCommand(
      action: "github.getIssueWriteAccess",
      args: ["owner": repo.owner, "name": repo.name],
      as: GitHubIssueWriteAccessDTO.self
    )
  }

  /// One PATCH: `patch` uses GitHub's field names (`state`, `state_reason`, …).
  func updateGitHubIssue(_ repo: GitHubRepoRefDTO, number: Int, patch: [String: Any]) async throws -> GitHubIssueRow {
    try await sendDecodableCommand(
      action: "github.updateIssue",
      args: ["owner": repo.owner, "name": repo.name, "number": number, "patch": patch],
      as: GitHubIssueRow.self
    )
  }

  func commentOnGitHubIssue(_ repo: GitHubRepoRefDTO, number: Int, body: String) async throws -> GitHubIssueCommentDTO {
    try await sendDecodableCommand(
      action: "github.commentOnIssue",
      args: ["owner": repo.owner, "name": repo.name, "number": number, "body": body],
      as: GitHubIssueCommentDTO.self
    )
  }
}

// MARK: - Menu visibility

/// Whether the Work tab's ⋯ menu offers GitHub Issues: the project's origin is
/// a GitHub repository with issues on and at least one open, as on desktop.
/// One summary read (one GraphQL point) per project, kept for 15 minutes.
@MainActor
final class GitHubIssuesMenuAvailability {
  static let shared = GitHubIssuesMenuAvailability()

  private var checkedAt: [String: Date] = [:]
  private var inFlight: Set<String> = []

  func refresh(sync: SyncService, projectId: String?) {
    guard let projectId, sync.supportsGitHubIssuesPane else { return }
    if inFlight.contains(projectId) { return }
    if let checked = checkedAt[projectId], Date().timeIntervalSince(checked) < 15 * 60 { return }
    inFlight.insert(projectId)
    Task { @MainActor in
      defer { inFlight.remove(projectId) }
      do {
        guard let repo = try await sync.detectGitHubIssueRepo() else {
          sync.githubIssuesMenuProjectIds.remove(projectId)
          checkedAt[projectId] = Date()
          return
        }
        let summary = try await sync.fetchGitHubRepoIssueSummary(repo)
        if summary.hasIssuesEnabled && summary.openCount > 0 {
          sync.githubIssuesMenuProjectIds.insert(projectId)
        } else {
          sync.githubIssuesMenuProjectIds.remove(projectId)
        }
        checkedAt[projectId] = Date()
      } catch {
        // Keep the last answer; the next Work visit asks again.
      }
    }
  }
}

// MARK: - Store

@MainActor
final class GitHubIssuesPaneStore: ObservableObject {
  enum Phase: Equatable {
    case idle, loading, loaded, noRepo, failed(String)
  }

  @Published var stateFilter: GitHubIssueStateFilter = .open {
    didSet {
      guard oldValue != stateFilter else { return }
      // Rows of the old filter must not show under the new one.
      issues = []
      Task { await reload() }
    }
  }
  @Published var query = ""
  @Published private(set) var repo: GitHubRepoRefDTO?
  @Published private(set) var issues: [GitHubIssueRow] = []
  @Published private(set) var phase: Phase = .idle
  @Published private(set) var openCount: Int?
  @Published private(set) var canWrite: Bool?

  private let sync: SyncService

  init(sync: SyncService) {
    self.sync = sync
  }

  var visibleIssues: [GitHubIssueRow] {
    let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard !needle.isEmpty else { return issues }
    return issues.filter { issue in
      issue.title.lowercased().contains(needle)
        || "#\(issue.number)".contains(needle)
        || issue.labels.contains { $0.name.lowercased().contains(needle) }
    }
  }

  func start() async {
    if repo == nil {
      phase = .loading
      do {
        guard let found = try await sync.detectGitHubIssueRepo() else {
          phase = .noRepo
          return
        }
        repo = found
      } catch {
        phase = .failed(error.localizedDescription)
        return
      }
    }
    await reload()
    await refreshWriteAccess()
  }

  /// Each reload's number; a reply for an older one (the filter changed while
  /// it was in flight) is dropped instead of showing the wrong rows.
  private var reloadGeneration = 0

  func reload() async {
    guard let repo else { return }
    reloadGeneration += 1
    let generation = reloadGeneration
    let filter = stateFilter
    if issues.isEmpty { phase = .loading }
    do {
      let rows = try await sync.fetchGitHubIssueList(repo, state: filter)
      guard generation == reloadGeneration else { return }
      issues = rows
      phase = .loaded
      if let summary = try? await sync.fetchGitHubRepoIssueSummary(repo), generation == reloadGeneration {
        openCount = summary.openCount
      }
    } catch {
      guard generation == reloadGeneration else { return }
      phase = issues.isEmpty ? .failed(error.localizedDescription) : .loaded
    }
  }

  func refreshWriteAccess() async {
    guard let repo else { return }
    if let access = try? await sync.fetchGitHubIssueWriteAccess(repo) {
      canWrite = access.writeSource != nil
    }
  }

  /// Keep the list in step with an issue the detail screen changed.
  func replace(_ issue: GitHubIssueRow) {
    if let index = issues.firstIndex(where: { $0.number == issue.number }) {
      let stillMatches = stateFilter == .all || (stateFilter == .open) == issue.isOpen
      if stillMatches { issues[index] = issue } else { issues.remove(at: index) }
    }
  }
}

// MARK: - Markdown

/// GitHub bodies mix markdown and HTML (bots often send only HTML). The phone's
/// markdown renderer does not read HTML, so the common tags become markdown and
/// the rest is removed instead of showing as raw text. Code is left exactly as
/// written: fenced blocks and inline code spans are not touched.
func githubIssueDisplayMarkdown(_ raw: String) -> String {
  githubIssueCodeSegments(raw)
    .map { $0.isCode ? $0.text : githubIssueProseWithoutHTML($0.text) }
    .joined()
    .replacingOccurrences(of: "\n{3,}", with: "\n\n", options: .regularExpression)
    .trimmingCharacters(in: .whitespacesAndNewlines)
}

/// The text cut into code (``` fences and `inline` spans) and everything else.
func githubIssueCodeSegments(_ text: String) -> [(text: String, isCode: Bool)] {
  guard let regex = try? NSRegularExpression(pattern: "```[\\s\\S]*?(```|$)|`[^`\\n]+`") else { return [(text, false)] }
  var segments: [(text: String, isCode: Bool)] = []
  var cursor = text.startIndex
  for match in regex.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
    guard let range = Range(match.range, in: text) else { continue }
    if cursor < range.lowerBound { segments.append((String(text[cursor..<range.lowerBound]), false)) }
    segments.append((String(text[range]), true))
    cursor = range.upperBound
  }
  if cursor < text.endIndex { segments.append((String(text[cursor...]), false)) }
  return segments
}

private func githubIssueProseWithoutHTML(_ raw: String) -> String {
  var text = raw
  func replace(_ pattern: String, _ template: String) {
    guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive, .dotMatchesLineSeparators]) else { return }
    text = regex.stringByReplacingMatches(in: text, range: NSRange(text.startIndex..., in: text), withTemplate: template)
  }
  replace("<!--.*?-->", "")
  replace("<a\\s[^>]*href=\"([^\"]*)\"[^>]*>(.*?)</a>", "[$2]($1)")
  replace("<img\\s[^>]*src=\"([^\"]*)\"[^>]*>", "[image]($1)")
  replace("<br\\s*/?>", "\n")
  replace("</?(p|div)[^>]*>", "\n")
  replace("<summary[^>]*>(.*?)</summary>", "**$1**\n")
  // Only things shaped like tags: a letter or `/` right after `<`, so
  // `a < b` and `<-` stay text.
  replace("</?[A-Za-z][^>]*>", "")
  return text
    .replacingOccurrences(of: "&amp;", with: "&")
    .replacingOccurrences(of: "&lt;", with: "<")
    .replacingOccurrences(of: "&gt;", with: ">")
    .replacingOccurrences(of: "&quot;", with: "\"")
}

// MARK: - Dates

func githubIssueRelativeAge(_ raw: String?) -> String? {
  guard let date = issueISODate(raw) else { return nil }
  let delta = Date().timeIntervalSince(date)
  if delta < 60 { return "now" }
  let minutes = Int(delta / 60)
  if minutes < 60 { return "\(minutes)m ago" }
  let hours = minutes / 60
  if hours < 48 { return "\(hours)h ago" }
  return "\(hours / 24)d ago"
}
