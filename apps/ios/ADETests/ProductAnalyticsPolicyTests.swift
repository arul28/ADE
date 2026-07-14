import XCTest
@testable import ADE

final class ProductAnalyticsPolicyTests: XCTestCase {
  private var defaultsSuites: [String] = []

  override func tearDown() {
    for suite in defaultsSuites {
      UserDefaults.standard.removePersistentDomain(forName: suite)
    }
    defaultsSuites.removeAll()
    super.tearDown()
  }

  func testCanonicalEventAllowlistUsesOnlyClosedUnderscoreNames() {
    XCTAssertEqual(
      ProductAnalytics.allowedEventNames,
      Set([
        "ade_mobile_app_opened",
        "ade_mobile_screen_viewed",
        "ade_mobile_feature_used",
        "ade_mobile_error",
        "ade_mobile_analytics_budget",
      ])
    )
    XCTAssertEqual(ADEAnalyticsOutcome.failed.rawValue, "failure")
  }

  func testAnalyticsRequiresConsentAndOptOutStopsCaptureImmediately() {
    let (analytics, sink, _) = makeAnalytics(preference: nil)

    XCTAssertFalse(analytics.isEnabled)
    XCTAssertTrue(analytics.shouldRequestConsent)
    analytics.captureScreen(.work)
    analytics.setEnabled(true)
    XCTAssertFalse(analytics.shouldRequestConsent)
    analytics.captureScreen(.work)
    analytics.setEnabled(false)
    analytics.captureScreen(.lanes)

    XCTAssertEqual(sink.events.map(\.name), ["ade_mobile_screen_viewed"])
    XCTAssertEqual(sink.enabledStates, [true, false])
  }

  func testAppOpenedHasStrictPerEventDailyLimit() {
    let (analytics, sink, _) = makeAnalytics()

    for _ in 0..<20 {
      analytics.captureAppOpened(.foreground)
    }

    XCTAssertEqual(sink.events.count, 3)
    XCTAssertTrue(sink.events.allSatisfy { $0.name == "ade_mobile_app_opened" })
  }

  func testGlobalDailyLimitStopsAllEventTypesAtTwenty() {
    let (analytics, sink, _) = makeAnalytics()

    for _ in 0..<3 {
      analytics.captureAppOpened(.foreground)
    }
    for screen in [
      ADEAnalyticsScreen.hub,
      .work,
      .lanes,
      .pullRequests,
      .files,
      .cto,
      .settings,
      .attentionDrawer,
      .linear,
      .workSession,
    ] {
      analytics.captureScreen(screen)
    }
    analytics.captureFeature(.deepLink, outcome: .opened, source: .sessionLink)
    analytics.captureFeature(.deepLink, outcome: .opened, source: .pullRequestLink)
    analytics.captureFeature(.pairing, outcome: .started)
    analytics.captureFeature(.pairing, outcome: .completed)
    analytics.captureFeature(.pushNotification, outcome: .opened, source: .notification)
    analytics.captureFeature(.voiceDictation, outcome: .started, source: .composer)
    analytics.captureFeature(.voiceDictation, outcome: .completed, source: .composer)

    analytics.captureError(.pairing)

    XCTAssertEqual(sink.events.count, ProductAnalytics.dailyEventLimit)
    XCTAssertFalse(sink.events.contains { $0.name == "ade_mobile_error" })
  }

  func testScreenViewIsDeduplicatedWithinForegroundAndCanRepeatNextForeground() {
    let (analytics, sink, _) = makeAnalytics()

    analytics.captureAppOpened(.coldStart)
    analytics.captureScreen(.work)
    analytics.captureScreen(.work)
    analytics.captureAppOpened(.foreground)
    analytics.captureScreen(.work)

    XCTAssertEqual(
      sink.events.filter { $0.name == "ade_mobile_screen_viewed" }.count,
      2
    )
  }

  func testDailyBudgetSurvivesServiceRestart() {
    let defaults = makeDefaults()
    defaults.set(true, forKey: ProductAnalytics.enabledDefaultsKey)
    let firstSink = ProductAnalyticsTestSink()
    let first = ProductAnalytics(defaults: defaults, sink: firstSink)

    for _ in 0..<4 {
      first.captureAppOpened(.foreground)
    }
    XCTAssertEqual(firstSink.events.count, 3)

    let restartedSink = ProductAnalyticsTestSink()
    let restarted = ProductAnalytics(defaults: defaults, sink: restartedSink)
    restarted.captureAppOpened(.foreground)

    XCTAssertTrue(restartedSink.events.isEmpty)
  }

  func testNextActiveDayEmitsOnePriorDayBudgetSummaryWithinNewCap() throws {
    var currentDate = Date(timeIntervalSince1970: 1_800_000_000)
    let (analytics, sink, _) = makeAnalytics(now: { currentDate })

    for _ in 0..<5 {
      analytics.captureAppOpened(.foreground)
    }
    XCTAssertEqual(sink.events.count, 3)

    currentDate.addTimeInterval(24 * 60 * 60)
    analytics.captureScreen(.work)
    analytics.captureScreen(.lanes)

    let summaries = sink.events.filter { $0.name == "ade_mobile_analytics_budget" }
    let summary = try XCTUnwrap(summaries.first)
    XCTAssertEqual(summaries.count, 1)
    XCTAssertEqual(summary.properties["sent_count"] as? Int, 3)
    XCTAssertEqual(summary.properties["dropped_count"] as? Int, 2)
    XCTAssertEqual(summary.properties["drop_reason"] as? String, "daily_budget")
    XCTAssertEqual(sink.events.suffix(3).map(\.name), [
      "ade_mobile_analytics_budget",
      "ade_mobile_screen_viewed",
      "ade_mobile_screen_viewed",
    ])
  }

  func testFeaturePropertiesAreClosedAndContainNoSensitiveContentKeys() throws {
    let (analytics, sink, _) = makeAnalytics()

    analytics.captureFeature(
      .voiceDictation,
      outcome: .completed,
      source: .globalPill
    )

    let event = try XCTUnwrap(sink.events.first)
    XCTAssertEqual(event.name, "ade_mobile_feature_used")
    XCTAssertEqual(
      Set(event.properties.keys),
      Set([
        "surface",
        "platform",
        "feature",
        "outcome",
        "source",
        "$process_person_profile",
        "$geoip_disable",
      ])
    )
    XCTAssertEqual(event.properties["surface"] as? String, "mobile")
    XCTAssertEqual(event.properties["platform"] as? String, "ios")
    XCTAssertEqual(event.properties["feature"] as? String, "voice_dictation")
    XCTAssertEqual(event.properties["outcome"] as? String, "completed")
    XCTAssertEqual(event.properties["source"] as? String, "global_pill")
    XCTAssertEqual(event.properties["$process_person_profile"] as? Bool, false)
    XCTAssertEqual(event.properties["$geoip_disable"] as? Bool, true)

    let forbiddenKeys = Set([
      "prompt",
      "transcript",
      "project",
      "path",
      "file",
      "terminal",
      "identifier",
      "message",
      "error",
    ])
    XCTAssertTrue(forbiddenKeys.isDisjoint(with: event.properties.keys))
  }

  func testErrorsUseNormalizedSchemaAndAreAlwaysRecoverable() throws {
    let (analytics, sink, _) = makeAnalytics()

    analytics.captureError(.pushRegistration)

    let event = try XCTUnwrap(sink.events.first)
    XCTAssertEqual(event.name, "ade_mobile_error")
    XCTAssertEqual(
      Set(event.properties.keys),
      Set([
        "surface",
        "platform",
        "error_kind",
        "recoverable",
        "$process_person_profile",
        "$geoip_disable",
      ])
    )
    XCTAssertEqual(event.properties["error_kind"] as? String, "push_registration")
    XCTAssertEqual(event.properties["recoverable"] as? Bool, true)
  }

  func testConfigurationRequiresPublicTokenAndHTTPSOrigin() {
    XCTAssertNil(DirectPostHogProductAnalyticsSink.validatedConfiguration(
      projectToken: "phx_personal-secret",
      host: nil
    ))
    XCTAssertNil(DirectPostHogProductAnalyticsSink.validatedConfiguration(
      projectToken: "phc_short",
      host: nil
    ))
    XCTAssertNil(DirectPostHogProductAnalyticsSink.validatedConfiguration(
      projectToken: "phc_public.bad-token",
      host: nil
    ))
    XCTAssertNil(DirectPostHogProductAnalyticsSink.validatedConfiguration(
      projectToken: "phc_public_123",
      host: "http://us.i.posthog.com"
    ))
    XCTAssertNil(DirectPostHogProductAnalyticsSink.validatedConfiguration(
      projectToken: "phc_public_123",
      host: "https://us.i.posthog.com/custom-path"
    ))
    XCTAssertNil(DirectPostHogProductAnalyticsSink.validatedConfiguration(
      projectToken: "phc_public_123",
      host: "not a host"
    ))

    XCTAssertEqual(
      DirectPostHogProductAnalyticsSink.validatedConfiguration(
        projectToken: "phc_public_123",
        host: nil
      )?.endpoint.absoluteString,
      "https://us.i.posthog.com/i/v0/e/"
    )
    XCTAssertEqual(
      DirectPostHogProductAnalyticsSink.validatedConfiguration(
        projectToken: "phc_public_123",
        host: "https://eu.i.posthog.com/"
      )?.endpoint.absoluteString,
      "https://eu.i.posthog.com/i/v0/e/"
    )
  }

  func testMalformedConfigurationIsNetworkInert() {
    let defaults = makeDefaults()
    let factory = ProductAnalyticsTestTransportFactory()
    let sink = DirectPostHogProductAnalyticsSink(
      defaults: defaults,
      transportFactory: { factory.make() }
    )

    sink.configure(projectToken: "phx_personal", host: nil, enabled: true)
    sink.capture(event: "ade_mobile_app_opened", properties: ["entry_point": "cold_start"])
    sink.configure(projectToken: "phc_public_123", host: "http://example.com", enabled: true)
    sink.capture(event: "ade_mobile_app_opened", properties: ["entry_point": "cold_start"])

    XCTAssertTrue(factory.transports.isEmpty)
    XCTAssertNil(defaults.string(forKey: DirectPostHogProductAnalyticsSink.installationIDDefaultsKey))
  }

  func testDirectCapturePayloadHasOnlyAnonymousPrivatePostHogEnvelope() throws {
    let defaults = makeDefaults()
    let factory = ProductAnalyticsTestTransportFactory()
    let sink = DirectPostHogProductAnalyticsSink(
      defaults: defaults,
      transportFactory: { factory.make() }
    )
    sink.configure(
      projectToken: "phc_public-token_123",
      host: "https://eu.i.posthog.com",
      enabled: true
    )

    sink.capture(event: "ade_mobile_screen_viewed", properties: [
      "screen": "work",
      "prompt": "must never leave the device",
      "surface": "desktop",
    ])

    let request = try XCTUnwrap(factory.transports.first?.requests.first)
    XCTAssertEqual(request.url?.absoluteString, "https://eu.i.posthog.com/i/v0/e/")
    XCTAssertEqual(request.httpMethod, "POST")
    XCTAssertEqual(request.timeoutInterval, 5)
    XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
    let body = try XCTUnwrap(request.httpBody)
    let payload = try XCTUnwrap(
      JSONSerialization.jsonObject(with: body) as? [String: Any]
    )
    XCTAssertEqual(
      Set(payload.keys),
      Set(["api_key", "distinct_id", "event", "properties", "uuid"])
    )
    XCTAssertEqual(payload["api_key"] as? String, "phc_public-token_123")
    XCTAssertEqual(payload["event"] as? String, "ade_mobile_screen_viewed")
    XCTAssertNotNil(UUID(uuidString: try XCTUnwrap(payload["distinct_id"] as? String)))
    XCTAssertNotNil(UUID(uuidString: try XCTUnwrap(payload["uuid"] as? String)))

    let properties = try XCTUnwrap(payload["properties"] as? [String: Any])
    XCTAssertEqual(
      Set(properties.keys),
      Set([
        "screen",
        "surface",
        "platform",
        "$process_person_profile",
        "$geoip_disable",
      ])
    )
    XCTAssertEqual(properties["screen"] as? String, "work")
    XCTAssertEqual(properties["surface"] as? String, "mobile")
    XCTAssertEqual(properties["platform"] as? String, "ios")
    XCTAssertEqual(properties["$process_person_profile"] as? Bool, false)
    XCTAssertEqual(properties["$geoip_disable"] as? Bool, true)
  }

  func testOptOutCancelsInFlightWorkAndRotatesAnonymousIDBeforeFutureOptIn() throws {
    let defaults = makeDefaults()
    let factory = ProductAnalyticsTestTransportFactory()
    let sink = DirectPostHogProductAnalyticsSink(
      defaults: defaults,
      transportFactory: { factory.make() }
    )
    sink.configure(projectToken: "phc_public_123", host: nil, enabled: true)
    sink.capture(event: "ade_mobile_app_opened", properties: ["entry_point": "cold_start"])

    let firstTransport = try XCTUnwrap(factory.transports.first)
    let firstID = try distinctID(from: XCTUnwrap(firstTransport.requests.first))
    sink.setEnabled(false)
    sink.capture(event: "ade_mobile_screen_viewed", properties: ["screen": "work"])

    XCTAssertEqual(firstTransport.cancelAllCount, 1)
    XCTAssertEqual(firstTransport.requests.count, 1)
    XCTAssertNil(defaults.string(forKey: DirectPostHogProductAnalyticsSink.installationIDDefaultsKey))

    sink.setEnabled(true)
    sink.capture(event: "ade_mobile_app_opened", properties: ["entry_point": "cold_start"])

    XCTAssertEqual(factory.transports.count, 2)
    let secondID = try distinctID(from: XCTUnwrap(factory.transports[1].requests.first))
    XCTAssertNotEqual(firstID, secondID)
  }

  func testEphemeralTransportDisablesPersistenceAndUsesFiveSecondDeadline() {
    let configuration = DirectProductAnalyticsHTTPTransport.makeSessionConfiguration()

    XCTAssertEqual(configuration.timeoutIntervalForRequest, 5)
    XCTAssertEqual(configuration.timeoutIntervalForResource, 5)
    XCTAssertFalse(configuration.waitsForConnectivity)
    XCTAssertEqual(configuration.requestCachePolicy, .reloadIgnoringLocalCacheData)
    XCTAssertNil(configuration.urlCache)
    XCTAssertNil(configuration.urlCredentialStorage)
    XCTAssertNil(configuration.httpCookieStorage)
    XCTAssertEqual(configuration.httpCookieAcceptPolicy, .never)
    XCTAssertFalse(configuration.httpShouldSetCookies)
    XCTAssertEqual(configuration.identifier, nil)
  }

  private func makeAnalytics(
    now: @escaping () -> Date = Date.init,
    preference: Bool? = true
  ) -> (ProductAnalytics, ProductAnalyticsTestSink, UserDefaults) {
    let defaults = makeDefaults()
    if let preference {
      defaults.set(preference, forKey: ProductAnalytics.enabledDefaultsKey)
    }
    let sink = ProductAnalyticsTestSink()
    return (
      ProductAnalytics(defaults: defaults, now: now, sink: sink),
      sink,
      defaults
    )
  }

  private func makeDefaults() -> UserDefaults {
    let suite = "ProductAnalyticsPolicyTests.\(UUID().uuidString)"
    defaultsSuites.append(suite)
    let defaults = UserDefaults(suiteName: suite)!
    defaults.removePersistentDomain(forName: suite)
    return defaults
  }

  private func distinctID(from request: URLRequest) throws -> String {
    let body = try XCTUnwrap(request.httpBody)
    let payload = try XCTUnwrap(
      JSONSerialization.jsonObject(with: body) as? [String: Any]
    )
    return try XCTUnwrap(payload["distinct_id"] as? String)
  }
}

private final class ProductAnalyticsTestSink: ProductAnalyticsSink {
  struct Event {
    let name: String
    let properties: [String: Any]
  }

  private(set) var events: [Event] = []
  private(set) var enabledStates: [Bool] = []

  var isConfigured: Bool { true }
  var canCapture: Bool { true }

  func capture(event: String, properties: [String: Any]) {
    events.append(Event(name: event, properties: properties))
  }

  func setEnabled(_ enabled: Bool) {
    enabledStates.append(enabled)
  }

  func flush() {}
}

private final class ProductAnalyticsTestTransportFactory {
  private(set) var transports: [ProductAnalyticsTestTransport] = []

  func make() -> ProductAnalyticsHTTPTransport {
    let transport = ProductAnalyticsTestTransport()
    transports.append(transport)
    return transport
  }
}

private final class ProductAnalyticsTestTransport: ProductAnalyticsHTTPTransport {
  private(set) var requests: [URLRequest] = []
  private(set) var cancelAllCount = 0

  func send(_ request: URLRequest) {
    requests.append(request)
  }

  func cancelAll() {
    cancelAllCount += 1
  }
}
