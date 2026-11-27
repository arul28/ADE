import CryptoKit
import Foundation
import SwiftUI
import os

private let workAutoLaneNamingLog = Logger(subsystem: "com.ade.ios", category: "AutoLaneNaming")
private let workLaunchIssueLog = Logger(subsystem: "com.ade.ios", category: "WorkLaunch")

struct WorkAutoLaneNameSuggestion {
  let name: String
  let hostApplied: Bool
}

func workCursorCloudLaunchFingerprint(
  projectId: String?,
  laneId: String,
  promptText: String,
  repoUrl: String,
  startingRef: String?,
  modelId: String?,
  serviceTier: String?,
  autoCreatePR: Bool,
  secretNames: [String]
) -> String {
  let material = [
    projectId ?? "",
    laneId,
    promptText,
    repoUrl,
    startingRef ?? "",
    modelId ?? "",
    serviceTier ?? "",
    autoCreatePR ? "1" : "0",
    secretNames.sorted().joined(separator: "\u{1f}"),
  ].joined(separator: "\u{1e}")
  return SHA256.hash(data: Data(material.utf8))
    .map { String(format: "%02x", $0) }
    .joined()
}

@MainActor
protocol WorkAutoLaneNamingClient: AnyObject {
  func supportsRemoteAction(_ action: String) -> Bool

  func suggestLaneName(
    laneId: String,
    prompt: String,
    modelId: String,
    fallbackName: String,
    temporaryBranch: String?,
    attachments: [AgentChatFileRef],
    targetProjectId: String?,
    targetProjectRootPath: String?
  ) async throws -> WorkAutoLaneNameSuggestion

  func renameLane(
    _ laneId: String,
    name: String,
    targetProjectId: String?,
    targetProjectRootPath: String?
  ) async throws
}

extension SyncService: WorkAutoLaneNamingClient {}

enum WorkAutoLaneNamingSurface: String {
  case workNewChat = "work_new_chat"
  case hubComposer = "hub_composer"
}

enum WorkAutoLaneNamingOutcome: Equatable {
  case missingModel
  case keptFallback
  case renamed(String)
  case suggestFailed(String)
  case renameFailed(String)
}

struct WorkProjectCommandScope: Equatable {
  let projectId: String?
  let projectRootPath: String?
}

private func workNonEmptyScopeValue(_ value: String?) -> String? {
  let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  return trimmed.isEmpty ? nil : trimmed
}

private func workShellProjectRootCandidate(from path: String?) -> String? {
  guard let normalized = syncNormalizedProjectRootScope(path) else { return nil }
  if let range = normalized.range(of: "/.ade/worktrees/") {
    return String(normalized[..<range.lowerBound])
  }
  return normalized
}

private func workUniqueRoots(_ roots: [String?]) -> [String] {
  var seen = Set<String>()
  return roots.compactMap { root in
    guard let root, !seen.contains(root) else { return nil }
    seen.insert(root)
    return root
  }
}

private func workAutoLaneNamingErrorIsTransient(_ message: String) -> Bool {
  let value = message.lowercased()
  let permanentMarkers = [
    "disabled", "not authenticated", "no authenticated", "unsupported",
    "capability", "invalid structured", "invalid output", "manual",
    "branch safety",
  ]
  if permanentMarkers.contains(where: { value.contains($0) }) {
    return false
  }
  return ["timeout", "timed out", "temporar", "rate limit", "connection", "unavailable"]
    .contains { value.contains($0) }
}

func workShellProjectScope(
  for lane: LaneSummary,
  projects: [MobileProjectSummary]
) -> WorkProjectCommandScope {
  let laneProjectId = workNonEmptyScopeValue(lane.projectId)
  let projectById = laneProjectId.flatMap { id in projects.first { $0.id == id } }
  let expectedRoots = workUniqueRoots([
    workShellProjectRootCandidate(from: lane.attachedRootPath),
    workShellProjectRootCandidate(from: lane.worktreePath),
  ])

  let projectByLanePath = projects.first { project in
    guard let root = syncNormalizedProjectRootScope(project.rootPath) else { return false }
    return expectedRoots.contains(root)
  }

  let project = laneProjectId == nil ? projectByLanePath : projectById
  let projectId = laneProjectId ?? project?.id
  let rootPath = syncNormalizedProjectRootScope(project?.rootPath)

  return WorkProjectCommandScope(projectId: projectId, projectRootPath: rootPath)
}

@discardableResult
@MainActor
func workRunAutoLaneAiRename(
  laneId: String,
  opener: String,
  fallbackName: String,
  modelId: String,
  temporaryBranch: String? = nil,
  attachments: [AgentChatFileRef] = [],
  syncService: WorkAutoLaneNamingClient,
  surface: WorkAutoLaneNamingSurface,
  targetProjectId: String? = nil,
  targetProjectRootPath: String? = nil,
  maxAttempts: Int = 2,
  retryDelayNanoseconds: UInt64 = 750_000_000,
  refreshLanes: (@MainActor () async -> Void)? = nil
) async -> WorkAutoLaneNamingOutcome {
  let trimmedModelId = modelId.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !trimmedModelId.isEmpty else {
    workAutoLaneNamingLog.error(
      "auto_lane_naming_skipped_missing_model surface=\(surface.rawValue, privacy: .public) lane=\(laneId, privacy: .public)"
    )
    return .missingModel
  }

  let actionAdvertised = syncService.supportsRemoteAction("lanes.suggestName")
  workAutoLaneNamingLog.notice(
    "auto_lane_naming_start surface=\(surface.rawValue, privacy: .public) lane=\(laneId, privacy: .public) model=\(trimmedModelId, privacy: .public) targetProject=\(targetProjectId ?? "active", privacy: .public) advertised=\(actionAdvertised, privacy: .public)"
  )

  let attempts = max(1, maxAttempts)
  for attempt in 1...attempts {
    do {
      workAutoLaneNamingLog.notice(
        "auto_lane_naming_suggest_attempt surface=\(surface.rawValue, privacy: .public) lane=\(laneId, privacy: .public) attempt=\(attempt, privacy: .public)"
      )
      let suggestion = try await syncService.suggestLaneName(
        laneId: laneId,
        prompt: opener,
        modelId: trimmedModelId,
        fallbackName: fallbackName,
        temporaryBranch: temporaryBranch,
        attachments: attachments,
        targetProjectId: targetProjectId,
        targetProjectRootPath: targetProjectRootPath
      )
      let suggested = suggestion.name.trimmingCharacters(in: .whitespacesAndNewlines)

      if suggestion.hostApplied {
        if let refreshLanes {
          await refreshLanes()
        }
        return suggested.isEmpty || suggested == fallbackName
          ? .keptFallback
          : .renamed(suggested)
      }

      guard !suggested.isEmpty, suggested != fallbackName else {
        workAutoLaneNamingLog.notice(
          "auto_lane_naming_kept_fallback surface=\(surface.rawValue, privacy: .public) lane=\(laneId, privacy: .public) attempt=\(attempt, privacy: .public)"
        )
        return .keptFallback
      }

      do {
        try await syncService.renameLane(
          laneId,
          name: suggested,
          targetProjectId: targetProjectId,
          targetProjectRootPath: targetProjectRootPath
        )
        workAutoLaneNamingLog.notice(
          "auto_lane_naming_renamed surface=\(surface.rawValue, privacy: .public) lane=\(laneId, privacy: .public) name=\(suggested, privacy: .public)"
        )
        if let refreshLanes {
          await refreshLanes()
        }
        return .renamed(suggested)
      } catch {
        let message = error.localizedDescription
        workAutoLaneNamingLog.error(
          "auto_lane_naming_rename_failed surface=\(surface.rawValue, privacy: .public) lane=\(laneId, privacy: .public) error=\(message, privacy: .public)"
        )
        return .renameFailed(message)
      }
    } catch {
      let message = error.localizedDescription
      if attempt < attempts && workAutoLaneNamingErrorIsTransient(message) {
        workAutoLaneNamingLog.warning(
          "auto_lane_naming_suggest_retrying surface=\(surface.rawValue, privacy: .public) lane=\(laneId, privacy: .public) attempt=\(attempt, privacy: .public) error=\(message, privacy: .public)"
        )
        if retryDelayNanoseconds > 0 {
          try? await Task.sleep(nanoseconds: retryDelayNanoseconds)
        }
        continue
      }
      workAutoLaneNamingLog.error(
        "auto_lane_naming_suggest_failed surface=\(surface.rawValue, privacy: .public) lane=\(laneId, privacy: .public) attempts=\(attempt, privacy: .public) error=\(message, privacy: .public)"
      )
      return .suggestFailed(message)
    }
  }

  return .suggestFailed("Auto lane naming did not complete.")
}

enum WorkNewSessionMode: String, CaseIterable, Identifiable {
  case chat
  case cli

  var id: String { rawValue }

  var title: String {
    switch self {
    case .chat: return "Chat"
    case .cli: return "CLI"
    }
  }

  var systemImage: String {
    switch self {
    case .chat: return "bubble.left.and.bubble.right"
    case .cli: return "chevron.left.forwardslash.chevron.right"
    }
  }

  var accessibilityDescription: String {
    switch self {
    case .chat: return "In-app chat agent"
    case .cli: return "Terminal CLI agent"
    }
  }
}

func workQueuedNewSessionConsumesOpeningDraft(_ mode: WorkNewSessionMode) -> Bool {
  // CLI start is atomic: its queued payload already contains initialInput.
  // Chat creation queues only the empty session, so its separate opener must
  // remain in the composer until the real session materializes.
  mode == .cli
}

/// Per-project "last explicitly chosen" Chat vs CLI interface for the new-session
/// composers. Restored as the default when the composer opens so the choice
/// survives app restarts, project switches, and launching a session — desktop
/// keeps the same choice per project in `WorkProjectViewState.draftKind`.
/// Written ONLY on an explicit tap of the Chat/CLI switcher, never by
/// programmatic model-availability fallbacks, so a stored CLI choice that a
/// restored chat-only model can't honor drops to chat for that session without
/// discarding the preference. Shared between the in-project New Chat screen and
/// the all-projects hub composer.
enum WorkNewSessionModePreferences {
  /// Versioned map of projectId → mode raw value, so a future field change can
  /// migrate rather than mis-decode.
  private static let storageKey = "ade.work.newSessionModeByProject.v1"
  private static var defaults: UserDefaults { ADESharedContainer.defaults }

  private static func normalizedProjectId(_ projectId: String?) -> String? {
    let trimmed = projectId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return trimmed.isEmpty ? nil : trimmed
  }

  /// The last explicitly chosen interface for this project, or nil when the user
  /// has not picked one yet (the caller then defaults to `.chat`).
  static func load(projectId: String?) -> WorkNewSessionMode? {
    guard let key = normalizedProjectId(projectId) else { return nil }
    let map = defaults.dictionary(forKey: storageKey) as? [String: String]
    guard let raw = map?[key] else { return nil }
    return WorkNewSessionMode(rawValue: raw)
  }

  /// Persists the user's explicit interface choice for this project. No-op when
  /// the project id is unknown so a nil-scope session can't clobber a good record.
  static func save(_ mode: WorkNewSessionMode, projectId: String?) {
    guard let key = normalizedProjectId(projectId) else { return }
    var map = (defaults.dictionary(forKey: storageKey) as? [String: String]) ?? [:]
    map[key] = mode.rawValue
    defaults.set(map, forKey: storageKey)
  }

  /// Resolves the interface to actually use for a session given a stored choice
  /// and the current model: honors the stored choice but drops a CLI preference
  /// to chat when the model can't run in CLI. Pure — reads and writes no store —
  /// so it is safe to reuse from init and from live per-project switches without
  /// ever overwriting an explicit switcher choice.
  static func resolvedMode(
    stored: WorkNewSessionMode?,
    modelId: String,
    provider: String
  ) -> WorkNewSessionMode {
    guard let stored else { return .chat }
    if stored == .cli,
       !workModelAllowedForAvailabilityMode(modelId: modelId, provider: provider, mode: .cli) {
      return .chat
    }
    return stored
  }
}

/// Desktop `ModeSwitcherPills` parity: compact Chat/CLI toggle for the nav bar.
struct WorkSessionTypeSwitcher: View {
  @Binding var selection: WorkNewSessionMode
  /// Fired only on an explicit user tap that changes the selection (never on a
  /// programmatic seed/restore), so callers can persist the choice without a
  /// restore or availability fallback overwriting the stored preference.
  var onUserSelect: ((WorkNewSessionMode) -> Void)? = nil

  var body: some View {
    // Desktop's start-mode switch (`ModeSwitcherPills`): a capsule track with
    // a capsule thumb under the selection.
    HStack(spacing: 4) {
      ForEach(WorkNewSessionMode.allCases) { mode in
        let isSelected = selection == mode
        Button {
          guard !isSelected else { return }
          withAnimation(.snappy(duration: 0.16)) {
            selection = mode
          }
          onUserSelect?(mode)
        } label: {
          HStack(spacing: 6) {
            Image(systemName: mode.systemImage)
              .font(.system(size: 11.5, weight: .medium))
            Text(mode.title)
              .font(.system(size: 13, weight: isSelected ? .semibold : .medium))
          }
          .foregroundStyle(isSelected ? ADEColor.textPrimary : ADEColor.textSecondary)
          .padding(.horizontal, 14)
          .frame(minHeight: 30)
          .background {
            if isSelected {
              Capsule(style: .continuous)
                .fill(ADEKit.surface)
                .overlay(Capsule(style: .continuous).strokeBorder(ADEKit.edge, lineWidth: 0.75))
            }
          }
          .contentShape(Capsule(style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(mode.title)
        .accessibilityHint(mode.accessibilityDescription)
        .accessibilityAddTraits(isSelected ? [.isSelected] : [])
      }
    }
    .padding(3)
    .background(ADEKit.track, in: Capsule(style: .continuous))
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Session type")
  }
}

/// `yyyyMMdd-HHmmss` stamp for generic auto-created lane fallback names.
private let workAutoLaneNameFormatter: DateFormatter = {
  let formatter = DateFormatter()
  formatter.locale = Locale(identifier: "en_US_POSIX")
  formatter.dateFormat = "yyyyMMdd-HHmmss"
  return formatter
}()

private let workGenericLaneFallbackName = "parallel-task"

private let workLaneFallbackStopwords: Set<String> = [
  "a", "an", "and", "are", "as", "at", "be", "been", "being", "but",
  "can", "chat", "context", "could", "did", "do", "does", "for", "from",
  "had", "has", "have", "help", "how", "i", "if", "im", "in", "into",
  "is", "it", "just", "let", "make", "me", "my", "of", "on", "please",
  "pls", "prompt", "the", "this", "though", "thought", "to", "use", "we",
  "with", "wrong", "you",
]

private let workNamingTlds: Set<String> = [
  "com", "org", "io", "net", "dev", "app", "co", "ai", "gov", "edu", "sh", "xyz", "me",
]

private let workBareDomainPattern = "\\b([a-z0-9][a-z0-9-]*)\\.(?:" +
  workNamingTlds.sorted().map(NSRegularExpression.escapedPattern(for:)).joined(separator: "|") +
  ")\\b"

func workAutoLaneGenericSuffix(date: Date = Date()) -> String {
  workAutoLaneNameFormatter.string(from: date)
}

func workDeterministicAutoLaneName(from prompt: String, genericSuffix: String? = nil) -> String {
  let collapsed = workCleanPromptForNaming(prompt)
  guard !collapsed.isEmpty else {
    return "New Development Lane"
  }
  let priorityWords = workPriorityLaneNamingWords(cleanedPrompt: collapsed)
  if !priorityWords.isEmpty {
    return workReadableLaneTitle(words: priorityWords)
  }
  let tokens = workRegexMatches(
    in: collapsed.lowercased(),
    pattern: #"[a-z0-9]+"#
  )
  let meaningfulWords = Array(tokens
    .filter { $0.count > 1 && !workLaneFallbackStopwords.contains($0) }
    .prefix(5))
  let fallbackWords = Array(tokens
    .filter { $0.count > 1 }
    .prefix(4))
  let words = meaningfulWords.isEmpty ? fallbackWords : meaningfulWords
  let slug = workSlugify(words.joined(separator: "-"))
  if !slug.isEmpty {
    return workReadableLaneTitle(words: Array(slug.split(separator: "-").map(String.init).prefix(6)))
  }
  return "New Development Lane"
}

private func workReadableLaneTitle(words: [String]) -> String {
  let preserved = [
    "ade": "ADE", "github": "GitHub", "ios": "iOS", "macos": "macOS",
    "codex": "Codex", "openai": "OpenAI", "oauth": "OAuth",
  ]
  return words.map { word in
    preserved[word] ?? word.prefix(1).uppercased() + String(word.dropFirst())
  }.joined(separator: " ")
}

private func workCleanPromptForNaming(_ prompt: String) -> String {
  var value = prompt
  value = value.replacingOccurrences(of: #"```[\s\S]*?```"#, with: " ", options: .regularExpression)
  value = value.replacingOccurrences(of: #"`([^`]+)`"#, with: "$1", options: .regularExpression)
  value = workReplacingRegexMatches(in: value, pattern: #"\b[a-z][a-z0-9+.-]*://\S+"#) { match in
    " \(workNamingTokens(fromURLText: match)) "
  }
  value = value.replacingOccurrences(
    of: workBareDomainPattern,
    with: " $1 ",
    options: [.regularExpression, .caseInsensitive]
  )
  value = value.replacingOccurrences(
    of: #"\b(?:ok so|okay so|correct me if i'?m wrong|correct me if im wrong|correct if i'?m wrong|correct if im wrong|if i'?m wrong|if im wrong|please|pls|kindly|can you|could you|would you|will you|help me|i need(?: you)? to|i want(?: you)? to|i'?d like(?: you)? to|let'?s|lets|we need to|take a look at|have a look at|take a look|look at|look into|check out|go over|show me|give me|tell me about|use context skill|use the context skill)\b"#,
    with: " ",
    options: [.regularExpression, .caseInsensitive]
  )
  value = value.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
  return value.trimmingCharacters(in: .whitespacesAndNewlines)
}

private func workNamingTokens(fromURLText urlText: String) -> String {
  let withoutScheme = urlText.replacingOccurrences(
    of: #"^[a-z][a-z0-9+.-]*://"#,
    with: "",
    options: [.regularExpression, .caseInsensitive]
  )
  let segments = withoutScheme
    .components(separatedBy: CharacterSet(charactersIn: "/?#&="))
    .filter { !$0.isEmpty }
  guard let host = segments.first else { return "" }
  let hostLabels = host
    .split(separator: ".")
    .map(String.init)
    .filter { label in
      let normalized = label.lowercased()
      return !normalized.isEmpty && normalized != "www" && !workNamingTlds.contains(normalized)
    }
  let pathLabels = segments.dropFirst().filter { !$0.isEmpty && $0.count <= 24 }
  return (hostLabels + pathLabels).joined(separator: " ")
}

private func workPriorityLaneNamingWords(cleanedPrompt: String) -> [String] {
  let normalized = cleanedPrompt
    .lowercased()
    .replacingOccurrences(of: #"[^a-z0-9]+"#, with: " ", options: .regularExpression)
    .trimmingCharacters(in: .whitespacesAndNewlines)
  guard !normalized.isEmpty else { return [] }
  let provider = ["claude", "codex", "muse", "cursor", "droid", "opencode", "pi"].first {
    workRegexContains(normalized, pattern: #"\b\#($0)\b"#)
  } ?? (workRegexContains(normalized, pattern: #"\bopen code\b"#) ? "opencode" : nil)
  guard let provider else { return [] }
  let mentionsAuth = workRegexContains(
    normalized,
    pattern: #"\b(auth|authenticate|authentication|credential|credentials|creds|oauth)\b"#
  )
  let mentionsLogin = workRegexContains(normalized, pattern: #"\b(log\s+in|login(?!\s+history)|signin|sign\s*in)\b"#)
  let mentionsUiControl = workRegexContains(normalized, pattern: #"\b(button|cta|call to action|chip|banner)\b"#)
  guard mentionsAuth || mentionsLogin else { return [] }
  guard mentionsLogin || mentionsUiControl else { return [] }
  var words = [provider, "auth"]
  if mentionsLogin {
    words.append("login")
  }
  if mentionsUiControl {
    words.append("button")
  }
  var seen: Set<String> = []
  return words.filter { seen.insert($0).inserted }.prefix(5).map { $0 }
}

private func workGenericLaneFallback(genericSuffix: String?) -> String {
  guard let suffix = workNormalizeGenericLaneSuffix(genericSuffix) else {
    return workGenericLaneFallbackName
  }
  return "\(workGenericLaneFallbackName)-\(suffix)"
}

private func workNormalizeGenericLaneSuffix(_ raw: String?) -> String? {
  let normalized = workSlugify((raw ?? "").lowercased())
  let clipped = String(normalized.prefix(24))
    .trimmingCharacters(in: CharacterSet(charactersIn: "-"))
  return clipped.isEmpty ? nil : clipped
}

private func workSlugify(_ value: String) -> String {
  value
    .replacingOccurrences(of: #"[^a-z0-9-]+"#, with: "-", options: .regularExpression)
    .replacingOccurrences(of: #"-+"#, with: "-", options: .regularExpression)
    .trimmingCharacters(in: CharacterSet(charactersIn: "-"))
}

private func workRegexContains(_ value: String, pattern: String) -> Bool {
  guard let regex = try? NSRegularExpression(pattern: pattern) else { return false }
  let range = NSRange(value.startIndex..<value.endIndex, in: value)
  return regex.firstMatch(in: value, range: range) != nil
}

private func workRegexMatches(in value: String, pattern: String) -> [String] {
  guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
  let range = NSRange(value.startIndex..<value.endIndex, in: value)
  return regex.matches(in: value, range: range).compactMap { match in
    guard let tokenRange = Range(match.range, in: value) else { return nil }
    return String(value[tokenRange])
  }
}

private func workReplacingRegexMatches(
  in value: String,
  pattern: String,
  transform: (String) -> String
) -> String {
  guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else {
    return value
  }
  let nsValue = value as NSString
  let matches = regex.matches(in: value, range: NSRange(location: 0, length: nsValue.length))
  guard !matches.isEmpty else { return value }
  var result = ""
  var cursor = 0
  for match in matches {
    let range = match.range
    if range.location > cursor {
      result += nsValue.substring(with: NSRange(location: cursor, length: range.location - cursor))
    }
    result += transform(nsValue.substring(with: range))
    cursor = range.location + range.length
  }
  if cursor < nsValue.length {
    result += nsValue.substring(from: cursor)
  }
  return result
}

/// Progressive-disclosure tiers for the new-chat header. The screen picks one
/// from the measured height left for the scrollable header after the pinned
/// lane picker and the (growable) composer have taken their space — never from
/// keyboard notifications, so composer growth and the keyboard collapse the
/// header the same way.
enum WorkNewChatHeaderTier: Int, Comparable {
  /// Nothing but the pinned rows fit.
  case hidden = 0
  /// Action chips only.
  case minimal = 1
  /// Action chips + usage carousel.
  case compact = 2
  /// Word-mark, tagline, chips, usage carousel.
  case full = 3

  static func < (lhs: Self, rhs: Self) -> Bool { lhs.rawValue < rhs.rawValue }

  var showsBranding: Bool { self == .full }
  var showsUsageCarousel: Bool { self >= .compact }
  var showsActionChips: Bool { self >= .minimal }

  /// Minimum scroll-area height each tier needs, richest first.
  private static let thresholds: [(tier: Self, minHeight: CGFloat)] = [
    (.full, 300),
    (.compact, 190),
    (.minimal, 96),
  ]

  /// Extra height required to step *up* a tier, so revealing content that then
  /// re-consumes the height cannot flip the tier back and forth.
  private static let hysteresis: CGFloat = 24

  static func resolve(available: CGFloat, current: Self) -> Self {
    for entry in thresholds {
      let bound = entry.tier > current ? entry.minHeight + hysteresis : entry.minHeight
      if available >= bound { return entry.tier }
    }
    return .hidden
  }
}

/// Full-screen "Start a new conversation" composer. Mirrors the desktop welcome screen: big ADE word-mark,
/// one-line tagline, a minimal workspace pill users can change inline, and a
/// prominent composer anchored at the bottom. Sending fires the host create
/// call and immediately pushes the new session route on top of the current
/// navigation path so the screen flows straight into the live chat instead
/// of bouncing back to the sidebar.
struct WorkNewChatScreen: View {
  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  var syncService: SyncService { syncPublishes.service }
  @EnvironmentObject private var machineFleet: MachineFleet
  @Environment(\.dismiss) private var dismiss

  let lanes: [LaneSummary]
  let preferredLaneId: String?
  /// Project scope for the per-project Chat/CLI interface preference. Captured at
  /// construction (the screen is pushed for the active project) so it is stable
  /// while shown.
  let activeProjectId: String?
  let activeProjectRootPath: String?
  let onStarted: @MainActor (AgentChatSessionSummary, String, Bool, String?, [AgentChatFileRef]) async -> Void
  let onCliStarted: @MainActor (TerminalSessionSummary) async -> Void
  let onChatImported: @MainActor (AgentChatSessionSummary) async -> Void
  let onRefreshLanes: @MainActor () async -> Void
  /// A new chat into an auto-created lane went through the host-owned launch:
  /// open the chat (session id = launch id) right away; the host is still
  /// setting the lane up.
  let onLaunchStarted: @MainActor (ChatLaunchSnapshot) async -> Void
  /// A chat started on ADE Cloud: open its page (its launch id), which shows
  /// the setup steps and becomes the chat once its computer runs it.
  let onCloudLaunchStarted: @MainActor (String) async -> Void

  @State private var selectedLaneId: String = ""
  @ObservedObject private var cloudLaunches = AccountCloudLaunchStore.shared
  @ObservedObject private var cloudStore = AccountCloudStore.shared
  /// The machine the chat starts on. Nil = the primary (focused) machine.
  @State private var selectedMachineKey: String?
  /// That machine's lanes (namespaced ids), when it is not the primary one.
  @State private var remoteLanes: [LaneSummary] = []
  @State private var remoteLanesLoading = false
  /// Set when the chosen model has no account on the chosen machine.
  @State private var machineModelHint: String?
  @State private var provider: String = "claude"
  @State private var modelId: String = "claude-sonnet-5"
  @State private var busy: Bool = false
  @State private var errorMessage: String?
  @State private var modelPickerPresented = false
  /// The page is on a display with a vertical edge bar (see `body`).
  @State private var displayHasEdgeRail = false
  @State private var runtimeMode: String = "full-auto"
  @State private var reasoningEffort: String = ""
  @State private var codexFastMode: Bool = false
  /// The account's Fast permission, from the host's launch defaults. False
  /// leaves the picker's toggle disabled; this screen never edits the account.
  @State private var fastModeAllowed: Bool = false
  /// Copilot's context tier and Auto profile for the chat about to be created.
  @State private var copilotContextTier: String = "default"
  @State private var copilotAutoTier: String? = nil
  /// The catalog option the picker handed us, kept so fast-tier support is read
  /// from the live host-advertised model (its `serviceTiers`) rather than
  /// re-derived from the curated iOS catalog — which can miss a freshly
  /// advertised fast model and wrongly hide the toggle.
  @State private var selectedModelOption: WorkModelOption?
  /// The connected machine's saved Custom harnesses
  /// (`account.getMachineInventory`). Empty against a host that does not
  /// advertise the action, which hides the picker's Custom section.
  @State private var harnessPresets: [SyncMachineInventoryPreset] = []
  /// The Custom harness the next launch runs under, when the user picked one
  /// from the Custom section. Cleared by any manual model choice.
  @State private var selectedPreset: SyncMachineInventoryPreset?
  /// The selected provider's real accounts on the chosen machine, from the
  /// account commands (Claude and Codex only). Not the machine inventory's
  /// sign-in rows: those include a provider's own logins (OpenCode's Anthropic,
  /// OpenAI…), which no launch can switch to.
  @State private var launchAccountState = WorkLaunchAccountState()
  /// The account the next launch runs on; nil = the machine picks its default.
  @State private var selectedLaunchAccountId: String?
  /// Issues the next launch starts with, from the menu's issue-context section.
  @State private var launchIssues: [WorkLaunchIssue] = []
  @State private var linearIssuePickerPresented = false
  @State private var githubIssuePickerPresented = false
  /// The preset id the persisted composer preference last sent with. Resolved
  /// against the connected machine's list once it arrives, then dropped, so a
  /// relaunch keeps the harness the user chose instead of silently falling back
  /// to the machine's default sign-in.
  @State private var restoredPresetId: String?
  @State private var sessionMode: WorkNewSessionMode = .chat
  @State private var shellLaunchBusy: Bool = false
  @State private var queuedShellLaneIds = Set<String>()
  @State private var usageRefreshRevision = 0
  /// Status banner shown above the composer while an auto-created lane is being
  /// minted before the chat/CLI session starts.
  @State private var autoCreateStatus: String?
  /// Progressive header collapse driven by the measured height left for the
  /// scroll area, not by keyboard notifications, so a grown composer collapses
  /// the header exactly like the keyboard does.
  @State private var headerTier: WorkNewChatHeaderTier = .full
  /// Full scroll-view height and the floating controls' height; the header
  /// tier is chosen from what is left between them.
  @State private var scrollAreaHeight: CGFloat = 0
  @State private var bottomControlsHeight: CGFloat = 0
  /// Word-mark + action chips, as laid out.
  @State private var headerContentHeight: CGFloat = 0
  /// Composer keyboard focus, hoisted out of the composer bar so presenting the
  /// lane sheet can park it and restore it on dismiss (mirrors
  /// `HubComposerDrawer`'s destination-picker focus restore).
  @State private var composerFocused: Bool = false
  @State private var composerFocusedBeforeLaneSheet: Bool = false
  /// The selection the screen opened on, so the host's launch defaults only
  /// replace it while the user has not picked anything here yet.
  private let openingSelection: WorkComposerPreferences.Selection
  @State private var hostLaunchDefaultsChecked = false
  /// The free model ADE started this chat on because nothing is signed in on
  /// the chosen machine. ADE chose it, not the person, so it is never saved as
  /// the remembered model; any pick here clears it.
  @State private var freeDefaultSelection: WorkComposerPreferences.Selection?
  /// The person picked a model or a harness on this page.
  @State private var modelPickedByPerson = false
  /// The chosen machine's free-models answer, and the free model it would
  /// start on (for the "Use a free model" action beside the account hint).
  @State private var freeModelsStatus: WorkFreeModelsStatus?
  @State private var freeDefaultModelId: String?
  /// Tells the page when a machine's free models were read again.
  @ObservedObject private var freeModelsStore = WorkFreeModelsStatusStore.shared

  init(
    lanes: [LaneSummary],
    preferredLaneId: String?,
    activeProjectId: String?,
    activeProjectRootPath: String?,
    onStarted: @escaping @MainActor (AgentChatSessionSummary, String, Bool, String?, [AgentChatFileRef]) async -> Void,
    onCliStarted: @escaping @MainActor (TerminalSessionSummary) async -> Void,
    onChatImported: @escaping @MainActor (AgentChatSessionSummary) async -> Void = { _ in },
    onRefreshLanes: @escaping @MainActor () async -> Void,
    onLaunchStarted: @escaping @MainActor (ChatLaunchSnapshot) async -> Void = { _ in },
    // Required: a host that drops it would clear the composer and open nothing.
    onCloudLaunchStarted: @escaping @MainActor (String) async -> Void
  ) {
    self.lanes = lanes
    self.preferredLaneId = preferredLaneId
    self.activeProjectId = activeProjectId
    self.activeProjectRootPath = activeProjectRootPath
    self.onStarted = onStarted
    self.onCliStarted = onCliStarted
    self.onChatImported = onChatImported
    self.onRefreshLanes = onRefreshLanes
    self.onLaunchStarted = onLaunchStarted
    self.onCloudLaunchStarted = onCloudLaunchStarted
    // Restore the last-used model + access mode so a fresh New Chat screen opens
    // on the user's most recent choices. Seeding the @State initial values here
    // (rather than assigning in onAppear) avoids the provider/model onChange
    // handlers firing and resetting runtimeMode back to the provider default.
    var restoredProvider = "claude"
    var restoredModelId = "claude-sonnet-5"
    if let saved = WorkComposerPreferences.load() {
      restoredProvider = saved.provider
      restoredModelId = saved.modelId
      _provider = State(initialValue: saved.provider)
      _modelId = State(initialValue: saved.modelId)
      _runtimeMode = State(initialValue: saved.runtimeMode)
      _reasoningEffort = State(initialValue: saved.reasoningEffort)
      _codexFastMode = State(initialValue: saved.codexFastMode)
      _restoredPresetId = State(initialValue: saved.presetId)
    }
    // Restore the last explicitly chosen Chat/CLI interface for this project so
    // the choice survives app restarts, project switches, and launching a
    // session. Seeding the initial @State here (not onAppear) keeps the
    // sessionMode onChange from firing and resetting runtimeMode to the provider
    // default. A stored CLI choice is only honored when the restored model can
    // actually run in CLI; otherwise the session opens on chat WITHOUT rewriting
    // the stored preference (a later switcher tap overwrites it).
    _sessionMode = State(initialValue: WorkNewSessionModePreferences.resolvedMode(
      stored: WorkNewSessionModePreferences.load(projectId: activeProjectId),
      modelId: restoredModelId,
      provider: restoredProvider
    ))
    let saved = WorkComposerPreferences.load()
    openingSelection = WorkComposerPreferences.Selection(
      provider: restoredProvider,
      modelId: restoredModelId,
      runtimeMode: saved?.runtimeMode ?? workDefaultRuntimeMode(provider: restoredProvider),
      reasoningEffort: saved?.reasoningEffort ?? "",
      codexFastMode: saved?.codexFastMode ?? false
    )
  }

  /// Open a new chat on what this machine used last, from any client. Only a
  /// chat on the focused machine, and only before the user picks anything here.
  @MainActor
  private func applyHostLaunchDefaults() async {
    guard !hostLaunchDefaultsChecked else { return }
    hostLaunchDefaultsChecked = true
    // Permission is independent of whether the launch defaults apply to this
    // composer (CLI mode, another machine, a preset, a changed selection).
    fastModeAllowed = await syncService.getFastModeEnabled()
    guard let defaults = await syncService.fetchChatLaunchDefaults() else { return }
    guard sessionMode == .chat, selectedMachineKey == nil, composerSelection == openingSelection else { return }
    // A persisted Custom harness is the user's own last choice and outranks the
    // machine's launch defaults. Hold the defaults until that preset has been
    // resolved or proven gone (which clears `restoredPresetId`), so the two
    // async loads cannot fight over the composer.
    guard restoredPresetId == nil else { return }
    selectedModelOption = nil
    provider = workNormalizedChatProvider(defaults.provider)
    modelId = defaults.modelId
    reasoningEffort = defaults.reasoningEffort ?? ""
    copilotContextTier = workCopilotContextTier(defaults.copilotContextTier)
    copilotAutoTier = defaults.copilotAutoTier
    // Fast is opt-in per chat. The host's launch defaults no longer carry it,
    // and an older host that still does must not seed it here.
    codexFastMode = false
    fastModeAllowed = defaults.fastModeAllowed ?? fastModeAllowed
    let mode = workRuntimeMode(
      provider: defaults.provider,
      interactionMode: defaults.interactionMode,
      permissionMode: defaults.permissionMode,
      claudePermissionMode: defaults.claudePermissionMode,
      codexConfigSource: defaults.codexConfigSource,
      codexApprovalPolicy: defaults.codexApprovalPolicy,
      codexSandbox: defaults.codexSandbox,
      opencodePermissionMode: defaults.opencodePermissionMode,
      cursorModeId: defaults.cursorModeId,
      droidPermissionMode: defaults.droidPermissionMode,
      musePermissionMode: defaults.musePermissionMode,
      copilotPermissionMode: defaults.copilotPermissionMode
    )
    runtimeMode = mode.isEmpty ? workDefaultRuntimeMode(provider: provider) : mode
    checkModelOnMachine()
  }

  /// The live composer selection. Persisted as the app-wide "last used" choice
  /// whenever it changes (see `.onChange` in `body`) so the next New Chat —
  /// chat or CLI — restores it.
  private var composerSelection: WorkComposerPreferences.Selection {
    WorkComposerPreferences.Selection(
      provider: provider,
      modelId: modelId,
      runtimeMode: runtimeMode,
      reasoningEffort: reasoningEffort,
      codexFastMode: codexFastMode,
      presetId: selectedPreset?.id
    )
  }

  /// Whether the synthetic "Auto-create lane" entry is the current selection.
  private var isAutoCreateLane: Bool {
    selectedLaneId == workAutoCreateLaneSentinelId
  }

  /// Whether the chat starts on ADE Cloud (through the account server).
  private var isCloudSelected: Bool { selectedMachineKey == ADECloudMachine.id }

  /// The model ADE Cloud runs, from the server's catalog.
  private var cloudProviderEntry: CloudCatalogProvider? {
    cloudLaunches.catalog?.providers.first { $0.provider == provider }
  }

  /// The footnote under the composer while ADE Cloud is picked: why it
  /// can't start work now, or what a model that signs in on the desktop needs.
  private var cloudFootnote: String? {
    guard isCloudSelected else { return nil }
    if let refusal = cloudStore.doingRefusal { return refusal }
    if let entry = cloudProviderEntry, entry.remoteSignIn == "desktop" {
      // The desktop's sign-in already reached ADE Cloud: nothing to do.
      if cloudLaunches.carriedSignIns[entry.provider] == true {
        return "Uses your \(entry.label) sign-in from \(Brand.name) desktop."
      }
      return cloudDesktopSignInSentence(label: entry.label)
    }
    if cloudLaunches.catalog != nil, cloudProviderEntry?.models.contains(where: { $0.id == modelId }) != true {
      return "Pick a model \(Brand.cloudName) runs."
    }
    return nil
  }

  /// The lanes of the chosen machine.
  private var visibleLanes: [LaneSummary] {
    selectedMachineKey == nil ? lanes : remoteLanes
  }

  private var defaultNewSessionLane: LaneSummary? {
    if let preferredLaneId, let lane = visibleLanes.first(where: { $0.id == preferredLaneId }) {
      return lane
    }
    return workNewChatPrimaryLane(visibleLanes)
  }

  private var selectedConcreteLane: LaneSummary? {
    guard !isAutoCreateLane else { return nil }
    return visibleLanes.first(where: { $0.id == selectedLaneId })
  }

  private var machineOptions: [WorkNewChatMachineOption] {
    workNewChatMachineOptions(syncService: syncService, fleet: machineFleet)
  }

  private var selectedMachineOption: WorkNewChatMachineOption {
    let options = machineOptions
    return options.first { $0.machineKey == selectedMachineKey } ?? options[0]
  }

  /// The chosen machine's checkout of the focused repository (nil = primary).
  private var selectedRemoteRepo: WorkRemoteMachineRepo? {
    selectedMachineKey.flatMap { syncService.remoteLaneRepo(machineKey: $0) }
  }

  /// ADE Cloud takes files through the account server, so it needs no
  /// connected machine; any other target stages them on its machine.
  private var attachmentsAvailable: Bool {
    isCloudSelected || syncService.supportsViewerRemoteAction("chat.saveTempAttachment")
  }

  private var canUploadAttachments: Bool {
    isCloudSelected || (attachmentsAvailable && syncService.connectionState == .connected)
  }

  /// Fast mode only applies to in-app chat sessions on fast-tier models. The
  /// picker owns the control, but launch still gates the submitted value on the
  /// resolved session interface and model support.
  private var fastModeSupported: Bool {
    guard sessionMode == .chat else { return false }
    if let option = selectedModelOption,
       workModelIdsEquivalent(option.id, modelId),
       option.supportsServiceTier("fast") {
      return true
    }
    return workComposerSupportsFastMode(modelId: modelId, provider: provider)
  }

  var body: some View {
    // The header scrolls edge to edge; the lane bubble and the composer float
    // over it in a bottom safe-area inset that draws no background of its own,
    // so nothing paints an opaque band behind the floating controls.
    ScrollView {
      // Outer stack is unspaced so the collapsed carousel below contributes
      // neither height nor inter-item spacing.
      VStack(spacing: 0) {
        VStack(spacing: 18) {
          if headerTier.showsBranding {
            brandMark
          }

          if headerTier.showsActionChips {
            sessionActionChips
          }
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { headerContentHeight = $0 }

        // The carousel stays mounted at every tier and collapses to nothing
        // when the tier hides it: it owns `@State` stats behind a
        // `.task(id:)`, so removing it from the tree would refetch and flash
        // an empty card every time the header tier stepped back up.
        WorkUsageActivityCarousel(refreshRevision: usageRefreshRevision, maxHeight: usagePanelMaxHeight)
          .environmentObject(syncService)
          .padding(.top, usageCarouselTopPadding)
          .fixedSize(horizontal: false, vertical: true)
          .frame(maxHeight: headerTier.showsUsageCarousel ? nil : 0)
          .clipped()
          .opacity(headerTier.showsUsageCarousel ? 1 : 0)
          .allowsHitTesting(headerTier.showsUsageCarousel)
          .accessibilityHidden(!headerTier.showsUsageCarousel)
      }
      .frame(maxWidth: .infinity)
      .padding(.horizontal, 16)
      .padding(.top, headerTier.showsBranding ? 12 : 8)
      .padding(.bottom, 16)
    }
    .scrollBounceBehavior(.basedOnSize)
    .scrollDismissesKeyboard(.interactively)
    .refreshable {
      await MobileUsageQuotaStore.shared.load(using: syncService, refresh: true)
      usageRefreshRevision &+= 1
    }
    .animation(.smooth(duration: 0.2), value: headerTier)
    .safeAreaInset(edge: .bottom, spacing: 0) {
      VStack(spacing: 8) {
        // Pinned: the lane picker must stay reachable no matter how tall the
        // composer grows or whether the keyboard is up.
        // Left-aligned in one row, on the prompt box's own left edge.
        laneSelector
          .padding(.horizontal, 10)

        if let cloudFootnote {
          Text(cloudFootnote)
            .font(.caption)
            .foregroundStyle(cloudStore.doingRefusal != nil ? ADEColor.warning : ADEColor.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 14)
            .adeInspectable("Work.NewChat.CloudFootnote")
        }

        launchSelectionRow

        if let autoCreateStatus, busy {
          HStack(spacing: 8) {
            ProgressView().controlSize(.mini)
            Text(autoCreateStatus)
              .font(.caption)
              .foregroundStyle(ADEColor.textSecondary)
              .lineLimit(1)
          }
          .padding(.horizontal, 12)
          .padding(.vertical, 6)
          .adeKitPill()
          .transition(.opacity)
        }

        if let errorMessage {
          Text(errorMessage)
            .font(.caption)
            .foregroundStyle(ADEColor.danger)
            .multilineTextAlignment(.center)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(ADEKit.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(ADEKit.edge, lineWidth: 0.75))
            .padding(.horizontal, 20)
        }

        composerBar
      }
      .padding(.bottom, 4)
      // Held landscape on the Duo, the prompt box's bottom lines up with the
      // edge bar's last capsule.
      .duoEdgeBarAlignedBottom(contentBottomPadding: 4)
      .onGeometryChange(for: CGFloat.self) { proxy in
        proxy.size.height
      } action: { height in
        bottomControlsHeight = height
        applyHeaderHeight()
      }
    }
    // Measured outside the inset, so this is the full height the page has;
    // the floating controls' own height is subtracted in `applyHeaderHeight`.
    .onGeometryChange(for: CGFloat.self) { proxy in
      proxy.size.height
    } action: { height in
      scrollAreaHeight = height
      applyHeaderHeight()
    }
    .adeScreenBackground()
    .adeNavigationGlass()
    .navigationTitle("")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar(.hidden, for: .tabBar)
    .adeRootTabBarHidden()
    .adeAnalyticsScreen(.workNewChat)
    // On a display whose bar runs down a curved edge (the Duo's closed outer
    // display), the system back button lands in that strip beside the prompt
    // box; Back belongs at the top. Every other phone keeps the system button.
    .onGeometryChange(for: Bool.self) { proxy in
      workDisplayHasEdgeRail(proxy)
    } action: { hasRail in
      if displayHasEdgeRail != hasRail { displayHasEdgeRail = hasRail }
    }
    .navigationBarBackButtonHidden(displayHasEdgeRail)
    .modifier(WorkNewChatTopBackButton(shown: displayHasEdgeRail) { dismiss() })
    .toolbar {
      // The busy spinner rides beside the switcher, in the same item: a
      // trailing item declared only while busy left an empty glass circle
      // over the composer when it went away (the edge bar does not drop a
      // removed item), and an always-declared empty one draws the circle too.
      ToolbarItem(placement: .principal) {
        WorkSessionTypeSwitcher(selection: $sessionMode, onUserSelect: { mode in
          WorkNewSessionModePreferences.save(mode, projectId: activeProjectId)
        })
        .overlay(alignment: .trailing) {
          if busy {
            ProgressView()
              .controlSize(.small)
              .offset(x: 28)
          }
        }
      }
    }
    .onAppear {
      // No computer of the person's own serves this project: start on ADE Cloud.
      if selectedMachineKey == nil, workNewChatPrefersCloud(syncService: syncService) {
        selectMachine(workNewChatCloudOption())
      }
      // A lane of another machine opens the page on that machine.
      if selectedMachineKey == nil,
         let preferredLaneId,
         let remote = workParseRemoteLaneId(preferredLaneId),
         remote.machineKey != syncService.focusedMachineKey {
        selectedMachineKey = remote.machineKey
        selectedLaneId = preferredLaneId
        Task { await loadRemoteLanes(keepSelection: true) }
      }
      if selectedLaneId.isEmpty {
        selectedLaneId = defaultNewSessionLane?.id ?? ""
      }
      #if DEBUG
      if ProcessInfo.processInfo.arguments.contains("-adePreviewFocusComposer") {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { composerFocused = true }
      }
      #endif
      if runtimeMode.isEmpty {
        runtimeMode = workDefaultRuntimeMode(provider: provider)
      }
    }
    .onChange(of: composerSelection) { _, newValue in
      // Persist the full selection without deriving one setting from another.
      // A free model ADE picked is not the person's choice: never remember it,
      // also after a change to another setting such as the access mode.
      guard !isOnFreeDefault else { return }
      WorkComposerPreferences.save(newValue)
    }
    // A machine with nothing signed in starts the chat on a free model.
    .task(id: freeDefaultTaskKey) { await applyFreeDefaultIfNeeded() }
    .onChange(of: sessionMode) { _, mode in
      guard mode == .cli else { return }
      // The CLI start records Linear links only. A GitHub choice made in chat
      // mode must not ride the prompt with no session link behind it.
      launchIssues.removeAll { issue in
        if case .github = issue { return true }
        return false
      }
    }
    .onChange(of: launchAccountProvider) { _, _ in
      // An id belongs to one provider. The read failure path may keep a valid
      // same-provider pick, but a provider switch must never forward the old id
      // (the host would treat it as an explicit choice and skip Smart balance).
      selectedLaunchAccountId = nil
    }
    .task { await applyHostLaunchDefaults() }
    .task(id: launchAccountsTaskKey) { await loadLaunchAccounts() }
    .sheet(isPresented: $linearIssuePickerPresented) {
      WorkLinearIssuePickerSheet(syncService: syncService, onPick: addLinearLaunchIssue)
    }
    .sheet(isPresented: $githubIssuePickerPresented) {
      WorkGitHubIssuePickerSheet(syncService: syncService, onPick: addGitHubLaunchIssue)
    }
    .sheet(isPresented: $modelPickerPresented) {
      WorkModelPickerSheet(
        currentModelId: modelId,
        currentProvider: provider,
        currentReasoningEffort: reasoningEffort,
        currentCodexFastMode: codexFastMode,
        fastModeAllowed: fastModeAllowed,
        cursorAvailabilityMode: sessionMode == .cli ? .cli : .chat,
        lanes: visibleLanes,
        // Custom harnesses are the connected host's own; another machine's list
        // (or ADE Cloud) would offer a preset this launch cannot resolve.
        harnessPresets: selectedMachineKey == nil ? harnessPresets : [],
        isBusy: false,
        onSelectPreset: { preset in
          modelPickedByPerson = true
          freeDefaultSelection = nil
          selectedPreset = preset
          selectedModelOption = nil
          modelId = preset.model
          provider = sessionMode == .chat
            ? workNormalizedChatProvider(preset.harness)
            : preset.harness
          if !reasoningEffort.isEmpty { reasoningEffort = "" }
          if codexFastMode { codexFastMode = false }
          machineModelHint = nil
        },
        selectedPresetId: selectedPreset?.id,
        currentCopilotContextTier: copilotContextTier,
        currentCopilotAutoTier: copilotAutoTier,
        onSelectCopilotTiers: { context, auto in
          copilotContextTier = context
          copilotAutoTier = auto
        },
        // ADE Cloud lists its own models; an empty list until it arrives, never
        // the connected machine's.
        cloudCatalog: isCloudSelected ? (cloudLaunches.catalog ?? .pending) : nil,
        // Free models are read and downloaded on the chosen machine only.
        freeModelsMachine: selectedMachineHost.map { WorkFreeModelsMachine.host($0) } ?? .unreachable,
        onSelect: { option, pickedReasoning, runtimeProvider, pickedFastMode in
          modelPickedByPerson = true
          freeDefaultSelection = nil
          selectedPreset = nil
          selectedModelOption = option
          modelId = option.id
          provider = sessionMode == .chat
            ? workNormalizedChatProvider(runtimeProvider)
            : workResolveCliProvider(for: option.id, provider: runtimeProvider)
          let nextReasoning = pickedReasoning ?? ""
          if nextReasoning != reasoningEffort { reasoningEffort = nextReasoning }
          if pickedFastMode != codexFastMode { codexFastMode = pickedFastMode }
        }
      )
    }
    .task(id: syncService.focusedHostInventoryMachineKey ?? "") {
      await loadHarnessPresets()
    }
  }

  /// The chosen machine's connection: the primary one, or the roster
  /// connection to another machine. Nil for ADE Cloud and for a machine the
  /// phone has no connection to.
  private var selectedMachineHost: ProviderAccountsHost? {
    guard !isCloudSelected else { return nil }
    guard let selectedMachineKey else { return syncService }
    return machineFleet.connection(for: selectedMachineKey)
  }

  private var freeDefaultTaskKey: String {
    let phase = selectedMachineKey
      .flatMap { machineFleet.connection(for: $0) }
      .map { String(describing: $0.phase) }
      ?? String(describing: syncService.connectionState)
    // A new free list (OpenCode finished downloading), a sign-in on this
    // machine and the end of a launch all run the free default again.
    // The machine itself, too: the primary connection can move to another one.
    let host = selectedMachineHost
    let machine = host.map { WorkFreeModelsStatusStore.key(for: $0) } ?? "none"
    let generation = host.map { freeModelsStore.generation(for: $0) } ?? 0
    return "\(machine)|\(phase)|\(sessionMode)|\(generation)|\(busy)"
  }

  /// Nothing signed in on the chosen machine: start on its free default (the
  /// manifest's preferred free model it lists, else its first), unless the
  /// person already picked something here. A machine with a provider signed
  /// in, or an older one, leaves the page as it always was, and takes back a
  /// free model ADE chose for another machine.
  @MainActor
  private func applyFreeDefaultIfNeeded() async {
    guard let host = selectedMachineHost else {
      freeModelsStatus = nil
      freeDefaultModelId = nil
      revertFreeDefaultUnlessBusy()
      return
    }
    let status = await WorkFreeModelsStatusStore.shared.status(for: host)
    guard !Task.isCancelled else { return }
    freeModelsStatus = status
    guard let status, status.nothingSignedIn else {
      freeDefaultModelId = nil
      revertFreeDefaultUnlessBusy()
      return
    }
    // A launch reads the composer, so nothing changes while one runs, and the
    // free list is not read either. The task runs again when it ends.
    guard !busy else { return }
    let pick = await workFreeDefaultModelId(on: host, status: status)
    guard !Task.isCancelled else { return }
    freeDefaultModelId = pick
    // This machine has no free model to start on.
    guard let pick else {
      revertFreeDefaultUnlessBusy()
      return
    }
    guard !busy, sessionMode == .chat, !modelPickedByPerson, selectedPreset == nil,
          isOnFreeDefault || !workIsFreeModel(modelId),
          !(isOnFreeDefault && modelId == pick)
    else { return }
    let selection = freeModelSelection(pick)
    // Set before the fields change, so the save on change sees it.
    freeDefaultSelection = selection
    applyFreeModelSelection(selection)
  }

  /// A free model's composer selection: OpenCode, its default mode, no effort.
  private func freeModelSelection(_ id: String) -> WorkComposerPreferences.Selection {
    WorkComposerPreferences.Selection(
      provider: "opencode",
      modelId: id,
      runtimeMode: workDefaultRuntimeMode(provider: "opencode"),
      reasoningEffort: "",
      codexFastMode: false
    )
  }

  private func applyFreeModelSelection(_ selection: WorkComposerPreferences.Selection) {
    selectedModelOption = nil
    provider = selection.provider
    modelId = selection.modelId
    runtimeMode = selection.runtimeMode
    reasoningEffort = selection.reasoningEffort
    codexFastMode = selection.codexFastMode
    machineModelHint = nil
  }

  /// The composer still runs the free model ADE chose. Another setting (the
  /// access mode) can change; the model stays ADE's choice until the person
  /// picks a model or a harness, which clears `freeDefaultSelection`.
  private var isOnFreeDefault: Bool {
    guard let freeDefaultSelection, selectedPreset == nil else { return false }
    return provider == freeDefaultSelection.provider && modelId == freeDefaultSelection.modelId
  }

  /// Puts back what the page opened on when the free model ADE chose no
  /// longer applies (another machine, no machine, someone signed in).
  private func revertFreeDefault() {
    guard isOnFreeDefault else {
      freeDefaultSelection = nil
      return
    }
    freeDefaultSelection = nil
    provider = openingSelection.provider
    modelId = openingSelection.modelId
    runtimeMode = openingSelection.runtimeMode
    reasoningEffort = openingSelection.reasoningEffort
    codexFastMode = openingSelection.codexFastMode
    checkModelOnMachine()
  }

  /// A launch reads the composer: the revert waits until it ends.
  private func revertFreeDefaultUnlessBusy() {
    guard !busy else { return }
    revertFreeDefault()
  }

  /// A brand-new person whose chosen model has no account here: the hint
  /// offers the machine's free model instead.
  private var freeModelOfferId: String? {
    guard freeModelsStatus?.isNewPerson == true, sessionMode == .chat,
          let freeDefaultModelId, !workIsFreeModel(modelId) else { return nil }
    return freeDefaultModelId
  }

  private func useFreeModel(_ id: String) {
    // A launch in progress keeps the model it started with.
    guard !busy else { return }
    modelPickedByPerson = true
    freeDefaultSelection = nil
    selectedPreset = nil
    applyFreeModelSelection(freeModelSelection(id))
  }

  @ViewBuilder
  private var brandMark: some View {
    Image("BrandMark")
      .resizable()
      .renderingMode(.original)
      .interpolation(.high)
      .aspectRatio(contentMode: .fit)
      .frame(width: 88, height: 88)
    .padding(.top, 0)
    .accessibilityLabel(Brand.name)
  }

  @ViewBuilder
  private var laneSelector: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(spacing: 8) {
        // Neither pill may be `fixedSize()`: the machine name and the lane name
        // + branch are user data, and an ideal width larger than the screen
        // made the whole page — usage card and composer included — lay out
        // wider than the viewport until some later interaction forced a
        // relayout. The machine pill keeps its width; the lane pill absorbs the
        // squeeze and its own label truncates.
        WorkNewChatMachineDropdown(
          options: machineOptions,
          selected: selectedMachineOption,
          onSelect: selectMachine
        )
        .disabled(busy)
        .layoutPriority(1)
        if remoteLanesLoading {
          ProgressView().controlSize(.small)
        } else {
          WorkLanePickerDropdown(
            lanes: visibleLanes,
            selectedLaneId: $selectedLaneId,
            onMenuPresentationChange: handleLaneSheetPresentation,
            floatingGlass: true
          )
        }
        Spacer(minLength: 0)
      }
      // A hard clamp: however wide the pills' ideal sizes are, the row reports
      // the container's width, so nothing above it can grow.
      .frame(maxWidth: .infinity, alignment: .leading)
      if let machineModelHint {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
          Text(machineModelHint)
            .font(.caption)
            .foregroundStyle(ADEColor.warning)
            .lineLimit(2)
          if let freeId = freeModelOfferId {
            Button("Use a free model") { useFreeModel(freeId) }
              .font(.caption.weight(.semibold))
              .foregroundStyle(ADEColor.accent)
              .buttonStyle(.plain)
              .fixedSize()
              .disabled(busy)
              .accessibilityIdentifier("Work.NewChat.UseFreeModel")
          }
        }
        .padding(.horizontal, 4)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  /// A new machine: its lanes and accounts. A machine that is not connected is
  /// reconnected; its lanes load once it is live.
  private func selectMachine(_ option: WorkNewChatMachineOption) {
    // A send in flight has already read its machine, account and issues.
    guard !busy else { return }
    errorMessage = nil
    guard option.machineKey != selectedMachineKey else { return }
    selectedMachineKey = option.machineKey
    // The account id and issue links name things on the previous machine;
    // neither may ride along to the next launch.
    selectedLaunchAccountId = nil
    launchIssues.removeAll()
    launchAccountState.clear()
    let keepsAutoCreate = isAutoCreateLane
    if option.isCloud {
      // ADE Cloud: a new cloud lane by default, or one of the project's
      // cloud lanes. Its models come from the server's catalog.
      selectedPreset = nil
      remoteLanes = syncService.cloudLanesForActiveProject()
      selectedLaneId = workAutoCreateLaneSentinelId
      machineModelHint = nil
      Task {
        await cloudLaunches.loadCatalogIfNeeded(using: syncService)
        pickCloudModelIfNeeded()
      }
      return
    }
    if option.machineKey == nil {
      remoteLanes = []
      selectedLaneId = keepsAutoCreate ? workAutoCreateLaneSentinelId : (workNewChatPrimaryLane(lanes)?.id ?? "")
    } else {
      // A saved Custom harness resolves against the machine that owns its key
      // and sign-in. Another machine's picker hides presets for exactly that
      // reason, so a selection made on the primary host must not ride along.
      selectedPreset = nil
      selectedLaneId = keepsAutoCreate ? workAutoCreateLaneSentinelId : ""
      Task { await loadRemoteLanes(keepSelection: keepsAutoCreate) }
    }
    checkModelOnMachine()
  }

  /// Keeps the model on one ADE Cloud runs: the last cloud pick, else the
  /// catalog's default.
  private func pickCloudModelIfNeeded() {
    guard isCloudSelected, cloudProviderEntry?.models.contains(where: { $0.id == modelId }) != true,
          let pick = cloudLaunches.defaultModel() else { return }
    provider = pick.provider
    modelId = pick.modelId
    reasoningEffort = ""
    codexFastMode = false
  }

  @MainActor
  private func loadRemoteLanes(keepSelection: Bool) async {
    guard let key = selectedMachineKey, key != ADECloudMachine.id else { return }
    remoteLanesLoading = true
    defer { remoteLanesLoading = false }
    // A machine that is not connected is connected now (a pick reconnects it).
    let live = await machineFleet.connect(machineKey: key)
    guard selectedMachineKey == key else { return }
    guard let repo = syncService.remoteLaneRepo(machineKey: key) else {
      errorMessage = "That machine has no checkout of this project."
      return
    }
    guard live else {
      errorMessage = "Can’t reach \(repo.machineName) right now."
      return
    }
    do {
      let snapshots = try await syncService.fetchRemoteLaneSnapshots(
        repo: repo,
        timeoutNanoseconds: LaneRemoteMachinesModel.readTimeoutNanoseconds
      )
      guard selectedMachineKey == key else { return }
      remoteLanes = snapshots.map(\.lane).filter { $0.archivedAt == nil }
      if !keepSelection || !remoteLanes.contains(where: { $0.id == selectedLaneId }) && !isAutoCreateLane {
        selectedLaneId = workNewChatPrimaryLane(remoteLanes)?.id ?? ""
      }
    } catch {
      guard selectedMachineKey == key else { return }
      errorMessage = "Can’t read \(repo.machineName)’s lanes: \(error.localizedDescription)"
    }
  }

  /// The connected machine's saved Custom harnesses. Silent on any failure:
  /// a host that does not advertise the action, or is offline, simply shows no
  /// Custom section.
  @MainActor
  private func loadHarnessPresets() async {
    guard syncService.supportsRemoteAction("account.getMachineInventory"),
          let machineKey = syncService.focusedHostInventoryMachineKey,
          !machineKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    else {
      harnessPresets = []
      return
    }
    do {
      let detail = try await syncService.fetchMachineInventory(machineKey: machineKey)
      harnessPresets = detail.presets
      resolveRestoredPreset()
      if let selectedPreset, !detail.presets.contains(where: { $0.id == selectedPreset.id }) {
        self.selectedPreset = nil
      }
    } catch {
      harnessPresets = []
    }
  }

  /// The account provider the chosen model runs on, when that provider keeps
  /// real accounts. A Custom harness names its own sign-in, so it has no account
  /// to pick.
  private var launchAccountProvider: ProviderAccountProvider? {
    guard selectedPreset == nil else { return nil }
    return ProviderAccountProvider(rawValue: workResolveCliProvider(for: modelId, provider: provider).lowercased())
  }

  /// The signed-in accounts the chosen machine can run this model on. The
  /// choice appears when there is a real one: more than one, or one that is
  /// not the machine's default.
  private var launchAccountChoices: [ProviderAccount] {
    launchAccountState.choices
  }

  private var selectedLaunchAccount: ProviderAccount? {
    guard let selectedLaunchAccountId else { return nil }
    return launchAccountChoices.first { $0.id == selectedLaunchAccountId }
  }

  private var launchAccountsScope: String {
    WorkLaunchAccountState.scope(
      provider: launchAccountProvider,
      machineKey: selectedMachineKey
    )
  }

  private var launchAccountsTaskKey: String {
    let hostPhase = selectedMachineKey
      .flatMap { machineFleet.connection(for: $0) }
      .map { String(describing: $0.phase) } ?? "none"
    return "\(launchAccountsScope)|\(hostPhase)"
  }

  /// Adds a picked issue to the launch, once per issue. Split out of the
  /// sheet closures so the screen's modifier chain stays checkable.
  private func addLinearLaunchIssue(_ issue: NormalizedLinearIssue) {
    let picked = WorkLaunchIssue.linear(issue)
    if !launchIssues.contains(where: { $0.id == picked.id }) {
      launchIssues.append(picked)
    }
    linearIssuePickerPresented = false
  }

  private func addGitHubLaunchIssue(_ issue: GitHubIssueRow, repo: GitHubRepoRefDTO) {
    let picked = WorkLaunchIssue.github(issue, owner: repo.owner, repo: repo.name)
    if !launchIssues.contains(where: { $0.id == picked.id }) {
      launchIssues.append(picked)
    }
    githubIssuePickerPresented = false
  }

  /// The chosen machine's real accounts for the model's provider. Read from the
  /// account commands, not the machine inventory: the inventory also lists a
  /// provider's own CLI logins (OpenCode's Anthropic, OpenAI…), which are not
  /// accounts any launch can switch to.
  @MainActor
  private func loadLaunchAccounts() async {
    await launchAccountState.load(
      provider: launchAccountProvider,
      machineKey: selectedMachineKey,
      machineFleet: machineFleet,
      syncService: syncService
    )
    guard !launchAccountState.error,
          launchAccountState.loadedScope == launchAccountsScope else { return }
    if let selectedLaunchAccountId,
       !launchAccountState.accounts.contains(where: { $0.id == selectedLaunchAccountId && $0.canTakeChats }) {
      self.selectedLaunchAccountId = nil
    }
  }

  /// A new-chat issue row calls a host attach command, not just the tracker
  /// reader. An older host that can list Linear/GitHub cannot record the link,
  /// so the row must be absent rather than silently pretend it worked.
  private var canAttachLinearLaunchIssue: Bool {
    selectedMachineKey == nil
      && syncService.canInvokeRemoteAction("lanes.attachLinearIssueToSession")
  }

  private var canAttachGitHubLaunchIssue: Bool {
    selectedMachineKey == nil
      && sessionMode == .chat
      && syncService.canInvokeRemoteAction("lanes.attachGitHubIssueToSession")
  }

  private var githubIssuesAvailable: Bool {
    // The issue pickers read the focused machine's project. A chat on another
    // machine would show that machine's repo, so the phone offers no issue
    // context there until its pickers are machine-scoped.
    guard canAttachGitHubLaunchIssue,
          syncService.supportsGitHubIssuesPane,
          let projectId = activeProjectId
    else { return false }
    return syncService.githubIssuesMenuProjectIds.contains(projectId)
  }

  /// What the next launch carries beyond the lane and the prompt: the account
  /// it runs on and the issues it starts with. Only the picks that are set draw
  /// a pill; the controls themselves live in the composer's ⋯ menu.
  @ViewBuilder
  private var launchSelectionRow: some View {
    if selectedLaunchAccount != nil || !launchIssues.isEmpty {
      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 8) {
          if let account = selectedLaunchAccount {
            Button {
              selectedLaunchAccountId = nil
            } label: {
              launchOptionPill(systemImage: "person.crop.circle", title: account.displayName)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Account: \(account.displayName)")
            .accessibilityHint("Removes the pick; the machine's default account is used.")
            .accessibilityIdentifier("Work.NewChat.Account")
          }
          ForEach(launchIssues) { issue in
            Button {
              launchIssues.removeAll { $0.id == issue.id }
            } label: {
              launchOptionPill(systemImage: issue.symbolName, title: issue.identifier)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Remove \(issue.providerLabel) issue \(issue.identifier)")
          }
        }
        .padding(.horizontal, 10)
      }
    }
  }

  /// The launch options, drawn by the composer's ⋯ menu: which account the run
  /// starts on, and the issues it starts with.
  @ViewBuilder
  private var launchOptionsMenu: some View {
    let accounts = launchAccountChoices
    // ADE Cloud signs its computer in with your logins; there is no machine
    // account list to pick from.
    if !isCloudSelected, launchAccountState.error || !accounts.isEmpty {
      Section("Account") {
        Button {
          selectedLaunchAccountId = nil
        } label: {
          launchMenuRow("Default (machine picks)", checked: selectedLaunchAccountId == nil)
        }
        if let failure = launchAccountState.failure {
          if failure == .retryable {
            Button {
              Task { await loadLaunchAccounts() }
            } label: {
              Label("Couldn't load accounts. Retry", systemImage: "arrow.clockwise")
            }
            .accessibilityIdentifier("Work.NewChat.AccountRetry")
          } else {
            Text("Accounts aren't available on this machine.")
          }
        } else {
          ForEach(accounts) { account in
            Button {
              selectedLaunchAccountId = account.id
            } label: {
              launchMenuRow(
                account.displayName + (account.isDefault ? " (default)" : ""),
                checked: selectedLaunchAccount?.id == account.id
              )
            }
          }
        }
      }
    }
    if (canAttachLinearLaunchIssue && syncService.linearConnected)
        || githubIssuesAvailable
        || !launchIssues.isEmpty {
      Section("Issue context") {
        if canAttachLinearLaunchIssue && syncService.linearConnected {
          Button {
            linearIssuePickerPresented = true
          } label: {
            Label("Linear issue…", systemImage: "circle.dashed")
          }
          .accessibilityIdentifier("Work.NewChat.LinearIssue")
        }
        if githubIssuesAvailable {
          Button {
            githubIssuePickerPresented = true
          } label: {
            Label("GitHub issue…", systemImage: "smallcircle.filled.circle")
          }
          .accessibilityIdentifier("Work.NewChat.GitHubIssue")
        }
        ForEach(launchIssues) { issue in
          Button(role: .destructive) {
            launchIssues.removeAll { $0.id == issue.id }
          } label: {
            Label("Remove \(issue.identifier)", systemImage: "xmark")
          }
        }
      }
    }
  }

  @ViewBuilder
  private func launchMenuRow(_ title: String, checked: Bool) -> some View {
    if checked {
      Label(title, systemImage: "checkmark")
    } else {
      Text(title)
    }
  }

  private func launchOptionPill(systemImage: String, title: String) -> some View {
    HStack(spacing: 5) {
      Image(systemName: systemImage)
        .font(.system(size: 11, weight: .semibold))
      Text(title)
        .font(.system(size: 12, weight: .semibold))
        .lineLimit(1)
    }
    .foregroundStyle(ADEColor.textSecondary)
    .padding(.horizontal, 11)
    .frame(minHeight: 30)
    .adeKitPill()
  }

  /// Re-adopt the harness the last send ran under, once the machine's list
  /// proves the preset still exists and is bound. A manual pick already made
  /// while the fetch was in flight wins, and a preset only belongs to the
  /// primary host — the picker hides them for any other machine for the same
  /// reason.
  @MainActor
  private func resolveRestoredPreset() {
    guard selectedMachineKey == nil,
          selectedPreset == nil,
          selectedModelOption == nil,
          let restoredPresetId else { return }
    self.restoredPresetId = nil
    guard let preset = harnessPresets.first(where: { $0.id == restoredPresetId && $0.bound }) else { return }
    selectedPreset = preset
    modelId = preset.model
    provider = sessionMode == .chat
      ? workNormalizedChatProvider(preset.harness)
      : preset.harness
    machineModelHint = nil
  }

  /// The chosen model needs an account on the chosen machine. When that
  /// machine has none for the model's provider, pick its first provider's
  /// default model and say so.
  private func checkModelOnMachine() {
    machineModelHint = nil
    // A free model needs no account: it runs in the machine's OpenCode.
    if workIsFreeModel(modelId) { return }
    let machineName = selectedMachineOption.name
    let mode: WorkCursorAvailabilityMode = sessionMode == .cli ? .cli : .chat
    switch workNewChatModelCheck(
      machineKey: selectedMachineKey ?? syncService.focusedMachineKey,
      provider: provider,
      mode: mode
    ) {
    case .fits:
      return
    case .noAccount:
      machineModelHint = "\(machineName) has no account for this model."
    case .fallback(let fallbackModelId, let fallbackProvider):
      let previous = prettyNewChatModelName(modelId)
      // The machine cannot run the preset's model; a preset whose model no
      // longer matches must not ride along with the launch.
      selectedPreset = nil
      selectedModelOption = nil
      modelId = fallbackModelId
      provider = sessionMode == .chat ? workNormalizedChatProvider(fallbackProvider) : fallbackProvider
      machineModelHint = "\(machineName) has no account for \(previous). Using \(prettyNewChatModelName(fallbackModelId))."
    }
  }

  /// Parks composer focus while the lane sheet is up and restores it after the
  /// sheet has finished dismissing, so the flow stays continuous (same pattern
  /// as HubComposerDrawer's destination picker) — but only if it had focus.
  private func handleLaneSheetPresentation(_ presented: Bool) {
    if presented {
      composerFocusedBeforeLaneSheet = composerFocused
      composerFocused = false
    } else if composerFocusedBeforeLaneSheet {
      composerFocusedBeforeLaneSheet = false
      composerFocused = true
    }
  }

  /// Gap above the usage carousel. Matches what the old `VStack(spacing: 14)`
  /// plus its 2pt top padding produced: 16pt below whatever precedes it, 2pt
  /// when it is the only header content, nothing at all when it is collapsed.
  private var usageCarouselTopPadding: CGFloat {
    guard headerTier.showsUsageCarousel else { return 0 }
    // The chips row only renders for a concrete lane, so key off what is
    // actually drawn rather than off the tier flag alone.
    let chipsRendered = headerTier.showsActionChips && selectedConcreteLane != nil
    return (headerTier.showsBranding || chipsRendered) ? 16 : 2
  }

  /// The page never scrolls: the usage panel gets exactly the height left
  /// between the header and the floating lane bubble (content taller than that
  /// scrolls inside the panel), so the panel can no longer run under the
  /// bubble. Nil until the page has been measured.
  private var usagePanelMaxHeight: CGFloat? {
    guard scrollAreaHeight > 0, bottomControlsHeight > 0 else { return nil }
    let pagePadding: CGFloat = (headerTier.showsBranding ? 12 : 8) + 16
    let remaining = scrollAreaHeight - bottomControlsHeight - headerContentHeight
      - usageCarouselTopPadding - pagePadding - 1
    return max(120, remaining)
  }

  /// Steps the header tier from the height left above the floating controls,
  /// with a small deadband so freeing height by hiding content cannot
  /// immediately re-show it and start an oscillation.
  private func applyHeaderHeight() {
    let available = scrollAreaHeight - bottomControlsHeight
    guard scrollAreaHeight > 0, available > 0 else { return }
    let next = WorkNewChatHeaderTier.resolve(available: available, current: headerTier)
    if next != headerTier { headerTier = next }
  }

  /// Shell and Import session, as quiet neutral pills (desktop's launch-shelf
  /// ghost buttons). Only offered for a concrete lane — both act on an
  /// existing worktree.
  @ViewBuilder
  private var sessionActionChips: some View {
    if selectedMachineKey == nil, let lane = selectedConcreteLane {
      let chipsDisabled = busy || shellLaunchBusy
      let shellQueued = queuedShellLaneIds.contains(lane.id)
      let shellDisabled = chipsDisabled || shellQueued
      HStack(spacing: 8) {
        Button {
          Task { await launchShell(in: lane) }
        } label: {
          shellSessionAffordance(isBusy: shellLaunchBusy, isQueued: shellQueued, disabled: shellDisabled)
        }
        .buttonStyle(.plain)
        .disabled(shellDisabled)

        NavigationLink {
          WorkImportSessionScreen(
            lane: lane,
            lanes: visibleLanes,
            onCliImported: onCliStarted,
            onChatImported: onChatImported
          )
          .environmentObject(syncService)
        } label: {
          importSessionAffordance(disabled: chipsDisabled)
        }
        .buttonStyle(.plain)
        .disabled(chipsDisabled)
      }
    }
  }

  private func quietChip(
    systemImage: String?,
    title: String,
    disabled: Bool,
    showsProgress: Bool = false
  ) -> some View {
    HStack(spacing: 6) {
      if showsProgress {
        ProgressView()
          .controlSize(.mini)
      } else if let systemImage {
        Image(systemName: systemImage)
          .font(.system(size: 12, weight: .medium))
      }
      Text(title)
        .font(.system(size: 13, weight: .medium))
    }
    .foregroundStyle(ADEColor.textSecondary)
    .padding(.horizontal, 12)
    .frame(minHeight: 32)
    .background(ADEKit.track, in: Capsule(style: .continuous))
    .contentShape(Capsule(style: .continuous))
    .opacity(disabled && !showsProgress ? 0.5 : 1)
    .frame(minHeight: 44)
  }

  private func shellSessionAffordance(isBusy: Bool, isQueued: Bool, disabled: Bool) -> some View {
    quietChip(
      systemImage: isQueued ? "clock.badge.checkmark" : "terminal",
      title: isBusy ? "Starting shell" : (isQueued ? "Shell queued" : "Shell"),
      disabled: disabled,
      showsProgress: isBusy
    )
    .accessibilityLabel(isBusy ? "Starting shell" : (isQueued ? "Shell queued" : "Open shell"))
  }

  private func importSessionAffordance(disabled: Bool) -> some View {
    quietChip(systemImage: "square.and.arrow.down", title: "Import session", disabled: disabled)
  }

  @ViewBuilder
  private var composerBar: some View {
    WorkNewChatComposerBar(
      draftScopeProjectId: activeProjectId,
      draftScopeProjectRootPath: activeProjectRootPath,
      sessionMode: sessionMode,
      provider: $provider,
      modelId: modelId,
      modelName: selectedPreset?.name ?? prettyNewChatModelName(modelId),
      modelBrandKey: modelBrandKey,
      preset: selectedPreset,
      busy: busy,
      canStart: !busy && !shellLaunchBusy && (isAutoCreateLane || !selectedLaneId.isEmpty) && !modelId.isEmpty,
      attachmentsAvailable: attachmentsAvailable,
      canUploadAttachments: canUploadAttachments,
      runtimeMode: $runtimeMode,
      reasoningEffort: $reasoningEffort,
      codexFastMode: $codexFastMode,
      fastModeAllowed: fastModeAllowed,
      composerFocused: $composerFocused,
      onOpenModelPicker: {
        modelPickerPresented = true
      },
      launchMenu: AnyView(launchOptionsMenu),
      onSubmit: submit(openingMessage:attachments:)
    )
  }

  private func prettyNewChatModelName(_ model: String) -> String {
    let trimmed = model.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return "Model" }
    // The live host catalog names the model the same way the desktop picker
    // does ("DeepSeek V4.1 Flash"). Only when it has never been seen does the
    // label fall back to a prettified id — never the raw route.
    if let entry = WorkModelMentionDirectory.shared.entry(for: trimmed) {
      let title = entry.title.trimmingCharacters(in: .whitespacesAndNewlines)
      if !title.isEmpty { return title }
    }
    if let option = selectedModelOption, workModelIdsEquivalent(option.id, trimmed) {
      let name = option.displayName.trimmingCharacters(in: .whitespacesAndNewlines)
      if !name.isEmpty { return name }
    }
    if let known = workKnownModelDisplayName(trimmed) {
      return known
    }
    if let pretty = workPrettyModelNameFromId(trimmed) {
      return pretty
    }
    return trimmed
  }

  /// The mark the composer's model pill wears. A gateway model (OpenCode Go's
  /// DeepSeek) is branded by its maker, not by the runtime that routes it; the
  /// catalog directory carries that resolution once the picker has loaded.
  private var modelBrandKey: String {
    if let entry = WorkModelMentionDirectory.shared.entry(for: modelId) {
      return entry.brandKey
    }
    return provider
  }

  @MainActor
  private func launchShell(in lane: LaneSummary) async {
    guard !busy && !shellLaunchBusy else { return }
    shellLaunchBusy = true
    errorMessage = nil
    defer { shellLaunchBusy = false }

    do {
      let scope = workShellProjectScope(
        for: lane,
        projects: syncService.projects
      )
      let result = try await syncService.startShellSession(
        laneId: lane.id,
        targetProjectId: scope.projectId,
        targetProjectRootPath: scope.projectRootPath
      )
      if let session = result.session {
        await onCliStarted(session)
      } else {
        await onCliStarted(TerminalSessionSummary(
          id: result.sessionId,
          laneId: lane.id,
          laneName: lane.name,
          ptyId: result.ptyId,
          tracked: true,
          pinned: false,
          manuallyNamed: nil,
          goal: nil,
          toolType: "shell",
          title: "Shell",
          status: "running",
          startedAt: workDateFormatter.string(from: Date()),
          endedAt: nil,
          exitCode: nil,
          transcriptPath: "",
          headShaStart: nil,
          headShaEnd: nil,
          lastOutputPreview: nil,
          summary: nil,
          runtimeState: "running",
          resumeCommand: nil,
          resumeMetadata: nil,
          chatIdleSinceAt: nil
        ))
      }
    } catch is QueuedRemoteCommandError {
      ADEHaptics.medium()
      queuedShellLaneIds.insert(lane.id)
      errorMessage = nil
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  /// Starts the chat on ADE Cloud through the account server: on a new cloud
  /// lane, or on the picked cloud lane (with or without a computer). Its page
  /// opens at once, as a launch on a computer of your own does: the message,
  /// the setup steps (with Retry when the start fails), then the chat.
  private func submitOnCloud(opener: String, rawText: String, attachments: [WorkChatInputAttachment]) async -> Bool {
    if let refusal = cloudStore.doingRefusal {
      errorMessage = refusal
      return false
    }
    guard sessionMode == .chat else {
      errorMessage = "\(Brand.cloudName) starts chats from the phone. Switch to Chat."
      return false
    }
    // The files go up with the launch, from the bytes on this phone. A file
    // restored from a draft lives only on the machine that saved it.
    var files: [(name: String, contentType: String, data: Data)] = []
    for attachment in attachments {
      guard let data = attachment.uploadData ?? attachment.image?.jpegData(compressionQuality: 0.85) else {
        errorMessage = "\(attachment.filename) is on the machine that saved this draft. Remove it and attach it again to send it to \(Brand.cloudName)."
        return false
      }
      let isJPEG = attachment.uploadData == nil
      files.append((
        name: attachment.filename,
        contentType: isJPEG ? "image/jpeg" : attachment.mimeType,
        data: data
      ))
    }
    guard let project = syncService.activeAccountProjectForCloud else {
      errorMessage = "Add this project to your account to use \(Brand.cloudName)."
      return false
    }
    guard let entry = cloudProviderEntry, entry.models.contains(where: { $0.id == modelId }) else {
      errorMessage = "Pick a model \(Brand.cloudName) runs."
      return false
    }
    let existingLane: (id: String, name: String)? = isAutoCreateLane ? nil : visibleLanes
      .first { $0.id == selectedLaneId }
      .map { lane in (workParseRemoteLaneId(lane.id)?.laneId ?? lane.id, lane.name) }
    if !isAutoCreateLane, existingLane == nil {
      errorMessage = "Pick a lane."
      return false
    }
    busy = true
    errorMessage = nil
    if !isOnFreeDefault { WorkComposerPreferences.save(composerSelection) }
    let launchId = await cloudLaunches.start(
      accountProjectId: project.id,
      origin: "\(project.host)/\(project.owner)/\(project.name)",
      prompt: opener,
      provider: entry.provider,
      modelId: modelId,
      effort: reasoningEffort,
      // Only a model ADE Cloud runs fast; the saved preference stays.
      fast: codexFastMode && fastModeAllowed && entry.models.contains { $0.id == modelId && $0.fast },
      files: files,
      existingLane: existingLane,
      newLaneName: existingLane == nil ? autoCreatedLaneName(opener: rawText) : nil,
      using: syncService
    )
    busy = false
    let launch = cloudLaunches.entries.first { $0.launchId == launchId }
    if let startError = launch?.startError, launch?.startNeverReached == true, launch?.record == nil {
      // ADE Cloud surely kept nothing: the message stays here (false
      // restores the draft), with the reason, for a send again. A start with
      // no answer may run: its page opens with Retry under the same id.
      ADEHaptics.error()
      cloudLaunches.discardFailedStart(launchId)
      errorMessage = startError
      return false
    }
    ADEHaptics.success()
    // A start ADE Cloud kept opens its page; a later failure shows there with Retry.
    await onCloudLaunchStarted(launchId)
    return true
  }

  private func submit(openingMessage: String, attachments inputAttachments: [WorkChatInputAttachment]) async -> Bool {
    let readyAttachments = workChatInputReadyAttachments(inputAttachments)
    let rawText = openingMessage.trimmingCharacters(in: .whitespacesAndNewlines)
    let opener = workChatOutgoingText(openingMessage, attachmentCount: readyAttachments.count)
    // A chat's first message carries the issue references the menu attached,
    // the same way desktop's does; the transcript still names the launch with
    // the person's own words.
    let chatOpener = workLaunchChatOpener(opener, issues: launchIssues)
    guard !busy && !shellLaunchBusy && (isAutoCreateLane || !selectedLaneId.isEmpty) else { return false }
    guard !opener.isEmpty && !modelId.isEmpty else { return false }
    let availabilityMode: WorkCursorAvailabilityMode = sessionMode == .cli ? .cli : .chat
    guard workModelAllowedForAvailabilityMode(modelId: modelId, provider: provider, mode: availabilityMode) else {
      errorMessage = sessionMode == .cli
        ? "This model is available for chat only. Choose a CLI-capable model."
        : "This model is available for CLI only. Choose a chat-capable model."
      return false
    }
    if isCloudSelected {
      return await submitOnCloud(opener: chatOpener, rawText: rawText, attachments: readyAttachments)
    }
    guard readyAttachments.isEmpty || canUploadAttachments else {
      errorMessage = "Reconnect to attach images."
      return false
    }
    // Another machine: its checkout of this project. Chats and CLI sessions
    // both start there, scoped to that checkout and sent over that machine's
    // own connection.
    let remoteRepo = selectedRemoteRepo
    if selectedMachineKey != nil {
      guard remoteRepo != nil else {
        errorMessage = "That machine has no checkout of this project."
        return false
      }
    }
    // The machine pill stays tappable while the composer is busy; capture the
    // launch's inputs once so a late tap cannot move the lane, drop the account,
    // or empty the issue list between here and the first await.
    let launchRemoteRepo = remoteRepo
    let launchSessionMode = sessionMode
    let launchIsAutoCreateLane = isAutoCreateLane
    let launchLaneId = selectedLaneId
    let launchPresetId = selectedPreset?.id
    // The raw id, not the resolved row: a failed refresh empties the display
    // rows but the person's pick is still the account the host should resolve.
    let launchAccountId = selectedLaunchAccountId
    let launchIssuesSnapshot = launchIssues
    // Anchor the "last time you sent a message" choice — covers the case where
    // the user sent with the restored/default selection without changing it.
    // Not a free model ADE picked: that was never the person's choice.
    if !isOnFreeDefault { WorkComposerPreferences.save(composerSelection) }
    busy = true
    errorMessage = nil
    let wire = workRuntimeWireFields(provider: provider, mode: runtimeMode)
    let piMetadata = workResolvedPiModelMetadata(
      modelId: modelId,
      profileId: selectedModelOption?.piProfileId,
      providerId: selectedModelOption?.piProviderId,
      piModelId: selectedModelOption?.piModelId
    )
    let normalizedReasoning = reasoningEffort.trimmingCharacters(in: .whitespacesAndNewlines)

    // Auto-create lane + plain chat: the host owns the whole launch (reserve
    // ids, fetch, checkout, template, create the chat, send the opener) and
    // this screen opens the chat immediately. Older hosts that do not
    // advertise `chat.startLaunch` — and offline sends — keep the chained flow
    // below unchanged.
    if let request = ChatLaunchRequest(
      composerOpener: opener,
      laneName: autoCreatedLaneName(opener: opener),
      provider: provider,
      modelId: modelId,
      reasoningEffort: reasoningEffort,
      codexFastMode: codexFastMode,
      presetId: launchPresetId,
      piMetadata: piMetadata,
      wire: wire,
      projectId: activeProjectId,
      projectRootPath: activeProjectRootPath,
      originClientId: syncService.pairingDeviceId,
      isAutoCreateLane: launchIsAutoCreateLane,
      isChatSession: launchSessionMode == .chat,
      cursorCloudMode: false,
      // Issue links need the chained flow's post-create attach; the host-owned
      // launch has no issue-link field. Account selection travels on both.
      hostCanStartLaunch: launchRemoteRepo == nil && syncService.canStartChatLaunch && launchIssuesSnapshot.isEmpty,
      instanceId: launchAccountId
    ) {
      let syncService = syncService
      let attachmentsToStage = readyAttachments
      let scopeProjectId = activeProjectId
      let scopeProjectRootPath = activeProjectRootPath
      // Attachments stage on the host in the background (same helper and scope
      // the chained flow uses before `chat.send`); the launch carries the refs.
      let snapshot = syncService.beginChatLaunch(request) {
        try await workChatSaveInputAttachments(
          attachmentsToStage,
          syncService: syncService,
          targetProjectId: scopeProjectId,
          targetProjectRootPath: scopeProjectRootPath
        )
      }
      ADEHaptics.success()
      busy = false
      await onLaunchStarted(snapshot)
      return true
    }

    // Resolve the target lane. When auto-create is selected we mint a fresh
    // lane first; on failure we surface the error and never create the session.
    // Track whether we created the lane so we can clean it up if the session
    // launch fails immediately afterwards (desktop parity).
    let targetLaneId: String
    let targetLaneForScope: LaneSummary?
    var createdLaneId: String?
    var autoCreatedFallbackName: String?
    var autoCreatedTemporaryBranch: String?
    if launchIsAutoCreateLane {
      withAnimation(.snappy(duration: 0.16)) {
        autoCreateStatus = "Creating lane…"
      }
      do {
        let laneName = autoCreatedLaneName(opener: opener)
        let lane = try await syncService.createLane(
          name: laneName,
          description: opener.isEmpty ? "" : String(opener.prefix(280)),
          autoNamedBranch: true,
          targetProjectId: launchRemoteRepo?.markedProjectId,
          targetProjectRootPath: launchRemoteRepo?.rootPath,
          setUpLane: true
        )
        targetLaneId = lane.id
        targetLaneForScope = lane
        createdLaneId = lane.id
        autoCreatedFallbackName = laneName
        // The host chose the placeholder in the project's branch pattern.
        autoCreatedTemporaryBranch = lane.branchRef
        await onRefreshLanes()
      } catch {
        ADEHaptics.error()
        errorMessage = error.localizedDescription
        autoCreateStatus = nil
        busy = false
        return false
      }
    } else {
      targetLaneId = launchLaneId
      targetLaneForScope = visibleLanes.first { $0.id == launchLaneId }
    }
    let targetScope = launchRemoteRepo.map {
      WorkProjectCommandScope(
        projectId: $0.markedProjectId,
        projectRootPath: $0.rootPath
      )
    } ?? targetLaneForScope
      .map { workShellProjectScope(for: $0, projects: syncService.projects) }
      ?? WorkProjectCommandScope(projectId: nil, projectRootPath: nil)

    // Lane is ready; the naming/creating banner is done — the composer + nav
    // spinner carry the remaining "starting session" state.
    autoCreateStatus = nil
    var createdChatSummary: AgentChatSessionSummary?
    var createdChatAttachments: [AgentChatFileRef] = []
    var namingAttachmentRefs: [AgentChatFileRef] = []

    do {
      let attachmentRefs = try await workChatSaveInputAttachments(
        readyAttachments,
        syncService: syncService,
        targetProjectId: targetScope.projectId,
        targetProjectRootPath: targetScope.projectRootPath
      )
      namingAttachmentRefs = attachmentRefs
      if launchSessionMode == .cli {
        let cliProvider = workResolveCliProvider(for: modelId, provider: provider)
        let cliReasoningEffort = workCliSupportsReasoningSelection(provider: cliProvider) && !normalizedReasoning.isEmpty
          ? normalizedReasoning
          : nil
        let result = try await syncService.startCliSession(
          laneId: targetLaneId,
          provider: cliProvider,
          permissionMode: workCliPermissionMode(provider: cliProvider, runtimeMode: runtimeMode),
          title: workCliInitialSessionTitle(provider: cliProvider, opener: opener),
          initialInput: workLaunchCliInitialInput(text: rawText, attachments: attachmentRefs, issues: launchIssuesSnapshot),
          modelId: modelId,
          reasoningEffort: cliReasoningEffort,
          fastMode: fastModeSupported ? codexFastMode : nil,
          presetId: launchPresetId,
          instanceId: launchAccountId,
          linearIssues: launchIssuesSnapshot.compactMap(\.linearIssue),
          cols: 48,
          rows: 24,
          // Same scope as a chat: another machine's checkout routes the start
          // (and the reply's lane ids) through that machine.
          targetProjectId: targetScope.projectId,
          targetProjectRootPath: targetScope.projectRootPath
        )
        if let session = result.session {
          await onCliStarted(session)
        } else {
          let lane = visibleLanes.first(where: { $0.id == targetLaneId })
          await onCliStarted(TerminalSessionSummary(
            id: result.sessionId,
            laneId: targetLaneId,
            laneName: lane?.name ?? targetLaneId,
            ptyId: result.ptyId,
            tracked: true,
            pinned: false,
            manuallyNamed: nil,
            goal: opener.isEmpty ? nil : opener,
            toolType: workCliToolType(provider: cliProvider),
            title: workCliInitialSessionTitle(provider: cliProvider, opener: opener),
            status: "running",
            startedAt: workDateFormatter.string(from: Date()),
            endedAt: nil,
            exitCode: nil,
            transcriptPath: "",
            headShaStart: nil,
            headShaEnd: nil,
            lastOutputPreview: nil,
            summary: nil,
            runtimeState: "running",
            resumeCommand: nil,
            resumeMetadata: nil,
            chatIdleSinceAt: nil
          ))
        }
        if let createdLaneId, let autoCreatedFallbackName {
          startBackgroundLaneNaming(laneId: createdLaneId, opener: opener, fallbackName: autoCreatedFallbackName, temporaryBranch: autoCreatedTemporaryBranch, attachments: namingAttachmentRefs)
        }
        busy = false
        return true
      }
      let summary = try await syncService.createChatSession(
        laneId: targetLaneId,
        provider: provider,
        model: modelId,
        reasoningEffort: normalizedReasoning.isEmpty ? nil : normalizedReasoning,
        // Preserve the independent preference. Runtime capability checks
        // belong at request construction, not in the composer state.
        codexFastMode: codexFastMode,
        piProfileId: piMetadata?.profileId,
        piProviderId: piMetadata?.providerId,
        piModelId: piMetadata?.modelId,
        permissionMode: wire.permissionMode,
        interactionMode: wire.interactionMode,
        claudePermissionMode: wire.claudePermissionMode,
        codexApprovalPolicy: wire.codexApprovalPolicy,
        codexSandbox: wire.codexSandbox,
        codexConfigSource: wire.codexConfigSource,
        opencodePermissionMode: wire.opencodePermissionMode,
        droidPermissionMode: wire.droidPermissionMode,
        musePermissionMode: wire.musePermissionMode,
        copilotPermissionMode: wire.copilotPermissionMode,
        copilotContextTier: providerFamilyKey(provider) == "copilot" ? copilotContextTier : nil,
        copilotAutoTier: providerFamilyKey(provider) == "copilot" ? copilotAutoTier : nil,
        cursorModeId: wire.cursorModeId,
        targetProjectId: targetScope.projectId,
        targetProjectRootPath: targetScope.projectRootPath,
        pendingDisplayName: opener,
        presetId: launchPresetId,
        instanceId: launchAccountId
      )
      createdChatSummary = summary
      createdChatAttachments = attachmentRefs
      if let launchRemoteRepo {
        // The chat lives on that machine: its reads, sends and stream go there.
        syncService.setRemoteMachineChatScope(
          sessionId: summary.sessionId,
          machineKey: launchRemoteRepo.machineKey,
          projectId: launchRemoteRepo.projectId,
          projectRootPath: launchRemoteRepo.rootPath
        )
      }
      // Record the picked issues on the chat (and its lane) the way desktop's
      // attach does, so the lane's linked-issue list and a PR's "Closes"
      // references are right. Runs after the remote scope is set, so a chat on
      // another machine takes its links there. The first message already names
      // them; a failed link must not cost the person their chat, but it must
      // not disappear either.
      for issue in launchIssuesSnapshot {
        do {
          switch issue {
          case .linear(let linear):
            try await syncService.attachLinearIssueToChat(chatSessionId: summary.sessionId, issue: linear)
          case .github:
            if let payload = issue.githubIssuePayload {
              try await syncService.attachGitHubIssueToChat(chatSessionId: summary.sessionId, issues: [payload])
            }
          }
        } catch {
          workLaunchIssueLog.warning("issue_link_failed provider=\(issue.providerLabel, privacy: .public) id=\(issue.identifier, privacy: .public) error=\(String(describing: error), privacy: .private)")
        }
      }
      if attachmentRefs.isEmpty {
        await onStarted(summary, chatOpener, false, nil, [])
      } else {
        let delivery = try await syncService.sendChatMessage(
          sessionId: summary.sessionId,
          text: chatOpener,
          attachments: attachmentRefs,
          targetProjectId: targetScope.projectId,
          targetProjectRootPath: targetScope.projectRootPath
        )
        let deliveryState: String?
        switch delivery {
        case .queued:
          deliveryState = "queued"
        case .sent, .dropped, .heldByServer:
          // `.dropped` (queue_full) is steer-only, and `.heldByServer` needs
          // an asleep cloud chat with no files; a new chat's opener with
          // files is neither. Fold both into the delivered path to keep the
          // switch exhaustive.
          deliveryState = nil
        }
        await onStarted(summary, chatOpener, true, deliveryState, attachmentRefs)
      }
      if let createdLaneId, let autoCreatedFallbackName {
        startBackgroundLaneNaming(laneId: createdLaneId, opener: opener, fallbackName: autoCreatedFallbackName, temporaryBranch: autoCreatedTemporaryBranch, attachments: namingAttachmentRefs)
      }
      busy = false
      return true
    } catch let error as QueuedRemoteCommandError {
      if workQueuedNewSessionConsumesOpeningDraft(sessionMode) {
        // The queued CLI start already owns `initialInput`; restoring it would
        // invite a duplicate command when the user submits again.
        ADEHaptics.medium()
        errorMessage = nil
        if let createdLaneId, let autoCreatedFallbackName {
          startBackgroundLaneNaming(
            laneId: createdLaneId,
            opener: opener,
            fallbackName: autoCreatedFallbackName,
            temporaryBranch: autoCreatedTemporaryBranch,
            attachments: namingAttachmentRefs
          )
        }
        busy = false
        return true
      }
      // Offline: the create was queued and a "Pending sync" row now stands in
      // for it on the Work list. The opener itself was not sent, so keep the
      // lane and return false to preserve the exact draft and attachments.
      ADEHaptics.medium()
      errorMessage = error.localizedDescription
      busy = false
      return false
    } catch let error as AmbiguousChatCreationError {
      // The host may already have created the session. Keep its lane and draft,
      // and let the Work list reconcile before the user chooses to retry.
      ADEHaptics.error()
      errorMessage = error.localizedDescription
      busy = false
      return false
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
      if let createdChatSummary {
        // Session creation succeeded, so the opener failure is ambiguous: the
        // host may already be running it. Keep the lane/session, open the chat,
        // mark the optimistic echo failed, and restore the exact text into the
        // mounted composer. Never auto-resend or delete the live lane.
        await onStarted(
          createdChatSummary,
          opener,
          true,
          "failed",
          createdChatAttachments
        )
        if let createdLaneId, let autoCreatedFallbackName {
          startBackgroundLaneNaming(
            laneId: createdLaneId,
            opener: opener,
            fallbackName: autoCreatedFallbackName,
            temporaryBranch: autoCreatedTemporaryBranch,
            attachments: namingAttachmentRefs
          )
        }
        busy = false
        return true
      }
      // The session never launched into a lane we just minted — tear it back
      // down so an auto-create failure doesn't leave an orphaned empty lane.
      if let createdLaneId {
        try? await syncService.deleteLane(createdLaneId)
        await onRefreshLanes()
      }
      busy = false
      return false
    }
  }

  /// Builds the desktop-parity deterministic fallback name for an auto-created
  /// lane. The host can still replace this through the best-effort naming call.
  private func autoCreatedLaneName(opener: String) -> String {
    workDeterministicAutoLaneName(from: opener, genericSuffix: workAutoLaneGenericSuffix())
  }

  /// Desktop-parity background lane naming. The lane is created immediately
  /// with the deterministic fallback; then the host AI gets two chances to
  /// replace it, and every failure is logged with the lane id so mobile
  /// auto-naming cannot silently disappear again.
  private func startBackgroundLaneNaming(
    laneId: String,
    opener: String,
    fallbackName: String,
    temporaryBranch: String?,
    attachments: [AgentChatFileRef]
  ) {
    let syncService = syncService
    let modelId = modelId
    let onRefreshLanes = onRefreshLanes
    Task {
      await workRunAutoLaneAiRename(
        laneId: laneId,
        opener: opener,
        fallbackName: fallbackName,
        modelId: modelId,
        temporaryBranch: temporaryBranch,
        attachments: attachments,
        syncService: syncService,
        surface: .workNewChat,
        refreshLanes: onRefreshLanes
      )
    }
  }

}

private func workCliSupportsReasoningSelection(provider: String) -> Bool {
  let family = providerFamilyKey(provider)
  return family == "claude" || family == "codex" || family == "muse" || family == "droid" || family == "pi" || family == "antigravity"
}

private func workCliInitialSessionTitle(provider: String, opener: String) -> String {
  let fallback = providerLabel(provider)
  let seed = opener
    .replacingOccurrences(of: "\n", with: " ")
    .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
    .trimmingCharacters(in: .whitespacesAndNewlines)
  guard !seed.isEmpty else {
    return fallback
  }
  let clipped: String
  if seed.count > 72 {
    let prefix = String(seed.prefix(72))
    clipped = prefix.replacingOccurrences(of: #"\s+\S*$"#, with: "", options: .regularExpression)
  } else {
    clipped = seed
  }
  return clipped.trimmingCharacters(in: CharacterSet(charactersIn: ".?!,:; ").union(.whitespacesAndNewlines))
}

func workCliPermissionMode(provider: String, runtimeMode: String) -> String? {
  let wire = workRuntimeWireFields(provider: provider, mode: runtimeMode)
  guard let permissionMode = wire.permissionMode, !permissionMode.isEmpty else {
    return nil
  }
  return permissionMode
}

private func workCliToolType(provider: String) -> String {
  switch providerFamilyKey(provider) {
  case "claude": return "claude"
  case "codex": return "codex"
  case "cursor": return "cursor-cli"
  case "opencode": return "opencode"
  case "pi": return "pi"
  case "muse": return "muse"
  case "droid": return "droid"
  case "qwen": return "qwen"
  case "kimi": return "kimi"
  case "grok": return "grok"
  case "copilot": return "copilot"
  case "antigravity": return "antigravity"
  case "shell": return "shell"
  default: return "opencode"
  }
}

private struct WorkNewChatComposerBar: View {
  /// The project the drafts this composer opens belong to, so a draft listed
  /// or scheduled here targets the project the user is looking at.
  let draftScopeProjectId: String?
  let draftScopeProjectRootPath: String?
  let sessionMode: WorkNewSessionMode
  @Binding var provider: String
  let modelId: String
  let modelName: String
  /// The model pill's mark, resolved upstream of the gateway route.
  let modelBrandKey: String
  /// A selected Custom harness, whose own mark and accent replace the provider
  /// mark while the composer runs on it.
  let preset: SyncMachineInventoryPreset?
  let busy: Bool
  let canStart: Bool
  let attachmentsAvailable: Bool
  let canUploadAttachments: Bool
  @Binding var runtimeMode: String
  @Binding var reasoningEffort: String
  @Binding var codexFastMode: Bool
  /// The account's Fast permission; false draws the muted bolt and disables the
  /// picker's switch without offering a dead toggle.
  let fastModeAllowed: Bool
  /// Owned by the screen so the lane sheet can park and restore keyboard focus.
  @Binding var composerFocused: Bool
  let onOpenModelPicker: () -> Void
  /// Launch options the ⋯ menu draws (account, issue context), owned by the
  /// screen so the picks survive the composer's own state.
  var launchMenu: AnyView? = nil
  let onSubmit: @MainActor (String, [WorkChatInputAttachment]) async -> Bool

  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  private var syncService: SyncService { syncPublishes.service }
  @State private var draft: String = ""
  @State private var attachments: [WorkChatInputAttachment] = []
  /// Set by a tap on an image or file pill; the tray opens that preview.
  @State private var attachmentPreviewRequest: UUID?
  @State private var presentedPicker: WorkComposerPicker?
  private let dictationTargetId = "work-new-chat-screen"

  private var canSend: Bool {
    workChatInputCanSend(
      text: draft,
      attachments: attachments,
      baseEnabled: canStart,
      canUploadAttachments: canUploadAttachments
    )
  }

  private var runtimeOptions: [WorkRuntimeModeOption] {
    workRuntimeModeOptions(provider: provider)
  }

  private var placeholder: String {
    "Type to vibecode…"
  }

  @MainActor
  private func dispatch() {
    let outgoingAttachments = workChatInputReadyAttachments(attachments)
    guard canSend else { return }
    let restoredDraft = draft
    let restoredAttachments = attachments
    composerFocused = false
    draft = ""
    attachments.removeAll()
    // Drop the persisted draft synchronously — navigating into the new chat must
    // not race the 400ms autosave debounce and leave the just-sent text behind.
    WorkComposerDraftStore.clear(WorkComposerDraftStore.workNewChatKey)
    Task {
      let started = await onSubmit(restoredDraft, outgoingAttachments)
      if !started {
        draft = restoredDraft
        attachments = restoredAttachments
      }
    }
  }

  var body: some View {
    ADEPlainGlassComposer(
      text: $draft,
      isFocused: $composerFocused,
      attachments: $attachments,
      placeholder: placeholder,
      acceptsPastedImages: attachmentsAvailable,
      sendEnabled: canSend && !busy,
      sending: busy,
      dictationTargetId: dictationTargetId,
      onSend: { dispatch() },
      menu: { startDictation in
        WorkComposerOverflowButton(
          presentedPicker: $presentedPicker,
          draft: $draft,
          attachments: $attachments,
          canCompose: !busy,
          attachmentsAvailable: attachmentsAvailable,
          onDictate: startDictation,
          draftsAvailable: syncService.canInvokeRemoteAction("chat.listDrafts"),
          scheduleAvailable: syncService.canInvokeRemoteAction("chat.createDraft"),
          scope: WorkDraftScope(
            projectId: draftScopeProjectId,
            projectRootPath: draftScopeProjectRootPath
          ),
          provider: provider,
          modelId: modelId,
          runtimeMode: runtimeMode,
          extraMenuContent: launchMenu
        )
      },
      controls: {
        ScrollView(.horizontal, showsIndicators: false) {
          WorkComposerControlsRow(
            provider: provider,
            modelDisplayName: modelName,
            modelBrandKey: modelBrandKey,
            preset: preset,
            reasoningEffort: reasoningEffort,
            currentMode: runtimeMode,
            modeOptions: runtimeOptions,
            modeLabel: workRuntimeModeLabel(provider: provider, mode: runtimeMode),
            fastModeEnabled: codexFastMode,
            fastModeAllowed: fastModeAllowed,
            onOpenModelPicker: onOpenModelPicker,
            onSelectMode: { runtimeMode = $0 }
          )
          .padding(.trailing, 4)
        }
      }
    )
    .padding(.horizontal, 10)
    .workChatAttachmentPicker(
      isPresented: $presentedPicker.isPresenting(.photos),
      attachments: $attachments,
      onDismiss: { composerFocused = true }
    )
    .workPersistedDraft($draft, key: WorkComposerDraftStore.workNewChatKey)
    .workPersistedDraftAttachments($attachments, key: WorkComposerDraftStore.workNewChatKey)
    .workChatFileAttachmentPickers(
      presentedPicker: $presentedPicker,
      attachments: $attachments,
      onDismiss: {}
    )
  }

  /// Primary foreground launch button — the compact arrow-in-circle send glyph
  /// shared with the in-session composer (desktop parity), navigating into the
  /// new live chat.
  private var foregroundSendButton: some View {
    ADEComposerSendButton(
      enabled: canSend && !busy,
      sending: busy,
      accessibilityLabelText: "Send",
      disabledAccessibilityLabel: "Enter a message to send"
    ) {
      dispatch()
    }
  }

}

/// Back as a top-leading item that stays in the top row (never moves into a
/// vertical edge bar). Only where the system back button would land there.
private struct WorkNewChatTopBackButton: ViewModifier {
  let shown: Bool
  let action: () -> Void

  func body(content: Content) -> some View {
    if !shown {
      content
    } else {
      #if compiler(>=6.4)
      if #available(iOS 27.1, *) {
        content.toolbar {
          ToolbarItem(placement: .topBarLeading) { button }
            .axisBehavior(.horizontalOnly)
        }
      } else {
        content.toolbar {
          ToolbarItem(placement: .topBarLeading) { button }
        }
      }
      #else
      content.toolbar {
        ToolbarItem(placement: .topBarLeading) { button }
      }
      #endif
    }
  }

  private var button: some View {
    Button("Back", systemImage: "chevron.left", action: action)
      .accessibilityIdentifier("Work.NewChat.Back")
  }
}

struct WorkNewChatRoute: Hashable {
  let preferredLaneId: String?
}

#if DEBUG
/// Fixture render of the real New Chat page — two lanes, Claude + Codex limits
/// across several accounts, and a month of activity — so a simulator can
/// screenshot it with no pairing. Reached with `-adePreviewScreen new-chat`.
/// `-adePreviewFocusComposer` opens it with the composer expanded.
struct WorkNewChatPreviewHost: View {
  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  private var syncService: SyncService { syncPublishes.service }

  /// `new-chat-deepseek`: start the composer on a gateway-routed model
  /// (`opencode/opencode-go/deepseek-v4.1-flash`), seed the live catalog that
  /// names it, and open on the long-branch lane — the inputs the model-chip and
  /// layout fixes are about, provable with no pairing.
  let usesGatewayModelFixture: Bool

  init(usesGatewayModelFixture: Bool = false, freeModelsFixture: Bool = false) {
    self.usesGatewayModelFixture = usesGatewayModelFixture
    if freeModelsFixture {
      // A new person's computer: nothing signed in, so the page starts on the
      // free default and never saves it as the remembered model.
      WorkFreeModelsStatusStore.shared.pinPreview(
        status: WorkFreeModelsPreviewData.status,
        freeModelIds: WorkFreeModelsPreviewData.freeModelIds
      )
      if let catalog = WorkFreeModelsPreviewData.catalog(includeFree: true) {
        SyncMenuSafePublisher.shared.service.seedPreviewChatModelCatalog(catalog)
        WorkModelMentionDirectory.shared.record(catalog: catalog)
      }
    }
    MobileUsageQuotaStore.shared.pinPreviewSnapshot(WorkNewChatPreviewFixtures.quotaSnapshot())
    WorkUsageActivityCarousel.previewStats = WorkNewChatPreviewFixtures.stats()
    if usesGatewayModelFixture {
      WorkComposerPreferences.save(
        provider: "opencode",
        modelId: WorkNewChatPreviewFixtures.gatewayModelId,
        runtimeMode: "default",
        reasoningEffort: "",
        codexFastMode: false
      )
      if let catalog = WorkNewChatPreviewFixtures.gatewayCatalog() {
        WorkModelMentionDirectory.shared.record(catalog: catalog)
      }
    }
  }

  var body: some View {
    NavigationStack {
      WorkNewChatScreen(
        lanes: WorkNewChatPreviewFixtures.lanes,
        preferredLaneId: usesGatewayModelFixture
          ? WorkNewChatPreviewFixtures.lanes[1].id
          : WorkNewChatPreviewFixtures.lanes.first?.id,
        activeProjectId: "preview-project",
        activeProjectRootPath: "/Users/preview/Projects/ADE",
        onStarted: { _, _, _, _, _ in },
        onCliStarted: { _ in },
        onRefreshLanes: {},
        onCloudLaunchStarted: { _ in }
      )
    }
  }
}

@MainActor
enum WorkNewChatPreviewFixtures {
  static let lanes: [LaneSummary] = [
    lane(id: "preview-lane-primary", name: "Primary", type: "primary", branch: "main", color: "blue"),
    lane(id: "preview-lane-glass", name: "Glass composer", type: "worktree", branch: "ade/glass-composer-4c06a9a3", color: "purple"),
    lane(id: "preview-lane-usage", name: "Usage panel", type: "worktree", branch: "ade/usage-panel-19ab22", color: "green"),
  ]

  /// The gateway-routed model the chip fixture starts on: OpenCode Go fronts
  /// DeepSeek, so the route names the gateway and the maker is the model.
  static let gatewayModelId = "opencode/opencode-go/deepseek-v4.1-flash"

  /// The host's `chat.modelCatalog` row for `gatewayModelId`, decoded from the
  /// same JSON shape the wire carries so the fixture cannot drift from the
  /// contract.
  static func gatewayCatalog() -> AgentChatModelCatalog? {
    let raw = """
    {"fetchedAt":"2026-10-02T00:00:00.000Z","groups":[{"key":"opencode","displayName":"OpenCode","providers":[{"key":"opencode-go","displayName":"OpenCode Go","badgeColor":"#4D6BFE","modelCount":1,"subsections":[{"key":"opencode-go","label":"OpenCode Go","models":[{"id":"opencode/opencode-go/deepseek-v4.1-flash","runtimeModelId":"deepseek-v4.1-flash","provider":"opencode","providerKey":"opencode-go","groupKey":"opencode","displayName":"DeepSeek V4.1 Flash","description":"DeepSeek V4.1 Flash (OpenCode)","isDefault":false,"family":"opencode","supportsReasoning":true,"supportsTools":true,"isAvailable":true}]}]}]}]}
    """
    return try? JSONDecoder().decode(AgentChatModelCatalog.self, from: Data(raw.utf8))
  }

  private static func lane(id: String, name: String, type: String, branch: String, color: String) -> LaneSummary {
    LaneSummary(
      id: id,
      name: name,
      description: nil,
      laneType: type,
      baseRef: "main",
      branchRef: branch,
      worktreePath: "/Users/preview/Projects/ADE/.ade/worktrees/\(id)",
      attachedRootPath: nil,
      isEditProtected: false,
      status: LaneStatus(dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false),
      color: color,
      icon: .bolt,
      tags: [],
      folder: nil,
      createdAt: iso(Date().addingTimeInterval(-86_400)),
      archivedAt: nil,
      devicesOpen: []
    )
  }

  private static func iso(_ date: Date) -> String {
    ISO8601DateFormatter().string(from: date)
  }

  private static func window(
    _ provider: String,
    _ type: String,
    used: Double,
    resetsIn seconds: TimeInterval,
    duration: TimeInterval,
    account: String
  ) -> MobileUsageQuotaWindow {
    MobileUsageQuotaWindow(
      provider: provider,
      windowType: type,
      percentUsed: used,
      resetsAt: iso(Date().addingTimeInterval(seconds)),
      resetsInMs: seconds * 1000,
      windowDurationMs: duration * 1000,
      accountId: account
    )
  }

  static func quotaSnapshot() -> MobileUsageQuotaSnapshot {
    let fiveHours: TimeInterval = 5 * 3_600
    let week: TimeInterval = 7 * 86_400
    let machine = [MobileUsageAccountMachine(machineKey: "mac", label: "Arul's MacBook Pro", checkedAt: iso(Date()))]
    return MobileUsageQuotaSnapshot(
      windows: [
        window("claude", "five_hour", used: 54, resetsIn: 1 * 3_600 + 49 * 60, duration: fiveHours, account: "claude-personal"),
        window("claude", "weekly", used: 31, resetsIn: 3 * 86_400 + 5 * 3_600, duration: week, account: "claude-personal"),
        window("claude", "five_hour", used: 12, resetsIn: 3 * 3_600 + 10 * 60, duration: fiveHours, account: "claude-work"),
        window("claude", "weekly", used: 78, resetsIn: 1 * 86_400 + 2 * 3_600, duration: week, account: "claude-work"),
        window("codex", "five_hour", used: 22, resetsIn: 4 * 3_600 + 2 * 60, duration: fiveHours, account: "codex-personal"),
        window("codex", "weekly", used: 93, resetsIn: 2 * 86_400 + 7 * 3_600, duration: week, account: "codex-personal"),
      ],
      accounts: [
        MobileUsageAccount(id: "claude-personal", provider: "claude", email: "arul@example.com", plan: "Claude Max", machines: machine, url: "https://claude.ai/settings/usage"),
        MobileUsageAccount(id: "claude-work", provider: "claude", email: "arul@versic.dev", plan: "Claude Team", machines: machine, url: "https://claude.ai/settings/usage"),
        MobileUsageAccount(id: "codex-personal", provider: "codex", email: "arul@example.com", plan: "ChatGPT Pro", machines: machine, url: "https://chatgpt.com/codex/settings/usage"),
      ],
      providerStatus: [
        "claude": MobileUsageProviderStatus(state: "ok", lastSuccessAt: iso(Date()), source: "oauth", updatedAt: iso(Date()), accountUrl: "https://claude.ai/settings/usage"),
        "codex": MobileUsageProviderStatus(state: "ok", lastSuccessAt: iso(Date()), source: "oauth", updatedAt: iso(Date()), accountUrl: "https://chatgpt.com/codex/settings/usage"),
      ],
      lastPolledAt: iso(Date().addingTimeInterval(-40)),
      errors: [],
      spendControlReached: false
    )
  }

  /// `-adeUsageFixtureDays <n>`: a short history (a new install), one client.
  static func stats() -> MobileAdeUsageStats? {
    let calendar = Calendar(identifier: .gregorian)
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.dateFormat = "yyyy-MM-dd"
    let fixtureDays = UserDefaults.standard.integer(forKey: "adeUsageFixtureDays")
    let sparse = fixtureDays > 0
    var daily: [[String: Any]] = []
    for offset in stride(from: (sparse ? fixtureDays : 70) - 1, through: 0, by: -1) {
      guard let day = calendar.date(byAdding: .day, value: -offset, to: Date()) else { continue }
      let seed = (offset * 37 + 11) % 100
      let quiet = seed < 18
      let input = quiet ? 0 : 40_000 + seed * 5_200
      let output = quiet ? 0 : 12_000 + seed * 1_700
      let cached = quiet ? 0 : 180_000 + seed * 21_000
      daily.append([
        "date": formatter.string(from: day),
        "inputTokens": input,
        "outputTokens": output,
        "cachedTokens": cached,
        "totalTokens": input + output + cached,
        "sessions": quiet ? 0 : 1 + seed % 6,
        "interactions": quiet ? 0 : 4 + seed % 30,
        "commits": quiet ? 0 : seed % 5,
        "insertions": quiet ? 0 : 60 + seed * 9,
        "deletions": quiet ? 0 : 20 + seed * 4,
        "filesChanged": quiet ? 0 : 2 + seed % 12,
      ])
    }
    let activeDaily = daily.filter { ($0["totalTokens"] as? Int ?? 0) > 0 }
    let summary: [String: Any] = sparse
      ? [
        "totalTokens": activeDaily.reduce(0) { $0 + ($1["totalTokens"] as? Int ?? 0) },
        "chatSessions": activeDaily.reduce(0) { $0 + ($1["sessions"] as? Int ?? 0) },
        "terminalSessions": 0,
        "activeDays": activeDaily.count,
        "totalInteractions": activeDaily.reduce(0) { $0 + ($1["interactions"] as? Int ?? 0) },
      ]
      : [
        "totalTokens": 48_200_000,
        "chatSessions": 212,
        "terminalSessions": 41,
        "activeDays": 57,
        "totalInteractions": 1_930,
      ]
    let payload: [String: Any] = [
      "generatedAt": iso(Date()),
      "summary": summary,
      "clients": sparse
        ? [["client": "desktop", "interactions": 46, "activeDays": activeDaily.count, "sessions": 5]]
        : [
          ["client": "desktop", "interactions": 1_240, "activeDays": 55, "sessions": 180],
          ["client": "mobile", "interactions": 410, "activeDays": 31, "sessions": 52],
          ["client": "cli", "interactions": 280, "activeDays": 18, "sessions": 21],
        ],
      "daily": daily,
    ]
    guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return nil }
    return try? JSONDecoder().decode(MobileAdeUsageStats.self, from: data)
  }
}

/// The Hub composer floating over a list, for `-adePreviewScreen hub-composer`.
struct HubComposerPreviewHost: View {
  @State private var expanded = ProcessInfo.processInfo.arguments.contains("-adePreviewFocusComposer")

  var body: some View {
    NavigationStack {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 10) {
          ForEach(0..<14, id: \.self) { index in
            VStack(alignment: .leading, spacing: 4) {
              Text(["Glass composer", "Usage panel port", "Lane picker bubble", "Hub drawer"][index % 4])
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(ADEColor.textPrimary)
              Text("Claude Opus 5 · \(index + 2)m ago")
                .font(.caption)
                .foregroundStyle(ADEColor.textSecondary)
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(ADEColor.cardBackground, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
          }
        }
        .padding(16)
      }
      .adeScreenBackground()
      .navigationTitle("Hub")
      .safeAreaInset(edge: .bottom, spacing: 0) {
        HubInlineComposer(expanded: $expanded, onCreated: { _ in })
      }
    }
  }
}
#endif

/// A machine's Primary lane, else its first lane.
func workNewChatPrimaryLane(_ lanes: [LaneSummary]) -> LaneSummary? {
  lanes.first { $0.laneType == "primary" }
    ?? lanes.first { $0.name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "primary" }
    ?? lanes.first
}
