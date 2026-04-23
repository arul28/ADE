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

  var id: String { rawValue }

  var title: String {
    rawValue.capitalized
  }

  var symbol: String {
    switch self {
    case .git: return "arrow.triangle.branch"
    }
  }
}

enum LaneGitConfirmation: Identifiable {
  case rebaseLane
  case rebaseDescendants
  case forcePush
  case rebaseAndPush

  var id: String {
    switch self {
    case .rebaseLane: return "rebase-lane"
    case .rebaseDescendants: return "rebase-descendants"
    case .forcePush: return "force-push"
    case .rebaseAndPush: return "rebase-and-push"
    }
  }

  var title: String {
    switch self {
    case .rebaseLane: return "Rebase this lane?"
    case .rebaseDescendants: return "Rebase lane and descendants?"
    case .forcePush: return "Force push?"
    case .rebaseAndPush: return "Rebase and push?"
    }
  }

  var message: String {
    switch self {
    case .rebaseLane:
      return "ADE will replay this lane on top of its parent. Review the lane status before continuing."
    case .rebaseDescendants:
      return "ADE will replay this lane and child lanes. Review affected lanes before continuing."
    case .forcePush:
      return "This updates the remote branch with force-with-lease. Review the lane status before continuing."
    case .rebaseAndPush:
      return "ADE will rebase this lane, inspect upstream state, then push. If the branch diverged, it may use force-with-lease."
    }
  }

  var confirmTitle: String {
    switch self {
    case .rebaseLane: return "Rebase lane"
    case .rebaseDescendants: return "Rebase all"
    case .forcePush: return "Force push"
    case .rebaseAndPush: return "Rebase and push"
    }
  }

  var actionLabel: String {
    switch self {
    case .rebaseLane: return "rebase lane"
    case .rebaseDescendants: return "rebase descendants"
    case .forcePush: return "force push"
    case .rebaseAndPush: return "rebase and push"
    }
  }
}

enum LaneFileConfirmation: Identifiable {
  case discardUnstaged(FileChange)
  case discardAllUnstaged([FileChange])
  case restoreStaged(FileChange)

  var id: String {
    switch self {
    case .discardUnstaged(let file): return "discard:\(file.id)"
    case .discardAllUnstaged(let files): return "discard-all:\(files.count):\(files.map(\.id).joined(separator: ","))"
    case .restoreStaged(let file): return "restore:\(file.id)"
    }
  }

  var title: String {
    switch self {
    case .discardUnstaged: return "Discard changes?"
    case .discardAllUnstaged: return "Discard all unstaged changes?"
    case .restoreStaged: return "Restore staged file?"
    }
  }

  var message: String {
    switch self {
    case .discardUnstaged:
      return "Unstaged changes to this file will be permanently lost."
    case .discardAllUnstaged(let files):
      return "Unstaged changes to \(files.count) file\(files.count == 1 ? "" : "s") will be permanently lost."
    case .restoreStaged:
      return "The staged version of this file will be restored from HEAD."
    }
  }

  var confirmTitle: String {
    switch self {
    case .discardUnstaged: return "Discard"
    case .discardAllUnstaged: return "Discard all"
    case .restoreStaged: return "Restore"
    }
  }

  var actionLabel: String {
    switch self {
    case .discardUnstaged: return "discard file"
    case .discardAllUnstaged: return "discard all"
    case .restoreStaged: return "restore staged file"
    }
  }

  var file: FileChange? {
    switch self {
    case .discardUnstaged(let file), .restoreStaged(let file):
      return file
    case .discardAllUnstaged:
      return nil
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
