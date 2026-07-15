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
  case scheduleForcedReset
  case cancelScheduledReconnect
  case scheduleReconnect
  case none
}

func syncNetworkPathRecoveryAction(
  shouldRoamToTailnet: Bool,
  isPathSatisfied: Bool,
  hasLiveConnection: Bool
) -> SyncNetworkPathRecoveryAction {
  if shouldRoamToTailnet { return .scheduleForcedReset }
  guard isPathSatisfied else { return .none }
  return hasLiveConnection ? .cancelScheduledReconnect : .scheduleReconnect
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
