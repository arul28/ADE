import Foundation
import SwiftUI

enum ADEAnalyticsEventName: String, CaseIterable {
  case appOpened = "ade_mobile_app_opened"
  case screenViewed = "ade_mobile_screen_viewed"
  case featureUsed = "ade_mobile_feature_used"
  case error = "ade_mobile_error"
  case analyticsBudget = "ade_mobile_analytics_budget"
}

enum ADEAnalyticsAppEntryPoint: String, CaseIterable {
  case coldStart = "cold_start"
  case foreground = "foreground"
}

enum ADEAnalyticsScreen: String, CaseIterable {
  case hub
  case work
  case lanes
  case pullRequests = "pull_requests"
  case files
  case cto
  case settings
  case attentionDrawer = "attention_drawer"
  case linear
  case workSession = "work_session"
  case workNewChat = "work_new_chat"
  case laneDetail = "lane_detail"
  case fileDetail = "file_detail"
  case fileSearch = "file_search"
  case pullRequestDetail = "pull_request_detail"
  case pullRequestCreate = "pull_request_create"
  case ctoSettings = "cto_settings"
  case terminal
  case personalChats = "personal_chats"
}

enum ADEAnalyticsFeature: String, CaseIterable {
  case deepLink = "deep_link"
  case pairing
  case pushNotification = "push_notification"
  case pushAction = "push_action"
  case voiceDictation = "voice_dictation"
  case appClipHandoff = "app_clip_handoff"
}

enum ADEAnalyticsOutcome: String, CaseIterable {
  case opened
  case started
  case completed
  case cancelled
  case failed = "failure"
  case approved
  case denied
}

enum ADEAnalyticsSource: String, CaseIterable {
  case pairingLink = "pairing_link"
  case sessionLink = "session_link"
  case pullRequestLink = "pull_request_link"
  case linearIssueLink = "linear_issue_link"
  case sendToMacLink = "send_to_mac_link"
  case notification
  case notificationApprove = "notification_approve"
  case notificationDeny = "notification_deny"
  case composer
  case globalPill = "global_pill"
  case appClip = "app_clip"
}

enum ADEAnalyticsErrorCategory: String, CaseIterable {
  case pairing
  case pushRegistration = "push_registration"
  case voiceDictation = "voice_dictation"
}

protocol ProductAnalyticsSink: AnyObject {
  var isConfigured: Bool { get }
  var canCapture: Bool { get }
  func capture(event: String, properties: [String: Any])
  func setEnabled(_ enabled: Bool)
  func flush()
}

protocol ProductAnalyticsHTTPTransport: AnyObject {
  func send(_ request: URLRequest)
  func cancelAll()
}

/// A one-shot HTTPS transport. It deliberately has no persistent queue,
/// background session, cookies, URL cache, credential store, redirects, or
/// retry loop. Every accepted product event maps to at most one data task.
final class DirectProductAnalyticsHTTPTransport: ProductAnalyticsHTTPTransport {
  private final class NoRedirectDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(
      _ session: URLSession,
      task: URLSessionTask,
      willPerformHTTPRedirection response: HTTPURLResponse,
      newRequest request: URLRequest,
      completionHandler: @escaping (URLRequest?) -> Void
    ) {
      completionHandler(nil)
    }
  }

  private let lock = NSLock()
  private var session: URLSession?

  init(configuration: URLSessionConfiguration = DirectProductAnalyticsHTTPTransport.makeSessionConfiguration()) {
    session = URLSession(
      configuration: configuration,
      delegate: NoRedirectDelegate(),
      delegateQueue: nil
    )
  }

  func send(_ request: URLRequest) {
    lock.withLock {
      guard let session else { return }
      session.dataTask(with: request).resume()
    }
  }

  func cancelAll() {
    let activeSession = lock.withLock {
      let activeSession = session
      session = nil
      return activeSession
    }
    activeSession?.invalidateAndCancel()
  }

  static func makeSessionConfiguration() -> URLSessionConfiguration {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = 5
    configuration.timeoutIntervalForResource = 5
    configuration.waitsForConnectivity = false
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    configuration.urlCache = nil
    configuration.urlCredentialStorage = nil
    configuration.httpCookieStorage = nil
    configuration.httpCookieAcceptPolicy = .never
    configuration.httpShouldSetCookies = false
    return configuration
  }
}

/// Minimal PostHog Capture API client. ADE intentionally does not link the
/// PostHog SDK: that keeps remote config, replay, crash collection, automatic
/// lifecycle hooks, and an offline event queue out of the mobile binary.
final class DirectPostHogProductAnalyticsSink: ProductAnalyticsSink {
  struct Configuration: Equatable {
    let projectToken: String
    let endpoint: URL
  }

  static let defaultHost = "https://us.i.posthog.com"
  static let installationIDDefaultsKey = "ade.analytics.installation-id.v1"

  private let defaults: UserDefaults
  private let transportFactory: () -> ProductAnalyticsHTTPTransport
  private let lock = NSLock()
  private var configuration: Configuration?
  private var transport: ProductAnalyticsHTTPTransport?
  private var requestedEnabled = true

  init(
    defaults: UserDefaults = .standard,
    transportFactory: @escaping () -> ProductAnalyticsHTTPTransport = {
      DirectProductAnalyticsHTTPTransport()
    }
  ) {
    self.defaults = defaults
    self.transportFactory = transportFactory
  }

  var isConfigured: Bool {
    lock.withLock { configuration != nil }
  }

  var canCapture: Bool {
    lock.withLock { requestedEnabled && configuration != nil }
  }

  func configure(projectToken: String?, host: String?, enabled: Bool) {
    let validated = Self.validatedConfiguration(projectToken: projectToken, host: host)
    lock.withLock {
      transport?.cancelAll()
      transport = nil
      configuration = validated
      requestedEnabled = enabled
      if !enabled {
        defaults.removeObject(forKey: Self.installationIDDefaultsKey)
      }
    }
  }

  func capture(event: String, properties: [String: Any]) {
    lock.withLock {
      guard requestedEnabled,
            ProductAnalytics.allowedEventNames.contains(event),
            let configuration else {
        return
      }

      guard var privateProperties = Self.sanitizedProperties(
        event: event,
        properties: properties
      ) else {
        return
      }

      let installationID: String
      if let existing = defaults.string(forKey: Self.installationIDDefaultsKey),
         UUID(uuidString: existing) != nil {
        installationID = existing.lowercased()
      } else {
        installationID = UUID().uuidString.lowercased()
        defaults.set(installationID, forKey: Self.installationIDDefaultsKey)
      }

      privateProperties["surface"] = "mobile"
      privateProperties["platform"] = "ios"
      privateProperties["$process_person_profile"] = false
      privateProperties["$geoip_disable"] = true

      let payload: [String: Any] = [
        "api_key": configuration.projectToken,
        "distinct_id": installationID,
        "event": event,
        "properties": privateProperties,
        "uuid": UUID().uuidString.lowercased(),
      ]
      guard JSONSerialization.isValidJSONObject(payload),
            let body = try? JSONSerialization.data(withJSONObject: payload) else {
        return
      }

      var request = URLRequest(
        url: configuration.endpoint,
        cachePolicy: .reloadIgnoringLocalCacheData,
        timeoutInterval: 5
      )
      request.httpMethod = "POST"
      request.httpBody = body
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      let activeTransport = transport ?? transportFactory()
      transport = activeTransport
      activeTransport.send(request)
    }
  }

  func setEnabled(_ enabled: Bool) {
    lock.withLock {
      requestedEnabled = enabled
      guard !enabled else { return }
      transport?.cancelAll()
      transport = nil
      // A future opt-in receives a fresh anonymous installation id. This keeps
      // the opt-out boundary from linking pre- and post-consent activity.
      defaults.removeObject(forKey: Self.installationIDDefaultsKey)
    }
  }

  func flush() {
    // Every event starts immediately and there is no application-level queue.
  }

  static func validatedConfiguration(projectToken: String?, host: String?) -> Configuration? {
    guard let projectToken = normalizedConfigurationValue(projectToken) else {
      return nil
    }
    let tokenSuffix = projectToken.dropFirst(4)
    let allowedTokenCharacters = CharacterSet(
      charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-"
    )
    guard projectToken.hasPrefix("phc_"),
          tokenSuffix.count >= 8,
          projectToken.count <= 256,
          tokenSuffix.unicodeScalars.allSatisfy(allowedTokenCharacters.contains) else {
      return nil
    }

    let hostValue = normalizedConfigurationValue(host) ?? defaultHost
    guard var components = URLComponents(string: hostValue),
          components.scheme?.lowercased() == "https",
          components.host?.isEmpty == false,
          components.user == nil,
          components.password == nil,
          components.query == nil,
          components.fragment == nil,
          components.path.isEmpty || components.path == "/" else {
      return nil
    }
    components.path = "/i/v0/e/"
    guard let endpoint = components.url else { return nil }
    return Configuration(projectToken: projectToken, endpoint: endpoint)
  }

  private static func sanitizedProperties(
    event: String,
    properties: [String: Any]
  ) -> [String: Any]? {
    guard let eventName = ADEAnalyticsEventName(rawValue: event) else { return nil }
    func enumString<T: RawRepresentable>(_ key: String, as type: T.Type) -> String?
      where T.RawValue == String {
      guard let raw = properties[key] as? String, T(rawValue: raw) != nil else { return nil }
      return raw
    }

    switch eventName {
    case .appOpened:
      guard let entryPoint = enumString("entry_point", as: ADEAnalyticsAppEntryPoint.self) else {
        return nil
      }
      return ["entry_point": entryPoint]

    case .screenViewed:
      guard let screen = enumString("screen", as: ADEAnalyticsScreen.self) else { return nil }
      return ["screen": screen]

    case .featureUsed:
      guard let feature = enumString("feature", as: ADEAnalyticsFeature.self),
            let outcome = enumString("outcome", as: ADEAnalyticsOutcome.self) else {
        return nil
      }
      var sanitized: [String: Any] = [
        "feature": feature,
        "outcome": outcome,
      ]
      if properties["source"] != nil {
        guard let source = enumString("source", as: ADEAnalyticsSource.self) else { return nil }
        sanitized["source"] = source
      }
      return sanitized

    case .error:
      guard let errorKind = enumString("error_kind", as: ADEAnalyticsErrorCategory.self),
            properties["recoverable"] as? Bool == true else {
        return nil
      }
      return [
        "error_kind": errorKind,
        "recoverable": true,
      ]

    case .analyticsBudget:
      guard let sentCount = properties["sent_count"] as? Int,
            (0...ProductAnalytics.dailyEventLimit).contains(sentCount),
            let droppedCount = properties["dropped_count"] as? Int,
            (0...9_999).contains(droppedCount),
            let dropReason = properties["drop_reason"] as? String,
            dropReason == "none" || dropReason == "daily_budget" else {
        return nil
      }
      return [
        "sent_count": sentCount,
        "dropped_count": droppedCount,
        "drop_reason": dropReason,
      ]
    }
  }

  private static func normalizedConfigurationValue(_ raw: String?) -> String? {
    guard let raw else { return nil }
    let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !value.isEmpty, !value.contains("$(") else { return nil }
    return value
  }
}

/// The only analytics entry point in the iOS app.
///
/// Call sites choose from closed enums and cannot attach arbitrary strings,
/// identifiers, paths, prompts, transcripts, project names, or error messages.
/// The service also enforces a restart-safe install-local daily budget before
/// the direct Capture API sink sees an event.
final class ProductAnalytics {
  static let shared = ProductAnalytics()

  static let enabledDefaultsKey = "ade.analytics.enabled"
  static let allowedEventNames = Set(ADEAnalyticsEventName.allCases.map(\.rawValue))
  static let dailyEventLimit = 20

  private static let budgetDefaultsKey = "ade.analytics.daily-budget.v2"
  private static let eventLimits: [ADEAnalyticsEventName: Int] = [
    .appOpened: 3,
    .screenViewed: 10,
    .featureUsed: 7,
    .error: 2,
    .analyticsBudget: 1,
  ]

  private enum DropReason: String {
    case none
    case dailyBudget = "daily_budget"
  }

  private struct DailyBudget: Codable, Equatable {
    var day: String
    var total: Int
    var counts: [String: Int]
    var dropped: Int
    var dropReasons: [String: Int]
  }

  private struct PendingEvent {
    let name: ADEAnalyticsEventName
    let properties: [String: Any]
  }

  private let defaults: UserDefaults
  private let now: () -> Date
  private let sink: ProductAnalyticsSink
  private let lock = NSLock()
  private var budget: DailyBudget?
  private var foregroundDeduplicationKeys = Set<String>()

  init(
    defaults: UserDefaults = .standard,
    now: @escaping () -> Date = Date.init,
    sink: ProductAnalyticsSink? = nil
  ) {
    self.defaults = defaults
    self.now = now
    self.sink = sink ?? DirectPostHogProductAnalyticsSink(defaults: defaults)
  }

  var isEnabled: Bool {
    if defaults.object(forKey: Self.enabledDefaultsKey) == nil {
      return false
    }
    return defaults.bool(forKey: Self.enabledDefaultsKey)
  }

  var shouldRequestConsent: Bool {
    sink.isConfigured && defaults.object(forKey: Self.enabledDefaultsKey) == nil
  }

  func configure(bundle: Bundle = .main) {
    guard let postHogSink = sink as? DirectPostHogProductAnalyticsSink else { return }
    postHogSink.configure(
      projectToken: Self.configurationValue(for: "ADEPostHogProjectToken", in: bundle),
      host: Self.configurationValue(for: "ADEPostHogHost", in: bundle),
      enabled: isEnabled
    )
  }

  func setEnabled(_ enabled: Bool) {
    defaults.set(enabled, forKey: Self.enabledDefaultsKey)
    sink.setEnabled(enabled)
    Task { @MainActor in
      await SyncService.shared?.setProductAnalyticsClientEnabled(enabled)
    }
  }

  func captureAppOpened(_ entryPoint: ADEAnalyticsAppEntryPoint) {
    lock.withLock {
      foregroundDeduplicationKeys.removeAll(keepingCapacity: true)
    }
    capture(
      .appOpened,
      properties: ["entry_point": entryPoint.rawValue]
    )
  }

  func captureScreen(_ screen: ADEAnalyticsScreen) {
    capture(
      .screenViewed,
      properties: ["screen": screen.rawValue],
      foregroundDeduplicationKey: "screen:\(screen.rawValue)"
    )
  }

  func captureFeature(
    _ feature: ADEAnalyticsFeature,
    outcome: ADEAnalyticsOutcome,
    source: ADEAnalyticsSource? = nil
  ) {
    var properties = [
      "feature": feature.rawValue,
      "outcome": outcome.rawValue,
    ]
    if let source {
      properties["source"] = source.rawValue
    }
    let deduplicationKey = [feature.rawValue, outcome.rawValue, source?.rawValue]
      .compactMap { $0 }
      .joined(separator: ":")
    capture(
      .featureUsed,
      properties: properties,
      foregroundDeduplicationKey: "feature:\(deduplicationKey)"
    )
  }

  func captureError(_ category: ADEAnalyticsErrorCategory) {
    capture(
      .error,
      properties: [
        "error_kind": category.rawValue,
        "recoverable": true,
      ],
      foregroundDeduplicationKey: "error:\(category.rawValue)"
    )
  }

  func flush() {
    sink.flush()
  }

  private func capture(
    _ event: ADEAnalyticsEventName,
    properties: [String: Any],
    foregroundDeduplicationKey: String? = nil
  ) {
    guard isEnabled, sink.canCapture else { return }

    let pendingEvents = lock.withLock { () -> [PendingEvent] in
      var pendingEvents: [PendingEvent] = []
      var currentBudget: DailyBudget
      let currentDay = Self.utcDay(for: now())

      if let inMemory = budget, inMemory.day == currentDay {
        currentBudget = inMemory
      } else if let stored = loadPersistedBudget(), stored.day == currentDay {
        currentBudget = stored
        budget = stored
      } else {
        let previousBudget = budget ?? loadPersistedBudget()
        currentBudget = DailyBudget(
          day: currentDay,
          total: 0,
          counts: [:],
          dropped: 0,
          dropReasons: [:]
        )
        budget = currentBudget
        foregroundDeduplicationKeys.removeAll(keepingCapacity: true)

        if let previousBudget,
           previousBudget.total > 0 || previousBudget.dropped > 0,
           reserve(.analyticsBudget, in: &currentBudget) {
          let dominantReason = previousBudget.dropReasons
            .max { lhs, rhs in
              lhs.value == rhs.value ? lhs.key > rhs.key : lhs.value < rhs.value
            }?.key ?? DropReason.none.rawValue
          pendingEvents.append(PendingEvent(
            name: .analyticsBudget,
            properties: [
              "sent_count": min(max(previousBudget.total, 0), Self.dailyEventLimit),
              "dropped_count": min(max(previousBudget.dropped, 0), 9_999),
              "drop_reason": dominantReason,
            ]
          ))
        }
      }

      if let foregroundDeduplicationKey,
         foregroundDeduplicationKeys.contains(foregroundDeduplicationKey) {
        budget = currentBudget
        persist(currentBudget)
        return pendingEvents
      }

      guard reserve(event, in: &currentBudget) else {
        let reason = DropReason.dailyBudget
        currentBudget.dropped = min(currentBudget.dropped + 1, 9_999)
        currentBudget.dropReasons[reason.rawValue, default: 0] = min(
          currentBudget.dropReasons[reason.rawValue, default: 0] + 1,
          9_999
        )
        budget = currentBudget
        persist(currentBudget)
        return pendingEvents
      }

      budget = currentBudget
      persist(currentBudget)
      if let foregroundDeduplicationKey {
        foregroundDeduplicationKeys.insert(foregroundDeduplicationKey)
      }
      pendingEvents.append(PendingEvent(name: event, properties: properties))
      return pendingEvents
    }

    for pendingEvent in pendingEvents {
      var eventProperties = pendingEvent.properties
      eventProperties["surface"] = "mobile"
      eventProperties["platform"] = "ios"
      eventProperties["$process_person_profile"] = false
      eventProperties["$geoip_disable"] = true
      sink.capture(event: pendingEvent.name.rawValue, properties: eventProperties)
    }
  }

  private func reserve(_ event: ADEAnalyticsEventName, in budget: inout DailyBudget) -> Bool {
    let eventCount = budget.counts[event.rawValue, default: 0]
    guard budget.total < Self.dailyEventLimit,
          eventCount < (Self.eventLimits[event] ?? 0) else {
      return false
    }
    budget.total += 1
    budget.counts[event.rawValue] = eventCount + 1
    return true
  }

  private func loadPersistedBudget() -> DailyBudget? {
    guard let data = defaults.data(forKey: Self.budgetDefaultsKey) else { return nil }
    return try? JSONDecoder().decode(DailyBudget.self, from: data)
  }

  private func persist(_ budget: DailyBudget) {
    guard let data = try? JSONEncoder().encode(budget) else { return }
    defaults.set(data, forKey: Self.budgetDefaultsKey)
  }

  private static func utcDay(for date: Date) -> String {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(secondsFromGMT: 0)!
    let components = calendar.dateComponents([.year, .month, .day], from: date)
    return String(
      format: "%04d-%02d-%02d",
      components.year ?? 0,
      components.month ?? 0,
      components.day ?? 0
    )
  }

  private static func configurationValue(for key: String, in bundle: Bundle) -> String? {
    guard let raw = bundle.object(forInfoDictionaryKey: key) as? String else { return nil }
    let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !value.isEmpty, !value.contains("$(") else { return nil }
    return value
  }
}

private extension NSLock {
  func withLock<T>(_ body: () throws -> T) rethrows -> T {
    lock()
    defer { unlock() }
    return try body()
  }
}

extension View {
  func adeAnalyticsScreen(_ screen: ADEAnalyticsScreen) -> some View {
    onAppear {
      ProductAnalytics.shared.captureScreen(screen)
    }
  }
}
