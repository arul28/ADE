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

/// The Lanes tab's one-tap filters (the chip row under the search field).
/// Running and Needs you read the lane's live chats, Changes its working tree.
enum LaneQuickFilter: String, CaseIterable, Identifiable {
  case active
  case running
  case attention
  case dirty
  case archived

  var id: String { rawValue }

  var title: String {
    switch self {
    case .active: return "Active"
    case .running: return "Running"
    case .attention: return "Needs you"
    case .dirty: return "Changes"
    case .archived: return "Archived"
    }
  }

  var scope: LaneListScope {
    self == .archived ? .archived : .active
  }

  var emptyTitle: String {
    switch self {
    case .active: return "No active lanes"
    case .running: return "Nothing running"
    case .attention: return "Nothing needs you"
    case .dirty: return "No uncommitted changes"
    case .archived: return "No archived lanes"
    }
  }

  func matches(_ snapshot: LaneListSnapshot) -> Bool {
    switch self {
    case .active: return snapshot.lane.archivedAt == nil
    case .archived: return snapshot.lane.archivedAt != nil
    case .running: return snapshot.lane.archivedAt == nil && snapshot.runtime.runningCount > 0
    case .attention: return snapshot.lane.archivedAt == nil && snapshot.runtime.awaitingInputCount > 0
    case .dirty: return snapshot.lane.archivedAt == nil && snapshot.lane.status.dirty
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
  case forcePush
  case rebaseAndPush

  var id: String {
    switch self {
    case .rebaseLane: return "rebase-lane"
    case .forcePush: return "force-push"
    case .rebaseAndPush: return "rebase-and-push"
    }
  }

  var title: String {
    switch self {
    case .rebaseLane: return "Rebase this lane?"
    case .forcePush: return "Force push?"
    case .rebaseAndPush: return "Rebase and push?"
    }
  }

  var message: String {
    switch self {
    case .rebaseLane:
      return "ADE will replay this lane on top of its base branch. Review the lane status before continuing."
    case .forcePush:
      return "This updates the remote branch with force-with-lease. Review the lane status before continuing."
    case .rebaseAndPush:
      return "ADE will rebase this lane, inspect upstream state, then push. If the branch diverged, it may use force-with-lease."
    }
  }

  var confirmTitle: String {
    switch self {
    case .rebaseLane: return "Rebase lane"
    case .forcePush: return "Force push"
    case .rebaseAndPush: return "Rebase and push"
    }
  }

  var actionLabel: String {
    switch self {
    case .rebaseLane: return "rebase lane"
    case .forcePush: return "force push"
    case .rebaseAndPush: return "rebase and push"
    }
  }
}

enum LaneFileConfirmation: Identifiable {
  case discardUnstaged(FileChange)
  case discardAllUnstaged([FileChange])
  case restoreStaged(FileChange)
  case restoreAllStaged([FileChange])

  var id: String {
    switch self {
    case .discardUnstaged(let file): return "discard:\(file.id)"
    case .discardAllUnstaged(let files): return "discard-all:\(files.count):\(files.map(\.id).joined(separator: ","))"
    case .restoreStaged(let file): return "restore:\(file.id)"
    case .restoreAllStaged(let files): return "restore-all:\(files.count):\(files.map(\.id).joined(separator: ","))"
    }
  }

  var title: String {
    switch self {
    case .discardUnstaged: return "Discard changes?"
    case .discardAllUnstaged: return "Discard all unstaged changes?"
    case .restoreStaged: return "Discard staged changes?"
    case .restoreAllStaged: return "Discard all staged changes?"
    }
  }

  var message: String {
    switch self {
    case .discardUnstaged:
      return "Unstaged changes to this file will be permanently lost."
    case .discardAllUnstaged(let files):
      return "Unstaged changes to \(files.count) file\(files.count == 1 ? "" : "s") will be permanently lost."
    case .restoreStaged:
      return "Staged changes to this file will be removed from the index and worktree. Unstaged edits to the same file will also be permanently lost."
    case .restoreAllStaged(let files):
      return "Staged changes to \(files.count) file\(files.count == 1 ? "" : "s") will be removed from the index and worktree. Unstaged edits to the same file\(files.count == 1 ? "" : "s") will also be permanently lost."
    }
  }

  var confirmTitle: String {
    switch self {
    case .discardUnstaged: return "Discard"
    case .discardAllUnstaged: return "Discard all"
    case .restoreStaged: return "Discard staged"
    case .restoreAllStaged: return "Discard staged"
    }
  }

  var actionLabel: String {
    switch self {
    case .discardUnstaged: return "discard file"
    case .discardAllUnstaged: return "discard all"
    case .restoreStaged: return "discard staged file"
    case .restoreAllStaged: return "discard staged files"
    }
  }

  var file: FileChange? {
    switch self {
    case .discardUnstaged(let file), .restoreStaged(let file):
      return file
    case .discardAllUnstaged, .restoreAllStaged:
      return nil
    }
  }
}

/// The two ways to make a lane, as on desktop: a fresh branch that starts
/// from a branch you pick, or a lane that works directly on an existing branch.
enum LaneCreateMode: String, CaseIterable, Identifiable {
  case newBranch
  case existingBranch

  var id: String { rawValue }

  var title: String {
    switch self {
    case .newBranch: return "Create new branch"
    case .existingBranch: return "Use existing branch"
    }
  }

  var help: String {
    switch self {
    case .newBranch: return "Makes a fresh branch for this lane, starting from the branch you pick."
    case .existingBranch: return "The lane works directly on a branch that already exists. No new branch is made."
    }
  }

  var symbol: String {
    switch self {
    case .newBranch: return "plus.square.on.square"
    case .existingBranch: return "arrow.triangle.branch"
    }
  }
}

struct LaneDeleteSelection: Equatable {
  var worktree = false
  var localBranch = false
  var remoteBranch = false

  static let empty = LaneDeleteSelection()

  var hasAny: Bool {
    worktree || localBranch || remoteBranch
  }

  var allSelected: Bool {
    worktree && localBranch && remoteBranch
  }
}

enum ManageLaneTab: String, CaseIterable, Identifiable {
  case delete
  case appearance
  case archive

  var id: String { rawValue }

  var title: String {
    switch self {
    case .delete: return "Delete"
    case .appearance: return "Appearance"
    case .archive: return "Archive"
    }
  }

  var symbol: String {
    switch self {
    case .delete: return "trash"
    case .appearance: return "paintbrush"
    case .archive: return "archivebox"
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

  var detail: String {
    switch self {
    case .worktree: return "Remove the ADE lane and worktree"
    case .localBranch: return "Also delete the local branch"
    case .remoteBranch: return "Also delete the remote branch"
    }
  }

  var symbol: String {
    switch self {
    case .worktree: return "folder.badge.minus"
    case .localBranch: return "arrow.triangle.branch"
    case .remoteBranch: return "cloud.slash"
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
