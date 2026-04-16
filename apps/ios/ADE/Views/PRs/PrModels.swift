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

enum PrListStateFilter: String, CaseIterable, Identifiable {
  case all
  case open
  case draft
  case closed
  case merged

  var id: String { rawValue }

  var title: String {
    switch self {
    case .all: return "All"
    case .open: return "Open"
    case .draft: return "Draft"
    case .closed: return "Closed"
    case .merged: return "Merged"
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

enum PrTimelineEventKind: Equatable {
  case stateChange
  case review
  case comment
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
