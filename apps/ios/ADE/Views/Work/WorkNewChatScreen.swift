import SwiftUI
import os

private let workAutoLaneNamingLog = Logger(subsystem: "com.ade.ios", category: "AutoLaneNaming")

@MainActor
protocol WorkAutoLaneNamingClient: AnyObject {
  func supportsRemoteAction(_ action: String) -> Bool

  func suggestLaneName(
    laneId: String,
    prompt: String,
    modelId: String,
    fallbackName: String,
    targetProjectId: String?,
    targetProjectRootPath: String?
  ) async throws -> String

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

@discardableResult
@MainActor
func workRunAutoLaneAiRename(
  laneId: String,
  opener: String,
  fallbackName: String,
  modelId: String,
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
      let suggested = try await syncService.suggestLaneName(
        laneId: laneId,
        prompt: opener,
        modelId: trimmedModelId,
        fallbackName: fallbackName,
        targetProjectId: targetProjectId,
        targetProjectRootPath: targetProjectRootPath
      ).trimmingCharacters(in: .whitespacesAndNewlines)

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
      if attempt < attempts {
        workAutoLaneNamingLog.warning(
          "auto_lane_naming_suggest_retrying surface=\(surface.rawValue, privacy: .public) lane=\(laneId, privacy: .public) attempt=\(attempt, privacy: .public) error=\(message, privacy: .public)"
        )
        if retryDelayNanoseconds > 0 {
          try? await Task.sleep(nanoseconds: retryDelayNanoseconds)
        }
        continue
      }
      workAutoLaneNamingLog.error(
        "auto_lane_naming_suggest_failed surface=\(surface.rawValue, privacy: .public) lane=\(laneId, privacy: .public) attempts=\(attempts, privacy: .public) error=\(message, privacy: .public)"
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
    return workGenericLaneFallback(genericSuffix: genericSuffix)
  }
  let priorityWords = workPriorityLaneNamingWords(cleanedPrompt: collapsed)
  if !priorityWords.isEmpty {
    return priorityWords.joined(separator: "-")
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
    return String(slug.prefix(48))
  }
  return workGenericLaneFallback(genericSuffix: genericSuffix)
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
  let provider = ["claude", "codex", "cursor", "droid", "opencode"].first {
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
  let onStarted: @MainActor (AgentChatSessionSummary, String) async -> Void
  let onCliStarted: @MainActor (TerminalSessionSummary) async -> Void
  let onChatImported: @MainActor (String) async -> Void
  let onRefreshLanes: @MainActor () async -> Void

  @State private var selectedLaneId: String = ""
  @State private var provider: String = "claude"
  @State private var modelId: String = "claude-sonnet-4-6"
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
  /// Status banner shown above the composer while an auto-created lane is being
  /// minted before the chat/CLI session starts.
  @State private var autoCreateStatus: String?

  init(
    lanes: [LaneSummary],
    preferredLaneId: String?,
    activeProjectId: String?,
    onStarted: @escaping @MainActor (AgentChatSessionSummary, String) async -> Void,
    onCliStarted: @escaping @MainActor (TerminalSessionSummary) async -> Void,
    onChatImported: @escaping @MainActor (String) async -> Void = { _ in },
    onRefreshLanes: @escaping @MainActor () async -> Void
  ) {
    self.lanes = lanes
    self.preferredLaneId = preferredLaneId
    self.activeProjectId = activeProjectId
    self.onStarted = onStarted
    self.onCliStarted = onCliStarted
    self.onChatImported = onChatImported
    self.onRefreshLanes = onRefreshLanes
    // Restore the last-used model + access mode so a fresh New Chat screen opens
    // on the user's most recent choices. Seeding the @State initial values here
    // (rather than assigning in onAppear) avoids the provider/model onChange
    // handlers firing and resetting runtimeMode back to the provider default.
    var restoredProvider = "claude"
    var restoredModelId = "claude-sonnet-4-6"
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

  /// Fast mode only applies to in-app chat sessions on fast-tier models — the
  /// CLI launcher has no fast-mode parameter — so the lightning toggle (and the
  /// value we send) is gated on both. The picker's option can only *add* support
  /// (a live host-advertised fast tier the curated catalog may miss); it never
  /// suppresses the catalog/allow-list fallback, so a known-fast model whose
  /// option ships empty `serviceTiers` still shows the toggle.
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
    VStack(spacing: 0) {
      Spacer(minLength: 24)

      ScrollView {
        VStack(spacing: 18) {
          brandMark
          VStack(spacing: 6) {
            Text("Start a new conversation")
              .font(.title3.weight(.semibold))
              .foregroundStyle(ADEColor.textPrimary)
            Text("Ask ADE anything — refactor code, debug issues, or explore ideas.")
              .font(.footnote)
              .foregroundStyle(ADEColor.textSecondary)
              .multilineTextAlignment(.center)
              .padding(.horizontal, 24)
          }

          laneSelector
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 16)
      }
      .scrollBounceBehavior(.basedOnSize)
      .scrollDismissesKeyboard(.interactively)

      if let autoCreateStatus, busy {
        HStack(spacing: 8) {
          ProgressView().controlSize(.mini)
          Text(autoCreateStatus)
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
            .lineLimit(1)
          Spacer(minLength: 0)
        }
        .padding(.horizontal, 20)
        .padding(.bottom, 6)
        .transition(.opacity)
      }

      if let errorMessage {
        Text(errorMessage)
          .font(.caption)
          .foregroundStyle(ADEColor.danger)
          .padding(.horizontal, 20)
          .padding(.bottom, 6)
      }

      sessionActionChips

      composerBar
    }
    .adeScreenBackground()
    .adeNavigationGlass()
    .navigationTitle("")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar(.hidden, for: .tabBar)
    .adeRootTabBarHidden()
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
      // A restored selection (see init) can carry a model only valid in the mode
      // it was last used in — e.g. a CLI-only Cursor model. normalizeSelection
      // only runs on a sessionMode *change*, which never fires for the seeded
      // initial state, so a model disallowed for the (possibly restored) mode
      // would otherwise reach Send. Normalize here, but only when the model is
      // actually disallowed, so a valid restored selection keeps its runtimeMode.
      let availabilityMode: WorkCursorAvailabilityMode = sessionMode == .cli ? .cli : .chat
      if !workModelAllowedForAvailabilityMode(modelId: modelId, provider: provider, mode: availabilityMode) {
        normalizeSelection(for: sessionMode)
      }
      if selectedLaneId.isEmpty {
        selectedLaneId = defaultNewSessionLane?.id ?? ""
      }
      if runtimeMode.isEmpty {
        runtimeMode = workDefaultRuntimeMode(provider: provider)
      }
    }
    .onChange(of: provider) { _, newProvider in
      runtimeMode = workDefaultRuntimeMode(provider: newProvider)
      if !workNewChatModel(modelId, belongsTo: workNormalizedNewChatProvider(newProvider)) {
        modelId = workDefaultNewChatModelId(provider: newProvider)
      }
      if !modelSupportsReasoning(modelId: modelId, provider: newProvider) {
        reasoningEffort = ""
      }
      if !fastModeSupported {
        codexFastMode = false
      }
    }
    .onChange(of: sessionMode) { _, newMode in
      normalizeSelection(for: newMode)
    }
    .onChange(of: modelId) { _, newModel in
      if !modelSupportsReasoning(modelId: newModel, provider: provider) {
        reasoningEffort = ""
      }
      if !fastModeSupported {
        codexFastMode = false
      }
    }
    .onChange(of: composerSelection) { _, newValue in
      // Persist every model / access-mode change so the next New Chat restores
      // it. Captures the full tuple atomically — a single field change here
      // already reflects any cascading provider/model normalization above.
      WorkComposerPreferences.save(newValue)
    }
    .sheet(isPresented: $modelPickerPresented) {
      WorkModelPickerSheet(
        currentModelId: modelId,
        currentProvider: provider,
        currentReasoningEffort: reasoningEffort,
        cursorAvailabilityMode: sessionMode == .cli ? .cli : .chat,
        isBusy: false,
        onSelect: { option, pickedReasoning, runtimeProvider in
          selectedModelOption = option
          modelId = option.id
          provider = sessionMode == .chat
            ? workNormalizedNewChatProvider(runtimeProvider)
            : workResolveCliProvider(for: option.id, provider: runtimeProvider)
          reasoningEffort = pickedReasoning ?? ""
          runtimeMode = workDefaultRuntimeMode(provider: provider)
          modelPickerPresented = false
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
      .frame(maxWidth: 260)
      .shadow(color: ADEColor.purpleAccent.opacity(0.45), radius: 22)
    .padding(.top, 8)
    .accessibilityLabel("ADE")
  }

  @ViewBuilder
  private var laneSelector: some View {
    HStack {
      Spacer(minLength: 0)
      WorkLanePickerDropdown(
        lanes: lanes,
        selectedLaneId: $selectedLaneId
      )
      Spacer(minLength: 0)
    }
  }

  // Sits just above the composer, like the context chips in a chat.
  @ViewBuilder
  private var sessionActionChips: some View {
    if let lane = selectedConcreteLane {
      let chipsDisabled = busy || shellLaunchBusy
      HStack(spacing: 8) {
        Spacer(minLength: 0)
        Button {
          Task { await launchShell(in: lane) }
        } label: {
          shellSessionAffordance(isBusy: shellLaunchBusy, disabled: chipsDisabled)
        }
        .buttonStyle(.plain)
        .disabled(chipsDisabled)

        NavigationLink {
          WorkImportSessionScreen(
            lane: lane,
            onCliImported: onCliStarted,
            onChatImported: onChatImported
          )
          .environmentObject(syncService)
        } label: {
          importSessionAffordance(disabled: chipsDisabled)
        }
        .buttonStyle(.plain)
        .disabled(chipsDisabled)
        Spacer(minLength: 0)
      }
      .padding(.horizontal, 20)
      .padding(.bottom, 8)
    }
  }

  private func shellSessionAffordance(isBusy: Bool, disabled: Bool) -> some View {
    HStack(spacing: 6) {
      if isBusy {
        ProgressView()
          .controlSize(.mini)
          .tint(ADEColor.accent)
      } else {
        Image(systemName: "terminal")
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(disabled ? ADEColor.textMuted : ADEColor.accent)
      }
      Text(isBusy ? "Starting shell" : "Shell")
        .font(.subheadline.weight(.medium))
        .foregroundStyle(disabled ? ADEColor.textMuted : ADEColor.textPrimary)
    }
    .padding(.horizontal, 14)
    .frame(height: 34)
    .background(ADEColor.surfaceBackground.opacity(disabled ? 0.36 : 0.7), in: Capsule(style: .continuous))
    .overlay { Capsule(style: .continuous).stroke(ADEColor.glassBorder.opacity(disabled ? 0.5 : 1), lineWidth: 0.6) }
    .opacity(disabled && !isBusy ? 0.5 : 1)
    .accessibilityLabel(isBusy ? "Starting shell" : "Open shell")
  }

  private func importSessionAffordance(disabled: Bool) -> some View {
    HStack(spacing: 6) {
      Image(systemName: "square.and.arrow.down")
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(disabled ? ADEColor.textMuted : ADEColor.accent)
      Text("Import session")
        .font(.subheadline.weight(.medium))
        .foregroundStyle(disabled ? ADEColor.textMuted : ADEColor.textPrimary)
    }
    .padding(.horizontal, 14)
    .frame(height: 34)
    .background(ADEColor.surfaceBackground.opacity(disabled ? 0.36 : 0.7), in: Capsule(style: .continuous))
    .overlay { Capsule(style: .continuous).stroke(ADEColor.glassBorder.opacity(disabled ? 0.5 : 1), lineWidth: 0.6) }
    .opacity(disabled ? 0.5 : 1)
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
      runtimeMode: $runtimeMode,
      reasoningEffort: $reasoningEffort,
      fastModeSupported: fastModeSupported,
      codexFastMode: $codexFastMode,
      onOpenModelPicker: { modelPickerPresented = true },
      onSubmit: submit(openingMessage:)
    )
  }

  private func prettyNewChatModelName(_ model: String) -> String {
    let trimmed = model.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return "Model" }
    if let known = workKnownModelDisplayName(trimmed) {
      return known
    }
    let lower = trimmed.lowercased()
    switch lower {
    case "opus": return "Claude Opus 4.7"
    case "opus[1m]", "opus-1m": return "Claude Opus 4.7 1M"
    case "sonnet": return "Claude Sonnet 4.6"
    case "haiku": return "Claude Haiku 4.5"
    default: break
    }
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
      let result = try await syncService.startShellSession(laneId: lane.id)
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
    } catch let queuedError as QueuedRemoteCommandError {
      ADEHaptics.medium()
      errorMessage = queuedError.errorDescription
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  private func submit(openingMessage: String) async -> Bool {
    let opener = openingMessage.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !busy && !shellLaunchBusy && (isAutoCreateLane || !selectedLaneId.isEmpty) else { return false }
    guard !opener.isEmpty && !modelId.isEmpty else { return false }
    // Anchor the "last time you sent a message" choice — covers the case where
    // the user sent with the restored/default selection without changing it.
    WorkComposerPreferences.save(composerSelection)
    busy = true
    errorMessage = nil
    let wire = workRuntimeWireFields(provider: provider, mode: runtimeMode)
    let normalizedReasoning = reasoningEffort.trimmingCharacters(in: .whitespacesAndNewlines)

    // Resolve the target lane. When auto-create is selected we mint a fresh
    // lane first; on failure we surface the error and never create the session.
    // Track whether we created the lane so we can clean it up if the session
    // launch fails immediately afterwards (desktop parity).
    let targetLaneId: String
    var createdLaneId: String?
    var autoCreatedFallbackName: String?
    if isAutoCreateLane {
      withAnimation(.snappy(duration: 0.16)) {
        autoCreateStatus = "Creating lane…"
      }
      do {
        let laneName = autoCreatedLaneName(opener: opener)
        let lane = try await syncService.createLane(
          name: laneName,
          description: opener.isEmpty ? "" : String(opener.prefix(280))
        )
        targetLaneId = lane.id
        createdLaneId = lane.id
        autoCreatedFallbackName = laneName
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
    }

    // Lane is ready; the naming/creating banner is done — the composer + nav
    // spinner carry the remaining "starting session" state.
    autoCreateStatus = nil

    do {
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
          initialInput: opener,
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
          startBackgroundLaneNaming(laneId: createdLaneId, opener: opener, fallbackName: autoCreatedFallbackName)
        }
        busy = false
        return true
      }
      let summary = try await syncService.createChatSession(
        laneId: targetLaneId,
        provider: provider,
        model: modelId,
        reasoningEffort: normalizedReasoning.isEmpty ? nil : normalizedReasoning,
        // Send an explicit true/false when the model supports fast mode so the
        // user's choice (including an explicit OFF) is honored rather than
        // falling back to the host default; nil only when fast mode is N/A.
        codexFastMode: fastModeSupported ? codexFastMode : nil,
        permissionMode: wire.permissionMode,
        interactionMode: wire.interactionMode,
        claudePermissionMode: wire.claudePermissionMode,
        codexApprovalPolicy: wire.codexApprovalPolicy,
        codexSandbox: wire.codexSandbox,
        codexConfigSource: wire.codexConfigSource,
        opencodePermissionMode: wire.opencodePermissionMode,
        droidPermissionMode: wire.droidPermissionMode,
        cursorModeId: wire.cursorModeId,
        pendingDisplayName: opener
      )
      await onStarted(summary, opener)
      if let createdLaneId, let autoCreatedFallbackName {
        startBackgroundLaneNaming(laneId: createdLaneId, opener: opener, fallbackName: autoCreatedFallbackName)
      }
      busy = false
      return true
    } catch is QueuedRemoteCommandError {
      // Offline: the create was queued and a "Pending sync" row now stands in
      // for it on the Work list. Dismiss cleanly — not an error — and keep the
      // (existing) lane; the queued command drains on reconnect.
      ADEHaptics.medium()
      busy = false
      return true
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
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
  private func startBackgroundLaneNaming(laneId: String, opener: String, fallbackName: String) {
    let syncService = syncService
    let modelId = modelId
    let onRefreshLanes = onRefreshLanes
    Task {
      await workRunAutoLaneAiRename(
        laneId: laneId,
        opener: opener,
        fallbackName: fallbackName,
        modelId: modelId,
        syncService: syncService,
        surface: .workNewChat,
        refreshLanes: onRefreshLanes
      )
    }
  }

  private func normalizeSelection(for mode: WorkNewSessionMode) {
    let availabilityMode: WorkCursorAvailabilityMode = mode == .cli ? .cli : .chat
    if !workModelAllowedForAvailabilityMode(modelId: modelId, provider: provider, mode: availabilityMode),
       let replacement = workDefaultModelIdForAvailabilityMode(preferredProvider: provider, mode: availabilityMode) {
      modelId = replacement.modelId
      provider = mode == .chat
        ? workNormalizedNewChatProvider(replacement.provider)
        : workResolveCliProvider(for: replacement.modelId, provider: replacement.provider)
    } else if mode == .chat {
      provider = workNormalizedNewChatProvider(provider)
      if !workNewChatModel(modelId, belongsTo: provider) {
        modelId = workDefaultNewChatModelId(provider: provider)
      }
    } else {
      provider = workResolveCliProvider(for: modelId, provider: provider)
    }
    runtimeMode = workDefaultRuntimeMode(provider: provider)
    if !modelSupportsReasoning(modelId: modelId, provider: provider) {
      reasoningEffort = ""
    }
    if !fastModeSupported {
      codexFastMode = false
    }
  }
}

private func workNormalizedNewChatProvider(_ provider: String) -> String {
  let family = providerFamilyKey(provider)
  // Droid (Factory) is a first-class in-app chat runtime, and its Droid Core
  // models (GLM / Kimi / MiniMax) only run under the droid provider — desktop
  // and the TUI already derive provider from the model's family. Without droid
  // in this allowlist, picking a Droid Core model silently collapsed the
  // provider to "claude", sending a GLM model id to the Claude runtime.
  return ["claude", "codex", "cursor", "opencode", "droid"].contains(family) ? family : "claude"
}

private func workNewChatModel(_ modelId: String, belongsTo provider: String) -> Bool {
  let trimmed = modelId.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !trimmed.isEmpty else { return false }
  return workModelCatalogGroupKey(for: trimmed, currentProvider: provider) == provider
}

private func workDefaultNewChatModelId(provider: String) -> String {
  let family = providerFamilyKey(provider)
  if let defaultModel = workDefaultCatalogModelId(provider: family) {
    return defaultModel
  }
  switch workNormalizedNewChatProvider(provider) {
  case "codex": return workDefaultCatalogModelId(provider: "codex") ?? "gpt-5.5"
  case "cursor": return "auto"
  case "opencode": return "opencode/anthropic/claude-sonnet-4-6"
  default: return "claude-sonnet-4-6"
  }
}

private func workCliSupportsReasoningSelection(provider: String) -> Bool {
  let family = providerFamilyKey(provider)
  return family == "claude" || family == "codex" || family == "droid"
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
  case "droid": return "droid"
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
  @Binding var runtimeMode: String
  @Binding var reasoningEffort: String
  let fastModeSupported: Bool
  @Binding var codexFastMode: Bool
  let onOpenModelPicker: () -> Void
  let onSubmit: @MainActor (String) async -> Bool

  @State private var draft: String = ""
  @FocusState private var composerFocused: Bool
  @StateObject private var dictationCoordinator = DictationInsertionCoordinator()
  @State private var isDictating = false
  /// Live viewport width of the controls scroll area, so the access control
  /// collapses to the in-session composer's dot-Menu at the same threshold.
  @State private var controlsWidth: CGFloat = 0
  private let dictationTargetId = "work-new-chat-screen"

  private var trimmedDraft: String {
    draft.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private var canSend: Bool {
    canStart && !trimmedDraft.isEmpty
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
    let text = trimmedDraft
    draft = ""
    Task {
      let started = await onSubmit(text)
      if !started {
        draft = text
      }
    }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      TextField(placeholder, text: $draft, axis: .vertical)
        .textFieldStyle(.plain)
        .lineLimit(1...6)
        .font(.body)
        .foregroundStyle(ADEColor.textPrimary)
        .tint(ADEColor.accent)
        .autocorrectionDisabled(false)
        .textInputAutocapitalization(.sentences)
        .focused($composerFocused)
        .frame(maxWidth: .infinity, minHeight: 28, alignment: .leading)

      HStack(alignment: .center, spacing: 8) {
        if !isDictating {
          ScrollView(.horizontal, showsIndicators: false) {
            WorkComposerControlsRow(
              provider: provider,
              modelDisplayName: modelName,
              reasoningEffort: reasoningEffort,
              currentMode: runtimeMode,
              modeOptions: runtimeOptions,
              modeLabel: workRuntimeModeLabel(provider: provider, mode: runtimeMode),
              isCollapsed: isControlsCollapsed,
              fastModeSupported: fastModeSupported,
              fastModeEnabled: codexFastMode,
              settingsMutationInFlight: busy,
              onOpenModelPicker: onOpenModelPicker,
              onSelectMode: { runtimeMode = $0 },
              onToggleFastMode: { codexFastMode = $0 }
            )
            .padding(.trailing, 4)
          }
          .background(
            GeometryReader { proxy in
              Color.clear
                .onAppear { controlsWidth = proxy.size.width }
                .onChange(of: proxy.size.width) { _, newValue in
                  controlsWidth = newValue
                }
            }
          )

          DictationRawUndoChip(coordinator: dictationCoordinator, draft: $draft)
        }

        DictationMicButton(
          draft: $draft,
          coordinator: dictationCoordinator,
          targetId: dictationTargetId,
          onRecordingChange: { isDictating = $0 }
        )
        .frame(maxWidth: isDictating ? .infinity : nil)

        if !isDictating {
          foregroundSendButton
        }
      }
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 14)
    .background(
      RoundedRectangle(cornerRadius: 24, style: .continuous)
        .fill(ADEColor.composerBackground)
    )
    .glassEffect(in: .rect(cornerRadius: 24))
    .overlay(
      RoundedRectangle(cornerRadius: 24, style: .continuous)
        .fill(
          LinearGradient(
            colors: [Color.white.opacity(0.10), .clear],
            startPoint: .top,
            endPoint: .bottom
          )
        )
        .allowsHitTesting(false)
    )
    .overlay(
      RoundedRectangle(cornerRadius: 24, style: .continuous)
        .stroke(ADEColor.glassBorder, lineWidth: 1)
    )
    .shadow(color: Color.black.opacity(0.32), radius: 14, y: 6)
    .padding(.horizontal, 16)
    .padding(.bottom, 0)
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
