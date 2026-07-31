import SwiftUI

struct PrActionAvailability: Equatable {
  let showsMerge: Bool
  let mergeEnabled: Bool
  let showsClose: Bool
  let showsReopen: Bool
  let showsRequestReviewers: Bool

  init(prState: String) {
    switch prState {
    case "open":
      showsMerge = true
      mergeEnabled = true
      showsClose = true
      showsReopen = false
      showsRequestReviewers = true
    case "draft":
      showsMerge = true
      mergeEnabled = false
      showsClose = false
      showsReopen = false
      showsRequestReviewers = true
    case "closed":
      showsMerge = false
      mergeEnabled = false
      showsClose = false
      showsReopen = true
      showsRequestReviewers = false
    default:
      showsMerge = false
      mergeEnabled = false
      showsClose = false
      showsReopen = false
      showsRequestReviewers = false
    }
  }
}

enum PrRootSurface: String, CaseIterable, Identifiable {
  case github
  case workflows

  var id: String { rawValue }

  var title: String {
    switch self {
    case .github: return "GitHub"
    case .workflows: return "Workflows"
    }
  }
}

enum PrWorkflowKindFilter: String, CaseIterable, Identifiable {
  case all
  case integration
  case rebase

  var id: String { rawValue }

  var title: String {
    switch self {
    case .all: return "All"
    case .integration: return "Integration"
    case .rebase: return "Rebase"
    }
  }
}

enum PrGitHubStatusFilter: String, CaseIterable, Identifiable {
  case open
  case draft
  case merged
  case closed
  case all

  var id: String { rawValue }

  var title: String {
    switch self {
    case .open: return "Open"
    case .draft: return "Draft"
    case .merged: return "Merged"
    case .closed: return "Closed"
    case .all: return "All"
    }
  }
}

/// The three primary GitHub status categories shown as the headline selector,
/// mirroring desktop's GitHubTab. `open` folds `draft` in (state == open OR
/// draft). Order + colors match desktop: Open (#60A5FA), Merged (#4ADE80),
/// Closed (#A1A1AA).
enum PrGitHubCategory: String, CaseIterable, Identifiable {
  case open
  case merged
  case closed

  var id: String { rawValue }

  var title: String {
    switch self {
    case .open: return "Open"
    case .merged: return "Merged"
    case .closed: return "Closed"
    }
  }

  /// Accent color per desktop's `stateColor`/`FILTER_COLORS`.
  var tint: Color {
    switch self {
    case .open: return Color(red: 0x60 / 255, green: 0xA5 / 255, blue: 0xFA / 255)
    case .merged: return Color(red: 0x4A / 255, green: 0xDE / 255, blue: 0x80 / 255)
    case .closed: return Color(red: 0xA1 / 255, green: 0xA1 / 255, blue: 0xAA / 255)
    }
  }

  var icon: String? {
    switch self {
    case .open: return "arrow.triangle.pull"
    case .merged: return "arrow.merge"
    case .closed: return "xmark.circle"
    }
  }

  /// Bridge to the richer 5-way status filter used by the existing derivation
  /// pipeline. `open` keeps the `.open` filter (draft is folded in by the
  /// category-aware matcher); merged/closed map 1:1.
  var statusFilter: PrGitHubStatusFilter {
    switch self {
    case .open: return .open
    case .merged: return .merged
    case .closed: return .closed
    }
  }
}

/// Per-category counts for the three headline tabs. Open folds draft in.
struct PrGitHubCategoryCounts: Equatable {
  let open: Int
  let merged: Int
  let closed: Int

  func count(for category: PrGitHubCategory) -> Int {
    switch category {
    case .open: return open
    case .merged: return merged
    case .closed: return closed
    }
  }

  static let zero = PrGitHubCategoryCounts(open: 0, merged: 0, closed: 0)
}

enum PrGitHubScopeFilter: String, CaseIterable, Identifiable {
  case all
  case ade
  case external

  var id: String { rawValue }

  var title: String {
    switch self {
    case .all: return "All"
    case .ade: return "ADE"
    case .external: return "External"
    }
  }
}

enum PrGitHubSortOption: String, CaseIterable, Identifiable {
  case updated
  case created
  case number

  var id: String { rawValue }

  var title: String {
    switch self {
    case .updated: return "Updated"
    case .created: return "Created"
    case .number: return "Number"
    }
  }
}

struct PrGitHubFilterCounts: Equatable {
  let open: Int
  let draft: Int
  let merged: Int
  let closed: Int
  let all: Int
  let ade: Int
  let external: Int
}

struct PrGitHubLaneLinkRequest: Identifiable {
  let item: GitHubPrListItem

  var id: String { item.id }
}

/// Drives the "Create lane from PR branch" (auto-map) confirmation surface.
/// Holds the source GitHub item plus the (optional) resolved preflight so the
/// sheet can show the target lane name / blocking conflict before committing.
struct PrAutoMapRequest: Identifiable {
  let item: GitHubPrListItem

  var id: String { "automap:\(item.id)" }
}

/// Surfaces an auto-map blocking conflict as a thrown error so the durable
/// action wrapper routes it through the standard failure path (toast + reload).
enum PrAutoMapError: LocalizedError {
  case blocked(String)

  var errorDescription: String? {
    switch self {
    case .blocked(let message): return message
    }
  }
}

enum PrReviewEventOption: String, CaseIterable, Identifiable {
  case approve = "APPROVE"
  case requestChanges = "REQUEST_CHANGES"
  case comment = "COMMENT"

  var id: String { rawValue }

  var title: String {
    switch self {
    case .approve: return "Approve"
    case .requestChanges: return "Request changes"
    case .comment: return "Comment"
    }
  }
}

enum PrDetailEditorSheet: Identifiable {
  case title(String)
  case body(String)
  case labels(String)
  case review

  var id: String {
    switch self {
    case .title: return "title"
    case .body: return "body"
    case .labels: return "labels"
    case .review: return "review"
    }
  }
}

enum PrDiffDisplayLineKind: Equatable {
  case hunk
  case context
  case added
  case removed
  case note
}

struct PrDiffDisplayLine: Identifiable, Equatable {
  var id: String {
    "\(kind)-\(oldLineNumber ?? -1)-\(newLineNumber ?? -1)-\(prefix)-\(text)"
  }

  let kind: PrDiffDisplayLineKind
  let prefix: String
  let text: String
  let oldLineNumber: Int?
  let newLineNumber: Int?
}

struct PrPatchPreviewLimit: Equatable {
  let title: String
  let message: String
}

enum PrTimelineEventKind: Equatable {
  case stateChange
  case review
  case comment
  case deployment
  case commit
  case label
  case ci
  case forcePush
  case reviewRequest
}

struct PrTimelineEvent: Identifiable, Equatable {
  let id: String
  let kind: PrTimelineEventKind
  let title: String
  let author: String?
  let body: String?
  let timestamp: String
  let metadata: String?
}

enum PrMergeMethodOption: String, CaseIterable, Identifiable {
  case squash
  case merge
  case rebase

  var id: String { rawValue }

  var title: String {
    switch self {
    case .squash: return "Squash and merge"
    case .merge: return "Create a merge commit"
    case .rebase: return "Rebase and merge"
    }
  }

  var shortTitle: String {
    switch self {
    case .squash: return "Squash"
    case .merge: return "Merge"
    case .rebase: return "Rebase"
    }
  }

  var description: String {
    switch self {
    case .squash: return "Combine all commits into one clean commit."
    case .merge: return "Preserve the branch history with a merge commit."
    case .rebase: return "Replay commits onto the base branch for linear history."
    }
  }
}

enum PrDetailTab: String, CaseIterable, Identifiable {
  case overview
  case files
  case checks
  case activity

  var id: String { rawValue }

  var title: String {
    switch self {
    case .overview: return "Overview"
    case .files: return "Files"
    case .checks: return "Checks"
    case .activity: return "Activity"
    }
  }
}

struct PrStackPresentation: Identifiable {
  let id: String
  let groupName: String?
}

struct PrRebaseWorkflowItem: Identifiable {
  let laneId: String
  let laneName: String
  let branchRef: String
  let behindCount: Int
  let severity: String
  let statusMessage: String
  let deferredUntil: String?

  var id: String { laneId }
}

enum PrCleanupChoice {
  case archive
  case deleteBranch
}

// MARK: - Durable PR action / detail state (lives on SyncService)

/// A single in-flight PR action tracked durably on `SyncService` so its
/// spinner survives a tab switch + view remount. The `token` disambiguates
/// completions when the same `key` is reused for a newer action.
struct PrInFlightAction: Identifiable, Equatable {
  let token: UUID
  let key: String
  let label: String
  let startedAt: Date

  var id: String { key }
}

/// A fully-loaded PR detail snapshot + sidecars cached on `SyncService` so
/// re-opening a PR (or re-entering the PRs tab) renders instantly while a
/// freshness-gated background refresh runs. `loadedAt` drives the freshness
/// gate. Not `Equatable` (its members are large + some are not Equatable),
/// which is fine — it is read imperatively, never diffed in a view body.
struct PrDetailWarmEntry {
  var pr: PullRequestListItem?
  var githubItem: GitHubPrListItem?
  var snapshot: PullRequestSnapshot?
  var reviewThreads: [PrReviewThread]
  var actionRuns: [PrActionRun]
  var activityEvents: [PrActivityEvent]
  var deployments: [PrDeployment]
  var groupMembers: [PrGroupMemberSummary]
  var capabilities: PrActionCapabilities?
  var unavailableParts: [String]
  var loadedAt: Date
}

/// Precomputed, memoized derivations of the GitHub PR list. Recomputing the
/// filter/sort/count passes inside `body`-read computed properties was a major
/// lag source: every SwiftUI render re-filtered the full snapshot, re-sorted
/// with date-string parsing, and made seven extra full passes for the counts.
/// This struct is rebuilt only when its inputs change (snapshot or filters),
/// not on every render.
struct PrGitHubDerivedList: Equatable {
  var filtered: [GitHubPrListItem]
  var repoItems: [GitHubPrListItem]
  var externalItems: [GitHubPrListItem]
  var counts: PrGitHubFilterCounts
  /// Scope-filtered counts for the three headline tabs (Open/Merged/Closed),
  /// memoized here so a `body` pass never re-scans the snapshot.
  var categoryCounts: PrGitHubCategoryCounts
  var allCount: Int
  var linkedCount: Int

  static let empty = PrGitHubDerivedList(
    filtered: [],
    repoItems: [],
    externalItems: [],
    counts: PrGitHubFilterCounts(open: 0, draft: 0, merged: 0, closed: 0, all: 0, ade: 0, external: 0),
    categoryCounts: .zero,
    allCount: 0,
    linkedCount: 0
  )
}
