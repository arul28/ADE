import ClerkKit
import Foundation
import SwiftUI

/// Build-time configuration for the account layer, sourced from Info.plist keys
/// that are populated from build settings (`CLERK_PUBLISHABLE_KEY`,
/// `ADE_ACCOUNT_DIRECTORY_BASE_URL`). Nothing here is hardcoded in source: the
/// publishable key is safe to embed (it's public) but still flows through the
/// build configuration so CI or a different Clerk instance can override it.
enum AccountConfig {
  static var clerkPublishableKey: String? {
    infoValue("ADEClerkPublishableKey")
  }

  static var directoryBaseURL: URL? {
    guard let raw = infoValue("ADEAccountDirectoryBaseURL") else { return nil }
    return URL(string: raw)
  }

  /// Reads a string Info.plist value, treating empty strings and unexpanded
  /// `$(BUILD_SETTING)` placeholders as absent.
  private static func infoValue(_ key: String) -> String? {
    guard let raw = Bundle.main.object(forInfoDictionaryKey: key) as? String else { return nil }
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty, !trimmed.hasPrefix("$(") else { return nil }
    return trimmed
  }
}

/// The signed-in identity, distilled from a ClerkKit `User` into the few fields
/// the UI renders. Provider-aware so surfaces can accent by how the user signed
/// in (Apple / Google / GitHub / Email).
struct AccountIdentity: Equatable {
  var displayName: String
  var email: String?
  var imageURL: URL?
  /// Friendly provider label, e.g. "GitHub", "Google", "Apple", or "Email".
  var providerLabel: String
  /// Lowercased provider id used to resolve a brand accent, e.g. "github".
  var providerId: String

  var accent: Color {
    ADEColor.providerBrand(for: providerId)
  }
}

/// Wraps ClerkKit behind the app's `ObservableObject` convention so SwiftUI
/// surfaces observe published state instead of the `@Observable` `Clerk` type
/// directly. Owns configuration, session restore, the sign-in/out operations,
/// and loading of account machines from the directory Worker.
@MainActor
final class AccountService: ObservableObject {
  static let shared = AccountService()

  enum Phase: Equatable {
    /// No publishable key wired into the build — the account layer is inert and
    /// the app behaves exactly as before (local pairing only).
    case unconfigured
    /// Configuring ClerkKit / restoring a cached session.
    case loading
    case signedOut
    case signedIn
  }

  enum MachinesState: Equatable {
    case idle
    case loading
    case loaded
    /// No directory base URL configured (Worker not deployed yet).
    case unconfigured
    case unreachable(String)
  }

  @Published private(set) var phase: Phase = .loading
  @Published private(set) var identity: AccountIdentity?
  @Published private(set) var machines: [AccountMachine] = []
  @Published private(set) var machinesState: MachinesState = .idle
  /// Transient, user-facing error from the last sign-in attempt.
  @Published var lastError: String?

  private var didConfigure = false
  private var eventTask: Task<Void, Never>?
  private let directory = AccountDirectoryClient()

  var isConfigured: Bool { phase != .unconfigured }
  var isSignedIn: Bool { phase == .signedIn }

  private init() {}

  // MARK: - Lifecycle

  /// Configure ClerkKit once, restore any cached session, and begin observing
  /// auth events. Idempotent — safe to call from `.task` on every appearance.
  func bootstrap() async {
    guard !didConfigure else { return }
    guard let key = AccountConfig.clerkPublishableKey else {
      phase = .unconfigured
      return
    }
    didConfigure = true

    // `configure` hydrates any cached client/session synchronously and kicks a
    // background refresh; we still explicitly refresh so the first-run flow has
    // a determinate signed-in / signed-out state.
    Clerk.configure(publishableKey: key)
    observeAuthEvents()
    syncFromClerk()

    do {
      try await Clerk.shared.refreshEnvironment()
      _ = try await Clerk.shared.refreshClient()
    } catch {
      // Offline / transient — cached state (if any) still stands.
    }
    syncFromClerk()
  }

  private func observeAuthEvents() {
    eventTask?.cancel()
    eventTask = Task { [weak self] in
      for await _ in Clerk.shared.auth.events {
        guard let self else { return }
        self.syncFromClerk()
      }
    }
  }

  /// Recompute published state from the live Clerk instance.
  private func syncFromClerk() {
    guard didConfigure else { return }
    if let user = Clerk.shared.user {
      identity = Self.identity(from: user)
      if phase != .signedIn {
        phase = .signedIn
      }
    } else {
      identity = nil
      machines = []
      machinesState = .idle
      phase = .signedOut
    }
  }

  // MARK: - Sign in

  /// Start an email sign-in: creates the attempt and sends a one-time code.
  func sendEmailCode(to email: String) async throws {
    let trimmed = email.trimmingCharacters(in: .whitespacesAndNewlines)
    guard trimmed.contains("@") else {
      throw AccountError.message("Enter a valid email address.")
    }
    lastError = nil
    _ = try await Clerk.shared.auth.signInWithEmailCode(emailAddress: trimmed)
  }

  /// Verify the emailed code, completing the sign-in when it matches.
  func verifyEmailCode(_ code: String) async throws {
    let trimmed = code.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let signIn = Clerk.shared.auth.currentSignIn else {
      throw AccountError.message("Start the email sign-in again.")
    }
    lastError = nil
    _ = try await signIn.verifyCode(trimmed)
    syncFromClerk()
  }

  /// OAuth sign-in via the system web session (Google / GitHub). ClerkKit
  /// supplies the presentation anchor and handles the redirect callback.
  func signInWithOAuth(_ provider: OAuthProvider) async throws {
    lastError = nil
    _ = try await Clerk.shared.auth.signInWithOAuth(provider: provider)
    syncFromClerk()
  }

  /// Native Sign in with Apple. Requires the Sign-in-with-Apple capability and
  /// the Clerk associated domain (see the app entitlements); works on device
  /// and in a simulator signed into an Apple ID.
  func signInWithApple() async throws {
    lastError = nil
    _ = try await Clerk.shared.auth.signInWithApple()
    syncFromClerk()
  }

  func signOut() async {
    do {
      try await Clerk.shared.auth.signOut()
    } catch {
      // Even if the network revoke fails, drop local state below.
    }
    syncFromClerk()
  }

  // MARK: - Token

  /// The current ClerkKit session token (JWT) for presenting to the directory
  /// Worker as a Bearer credential. `nil` when signed out.
  func sessionToken() async -> String? {
    guard isConfigured else { return nil }
    return try? await Clerk.shared.auth.getToken()
  }

  // MARK: - Machines

  /// Load the caller's machines from the directory Worker. Degrades quietly:
  /// no base URL → `.unconfigured`; unreachable → `.unreachable`; the local
  /// pairing flow is never blocked on this.
  func loadMachines() async {
    guard isSignedIn else { return }
    guard let baseURL = AccountConfig.directoryBaseURL else {
      machinesState = .unconfigured
      return
    }
    guard let token = await sessionToken() else {
      machinesState = .unreachable("Sign in again to load your machines.")
      return
    }

    if machines.isEmpty {
      machinesState = .loading
    }
    do {
      let fetched = try await directory.fetchMachines(baseURL: baseURL, token: token)
      machines = fetched
      machinesState = .loaded
    } catch let error as AccountDirectoryClient.DirectoryError {
      machinesState = .unreachable(error.localizedDescription)
    } catch {
      machinesState = .unreachable("Couldn't load your machines.")
    }
  }

  // MARK: - Identity mapping

  private static func identity(from user: User) -> AccountIdentity {
    let first = user.firstName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let last = user.lastName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let fullName = [first, last].filter { !$0.isEmpty }.joined(separator: " ")
    let email = user.primaryEmailAddress?.emailAddress ?? user.emailAddresses.first?.emailAddress

    let displayName: String = {
      if !fullName.isEmpty { return fullName }
      if let username = user.username, !username.isEmpty { return username }
      if let email, let local = email.split(separator: "@").first { return String(local) }
      return "Signed in"
    }()

    let provider = user.verifiedExternalAccounts.first?.provider
      ?? user.externalAccounts.first?.provider
    let (providerId, providerLabel) = Self.provider(from: provider)

    return AccountIdentity(
      displayName: displayName,
      email: email,
      imageURL: user.hasImage ? URL(string: user.imageUrl) : nil,
      providerLabel: providerLabel,
      providerId: providerId
    )
  }

  /// Normalize a Clerk external-account provider id (e.g. `oauth_github`,
  /// `github`) into a `(brandId, label)` pair.
  private static func provider(from raw: String?) -> (String, String) {
    guard let raw, !raw.isEmpty else { return ("email", "Email") }
    let id = raw
      .replacingOccurrences(of: "oauth_", with: "")
      .lowercased()
    switch id {
    case "github": return ("github", "GitHub")
    case "google": return ("google", "Google")
    case "apple": return ("apple", "Apple")
    default:
      return (id, id.prefix(1).uppercased() + id.dropFirst())
    }
  }
}

enum AccountError: LocalizedError {
  case message(String)

  var errorDescription: String? {
    switch self {
    case .message(let text): return text
    }
  }
}
