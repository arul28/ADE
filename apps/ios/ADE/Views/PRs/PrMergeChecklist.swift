import SwiftUI

// MARK: - GitHub-style merge requirement checklist (iOS)
//
// Pure derivation + presentational checklist that mirrors the desktop
// `prMergeRailUtils.ts` (`buildMergeChecklist`, `canAttemptMerge`,
// `buildDefaultCommitMessage`, command-line). Driven primarily by the new
// structured merge-state fields (`mergeStateStatus`, `reviewDecision`,
// `approvalsCount`/`requiredApprovals`) and falling back to checks/reviews/
// conflict booleans when the merge-box state is absent (older hosts).

/// State of one requirement row.
enum PrMergeChecklistState: Equatable {
  /// Green ✓ — requirement satisfied.
  case pass
  /// Red ✗ — requirement failing / blocking.
  case fail
  /// Muted ● — informational / not-yet-applicable.
  case neutral

  var icon: String {
    switch self {
    case .pass: return "checkmark.circle.fill"
    case .fail: return "xmark.octagon.fill"
    case .neutral: return "circle.fill"
    }
  }

  var tint: Color {
    switch self {
    case .pass: return ADEColor.success
    case .fail: return ADEColor.danger
    case .neutral: return ADEColor.textMuted
    }
  }
}

/// A single requirement row in the merge checklist.
struct PrMergeChecklistItem: Identifiable, Equatable {
  let id: String
  let label: String
  let state: PrMergeChecklistState
  /// Secondary detail line (e.g. "0 of 1 required approvals").
  let detail: String?

  init(id: String, label: String, state: PrMergeChecklistState, detail: String? = nil) {
    self.id = id
    self.label = label
    self.state = state
    self.detail = detail
  }
}

/// Failing/passing/pending tally over PR checks. Matches desktop
/// `summarizeChecks`: only `failure`/`cancelled` count as failing and only
/// `success` counts as passing (neutral/skipped count as neither).
struct PrCheckTally: Equatable {
  var total: Int = 0
  var passing: Int = 0
  var failing: Int = 0
  var pending: Int = 0
}

enum PrMergeChecklist {
  static func summarizeChecks(_ checks: [PrCheck]) -> PrCheckTally {
    var tally = PrCheckTally(total: checks.count)
    for check in checks {
      if check.status != "completed" {
        tally.pending += 1
        continue
      }
      switch check.conclusion {
      case "failure", "cancelled":
        tally.failing += 1
      case "success":
        tally.passing += 1
      default:
        break
      }
    }
    return tally
  }

  /// Mirrors desktop `buildMergeChecklist`. `reviewStatus`/`prState` come from
  /// the summary list item so the review fallback works on older hosts.
  static func build(
    prState: String,
    summaryReviewStatus: String,
    status: PrStatus?,
    checks: [PrCheck],
    reviews: [PrReview],
    summaryChecksStatus: String? = nil
  ) -> [PrMergeChecklistItem] {
    var items: [PrMergeChecklistItem] = []
    let mergeState = status?.mergeStateStatus
    let blocked = mergeState == .blocked

    // --- Review requirement -------------------------------------------------
    let reviewDecision = status?.reviewDecision
    let required = status?.requiredApprovals
    let approvals = status?.approvalsCount
    let changesRequested = reviews.filter { $0.state == "changes_requested" }
    if reviewDecision == .changesRequested || !changesRequested.isEmpty {
      // Ordered-unique reviewer logins, capped at 3 for the detail line.
      var seen = Set<String>()
      let reviewers = changesRequested
        .map { $0.reviewer }
        .filter { seen.insert($0).inserted }
        .prefix(3)
        .joined(separator: ", ")
      items.append(
        PrMergeChecklistItem(
          id: "review",
          label: "Changes requested",
          state: .fail,
          detail: reviewers.isEmpty ? nil : "Requested by \(reviewers)"
        )
      )
    } else if reviewDecision == .reviewRequired {
      items.append(
        PrMergeChecklistItem(
          id: "review",
          label: "Review required",
          state: .fail,
          detail: required.map { req in
            "\(approvals ?? 0) of \(req) required approval\(req == 1 ? "" : "s")"
          }
        )
      )
    } else if reviewDecision == .approved {
      items.append(
        PrMergeChecklistItem(
          id: "review",
          label: "Changes approved",
          state: .pass,
          detail: required.map { req in
            "\(approvals ?? req) of \(req) required approval\(req == 1 ? "" : "s")"
          }
        )
      )
    } else if reviewDecision == nil
      && (summaryReviewStatus == "requested" || status?.reviewStatus == "requested")
    {
      // Older runtimes without reviewDecision: fall back to the summary status.
      items.append(PrMergeChecklistItem(id: "review", label: "Review required", state: .fail))
    }

    // --- Checks -------------------------------------------------------------
    // ADE-135: `summarizeChecks` counts rows and is producer-blind, so a PR
    // whose only checks are third-party apps reports passing == 3 and this row
    // claimed "All 3 checks passed" — the ticket's lie, on the surface a reader
    // trusts most. The canonical rollup decides the verdict; the counts stay.
    let summary = summarizeChecks(checks)
    let checksRollup = status?.checksStatus ?? summaryChecksStatus
    if summary.failing > 0 {
      items.append(
        PrMergeChecklistItem(
          id: "checks",
          label: "\(summary.failing) failing check\(summary.failing == 1 ? "" : "s")",
          state: .fail
        )
      )
    } else if summary.pending > 0 {
      items.append(
        PrMergeChecklistItem(
          id: "checks",
          label: "\(summary.pending) pending check\(summary.pending == 1 ? "" : "s")",
          state: .neutral
        )
      )
    } else if checksRollup == "not_run" {
      items.append(
        PrMergeChecklistItem(
          id: "checks",
          label: "No CI has run on this commit",
          state: .neutral
        )
      )
    } else if summary.passing > 0 {
      items.append(
        PrMergeChecklistItem(
          id: "checks",
          label: "All \(summary.passing) check\(summary.passing == 1 ? "" : "s") passed",
          state: .pass
        )
      )
    }

    // --- Conflicts ----------------------------------------------------------
    let hasConflicts = mergeState == .dirty || (status?.mergeConflicts ?? false)
    items.append(
      PrMergeChecklistItem(
        id: "conflicts",
        label: hasConflicts ? "Conflicts with base branch" : "No conflicts with base branch",
        state: hasConflicts ? .fail : .pass
      )
    )

    // --- Up to date with base ----------------------------------------------
    let behind = status?.behindBaseBy ?? 0
    if mergeState == .behind || behind > 0 {
      items.append(
        PrMergeChecklistItem(
          id: "behind",
          label: behind > 0
            ? "\(behind) commit\(behind == 1 ? "" : "s") behind base branch"
            : "Out of date with base branch",
          state: .neutral
        )
      )
    } else {
      items.append(PrMergeChecklistItem(id: "behind", label: "Up to date with base branch", state: .pass))
    }

    // --- Branch protection --------------------------------------------------
    if blocked {
      items.append(
        PrMergeChecklistItem(
          id: "protected",
          label: "Protected by branch rules",
          state: .neutral,
          detail: (status?.canBypass ?? false) ? "You can bypass as an administrator" : nil
        )
      )
    }

    return items
  }

  /// Mirrors desktop `canAttemptMerge`. Prefers `mergeStateStatus` when present,
  /// falling back to the legacy `isMergeable` boolean otherwise.
  static func canAttemptMerge(prState: String, status: PrStatus?, bypassRules: Bool) -> Bool {
    guard prState == "open" else { return false }
    if let mergeState = status?.mergeStateStatus {
      if mergeState == .dirty || mergeState == .draft { return false }
      if status?.mergeConflicts == true { return false }
      // Admin bypass can land anything that isn't conflicted/draft, as long as
      // we have a status snapshot to merge against.
      if bypassRules { return status != nil }
      return mergeState == .clean || mergeState == .hasHooks || mergeState == .unstable
    }
    // Fallback to the legacy boolean when mergeStateStatus is absent.
    if status?.mergeConflicts == true { return false }
    if bypassRules { return status != nil }
    return status?.isMergeable ?? false
  }

  /// The bypass toggle is offered ONLY when the viewer can bypass and the
  /// merge-box state is `blocked` (branch-protection block). Other blockers
  /// (conflicts, failing checks) are not bypassable by an admin merge.
  static func showsBypassToggle(status: PrStatus?, capabilities: PrActionCapabilities?) -> Bool {
    let canBypass = (status?.canBypass ?? false) || (capabilities?.canBypass ?? false)
    let mergeState = status?.mergeStateStatus ?? capabilities?.mergeStateStatus
    return canBypass && mergeState == .blocked
  }

  /// Mirrors desktop `buildMergeCommandLineInstructions` (`--admin` on bypass).
  static func commandLine(
    repoOwner: String,
    repoName: String,
    prNumber: Int,
    method: PrMergeMethodOption,
    bypassRules: Bool
  ) -> String {
    let adminFlag = bypassRules ? " --admin" : ""
    return "gh pr merge \(prNumber) --\(method.rawValue)\(adminFlag) --repo \(repoOwner)/\(repoName)"
  }

  /// Mirrors desktop `buildDefaultCommitMessage`.
  /// - `squash` → title `"<prTitle> (#<n>)"`, body = each commit's message.
  /// - `merge`  → title `"Merge pull request #<n> from <owner>/<head>"`, body = PR title.
  /// - `rebase` → empty (no editor shown).
  static func defaultCommitMessage(
    method: PrMergeMethodOption,
    prTitle: String,
    prNumber: Int,
    headBranch: String,
    repoOwner: String,
    commits: [PrCommit]
  ) -> (title: String, body: String) {
    switch method {
    case .rebase:
      return ("", "")
    case .merge:
      return ("Merge pull request #\(prNumber) from \(repoOwner)/\(headBranch)", prTitle)
    case .squash:
      let body = commits
        .compactMap { commit -> String? in
          let message = commit.message.trimmingCharacters(in: .whitespacesAndNewlines)
          guard !message.isEmpty else { return nil }
          // Collapse 3+ blank lines like GitHub.
          let collapsed = message.replacingOccurrences(
            of: "\n{3,}",
            with: "\n\n",
            options: .regularExpression
          )
          return "* \(collapsed)"
        }
        .joined(separator: "\n\n")
      return ("\(prTitle) (#\(prNumber))", body)
    }
  }
}

// MARK: - Checklist view

/// Renders the requirement checklist with the liquid-glass row treatment used
/// across the PR detail surfaces.
struct PrMergeChecklistView: View {
  let items: [PrMergeChecklistItem]

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      ForEach(items) { item in
        HStack(alignment: .top, spacing: 10) {
          Image(systemName: item.state.icon)
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(item.state.tint)
            .frame(width: 18, height: 18)
            .padding(.top, 1)

          VStack(alignment: .leading, spacing: 2) {
            Text(item.label)
              .font(.system(size: 13, weight: .medium))
              .foregroundStyle(ADEColor.textPrimary)
              .fixedSize(horizontal: false, vertical: true)
            if let detail = item.detail {
              Text(detail)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(ADEColor.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            }
          }

          Spacer(minLength: 0)
        }
      }
    }
  }
}
