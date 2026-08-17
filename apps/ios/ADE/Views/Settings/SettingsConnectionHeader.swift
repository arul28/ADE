import Foundation
import SwiftUI

func syncTransportBadgeText(routeKind: SyncConnectionRouteKind?) -> String? {
  switch routeKind {
  case .lan: return "via LAN"
  case .tailnet: return "via Tailscale"
  case .relay: return "via ADE Relay"
  case nil: return nil
  }
}

func settingsConnectedRouteChipText(
  durationMs: Int?,
  routeKind: SyncConnectionRouteKind?
) -> String? {
  // A non-nil observed route proves that a connection attempt completed. Keep
  // the primary performance chip route-neutral; the diagnostics section has a
  // separate connectionRoute row for people who actually need LAN/Tailscale/
  // relay detail.
  guard routeKind != nil else { return nil }
  guard let durationMs, durationMs >= 0, durationMs <= 10_000 else {
    return "Connected"
  }
  let seconds = Double(durationMs) / 1_000
  let durationLabel = String(
    format: "%.1f",
    locale: Locale(identifier: "en_US_POSIX"),
    seconds
  )
  return "Connected in \(durationLabel)s"
}

/// Which machine a connection line should name. While connected the attached
/// host is the only truth, but during an attempt — and after it fails — the
/// machine the user aimed at is: an account can hold several Macs, and naming
/// the last-connected one blames a machine that took no part in the failure.
func syncConnectionSubjectMachineName(
  transport: SyncTransportHealth,
  attemptMachineName: String?,
  hostDisplayName: String?
) -> String? {
  let host = syncTrimmedMachineName(hostDisplayName)
  switch transport {
  case .connecting, .unreachable:
    return syncTrimmedMachineName(attemptMachineName) ?? host
  case .connected, .disconnected:
    return host
  }
}

/// Which machine the card's sleep copy — and its "Wake it" — are about, or nil
/// when no machine is asleep.
///
/// One function for both halves because they used to be computed apart and
/// drifted: the name came from the failure (the MacBook) while the identity
/// came from the live attempt target, which `restorePreviousConnection` has
/// already repointed at the fallback — so "Wake it" under "MacBook Pro is
/// asleep" dialled the Mac Studio.
///
/// While an attempt is in flight the subject is the attempt, and ONLY when that
/// attempt is itself a wake: the restore that follows a failed switch is a
/// plain redial with `attemptIsWakingMachine` false, and letting the stale
/// failure speak for it made the card say "MacBook Pro is waking up" while it
/// dialled the Mac Studio. Once the attempt is over the failure is the only
/// thing that still remembers which machine was asleep.
func syncAsleepCardSubject(
  transport: SyncTransportHealth,
  attemptIsWakingMachine: Bool,
  attemptMachineName: String?,
  attemptMachineIdentity: String?,
  failure: SyncConnectAttemptFailure?
) -> (name: String, identity: String?)? {
  if transport == .connecting {
    guard attemptIsWakingMachine,
          let name = syncTrimmedMachineName(attemptMachineName) else { return nil }
    return (name, syncTrimmedMachineName(attemptMachineIdentity))
  }
  guard let failure,
        failure.machineWasAsleep,
        let name = syncTrimmedMachineName(failure.machineName) else { return nil }
  return (name, syncTrimmedMachineName(failure.machineIdentity))
}

/// What the connection card leads with.
///
/// `.standard` is the transport's own vocabulary — Connected, Reconnecting,
/// Can't reach — and it is right whenever the machine in question is awake.
/// It is wrong for a sleeping Mac in a specific and damaging way: it reports
/// the mechanism ("Reconnecting") instead of the outcome ("it's asleep"), and
/// the mechanism is what let two machines end up named on one card. The two
/// sleep cases lead with the outcome and carry the action that fixes it.
enum SettingsConnectionOutcome: Equatable {
  case standard
  case waking(machine: String)
  case asleep(machine: String, attachedTo: String?)
}

/// A sleeping machine owns the card for as long as its failure is the newest
/// thing that happened — which is the same rule the machine rows already use
/// for their inline failures, and for the same reason: a failed switch restores
/// the previous connection, so "attached to the Studio, card explaining that
/// the MacBook is asleep" is the honest steady state, not a contradiction. Any
/// new attempt clears it.
func settingsConnectionOutcome(
  transport: SyncTransportHealth,
  asleepMachineName: String?,
  attachedMachineName: String?
) -> SettingsConnectionOutcome {
  guard let machine = syncTrimmedMachineName(asleepMachineName) else { return .standard }
  switch transport {
  case .connecting:
    return .waking(machine: machine)
  case .connected:
    return .asleep(machine: machine, attachedTo: syncTrimmedMachineName(attachedMachineName))
  case .unreachable, .disconnected:
    // Nowhere to fall back to. Naming a machine we are not on would be the
    // same lie in the other direction.
    return .asleep(machine: machine, attachedTo: nil)
  }
}

func settingsConnectionOutcomeTitle(_ outcome: SettingsConnectionOutcome) -> String? {
  switch outcome {
  case .standard: return nil
  case .waking(let machine): return "\(machine) is waking up"
  case .asleep(let machine, _): return "\(machine) is asleep"
  }
}

func settingsConnectionOutcomeDetail(_ outcome: SettingsConnectionOutcome) -> String? {
  switch outcome {
  case .standard:
    return nil
  case .waking:
    return "This can take a moment."
  case .asleep(_, let attachedTo):
    guard let attachedTo else { return "Not connected right now" }
    return "You\u{2019}re still on \(attachedTo)"
  }
}

private func syncTrimmedMachineName(_ value: String?) -> String? {
  guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines),
        !trimmed.isEmpty else {
    return nil
  }
  return trimmed
}

struct SettingsConnectionHeader: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  let snapshot: SettingsConnectionSnapshot
  let onDisconnect: () -> Void
  let onReconnect: () -> Void
  var onPairWithPin: (() -> Void)?
  /// Dials the sleeping machine again. Bounded by the same connect attempt as
  /// every other path, so the card always lands back on a definite state.
  var onWake: (() -> Void)?

  @State private var pulsing = false

  private var health: SyncConnectionHealth {
    snapshot.health
  }

  private var outcome: SettingsConnectionOutcome {
    settingsConnectionOutcome(
      transport: health.transport,
      asleepMachineName: snapshot.asleepMachineName,
      attachedMachineName: snapshot.attachedMachineName
    )
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack(alignment: .center, spacing: 12) {
        SettingsStatusDot(
          health: health,
          pulsing: pulsing,
          reduceMotion: reduceMotion,
          isAsleep: outcome != .standard
        )
        VStack(alignment: .leading, spacing: 4) {
          Text(settingsConnectionOutcomeTitle(outcome) ?? SettingsConnectionPresentation.statusLabel(
            for: health,
            canReconnectToSavedHost: snapshot.canReconnectToSavedHost
          ))
            .font(.system(.body, design: .rounded).weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
          if let detail = stateDetailLine {
            Text(detail)
              .font(.caption)
              .foregroundStyle(ADEColor.textSecondary)
              .lineLimit(2)
              .fixedSize(horizontal: false, vertical: true)
          }
          if health.transport.isConnected,
             outcome == .standard,
             let routeLabel = syncTransportBadgeText(routeKind: snapshot.routeKind) {
            Text(routeLabel)
              .font(.caption2.weight(.semibold))
              .foregroundStyle(ADEColor.textSecondary)
              .padding(.horizontal, 7)
              .padding(.vertical, 3)
              .background(ADEColor.recessedBackground, in: Capsule())
              .overlay(Capsule().stroke(ADEColor.border.opacity(0.7), lineWidth: 0.7))
          }
        }
        Spacer(minLength: 0)
        SettingsConnectionQuickAction(
          connectionState: snapshot.connectionState,
          canReconnectToSavedHost: snapshot.canReconnectToSavedHost,
          onDisconnect: onDisconnect,
          onReconnect: onReconnect
        )
        .layoutPriority(1)
      }

      if showsWakeAction, let onWake {
        // Its own row rather than the trailing slot: the trailing control
        // belongs to the connection we are ON, and taking it would cost the
        // user their Disconnect for as long as this card stands.
        HStack {
          Spacer(minLength: 0)
          ADEGlassActionButton(
            title: "Wake it",
            symbol: "power",
            tint: ADEColor.purpleAccent
          ) {
            onWake()
          }
          .accessibilityLabel("Wake the machine")
        }
      }

      if outcome != .standard {
        // The outcome lines above already name both machines and carry the
        // action. Anything else here is the second label that started this.
        EmptyView()
      } else if health.transport == .unreachable, let hostName = pendingHostName {
        // Only after the attempt is over. While it is running the status line
        // above already names the machine being reached, and a second line
        // repeating it is how this card came to carry two of them.
        Text(pendingDescription(hostName: hostName))
          .font(.subheadline)
          .foregroundStyle(ADEColor.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      } else if !snapshot.canReconnectToSavedHost {
        // Onboarding copy for users who have never paired a machine. Once a
        // machine is saved we never show this again — the status caption above
        // ("Last connected to: …") carries the returning-user message instead.
        Text("Pair once on Wi‑Fi to remotely connect later.")
          .font(.subheadline)
          .foregroundStyle(ADEColor.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }

      if let errorMessage,
         outcome == .standard,
         !health.transport.isConnected {
        SettingsInlineErrorBanner(
          message: errorMessage,
          actionTitle: snapshot.canPairWithPin ? "Pair with PIN instead" : nil,
          onAction: onPairWithPin
        )
      }

      if let compatibilityMessage {
        SettingsHostCompatibilityBanner(message: compatibilityMessage)
      }

    }
    .padding(18)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(
      RoundedRectangle(cornerRadius: 20, style: .continuous)
        .fill(
          LinearGradient(
            colors: [
              ADEColor.purpleAccent.opacity(0.10),
              ADEColor.purpleAccent.opacity(0.02),
            ],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
          )
        )
    )
    .glassEffect(in: .rect(cornerRadius: 20))
    .overlay(
      RoundedRectangle(cornerRadius: 20, style: .continuous)
        .strokeBorder(
          LinearGradient(
            colors: [
              SettingsConnectionPresentation.statusTint(for: health).opacity(0.55),
              SettingsConnectionPresentation.statusTint(for: health).opacity(0.10),
            ],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
          ),
          lineWidth: 0.9
        )
    )
    .shadow(
      color: SettingsConnectionPresentation.glowTint(for: health).opacity(0.35),
      radius: 22,
      y: 8
    )
    .task(id: pulseTaskKey) {
      await updatePulsingState()
    }
  }

  private var isActiveState: Bool {
    health.transport == .connecting
  }

  private var pulseTaskKey: Bool {
    isActiveState && !reduceMotion
  }

  private func updatePulsingState() async {
    let shouldPulse = pulseTaskKey
    if shouldPulse {
      await Task.yield()
    }
    guard pulsing != shouldPulse else { return }
    withAnimation(ADEMotion.standard(reduceMotion: reduceMotion)) {
      pulsing = shouldPulse
    }
  }

  private var errorMessage: String? {
    snapshot.errorMessage
  }

  private var pendingHostName: String? {
    snapshot.connectAttemptHostName
  }

  private var compatibilityMessage: String? {
    guard health.transport.isConnected,
          snapshot.hostCompatibilityMode == .limited else {
      return nil
    }
    let missingCount = snapshot.hostCompatibilityMissingActions.count
    if snapshot.hostCompatibilityMissingActions.contains("commandRouting") {
      return "This machine is running an older ADE brain. Update ADE on the machine to enable mobile actions."
    }
    if missingCount > 0 {
      if missingCount == 1 {
        return "1 mobile action needs a newer ADE brain on this machine."
      }
      return "\(missingCount) mobile actions need a newer ADE brain on this machine."
    }
    return "Update ADE on this machine for full mobile support."
  }

  /// Shown only once the wake has settled. During the attempt the trailing
  /// Cancel is the right control, and a second button offering to start what is
  /// already running is how a card stops being trustworthy.
  private var showsWakeAction: Bool {
    guard onWake != nil else { return false }
    if case .asleep = outcome { return true }
    return false
  }

  private var stateDetailLine: String? {
    if let detail = settingsConnectionOutcomeDetail(outcome) { return detail }
    switch health.transport {
    case .connected:
      // Name the machine you're attached to, right under the status word.
      return snapshot.hostDisplayName
    case .connecting:
      // Never claim the target is a *saved* machine — an account adoption can
      // be reaching a Mac this phone has never paired with. With no stage
      // label, name the machine this attempt is actually aimed at: the subject
      // name is repointed with the attempt, so the two lines of this card
      // cannot name different machines by construction.
      if let stage = snapshot.accountConnectStageLabel { return stage }
      guard let machine = pendingHostName else { return "Connecting to your machine" }
      return "Connecting to \(machine)\u{2026}"
    case .unreachable:
      return "Can\u{2019}t reach your machine"
    case .disconnected:
      // Returning users see where they left off. Brand-new users (no saved
      // machine) get no caption here at all — the pairing onboarding copy
      // below carries the message instead.
      if snapshot.canReconnectToSavedHost, let host = snapshot.hostDisplayName {
        return "Last connected to: \(host)"
      }
      return nil
    }
  }

  /// `hostName` is always the machine the current attempt is aimed at — the
  /// snapshot resolves that before this view sees it, so the copy can never
  /// name the last-connected machine while reaching a different one.
  private func pendingDescription(hostName: String) -> String {
    switch health.transport {
    case .unreachable:
      return "Tap reconnect to try \(hostName) again \u{2014} or pair another machine below."
    default:
      return "Reaching \(hostName)\u{2026}"
    }
  }
}

private struct SettingsHostCompatibilityBanner: View {
  let message: String

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: "exclamationmark.triangle.fill")
        .font(.system(size: 15, weight: .semibold))
        .foregroundStyle(ADEColor.warning)
        .padding(.top, 1)

      VStack(alignment: .leading, spacing: 3) {
        Text("Machine update recommended")
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
        Text(message)
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 10)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(ADEColor.warning.opacity(0.10), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .strokeBorder(ADEColor.warning.opacity(0.25), lineWidth: 0.75)
    )
  }
}

private struct SettingsConnectionQuickAction: View {
  let connectionState: RemoteConnectionState
  let canReconnectToSavedHost: Bool
  let onDisconnect: () -> Void
  let onReconnect: () -> Void

  var body: some View {
    switch connectionState {
    case .connected:
      ADEGlassActionButton(
        title: "Disconnect",
        symbol: "power",
        tint: ADEColor.textSecondary
      ) {
        onDisconnect()
      }
      .accessibilityLabel("Disconnect from machine")

    case .connecting:
      // Status copy lives in the header's leading column — keep the trailing
      // control compact so it never steals width from the title stack.
      Button {
        onDisconnect()
      } label: {
        HStack(spacing: 6) {
          ProgressView().controlSize(.mini)
          Text("Cancel")
            .font(.caption.weight(.semibold))
            .foregroundStyle(ADEColor.textSecondary)
            .lineLimit(1)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
      }
      .buttonStyle(.plain)
      .background(ADEColor.textSecondary.opacity(0.1), in: Capsule())
      .glassEffect()
      .fixedSize(horizontal: true, vertical: false)
      .accessibilityLabel("Cancel connecting")

    case .error, .disconnected:
      if canReconnectToSavedHost {
        ADEGlassActionButton(
          title: "Reconnect",
          symbol: "arrow.clockwise",
          tint: ADEColor.purpleAccent
        ) {
          onReconnect()
        }
        .accessibilityLabel("Reconnect to saved machine")
      }
    }
  }
}

private struct SettingsStatusDot: View {
  let health: SyncConnectionHealth
  let pulsing: Bool
  let reduceMotion: Bool
  var isAsleep = false

  var body: some View {
    ZStack {
      Circle()
        .fill(dotColor.opacity(0.45))
        .frame(width: 24, height: 24)
        .blur(radius: 6)

      Circle()
        .fill(
          RadialGradient(
            colors: [
              dotColor,
              dotColor.opacity(0.55),
            ],
            center: .init(x: 0.35, y: 0.32),
            startRadius: 0.5,
            endRadius: 8
          )
        )
        .frame(width: 14, height: 14)
        .overlay(
          Circle().strokeBorder(.white.opacity(0.45), lineWidth: 0.6)
        )
    }
    .scaleEffect(shouldPulse ? 1.18 : 1.0)
    .animation(pulseAnimation, value: pulsing)
  }

  private var shouldPulse: Bool {
    health.transport == .connecting && pulsing && !reduceMotion
  }

  private var pulseAnimation: Animation? {
    guard !reduceMotion else { return nil }
    return .smooth(duration: 1.0).repeatForever(autoreverses: true)
  }

  private var dotColor: Color {
    // A sleeping machine is not a fault. Amber says "needs a tap", which is
    // exactly true, where red would say something is broken.
    if isAsleep { return ADEColor.warning }
    switch health.transport {
    case .connected:
      return health.load == .strained ? ADEColor.warning : ADEColor.purpleAccent
    case .connecting:
      return ADEColor.warning
    case .unreachable:
      return ADEColor.danger
    case .disconnected:
      // Disconnected is an inactive state in the new header presentation —
      // a saturated purple here reads as "active" and contradicts the rest
      // of the inactive affordances.
      return ADEColor.textMuted
    }
  }
}

private struct SettingsInlineErrorBanner: View {
  let message: String
  var actionTitle: String?
  var onAction: (() -> Void)?

  var body: some View {
    HStack(alignment: .top, spacing: 8) {
      Image(systemName: "exclamationmark.triangle.fill")
        .font(.caption.weight(.semibold))
        .foregroundStyle(ADEColor.danger)
      VStack(alignment: .leading, spacing: 7) {
        Text(message)
          .font(.caption)
          .foregroundStyle(ADEColor.danger)
          .fixedSize(horizontal: false, vertical: true)
        if let actionTitle, let onAction {
          Button(actionTitle, action: onAction)
            .font(.caption.weight(.semibold))
            .foregroundStyle(ADEColor.accent)
            .frame(minHeight: 44)
            .buttonStyle(.plain)
        }
      }
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 8)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(ADEColor.danger.opacity(0.1), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 12, style: .continuous)
        .stroke(ADEColor.danger.opacity(0.25), lineWidth: 0.6)
    )
  }
}
