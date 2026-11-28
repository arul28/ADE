import XCTest
@testable import ADE

/// How long the credits left last at a size or on one computer, at the price
/// the account pays now (Pricing v3), as the desktop's "Left at this size"
/// counts it. A wrong number here tells a person their credits run out
/// sooner (or later) than they do.
final class CloudHoursAtPriceTests: XCTestCase {
  private static func tier(_ id: String, full: Int, ad: Int?) -> CloudPhoneTier {
    CloudPhoneTier(id: id, label: id.capitalized, type: "default", cpu: 4, memoryGb: 8, multiplierMilli: full, diskMaxGb: nil, adMultiplierMilli: ad)
  }

  private static func pricing(available: Bool = true, on: Bool, computers: [CloudPricingState.Price] = []) -> CloudPricingState {
    CloudPricingState(
      creditScale: 10,
      ads: .init(available: available, on: on, startsOn: false, noticeSeen: true, discountPct: 20, windowMinutes: 60),
      computers: computers
    )
  }

  func testTimeLeftCountsThePricePaidNow() {
    // Medium: 10 credits an hour, 8 with ads. 416 credits = 41_600.
    let medium = Self.tier("medium", full: 1000, ad: 800)
    let freeSmall = Self.tier("small", full: 500, ad: 0)
    let keptFull = CloudPricingState.Price(now: "full", reason: "x", rateMilli: 1000, otherRateMilli: 800, instanceId: "kept")
    let atAd = CloudPricingState.Price(now: "ad", reason: nil, rateMilli: 800, otherRateMilli: 1000, instanceId: "ad")
    let cases: [(name: String, shown: String, expected: String)] = [
      ("Free, ads on, Medium", medium.atPriceNow(Self.pricing(on: true)).hoursLeftLabel(41_600), "52\u{00A0}h"),
      ("Free, ads on, Small free with ads", freeSmall.atPriceNow(Self.pricing(on: true)).hoursLeftLabel(41_600), "Unlimited"),
      ("Free, ads off, Small uses credits", freeSmall.atPriceNow(Self.pricing(on: false)).hoursLeftLabel(41_600), "83\u{00A0}h"),
      ("Pro, ads on, Medium", medium.atPriceNow(Self.pricing(on: true)).hoursLeftLabel(500_000), "625\u{00A0}h"),
      ("Pricing v3 off: unchanged", medium.atPriceNow(nil).hoursLeftLabel(41_600), "41\u{00A0}h"),
      ("ads off", medium.atPriceNow(Self.pricing(on: false)).hoursLeftLabel(41_600), "41\u{00A0}h"),
      ("no ads in this country", medium.atPriceNow(Self.pricing(available: false, on: true)).hoursLeftLabel(41_600), "41\u{00A0}h"),
      ("a computer kept at the full price while ads are on",
       medium.atComputerPriceNow(Self.pricing(on: true, computers: [keptFull]), instanceId: "kept").hoursLeftLabel(41_600), "41\u{00A0}h"),
      ("a computer at the ad price",
       medium.atComputerPriceNow(Self.pricing(on: true, computers: [atAd]), instanceId: "ad").hoursLeftLabel(41_600), "52\u{00A0}h"),
      ("a computer the server lists no price for: the size's price now",
       medium.atComputerPriceNow(Self.pricing(on: true), instanceId: "other").hoursLeftLabel(41_600), "52\u{00A0}h"),
      ("Pricing v3 off, one computer: unchanged", medium.atComputerPriceNow(nil, instanceId: "kept").hoursLeftLabel(41_600), "41\u{00A0}h"),
    ]
    for item in cases {
      XCTAssertEqual(item.shown, item.expected, item.name)
    }
  }
}
