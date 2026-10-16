import Foundation

// Swift ports of the desktop conversation rules, so the phone tells the PR's
// story the way the desktop does:
//   - `shared/prBodyBotSections.ts` + `PrMarkdown` sanitizing → `prCleanBody`
//   - `shared/prConversationDigest.ts` (`digestPreview`, `buildPrConversationDigest`,
//     `describeBotGroup`) → `prDigestPreview`, `buildPrConversationDigest`,
//     `prDescribeBotGroup`
//   - `prDigestTimelineModel.ts` (`groupPushes`, story events) → the push and
//     story handling inside `buildPrConversationDigest`

// MARK: - Body cleaning

/// Drops every HTML comment. GitHub never renders them, and bots hide JSON in
/// them (`<!-- devin-review-comment {...} -->`, `<!-- CURSOR_AGENT_PR_BODY_BEGIN -->`).
/// An unterminated `<!--` hides the rest of the text, as it does on GitHub.
func prStripHtmlComments(_ text: String) -> String {
  guard text.contains("<!--") else { return text }
  return text
    .replacingOccurrences(of: #"<!--[\s\S]*?-->"#, with: "", options: .regularExpression)
    .replacingOccurrences(of: #"<!--[\s\S]*$"#, with: "", options: .regularExpression)
}

/// The PR description as the author wrote it: bot blocks split out (each one
/// becomes that bot's comment in the thread), every HTML comment gone, and no
/// run of blank lines left where something was cut.
func prCleanBody(_ body: String?) -> (body: String, sections: [PrBodyBotSection]) {
  let split = prSplitBodyBotSections(body)
  let cleaned = prStripHtmlComments(split.body)
    .replacingOccurrences(of: #"\n[ \t]*\n(?:[ \t]*\n)+"#, with: "\n\n", options: .regularExpression)
    .trimmingCharacters(in: .whitespacesAndNewlines)
  return (cleaned, split.sections)
}

/// One-line, markup-free preview for a digest row (desktop `digestPreview`).
func prDigestPreview(_ body: String?, max: Int = 140) -> String {
  guard let body, !body.isEmpty else { return "" }
  var text = prStripHtmlComments(body)
  let replacements: [(String, String)] = [
    (#"(?i)<details>[\s\S]*?</details>"#, " "),
    (#"<[^>]+>"#, " "),
    (#"```[\s\S]*?```"#, " "),
    (#"!\[[^\]]*\]\([^)]*\)"#, " "),
    (#"\[([^\]]+)\]\([^)]*\)"#, "$1"),
    (#"[`*_>#~|]"#, ""),
    (#"\s+"#, " "),
  ]
  for (pattern, template) in replacements {
    text = text.replacingOccurrences(of: pattern, with: template, options: .regularExpression)
  }
  text = text.trimmingCharacters(in: .whitespacesAndNewlines)
  // Keep the first sentence when it is long enough to stand alone.
  var pick = text
  if let match = text.range(of: #"^.{12,}?[.!?](?=\s|$)"#, options: .regularExpression) {
    let sentence = String(text[match])
    if sentence.count <= max { pick = sentence }
  }
  guard pick.count > max else { return pick }
  return String(pick.prefix(max - 1)).trimmingCharacters(in: .whitespaces) + "…"
}

// MARK: - Conversation digest

struct PrDigestPush: Equatable, Identifiable {
  let id: String
  let sha: String
  let shortSha: String
  let subject: String
  let at: String
  let commitCount: Int
  let forcePushed: Bool
}

/// A commit (or force-push) the digest folds into pushes.
struct PrDigestCommit: Equatable {
  let id: String
  let sha: String
  let shortSha: String
  let subject: String
  let at: String
  var forcePushed = false
}

struct PrDigestEntry: Equatable, Identifiable {
  enum Kind: String, Equatable { case thread, review, comment }
  let id: String
  let kind: Kind
  let author: String
  var authorIsBot: Bool? = nil
  var avatarUrl: String? = nil
  let at: String
  let body: String?
  /// Review threads only.
  var path: String? = nil
  var line: Int? = nil
  var resolved = false
  var outdated = false
  /// Reviews only: approved, changes_requested, commented…
  var reviewState: String? = nil

  /// Not resolved and not outdated: someone still has to act.
  var isOpenThread: Bool { kind == .thread && !resolved && !outdated }

  /// `Header.swift:42`, or the file name alone.
  var location: String? {
    guard let path, !path.isEmpty else { return nil }
    let file = path.split(separator: "/").last.map(String.init) ?? path
    return line.map { "\(file):\($0)" } ?? file
  }
}

struct PrDigestBotGroup: Equatable, Identifiable {
  let id: String
  let key: String
  let identity: PrAuthorIdentity
  var avatarUrl: String?
  var entries: [PrDigestEntry]
  var threadCount = 0
  var resolvedThreadCount = 0
  var openThreadCount = 0
  var commentCount = 0
  var latestAt: String
}

struct PrDigestAttention: Equatable, Identifiable {
  let entry: PrDigestEntry
  let identity: PrAuthorIdentity
  var id: String { entry.id }
}

/// One row of the Overview history.
enum PrDigestItem: Equatable, Identifiable {
  case push(PrDigestPush)
  case bot(PrDigestBotGroup)
  case entry(PrDigestEntry, PrAuthorIdentity)
  case story(PrTimelineEvent)

  var id: String {
    switch self {
    case .push(let push): return "push:\(push.id)"
    case .bot(let group): return group.id
    case .entry(let entry, _): return "entry:\(entry.id)"
    case .story(let event): return "story:\(event.id)"
    }
  }
}

struct PrConversationDigest: Equatable {
  /// Open review threads: people first, then bots, newest first inside each.
  var openThreads: [PrDigestAttention]
  var items: [PrDigestItem]

  static let empty = PrConversationDigest(openThreads: [], items: [])
}

private func prDigestTime(_ value: String?) -> TimeInterval {
  prParsedDate(value)?.timeIntervalSince1970 ?? 0
}

/// Index of the last push starting at or before `at`, or -1 before every push.
private func prDigestSectionIndex(_ pushStarts: [TimeInterval], at: String) -> Int {
  let time = prDigestTime(at)
  var index = -1
  for (i, start) in pushStarts.enumerated() {
    if start <= time { index = i } else { break }
  }
  return index
}

/// The Overview history as triage (desktop `buildDigestTimelineModel`):
/// consecutive commits with no conversation between them are one push, a
/// force-push starts its own; inside each push every bot folds into one row
/// with its thread and comment counts; people and lifecycle events stay rows.
func buildPrConversationDigest(
  commits: [PrDigestCommit],
  entries: [PrDigestEntry],
  story: [PrTimelineEvent] = []
) -> PrConversationDigest {
  let sortedEntries = entries.enumerated()
    .sorted { (prDigestTime($0.element.at), $0.offset) < (prDigestTime($1.element.at), $1.offset) }
    .map(\.element)

  // Pushes: walk commits and conversation together in time order.
  enum Mark { case commit(PrDigestCommit), talk }
  var marks: [(time: TimeInterval, order: Int, mark: Mark)] = []
  for (index, commit) in commits.enumerated() {
    marks.append((prDigestTime(commit.at), index, .commit(commit)))
  }
  for (index, entry) in sortedEntries.enumerated() {
    marks.append((prDigestTime(entry.at), commits.count + index, .talk))
  }
  marks.sort { ($0.time, $0.order) < ($1.time, $1.order) }
  var pushes: [PrDigestPush] = []
  var run: [PrDigestCommit] = []
  func flush() {
    guard let first = run.first, let last = run.last else { return }
    pushes.append(PrDigestPush(
      id: first.id,
      sha: last.sha,
      shortSha: last.shortSha,
      subject: last.subject.split(separator: "\n").first.map(String.init) ?? last.subject,
      at: first.at,
      commitCount: max(1, run.filter { !$0.forcePushed }.count),
      forcePushed: run.contains { $0.forcePushed }
    ))
    run = []
  }
  for mark in marks {
    switch mark.mark {
    case .commit(let commit):
      if commit.forcePushed { flush() }
      run.append(commit)
    case .talk:
      flush()
    }
  }
  flush()

  struct Section {
    var push: PrDigestPush?
    var bots: [PrDigestBotGroup] = []
    var rows: [(time: TimeInterval, item: PrDigestItem)] = []
  }
  var preamble = Section(push: nil)
  var sections = pushes.map { Section(push: $0) }
  let pushStarts = pushes.map { prDigestTime($0.at) }
  var openThreads: [PrDigestAttention] = []

  func withSection(_ at: String, _ body: (inout Section) -> Void) {
    let index = prDigestSectionIndex(pushStarts, at: at)
    if index >= 0 { body(&sections[index]) } else { body(&preamble) }
  }

  for entry in sortedEntries {
    let identity = PrAuthorIdentity.classify(entry.author, accountIsBot: entry.authorIsBot)
    if entry.isOpenThread { openThreads.append(PrDigestAttention(entry: entry, identity: identity)) }
    withSection(entry.at) { section in
      guard identity.isBot else {
        section.rows.append((prDigestTime(entry.at), .entry(entry, identity)))
        return
      }
      let key = identity.kind ?? identity.normalizedLogin
      var group: PrDigestBotGroup
      let existing = section.bots.firstIndex { $0.key == key }
      if let existing {
        group = section.bots[existing]
      } else {
        group = PrDigestBotGroup(
          id: "bot:\(section.push?.id ?? "pre"):\(key)",
          key: key,
          identity: identity,
          avatarUrl: entry.avatarUrl,
          entries: [],
          latestAt: entry.at
        )
      }
      group.entries.append(entry)
      if group.avatarUrl == nil { group.avatarUrl = entry.avatarUrl }
      if prDigestTime(entry.at) > prDigestTime(group.latestAt) { group.latestAt = entry.at }
      if entry.kind == .thread {
        group.threadCount += 1
        if entry.isOpenThread { group.openThreadCount += 1 } else { group.resolvedThreadCount += 1 }
      } else {
        group.commentCount += 1
      }
      if let existing { section.bots[existing] = group } else { section.bots.append(group) }
    }
  }

  for event in story {
    withSection(event.timestamp) { $0.rows.append((prDigestTime(event.timestamp), .story(event))) }
  }

  var items: [PrDigestItem] = []
  for section in [preamble] + sections {
    if let push = section.push { items.append(.push(push)) }
    items.append(contentsOf: section.bots.map { .bot($0) })
    items.append(contentsOf: section.rows.enumerated()
      .sorted { ($0.element.time, $0.offset) < ($1.element.time, $1.offset) }
      .map(\.element.item))
  }

  openThreads.sort { lhs, rhs in
    if lhs.identity.isBot != rhs.identity.isBot { return !lhs.identity.isBot }
    return prDigestTime(lhs.entry.at) > prDigestTime(rhs.entry.at)
  }
  return PrConversationDigest(openThreads: openThreads, items: items)
}

/// "10 threads · all resolved · 2 comments", "3 threads · 1 open",
/// "Comment posted" (desktop `describeBotGroup`).
func prDescribeBotGroup(_ group: PrDigestBotGroup) -> String {
  var parts: [String] = []
  if group.threadCount > 0 {
    let threads = "\(group.threadCount) thread\(group.threadCount == 1 ? "" : "s")"
    if group.openThreadCount == 0 {
      parts.append("\(threads) · all resolved")
    } else if group.resolvedThreadCount == 0 {
      parts.append("\(threads) · \(group.openThreadCount) open")
    } else {
      parts.append("\(threads) · \(group.resolvedThreadCount) resolved")
    }
  }
  if group.commentCount > 0 {
    if group.threadCount == 0 && group.commentCount == 1 {
      parts.append(group.identity.role == .deploy ? "Deploy update" : "Comment posted")
    } else {
      parts.append("\(group.commentCount) comment\(group.commentCount == 1 ? "" : "s")")
    }
  }
  return parts.joined(separator: " · ")
}

// MARK: - Digest input from the PR detail payloads

/// The digest's inputs from what the detail screen loaded: review threads,
/// reviews, conversation comments, the bot blocks of the body, pushes, and the
/// lifecycle events worth a row.
func prDigestInputs(
  pr: PullRequestListItem,
  snapshot: PullRequestSnapshot?,
  reviewThreads: [PrReviewThread],
  activity: [PrActivityEvent],
  bodySections: [PrBodyBotSection]
) -> (commits: [PrDigestCommit], entries: [PrDigestEntry], story: [PrTimelineEvent]) {
  var entries: [PrDigestEntry] = []
  for thread in reviewThreads {
    let first = thread.comments.first
    entries.append(PrDigestEntry(
      id: "thread:\(thread.id)",
      kind: .thread,
      author: first?.author ?? "reviewer",
      authorIsBot: first?.authorIsBot,
      avatarUrl: first?.authorAvatarUrl,
      at: thread.createdAt ?? first?.createdAt ?? "",
      body: first?.body,
      path: thread.path,
      line: thread.line ?? thread.originalLine,
      resolved: thread.isResolved,
      outdated: thread.isOutdated
    ))
  }

  let reviews = snapshot?.reviews ?? []
  for review in reviews {
    entries.append(PrDigestEntry(
      id: "review:\(review.id)",
      kind: .review,
      author: review.reviewer,
      authorIsBot: review.reviewerIsBot,
      at: review.submittedAt ?? "",
      body: review.body,
      reviewState: review.state.lowercased()
    ))
  }
  // Inline review comments already live in their threads.
  let comments = (snapshot?.comments ?? []).filter { $0.source != "review" }
  for comment in comments {
    entries.append(PrDigestEntry(
      id: "comment:\(comment.id)",
      kind: .comment,
      author: comment.author,
      authorIsBot: comment.authorIsBot,
      at: comment.createdAt ?? comment.updatedAt ?? "",
      body: comment.body
    ))
  }
  // Older hosts: the activity feed is the only source of the conversation.
  if reviews.isEmpty && comments.isEmpty {
    for event in activity where event.type == "review" || event.type == "comment" {
      if event.type == "comment", event.metadata?["source"]?.plainTextValue == "review" { continue }
      entries.append(PrDigestEntry(
        id: "activity:\(event.id)",
        kind: event.type == "review" ? .review : .comment,
        author: event.author ?? "someone",
        avatarUrl: event.avatarUrl,
        at: event.timestamp,
        body: event.body,
        reviewState: event.metadata?["state"]?.plainTextValue?.lowercased()
      ))
    }
  }
  for section in bodySections {
    entries.append(PrDigestEntry(
      id: "\(prDescriptionBotEventPrefix)\(section.id)",
      kind: .comment,
      author: section.login,
      authorIsBot: true,
      at: pr.createdAt,
      body: section.body
    ))
  }

  var commits: [PrDigestCommit] = []
  for event in activity {
    switch event.type {
    case "commit":
      let sha = event.metadata?["sha"]?.plainTextValue ?? event.id
      let short = event.metadata?["shortSha"]?.plainTextValue ?? String(sha.prefix(7))
      commits.append(PrDigestCommit(id: event.id, sha: sha, shortSha: short, subject: event.body ?? "Commit", at: event.timestamp))
    case "force_push":
      let sha = event.metadata?["afterSha"]?.plainTextValue ?? event.id
      commits.append(PrDigestCommit(id: event.id, sha: sha, shortSha: String(sha.prefix(7)), subject: "Force-pushed", at: event.timestamp, forcePushed: true))
    default:
      break
    }
  }
  if commits.isEmpty, let snapshotCommits = snapshot?.commits {
    commits = snapshotCommits.map {
      PrDigestCommit(id: "commit:\($0.sha)", sha: $0.sha, shortSha: $0.shortSha, subject: $0.message, at: $0.committedDate)
    }
  }

  var story: [PrTimelineEvent] = []
  for event in activity {
    let symbolTitle: String?
    switch event.type {
    case "deployment", "label", "review_request", "cross_referenced", "renamed", "ready_for_review", "convert_to_draft", "reopened":
      symbolTitle = prDigestPreview(event.body, max: 90)
    default:
      symbolTitle = nil
    }
    guard let title = symbolTitle, !title.isEmpty else { continue }
    story.append(PrTimelineEvent(
      id: event.id,
      kind: prDigestStoryKind(event.type),
      title: title,
      author: event.author,
      body: nil,
      timestamp: event.timestamp,
      metadata: nil
    ))
  }
  let finalState = snapshot?.status?.state ?? pr.state
  if finalState == "merged" || finalState == "closed" {
    let at = (finalState == "merged" ? pr.mergedAt : nil) ?? pr.updatedAt
    let by = pr.mergedBy?.login
    story.append(PrTimelineEvent(
      id: "state-\(finalState)-\(pr.id)",
      kind: .stateChange,
      title: finalState == "merged"
        ? "Merged into \(pr.baseBranch)\(by.map { " by \($0)" } ?? "")"
        : "Closed without merging",
      author: by,
      body: nil,
      timestamp: at,
      metadata: nil
    ))
  }
  return (commits, entries, story)
}

private func prDigestStoryKind(_ type: String) -> PrTimelineEventKind {
  switch type {
  case "deployment": return .deployment
  case "label": return .label
  case "review_request": return .reviewRequest
  default: return .stateChange
  }
}
