import SwiftUI

struct SettingsDiagnosticsSection: View {
  @EnvironmentObject private var syncService: SyncService

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      SettingsSectionHeader(label: "ABOUT")

      VStack(spacing: 10) {
        SettingsDetailRow(
          symbol: "app.badge",
          label: "ADE",
          value: Self.appVersionString
        )

        if let identity = syncService.activeHostProfile?.hostIdentity {
          SettingsDetailRow(
            symbol: "desktopcomputer.and.arrow.down",
            label: "Paired host",
            value: Self.shortIdentity(identity)
          )
        }

        if let lastSync = syncService.lastSyncAt {
          SettingsDetailRow(
            symbol: "clock.arrow.circlepath",
            label: "Last sync",
            value: Self.relativeDate(lastSync)
          )
        }

        if let deviceId = syncService.activeHostProfile?.pairedDeviceId {
          SettingsDetailRow(
            symbol: "iphone",
            label: "This device",
            value: Self.shortIdentity(deviceId)
          )
        }
      }
    }
  }

  private static var appVersionString: String {
    let info = Bundle.main.infoDictionary
    let shortVersion = info?["CFBundleShortVersionString"] as? String ?? "–"
    let build = info?["CFBundleVersion"] as? String ?? "–"
    return "\(shortVersion) (\(build))"
  }

  private static func shortIdentity(_ raw: String) -> String {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard trimmed.count > 12 else { return trimmed }
    let prefix = trimmed.prefix(6)
    let suffix = trimmed.suffix(4)
    return "\(prefix)…\(suffix)"
  }

  private static func relativeDate(_ date: Date) -> String {
    let formatter = RelativeDateTimeFormatter()
    formatter.unitsStyle = .short
    return formatter.localizedString(for: date, relativeTo: Date())
  }
}

struct SettingsDetailRow: View {
  let symbol: String
  let label: String
  let value: String

  var body: some View {
    HStack(alignment: .center, spacing: 12) {
      Image(systemName: symbol)
        .font(.system(size: 14, weight: .semibold))
        .foregroundStyle(ADEColor.purpleAccent)
        .frame(width: 28, height: 28)
        .background(
          RoundedRectangle(cornerRadius: 9, style: .continuous)
            .fill(ADEColor.purpleAccent.opacity(0.14))
        )

      Text(label)
        .font(.subheadline.weight(.medium))
        .foregroundStyle(ADEColor.textPrimary)

      Spacer(minLength: 8)

      Text(value)
        .font(.caption.monospaced())
        .foregroundStyle(ADEColor.textSecondary)
        .lineLimit(1)
        .truncationMode(.middle)
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .fill(ADEColor.surfaceBackground.opacity(0.06))
    )
    .glassEffect(in: .rect(cornerRadius: 14))
    .overlay(
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .stroke(ADEColor.border.opacity(0.14), lineWidth: 0.6)
    )
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(label): \(value)")
  }
}
