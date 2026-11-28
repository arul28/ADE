import Foundation
import UIKit

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

// MARK: - Link silence

enum SyncLinkSilenceTiming {
  /// How often a live connection in the foreground looks at its silence. The
  /// check compares two numbers and sends nothing; a healthy link costs one
  /// timer wake per tick and no traffic.
  static let checkIntervalNanoseconds: UInt64 = 15_000_000_000
  /// Silence is suspect at this many expected inbound intervals.
  static let cadenceMultiplier: Double = 3
  /// The statuses whose spacing gives the expected cadence.
  static let cadenceSampleCount = 4
}

/// The spacing of the `brain_status` frames one connection has received
/// lately. The host sends one on a fixed cadence while a phone is connected
/// (every few seconds direct, less often through the relay), so the widest
/// recent gap is how long a quiet but healthy link stays silent. Nothing about
/// a host version is assumed: an older host that sends no periodic status never
/// produces two statuses and keeps the heartbeat-based rule; one that sends
/// them only on changes produces wide gaps and so a gentle threshold.
struct SyncInboundCadenceTracker: Equatable {
  private(set) var lastStatusUptime: TimeInterval?
  private(set) var recentIntervals: [TimeInterval] = []

  mutating func noteStatus(at uptime: TimeInterval) {
    if let lastStatusUptime, uptime > lastStatusUptime {
      recentIntervals.append(uptime - lastStatusUptime)
      let overflow = recentIntervals.count - SyncLinkSilenceTiming.cadenceSampleCount
      if overflow > 0 { recentIntervals.removeFirst(overflow) }
    }
    lastStatusUptime = uptime
  }

  /// Nil until two statuses arrived on this connection.
  var statusCadenceSeconds: TimeInterval? {
    recentIntervals.max()
  }
}

/// The least silence ever treated as suspect, by route and path. The relay
/// batches a quiet peer's statuses, so it waits longer; metered and Low Data
/// paths wait longer again, but never minutes.
func syncLinkSilenceFloorSeconds(
  routeKind: SyncConnectionRouteKind?,
  isExpensive: Bool,
  isConstrained: Bool
) -> TimeInterval {
  // An unknown route is treated as the relay: the gentler of the two.
  let relay = routeKind == nil || routeKind == .relay
  if isConstrained { return relay ? 105 : 40 }
  if isExpensive { return relay ? 90 : 30 }
  return relay ? 75 : 20
}

/// Silence after which a live link is probed: three times the inbound cadence
/// the host really keeps (its status spacing, capped by its heartbeat), never
/// under the route's floor, and never later than the heartbeat-only rule
/// (`fallbackThresholdSeconds`), which is also what a host that sends no
/// status gets.
func syncLinkSilenceThresholdSeconds(
  statusCadenceSeconds: TimeInterval?,
  hostHeartbeatSeconds: TimeInterval,
  routeKind: SyncConnectionRouteKind?,
  isExpensive: Bool,
  isConstrained: Bool,
  fallbackThresholdSeconds: TimeInterval
) -> TimeInterval {
  guard let statusCadenceSeconds, statusCadenceSeconds > 0 else { return fallbackThresholdSeconds }
  let expected = hostHeartbeatSeconds > 0 ? min(statusCadenceSeconds, hostHeartbeatSeconds) : statusCadenceSeconds
  let floor = syncLinkSilenceFloorSeconds(
    routeKind: routeKind,
    isExpensive: isExpensive,
    isConstrained: isConstrained
  )
  return min(fallbackThresholdSeconds, max(expected * SyncLinkSilenceTiming.cadenceMultiplier, floor))
}

enum SyncLinkSilenceAction: Equatable {
  /// Heard from recently enough: send nothing.
  case quiet
  /// Today's silence fallback: one ping after a whole fallback interval of quiet.
  case ping
  /// Silence passed the threshold: ping and tear down if nothing answers.
  case probe
}

/// What one silence check does. Recent inbound traffic does nothing, so a
/// healthy link sends no frame.
func syncLinkSilenceAction(
  now: TimeInterval,
  lastInboundAt: TimeInterval?,
  silenceThresholdSeconds: TimeInterval,
  fallbackPingIntervalSeconds: TimeInterval,
  lastFallbackPingAt: TimeInterval?
) -> SyncLinkSilenceAction {
  let silence = lastInboundAt.map { now - $0 } ?? .infinity
  if silence >= silenceThresholdSeconds { return .probe }
  guard silence >= fallbackPingIntervalSeconds else { return .quiet }
  if let lastFallbackPingAt, now - lastFallbackPingAt < fallbackPingIntervalSeconds { return .quiet }
  return .ping
}

/// Unanswered probes tolerated before the link counts as dropped. A metered
/// or Low Data path gets one retry: its round trips are slower and a reply can
/// queue behind a large frame.
func syncTransportProbeRetryCount(isExpensive: Bool, isConstrained: Bool) -> Int {
  isExpensive || isConstrained ? 1 : 0
}

// MARK: - Route round trips

/// The round trips measured on one route from one network, for diagnosis.
/// Only pings that already go out are timed: this phone's own probe and
/// silence pings, and the host's heartbeat (its `latencyMs` in `brain_status`).
struct SyncRouteRoundTrip: Equatable {
  enum Source: String {
    case phoneProbe = "phone_probe"
    case hostHeartbeat = "host_heartbeat"
  }

  let routeKind: SyncConnectionRouteKind
  let networkFingerprint: String?
  var phoneProbeMs: Int?
  var hostHeartbeatMs: Int?
  var lastMs: Int
  var lastSource: Source
  var measuredAtUptime: TimeInterval
}

let syncRouteRoundTripMemoryCapacity = 8

func syncRouteRoundTripKey(routeKind: SyncConnectionRouteKind, networkFingerprint: String?) -> String {
  "\(routeKind.rawValue)|\(networkFingerprint ?? "unknown")"
}

/// "ADE relay · 84 ms": the Settings diagnostics line.
func syncRouteRoundTripLine(_ roundTrip: SyncRouteRoundTrip) -> String {
  "\(roundTrip.routeKind.label) · \(roundTrip.lastMs) ms"
}

// MARK: - Automatic recovery grace

/// How long an automatic reconnect keeps showing the connected state it is
/// replacing. A reconnect that finishes inside it is never seen.
let syncAutomaticRecoveryGraceSeconds: TimeInterval = 2

/// The connection state surfaces show. Inside the grace only `.connecting` is
/// hidden; a terminal state (`.error`, `.disconnected`) always shows at once.
/// Request gating never reads this: it reads the real state.
func syncPresentedConnectionState(
  _ real: RemoteConnectionState,
  recoveryGraceActive: Bool
) -> RemoteConnectionState {
  recoveryGraceActive && real == .connecting ? .connected : real
}

/// A domain's status as surfaces show it. Inside the grace a domain that was
/// ready keeps reading ready while the reconnect re-hydrates it; a failure
/// always shows.
func syncPresentedDomainStatus(
  _ real: SyncDomainStatus,
  graceSnapshot: SyncDomainStatus?
) -> SyncDomainStatus {
  guard let graceSnapshot, graceSnapshot.phase == .ready else { return real }
  switch real.phase {
  case .disconnected, .hydrating, .syncingInitialData:
    return graceSnapshot
  case .ready, .failed:
    return real
  }
}

// MARK: - Focused connection notice

/// What the banner over the project tabs says about the focused machine.
enum SyncFocusedConnectionNoticeKind: Equatable {
  /// The link went quiet and a probe is out; it may still be fine.
  case checking
  case reconnecting
  /// The computer closed the link because a request ran too long (4002).
  case hostBusy
  case waking
  case unreachable
  /// The account says the Mac announced a sleep.
  case asleep
  /// An ADE Cloud computer the account says is asleep or stopped. Its saved
  /// work stays readable; nothing here wakes it.
  case cloudResting
  /// The phone itself has no network path.
  case noNetwork
}

struct SyncFocusedConnectionNoticeInputs: Equatable {
  var presentedState: RemoteConnectionState
  var linkSilenceSuspected: Bool
  /// A machine is paired and automatic reconnect is on (not paused by the user).
  var autoReconnectActive: Bool
  var isProjectSwitching: Bool
  /// The tabs show an account project no computer serves.
  var isAccountProjectScope: Bool
  var phoneHasNetworkPath: Bool
  var focusedCloudComputerResting: Bool
  var focusedMachineAsleep: Bool
  var attemptIsWakingMachine: Bool
  var lastDropWasHostBusy: Bool
}

/// Nil when nothing should show: connected and answering, deliberately
/// disconnected, or nothing paired.
func syncFocusedConnectionNoticeKind(_ inputs: SyncFocusedConnectionNoticeInputs) -> SyncFocusedConnectionNoticeKind? {
  guard inputs.autoReconnectActive, !inputs.isProjectSwitching, !inputs.isAccountProjectScope else { return nil }
  let troubled: Bool
  switch inputs.presentedState {
  case .connected: troubled = inputs.linkSilenceSuspected
  case .connecting, .error: troubled = true
  case .disconnected: troubled = false
  }
  guard troubled else { return nil }
  if inputs.attemptIsWakingMachine, inputs.presentedState == .connecting { return .waking }
  if inputs.focusedCloudComputerResting { return .cloudResting }
  if !inputs.phoneHasNetworkPath { return .noNetwork }
  if inputs.focusedMachineAsleep { return .asleep }
  if inputs.presentedState == .connected { return .checking }
  if inputs.presentedState == .error { return .unreachable }
  return inputs.lastDropWasHostBusy ? .hostBusy : .reconnecting
}

/// The focused machine's banner: what it says and what it offers.
struct SyncFocusedConnectionNotice: Equatable {
  let kind: SyncFocusedConnectionNoticeKind
  let machineName: String
  /// When a frame last arrived from this machine; nil when unknown.
  let updatedAt: Date?

  var title: String {
    switch kind {
    case .checking: return "Checking the connection to \(machineName)…"
    case .reconnecting: return "Reconnecting to \(machineName)…"
    case .hostBusy: return "\(machineName) was busy · reconnecting…"
    case .waking: return "Waking \(machineName)…"
    case .unreachable: return "Can’t reach \(machineName)"
    case .asleep: return "\(machineName) is asleep"
    case .cloudResting: return "\(machineName) is asleep · showing saved work"
    case .noNetwork: return "No connection"
    }
  }

  /// The title and, when known, how old the shown data is. A resting ADE
  /// Cloud computer's line already says what is shown.
  func line(now: Date) -> String {
    guard kind != .cloudResting, let updatedAt else { return title }
    return "\(title) · updated \(syncShortAgeText(seconds: now.timeIntervalSince(updatedAt))) ago"
  }

  func accessibilityLabel(now: Date) -> String {
    let spokenTitle = title.replacingOccurrences(of: " · ", with: ", ").replacingOccurrences(of: "…", with: "")
    guard kind != .cloudResting, let updatedAt else { return spokenTitle }
    return "\(spokenTitle). Updated \(syncSpokenAgeText(seconds: now.timeIntervalSince(updatedAt))) ago."
  }

  /// A spinner while the phone is working on it; a still glyph otherwise.
  var showsProgress: Bool {
    switch kind {
    case .checking, .reconnecting, .hostBusy, .waking: return true
    case .unreachable, .asleep, .cloudResting, .noNetwork: return false
    }
  }

  var symbol: String {
    switch kind {
    case .noNetwork: return "wifi.slash"
    case .asleep, .cloudResting: return "moon.zzz"
    default: return "exclamationmark.triangle"
    }
  }

  /// A probe that has not answered yet says nothing about the rows.
  var marksContentStale: Bool { kind != .checking }

  /// Retry only where the phone has stopped trying on its fast schedule. An
  /// asleep Mac or ADE Cloud computer is never dialed from here: reading its
  /// saved work must not wake it.
  var offersRetry: Bool { kind == .unreachable }
}

/// "12s", "4m", "2h": the age in the banner.
func syncShortAgeText(seconds: TimeInterval) -> String {
  let whole = max(0, Int(seconds.rounded(.down)))
  if whole < 60 { return "\(whole)s" }
  if whole < 3_600 { return "\(whole / 60)m" }
  if whole < 86_400 { return "\(whole / 3_600)h" }
  return "\(whole / 86_400)d"
}

/// The same age for VoiceOver: "12 seconds", "4 minutes".
func syncSpokenAgeText(seconds: TimeInterval) -> String {
  let whole = max(0, Int(seconds.rounded(.down)))
  func unit(_ value: Int, _ name: String) -> String { "\(value) \(name)\(value == 1 ? "" : "s")" }
  if whole < 60 { return unit(whole, "second") }
  if whole < 3_600 { return unit(whole / 60, "minute") }
  if whole < 86_400 { return unit(whole / 3_600, "hour") }
  return unit(whole / 86_400, "day")
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

/// The close code a host sends when the computer was too busy to finish a
/// request in time.
let syncHostBusyCloseCode = 4002

let syncHostBusyCloseMessage = "This computer was busy and closed the connection. Reconnecting now."

func syncSocketCloseError(closeCodeRawValue: Int, reason: String?) -> NSError {
  let message: String
  switch closeCodeRawValue {
  case 4002:
    // The host closes a connection whose request ran past its time limit (and
    // a project handoff it could not complete): the computer was busy.
    message = syncHostBusyCloseMessage
  case 4003:
    message = "This saved connection needs attention. Open Settings and reconnect."
  case 4004:
    message = "Connection attempts are paused briefly. Try again shortly."
  case 4503:
    message = "This computer is handling too many connections. Try again shortly."
  case _ where syncRelayHostDidNotAnswerCloseCodes.contains(closeCodeRawValue):
    message = syncRelayHostDidNotAnswerMessage()
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


/// Notes a live connection to a machine that dropped without either side
/// closing it (no close frame: 1006, or none at all). The phone reconnects on
/// its own, so a drop is expected, not a bug: it leaves a breadcrumb that rides
/// on whatever is reported next (a reconnect that fails, a hang), never an
/// issue of its own. As an issue it was 84 events from two phones (Sentry
/// 7847464039). Names and counts only: no address, machine name or content.
///
/// A drop on a connection that lived through a trip to the background is iOS
/// suspending the app and killing its sockets; the breadcrumb says so.
@MainActor
enum SyncLiveDropReport {
  /// Uptime of the app's last move to the background.
  private static var lastBackgroundedUptime: TimeInterval?

  static func noteAppBackgrounded(uptime: TimeInterval = ProcessInfo.processInfo.systemUptime) {
    lastBackgroundedUptime = uptime
  }

  /// Close codes that mean nobody closed the connection on purpose.
  static func isUnexplainedDrop(closeCode: Int?) -> Bool {
    guard let closeCode else { return true }
    return closeCode == 0 || closeCode == 1006
  }

  /// Whether the app was in the background at some point while the connection
  /// was open (or is now), so iOS may have killed the socket.
  static func wasSuspendedDuringConnection(
    connectionAgeSeconds: TimeInterval?,
    lastBackgroundedUptime: TimeInterval?,
    appIsInBackground: Bool,
    nowUptime: TimeInterval
  ) -> Bool {
    if appIsInBackground { return true }
    guard let lastBackgroundedUptime else { return false }
    // Unknown age: any background since launch may have been during it.
    guard let connectionAgeSeconds else { return true }
    return lastBackgroundedUptime >= nowUptime - connectionAgeSeconds
  }

  static func report(
    connection: String,
    routeKind: SyncConnectionRouteKind?,
    closeCode: Int?,
    connectionAgeSeconds: TimeInterval?,
    error: Error? = nil,
    roundTripMs: Int? = nil
  ) {
    guard isUnexplainedDrop(closeCode: closeCode) else { return }
    let route = routeKind.map { String(describing: $0) } ?? "unknown"
    let ageBucket: String
    switch connectionAgeSeconds ?? -1 {
    case ..<0: ageBucket = "unknown"
    case ..<10: ageBucket = "under_10s"
    case ..<60: ageBucket = "under_1m"
    case ..<600: ageBucket = "under_10m"
    default: ageBucket = "over_10m"
    }
    var data: [String: String] = [
      "connection": connection,
      "route": route,
      "close_code": String(closeCode ?? 0),
      "age": ageBucket,
    ]
    // The last round trip measured on this route: a slow route that then
    // drops reads differently from a fast one.
    if let roundTripMs { data["rtt_ms"] = String(roundTripMs) }
    if let error {
      let nsError = error as NSError
      data["error_domain"] = nsError.domain
      data["error_code"] = String(nsError.code)
      if let underlying = nsError.userInfo[NSUnderlyingErrorKey] as? NSError {
        data["underlying_domain"] = underlying.domain
        data["underlying_code"] = String(underlying.code)
      }
    }
    let suspended = wasSuspendedDuringConnection(
      connectionAgeSeconds: connectionAgeSeconds,
      lastBackgroundedUptime: lastBackgroundedUptime,
      appIsInBackground: UIApplication.shared.applicationState == .background,
      nowUptime: ProcessInfo.processInfo.systemUptime
    )
    CrashReporting.breadcrumb(
      "sync.live_drop",
      message: suspended
        ? "live connection dropped after the app was suspended"
        : "live connection dropped without a close frame",
      data: data
    )
  }
}
