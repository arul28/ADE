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

  /// ADE's own compaction overrides for this account (desktop
  /// `ProviderCompactionSettings`). Absent fields keep the provider's value.
  struct Compaction: Codable, Equatable {
    var atTokens: Int?
    /// The window is set to Auto (`atTokens: null`), which overrides a
    /// provider's token limit; an absent `atTokens` inherits it instead.
    var atTokensAuto = false
    var subagentAtTokens: Int?
    var subagentAtTokensAuto = false
    var reserveTokens: Int?
    var keepRecentTokens: Int?
    /// ask · always · never
    var idleMode: String?

    var wireValue: [String: Any] {
      var out: [String: Any] = [:]
      if let atTokens { out["atTokens"] = atTokens } else if atTokensAuto { out["atTokens"] = NSNull() }
      if let subagentAtTokens { out["subagentAtTokens"] = subagentAtTokens } else if subagentAtTokensAuto { out["subagentAtTokens"] = NSNull() }
      if let reserveTokens { out["reserveTokens"] = reserveTokens }
      if let keepRecentTokens { out["keepRecentTokens"] = keepRecentTokens }
      if let idleMode { out["idleMode"] = idleMode }
      return out
    }
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
  /// Nil inherits the provider's compaction settings.
  var compaction: Compaction?
  /// Claude only. "1h", or nil for Claude Code's 5 minutes.
  var subagentPromptCacheTtl: String?
  /// Claude only. "5m" or "1h", or nil for automatic.
  var mainPromptCacheTtl: String?
  /// Claude only. "stop", or nil to keep going on extra usage.
  var onExtraUsage: String?

  var email: String? { nonEmpty(account?.email) }
  /// What an account is called: its login's email, never its id (a storage key
  /// that two machines can give one email differently). Without an email, a
  /// working login still reads as signed in. Desktop `AccountCard`'s name, with
  /// the strings of `PROVIDER_ACCOUNT_SIGNED_IN_NO_EMAIL` / `_NOT_SIGNED_IN`.
  var displayName: String { email ?? (hasLogin ? "Signed in, no email" : "Not signed in") }
  var plan: String? { nonEmpty(account?.plan) }
  /// The config home names a login, working or not.
  var hasLogin: Bool { signedIn || loginBroken == true }
  /// The machine's own login (the one the terminal's CLI uses). The host
  /// refuses to remove it. Desktop `isBaseProviderInstance`.
  var isMachineLogin: Bool { id == provider }
  /// A working login of its own, so new chats can start on it: signed in,
  /// not broken, and not a copy of another account's login.
  var canTakeChats: Bool { signedIn && loginBroken != true && sameLoginAs == nil }

  private func nonEmpty(_ value: String?) -> String? {
    let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return trimmed.isEmpty ? nil : trimmed
  }
}

/// Keeps an explicit `null` window (Auto) apart from an absent one (inherit).
extension ProviderAccount.Compaction {
  private enum CodingKeys: String, CodingKey {
    case atTokens, subagentAtTokens, reserveTokens, keepRecentTokens, idleMode
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    atTokens = try container.decodeIfPresent(Int.self, forKey: .atTokens)
    atTokensAuto = try container.contains(.atTokens) && container.decodeNil(forKey: .atTokens)
    subagentAtTokens = try container.decodeIfPresent(Int.self, forKey: .subagentAtTokens)
    subagentAtTokensAuto = try container.contains(.subagentAtTokens) && container.decodeNil(forKey: .subagentAtTokens)
    reserveTokens = try container.decodeIfPresent(Int.self, forKey: .reserveTokens)
    keepRecentTokens = try container.decodeIfPresent(Int.self, forKey: .keepRecentTokens)
    idleMode = try container.decodeIfPresent(String.self, forKey: .idleMode)
  }

  func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    if let atTokens { try container.encode(atTokens, forKey: .atTokens) } else if atTokensAuto { try container.encodeNil(forKey: .atTokens) }
    if let subagentAtTokens { try container.encode(subagentAtTokens, forKey: .subagentAtTokens) } else if subagentAtTokensAuto { try container.encodeNil(forKey: .subagentAtTokens) }
    try container.encodeIfPresent(reserveTokens, forKey: .reserveTokens)
    try container.encodeIfPresent(keepRecentTokens, forKey: .keepRecentTokens)
    try container.encodeIfPresent(idleMode, forKey: .idleMode)
  }
}

struct ProviderAccountSettings: Codable, Equatable {
  var smartBalance: Bool
  var autoStartWindows: Bool
}

/// One account setting the phone changes. Nil restores the default.
enum ProviderAccountSettingChange: Equatable {
  case mainPromptCache(String?)
  case subagentPromptCache(String?)
  case onExtraUsage(String?)
  case compaction(ProviderAccount.Compaction?)

  var key: String {
    switch self {
    case .mainPromptCache: return "mainPromptCacheTtl"
    case .subagentPromptCache: return "subagentPromptCacheTtl"
    case .onExtraUsage: return "onExtraUsage"
    case .compaction: return "compaction"
    }
  }

  var wireValue: Any {
    switch self {
    case .mainPromptCache(let value), .subagentPromptCache(let value), .onExtraUsage(let value):
      return value ?? NSNull()
    case .compaction(let value):
      return value?.wireValue ?? NSNull()
    }
  }

  /// The account, as read back, holds this change. An older ADE accepts a
  /// setting it does not know and saves nothing.
  func isSaved(in account: ProviderAccount?) -> Bool {
    guard let account else { return false }
    switch self {
    case .mainPromptCache(let value): return account.mainPromptCacheTtl == value
    case .subagentPromptCache(let value): return account.subagentPromptCacheTtl == value
    case .onExtraUsage(let value): return account.onExtraUsage == value
    case .compaction(let value):
      guard let value, let saved = account.compaction else { return (account.compaction == nil) == (value == nil) }
      // The host normalizes the numbers, so a number's presence is compared, not its value.
      return saved.atTokensAuto == value.atTokensAuto
        && saved.subagentAtTokensAuto == value.subagentAtTokensAuto
        && (saved.atTokens == nil) == (value.atTokens == nil)
        && (saved.subagentAtTokens == nil) == (value.subagentAtTokens == nil)
        && saved.idleMode == value.idleMode
    }
  }
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

  /// Smart balance or auto-start, for the whole provider on this machine.
  func setRouting(_ provider: ProviderAccountProvider, key: String, enabled: Bool) async throws -> ProviderAccountSettings {
    try await settings("setSettings", ["provider": provider.rawValue, "settings": [key: enabled]])
  }

  func setAccountSetting(_ provider: ProviderAccountProvider, id: String, change: ProviderAccountSettingChange) async throws {
    _ = try await settings("setSettings", [
      "provider": provider.rawValue,
      "instanceId": id,
      "settings": [change.key: change.wireValue],
    ])
  }

  /// Signs the login out and keeps the account, so Sign in can put one back.
  func signOut(id: String) async throws {
    struct SignedOut: Decodable { var instance: ProviderAccount? }
    _ = try await call("providerAccounts.signOut", ["id": id], as: SignedOut.self)
  }

  func create(_ provider: ProviderAccountProvider) async throws -> ProviderAccount {
    do {
      return try await account("create", ["provider": provider.rawValue])
    } catch where error.localizedDescription.contains("needs a label") {
      // A host older than nameless accounts still asks for one.
      return try await account("create", ["provider": provider.rawValue, "label": provider.title])
    }
  }

  func remove(id: String) async throws {
    struct Removed: Decodable { var removed: Bool }
    _ = try await call("providerAccounts.remove", ["id": id], as: Removed.self)
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

  func create() async -> ProviderAccount? {
    await run(accountId: nil) { try await $0.create(self.provider) }
  }

  func setSmartBalance(_ enabled: Bool) async {
    await setRouting(key: "smartBalance", enabled: enabled) { $0.smartBalance = enabled }
  }

  func setAutoStartWindows(_ enabled: Bool) async {
    await setRouting(key: "autoStartWindows", enabled: enabled) { $0.autoStartWindows = enabled }
  }

  @discardableResult
  func signOut(id: String) async -> Bool {
    await run(accountId: id) { try await $0.signOut(id: id) } != nil
  }

  /// Changes one account setting, then checks the account read back holds it.
  @discardableResult
  func setAccountSetting(id: String, _ change: ProviderAccountSettingChange) async -> Bool {
    guard await run(accountId: id, { try await $0.setAccountSetting(self.provider, id: id, change: change) }) != nil else {
      return false
    }
    guard change.isSaved(in: account(id: id)) else {
      errorMessage = "That setting was not saved. Update ADE on that computer and try again."
      return false
    }
    return true
  }

  /// "Use this account": new chats start on it. Smart balance would pick for
  /// them instead, so it turns off first (desktop `selectAccount`).
  @discardableResult
  func useForNewChats(id: String) async -> Bool {
    if settings?.smartBalance == true {
      await setSmartBalance(false)
      guard settings?.smartBalance == false else { return false }
    }
    guard account(id: id)?.isDefault != true else { return true }
    return await makeDefault(id: id)
  }

  /// Shows the new value at once and puts the old one back if the host refuses.
  private func setRouting(key: String, enabled: Bool, apply: (inout ProviderAccountSettings) -> Void) async {
    guard let client else {
      if settings != nil { apply(&settings!) }
      return
    }
    let previous = settings
    if settings != nil { apply(&settings!) }
    do {
      settings = try await client.setRouting(provider, key: key, enabled: enabled)
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
