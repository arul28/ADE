import SwiftUI

// The hub composer's destinations on machines other than the primary one: which
// machines offer projects, how a pick on one reads, and the machine headers
// that group the picker's project list.

extension MachineFleet {
  /// Live machines other than the primary that have projects to offer.
  var composerDestinationMachines: [Machine] {
    machines.filter { $0.state == .live && !$0.projects.isEmpty }
  }
}

/// "ADE", or "ADE · windows" when the project is on another machine.
func hubComposerDestinationTitle(projectName: String?, machineName: String?) -> String {
  guard let projectName else { return "Select project" }
  return machineName.map { "\(projectName) · \($0)" } ?? projectName
}

/// One machine's header above its projects in the destination picker.
struct HubComposerMachineHeader: View {
  let name: String

  var body: some View {
    HStack(spacing: 6) {
      Image(systemName: machineSymbol(machineKey: nil, name: name))
        .font(.system(size: 11, weight: .regular))
      Text(name)
        .font(.system(size: 12, weight: .semibold))
        .lineLimit(1)
      Spacer(minLength: 0)
    }
    .foregroundStyle(ADEColor.textSecondary)
    .padding(.horizontal, 8)
    .padding(.top, 8)
    .padding(.bottom, 2)
  }
}

// MARK: - Project first, then the computer

/// One copy of a project the composer can send to: the primary's catalog
/// row, or the roster row of another live computer.
struct HubComposerCopy: Equatable, Identifiable {
  /// Nil for the primary machine.
  let machineKey: String?
  let machineName: String
  /// The account machine key, when the account lists the computer.
  let accountMachineKey: String?
  let project: MobileProjectSummary

  /// One computer can hold two folders of a project, and two computers can
  /// share a name: the folder on its computer is the identity.
  var id: String { "\(machineKey ?? "")|\(project.id)" }
}

/// One row of the composer's project list: an account project once, with
/// each live copy, or a folder that is not on the account.
struct HubComposerProjectEntry: Identifiable, Equatable {
  let id: String
  let accountProjectId: String?
  let name: String
  let iconDataUrl: String?
  var copies: [HubComposerCopy]
}

/// Pure: one entry per account project (named by the account), then one per
/// folder that is not on the account, all by name. Copies keep their order
/// (the primary first).
func hubComposerProjectEntries(_ copies: [(copy: HubComposerCopy, accountProject: AccountProject?)]) -> [HubComposerProjectEntry] {
  var entries: [HubComposerProjectEntry] = []
  var indexByAccountId: [String: Int] = [:]
  for (copy, accountProject) in copies {
    if let accountProject {
      if let index = indexByAccountId[accountProject.id] {
        entries[index].copies.append(copy)
      } else {
        indexByAccountId[accountProject.id] = entries.count
        entries.append(HubComposerProjectEntry(
          id: accountProject.id,
          accountProjectId: accountProject.id,
          name: accountProject.name,
          iconDataUrl: copy.project.iconDataUrl,
          copies: [copy]
        ))
      }
    } else {
      entries.append(HubComposerProjectEntry(
        id: "local|\(copy.machineKey ?? "")|\(copy.project.id)",
        accountProjectId: nil,
        name: copy.project.displayName,
        iconDataUrl: copy.project.iconDataUrl,
        copies: [copy]
      ))
    }
  }
  return entries.enumerated().sorted { lhs, rhs in
    let order = lhs.element.name.localizedCaseInsensitiveCompare(rhs.element.name)
    return order == .orderedSame ? lhs.offset < rhs.offset : order == .orderedAscending
  }.map(\.element)
}

/// Pure: the copy a pick of `entry` starts on, in the Start-on order
/// (`resolveStartOn`): the computer this phone used last for the project,
/// else the account's main copy, else the primary's copy, else the first.
func hubComposerDefaultCopy(
  _ entry: HubComposerProjectEntry,
  lastAccountMachineKey: String?,
  mainCopy: AccountProjectCopy? = nil
) -> HubComposerCopy? {
  if let lastAccountMachineKey,
     let last = entry.copies.first(where: { $0.accountMachineKey == lastAccountMachineKey }) {
    return last
  }
  if let mainCopy,
     let main = entry.copies.first(where: { $0.accountMachineKey == mainCopy.machineKey && $0.project.id == mainCopy.checkoutId }) {
    return main
  }
  return entry.copies.first { $0.machineKey == nil } ?? entry.copies.first
}

/// The computers of the chosen project, as small chips under its row.
struct HubComposerStartOnChips: View {
  let copies: [HubComposerCopy]
  let isSelected: (HubComposerCopy) -> Bool
  let onPick: (HubComposerCopy) -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 5) {
      Text("Start on")
        .font(.system(size: 11.5, weight: .medium))
        .foregroundStyle(ADEColor.textMuted)
      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 6) {
          ForEach(copies) { copy in
            let selected = isSelected(copy)
            Button {
              onPick(copy)
            } label: {
              HStack(spacing: 5) {
                Image(systemName: machineSymbol(machineKey: copy.machineKey, name: copy.machineName))
                  .font(.system(size: 10.5))
                Text(copy.machineName)
                  .font(.system(size: 12.5, weight: selected ? .semibold : .regular))
                  .lineLimit(1)
              }
              .foregroundStyle(selected ? ADEColor.accent : ADEColor.textSecondary)
              .padding(.horizontal, 9)
              .padding(.vertical, 5)
              .background(
                selected ? ADEColor.accent.opacity(0.12) : ADEKit.pressed,
                in: Capsule()
              )
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Start on \(copy.machineName)")
            .accessibilityAddTraits(selected ? .isSelected : [])
          }
        }
      }
    }
    .padding(.leading, 39)
    .padding(.trailing, 8)
    .padding(.bottom, 6)
  }
}
