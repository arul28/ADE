import SwiftUI

/// An issue the next launch starts with, picked from the composer's ⋯ menu.
///
/// The phone used to offer Linear alone, in a strip above the composer, and
/// only for a CLI start. Desktop's composer offers every connected tracker from
/// one "Issue context" menu, for a chat and a CLI alike; this is the phone's
/// half of that, so both surfaces say the same thing about the same launch.
enum WorkLaunchIssue: Identifiable, Equatable {
  case linear(NormalizedLinearIssue)
  case github(GitHubIssueRow, owner: String, repo: String)

  var id: String {
    switch self {
    case .linear(let issue): return "linear:\(issue.id)"
    case .github(let issue, let owner, let repo): return "github:\(owner)/\(repo)#\(issue.number)"
    }
  }

  var providerLabel: String {
    switch self {
    case .linear: return "Linear"
    case .github: return "GitHub"
    }
  }

  var identifier: String {
    switch self {
    case .linear(let issue): return issue.identifier
    case .github(let issue, let owner, let repo): return "\(owner)/\(repo)#\(issue.number)"
    }
  }

  var title: String {
    switch self {
    case .linear(let issue): return issue.title
    case .github(let issue, _, _): return issue.title
    }
  }

  var url: String? {
    switch self {
    case .linear(let issue): return issue.url
    case .github(let issue, _, _): return issue.htmlUrl
    }
  }

  var symbolName: String {
    switch self {
    case .linear: return "circle.dashed"
    case .github: return "smallcircle.filled.circle"
    }
  }

  var linearIssue: NormalizedLinearIssue? {
    if case .linear(let issue) = self { return issue }
    return nil
  }

  var githubRef: (issue: GitHubIssueRow, owner: String, repo: String)? {
    if case .github(let issue, let owner, let repo) = self { return (issue, owner, repo) }
    return nil
  }

  /// The issue in the lane-link shape `lanes.attachGitHubIssueToSession` takes.
  /// `nil` for a Linear issue, which attaches through its own command.
  var githubIssuePayload: WorkGitHubIssueLinkPayload? {
    guard let (issue, owner, repo) = githubRef else { return nil }
    let now = Date().ISO8601Format()
    return WorkGitHubIssueLinkPayload(
      id: "\(owner)/\(repo)#\(issue.number)",
      number: issue.number,
      owner: owner,
      repo: repo,
      title: issue.title,
      body: issue.body,
      url: issue.htmlUrl ?? "https://github.com/\(owner)/\(repo)/issues/\(issue.number)",
      state: issue.state == "closed" ? "closed" : "open",
      stateReason: issue.stateReason,
      labels: issue.labels.map(\.name),
      assignees: issue.assignees.map(\.login),
      authorLogin: issue.user?.login,
      createdAt: issue.createdAt ?? now,
      updatedAt: issue.updatedAt ?? now
    )
  }
}

/// Desktop's `LaneGitHubIssue`, as the attach command reads it.
struct WorkGitHubIssueLinkPayload: Encodable {
  var id: String
  var number: Int
  var owner: String
  var repo: String
  var title: String
  var body: String?
  var url: String
  var state: String
  var stateReason: String?
  var labels: [String]
  var assignees: [String]
  var authorLogin: String?
  var createdAt: String
  var updatedAt: String
}

/// Text inside an issue is author-controlled, so it is wrapped the way desktop
/// wraps it: the agent reads the block as data, never as instructions.
func workLaunchUntrusted(_ value: String, source: String) -> String {
  let escaped = value
    .replacingOccurrences(of: "&", with: "&amp;")
    .replacingOccurrences(of: "<", with: "&lt;")
    .replacingOccurrences(of: ">", with: "&gt;")
    .replacingOccurrences(of: "\"", with: "&quot;")
    .replacingOccurrences(of: "'", with: "&apos;")
  return "<untrusted-data source=\"\(source)\">\(escaped)</untrusted-data>"
}

/// The issue references a launch prompt carries, worded like the desktop
/// composer's `buildChatContextAttachmentPrompt` for the same trackers.
func workLaunchIssuePromptBlock(_ issues: [WorkLaunchIssue]) -> String {
  guard !issues.isEmpty else { return "" }
  let linear = issues.compactMap(\.linearIssue)
  let github = issues.compactMap(\.githubRef)
  var sections: [String] = []

  if !linear.isEmpty {
    let entries = linear.enumerated().map { index, issue in
      [
        "Linear issue \(index + 1):",
        "- Provider: Linear",
        "- Identifier: \(issue.identifier)",
        "- Linear issue id: \(issue.id)",
        "- Title: \(workLaunchUntrusted(issue.title, source: "linear"))",
        issue.projectName.map { "- Project: \(workLaunchUntrusted($0, source: "linear"))" },
        issue.teamName.map { "- Team: \(workLaunchUntrusted($0, source: "linear"))" },
        issue.stateName.map { "- State: \(workLaunchUntrusted($0, source: "linear"))" },
        issue.priorityLabel.map { "- Priority: \(workLaunchUntrusted($0, source: "linear"))" },
        issue.url.map { "- URL: \(workLaunchUntrusted($0, source: "linear"))" },
        issue.description?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
          ? "- Description:\n\(workLaunchUntrusted(issue.description ?? "", source: "linear"))"
          : nil,
      ].compactMap { $0 }.joined(separator: "\n")
    }
    sections.append(([
      "Attached issue context:",
      "ADE already stores any local Linear credentials; do not ask the user for a Linear API key. Use the identifiers below.",
    ] + entries).joined(separator: "\n\n"))
  }

  if !github.isEmpty {
    let entries = github.enumerated().map { index, entry in
      let (issue, owner, repo) = entry
      return [
        "GitHub issue \(index + 1):",
        "- Provider: GitHub",
        "- Identifier: \(owner)/\(repo)#\(issue.number)",
        "- Title: \(workLaunchUntrusted(issue.title, source: "github"))",
        "- Repository: \(owner)/\(repo)",
        "- State: \(workLaunchUntrusted(issue.state, source: "github"))",
        "- URL: \(workLaunchUntrusted(issue.htmlUrl ?? "", source: "github"))",
        issue.body?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
          ? "- Description:\n\(workLaunchUntrusted(issue.body ?? "", source: "github"))"
          : nil,
      ].compactMap { $0 }.joined(separator: "\n")
    }
    sections.append(([
      "Attached GitHub issue context:",
      "ADE already stores any local GitHub credentials; do not ask the user for a GitHub token. Use the identifiers below.",
    ] + entries).joined(separator: "\n\n"))
  }

  return sections.joined(separator: "\n\n")
}

/// A CLI's first input: its attachment manifest, the issue references, then
/// what the person typed — the desktop order for the same launch.
func workLaunchCliInitialInput(
  text: String,
  attachments: [AgentChatFileRef],
  issues: [WorkLaunchIssue]
) -> String {
  [
    workCliInitialInput(text: "", attachments: attachments),
    workLaunchIssuePromptBlock(issues),
    text.trimmingCharacters(in: .whitespacesAndNewlines),
  ]
  .filter { !$0.isEmpty }
  .joined(separator: "\n\n")
}

/// A chat's opener with the issue references in front of it. The session link
/// carries each issue in full (the agent reads the same context file a CLI
/// does), so the message itself only names them — a readable first bubble
/// rather than the whole metadata block a CLI has no link to carry.
func workLaunchChatOpener(_ text: String, issues: [WorkLaunchIssue]) -> String {
  guard !issues.isEmpty else { return text }
  let lines = issues.map { issue in
    let url = issue.url.map { " — \($0)" } ?? ""
    return "- \(issue.providerLabel) \(issue.identifier): \(issue.title)\(url)"
  }
  let block = (["Issue context:"] + lines).joined(separator: "\n")
  let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
  return trimmed.isEmpty ? block : "\(block)\n\n\(trimmed)"
}

/// The Linear issue list in pick mode: tapping an issue adds it to the launch
/// instead of attaching it to an existing chat.
struct WorkLinearIssuePickerSheet: View {
  @StateObject private var store: LinearPaneStore
  @State private var started = false
  @Environment(\.dismiss) private var dismiss
  let onPick: (NormalizedLinearIssue) -> Void

  init(syncService: SyncService, onPick: @escaping (NormalizedLinearIssue) -> Void) {
    _store = StateObject(wrappedValue: LinearPaneStore(sync: syncService))
    self.onPick = onPick
  }

  var body: some View {
    NavigationStack {
      LinearIssueListScreen(
        store: store,
        onClose: { dismiss() },
        showsClose: true,
        onAttachIssue: { issue in onPick(issue) }
      )
    }
    .task {
      guard !started else { return }
      started = true
      await store.start()
    }
  }
}

/// This project's GitHub issues in pick mode, the GitHub twin of
/// `WorkLinearIssuePickerSheet`.
struct WorkGitHubIssuePickerSheet: View {
  @StateObject private var store: GitHubIssuesPaneStore
  @State private var started = false
  @Environment(\.dismiss) private var dismiss
  let onPick: (GitHubIssueRow, GitHubRepoRefDTO) -> Void

  init(syncService: SyncService, onPick: @escaping (GitHubIssueRow, GitHubRepoRefDTO) -> Void) {
    _store = StateObject(wrappedValue: GitHubIssuesPaneStore(sync: syncService))
    self.onPick = onPick
  }

  var body: some View {
    NavigationStack {
      GitHubIssueListScreen(
        store: store,
        onClose: { dismiss() },
        onPickIssue: { issue in
          guard let repo = store.repo else { return }
          onPick(issue, repo)
        }
      )
    }
    .task {
      guard !started else { return }
      started = true
      await store.start()
    }
  }
}
