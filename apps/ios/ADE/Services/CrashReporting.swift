import Foundation
import Sentry

/// Crash and error reporting through Sentry (sentry-cocoa). App target only:
/// keep Sentry out of `ADE/Shared`, `ADEWidgets` and `ADEClip`, which compile
/// into extensions with tight memory limits.
///
/// Every event passes `ADECrashScrubber` before it leaves the device. The Sentry
/// user is the pseudonymous account hash `ProductAnalytics` already uses, never
/// the Clerk id, email or name. `sendDefaultPii` stays false, so no IP address.
enum CrashReporting {
  private static var didStart = false

  /// Starts Sentry for Release and TestFlight builds. Debug and simulator runs
  /// stay silent unless `ADE_SENTRY_DEV=1` opts in (those events are sent with
  /// environment `development`). `ADE_SENTRY_DSN` overrides the Info.plist DSN.
  /// `ADE_SENTRY_DISABLED=1` or `DO_NOT_TRACK=1` turns reporting off, and so
  /// does an analytics opt-out stored by an earlier build: a choice someone
  /// already made covers error tracking too.
  static func start() {
    guard !didStart else { return }
    let environment = ProcessInfo.processInfo.environment
    if ProductAnalytics.isTruthyFlag(environment["ADE_SENTRY_DISABLED"]) || !ProductAnalytics.shared.isEnabled {
      return
    }
    #if DEBUG
    let isDebugBuild = true
    #else
    let isDebugBuild = false
    #endif
    #if targetEnvironment(simulator)
    let isSimulator = true
    #else
    let isSimulator = false
    #endif
    let isDevelopmentRun = isDebugBuild || isSimulator
    if isDevelopmentRun, environment["ADE_SENTRY_DEV"] != "1" {
      return
    }
    guard let dsn = resolvedDSN(environment: environment) else { return }

    didStart = true
    let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String
    let firstPartyTargets = firstPartyURLPatterns()
    SentrySDK.start { options in
      options.dsn = dsn
      options.environment = isDevelopmentRun ? "development" : "production"
      options.dist = build
      // releaseName stays unset: the SDK sends bundleId@shortVersion+build,
      // which matches the App Store Connect build.
      options.sendDefaultPii = false
      options.attachScreenshot = false
      options.attachViewHierarchy = false
      options.enableMetricKit = true
      options.enableAppHangTracking = true
      // A hang the main thread was not fully blocked for is a slow frame, not
      // a freeze; MetricKit (on above) still reports those from the OS.
      options.enableReportNonFullyBlockingAppHangs = false
      options.enableWatchdogTerminationTracking = true
      options.enableLogs = true
      options.tracesSampleRate = 0.05
      options.tracePropagationTargets = firstPartyTargets
      options.enableCaptureFailedRequests = true
      options.failedRequestTargets = firstPartyTargets
      options.sessionReplay.sessionSampleRate = 0
      options.sessionReplay.onErrorSampleRate = 1.0
      options.sessionReplay.maskAllText = true
      options.sessionReplay.maskAllImages = true
      options.beforeBreadcrumb = { crumb in ADECrashScrubber.scrub(crumb) }
      // The budget decides first, on the raw event; the scrubber only cleans.
      options.beforeSend = { event in
        if isIdleRunLoopAppHang(event) { return nil }
        return ADECrashEventLimiter.shared.admit(ADECrashScrubber.fingerprint(for: event))
          ? ADECrashScrubber.scrub(event)
          : nil
      }
    }
    // The tags every ADE Sentry project carries (`sentryCommonTags` in
    // `shared/sentry/config.ts`). No `is_internal`: a phone has no team-install
    // marker. The OS is Sentry's own `os` tag.
    let distribution = ADEAnalyticsDistribution.current
    SentrySDK.configureScope { scope in
      scope.setTag(value: "ios", key: "surface")
      scope.setTag(value: "ios", key: "client")
      scope.setTag(value: isDevelopmentRun ? "development" : distribution.releaseChannel, key: "release_channel")
      scope.setTag(value: distribution.rawValue, key: "distribution")
    }
    setUser(accountId: nil)
  }

  /// Reports a handled error. `context` holds short facts such as `area`; values
  /// are scrubbed before they are sent. Cancellations and benign offline states
  /// are dropped, because they are not bugs.
  static func capture(_ error: Error, context: [String: String] = [:]) {
    if error is CancellationError { return }
    if let urlError = error as? URLError, benignURLErrorCodes.contains(urlError.code) { return }
    let area = context["area"] ?? "unknown"
    let fingerprint = ["ios", area, String(describing: type(of: error))]
    _ = SentrySDK.capture(error: error) { scope in
      scope.setFingerprint(fingerprint)
      scope.setTag(value: area, key: "area")
      scope.setContext(value: ADECrashScrubber.scrubDictionary(context as [String: Any]), key: "ade")
    }
  }

  /// Adds a breadcrumb. Put only names and counts in `data`, never prompt,
  /// transcript, path or token text. The scrubber checks it anyway.
  static func breadcrumb(_ category: String, message: String? = nil, data: [String: String] = [:]) {
    let crumb = Sentry.Breadcrumb(level: .info, category: category)
    crumb.message = message.map { ADECrashScrubber.scrubString($0) }
    crumb.data = ADECrashScrubber.scrubDictionary(data as [String: Any])
    SentrySDK.addBreadcrumb(crumb)
  }

  private static var lastDisplayLayout: String?

  /// The layout the window is in (phone, wide, the Duo's edge bar, its fold),
  /// as tags on every later event plus one breadcrumb when it changes. It
  /// sends nothing of its own, so a Duo crash names its posture at no cost
  /// to the event budget. Geometry calls this often; only changes count.
  static func setDisplayLayout(family: String, edgeBar: Bool, fold: String) {
    guard didStart else { return }
    let key = "\(family)|\(edgeBar)|\(fold)"
    guard key != lastDisplayLayout else { return }
    lastDisplayLayout = key
    SentrySDK.configureScope { scope in
      scope.setTag(value: family, key: "display.family")
      scope.setTag(value: edgeBar ? "yes" : "no", key: "display.edge_bar")
      scope.setTag(value: fold, key: "display.fold")
    }
    breadcrumb("layout", message: "\(family) fold=\(fold) edgeBar=\(edgeBar)")
  }

  /// Sets the Sentry user. A non-empty `accountId` (the Clerk user id) is hashed
  /// the same way PostHog hashes it. `nil` falls back to the anonymous install
  /// id that PostHog already uses, so sign-out never keeps the old account.
  /// With analytics off there is no id, and events carry no user.
  static func setUser(accountId: String?) {
    let normalized = accountId?.trimmingCharacters(in: .whitespacesAndNewlines)
    let userId: String?
    if let normalized, !normalized.isEmpty {
      userId = ProductAnalytics.accountHash(normalized)
    } else {
      userId = ProductAnalytics.shared.currentDistinctId()
    }
    guard let userId else {
      SentrySDK.setUser(nil)
      return
    }
    let user = Sentry.User()
    user.userId = userId
    SentrySDK.setUser(user)
  }

  /// An app hang whose main thread sat idle in its run loop: the app was
  /// suspended (or the detector misfired) while nothing ran. Decided on
  /// library names and in-app flags, because Sentry fills in no function
  /// names on device; a hang with real work on the stack is always kept.
  private static func isIdleRunLoopAppHang(_ event: Sentry.Event) -> Bool {
    guard let exception = event.exceptions?.last,
          exception.type?.contains("App Hang") == true else { return false }
    let stacktrace = exception.stacktrace
      ?? event.threads?.first(where: { $0.current?.boolValue == true })?.stacktrace
    guard let frames = stacktrace?.frames else { return false }
    return ADEAppHangStack.isIdleRunLoop(frames.map {
      ADEAppHangStack.Frame(package: $0.package, inApp: $0.inApp?.boolValue == true)
    })
  }

  // MARK: - Configuration helpers

  /// Network error and trace targets: ADE's own Workers only, never third parties.
  private static func firstPartyURLPatterns() -> [String] {
    ["ADEAccountDirectoryBaseURL", "ADEPushRelayBaseURL"].compactMap { key -> String? in
      guard let raw = Bundle.main.object(forInfoDictionaryKey: key) as? String else { return nil }
      let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !value.isEmpty, !value.hasPrefix("$("),
            let host = URL(string: value)?.host, !host.isEmpty else { return nil }
      return "^https://" + NSRegularExpression.escapedPattern(for: host)
    }
  }

  private static func resolvedDSN(environment: [String: String]) -> String? {
    if let override = environment["ADE_SENTRY_DSN"]?.trimmingCharacters(in: .whitespacesAndNewlines),
       !override.isEmpty {
      return override
    }
    guard let raw = Bundle.main.object(forInfoDictionaryKey: "ADESentryDSN") as? String else {
      return nil
    }
    let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !value.isEmpty, !value.hasPrefix("$(") else { return nil }
    return value
  }

  private static let benignURLErrorCodes: Set<URLError.Code> = [
    .cancelled,
    .notConnectedToInternet,
    .networkConnectionLost,
    .dataNotAllowed,
    // A phone on a weak network, like a lost connection: the network, not ADE.
    .timedOut,
  ]
}

/// Reads an app hang's main-thread stack, outermost frame first.
enum ADEAppHangStack {
  struct Frame {
    /// The image path Sentry records for the frame.
    let package: String?
    let inApp: Bool
  }

  /// True when the stack is the idle main run loop and nothing else: the
  /// innermost frame is in `libsystem_kernel` (waiting in `mach_msg`), every
  /// frame inside `GraphicsServices` (GSEventRunModal) is CoreFoundation's run
  /// loop or the kernel, and no ADE code is on the stack except the entry
  /// point outside the run loop.
  static func isIdleRunLoop(_ frames: [Frame]) -> Bool {
    guard let innermost = frames.last, library(innermost) == "libsystem_kernel.dylib",
          let runLoopEntry = frames.firstIndex(where: { library($0) == "GraphicsServices" }) else {
      return false
    }
    let insideRunLoop = frames[frames.index(after: runLoopEntry)...]
    guard !insideRunLoop.isEmpty else { return false }
    return insideRunLoop.allSatisfy {
      !$0.inApp && idleRunLoopLibraries.contains(library($0))
    }
  }

  private static let idleRunLoopLibraries: Set<String> = ["CoreFoundation", "libsystem_kernel.dylib"]

  private static func library(_ frame: Frame) -> String {
    guard let package = frame.package else { return "" }
    return package.split(separator: "/").last.map(String.init) ?? package
  }
}

/// Scrubs strings, dictionaries and events before they leave the device.
enum ADECrashScrubber {
  static func scrub(_ event: Sentry.Event) -> Sentry.Event {
    if let user = event.user {
      user.email = nil
      user.username = nil
      user.ipAddress = nil
    }
    if let message = event.message {
      // `formatted` is read-only; a scrubbed message is a new one.
      event.message = SentryMessage(formatted: scrubString(message.formatted))
    }
    event.exceptions?.forEach { exception in
      // Written to compile whether `value` is optional or not in this SDK version.
      if let value = exception.value as String? {
        exception.value = scrubString(value)
      }
    }
    if let request = event.request {
      // A failed-request event names the URL it called; nothing else is kept.
      request.url = request.url.map { scrubString($0) }
      request.queryString = nil
      request.fragment = nil
      request.cookies = nil
      request.headers = nil
    }
    event.breadcrumbs?.forEach { crumb in _ = scrub(crumb) }
    event.tags = event.tags.map { scrubStringDictionary($0) }
    event.extra = event.extra.map { scrubDictionary($0) }
    event.context = event.context.map { contexts in
      contexts.mapValues { scrubDictionary($0) }
    }
    return event
  }

  static func scrub(_ crumb: Sentry.Breadcrumb) -> Sentry.Breadcrumb? {
    if let message = crumb.message {
      crumb.message = scrubString(message)
    }
    if let data = crumb.data {
      crumb.data = scrubDictionary(data)
    }
    return crumb
  }

  static func scrubString(_ input: String) -> String {
    var output = input
    for pattern in secretPatterns {
      let range = NSRange(output.startIndex..<output.endIndex, in: output)
      output = pattern.stringByReplacingMatches(
        in: output,
        options: [],
        range: range,
        withTemplate: "[redacted]"
      )
    }
    for (pattern, template) in relayPathPatterns {
      let range = NSRange(output.startIndex..<output.endIndex, in: output)
      output = pattern.stringByReplacingMatches(in: output, options: [], range: range, withTemplate: template)
    }
    return output
  }

  static func scrubDictionary(_ dictionary: [String: Any]) -> [String: Any] {
    scrubMap(dictionary, depth: 0)
  }

  static func scrubStringDictionary(_ dictionary: [String: String]) -> [String: String] {
    var output: [String: String] = [:]
    for (key, value) in dictionary {
      output[key] = keyLooksSecret(key) ? "[redacted]" : scrubString(value)
    }
    return output
  }

  // MARK: - Private

  /// The secret shapes of `apps/desktop/src/shared/sentry/scrub.ts` (keep the
  /// two lists in step), plus PostHog keys, home-directory paths, and
  /// `code`/`pin` assignments (pairing codes).
  private static let secretPatterns: [NSRegularExpression] = [
    #"sk-[A-Za-z0-9_-]{16,}"#,
    #"(?:ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)[A-Za-z0-9_]+"#,
    #"xox[abprs]-[A-Za-z0-9-]+"#,
    #"AKIA[0-9A-Z]{16}"#,
    #"AIza[0-9A-Za-z_-]{35}"#,
    #"lin_(?:api|oauth)_[A-Za-z0-9]{20,}"#,
    #"sntrys_[A-Za-z0-9_=-]{20,}"#,
    #"(?:xai-|gsk_|hf_|npm_|sk_live_|sk_test_|rk_live_)[A-Za-z0-9_-]{16,}"#,
    #"ya29\.[A-Za-z0-9._-]{20,}"#,
    #"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+"#,
    #"(?i)(?:Bearer|Basic)\s+\S+"#,
    #"(?i)(?<=://)[^\s/@:]+:[^\s/@]+(?=@)"#,
    #"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|\z)"#,
    #"(?i)\b(?:api[_-]?key|token|secret|password|authorization|cookie|code|pin)\s*[:=]\s*\S+"#,
    #"phc_[A-Za-z0-9_-]{8,}"#,
    #"/Users/[^/\s]+"#,
  ].compactMap { try? NSRegularExpression(pattern: $0) }

  /// The relays address a machine by its `machineKey` in the URL path, and a
  /// custom webhook by `/hooks/<id>/<token>`. Rewritten wherever they appear;
  /// the app holds no file paths that look like these.
  private static let relayPathPatterns: [(NSRegularExpression, String)] = [
    (#"/(host|connect|prewarm|machines)/[^\s/?#"']+"#, "/$1/[key]"),
    (#"/hooks/(?!(?:register|events|ack|subscribe)(?:[/?#\s"']|$))[^\s/?#"']+/[^\s/?#"']+"#, "/hooks/[id]/[token]"),
  ].compactMap { pattern, template in
    (try? NSRegularExpression(pattern: pattern)).map { ($0, template) }
  }

  private static let secretKeyPattern = try? NSRegularExpression(
    pattern: #"(?i)api[_-]?key|token|secret|password|authorization|cookie"#
  )

  private static func keyLooksSecret(_ key: String) -> Bool {
    guard let secretKeyPattern else { return false }
    let range = NSRange(key.startIndex..<key.endIndex, in: key)
    return secretKeyPattern.firstMatch(in: key, options: [], range: range) != nil
  }

  private static func scrubMap(_ dictionary: [String: Any], depth: Int) -> [String: Any] {
    var output: [String: Any] = [:]
    for (key, value) in dictionary {
      output[key] = keyLooksSecret(key) ? "[redacted]" : scrubValue(value, depth: depth)
    }
    return output
  }

  private static func scrubValue(_ value: Any, depth: Int) -> Any {
    guard depth < 6 else { return "[truncated]" }
    switch value {
    case let string as String:
      return scrubString(string)
    case let dictionary as [String: Any]:
      return scrubMap(dictionary, depth: depth + 1)
    case let array as [Any]:
      return array.map { scrubValue($0, depth: depth + 1) }
    default:
      return value
    }
  }

  /// The grouping key for the quota: the caller's fingerprint, else the exception
  /// type, else the message. Read from the raw event, before it is scrubbed.
  fileprivate static func fingerprint(for event: Sentry.Event) -> String {
    if let fingerprint = event.fingerprint, !fingerprint.isEmpty {
      return fingerprint.joined(separator: "|")
    }
    if let type = event.exceptions?.first?.type {
      return "exception|" + type
    }
    return "message|" + (event.message?.formatted ?? "event")
  }
}

/// Client-side quota guard, per process: at most 5 events per fingerprint and
/// 60 in total per hour. Events beyond that are dropped before they are sent.
private final class ADECrashEventLimiter {
  static let shared = ADECrashEventLimiter()

  private let perFingerprintLimit = 5
  private let totalLimit = 60
  private let window: TimeInterval = 3600
  private let lock = NSLock()
  private var total: [Date] = []
  private var perFingerprint: [String: [Date]] = [:]

  func admit(_ fingerprint: String, now: Date = Date()) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    let cutoff = now.addingTimeInterval(-window)
    total.removeAll { $0 < cutoff }
    guard total.count < totalLimit else { return false }
    var recent = perFingerprint[fingerprint, default: []]
    recent.removeAll { $0 < cutoff }
    guard recent.count < perFingerprintLimit else {
      perFingerprint[fingerprint] = recent
      return false
    }
    recent.append(now)
    perFingerprint[fingerprint] = recent
    total.append(now)
    if perFingerprint.count > 256 {
      perFingerprint = perFingerprint.filter { ($0.value.last ?? .distantPast) >= cutoff }
    }
    return true
  }
}
