import Foundation
import SwiftUI

// Swift ports of the desktop PR detail rules, so iOS says the same thing:
//   - `apps/desktop/src/shared/prBotIdentity.ts`  → `PrAuthorIdentity.classify`
//   - `apps/desktop/src/shared/prNextStep.ts`     → `PrNextStep.resolve`
//   - the conversation digest lives in `PrConversationDigest.swift`
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

/// "opened 3 days ago", plus "· updated 2 hours ago" only when that says
/// something the opened time does not (desktop `PrDetailHeader`).
func prHeaderAgeLabel(createdAt: String?, updatedAt: String?) -> String {
  let opened = "opened \(prRelativeTime(createdAt))"
  guard prParsedDate(createdAt) != nil, prParsedDate(updatedAt) != nil else { return opened }
  let updated = prRelativeTime(updatedAt)
  return updated == prRelativeTime(createdAt) ? opened : "\(opened) · updated \(updated)"
}

/// Id prefix of the timeline events made from bot blocks in the PR body
/// (desktop `PR_DESCRIPTION_BOT_EVENT_PREFIX`).
let prDescriptionBotEventPrefix = "desc-bot:"

func prIsDescriptionBotEvent(_ event: PrTimelineEvent) -> Bool {
  event.id.hasPrefix(prDescriptionBotEventPrefix)
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
