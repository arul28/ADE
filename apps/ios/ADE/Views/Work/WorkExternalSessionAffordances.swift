import Foundation

// Swift mirror of `apps/desktop/src/shared/externalSessionPolicy.ts` — the one
// source of truth for which import actions exist. Keep the table, labels, notes
// and lock reason in lockstep with that file; `ADETests` mirrors its tests.

/// Which lanes an import action may target.
///
/// - `any`: any lane.
/// - `home`: only the session's home lane. A session with no live home lane
///   (outside folder, removed lane) may go to any lane and runs in its folder.
/// - `root`: only the home lane, and only when the session folder is that
///   lane's worktree root — ADE chats always run at the lane root.
/// - `none`: not offered.
enum WorkImportLaneRule: Int, Equatable {
  case none = 0
  case root = 1
  case home = 2
  case any = 3
}

struct WorkProviderImportRules: Equatable {
  /// Continue the same provider session as an ADE chat.
  var chatContinue: WorkImportLaneRule
  /// A new ADE chat with this history (native fork or full replay).
  var chatCopy: WorkImportLaneRule
  /// Continue the same provider session in a tracked CLI terminal.
  var cliContinue: WorkImportLaneRule
  /// A provider-native copy in a tracked CLI terminal.
  var cliCopy: WorkImportLaneRule
}

/// Import surfaces, in display order. Wire values for `target`.
let workImportSurfaces = ["chat", "cli"]

/// The provider table. Host capabilities can only narrow it
/// (see `workEffectiveImportRules`).
let workProviderImportRules: [String: WorkProviderImportRules] = [
  "claude": WorkProviderImportRules(chatContinue: .root, chatCopy: .any, cliContinue: .home, cliCopy: .any),
  "codex": WorkProviderImportRules(chatContinue: .any, chatCopy: .any, cliContinue: .any, cliCopy: .any),
  "cursor": WorkProviderImportRules(chatContinue: .none, chatCopy: .any, cliContinue: .home, cliCopy: .none),
  "droid": WorkProviderImportRules(chatContinue: .none, chatCopy: .any, cliContinue: .home, cliCopy: .any),
  "opencode": WorkProviderImportRules(chatContinue: .none, chatCopy: .any, cliContinue: .home, cliCopy: .home),
  "pi": WorkProviderImportRules(chatContinue: .none, chatCopy: .any, cliContinue: .home, cliCopy: .home),
  "qwen": WorkProviderImportRules(chatContinue: .none, chatCopy: .any, cliContinue: .home, cliCopy: .home),
  "kimi": WorkProviderImportRules(chatContinue: .none, chatCopy: .any, cliContinue: .home, cliCopy: .none),
  "grok": WorkProviderImportRules(chatContinue: .none, chatCopy: .any, cliContinue: .home, cliCopy: .home),
  "copilot": WorkProviderImportRules(chatContinue: .root, chatCopy: .any, cliContinue: .home, cliCopy: .none),
]

private let workNoImportRules = WorkProviderImportRules(chatContinue: .none, chatCopy: .none, cliContinue: .none, cliCopy: .none)

/// Canonical provider key for the import table ("factory" is Droid's old id).
func workExternalSessionProviderKey(_ provider: String) -> String {
  let key = provider.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  return key == "factory" ? "droid" : key
}

private func workNarrowerRule(_ left: WorkImportLaneRule, _ right: WorkImportLaneRule) -> WorkImportLaneRule {
  left.rawValue <= right.rawValue ? left : right
}

/// The provider table narrowed by what the host reported for this session: a
/// missing source folder, a droid without `--fork`. Unknown providers get nothing.
func workEffectiveImportRules(_ session: ExternalSessionSummary) -> WorkProviderImportRules {
  guard let base = workProviderImportRules[workExternalSessionProviderKey(session.provider)] else {
    return workNoImportRules
  }
  let cap = session.capabilities
  let cliContinueCap: WorkImportLaneRule = cap.resumeInDifferentCwd ? .any : cap.resumeInPlace ? .home : .none
  let cliCopyCap: WorkImportLaneRule = cap.forkIntoDifferentCwd ? .any : cap.fork ? .home : .none
  return WorkProviderImportRules(
    chatContinue: cap.importToChat ? base.chatContinue : .none,
    // The list already hides sessions with no prompts; an empty replay is
    // refused by the chat importer itself.
    chatCopy: base.chatCopy,
    cliContinue: workNarrowerRule(base.cliContinue, cliContinueCap),
    cliCopy: workNarrowerRule(base.cliCopy, cliCopyCap)
  )
}

private func workHomeLaneId(_ home: ExternalSessionHome?) -> String? {
  guard let home, home.kind == "lane", let laneId = home.laneId, !laneId.isEmpty else { return nil }
  return laneId
}

/// Whether `rule` lets an action target `targetLaneId` for this session.
func workLaneRuleAllows(_ rule: WorkImportLaneRule, home: ExternalSessionHome?, targetLaneId: String?) -> Bool {
  switch rule {
  case .none:
    return false
  case .any:
    return true
  case .home:
    let homeId = workHomeLaneId(home)
    return homeId == nil || homeId == targetLaneId
  case .root:
    guard let homeId = workHomeLaneId(home) else { return false }
    return homeId == targetLaneId && home?.atLaneRoot == true
  }
}

/// Whether `rule` can reach any lane other than the home lane.
private func workRuleReachesOtherLanes(_ rule: WorkImportLaneRule, home: ExternalSessionHome?) -> Bool {
  switch rule {
  case .any: return true
  case .home: return workHomeLaneId(home) == nil
  case .root, .none: return false
  }
}

struct WorkImportPlanAction: Equatable {
  /// "chat" or "cli".
  var target: String
  /// Wire value for the import `mode`: "resume" or "fork".
  var mode: String
  var label: String
  /// A chat copy lets the user pick the model.
  var needsModel: Bool
}

struct WorkImportPlan: Equatable {
  /// Surfaces that have at least one action for some lane.
  var surfaces: [String]
  /// The surface this plan describes (the requested one, else the first available).
  var surface: String?
  /// The lane the actions run against after locking.
  var targetLaneId: String?
  var laneLocked: Bool
  var lockReason: String?
  var primary: WorkImportPlanAction?
  var secondary: WorkImportPlanAction?
  /// One short line under the action bar, or nil.
  var note: String?
}

private func workRulesForSurface(_ rules: WorkProviderImportRules, _ surface: String) -> (resume: WorkImportLaneRule, fork: WorkImportLaneRule) {
  surface == "chat"
    ? (rules.chatContinue, rules.chatCopy)
    : (rules.cliContinue, rules.cliCopy)
}

/// Everything the action bar shows, for one session, surface and target lane.
/// The screen renders this plan as-is; it never decides on its own which
/// actions exist.
func workPlanImport(
  _ session: ExternalSessionSummary,
  surface requestedSurface: String?,
  targetLaneId requestedTargetLaneId: String?,
  laneName: ((String) -> String?)? = nil
) -> WorkImportPlan {
  let rules = workEffectiveImportRules(session)
  let surfaces = workImportSurfaces.filter { surface in
    let pair = workRulesForSurface(rules, surface)
    return pair.resume != .none || pair.fork != .none
  }
  let surface: String? = requestedSurface.flatMap { surfaces.contains($0) ? $0 : nil } ?? surfaces.first
  guard let surface else {
    return WorkImportPlan(
      surfaces: surfaces,
      surface: nil,
      targetLaneId: requestedTargetLaneId,
      laneLocked: false,
      lockReason: nil,
      primary: nil,
      secondary: nil,
      note: nil
    )
  }

  let home = session.home
  let homeId = workHomeLaneId(home)
  let pair = workRulesForSurface(rules, surface)
  let laneLocked = homeId != nil
    && !workRuleReachesOtherLanes(pair.resume, home: home)
    && !workRuleReachesOtherLanes(pair.fork, home: home)
  let targetLaneId = laneLocked ? homeId : requestedTargetLaneId
  let providerLabel = workExternalSessionProviderName(session.provider)
  func nameOf(_ laneId: String?) -> String? {
    guard let laneId else { return nil }
    return laneName?(laneId) ?? (laneId == homeId ? home?.laneName : nil)
  }

  let canContinue = workLaneRuleAllows(pair.resume, home: home, targetLaneId: targetLaneId)
  let canCopy = workLaneRuleAllows(pair.fork, home: home, targetLaneId: targetLaneId)
  let awayFromHome = homeId != nil && targetLaneId != homeId

  func copyAction(_ label: String) -> WorkImportPlanAction {
    WorkImportPlanAction(target: surface, mode: "fork", label: label, needsModel: surface == "chat")
  }

  var primary: WorkImportPlanAction?
  var secondary: WorkImportPlanAction?
  if canContinue {
    primary = WorkImportPlanAction(target: surface, mode: "resume", label: "Continue", needsModel: false)
    if canCopy { secondary = copyAction("Copy") }
  } else if canCopy {
    primary = copyAction(surface == "chat" ? "Open as ADE chat" : awayFromHome ? "Copy here" : "Copy")
  }

  var note: String?
  if primary?.mode == "resume" && session.possiblyActive {
    note = "Open elsewhere — close it there first."
  } else if primary?.mode == "fork", awayFromHome, let homeName = nameOf(homeId) {
    note = "Original stays in \(homeName)."
  } else if primary?.mode == "resume",
            surface == "cli",
            pair.resume != .any,
            homeId == nil,
            home != nil {
    note = "Runs in its original folder."
  }

  return WorkImportPlan(
    surfaces: surfaces,
    surface: surface,
    targetLaneId: targetLaneId,
    laneLocked: laneLocked,
    lockReason: laneLocked ? "\(providerLabel) sessions stay in their own lane." : nil,
    primary: primary,
    secondary: secondary,
    note: note
  )
}

/// Label for a surface in the mode switch.
func workImportSurfaceLabel(_ surface: String) -> String {
  surface == "chat" ? "ADE chat" : "CLI"
}

func workNormalizedImportedSessionKind(_ kind: String) -> String? {
  switch kind.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
  case "chat", "cli": return kind.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  default: return nil
  }
}

func workImportedSessionRef(for session: ExternalSessionSummary) -> ExternalSessionImportedRef? {
  guard session.alreadyImported, let ref = session.importedSessionRef else { return nil }
  guard let kind = workNormalizedImportedSessionKind(ref.kind) else { return nil }
  let sessionId = ref.sessionId.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !sessionId.isEmpty else { return nil }
  return ExternalSessionImportedRef(kind: kind, sessionId: sessionId)
}

/// One provider-label map for the import feature. Mirrors
/// `EXTERNAL_SESSION_PROVIDER_LABELS`.
func workExternalSessionProviderName(_ provider: String) -> String {
  switch workExternalSessionProviderKey(provider) {
  case "claude": return "Claude"
  case "codex": return "Codex"
  case "cursor": return "Cursor"
  case "droid": return "Droid"
  case "opencode": return "OpenCode"
  case "pi": return "Pi"
  case "qwen": return "Qwen"
  case "kimi": return "Kimi"
  case "grok": return "Grok"
  case "copilot": return "Copilot"
  default:
    let trimmed = provider.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? "Unknown" : trimmed
  }
}
