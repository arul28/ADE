import SwiftUI

// Remove… and Hide on the Hub, for one project or a selection.
//
// Remove… offers the desktop remove dialog's choices (`HubRemoveProjectsSheet`).
// Hide on this iPhone is the phone's own: it takes rows off this phone's list
// only, nothing changes on a computer or the account, and Undo or the
// header's "N hidden" brings them back.

// MARK: - Hidden on this phone

/// The key "Hide on this iPhone" stores for an account project.
func hubHiddenAccountKey(_ accountProjectId: String) -> String { "acct:\(accountProjectId)" }

/// The key "Hide on this iPhone" stores for a folder that is not an account
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
  /// The folder the card shows, on the computer the phone reaches it on
  /// (desktop: the copy the tab is on). Nil for a project no reachable
  /// computer shows.
  let current: HubRemovalCopy?
  /// Every folder of it the phone knows, `current` included, one or more per
  /// computer.
  let copies: [HubRemovalCopy]
  /// It has a GitHub repository, so other computers can hold copies of it
  /// (desktop: `repoKey`). A folder with none lives on one computer only.
  let hasRepository: Bool
  /// What "Hide on this iPhone" stores.
  let hideKey: String
}

/// The desktop remove dialog's choices, by the same names: "From <computer>",
/// "From all my computers" and "From my account".
enum HubRemovalScope: Hashable {
  /// The computer each card shows its folder from (desktop "this").
  case current
  case all
  case account
}

/// Pure: the choices for these items, as the desktop offers them: the
/// card's computer when a reachable computer shows it, "all my computers"
/// for a project with a GitHub repository and at least one copy, and "my
/// account" for account projects.
func hubRemovalScopes(_ items: [HubRemovalItem]) -> [HubRemovalScope] {
  var scopes: [HubRemovalScope] = []
  if items.contains(where: { $0.current != nil }) { scopes.append(.current) }
  if items.contains(where: { $0.hasRepository && !$0.copies.isEmpty }) { scopes.append(.all) }
  if !items.isEmpty, items.allSatisfy({ $0.accountProject != nil }) { scopes.append(.account) }
  return scopes
}

/// One folder a removal calls, with the row it belongs to.
struct HubRemovalTarget: Hashable, Identifiable {
  let item: HubRemovalItem
  let copy: HubRemovalCopy
  var id: String { "\(item.id)|\(copy.id)" }
}

/// Pure: the folders a scope calls. A folder with no repository has only
/// the copy the card shows, whatever the scope (desktop `rows`).
func hubRemovalTargets(_ items: [HubRemovalItem], scope: HubRemovalScope) -> [HubRemovalTarget] {
  items.flatMap { item -> [HubRemovalTarget] in
    let copies: [HubRemovalCopy]
    if scope == .current || !item.hasRepository {
      copies = item.current.map { [$0] } ?? []
    } else {
      copies = item.copies
    }
    return copies.map { HubRemovalTarget(item: item, copy: $0) }
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

/// "Only on <computer>": the folders that are not account projects, of one
/// reachable computer or of the same few computers.
struct HubLocalSectionModel: Identifiable, Equatable {
  /// The computers' keys, joined with "+".
  let computerKey: String
  /// "Mac Studio", or "Mac Studio and MacBook Air".
  let computerName: String
  let presentations: [HubProjectPresentation]
  var id: String { computerKey }
}

/// Something the user hid on this phone that the Hub would otherwise show.
struct HubHiddenEntry: Identifiable, Equatable {
  /// The stored key (`hubHiddenAccountKey` / `hubHiddenFolderKey`).
  let key: String
  let name: String
  /// Nil for a row of the main list; else the computer of an "Only on"
  /// folder.
  let computerKey: String?
  var id: String { key }
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

/// Remove…, for one project or a selection. The choices, words and safety
/// rule are the desktop remove dialog's (`RemoveProjectDialog.tsx`):
///
/// - From <computer>: that computer drops its entry for the folder
///   (`project_forget_request`, sent on that computer's own link).
/// - From all my computers: the same, on every computer with a copy.
/// - From my account: every reachable computer drops its entry, then the
///   account forgets the project for every device.
///
/// An offline computer is never called: it keeps its entry and its folder.
/// The phone removes entries only; every folder stays on disk. The desktop's
/// "Also delete the folders" needs `projects.inspectRemoval`, which a phone
/// cannot send, so it is not offered here.
struct HubRemoveProjectsSheet: View {
  let items: [HubRemovalItem]
  let fleet: MachineFleet?
  /// The line the Hub's toast shows when the sheet is done.
  let onFinished: (String) -> Void

  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  private var sync: SyncService { syncPublishes.service }
  @Environment(\.dismiss) private var dismiss

  @State private var scope: HubRemovalScope
  @State private var phase: Phase = .choose
  @State private var results: [String: HubRemovalResult] = [:]
  @State private var accountSteps: [String: HubAccountStep] = [:]

  private enum Phase { case choose, running, done }

  init(items: [HubRemovalItem], fleet: MachineFleet?, onFinished: @escaping (String) -> Void) {
    self.items = items
    self.fleet = fleet
    self.onFinished = onFinished
    // The desktop opens on the tab's computer, else on the account.
    let scopes = hubRemovalScopes(items)
    _scope = State(initialValue: scopes.first(where: { $0 != .all }) ?? scopes.first ?? .current)
  }

  private var scopes: [HubRemovalScope] { hubRemovalScopes(items) }
  private var targets: [HubRemovalTarget] { hubRemovalTargets(items, scope: scope) }
  private var single: Bool { items.count == 1 }
  private var pronoun: String { single ? "it" : "them" }

  private func isReachable(_ phoneKey: String?) -> Bool {
    guard let phoneKey else { return false }
    return sync.startOnIsLive(phoneKey)
  }

  private var actionable: [HubRemovalTarget] { targets.filter { isReachable($0.copy.phoneKey) } }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        header
        if phase == .choose, scopes.count > 1 {
          choices
        }
        rows
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
      Text(single ? "Remove \(items[0].name)?" : "Remove \(items.count) projects?")
        .font(.system(size: 20, weight: .bold))
        .foregroundStyle(ADEColor.textPrimary)
        .fixedSize(horizontal: false, vertical: true)
      if !single {
        Text(hubRemovalNames(items.map(\.name)))
          .font(.system(size: 14))
          .foregroundStyle(ADEColor.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      if phase == .choose {
        Text("ADE keeps the folders. Each copy stays on disk where it is.")
          .font(.system(size: 14))
          .foregroundStyle(ADEColor.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
          .padding(.top, 2)
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

  /// The one computer every item's card shows from, if they share one.
  private var currentComputer: HubRemovalCopy? {
    let currents = items.compactMap(\.current)
    guard let first = currents.first, currents.allSatisfy({ $0.computerKey == first.computerKey }) else { return nil }
    return first
  }

  private func title(for option: HubRemovalScope) -> String {
    switch option {
    case .current:
      if let computer = currentComputer { return "From \(computer.computerName)" }
      return "From the computer each is on"
    case .all: return "From all my computers"
    case .account: return "From my account"
    }
  }

  private func hint(for option: HubRemovalScope) -> String? {
    switch option {
    case .account: return "Every computer and device stops listing \(pronoun)."
    case .current, .all: return nil
    }
  }

  private func symbol(for option: HubRemovalScope) -> String {
    switch option {
    case .current:
      return currentComputer.map { machineSymbol(machineKey: $0.phoneKey, name: $0.computerName) } ?? "desktopcomputer"
    case .all: return "macbook.and.iphone"
    case .account: return "person.crop.circle"
    }
  }

  // MARK: Rows

  private var rows: some View {
    ADESettingsRows {
      if targets.isEmpty && scope != .account {
        summaryRow(symbol: "icloud.slash", tone: .neutral, title: nil, lines: ["No computer with this project is online."], dimmed: true)
      }
      if scope == .account {
        ForEach(items.compactMap(\.accountProject), id: \.id) { project in
          accountRow(project)
        }
      }
      ForEach(targets) { target in
        targetRow(target)
      }
    }
  }

  private func accountRow(_ project: AccountProject) -> some View {
    let step = accountSteps[project.id] ?? .idle
    var lines: [String]
    var tone: ADEKitTone = .neutral
    switch step {
    case .idle:
      lines = [single
        ? "Your project list forgets it. Lanes and chats come back if you add it again."
        : "Your project list forgets \(project.name). Lanes and chats come back if you add it again."]
      let projectTargets = targets.filter { $0.item.accountProject?.id == project.id }
      let offline = projectTargets.filter { !isReachable($0.copy.phoneKey) }.count
      if offline == 1 {
        lines.append("1 computer is offline and keeps its folder.")
      } else if offline > 1 {
        lines.append("\(offline) computers are offline and keep their folders.")
      } else if projectTargets.isEmpty {
        lines.append("No folder changes on any computer.")
      }
    case .running:
      lines = ["Removing…"]
    case .done:
      tone = .ok
      lines = ["Removed from your account."]
    case .failed(let message):
      tone = .crit
      lines = ["Still on your account. \(message)"]
    }
    return summaryRow(
      symbol: "person.crop.circle",
      tone: tone,
      title: single ? "Your account" : "\(project.name) on your account",
      lines: lines,
      running: step == .running
    )
  }

  private func targetRow(_ target: HubRemovalTarget) -> some View {
    let reachable = isReachable(target.copy.phoneKey)
    let name = target.copy.computerName
    var lines: [String] = []
    var tone: ADEKitTone = .neutral
    var running = false
    if !reachable && results[target.id] == nil || results[target.id] == .offline {
      lines.append(scope == .account
        ? "\(name) is offline. It keeps its folder."
        : "\(name) is offline. Nothing changes there.")
    } else if let result = results[target.id] {
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
      case .unknown:
        tone = .warn
        lines.append("Not known: \(name) disconnected. Open this again to check.")
      case .offline:
        break
      }
    } else {
      let working = runningChats(target.copy)
      if working > 0 {
        tone = .warn
        let they = working == 1 ? "it" : "them"
        lines.append("\(working) \(working == 1 ? "chat" : "chats") running. Removing it stops \(they).")
      }
    }
    return summaryRow(
      symbol: machineSymbol(machineKey: target.copy.phoneKey, name: name),
      tone: tone,
      title: single ? name : "\(target.item.name) on \(name)",
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
    title: String?,
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
        if let title {
          Text(title)
            .font(.system(size: 15, weight: .medium))
            .foregroundStyle(dimmed ? ADEColor.textSecondary : ADEColor.textPrimary)
            .fixedSize(horizontal: false, vertical: true)
        }
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
            .foregroundStyle(tone == .crit ? ADEColor.danger : tone == .warn ? ADEColor.warning : ADEColor.textSecondary)
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

  /// The desktop's confirm label.
  private var confirmLabel: String {
    if scope == .account { return "Remove from my account" }
    let computers = Set(actionable.map(\.copy.computerKey))
    if computers.count <= 1 {
      let name = actionable.first?.copy.computerName ?? currentComputer?.computerName ?? items.first?.current?.computerName
      return "Remove from \(name ?? "this computer")"
    }
    return "Remove from \(computers.count) computers"
  }

  private var canConfirm: Bool {
    !actionable.isEmpty || scope == .account
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
      } catch let error as NSError where error.domain == "ADE" && error.code == 23 || !isReachable(target.copy.phoneKey) {
        // The request went out and no answer came (a timeout, or the link
        // dropped): the computer may have finished.
        results[target.id] = .unknown
        problems += 1
      } catch {
        // The computer answered no (or the request could not be built): the
        // row says why, and Sentry gets the failure without the folder.
        CrashReporting.capture(error, context: ["area": "hub-remove-folder"])
        results[target.id] = .failed(SyncUserFacingError.message(for: error))
        problems += 1
      }
    }
    // The account step runs after the computers, as on the desktop: a copy
    // that stays (offline, refused) keeps its folder either way.
    var accountRemoved = 0
    if scope == .account {
      for project in items.compactMap(\.accountProject) {
        accountSteps[project.id] = .running
        do {
          try await AccountProjectStore.shared.remove(projectId: project.id)
          accountSteps[project.id] = .done
          accountRemoved += 1
        } catch {
          // A signed-out phone (no status) is told to sign in; anything else
          // is a failure the account server should not give.
          let signedOut = (error as? AccountProjectsClient.ChangeError).map { $0.status == nil } ?? false
          if !signedOut { CrashReporting.capture(error, context: ["area": "hub-remove-account-project"]) }
          accountSteps[project.id] = .failed((error as? AccountProjectsClient.ChangeError)?.message ?? SyncUserFacingError.message(for: error))
          problems += 1
        }
      }
    }
    phase = .done
    let text: String
    if accountRemoved > 0 {
      text = accountRemoved == 1 && single ? "Removed \(items[0].name) from your account" : "Removed \(accountRemoved) from your account"
    } else if removed > 0 {
      text = removed == 1 ? "Removed 1 folder from a computer" : "Removed \(removed) folders from computers"
    } else {
      onFinished("Nothing was removed")
      return
    }
    onFinished(problems > 0 ? "\(text). Some were kept." : text)
  }
}

extension MobileProjectSummary {
  /// The folder's own GitHub `owner/name`, when its computer sent both.
  var hubRepositorySlug: String? {
    guard let owner = repoOwner?.trimmingCharacters(in: .whitespacesAndNewlines), !owner.isEmpty,
          let name = repoName?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty
    else { return nil }
    return "\(owner)/\(name)"
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

/// Above the project grid: the list's name, how many it holds, what this
/// phone hides, and Select.
struct HubProjectsHeader: View {
  let title: String
  /// The account's count when the account governs the list: hiding a row on
  /// this phone never lowers it.
  let count: Int
  /// Rows this phone hides, main list and "Only on" folders. Empty hides
  /// the menu.
  var hidden: [HubHiddenEntry] = []
  let selecting: Bool
  let canSelect: Bool
  let onToggleSelect: () -> Void
  var onShowHidden: (Set<String>) -> Void = { _ in }

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 6) {
      Text(title)
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(ADEColor.textSecondary)
      Text("\(count)")
        .font(.system(size: 13, weight: .medium))
        .monospacedDigit()
        .foregroundStyle(ADEColor.textMuted)
      if !hidden.isEmpty, !selecting {
        hiddenMenu
      }
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

  /// "· 3 hidden": a menu that shows them all again, or one by name.
  private var hiddenMenu: some View {
    Menu {
      Section("Hidden on this iPhone") {
        Button {
          onShowHidden(Set(hidden.map(\.key)))
        } label: {
          Label(hidden.count == 1 ? "Show it" : "Show all \(hidden.count)", systemImage: "eye")
        }
      }
      Section {
        ForEach(hidden) { entry in
          Button(entry.name) { onShowHidden([entry.key]) }
        }
      }
    } label: {
      HStack(spacing: 4) {
        Text("·")
        Text("\(hidden.count) hidden")
          .monospacedDigit()
        Image(systemName: "chevron.down")
          .font(.system(size: 9, weight: .semibold))
      }
      .font(.system(size: 13, weight: .medium))
      .foregroundStyle(ADEColor.accent)
      .frame(minHeight: 32)
      .contentShape(Rectangle())
    }
    .accessibilityLabel(hidden.count == 1 ? "1 project hidden on this iPhone" : "\(hidden.count) projects hidden on this iPhone")
    .accessibilityHint("Shows them again.")
  }
}

/// Under the list while selecting: Select all, the count, Hide and Remove….
struct HubSelectionBar: View {
  let selected: Int
  let total: Int
  let onSelectAll: () -> Void
  let onHide: () -> Void
  let onRemove: () -> Void

  var body: some View {
    HStack(spacing: 10) {
      Button(selected == total && total > 0 ? "Deselect all" : "Select all", action: onSelectAll)
        .buttonStyle(ADEKitButtonStyle())
        .lineLimit(1)
      Spacer(minLength: 4)
      Text(selected == 0 ? "None selected" : "\(selected) selected")
        .font(.system(size: 13, weight: .medium))
        .monospacedDigit()
        .foregroundStyle(ADEColor.textSecondary)
        .lineLimit(1)
        .minimumScaleFactor(0.85)
      Spacer(minLength: 4)
      Button(action: onHide) {
        Label("Hide", systemImage: "eye.slash")
      }
      .buttonStyle(ADEKitButtonStyle())
      .lineLimit(1)
      .disabled(selected == 0)
      .accessibilityHint("Hides them on this iPhone only.")
      Button("Remove…", action: onRemove)
        .buttonStyle(ADEKitButtonStyle(prominent: true, brand: ADEColor.danger))
        .lineLimit(1)
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
  /// Card id -> its GitHub `owner/name`, for the line under its name
  /// (`hubLocalFolderSubtitle`).
  let gitHubIdentities: [String: String]
  /// Nil while the list is not selecting.
  let selectedIds: Set<String>?
  let onOpen: (HubProjectPresentation) -> Void
  let onToggle: (HubProjectPresentation) -> Void
  let onHide: (HubProjectPresentation) -> Void
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
          Text(hubLocalFolderSubtitle(gitHubIdentity: gitHubIdentities[project.id]))
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
        Button { onHide(presentation) } label: { Label("Hide on this iPhone", systemImage: "eye.slash") }
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
