import SwiftUI

// Remove… on the Hub, for one project or a selection. The choices match the
// desktop's remove dialog, plus one that only this phone has:
//
// - From this list: hides the projects on this iPhone. Nothing changes on a
//   computer or the account, and Undo (or "Show") brings them back.
// - From <computer>: the computer drops its entry for each folder
//   (`project_forget_request`, sent on that computer's own link). The
//   folder stays on disk.
// - From all my computers: the same, on every computer with a copy.
// - From my account: every reachable computer drops its entry, then the
//   account forgets the project for every device.
//
// An offline computer is never called: it keeps its entry and its folder.
// Folders are never deleted from the phone. The desktop deletes a folder
// only after the computer reports it clean (`projects.inspectRemoval`), and
// that machine call has no sync envelope a phone can send yet.

// MARK: - Hidden on this phone

/// The key "From this list" stores for an account project.
func hubHiddenAccountKey(_ accountProjectId: String) -> String { "acct:\(accountProjectId)" }

/// The key "From this list" stores for a folder that is not an account
/// project: the computer and that computer's registry id of the folder.
func hubHiddenFolderKey(computerKey: String, projectId: String) -> String { "folder:\(computerKey):\(projectId)" }

/// The projects the user hid on this phone, per account (or per machine when
/// signed out). Phone only; never sent anywhere.
@MainActor
final class HubPhoneHiddenList: ObservableObject {
  static let shared = HubPhoneHiddenList()

  @Published private(set) var keys: Set<String> = []
  private var scope: String?
  private static let defaultsPrefix = "ade.hub.hiddenOnPhone.v1|"

  /// Loads the list of `scope` (an account user id, or a machine key).
  func use(scope: String?) {
    guard scope != self.scope else { return }
    self.scope = scope
    let stored = scope.flatMap { UserDefaults.standard.stringArray(forKey: Self.defaultsPrefix + $0) } ?? []
    keys = Set(stored)
  }

  func hide(_ hidden: Set<String>) {
    let next = keys.union(hidden)
    guard next != keys else { return }
    keys = next
    save()
  }

  func show(_ shown: Set<String>) {
    let next = keys.subtracting(shown)
    guard next != keys else { return }
    keys = next
    save()
  }

  private func save() {
    guard let scope else { return }
    let key = Self.defaultsPrefix + scope
    if keys.isEmpty {
      UserDefaults.standard.removeObject(forKey: key)
    } else {
      UserDefaults.standard.set(keys.sorted(), forKey: key)
    }
  }
}

// MARK: - What a removal acts on

/// One folder of a project on one computer.
struct HubRemovalCopy: Hashable, Identifiable {
  /// The account machine key when the account knows the computer, else the
  /// phone's key for it.
  let computerKey: String
  let computerName: String
  /// The phone's key for the computer (the focused machine's key or a fleet
  /// key): the link a removal is sent on. Nil when the phone has no link.
  let phoneKey: String?
  /// That computer's registry id of the folder.
  let projectId: String
  let rootPath: String?

  var id: String { "\(computerKey)|\(projectId)" }
}

/// One row of the Hub that Remove… acts on.
struct HubRemovalItem: Hashable, Identifiable {
  /// The Hub card id.
  let id: String
  let name: String
  /// Nil for a folder that is not an account project.
  let accountProject: AccountProject?
  /// Every folder of it the phone knows, one or more per computer.
  let copies: [HubRemovalCopy]
  /// What "From this list" stores.
  let hideKey: String
}

enum HubRemovalScope: Hashable {
  case list
  case computer(String)
  case all
  case account
}

struct HubRemovalComputer: Hashable, Identifiable {
  let key: String
  let name: String
  let phoneKey: String?
  var id: String { key }
}

/// Pure: every computer that holds a copy of the items, once, by name.
func hubRemovalComputers(_ items: [HubRemovalItem]) -> [HubRemovalComputer] {
  var seen: [String: HubRemovalComputer] = [:]
  for copy in items.flatMap(\.copies) {
    if let existing = seen[copy.computerKey], existing.phoneKey != nil { continue }
    seen[copy.computerKey] = HubRemovalComputer(key: copy.computerKey, name: copy.computerName, phoneKey: copy.phoneKey)
  }
  return seen.values.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
}

/// Pure: the choices the sheet offers for these items. "From all my
/// computers" shows for a project on the account (as on the desktop) or
/// for a selection on more than one computer; "From my account" only when
/// every item is an account project.
func hubRemovalScopes(_ items: [HubRemovalItem]) -> [HubRemovalScope] {
  let computers = hubRemovalComputers(items)
  var scopes: [HubRemovalScope] = [.list]
  scopes += computers.map { .computer($0.key) }
  if computers.count > 1 || items.contains(where: { $0.accountProject != nil && !$0.copies.isEmpty }) {
    scopes.append(.all)
  }
  if !items.isEmpty, items.allSatisfy({ $0.accountProject != nil }) {
    scopes.append(.account)
  }
  return scopes
}

/// One folder a removal calls, with the row it belongs to.
struct HubRemovalTarget: Hashable, Identifiable {
  let item: HubRemovalItem
  let copy: HubRemovalCopy
  var id: String { "\(item.id)|\(copy.id)" }
}

/// Pure: the folders a scope calls.
func hubRemovalTargets(_ items: [HubRemovalItem], scope: HubRemovalScope) -> [HubRemovalTarget] {
  switch scope {
  case .list:
    return []
  case .computer(let key):
    return items.flatMap { item in item.copies.filter { $0.computerKey == key }.map { HubRemovalTarget(item: item, copy: $0) } }
  case .all, .account:
    return items.flatMap { item in item.copies.map { HubRemovalTarget(item: item, copy: $0) } }
  }
}

/// The Remove sheet's items, as a sheet item.
struct HubRemovalSheetTarget: Identifiable {
  let id = UUID()
  let items: [HubRemovalItem]
}

/// The computer a Hub card's folder is on, and that folder.
struct HubCardComputer: Equatable {
  /// The account machine key when the account knows it, else the phone key.
  let key: String
  let name: String
  let phoneKey: String?
  /// The phone has a live link to it now.
  let reachable: Bool
  /// That computer's own summary of the folder (its id and root).
  let project: MobileProjectSummary
}

/// "Only on <computer>": the folders of one reachable computer that are not
/// account projects.
struct HubLocalSectionModel: Identifiable, Equatable {
  let computerKey: String
  let computerName: String
  let presentations: [HubProjectPresentation]
  var id: String { computerKey }
}

// MARK: - Sending a removal

/// Removes one folder's entry on its own computer: the focused machine's
/// link when it is that computer, else that computer's fleet link. The pin
/// is the copy's `phoneKey`; the call never falls back to another machine.
@MainActor
func hubRemoveCopy(_ copy: HubRemovalCopy, sync: SyncService, fleet: MachineFleet?) async throws {
  guard let phoneKey = copy.phoneKey else {
    throw NSError(domain: "ADE", code: 14, userInfo: [NSLocalizedDescriptionKey: machineConnectionUnreachableMessage])
  }
  if phoneKey == sync.focusedMachineKey {
    try await sync.removeProjectFromFocusedMachine(projectId: copy.projectId, rootPath: copy.rootPath)
    return
  }
  guard let connection = fleet?.connection(for: phoneKey), connection.isLive else {
    throw NSError(domain: "ADE", code: 14, userInfo: [NSLocalizedDescriptionKey: machineConnectionUnreachableMessage])
  }
  try await connection.forgetProject(projectId: copy.projectId, rootPath: copy.rootPath)
}

/// How the sheet ended, for the Hub's toast.
enum HubRemovalFinish {
  /// "From this list": the keys hidden, for Undo.
  case hidden(keys: Set<String>, text: String)
  case removed(text: String)
}

private enum HubRemovalResult: Equatable {
  case running
  case removed
  case failed(String)
  /// The computer is offline: nothing was sent.
  case offline
  /// The request went out and no answer came back.
  case unknown
}

private enum HubAccountStep: Equatable {
  case idle, running, done
  case failed(String)
}

// MARK: - The sheet

struct HubRemoveProjectsSheet: View {
  let items: [HubRemovalItem]
  let fleet: MachineFleet?
  let onFinished: (HubRemovalFinish) -> Void

  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  private var sync: SyncService { syncPublishes.service }
  @Environment(\.dismiss) private var dismiss

  @State private var scope: HubRemovalScope = .list
  @State private var phase: Phase = .choose
  @State private var results: [String: HubRemovalResult] = [:]
  @State private var accountSteps: [String: HubAccountStep] = [:]

  private enum Phase { case choose, running, done }

  private var computers: [HubRemovalComputer] { hubRemovalComputers(items) }
  private var scopes: [HubRemovalScope] { hubRemovalScopes(items) }
  private var targets: [HubRemovalTarget] { hubRemovalTargets(items, scope: scope) }

  private func isReachable(_ phoneKey: String?) -> Bool {
    guard let phoneKey else { return false }
    return sync.startOnIsLive(phoneKey)
  }

  private var reachableTargets: [HubRemovalTarget] { targets.filter { isReachable($0.copy.phoneKey) } }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        header
        if phase == .choose {
          choices
        }
        summary
        if scope != .list {
          HStack(alignment: .top, spacing: 8) {
            Image(systemName: "folder")
              .font(.system(size: 12, weight: .semibold))
              .padding(.top, 2)
            Text("Folders stay on disk. To delete a folder too, use ADE on that computer. It checks the folder for work that isn’t pushed first.")
              .font(.system(size: 13))
              .fixedSize(horizontal: false, vertical: true)
          }
          .foregroundStyle(ADEColor.textMuted)
        }
        buttons
      }
      .padding(.horizontal, 20)
      .padding(.top, 28)
      .padding(.bottom, 24)
    }
    .background(ADEColor.pageBackground.ignoresSafeArea())
    .presentationDragIndicator(.visible)
    .interactiveDismissDisabled(phase == .running)
  }

  // MARK: Header

  private var header: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(items.count == 1 ? "Remove \(items[0].name)?" : "Remove \(items.count) projects?")
        .font(.system(size: 20, weight: .bold))
        .foregroundStyle(ADEColor.textPrimary)
        .fixedSize(horizontal: false, vertical: true)
      if items.count > 1 {
        Text(hubRemovalNames(items.map(\.name)))
          .font(.system(size: 14))
          .foregroundStyle(ADEColor.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
  }

  // MARK: Choices

  private var choices: some View {
    ADESettingsRows {
      ForEach(scopes, id: \.self) { option in
        Button {
          scope = option
        } label: {
          ADESettingsRow(title: title(for: option), hint: hint(for: option), symbol: symbol(for: option), tint: option == .account ? .red : .slate) {
            Image(systemName: scope == option ? "checkmark.circle.fill" : "circle")
              .font(.system(size: 20))
              .foregroundStyle(scope == option ? ADEColor.accent : ADEColor.textMuted)
          }
        }
        .buttonStyle(ADEKitRowButtonStyle())
        .accessibilityAddTraits(scope == option ? .isSelected : [])
      }
    }
  }

  private func computer(_ key: String) -> HubRemovalComputer? { computers.first { $0.key == key } }

  private func title(for option: HubRemovalScope) -> String {
    switch option {
    case .list: return "From this list"
    case .computer(let key): return "From \(computer(key)?.name ?? "this computer")"
    case .all: return "From all my computers"
    case .account: return "From my account"
    }
  }

  private func hint(for option: HubRemovalScope) -> String {
    switch option {
    case .list:
      return "Only this iPhone stops showing \(items.count == 1 ? "it" : "them"). You can show \(items.count == 1 ? "it" : "them") again."
    case .computer(let key):
      guard let computer = computer(key) else { return "" }
      return isReachable(computer.phoneKey)
        ? "\(computer.name) takes \(items.count == 1 ? "it" : "them") off its list."
        : "\(computer.name) is offline. Nothing changes there."
    case .all:
      return "Every computer with a copy takes \(items.count == 1 ? "it" : "them") off its list."
    case .account:
      return "Every computer and device stops listing \(items.count == 1 ? "it" : "them")."
    }
  }

  private func symbol(for option: HubRemovalScope) -> String {
    switch option {
    case .list: return "iphone"
    case .computer(let key):
      return computer(key).map { machineSymbol(machineKey: $0.phoneKey, name: $0.name) } ?? "desktopcomputer"
    case .all: return "macbook.and.iphone"
    case .account: return "person.crop.circle"
    }
  }

  // MARK: What happens

  @ViewBuilder
  private var summary: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(phase == .done ? "Result" : "What happens")
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(ADEColor.textSecondary)
      ADESettingsRows {
        if scope == .list {
          summaryRow(
            symbol: "iphone",
            tone: .neutral,
            title: "This iPhone",
            lines: [(items.count == 1 ? "Hides \(items[0].name)." : "Hides \(items.count) projects.") + " Nothing changes on your computers or your account."]
          )
        }
        if scope == .account {
          ForEach(items.compactMap(\.accountProject), id: \.id) { project in
            accountRow(project)
          }
        }
        if scope != .list {
          if targets.isEmpty {
            summaryRow(symbol: "desktopcomputer", tone: .neutral, title: "Your computers", lines: ["No computer has a copy. No folder changes."])
          }
          ForEach(targets) { target in
            targetRow(target)
          }
        }
      }
    }
  }

  private func accountRow(_ project: AccountProject) -> some View {
    let step = accountSteps[project.id] ?? .idle
    let line: (String, ADEKitTone) = {
      switch step {
      case .idle: return ("Your project list forgets \(project.name). Lanes and chats come back if you add it again.", .neutral)
      case .running: return ("Removing…", .neutral)
      case .done: return ("Removed from your account.", .ok)
      case .failed(let message): return ("Still on your account. \(message)", .crit)
      }
    }()
    return summaryRow(symbol: "person.crop.circle", tone: line.1, title: "Your account", lines: [line.0], running: step == .running)
  }

  private func targetRow(_ target: HubRemovalTarget) -> some View {
    let reachable = isReachable(target.copy.phoneKey)
    var lines: [String] = []
    var tone: ADEKitTone = .neutral
    var running = false
    if let result = results[target.id] {
      switch result {
      case .running:
        running = true
        lines.append("Removing…")
      case .removed:
        tone = .ok
        lines.append("Removed. The folder stays on disk.")
      case .failed(let message):
        tone = .crit
        lines.append("Kept. \(message)")
      case .offline:
        lines.append(scope == .account ? "Offline. It keeps its folder." : "Offline. Nothing changed there.")
      case .unknown:
        tone = .warn
        lines.append("Not known: \(target.copy.computerName) stopped answering. Check again later.")
      }
    } else if !reachable {
      lines.append(scope == .account ? "Offline. It keeps its folder." : "Offline. Nothing changes there.")
    } else {
      let working = runningChats(target.copy)
      if working > 0 {
        tone = .warn
        lines.append("\(working) \(working == 1 ? "chat is" : "chats are") working. Removing it stops \(working == 1 ? "it" : "them").")
      } else {
        lines.append("Takes \(target.item.name) off its list.")
      }
    }
    return summaryRow(
      symbol: machineSymbol(machineKey: target.copy.phoneKey, name: target.copy.computerName),
      tone: tone,
      title: items.count == 1 ? target.copy.computerName : "\(target.item.name) on \(target.copy.computerName)",
      path: target.copy.rootPath,
      lines: lines,
      running: running,
      dimmed: !reachable && results[target.id] == nil
    )
  }

  /// Chats working now in this folder, from the live roster of its computer.
  private func runningChats(_ copy: HubRemovalCopy) -> Int {
    guard let phoneKey = copy.phoneKey, let roster = sync.liveRoster(forPhoneKey: phoneKey) else { return 0 }
    return roster.filter { $0.projectId == copy.projectId }.reduce(0) { $0 + $1.runningCount }
  }

  private func summaryRow(
    symbol: String,
    tone: ADEKitTone,
    title: String,
    path: String? = nil,
    lines: [String],
    running: Bool = false,
    dimmed: Bool = false
  ) -> some View {
    HStack(alignment: .top, spacing: 12) {
      Group {
        if running {
          ProgressView().controlSize(.small)
        } else {
          Image(systemName: resultSymbol(symbol, tone: tone))
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(tone == .neutral ? ADEColor.textSecondary : tone.color)
        }
      }
      .frame(width: 22, height: 20)
      VStack(alignment: .leading, spacing: 3) {
        Text(title)
          .font(.system(size: 15, weight: .medium))
          .foregroundStyle(dimmed ? ADEColor.textSecondary : ADEColor.textPrimary)
          .fixedSize(horizontal: false, vertical: true)
        if let path, !path.isEmpty {
          Text(path)
            .font(.adeMono(11))
            .foregroundStyle(ADEColor.textMuted)
            .lineLimit(1)
            .truncationMode(.middle)
        }
        ForEach(lines, id: \.self) { line in
          Text(line)
            .font(.system(size: 13))
            .foregroundStyle(tone == .crit ? ADEColor.danger : ADEColor.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      Spacer(minLength: 0)
    }
    .padding(.horizontal, ADEKit.inset)
    .padding(.vertical, 12)
    .accessibilityElement(children: .combine)
  }

  private func resultSymbol(_ symbol: String, tone: ADEKitTone) -> String {
    switch tone {
    case .ok: return "checkmark.circle.fill"
    case .crit: return "xmark.circle.fill"
    case .warn: return "exclamationmark.triangle.fill"
    default: return symbol
    }
  }

  // MARK: Buttons

  private var confirmLabel: String {
    switch scope {
    case .list: return "Remove from this list"
    case .account: return "Remove from my account"
    case .computer(let key): return "Remove from \(computer(key)?.name ?? "this computer")"
    case .all:
      let count = Set(reachableTargets.map(\.copy.computerKey)).count
      return count == 1 ? "Remove from 1 computer" : "Remove from \(count) computers"
    }
  }

  private var canConfirm: Bool {
    switch scope {
    case .list, .account: return true
    case .computer, .all: return !reachableTargets.isEmpty
    }
  }

  @ViewBuilder
  private var buttons: some View {
    VStack(spacing: 10) {
      if phase == .done {
        Button("Done") { dismiss() }
          .buttonStyle(ADEKitButtonStyle(prominent: true, wide: true))
      } else {
        Button {
          Task { await run() }
        } label: {
          HStack(spacing: 8) {
            if phase == .running { ProgressView().controlSize(.small).tint(.white) }
            Text(phase == .running ? "Removing…" : confirmLabel)
          }
        }
        .buttonStyle(ADEKitButtonStyle(prominent: true, wide: true, brand: ADEColor.danger))
        .disabled(phase == .running || !canConfirm)

        Button("Cancel") { dismiss() }
          .buttonStyle(ADEKitButtonStyle(wide: true))
          .disabled(phase == .running)
      }
    }
  }

  // MARK: Run

  private func run() async {
    guard phase == .choose else { return }
    if scope == .list {
      let keys = Set(items.map(\.hideKey))
      HubPhoneHiddenList.shared.hide(keys)
      dismiss()
      onFinished(.hidden(
        keys: keys,
        text: items.count == 1 ? "Removed \(items[0].name) from this list" : "Removed \(items.count) projects from this list"
      ))
      return
    }
    phase = .running
    var removed = 0
    var problems = 0
    for target in targets {
      guard isReachable(target.copy.phoneKey) else {
        results[target.id] = .offline
        continue
      }
      results[target.id] = .running
      do {
        try await hubRemoveCopy(target.copy, sync: sync, fleet: fleet)
        results[target.id] = .removed
        removed += 1
      } catch let error as NSError where error.domain == "ADE" && error.code == 23 {
        // The request went out; the computer may have finished.
        results[target.id] = .unknown
        problems += 1
      } catch {
        results[target.id] = .failed(SyncUserFacingError.message(for: error))
        problems += 1
      }
    }
    var accountRemoved = 0
    if scope == .account {
      for project in items.compactMap(\.accountProject) {
        accountSteps[project.id] = .running
        do {
          try await AccountProjectStore.shared.remove(projectId: project.id)
          accountSteps[project.id] = .done
          accountRemoved += 1
        } catch {
          accountSteps[project.id] = .failed((error as? AccountProjectsClient.ChangeError)?.message ?? SyncUserFacingError.message(for: error))
          problems += 1
        }
      }
    }
    phase = .done
    let text: String
    if scope == .account {
      text = accountRemoved == 1 && items.count == 1 ? "Removed \(items[0].name) from your account" : "Removed \(accountRemoved) from your account"
    } else {
      text = removed == 1 ? "Removed 1 folder from a computer" : "Removed \(removed) folders from computers"
    }
    onFinished(.removed(text: problems > 0 ? "\(text). Some were kept." : text))
  }
}

/// "ade, website and 3 more".
func hubRemovalNames(_ names: [String], shown: Int = 3) -> String {
  guard names.count > 1 else { return names.first ?? "" }
  if names.count <= shown {
    return names.dropLast().joined(separator: ", ") + " and " + (names.last ?? "")
  }
  return names.prefix(shown).joined(separator: ", ") + " and \(names.count - shown) more"
}

// MARK: - List header and select mode

/// Above the project grid: the list's name, how many it holds, and Select.
struct HubProjectsHeader: View {
  let title: String
  let count: Int
  let selecting: Bool
  let canSelect: Bool
  let onToggleSelect: () -> Void

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 6) {
      Text(title)
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(ADEColor.textSecondary)
      Text("\(count)")
        .font(.system(size: 13, weight: .medium))
        .monospacedDigit()
        .foregroundStyle(ADEColor.textMuted)
      Spacer(minLength: 8)
      if canSelect {
        Button(selecting ? "Done" : "Select", action: onToggleSelect)
          .font(.system(size: 14, weight: selecting ? .semibold : .regular))
          .foregroundStyle(ADEColor.accent)
          .buttonStyle(.plain)
          .frame(minHeight: 32)
          .contentShape(Rectangle())
      }
    }
    .padding(.horizontal, 2)
    .accessibilityElement(children: .contain)
  }
}

/// Under the list while selecting: Select all, the count, and Remove….
struct HubSelectionBar: View {
  let selected: Int
  let total: Int
  let onSelectAll: () -> Void
  let onRemove: () -> Void

  var body: some View {
    HStack(spacing: 12) {
      Button(selected == total && total > 0 ? "Deselect all" : "Select all", action: onSelectAll)
        .buttonStyle(ADEKitButtonStyle())
      Spacer(minLength: 4)
      Text(selected == 0 ? "None selected" : "\(selected) selected")
        .font(.system(size: 13, weight: .medium))
        .monospacedDigit()
        .foregroundStyle(ADEColor.textSecondary)
        .lineLimit(1)
      Spacer(minLength: 4)
      Button("Remove…", action: onRemove)
        .buttonStyle(ADEKitButtonStyle(prominent: true, brand: ADEColor.danger))
        .disabled(selected == 0)
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 10)
    .adeKitCard(padding: nil)
    .padding(.horizontal, 16)
    .padding(.bottom, 8)
  }
}

/// The tick a row shows while the list selects.
struct HubSelectionMark: View {
  let selected: Bool

  var body: some View {
    Image(systemName: selected ? "checkmark.circle.fill" : "circle")
      .font(.system(size: 20, weight: .regular))
      .foregroundStyle(selected ? ADEColor.accent : ADEColor.textMuted)
      .accessibilityHidden(true)
  }
}

// MARK: - Only on a computer

/// Folders a reachable computer shows that are not account projects, under
/// "Only on <computer>": smaller rows than the project tiles.
struct HubLocalFolderSection: View {
  let computerName: String
  let presentations: [HubProjectPresentation]
  /// Card id -> the line under its name (`hubLocalFolderSubtitle`).
  let subtitles: [String: String]
  /// Nil while the list is not selecting.
  let selectedIds: Set<String>?
  let onOpen: (HubProjectPresentation) -> Void
  let onToggle: (HubProjectPresentation) -> Void
  let onRemove: (HubProjectPresentation) -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .firstTextBaseline, spacing: 6) {
        Text("Only on \(computerName)")
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(1)
        Text("\(presentations.count)")
          .font(.system(size: 13, weight: .medium))
          .monospacedDigit()
          .foregroundStyle(ADEColor.textMuted)
      }
      .padding(.horizontal, 2)
      .accessibilityElement(children: .combine)
      ADESettingsRows {
        ForEach(presentations) { presentation in
          row(presentation)
        }
      }
    }
  }

  private func row(_ presentation: HubProjectPresentation) -> some View {
    let project = presentation.project
    let selected = selectedIds?.contains(project.id)
    return Button {
      if selected != nil { onToggle(presentation) } else { onOpen(presentation) }
    } label: {
      HStack(spacing: 12) {
        if let selected { HubSelectionMark(selected: selected) }
        HubProjectIcon(iconDataUrl: project.iconDataUrl, isActive: presentation.isActive, size: 26)
        VStack(alignment: .leading, spacing: 2) {
          Text(project.displayName)
            .font(.system(size: 15, weight: .medium))
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(1)
          Text(subtitles[project.id] ?? hubLocalFolderSubtitle(gitHubIdentity: nil))
            .font(.system(size: 12))
            .foregroundStyle(ADEColor.textMuted)
            .lineLimit(1)
        }
        .layoutPriority(1)
        Spacer(minLength: 6)
        let counts = presentation.stateCounts
        if !counts.isEmpty {
          HubStateSummary(counts: counts, fitsWidth: true)
        }
        if presentation.isSwitching {
          ProgressView().controlSize(.small)
        } else if selected == nil {
          ADESettingsChevron()
        }
      }
      .padding(.horizontal, ADEKit.inset)
      .padding(.vertical, 10)
      .frame(minHeight: 52)
      .contentShape(Rectangle())
    }
    .buttonStyle(ADEKitRowButtonStyle())
    .accessibilityAddTraits(selected == true ? .isSelected : [])
    .contextMenu {
      if selected == nil {
        Button { onOpen(presentation) } label: { Label("Open", systemImage: "arrow.up.forward.app") }
        if let path = project.rootPath, !path.isEmpty {
          Button { UIPasteboard.general.string = path } label: { Label("Copy path", systemImage: "doc.on.doc") }
        }
        Divider()
        Button(role: .destructive) { onRemove(presentation) } label: { Label("Remove…", systemImage: "trash") }
      }
    }
  }
}

/// A folder that is not an account project: its GitHub address
/// (`owner/name`) when it has one the account does not list, else that it
/// has none. Never its path.
func hubLocalFolderSubtitle(gitHubIdentity: String?) -> String {
  guard let gitHubIdentity, !gitHubIdentity.isEmpty else { return "No GitHub repository" }
  return "\(gitHubIdentity), not on your account"
}
