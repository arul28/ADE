import Combine
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
    // Made now, so that its clock starts with the process and not with the first publish.
    _ = ADEHangContext.shared
    let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String
    let firstPartyTargets = firstPartyURLPatterns()
    let distribution = ADEAnalyticsDistribution.current
    SentrySDK.start { options in
      options.dsn = dsn
      // The ADE Beta app reports as `beta`, never as production, so a beta's
      // errors cannot read as the store app's (`sentryEnvironment`).
      options.environment = sentryEnvironment(isDevelopmentRun: isDevelopmentRun, releaseChannel: distribution.releaseChannel)
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
        if isIdleRunLoopAppHang(event) || isNoiseHang(event) { return nil }
        groupAppHang(event)
        guard ADECrashEventLimiter.shared.admit(ADECrashScrubber.fingerprint(for: event)) else { return nil }
        let scrubbed = ADECrashScrubber.scrub(event)
        // PostHog error tracking gets what Sentry admitted, never more.
        if let report = exceptionReport(from: scrubbed) {
          ProductAnalytics.shared.captureException(report)
        }
        return scrubbed
      }
    }
    // The tags every ADE Sentry project carries (`sentryCommonTags` in
    // `shared/sentry/config.ts`). No `is_internal`: a phone has no team-install
    // marker. The OS is Sentry's own `os` tag. `machine_id` is this app on this
    // phone, the value PostHog events carry (`DirectPostHogProductAnalyticsSink.machineID`).
    SentrySDK.configureScope { scope in
      scope.setTag(value: "ios", key: "surface")
      scope.setTag(value: "ios", key: "client")
      scope.setTag(value: isDevelopmentRun ? "development" : distribution.releaseChannel, key: "release_channel")
      scope.setTag(value: distribution.rawValue, key: "distribution")
      if let machineID = DirectPostHogProductAnalyticsSink.machineID {
        scope.setTag(value: machineID, key: "machine_id")
      }
    }
    setUser(accountId: nil)
  }

  /// Reports a handled error. `context` holds short facts such as `area`; values
  /// are scrubbed before they are sent. Cancellations and benign offline states
  /// are dropped, because they are not bugs.
  static func capture(_ error: Error, context: [String: String] = [:]) {
    if error is CancellationError { return }
    if let urlError = error as? URLError, benignURLErrorCodes.contains(urlError.code) { return }
    // A paired machine that is asleep, busy or on a slow link; the user is
    // told to try again, and nothing on the phone failed.
    if error.localizedDescription == SyncRequestTimeout.message { return }
    let area = context["area"] ?? "unknown"
    let typeName = errorTypeName(error)
    let fingerprint = ["ios", area, typeName]
    _ = SentrySDK.capture(error: reportableError(error, typeName: typeName)) { scope in
      scope.setFingerprint(fingerprint)
      scope.setTag(value: area, key: "area")
      scope.setContext(value: ADECrashScrubber.scrubDictionary(context as [String: Any]), key: "ade")
      // The associated values, which the title must not carry, with every
      // quoted value (a machine name, a route label) left out.
      scope.setExtra(value: redactedErrorDescription(error), key: "error_description")
    }
  }

  /// `production` for the store app (TestFlight or App Store), `beta` for the
  /// ADE Beta app, `development` for a debug or simulator run: the desktop's
  /// rule (`resolveSentryEnvironment`), from the same `releaseChannel`.
  static func sentryEnvironment(isDevelopmentRun: Bool, releaseChannel: String) -> String {
    if isDevelopmentRun || releaseChannel == "development" { return "development" }
    return releaseChannel == "stable" ? "production" : releaseChannel
  }

  /// The error's type, bare: `AccountAdoptionRoutesExhaustedError`, never the
  /// module path with its per-build `(unknown context at $10422b9a4)`.
  static func errorTypeName(_ error: Error) -> String {
    let described = String(describing: type(of: error))
    let bare = described.split(separator: ".").last.map(String.init) ?? described
    return bare.isEmpty ? "Error" : bare
  }

  /// What Sentry titles the issue by. A Swift error is reported under its bare
  /// type name with no description: sentry-cocoa otherwise titles it
  /// `String(describing:)`, associated values and all (a machine's name), and
  /// its domain carries a per-build address. A Foundation error keeps its
  /// domain and code; its description is scrubbed like everything else.
  static func reportableError(_ error: Error, typeName: String) -> Error {
    let nsError = error as NSError
    let swiftNative = nsError.domain.contains("unknown context at")
      || nsError.domain == String(reflecting: type(of: error))
      || nsError.domain.hasSuffix(".\(typeName)")
    guard swiftNative else { return error }
    return NSError(domain: typeName, code: nsError.code, userInfo: [NSLocalizedDescriptionKey: typeName])
  }

  static func redactedErrorDescription(_ error: Error) -> String {
    let described = String(describing: error)
    let unquoted = described.replacingOccurrences(of: #""(?:[^"\\]|\\.)*""#, with: "\"<redacted>\"", options: .regularExpression)
    return String(ADECrashScrubber.scrubString(unquoted).prefix(1_000))
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

  private static var lastScreen: String?

  /// The ADE screen shown last, as a tag on every later event plus one
  /// breadcrumb when it changes. An app hang's stack names only system code:
  /// in the 13 hangs of ADE-IOS-1B (2026-10-23 to 2026-11-05) no main thread
  /// held an ADE function, so the screen is what tells which view was
  /// updating. Like the layout, it sends nothing of its own.
  static func setScreen(_ screen: String) {
    guard didStart, screen != lastScreen else { return }
    lastScreen = screen
    SentrySDK.configureScope { scope in
      scope.setTag(value: screen, key: "screen")
    }
    breadcrumb("screen", message: screen)
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

  /// A hang report that is not a freeze someone saw: see `ADEHangReportFilter`.
  private static func isNoiseHang(_ event: Sentry.Event) -> Bool {
    guard let exception = event.exceptions?.last else { return false }
    return ADEHangReportFilter.isNoise(
      type: exception.type,
      value: exception.value,
      isFatal: event.level == .fatal
    )
  }

  /// One issue per kind of app hang, not per duration. The SDK titles a hang
  /// with its length ("App hanging between 3.9 and 4.7 seconds") and the
  /// phone's stacks differ in system frames, so Sentry made a new issue for
  /// nearly every hang. The kind is the exception type (`App Hang Fully
  /// Blocked`, `Fatal App Hang Fully Blocked` for a watchdog kill) plus where
  /// the main thread was: the innermost ADE function when the phone named
  /// one, else the library it was blocked in (SQLite, SwiftUI, …), so hangs
  /// with different causes stay apart.
  ///
  /// The OS's own hang reports (MetricKit's `MXHangDiagnostic`) get the same
  /// treatment: their title carries the duration ("hangDuration:2.4 sec"), so
  /// each one opened its own issue. They group as `mx_hang` plus the same site.
  private static func groupAppHang(_ event: Sentry.Event) {
    guard let exception = event.exceptions?.last, let type = exception.type else { return }
    let isMetricKitHang = type == "MXHangDiagnostic"
    guard isMetricKitHang || type.contains("App Hang") else { return }
    // A MetricKit report may mark no thread as current; its first thread with
    // frames is then the hung one (MetricKit lists the main thread first).
    let stacktrace = exception.stacktrace
      ?? event.threads?.first(where: { $0.current?.boolValue == true })?.stacktrace
      ?? (isMetricKitHang ? event.threads?.first(where: { $0.stacktrace?.frames.isEmpty == false })?.stacktrace : nil)
    let frames = stacktrace?.frames ?? []
    let site = innermostAppFunction(frames) ?? innermostBlockingLibrary(frames)
    let kind = isMetricKitHang ? ["ios", "mx_hang"] : ["ios", "app_hang", type]
    event.fingerprint = kind + (site.map { [$0] } ?? [])
    // A MetricKit report arrives a day later, so this launch's publish counts
    // say nothing about it.
    if isMetricKitHang { return }
    // What fed the main thread before the hang. Many hangs hold no ADE frame
    // at all: the stack is SwiftUI working through view updates (ADE-IOS-27,
    // 8 seconds after launch) and says nothing about which state kept
    // changing. The publish counts and the app's age do.
    if let hang = ADEHangContext.shared.snapshot(at: event.timestamp) {
      var context = event.context ?? [:]
      context["ade_hang"] = hang
      event.context = context
    }
  }

  /// Counts every `objectWillChange` of one of the app's shared models, for
  /// `ADEHangContext`. Does nothing until crash reporting has started, so
  /// tests and previews that build a model pay nothing. One counter per
  /// `source`: watching a source again replaces the earlier watch.
  static func watchPublishes<P: Publisher>(of publisher: P, source: String) where P.Failure == Never {
    guard didStart else { return }
    publishWatches[source] = publisher.sink { _ in ADEHangContext.shared.notePublish(source) }
  }

  private static var publishWatches: [String: AnyCancellable] = [:]

  /// The innermost in-app frame's function, skipping the entry point every
  /// stack has (`main`, `ADEApp.$main`). Nil when the phone sent no names.
  private static func innermostAppFunction(_ frames: [Sentry.Frame]) -> String? {
    frames.reversed().first(where: { frame in
      guard frame.inApp?.boolValue == true, let function = frame.function, !function.isEmpty else { return false }
      return function != "main" && !function.hasSuffix(".$main")
    })?.function
  }

  /// The library of the innermost frame that is not the kernel's or the
  /// thread library's wait, which every blocked stack ends in.
  private static func innermostBlockingLibrary(_ frames: [Sentry.Frame]) -> String? {
    frames.reversed().lazy
      .compactMap { $0.package?.split(separator: "/").last.map(String.init) }
      .first { !waitLibraries.contains($0) }
  }

  private static let waitLibraries: Set<String> = [
    "libsystem_kernel.dylib", "libsystem_pthread.dylib", "libsystem_platform.dylib",
  ]

  /// Reads a scrubbed Sentry error event into the report PostHog's
  /// `$exception` is built from. Transactions and info/debug messages are
  /// not errors and are not mirrored.
  static func exceptionReport(from event: Sentry.Event) -> ADEAnalyticsExceptionReport? {
    if let type = event.type, type != "event" { return nil }
    let level: String
    switch event.level {
    case .fatal: level = "fatal"
    case .error: level = "error"
    case .warning: level = "warning"
    default: return nil
    }
    // Sentry lists a cause chain oldest first, so the outermost error comes
    // last. PostHog reads the first entry as the headline, so it is reversed.
    // A handled error carries its stack on the thread that captured it.
    let currentThreadStack = event.threads?.first(where: { $0.current?.boolValue == true })?.stacktrace
    let sentryExceptions = event.exceptions ?? []
    var exceptions: [ADEAnalyticsExceptionReport.Exception] = sentryExceptions.enumerated().reversed().map { index, exception in
      let stacktrace = exception.stacktrace
        ?? (index == sentryExceptions.count - 1 ? currentThreadStack : nil)
      return ADEAnalyticsExceptionReport.Exception(
        type: exception.type ?? "Error",
        value: exception.value,
        mechanism: exception.mechanism?.type,
        handled: exception.mechanism?.handled?.boolValue ?? true,
        frames: (stacktrace?.frames ?? []).map { frame in
          ADEAnalyticsExceptionReport.Frame(
            module: frame.package ?? frame.module,
            filename: frame.fileName,
            function: frame.function,
            line: frame.lineNumber?.intValue,
            instructionAddress: frame.instructionAddress,
            imageAddress: frame.imageAddress,
            inApp: frame.inApp?.boolValue ?? false
          )
        }
      )
    }
    if exceptions.isEmpty {
      // A captured message: no stack, the scrubbed text is the value.
      guard let message = event.message?.formatted, !message.isEmpty else { return nil }
      exceptions = [.init(type: "Problem", value: message, mechanism: "capture_message", handled: true, frames: [])]
    }
    let fingerprint = event.fingerprint.flatMap { $0.isEmpty ? nil : $0.joined(separator: "|") }
    return ADEAnalyticsExceptionReport(
      exceptions: exceptions,
      level: level,
      fingerprint: fingerprint,
      replaySessionId: SessionReplay.currentSessionId(),
      screen: event.tags?["screen"]
    )
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

/// Hang reports that describe no freeze a person saw, read from the exception
/// Sentry builds:
/// - A non-fatal `App Hang …` lasting over `maxNonFatalAppHangSeconds`. The
///   detector measured the app suspended in the background (reports ran from
///   200 s to 23,000 s); a real freeze that long ends in a watchdog kill, which
///   arrives as the fatal type and is always kept.
/// - A MetricKit `MXHangDiagnostic` under `minMetricKitHangSeconds`: the
///   keyboard and other system work the OS counts as a hang, not one of ours.
/// A value this cannot read is kept.
enum ADEHangReportFilter {
  static let maxNonFatalAppHangSeconds: Double = 60
  static let minMetricKitHangSeconds: Double = 2

  static func isNoise(type: String?, value: String?, isFatal: Bool) -> Bool {
    guard let type, let value else { return false }
    if type == "MXHangDiagnostic" {
      guard let seconds = metricKitHangSeconds(value) else { return false }
      return seconds < minMetricKitHangSeconds
    }
    guard type.contains("App Hang"), !isFatal, !type.hasPrefix("Fatal") else { return false }
    guard let seconds = appHangMinimumSeconds(value) else { return false }
    return seconds > maxNonFatalAppHangSeconds
  }

  /// "App hanging between 235.3 and 236.1 seconds." -> 235.3
  static func appHangMinimumSeconds(_ value: String) -> Double? {
    guard let range = value.range(of: "between ") else { return nil }
    let number = value[range.upperBound...].prefix { $0.isNumber || $0 == "." }
    return Double(number)
  }

  /// "MXHangDiagnostic hangDuration:1.603 sec" -> 1.603. Sentry formats the
  /// OS's measurement in en_US with the unit it came in.
  static func metricKitHangSeconds(_ value: String) -> Double? {
    guard let range = value.range(of: "hangDuration:") else { return nil }
    let parts = value[range.upperBound...].trimmingCharacters(in: .whitespaces)
      .split(separator: " ", maxSplits: 1)
    guard let first = parts.first, let amount = Double(first.replacingOccurrences(of: ",", with: "")) else {
      return nil
    }
    switch parts.count > 1 ? String(parts[1]) : "" {
    case "ms": return amount / 1_000
    case "sec", "s": return amount
    case "min": return amount * 60
    case "hr", "h": return amount * 3_600
    default: return nil
    }
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

/// How often the app's shared models published in the seconds before a hang,
/// and how old the process was then. A view update storm shows as hundreds of
/// publishes a second from one source; a hang at launch shows as a small age.
/// Written on the main thread on every publish (one lock, one add).
///
/// Sentry sends a hang's event after the hang ends, and sends a fatal hang's
/// event from the next launch, so "now" is the wrong moment in both cases. The
/// snapshot is taken at the event's own timestamp (the moment the hang was
/// detected), and an event from before this process started gets none.
final class ADEHangContext {
  static let shared = ADEHangContext()

  /// One-second buckets kept per source: the seconds reported, plus the
  /// longest hang whose start is still in the ring when its event is sent.
  private static let kept = 60
  /// The seconds before the hang that a snapshot reports.
  private static let reported = 10

  private let lock = NSLock()
  private let startedAt = ProcessInfo.processInfo.systemUptime
  private let startedDate = Date()
  private var counts: [String: [Int]] = [:]
  private var newestSecond: [String: Int] = [:]

  func notePublish(_ source: String, uptime: TimeInterval = ProcessInfo.processInfo.systemUptime) {
    let second = Int(uptime)
    lock.lock()
    defer { lock.unlock() }
    var buckets = advanced(source, to: second)
    buckets[second % Self.kept] += 1
    counts[source] = buckets
    newestSecond[source] = second
  }

  /// The context for a hang detected at `date`. Nil when that is before this
  /// process started (a fatal hang, reported by the launch after it).
  func snapshot(at date: Date?, uptime: TimeInterval = ProcessInfo.processInfo.systemUptime) -> [String: Any]? {
    let hangUptime = date.map { startedAt + $0.timeIntervalSince(startedDate) } ?? uptime
    guard hangUptime >= startedAt else { return nil }
    let hangSecond = Int(hangUptime)
    let nowSecond = max(Int(uptime), hangSecond)
    lock.lock()
    defer { lock.unlock() }
    var result: [String: Any] = ["seconds_since_launch": Int(hangUptime - startedAt)]
    // A hang so long that its start has left the ring: the counts are gone.
    guard nowSecond - hangSecond <= Self.kept - Self.reported else { return result }
    var publishes: [String: Any] = [:]
    for source in counts.keys.sorted() {
      let buckets = advanced(source, to: nowSecond)
      let before = (0..<Self.reported).map { buckets[((hangSecond - $0) % Self.kept + Self.kept) % Self.kept] }
      publishes[source] = [
        "last_\(Self.reported)s": before.reduce(0, +),
        "peak_per_second": before.max() ?? 0,
      ]
    }
    result["publishes"] = publishes
    return result
  }

  /// The source's buckets with every second between its newest publish and
  /// `second` emptied, so an old burst does not count as a recent one.
  private func advanced(_ source: String, to second: Int) -> [Int] {
    var buckets = counts[source] ?? Array(repeating: 0, count: Self.kept)
    guard let newest = newestSecond[source] else { return buckets }
    let elapsed = second - newest
    if elapsed >= Self.kept { return Array(repeating: 0, count: Self.kept) }
    if elapsed > 0 {
      for step in 1...elapsed { buckets[(newest + step) % Self.kept] = 0 }
    }
    return buckets
  }
}
