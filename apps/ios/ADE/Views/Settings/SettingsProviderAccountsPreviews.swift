import SwiftUI

#if DEBUG
/// `-adePreviewScreen accounts | account-detail | account-add | account-signin-claude |
/// account-signin-codex | account-signin-done`: the AI accounts screens from fixtures.
enum ProviderAccountsPreviewData {
  static let accounts: [ProviderAccount] = [
    ProviderAccount(
      id: "claude", provider: "claude", label: "Personal",
      configHome: "/Users/arul/.claude", isDefault: true, createdAt: "2026-01-01T00:00:00Z",
      account: .init(email: "arul@gmail.com", plan: "max"), signedIn: true
    ),
    ProviderAccount(
      id: "work", provider: "claude", label: "Work",
      configHome: "/Users/arul/.ade/provider-homes/claude/work", isDefault: false, createdAt: "2026-02-01T00:00:00Z",
      account: .init(email: "arul@versic.dev", plan: "max"), signedIn: true
    ),
    ProviderAccount(
      id: "beats", provider: "claude", label: "Beats",
      configHome: "/Users/arul/.ade/provider-homes/claude/beats", isDefault: false, createdAt: "2026-03-01T00:00:00Z",
      account: .init(email: "beats@arul.dev", plan: "pro"), signedIn: false, loginBroken: true
    ),
    ProviderAccount(
      id: "spare", provider: "claude", label: "Spare",
      configHome: "/Users/arul/.ade/provider-homes/claude/spare", isDefault: false, createdAt: "2026-04-01T00:00:00Z",
      account: nil, signedIn: false
    ),
  ]

  static let settings = ProviderAccountSettings(smartBalance: true, autoStartWindows: false)

  static func snapshot() -> MobileUsageQuotaSnapshot {
    let now = Date()
    func iso(_ hours: Double) -> String { ISO8601DateFormatter().string(from: now.addingTimeInterval(hours * 3600)) }
    func window(_ account: String, _ type: String, used: Double, hours: Double, duration: Double) -> MobileUsageQuotaWindow {
      MobileUsageQuotaWindow(
        provider: "claude", windowType: type, percentUsed: used, resetsAt: iso(hours),
        resetsInMs: hours * 3_600_000, windowDurationMs: duration * 3_600_000, accountId: account
      )
    }
    return MobileUsageQuotaSnapshot(
      windows: [
        window("u-personal", "five_hour", used: 38, hours: 2.4, duration: 5),
        window("u-personal", "weekly", used: 71, hours: 70, duration: 168),
        window("u-work", "five_hour", used: 12, hours: 4.1, duration: 5),
        window("u-work", "weekly", used: 88, hours: 19, duration: 168),
      ],
      accounts: [
        MobileUsageAccount(id: "u-personal", provider: "claude", email: "arul@gmail.com", plan: "max", instanceId: "claude", machines: [], url: nil),
        MobileUsageAccount(id: "u-work", provider: "claude", email: "arul@versic.dev", plan: "max", instanceId: "work", machines: [], url: nil),
      ],
      providerStatus: nil,
      lastPolledAt: iso(0),
      errors: [],
      spendControlReached: nil,
      balanceNext: [MobileUsageBalanceNext(provider: "claude", instanceId: "work")]
    )
  }

  static func login(provider: String, awaitingCode: Bool = false, deviceCode: String? = nil, state: String = "running") -> ProviderAccountLogin {
    ProviderAccountLogin(
      loginId: "login-1", instanceId: provider == "codex" ? "codex" : "work", provider: provider, state: state,
      url: "https://claude.ai/oauth/authorize?code=true", awaitingCode: awaitingCode, deviceCode: deviceCode,
      email: state == "succeeded" ? "arul@versic.dev" : nil, message: nil,
      startedAt: "2026-10-03T00:00:00Z", endedAt: nil
    )
  }
}

struct ProviderAccountsPreviewHost: View {
  enum Screen { case list, detail, add, signInClaude, signInCodex, signInDone }
  let screen: Screen
  @State private var provider: ProviderAccountProvider = .claude
  @StateObject private var store = ProviderAccountsStore(
    provider: .claude,
    accounts: ProviderAccountsPreviewData.accounts,
    settings: ProviderAccountsPreviewData.settings
  )

  init(screen: Screen) {
    self.screen = screen
    MobileUsageQuotaStore.shared.pinPreviewSnapshot(ProviderAccountsPreviewData.snapshot())
  }

  var body: some View {
    switch screen {
    case .list:
      NavigationStack {
        ProviderAccountsScreen(provider: $provider, store: store, hostName: "Arul’s Mac Studio")
          .navigationTitle("AI accounts")
          .navigationBarTitleDisplayMode(.inline)
      }
    case .detail:
      NavigationStack {
        ProviderAccountDetailPage(store: store, accountId: "work", hostName: "Arul’s Mac Studio")
      }
    case .add:
      ProviderAccountAddSheet(provider: .claude) { _ in nil }
    case .signInClaude:
      ProviderAccountSignInSheet(controller: ProviderAccountSignInController(
        account: ProviderAccountsPreviewData.accounts[1],
        fixture: ProviderAccountsPreviewData.login(provider: "claude", awaitingCode: true)
      ))
    case .signInCodex:
      ProviderAccountSignInSheet(controller: ProviderAccountSignInController(
        account: ProviderAccount(
          id: "codex", provider: "codex", label: "Default", configHome: "/Users/arul/.codex",
          isDefault: true, createdAt: "", account: nil, signedIn: false
        ),
        fixture: ProviderAccountsPreviewData.login(provider: "codex", deviceCode: "K7QF-29XM")
      ))
    case .signInDone:
      ProviderAccountSignInSheet(controller: ProviderAccountSignInController(
        account: ProviderAccountsPreviewData.accounts[1],
        fixture: ProviderAccountsPreviewData.login(provider: "claude", state: "succeeded")
      ))
    }
  }
}
#endif
