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
/// line, and a trailing affordance — in one of two looks selected by `surface`:
/// `.row` (a glassy list row) or `.card` (an opaque accent-bordered card).
///
/// Callers wrap it in their own `Button` and own the tap/disabled/accessibility
/// behavior; this view is purely the visual content so each site keeps its
/// existing interaction semantics.
struct MachineRowView: View {
  enum Surface { case row, card }

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
  var surface: Surface = .row
  var onRename: (() -> Void)?

  private let cornerRadius: CGFloat = 16

  var body: some View {
    HStack(spacing: 14) {
      iconTile

      VStack(alignment: .leading, spacing: 3) {
        HStack(spacing: 6) {
          Text(title)
            .font(.body.weight(.medium))
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(1)
          if let statusPill {
            ADEStatusPill(text: statusPill.text, tint: statusPill.tint)
          }
        }
        Text(routeHint)
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(1)
      }

      Spacer(minLength: 8)

      HStack(spacing: 4) {
        if let onRename {
          Button(action: onRename) {
            Image(systemName: "pencil")
              .font(.system(size: 13, weight: .semibold))
              .foregroundStyle(ADEColor.textSecondary)
              .frame(width: 44, height: 44)
              .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .accessibilityLabel("Rename \(title)")
        }
        trailing
      }
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 13)
    .frame(maxWidth: .infinity, alignment: .leading)
    .modifier(MachineRowSurface(surface: surface, cornerRadius: cornerRadius))
  }

  private var visualState: MachineRowVisualState {
    machineRowVisualState(
      isAuthenticatedCurrent: isAuthenticatedCurrent,
      directoryRecentlyReachable: online
    )
  }

  private var iconColor: Color {
    visualState == .authenticatedCurrent ? ADEColor.success : ADEColor.textMuted
  }

  private var iconTile: some View {
    Image(systemName: deviceSymbol)
      .font(.system(size: 18, weight: .semibold))
      .foregroundStyle(iconColor)
      .frame(width: 38, height: 38)
      .background(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .fill(iconColor.opacity(0.14))
      )
      .overlay(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .strokeBorder(
            (visualState == .authenticatedCurrent ? ADEColor.success : ADEColor.border).opacity(0.3),
            lineWidth: 0.6
          )
      )
  }

  @ViewBuilder
  private var trailing: some View {
    switch affordance {
    case .connect:
      HStack(spacing: 4) {
        Text("Connect")
          .font(.caption.weight(.semibold))
        Image(systemName: "chevron.right")
          .font(.system(size: 11, weight: .bold))
      }
      .foregroundStyle(ADEColor.accent)
    case .chevron:
      Image(systemName: "chevron.right")
        .font(.system(size: 13, weight: .bold))
        .foregroundStyle(ADEColor.accent.opacity(0.8))
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

private struct MachineRowSurface: ViewModifier {
  let surface: MachineRowView.Surface
  let cornerRadius: CGFloat

  func body(content: Content) -> some View {
    switch surface {
    case .row:
      content
        .background(
          RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
            .fill(ADEColor.surfaceBackground.opacity(0.5))
        )
        .glassEffect(in: .rect(cornerRadius: cornerRadius))
        .overlay(
          RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
            .stroke(ADEColor.glassBorder, lineWidth: 0.75)
        )
    case .card:
      content
        .background(
          ADEColor.cardBackground.opacity(0.72),
          in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        )
        .overlay(
          RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
            .stroke(ADEColor.accent.opacity(0.28), lineWidth: 1)
        )
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

/// The unified status hint for a saved machine. Directory presence is only a
/// routing hint; absence never claims the Mac is powered off. Callers with a
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
