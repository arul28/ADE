import SwiftUI

#if DEBUG
/// `-adePreviewScreen settings-machines`: Settings with the Connected and
/// Available machine sections, from fixtures. `settings-machine-page` opens the
/// MacBook's machine page.
struct SettingsMachinesPreviewHost: View {
  var showsPage = false

  static let machines: [SettingsMachine] = [
    SettingsMachine(
      id: "studio", name: "Arul’s Mac Studio · ADE", symbol: "desktopcomputer", machineKey: "machine:studio",
      account: nil, link: .primary(live: true, connecting: false), online: true, isAsleep: false, lastSeenAt: nil,
      hiddenIdentity: "studio", detail: "Local network · plugged in",
      projects: [
        RemoteRosterProject(projectId: "ade", displayName: "ADE", booted: true, runningCount: 2, attentionCount: 0, lanes: [], chats: []),
      ]
    ),
    SettingsMachine(
      id: "mbp", name: "MacBook Pro (97) · ADE", symbol: "laptopcomputer", machineKey: "machine:mbp",
      account: nil, link: .connected(.live, gaveUp: false), online: true, isAsleep: false, lastSeenAt: nil,
      hiddenIdentity: "mbp", detail: "Local network · 11% battery",
      projects: [
        RemoteRosterProject(projectId: "ade", displayName: "ADE", booted: true, runningCount: 1, attentionCount: 0, lanes: [], chats: []),
        RemoteRosterProject(projectId: "versic", displayName: "Versic", booted: true, runningCount: 0, attentionCount: 0, lanes: [], chats: []),
      ]
    ),
    SettingsMachine(
      id: "alpha", name: "arul · ADE Alpha", symbol: "desktopcomputer", machineKey: "machine:alpha",
      account: nil, link: .connected(.offline(message: nil), gaveUp: true), online: false, isAsleep: false,
      lastSeenAt: Date().addingTimeInterval(-6 * 3600), hiddenIdentity: "alpha", detail: nil, projects: []
    ),
    SettingsMachine(
      id: "macpoop", name: "Macpoop · ADE Alpha", symbol: "laptopcomputer", machineKey: nil,
      account: nil, link: .available, online: true, isAsleep: false, lastSeenAt: nil,
      hiddenIdentity: "macpoop", detail: "82% battery", projects: []
    ),
    SettingsMachine(
      id: "windows", name: "windows · ADE", symbol: "desktopcomputer", machineKey: nil,
      account: nil, link: .available, online: false, isAsleep: false,
      lastSeenAt: Date().addingTimeInterval(-19 * 3600), hiddenIdentity: "windows", detail: nil, projects: []
    ),
  ]

  var body: some View {
    NavigationStack {
      if showsPage {
        SettingsMachinePageContent(machine: Self.machines[1], actions: SettingsMachinePageActions(rename: {}, removeFromAccount: {}))
          .navigationTitle("")
          .navigationBarTitleDisplayMode(.inline)
      } else {
        let sections = settingsMachineSections(Self.machines)
        ADESettingsPage(title: "Settings") {
          ADESettingsSection("Connected", hint: "2 of 4 live") {
            ADESettingsRows {
              ForEach(sections.connected) { SettingsMachineRow(machine: $0) }
            }
          }
          ADESettingsSection("Available") {
            ADESettingsRows {
              ForEach(sections.available) { SettingsMachineRow(machine: $0) }
            }
          }
          ADESettingsSection("App") {
            ADESettingsRows {
              ADESettingsRow("Appearance", symbol: "circle.lefthalf.filled")
              ADESettingsRow("Notifications", symbol: "bell")
              ADESettingsRow("Usage", symbol: "chart.bar")
            }
          }
        }
        .navigationTitle("Settings")
      }
    }
  }
}
#endif
