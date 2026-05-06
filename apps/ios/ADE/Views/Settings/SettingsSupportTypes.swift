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
  static func statusLabel(for health: SyncConnectionHealth) -> String {
    switch health.transport {
    case .connected:
      return health.load == .strained ? "Connected, slow" : "Connected"
    case .connecting:
      return "Connecting"
    case .unreachable:
      return "Connection error"
    case .disconnected:
      return "Not connected"
    }
  }

  static func statusTint(for health: SyncConnectionHealth) -> Color {
    switch health.transport {
    case .connected:
      return health.load == .strained ? ADEColor.warning : ADEColor.success
    case .connecting:
      return ADEColor.warning
    case .unreachable:
      return ADEColor.danger
    case .disconnected:
      return ADEColor.textMuted
    }
  }

  static func glowTint(for health: SyncConnectionHealth) -> Color {
    switch health.transport {
    case .connected:
      return health.load == .strained ? ADEColor.warning.opacity(0.22) : ADEColor.purpleGlow
    case .connecting:
      return ADEColor.warning.opacity(0.25)
    case .unreachable:
      return ADEColor.danger.opacity(0.22)
    case .disconnected:
      return .clear
    }
  }
}
