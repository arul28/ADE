import CryptoKit
import Foundation
import OSLog
import Security

/// Passwords on the phone: the account's saved logins and API secrets, read
/// only. Each item is sealed on the device or cloud lane that wrote it
/// (`apps/ade-cli/src/services/passwords/passwordCrypto.ts`); the relay
/// stores the sealed envelope and the wrapped vault key. The phone asks the
/// relay for the key once, keeps it in this device's Keychain, and opens the
/// items in memory while Passwords is on screen. Values, usernames and sites
/// are never logged.
private let passwordsLog = Logger(subsystem: "com.ade.ios", category: "Passwords")

// MARK: - What an item holds

/// The plaintext inside one sealed item (`PasswordItemSecret` in
/// `apps/desktop/src/shared/types/passwords.ts`).
enum PasswordItemSecret: Equatable, Decodable {
  case login(PasswordLogin)
  case secret(PasswordSecret)

  struct PasswordLogin: Equatable, Decodable {
    var title: String
    var origins: [String]
    var username: String
    var password: String
    var notes: String
    var totpUri: String?
  }

  struct PasswordSecret: Equatable, Decodable {
    var name: String
    var value: String
    var projectScope: String?
    var notes: String
  }

  private enum CodingKeys: String, CodingKey { case kind }

  init(from decoder: Decoder) throws {
    let kind = try decoder.container(keyedBy: CodingKeys.self).decode(String.self, forKey: .kind)
    switch kind {
    case "login":
      let login = try PasswordLoginWire(from: decoder)
      self = .login(PasswordLogin(
        title: login.title ?? "",
        origins: login.origins ?? [],
        username: login.username ?? "",
        password: login.password ?? "",
        notes: login.notes ?? "",
        totpUri: login.totpUri
      ))
    case "secret":
      let secret = try PasswordSecretWire(from: decoder)
      self = .secret(PasswordSecret(
        name: secret.name ?? "",
        value: secret.value ?? "",
        projectScope: secret.projectScope,
        notes: secret.notes ?? ""
      ))
    default:
      throw DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "Unknown password item kind."))
    }
  }

  /// Lenient wire shapes: a field an older writer left out reads as empty.
  private struct PasswordLoginWire: Decodable {
    var title: String?
    var origins: [String]?
    var username: String?
    var password: String?
    var notes: String?
    var totpUri: String?
  }

  private struct PasswordSecretWire: Decodable {
    var name: String?
    var value: String?
    var projectScope: String?
    var notes: String?
  }
}

/// One opened item the phone shows.
struct PasswordsVaultItem: Identifiable, Equatable {
  let id: String
  let secret: PasswordItemSecret
}

// MARK: - The sealed envelope

/// `{ v: 1, epoch, nonce, ct }`: AES-256-GCM, `ct` is ciphertext then the
/// 16-byte tag, both base64.
struct PasswordEnvelope: Equatable, Decodable {
  let v: Int
  let epoch: Int
  let nonce: String
  let ct: String
}

enum PasswordCryptoError: Error, Equatable {
  case invalidBinding
  case invalidKey
  case otherVaultKey
  case damaged
  case cannotOpen
  case unreadable
  /// A kind the phone has nothing to show for (a passkey ADE's browser uses).
  case notShownHere
}

/// The phone's half of `passwordCrypto.ts`: opening, never sealing. The
/// additional data must match the brains' byte for byte, or nothing opens.
enum PasswordCrypto {
  static let envelopeVersion = 1
  private static let aadPrefix = "ade.passwords.v1"
  private static let keyBytes = 32
  private static let nonceBytes = 12
  private static let tagBytes = 16
  /// `Number.MAX_SAFE_INTEGER`: the brains only write safe integers.
  private static let maxSafeInteger = 9_007_199_254_740_991

  /// `"ade.passwords.v1\n<accountId>\n<itemId>\n<epoch>"` in UTF-8.
  static func additionalData(accountId: String, itemId: String, epoch: Int) throws -> Data {
    for part in [accountId, itemId] {
      if part.isEmpty || part.unicodeScalars.contains(where: { $0 == "\n" || $0 == "\r" }) {
        throw PasswordCryptoError.invalidBinding
      }
    }
    guard epoch >= 1, epoch <= maxSafeInteger else { throw PasswordCryptoError.invalidBinding }
    return Data("\(aadPrefix)\n\(accountId)\n\(itemId)\n\(epoch)".utf8)
  }

  /// A stored envelope string, or nil if it is not one.
  static func parseEnvelope(_ raw: String) -> PasswordEnvelope? {
    guard let envelope = try? JSONDecoder().decode(PasswordEnvelope.self, from: Data(raw.utf8)),
          envelope.v == envelopeVersion,
          abs(envelope.epoch) <= maxSafeInteger else { return nil }
    return envelope
  }

  /// Opens one item's plaintext bytes. Throws on any mismatch: wrong key,
  /// account, item or epoch, or tampering.
  static func openData(key: Data, accountId: String, itemId: String, epoch: Int, envelope: PasswordEnvelope) throws -> Data {
    guard key.count == keyBytes else { throw PasswordCryptoError.invalidKey }
    guard envelope.v == envelopeVersion, envelope.epoch == epoch else { throw PasswordCryptoError.otherVaultKey }
    guard let nonceData = Data(base64Encoded: envelope.nonce),
          let body = Data(base64Encoded: envelope.ct),
          nonceData.count == nonceBytes,
          body.count > tagBytes else { throw PasswordCryptoError.damaged }
    let aad = try additionalData(accountId: accountId, itemId: itemId, epoch: epoch)
    do {
      let box = try AES.GCM.SealedBox(
        nonce: AES.GCM.Nonce(data: nonceData),
        ciphertext: body.prefix(body.count - tagBytes),
        tag: body.suffix(tagBytes)
      )
      return try AES.GCM.open(box, using: SymmetricKey(data: key), authenticating: aad)
    } catch {
      throw PasswordCryptoError.cannotOpen
    }
  }

  static func open(key: Data, accountId: String, itemId: String, epoch: Int, envelope: PasswordEnvelope) throws -> PasswordItemSecret {
    let plain = try openData(key: key, accountId: accountId, itemId: itemId, epoch: epoch, envelope: envelope)
    guard let secret = try? JSONDecoder().decode(PasswordItemSecret.self, from: plain) else {
      // Opened fine but of a kind the phone does not list (a passkey): skip it
      // quietly rather than reporting it as damaged.
      if let kind = (try? JSONSerialization.jsonObject(with: plain)) as? [String: Any],
         let name = kind["kind"] as? String, name == "passkey" {
        throw PasswordCryptoError.notShownHere
      }
      throw PasswordCryptoError.unreadable
    }
    return secret
  }
}

// MARK: - Authenticator codes (RFC 6238), as `passwordTotp.ts`

struct PasswordTotpParams: Equatable {
  enum Algorithm: String { case sha1, sha256, sha512 }
  let secret: Data
  let digits: Int
  let period: Int
  let algorithm: Algorithm
}

enum PasswordTotp {
  private static let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")

  static func decodeBase32(_ input: String) -> Data? {
    var clean = input.uppercased().filter { !$0.isWhitespace && $0 != "-" }
    while clean.hasSuffix("=") { clean.removeLast() }
    guard !clean.isEmpty else { return nil }
    var bits = 0
    var value: UInt32 = 0
    var out = Data()
    for char in clean {
      guard let index = alphabet.firstIndex(of: char) else { return nil }
      value = (value << 5) | UInt32(index)
      bits += 5
      if bits >= 8 {
        out.append(UInt8((value >> UInt32(bits - 8)) & 0xff))
        bits -= 8
      }
    }
    return out
  }

  /// The code parameters in an `otpauth://totp/` URI or a bare base32 key.
  static func parse(_ input: String) -> PasswordTotpParams? {
    let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }
    guard trimmed.lowercased().hasPrefix("otpauth://") else {
      guard let secret = decodeBase32(trimmed), secret.count >= 10 else { return nil }
      return PasswordTotpParams(secret: secret, digits: 6, period: 30, algorithm: .sha1)
    }
    // Parsed by hand: a label with a space or a colon (common in exports)
    // makes `URLComponents` give up where the brains' WHATWG URL does not.
    var rest = Substring(trimmed.dropFirst("otpauth://".count))
    if let hash = rest.firstIndex(of: "#") { rest = rest[..<hash] }
    let hostEnd = rest.firstIndex(where: { $0 == "/" || $0 == "?" }) ?? rest.endIndex
    let host = rest[..<hostEnd].split(separator: ":", maxSplits: 1).first.map(String.init) ?? ""
    guard host.lowercased() == "totp" else { return nil }
    var query: [String: String] = [:]
    if let mark = rest.firstIndex(of: "?") {
      for pair in rest[rest.index(after: mark)...].split(separator: "&") {
        let parts = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
        let name = decodeQueryComponent(parts[0])
        // First value wins, as `URLSearchParams.get`.
        if query[name] == nil { query[name] = parts.count > 1 ? decodeQueryComponent(parts[1]) : "" }
      }
    }
    guard let secret = decodeBase32(query["secret"] ?? ""), secret.count >= 10 else { return nil }
    guard let digits = Int(query["digits"] ?? "6"), [6, 7, 8].contains(digits),
          let period = Int(query["period"] ?? "30"), (5...300).contains(period) else { return nil }
    var algorithmName = (query["algorithm"] ?? "SHA1").lowercased()
    if let dash = algorithmName.firstIndex(of: "-") { algorithmName.remove(at: dash) }
    guard let algorithm = PasswordTotpParams.Algorithm(rawValue: algorithmName) else { return nil }
    return PasswordTotpParams(secret: secret, digits: digits, period: period, algorithm: algorithm)
  }

  private static func decodeQueryComponent(_ value: Substring) -> String {
    let spaced = value.replacingOccurrences(of: "+", with: " ")
    return spaced.removingPercentEncoding ?? spaced
  }

  /// The code at `date`, and how many seconds it stays valid.
  static func code(_ params: PasswordTotpParams, at date: Date = Date()) -> (code: String, secondsLeft: Int) {
    let seconds = Int64(floor(date.timeIntervalSince1970))
    let counter = UInt64(max(0, seconds) / Int64(params.period))
    var message = Data(count: 8)
    for index in 0..<8 { message[index] = UInt8((counter >> UInt64(56 - index * 8)) & 0xff) }
    let key = SymmetricKey(data: params.secret)
    let mac: Data
    switch params.algorithm {
    case .sha1: mac = Data(HMAC<Insecure.SHA1>.authenticationCode(for: message, using: key))
    case .sha256: mac = Data(HMAC<SHA256>.authenticationCode(for: message, using: key))
    case .sha512: mac = Data(HMAC<SHA512>.authenticationCode(for: message, using: key))
    }
    let bytes = [UInt8](mac)
    let offset = Int(bytes[bytes.count - 1] & 0x0f)
    let binary = (UInt32(bytes[offset] & 0x7f) << 24)
      | (UInt32(bytes[offset + 1]) << 16)
      | (UInt32(bytes[offset + 2]) << 8)
      | UInt32(bytes[offset + 3])
    var modulus: UInt32 = 1
    for _ in 0..<params.digits { modulus *= 10 }
    let digits = String(binary % modulus)
    let code = String(repeating: "0", count: max(0, params.digits - digits.count)) + digits
    let secondsLeft = params.period - Int(max(0, seconds) % Int64(params.period))
    return (code, secondsLeft)
  }
}

// MARK: - Relay

/// The two relay routes the phone reads, under the account's authenticated
/// `/attention/account/` (`apps/push-relay/src/passwords.ts`).
struct PasswordsRelayClient {
  enum RelayError: Error, Equatable {
    case unauthorized
    /// 503: the relay has no key service, or it is down.
    case unavailable
    case server(Int)
    case transport
    case unreadable
  }

  struct ItemRow: Decodable, Equatable {
    let id: String
    let ciphertext: String?
    let deleted: Bool
  }

  private struct ItemsPage: Decodable {
    let items: [ItemRow]
    let cursor: String?
    let truncated: Bool
  }

  struct ReleasedKey: Equatable {
    let key: Data
    let epoch: Int
  }

  var session: URLSession = .shared

  /// Every row since the start, paged until the relay says it is done. A
  /// later page's row replaces an earlier one with the same id.
  func fetchAllItems(baseURL: URL, token: String, refreshToken: @escaping () async -> String?) async throws -> [ItemRow] {
    var byId: [String: ItemRow] = [:]
    var cursor: String?
    for _ in 0..<50 {
      var components = URLComponents(url: endpoint(baseURL, "items"), resolvingAgainstBaseURL: false)
      if let cursor { components?.queryItems = [URLQueryItem(name: "since", value: cursor)] }
      guard let url = components?.url else { throw RelayError.transport }
      let data = try await perform(url: url, method: "GET", token: token, body: nil, refreshToken: refreshToken)
      guard let page = try? JSONDecoder().decode(ItemsPage.self, from: data) else { throw RelayError.unreadable }
      for row in page.items { byId[row.id] = row }
      // A page that does not move the cursor would repeat forever.
      guard page.truncated, let next = page.cursor, next != cursor else { break }
      cursor = next
    }
    return Array(byId.values)
  }

  func requestKey(baseURL: URL, token: String, deviceId: String, refreshToken: @escaping () async -> String?) async throws -> ReleasedKey {
    let body = try JSONSerialization.data(withJSONObject: ["deviceId": deviceId, "machineKind": "phone"])
    let data = try await perform(url: endpoint(baseURL, "key"), method: "POST", token: token, body: body, refreshToken: refreshToken)
    struct Response: Decodable { let dek: String; let epoch: Int }
    guard let response = try? JSONDecoder().decode(Response.self, from: data),
          let key = Data(base64Encoded: response.dek),
          key.count == 32,
          response.epoch >= 1 else { throw RelayError.unreadable }
    return ReleasedKey(key: key, epoch: response.epoch)
  }

  private func endpoint(_ baseURL: URL, _ leaf: String) -> URL {
    baseURL
      .appendingPathComponent("attention")
      .appendingPathComponent("account")
      .appendingPathComponent("passwords")
      .appendingPathComponent(leaf)
  }

  private func perform(url: URL, method: String, token: String, body: Data?, refreshToken: () async -> String?) async throws -> Data {
    func send(_ accessToken: String) async throws -> (Data, HTTPURLResponse) {
      var request = URLRequest(url: url)
      request.httpMethod = method
      request.httpBody = body
      request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
      request.setValue("application/json", forHTTPHeaderField: "Accept")
      if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
      request.setValue(UUID().uuidString.lowercased(), forHTTPHeaderField: "X-ADE-Correlation-ID")
      request.timeoutInterval = 12
      request.cachePolicy = .reloadIgnoringLocalCacheData
      do {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw RelayError.transport }
        return (data, http)
      } catch let error as RelayError {
        throw error
      } catch {
        throw RelayError.transport
      }
    }
    var (data, response) = try await send(token)
    if response.statusCode == 401,
       let refreshed = await refreshToken()?.trimmingCharacters(in: .whitespacesAndNewlines),
       !refreshed.isEmpty {
      (data, response) = try await send(refreshed)
    }
    switch response.statusCode {
    case 200..<300: return data
    case 401, 403: throw RelayError.unauthorized
    case 503: throw RelayError.unavailable
    default: throw RelayError.server(response.statusCode)
    }
  }
}

// MARK: - The key on this device

/// The vault key, in this device's Keychain only: readable while the phone is
/// unlocked, never in a backup restored elsewhere, never synced to iCloud.
/// One item per account id; every one goes on sign-out.
enum PasswordsKeyStore {
  /// One serial queue for every Keychain change, so a sign-out's delete and a
  /// key save run in the order they were asked for.
  private static let queue = DispatchQueue(label: "ade.passwords.keystore", qos: .utility)

  /// Queues `body` and does not wait.
  static func run(_ body: @escaping @Sendable () -> Void) {
    queue.async(execute: body)
  }

  /// Queues `body` and waits for its result.
  static func perform<T: Sendable>(_ body: @escaping @Sendable () -> T) async -> T {
    await withCheckedContinuation { continuation in
      queue.async { continuation.resume(returning: body()) }
    }
  }

  private static let service = "com.ade.ios.passwords"
  private static let accountPrefix = "vault-key:"

  private struct Stored: Codable {
    let dek: String
    let epoch: Int
  }

  private static func baseQuery(accountId: String? = nil) -> [String: Any] {
    var query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrSynchronizable as String: kCFBooleanFalse as Any,
    ]
    if let accountId { query[kSecAttrAccount as String] = accountPrefix + accountId }
    return query
  }

  static func load(accountId: String) -> PasswordsRelayClient.ReleasedKey? {
    var query = baseQuery(accountId: accountId)
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    query[kSecReturnData as String] = true
    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
          let data = item as? Data,
          let stored = try? JSONDecoder().decode(Stored.self, from: data),
          let key = Data(base64Encoded: stored.dek),
          key.count == 32 else { return nil }
    return PasswordsRelayClient.ReleasedKey(key: key, epoch: stored.epoch)
  }

  @discardableResult
  static func save(_ released: PasswordsRelayClient.ReleasedKey, accountId: String) -> Bool {
    guard let data = try? JSONEncoder().encode(Stored(dek: released.key.base64EncodedString(), epoch: released.epoch)) else {
      return false
    }
    let query = baseQuery(accountId: accountId)
    let status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
    if status == errSecItemNotFound {
      var add = query
      add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
      add[kSecValueData as String] = data
      return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
    }
    return status == errSecSuccess
  }

  static func delete(accountId: String) {
    SecItemDelete(baseQuery(accountId: accountId) as CFDictionary)
  }

  /// Removes every account's key but `keeping`'s (nil: all of them).
  static func deleteAll(keeping accountId: String? = nil) {
    guard let accountId else {
      SecItemDelete(baseQuery() as CFDictionary)
      return
    }
    var query = baseQuery()
    query[kSecMatchLimit as String] = kSecMatchLimitAll
    query[kSecReturnAttributes as String] = true
    var result: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
          let rows = result as? [[String: Any]] else { return }
    let keep = accountPrefix + accountId
    for row in rows {
      guard let account = row[kSecAttrAccount as String] as? String, account != keep else { continue }
      var delete = baseQuery()
      delete[kSecAttrAccount as String] = account
      SecItemDelete(delete as CFDictionary)
    }
  }
}

// MARK: - The vault

/// The signed-in account's Passwords, opened in memory. Read only: the phone
/// never seals or writes an item.
@MainActor
final class PasswordsVault: ObservableObject {
  static let shared = PasswordsVault()

  enum Phase: Equatable {
    /// Signed out, or not read yet.
    case inactive
    case loading
    /// The account has no saved items, or the relay cannot release a key.
    case notSetUp
    case ready
    case failed(String)
  }

  @Published private(set) var phase: Phase = .inactive
  @Published private(set) var items: [PasswordsVaultItem] = []
  /// Saved items this phone could not open (damaged, or sealed by an older key).
  @Published private(set) var unopenableCount = 0

  private var userId: String?
  private var inFlight: Task<Void, Never>?
  private let client = PasswordsRelayClient()

#if DEBUG
  /// A fixture screen's vault: seeded items, no relay, no Keychain, and
  /// Reveal opens with no Face ID prompt.
  private(set) var isPreviewSeeded = false

  func seedPreview(_ previewItems: [PasswordsVaultItem]) {
    isPreviewSeeded = true
    items = previewItems
    phase = .ready
  }
#endif

  var logins: [(id: String, login: PasswordItemSecret.PasswordLogin)] {
    items.compactMap { item in
      if case .login(let login) = item.secret { return (item.id, login) }
      return nil
    }
  }

  var secrets: [(id: String, secret: PasswordItemSecret.PasswordSecret)] {
    items.compactMap { item in
      if case .secret(let secret) = item.secret { return (item.id, secret) }
      return nil
    }
  }

  /// The account `userId` signed in. Another account's key leaves this device.
  func activate(userId: String) {
    guard self.userId != userId else { return }
    inFlight?.cancel()
    inFlight = nil
    self.userId = userId
    items = []
    unopenableCount = 0
    phase = .inactive
    PasswordsKeyStore.run { PasswordsKeyStore.deleteAll(keeping: userId) }
  }

  /// Signed out: every key and every opened item go.
  func deactivate() {
    inFlight?.cancel()
    inFlight = nil
    userId = nil
    items = []
    unopenableCount = 0
    phase = .inactive
#if DEBUG
    if isPreviewSeeded { return }
#endif
    PasswordsKeyStore.run { PasswordsKeyStore.deleteAll() }
  }

  /// Reads and opens the account's items. A read already running is joined.
  func refresh() async {
    if let inFlight {
      await inFlight.value
      return
    }
    let task = Task { await self.performRefresh() }
    inFlight = task
    await task.value
    if inFlight == task { inFlight = nil }
  }

  private func performRefresh() async {
#if DEBUG
    if isPreviewSeeded { return }
#endif
    guard let accountId = userId else { return }
    guard let baseURL = AccountConfig.attentionRelayBaseURL else {
      phase = .notSetUp
      return
    }
    if items.isEmpty { phase = .loading }
    let account = AccountService.shared
    guard let session = await account.pairingSession(),
          session.authorization.ownerId == accountId,
          userId == accountId else {
      if userId == accountId { phase = .failed("Sign in again to see your passwords.") }
      return
    }
    let refreshToken: () async -> String? = {
      guard account.isPairingCommitAuthorized(session.authorization) else { return nil }
      return try? await account.freshRelaySession(expectedAuthorization: session.authorization).token
    }
    let deviceId = account.attentionDeviceId
    do {
      let rows = try await client.fetchAllItems(baseURL: baseURL, token: session.token, refreshToken: refreshToken)
      guard userId == accountId, !Task.isCancelled else { return }
      var damaged = 0
      var live: [(id: String, envelope: PasswordEnvelope)] = []
      for row in rows where !row.deleted {
        guard let raw = row.ciphertext, !raw.isEmpty else { continue }
        if let envelope = PasswordCrypto.parseEnvelope(raw) { live.append((row.id, envelope)) } else { damaged += 1 }
      }
      // No saved items: nothing to open, and no key is asked for (asking
      // would create a vault the person never turned on).
      guard !live.isEmpty else {
        publish(items: [], unopenable: damaged, phase: .notSetUp)
        return
      }
      let client = self.client
      let key: () async throws -> PasswordsRelayClient.ReleasedKey = {
        let cached = await PasswordsKeyStore.perform { PasswordsKeyStore.load(accountId: accountId) }
        if let cached { return cached }
        let released = try await client.requestKey(baseURL: baseURL, token: session.token, deviceId: deviceId, refreshToken: refreshToken)
        // Checked on the main actor, then queued behind any sign-out's delete
        // already on the key-store queue: a key never outlives its account.
        guard self.userId == accountId, !Task.isCancelled else { throw CancellationError() }
        _ = await PasswordsKeyStore.perform { PasswordsKeyStore.save(released, accountId: accountId) }
        passwordsLog.info("passwords.key_ready epoch=\(released.epoch, privacy: .public)")
        return released
      }
      var opened = Self.open(live, key: try await key(), accountId: accountId)
      if opened.needsNewerKey {
        // Reset on another machine: this key is stale. Fetch it again, once.
        passwordsLog.info("passwords.key_epoch_advanced")
        await PasswordsKeyStore.perform { PasswordsKeyStore.delete(accountId: accountId) }
        guard userId == accountId, !Task.isCancelled else { return }
        opened = Self.open(live, key: try await key(), accountId: accountId)
      }
      guard userId == accountId, !Task.isCancelled else { return }
      let unopenable = damaged + opened.unopenable
      if unopenable > 0 { passwordsLog.notice("passwords.items_unopenable count=\(unopenable, privacy: .public)") }
      passwordsLog.info("passwords.opened count=\(opened.items.count, privacy: .public)")
      publish(items: opened.items, unopenable: unopenable, phase: opened.items.isEmpty ? .notSetUp : .ready)
    } catch let error as PasswordsRelayClient.RelayError {
      guard userId == accountId, !Task.isCancelled else { return }
      passwordsLog.notice("passwords.read_failed error=\(String(describing: error), privacy: .public)")
      switch error {
      case .unavailable: publish(items: [], unopenable: 0, phase: .notSetUp)
      case .unauthorized: phase = .failed("Your session expired. Sign in again.")
      case .transport: phase = .failed("Couldn't reach ADE. Check your connection and try again.")
      case .server, .unreadable: phase = .failed("ADE couldn't load your passwords. Try again in a moment.")
      }
    } catch {
      guard userId == accountId, !Task.isCancelled else { return }
      phase = .failed("ADE couldn't load your passwords. Try again in a moment.")
    }
  }

  private func publish(items next: [PasswordsVaultItem], unopenable: Int, phase nextPhase: Phase) {
    items = next
    unopenableCount = unopenable
    phase = nextPhase
  }

  /// Opens every live item under one key. An item sealed under a newer epoch
  /// stops the pass (the key is stale); an older epoch is skipped, as a
  /// reset wiped it.
  nonisolated static func open(
    _ live: [(id: String, envelope: PasswordEnvelope)],
    key: PasswordsRelayClient.ReleasedKey,
    accountId: String
  ) -> (items: [PasswordsVaultItem], unopenable: Int, needsNewerKey: Bool) {
    var items: [PasswordsVaultItem] = []
    var unopenable = 0
    for (id, envelope) in live {
      if envelope.epoch > key.epoch { return ([], 0, true) }
      if envelope.epoch < key.epoch {
        unopenable += 1
        continue
      }
      do {
        items.append(PasswordsVaultItem(
          id: id,
          secret: try PasswordCrypto.open(key: key.key, accountId: accountId, itemId: id, epoch: key.epoch, envelope: envelope)
        ))
      } catch PasswordCryptoError.notShownHere {
        continue
      } catch {
        unopenable += 1
      }
    }
    items.sort { sortKey($0).localizedCaseInsensitiveCompare(sortKey($1)) == .orderedAscending }
    return (items, unopenable, false)
  }

  private nonisolated static func sortKey(_ item: PasswordsVaultItem) -> String {
    switch item.secret {
    case .login(let login): return login.title.isEmpty ? (login.origins.first ?? "") : login.title
    case .secret(let secret): return secret.name
    }
  }
}
