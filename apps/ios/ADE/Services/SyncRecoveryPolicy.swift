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
  shouldRoamToTailnet: Bool,
  isPathSatisfied: Bool,
  hasLiveConnection: Bool
) -> SyncNetworkPathRecoveryAction {
  if shouldRoamToTailnet, hasLiveConnection { return .attemptAuthenticatedReplacement }
  guard isPathSatisfied else { return .none }
  return hasLiveConnection ? .cancelScheduledReconnect : .scheduleReconnect
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
  case 4001:
    message = "The machine stopped responding. Reconnecting now."
  case 4506:
    message = "The relay connection was interrupted. Reconnecting now."
  case 4507:
    message = "The machine couldn't accept the relay connection. Reconnecting now."
  default:
    if let trimmedReason = reason?.trimmingCharacters(in: .whitespacesAndNewlines),
       !trimmedReason.isEmpty {
      message = trimmedReason
    } else {
      message = "The connection to the machine was interrupted. Reconnecting now."
    }
  }
  return NSError(
    domain: "ADE",
    code: 24,
    userInfo: [NSLocalizedDescriptionKey: message]
  )
}
