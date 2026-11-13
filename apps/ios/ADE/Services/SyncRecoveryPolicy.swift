import Foundation

func syncTransportProbeTimeoutNanoseconds(isExpensive: Bool, isConstrained: Bool) -> UInt64 {
  if isConstrained {
    return SyncSocketTiming.constrainedTransportProbeTimeoutNanoseconds
  }
  if isExpensive {
    return SyncSocketTiming.expensiveTransportProbeTimeoutNanoseconds
  }
  return SyncSocketTiming.transportProbeTimeoutNanoseconds
}

func syncHeartbeatSilenceThresholdSeconds(
  heartbeatIntervalNanoseconds: UInt64,
  isExpensive: Bool,
  isConstrained: Bool
) -> TimeInterval {
  let intervalSeconds = TimeInterval(heartbeatIntervalNanoseconds) / 1_000_000_000
  if isConstrained {
    return max(60, intervalSeconds * 4)
  }
  if isExpensive {
    return max(45, intervalSeconds * 3)
  }
  return max(30, intervalSeconds * 2)
}

func syncShouldProbeTransportAfterHeartbeatSilence(
  now: TimeInterval,
  lastInboundMessageAt: TimeInterval?,
  heartbeatIntervalNanoseconds: UInt64,
  isExpensive: Bool,
  isConstrained: Bool
) -> Bool {
  guard let lastInboundMessageAt else { return true }
  return now - lastInboundMessageAt >= syncHeartbeatSilenceThresholdSeconds(
    heartbeatIntervalNanoseconds: heartbeatIntervalNanoseconds,
    isExpensive: isExpensive,
    isConstrained: isConstrained
  )
}

func syncJitteredReconnectDelayNanoseconds(base: UInt64, sample: Double) -> UInt64 {
  let clampedSample = min(1, max(0, sample))
  let factor = 0.8 + (0.4 * clampedSample)
  return UInt64((Double(base) * factor).rounded())
}

enum SyncScheduledPathReconnectAction: Equatable {
  case skip
  case reconnect
  case resetAndReconnect
}

func syncScheduledPathReconnectAction(
  forceSocketReset: Bool,
  scheduledConnectionGeneration: UInt64,
  currentConnectionGeneration: UInt64,
  hasLiveConnection: Bool
) -> SyncScheduledPathReconnectAction {
  if hasLiveConnection, scheduledConnectionGeneration != currentConnectionGeneration {
    return .skip
  }
  if forceSocketReset, scheduledConnectionGeneration == currentConnectionGeneration {
    return .resetAndReconnect
  }
  return .reconnect
}

enum SyncNetworkPathRecoveryAction: Equatable {
  case attemptAuthenticatedReplacement
  case cancelScheduledReconnect
  case scheduleReconnect
  case none
}

func syncNetworkPathRecoveryAction(
  roamTrigger: SyncRoamTrigger?,
  isPathSatisfied: Bool,
  hasLiveConnection: Bool
) -> SyncNetworkPathRecoveryAction {
  if roamTrigger != nil, hasLiveConnection { return .attemptAuthenticatedReplacement }
  guard isPathSatisfied else { return .none }
  return hasLiveConnection ? .cancelScheduledReconnect : .scheduleReconnect
}

enum SyncRoamTiming {
  /// Floor between two failover races. Short on purpose: a real interface
  /// change may mean the current route is gone, and making the user wait out an
  /// upgrade cooldown to fail over would be a regression. It exists only to
  /// absorb the burst of NWPathMonitor updates around one physical change.
  static let pathChangeCooldownSeconds: TimeInterval = 3
  /// A connection this young has not proven anything yet; upgrading away from
  /// it is churn. Genuine path changes ignore this — the route may be dead.
  static let minimumConnectionAgeSeconds: TimeInterval = 10
  /// How often a healthy connection may spend one quiet attempt looking for a
  /// better transport when nothing about the network changed.
  static let upgradeProbeIntervalSeconds: TimeInterval = 300
}

enum SyncRoamTrigger: Equatable {
  /// The interface set changed. Race everything: the current route may be gone
  /// (Tailscale switched off, Wi-Fi dropped) and failing over fast is the point.
  case pathChange
  /// Nothing changed, but a strictly better transport class looks reachable.
  /// One quiet attempt restricted to better-class candidates.
  case upgradeProbe
}

struct SyncRoamInputs: Equatable {
  var hasLiveConnection: Bool
  var isPathSatisfied: Bool
  /// True only when the interface set itself changed. Any NWPathMonitor update
  /// used to qualify, which is why an idle phone on cellular rebuilt its
  /// connection every 30-70 seconds.
  var interfacesChanged: Bool
  var currentRouteKind: SyncConnectionRouteKind?
  /// Best transport class we have a plausible candidate for right now: a live
  /// Bonjour hit for LAN, a tailnet interface plus a saved tailnet route, etc.
  var bestAvailableRouteKind: SyncConnectionRouteKind?
  var connectionAgeSeconds: TimeInterval?
  var secondsSinceLastRoamAttempt: TimeInterval?

  init(
    hasLiveConnection: Bool,
    isPathSatisfied: Bool,
    interfacesChanged: Bool,
    currentRouteKind: SyncConnectionRouteKind? = nil,
    bestAvailableRouteKind: SyncConnectionRouteKind? = nil,
    connectionAgeSeconds: TimeInterval? = nil,
    secondsSinceLastRoamAttempt: TimeInterval? = nil
  ) {
    self.hasLiveConnection = hasLiveConnection
    self.isPathSatisfied = isPathSatisfied
    self.interfacesChanged = interfacesChanged
    self.currentRouteKind = currentRouteKind
    self.bestAvailableRouteKind = bestAvailableRouteKind
    self.connectionAgeSeconds = connectionAgeSeconds
    self.secondsSinceLastRoamAttempt = secondsSinceLastRoamAttempt
  }
}

/// Whether a healthy connection should be re-raced, and why. Standing facts
/// ("on cellular, and a tailnet route is saved") are deliberately NOT triggers:
/// they stay true forever and turned every path update into a full connection
/// race that replaced a working socket.
func syncRoamTrigger(_ inputs: SyncRoamInputs) -> SyncRoamTrigger? {
  guard inputs.hasLiveConnection, inputs.isPathSatisfied else { return nil }
  let secondsSinceLastRoamAttempt = inputs.secondsSinceLastRoamAttempt ?? .infinity
  if inputs.interfacesChanged {
    return secondsSinceLastRoamAttempt >= SyncRoamTiming.pathChangeCooldownSeconds
      ? .pathChange
      : nil
  }
  guard let currentRouteKind = inputs.currentRouteKind,
        let bestAvailableRouteKind = inputs.bestAvailableRouteKind,
        bestAvailableRouteKind < currentRouteKind,
        (inputs.connectionAgeSeconds ?? 0) >= SyncRoamTiming.minimumConnectionAgeSeconds,
        secondsSinceLastRoamAttempt >= SyncRoamTiming.upgradeProbeIntervalSeconds
  else { return nil }
  return .upgradeProbe
}

func syncNetworkPathInterfacesChanged(
  previous: SyncNetworkPathSnapshot?,
  next: SyncNetworkPathSnapshot
) -> Bool {
  guard let previous else { return true }
  return previous.isSatisfied != next.isSatisfied
    || previous.usesWiFi != next.usesWiFi
    || previous.usesCellular != next.usesCellular
    || previous.usesWiredEthernet != next.usesWiredEthernet
}

struct SyncRelayAuthorizationLease: Equatable, Sendable {
  var expiresAtMilliseconds: TimeInterval
  var refreshAfterMilliseconds: TimeInterval
  var challenge: String
  var graceMilliseconds: TimeInterval

  init?(_ payload: [String: Any]) {
    guard let expiresAtMilliseconds = Self.number(payload["expiresAt"]),
          let refreshAfterMilliseconds = Self.number(payload["refreshAfter"]),
          let challenge = payload["challenge"] as? String,
          !challenge.isEmpty,
          let graceMilliseconds = Self.number(payload["graceMs"]),
          expiresAtMilliseconds > 0,
          refreshAfterMilliseconds > 0,
          graceMilliseconds >= 0 else { return nil }
    self.expiresAtMilliseconds = expiresAtMilliseconds
    self.refreshAfterMilliseconds = refreshAfterMilliseconds
    self.challenge = challenge
    self.graceMilliseconds = graceMilliseconds
  }

  init(
    expiresAtMilliseconds: TimeInterval,
    refreshAfterMilliseconds: TimeInterval,
    challenge: String,
    graceMilliseconds: TimeInterval
  ) {
    self.expiresAtMilliseconds = expiresAtMilliseconds
    self.refreshAfterMilliseconds = refreshAfterMilliseconds
    self.challenge = challenge
    self.graceMilliseconds = graceMilliseconds
  }

  var retryDeadlineMilliseconds: TimeInterval {
    expiresAtMilliseconds + graceMilliseconds
  }

  private static func number(_ value: Any?) -> TimeInterval? {
    if let value = value as? NSNumber { return value.doubleValue }
    if let value = value as? Double { return value }
    if let value = value as? Int { return TimeInterval(value) }
    return nil
  }
}

enum SyncRelayReauthorizationTiming {
  static let retryDelaySeconds: [TimeInterval] = [1, 2, 4, 8]
}

func syncRelayReauthorizationScheduleDelayNanoseconds(
  lease: SyncRelayAuthorizationLease,
  nowMilliseconds: TimeInterval
) -> UInt64 {
  let delayMilliseconds = max(0, lease.refreshAfterMilliseconds - nowMilliseconds)
  return UInt64((delayMilliseconds * 1_000_000).rounded())
}

func syncRelayReauthorizationRetryDelayNanoseconds(
  attempt: Int,
  lease: SyncRelayAuthorizationLease,
  nowMilliseconds: TimeInterval
) -> UInt64? {
  guard SyncRelayReauthorizationTiming.retryDelaySeconds.indices.contains(attempt) else {
    return nil
  }
  let delaySeconds = SyncRelayReauthorizationTiming.retryDelaySeconds[attempt]
  guard nowMilliseconds + (delaySeconds * 1_000) <= lease.retryDeadlineMilliseconds else {
    return nil
  }
  return UInt64((delaySeconds * 1_000_000_000).rounded())
}

func syncRelayReauthorizationIsDue(
  lease: SyncRelayAuthorizationLease,
  nowMilliseconds: TimeInterval
) -> Bool {
  nowMilliseconds >= lease.refreshAfterMilliseconds
}

func syncRelayReauthorizationContextIsCurrent(
  scheduledGeneration: UInt64,
  currentGeneration: UInt64,
  scheduledSocketIdentifier: ObjectIdentifier,
  currentSocketIdentifier: ObjectIdentifier?
) -> Bool {
  scheduledGeneration == currentGeneration
    && currentSocketIdentifier == scheduledSocketIdentifier
}

enum SyncRelayReauthorizationRetryAction: Equatable {
  case retryExactAttempt
  case rebuildAttempt
  case accountChanged
  case stop
}

func syncRelayReauthorizationRetryAction(
  receivedHostResult: Bool,
  errorCode: String?,
  retryable: Bool
) -> SyncRelayReauthorizationRetryAction {
  guard receivedHostResult else { return .retryExactAttempt }
  switch errorCode {
  case "relay_account_changed":
    return .accountChanged
  case "token_expired", "token_not_advanced", "token_too_short":
    return .rebuildAttempt
  default:
    return retryable ? .retryExactAttempt : .stop
  }
}

enum SyncRequestTimeoutRecoveryAction: Equatable {
  case failRequestOnly
  case probeTransport
}

func syncRequestTimeoutRecoveryAction(
  disconnectOnTimeout: Bool,
  now: TimeInterval,
  lastInboundMessageAt: TimeInterval?,
  silenceThreshold: TimeInterval = SyncSocketTiming.requestTimeoutReconnectSilenceSeconds
) -> SyncRequestTimeoutRecoveryAction {
  guard disconnectOnTimeout,
        syncShouldReconnectAfterRequestTimeout(
          now: now,
          lastInboundMessageAt: lastInboundMessageAt,
          silenceThreshold: silenceThreshold
        ) else {
    return .failRequestOnly
  }
  return .probeTransport
}

enum SyncSocketCompletionAction: Equatable {
  case ignore
  case failOpening
  case failHandshake
  case recoverTransport(closeCodeRawValue: Int?)
}

func syncSocketCompletionAction(
  isCurrentSocket: Bool,
  completedWhileOpening: Bool,
  canSendLiveRequests: Bool,
  closeCodeRawValue: Int?
) -> SyncSocketCompletionAction {
  guard isCurrentSocket else { return .ignore }
  if completedWhileOpening { return .failOpening }
  return canSendLiveRequests
    ? .recoverTransport(closeCodeRawValue: closeCodeRawValue)
    : .failHandshake
}

/// Relay close codes that mean the phone got through to the computer's relay
/// connection, but ADE on that computer did not answer: its bridge refused
/// the tunnel (4507). Only a code the computer itself sends belongs here:
/// 4501 (no host connection at the relay) also means the computer is asleep or
/// offline, and 4509 can come from the relay side. Copy only: these codes
/// recover exactly like every other close.
let syncRelayHostDidNotAnswerCloseCodes: Set<Int> = [4507]

/// What the phone says when the relay reached the computer but ADE on it did
/// not answer. With a machine name it names the route; without one (the
/// primary banner) it stays route-neutral.
func syncRelayHostDidNotAnswerMessage(machineName: String? = nil) -> String {
  let fix = "It usually repairs itself in a few seconds; if it doesn’t, open ADE on that computer to see why."
  guard let machineName = machineName?.trimmingCharacters(in: .whitespacesAndNewlines),
        !machineName.isEmpty else {
    return "This computer is online, but ADE on it didn’t answer. \(fix)"
  }
  return "ADE relay reached \(machineName), but ADE on it didn’t answer. \(fix)"
}

/// Whether `error` ended with one of `syncRelayHostDidNotAnswerCloseCodes`.
func syncErrorIsRelayHostDidNotAnswer(_ error: Error?) -> Bool {
  guard let error else { return false }
  if let mailboxError = error as? SyncConnectionRaceMailboxError {
    return mailboxError.closeCode.map(syncRelayHostDidNotAnswerCloseCodes.contains) ?? false
  }
  let code = (error as NSError).userInfo["ADESocketCloseCode"] as? Int
  return code.map(syncRelayHostDidNotAnswerCloseCodes.contains) ?? false
}

func syncSocketCloseError(closeCodeRawValue: Int, reason: String?) -> NSError {
  let message: String
  switch closeCodeRawValue {
  case 4003:
    message = "This saved connection needs attention. Open Settings and reconnect."
  case 4004:
    message = "Connection attempts are paused briefly. Try again shortly."
  case 4503:
    message = "This computer is handling too many connections. Try again shortly."
  case _ where syncRelayHostDidNotAnswerCloseCodes.contains(closeCodeRawValue):
    message = syncRelayHostDidNotAnswerMessage()
  case 4000, 4001, 4002, 4008, 4501, 4502, 4505, 4506:
    message = "Can’t reach this computer right now. Reconnecting now."
  default:
    message = "Can’t reach this computer right now. Reconnecting now."
  }
  var userInfo: [String: Any] = [
    NSLocalizedDescriptionKey: message,
    "ADESocketCloseCode": closeCodeRawValue,
  ]
  if let diagnosticReason = reason?.trimmingCharacters(in: .whitespacesAndNewlines),
     !diagnosticReason.isEmpty {
    userInfo["ADESocketCloseReason"] = diagnosticReason
  }
  return NSError(
    domain: "ADE",
    code: 24,
    userInfo: userInfo
  )
}

/// The error the transport-silence recovery paths report. One factory because
/// the heartbeat-silence probe and the foreground-resume probe were building the
/// same literal by hand. The socket-close path keeps its own construction: that
/// one carries close-code diagnostics this message does not.
func syncTransportSilenceRecoveryError() -> NSError {
  NSError(
    domain: "ADE",
    code: 24,
    userInfo: [NSLocalizedDescriptionKey: "The machine stopped responding. Reconnecting now."]
  )
}

// MARK: - Foreground resume

/// What a return to the foreground should do with the existing sync session.
enum SyncForegroundResumeAction: Equatable {
  /// Tear the session down and rebuild it without asking it anything first.
  case replaceSession
  /// Keep the session but stop treating it as proven — probe it alongside the refreshes.
  case probeSession
  /// No background gap was recorded (a cold bootstrap); just refresh.
  case refreshOnly
}

/// A background longer than this may have had its socket suspended by iOS
/// without a close event ever arriving, so "connected" stops being evidence.
let syncSuspendedSessionBackgroundGapSeconds: TimeInterval = 10

/// Classify a resume by how long the app was backgrounded — the only evidence
/// available about whether the socket is still real.
///
/// Below the threshold the socket is probably alive and replacing it would cost
/// a reconnect on every trivial app switch. At or above it, probing only buys a
/// round trip we are about to spend anyway, so the session is replaced outright.
func syncForegroundResumeAction(
  backgroundGapSeconds: TimeInterval?,
  suspendedGapSeconds: TimeInterval = syncSuspendedSessionBackgroundGapSeconds
) -> SyncForegroundResumeAction {
  guard let backgroundGapSeconds else { return .refreshOnly }
  return backgroundGapSeconds >= suspendedGapSeconds ? .replaceSession : .probeSession
}

/// Detects a connection that keeps closing right after it connects for the
/// same reason (for example the host refusing one reply and closing 4001), and
/// turns that into an exponential backoff. Without it, the post-hello stability
/// reset re-armed the fast 1.5 s retry every cycle and the phone hammered the
/// host forever.
struct SyncReconnectFlapTracker {
  /// A connection that dies within this many seconds of hello counts as a flap.
  static let shortLivedConnectionSeconds: TimeInterval = 30
  static let windowSeconds: TimeInterval = 120
  static let threshold = 3
  static let baseBackoffSeconds: TimeInterval = 15
  static let maxBackoffSeconds: TimeInterval = 300

  private var closes: [(at: TimeInterval, signature: String)] = []
  private(set) var consecutiveTrips = 0

  /// Records one close of a live connection. Returns the backoff to use
  /// instead of the normal reconnect delay when the connection is flapping.
  mutating func recordClose(
    signature: String,
    connectionAgeSeconds: TimeInterval?,
    now: TimeInterval
  ) -> TimeInterval? {
    // Never finished hello: not this failure mode, and no proof of health.
    guard let connectionAgeSeconds else { return nil }
    guard connectionAgeSeconds <= Self.shortLivedConnectionSeconds else {
      // The connection held; whatever was wrong before is over.
      reset()
      return nil
    }
    closes.removeAll { now - $0.at > Self.windowSeconds }
    closes.append((at: now, signature: signature))
    let sameReasonCount = closes.filter { $0.signature == signature }.count
    guard sameReasonCount >= Self.threshold else { return nil }
    consecutiveTrips += 1
    let exponent = Double(min(consecutiveTrips - 1, 10))
    return min(Self.maxBackoffSeconds, Self.baseBackoffSeconds * pow(2, exponent))
  }

  mutating func reset() {
    closes.removeAll()
    consecutiveTrips = 0
  }
}

/// Short connection-banner copy for a flapping connection.
func syncReconnectFlapMessage(machineName: String, closeReason: String?, retryInSeconds: TimeInterval) -> String {
  let seconds = Int(retryInSeconds.rounded())
  let trimmedReason = closeReason?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  let reasonSuffix = trimmedReason.isEmpty ? "" : " (\(trimmedReason))"
  return "\(machineName) keeps closing the connection right after connecting\(reasonSuffix). Retrying in \(seconds) s."
}

/// One relay re-authorization loop, shared by the focused connection and the
/// fleet's roster connections: refresh shortly before the lease expires,
/// resend the exact same attempt after a transport miss (the host dedupes it),
/// rebuild it when the host says the token went stale, and stop on an account
/// change or once retries would run past the lease. Returns when cancelled or
/// when `isCurrent` turns false.
@MainActor
func syncRunRelayReauthorizationLoop<Attempt>(
  lease: SyncRelayAuthorizationLease,
  refreshImmediately: Bool = false,
  isCurrent: @MainActor () -> Bool,
  makeAttempt: @MainActor (SyncRelayAuthorizationLease) async throws -> Attempt,
  perform: @MainActor (Attempt) async throws -> SyncRelayAuthorizationLease,
  install: @MainActor (SyncRelayAuthorizationLease) throws -> Void,
  onAccountChanged: @MainActor (RelayReauthorizationFailure) -> Void,
  onGiveUp: @MainActor (Error) -> Void
) async {
  var activeLease = lease
  var activeAttempt: Attempt?
  var refreshNow = refreshImmediately
  var retryAttempt = 0
  while !Task.isCancelled {
    guard isCurrent() else { return }
    if !refreshNow {
      let delay = syncRelayReauthorizationScheduleDelayNanoseconds(
        lease: activeLease,
        nowMilliseconds: Date().timeIntervalSince1970 * 1_000
      )
      if delay > 0 { try? await Task.sleep(nanoseconds: delay) }
      guard !Task.isCancelled else { return }
    }
    refreshNow = true
    do {
      let attemptToSend: Attempt
      if let pending = activeAttempt {
        attemptToSend = pending
      } else {
        attemptToSend = try await makeAttempt(activeLease)
        activeAttempt = attemptToSend
      }
      let refreshed = try await perform(attemptToSend)
      try install(refreshed)
      activeLease = refreshed
      activeAttempt = nil
      retryAttempt = 0
      refreshNow = false
    } catch is CancellationError {
      return
    } catch {
      if let failure = error as? RelayReauthorizationFailure {
        let action = syncRelayReauthorizationRetryAction(
          receivedHostResult: failure.receivedHostResult,
          errorCode: failure.code,
          retryable: failure.retryable
        )
        if action == .accountChanged {
          onAccountChanged(failure)
          return
        }
        if action == .rebuildAttempt { activeAttempt = nil }
        guard action == .retryExactAttempt || action == .rebuildAttempt else {
          onGiveUp(failure)
          return
        }
      }
      guard let retryDelay = syncRelayReauthorizationRetryDelayNanoseconds(
        attempt: retryAttempt,
        lease: activeLease,
        nowMilliseconds: Date().timeIntervalSince1970 * 1_000
      ) else {
        onGiveUp(error)
        return
      }
      retryAttempt += 1
      try? await Task.sleep(nanoseconds: retryDelay)
      guard !Task.isCancelled else { return }
    }
  }
}


/// Reports a live connection to a machine that dropped without either side
/// closing it (no close frame: 1006, or none at all). Such a drop was seen only
/// on a real iPhone (a Wi-Fi socket dropped 110 ms after the computer's sync
/// port moved) and never in the simulator, so the phone says what it saw. The
/// Sentry event carries the breadcrumbs left just before it (saved port
/// changes, network path changes). Names and counts only: no address, machine
/// name or content. At most one report per kind per ten minutes.
@MainActor
enum SyncLiveDropReport {
  private static var lastReportedAt: [String: Date] = [:]
  static let minimumInterval: TimeInterval = 600

  /// Close codes that mean nobody closed the connection on purpose.
  static func isUnexplainedDrop(closeCode: Int?) -> Bool {
    guard let closeCode else { return true }
    return closeCode == 0 || closeCode == 1006
  }

  static func report(
    connection: String,
    routeKind: SyncConnectionRouteKind?,
    closeCode: Int?,
    connectionAgeSeconds: TimeInterval?,
    now: Date = Date()
  ) {
    guard isUnexplainedDrop(closeCode: closeCode) else { return }
    let kind = "\(connection):\(routeKind.map { String(describing: $0) } ?? "unknown")"
    if let last = lastReportedAt[kind], now.timeIntervalSince(last) < minimumInterval { return }
    lastReportedAt[kind] = now
    let ageBucket: String
    switch connectionAgeSeconds ?? -1 {
    case ..<0: ageBucket = "unknown"
    case ..<10: ageBucket = "under_10s"
    case ..<60: ageBucket = "under_1m"
    case ..<600: ageBucket = "under_10m"
    default: ageBucket = "over_10m"
    }
    CrashReporting.capture(
      NSError(domain: "ADESyncLiveDrop", code: closeCode ?? 0, userInfo: [
        NSLocalizedDescriptionKey: "A live machine connection dropped without a close frame.",
      ]),
      context: [
        "area": "sync_live_drop",
        "connection": connection,
        "route": routeKind.map { String(describing: $0) } ?? "unknown",
        "close_code": String(closeCode ?? 0),
        "age": ageBucket,
      ]
    )
  }
}
