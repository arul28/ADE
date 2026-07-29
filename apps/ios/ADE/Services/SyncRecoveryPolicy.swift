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
  /// Floor between two roam attempts of any kind. Also absorbs bursts of
  /// NWPathMonitor updates around a single physical network change.
  static let cooldownSeconds: TimeInterval = 30
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
  if let secondsSinceLastRoamAttempt = inputs.secondsSinceLastRoamAttempt,
     secondsSinceLastRoamAttempt < SyncRoamTiming.cooldownSeconds {
    return nil
  }
  if inputs.interfacesChanged { return .pathChange }
  guard let currentRouteKind = inputs.currentRouteKind,
        let bestAvailableRouteKind = inputs.bestAvailableRouteKind,
        bestAvailableRouteKind.rawValue < currentRouteKind.rawValue,
        (inputs.connectionAgeSeconds ?? 0) >= SyncRoamTiming.minimumConnectionAgeSeconds,
        (inputs.secondsSinceLastRoamAttempt ?? .infinity) >= SyncRoamTiming.upgradeProbeIntervalSeconds
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

func syncSocketCloseError(closeCodeRawValue: Int, reason: String?) -> NSError {
  let message: String
  switch closeCodeRawValue {
  case 4003:
    message = "This saved connection needs attention. Open Settings and reconnect."
  case 4004:
    message = "Connection attempts are paused briefly. Try again shortly."
  case 4503:
    message = "This Mac is handling too many connections. Try again shortly."
  case 4000, 4001, 4002, 4008, 4501, 4502, 4505, 4506, 4507:
    message = "Can’t reach this Mac right now. Reconnecting now."
  default:
    message = "Can’t reach this Mac right now. Reconnecting now."
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
