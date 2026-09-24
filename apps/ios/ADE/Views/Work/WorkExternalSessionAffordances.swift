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
///
/// Chat continue for Droid, OpenCode, Pi and Copilot seeds the provider's own
/// session pointer. Cursor, Qwen, Kimi and Grok stay `none` until a live run
/// proves their CLI session can be loaded by ADE's chat runtime.
let workProviderImportRules: [String: WorkProviderImportRules] = [
  "claude": WorkProviderImportRules(chatContinue: .root, chatCopy: .any, cliContinue: .home, cliCopy: .any),
  "codex": WorkProviderImportRules(chatContinue: .any, chatCopy: .any, cliContinue: .any, cliCopy: .any),
  "cursor": WorkProviderImportRules(chatContinue: .none, chatCopy: .any, cliContinue: .home, cliCopy: .none),
  "droid": WorkProviderImportRules(chatContinue: .root, chatCopy: .any, cliContinue: .home, cliCopy: .any),
  "opencode": WorkProviderImportRules(chatContinue: .root, chatCopy: .any, cliContinue: .home, cliCopy: .home),
  "pi": WorkProviderImportRules(chatContinue: .root, chatCopy: .any, cliContinue: .home, cliCopy: .home),
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
  /// A chat copy takes a model. Desktop shows a picker; the phone sends no
  /// model and the host picks the session's family, else the provider default.
  var needsModel: Bool
  /// Continuing a session that may still be open elsewhere asks for a second
  /// tap before it runs; two writers on one provider session corrupt it.
  var confirmBeforeRun: Bool = false
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
  originLaneId: String? = nil,
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
    WorkImportPlanAction(target: surface, mode: "fork", label: label, needsModel: surface == "chat", confirmBeforeRun: false)
  }

  var primary: WorkImportPlanAction?
  var secondary: WorkImportPlanAction?
  if canContinue {
    primary = WorkImportPlanAction(
      target: surface,
      mode: "resume",
      label: "Continue",
      needsModel: false,
      confirmBeforeRun: session.possiblyActive
    )
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
            // An older host sends no `home`; its folder check is the only signal,
            // and it answers for the lane the list was scanned for
            // (`originLaneId`), not the lane picked since.
            home != nil
              || session.cwdMatchesRequestedLane != true
              || (originLaneId != nil && targetLaneId != originLaneId) {
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

/// Host-side guard, mirrored so the phone refuses the same imports with the
/// same words before a round trip. Mirrors `importRejectionReason`.
func workImportRejectionReason(
  _ session: ExternalSessionSummary,
  target: String,
  mode: String,
  laneId: String
) -> String? {
  let rules = workEffectiveImportRules(session)
  let pair = workRulesForSurface(rules, target)
  let rule = mode == "resume" ? pair.resume : pair.fork
  let label = workExternalSessionProviderName(session.provider)
  if rule == .none {
    let what: String
    if target == "chat" {
      what = mode == "resume" ? "continued as an ADE chat" : "opened as an ADE chat"
    } else {
      what = mode == "resume" ? "continued in a terminal" : "copied in a terminal"
    }
    return "This \(label) session can't be \(what)."
  }
  if !workLaneRuleAllows(rule, home: session.home, targetLaneId: laneId) {
    if let homeName = session.home?.laneName, !homeName.isEmpty {
      return "This \(label) session can only do that in \(homeName)."
    }
    return "This \(label) session can't do that in this lane."
  }
  return nil
}

/// Sessions with no prompts have nothing to continue or replay; the list hides
/// them, like the desktop dialog. An unknown count stays visible.
func workImportHasPrompts(_ session: ExternalSessionSummary) -> Bool {
  guard let count = session.messageCount else { return true }
  return count > 0
}

/// Date section for the import list: "Today", "Yesterday", a weekday within
/// the last week, else a short date. Mirrors `sessionDateGroup`. Accepts
/// seconds or milliseconds.
func workImportDateGroup(_ timestamp: Double?, now: Date = Date(), calendar: Calendar = .current) -> String {
  guard let timestamp, timestamp.isFinite, timestamp > 0 else { return "Older" }
  let seconds = timestamp > 10_000_000_000 ? timestamp / 1000 : timestamp
  let date = Date(timeIntervalSince1970: seconds)
  let today = calendar.startOfDay(for: now)
  let day = calendar.startOfDay(for: date)
  if day == today { return "Today" }
  if let yesterday = calendar.date(byAdding: .day, value: -1, to: today), day == yesterday {
    return "Yesterday"
  }
  if now.timeIntervalSince(date) < 7 * 24 * 60 * 60 {
    return date.formatted(.dateTime.weekday(.wide))
  }
  return date.formatted(.dateTime.month(.abbreviated).day().year())
}

/// The last import mode picked for a provider, shared by every import screen.
/// Same idea as the desktop's `ade.importSession.surface.<provider>`.
func workImportSurfacePreference(_ provider: String, defaults: UserDefaults = .standard) -> String? {
  let value = defaults.string(forKey: "ade.importSession.surface.\(workExternalSessionProviderKey(provider))")
  return value.flatMap { workImportSurfaces.contains($0) ? $0 : nil }
}

func workSetImportSurfacePreference(_ provider: String, surface: String, defaults: UserDefaults = .standard) {
  guard workImportSurfaces.contains(surface) else { return }
  defaults.set(surface, forKey: "ade.importSession.surface.\(workExternalSessionProviderKey(provider))")
}

/// Every provider the importer scans, in display order. Mirrors
/// `EXTERNAL_SESSION_PROVIDERS`.
let workImportSessionProviders = [
  "claude", "codex", "cursor", "droid", "opencode", "pi", "qwen", "kimi", "grok", "copilot",
]

/// The ACP providers a host learned together with `work.getExternalSessionDetail`.
let workImportAcpProviders: Set<String> = ["qwen", "kimi", "grok", "copilot"]

/// Providers worth asking this host about. An older host (no
/// `work.getExternalSessionDetail`) refuses the ACP providers by name, so the
/// phone does not ask it about them at all.
func workImportScanProviders(hostKnowsAcpProviders: Bool) -> [String] {
  hostKnowsAcpProviders
    ? workImportSessionProviders
    : workImportSessionProviders.filter { !workImportAcpProviders.contains($0) }
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
