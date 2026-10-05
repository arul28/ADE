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

  /// Codex signs in from the phone with a device code; Claude shows a code to
  /// paste back. See `ProviderAccountsClient.startLogin`.
  var usesDeviceCode: Bool { self == .codex }

  var signInSubtitle: String {
    usesDeviceCode
      ? "Approve this \(title) login in your browser with a one-time code."
      : "Approve this \(title) login in your browser, then paste the code it shows."
  }

  var signInSteps: [String] {
    [
      "Open the sign-in page",
      usesDeviceCode ? "Paste the code on the page" : "Paste the code it gives you",
      "ADE checks the login",
    ]
  }
}

// MARK: - Host calls

/// A machine the phone can manage accounts on: the primary connection
/// (`SyncService`) or the light roster connection to another paired machine
/// (`MachineConnection`). The account commands are machine-wide (runtime
/// scope), so they need no project on either.
@MainActor
protocol ProviderAccountsHost: AnyObject {
  /// The machine advertises the account commands.
  var supportsProviderAccounts: Bool { get }
  /// The phone may change accounts there now (connected, and a controller).
  var canChangeProviderAccounts: Bool { get }
  /// A dropped connection, as opposed to a host that answered with an error.
  var providerAccountsConnected: Bool { get }
  func runProviderAccountsCommand(_ action: String, args: [String: Any]) async throws -> Any
}

private let providerAccountsCommandTimeout: UInt64 = 30_000_000_000

extension SyncService: ProviderAccountsHost {
  var supportsProviderAccounts: Bool { supportsRemoteAction("providerAccounts.list") }
  var canChangeProviderAccounts: Bool { canInvokeRemoteAction("providerAccounts.setDefault") }
  var providerAccountsConnected: Bool { connectionState == .connected }

  func runProviderAccountsCommand(_ action: String, args: [String: Any]) async throws -> Any {
    try requireInvokableRemoteAction(action)
    let response = try await sendCommand(
      action: action,
      args: args,
      disconnectOnTimeout: false,
      timeoutNanoseconds: providerAccountsCommandTimeout
    )
    if let payload = response as? [String: Any], payload["queued"] as? Bool == true {
      throw QueuedRemoteCommandError(action: action)
    }
    return response
  }
}

extension MachineConnection: ProviderAccountsHost {
  var supportsProviderAccounts: Bool { supportsAction("providerAccounts.list") }
  var canChangeProviderAccounts: Bool { phase == .live && supportsAction("providerAccounts.setDefault") }
  var providerAccountsConnected: Bool { phase == .live }

  func runProviderAccountsCommand(_ action: String, args: [String: Any]) async throws -> Any {
    guard phase == .live else {
      throw NSError(domain: "ADE", code: 15, userInfo: [NSLocalizedDescriptionKey: "\(hostName ?? "This machine") is not connected right now."])
    }
    guard supportsAction(action) else {
      throw NSError(domain: "ADE", code: 15, userInfo: [NSLocalizedDescriptionKey: "\(hostName ?? "This machine") runs an ADE that cannot do this from the phone yet."])
    }
    return try await sendCommand(
      action: action,
      args: args,
      projectId: nil,
      projectRootPath: nil,
      timeoutNanoseconds: providerAccountsCommandTimeout
    )
  }
}

/// The typed account commands, on whichever machine `host` is.
@MainActor
struct ProviderAccountsClient {
  let host: ProviderAccountsHost

  private func call<T: Decodable>(_ action: String, _ args: [String: Any], as type: T.Type) async throws -> T {
    let raw = try await host.runProviderAccountsCommand(action, args: args)
    let data = try JSONSerialization.data(withJSONObject: raw)
    return try JSONDecoder().decode(T.self, from: data)
  }

  private func accounts(_ method: String, _ args: [String: Any]) async throws -> [ProviderAccount] {
    try await call("providerAccounts.\(method)", args, as: ProviderAccountListEnvelope.self).instances
  }

  private func account(_ method: String, _ args: [String: Any]) async throws -> ProviderAccount {
    try await call("providerAccounts.\(method)", args, as: ProviderAccountEnvelope.self).instance
  }

  private func login(_ method: String, _ args: [String: Any]) async throws -> ProviderAccountLogin {
    try await call("providerAccounts.\(method)", args, as: ProviderAccountLoginEnvelope.self).login
  }

  private func settings(_ method: String, _ args: [String: Any]) async throws -> ProviderAccountSettings {
    try await call("providerAccounts.\(method)", args, as: ProviderAccountSettingsEnvelope.self).settings
  }

  func list(_ provider: ProviderAccountProvider) async throws -> [ProviderAccount] {
    try await accounts("list", ["provider": provider.rawValue])
  }

  func refresh(_ provider: ProviderAccountProvider, instanceId: String? = nil) async throws -> [ProviderAccount] {
    var args: [String: Any] = ["provider": provider.rawValue]
    if let instanceId { args["instanceId"] = instanceId }
    return try await accounts("refresh", args)
  }

  func settings(_ provider: ProviderAccountProvider) async throws -> ProviderAccountSettings {
    try await settings("getSettings", ["provider": provider.rawValue])
  }

  func setSmartBalance(_ provider: ProviderAccountProvider, enabled: Bool) async throws -> ProviderAccountSettings {
    try await settings("setSettings", ["provider": provider.rawValue, "settings": ["smartBalance": enabled]])
  }

  func create(_ provider: ProviderAccountProvider, label: String) async throws -> ProviderAccount {
    try await account("create", ["provider": provider.rawValue, "label": label])
  }

  func remove(id: String) async throws {
    struct Removed: Decodable { var removed: Bool }
    _ = try await call("providerAccounts.remove", ["id": id], as: Removed.self)
  }

  func rename(id: String, label: String) async throws -> ProviderAccount {
    try await account("rename", ["id": id, "label": label])
  }

  func setDefault(id: String) async throws -> ProviderAccount {
    try await account("setDefault", ["id": id])
  }

  func dismissReplaced(id: String) async throws -> ProviderAccount {
    try await account("dismissReplaced", ["id": id])
  }

  /// Codex signs in with a device code here: its normal sign-in returns to a
  /// localhost port on the machine, which the phone's browser cannot reach.
  func startLogin(id: String, provider: ProviderAccountProvider) async throws -> ProviderAccountLogin {
    try await login("loginStart", ["id": id, "deviceAuth": provider.usesDeviceCode])
  }

  func loginStatus(loginId: String) async throws -> ProviderAccountLogin {
    try await login("loginStatus", ["loginId": loginId])
  }

  func submitLoginCode(loginId: String, code: String) async throws -> ProviderAccountLogin {
    try await login("loginSubmitCode", ["loginId": loginId, "code": code])
  }

  func cancelLogin(loginId: String) async throws -> ProviderAccountLogin {
    try await login("loginCancel", ["loginId": loginId])
  }

  /// The machine's own quota readings. Account ids repeat across machines
  /// (every machine's default is `claude`), so one machine's accounts are
  /// never matched against another machine's snapshot.
  func quotaSnapshot(refresh: Bool) async throws -> MobileUsageQuotaSnapshot {
    try await call(refresh ? "usage.refreshQuota" : "usage.getQuotaSnapshot", [:], as: MobileUsageQuotaSnapshot.self)
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
  private let client: ProviderAccountsClient?

  init(provider: ProviderAccountProvider, host: ProviderAccountsHost?) {
    self.provider = provider
    self.client = host.map(ProviderAccountsClient.init(host:))
  }

  #if DEBUG
  /// Fixture screens hand the store its data and never reach a host.
  init(provider: ProviderAccountProvider, accounts: [ProviderAccount], settings: ProviderAccountSettings) {
    self.provider = provider
    self.client = nil
    self.accounts = accounts
    self.settings = settings
    self.loaded = true
  }
  #endif

  func load(refresh: Bool = false) async {
    guard let client else { return }
    loading = true
    defer { loading = false }
    do {
      async let list = refresh
        ? client.refresh(provider)
        : client.list(provider)
      async let readSettings = client.settings(provider)
      let (nextAccounts, nextSettings) = try await (list, readSettings)
      accounts = sortedAccounts(nextAccounts)
      settings = nextSettings
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
    loaded = true
  }

  @discardableResult
  func rename(id: String, label: String) async -> Bool {
    await run(accountId: id) { _ = try await $0.rename(id: id, label: label) } != nil
  }

  @discardableResult
  func remove(id: String) async -> Bool {
    await run(accountId: id) { try await $0.remove(id: id) } != nil
  }

  @discardableResult
  func makeDefault(id: String) async -> Bool {
    await run(accountId: id) { _ = try await $0.setDefault(id: id) } != nil
  }

  @discardableResult
  func dismissReplaced(id: String) async -> Bool {
    await run(accountId: id) { _ = try await $0.dismissReplaced(id: id) } != nil
  }

  /// Re-reads one account's saved login, right after a sign-in finished for it.
  func refreshAfterSignIn(id: String) async {
    await run(accountId: id) { _ = try await $0.refresh(self.provider, instanceId: id) }
  }

  func create(label: String) async -> ProviderAccount? {
    await run(accountId: nil) { try await $0.create(self.provider, label: label) }
  }

  func setSmartBalance(_ enabled: Bool) async {
    guard let client else {
      settings?.smartBalance = enabled
      return
    }
    let previous = settings
    settings?.smartBalance = enabled
    do {
      settings = try await client.setSmartBalance(provider, enabled: enabled)
      errorMessage = nil
    } catch {
      settings = previous
      errorMessage = error.localizedDescription
    }
  }

  func account(id: String) -> ProviderAccount? {
    accounts.first { $0.id == id }
  }

  /// Runs one change, then re-reads the list. Nil when the change failed; the
  /// error is on `errorMessage`.
  @discardableResult
  private func run<T>(accountId: String?, _ change: (ProviderAccountsClient) async throws -> T) async -> T? {
    guard let client else { return nil }
    busyAccountId = accountId
    defer { busyAccountId = nil }
    do {
      let result = try await change(client)
      accounts = sortedAccounts(try await client.list(provider))
      errorMessage = nil
      return result
    } catch {
      errorMessage = error.localizedDescription
      return nil
    }
  }

  /// Default first, then the order the accounts were added.
  private func sortedAccounts(_ list: [ProviderAccount]) -> [ProviderAccount] {
    list.sorted { lhs, rhs in
      if lhs.isDefault != rhs.isDefault { return lhs.isDefault }
      return lhs.createdAt < rhs.createdAt
    }
  }
}

// MARK: - Machines

/// One machine on the AI accounts page: where its commands go, a store per
/// provider, and that machine's own quota readings.
@MainActor
final class ProviderAccountsMachine: ObservableObject, Identifiable {
  let id: String
  /// Kept current by the directory while the page renders, so it is not
  /// published: a rename shows on the next render either way.
  var name: String
  let host: ProviderAccountsHost?
  let claude: ProviderAccountsStore
  let codex: ProviderAccountsStore
  @Published private(set) var quota: MobileUsageQuotaSnapshot?

  init(id: String, name: String, host: ProviderAccountsHost?) {
    self.id = id
    self.name = name
    self.host = host
    self.claude = ProviderAccountsStore(provider: .claude, host: host)
    self.codex = ProviderAccountsStore(provider: .codex, host: host)
  }

  #if DEBUG
  init(id: String, name: String, claude: ProviderAccountsStore, codex: ProviderAccountsStore, quota: MobileUsageQuotaSnapshot?) {
    self.id = id
    self.name = name
    self.host = nil
    self.claude = claude
    self.codex = codex
    self.quota = quota
  }
  #endif

  func store(for provider: ProviderAccountProvider) -> ProviderAccountsStore {
    provider == .claude ? claude : codex
  }

  /// Quota is best-effort: a machine that cannot answer simply shows no meters.
  func loadQuota(refresh: Bool = false) async {
    guard let host else { return }
    if let snapshot = try? await ProviderAccountsClient(host: host).quotaSnapshot(refresh: refresh) {
      quota = snapshot
    }
  }
}

/// Keeps one `ProviderAccountsMachine` per machine for the life of the page,
/// so switching machines and back keeps what was already loaded. A machine
/// whose connection object was replaced (a reconnect) gets a fresh one.
@MainActor
final class ProviderAccountsMachineDirectory: ObservableObject {
  private var machines: [String: ProviderAccountsMachine] = [:]

  func machine(id: String, name: String, host: ProviderAccountsHost) -> ProviderAccountsMachine {
    if let existing = machines[id], existing.host === host {
      if existing.name != name { existing.name = name }
      return existing
    }
    let created = ProviderAccountsMachine(id: id, name: name, host: host)
    machines[id] = created
    return created
  }
}
