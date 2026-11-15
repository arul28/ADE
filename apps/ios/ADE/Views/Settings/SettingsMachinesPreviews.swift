import SwiftUI

#if DEBUG
/// `-adePreviewScreen settings-machines`: Settings with the Connected and
/// Available machine sections, from fixtures. `settings-machine-page` opens the
/// MacBook's machine page; `settings-machine-page-failing` opens the Studio
/// install whose last connect failed.
struct SettingsMachinesPreviewHost: View {
  var showsPage = false
  var showsFailingPage = false

  /// The Studio install whose last connect failed (the relay reached it, ADE
  /// on it did not answer).
  static let failingId = "studio-beta"
  static let failingError = SettingsMachineError.connect(
    syncRelayHostDidNotAnswerMessage(machineName: "Arul’s Mac Studio")
  )

  static let machines: [SettingsMachine] = [
    SettingsMachine(
      id: "studio", name: "Arul’s Mac Studio · ADE", symbol: "desktopcomputer", machineKey: "machine:studio",
      account: nil, link: .primary(live: true, connecting: false), online: true, isAsleep: false, lastSeenAt: nil,
      hiddenIdentity: "studio", detail: "Local network · plugged in",
      projects: [
        RemoteRosterProject(projectId: "ade", displayName: "ADE", booted: true, runningCount: 2, attentionCount: 0, lanes: [], chats: []),
      ],
      appVersion: "1.2.127",
      computerName: "Arul’s Mac Studio", install: "ADE"
    ),
    SettingsMachine(
      id: "mbp", name: "MacBook Pro (97) · ADE", symbol: "laptopcomputer", machineKey: "machine:mbp",
      account: nil, link: .connected(.live, gaveUp: false), online: true, isAsleep: false, lastSeenAt: nil,
      hiddenIdentity: "mbp", detail: "Local network · 11% battery",
      projects: [
        RemoteRosterProject(projectId: "ade", displayName: "ADE", booted: true, runningCount: 1, attentionCount: 0, lanes: [], chats: []),
        RemoteRosterProject(projectId: "versic", displayName: "Versic", booted: true, runningCount: 0, attentionCount: 0, lanes: [], chats: []),
      ],
      // This machine runs Beta; the Studio above runs Stable.
      appVersion: "1.2.128-beta.3",
      computerName: "MacBook Pro (97)", install: "ADE"
    ),
    SettingsMachine(
      id: "alpha", name: "arul · ADE Alpha", symbol: "desktopcomputer", machineKey: "machine:alpha",
      account: nil, link: .connected(.offline(message: nil), gaveUp: true), online: false, isAsleep: false,
      lastSeenAt: Date().addingTimeInterval(-6 * 3600), hiddenIdentity: "alpha", detail: nil, projects: [],
      computerName: "arul", install: "ADE Alpha"
    ),
    // Three more installs on the Studio: a dev home, Beta (its last connect
    // failed), and a long-named dev install that is offline.
    SettingsMachine(
      id: "studio-dev", name: "Arul’s Mac Studio · ~/.ade-dev-first-run", symbol: "desktopcomputer",
      machineKey: "machine:studio-dev", account: nil, link: .available, online: true, isAsleep: false,
      lastSeenAt: nil, hiddenIdentity: "studio-dev", detail: "Local network · plugged in", projects: [],
      computerName: "Arul’s Mac Studio", install: "~/.ade-dev-first-run"
    ),
    SettingsMachine(
      id: failingId, name: "Arul’s Mac Studio · ADE Beta", symbol: "desktopcomputer", machineKey: nil,
      account: nil, link: .available, online: true, isAsleep: false, lastSeenAt: nil,
      hiddenIdentity: "studio-beta", detail: "ADE relay · plugged in", projects: [],
      appVersion: "1.2.128-beta.3",
      computerName: "Arul’s Mac Studio", install: "ADE Beta"
    ),
    SettingsMachine(
      id: "studio-tabs", name: "Arul’s Mac Studio (dev tabs) · ~/.ade-dev-tabs-worktree", symbol: "desktopcomputer",
      machineKey: nil, account: nil, link: .available, online: false, isAsleep: false,
      lastSeenAt: Date().addingTimeInterval(-28 * 60), hiddenIdentity: "studio-tabs", detail: nil, projects: [],
      computerName: "Arul’s Mac Studio (dev tabs)", install: "~/.ade-dev-tabs-worktree"
    ),
    SettingsMachine(
      id: "macpoop", name: "Macpoop · ADE Alpha", symbol: "laptopcomputer", machineKey: nil,
      account: nil, link: .available, online: true, isAsleep: false, lastSeenAt: nil,
      hiddenIdentity: "macpoop", detail: "82% battery", projects: [],
      computerName: "Macpoop", install: "ADE Alpha"
    ),
    SettingsMachine(
      id: "windows", name: "windows · ADE", symbol: "desktopcomputer", machineKey: nil,
      account: nil, link: .available, online: false, isAsleep: false,
      lastSeenAt: Date().addingTimeInterval(-19 * 3600), hiddenIdentity: "windows", detail: nil, projects: [],
      computerName: "windows", install: "ADE"
    ),
  ]

  private func row(_ machine: SettingsMachine) -> some View {
    SettingsMachineRow(machine: machine, error: machine.id == Self.failingId ? Self.failingError : nil)
  }

  var body: some View {
    NavigationStack {
      if showsFailingPage, let failing = Self.machines.first(where: { $0.id == Self.failingId }) {
        SettingsMachinePageContent(
          machine: failing,
          error: Self.failingError,
          actions: SettingsMachinePageActions(rename: {}, removeFromAccount: {})
        )
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
      } else if showsPage {
        SettingsMachinePageContent(machine: Self.machines[1], actions: SettingsMachinePageActions(rename: {}, removeFromAccount: {}))
          .navigationTitle("")
          .navigationBarTitleDisplayMode(.inline)
      } else {
        let sections = settingsMachineSections(Self.machines)
        ADESettingsPage(title: "Settings") {
          ADESettingsSection("Connected", hint: "2 of 8 live") {
            ADESettingsRows {
              ForEach(sections.connected) { row($0) }
            }
          }
          ADESettingsSection("Available") {
            ADESettingsRows {
              ForEach(sections.available) { row($0) }
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

/// `-adePreviewScreen work-load-notice`: the Work list's "Couldn't load your
/// chats" notice above cached rows, collapsed and with its details open.
struct WorkLoadNoticePreviewHost: View {
  private let notice = SyncDomainStatus(
    phase: .failed,
    lastError: "Request list_sessions timed out after 15s (relay 4501: host sync listener unavailable)",
    lastHydratedAt: nil
  ).inlineHydrationFailureNotice(for: .work)

  var body: some View {
    NavigationStack {
      List {
        if let notice {
          ADEFlatInlineNotice(notice: notice, retry: {})
            .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
        }
        ForEach(["share test chat", "Multi-machine project lifecycle", "Cloud coordinator", "Linux Desktop App Plan"], id: \.self) { title in
          VStack(alignment: .leading, spacing: 4) {
            Text(title)
              .font(.headline)
              .foregroundStyle(ADEColor.textPrimary)
            Text("Cached chat row")
              .font(.subheadline.italic())
              .foregroundStyle(ADEColor.textSecondary)
          }
          .padding(.vertical, 8)
          .listRowBackground(Color.clear)
        }
      }
      .listStyle(.plain)
      .scrollContentBackground(.hidden)
      .background(ADEColor.pageBackground.ignoresSafeArea())
      .navigationTitle("Work")
    }
  }
}
#endif
