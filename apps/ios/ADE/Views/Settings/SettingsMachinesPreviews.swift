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
        List {
          Section {
            HStack(spacing: 12) {
              Circle().fill(ADEColor.purpleAccent.opacity(0.3)).frame(width: 44, height: 44)
                .overlay(Text("AS").font(.system(size: 16, weight: .bold, design: .rounded)).foregroundStyle(ADEColor.purpleAccent))
              VStack(alignment: .leading, spacing: 2) {
                Text("Arul Sharma").font(.body.weight(.semibold))
                Text("arulsharma90@gmail.com").font(.caption).foregroundStyle(ADEColor.textSecondary)
              }
              Spacer()
              Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(ADEColor.textMuted)
            }
            .adeFlatRow()
          }
          Section {
            ForEach(sections.connected) { SettingsMachineRow(machine: $0).adeFlatRow() }
          } header: {
            ADEFlatSectionHeader("Connected", detail: "2 of 4 live") {
              Image(systemName: "plus").font(.system(size: 13, weight: .semibold)).foregroundStyle(ADEColor.accent)
            }
          }
          Section {
            ForEach(sections.available) { SettingsMachineRow(machine: $0).adeFlatRow() }
          } header: {
            ADEFlatSectionHeader("Available")
          }
          Section {
            Label("Appearance", systemImage: "circle.lefthalf.filled").adeFlatRow()
            Label("Notifications", systemImage: "bell.badge").adeFlatRow()
            Label("Usage", systemImage: "chart.line.uptrend.xyaxis").adeFlatRow()
          } header: {
            ADEFlatSectionHeader("App")
          }
        }
        .adeFlatList()
        .navigationTitle("Settings")
      }
    }
  }
}
#endif
