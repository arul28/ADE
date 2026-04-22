import SwiftUI

struct SettingsConnectionHeader: View {
  @EnvironmentObject private var syncService: SyncService
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  @State private var pulsing = false

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack(alignment: .center, spacing: 12) {
        SettingsStatusDot(
          state: syncService.connectionState,
          pulsing: pulsing,
          reduceMotion: reduceMotion
        )
        VStack(alignment: .leading, spacing: 1) {
          Text(SettingsConnectionPresentation.statusLabel(for: syncService.connectionState))
            .font(.system(.body, design: .rounded).weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
          if let detail = stateDetailLine {
            Text(detail)
              .font(.caption)
              .foregroundStyle(ADEColor.textSecondary)
          }
        }
        Spacer(minLength: 0)
        SettingsConnectionQuickAction()
          .environmentObject(syncService)
      }

      if syncService.connectionState == .connected {
        SettingsConnectedHostDetails()
          .environmentObject(syncService)
      } else if let hostName = pendingHostName {
        Text(pendingDescription(hostName: hostName))
          .font(.subheadline)
          .foregroundStyle(ADEColor.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      } else {
        Text("Pair a computer to start syncing lanes, work, and files.")
          .font(.subheadline)
          .foregroundStyle(ADEColor.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }

      if let errorMessage,
         syncService.connectionState != .connected,
         syncService.connectionState != .syncing {
        SettingsInlineErrorBanner(message: errorMessage)
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
              SettingsConnectionPresentation.statusTint(for: syncService.connectionState).opacity(0.55),
              SettingsConnectionPresentation.statusTint(for: syncService.connectionState).opacity(0.10),
            ],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
          ),
          lineWidth: 0.9
        )
    )
    .shadow(
      color: SettingsConnectionPresentation.glowTint(for: syncService.connectionState).opacity(0.35),
      radius: 22,
      y: 8
    )
    .task(id: pulseTaskKey) {
      await updatePulsingState()
    }
  }

  private var isActiveState: Bool {
    syncService.connectionState == .connecting || syncService.connectionState == .syncing
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
    syncService.lastError
  }

  private var pendingHostName: String? {
    switch syncService.connectionState {
    case .connecting, .syncing, .error:
      return displayHostName
    default:
      return nil
    }
  }

  private var displayHostName: String? {
    if let name = syncService.hostName, !name.isEmpty {
      return name
    }
    return syncService.activeHostProfile?.hostName
  }

  private var stateDetailLine: String? {
    switch syncService.connectionState {
    case .connected, .syncing:
      return "Live · ready to sync"
    case .connecting:
      return "Connecting to saved host"
    case .error:
      return "Unable to reach your Mac"
    case .disconnected:
      if syncService.savedReconnectHost?.tailscaleAddress != nil {
        return "Saved host · Tailscale route ready"
      }
      if syncService.canReconnectToSavedHost {
        return "Saved host · not connected"
      }
      return "No paired host"
    }
  }

  private func pendingDescription(hostName: String) -> String {
    switch syncService.connectionState {
    case .connecting:
      return "Reaching \(hostName)..."
    case .syncing:
      return "Syncing data from \(hostName)..."
    case .error:
      return "Tap reconnect to try \(hostName) again, or pair a different host below."
    default:
      return "Reaching \(hostName)..."
    }
  }
}

private struct SettingsConnectedHostDetails: View {
  @EnvironmentObject private var syncService: SyncService

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      if let hostName = displayHostName {
        Text(hostName)
          .font(.title3.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
      }
      if let routeLine {
        Text(routeLine)
          .font(.caption.monospaced())
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(1)
          .truncationMode(.middle)
      }
    }
  }

  private var displayHostName: String? {
    if let name = syncService.hostName, !name.isEmpty {
      return name
    }
    return syncService.activeHostProfile?.hostName
  }

  private var routeLine: String? {
    guard let address = syncService.currentAddress ?? syncService.activeHostProfile?.lastSuccessfulAddress else {
      return nil
    }
    let prefix = syncIsTailscaleIPv4Address(address) ? "Tailscale " : ""
    if let port = syncService.activeHostProfile?.port {
      return "\(prefix)\(address) · :\(port)"
    }
    return "\(prefix)\(address)"
  }
}

private struct SettingsConnectionQuickAction: View {
  @EnvironmentObject private var syncService: SyncService

  var body: some View {
    switch syncService.connectionState {
    case .connected, .syncing:
      ADEGlassActionButton(
        title: "Disconnect",
        symbol: "power",
        tint: ADEColor.textSecondary
      ) {
        syncService.disconnect()
      }
      .accessibilityLabel("Disconnect from host")

    case .connecting:
      HStack(spacing: 6) {
        ProgressView().controlSize(.mini)
        Text("Connecting")
          .font(.caption.weight(.medium))
          .foregroundStyle(ADEColor.textSecondary)
      }
      .padding(.horizontal, 10)
      .padding(.vertical, 7)
      .background(ADEColor.textSecondary.opacity(0.1), in: Capsule())
      .glassEffect()

    case .error, .disconnected:
      if syncService.canReconnectToSavedHost {
        ADEGlassActionButton(
          title: "Reconnect",
          symbol: "arrow.clockwise",
          tint: ADEColor.purpleAccent
        ) {
          Task { await syncService.reconnectIfPossible(userInitiated: true) }
        }
        .accessibilityLabel("Reconnect to saved host")
      }
    }
  }
}

private struct SettingsStatusDot: View {
  let state: RemoteConnectionState
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
    (state == .connecting || state == .syncing) && pulsing && !reduceMotion
  }

  private var pulseAnimation: Animation? {
    guard !reduceMotion else { return nil }
    return .smooth(duration: 1.0).repeatForever(autoreverses: true)
  }

  private var dotColor: Color {
    switch state {
    case .connected:
      return ADEColor.purpleAccent
    case .connecting, .syncing:
      return ADEColor.warning
    case .error:
      return ADEColor.danger
    case .disconnected:
      return Color(red: 156.0 / 255.0, green: 145.0 / 255.0, blue: 200.0 / 255.0)
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
