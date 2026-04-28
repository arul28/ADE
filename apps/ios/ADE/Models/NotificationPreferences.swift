import Foundation

/// Per-session overrides let users silence a single session or restrict it to
/// awaiting-input alerts only, without touching global category toggles.
public struct SessionNotificationOverride: Codable, Equatable, Hashable {
  public var muted: Bool
  public var awaitingInputOnly: Bool

  public init(muted: Bool = false, awaitingInputOnly: Bool = false) {
    self.muted = muted
    self.awaitingInputOnly = awaitingInputOnly
  }
}

/// User-controlled toggles for the four notification category families plus
/// per-session overrides and an optional quiet-hours window. Persisted as JSON
/// in the App Group `UserDefaults` so the desktop host can read + respect the
/// same settings via the sync channel.
public struct NotificationPreferences: Codable, Equatable, Hashable {
  // Chat
  public var chatAwaitingInput: Bool = true
  public var chatFailed: Bool = true
  public var chatTurnCompleted: Bool = false

  // CTO & sub-agents
  public var ctoSubagentStarted: Bool = false
  public var ctoSubagentFinished: Bool = true
  public var ctoMissionPhase: Bool = true

  // PRs & CI
  public var prCiFailing: Bool = true
  public var prReviewRequested: Bool = true
  public var prChangesRequested: Bool = true
  public var prMergeReady: Bool = true

  // System & health
  public var systemProviderOutage: Bool = true
  public var systemAuthRateLimit: Bool = true
  public var systemHookFailure: Bool = false

  // Quiet hours (time-of-day only; year/month/day components are ignored).
  public var quietHoursStart: Date? = nil
  public var quietHoursEnd: Date? = nil

  // Per-session overrides keyed by sessionId.
  public var perSessionOverrides: [String: SessionNotificationOverride] = [:]

  public init() {}

  /// UserDefaults key under which the JSON-encoded blob is stored.
  public static let defaultKey = "ade.notifications.prefs"

  /// Count of enabled category toggles — used by the Settings row subtitle.
  public var enabledCategoryCount: Int {
    var n = 0
    if chatAwaitingInput { n += 1 }
    if chatFailed { n += 1 }
    if chatTurnCompleted { n += 1 }
    if ctoSubagentStarted { n += 1 }
    if ctoSubagentFinished { n += 1 }
    if ctoMissionPhase { n += 1 }
    if prCiFailing { n += 1 }
    if prReviewRequested { n += 1 }
    if prChangesRequested { n += 1 }
    if prMergeReady { n += 1 }
    if systemProviderOutage { n += 1 }
    if systemAuthRateLimit { n += 1 }
    if systemHookFailure { n += 1 }
    return n
  }

  /// Total category toggle count (excluding per-session overrides / quiet
  /// hours) — useful for "N of M" style UI.
  public static let totalCategoryCount = 13
}

public extension NotificationPreferences {
  /// Decodes stored preferences. Returns a default-initialised struct when no
  /// blob exists yet or decoding fails — this keeps the Settings screen usable
  /// on first launch.
  static func load(from defaults: UserDefaults) -> NotificationPreferences {
    guard let data = defaults.data(forKey: defaultKey) else {
      return NotificationPreferences()
    }
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    if let decoded = try? decoder.decode(NotificationPreferences.self, from: data) {
      return decoded
    }
    return NotificationPreferences()
  }

  /// Encodes + persists. Silently no-ops on encode failure so UI code doesn't
  /// need error handling for the common case.
  func save(to defaults: UserDefaults) {
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .iso8601
    guard let data = try? encoder.encode(self) else { return }
    defaults.set(data, forKey: NotificationPreferences.defaultKey)
  }
}
