import CryptoKit
import Foundation
import SwiftUI
import os

private let workAutoLaneNamingLog = Logger(subsystem: "com.ade.ios", category: "AutoLaneNaming")

struct WorkAutoLaneNameSuggestion {
  let name: String
  let hostApplied: Bool
}

func workAutoLaneTemporaryBranch() -> String {
  let hex = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
  return "ade/\(hex.prefix(8))"
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
              .font(.system(size: 12, weight: isSelected ? .semibold : .regular))
              .foregroundStyle(isSelected ? ADEColor.textPrimary : ADEColor.textSecondary)
              .opacity(0.85)
            Text(mode.title)
              .font(.caption.weight(.semibold))
              .foregroundStyle(isSelected ? ADEColor.textPrimary : ADEColor.textSecondary)
          }
          .padding(.horizontal, 14)
          .padding(.vertical, 8)
          .background {
            if isSelected {
              Capsule(style: .continuous)
                .fill(ADEColor.surfaceBackground.opacity(0.85))
            }
          }
          .overlay {
            if isSelected {
              Capsule(style: .continuous)
                .stroke(ADEColor.glassBorder, lineWidth: 0.5)
            }
          }
          .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(mode.title)
        .accessibilityHint(mode.accessibilityDescription)
        .accessibilityAddTraits(isSelected ? [.isSelected] : [])
      }
    }
    .padding(4)
    .background(ADEColor.recessedBackground.opacity(0.72), in: Capsule(style: .continuous))
    .overlay {
      Capsule(style: .continuous)
        .stroke(ADEColor.glassBorder, lineWidth: 0.5)
    }
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
  let provider = ["claude", "codex", "cursor", "droid", "opencode", "pi"].first {
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

/// Full-screen "Start a new conversation" composer that replaces the modal
/// WorkNewChatSheet. Mirrors the desktop welcome screen: big ADE word-mark,
/// one-line tagline, a minimal workspace pill users can change inline, and a
/// prominent composer anchored at the bottom. Sending fires the host create
/// call and immediately pushes the new session route on top of the current
/// navigation path so the screen flows straight into the live chat instead
/// of bouncing back to the sidebar.
struct WorkNewChatScreen: View {
  @EnvironmentObject var syncService: SyncService
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

  @State private var selectedLaneId: String = ""
  @State private var provider: String = "claude"
  @State private var modelId: String = "claude-sonnet-5"
  @State private var busy: Bool = false
  @State private var errorMessage: String?
  @State private var modelPickerPresented = false
  @State private var runtimeMode: String = "default"
  @State private var reasoningEffort: String = ""
  @State private var codexFastMode: Bool = false
  /// The catalog option the picker handed us, kept so fast-tier support is read
  /// from the live host-advertised model (its `serviceTiers`) rather than
  /// re-derived from the curated iOS catalog — which can miss a freshly
  /// advertised fast model and wrongly hide the toggle.
  @State private var selectedModelOption: WorkModelOption?
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

  init(
    lanes: [LaneSummary],
    preferredLaneId: String?,
    activeProjectId: String?,
    activeProjectRootPath: String?,
    onStarted: @escaping @MainActor (AgentChatSessionSummary, String, Bool, String?, [AgentChatFileRef]) async -> Void,
    onCliStarted: @escaping @MainActor (TerminalSessionSummary) async -> Void,
    onChatImported: @escaping @MainActor (AgentChatSessionSummary) async -> Void = { _ in },
    onRefreshLanes: @escaping @MainActor () async -> Void,
    onLaunchStarted: @escaping @MainActor (ChatLaunchSnapshot) async -> Void = { _ in }
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
      codexFastMode: codexFastMode
    )
  }

  /// Whether the synthetic "Auto-create lane" entry is the current selection.
  private var isAutoCreateLane: Bool {
    selectedLaneId == workAutoCreateLaneSentinelId
  }

  private var defaultNewSessionLane: LaneSummary? {
    if let preferredLaneId, let lane = lanes.first(where: { $0.id == preferredLaneId }) {
      return lane
    }
    return lanes.first { $0.laneType == "primary" }
      ?? lanes.first { $0.name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "primary" }
      ?? lanes.first
  }

  private var selectedConcreteLane: LaneSummary? {
    guard !isAutoCreateLane else { return nil }
    return lanes.first(where: { $0.id == selectedLaneId })
  }

  private var attachmentsAvailable: Bool {
    syncService.supportsViewerRemoteAction("chat.saveTempAttachment")
  }

  private var canUploadAttachments: Bool {
    attachmentsAvailable
      && syncService.connectionState == .connected
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
        laneSelector
          .padding(.horizontal, 20)

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
          .workChatGlass(in: Capsule(style: .continuous))
          .transition(.opacity)
        }

        if let errorMessage {
          Text(errorMessage)
            .font(.caption)
            .foregroundStyle(ADEColor.danger)
            .multilineTextAlignment(.center)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .workChatGlass(in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .padding(.horizontal, 20)
        }

        composerBar
      }
      .padding(.bottom, 4)
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
    .toolbar {
      ToolbarItem(placement: .principal) {
        WorkSessionTypeSwitcher(selection: $sessionMode, onUserSelect: { mode in
          WorkNewSessionModePreferences.save(mode, projectId: activeProjectId)
        })
      }
      ToolbarItem(placement: .topBarTrailing) {
        if busy {
          ProgressView().controlSize(.small)
        }
      }
    }
    .onAppear {
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
      WorkComposerPreferences.save(newValue)
    }
    .sheet(isPresented: $modelPickerPresented) {
      WorkModelPickerSheet(
        currentModelId: modelId,
        currentProvider: provider,
        currentReasoningEffort: reasoningEffort,
        currentCodexFastMode: codexFastMode,
        cursorAvailabilityMode: sessionMode == .cli ? .cli : .chat,
        lanes: lanes,
        isBusy: false,
        onSelect: { option, pickedReasoning, runtimeProvider, pickedFastMode in
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
  }

  @ViewBuilder
  private var brandMark: some View {
    Image("BrandMark")
      .resizable()
      .renderingMode(.original)
      .interpolation(.high)
      .aspectRatio(contentMode: .fit)
      .frame(maxWidth: 240)
    .padding(.top, 0)
    .accessibilityLabel("ADE")
  }

  @ViewBuilder
  private var laneSelector: some View {
    HStack {
      Spacer(minLength: 0)
      WorkLanePickerDropdown(
        lanes: lanes,
        selectedLaneId: $selectedLaneId,
        onMenuPresentationChange: handleLaneSheetPresentation,
        floatingGlass: true
      )
      Spacer(minLength: 0)
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

  /// Shell and Import session, as the thread's glass capsules. Only offered for
  /// a concrete lane — both act on an existing worktree.
  @ViewBuilder
  private var sessionActionChips: some View {
    if let lane = selectedConcreteLane {
      let chipsDisabled = busy || shellLaunchBusy
      let shellQueued = queuedShellLaneIds.contains(lane.id)
      let shellDisabled = chipsDisabled || shellQueued
      GlassEffectContainer(spacing: 8) {
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
              lanes: lanes,
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
  }

  private func glassChip(
    systemImage: String?,
    title: String,
    disabled: Bool,
    showsProgress: Bool = false
  ) -> some View {
    HStack(spacing: 6) {
      if showsProgress {
        ProgressView()
          .controlSize(.mini)
          .tint(ADEColor.accent)
      } else if let systemImage {
        Image(systemName: systemImage)
          .font(.system(size: 12, weight: .semibold))
          .foregroundStyle(disabled ? ADEColor.textMuted : ADEColor.accent)
      }
      Text(title)
        .font(.caption.weight(.semibold))
        .foregroundStyle(disabled ? ADEColor.textMuted : ADEColor.textPrimary)
    }
    .padding(.horizontal, 12)
    .frame(minHeight: workChatComposerChipRowHeight)
    .workChatGlass(in: Capsule(style: .continuous), interactive: !disabled)
    .overlay(
      Capsule(style: .continuous)
        .stroke(ADEColor.accent.opacity(disabled ? 0.08 : 0.22), lineWidth: 0.75)
    )
    .contentShape(Capsule(style: .continuous))
    .opacity(disabled && !showsProgress ? 0.6 : 1)
    .frame(minHeight: 44)
  }

  private func shellSessionAffordance(isBusy: Bool, isQueued: Bool, disabled: Bool) -> some View {
    glassChip(
      systemImage: isQueued ? "clock.badge.checkmark" : "terminal",
      title: isBusy ? "Starting shell" : (isQueued ? "Shell queued" : "Shell"),
      disabled: disabled,
      showsProgress: isBusy
    )
    .accessibilityLabel(isBusy ? "Starting shell" : (isQueued ? "Shell queued" : "Open shell"))
  }

  private func importSessionAffordance(disabled: Bool) -> some View {
    glassChip(systemImage: "square.and.arrow.down", title: "Import session", disabled: disabled)
  }

  @ViewBuilder
  private var composerBar: some View {
    WorkNewChatComposerBar(
      sessionMode: sessionMode,
      provider: $provider,
      modelId: modelId,
      modelName: prettyNewChatModelName(modelId),
      busy: busy,
      canStart: !busy && !shellLaunchBusy && (isAutoCreateLane || !selectedLaneId.isEmpty) && !modelId.isEmpty,
      attachmentsAvailable: attachmentsAvailable,
      canUploadAttachments: canUploadAttachments,
      runtimeMode: $runtimeMode,
      reasoningEffort: $reasoningEffort,
      codexFastMode: $codexFastMode,
      composerFocused: $composerFocused,
      onOpenModelPicker: { modelPickerPresented = true },
      onSubmit: submit(openingMessage:attachments:)
    )
  }

  private func prettyNewChatModelName(_ model: String) -> String {
    let trimmed = model.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return "Model" }
    if let known = workKnownModelDisplayName(trimmed) {
      return known
    }
    let lower = trimmed.lowercased()
    if lower.hasPrefix("claude-") {
      let tail = trimmed.dropFirst("claude-".count)
      let joined = tail.split(separator: "-").map { part -> String in
        let s = String(part)
        if s.range(of: #"^\d+$"#, options: .regularExpression) != nil { return s }
        return s.prefix(1).uppercased() + s.dropFirst()
      }.joined(separator: " ")
      return "Claude " + joined.replacingOccurrences(of: #"(\d+) (\d+)"#, with: "$1.$2", options: .regularExpression)
    }
    return trimmed
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
  private func submit(openingMessage: String, attachments inputAttachments: [WorkChatInputAttachment]) async -> Bool {
    let readyAttachments = workChatInputReadyAttachments(inputAttachments)
    let rawText = openingMessage.trimmingCharacters(in: .whitespacesAndNewlines)
    let opener = workChatOutgoingText(openingMessage, attachmentCount: readyAttachments.count)
    guard !busy && !shellLaunchBusy && (isAutoCreateLane || !selectedLaneId.isEmpty) else { return false }
    guard !opener.isEmpty && !modelId.isEmpty else { return false }
    let availabilityMode: WorkCursorAvailabilityMode = sessionMode == .cli ? .cli : .chat
    guard workModelAllowedForAvailabilityMode(modelId: modelId, provider: provider, mode: availabilityMode) else {
      errorMessage = sessionMode == .cli
        ? "This model is available for chat only. Choose a CLI-capable model."
        : "This model is available for CLI only. Choose a chat-capable model."
      return false
    }
    guard readyAttachments.isEmpty || canUploadAttachments else {
      errorMessage = "Reconnect to attach images."
      return false
    }
    // Anchor the "last time you sent a message" choice — covers the case where
    // the user sent with the restored/default selection without changing it.
    WorkComposerPreferences.save(composerSelection)
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
      piMetadata: piMetadata,
      wire: wire,
      projectId: activeProjectId,
      projectRootPath: activeProjectRootPath,
      originClientId: syncService.pairingDeviceId,
      isAutoCreateLane: isAutoCreateLane,
      isChatSession: sessionMode == .chat,
      cursorCloudMode: false,
      hostCanStartLaunch: syncService.canStartChatLaunch
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
    if isAutoCreateLane {
      withAnimation(.snappy(duration: 0.16)) {
        autoCreateStatus = "Creating lane…"
      }
      do {
        let laneName = autoCreatedLaneName(opener: opener)
        let temporaryBranch = workAutoLaneTemporaryBranch()
        let lane = try await syncService.createLane(
          name: laneName,
          description: opener.isEmpty ? "" : String(opener.prefix(280)),
          branchName: temporaryBranch
        )
        targetLaneId = lane.id
        targetLaneForScope = lane
        createdLaneId = lane.id
        autoCreatedFallbackName = laneName
        autoCreatedTemporaryBranch = temporaryBranch
        await onRefreshLanes()
      } catch {
        ADEHaptics.error()
        errorMessage = error.localizedDescription
        autoCreateStatus = nil
        busy = false
        return false
      }
    } else {
      targetLaneId = selectedLaneId
      targetLaneForScope = lanes.first { $0.id == selectedLaneId }
    }
    let targetScope = targetLaneForScope
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
      if sessionMode == .cli {
        let cliProvider = workResolveCliProvider(for: modelId, provider: provider)
        let cliReasoningEffort = workCliSupportsReasoningSelection(provider: cliProvider) && !normalizedReasoning.isEmpty
          ? normalizedReasoning
          : nil
        let result = try await syncService.startCliSession(
          laneId: targetLaneId,
          provider: cliProvider,
          permissionMode: workCliPermissionMode(provider: cliProvider, runtimeMode: runtimeMode),
          title: workCliInitialSessionTitle(provider: cliProvider, opener: opener),
          initialInput: workCliInitialInput(text: rawText, attachments: attachmentRefs),
          modelId: modelId,
          reasoningEffort: cliReasoningEffort,
          fastMode: fastModeSupported ? codexFastMode : nil,
          cols: 48,
          rows: 24
        )
        if let session = result.session {
          await onCliStarted(session)
        } else {
          let lane = lanes.first(where: { $0.id == targetLaneId })
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
        cursorModeId: wire.cursorModeId,
        targetProjectId: targetScope.projectId,
        targetProjectRootPath: targetScope.projectRootPath,
        pendingDisplayName: opener
      )
      createdChatSummary = summary
      createdChatAttachments = attachmentRefs
      if attachmentRefs.isEmpty {
        await onStarted(summary, opener, false, nil, [])
      } else {
        let delivery = try await syncService.sendChatMessage(
          sessionId: summary.sessionId,
          text: opener,
          attachments: attachmentRefs,
          targetProjectId: targetScope.projectId,
          targetProjectRootPath: targetScope.projectRootPath
        )
        let deliveryState: String?
        switch delivery {
        case .queued:
          deliveryState = "queued"
        case .sent, .dropped:
          // `.dropped` (queue_full) is steer-only; a new chat's opener goes
          // through sendChatMessage, so it is unreachable here. Fold it into the
          // delivered path to keep the switch exhaustive.
          deliveryState = nil
        }
        await onStarted(summary, opener, true, deliveryState, attachmentRefs)
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
  return family == "claude" || family == "codex" || family == "droid" || family == "pi"
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
  case "droid": return "droid"
  case "qwen": return "qwen"
  case "kimi": return "kimi"
  case "grok": return "grok"
  case "copilot": return "copilot"
  case "shell": return "shell"
  default: return "opencode"
  }
}

private struct WorkNewChatComposerBar: View {
  let sessionMode: WorkNewSessionMode
  @Binding var provider: String
  let modelId: String
  let modelName: String
  let busy: Bool
  let canStart: Bool
  let attachmentsAvailable: Bool
  let canUploadAttachments: Bool
  @Binding var runtimeMode: String
  @Binding var reasoningEffort: String
  @Binding var codexFastMode: Bool
  /// Owned by the screen so the lane sheet can park and restore keyboard focus.
  @Binding var composerFocused: Bool
  let onOpenModelPicker: () -> Void
  let onSubmit: @MainActor (String, [WorkChatInputAttachment]) async -> Bool

  @EnvironmentObject private var syncService: SyncService
  @State private var draft: String = ""
  @State private var attachments: [WorkChatInputAttachment] = []
  @State private var presentedPicker: WorkComposerPicker?
  /// Live viewport width of the controls scroll area, so the access control
  /// collapses to the in-session composer's dot-Menu at the same threshold.
  @State private var controlsWidth: CGFloat = 0
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

  private var isControlsCollapsed: Bool {
    controlsWidth > 0 && controlsWidth <= workComposerControlsCollapseThreshold
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
          stashAvailable: syncService.canInvokeRemoteAction("chat.listPromptStashes"),
          scope: WorkPromptStashScope(),
          provider: provider,
          modelId: modelId,
          extraMenuContent: AnyView(sessionSettingsMenu)
        )
      },
      controls: {
        ScrollView(.horizontal, showsIndicators: false) {
          WorkComposerControlsRow(
            provider: provider,
            modelDisplayName: modelName,
            reasoningEffort: reasoningEffort,
            currentMode: runtimeMode,
            modeOptions: runtimeOptions,
            modeLabel: workRuntimeModeLabel(provider: provider, mode: runtimeMode),
            isCollapsed: isControlsCollapsed,
            fastModeEnabled: codexFastMode,
            onOpenModelPicker: onOpenModelPicker,
            onSelectMode: { runtimeMode = $0 }
          )
          .padding(.trailing, 4)
        }
        .onGeometryChange(for: CGFloat.self) { proxy in
          proxy.size.width
        } action: { width in
          controlsWidth = width
        }
      }
    )
    .padding(.horizontal, 16)
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

  /// Model and access in the ⋯ menu too, like the chat's folded composer:
  /// the controls row that normally shows them is hidden while folded.
  @ViewBuilder
  private var sessionSettingsMenu: some View {
    Section {
      Button {
        onOpenModelPicker()
      } label: {
        Label("Model · \(modelName)", systemImage: "cpu")
      }
      if runtimeOptions.count > 1 {
        Picker(selection: Binding(get: { runtimeMode }, set: { runtimeMode = $0 })) {
          ForEach(runtimeOptions, id: \.id) { option in
            Text(option.title).tag(option.id)
          }
        } label: {
          Label("Access · \(workRuntimeModeLabel(provider: provider, mode: runtimeMode))", systemImage: "lock.shield")
        }
        .pickerStyle(.menu)
      }
    }
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

struct WorkNewChatRoute: Hashable {
  let preferredLaneId: String?
}

#if DEBUG
/// Fixture render of the real New Chat page — two lanes, Claude + Codex limits
/// across several accounts, and a month of activity — so a simulator can
/// screenshot it with no pairing. Reached with `-adePreviewScreen new-chat`.
/// `-adePreviewFocusComposer` opens it with the composer expanded.
struct WorkNewChatPreviewHost: View {
  @EnvironmentObject private var syncService: SyncService

  init() {
    MobileUsageQuotaStore.shared.pinPreviewSnapshot(WorkNewChatPreviewFixtures.quotaSnapshot())
    WorkUsageActivityCarousel.previewStats = WorkNewChatPreviewFixtures.stats()
  }

  var body: some View {
    NavigationStack {
      WorkNewChatScreen(
        lanes: WorkNewChatPreviewFixtures.lanes,
        preferredLaneId: WorkNewChatPreviewFixtures.lanes.first?.id,
        activeProjectId: "preview-project",
        activeProjectRootPath: "/Users/preview/Projects/ADE",
        onStarted: { _, _, _, _, _ in },
        onCliStarted: { _ in },
        onRefreshLanes: {}
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
      parentLaneId: nil,
      childCount: 0,
      stackDepth: 0,
      parentStatus: nil,
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

  static func stats() -> MobileAdeUsageStats? {
    let calendar = Calendar(identifier: .gregorian)
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.dateFormat = "yyyy-MM-dd"
    var daily: [[String: Any]] = []
    for offset in stride(from: 69, through: 0, by: -1) {
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
    let payload: [String: Any] = [
      "generatedAt": iso(Date()),
      "summary": [
        "totalTokens": 48_200_000,
        "chatSessions": 212,
        "terminalSessions": 41,
        "activeDays": 57,
        "totalInteractions": 1_930,
      ],
      "clients": [
        ["client": "desktop", "interactions": 1_240, "activeDays": 55, "sessions": 180],
        ["client": "mobile", "interactions": 410, "activeDays": 31, "sessions": 52],
        ["client": "tui", "interactions": 280, "activeDays": 18, "sessions": 21],
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
