import XCTest
@testable import ADE

/// The account identity the host stamps onto each provider's quota status.
///
/// `accountEmail` and `accountUrl` are additive fields: a phone paired to an
/// older host must decode the snapshot exactly as before and simply show no
/// email line and no external link.
final class UsageQuotaAccountDecodingTests: XCTestCase {
  private func decode(_ json: String) throws -> MobileUsageQuotaSnapshot {
    try JSONDecoder().decode(MobileUsageQuotaSnapshot.self, from: Data(json.utf8))
  }

  func testDecodesAccountEmailAndLimitsUrlPerProvider() throws {
    let snapshot = try decode("""
    {
      "windows": [{
        "provider": "codex",
        "windowType": "five_hour",
        "percentUsed": 42,
        "resetsAt": "2026-09-10T19:00:00.000Z",
        "resetsInMs": 3600000
      }],
      "providerStatus": {
        "claude": {
          "state": "ok",
          "source": "oauth",
          "accountEmail": "dev@example.com",
          "accountUrl": "https://claude.ai/new#settings/usage"
        },
        "codex": {
          "state": "ok",
          "source": "http",
          "accountEmail": "dev@example.com",
          "accountUrl": "https://chatgpt.com/codex/cloud/settings/analytics#usage"
        }
      },
      "lastPolledAt": "2026-09-10T18:00:00.000Z",
      "errors": []
    }
    """)

    XCTAssertEqual(snapshot.providerStatus?["claude"]?.accountEmail, "dev@example.com")
    XCTAssertEqual(
      snapshot.providerStatus?["codex"]?.accountUrl,
      "https://chatgpt.com/codex/cloud/settings/analytics#usage"
    )
  }

  func testOlderHostWithoutAccountFieldsStillDecodes() throws {
    let snapshot = try decode("""
    {
      "windows": [],
      "providerStatus": { "claude": { "state": "ok", "source": "cli" } },
      "lastPolledAt": "2026-09-10T18:00:00.000Z",
      "errors": []
    }
    """)

    XCTAssertNil(snapshot.providerStatus?["claude"]?.accountEmail)
    XCTAssertNil(snapshot.providerStatus?["claude"]?.accountUrl)
    XCTAssertEqual(snapshot.providerStatus?["claude"]?.state, "ok")
  }

  func testDecodesPooledAccountsAndPerWindowAttribution() throws {
    let snapshot = try decode("""
    {
      "windows": [
        {
          "provider": "codex",
          "windowType": "weekly",
          "percentUsed": 100,
          "resetsAt": "2026-09-16T12:00:00.000Z",
          "resetsInMs": 518400000,
          "accountId": "codex:a@example.com"
        },
        {
          "provider": "codex",
          "windowType": "weekly",
          "percentUsed": 3,
          "resetsAt": "2026-09-16T19:00:00.000Z",
          "resetsInMs": 543600000,
          "accountId": "codex:b@example.com"
        }
      ],
      "accounts": [
        {
          "id": "codex:a@example.com",
          "provider": "codex",
          "email": "a@example.com",
          "plan": "ChatGPT Pro",
          "machines": [{ "label": "studio", "checkedAt": "2026-09-10T11:00:00.000Z" }]
        },
        {
          "id": "codex:b@example.com",
          "provider": "codex",
          "email": "b@example.com",
          "machines": [{ "label": "nucbox-1" }]
        }
      ],
      "lastPolledAt": "2026-09-10T12:00:00.000Z",
      "errors": []
    }
    """)

    let accounts = adeUsagePoolAccounts(snapshot.accounts)
    XCTAssertEqual(accounts.map(\.initials), ["A", "B"])
    // Fixed clock: countdowns are derived from `resetsAt` against the current
    // time, so the forecast below is only deterministic with `now` pinned.
    let now = try XCTUnwrap(adeUsageParseISODate("2026-09-10T12:00:00.000Z"))
    let cards = adeUsageLimitCards(
      provider: "codex",
      windows: snapshot.windows,
      accounts: accounts,
      now: now
    )
    XCTAssertEqual(cards.count, 1)
    let card = try XCTUnwrap(cards.first)
    // Two accounts, one exhausted: the pooled card reads 49% left and the next
    // reset returns that account's whole half of the pool.
    XCTAssertEqual(Int(card.percentLeft.rounded()), 49)
    XCTAssertEqual(Int((card.forecast?.percent ?? 0).rounded()), 50)
    XCTAssertEqual(card.forecast?.resetsInMs, 518_400_000)
    XCTAssertEqual(card.segments.map { Int($0.percentLeft.rounded()) }, [0, 97])
    XCTAssertEqual(card.segments.first?.account?.plan, "ChatGPT Pro")
  }

  func testAccountInitialsAndSingleAccountFallback() {
    XCTAssertEqual(adeUsageAccountInitials(email: "first.last@example.com"), "FL")
    XCTAssertEqual(adeUsageAccountInitials(email: "dev@example.com"), "DE")
    XCTAssertEqual(adeUsageAccountInitials(email: nil, fallback: "nucbox-1"), "NU")
    XCTAssertEqual(adeUsageAccountInitials(email: nil), "··")

    // One account and a host that does not attribute windows: the lone account
    // still owns the card's only segment.
    let account = ADEUsageAccountView(
      id: "claude:solo",
      provider: "claude",
      email: "solo@example.com",
      plan: nil,
      machines: [MobileUsageAccountMachine(machineKey: nil, label: "studio", checkedAt: nil)],
      url: nil,
      initials: "SO"
    )
    let window = MobileUsageQuotaWindow(
      provider: "claude",
      windowType: "weekly",
      percentUsed: 40,
      resetsAt: "2026-09-16T12:00:00.000Z",
      resetsInMs: 3_600_000,
      windowDurationMs: nil,
      accountId: nil
    )
    // Pinned: headroom is read against the clock, so an implicit `Date()` would
    // turn this into a test that changes its answer once the window resets.
    let now = adeUsageParseISODate("2026-09-10T12:00:00.000Z") ?? Date()
    let cards = adeUsageLimitCards(
      provider: "claude",
      windows: [window],
      accounts: [account],
      now: now
    )
    XCTAssertEqual(cards.first?.segments.first?.account?.email, "solo@example.com")
    XCTAssertEqual(Int((cards.first?.percentLeft ?? 0).rounded()), 60)
  }

  /// A cached snapshot can outlive the window it describes. Desktop and the CLI
  /// zero such a window (`displayPercent`); the phone has to agree, or the same
  /// account reads "3% left" on iOS and "100% left" on the Mac.
  func testWindowPastItsResetReadsAsRefilled() throws {
    let now = try XCTUnwrap(adeUsageParseISODate("2026-09-10T12:00:00.000Z"))
    let expired = MobileUsageQuotaWindow(
      provider: "codex",
      windowType: "five_hour",
      percentUsed: 97,
      // Ten minutes in the past: the provider has already refilled this one.
      resetsAt: "2026-09-10T11:50:00.000Z",
      resetsInMs: 600_000,
      windowDurationMs: 18_000_000,
      accountId: nil
    )

    XCTAssertEqual(adeUsageDisplayPercentUsed(expired, now: now), 0)
    XCTAssertEqual(adeUsageDisplayPercentLeft(expired, now: now), 100)

    let cards = adeUsageLimitCards(provider: "codex", windows: [expired], accounts: [], now: now)
    XCTAssertEqual(Int((cards.first?.percentLeft ?? 0).rounded()), 100)
    XCTAssertEqual(Int((cards.first?.percentUsed ?? 0).rounded()), 0)
    XCTAssertEqual(cards.first?.segments.map { Int($0.percentLeft.rounded()) }, [100])

    let pace = try XCTUnwrap(adeUsageWindowPace(expired, now: now))
    XCTAssertEqual(pace.paceDelta, -100, accuracy: 0.0001)
    XCTAssertNil(pace.dryInMs)

    // Still inside the window, the reported fill is untouched.
    let live = MobileUsageQuotaWindow(
      provider: "codex",
      windowType: "five_hour",
      percentUsed: 97,
      resetsAt: "2026-09-10T12:10:00.000Z",
      resetsInMs: 600_000,
      windowDurationMs: 18_000_000,
      accountId: nil
    )
    XCTAssertEqual(adeUsageDisplayPercentUsed(live, now: now), 97)
    XCTAssertEqual(adeUsageDisplayPercentLeft(live, now: now), 3)

    // An unparsable `resetsAt` says nothing about the current clock, so the
    // last known fill stands rather than inventing a refill.
    let unparsable = MobileUsageQuotaWindow(
      provider: "codex",
      windowType: "five_hour",
      percentUsed: 97,
      resetsAt: "not-a-date",
      resetsInMs: 0,
      windowDurationMs: 18_000_000,
      accountId: nil
    )
    XCTAssertEqual(adeUsageDisplayPercentUsed(unparsable, now: now), 97)
  }

  /// Pace is a rate read against the CURRENT clock, so it takes the same `now`
  /// the card builder does. Pinning it is what makes the numbers below assertable
  /// at all — with an implicit `Date()` this test would drift every run.
  func testWindowPaceIsMeasuredAgainstTheSuppliedClock() throws {
    let now = try XCTUnwrap(adeUsageParseISODate("2026-09-10T12:00:00.000Z"))
    let window = MobileUsageQuotaWindow(
      provider: "codex",
      windowType: "five_hour",
      percentUsed: 75,
      // Half of the 5-hour window is left, so an even burn would be at 50%.
      resetsAt: "2026-09-10T14:30:00.000Z",
      resetsInMs: 1,
      windowDurationMs: 18_000_000,
      accountId: nil
    )

    let pace = try XCTUnwrap(adeUsageWindowPace(window, now: now))
    XCTAssertEqual(pace.elapsedFraction, 0.5, accuracy: 0.0001)
    XCTAssertEqual(pace.paceDelta, 25, accuracy: 0.0001)
    XCTAssertEqual(pace.resetsInMs, 9_000_000, accuracy: 1)
    // 25 points of headroom at 75 points per 2.5h runs dry in 50 minutes.
    XCTAssertEqual(try XCTUnwrap(pace.dryInMs), 3_000_000, accuracy: 1)
    XCTAssertTrue(pace.isAheadOfPace)
  }

  /// The cached copy on disk is written with `JSONEncoder`, so a round trip has
  /// to preserve the two new fields or the email disappears on cold launch.
  func testAccountFieldsSurviveTheLocalCacheRoundTrip() throws {
    let original = MobileUsageQuotaSnapshot(
      windows: [],
      accounts: nil,
      providerStatus: [
        "claude": MobileUsageProviderStatus(
          state: "ok",
          lastSuccessAt: nil,
          source: "oauth",
          updatedAt: nil,
          lastAttemptAt: nil,
          errorKind: nil,
          nextRetryAt: nil,
          message: nil,
          accountEmail: "dev@example.com",
          accountPlan: "Claude Max",
          accountUrl: "https://claude.ai/new#settings/usage"
        ),
      ],
      lastPolledAt: "2026-09-10T18:00:00.000Z",
      errors: [],
      spendControlReached: nil
    )

    let data = try JSONEncoder().encode(original)
    let restored = try JSONDecoder().decode(MobileUsageQuotaSnapshot.self, from: data)
    XCTAssertEqual(restored, original)
    XCTAssertEqual(restored.providerStatus?["claude"]?.accountEmail, "dev@example.com")
    XCTAssertEqual(restored.providerStatus?["claude"]?.accountPlan, "Claude Max")
  }

  /// Host timestamps arrive in both ISO shapes. Parsing `checkedAt` with the
  /// plain formatter alone returned `nil` for fractional seconds, collapsing
  /// freshness to 0 so the pooled machine list stopped sorting by recency.
  func testPooledMachinesSortByRecencyAcrossBothISOShapes() throws {
    let accounts = [
      MobileUsageAccount(
        id: "claude:dev@example.com",
        provider: "claude",
        email: "dev@example.com",
        plan: "Claude Max",
        machines: [
          MobileUsageAccountMachine(machineKey: "a", label: "Mac mini", checkedAt: "2026-09-10T10:00:00Z"),
          MobileUsageAccountMachine(machineKey: "b", label: "MacBook", checkedAt: "2026-09-10T12:00:00.250Z"),
          MobileUsageAccountMachine(machineKey: "c", label: "Studio", checkedAt: nil),
        ],
        url: nil
      ),
    ]

    let pooled = adeUsagePoolAccounts(accounts)
    XCTAssertEqual(pooled.count, 1)
    XCTAssertEqual(pooled.first?.machines.map(\.label), ["MacBook", "Mac mini", "Studio"])
  }
}
