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
  enum Screen { case list, otherMachine, detail, add, signInClaude, signInCodex, signInDone }
  let screen: Screen
  @State private var provider: ProviderAccountProvider = .claude
  @State private var selectedMachineId: String
  @StateObject private var studio = ProviderAccountsMachine(
    id: "machine:studio",
    name: "Arul’s Mac Studio",
    claude: ProviderAccountsStore(provider: .claude, accounts: ProviderAccountsPreviewData.accounts, settings: ProviderAccountsPreviewData.settings),
    codex: ProviderAccountsStore(provider: .codex, accounts: [], settings: ProviderAccountsPreviewData.settings),
    quota: ProviderAccountsPreviewData.snapshot()
  )
  // A second machine has its own logins: the same default id (`claude`), a
  // different person, and no quota readings yet.
  @StateObject private var laptop = ProviderAccountsMachine(
    id: "machine:mbp",
    name: "MacBook Pro",
    claude: ProviderAccountsStore(
      provider: .claude,
      accounts: [
        ProviderAccount(
          id: "claude", provider: "claude", label: "Default", configHome: "/Users/arul/.claude",
          isDefault: true, createdAt: "2026-01-01T00:00:00Z", account: .init(email: "arul@school.edu", plan: "pro"), signedIn: true
        ),
        ProviderAccount(
          id: "client", provider: "claude", label: "Client", configHome: "/Users/arul/.ade/provider-homes/claude/client",
          isDefault: false, createdAt: "2026-05-01T00:00:00Z", account: .init(email: "arul@client.co", plan: "max"), signedIn: true
        ),
      ],
      settings: ProviderAccountSettings(smartBalance: false, autoStartWindows: false)
    ),
    codex: ProviderAccountsStore(provider: .codex, accounts: [], settings: ProviderAccountSettings(smartBalance: false, autoStartWindows: false)),
    quota: nil
  )

  init(screen: Screen) {
    self.screen = screen
    _selectedMachineId = State(initialValue: screen == .otherMachine ? "machine:mbp" : "machine:studio")
  }

  private var machines: [ProviderAccountsMachineOption] {
    [
      ProviderAccountsMachineOption(id: "machine:studio", name: "Arul’s Mac Studio", isPrimary: true),
      ProviderAccountsMachineOption(id: "machine:mbp", name: "MacBook Pro", isPrimary: false),
    ]
  }

  var body: some View {
    switch screen {
    case .list, .otherMachine:
      let machine = selectedMachineId == laptop.id ? laptop : studio
      NavigationStack {
        ProviderAccountsScreen(
          provider: $provider,
          machine: machine,
          store: machine.store(for: provider),
          machines: machines,
          selectedMachineId: $selectedMachineId
        )
        .id(machine.id)
        .navigationTitle("AI accounts")
        .navigationBarTitleDisplayMode(.inline)
      }
    case .detail:
      NavigationStack {
        ProviderAccountDetailPage(machine: studio, store: studio.claude, accountId: "work")
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
