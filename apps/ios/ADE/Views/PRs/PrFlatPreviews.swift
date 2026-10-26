#if DEBUG
import SwiftUI

// Fixture screens for the flat PRs UI, for Xcode previews and bare-simulator
// screenshots (`-adePreviewScreen prs-list | pr-detail | pr-files | pr-diff |
// pr-checks`). No brain, no pairing, no network beyond avatars.

enum PrFlatPreviewData {
  static func iso(_ secondsAgo: TimeInterval) -> String {
    ISO8601DateFormatter().string(from: Date().addingTimeInterval(-secondsAgo))
  }

  static let hour: TimeInterval = 3_600
  static let day: TimeInterval = 86_400

  static func item(
    _ number: Int, _ title: String, state: String = "merged", author: String = "arul28", isBot: Bool = false,
    ago: TimeInterval, lane: String? = nil, laneId: String? = nil, detachedLane: String? = nil,
    head: String = "ade/branch", additions: Int, deletions: Int, draft: Bool = false
  ) -> GitHubPrListItem {
    GitHubPrListItem(
      id: "gh-\(number)", scope: "repo", repoOwner: "arul28", repoName: "ADE", githubPrNumber: number,
      githubUrl: "https://github.com/arul28/ADE/pull/\(number)", title: title, state: state, isDraft: draft,
      baseBranch: "main", headBranch: head, author: author, createdAt: iso(ago + 2 * day), updatedAt: iso(ago),
      linkedPrId: nil, linkedGroupId: nil, linkedLaneId: laneId ?? lane.map { "lane-\($0)" }, linkedLaneName: lane,
      adeKind: nil, workflowDisplayState: nil, cleanupState: nil, labels: [], isBot: isBot, commentCount: 4,
      detached: detachedLane.map { PrDetachedLane(at: iso(ago), laneName: $0, laneColor: nil, chats: 3, artifacts: 1, checkpoints: 0) },
      mergedAt: state == "merged" ? iso(ago) : nil, additions: additions, deletions: deletions
    )
  }

  static let mergedItems: [GitHubPrListItem] = [
    item(1370, "SDK 0.3: Versic report, typed runtime events and the new release notes", ago: 2 * hour, lane: "sdk 0.3 versic", head: "ade/sdk-0-3-versic", additions: 4_812, deletions: 1_203),
    item(1368, "Settings redesign with themes", ago: 3 * hour, lane: "settings redesign", laneId: "fleet|machine:mbp|lane-settings", head: "ade/settings-redesign", additions: 9_120, deletions: 2_310),
    item(1367, "Cross-machine lane links for the PR list", ago: 5 * hour, detachedLane: "cross-machine", head: "ade/cross-machine-to-phone", additions: 5_147, deletions: 3_099),
    item(1366, "chore(deps): bump electron from 38.1.0 to 38.2.1", author: "dependabot[bot]", isBot: true, ago: 7 * hour, head: "dependabot/npm/electron-38.2.1", additions: 12, deletions: 12),
    item(1361, "OpenCode 2.0 full migration", ago: day + 2 * hour, lane: "opencode 2", head: "ade/opencode-2", additions: 7_004, deletions: 5_880),
    item(1358, "Fix Copilot --no-alt-screen import", author: "devin-ai-integration[bot]", isBot: true, ago: day + 5 * hour, head: "devin/copilot-alt-screen", additions: 88, deletions: 21),
    item(1352, "Steer lifecycle: Steering… stays until the provider accepts", ago: 3 * day, lane: "steer lifecycle", head: "ade/steer-lifecycle", additions: 640, deletions: 212),
  ]

  static let body = """
  ## Summary
  Moves the lane links of every paired machine onto the phone's PR list, so a PR whose lane lives on the MacBook still shows its lane.

  - Each live machine answers `prs.list` for its checkout
  - Lane ids come back namespaced, so lane calls go to the right machine
  <!-- devin-review-comment {"id":"c-91","file":"apps/ios/ADE/Views/PRs/PrRemoteMachines.swift","line":85} -->

  ## Test plan
  - [x] Open a PR whose lane is on another machine
  - [x] Create a lane from a PR on the least busy machine
  <!-- CURSOR_AGENT_PR_BODY_BEGIN -->
  <!-- CURSOR_AGENT_PR_BODY_END -->

  <!-- This is an auto-generated comment: release notes by coderabbit.ai -->
  ## Summary by CodeRabbit
  * **New Features**
    * PR rows show the lane another machine holds.
  <!-- end of auto-generated comment: release notes by coderabbit.ai -->

  <!-- devin-review-badge-begin -->
  [Open with Devin](https://app.devin.ai/review/arul28/ADE/pull/1367)
  <!-- devin-review-badge-end -->
  """

  static func thread(_ id: String, author: String, bot: Bool, path: String, line: Int, body: String, resolved: Bool, ago: TimeInterval) -> PrReviewThread {
    PrReviewThread(
      id: id, isResolved: resolved, isOutdated: false, path: path, line: line, originalLine: line,
      startLine: nil, originalStartLine: nil, diffSide: "RIGHT", url: nil, createdAt: iso(ago), updatedAt: iso(ago),
      comments: [
        PrReviewThreadComment(id: "\(id)-c1", author: author, authorAvatarUrl: nil, authorIsBot: bot, body: body, url: nil, createdAt: iso(ago), updatedAt: iso(ago)),
        PrReviewThreadComment(id: "\(id)-c2", author: "arul28", authorAvatarUrl: nil, authorIsBot: false, body: "Fixed in the next push.", url: nil, createdAt: iso(ago - 600), updatedAt: nil),
      ]
    )
  }

  static let threads: [PrReviewThread] = {
    var result: [PrReviewThread] = []
    for index in 0..<10 {
      result.append(thread(
        "devin-\(index)", author: "devin-ai-integration", bot: true,
        path: "apps/ios/ADE/Views/PRs/PrRemoteMachines.swift", line: 40 + index * 7,
        body: "<!-- devin-review-comment {\"id\":\"\(index)\"} -->\n**Potential race:** the link map is rebuilt while a refresh is in flight.",
        resolved: true, ago: 9 * day - Double(index) * 600
      ))
    }
    result.append(thread("rabbit-1", author: "coderabbitai", bot: true, path: "apps/ios/ADE/Views/PRs/PrsRootScreen.swift", line: 612,
                         body: "_⚠️ Potential issue_\n\n**Guard against an empty machine key** before building the namespaced id.", resolved: false, ago: 2 * day))
    result.append(thread("rabbit-2", author: "coderabbitai", bot: true, path: "apps/ios/ADE/Services/SyncService.swift", line: 10302,
                         body: "Consider batching these refreshes.", resolved: true, ago: 2 * day - 60))
    result.append(thread("human-1", author: "octocat", bot: false, path: "apps/ios/ADE/Views/PRs/PrRowCard.swift", line: 128,
                         body: "Should the machine icon also show for the primary machine? I think not, but worth a second look.", resolved: false, ago: day))
    return result
  }()

  static let activity: [PrActivityEvent] = [
    PrActivityEvent(id: "commit-1", type: "commit", author: "arul", avatarUrl: nil, body: "feat(mobile): PRs link lanes on every machine", timestamp: iso(11 * day),
                    metadata: ["sha": .string("602290b33aa"), "shortSha": .string("602290b")]),
    PrActivityEvent(id: "commit-2", type: "commit", author: "arul", avatarUrl: nil, body: "fix(mobile): dead-machine retry loop", timestamp: iso(11 * day - 900),
                    metadata: ["sha": .string("d8febdd20bb"), "shortSha": .string("d8febdd")]),
    PrActivityEvent(id: "label-1", type: "label", author: "arul28", avatarUrl: nil, body: "Added label: mobile", timestamp: iso(10 * day), metadata: nil),
    PrActivityEvent(id: "commit-3", type: "commit", author: "arul", avatarUrl: nil, body: "feat(providers): route lane calls to the owner machine", timestamp: iso(3 * day),
                    metadata: ["sha": .string("e348c0e11cc"), "shortSha": .string("e348c0e")]),
    PrActivityEvent(id: "force-1", type: "force_push", author: "arul28", avatarUrl: nil, body: "Force-pushed branch", timestamp: iso(1.5 * day),
                    metadata: ["afterSha": .string("b0718e05d44")]),
  ]

  static let files: [PrFile] = [
    PrFile(filename: "apps/ios/ADE/Views/PRs/PrRemoteMachines.swift", status: "added", additions: 224, deletions: 0, patch: "@@ -0,0 +1,6 @@\n+import Foundation\n+\n+/// A PR whose lane lives on another machine.\n+struct PrRemoteLaneLink: Equatable {\n+  let laneId: String\n+}", previousFilename: nil),
    PrFile(filename: "apps/ios/ADE/Views/PRs/PrsRootScreen.swift", status: "modified", additions: 118, deletions: 41, patch: "@@ -12,7 +12,9 @@ struct PRsTabView: View {\n   @State private var path = NavigationPath()\n-  @State private var prs: [PullRequestListItem] = []\n+  @State private var prs: [PullRequestListItem] = []\n+  /// PR ↔ lane links of the other machines.\n+  @StateObject private var remotePrs = PrRemoteMachinesModel()\n   @State private var lanes: [LaneSummary] = []\n   @State private var errorMessage: String?\n   @State private var createPresented = false\n@@ -310,6 +312,10 @@ struct PRsTabView: View {\n     guard isActive else { return nil }\n+    let live = machineFleet.machines.filter { $0.state == .live }\n+    return live.map(\\.machineKey).joined(separator: \",\")\n   }", previousFilename: nil),
    PrFile(filename: "apps/ios/ADE/Views/PRs/PrRowCard.swift", status: "modified", additions: 32, deletions: 18, patch: "@@ -1,3 +1,3 @@\n-import SwiftUI\n+import SwiftUI\n import UIKit", previousFilename: nil),
    PrFile(filename: "apps/ios/ADE/Services/SyncService.swift", status: "modified", additions: 61, deletions: 9, patch: nil, previousFilename: nil),
    PrFile(filename: "apps/ios/ADETests/PrRemoteMachinesTests.swift", status: "added", additions: 140, deletions: 0, patch: nil, previousFilename: nil),
    PrFile(filename: "docs/mobile/multi-machine.md", status: "renamed", additions: 4, deletions: 2, patch: nil, previousFilename: "docs/mobile/machines.md"),
    PrFile(filename: "README.md", status: "modified", additions: 3, deletions: 1, patch: nil, previousFilename: nil),
    PrFile(filename: "apps/ios/ADE/Views/PRs/PrLegacyLaneOffer.swift", status: "removed", additions: 0, deletions: 212, patch: nil, previousFilename: nil),
  ]

  static let checks: [PrCheck] = [
    PrCheck(name: "ios / unit tests", status: "completed", conclusion: "failure", detailsUrl: "https://github.com/arul28/ADE/actions/runs/1", startedAt: iso(40 * 60), completedAt: iso(31 * 60)),
    PrCheck(name: "desktop / e2e (shard 2)", status: "in_progress", conclusion: nil, detailsUrl: nil, startedAt: iso(6 * 60), completedAt: nil),
    PrCheck(name: "desktop / typecheck", status: "completed", conclusion: "success", detailsUrl: nil, startedAt: iso(40 * 60), completedAt: iso(38 * 60)),
    PrCheck(name: "desktop / lint", status: "completed", conclusion: "success", detailsUrl: nil, startedAt: iso(40 * 60), completedAt: iso(39 * 60)),
    PrCheck(name: "desktop / unit (shard 1)", status: "completed", conclusion: "success", detailsUrl: nil, startedAt: iso(40 * 60), completedAt: iso(34 * 60)),
    PrCheck(name: "CodeRabbit", status: "completed", conclusion: "success", detailsUrl: nil, startedAt: iso(45 * 60), completedAt: iso(44 * 60)),
    PrCheck(name: "Vercel preview", status: "completed", conclusion: "skipped", detailsUrl: nil, startedAt: nil, completedAt: nil),
  ]

  static let actionRuns: [PrActionRun] = [
    PrActionRun(id: 1, name: "CI", status: "completed", conclusion: "failure", headSha: "b0718e0", htmlUrl: "https://github.com/arul28/ADE/actions/runs/1",
                createdAt: iso(40 * 60), updatedAt: iso(31 * 60), jobs: [
                  PrActionJob(id: 11, name: "ios / unit tests", status: "completed", conclusion: "failure", startedAt: iso(40 * 60), completedAt: iso(31 * 60), steps: [
                    PrActionStep(name: "Set up job", status: "completed", conclusion: "success", number: 1, startedAt: iso(40 * 60), completedAt: iso(40 * 60 - 3)),
                    PrActionStep(name: "Build for testing", status: "completed", conclusion: "success", number: 2, startedAt: iso(40 * 60), completedAt: iso(34 * 60)),
                    PrActionStep(name: "Run ADETests", status: "completed", conclusion: "failure", number: 3, startedAt: iso(34 * 60), completedAt: iso(31 * 60)),
                  ])
                ]),
  ]

  static func pr(state: String = "merged") -> PullRequestListItem {
    PullRequestListItem(
      id: "pr-1367", laneId: "", laneName: nil, projectId: "ade", repoOwner: "arul28", repoName: "ADE", githubPrNumber: 1367,
      githubUrl: "https://github.com/arul28/ADE/pull/1367", title: "Cross-machine lane links for the PR list", state: state,
      baseBranch: "main", headBranch: "ade/cross-machine-to-phone", checksStatus: "failing", reviewStatus: "approved",
      additions: 5_147, deletions: 3_099, lastSyncedAt: nil, createdAt: iso(12 * day), updatedAt: iso(3 * hour),
      adeKind: nil, linkedGroupId: nil, linkedGroupType: nil, linkedGroupName: nil, linkedGroupPosition: nil, linkedGroupCount: 0,
      workflowDisplayState: nil, cleanupState: nil, mergedAt: state == "merged" ? iso(3 * hour) : nil,
      mergedBy: PrMergedBy(login: "arul28", avatarUrl: nil)
    )
  }

  static func snapshot() -> PullRequestSnapshot {
    PullRequestSnapshot(
      detail: PrDetail(prId: "pr-1367", body: body, assignees: [], author: PrUser(login: "arul28"), isDraft: false,
                       labels: [], requestedReviewers: [], milestone: nil, linkedIssues: []),
      status: nil,
      checks: checks,
      reviews: [
        PrReview(reviewer: "devin-ai-integration", state: "commented", body: "Reviewed 12 files. <!-- devin-review-summary -->", submittedAt: iso(9 * day), reviewerIsBot: true),
        PrReview(reviewer: "octocat", state: "approved", body: "Looks good. The namespaced ids are a nice touch.", submittedAt: iso(4 * hour)),
      ],
      comments: [
        PrComment(id: "c1", author: "devin-ai-integration", authorIsBot: true, body: "<!-- devin-review-comment {} -->\nI finished the review.", source: "issue", createdAt: iso(9 * day)),
        PrComment(id: "c2", author: "arul28", body: "Merging once the phone test passes on the MacBook too.", source: "issue", createdAt: iso(5 * hour)),
      ],
      files: files
    )
  }
}

extension PrFlatPreviewData {
  /// The open, bot-heavy PR as the Duo's column sees it: one failing and one
  /// running check, two open threads, reviewers, labels and an assignee.
  static func duoModel(state: String = "open", conversation: Bool = false) -> PrDuoDetailModel {
    let pr = pr(state: state)
    var snapshot = snapshot()
    if conversation {
      // `pr-conversation`: reactions on the description and on comments, one
      // of them the viewer's own (editable, its reaction tinted).
      snapshot.detail?.nodeId = "PR_kwDO1367"
      snapshot.detail?.reactions = [
        PrReviewThreadReaction(id: "r1", content: "rocket", user: "octocat"),
        PrReviewThreadReaction(id: "r2", content: "+1", user: "summary", count: 3),
      ]
      snapshot.comments = [
        PrComment(id: "c1", author: "devin-ai-integration", authorIsBot: true, body: "<!-- devin-review-comment {} -->\nI finished the review.", source: "issue", createdAt: iso(9 * day)),
        PrComment(id: "c3", author: "octocat", body: "Tried it on the iPad: the lane chips name the right machine now.", source: "issue", createdAt: iso(6 * hour), githubId: 9001, nodeId: "IC_octo", reactions: [
          PrReviewThreadReaction(id: "r3", content: "heart", user: "arul28"),
          PrReviewThreadReaction(id: "r4", content: "+1", user: "someone"),
        ]),
        PrComment(id: "c2", author: "arul28", body: "Merging once the phone test passes on the MacBook too.", source: "issue", createdAt: iso(5 * hour), githubId: 9002, nodeId: "IC_mine", reactions: [
          PrReviewThreadReaction(id: "r5", content: "eyes", user: "octocat"),
        ]),
      ]
    }
    snapshot.detail?.labels = [
      PrLabel(name: "mobile", color: "0E8A16", description: nil),
      PrLabel(name: "multi-machine", color: "5319E7", description: nil),
    ]
    snapshot.detail?.assignees = [PrUser(login: "arul28")]
    snapshot.detail?.requestedReviewers = [PrUser(login: "octocat"), PrUser(login: "coderabbitai", isBot: true)]
    let cleaned = prCleanBody(snapshot.detail?.body)
    let inputs = prDigestInputs(pr: pr, snapshot: snapshot, reviewThreads: threads, activity: activity, bodySections: cleaned.sections)
    let step = PrNextStep.resolve(PrNextStepInput(
      state: state, mergeStateStatus: state == "open" ? .blocked : nil, mergeConflicts: false, behindBaseBy: 0,
      mergeabilityComputing: false, checksStatus: "failing", failingChecks: 1, pendingChecks: 1, passingChecks: 4,
      reviewDecision: .approved, approvalsCount: 1, requiredApprovals: 1, changesRequestedBy: [], unresolvedThreads: 2,
      canBypass: true, autoMergeAllowed: true, autoMergeEnabled: false, autoMergeMethod: nil, baseBranch: "main"
    ))
    return PrDuoDetailModel(
      title: pr.title,
      number: pr.githubPrNumber,
      state: state,
      author: "arul28",
      description: cleaned.body,
      digest: buildPrConversationDigest(commits: inputs.commits, entries: inputs.entries, story: inputs.story),
      threadsById: Dictionary(uniqueKeysWithValues: threads.map { ($0.id, $0) }),
      files: snapshot.files,
      canOpenFiles: true,
      checks: snapshot.checks,
      overallChecksStatus: "failing",
      actionRuns: actionRuns,
      canRerun: true,
      step: step,
      canAct: true,
      canComment: true,
      canReview: state == "open",
      canEditMetadata: true,
      detail: snapshot.detail,
      reviews: snapshot.reviews,
      mergedSummary: state == "merged" ? "Merged into main by arul28 · 3h ago" : nil,
      canArchiveLane: true,
      canMergeAnyway: true,
      canOpenGitHub: true,
      conversation: conversation
        ? PrConversationControls(
            viewerLogin: "arul28",
            canReact: true,
            canEditComments: true,
            descriptionSubjectId: snapshot.detail?.nodeId,
            descriptionReactions: snapshot.detail?.reactions ?? []
          )
        : .none
    )
  }
}

extension PrDuoDetailActions {
  /// Actions that do nothing, for fixture screens.
  static let inert = PrDuoDetailActions(
    refresh: {}, retry: {}, reply: { _, _ in }, resolve: { _, _ in }, openFile: { _ in }, copyPath: { _ in },
    rerun: {}, runStep: { _ in },
    stepLabel: { action in
      switch action {
      case .fixChecks: return "Open checks"
      case .rerunChecks: return "Re-run checks"
      case .deleteBranch: return "Delete branch"
      default: return "Continue"
      }
    },
    stepAvailable: { _ in true },
    merge: {}, mergeAnyway: {}, stackMerge: {}, archiveLane: {}, comment: { _ in }, review: { _, _ in },
    requestReviewers: { _ in }, setLabels: { _ in }, openGitHub: {}
  )
}

/// `-adePreviewScreen prs-list`: the Merged tab with date groups.
struct PrsListPreviewHost: View {
  @State private var category = PrGitHubCategory.merged
  @State private var search = ""
  @StateObject private var drawer = ActivityDrawerModel()

  var body: some View {
    NavigationStack {
      List {
        let groups = prListPeriodGroups(PrFlatPreviewData.mergedItems)
        ForEach(Array(groups.enumerated()), id: \.element.id) { index, group in
          Section {
            ForEach(group.items) { item in
              let machine = item.linkedLaneId?.hasPrefix("fleet|") == true ? "MacBook Pro" : nil
              PrRowCard(item: item, laneMachineName: machine)
                .adeFlatRow(insets: EdgeInsets(top: 11, leading: 16, bottom: 11, trailing: 16))
                .contextMenu {
                  Button("Open lane", systemImage: "arrow.triangle.branch") {}
                  Button("Open in GitHub", systemImage: "arrow.up.right.square") {}
                  Button("Copy link", systemImage: "link") {}
                }
            }
          } header: {
            PrListGroupHeader(group: group, isLoading: index == 0)
          }
        }
      }
      .adeFlatList()
      // The real list's header (PrsRootScreen): ‹ logo and "PRs ▾", then
      // search, New pull request and ⋯, then Open / Merged / Closed.
      .safeAreaInset(edge: .top, spacing: 0) {
        PrListHeaderBar(
          searchText: $search,
          prompt: "Search PRs",
          filterActive: false,
          canCreate: true,
          onCreate: {},
          onOpenActivity: {},
          onOpenSettings: {}
        ) {
          Button("Mine") {}
        } category: {
          Picker("Status", selection: $category) {
            Text(verbatim: "Open 17").tag(PrGitHubCategory.open)
            Text(verbatim: "Merged 1035").tag(PrGitHubCategory.merged)
            Text(verbatim: "Closed 167").tag(PrGitHubCategory.closed)
          }
          .pickerStyle(.segmented)
        }
      }
      .navigationTitle("")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          HStack(spacing: 6) {
            WorkHeaderProjectButton(iconDataUrl: nil) {}
            PrListTitleLabel(title: "PRs")
          }
          .padding(.horizontal, 4)
        }
        .sharedBackgroundVisibility(.hidden)
      }
    }
    .environmentObject(drawer)
  }
}

/// `-adePreviewScreen pr-detail | pr-files | pr-checks`: the phone's PR
/// detail, the same `PrDuoDetail` the app pushes (`.phone` context).
struct PrDetailPreviewHost: View {
  @State var tab: PrDetailTab
  var state = "merged"
  var conversation = false
  @State private var method: PrMergeMethodOption = .squash

  var body: some View {
    NavigationStack {
      PrDuoDetail(
        model: PrFlatPreviewData.duoModel(state: state, conversation: conversation),
        actions: .inert,
        tab: $tab,
        mergeMethod: $method,
        context: .phone,
        header: {
          PrFlatDetailHeader(
            createdAt: PrFlatPreviewData.iso(12 * PrFlatPreviewData.day),
            updatedAt: PrFlatPreviewData.iso(3 * PrFlatPreviewData.hour),
            title: "",
            baseBranch: "main",
            headBranch: "ade/cross-machine-to-phone",
            laneName: "cross-machine",
            ghostLaneName: nil,
            machineName: "MacBook Pro",
            stackLabel: nil,
            onOpenLane: {},
            onOpenStack: nil,
            canCreateLane: false,
            canLinkLane: false,
            onCreateLane: {},
            onLinkLane: {},
            showsTitle: false
          )
        },
        overflow: {
          Button("Comment", systemImage: "text.bubble") {}
          Button("Copy link", systemImage: "link") {}
        }
      )
    }
  }
}

/// `-adePreviewScreen pr-diff`: one file's diff with previous / next.
struct PrDiffPreviewHost: View {
  var body: some View {
    NavigationStack {
      PrFileDiffPage(files: PrFlatPreviewData.files, initialIndex: 1, canOpenFiles: true, onOpenFile: { _ in }, onCopyPath: { _ in })
    }
  }
}

/// `-adePreviewScreen pr-media`: a description whose text holds media. Unlike
/// the other fixture screens this one needs the network: the pictures and the
/// video are real GitHub attachments of a public pull request, because how a
/// remote attachment loads is the thing on show.
struct PrDescriptionMediaPreviewHost: View {
  private static let text = """
  ## What changed

  One line on top says what needs you. The description is right under it.

  | Before | After |
  | --- | --- |
  | ![The description is first. The open threads are below it.](https://github.com/user-attachments/assets/c7542908-8982-4bab-b3d0-5d961e4e528f)<!-- ade-proof:8b381a30 --> | ![One line on top says what needs you.](https://github.com/user-attachments/assets/697ac6b5-88c3-4527-bf54-0f389f7909e7)<!-- ade-proof:4a817cd7 --> |

  ## Evidence

  A click on the line opens the list:

  ![A click on the line opens the list of open threads](https://github.com/user-attachments/assets/bdfdb4f9-c868-4844-b502-75e0597caefa)

  "Add to chat" on a part of the text:

  https://github.com/user-attachments/assets/83908590-2459-482d-bce8-9fbe8c7b7974
  """

  var body: some View {
    NavigationStack {
      ScrollView {
        PrFlatDescription(text: prCleanBody(Self.text).body)
          .padding(16)
      }
      .navigationTitle("#1595")
      .navigationBarTitleDisplayMode(.inline)
    }
  }
}

#Preview("PRs · merged list") { PrsListPreviewHost() }
#Preview("PR detail · overview") { PrDetailPreviewHost(tab: .overview) }
#Preview("PR detail · files") { PrDetailPreviewHost(tab: .files) }
#Preview("PR detail · checks") { PrDetailPreviewHost(tab: .checks, state: "open") }
#Preview("PR diff") { PrDiffPreviewHost() }
#endif
