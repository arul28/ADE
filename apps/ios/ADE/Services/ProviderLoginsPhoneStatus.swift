import Foundation

/// The account's provider sign-ins (`providerLogins.status`), as the phone
/// reads them from the machine it drives: each sign-in, the computer it came
/// from, whether ADE Cloud uses it, and "In use here" for that machine. The
/// writes (`use`, `setCloud`, `setCloudAll`) answer with the new status.
/// Settings › Providers (`SettingsProviderSignIns.swift`) and the ADE Cloud
/// page's sign-ins card read it.
struct ProviderLoginsPhoneStatus: Decodable, Equatable {
  struct ThisComputer: Decodable, Equatable {
    let capture: String
    let reason: String?
    let message: String?
    let label: String?
    let cloudComputer: Bool
  }

  struct Cloud: Decodable, Equatable {
    /// The one off switch for all of ADE Cloud's sign-ins.
    let enabled: Bool
    /// Place → the vault key in use, "key" for the saved key.
    let inUse: [String: String]
  }

  struct SignIn: Decodable, Equatable, Identifiable {
    struct Origin: Decodable, Equatable {
      let label: String
      let thisComputer: Bool
    }
    struct Account: Decodable, Equatable {
      let email: String?
      let id: String?
    }
    struct RenewsNow: Decodable, Equatable {
      let label: String
      let cloudComputer: Bool
      let thisComputer: Bool
    }

    let key: String
    let provider: String
    let slot: String
    let renewal: String?
    let origin: Origin
    let account: Account?
    let capturedAt: String?
    let renewedAt: String?
    let renewedBy: String?
    let renewsNow: RenewsNow?
    let onForCloud: Bool
    let inUseOnCloud: Bool

    var id: String { key }

    private enum CodingKeys: String, CodingKey {
      case key, provider, slot, renewal = "class", origin, account, capturedAt, renewedAt, renewedBy, renewsNow, onForCloud, inUseOnCloud
    }

    init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      key = try c.decode(String.self, forKey: .key)
      provider = try c.decode(String.self, forKey: .provider)
      slot = (try? c.decode(String.self, forKey: .slot)) ?? "default"
      renewal = c.lenient(String.self, forKey: .renewal)
      origin = try c.decode(Origin.self, forKey: .origin)
      account = c.lenient(Account.self, forKey: .account)
      capturedAt = c.lenient(String.self, forKey: .capturedAt)
      renewedAt = c.lenient(String.self, forKey: .renewedAt)
      renewedBy = c.lenient(String.self, forKey: .renewedBy)
      renewsNow = c.lenient(RenewsNow.self, forKey: .renewsNow)
      onForCloud = (try? c.decode(Bool.self, forKey: .onForCloud)) ?? true
      inUseOnCloud = (try? c.decode(Bool.self, forKey: .inUseOnCloud)) ?? false
    }

    var email: String? {
      guard let email = account?.email?.trimmingCharacters(in: .whitespacesAndNewlines), !email.isEmpty else { return nil }
      return email
    }

    /// The email, else "Sign-in from Mac Studio" (K4).
    var title: String { email ?? "Sign-in from \(origin.label)" }

    /// The confirm's words: the email, else "the sign-in from Mac Studio".
    var name: String { email ?? "the sign-in from \(origin.label)" }

    /// A Claude pass is never a carried sign-in.
    var isClaudePass: Bool { key.hasPrefix("claude-pass/") }
  }

  struct Provider: Decodable, Equatable {
    struct Local: Decodable, Equatable {
      let state: String
      let key: String?
    }
    let provider: String
    /// `carried`, `fallback` or `never`.
    let carry: String
    let message: String
    let local: Local
  }

  /// A Claude pass for ADE Cloud, by name and state only.
  struct Pass: Decodable, Equatable {
    let key: String
    let unreadable: Bool?
    let email: String?
    let label: String?
    let on: Bool?
    let newChats: Bool?
    let endsInDays: Double?
  }

  let thisComputer: ThisComputer
  let cloud: Cloud
  let signIns: [SignIn]
  let providers: [Provider]
  let claudePasses: [Pass]?

  private enum CodingKeys: String, CodingKey { case thisComputer, cloud, signIns, providers, claudePasses }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    thisComputer = try c.decode(ThisComputer.self, forKey: .thisComputer)
    cloud = try c.decode(Cloud.self, forKey: .cloud)
    // One sign-in a newer brain shapes differently drops alone.
    signIns = (try? c.decode(ADELossyArray<SignIn>.self, forKey: .signIns))?.wrappedValue ?? []
    providers = (try? c.decode(ADELossyArray<Provider>.self, forKey: .providers))?.wrappedValue ?? []
    claudePasses = (try? c.decodeIfPresent(ADELossyArray<Pass>.self, forKey: .claudePasses))?.wrappedValue
  }

  func provider(_ id: String) -> Provider? { providers.first { $0.provider == id } }

  /// The account's sign-ins of one provider, newest first; never a Claude
  /// pass, and never Pi's Claude sign-in (it is not carried).
  func cards(for provider: String) -> [SignIn] {
    signIns
      .filter { $0.provider == provider && !$0.isClaudePass && !(provider == "pi" && $0.slot == "anthropic") }
      .sorted { ($0.capturedAt ?? "") > ($1.capturedAt ?? "") }
  }

  @MainActor
  static func read(on host: ProviderAccountsHost) async throws -> ProviderLoginsPhoneStatus {
    try decode(try await host.runProviderAccountsCommand("providerLogins.status", args: [:]))
  }

  /// One of the person's writes; the answer is the new status.
  @MainActor
  static func write(_ method: String, args: [String: Any], on host: ProviderAccountsHost) async throws -> ProviderLoginsPhoneStatus {
    try decode(try await host.runProviderAccountsCommand("providerLogins.\(method)", args: args))
  }

  private static func decode(_ raw: Any) throws -> ProviderLoginsPhoneStatus {
    let data = try JSONSerialization.data(withJSONObject: raw)
    return try JSONDecoder().decode(ProviderLoginsPhoneStatus.self, from: data)
  }
}
