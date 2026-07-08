import SwiftUI

struct SettingsConnectionHeader: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  let snapshot: SettingsConnectionSnapshot
  let onDisconnect: () -> Void
  let onReconnect: (Bool) -> Void

  @State private var pulsing = false

  private var health: SyncConnectionHealth {
    snapshot.health
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack(alignment: .center, spacing: 12) {
        SettingsStatusDot(
          health: health,
          pulsing: pulsing,
          reduceMotion: reduceMotion
        )
        VStack(alignment: .leading, spacing: 1) {
          Text(SettingsConnectionPresentation.statusLabel(for: health))
            .font(.system(.body, design: .rounded).weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
          if let detail = stateDetailLine {
            Text(detail)
              .font(.caption)
              .foregroundStyle(ADEColor.textSecondary)
              .lineLimit(2)
              .fixedSize(horizontal: false, vertical: true)
          }
        }
        Spacer(minLength: 0)
        SettingsConnectionQuickAction(
          connectionState: snapshot.connectionState,
          canReconnectToSavedHost: snapshot.canReconnectToSavedHost,
          savedReconnectPrefersTailnet: snapshot.savedReconnectPrefersTailnet,
          onDisconnect: onDisconnect,
          onReconnect: onReconnect
        )
        .layoutPriority(1)
      }

      if health.transport.isConnected {
        VStack(alignment: .leading, spacing: 4) {
          SettingsConnectedHostDetails(routeLine: snapshot.routeLine)
          if snapshot.usingRelay {
            // Quiet nudge: relay is a valid automatic path; Tailscale is only a
            // recommendation for faster, steadier direct sync.
            Text("Using ADE relay. For faster, more stable sync, connect both devices with Tailscale.")
              .font(.caption)
              .foregroundStyle(ADEColor.textSecondary)
              .fixedSize(horizontal: false, vertical: true)
          }
        }
      } else if let hostName = pendingHostName {
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
         !health.transport.isConnected {
        SettingsInlineErrorBanner(message: errorMessage)
      }

      if let compatibilityMessage {
        SettingsHostCompatibilityBanner(message: compatibilityMessage)
      }

      if snapshot.showTailscaleOffHint {
        ADETailscaleOffHintCard()
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
    snapshot.pendingHostName
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

  private var stateDetailLine: String? {
    switch health.transport {
    case .connected:
      // Name the machine you're attached to, right under the status word.
      return snapshot.hostDisplayName
    case .connecting:
      return "Connecting to saved machine"
    case .unreachable:
      return "Unable to reach your machine"
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

  private func pendingDescription(hostName: String) -> String {
    switch health.transport {
    case .connecting:
      return "Reaching \(hostName)..."
    case .unreachable:
      return "Tap reconnect to try \(hostName) again, or pair a different machine below."
    default:
      return "Reaching \(hostName)..."
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

private struct SettingsConnectedHostDetails: View {
  let routeLine: String?

  var body: some View {
    // The machine name now lives in the status caption above, so this block
    // only carries the route line (Tailscale/LAN address · port).
    if let routeLine {
      Text(routeLine)
        .font(.caption.monospaced())
        .foregroundStyle(ADEColor.textSecondary)
        .lineLimit(1)
        .truncationMode(.middle)
    }
  }
}

private struct SettingsConnectionQuickAction: View {
  let connectionState: RemoteConnectionState
  let canReconnectToSavedHost: Bool
  let savedReconnectPrefersTailnet: Bool
  let onDisconnect: () -> Void
  let onReconnect: (Bool) -> Void

  var body: some View {
    switch connectionState {
    case .connected, .syncing:
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
          onReconnect(savedReconnectPrefersTailnet)
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

  var body: some View {
    HStack(alignment: .top, spacing: 8) {
      Image(systemName: "exclamationmark.triangle.fill")
        .font(.caption.weight(.semibold))
        .foregroundStyle(ADEColor.danger)
      Text(message)
        .font(.caption)
        .foregroundStyle(ADEColor.danger)
        .fixedSize(horizontal: false, vertical: true)
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
