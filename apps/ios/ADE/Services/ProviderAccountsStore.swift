import Foundation

// MARK: - Wire models

/// One local Claude or Codex login on the connected machine. Mirrors the
/// desktop's `ProviderInstance`; additive fields decode as absent.
struct ProviderAccount: Codable, Equatable, Identifiable {
  struct Identity: Codable, Equatable {
    var email: String?
    var plan: String?
  }

  struct ReplacedLogin: Codable, Equatable {
    var email: String
    var plan: String?
    var replacedAt: String
  }

  var id: String
  var provider: String
  var label: String
  var configHome: String
  var isDefault: Bool
  var createdAt: String
  var account: Identity?
  var signedIn: Bool
  var loginBroken: Bool?
  var sameLoginAs: String?
  var replacedAccount: ReplacedLogin?

  var email: String? { nonEmpty(account?.email) }
  var plan: String? { nonEmpty(account?.plan) }
  /// The config home names a login, working or not.
  var hasLogin: Bool { signedIn || loginBroken == true }

  private func nonEmpty(_ value: String?) -> String? {
    let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return trimmed.isEmpty ? nil : trimmed
  }
}

struct ProviderAccountSettings: Codable, Equatable {
  var smartBalance: Bool
  var autoStartWindows: Bool
}

/// A sign-in the host is running for one account.
struct ProviderAccountLogin: Codable, Equatable {
  var loginId: String
  var instanceId: String
  var provider: String
  /// running · verifying · succeeded · failed · cancelled
  var state: String
  var url: String?
  var awaitingCode: Bool
  var deviceCode: String?
  var email: String?
  var message: String?
  var startedAt: String
  var endedAt: String?

  var isLive: Bool { state == "running" || state == "verifying" }
}

private struct ProviderAccountListEnvelope: Decodable { var instances: [ProviderAccount] }
private struct ProviderAccountEnvelope: Decodable { var instance: ProviderAccount }
private struct ProviderAccountSettingsEnvelope: Decodable { var settings: ProviderAccountSettings }
private struct ProviderAccountLoginEnvelope: Decodable { var login: ProviderAccountLogin }

enum ProviderAccountProvider: String, CaseIterable, Identifiable {
  case claude
  case codex

  var id: String { rawValue }
  var title: String { self == .claude ? "Claude" : "Codex" }
}

// MARK: - Host calls

extension SyncService {
  /// Whether the connected machine can manage its accounts from this phone.
  var supportsProviderAccounts: Bool { supportsRemoteAction("providerAccounts.list") }
  var canChangeProviderAccounts: Bool { canInvokeRemoteAction("providerAccounts.setDefault") }

  private func providerAccountsCall<T: Decodable>(_ method: String, _ args: [String: Any], as type: T.Type) async throws -> T {
    let action = "providerAccounts.\(method)"
    try requireInvokableRemoteAction(action)
    return try await sendDecodableCommand(
      action: action,
      args: args,
      disconnectOnTimeout: false,
      timeoutNanoseconds: 30_000_000_000,
      as: type
    )
  }

  func listProviderAccounts(_ provider: ProviderAccountProvider) async throws -> [ProviderAccount] {
    try await providerAccountsCall("list", ["provider": provider.rawValue], as: ProviderAccountListEnvelope.self).instances
  }

  func refreshProviderAccounts(_ provider: ProviderAccountProvider, instanceId: String? = nil) async throws -> [ProviderAccount] {
    var args: [String: Any] = ["provider": provider.rawValue]
    if let instanceId { args["instanceId"] = instanceId }
    return try await providerAccountsCall("refresh", args, as: ProviderAccountListEnvelope.self).instances
  }

  func providerAccountSettings(_ provider: ProviderAccountProvider) async throws -> ProviderAccountSettings {
    try await providerAccountsCall("getSettings", ["provider": provider.rawValue], as: ProviderAccountSettingsEnvelope.self).settings
  }

  func setProviderAccountSmartBalance(_ provider: ProviderAccountProvider, enabled: Bool) async throws -> ProviderAccountSettings {
    try await providerAccountsCall(
      "setSettings",
      ["provider": provider.rawValue, "settings": ["smartBalance": enabled]],
      as: ProviderAccountSettingsEnvelope.self
    ).settings
  }

  func createProviderAccount(_ provider: ProviderAccountProvider, label: String) async throws -> ProviderAccount {
    try await providerAccountsCall("create", ["provider": provider.rawValue, "label": label], as: ProviderAccountEnvelope.self).instance
  }

  func removeProviderAccount(id: String) async throws {
    struct Removed: Decodable { var removed: Bool }
    _ = try await providerAccountsCall("remove", ["id": id], as: Removed.self)
  }

  func renameProviderAccount(id: String, label: String) async throws -> ProviderAccount {
    try await providerAccountsCall("rename", ["id": id, "label": label], as: ProviderAccountEnvelope.self).instance
  }

  func setDefaultProviderAccount(id: String) async throws -> ProviderAccount {
    try await providerAccountsCall("setDefault", ["id": id], as: ProviderAccountEnvelope.self).instance
  }

  func dismissReplacedProviderLogin(id: String) async throws -> ProviderAccount {
    try await providerAccountsCall("dismissReplaced", ["id": id], as: ProviderAccountEnvelope.self).instance
  }

  /// Codex signs in with a device code here: its normal sign-in returns to a
  /// localhost port on the machine, which the phone's browser cannot reach.
  func startProviderAccountLogin(id: String, provider: ProviderAccountProvider) async throws -> ProviderAccountLogin {
    try await providerAccountsCall(
      "loginStart",
      ["id": id, "deviceAuth": provider == .codex],
      as: ProviderAccountLoginEnvelope.self
    ).login
  }

  func providerAccountLoginStatus(loginId: String) async throws -> ProviderAccountLogin {
    try await providerAccountsCall("loginStatus", ["loginId": loginId], as: ProviderAccountLoginEnvelope.self).login
  }

  func submitProviderAccountLoginCode(loginId: String, code: String) async throws -> ProviderAccountLogin {
    try await providerAccountsCall("loginSubmitCode", ["loginId": loginId, "code": code], as: ProviderAccountLoginEnvelope.self).login
  }

  func cancelProviderAccountLogin(loginId: String) async throws -> ProviderAccountLogin {
    try await providerAccountsCall("loginCancel", ["loginId": loginId], as: ProviderAccountLoginEnvelope.self).login
  }
}

// MARK: - Store

/// The connected machine's accounts for one provider, plus the actions the
/// Accounts page offers. Every change re-reads the list from the host, so the
/// page never shows a guess.
@MainActor
final class ProviderAccountsStore: ObservableObject {
  @Published private(set) var accounts: [ProviderAccount] = []
  @Published private(set) var settings: ProviderAccountSettings?
  @Published private(set) var loading = false
  @Published private(set) var loaded = false
  @Published var errorMessage: String?
  @Published private(set) var busyAccountId: String?

  let provider: ProviderAccountProvider
  private let syncService: SyncService?

  init(provider: ProviderAccountProvider, syncService: SyncService?) {
    self.provider = provider
    self.syncService = syncService
  }

  #if DEBUG
  /// Fixture screens hand the store its data and never reach a host.
  init(provider: ProviderAccountProvider, accounts: [ProviderAccount], settings: ProviderAccountSettings) {
    self.provider = provider
    self.syncService = nil
    self.accounts = accounts
    self.settings = settings
    self.loaded = true
  }
  #endif

  func load(refresh: Bool = false) async {
    guard let syncService else { return }
    loading = true
    defer { loading = false }
    do {
      async let list = refresh
        ? syncService.refreshProviderAccounts(provider)
        : syncService.listProviderAccounts(provider)
      async let readSettings = syncService.providerAccountSettings(provider)
      let (nextAccounts, nextSettings) = try await (list, readSettings)
      accounts = sortedAccounts(nextAccounts)
      settings = nextSettings
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
    loaded = true
  }

  /// Runs one change, then re-reads the list. Returns whether it worked.
  @discardableResult
  func perform(accountId: String?, _ change: (SyncService) async throws -> Void) async -> Bool {
    guard let syncService else { return false }
    busyAccountId = accountId
    defer { busyAccountId = nil }
    do {
      try await change(syncService)
      accounts = sortedAccounts(try await syncService.listProviderAccounts(provider))
      errorMessage = nil
      return true
    } catch {
      errorMessage = error.localizedDescription
      return false
    }
  }

  func setSmartBalance(_ enabled: Bool) async {
    guard let syncService else {
      settings?.smartBalance = enabled
      return
    }
    let previous = settings
    settings?.smartBalance = enabled
    do {
      settings = try await syncService.setProviderAccountSmartBalance(provider, enabled: enabled)
      errorMessage = nil
    } catch {
      settings = previous
      errorMessage = error.localizedDescription
    }
  }

  func create(label: String) async -> ProviderAccount? {
    guard let syncService else { return nil }
    do {
      let created = try await syncService.createProviderAccount(provider, label: label)
      accounts = sortedAccounts(try await syncService.listProviderAccounts(provider))
      errorMessage = nil
      return created
    } catch {
      errorMessage = error.localizedDescription
      return nil
    }
  }

  func account(id: String) -> ProviderAccount? {
    accounts.first { $0.id == id }
  }

  /// Default first, then the order the accounts were added.
  private func sortedAccounts(_ list: [ProviderAccount]) -> [ProviderAccount] {
    list.sorted { lhs, rhs in
      if lhs.isDefault != rhs.isDefault { return lhs.isDefault }
      return lhs.createdAt < rhs.createdAt
    }
  }
}
