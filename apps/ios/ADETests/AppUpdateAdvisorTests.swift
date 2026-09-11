import XCTest
@testable import ADE

final class AppUpdateAdvisorTests: XCTestCase {
  /// The Settings "Check for updates" button must actually issue a lookup.
  ///
  /// `ADEApp` checks on launch AND on every foreground, so the six-hour window
  /// is effectively always armed — an unforced check from Settings returned
  /// without touching anything, leaving a control that could never run.
  @MainActor
  func testForcedCheckBypassesTheThrottleWindowAndAutomaticChecksDoNot() async {
    let suiteName = "ade.appUpdateAdvisor.tests.\(UUID().uuidString)"
    guard let defaults = UserDefaults(suiteName: suiteName) else {
      return XCTFail("Could not create an isolated defaults suite.")
    }
    defer { defaults.removePersistentDomain(forName: suiteName) }

    // Inside the window: an attempt was recorded one minute ago.
    let recent = Date(timeIntervalSince1970: 1_800_000_000)
    defaults.set(recent, forKey: AppUpdateAdvisor.lastCheckKey)

    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [AppUpdateAdvisorStubProtocol.self]
    AppUpdateAdvisorStubProtocol.requestCount = 0
    defer { AppUpdateAdvisorStubProtocol.requestCount = 0 }

    let advisor = AppUpdateAdvisor(
      defaults: defaults,
      session: URLSession(configuration: configuration),
      bundleIdentifier: "dev.ade.test",
      currentVersion: "1.0.0",
      now: { recent.addingTimeInterval(60) }
    )

    // The automatic path stays throttled: no request, and the stamp is intact.
    await advisor.checkForUpdates()
    XCTAssertEqual(AppUpdateAdvisorStubProtocol.requestCount, 0)
    XCTAssertEqual(defaults.object(forKey: AppUpdateAdvisor.lastCheckKey) as? Date, recent)

    // The user-triggered path runs anyway.
    await advisor.checkForUpdates(force: true)
    XCTAssertEqual(AppUpdateAdvisorStubProtocol.requestCount, 1)
    XCTAssertNotEqual(defaults.object(forKey: AppUpdateAdvisor.lastCheckKey) as? Date, recent)
  }

  func testComparesDottedVersionsNumerically() {
    XCTAssertEqual(compareAppVersions("1.2.10", "1.2.9"), .orderedDescending)
    XCTAssertEqual(compareAppVersions("1.3.0", "1.10.0"), .orderedAscending)
    XCTAssertEqual(compareAppVersions("2.4", "2.4.0"), .orderedSame)
    XCTAssertEqual(compareAppVersions("1.2.beta", "1.2.1"), .invalid)
  }
}

/// Counts lookups without touching the network. The advisor swallows every
/// failure, so an empty body is a perfectly good stand-in for a response.
private final class AppUpdateAdvisorStubProtocol: URLProtocol {
  nonisolated(unsafe) static var requestCount = 0

  override class func canInit(with request: URLRequest) -> Bool {
    requestCount += 1
    return true
  }

  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    let response = HTTPURLResponse(
      url: request.url ?? URL(string: "https://itunes.apple.com/lookup")!,
      statusCode: 200,
      httpVersion: nil,
      headerFields: nil
    )!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data("{\"results\":[]}".utf8))
    client?.urlProtocolDidFinishLoading(self)
  }

  override func stopLoading() {}
}
