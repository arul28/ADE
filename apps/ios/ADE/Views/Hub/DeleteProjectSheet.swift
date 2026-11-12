import SwiftUI

// Remove a project from the ADE account (spec 3.7). It leaves the Hub on every
// device; the folders on the computers stay. The sheet lists what stops, from
// what the phone can see: chats working now on a connected computer, and a
// note for computers that are offline.

/// One computer's working chats in a project, for the "what stops" list.
struct DeleteProjectWorkingChats: Equatable {
  let computer: String
  let count: Int
}

extension SyncService {
  /// Chats working now in an account project, per connected computer, from
  /// the rosters the phone already has. A computer with no live link is not
  /// counted (its roster is old).
  func workingChats(in project: AccountProject) -> [DeleteProjectWorkingChats] {
    let account = AccountService.shared
    var rows: [DeleteProjectWorkingChats] = []
    for entry in accountProjectCopyMachines(project, machines: account.machines) {
      guard let machine = entry.machine,
            let phoneKey = startOnPhoneKey(for: machine),
            let roster = liveRoster(forPhoneKey: phoneKey) else { continue }
      let checkoutIds = Set(project.copies.filter { $0.machineKey == machine.machineKey }.map(\.checkoutId))
      let running = roster
        .filter { $0.accountProjectId == project.id || checkoutIds.contains($0.projectId) }
        .reduce(0) { $0 + $1.runningCount }
      if running > 0 { rows.append(DeleteProjectWorkingChats(computer: machine.displayName, count: running)) }
    }
    return rows
  }
}

struct DeleteProjectSheet: View {
  let project: AccountProject
  /// Called after the account removed the project, with the toast text.
  let onRemoved: (String) -> Void

  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  @ObservedObject private var account = AccountService.shared
  private var syncService: SyncService { syncPublishes.service }
  @Environment(\.dismiss) private var dismiss

  @State private var removing = false
  @State private var errorMessage: String?

  private var working: [DeleteProjectWorkingChats] { syncService.workingChats(in: project) }
  private var hasOfflineCopy: Bool {
    accountProjectCopyMachines(project, machines: account.machines).contains { $0.machine?.online != true }
  }

  var body: some View {
    ScrollView {
        VStack(alignment: .leading, spacing: 20) {
          VStack(alignment: .leading, spacing: 8) {
            Text("Remove \(project.name) from ADE?")
              .font(.system(size: 20, weight: .bold))
              .foregroundStyle(ADEColor.textPrimary)
              .fixedSize(horizontal: false, vertical: true)
            Text("It leaves ADE on every device. No folders are deleted. If you add it again, its lanes and chats come back.")
              .font(.system(size: 14))
              .foregroundStyle(ADEColor.textSecondary)
              .fixedSize(horizontal: false, vertical: true)
          }

          if !working.isEmpty || hasOfflineCopy {
            VStack(alignment: .leading, spacing: 8) {
              Text("What stops")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(ADEColor.textSecondary)
              ADESettingsRows {
                ForEach(working, id: \.computer) { row in
                  stopRow(
                    symbol: "bolt.horizontal.circle",
                    tone: .warn,
                    text: "\(row.count) \(row.count == 1 ? "chat is" : "chats are") working on \(row.computer)"
                  )
                }
                if hasOfflineCopy {
                  stopRow(
                    symbol: "moon.zzz",
                    tone: .neutral,
                    text: "Shares and automations on offline computers stop when those computers come back online."
                  )
                }
              }
            }
          }

          HStack(alignment: .top, spacing: 8) {
            Image(systemName: "folder")
              .font(.system(size: 12, weight: .semibold))
              .padding(.top, 2)
            Text("To delete a folder too, use ADE on that computer.")
              .font(.system(size: 13))
              .fixedSize(horizontal: false, vertical: true)
          }
          .foregroundStyle(ADEColor.textMuted)

          if let errorMessage {
            Text(errorMessage)
              .font(.system(size: 13))
              .foregroundStyle(ADEColor.danger)
              .fixedSize(horizontal: false, vertical: true)
          }

          VStack(spacing: 10) {
            Button {
              Task { await remove() }
            } label: {
              HStack(spacing: 8) {
                if removing { ProgressView().controlSize(.small).tint(.white) }
                Text(removing ? "Removing…" : "Remove from ADE")
              }
            }
            .buttonStyle(ADEKitButtonStyle(prominent: true, wide: true, brand: ADEColor.danger))
            .disabled(removing)

            Button("Cancel") { dismiss() }
              .buttonStyle(ADEKitButtonStyle(wide: true))
              .disabled(removing)
          }
        }
        .padding(.horizontal, 20)
        .padding(.top, 32)
        .padding(.bottom, 24)
    }
    .background(ADEColor.pageBackground.ignoresSafeArea())
    .presentationDragIndicator(.visible)
    .interactiveDismissDisabled(removing)
    // Which copies are offline comes from the account; read it once on open.
    .task { await account.loadMachines() }
  }

  private func stopRow(symbol: String, tone: ADEKitTone, text: String) -> some View {
    HStack(alignment: .top, spacing: 12) {
      Image(systemName: symbol)
        .font(.system(size: 14, weight: .semibold))
        .foregroundStyle(tone == .neutral ? ADEColor.textSecondary : tone.color)
        .frame(width: 22)
        .padding(.top, 1)
      Text(text)
        .font(.system(size: 14))
        .foregroundStyle(ADEColor.textPrimary)
        .fixedSize(horizontal: false, vertical: true)
      Spacer(minLength: 0)
    }
    .padding(.horizontal, ADEKit.inset)
    .padding(.vertical, 12)
  }

  private func remove() async {
    guard !removing else { return }
    removing = true
    errorMessage = nil
    do {
      try await AccountProjectStore.shared.remove(projectId: project.id)
      removing = false
      dismiss()
      onRemoved("Removed \(project.name)")
    } catch {
      removing = false
      errorMessage = (error as? AccountProjectsClient.ChangeError)?.message ?? SyncUserFacingError.message(for: error)
    }
  }
}
