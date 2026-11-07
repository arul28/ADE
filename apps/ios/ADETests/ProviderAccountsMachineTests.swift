import XCTest
@testable import ADE

/// Each machine on the AI accounts page talks only to its own host.
///
/// Logins live on the machine, and account ids repeat across machines (every
/// machine's default is `claude`), so a store or quota reading that leaked from
/// one machine to another would show, or change, the wrong person's account.
@MainActor
final class ProviderAccountsMachineTests: XCTestCase {
  /// A machine at the transport boundary: answers each command from a table
  /// and records what it was asked.
  private final class FakeHost: ProviderAccountsHost {
    var responses: [String: Any]
    private(set) var actions: [String] = []
    private(set) var calls: [(action: String, args: [String: Any])] = []
    init(responses: [String: Any]) { self.responses = responses }
    var supportsProviderAccounts: Bool { true }
    var canChangeProviderAccounts: Bool { true }
    var providerAccountsConnected: Bool { true }
    func runProviderAccountsCommand(_ action: String, args: [String: Any]) async throws -> Any {
      actions.append(action)
      calls.append((action, args))
      guard let response = responses[action] else {
        throw NSError(domain: "test", code: 1, userInfo: [NSLocalizedDescriptionKey: "no \(action)"])
      }
      return response
    }
  }

  private func account(_ id: String, email: String, isDefault: Bool) -> [String: Any] {
    [
      "id": id, "provider": "claude", "label": id, "configHome": "/home/\(id)",
      "isDefault": isDefault, "createdAt": "2026-01-01T00:00:00Z",
      "account": ["email": email], "signedIn": true,
    ]
  }

  func testEachMachineReadsAndChangesOnlyItsOwnAccountsAndQuota() async throws {
    let settings: [String: Any] = ["settings": ["smartBalance": false, "autoStartWindows": false]]
    let studio = FakeHost(responses: [
      "providerAccounts.list": ["instances": [account("claude", email: "studio@example.com", isDefault: true)]],
      "providerAccounts.getSettings": settings,
      "usage.getQuotaSnapshot": [
        "windows": [[
          "provider": "claude", "windowType": "weekly", "percentUsed": 40,
          "resetsAt": "2026-10-09T00:00:00Z", "resetsInMs": 3_600_000, "accountId": "u-studio",
        ]],
        "accounts": [["id": "u-studio", "provider": "claude", "instanceId": "claude", "machines": []]],
        "lastPolledAt": "2026-10-03T00:00:00Z",
        "errors": [],
      ],
    ])
    let laptop = FakeHost(responses: [
      "providerAccounts.list": ["instances": [
        account("claude", email: "laptop@example.com", isDefault: true),
        account("client", email: "client@example.com", isDefault: false),
      ]],
      "providerAccounts.getSettings": settings,
      "providerAccounts.setDefault": ["instance": account("client", email: "client@example.com", isDefault: true)],
      "usage.getQuotaSnapshot": ["windows": [], "lastPolledAt": "2026-10-03T00:00:00Z", "errors": []],
    ])
    let studioMachine = ProviderAccountsMachine(id: "machine:studio", name: "Studio", host: studio)
    let laptopMachine = ProviderAccountsMachine(id: "machine:mbp", name: "Laptop", host: laptop)

    await studioMachine.claude.load()
    await laptopMachine.claude.load()
    await studioMachine.loadQuota()
    await laptopMachine.loadQuota()

    XCTAssertEqual(studioMachine.claude.accounts.map(\.email), ["studio@example.com"])
    XCTAssertEqual(laptopMachine.claude.accounts.map(\.email), ["laptop@example.com", "client@example.com"])

    // Both defaults are `claude`; only the machine that measured it shows a meter.
    let studioDefault = try XCTUnwrap(studioMachine.claude.account(id: "claude"))
    let laptopDefault = try XCTUnwrap(laptopMachine.claude.account(id: "claude"))
    XCTAssertEqual(providerAccountWindows(studioDefault, snapshot: studioMachine.quota).count, 1)
    XCTAssertTrue(providerAccountWindows(laptopDefault, snapshot: laptopMachine.quota).isEmpty)

    let changed = await laptopMachine.claude.makeDefault(id: "client")
    XCTAssertTrue(changed)
    XCTAssertTrue(laptop.actions.contains("providerAccounts.setDefault"))
    XCTAssertFalse(studio.actions.contains("providerAccounts.setDefault"))
  }

  /// An account setting names its account, and an older ADE that accepts the
  /// call but drops the setting is an error, not a menu that shows it saved.
  /// "Use for new chats" turns smart balance off before it moves the default.
  func testAccountSettingsNameTheAccountAndCatchADroppedSetting() async throws {
    var work = account("work", email: "work@example.com", isDefault: false)
    let host = FakeHost(responses: [
      "providerAccounts.list": ["instances": [account("claude", email: "me@example.com", isDefault: true), work]],
      "providerAccounts.getSettings": ["settings": ["smartBalance": true, "autoStartWindows": false]],
      "providerAccounts.setSettings": ["settings": ["smartBalance": false, "autoStartWindows": false]],
      "providerAccounts.setDefault": ["instance": account("work", email: "work@example.com", isDefault: true)],
    ])
    let store = ProviderAccountsMachine(id: "machine:studio", name: "Studio", host: host).claude
    await store.load()

    // The host read back no cache setting: an older ADE dropped it.
    let dropped = await store.setAccountSetting(id: "work", .mainPromptCache("1h"))
    XCTAssertFalse(dropped)
    XCTAssertNotNil(store.errorMessage)
    let sent = try XCTUnwrap(host.calls.last { $0.action == "providerAccounts.setSettings" }?.args)
    XCTAssertEqual(sent["instanceId"] as? String, "work")
    XCTAssertEqual((sent["settings"] as? [String: Any])?["mainPromptCacheTtl"] as? String, "1h")

    // A host that keeps it reports success; nil restores the default as JSON null.
    work["mainPromptCacheTtl"] = "1h"
    host.responses["providerAccounts.list"] = ["instances": [account("claude", email: "me@example.com", isDefault: true), work]]
    let saved = await store.setAccountSetting(id: "work", .mainPromptCache("1h"))
    XCTAssertTrue(saved)
    _ = await store.setAccountSetting(id: "work", .onExtraUsage(nil))
    let cleared = try XCTUnwrap(host.calls.last { $0.action == "providerAccounts.setSettings" }?.args["settings"] as? [String: Any])
    XCTAssertTrue(cleared["onExtraUsage"] is NSNull)

    let used = await store.useForNewChats(id: "work")
    XCTAssertTrue(used)
    let order = host.actions.filter { $0 == "providerAccounts.setSettings" || $0 == "providerAccounts.setDefault" }
    XCTAssertEqual(Array(order.suffix(2)), ["providerAccounts.setSettings", "providerAccounts.setDefault"])
    XCTAssertEqual(store.settings?.smartBalance, false)
  }
}
