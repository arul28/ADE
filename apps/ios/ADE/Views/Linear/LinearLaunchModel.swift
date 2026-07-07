import Foundation

// MARK: - Launch configuration

/// What to spin up when launching work on a Linear issue, mirroring the desktop
/// batch-launch session types.
enum LinearLaunchSessionType: String, CaseIterable, Identifiable {
  case chat
  case cli
  case laneOnly

  var id: String { rawValue }

  var title: String {
    switch self {
    case .chat: return "Chat"
    case .cli: return "CLI"
    case .laneOnly: return "Lane only"
    }
  }

  var systemImage: String {
    switch self {
    case .chat: return "bubble.left.and.bubble.right"
    case .cli: return "chevron.left.forwardslash.chevron.right"
    case .laneOnly: return "square.stack.3d.up"
    }
  }

  /// Lane-only skips all model/permission config.
  var needsAgentConfig: Bool { self != .laneOnly }
}

/// The resolved per-issue launch config the orchestration consumes.
struct LinearLaunchConfig: Equatable {
  var sessionType: LinearLaunchSessionType
  var provider: String
  var modelId: String
  var reasoningEffort: String
  var codexFastMode: Bool
  /// Access/permission mode key (`workRuntimeWireFields` input): default / plan /
  /// edit / full-auto, etc.
  var runtimeMode: String
  var kickoff: String
}

// MARK: - Orchestration

/// Injected side-effects so `runLinearLaunch` is unit-testable without a live
/// `SyncService`. Mirrors the desktop `BatchLaunchDeps` shape.
struct LinearLaunchDeps {
  /// Creates a lane pre-attached to the issue; returns the new lane id.
  var createLane: (_ issue: LaneLinearIssue, _ name: String, _ description: String) async throws -> String
  /// Launches an SDK chat agent in the lane; returns the session id.
  var launchChat: (_ laneId: String, _ config: LinearLaunchConfig) async throws -> String
  /// Launches a tracked CLI agent in the lane; returns the session id.
  var launchCli: (_ laneId: String, _ config: LinearLaunchConfig) async throws -> String
  /// Rolls back a lane minted this run when the agent launch fails afterward.
  var deleteLane: (_ laneId: String) async throws -> Void
}

/// The result of a single-issue launch.
enum LinearLaunchOutcome: Equatable {
  case laneOnly(laneId: String)
  case session(laneId: String, sessionId: String)

  var laneId: String {
    switch self {
    case let .laneOnly(laneId): return laneId
    case let .session(laneId, _): return laneId
    }
  }

  var sessionId: String? {
    switch self {
    case .laneOnly: return nil
    case let .session(_, sessionId): return sessionId
    }
  }
}

/// Create-lane → launch-agent → return, with lane rollback on a post-lane
/// launch failure (desktop parity). This is the single-issue slice of the
/// desktop `runBatchLaunch`.
func runLinearLaunch(
  issue: NormalizedLinearIssue,
  config: LinearLaunchConfig,
  deps: LinearLaunchDeps
) async throws -> LinearLaunchOutcome {
  let laneIssue = laneLinearIssue(from: issue)
  let laneName = linearIssueLaneName(identifier: issue.identifier, title: issue.title)
  let description = String(issue.title.prefix(280))

  let laneId = try await deps.createLane(laneIssue, laneName, description)

  guard config.sessionType.needsAgentConfig else {
    return .laneOnly(laneId: laneId)
  }

  do {
    let sessionId: String
    switch config.sessionType {
    case .cli:
      sessionId = try await deps.launchCli(laneId, config)
    default:
      sessionId = try await deps.launchChat(laneId, config)
    }
    return .session(laneId: laneId, sessionId: sessionId)
  } catch {
    // The agent never launched into the lane we just minted — tear it back down
    // so a launch failure doesn't leave an orphaned empty lane.
    try? await deps.deleteLane(laneId)
    throw error
  }
}

// MARK: - Issue → lane derivation (ported from shared/linearIssueBranch.ts)

/// "IDENT Title" — the lane name a Linear issue produces (desktop parity).
func linearIssueLaneName(identifier: String, title: String) -> String {
  "\(identifier.trimmingCharacters(in: .whitespaces)) \(title.trimmingCharacters(in: .whitespaces))"
    .trimmingCharacters(in: .whitespaces)
}

/// `ident-title-slug`, sanitized against Git ref rules (desktop parity). The
/// host re-validates, so this only needs to produce a sane candidate.
func linearIssueBranchName(identifier: String, title: String) -> String {
  let ident = identifier.trimmingCharacters(in: .whitespaces).lowercased()
  let slug = linearSlug(title)
  let branch = [ident, slug].filter { !$0.isEmpty }.joined(separator: "-")
  return linearSanitizeBranchName(branch.isEmpty ? ident : branch)
}

private func linearSlug(_ input: String) -> String {
  let lowered = input.trimmingCharacters(in: .whitespaces).lowercased()
  var out = ""
  var lastWasDash = false
  for scalar in lowered.unicodeScalars {
    let isAlnum = (scalar >= "a" && scalar <= "z") || (scalar >= "0" && scalar <= "9")
    if isAlnum {
      out.unicodeScalars.append(scalar)
      lastWasDash = false
    } else if !lastWasDash {
      out.append("-")
      lastWasDash = true
    }
  }
  return out.trimmingCharacters(in: CharacterSet(charactersIn: "-"))
}

func linearSanitizeBranchName(_ input: String) -> String {
  var value = input.trimmingCharacters(in: .whitespaces)
  if value.hasPrefix("refs/heads/") { value.removeFirst("refs/heads/".count) }
  if value.hasPrefix("origin/") { value.removeFirst("origin/".count) }
  // Replace Git-ref-invalid characters with a dash.
  let invalid = CharacterSet(charactersIn: "\\~^:?*[] \t\n").union(.whitespacesAndNewlines)
  value = String(String.UnicodeScalarView(value.unicodeScalars.map { invalid.contains($0) ? "-" : $0 }))
  // Collapse runs of dots and dashes; strip edge dashes/dots.
  while value.contains("..") { value = value.replacingOccurrences(of: "..", with: "-") }
  while value.contains("--") { value = value.replacingOccurrences(of: "--", with: "-") }
  if value.lowercased().hasSuffix(".lock") { value.removeLast(".lock".count) }
  value = value.trimmingCharacters(in: CharacterSet(charactersIn: "-./"))
  return value.isEmpty ? "linear-issue" : value
}

/// Trims a `NormalizedLinearIssue` down to the lane-facing `LaneLinearIssue`,
/// deriving the branch name (desktop's `linearBrowserIssueToLaneIssue`).
func laneLinearIssue(from issue: NormalizedLinearIssue) -> LaneLinearIssue {
  LaneLinearIssue(
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    url: issue.url,
    projectId: issue.projectId,
    projectSlug: issue.projectSlug,
    projectName: issue.projectName,
    teamId: issue.teamId,
    teamKey: issue.teamKey,
    teamName: issue.teamName,
    stateId: issue.stateId,
    stateName: issue.stateName,
    stateType: issue.stateType,
    priority: issue.priority,
    priorityLabel: issue.priorityLabel,
    labels: issue.labels,
    assigneeId: issue.assigneeId,
    assigneeName: issue.assigneeName,
    creatorId: issue.creatorId,
    creatorName: issue.creatorName,
    dueDate: issue.dueDate,
    estimate: issue.estimate,
    branchName: linearIssueBranchName(identifier: issue.identifier, title: issue.title),
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt
  )
}

/// Default editable kickoff prompt seeded into the launch screen for an issue.
func linearDefaultKickoff(for issue: NormalizedLinearIssue) -> String {
  let title = issue.title.trimmingCharacters(in: .whitespacesAndNewlines)
  return "Pick up \(issue.identifier): \(title).\n\nRead the attached Linear issue for full context, plan the change, then implement it."
}
