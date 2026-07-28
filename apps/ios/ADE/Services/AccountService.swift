import ClerkKit
import Foundation
import SwiftUI
import UIKit

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

  static var attentionRelayBaseURL: URL? {
    guard let raw = infoValue("ADEPushRelayBaseURL") else { return nil }
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

struct AccountDeviceOwnershipState: Codable, Equatable {
  static let maximumSafeEpoch = 9_007_199_254_740_991

  let ownershipEpoch: Int
  let ownerId: String?
}

struct AccountDeviceOwnershipStore {
  private let defaults: UserDefaults
  private let key: String
  private let durableDeviceId: () -> String?
  private let loadDurableEpoch: (String) -> Int?
  private let saveDurableEpoch: (Int, String) -> Void

  init() {
    let keychain = KeychainService()
    self.init(
      defaults: ADESharedContainer.defaults,
      key: ADESharedContainer.accountDeviceOwnershipStateKey,
      durableDeviceId: { keychain.loadDeviceId() },
      loadDurableEpoch: { keychain.loadAccountDeviceOwnershipEpoch(deviceId: $0) },
      saveDurableEpoch: {
        keychain.saveAccountDeviceOwnershipEpoch($0, deviceId: $1)
      }
    )
  }

  init(defaults: UserDefaults, key: String) {
    self.init(
      defaults: defaults,
      key: key,
      durableDeviceId: { nil },
      loadDurableEpoch: { _ in nil },
      saveDurableEpoch: { _, _ in }
    )
  }

  init(
    defaults: UserDefaults,
    key: String,
    durableDeviceId: @escaping () -> String?,
    loadDurableEpoch: @escaping (String) -> Int?,
    saveDurableEpoch: @escaping (Int, String) -> Void
  ) {
    self.defaults = defaults
    self.key = key
    self.durableDeviceId = durableDeviceId
    self.loadDurableEpoch = loadDurableEpoch
    self.saveDurableEpoch = saveDurableEpoch
  }

  var state: AccountDeviceOwnershipState {
    let sharedState: AccountDeviceOwnershipState
    if let data = defaults.data(forKey: key),
       let decoded = try? JSONDecoder().decode(AccountDeviceOwnershipState.self, from: data),
       Self.isValid(epoch: decoded.ownershipEpoch) {
      sharedState = decoded
    } else {
      sharedState = AccountDeviceOwnershipState(ownershipEpoch: 1, ownerId: nil)
    }
    guard let deviceId = normalizedDurableDeviceId,
          let durableEpoch = loadDurableEpoch(deviceId),
          Self.isValid(epoch: durableEpoch),
          durableEpoch > sharedState.ownershipEpoch else {
      return sharedState
    }
    // App Group defaults are removed on reinstall while the Keychain device
    // identity survives. Recover the epoch high-water mark, but never infer an
    // owner from stale defaults; the next signed-in transition advances it.
    return AccountDeviceOwnershipState(ownershipEpoch: durableEpoch, ownerId: nil)
  }

  /// Commits the account boundary before any network request is allowed to use
  /// it. Repeating the same owner is stable; every owner/nil transition
  /// advances the per-install epoch monotonically.
  @discardableResult
  func transition(to ownerId: String?) -> AccountDeviceOwnershipState {
    let normalizedOwnerId = ownerId?
      .trimmingCharacters(in: .whitespacesAndNewlines)
    let resolvedOwnerId = normalizedOwnerId?.isEmpty == false ? normalizedOwnerId : nil
    let current = state
    guard current.ownerId != resolvedOwnerId else {
      persist(current)
      return current
    }
    let nextEpoch = min(
      AccountDeviceOwnershipState.maximumSafeEpoch,
      max(1, current.ownershipEpoch) + 1
    )
    let next = AccountDeviceOwnershipState(
      ownershipEpoch: nextEpoch,
      ownerId: resolvedOwnerId
    )
    persist(next)
    return next
  }

  private func persist(_ state: AccountDeviceOwnershipState) {
    guard let data = try? JSONEncoder().encode(state) else { return }
    defaults.set(data, forKey: key)
    defaults.synchronize()
    if let deviceId = normalizedDurableDeviceId {
      saveDurableEpoch(state.ownershipEpoch, deviceId)
    }
  }

  private var normalizedDurableDeviceId: String? {
    let normalized = durableDeviceId()?
      .trimmingCharacters(in: .whitespacesAndNewlines)
    return normalized?.isEmpty == false ? normalized : nil
  }

  private static func isValid(epoch: Int) -> Bool {
    epoch > 0 && epoch <= AccountDeviceOwnershipState.maximumSafeEpoch
  }
}

/// Durable marker proving this installation still owes Relay a device
/// revocation. It deliberately stores no Clerk credential: an explicit
/// sign-out uses its live token immediately, while a later sign-in either
/// retries under the same owner or atomically transfers the device to the new
/// owner by registering it before clearing this marker.
struct PendingAccountDeviceRevocation: Codable, Equatable {
  let ownerId: String
  let deviceId: String
  let ownershipEpoch: Int
  let createdAt: Date

  private enum CodingKeys: String, CodingKey {
    case ownerId
    case deviceId
    case ownershipEpoch
    case createdAt
  }

  init(ownerId: String, deviceId: String, ownershipEpoch: Int, createdAt: Date) {
    self.ownerId = ownerId
    self.deviceId = deviceId
    self.ownershipEpoch = ownershipEpoch
    self.createdAt = createdAt
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    ownerId = try container.decode(String.self, forKey: .ownerId)
    deviceId = try container.decode(String.self, forKey: .deviceId)
    // v1 pending markers predate ownership epochs. Treat them as the oldest
    // valid epoch so the next boundary safely replaces them.
    ownershipEpoch = try container.decodeIfPresent(Int.self, forKey: .ownershipEpoch) ?? 1
    createdAt = try container.decode(Date.self, forKey: .createdAt)
  }
}

struct AccountDeviceRevocationStore {
  private let defaults: UserDefaults
  private let key: String

  init(
    defaults: UserDefaults = ADESharedContainer.defaults,
    key: String = ADESharedContainer.pendingAccountDeviceRevocationKey
  ) {
    self.defaults = defaults
    self.key = key
  }

  var pending: PendingAccountDeviceRevocation? {
    guard let data = defaults.data(forKey: key) else { return nil }
    return try? JSONDecoder().decode(PendingAccountDeviceRevocation.self, from: data)
  }

  @discardableResult
  func mark(
    ownerId: String,
    deviceId: String,
    ownershipEpoch: Int,
    now: Date = Date()
  ) -> PendingAccountDeviceRevocation? {
    let normalizedOwnerId = ownerId.trimmingCharacters(in: .whitespacesAndNewlines)
    let normalizedDeviceId = deviceId.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalizedOwnerId.isEmpty,
          !normalizedDeviceId.isEmpty,
          ownershipEpoch > 0,
          ownershipEpoch <= AccountDeviceOwnershipState.maximumSafeEpoch else {
      return nil
    }
    // A newer boundary supersedes every older pending mutation for this
    // installation. Preserve only an equal/newer marker.
    if let existing = pending,
       existing.deviceId == normalizedDeviceId,
       existing.ownershipEpoch >= ownershipEpoch {
      return existing
    }
    let record = PendingAccountDeviceRevocation(
      ownerId: normalizedOwnerId,
      deviceId: normalizedDeviceId,
      ownershipEpoch: ownershipEpoch,
      createdAt: now
    )
    guard let data = try? JSONEncoder().encode(record) else { return nil }
    defaults.set(data, forKey: key)
    defaults.synchronize()
    return record
  }

  func clear(ifMatching record: PendingAccountDeviceRevocation? = nil) {
    if let record, pending != record { return }
    defaults.removeObject(forKey: key)
    defaults.synchronize()
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

func accountDeviceMutationMatchesCurrentOwnership(
  ownerId: String,
  ownershipEpoch: Int,
  state: AccountDeviceOwnershipState
) -> Bool {
  ownershipEpoch == state.ownershipEpoch && ownerId == state.ownerId
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

private struct AccountAttentionDeviceRegistrationRequest {
  let authorization: AccountPairingAuthorization
  let deviceId: String
  let ownershipEpoch: Int
  let apnsToken: String?
  let pushToStartToken: String?
  let clearPushToStartToken: Bool
  let bundleId: String
  let apsEnvironment: String
  let preferences: [String: Any]
}

private struct AccountAttentionDevicePreferencesRequest {
  let authorization: AccountPairingAuthorization
  let deviceId: String
  let devicePreferences: [String: Any]
}

/// Serializes account device PUTs while coalescing queued refreshes to the most
/// recent request. An in-flight request is allowed to finish because Relay's
/// ownership epoch makes it harmless after an account boundary; no later PUT
/// can overtake it.
@MainActor
final class LatestAccountRegistrationQueue<Request> {
  private var inFlight: Task<Bool, Never>?
  private var pending: Request?

  func submit(
    _ request: Request,
    perform: @escaping @MainActor (Request) async -> Bool
  ) async -> Bool {
    pending = request
    if let inFlight {
      return await inFlight.value
    }
    let task = Task { @MainActor [weak self] in
      guard let self else { return false }
      var result = false
      while let request = self.pending {
        self.pending = nil
        result = await perform(request)
      }
      // This runs without an actor suspension after observing an empty queue,
      // so a new submit can never attach to a completed drain.
      self.inFlight = nil
      return result
    }
    inFlight = task
    return await task.value
  }

  func discardPending() {
    pending = nil
  }
}

struct AccountRelayTokenPolicy: Equatable {
  static let production = AccountRelayTokenPolicy(expirationBuffer: 60, skipCache: true)

  let expirationBuffer: Double
  let skipCache: Bool
}

enum AccountRelayTokenError: Error, LocalizedError {
  case authorizationChanged
  case tokenUnavailable

  var errorDescription: String? {
    switch self {
    case .authorizationChanged:
      return "The signed-in account changed while Relay was connecting."
    case .tokenUnavailable:
      return "Sign in again to connect through Relay."
    }
  }
}

func accountFreshRelaySession(
  requestedAuthorization: AccountPairingAuthorization,
  currentAuthorization: AccountPairingAuthorization?,
  token: String?
) -> AccountPairingSession? {
  guard currentAuthorization == requestedAuthorization,
        let token = token?.trimmingCharacters(in: .whitespacesAndNewlines),
        !token.isEmpty else { return nil }
  return AccountPairingSession(authorization: requestedAuthorization, token: token)
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
  /// Bumped after a new account Attention snapshot is committed to the App
  /// Group. The in-app model observes this alongside SyncService revisions.
  @Published private(set) var attentionSnapshotRevision = 0
  /// Transient, user-facing error from the last sign-in attempt.
  @Published var lastError: String?

  private var didConfigure = false
  private var eventTask: Task<Void, Never>?
  private var emailVerificationKind: AccountEmailVerificationKind?
  private let directory = AccountDirectoryClient()
  private let attentionRelay = AccountAttentionRelayClient()
  private let localSignOutState = AccountLocalSignOutState()
  private let deviceRevocationStore = AccountDeviceRevocationStore()
  private let deviceOwnershipStore = AccountDeviceOwnershipStore()
  private var pairingAuthorizationGeneration: UInt64 = 0
  private var lastRelayCredential: (ownerId: String, token: String)?
  private var attentionRefreshTask: Task<Void, Never>?
  private var attentionRefreshId: UUID?
  private var isEndingAccountOwnership = false
  private let accountRegistrationQueue =
    LatestAccountRegistrationQueue<AccountAttentionDeviceRegistrationRequest>()
  private let accountPreferencesQueue =
    LatestAccountRegistrationQueue<AccountAttentionDevicePreferencesRequest>()

  var isConfigured: Bool { phase != .unconfigured }
  var isSignedIn: Bool { phase == .signedIn }
  var hasPendingAttentionDeviceRevocation: Bool {
    deviceRevocationStore.pending != nil
  }

  /// Stable identity used for every account Attention device endpoint. It
  /// intentionally matches the machine-registration device identity whenever
  /// SyncService is available so registration, prefs, activities, and sign-out
  /// all target the same relay row.
  var attentionDeviceId: String {
    SyncService.shared?.deviceId
      ?? UIDevice.current.identifierForVendor?.uuidString.lowercased()
      ?? "ios-device"
  }

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
      let previousOwnership = deviceOwnershipStore.state
      let previousOwnerId = previousOwnership.ownerId
      let ownerChanged = previousOwnerId != nextIdentity.userId
      let accountSwitched = ownerChanged && previousOwnerId != nil
      var switchRevocation: PendingAccountDeviceRevocation?
      var switchCredential: (ownerId: String, token: String)?
      if accountSwitched, let previousOwnerId {
        // A direct account switch is two ownership boundaries. The old
        // account's DELETE uses the unowned epoch; the new account's PUT gets
        // the following epoch, so equal-epoch foreign-owner requests can never
        // race at Relay.
        let unowned = deviceOwnershipStore.transition(to: nil)
        switchRevocation = deviceRevocationStore.mark(
          ownerId: previousOwnerId,
          deviceId: attentionDeviceId,
          ownershipEpoch: unowned.ownershipEpoch
        )
        switchCredential = lastRelayCredential
        lastRelayCredential = nil
        accountRegistrationQueue.discardPending()
        accountPreferencesQueue.discardPending()
        cancelAttentionRefresh()
        LiveActivityService.shared.prepareForAccountSignOut()
      }
      deviceOwnershipStore.transition(to: nextIdentity.userId)
      // A live signed-in owner has committed the account boundary, including
      // non-interactive Clerk session restoration.
      isEndingAccountOwnership = false
      if identity?.userId != nextIdentity.userId {
        invalidatePairingAuthorization()
        clearAttentionSnapshot()
      }
      SyncService.shared?.removeAccountOwnedPairings(exceptOwnerId: nextIdentity.userId)
      identity = nextIdentity
      if phase != .signedIn {
        phase = .signedIn
      }
      if shouldRefreshMachines {
        Task {
          if accountSwitched {
            await LiveActivityService.shared.handleAccountSignOut(immediate: true)
            if let switchRevocation,
               let switchCredential,
               switchCredential.ownerId == switchRevocation.ownerId {
              await self.attemptDeviceRevocation(
                switchRevocation,
                token: switchCredential.token
              )
            }
          }
          await self.processPendingDeviceRevocationAfterSignIn()
          // Transfer/revoke this installation before slower directory and
          // snapshot hydration, minimizing any window where the prior account
          // could still target the same APNs token.
          await PushNotificationService.shared.resumeAccountRegistrationIfAuthorized()
          async let machines: Void = self.loadMachines()
          async let attention: Void = self.refreshAttentionSnapshot()
          _ = await (machines, attention)
          await LiveActivityService.shared.handleAccountSignIn()
        }
      }
    } else {
      publishSignedOut()
    }
  }

  private func publishSignedOut() {
    isEndingAccountOwnership = true
    let previousOwnerId = identity?.userId ?? deviceOwnershipStore.state.ownerId
    let signedOutOwnership = deviceOwnershipStore.transition(to: nil)
    let cachedCredential = lastRelayCredential
    let pendingRevocation: PendingAccountDeviceRevocation?
    if !localSignOutState.isSuppressed, let previousOwnerId {
      pendingRevocation = deviceRevocationStore.mark(
        ownerId: previousOwnerId,
        deviceId: attentionDeviceId,
        ownershipEpoch: signedOutOwnership.ownershipEpoch
      )
    } else {
      pendingRevocation = nil
    }
    lastRelayCredential = nil
    accountRegistrationQueue.discardPending()
    accountPreferencesQueue.discardPending()
    cancelAttentionRefresh()
    invalidatePairingAuthorization()
    SyncService.shared?.removeAccountOwnedPairings(exceptOwnerId: nil)
    identity = nil
    machines = []
    machinesState = .idle
    phase = .signedOut
    clearAttentionSnapshot()
    LiveActivityService.shared.prepareForAccountSignOut()
    PushNotificationService.shared.handleAccountSignOut()
    Task {
      await LiveActivityService.shared.handleAccountSignOut(immediate: true)
      if let pendingRevocation,
         let cachedCredential,
         cachedCredential.ownerId == pendingRevocation.ownerId {
        await self.attemptDeviceRevocation(
          pendingRevocation,
          token: cachedCredential.token
        )
      }
    }
  }

  private func invalidatePairingAuthorization() {
    pairingAuthorizationGeneration &+= 1
  }

  private func cancelAttentionRefresh() {
    attentionRefreshTask?.cancel()
    attentionRefreshTask = nil
    attentionRefreshId = nil
  }

  /// Called only after an explicit sign-in operation completes and Clerk has
  /// published a real user. Merely receiving a cached auth event never clears
  /// the local sign-out boundary.
  private func finishInteractiveSignIn() {
    guard accountSessionStatusAllowsAccess(Clerk.shared.session?.status),
          Clerk.shared.user != nil else { return }
    isEndingAccountOwnership = false
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
    // Capture the current credential and persist the cleanup obligation before
    // invalidating local authorization. The UI/account boundary is then
    // committed before the bounded Relay request begins.
    isEndingAccountOwnership = true
    accountRegistrationQueue.discardPending()
    accountPreferencesQueue.discardPending()
    let revocation = await prepareAttentionDeviceRevocationForSignOut()
    // Make the user's local choice authoritative before Clerk revocation. If
    // that request fails, cached Clerk state and subsequent auth events still
    // cannot restore account machines or issue a session token.
    localSignOutState.suppress()
    publishSignedOut()
    if let revocation, let token = revocation.token {
      await attemptDeviceRevocation(revocation.pending, token: token)
    }
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

  private func prepareAttentionDeviceRevocationForSignOut() async -> (
    pending: PendingAccountDeviceRevocation,
    token: String?
  )? {
    guard let ownerId = identity?.userId ?? deviceOwnershipStore.state.ownerId else {
      return nil
    }
    let cachedToken = lastRelayCredential?.ownerId == ownerId
      ? lastRelayCredential?.token
      : nil
    let token: String?
    if let cachedToken {
      token = cachedToken
    } else {
      token = (await pairingSession())?.token
    }
    // Token acquisition may suspend, so device registration is blocked by
    // `isEndingAccountOwnership` above. Commit the epoch only after that await
    // and immediately before publishing the local sign-out boundary.
    let signedOutOwnership = deviceOwnershipStore.transition(to: nil)
    guard let pending = deviceRevocationStore.mark(
      ownerId: ownerId,
      deviceId: attentionDeviceId,
      ownershipEpoch: signedOutOwnership.ownershipEpoch
    ), pending.ownerId == ownerId else {
      return nil
    }
    return (pending, token)
  }

  private func attemptDeviceRevocation(
    _ pending: PendingAccountDeviceRevocation,
    token: String
  ) async {
    guard let baseURL = AccountConfig.attentionRelayBaseURL else { return }
    do {
      try await attentionRelay.unregisterDevice(
        baseURL: baseURL,
        token: token,
        deviceId: pending.deviceId,
        ownershipEpoch: pending.ownershipEpoch,
        timeoutInterval: 2
      )
      deviceRevocationStore.clear(ifMatching: pending)
    } catch AccountAttentionRelayClient.RelayError.staleOwnership {
      // Relay has already accepted a newer ownership boundary for this
      // installation. Retrying this older DELETE can never improve state.
      deviceRevocationStore.clear(ifMatching: pending)
    } catch {
      // Keep the durable marker. The same owner can retry on its next login;
      // another owner clears it only after Relay atomically transfers the
      // device during registration.
    }
  }

  private func processPendingDeviceRevocationAfterSignIn() async {
    guard let pending = deviceRevocationStore.pending,
          pending.ownerId == identity?.userId,
          let session = await pairingSession() else {
      return
    }
    await attemptDeviceRevocation(pending, token: session.token)
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
    lastRelayCredential = (authorization.ownerId, token)
    return AccountPairingSession(authorization: authorization, token: token)
  }

  /// Fetch a server-fresh Clerk JWT at the instant Relay authentication is
  /// about to be sent. Clerk JWTs have a one-minute TTL, so a token obtained
  /// before route discovery can already be near expiry when Relay sees it.
  /// The account generation is checked on both sides of the suspension point.
  func freshRelaySession(
    expectedAuthorization: AccountPairingAuthorization? = nil
  ) async throws -> AccountPairingSession {
    guard let authorization = currentPairingAuthorization,
          expectedAuthorization == nil || expectedAuthorization == authorization else {
      throw AccountRelayTokenError.authorizationChanged
    }
    let policy = AccountRelayTokenPolicy.production
    let token = try await Clerk.shared.auth.getToken(
      Session.GetTokenOptions(
        expirationBuffer: policy.expirationBuffer,
        skipCache: policy.skipCache
      )
    )
    guard let session = accountFreshRelaySession(
      requestedAuthorization: authorization,
      currentAuthorization: currentPairingAuthorization,
      token: token
    ) else {
      if currentPairingAuthorization != authorization {
        throw AccountRelayTokenError.authorizationChanged
      }
      throw AccountRelayTokenError.tokenUnavailable
    }
    lastRelayCredential = (authorization.ownerId, session.token)
    return session
  }

  /// The current ClerkKit session token (JWT) for presenting to the directory
  /// Worker as a Bearer credential. `nil` when signed out.
  func sessionToken() async -> String? {
    guard isConfigured else { return nil }
    return await pairingSession()?.token
  }

  // MARK: - Account Attention

  /// Fetch the account delta using a server-fresh Clerk token, merge it with
  /// the last complete App Group snapshot, and notify app/widgets. Failures are
  /// deliberately quiet: the current workspace snapshot remains usable.
  func refreshAttentionSnapshot() async {
    if let attentionRefreshTask {
      await attentionRefreshTask.value
      return
    }
    let task = Task { @MainActor [weak self] in
      guard let self else { return }
      await self.performAttentionSnapshotRefresh()
    }
    let refreshId = UUID()
    attentionRefreshTask = task
    attentionRefreshId = refreshId
    await task.value
    if attentionRefreshId == refreshId {
      attentionRefreshTask = nil
      attentionRefreshId = nil
    }
  }

  private func performAttentionSnapshotRefresh() async {
    guard isSignedIn,
          !isEndingAccountOwnership,
          let requestedOwnerId = identity?.userId,
          let baseURL = AccountConfig.attentionRelayBaseURL,
          let initialSession = await pairingSession(),
          initialSession.authorization.ownerId == requestedOwnerId,
          isPairingCommitAuthorized(initialSession.authorization) else {
      return
    }

    let existing = ADESharedContainer.readAttentionSnapshot()
    do {
      let delta = try await attentionRelay.fetchSnapshot(
        baseURL: baseURL,
        token: initialSession.token,
        since: existing?.revision ?? 0,
        streamId: existing?.streamId,
        refreshToken: { [weak self] in
          guard let self,
                self.isPairingCommitAuthorized(initialSession.authorization) else {
            return nil
          }
          return try? await self.freshRelaySession(
            expectedAuthorization: initialSession.authorization
          ).token
        }
      )
      guard isPairingCommitAuthorized(initialSession.authorization),
            identity?.userId == requestedOwnerId else {
        return
      }
      // Another writer may have committed a newer response while this request
      // was suspended. Always merge against the latest durable snapshot, never
      // the stale preflight read used to construct `since`.
      let complete = accountAttentionSnapshotForCommit(
        current: ADESharedContainer.readAttentionSnapshot(),
        incoming: delta
      )
      guard ADESharedContainer.writeAttentionSnapshot(complete) else { return }
      attentionSnapshotRevision &+= 1
      WidgetReloadBridge.reloadAllTimelines()
    } catch {
      // Keep the last-known account snapshot and machine-local fallback.
    }
  }

  func acknowledgeAttentionItems(_ itemIds: [String], dismiss: Bool) async {
    let ids = Array(Set(itemIds.filter { !$0.isEmpty })).prefix(64)
    guard !ids.isEmpty,
          isSignedIn,
          let requestedOwnerId = identity?.userId,
          let baseURL = AccountConfig.attentionRelayBaseURL,
          let initialSession = await pairingSession(),
          initialSession.authorization.ownerId == requestedOwnerId,
          isPairingCommitAuthorized(initialSession.authorization) else {
      return
    }
    do {
      try await attentionRelay.acknowledge(
        baseURL: baseURL,
        token: initialSession.token,
        itemIds: Array(ids),
        dismiss: dismiss,
        refreshToken: { [weak self] in
          guard let self,
                self.isPairingCommitAuthorized(initialSession.authorization) else {
            return nil
          }
          return try? await self.freshRelaySession(
            expectedAuthorization: initialSession.authorization
          ).token
        }
      )
      await refreshAttentionSnapshot()
    } catch {
      // The local seen state remains useful offline. A later snapshot refresh
      // will reconcile shared acknowledgment.
    }
  }

  func updateAttentionPresence(
    centerVisible: Bool,
    visibleItemIds: [String]
  ) async {
    guard isSignedIn,
          let requestedOwnerId = identity?.userId,
          let baseURL = AccountConfig.attentionRelayBaseURL,
          let initialSession = await pairingSession(),
          initialSession.authorization.ownerId == requestedOwnerId,
          isPairingCommitAuthorized(initialSession.authorization) else {
      return
    }
    try? await attentionRelay.updatePresence(
      baseURL: baseURL,
      token: initialSession.token,
      deviceId: attentionDeviceId,
      deviceName: UIDevice.current.name,
      foreground: true,
      attentionVisible: centerVisible,
      visibleItemIds: visibleItemIds,
      refreshToken: { [weak self] in
        guard let self,
              self.isPairingCommitAuthorized(initialSession.authorization) else {
          return nil
        }
        return try? await self.freshRelaySession(
          expectedAuthorization: initialSession.authorization
        ).token
      }
    )
  }

  func registerAttentionDevice(
    deviceId: String,
    apnsToken: String?,
    pushToStartToken: String?,
    clearPushToStartToken: Bool = false,
    bundleId: String,
    apsEnvironment: String,
    preferences: [String: Any]
  ) async -> Bool {
    guard isSignedIn,
          let requestedOwnerId = identity?.userId,
          AccountConfig.attentionRelayBaseURL != nil,
          let authorization = currentPairingAuthorization,
          authorization.ownerId == requestedOwnerId else {
      return false
    }
    let ownership = deviceOwnershipStore.transition(to: requestedOwnerId)
    let request = AccountAttentionDeviceRegistrationRequest(
      authorization: authorization,
      deviceId: deviceId,
      ownershipEpoch: ownership.ownershipEpoch,
      apnsToken: apnsToken,
      pushToStartToken: pushToStartToken,
      clearPushToStartToken: clearPushToStartToken,
      bundleId: bundleId,
      apsEnvironment: apsEnvironment,
      preferences: preferences
    )
    return await accountRegistrationQueue.submit(request) { [weak self] request in
      guard let self else { return false }
      return await self.performAttentionDeviceRegistration(request)
    }
  }

  func updateAttentionDevicePreferences(
    deviceId: String,
    devicePreferences: [String: Any]
  ) async -> Bool {
    guard isSignedIn,
          let requestedOwnerId = identity?.userId,
          AccountConfig.attentionRelayBaseURL != nil,
          let authorization = currentPairingAuthorization,
          authorization.ownerId == requestedOwnerId else {
      return false
    }
    let request = AccountAttentionDevicePreferencesRequest(
      authorization: authorization,
      deviceId: deviceId,
      devicePreferences: devicePreferences
    )
    return await accountPreferencesQueue.submit(request) { [weak self] request in
      guard let self else { return false }
      return await self.performAttentionDevicePreferencesUpdate(request)
    }
  }

  private func performAttentionDevicePreferencesUpdate(
    _ request: AccountAttentionDevicePreferencesRequest
  ) async -> Bool {
    guard let baseURL = AccountConfig.attentionRelayBaseURL,
          let initialSession = try? await freshRelaySession(
            expectedAuthorization: request.authorization
          ) else {
      return false
    }
    let refreshToken: () async -> String? = { [weak self] in
      guard let self,
            self.isPairingCommitAuthorized(request.authorization) else {
        return nil
      }
      return try? await self.freshRelaySession(
        expectedAuthorization: request.authorization
      ).token
    }
    do {
      try await attentionRelay.updateDevicePreferences(
        baseURL: baseURL,
        token: initialSession.token,
        deviceId: request.deviceId,
        devicePreferences: request.devicePreferences,
        refreshToken: refreshToken
      )
      return isPairingCommitAuthorized(request.authorization)
    } catch {
      return false
    }
  }

  private func performAttentionDeviceRegistration(
    _ request: AccountAttentionDeviceRegistrationRequest
  ) async -> Bool {
    guard let baseURL = AccountConfig.attentionRelayBaseURL,
          let initialSession = try? await freshRelaySession(
            expectedAuthorization: request.authorization
          ),
          accountDeviceMutationMatchesCurrentOwnership(
            ownerId: request.authorization.ownerId,
            ownershipEpoch: request.ownershipEpoch,
            state: deviceOwnershipStore.state
          ) else {
      return false
    }
    do {
      let pendingRevocation = deviceRevocationStore.pending
      if let pendingRevocation,
         pendingRevocation.ownerId == request.authorization.ownerId,
         pendingRevocation.deviceId == request.deviceId,
         pendingRevocation.ownershipEpoch <= request.ownershipEpoch {
        // Same-account retry: delete the stale row first when possible. A
        // failed delete does not block PUT—the registration is idempotent and
        // still renews this owner's lease.
        await attemptDeviceRevocation(
          pendingRevocation,
          token: initialSession.token
        )
      }
      try await attentionRelay.registerDevice(
        baseURL: baseURL,
        token: initialSession.token,
        deviceId: request.deviceId,
        ownershipEpoch: request.ownershipEpoch,
        apnsToken: request.apnsToken,
        pushToStartToken: request.pushToStartToken,
        clearPushToStartToken: request.clearPushToStartToken,
        bundleId: request.bundleId,
        apsEnvironment: request.apsEnvironment,
        deviceName: UIDevice.current.name,
        preferences: request.preferences,
        refreshToken: { [weak self] in
          guard let self,
                self.isPairingCommitAuthorized(request.authorization),
                accountDeviceMutationMatchesCurrentOwnership(
                  ownerId: request.authorization.ownerId,
                  ownershipEpoch: request.ownershipEpoch,
                  state: self.deviceOwnershipStore.state
                ) else {
            return nil
          }
          return try? await self.freshRelaySession(
            expectedAuthorization: request.authorization
          ).token
        }
      )
      guard isPairingCommitAuthorized(request.authorization),
            accountDeviceMutationMatchesCurrentOwnership(
              ownerId: request.authorization.ownerId,
              ownershipEpoch: request.ownershipEpoch,
              state: deviceOwnershipStore.state
            ) else {
        return false
      }
      // Registration is Relay's atomic ownership-transfer boundary. Clear a
      // prior account's durable revocation only after this device is confirmed
      // under the current account.
      if let pendingRevocation,
         pendingRevocation.deviceId == request.deviceId,
         pendingRevocation.ownershipEpoch <= request.ownershipEpoch {
        deviceRevocationStore.clear(ifMatching: pendingRevocation)
      }
      return true
    } catch AccountAttentionRelayClient.RelayError.staleOwnership {
      // A newer boundary already won at Relay. This request is permanently
      // superseded and must not enter the retry loop.
      if let pendingRevocation = deviceRevocationStore.pending,
         pendingRevocation.deviceId == request.deviceId,
         pendingRevocation.ownershipEpoch <= request.ownershipEpoch {
        deviceRevocationStore.clear(ifMatching: pendingRevocation)
      }
      return false
    } catch {
      return false
    }
  }

  func reportAttentionActivityToken(
    deviceId: String,
    activityId: String,
    token: String
  ) async -> Bool {
    guard isSignedIn,
          let requestedOwnerId = identity?.userId,
          let baseURL = AccountConfig.attentionRelayBaseURL,
          let initialSession = await pairingSession(),
          initialSession.authorization.ownerId == requestedOwnerId,
          isPairingCommitAuthorized(initialSession.authorization) else {
      return false
    }
    do {
      try await attentionRelay.reportActivityToken(
        baseURL: baseURL,
        token: initialSession.token,
        deviceId: deviceId,
        activityId: activityId,
        activityToken: token,
        refreshToken: { [weak self] in
          guard let self,
                self.isPairingCommitAuthorized(initialSession.authorization) else {
            return nil
          }
          return try? await self.freshRelaySession(
            expectedAuthorization: initialSession.authorization
          ).token
        }
      )
      return isPairingCommitAuthorized(initialSession.authorization)
    } catch {
      return false
    }
  }

  private func clearAttentionSnapshot() {
    guard ADESharedContainer.defaults.data(
      forKey: ADESharedContainer.attentionSnapshotKey
    ) != nil else {
      return
    }
    ADESharedContainer.clearAttentionSnapshot()
    attentionSnapshotRevision &+= 1
    WidgetReloadBridge.reloadAllTimelines()
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
    guard let initialSession = await pairingSession() else {
      guard identity?.userId == requestedOwnerId, phase == .signedIn else { return }
      machinesState = .unreachable("Sign in again to load your machines.")
      return
    }
    guard initialSession.authorization.ownerId == requestedOwnerId,
          isPairingCommitAuthorized(initialSession.authorization) else { return }

    if machines.isEmpty {
      machinesState = .loading
    }
    do {
      let fetched = try await directory.fetchMachines(
        baseURL: baseURL,
        token: initialSession.token,
        refreshToken: { [weak self] in
          guard let self,
                self.isPairingCommitAuthorized(initialSession.authorization) else { return nil }
          return try? await self.freshRelaySession(
            expectedAuthorization: initialSession.authorization
          ).token
        }
      )
      guard isPairingCommitAuthorized(initialSession.authorization) else { return }
      machines = fetched
      SyncService.shared?.adoptVerifiedAccountRelayMetadata(
        from: fetched,
        ownerId: requestedOwnerId
      )
      machinesState = .loaded
    } catch let error as AccountDirectoryClient.DirectoryError {
      guard isPairingCommitAuthorized(initialSession.authorization) else { return }
      machinesState = .unreachable(error.localizedDescription)
    } catch {
      guard isPairingCommitAuthorized(initialSession.authorization) else { return }
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
