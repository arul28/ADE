import SwiftUI

enum SettingsPairSheetRoute: Identifiable {
  case discover
  case qr
  case manual

  var id: String {
    switch self {
    case .discover: return "discover"
    case .qr: return "qr"
    case .manual: return "manual"
    }
  }
}

enum PinPreset: Identifiable {
  case discover(DiscoveredSyncHost)
  case qr(SyncPairingQrPayload)
  case manual(host: String, port: Int)

  var id: String {
    switch self {
    case .discover(let host):
      return "discover-\(host.id)"
    case .qr(let payload):
      return "qr-\(payload.hostIdentity.deviceId)"
    case .manual(let host, let port):
      return "manual-\(host)-\(port)"
    }
  }

  var hostDisplayName: String {
    switch self {
    case .discover(let host):
      return host.hostName
    case .qr(let payload):
      return payload.hostIdentity.name
    case .manual(let host, _):
      return host
    }
  }
}

enum SettingsConnectionPresentation {
  static func statusLabel(for state: RemoteConnectionState) -> String {
    switch state {
    case .connected: return "Connected"
    case .connecting: return "Connecting"
    case .syncing: return "Syncing"
    case .error: return "Connection error"
    case .disconnected: return "Not connected"
    }
  }

  static func statusTint(for state: RemoteConnectionState) -> Color {
    switch state {
    case .connected: return ADEColor.success
    case .connecting, .syncing: return ADEColor.warning
    case .error: return ADEColor.danger
    case .disconnected: return ADEColor.textMuted
    }
  }

  static func glowTint(for state: RemoteConnectionState) -> Color {
    switch state {
    case .connected: return ADEColor.purpleGlow
    case .connecting, .syncing: return ADEColor.warning.opacity(0.25)
    case .error: return ADEColor.danger.opacity(0.22)
    case .disconnected: return .clear
    }
  }
}
