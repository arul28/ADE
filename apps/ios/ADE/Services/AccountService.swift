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
  var userId: String
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

enum AccountAuthenticationOutcome: Equatable {
  case newAccount
  case returningUser
  case unknown
}

/// Device-local account boundary. Clerk can retain a cached user when a
/// server-side sign-out fails or while its event stream catches up. Once the
/// user signs out in ADE, that cache must not silently restore account access
/// on a later auth event or app launch. Only a successful, user-initiated
/// sign-in clears this durable suppression flag.
struct AccountLocalSignOutState {
  static let suppressionKey = "ade.account.local-sign-out-suppressed.v1"

  private let defaults: UserDefaults

  init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
  }

  var isSuppressed: Bool {
    defaults.bool(forKey: Self.suppressionKey)
  }

  func suppress() {
    defaults.set(true, forKey: Self.suppressionKey)
  }

  func clearAfterInteractiveSignIn() {
    defaults.removeObject(forKey: Self.suppressionKey)
  }
}

/// Keep token eligibility independently testable from ClerkKit. A cached Clerk
/// session is not enough: ADE must currently publish the same signed-in user
/// and must not be under a device-local sign-out boundary.
func accountSessionTokenIsAllowed(
  localSignOutSuppressed: Bool,
  phaseIsSignedIn: Bool,
  identityUserId: String?,
  clerkUserId: String?
) -> Bool {
  guard !localSignOutSuppressed, phaseIsSignedIn,
        let identityUserId, let clerkUserId else { return false }
  return identityUserId == clerkUserId
}

/// Clerk keeps the user attached to ended, expired, replaced, and revoked
/// sessions. Those cached identities are useful to Clerk's account switcher,
/// but they are not authorization for ADE account machines or Relay.
func accountSessionStatusAllowsAccess(_ status: Session.SessionStatus?) -> Bool {
  status == .active
}

/// A point-in-time account authorization used by account-created pairing.
/// Pairing performs network work, so owner identity alone is insufficient: the
/// generation also changes on local sign-out and account switches, invalidating
/// every in-flight operation that started under the previous account boundary.
struct AccountPairingAuthorization: Equatable, Sendable {
  let ownerId: String
  let generation: UInt64
}

struct AccountPairingSession: Sendable {
  let authorization: AccountPairingAuthorization
  let token: String
}

func accountPairingCommitIsAuthorized(
  _ authorization: AccountPairingAuthorization,
  currentGeneration: UInt64,
  localSignOutSuppressed: Bool,
  phaseIsSignedIn: Bool,
  identityUserId: String?,
  clerkUserId: String?
) -> Bool {
  authorization.generation == currentGeneration
    && authorization.ownerId == identityUserId
    && accountSessionTokenIsAllowed(
      localSignOutSuppressed: localSignOutSuppressed,
      phaseIsSignedIn: phaseIsSignedIn,
      identityUserId: identityUserId,
      clerkUserId: clerkUserId
    )
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
  @Published private(set) var authenticationOutcome: AccountAuthenticationOutcome = .unknown
  /// Transient, user-facing error from the last sign-in attempt.
  @Published var lastError: String?

  private var didConfigure = false
  private var eventTask: Task<Void, Never>?
  private var emailVerificationKind: AccountEmailVerificationKind?
  private let directory = AccountDirectoryClient()
  private let localSignOutState = AccountLocalSignOutState()
  private var pairingAuthorizationGeneration: UInt64 = 0

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
    guard !localSignOutState.isSuppressed else {
      publishSignedOut()
      return
    }
    if accountSessionStatusAllowsAccess(Clerk.shared.session?.status),
       let user = Clerk.shared.user {
      let nextIdentity = Self.identity(from: user)
      let shouldRefreshMachines = identity?.userId != nextIdentity.userId || phase != .signedIn
      if identity?.userId != nextIdentity.userId {
        invalidatePairingAuthorization()
      }
      SyncService.shared?.removeAccountOwnedPairings(exceptOwnerId: nextIdentity.userId)
      identity = nextIdentity
      if phase != .signedIn {
        phase = .signedIn
      }
      if shouldRefreshMachines {
        Task { await self.loadMachines() }
      }
    } else {
      publishSignedOut()
    }
  }

  private func publishSignedOut() {
    invalidatePairingAuthorization()
    SyncService.shared?.removeAccountOwnedPairings(exceptOwnerId: nil)
    identity = nil
    machines = []
    machinesState = .idle
    phase = .signedOut
  }

  private func invalidatePairingAuthorization() {
    pairingAuthorizationGeneration &+= 1
  }

  /// Called only after an explicit sign-in operation completes and Clerk has
  /// published a real user. Merely receiving a cached auth event never clears
  /// the local sign-out boundary.
  private func finishInteractiveSignIn() {
    guard accountSessionStatusAllowsAccess(Clerk.shared.session?.status),
          Clerk.shared.user != nil else { return }
    localSignOutState.clearAfterInteractiveSignIn()
    syncFromClerk()
  }

  // MARK: - Sign in

  /// Start an email sign-in-or-sign-up attempt and send a one-time code.
  func sendEmailCode(to email: String) async throws {
    let trimmed = email.trimmingCharacters(in: .whitespacesAndNewlines)
    guard trimmed.contains("@") else {
      throw AccountError.message("Enter a valid email address.")
    }
    lastError = nil
    emailVerificationKind = nil
    emailVerificationKind = try await AccountEmailAuthFlow.sendCode(
      to: trimmed,
      actions: emailAuthActions()
    )
  }

  /// Verify the emailed code against the attempt that sent it.
  func verifyEmailCode(_ code: String) async throws {
    let trimmed = code.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let emailVerificationKind else {
      ProductAnalytics.shared.captureSignInOutcome(.failed)
      throw AccountError.message("Start the email verification again.")
    }
    lastError = nil
    do {
      try await AccountEmailAuthFlow.verifyCode(
        trimmed,
        kind: emailVerificationKind,
        actions: emailAuthActions()
      )
      authenticationOutcome = emailVerificationKind == .signUp ? .newAccount : .returningUser
      finishInteractiveSignIn()
      ProductAnalytics.shared.captureSignInOutcome(
        authenticationOutcome == .newAccount ? .newAccount : .returningUser
      )
    } catch {
      ProductAnalytics.shared.captureSignInOutcome(.failed)
      throw error
    }
  }

  /// OAuth sign-in via the system web session (Google / GitHub). ClerkKit
  /// supplies the presentation anchor and handles the redirect callback.
  func signInWithOAuth(_ provider: OAuthProvider) async throws {
    lastError = nil
    do {
      let result = try await Clerk.shared.auth.signInWithOAuth(provider: provider)
      authenticationOutcome = Self.outcome(from: result)
      finishInteractiveSignIn()
      ProductAnalytics.shared.captureSignInOutcome(
        authenticationOutcome == .newAccount ? .newAccount : .returningUser
      )
    } catch {
      ProductAnalytics.shared.captureSignInOutcome(.failed)
      throw error
    }
  }

  /// Native Sign in with Apple. Requires the Sign-in-with-Apple capability and
  /// the Clerk associated domain (see the app entitlements); works on device
  /// and in a simulator signed into an Apple ID.
  func signInWithApple() async throws {
    lastError = nil
    do {
      let result = try await Clerk.shared.auth.signInWithApple()
      authenticationOutcome = Self.outcome(from: result)
      finishInteractiveSignIn()
      ProductAnalytics.shared.captureSignInOutcome(
        authenticationOutcome == .newAccount ? .newAccount : .returningUser
      )
    } catch {
      ProductAnalytics.shared.captureSignInOutcome(.failed)
      throw error
    }
  }

  func signOut() async {
    // Make the user's local choice authoritative before attempting network
    // revocation. If that request fails, cached Clerk state and subsequent auth
    // events still cannot restore account machines or issue a session token.
    localSignOutState.suppress()
    publishSignedOut()
    do {
      try await Clerk.shared.auth.signOut()
    } catch {
      // The local suppression boundary above remains authoritative even when
      // Clerk cannot revoke the server session right now.
    }
    authenticationOutcome = .unknown
    emailVerificationKind = nil
    syncFromClerk()
  }

  // MARK: - Token

  var currentPairingAuthorization: AccountPairingAuthorization? {
    guard let ownerId = identity?.userId,
          accountSessionStatusAllowsAccess(Clerk.shared.session?.status),
          accountSessionTokenIsAllowed(
            localSignOutSuppressed: localSignOutState.isSuppressed,
            phaseIsSignedIn: phase == .signedIn,
            identityUserId: ownerId,
            clerkUserId: Clerk.shared.user?.id
          ) else { return nil }
    return AccountPairingAuthorization(
      ownerId: ownerId,
      generation: pairingAuthorizationGeneration
    )
  }

  func isPairingCommitAuthorized(_ authorization: AccountPairingAuthorization) -> Bool {
    accountPairingCommitIsAuthorized(
      authorization,
      currentGeneration: pairingAuthorizationGeneration,
      localSignOutSuppressed: localSignOutState.isSuppressed,
      phaseIsSignedIn: phase == .signedIn,
      identityUserId: identity?.userId,
      clerkUserId: Clerk.shared.user?.id
    )
  }

  /// Returns an access token tied to the exact account generation that requested
  /// it. If sign-out or an account switch occurs while Clerk is refreshing, the
  /// result is discarded instead of escaping under stale authorization.
  func pairingSession() async -> AccountPairingSession? {
    guard let authorization = currentPairingAuthorization,
          let token = try? await Clerk.shared.auth.getToken(),
          isPairingCommitAuthorized(authorization) else { return nil }
    return AccountPairingSession(authorization: authorization, token: token)
  }

  /// The current ClerkKit session token (JWT) for presenting to the directory
  /// Worker as a Bearer credential. `nil` when signed out.
  func sessionToken() async -> String? {
    guard isConfigured else { return nil }
    return await pairingSession()?.token
  }

  // MARK: - Machines

  /// Load the caller's machines from the directory Worker. Degrades quietly:
  /// no base URL → `.unconfigured`; unreachable → `.unreachable`; the local
  /// pairing flow is never blocked on this.
  func loadMachines() async {
    guard isSignedIn, let requestedOwnerId = identity?.userId else { return }
    guard let baseURL = AccountConfig.directoryBaseURL else {
      machinesState = .unconfigured
      return
    }
    guard let token = await sessionToken() else {
      guard identity?.userId == requestedOwnerId, phase == .signedIn else { return }
      machinesState = .unreachable("Sign in again to load your machines.")
      return
    }
    guard identity?.userId == requestedOwnerId, phase == .signedIn else { return }

    if machines.isEmpty {
      machinesState = .loading
    }
    do {
      let fetched = try await directory.fetchMachines(baseURL: baseURL, token: token)
      guard identity?.userId == requestedOwnerId, phase == .signedIn else { return }
      machines = fetched
      SyncService.shared?.adoptVerifiedAccountRelayMetadata(
        from: fetched,
        ownerId: requestedOwnerId
      )
      machinesState = .loaded
    } catch let error as AccountDirectoryClient.DirectoryError {
      guard identity?.userId == requestedOwnerId, phase == .signedIn else { return }
      machinesState = .unreachable(error.localizedDescription)
    } catch {
      guard identity?.userId == requestedOwnerId, phase == .signedIn else { return }
      machinesState = .unreachable("Couldn't load your machines.")
    }
  }

  // MARK: - Identity mapping

  private func emailAuthActions() -> AccountEmailAuthActions {
    AccountEmailAuthActions(
      startSignIn: { email in
        _ = try await Clerk.shared.auth.signInWithEmailCode(emailAddress: email)
      },
      startSignUp: { email in
        let signUp = try await Clerk.shared.auth.signUp(emailAddress: email)
        _ = try await signUp.sendEmailCode()
      },
      verifySignIn: { code in
        guard let signIn = Clerk.shared.auth.currentSignIn else {
          throw AccountError.message("Start the email verification again.")
        }
        _ = try await signIn.verifyCode(code)
      },
      verifySignUp: { code in
        guard let signUp = Clerk.shared.auth.currentSignUp else {
          throw AccountError.message("Start the email verification again.")
        }
        _ = try await signUp.verifyEmailCode(code)
      }
    )
  }

  private static func outcome(from result: TransferFlowResult) -> AccountAuthenticationOutcome {
    switch result {
    case .signIn: return .returningUser
    case .signUp: return .newAccount
    }
  }

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
      userId: user.id,
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
