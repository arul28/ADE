#if DEBUG
import SwiftUI

@MainActor
private enum PrsRootPreviewData {
  static let iso: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
  }()

  static func iso(minutesAgo: Int) -> String {
    iso.string(from: Date().addingTimeInterval(-Double(minutesAgo * 60)))
  }

  static let linkedPr559 = PullRequestListItem(
    id: "pr-559",
    laneId: "lane-mobile-cleanup",
    laneName: "mobile app cleanup",
    projectId: "proj-ade",
    repoOwner: "arul28",
    repoName: "ADE",
    githubPrNumber: 559,
    githubUrl: "https://github.com/arul28/ADE/pull/559",
    title: "Mobile App Cleanup",
    state: "open",
    baseBranch: "main",
    headBranch: "ade/mobile-app-cleanup-b1ae5c6b",
    checksStatus: "passing",
    reviewStatus: "approved",
    additions: 412,
    deletions: 76,
    lastSyncedAt: nil,
    createdAt: iso(minutesAgo: 180),
    updatedAt: iso(minutesAgo: 180),
    adeKind: "single",
    linkedGroupId: nil,
    linkedGroupType: nil,
    linkedGroupName: nil,
    linkedGroupPosition: nil,
    linkedGroupCount: 0,
    workflowDisplayState: nil,
    cleanupState: nil
  )

  static let github559 = GitHubPrListItem(
    id: "gh-559",
    scope: "repo",
    repoOwner: "arul28",
    repoName: "ADE",
    githubPrNumber: 559,
    githubUrl: "https://github.com/arul28/ADE/pull/559",
    title: "Mobile App Cleanup",
    state: "open",
    isDraft: false,
    baseBranch: "main",
    headBranch: "ade/mobile-app-cleanup-b1ae5c6b",
    author: "arul28",
    createdAt: iso(minutesAgo: 180),
    updatedAt: iso(minutesAgo: 180),
    linkedPrId: linkedPr559.id,
    linkedGroupId: nil,
    linkedLaneId: linkedPr559.laneId,
    linkedLaneName: linkedPr559.laneName,
    adeKind: "single",
    workflowDisplayState: nil,
    cleanupState: nil,
    labels: [PrLabel(name: "mobile app cleanup", color: "8B5CF6")],
    isBot: false,
    commentCount: 0
  )

  static let github346 = GitHubPrListItem(
    id: "PR_kwDORNN9Fc7eiokw",
    scope: "repo",
    repoOwner: "arul28",
    repoName: "ADE",
    githubPrNumber: 346,
    githubUrl: "https://github.com/arul28/ADE/pull/346",
    title: "Bump eslint-plugin-react-hooks from 7.0.1 to 7.1.1 in /apps/desktop",
    state: "open",
    isDraft: false,
    baseBranch: "main",
    headBranch: "dependabot/npm_and_yarn/apps/desktop/eslint-plugin-react-hooks-7.1.1",
    author: "dependabot",
    createdAt: iso(minutesAgo: 60 * 24 * 14),
    updatedAt: iso(minutesAgo: 60 * 24 * 14),
    linkedPrId: nil,
    linkedGroupId: nil,
    linkedLaneId: nil,
    linkedLaneName: nil,
    adeKind: nil,
    workflowDisplayState: nil,
    cleanupState: nil,
    labels: [
      PrLabel(name: "dependencies", color: "0366d6"),
      PrLabel(name: "javascript", color: "168700"),
    ],
    isBot: true,
    commentCount: 0
  )

  static let github425 = GitHubPrListItem(
    id: "gh-425",
    scope: "repo",
    repoOwner: "arul28",
    repoName: "ADE",
    githubPrNumber: 425,
    githubUrl: "https://github.com/arul28/ADE/pull/425",
    title: "Bump @typescript-eslint/eslint-plugin from 8.46.2 to 8.48.0 in /apps/desktop",
    state: "open",
    isDraft: false,
    baseBranch: "main",
    headBranch: "dependabot/npm_and_yarn/apps/desktop/typescript-eslint-eslint-plugin-8.48.0",
    author: "dependabot",
    createdAt: iso(minutesAgo: 60 * 24 * 7),
    updatedAt: iso(minutesAgo: 60 * 24 * 7),
    linkedPrId: nil,
    linkedGroupId: nil,
    linkedLaneId: nil,
    linkedLaneName: nil,
    adeKind: nil,
    workflowDisplayState: nil,
    cleanupState: nil,
    labels: [
      PrLabel(name: "dependencies", color: "0366d6"),
      PrLabel(name: "javascript", color: "168700"),
    ],
    isBot: true,
    commentCount: 0
  )

  static let github344 = GitHubPrListItem(
    id: "gh-344",
    scope: "repo",
    repoOwner: "arul28",
    repoName: "ADE",
    githubPrNumber: 344,
    githubUrl: "https://github.com/arul28/ADE/pull/344",
    title: "Bump @types/node from 22.15.3 to 22.15.30 in /apps/desktop",
    state: "open",
    isDraft: false,
    baseBranch: "main",
    headBranch: "dependabot/npm_and_yarn/apps/desktop/types/node-22.15.30",
    author: "dependabot",
    createdAt: iso(minutesAgo: 60 * 24 * 14),
    updatedAt: iso(minutesAgo: 60 * 24 * 14),
    linkedPrId: nil,
    linkedGroupId: nil,
    linkedLaneId: nil,
    linkedLaneName: nil,
    adeKind: nil,
    workflowDisplayState: nil,
    cleanupState: nil,
    labels: [
      PrLabel(name: "dependencies", color: "0366d6"),
      PrLabel(name: "javascript", color: "168700"),
    ],
    isBot: true,
    commentCount: 0
  )

  // ADE-135. Sits directly under the passing row so the hollow dashed ring can be
  // compared against the green checkmark it used to be mistaken for.
  static let linkedPr988NotRun: PullRequestListItem = {
    var item = linkedPr559
    item.id = "pr-988"
    item.githubPrNumber = 988
    item.title = "GitHub Rate Limit Fallback"
    item.checksStatus = "not_run"
    item.checksReason = "3 checks reported, none from a CI provider. CI has not run on this commit."
    item.checksMissingRequired = ["CI / build"]
    return item
  }()

  static let github988NotRun: GitHubPrListItem = {
    var item = github559
    item.id = "gh-988"
    item.githubPrNumber = 988
    item.githubUrl = "https://github.com/arul28/ADE/pull/988"
    item.title = "GitHub Rate Limit Fallback"
    item.linkedPrId = linkedPr988NotRun.id
    return item
  }()

  static let categoryCounts = PrGitHubCategoryCounts(open: 21, merged: 0, closed: 0)
}

/// Lightweight harness for the PRs root GitHub surface shown in the live simulator.
/// Uses the same chrome + row components as `PRsTabView` without sync/network.
private struct PrsGitHubRootPreviewScreen: View {
  @State private var searchText = ""
  @State private var rootSurface: PrRootSurface = .github
  @State private var githubCategory: PrGitHubCategory = .open

  var body: some View {
    NavigationStack {
      List {
        PrsGlassSearchPill(
          text: $searchText,
          placeholder: "Search PRs, branches, authors"
        )
        .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 8, trailing: 16))
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)

        PrsSurfaceToggle(
          selection: $rootSurface,
          repoPrCount: 21,
          workflowCount: 1
        )
        .prListRow()

        PrGitHubCategoryTabs(
          selection: $githubCategory,
          counts: PrsRootPreviewData.categoryCounts
        )
        .prListRow()

        PrRowCard(
          item: PrsRootPreviewData.github559,
          linkedPr: PrsRootPreviewData.linkedPr559
        )
        .prListRowCard()

        PrRowCard(
          item: PrsRootPreviewData.github988NotRun,
          linkedPr: PrsRootPreviewData.linkedPr988NotRun
        )
        .prListRowCard()

        PrRowCard(
          item: PrsRootPreviewData.github346
        )
        .prListRowCard()

        PrRowCard(
          item: PrsRootPreviewData.github425
        )
        .prListRowCard()

        PrRowCard(
          item: PrsRootPreviewData.github344
        )
        .prListRowCard()
      }
      .listStyle(.plain)
      .listRowSpacing(2)
      .scrollContentBackground(.hidden)
      .adeScreenBackground()
      .adeNavigationGlass()
      .navigationTitle("")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar(.hidden, for: .navigationBar)
      .safeAreaInset(edge: .top, spacing: 0) {
        previewTopBar
      }
    }
  }

  private var previewTopBar: some View {
    HStack(alignment: .center, spacing: 12) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Text("PRs")
          .font(.system(size: 28, weight: .bold, design: .rounded))
          .tracking(-0.6)
          .foregroundStyle(PrsGlass.textPrimary)
        Text("21")
          .font(.system(size: 11, weight: .bold, design: .monospaced))
          .foregroundStyle(PrsGlass.textMuted)
          .padding(.horizontal, 6)
          .padding(.vertical, 2)
          .background(Capsule(style: .continuous).fill(Color.white.opacity(0.06)))
          .overlay(Capsule(style: .continuous).stroke(Color.white.opacity(0.10), lineWidth: 0.6))
      }
      Spacer(minLength: 0)
      HStack(spacing: 8) {
        PrsGlassDisc(tint: PrsGlass.textSecondary, isAlive: false) {
          Image(systemName: "line.3.horizontal.decrease.circle")
            .font(.system(size: 14, weight: .bold))
            .foregroundStyle(PrsGlass.textSecondary)
        }
        PrsGlassDisc(tint: PrsGlass.textSecondary, isAlive: false) {
          Image(systemName: "arrow.clockwise")
            .font(.system(size: 13, weight: .bold))
            .foregroundStyle(PrsGlass.textSecondary)
        }
        PrsAccentCapsule(isEnabled: true) {
          Image(systemName: "plus")
            .font(.system(size: 15, weight: .bold))
            .foregroundStyle(.white)
        }
      }
    }
    .padding(.horizontal, 16)
    .padding(.top, 8)
    .padding(.bottom, 10)
    .background(PrsLiquidBackdrop().opacity(0.001))
  }
}

#Preview("PRs · GitHub list") {
  PrsGitHubRootPreviewScreen()
}

#Preview("PRs · GitHub list · light") {
  PrsGitHubRootPreviewScreen()
    .preferredColorScheme(.light)
}
#endif
