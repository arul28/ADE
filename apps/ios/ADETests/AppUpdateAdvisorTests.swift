import XCTest
@testable import ADE

final class AppUpdateAdvisorTests: XCTestCase {
  func testComparesDottedVersionsNumerically() {
    XCTAssertEqual(compareAppVersions("1.2.10", "1.2.9"), .orderedDescending)
    XCTAssertEqual(compareAppVersions("1.3.0", "1.10.0"), .orderedAscending)
    XCTAssertEqual(compareAppVersions("2.4", "2.4.0"), .orderedSame)
    XCTAssertEqual(compareAppVersions("1.2.beta", "1.2.1"), .invalid)
  }
}
