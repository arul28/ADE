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
  case queue
  case integration
  case rebase

  var id: String { rawValue }

  var title: String {
    switch self {
    case .all: return "All"
    case .queue: return "Queue"
    case .integration: return "Integration"
    case .rebase: return "Rebase"
    }
  }
}

enum PrGitHubStatusFilter: String, CaseIterable, Identifiable {
  case open
  case merged
  case closed
  case all

  var id: String { rawValue }

  var title: String {
    switch self {
    case .open: return "Open"
    case .merged: return "Merged"
    case .closed: return "Closed"
    case .all: return "All"
    }
  }
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
  case convergence
  case files
  case checks
  case activity

  var id: String { rawValue }

  var title: String {
    switch self {
    case .overview: return "Overview"
    case .convergence: return "Path"
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
