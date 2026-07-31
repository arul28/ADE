import SwiftUI

func settingsVersionLabel(marketingVersion: String, build: String) -> String {
  "v\(marketingVersion) (\(build))"
}

struct SettingsDiagnosticsSection: View {
  enum Content: Equatable {
    case all
    case connection
    case about
  }

  let snapshot: SettingsDiagnosticsSnapshot
  var content: Content = .all

  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      if content != .about {
        VStack(alignment: .leading, spacing: 10) {
          SettingsSectionHeader(label: "CONNECTION DETAILS")

          if snapshot.connectionRoute == nil, snapshot.connectionPerformance == nil {
            SettingsConnectionDetailsEmptyState()
          } else {
            VStack(spacing: 10) {
              if let route = snapshot.connectionRoute {
                SettingsDetailRow(
                  symbol: "point.3.connected.trianglepath.dotted",
                  label: "Route",
                  value: route
                )
              }

              if let performance = snapshot.connectionPerformance {
                SettingsDetailRow(
                  symbol: "timer",
                  label: "Last connection",
                  value: performance
                )
              }
            }
          }
        }
      }

      if content != .connection {
        VStack(alignment: .leading, spacing: 10) {
          SettingsSectionHeader(label: "ABOUT")

          VStack(spacing: 10) {
            SettingsDetailRow(
              symbol: "app.badge",
              label: "ADE",
              value: Self.appVersionString
            )

            if let identity = snapshot.pairedMachineIdentity {
              SettingsDetailRow(
                symbol: "desktopcomputer.and.arrow.down",
                label: "Paired machine",
                value: identity
              )
            }

            if let lastSync = snapshot.lastSyncDescription {
              SettingsDetailRow(
                symbol: "clock.arrow.circlepath",
                label: "Last sync",
                value: lastSync
              )
            }

            if let deviceId = snapshot.deviceIdentity {
              SettingsDetailRow(
                symbol: "iphone",
                label: "This device",
                value: deviceId
              )
            }
          }
        }
      }
    }
  }

  private static var appVersionString: String {
    let info = Bundle.main.infoDictionary
    let shortVersion = info?["CFBundleShortVersionString"] as? String ?? "–"
    let build = info?["CFBundleVersion"] as? String ?? "–"
    return settingsVersionLabel(marketingVersion: shortVersion, build: build)
  }
}

private struct SettingsConnectionDetailsEmptyState: View {
  var body: some View {
    HStack(spacing: 12) {
      Image(systemName: "desktopcomputer.trianglebadge.exclamationmark")
        .font(.system(size: 14, weight: .semibold))
        .foregroundStyle(ADEColor.textSecondary)

      Text("Connect to a machine to see route and performance details.")
        .font(.subheadline)
        .foregroundStyle(ADEColor.textSecondary)
        .fixedSize(horizontal: false, vertical: true)
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 16)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(
      RoundedRectangle(cornerRadius: 12)
        .fill(ADEColor.surfaceBackground.opacity(0.55))
    )
    .overlay(
      RoundedRectangle(cornerRadius: 12)
        .stroke(ADEColor.border.opacity(0.45), lineWidth: 0.75)
    )
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
