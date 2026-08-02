import SwiftUI

// MARK: - Preview fixtures for the rebuilt PR detail Overview thread
//
// Renders the row components exactly as `PrDetailScreen.overviewThreadRows`
// stacks them, with static fixture data (no sync, no network) so Preview Lab
// can render the surface and visual changes are reviewable without pairing a
// host. Keep fixtures deterministic — no `Date()`-derived randomness beyond
// relative offsets.

private enum PrDetailPreviewFixtures {
  static let isoFormatter: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime]
    return formatter
  }()

  static func iso(minutesAgo: Int) -> String {
    isoFormatter.string(from: Date().addingTimeInterval(TimeInterval(-minutesAgo * 60)))
  }

  static let timeline: [PrTimelineEvent] = [
    PrTimelineEvent(
      id: "state-opened",
      kind: .stateChange,
      title: "Opened",
      author: "arul28",
      body: nil,
      timestamp: iso(minutesAgo: 60 * 26),
      metadata: "ade/prs-tab-mobile → main"
    ),
    PrTimelineEvent(
      id: "commit-1",
      kind: .commit,
      title: "commit: flatten PR detail palette",
      author: "arul28",
      body: nil,
      timestamp: iso(minutesAgo: 60 * 25),
      metadata: "a1b2c3d"
    ),
    PrTimelineEvent(
      id: "commit-2",
      kind: .commit,
      title: "commit: fold overview monolith into rows",
      author: "arul28",
      body: nil,
      timestamp: iso(minutesAgo: 60 * 24),
      metadata: "d4e5f6a"
    ),
    PrTimelineEvent(
      id: "review-1",
      kind: .review,
      title: "Changes requested",
      author: "greptile-apps[bot]",
      body: "Found `2` issues: the `reload()` fan-out can race the warm cache, and `prListRow()` drops the separator config.",
      timestamp: iso(minutesAgo: 60 * 20),
      metadata: nil
    ),
    PrTimelineEvent(
      id: "force-push-1",
      kind: .forcePush,
      title: "Force push",
      author: "arul28",
      body: nil,
      timestamp: iso(minutesAgo: 60 * 5),
      metadata: nil
    ),
    PrTimelineEvent(
      id: "comment-1",
      kind: .comment,
      title: "Comment",
      author: "codex",
      body: "Verified the merge rail against desktop `PrDetailMergeRail` — checklist states line up.",
      timestamp: iso(minutesAgo: 60 * 2),
      metadata: nil
    ),
    PrTimelineEvent(
      id: "label-1",
      kind: .label,
      title: "Added label mobile",
      author: "arul28",
      body: nil,
      timestamp: iso(minutesAgo: 45),
      metadata: nil
    ),
  ]

  static let checks: [PrCheck] = [
    PrCheck(name: "build (macos)", status: "completed", conclusion: "success", detailsUrl: nil, startedAt: nil, completedAt: nil),
    PrCheck(name: "test shard 1/8", status: "completed", conclusion: "success", detailsUrl: nil, startedAt: nil, completedAt: nil),
    PrCheck(name: "test shard 2/8", status: "in_progress", conclusion: nil, detailsUrl: nil, startedAt: nil, completedAt: nil),
    PrCheck(name: "greptile review", status: "completed", conclusion: "failure", detailsUrl: nil, startedAt: nil, completedAt: nil),
  ]

  static let files: [PrFile] = [
    PrFile(filename: "apps/ios/ADE/Views/PRs/PrDetailScreen.swift", status: "modified", additions: 214, deletions: 96, patch: nil, previousFilename: nil),
    PrFile(filename: "apps/ios/ADE/Views/PRs/PrDetailOverviewTab.swift", status: "modified", additions: 188, deletions: 402, patch: nil, previousFilename: nil),
    PrFile(filename: "apps/ios/ADE/Views/PRs/PrDetailOverviewPreviews.swift", status: "added", additions: 240, deletions: 0, patch: nil, previousFilename: nil),
    PrFile(filename: "apps/ios/ADE/Views/PRs/PrMergeGateCard.swift", status: "modified", additions: 44, deletions: 61, patch: nil, previousFilename: nil),
    PrFile(filename: "apps/ios/ADE/Views/Work/WorkRootComponents.swift", status: "modified", additions: 12, deletions: 0, patch: nil, previousFilename: nil),
  ]

  static let commits: [PrCommit] = [
    PrCommit(sha: "a1b2c3d4e5f6a7b8", shortSha: "a1b2c3d", message: "flatten PR detail palette", authorLogin: "arul28", authorName: "Arul", authorEmail: nil, committedDate: iso(minutesAgo: 60 * 25), checkStatus: "success"),
    PrCommit(sha: "d4e5f6a7b8c9d0e1", shortSha: "d4e5f6a", message: "fold overview monolith into rows", authorLogin: "arul28", authorName: "Arul", authorEmail: nil, committedDate: iso(minutesAgo: 60 * 24), checkStatus: "pending"),
  ]

  static let detail = PrDetail(
    prId: "pr-fixture",
    body: """
    Bumps [dorny/paths-filter](https://github.com/dorny/paths-filter) from 3 to 4.

    <details>
    <summary>Release notes</summary>
    <h2>v4.0.0</h2>
    <h3>What's changed</h3>
    <ul>
    <li>feat: update action runtime to node24 by <a href="https://github.com/saschabratton"><code>@saschabratton</code></a></li>
    <li><strong>Full changelog:</strong> <a href="https://github.com/dorny/paths-filter/compare/v3.0.3...v4.0.0">v3.0.3...v4.0.0</a></li>
    </ul>
    </details>
    """,
    assignees: [PrUser(login: "arul28", avatarUrl: nil)],
    author: PrUser(login: "arul28", avatarUrl: nil),
    isDraft: false,
    labels: [
      PrLabel(name: "mobile", color: "6b8afd", description: nil),
      PrLabel(name: "performance", color: "22c55e", description: nil),
    ],
    requestedReviewers: [PrUser(login: "codex", avatarUrl: nil)],
    milestone: nil,
    linkedIssues: [PrLinkedIssue(number: 712, title: "Mobile PR view is laggy and hard to read", state: "open")]
  )

  static let reviews: [PrReview] = [
    PrReview(reviewer: "greptile-apps[bot]", state: "changes_requested", body: nil, submittedAt: iso(minutesAgo: 60 * 20)),
    PrReview(reviewer: "codex", state: "approved", body: nil, submittedAt: iso(minutesAgo: 55)),
  ]

  static let pr = PullRequestListItem(
    id: "pr-fixture",
    laneId: "lane-prs-mobile",
    laneName: "PRs mobile polish",
    projectId: "project-ade",
    repoOwner: "arul28",
    repoName: "ADE",
    githubPrNumber: 855,
    githubUrl: "https://github.com/arul28/ADE/pull/855",
    title: "build(deps): bump dorny/paths-filter from 3 to 4",
    state: "open",
    baseBranch: "main",
    headBranch: "dependabot/github_actions/dorny/paths-filter-4",
    checksStatus: "passing",
    reviewStatus: "requested",
    additions: 3,
    deletions: 1,
    lastSyncedAt: nil,
    createdAt: iso(minutesAgo: 60 * 24),
    updatedAt: iso(minutesAgo: 60 * 24),
    adeKind: "single",
    linkedGroupId: nil,
    linkedGroupType: nil,
    linkedGroupName: nil,
    linkedGroupPosition: nil,
    linkedGroupCount: 0,
    workflowDisplayState: nil,
    cleanupState: nil
  )

  static let snapshot = PullRequestSnapshot(
    detail: detail,
    status: PrStatus(
      prId: pr.id,
      state: "open",
      checksStatus: "passing",
      reviewStatus: "requested",
      isMergeable: true,
      mergeConflicts: false,
      behindBaseBy: 0,
      reviewDecision: .reviewRequired,
      approvalsCount: 0,
      requiredApprovals: 1
    ),
    checks: checks,
    reviews: reviews,
    comments: [],
    files: files,
    commits: commits
  )

  // ADE-135 fixture: reproduces PR #988 — three third-party apps reported
  // `success`, GitHub Actions registered no suite, and one required context never
  // reported. This used to render as "CI passed".
  static let notRunReason = "3 checks reported, none from a CI provider. CI has not run on this commit."

  static let notRunMissingRequired = ["CI / build", "CI / test (ubuntu-latest)"]

  static var notRunPr: PullRequestListItem {
    var item = pr
    item.checksStatus = "not_run"
    item.checksReason = notRunReason
    item.checksMissingRequired = notRunMissingRequired
    return item
  }

  static var notRunSnapshot: PullRequestSnapshot {
    PullRequestSnapshot(
      detail: detail,
      status: PrStatus(
        prId: pr.id,
        state: "open",
        checksStatus: "not_run",
        checksReason: notRunReason,
        checksMissingRequired: notRunMissingRequired,
        reviewStatus: "requested",
        isMergeable: true,
        mergeConflicts: false,
        behindBaseBy: 0,
        reviewDecision: .reviewRequired,
        approvalsCount: 0,
        requiredApprovals: 1
      ),
      checks: [],
      reviews: reviews,
      comments: [],
      files: files,
      commits: commits
    )
  }

  static let unresolvedThread = PrReviewThread(
    id: "thread-1",
    isResolved: false,
    isOutdated: false,
    path: "apps/ios/ADE/Views/PRs/PrDetailScreen.swift",
    line: 512,
    originalLine: nil,
    startLine: nil,
    originalStartLine: nil,
    diffSide: nil,
    url: nil,
    createdAt: iso(minutesAgo: 60 * 19),
    updatedAt: iso(minutesAgo: 60 * 3),
    comments: [
      PrReviewThreadComment(
        id: "c1",
        author: "greptile-apps[bot]",
        authorAvatarUrl: nil,
        body: "The `reload()` sidecar fan-out should be throttled — consider gating on the warm-cache freshness window.",
        url: nil,
        createdAt: iso(minutesAgo: 60 * 19),
        updatedAt: nil
      )
    ]
  )

  static let checklist: [PrMergeChecklistItem] = [
    PrMergeChecklistItem(id: "review", label: "Review required", state: .fail, detail: "0 of 1 required approvals"),
    PrMergeChecklistItem(id: "checks", label: "1 failing check", state: .fail),
    PrMergeChecklistItem(id: "conflicts", label: "No conflicts with base branch", state: .pass),
    PrMergeChecklistItem(id: "behind", label: "Up to date with base branch", state: .pass),
  ]

  static let mergeRailModel = PrOverviewMergeRailModel(
    phase: .active,
    repoOwner: "arul28",
    repoName: "ade",
    prNumber: 701,
    gate: PrMergeGateInfo(tone: .red, subline: "1 failing check · 1 unresolved", target: .checks),
    isDraft: false,
    canMerge: false,
    canClose: true,
    canDeleteBranch: true,
    canReopen: false,
    isBusy: false,
    mergeMethod: .squash,
    onMerge: {},
    onChangeMethod: {},
    onClose: {},
    onReopen: {},
    onDeleteBranch: {}
  )
}

private struct PrDetailOverviewPreviewScreen: View {
  @State private var replyDraft = ""
  @State private var commentInput = ""
  @State private var commitsExpanded = false

  var body: some View {
    List {
      PrDetailSummarySection(
        pr: PrDetailPreviewFixtures.pr,
        snapshot: PrDetailPreviewFixtures.snapshot,
        mergeGate: PrMergeGateInfo(
          tone: .amber,
          subline: "0/1 approvals · 1 approval needed",
          target: .reviews
        ),
        commitsExpanded: $commitsExpanded,
        onChecksTap: {},
        onFilesTap: {},
        onCommitTap: { _ in }
      )
      .prListRow()

      PrThreadDescriptionCard(
        author: "arul28",
        text: PrDetailPreviewFixtures.detail.body ?? ""
      )
      .prListRow()

      ForEach(buildPrTimelineDisplayItems(PrDetailPreviewFixtures.timeline)) { item in
        PrTimelineDisplayRow(item: item)
          .prListRow()
      }

      PrThreadSectionHeader(title: "Threads", trailing: "1 unresolved")
        .prListRow()

      PrReviewThreadCard(
        thread: PrDetailPreviewFixtures.unresolvedThread,
        isLive: true,
        isFocused: false,
        replyDraft: $replyDraft,
        onFocus: {},
        onReply: { _ in },
        onResolve: { _ in }
      )
      .prListRow()

      PrReplyComposer(
        text: $commentInput,
        placeholder: "Comment on PR…",
        isLive: true,
        onSend: {},
        onClearFocus: nil
      )
      .prListRow()

      PrOverviewMergeRail(
        model: PrDetailPreviewFixtures.mergeRailModel,
        checklist: PrDetailPreviewFixtures.checklist
      )
      .prListRow()

      PrOverviewChecksCard(checks: PrDetailPreviewFixtures.checks, onSeeAll: {})
        .prListRow()

      PrOverviewCommitsCard(commits: PrDetailPreviewFixtures.commits)
        .prListRow()

      PrOverviewFilesCard(files: PrDetailPreviewFixtures.files, onSeeAll: {})
        .prListRow()

      PrOverviewPeopleCard(
        detail: PrDetailPreviewFixtures.detail,
        reviews: PrDetailPreviewFixtures.reviews,
        authorLogin: "arul28"
      )
      .prListRow()
    }
    .listStyle(.plain)
    .listRowSpacing(12)
    .scrollContentBackground(.hidden)
    .background(prLiquidGlassBackdrop().ignoresSafeArea())
  }
}

private struct PrUnmappedBannerPreviewScreen: View {
  @State private var expanded = true

  var body: some View {
    VStack(spacing: 20) {
      PrUnmappedThreadBanner(
        canAutoMap: true,
        canMap: true,
        isExpanded: $expanded,
        onAutoMap: {},
        onMap: {},
        onOpenInGitHub: {}
      )

      Text(expanded ? "Expanded" : "Collapsed")
        .font(.caption)
        .foregroundStyle(ADEColor.textMuted)
    }
    .padding(16)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    .background(prLiquidGlassBackdrop().ignoresSafeArea())
  }
}

private struct PrGitHubStackCardPreviewScreen: View {
  var body: some View {
    VStack {
      PrOverviewGitHubStackCard(
        stack: GitHubPrStackMembership(
          id: "github-stack:966",
          number: 966,
          size: 5,
          position: 4,
          baseBranch: "main"
        ),
        prNumber: 972,
        onOpenGitHub: {}
      )
    }
    .padding(16)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    .background(prLiquidGlassBackdrop().ignoresSafeArea())
  }
}

/// ADE-135. Header + checks tab for a PR nothing verified: the summary section's
/// subline carries the reason instead of the gate's green copy, and the checks
/// tab lists the required contexts that never reported as ghost rows.
private struct PrDetailNotRunPreviewScreen: View {
  @State private var commitsExpanded = false

  var body: some View {
    ScrollView {
      VStack(spacing: 14) {
        PrDetailSummarySection(
          pr: PrDetailPreviewFixtures.notRunPr,
          snapshot: PrDetailPreviewFixtures.notRunSnapshot,
          // Deliberately the green gate: the gate counts observed failures and
          // finds none, which is exactly the state the header must override.
          mergeGate: PrMergeGateInfo(tone: .green, subline: "All checks green", target: .overview),
          commitsExpanded: $commitsExpanded,
          onChecksTap: {},
          onFilesTap: {},
          onCommitTap: { _ in }
        )

        PrChecksTab(
          checks: [],
          overallChecksStatus: "not_run",
          checksReason: PrDetailPreviewFixtures.notRunReason,
          missingRequired: PrDetailPreviewFixtures.notRunMissingRequired,
          actionRuns: [],
          canRerunChecks: true,
          isLive: true,
          onRerun: {}
        )
      }
      .padding(16)
    }
    .background(prLiquidGlassBackdrop().ignoresSafeArea())
  }
}

#Preview("PR detail · Checks not run") {
  PrDetailNotRunPreviewScreen()
    .preferredColorScheme(.dark)
}

#Preview("PR detail · Checks not run · light") {
  PrDetailNotRunPreviewScreen()
    .preferredColorScheme(.light)
}

#Preview("PR detail · Overview thread") {
  PrDetailOverviewPreviewScreen()
    .preferredColorScheme(.dark)
}

#Preview("PR detail · Overview thread · light") {
  PrDetailOverviewPreviewScreen()
    .preferredColorScheme(.light)
}

#Preview("PR detail · Unmapped banner") {
  PrUnmappedBannerPreviewScreen()
    .preferredColorScheme(.dark)
}

#Preview("PR detail · GitHub stack") {
  PrGitHubStackCardPreviewScreen()
    .preferredColorScheme(.dark)
}
