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
    let cards = adeUsageLimitCards(provider: "codex", windows: snapshot.windows, accounts: accounts)
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
      accountUrl: nil,
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
    let cards = adeUsageLimitCards(provider: "claude", windows: [window], accounts: [account])
    XCTAssertEqual(cards.first?.segments.first?.account?.email, "solo@example.com")
    XCTAssertEqual(Int((cards.first?.percentLeft ?? 0).rounded()), 60)
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
  }
}
