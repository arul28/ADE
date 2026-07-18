#if DEBUG
import SwiftUI

@MainActor
private enum PrRowCardPreviewData {
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

  static var githubListRows: some View {
    ScrollView {
      VStack(spacing: 0) {
        PrRowCard(item: github559, linkedPr: linkedPr559)
        PrRowCard(item: github346)
        PrRowCard(item: github425)
      }
      .padding(.horizontal, 16)
    }
    .background(PrsLiquidBackdrop())
  }
}

#Preview("GitHub PR list rows") {
  PrRowCardPreviewData.githubListRows
}

#Preview("GitHub PR list rows · light") {
  PrRowCardPreviewData.githubListRows
    .preferredColorScheme(.light)
}

#Preview("Linked PR #559") {
  PrRowCard(
    item: PrRowCardPreviewData.github559,
    linkedPr: PrRowCardPreviewData.linkedPr559
  )
  .padding(.horizontal, 16)
  .background(PrsLiquidBackdrop())
}

#Preview("Unmapped bot PR #346") {
  PrRowCard(
    item: PrRowCardPreviewData.github346
  )
  .padding(.horizontal, 16)
  .background(PrsLiquidBackdrop())
}
#endif
