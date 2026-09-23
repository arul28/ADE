import Foundation
import SwiftUI

// Swift ports of the desktop PR detail rules, so iOS says the same thing:
//   - `apps/desktop/src/shared/prBotIdentity.ts`  → `PrAuthorIdentity.classify`
//   - `apps/desktop/src/shared/prNextStep.ts`     → `PrNextStep.resolve`
//   - `apps/desktop/src/shared/prConversationDigest.ts` (push folding)
//                                                  → `buildPrDigestDisplayItems`
// Keep the tables and the priority order in step with the TypeScript files;
// `PrDetailRedesignTests` pins the same fixtures as `prDetailRedesign.test.ts`.

// MARK: - Bot identity

enum PrBotRole: String, Equatable {
  case agentReviewer = "agent-reviewer"
  case deploy
  case dependency
  case ci
  case bot
  case human
}

struct PrAuthorIdentity: Equatable {
  let login: String
  let normalizedLogin: String
  let isBot: Bool
  let kind: String?
  let displayName: String
  let role: PrBotRole
  let brandColorHex: String?

  private struct KnownBot {
    let kind: String
    let displayName: String
    let role: PrBotRole
    let color: String
    let logins: [String]
  }

  private static let knownBots: [KnownBot] = [
    KnownBot(kind: "coderabbit", displayName: "CodeRabbit", role: .agentReviewer, color: "#FF570A", logins: ["coderabbitai", "coderabbit"]),
    KnownBot(kind: "devin", displayName: "Devin", role: .agentReviewer, color: "#3B82F6", logins: ["devin-ai-integration", "devin-ai", "devin"]),
    KnownBot(kind: "cursor", displayName: "Cursor", role: .agentReviewer, color: "#E6E6E6", logins: ["cursor", "cursor-com", "cursoragent", "cursor-bugbot", "bugbot"]),
    KnownBot(kind: "greptile", displayName: "Greptile", role: .agentReviewer, color: "#22C55E", logins: ["greptile-apps", "greptileai", "greptile"]),
    KnownBot(kind: "seer", displayName: "Seer", role: .agentReviewer, color: "#A78BFA", logins: ["seer-by-sentry"]),
    KnownBot(kind: "copilot", displayName: "Copilot", role: .agentReviewer, color: "#8B5CF6", logins: ["copilot-pull-request-reviewer", "copilot", "copilot-swe-agent", "github-copilot"]),
    KnownBot(kind: "codex", displayName: "Codex", role: .agentReviewer, color: "#10A37F", logins: ["chatgpt-codex-connector", "codex", "openai-codex"]),
    KnownBot(kind: "claude", displayName: "Claude", role: .agentReviewer, color: "#D97757", logins: ["claude", "claude-code", "anthropic-claude", "claude-bot"]),
    KnownBot(kind: "gemini", displayName: "Gemini", role: .agentReviewer, color: "#4285F4", logins: ["gemini-code-assist", "gemini-cli", "google-gemini"]),
    KnownBot(kind: "jules", displayName: "Jules", role: .agentReviewer, color: "#7C4DFF", logins: ["google-labs-jules", "jules"]),
    KnownBot(kind: "amazonq", displayName: "Amazon Q", role: .agentReviewer, color: "#FF9900", logins: ["amazon-q-developer", "amazon-q"]),
    KnownBot(kind: "windsurf", displayName: "Windsurf", role: .agentReviewer, color: "#0B9A8A", logins: ["windsurf-bot", "windsurf", "codeium"]),
    KnownBot(kind: "sourcery", displayName: "Sourcery", role: .agentReviewer, color: "#F5A623", logins: ["sourcery-ai", "sourcery-ai-experiments"]),
    KnownBot(kind: "qodo", displayName: "Qodo", role: .agentReviewer, color: "#7B61FF", logins: ["qodo-merge-pro", "qodo-merge", "qodo-ai", "codiumai-pr-agent-pro", "codiumai-pr-agent"]),
    KnownBot(kind: "ellipsis", displayName: "Ellipsis", role: .agentReviewer, color: "#6366F1", logins: ["ellipsis-dev"]),
    KnownBot(kind: "graphite", displayName: "Graphite", role: .agentReviewer, color: "#A3A3A3", logins: ["graphite-app", "graphite-reviewer"]),
    KnownBot(kind: "sweep", displayName: "Sweep", role: .agentReviewer, color: "#5B8DEF", logins: ["sweep-ai", "sweep-ai-dev"]),
    KnownBot(kind: "korbit", displayName: "Korbit", role: .agentReviewer, color: "#14B8A6", logins: ["korbit-ai"]),
    KnownBot(kind: "bito", displayName: "Bito", role: .agentReviewer, color: "#2563EB", logins: ["bito-code-review", "bito"]),
    KnownBot(kind: "cubic", displayName: "cubic", role: .agentReviewer, color: "#A855F7", logins: ["cubic-dev-ai"]),
    KnownBot(kind: "baz", displayName: "Baz", role: .agentReviewer, color: "#F43F5E", logins: ["baz-reviewer", "baz-scm"]),
    KnownBot(kind: "entelligence", displayName: "Entelligence", role: .agentReviewer, color: "#0EA5E9", logins: ["entelligence-ai-pr-reviews"]),
    KnownBot(kind: "augment", displayName: "Augment", role: .agentReviewer, color: "#22D3EE", logins: ["augmentcode", "augment-code"]),
    KnownBot(kind: "whatthediff", displayName: "What The Diff", role: .agentReviewer, color: "#F97316", logins: ["what-the-diff"]),
    KnownBot(kind: "opencode", displayName: "OpenCode", role: .agentReviewer, color: "#E5E5E5", logins: ["opencode-agent", "opencode"]),
    KnownBot(kind: "ade", displayName: "ADE", role: .agentReviewer, color: "#A78BFA", logins: ["ade-dev", "ade-agent", "ade-bot"]),
    KnownBot(kind: "vercel", displayName: "Vercel", role: .deploy, color: "#EDEDED", logins: ["vercel"]),
    KnownBot(kind: "netlify", displayName: "Netlify", role: .deploy, color: "#32E6E2", logins: ["netlify"]),
    KnownBot(kind: "cloudflare", displayName: "Cloudflare", role: .deploy, color: "#F38020", logins: ["cloudflare-workers-and-pages", "cloudflare-pages", "cloudflare"]),
    KnownBot(kind: "railway", displayName: "Railway", role: .deploy, color: "#C4B5FD", logins: ["railway-app"]),
    KnownBot(kind: "render", displayName: "Render", role: .deploy, color: "#8B5CF6", logins: ["render"]),
    KnownBot(kind: "supabase", displayName: "Supabase", role: .deploy, color: "#3ECF8E", logins: ["supabase"]),
    KnownBot(kind: "mintlify", displayName: "Mintlify", role: .deploy, color: "#0D9373", logins: ["mintlify"]),
    KnownBot(kind: "expo", displayName: "Expo", role: .deploy, color: "#E5E5E5", logins: ["expo-github-app"]),
    KnownBot(kind: "dependabot", displayName: "Dependabot", role: .dependency, color: "#025E8C", logins: ["dependabot", "dependabot-preview"]),
    KnownBot(kind: "renovate", displayName: "Renovate", role: .dependency, color: "#1A8CFF", logins: ["renovate", "renovate-bot"]),
    KnownBot(kind: "github-actions", displayName: "GitHub Actions", role: .ci, color: "#2088FF", logins: ["github-actions"]),
    KnownBot(kind: "codecov", displayName: "Codecov", role: .ci, color: "#F01F7A", logins: ["codecov", "codecov-commenter"]),
    KnownBot(kind: "sonar", displayName: "SonarQube Cloud", role: .ci, color: "#F3702A", logins: ["sonarcloud", "sonarqubecloud"]),
    KnownBot(kind: "deepsource", displayName: "DeepSource", role: .ci, color: "#34D399", logins: ["deepsource-io", "deepsource-autofix"]),
    KnownBot(kind: "snyk", displayName: "Snyk", role: .ci, color: "#4C4A73", logins: ["snyk-bot", "snyk-io"]),
    KnownBot(kind: "socket", displayName: "Socket", role: .ci, color: "#C084FC", logins: ["socket-security"]),
    KnownBot(kind: "sentry", displayName: "Sentry", role: .ci, color: "#A78BFA", logins: ["sentry", "sentry-io"]),
    KnownBot(kind: "changesets", displayName: "Changesets", role: .ci, color: "#FACC15", logins: ["changeset-bot"]),
    KnownBot(kind: "mergify", displayName: "Mergify", role: .ci, color: "#1CB893", logins: ["mergify"]),
    KnownBot(kind: "kodiak", displayName: "Kodiak", role: .ci, color: "#94A3B8", logins: ["kodiakhq"]),
    KnownBot(kind: "linear", displayName: "Linear", role: .bot, color: "#5E6AD2", logins: ["linear", "linear-app"]),
  ]

  private static let knownByLogin: [String: KnownBot] = {
    var map: [String: KnownBot] = [:]
    for bot in knownBots {
      for login in bot.logins { map[login] = bot }
    }
    return map
  }()

  static func normalize(_ login: String?) -> String {
    var value = (login ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    if value.hasSuffix("[bot]") { value.removeLast(5) }
    return value
  }

  /// GitHub says an account is a bot two ways: REST `user.type` (login ends in
  /// `[bot]`) and GraphQL `__typename` (no suffix). A person can own `cursor`
  /// or `claude`, so a short table login only counts with GitHub's word too.
  static func classify(_ login: String?, accountIsBot: Bool? = nil) -> PrAuthorIdentity {
    let raw = (login ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    let normalized = normalize(raw)
    let lower = raw.lowercased()
    let githubSaysBot = (accountIsBot ?? false) || lower.hasSuffix("[bot]") || lower.hasSuffix("-bot") || lower == "github-actions"
    let known = knownByLogin[normalized]
    let distinctive = normalized.contains("-") || normalized.hasSuffix("ai")
    let isBot = githubSaysBot || (known != nil && distinctive)
    if let known, isBot {
      return PrAuthorIdentity(login: raw, normalizedLogin: normalized, isBot: true, kind: known.kind, displayName: known.displayName, role: known.role, brandColorHex: known.color)
    }
    return PrAuthorIdentity(
      login: raw,
      normalizedLogin: normalized,
      isBot: isBot,
      kind: nil,
      displayName: isBot ? (normalized.isEmpty ? raw : normalized) : raw,
      role: isBot ? .bot : .human,
      brandColorHex: nil
    )
  }
}

// MARK: - Next step

enum PrNextStepKind: String, Equatable {
  case merged, closed, draft, computing, conflicts, behind
  case checksFailing = "checks_failing"
  case changesRequested = "changes_requested"
  case autoMergeArmed = "auto_merge_armed"
  case checksPending = "checks_pending"
  case reviewRequired = "review_required"
  case rulesBlocked = "rules_blocked"
  case ready
}

enum PrNextStepAction: String, Equatable {
  case deleteBranch = "delete_branch"
  case reopen
  case readyForReview = "ready_for_review"
  case resolveConflicts = "resolve_conflicts"
  case updateBranch = "update_branch"
  case fixChecks = "fix_checks"
  case rerunChecks = "rerun_checks"
  case addressFeedback = "address_feedback"
  case enableAutoMerge = "enable_auto_merge"
  case disableAutoMerge = "disable_auto_merge"
  case requestReview = "request_review"
  case fixThreads = "fix_threads"
  case merge
}

enum PrNextStepTone: String, Equatable {
  case success, danger, warning, info, neutral, merged
}

struct PrRequirementChip: Equatable, Identifiable {
  enum State: String, Equatable { case pass, fail, pending, neutral }
  let id: String
  let state: State
  let label: String
}

struct PrMergeAnyway: Equatable {
  var visible: Bool
  var blocked: Bool
  var blockedReason: String?
  var bypass: Bool
  var skips: [String]
}

struct PrNextStepInput: Equatable {
  var state: String
  var mergeStateStatus: PrMergeStateStatus?
  var mergeConflicts: Bool
  var behindBaseBy: Int?
  var mergeabilityComputing: Bool
  var checksStatus: String?
  var failingChecks: Int
  var pendingChecks: Int
  var passingChecks: Int
  var reviewDecision: PrReviewDecisionValue?
  var approvalsCount: Int?
  var requiredApprovals: Int?
  var changesRequestedBy: [String]
  var unresolvedThreads: Int
  var canBypass: Bool
  var autoMergeAllowed: Bool?
  var autoMergeEnabled: Bool
  var autoMergeMethod: String?
  var baseBranch: String
}

struct PrNextStep: Equatable {
  let kind: PrNextStepKind
  let tone: PrNextStepTone
  let headline: String
  let detail: String?
  let primary: PrNextStepAction?
  let secondary: PrNextStepAction?
  let mergeAnyway: PrMergeAnyway
  let chips: [PrRequirementChip]

  private static func plural(_ count: Int, _ one: String, _ many: String? = nil) -> String {
    "\(count) \(count == 1 ? one : (many ?? one + "s"))"
  }

  /// GitHub answers `unknown` while it computes mergeability. That is no
  /// answer, so it counts the same as no live merge box.
  private static func hasLiveMergeBox(_ input: PrNextStepInput) -> Bool {
    input.mergeStateStatus != nil && input.mergeStateStatus != .unknown
  }

  private static func chips(_ input: PrNextStepInput, conflicts: Bool) -> [PrRequirementChip] {
    var out: [PrRequirementChip] = []
    let liveBox = hasLiveMergeBox(input)
    if liveBox || input.mergeConflicts {
      out.append(conflicts ? .init(id: "conflicts", state: .fail, label: "Conflicts") : .init(id: "conflicts", state: .pass, label: "No conflicts"))
    }
    let behind = input.mergeStateStatus == .behind || (input.behindBaseBy ?? 0) > 0
    if liveBox || input.behindBaseBy != nil {
      if behind {
        let label = (input.behindBaseBy ?? 0) > 0 ? "\(input.behindBaseBy!) behind" : "Behind"
        out.append(.init(id: "up_to_date", state: .fail, label: label))
      } else {
        out.append(.init(id: "up_to_date", state: .pass, label: "Up to date"))
      }
    }
    if input.checksStatus == "not_run" {
      out.append(.init(id: "checks", state: .neutral, label: "No CI ran"))
    } else if input.failingChecks > 0 {
      out.append(.init(id: "checks", state: .fail, label: plural(input.failingChecks, "failing check")))
    } else if input.pendingChecks > 0 {
      out.append(.init(id: "checks", state: .pending, label: plural(input.pendingChecks, "check") + " running"))
    } else if input.passingChecks > 0 {
      out.append(.init(id: "checks", state: .pass, label: "Checks pass"))
    }
    if !input.changesRequestedBy.isEmpty || input.reviewDecision == .changesRequested {
      out.append(.init(id: "review", state: .fail, label: "Changes requested"))
    } else if input.reviewDecision == .reviewRequired {
      let label = input.requiredApprovals.map { "\(input.approvalsCount ?? 0) of \($0) approvals" } ?? "Review required"
      out.append(.init(id: "review", state: .fail, label: label))
    } else if input.reviewDecision == .approved {
      out.append(.init(id: "review", state: .pass, label: "Approved"))
    } else {
      out.append(.init(id: "review", state: .neutral, label: "No review needed"))
    }
    if input.unresolvedThreads > 0 {
      out.append(.init(id: "threads", state: .pending, label: plural(input.unresolvedThreads, "open thread")))
    }
    return out
  }

  private static func skips(_ input: PrNextStepInput, behind: Bool) -> [String] {
    var out: [String] = []
    if input.failingChecks > 0 { out.append(plural(input.failingChecks, "failing check")) }
    if input.pendingChecks > 0 { out.append(plural(input.pendingChecks, "running check")) }
    if input.checksStatus == "not_run" { out.append("no CI has run on this commit") }
    if !input.changesRequestedBy.isEmpty || input.reviewDecision == .changesRequested {
      out.append("requested changes")
    } else if input.reviewDecision == .reviewRequired {
      let missing = input.requiredApprovals.map { max($0 - (input.approvalsCount ?? 0), 1) } ?? 1
      out.append(plural(missing, "required approval"))
    }
    if input.unresolvedThreads > 0 { out.append(plural(input.unresolvedThreads, "open thread")) }
    if behind {
      if let count = input.behindBaseBy, count > 0 {
        out.append("\(plural(count, "commit")) behind \(input.baseBranch)")
      } else {
        out.append("behind \(input.baseBranch)")
      }
    }
    return out
  }

  static func resolve(_ input: PrNextStepInput) -> PrNextStep {
    let conflicts = input.mergeStateStatus == .dirty || input.mergeConflicts
    let behind = input.mergeStateStatus == .behind || (input.behindBaseBy ?? 0) > 0
    let chipList = chips(input, conflicts: conflicts)
    let skipList = skips(input, behind: behind)
    let hidden = PrMergeAnyway(visible: false, blocked: false, blockedReason: nil, bypass: false, skips: [])
    let state = input.state.lowercased()

    if state == "merged" {
      return PrNextStep(kind: .merged, tone: .merged, headline: "Merged into \(input.baseBranch)", detail: nil, primary: .deleteBranch, secondary: nil, mergeAnyway: hidden, chips: [])
    }
    if state == "closed" {
      return PrNextStep(kind: .closed, tone: .neutral, headline: "Closed without merging", detail: nil, primary: .reopen, secondary: nil, mergeAnyway: hidden, chips: [])
    }

    let protectionBlocks = input.mergeStateStatus == .blocked || input.mergeStateStatus == .behind
    var anyway = PrMergeAnyway(visible: true, blocked: false, blockedReason: nil, bypass: protectionBlocks && input.canBypass, skips: skipList)

    if state == "draft" || input.mergeStateStatus == .draft {
      var draftAnyway = anyway
      draftAnyway.blocked = true
      draftAnyway.blockedReason = "GitHub cannot merge a draft. Mark it ready first."
      return PrNextStep(kind: .draft, tone: .neutral, headline: "Draft, not ready for review", detail: "Mark it ready when the work is done.", primary: .readyForReview, secondary: nil, mergeAnyway: draftAnyway, chips: chipList)
    }
    if conflicts {
      var conflictAnyway = anyway
      conflictAnyway.blocked = true
      conflictAnyway.bypass = false
      conflictAnyway.blockedReason = "GitHub cannot merge while there are conflicts."
      return PrNextStep(kind: .conflicts, tone: .danger, headline: "Conflicts with \(input.baseBranch)", detail: "Resolve them before GitHub can merge.", primary: .resolveConflicts, secondary: nil, mergeAnyway: conflictAnyway, chips: chipList)
    }
    if protectionBlocks && !input.canBypass {
      anyway.blocked = true
      anyway.blockedReason = input.mergeStateStatus == .behind
        ? "The base branch requires this PR to be up to date with \(input.baseBranch). Update the branch first."
        : "Branch rules block this merge. A repository admin can bypass them."
    }
    if input.mergeabilityComputing && !hasLiveMergeBox(input) {
      return PrNextStep(kind: .computing, tone: .info, headline: "GitHub is checking mergeability", detail: nil, primary: nil, secondary: nil, mergeAnyway: anyway, chips: chipList)
    }
    if behind {
      let headline = (input.behindBaseBy ?? 0) > 0 ? "\(plural(input.behindBaseBy!, "commit")) behind \(input.baseBranch)" : "Behind \(input.baseBranch)"
      return PrNextStep(kind: .behind, tone: .warning, headline: headline, detail: "Update the branch so checks run on the latest base.", primary: .updateBranch, secondary: nil, mergeAnyway: anyway, chips: chipList)
    }
    if input.failingChecks > 0 {
      return PrNextStep(kind: .checksFailing, tone: .danger, headline: plural(input.failingChecks, "check") + " failing", detail: nil, primary: .fixChecks, secondary: .rerunChecks, mergeAnyway: anyway, chips: chipList)
    }
    if !input.changesRequestedBy.isEmpty || input.reviewDecision == .changesRequested {
      let who = input.changesRequestedBy.prefix(2).joined(separator: ", ")
      return PrNextStep(kind: .changesRequested, tone: .warning, headline: "Changes requested", detail: who.isEmpty ? nil : "By \(who)", primary: .addressFeedback, secondary: nil, mergeAnyway: anyway, chips: chipList)
    }
    if input.autoMergeEnabled {
      let method = input.autoMergeMethod.map { $0 == "merge" ? " · merge commit" : " · \($0)" } ?? ""
      return PrNextStep(kind: .autoMergeArmed, tone: .info, headline: "Auto-merge on\(method)", detail: "GitHub merges this PR when every requirement passes.", primary: nil, secondary: .disableAutoMerge, mergeAnyway: anyway, chips: chipList)
    }
    if input.pendingChecks > 0 {
      return PrNextStep(kind: .checksPending, tone: .info, headline: "Waiting on \(plural(input.pendingChecks, "check"))", detail: nil, primary: input.autoMergeAllowed == true ? .enableAutoMerge : nil, secondary: nil, mergeAnyway: anyway, chips: chipList)
    }
    if input.reviewDecision == .reviewRequired {
      let headline = input.requiredApprovals.map { "Needs \(plural(max($0 - (input.approvalsCount ?? 0), 1), "approval"))" } ?? "Review required"
      return PrNextStep(kind: .reviewRequired, tone: .warning, headline: headline, detail: nil, primary: .requestReview, secondary: nil, mergeAnyway: anyway, chips: chipList)
    }
    if input.mergeStateStatus == .blocked {
      let detail = input.unresolvedThreads > 0
        ? "\(plural(input.unresolvedThreads, "open review thread")) may need to be resolved."
        : "A rule on the base branch is not met yet."
      return PrNextStep(kind: .rulesBlocked, tone: .warning, headline: "Branch rules block the merge", detail: detail, primary: input.unresolvedThreads > 0 ? .fixThreads : nil, secondary: nil, mergeAnyway: anyway, chips: chipList)
    }
    var readyAnyway = anyway
    readyAnyway.visible = false
    return PrNextStep(
      kind: .ready,
      tone: .success,
      headline: "Ready to merge",
      detail: input.unresolvedThreads > 0 ? "\(plural(input.unresolvedThreads, "review thread")) still open" : nil,
      primary: .merge,
      secondary: input.unresolvedThreads > 0 ? .fixThreads : nil,
      mergeAnyway: readyAnyway,
      chips: chipList
    )
  }
}

/// Each reviewer's latest opinion, keyed by normalized login: approve, request
/// changes or a dismissal. Later plain comments do not undo it, and a later
/// dismissal clears an earlier verdict. A review with no time sorts first.
/// Desktop `latestReviewOpinionByLogin`.
func prLatestReviewOpinionByLogin(_ reviews: [PrReview]) -> [(login: String, state: String)] {
  typealias Entry = (index: Int, time: TimeInterval, review: PrReview)
  var entries: [Entry] = []
  for (index, review) in reviews.enumerated() {
    let state = review.state.lowercased()
    if state == "commented" || state == "pending" { continue }
    let time: TimeInterval = prParsedDate(review.submittedAt)?.timeIntervalSince1970 ?? 0
    entries.append((index: index, time: time, review: review))
  }
  // Stable by input order when two reviews share a time.
  entries.sort { (a: Entry, b: Entry) -> Bool in
    a.time != b.time ? a.time < b.time : a.index < b.index
  }
  var latest: [String: (login: String, state: String)] = [:]
  var order: [String] = []
  for entry in entries {
    let key = PrAuthorIdentity.normalize(entry.review.reviewer)
    if latest[key] == nil { order.append(key) }
    latest[key] = (login: entry.review.reviewer, state: entry.review.state.lowercased())
  }
  return order.compactMap { latest[$0] }
}

/// Who still has changes requested, by each reviewer's latest opinion.
func prChangesRequestedBy(_ reviews: [PrReview]) -> [String] {
  prLatestReviewOpinionByLogin(reviews)
    .filter { $0.state == "changes_requested" }
    .map { $0.login }
}

// MARK: - Push folding for the Overview thread

/// One row of the Overview's triage thread: an event, a push divider, or one
/// folded row per bot inside a push (desktop `buildDigestTimelineModel`).
enum PrDigestDisplayItem: Identifiable, Equatable {
  case event(PrTimelineEvent)
  case push(id: String, events: [PrTimelineEvent])
  case botGroup(id: String, identity: PrAuthorIdentity, events: [PrTimelineEvent])

  var id: String {
    switch self {
    case .event(let event): return event.id
    case .push(let id, _): return id
    case .botGroup(let id, _, _): return id
    }
  }
}

/// Consecutive commits with no conversation between them are one push; a
/// force-push starts its own. Inside each push, every bot's reviews and
/// comments fold into one row; people and lifecycle events stay as rows.
func buildPrDigestDisplayItems(_ events: [PrTimelineEvent], botFlags: [String: Bool] = [:]) -> [PrDigestDisplayItem] {
  var items: [PrDigestDisplayItem] = []
  var pushRun: [PrTimelineEvent] = []
  var botOrder: [String] = []
  var botEvents: [String: [PrTimelineEvent]] = [:]
  var botIdentity: [String: PrAuthorIdentity] = [:]
  var sectionRows: [PrTimelineEvent] = []
  var sectionKey = "pre"

  func flushSection() {
    for key in botOrder {
      if let identity = botIdentity[key], let groupEvents = botEvents[key] {
        items.append(.botGroup(id: "bot:\(sectionKey):\(key)", identity: identity, events: groupEvents))
      }
    }
    items.append(contentsOf: sectionRows.map { .event($0) })
    botOrder = []
    botEvents = [:]
    botIdentity = [:]
    sectionRows = []
  }

  func flushPush() {
    guard let first = pushRun.first else { return }
    flushSection()
    sectionKey = first.id
    items.append(.push(id: "push:\(first.id)", events: pushRun))
    pushRun = []
  }

  for event in events {
    switch event.kind {
    case .commit, .forcePush:
      // A force-push rewrote what came before, so it starts its own push.
      if event.kind == .forcePush && !pushRun.isEmpty { flushPush() }
      pushRun.append(event)
    case .review, .comment:
      if !pushRun.isEmpty { flushPush() }
      let login = event.author ?? ""
      let identity = PrAuthorIdentity.classify(login, accountIsBot: botFlags[login])
      if identity.isBot {
        let key = identity.kind ?? identity.normalizedLogin
        if botEvents[key] == nil {
          botOrder.append(key)
          botIdentity[key] = identity
        }
        botEvents[key, default: []].append(event)
      } else {
        sectionRows.append(event)
      }
    default:
      if !pushRun.isEmpty { flushPush() }
      sectionRows.append(event)
    }
  }
  if !pushRun.isEmpty { flushPush() }
  flushSection()
  return items
}

/// "3 comments", "Comment posted", "Deploy update" — the folded bot row summary.
func prDescribeBotGroup(identity: PrAuthorIdentity, events: [PrTimelineEvent]) -> String {
  let reviews = events.filter { $0.kind == .review }.count
  let comments = events.count - reviews
  var parts: [String] = []
  if reviews > 0 { parts.append("\(reviews) review\(reviews == 1 ? "" : "s")") }
  if comments > 0 {
    if reviews == 0 && comments == 1 {
      parts.append(identity.role == .deploy ? "Deploy update" : "Comment posted")
    } else {
      parts.append("\(comments) comment\(comments == 1 ? "" : "s")")
    }
  }
  return parts.joined(separator: " · ")
}

// MARK: - Views

func prNextStepColor(_ tone: PrNextStepTone) -> Color {
  switch tone {
  case .success: return ADEColor.success
  case .danger: return ADEColor.danger
  case .warning: return ADEColor.warning
  case .info: return ADEColor.info
  case .merged: return ADEColor.accent
  case .neutral: return ADEColor.textMuted
  }
}

func prChipColor(_ state: PrRequirementChip.State) -> Color {
  switch state {
  case .pass: return ADEColor.success
  case .fail: return ADEColor.danger
  case .pending: return ADEColor.warning
  case .neutral: return ADEColor.textMuted
  }
}

/// "opened 3 days ago", plus "· updated 2 hours ago" only when that says
/// something the opened time does not (desktop `PrDetailHeader`).
func prHeaderAgeLabel(createdAt: String?, updatedAt: String?) -> String {
  let opened = "opened \(prRelativeTime(createdAt))"
  guard prParsedDate(createdAt) != nil, prParsedDate(updatedAt) != nil else { return opened }
  let updated = prRelativeTime(updatedAt)
  return updated == prRelativeTime(createdAt) ? opened : "\(opened) · updated \(updated)"
}

/// The PR card at the top of the detail screen: number, author and age, the
/// title, then where it merges and the lane it belongs to.
struct PrDetailHeaderCard: View {
  let pr: PullRequestListItem
  let state: String
  let authorLogin: String?
  let laneName: String?

  var body: some View {
    VStack(alignment: .leading, spacing: 7) {
      HStack(spacing: 6) {
        Text("#\(pr.githubPrNumber)")
          .font(.system(size: 12.5, weight: .semibold, design: .monospaced))
          .foregroundStyle(ADEColor.accent)
        if let authorLogin, !authorLogin.isEmpty {
          Text("· \(authorLogin)")
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(ADEColor.textSecondary)
            .lineLimit(1)
        }
        Text("· \(prHeaderAgeLabel(createdAt: pr.createdAt, updatedAt: pr.updatedAt))")
          .font(.system(size: 12))
          .foregroundStyle(ADEColor.textMuted)
          .lineLimit(1)
        Spacer(minLength: 0)
        PrTagChip(label: state.isEmpty ? "unknown" : state, color: prStateTint(state))
      }
      Text(pr.title)
        .font(.system(size: 17, weight: .semibold))
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(3)
        .fixedSize(horizontal: false, vertical: true)
      HStack(spacing: 5) {
        Text(pr.baseBranch)
          .foregroundStyle(ADEColor.textSecondary)
        Image(systemName: "arrow.left")
          .font(.system(size: 9, weight: .semibold))
          .foregroundStyle(ADEColor.textMuted)
        Text(pr.headBranch)
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
          .truncationMode(.middle)
      }
      .font(.system(size: 11.5, design: .monospaced))
      if let laneName, !laneName.isEmpty {
        Label(laneName, systemImage: "arrow.triangle.branch")
          .font(.system(size: 11.5, weight: .medium))
          .foregroundStyle(ADEColor.tintLanes)
          .lineLimit(1)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(14)
    .prGlassCard(cornerRadius: 16)
    .accessibilityElement(children: .combine)
  }
}

/// The live note beside the Checks tab: a count while running, then the result.
struct PrChecksTabNote: View {
  let checks: [PrCheck]

  private var failing: Int {
    checks.filter { $0.status == "completed" && ["failure", "timed_out", "cancelled", "action_required"].contains($0.conclusion ?? "") }.count
  }
  private var running: Int { checks.filter { $0.status != "completed" }.count }
  private var passed: Int { checks.count - running - failing }

  var body: some View {
    if checks.isEmpty {
      EmptyView()
    } else if running > 0 {
      Text("\(passed)/\(checks.count)")
        .font(.system(size: 9.5, weight: .bold, design: .monospaced))
        .foregroundStyle(ADEColor.warning)
    } else {
      Image(systemName: failing > 0 ? "xmark.circle.fill" : "checkmark.circle.fill")
        .font(.system(size: 10, weight: .bold))
        .foregroundStyle(failing > 0 ? ADEColor.danger : ADEColor.success)
    }
  }
}

/// The bottom bar on every tab: the next step and its one action. A tap on the
/// text opens the full Merge sheet with the chips and "Merge anyway".
struct PrNextStepBar: View {
  let step: PrNextStep
  let primaryLabel: String?
  let primaryEnabled: Bool
  let isBusy: Bool
  let onOpenSheet: () -> Void
  let onPrimary: () -> Void

  var body: some View {
    PrStickyActionBar {
      Button(action: onOpenSheet) {
        HStack(spacing: 10) {
          Circle()
            .fill(prNextStepColor(step.tone))
            .frame(width: 9, height: 9)
          VStack(alignment: .leading, spacing: 1) {
            Text(step.headline)
              .font(.system(size: 14, weight: .semibold))
              .foregroundStyle(ADEColor.textPrimary)
              .lineLimit(1)
            if let failing = step.chips.first(where: { $0.state == .fail }) ?? step.chips.first(where: { $0.state == .pending }) {
              Text(failing.label)
                .font(.system(size: 11))
                .foregroundStyle(prChipColor(failing.state))
                .lineLimit(1)
            }
          }
          Spacer(minLength: 0)
          Image(systemName: "chevron.up")
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(ADEColor.textMuted)
        }
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Merge status: \(step.headline)")

      if let primaryLabel {
        Button(action: onPrimary) {
          HStack(spacing: 6) {
            if isBusy { ProgressView().controlSize(.small).tint(.white) }
            Text(primaryLabel)
              .font(.system(size: 13.5, weight: .bold))
              .lineLimit(1)
          }
          .foregroundStyle(step.primary == .merge ? Color.white : Color.black.opacity(0.85))
          .padding(.horizontal, 14)
          .padding(.vertical, 10)
          .background(
            Capsule(style: .continuous)
              .fill(step.primary == .merge ? ADEColor.success : prNextStepColor(step.tone))
          )
          .opacity(primaryEnabled ? 1 : 0.5)
        }
        .buttonStyle(.plain)
        .disabled(!primaryEnabled || isBusy)
      }
    }
  }
}

/// The full Merge card as a sheet: headline, detail, the requirement chips,
/// the main action, and "Merge anyway" (the admin bypass when rules block).
struct PrNextStepSheet: View {
  let step: PrNextStep
  let labelFor: (PrNextStepAction) -> String
  let isAvailable: (PrNextStepAction) -> Bool
  let onAction: (PrNextStepAction) -> Void
  let onMergeAnyway: () -> Void
  let onChip: (PrRequirementChip) -> Void
  let onDismiss: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack(alignment: .top, spacing: 10) {
        Circle()
          .fill(prNextStepColor(step.tone))
          .frame(width: 11, height: 11)
          .padding(.top, 5)
        VStack(alignment: .leading, spacing: 3) {
          Text(step.headline)
            .font(.system(size: 18, weight: .semibold))
            .foregroundStyle(ADEColor.textPrimary)
          if let detail = step.detail {
            Text(detail)
              .font(.system(size: 13))
              .foregroundStyle(ADEColor.textSecondary)
          }
        }
        Spacer(minLength: 0)
        Button(action: onDismiss) {
          Image(systemName: "xmark")
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(ADEColor.textMuted)
            .frame(width: 44, height: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Close")
      }

      if !step.chips.isEmpty {
        FlowChips(chips: step.chips, onChip: onChip)
      }

      VStack(spacing: 8) {
        if let primary = step.primary, isAvailable(primary) {
          sheetButton(labelFor(primary), filled: true, tint: primary == .merge ? ADEColor.success : prNextStepColor(step.tone)) { onAction(primary) }
        }
        if let secondary = step.secondary, isAvailable(secondary) {
          sheetButton(labelFor(secondary), filled: false, tint: ADEColor.textSecondary) { onAction(secondary) }
        }
        if step.mergeAnyway.visible {
          sheetButton(
            step.mergeAnyway.bypass ? "Bypass rules and merge" : "Merge anyway",
            filled: false,
            tint: step.mergeAnyway.bypass ? ADEColor.danger : ADEColor.textSecondary,
            action: onMergeAnyway
          )
          .disabled(step.mergeAnyway.blocked)
          .opacity(step.mergeAnyway.blocked ? 0.45 : 1)
          if step.mergeAnyway.blocked, let reason = step.mergeAnyway.blockedReason {
            Text(reason)
              .font(.system(size: 12))
              .foregroundStyle(ADEColor.textMuted)
              .frame(maxWidth: .infinity, alignment: .leading)
          } else if !step.mergeAnyway.skips.isEmpty {
            Text("Merging now skips: \(step.mergeAnyway.skips.joined(separator: ", ")).")
              .font(.system(size: 12))
              .foregroundStyle(ADEColor.warning)
              .frame(maxWidth: .infinity, alignment: .leading)
          }
        }
      }
    }
    .padding(18)
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private func sheetButton(_ title: String, filled: Bool, tint: Color, action: @escaping () -> Void) -> some View {
    Button {
      ADEHaptics.success()
      action()
    } label: {
      Text(title)
        .font(.system(size: 15, weight: .semibold))
        .frame(maxWidth: .infinity)
        .padding(.vertical, 13)
        .foregroundStyle(filled ? Color.black.opacity(0.85) : tint)
        .background(
          RoundedRectangle(cornerRadius: 12, style: .continuous)
            .fill(filled ? tint : tint.opacity(0.12))
        )
    }
    .buttonStyle(.plain)
  }
}

private struct FlowChips: View {
  let chips: [PrRequirementChip]
  let onChip: (PrRequirementChip) -> Void

  var body: some View {
    // Two-per-row grid: phone widths keep every chip on one line.
    LazyVGrid(columns: [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)], alignment: .leading, spacing: 8) {
      ForEach(chips) { chip in
        Button { onChip(chip) } label: {
          HStack(spacing: 5) {
            Image(systemName: chip.state == .pass ? "checkmark.circle.fill" : chip.state == .fail ? "xmark.circle.fill" : chip.state == .pending ? "clock.fill" : "circle")
              .font(.system(size: 11, weight: .semibold))
            Text(chip.label)
              .font(.system(size: 12, weight: .medium))
              .lineLimit(1)
          }
          .foregroundStyle(prChipColor(chip.state))
          .padding(.horizontal, 10)
          .padding(.vertical, 7)
          .frame(maxWidth: .infinity, alignment: .leading)
          .background(Capsule(style: .continuous).fill(prChipColor(chip.state).opacity(0.12)))
        }
        .buttonStyle(.plain)
      }
    }
  }
}

/// A push section divider in the Overview thread.
struct PrPushDividerRow: View {
  let events: [PrTimelineEvent]

  var body: some View {
    let last = events.last
    HStack(spacing: 6) {
      Image(systemName: events.contains(where: { $0.kind == .forcePush }) ? "arrow.triangle.2.circlepath" : "smallcircle.filled.circle")
        .font(.system(size: 10, weight: .semibold))
      Text(last?.title ?? "Push")
        .font(.system(size: 12))
        .lineLimit(1)
      if events.count > 1 {
        Text("· \(events.count) commits")
          .font(.system(size: 11))
      }
      Text("· \(prRelativeTime(events.first?.timestamp))")
        .font(.system(size: 11))
      Rectangle()
        .fill(ADEColor.textMuted.opacity(0.25))
        .frame(height: 0.5)
    }
    .foregroundStyle(ADEColor.textMuted)
    .padding(.top, 6)
  }
}

/// One folded row per bot inside a push; tap to see its items.
struct PrBotGroupRow: View {
  let identity: PrAuthorIdentity
  let events: [PrTimelineEvent]
  @State private var expanded = false

  /// Every item came out of the PR body: the PR author can edit that text, so
  /// the row must not read as the bot's own comment (desktop digest rows).
  private var allFromDescription: Bool {
    !events.isEmpty && events.allSatisfy(prIsDescriptionBotEvent)
  }

  private var summary: String {
    prDescribeBotGroup(identity: identity, events: events)
  }

  private var accessibilityText: String {
    allFromDescription
      ? "\(identity.displayName), from the PR description, \(summary)"
      : "\(identity.displayName), \(summary)"
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Button {
        withAnimation(.easeInOut(duration: 0.18)) { expanded.toggle() }
      } label: {
        HStack(spacing: 8) {
          Text(String(identity.displayName.prefix(1)).uppercased())
            .font(.system(size: 11, weight: .bold))
            .foregroundStyle(ADEColor.textPrimary)
            .frame(width: 22, height: 22)
            .background(Circle().fill(ADEColor.textMuted.opacity(0.2)))
          Text(identity.displayName)
            .font(.system(size: 13.5, weight: .medium))
            .foregroundStyle(ADEColor.textPrimary)
          if allFromDescription {
            PrDescriptionSourceNote()
          }
          Text(summary)
            .font(.system(size: 12))
            .foregroundStyle(ADEColor.textMuted)
            .lineLimit(1)
          Spacer(minLength: 0)
          Image(systemName: "chevron.right")
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(ADEColor.textMuted)
            .rotationEffect(.degrees(expanded ? 90 : 0))
        }
        .frame(minHeight: 44)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel(accessibilityText)
      .accessibilityValue(expanded ? "Expanded" : "Collapsed")

      if expanded {
        ForEach(events) { event in
          if !allFromDescription && prIsDescriptionBotEvent(event) {
            PrDescriptionSourceNote()
          }
          PrTimelineEventRow(event: event)
        }
      }
    }
  }
}

/// Id prefix of the timeline events made from bot blocks in the PR body
/// (desktop `PR_DESCRIPTION_BOT_EVENT_PREFIX`).
let prDescriptionBotEventPrefix = "desc-bot:"

func prIsDescriptionBotEvent(_ event: PrTimelineEvent) -> Bool {
  event.id.hasPrefix(prDescriptionBotEventPrefix)
}

/// "from the PR description": the text is in the body, which the PR author can
/// edit, so it is not the bot's own comment.
struct PrDescriptionSourceNote: View {
  var body: some View {
    Text("from the PR description")
      .font(.caption2)
      .foregroundStyle(ADEColor.textMuted)
      .lineLimit(1)
      .fixedSize()
      .accessibilityHint("The PR author can edit this text.")
  }
}

/// Section title above the pinned open review threads.
struct PrNeedsAttentionHeader: View {
  let count: Int

  var body: some View {
    HStack(spacing: 6) {
      Image(systemName: "exclamationmark.circle.fill")
        .font(.system(size: 12, weight: .semibold))
      Text("NEEDS ATTENTION")
        .font(.system(size: 11, weight: .bold))
        .tracking(0.6)
      Text("\(count)")
        .font(.system(size: 11, weight: .semibold, design: .monospaced))
        .foregroundStyle(ADEColor.textMuted)
      Spacer(minLength: 0)
    }
    .foregroundStyle(ADEColor.warning)
    .padding(.top, 4)
  }
}

// MARK: - Bot blocks in the PR body (desktop `prBodyBotSections.ts`)

struct PrBodyBotSection: Equatable {
  let id: String
  let login: String
  let body: String
}

/// Review bots append to the PR description (CodeRabbit notes, Cursor summary,
/// Devin badge). Split them out so the description stays the author's and each
/// block shows as that bot's comment in the thread.
func prSplitBodyBotSections(_ body: String?) -> (body: String, sections: [PrBodyBotSection]) {
  // Case rules match the TypeScript regexes: the Cursor marker is exact-case.
  let markers: [(id: String, login: String, start: String, end: String, anyCase: Bool)] = [
    ("coderabbit-summary", "coderabbitai", #"<!--\s*This is an auto-generated comment: release notes by coderabbit\.ai\s*-->"#, #"<!--\s*end of auto-generated comment: release notes by coderabbit\.ai\s*-->"#, true),
    ("cursor-summary", "cursor", #"<!--\s*CURSOR_SUMMARY\s*-->"#, #"<!--\s*/CURSOR_SUMMARY\s*-->"#, false),
    ("devin-review-badge", "devin-ai-integration", #"<!--\s*devin-review-badge-begin\s*-->"#, #"<!--\s*devin-review-badge-end\s*-->"#, true),
  ]
  var rest = body ?? ""
  var sections: [PrBodyBotSection] = []
  for marker in markers {
    let options: String.CompareOptions = marker.anyCase ? [.regularExpression, .caseInsensitive] : [.regularExpression]
    guard let start = rest.range(of: marker.start, options: options) else { continue }
    let after = rest[start.upperBound...]
    let end = after.range(of: marker.end, options: options)
    let inner = end.map { String(after[..<$0.lowerBound]) } ?? String(after)
    let tail = end.map { String(after[$0.upperBound...]) } ?? ""
    let content = inner
      .replacingOccurrences(of: #"<!--[\s\S]*?-->"#, with: "", options: .regularExpression)
      .trimmingCharacters(in: .whitespacesAndNewlines)
    if !content.isEmpty { sections.append(PrBodyBotSection(id: marker.id, login: marker.login, body: content)) }
    rest = String(rest[..<start.lowerBound]) + "\n" + tail
  }
  // A rule line or blank line left dangling at either end where a block was
  // cut (desktop `trimSeparators`).
  let trimmed = rest
    .replacingOccurrences(of: #"(?:\n[ \t]*(?:-{3,}|\*{3,}|_{3,})?[ \t]*)+$"#, with: "", options: .regularExpression)
    .replacingOccurrences(of: #"^(?:[ \t]*(?:-{3,}|\*{3,}|_{3,})?[ \t]*\n)+"#, with: "", options: .regularExpression)
    .trimmingCharacters(in: .whitespacesAndNewlines)
  return (trimmed, sections)
}
