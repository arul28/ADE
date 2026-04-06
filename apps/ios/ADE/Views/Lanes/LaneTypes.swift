import SwiftUI

// MARK: - Enums

enum LaneListScope: String, CaseIterable, Identifiable {
  case active
  case archived
  case all

  var id: String { rawValue }

  var title: String {
    switch self {
    case .active: return "Active"
    case .archived: return "Archived"
    case .all: return "All"
    }
  }
}

enum LaneRuntimeFilter: String, CaseIterable, Identifiable {
  case all
  case running
  case awaitingInput = "awaiting-input"
  case ended

  var id: String { rawValue }

  var title: String {
    switch self {
    case .all: return "All"
    case .running: return "Running"
    case .awaitingInput: return "Awaiting"
    case .ended: return "Ended"
    }
  }

  var symbol: String {
    switch self {
    case .all: return "line.3.horizontal.decrease.circle"
    case .running: return "waveform.path.ecg"
    case .awaitingInput: return "exclamationmark.bubble.fill"
    case .ended: return "stop.circle.fill"
    }
  }
}

enum LaneDetailSection: String, CaseIterable, Identifiable {
  case overview
  case work
  case git
  case manage

  var id: String { rawValue }

  var title: String {
    rawValue.capitalized
  }

  var symbol: String {
    switch self {
    case .overview: return "square.grid.2x2"
    case .git: return "arrow.triangle.branch"
    case .work: return "terminal"
    case .manage: return "slider.horizontal.3"
    }
  }
}

enum LaneCreateMode: String, CaseIterable, Identifiable {
  case primary
  case child
  case importBranch
  case rescueUnstaged

  var id: String { rawValue }

  /// Short label for segmented pickers on phone screens.
  var title: String {
    switch self {
    case .primary:
      return "Primary"
    case .child:
      return "Child"
    case .importBranch:
      return "Import"
    case .rescueUnstaged:
      return "Rescue"
    }
  }

  /// Full description for accessibility and subtitles.
  var fullTitle: String {
    switch self {
    case .primary:
      return "Primary lane"
    case .child:
      return "Child lane"
    case .importBranch:
      return "Import existing branch"
    case .rescueUnstaged:
      return "Rescue unstaged work"
    }
  }
}

enum LaneDeleteMode: String, CaseIterable, Identifiable {
  case worktree
  case localBranch = "local_branch"
  case remoteBranch = "remote_branch"

  var id: String { rawValue }

  var title: String {
    switch self {
    case .worktree: return "Worktree only"
    case .localBranch: return "Worktree + local"
    case .remoteBranch: return "Worktree + local + remote"
    }
  }
}

// MARK: - Model structs

struct LaneDetailSheetTarget: Identifiable {
  var id: String { "\(laneId):\(initialSection.rawValue)" }
  let laneId: String
  let snapshot: LaneListSnapshot
  let initialSection: LaneDetailSection
}

struct LaneDiffRequest: Identifiable {
  var id: String { "\(laneId):\(mode):\(path ?? "none"):\(compareRef ?? "none"):\(compareTo ?? "none")" }
  let laneId: String
  let path: String?
  let mode: String
  let compareRef: String?
  let compareTo: String?
  let title: String
}

struct LaneChatLaunchTarget: Identifiable {
  var id: String { provider }
  let provider: String
}
