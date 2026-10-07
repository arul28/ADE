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

/// The machine "Wake it" would dial, or nil when the card must not offer one.
///
/// The affordance and its target are ONE value. They used to be two: the card
/// showed the button off `asleepMachineName`, which comes from the failure
/// record, while the key was resolved separately against the account directory
/// — so a machine the directory has not loaded yet, or no longer lists, gave a
/// name with no key and a "Wake it" that did nothing when tapped. A dead button
/// is the same broken state as a spinner that never ends. Binding the button to
/// this value makes it unrepresentable: no key, no button, and the copy above
/// still tells the truth about the machine being asleep.
func settingsWakeMachineKey(
  outcome: SettingsConnectionOutcome,
  wakeMachineKey: String?
) -> String? {
  guard case .asleep = outcome else { return nil }
  guard let trimmed = wakeMachineKey?.trimmingCharacters(in: .whitespacesAndNewlines),
        !trimmed.isEmpty else {
    return nil
  }
  return trimmed
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
  let snapshot: SettingsConnectionSnapshot
  let onDisconnect: () -> Void
  let onReconnect: () -> Void
  var onPairWithPin: (() -> Void)?
  /// Dials the sleeping machine again. Takes the machine to dial, so the card
  /// can only offer the action when it has a target. Bounded by the same
  /// connect attempt as every other path, so the card always lands back on a
  /// definite state.
  var onWake: ((String) -> Void)?

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

  /// A sleeping machine is not a fault: amber says "needs a tap".
  private var dotTone: ADEKitTone {
    if outcome != .standard { return .warn }
    switch health.transport {
    case .connected: return health.load == .strained ? .warn : .ok
    case .connecting: return .warn
    case .unreachable: return .crit
    case .disconnected: return .neutral
    }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .center, spacing: 12) {
        ADEKitDot(tone: dotTone, size: 8)
        VStack(alignment: .leading, spacing: 3) {
          HStack(spacing: 6) {
            Text(settingsConnectionOutcomeTitle(outcome) ?? SettingsConnectionPresentation.statusLabel(
              for: health,
              canReconnectToSavedHost: snapshot.canReconnectToSavedHost
            ))
              .font(.system(size: 15, weight: .semibold))
              .foregroundStyle(ADEColor.textPrimary)
            if health.transport.isConnected,
               outcome == .standard,
               let routeLabel = syncTransportBadgeText(routeKind: snapshot.routeKind) {
              ADEKitTag(text: routeLabel)
            }
          }
          if let detail = stateDetailLine {
            Text(detail)
              .font(.system(size: 12.5))
              .foregroundStyle(ADEColor.textSecondary)
              .lineLimit(2)
              .fixedSize(horizontal: false, vertical: true)
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

      if let wakeMachineKey, let onWake {
        // Its own row rather than the trailing slot: the trailing control
        // belongs to the connection we are ON, and taking it would cost the
        // user their Disconnect for as long as this card stands.
        HStack {
          Spacer(minLength: 0)
          Button {
            onWake(wakeMachineKey)
          } label: {
            Label("Wake it", systemImage: "power")
          }
          .buttonStyle(ADEKitButtonStyle(prominent: true))
          .accessibilityLabel("Wake the machine")
        }
      }

      if outcome != .standard {
        // The outcome lines above already name both machines and carry the
        // action. Anything else here is the second label that started this.
        EmptyView()
      } else if health.transport == .unreachable, let hostName = pendingHostName {
        // Only after the attempt is over. While it is running the status line
        // above already names the machine being reached.
        Text(pendingDescription(hostName: hostName))
          .font(.system(size: 13))
          .foregroundStyle(ADEColor.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      } else if !snapshot.canReconnectToSavedHost {
        // Onboarding copy for users who have never paired a machine.
        Text("Pair once on Wi‑Fi to remotely connect later.")
          .font(.system(size: 13))
          .foregroundStyle(ADEColor.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }

      if let errorMessage,
         outcome == .standard,
         !health.transport.isConnected {
        ADESettingsNotice(
          message: errorMessage,
          tone: .crit,
          actionTitle: snapshot.canPairWithPin ? "Pair with PIN instead" : nil,
          action: onPairWithPin
        )
      }

      if let compatibilityMessage {
        ADESettingsNotice(message: compatibilityMessage, tone: .warn)
      }
    }
    .adeKitCard()
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
  /// The machine "Wake it" dials, and the reason the button exists at all —
  /// see `settingsWakeMachineKey`.
  private var wakeMachineKey: String? {
    settingsWakeMachineKey(outcome: outcome, wakeMachineKey: snapshot.wakeMachineKey)
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

private struct SettingsConnectionQuickAction: View {
  let connectionState: RemoteConnectionState
  let canReconnectToSavedHost: Bool
  let onDisconnect: () -> Void
  let onReconnect: () -> Void

  var body: some View {
    switch connectionState {
    case .connected:
      Button("Disconnect", action: onDisconnect)
        .buttonStyle(ADEKitButtonStyle())
        .accessibilityLabel("Disconnect from machine")

    case .connecting:
      Button(action: onDisconnect) {
        HStack(spacing: 6) {
          ProgressView().controlSize(.mini)
          Text("Cancel")
        }
      }
      .buttonStyle(ADEKitButtonStyle())
      .fixedSize(horizontal: true, vertical: false)
      .accessibilityLabel("Cancel connecting")

    case .error, .disconnected:
      if canReconnectToSavedHost {
        Button("Reconnect", action: onReconnect)
          .buttonStyle(ADEKitButtonStyle(prominent: true))
          .accessibilityLabel("Reconnect to saved machine")
      }
    }
  }
}
