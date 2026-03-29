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
  case git
  case work
  case overview
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
  var id: String { "\(laneId):\(mode):\(path ?? "none"):\(compareRef ?? "none")" }
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
