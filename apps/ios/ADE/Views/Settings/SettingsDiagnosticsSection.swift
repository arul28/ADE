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
  @EnvironmentObject private var appUpdateAdvisor: AppUpdateAdvisor

  var body: some View {
    if content != .about {
      ADESettingsSection("Connection") {
        if snapshot.connectionRoute == nil, snapshot.connectionPerformance == nil {
          ADESettingsRows {
            ADESettingsRow("Not connected", hint: "Connect to a machine to see its route.", symbol: "desktopcomputer")
          }
        } else {
          ADESettingsRows {
            if let route = snapshot.connectionRoute {
              ADESettingsValueRow(title: "Route", value: route, mono: true)
            }
            if let performance = snapshot.connectionPerformance {
              ADESettingsValueRow(title: "Last connection", value: performance, mono: true)
            }
          }
        }
      }
    }

    if content != .connection {
      ADESettingsSection("This device") {
        ADESettingsRows {
          ADESettingsValueRow(title: "ADE", value: Self.appVersionString, mono: true)
          SettingsAppUpdateRow(advisor: appUpdateAdvisor)
          if let identity = snapshot.pairedMachineIdentity {
            ADESettingsValueRow(title: "Paired machine", value: identity, mono: true)
          }
          if let lastSync = snapshot.lastSyncDescription {
            ADESettingsValueRow(title: "Last sync", value: lastSync)
          }
          if let deviceId = snapshot.deviceIdentity {
            ADESettingsValueRow(title: "Device id", value: deviceId, mono: true)
          }
          // Performance logs from a diagnostics launch, to AirDrop to the
          // Mac when the phone has no cable data link.
          let logFiles = ScrollDiagnostics.logFileURLs
          if !logFiles.isEmpty {
            ShareLink(items: logFiles) {
              ADESettingsRow(title: "Share diagnostics log", symbol: "square.and.arrow.up", titleColor: ADEColor.accent) {
                EmptyView()
              }
            }
            .buttonStyle(ADEKitRowButtonStyle())
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

private struct SettingsAppUpdateRow: View {
  @ObservedObject var advisor: AppUpdateAdvisor

  private var status: String {
    if advisor.isChecking { return "Checking…" }
    if let version = advisor.availableVersion { return "ADE \(version) available" }
    return advisor.hasChecked ? "Up to date" : "Not checked yet"
  }

  var body: some View {
    ADESettingsRow(title: "App updates", hint: status) {
      Button("Check") {
        Task { await advisor.checkForUpdates(force: true) }
      }
      .buttonStyle(ADEKitButtonStyle(prominent: advisor.availableVersion != nil))
      .disabled(advisor.isChecking)
      .opacity(advisor.isChecking ? 0.55 : 1)
      .accessibilityLabel("Check for updates")
    }
    .accessibilityElement(children: .contain)
  }
}
