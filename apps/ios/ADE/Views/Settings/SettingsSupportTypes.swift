import SwiftUI

enum SettingsPairSheetRoute: Identifiable {
  case discover
  case manual
  case scan

  var id: String {
    switch self {
    case .discover: return "discover"
    case .manual: return "manual"
    case .scan: return "scan"
    }
  }
}

enum PinPreset: Identifiable {
  case discover(DiscoveredSyncHost)
  case manual(host: String, port: Int)
  /// A new machine from a scanned pairing QR — the user still types the PIN,
  /// but the host/port/candidates (incl. relay) come from the payload.
  case qr(PairingQrPayload)

  var id: String {
    switch self {
    case .discover(let host):
      return "discover-\(host.id)"
    case .manual(let host, let port):
      return "manual-\(host)-\(port)"
    case .qr(let payload):
      return "qr-\(payload.hostIdentity.deviceId)-\(payload.port)"
    }
  }

  var hostDisplayName: String {
    switch self {
    case .discover(let host):
      return host.hostName
    case .manual(let host, _):
      return host
    case .qr(let payload):
      return payload.hostIdentity.name
    }
  }
}

/// Routes the friendly "Set a PIN on this machine" screen. Presented when a
/// machine advertises that no pairing PIN is configured (proactive, via the
/// Bonjour `pairingPinConfigured=false` TXT key) or when the host returns
/// `pin_not_set` during a pairing attempt (reactive fallback). Carries the
/// preset so "Try again" can reopen the PIN sheet for the same machine.
enum PinSetupRoute: Identifiable {
  case host(DiscoveredSyncHost)
  case manual(host: String, port: Int)
  case qr(PairingQrPayload)

  var id: String {
    switch self {
    case .host(let host):
      return "pinsetup-\(host.id)"
    case .manual(let host, let port):
      return "pinsetup-manual-\(host)-\(port)"
    case .qr(let payload):
      return "pinsetup-qr-\(payload.hostIdentity.deviceId)-\(payload.port)"
    }
  }

  /// The friendly machine name shown in the screen's body copy.
  var machineDisplayName: String {
    switch self {
    case .host(let host):
      let trimmed = host.hostName.trimmingCharacters(in: .whitespacesAndNewlines)
      return trimmed.isEmpty ? "this machine" : trimmed
    case .manual(let host, _):
      let trimmed = host.trimmingCharacters(in: .whitespacesAndNewlines)
      return trimmed.isEmpty ? "this machine" : trimmed
    case .qr(let payload):
      let trimmed = payload.hostIdentity.name.trimmingCharacters(in: .whitespacesAndNewlines)
      return trimmed.isEmpty ? "this machine" : trimmed
    }
  }

  /// The PIN-entry preset to reopen when the user taps "Try again".
  var pinPreset: PinPreset {
    switch self {
    case .host(let host):
      return .discover(host)
    case .manual(let host, let port):
      return .manual(host: host, port: port)
    case .qr(let payload):
      return .qr(payload)
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
