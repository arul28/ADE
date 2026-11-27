import SwiftUI

// "Update & restart" for other machines in Settings, as the desktop shows it:
// an Update button on each machine that is behind on its track, "Update all"
// when several are, a confirmation that names what is running on each, and
// the update's steps until the machine is back on the new version. The state
// lives in `MachineUpdateStore`.

// MARK: - Confirmation

/// Presents the store's confirmation when `origin` asked for it, so a page
/// pushed over the list never shows the list's question (or the reverse).
struct MachineUpdateConfirmationPresenter: ViewModifier {
  let origin: String
  @ObservedObject private var store = MachineUpdateStore.shared

  func body(content: Content) -> some View {
    content.sheet(item: Binding(
      get: { store.confirmation?.origin == origin ? store.confirmation : nil },
      set: { next in
        if next == nil, let current = store.confirmation, current.origin == origin { store.cancel(current) }
      }
    )) { confirmation in
      MachineUpdateConfirmationSheet(confirmation: confirmation)
        .presentationDetents([.medium, .large])
    }
  }
}

extension View {
  func machineUpdateConfirmation(origin: String) -> some View {
    modifier(MachineUpdateConfirmationPresenter(origin: origin))
  }
}

/// The question before anything restarts: one row per machine with the version
/// it goes from and to and what is running there (the desktop's
/// `confirmMachineUpdates`).
struct MachineUpdateConfirmationSheet: View {
  let confirmation: MachineUpdateConfirmation
  @ObservedObject private var store = MachineUpdateStore.shared

  /// Name each machine's track when any of them is on Beta.
  private var showsTracks: Bool { confirmation.rows.contains { $0.target.runsBeta } }

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 14) {
          Text("\(Brand.name) restarts there.")
            .font(.system(size: 14))
            .foregroundStyle(ADEColor.textSecondary)
          VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(confirmation.rows.enumerated()), id: \.element.id) { index, row in
              if index > 0 {
                Rectangle().fill(ADEKit.rule).frame(height: 0.75).padding(.leading, ADEKit.inset)
              }
              MachineUpdateImpactRow(row: row, showsTrack: showsTracks)
            }
          }
          .adeKitCard(padding: nil)
          Button(confirmation.confirmLabel) { store.confirm(confirmation) }
            .buttonStyle(ADEKitButtonStyle(prominent: true, wide: true))
          Button("Not now") { store.cancel(confirmation) }
            .buttonStyle(ADEKitButtonStyle(wide: true))
        }
        .padding(20)
      }
      .adeScreenBackground()
      .navigationTitle(confirmation.title)
      .navigationBarTitleDisplayMode(.inline)
    }
  }
}

/// One machine in the confirmation: tile, name, from → to, what is running.
struct MachineUpdateImpactRow: View {
  let row: MachineUpdateConfirmation.Row
  var showsTrack = false

  private static let maxListedChats = 4

  var body: some View {
    let impact = row.impact
    let listed = Array(impact.chats.prefix(Self.maxListedChats))
    let showsProject = Set(impact.chats.map(\.projectName).filter { !$0.isEmpty }).count > 1
    HStack(alignment: .top, spacing: 12) {
      ADESettingsIconTile(symbol: row.target.symbol, tint: .accent, size: 34)
      VStack(alignment: .leading, spacing: 5) {
        HStack(spacing: 6) {
          Text(row.target.name)
            .font(.system(size: 15, weight: .medium))
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(1)
          if showsTrack {
            ADEKitTag(text: row.target.runsBeta ? "Beta" : "Stable", tone: row.target.runsBeta ? .warn : .neutral)
          }
        }
        HStack(spacing: 5) {
          Text(row.target.version.map(adeVersionValue) ?? "Version unknown")
          Image(systemName: "arrow.right").font(.system(size: 10, weight: .bold)).accessibilityHidden(true)
          Text(row.target.targetVersion).foregroundStyle(ADEColor.textPrimary)
        }
        .font(.adeMono(12))
        .foregroundStyle(ADEColor.textSecondary)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("From \(row.target.version ?? "an unknown version") to \(row.target.targetVersion)")
        Text(impact.headline)
          .font(.system(size: 13, weight: impact.isBusy ? .semibold : .regular))
          .foregroundStyle(impact.isBusy ? ADEColor.warning : ADEColor.textSecondary)
        ForEach(listed) { chat in
          HStack(spacing: 6) {
            Image(systemName: "bubble.left.fill").font(.system(size: 10)).foregroundStyle(ADEColor.textMuted)
            Text(chatLine(chat, showsProject: showsProject))
              .font(.system(size: 12.5))
              .foregroundStyle(ADEColor.textSecondary)
              .lineLimit(1)
          }
        }
        if impact.chats.count > listed.count {
          Text("\(impact.chats.count - listed.count) more")
            .font(.system(size: 12.5))
            .foregroundStyle(ADEColor.textMuted)
        }
        if let line = impact.continueLine {
          Label(line, systemImage: "arrow.clockwise")
            .font(.system(size: 12.5))
            .foregroundStyle(impact.continueAfterRestart == false ? ADEColor.warning : ADEColor.textSecondary)
        }
        if let note = impact.note {
          Text(note)
            .font(.system(size: 12))
            .foregroundStyle(ADEColor.textMuted)
        }
      }
      Spacer(minLength: 0)
    }
    .padding(.horizontal, ADEKit.inset)
    .padding(.vertical, 12)
  }

  private func chatLine(_ chat: MachineUpdateImpact.Chat, showsProject: Bool) -> String {
    var line = chat.title
    if showsProject, !chat.projectName.isEmpty { line += " — \(chat.projectName)" }
    if !chat.resumable { line += " — won’t continue" }
    else if chat.awaitingUser { line += " — waits for your answer" }
    return line
  }
}

// MARK: - Row control

/// The trailing control on a machine row that is behind: "Update", or a
/// spinner while the update is asked, sent, or landing. Nil when the machine
/// has nothing to update, so the row keeps its usual control.
struct SettingsMachineUpdateControl: View {
  let machine: SettingsMachine
  let origin: String
  @ObservedObject private var store = MachineUpdateStore.shared

  var body: some View {
    if store.isBusy(machine) {
      ProgressView().controlSize(.small).accessibilityLabel("Updating \(machine.title)")
    } else if let target = store.target(for: machine) {
      Button("Update") { store.request([target], origin: origin) }
        .buttonStyle(ADEKitButtonStyle(tone: .accent))
        .accessibilityLabel("Update \(machine.title) to \(target.targetVersion)")
    }
  }

}

/// "Update all" for the machines in `machines` that are behind; nothing when
/// fewer than two are.
struct SettingsMachineUpdateAllButton: View {
  let machines: [SettingsMachine]
  let origin: String
  @ObservedObject private var store = MachineUpdateStore.shared

  var body: some View {
    let targets = machines.filter { !store.isBusy($0) }.compactMap { store.target(for: $0) }
    if targets.count >= 2 {
      Button("Update all (\(targets.count))") { store.request(targets, origin: origin) }
        .buttonStyle(ADEKitButtonStyle(tone: .accent))
        .controlSize(.small)
    }
  }
}

// MARK: - Machine page

/// The machine page's "ADE" card: the version it runs, the newest on its
/// track, Update & restart, and where the last update got to.
struct SettingsMachineUpdateSection: View {
  let machine: SettingsMachine
  let origin: String
  @ObservedObject private var store = MachineUpdateStore.shared
  @Environment(\.openURL) private var openURL

  var body: some View {
    let target = store.target(for: machine)
    let status = store.status(for: machine)
    let attempt = store.attempt(for: machine)
    ADESettingsSection("\(Brand.name)", hint: hint(target: target), symbol: "arrow.triangle.2.circlepath", tint: .violet) {
      VStack(alignment: .leading, spacing: 0) {
        ADESettingsValueRow(title: "Version", value: machine.appVersion.map(adeVersionValue) ?? "Unknown", mono: true)
        if let target {
          ADESettingsHairline()
          ADESettingsValueRow(title: "Newest on \(target.runsBeta ? "Beta" : "Stable")", value: target.targetVersion, mono: true, tone: .accent)
        }
        if let key = machine.machineKey, store.checkingKeys.contains(key) || store.updatingKeys.contains(key) || status?.inFlight == true {
          ADESettingsHairline()
          MachineUpdateProgress(
            phase: store.updatingKeys.contains(key) || store.checkingKeys.contains(key) ? .sending : .restarting,
            targetVersion: attempt?.pendingVersion ?? target?.targetVersion
          )
          .padding(.horizontal, ADEKit.inset)
          .padding(.vertical, 12)
        }
        if let status, !status.inFlight {
          ADESettingsHairline()
          ADESettingsNotice(
            message: status.message,
            tone: status.ok ? .ok : .crit,
            dismiss: { if let key = machine.machineKey { store.dismissAttempt(machineKey: key) } }
          )
          .padding(ADEKit.inset)
        }
        if let attempt, !attempt.ok, !attempt.steps.isEmpty {
          ForEach(attempt.steps) { step in
            ADESettingsHairline()
            ADESettingsValueRow(
              title: step.label,
              value: step.detail.isEmpty ? step.status : step.detail,
              tone: step.status == "failed" ? ADEKitTone.crit : nil
            )
          }
        }
        if let url = attempt?.manualDownloadURL {
          ADESettingsHairline()
          ADESettingsActionRow(title: "Download the update", symbol: "arrow.down.circle") { openURL(url) }
        }
        if let target, !store.isBusy(machine) {
          ADESettingsHairline()
          Button("Update & restart") { store.request([target], origin: origin) }
            .buttonStyle(ADEKitButtonStyle(prominent: true, wide: true))
            .padding(ADEKit.inset)
        }
      }
      .adeKitCard(padding: nil)
    }
  }

  private func hint(target: MachineUpdateTarget?) -> String? {
    if target != nil { return "A newer build is out on this machine’s track." }
    if store.needsUpdateOnMachine(machine) {
      return "This computer’s \(Brand.name) is too old to update from the phone. Update it there once; after that, it updates from here."
    }
    return nil
  }
}

/// The desktop's `UpdateSteps`: Sending, Restarting, Back on the new version.
struct MachineUpdateProgress: View {
  enum Phase { case sending, restarting }
  let phase: Phase
  let targetVersion: String?

  var body: some View {
    let steps = ["Sending", "Restarting", "Back on \(targetVersion ?? "the new version")"]
    let active = phase == .sending ? 0 : 1
    HStack(alignment: .top, spacing: 6) {
      ForEach(Array(steps.enumerated()), id: \.offset) { index, label in
        VStack(alignment: .leading, spacing: 5) {
          GeometryReader { proxy in
            ZStack(alignment: .leading) {
              Capsule().fill(ADEColor.textPrimary.opacity(0.1))
              Capsule()
                .fill(index < active ? ADEColor.success : ADEColor.accent)
                .frame(width: proxy.size.width * (index < active ? 1 : index == active ? 0.45 : 0))
            }
          }
          .frame(height: 3)
          Text(label)
            .font(.system(size: 11))
            .foregroundStyle(index == active ? ADEColor.textPrimary : ADEColor.textMuted)
            .lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Update progress: \(steps[active])")
  }
}
