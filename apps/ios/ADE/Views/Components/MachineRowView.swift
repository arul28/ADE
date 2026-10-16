import Foundation
import SwiftUI

enum MachineRowVisualState: Equatable {
  case authenticatedCurrent
  case saved
}

func machineRowVisualState(
  isAuthenticatedCurrent: Bool,
  directoryRecentlyReachable: Bool
) -> MachineRowVisualState {
  // Directory presence is a heartbeat hint, not proof that this phone has an
  // authenticated live connection. Only the current socket earns green.
  _ = directoryRecentlyReachable
  return isAuthenticatedCurrent ? .authenticatedCurrent : .saved
}

/// One shared machine row, used by every surface that lists Macs a phone can
/// reach: the ACCOUNT section, the settings MACHINES list, and the hub
/// no-machine quick-connect home. It renders the common anatomy — a device icon
/// tile, the machine name with an optional status pill, a route/status hint
/// line, and a trailing affordance — on one quiet kit card (`adeKitCard`).
///
/// Callers wrap it in their own `Button` and own the tap/disabled/accessibility
/// behavior; this view is purely the visual content so each site keeps its
/// existing interaction semantics.
struct MachineRowView: View {
  /// The inline pill shown next to the machine name. Omit (`nil`) for the card
  /// look, which leads with the name alone.
  enum StatusPill {
    case connected

    var text: String {
      "CONNECTED"
    }

    var tint: Color {
      ADEColor.success
    }
  }

  /// The trailing edge control that signals what a tap does.
  enum Affordance {
    case connect     // "Connect" + chevron
    case wake        // "Wake" + chevron — asleep, and dialling is what wakes it
    case chevron     // chevron only
    case connecting  // progress spinner
    case connected   // success checkmark (already the active machine)
    case none
  }

  let deviceSymbol: String
  let title: String
  let routeHint: String
  let online: Bool
  var isAuthenticatedCurrent = false
  var statusPill: StatusPill?
  var affordance: Affordance

  var body: some View {
    HStack(spacing: 12) {
      iconTile

      VStack(alignment: .leading, spacing: 3) {
        // The name gets the whole line: a status pill beside it cut long
        // names down to "MacBo…7) · ADE".
        Text(title)
          .font(.system(size: 15, weight: .medium))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
          // The end of an account row names the install ("· ADE Alpha"),
          // which is what tells two installs on one Mac apart.
          .truncationMode(.middle)
        HStack(spacing: 6) {
          if let statusPill {
            Circle()
              .fill(statusPill.tint)
              .frame(width: 7, height: 7)
          }
          Text(routeHint)
            .font(.system(size: 12.5))
            .foregroundStyle(statusPill?.tint ?? ADEColor.textSecondary)
            .lineLimit(1)
        }
      }

      Spacer(minLength: 8)

      trailing
    }
    .padding(.horizontal, ADEKit.inset)
    .padding(.vertical, 12)
    .adeKitCard(padding: nil)
  }

  private var visualState: MachineRowVisualState {
    machineRowVisualState(
      isAuthenticatedCurrent: isAuthenticatedCurrent,
      directoryRecentlyReachable: online
    )
  }

  private var iconTile: some View {
    Image(systemName: deviceSymbol)
      .font(.system(size: 16, weight: .regular))
      .foregroundStyle(visualState == .authenticatedCurrent ? ADEColor.success : ADEColor.textSecondary)
      .frame(width: 34, height: 34)
      .background(ADEKit.track, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
  }

  @ViewBuilder
  private var trailing: some View {
    switch affordance {
    case .connect, .wake:
      // Same shape either way: the word is the only thing that changes, because
      // the tap is the same tap — a machine that is asleep wakes because it was
      // dialled, not through a separate button.
      HStack(spacing: 4) {
        Text(affordance == .wake ? "Wake" : "Connect")
          .font(.system(size: 13, weight: .semibold))
        Image(systemName: "chevron.right")
          .font(.system(size: 10, weight: .semibold))
      }
      .foregroundStyle(ADEColor.accent)
    case .chevron:
      ADESettingsChevron()
    case .connecting:
      ProgressView().controlSize(.small)
    case .connected:
      Image(systemName: "checkmark.circle.fill")
        .font(.system(size: 15, weight: .semibold))
        .foregroundStyle(ADEColor.success)
    case .none:
      EmptyView()
    }
  }
}

/// The SF Symbol for a machine, chosen from whatever device/platform hint the
/// directory or pairing record advertised. Unknown/absent hints (e.g. a
/// directly-paired host that carries no device type) fall back to a laptop.
func machineDeviceSymbol(deviceType: String?, platform: String?) -> String {
  switch (deviceType ?? platform ?? "").lowercased() {
  case let value where value.contains("phone") || value.contains("ios"): return "iphone"
  case let value where value.contains("pad"): return "ipad"
  case let value where value.contains("mac") || value.contains("desktop"): return "desktopcomputer"
  default: return "laptopcomputer"
  }
}

/// The SF Symbol for a machine known by fleet key and name: the account's
/// device type when the account lists the machine, else a guess from the name
/// (a laptop for a name like one, a desktop otherwise).
@MainActor
func machineSymbol(machineKey: String?, name: String) -> String {
  if let identity = machineKey.flatMap(HiddenMachineStore.identity(fromFleetKey:)),
     let machine = AccountService.shared.machines.first(where: {
       $0.deviceId?.caseInsensitiveCompare(identity) == .orderedSame
     }),
     machine.deviceType != nil || machine.platform != nil {
    return machineDeviceSymbol(deviceType: machine.deviceType, platform: machine.platform)
  }
  let lower = name.lowercased()
  if lower.contains("macbook") || lower.contains("laptop") { return "laptopcomputer" }
  return "desktopcomputer"
}

/// The unified status hint for a saved machine. Directory presence is only a
/// routing hint; absence never claims the computer is powered off. Callers with a
/// richer route label show that instead and fall back to this.
func machineReachabilityText(
  isConnected: Bool,
  directoryOnline: Bool,
  lastSeenAt: Date?,
  now: Date = Date()
) -> String {
  if isConnected { return "Connected" }
  if directoryOnline { return "Online" }
  guard let lastSeenAt else { return "Last seen unknown" }
  let seconds = max(0, Int(now.timeIntervalSince(lastSeenAt)))
  if seconds < 60 { return "Last seen just now" }
  if seconds < 3_600 {
    let minutes = seconds / 60
    return "Last seen \(minutes)m ago"
  }
  if seconds < 86_400 {
    let hours = seconds / 3_600
    return "Last seen \(hours)h ago"
  }
  let days = seconds / 86_400
  return "Last seen \(days)d ago"
}

func machineLastSeenDate(epochMilliseconds: Double?) -> Date? {
  guard let epochMilliseconds, epochMilliseconds.isFinite, epochMilliseconds >= 0 else {
    return nil
  }
  return Date(timeIntervalSince1970: epochMilliseconds / 1_000)
}

func machineLastSeenDate(iso8601: String?) -> Date? {
  guard let iso8601 else { return nil }
  let fractional = ISO8601DateFormatter()
  fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  return fractional.date(from: iso8601) ?? ISO8601DateFormatter().date(from: iso8601)
}
