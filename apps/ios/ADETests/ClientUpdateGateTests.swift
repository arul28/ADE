import XCTest
@testable import ADE

// The update gate blocks people from working. The phone judges other
// machines with the desktop's own rule (`clientUpdateGate.test.ts` holds the
// same table), and itself with its install's minimum. Each must block exactly
// the builds below the minimum, and only when an update that meets it exists.
final class ClientUpdateGateTests: XCTestCase {
  private let minimum = ClientMinimum.Desktop(stable: "1.2.131", beta: "1.2.131-beta.2")
  private let latest = (stable: "1.2.131" as String?, beta: "1.2.131-beta.3" as String?)

  func testDesktopRuleMatchesTheDesktopTable() {
    let cases: [(String, String?, ClientMinimum.Desktop?, (stable: String?, beta: String?), Bool)] = [
      ("stable below the minimum", "1.2.130", minimum, latest, true),
      ("stable at the minimum", "1.2.131", minimum, latest, false),
      ("stable above the minimum", "1.2.140", minimum, latest, false),
      ("beta below the beta minimum", "1.2.131-beta.1", minimum, latest, true),
      ("old beta of an older patch", "1.2.130-beta.55", minimum, latest, true),
      ("beta at the beta minimum", "1.2.131-beta.2", minimum, latest, false),
      ("a beta is judged by the beta minimum", "1.2.131-beta.2", .init(stable: "1.2.140", beta: "1.2.131-beta.2"), latest, false),
      ("no minimum for the track", "1.2.100", .init(stable: nil, beta: "1.2.131-beta.2"), latest, false),
      ("no minimum read at all", "1.2.100", nil, latest, false),
      ("minimum ahead of every published build", "1.2.130", .init(stable: "1.2.132", beta: nil), latest, false),
      ("newest build on the track unknown", "1.2.130", minimum, (nil, "1.2.131-beta.3"), false),
      ("newest build is the other track's", "1.2.130", minimum, ("1.2.132-beta.1", nil), false),
      ("alpha build", "1.0.0-beta.1-alpha.202611171957", minimum, latest, false),
      ("dev build", "1.0.0-beta.1", minimum, latest, false),
      ("preview build", "1.2.128-beta.0.preview.7", minimum, latest, false),
      ("release candidate", "1.2.130-rc.1", minimum, latest, false),
      ("no version", nil, minimum, latest, false),
      ("a v prefix and build metadata", "v1.2.130+abc", minimum, latest, true),
      ("10 is newer than 9", "1.2.10", .init(stable: "1.2.9", beta: nil), ("1.2.10", nil), false),
    ]
    for (name, current, minimum, newest, required) in cases {
      let requirement = desktopUpdateRequirement(
        currentVersion: current,
        minimum: minimum,
        latestStable: newest.stable,
        latestBeta: newest.beta
      )
      XCTAssertEqual(requirement != nil, required, name)
    }
  }

  func testDesktopRuleNamesTheBuildThatMeetsTheMinimum() {
    XCTAssertEqual(
      desktopUpdateRequirement(currentVersion: "1.2.130", minimum: minimum, latestStable: latest.stable, latestBeta: latest.beta),
      DesktopUpdateRequirement(isBetaTrack: false, currentVersion: "1.2.130", minimumVersion: "1.2.131", targetVersion: "1.2.131")
    )
  }

  func testPhoneIsBlockedOnlyBelowItsMinimumWithTheUpdateOut() {
    func answer(appStore: String? = "1.2.130", testFlight: Int? = 10070, betaApp: Int? = 20010) -> ClientMinimum {
      ClientMinimum(
        desktop: .init(),
        ios: .init(appStoreVersion: appStore, testFlightBuild: testFlight, betaAppBuild: betaApp),
        links: ClientMinimum.defaultLinks
      )
    }
    let cases: [(String, PhoneInstallSource?, String, String, ClientMinimum?, String?, Bool)] = [
      ("app store below, store has it", .appStore, "1.2.129", "1", answer(), "1.2.130", true),
      ("app store below, store newer still", .appStore, "1.2.129", "1", answer(), "1.2.131", true),
      ("app store at the minimum", .appStore, "1.2.130", "1", answer(), "1.2.130", false),
      ("app store minimum ahead of the store", .appStore, "1.2.129", "1", answer(), "1.2.129", false),
      ("app store lookup failed", .appStore, "1.2.129", "1", answer(), nil, false),
      ("app store with no minimum", .appStore, "1.2.129", "1", answer(appStore: nil), "1.2.130", false),
      ("app store judged by version, not build", .appStore, "1.2.130", "1", answer(testFlight: 99999), "1.2.130", false),
      ("testflight below its build", .testFlight, "1.2.130", "10063", answer(), nil, true),
      ("testflight at its build", .testFlight, "1.2.130", "10070", answer(), nil, false),
      ("testflight judged by its own minimum", .testFlight, "1.2.130", "10063", answer(testFlight: nil, betaApp: 99999), nil, false),
      ("beta app below its build", .betaApp, "1.2.130", "20001", answer(), nil, true),
      ("beta app at its build", .betaApp, "1.2.130", "20010", answer(), nil, false),
      ("an unreadable build", .testFlight, "1.2.130", "1.2.3", answer(), nil, false),
      ("debug or simulator build", nil, "0.0.1", "1", answer(), "1.2.130", false),
      ("no answer read", .appStore, "1.2.129", "1", nil, "1.2.130", false),
    ]
    for (name, source, version, build, minimum, store, blocked) in cases {
      let requirement = phoneUpdateRequirement(
        source: source,
        marketingVersion: version,
        build: build,
        minimum: minimum,
        storeVersion: store
      )
      XCTAssertEqual(requirement != nil, blocked, name)
    }
  }

  func testInstallSourceComesFromTheBundleAndReceipt() {
    XCTAssertEqual(PhoneInstallSource.of(bundleId: "com.ade.ios.beta", receiptName: "sandboxReceipt"), .betaApp)
    XCTAssertEqual(PhoneInstallSource.of(bundleId: "com.ade.ios", receiptName: "sandboxReceipt"), .testFlight)
    XCTAssertEqual(PhoneInstallSource.of(bundleId: "com.ade.ios", receiptName: "receipt"), .appStore)
    XCTAssertNil(PhoneInstallSource.of(bundleId: "dev.someone.ade", receiptName: "receipt"))
  }
}
