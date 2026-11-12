import SwiftUI

// Location (spec 3.8): where an account project's folders are, one card per
// computer. The phone reads the folders from the account list and the
// computers' states from the account; it changes nothing on a computer except
// to put a new copy on one. The main folder of a copy belongs to its computer's
// brain, so "Use for new lanes" is not offered here.

/// One computer that holds folders of the project, for the Location page.
struct ProjectLocationComputer: Equatable, Identifiable {
  let accountMachineKey: String
  let machine: AccountMachine?
  /// The folder new lanes use on this computer first, then the other folders.
  let folders: [AccountProjectCopy]

  var id: String { accountMachineKey }
}

/// Pure: the project's folders grouped by computer. Within a computer the
/// main folder comes first, then the newest. Computers with a main folder
/// come first, then the newest.
func projectLocationComputers(_ project: AccountProject, machines: [AccountMachine]) -> [ProjectLocationComputer] {
  let byMachine = Dictionary(grouping: project.copies, by: \.machineKey)
  func ordered(_ copies: [AccountProjectCopy]) -> [AccountProjectCopy] {
    copies.sorted { lhs, rhs in
      if lhs.isMain != rhs.isMain { return lhs.isMain }
      if lhs.lastSeenAt != rhs.lastSeenAt { return lhs.lastSeenAt > rhs.lastSeenAt }
      return lhs.rootPath < rhs.rootPath
    }
  }
  return byMachine.map { key, copies in
    ProjectLocationComputer(
      accountMachineKey: key,
      machine: machines.first { $0.machineKey == key },
      folders: ordered(copies)
    )
  }
  .sorted { lhs, rhs in
    let (a, b) = (lhs.folders[0], rhs.folders[0])
    if a.isMain != b.isMain { return a.isMain }
    if a.lastSeenAt != b.lastSeenAt { return a.lastSeenAt > b.lastSeenAt }
    return lhs.accountMachineKey < rhs.accountMachineKey
  }
}

private enum LocationCopyState: Equatable {
  case copying
  case done
  case failed(String)
}

struct ProjectLocationScreen: View {
  let projectId: String

  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  @ObservedObject private var store = AccountProjectStore.shared
  @ObservedObject private var account = AccountService.shared
  private var syncService: SyncService { syncPublishes.service }
  @Environment(\.dismiss) private var dismiss

  @State private var copyJobs: [String: LocationCopyState] = [:]

  private var project: AccountProject? {
    let id = store.mergedTargets[projectId] ?? projectId
    return store.liveProjects.first { $0.id == id }
  }

  var body: some View {
    NavigationStack {
      ScrollView {
        if let project {
          content(project)
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .padding(.bottom, 28)
        } else {
          Text("This project was removed from your account.")
            .font(.system(size: 14))
            .foregroundStyle(ADEColor.textSecondary)
            .frame(maxWidth: .infinity)
            .padding(.top, 48)
        }
      }
      .background(ADEColor.pageBackground.ignoresSafeArea())
      .navigationTitle("Location")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button("Done") { dismiss() }
        }
      }
    }
    // Online and offline come from the account; read it once on open.
    .task { await account.loadMachines() }
  }

  @ViewBuilder
  private func content(_ project: AccountProject) -> some View {
    let computers = projectLocationComputers(project, machines: account.machines)
    let spare = spareComputers(project)
    VStack(alignment: .leading, spacing: 22) {
      VStack(alignment: .leading, spacing: 3) {
        Text(project.name)
          .font(.system(size: 20, weight: .bold))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(2)
        Text(project.addressLabel)
          .font(.system(size: 13))
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(1)
      }

      if computers.isEmpty {
        Text("No computer has a folder of this project yet.")
          .font(.system(size: 13.5))
          .foregroundStyle(ADEColor.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
          .padding(14)
          .frame(maxWidth: .infinity, alignment: .leading)
          .adeKitCard(padding: nil)
      } else {
        ForEach(computers) { computer in
          computerCard(computer)
        }
      }

      if !spare.isEmpty {
        VStack(alignment: .leading, spacing: 8) {
          Text("Put a copy on a computer")
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(ADEColor.textSecondary)
          ADESettingsRows {
            ForEach(spare, id: \.machineKey) { machine in
              spareRow(machine, project: project)
            }
          }
          Text("ADE copies it from GitHub into the computer's projects folder.")
            .font(.system(size: 12.5))
            .foregroundStyle(ADEColor.textMuted)
            .fixedSize(horizontal: false, vertical: true)
        }
      }

      if !computers.isEmpty {
        HStack(alignment: .top, spacing: 8) {
          Image(systemName: "folder")
            .font(.system(size: 12, weight: .semibold))
            .padding(.top, 2)
          Text(computers.count == 1
            ? "To move the folder, use ADE on \(computerName(computers[0].machine))."
            : "To move a folder, use ADE on the computer that holds it.")
            .font(.system(size: 13))
            .fixedSize(horizontal: false, vertical: true)
        }
        .foregroundStyle(ADEColor.textMuted)
      }
    }
  }

  // MARK: Computers with folders

  private func computerCard(_ computer: ProjectLocationComputer) -> some View {
    let reach = reach(computer.machine)
    let isOffline: Bool = { if case .offline = reach { return true }; return false }()
    return ADESettingsRows {
      HubCopyRow(
        name: computerName(computer.machine),
        reach: reach,
        symbol: machineDeviceSymbol(deviceType: computer.machine?.deviceType, platform: computer.machine?.platform)
      )
      ForEach(Array(computer.folders.enumerated()), id: \.element.checkoutId) { index, folder in
        folderRow(folder, isFirst: index == 0, computer: computer, isOffline: isOffline)
      }
    }
  }

  private func folderRow(
    _ folder: AccountProjectCopy,
    isFirst: Bool,
    computer: ProjectLocationComputer,
    isOffline: Bool
  ) -> some View {
    let usedForNewLanes = folder.isMain || (isFirst && !computer.folders.contains(where: \.isMain))
    return VStack(alignment: .leading, spacing: 5) {
      HStack(spacing: 8) {
        Text(usedForNewLanes ? "Used for new lanes" : "Another folder")
          .font(.system(size: 12.5, weight: .medium))
          .foregroundStyle(usedForNewLanes ? ADEColor.textPrimary : ADEColor.textSecondary)
        Spacer(minLength: 8)
        if !usedForNewLanes {
          Text(isOffline ? "Offline" : "Change on that computer")
            .font(.system(size: 12))
            .foregroundStyle(ADEColor.textMuted)
        }
      }
      Text(folder.rootPath)
        .font(.adeMono(12))
        .foregroundStyle(isOffline ? ADEColor.textMuted : ADEColor.textSecondary)
        .lineLimit(3)
        .truncationMode(.middle)
        .textSelection(.enabled)
    }
    .padding(.leading, ADEKit.inset + 40)
    .padding(.trailing, ADEKit.inset)
    .padding(.vertical, 10)
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityElement(children: .combine)
  }

  // MARK: Put a copy

  /// Online account computers with no folder of the project.
  private func spareComputers(_ project: AccountProject) -> [AccountMachine] {
    let holders = Set(project.copies.map(\.machineKey))
    return account.machines
      .filter { isAccountComputer($0) && !holders.contains($0.machineKey) }
      .filter { machine in
        if case .offline = reach(machine) { return copyJobs[machine.machineKey] != nil }
        return true
      }
      .sorted { $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending }
  }

  private func spareRow(_ machine: AccountMachine, project: AccountProject) -> some View {
    let job = copyJobs[machine.machineKey]
    let rowReach: HubCopyReach = job == .copying ? .copying : reach(machine)
    let detail: String? = {
      if case .failed(let message) = job { return message }
      return job == .done ? "Copied" : nil
    }()
    return HubCopyRow(
      name: machine.displayName,
      reach: rowReach,
      detail: detail,
      symbol: machineDeviceSymbol(deviceType: machine.deviceType, platform: machine.platform)
    ) {
      switch job {
      case .copying:
        ProgressView().controlSize(.small)
      case .done:
        Image(systemName: "checkmark.circle.fill").foregroundStyle(ADEColor.success)
      case .failed, nil:
        Button(job == nil ? "Put a copy" : "Try again") {
          putCopy(project, on: machine)
        }
        .buttonStyle(ADEKitButtonStyle(prominent: job == nil))
        .disabled(copyJobs.values.contains(.copying))
        .accessibilityLabel("Put a copy on \(machine.displayName)")
      }
    }
  }

  /// Connects the computer when it is not live, then sends the clone job to
  /// it over its own link. One copy at a time.
  private func putCopy(_ project: AccountProject, on machine: AccountMachine) {
    guard !copyJobs.values.contains(.copying) else { return }
    copyJobs[machine.machineKey] = .copying
    Task { @MainActor in
      switch await syncService.putAccountProjectCopy(project, onAccountMachine: machine.machineKey) {
      case .failure(let failure):
        copyJobs[machine.machineKey] = .failed(failure.message)
      case .success:
        copyJobs[machine.machineKey] = .done
        // The new folder reaches the account on that computer's next
        // publish; read the list once so its card shows sooner.
        Task { await store.refresh() }
      }
    }
  }

  // MARK: Helpers

  private func computerName(_ machine: AccountMachine?) -> String {
    machine?.displayName ?? "A computer that left your account"
  }

  private func reach(_ machine: AccountMachine?) -> HubCopyReach {
    guard let machine else { return .offline(lastSeen: nil) }
    let isLive = syncService.startOnPhoneKey(for: machine).map { syncService.startOnIsLive($0) } ?? false
    return hubCopyReach(machine, isLive: isLive)
  }
}
